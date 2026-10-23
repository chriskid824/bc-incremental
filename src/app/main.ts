/**
 * Browser entry point: creates the PixiJS application, loads game data, and wires the session,
 * renderer, DOM overlay and game loop together.
 */

import { Application } from 'pixi.js';
import { add, div, ZERO } from '../core/num';
import { loadGameData } from '../data';
import type { GameData } from '../data';
import { LOCALES, pickLocale, setLocale, t } from '../i18n';
import type { Locale } from '../i18n';
import {
  DEFAULT_ECONOMY,
  canAllocate,
  collectRules,
  createMetaState,
  nodePrice,
  nodeRank,
  statBlockFor,
} from '../meta';
import { createPlatform, openKeyValueStore } from '../platform';
import type { AnalyticsPolicy } from '../platform';
import { FirestoreSink, PlaytestAnalytics } from '../platform/analytics';
import type { Analytics } from '../platform/analytics';
import type { SaveStorage } from '../platform/storage';
import { loadSave, serializeSave } from '../save';
import type { Profile } from '../save';
import { MAX_RUN_SECONDS, TICK_RATE } from '../sim';
import { Renderer } from '../render';
import { Hud } from '../ui/hud';
import type { HudInfo } from '../ui/hud';
import { IntroPanel } from '../ui/intro';
import { ResultPanel } from '../ui/result';
import type { ResultInfo } from '../ui/result';
import { el, injectStyle } from '../ui/style';
import { TalentWebPanel } from '../ui/talentWeb';
import type { TalentWebView } from '../ui/talentWeb';
import { Toast } from '../ui/toast';
import {
  HIVE_SAVE_PREFIX,
  HIVE_SIGNATURE,
  raiseShards,
  readDevFlags,
  resumeAtWave,
  seedEmptySlots,
  startAtWave,
} from './devFlags';
import type { DevFlags } from './devFlags';
import HIVE_PRESET from './hivePreset.json';
import { bindMenuKeys, bindSpeedKeys } from './input';
import { GameLoop, SPEEDS } from './loop';
import type { Speed } from './loop';
import {
  FEEDBACK_AFTER_SECONDS,
  FIREBASE,
  buildFields,
  feedbackLink,
  playtestFirestore,
  runEndFields,
  sessionEndFields,
  sessionStartFields,
} from './playtest';
import type { Screen } from './playtest';
import { Session, leadsToTalents } from './session';
import type { ActiveRun, RunReport } from './session';

/** Becomes a settings toggle later (docs/ARCHITECTURE.md §10). */
const REDUCED_MOTION = false;

/** The M1 prototype stops at wave 40, like the demo (docs/GDD.md §9). */
const WAVE_CAP = 40;

/** Autosave interval outside runs (docs/ARCHITECTURE.md §8). */
const AUTOSAVE_MS = 30_000;

/**
 * Quiet time after the last talent purchase before the start wave is re-aimed for the new
 * build (Session.refreshStartWave simulates a few short runs, so not on every click).
 */
const REAIM_DELAY_MS = 600;

/** Playtest events are batched to Firestore at least this often (docs/ARCHITECTURE.md §9). */
const ANALYTICS_FLUSH_MS = 5 * 60_000;

/** A random id; randomUUID needs a secure context, which a plain-http LAN address is not. */
function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Playtest analytics under the platform's policy (src/platform): a sink only where the build may
 * send, sending by default only where its policy says so. The dev server and `?hive` never send
 * (playtestFirestore); every build keeps the local log for the export fallback.
 */
function openAnalytics(locale: Locale, hive: boolean, policy: AnalyticsPolicy): Analytics {
  const firestore = policy.cloud ? playtestFirestore(FIREBASE, import.meta.env.DEV, hive) : null;
  const sink =
    firestore !== null ? new FirestoreSink(firestore, (url, init) => fetch(url, init)) : null;
  return new PlaytestAnalytics({
    store: openKeyValueStore(),
    sink,
    clock: () => performance.now(),
    now: () => new Date(),
    newId,
    build: __BUILD_ID__,
    locale,
    defaultSending: policy.sendByDefault,
  });
}

/** Saves the local playtest log as a JSON file. */
function downloadJson(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The main slot, else the backup, else a fresh profile. */
function loadProfile(storage: SaveStorage, data: GameData): Profile {
  for (const slot of ['main', 'backup'] as const) {
    const text = storage.read(slot);
    if (text === null) continue;
    const loaded = loadSave(text, data);
    if (loaded.ok) return loaded.profile;
    console.warn(`Ignoring ${slot} save: ${loaded.error}`);
  }
  return { meta: createMetaState(), playSeconds: 0, speed: 1 };
}

async function main(root: HTMLElement, locale: Locale, flags: DevFlags): Promise<void> {
  injectStyle(document);

  const app = new Application();
  await app.init({
    resizeTo: window,
    background: 0x0b0d12,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio,
  });
  root.appendChild(app.canvas);

  const data = loadGameData();
  // The web build's or the Steam build's, chosen when the build was made (src/platform/index.ts).
  const platform = createPlatform({
    ...(flags.hive ? { savePrefix: HIVE_SAVE_PREFIX } : {}),
    analytics: (policy) => openAnalytics(locale, flags.hive, policy),
  });
  const storage = platform.storage;
  // `?hive` opens on the committed preset until its own slots hold a save (src/app/devFlags.ts).
  if (flags.hive) seedEmptySlots(storage, JSON.stringify(HIVE_PRESET));
  const profile = loadProfile(storage, data);
  const meta = profile.meta;
  raiseShards(meta, flags.shards);
  const analytics = platform.analytics;
  analytics.track(
    'session_start',
    sessionStartFields(meta, data, profile.playSeconds, {
      width: window.innerWidth,
      height: window.innerHeight,
    }),
  );
  /** The survey link once the player has played long enough to have an opinion. */
  const resultFeedbackUrl = (): string | null =>
    profile.playSeconds >= FEEDBACK_AFTER_SECONDS ? feedbackLink(analytics.installId) : null;
  const renderer = new Renderer(app, data, {
    reducedMotion: REDUCED_MOTION,
    hitStop: (ms) => loop.hitStop(ms),
    ...(flags.hive ? { construct: 'hive' as const } : {}),
  });
  // The arena has nothing to draw before the first run of this page.
  app.stage.visible = false;

  let lastSaveMs = performance.now();
  const save = (): void => {
    const previous = storage.read('main');
    if (previous !== null) storage.write('backup', previous);
    storage.write('main', serializeSave(profile, new Date().toISOString()));
    lastSaveMs = performance.now();
  };

  const setSpeed = (speed: Speed): void => {
    loop.speed = speed;
    profile.speed = speed;
  };
  const hud = new Hud(document, SPEEDS, setSpeed);
  hud.root.hidden = true;
  const results = new ResultPanel(document, data.enemies, {
    continue: () => session.continueFromResults(),
    openTalents: () => session.openTalents(),
    nextRun: () => session.startNextRun(),
    feedback: () => analytics.track('feedback_open', { screen: 'results' }),
  });
  let reaimTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelReaim = (): void => {
    if (reaimTimer !== null) clearTimeout(reaimTimer);
    reaimTimer = null;
  };
  /** The start-wave selector's pick, also how `&wave=N` picks N. */
  const pickStartWave = (wave: number): void => {
    session.setStartWave(wave);
    talentWeb.update(webView());
  };
  const scheduleReaim = (): void => {
    cancelReaim();
    reaimTimer = setTimeout(() => {
      reaimTimer = null;
      if (session.phase !== 'talents') return;
      session.refreshStartWave();
      talentWeb.update(webView());
    }, REAIM_DELAY_MS);
  };
  const talentWeb = new TalentWebPanel(document, data.talents, {
    allocate: (id) => {
      if (!session.allocate(id)) return;
      const node = data.talents.find((talent) => talent.id === id);
      if (node !== undefined) {
        analytics.track('talent_allocate', {
          node: id,
          rank: nodeRank(meta, node),
          archetype: node.archetype,
          runs: meta.runs,
        });
      }
      talentWeb.update(webView());
      scheduleReaim();
    },
    refund: () => {
      cancelReaim();
      // The build the player gave up on, before the refund clears it.
      analytics.track('respec', { runs: meta.runs, ...buildFields(meta, data) });
      session.refund();
      talentWeb.update(webView());
    },
    setStartWave: pickStartWave,
    start: () => session.startNextRun(),
    setSending: (on) => {
      analytics.sending = on;
      talentWeb.update(webView());
    },
    exportData: () =>
      downloadJson(
        analytics.exportLocal(),
        `bc-incremental-playtest-${analytics.installId.slice(0, 8)}.json`,
      ),
    feedback: () => analytics.track('feedback_open', { screen: 'talents' }),
  });
  const startFirstRun = (): void => {
    if (!intro.visible || session.phase !== 'idle') return;
    intro.hide();
    startAtWave(session, flags.wave);
  };
  const intro = new IntroPanel(document, startFirstRun, { dataNotice: analytics.sending });
  const toast = new Toast(document);
  root.append(hud.root, results.root, talentWeb.root, intro.root, toast.root);
  // The prototype says so in a corner of every screen.
  if (flags.hive) root.append(el(document, 'div', 'bc-ui bc-badge', t('app.prototype.hive')));

  const webView = (): TalentWebView => ({
    talents: data.talents,
    shards: meta.shards,
    cores: meta.cores,
    rank: (node) => nodeRank(meta, node),
    check: (node) => canAllocate(meta, node.id, data, DEFAULT_ECONOMY),
    price: (node) => nodePrice(meta, node, DEFAULT_ECONOMY),
    stats: statBlockFor(meta, data),
    rules: collectRules(meta, data),
    ...(flags.hive ? { signature: HIVE_SIGNATURE } : {}),
    startWave: session.startWave,
    maxStartWave: session.maxStartWave,
    reach: session.reach,
    lowering: session.startWaveLowering,
    priceGrowth: DEFAULT_ECONOMY.talentGrowth,
    playtest: {
      canSend: analytics.canSend,
      sending: analytics.sending,
      feedbackUrl: feedbackLink(analytics.installId),
    },
  });

  const session = new Session(
    data,
    meta,
    {
      runStarted(run) {
        cancelReaim();
        renderer.beginRun(run.typicalHit);
        app.stage.visible = true;
        results.hide();
        talentWeb.hide();
        hud.root.hidden = false;
        hud.setHint(run.number === 1 ? t('hud.hintAuto') : null);
        loop.resetClock();
      },
      runFinished(report) {
        hud.setHint(null);
        // Until the first talent is bought, point at the talent web as hard as possible.
        results.root.classList.toggle(
          'bc-result-first',
          report.affordable && meta.allocated.size === 0,
        );
        analytics.track('run_end', runEndFields(report, meta, data, profile.playSeconds));
        analytics.flush();
        results.show(toResultInfo(report, resultFeedbackUrl()));
        results.setTimeLeft(session.resultTimeLeftMs);
      },
      talentsOpened() {
        results.hide();
        // The run's HUD would show through the web and collide with its header.
        hud.root.hidden = true;
        talentWeb.show(webView());
      },
      profileChanged: save,
    },
    {
      waveCap: WAVE_CAP,
      ...(flags.hive ? { signature: HIVE_SIGNATURE } : {}),
      ...(flags.wave === null ? {} : { minStartWave: flags.wave }),
    },
  );

  const loop = new GameLoop(
    {
      isRunning: () => session.phase === 'running',
      step: () => renderer.handleEvents(session.step()),
      frame: (alpha, elapsedMs, speed) => {
        if (document.visibilityState === 'visible') profile.playSeconds += elapsedMs / 1000;
        // The countdown holds while the result card is read or the page is hidden.
        session.update(elapsedMs, results.hovered || document.visibilityState === 'hidden');
        if (session.phase !== 'running' && performance.now() - lastSaveMs > AUTOSAVE_MS) save();
        const run = session.currentRun;
        if (run === null) return;
        renderer.render(run.sim.state, alpha, elapsedMs);
        hud.update(toHudInfo(run, speed));
        if (session.phase === 'results') results.setTimeLeft(session.resultTimeLeftMs);
      },
    },
    { reducedMotion: REDUCED_MOTION },
  );

  bindSpeedKeys(window, setSpeed);
  bindMenuKeys(window, {
    confirm: () => {
      if (intro.visible) startFirstRun();
      else if (session.phase === 'results' || session.phase === 'talents') session.startNextRun();
    },
    talents: () => {
      if (session.queueTalents()) toast.show(t('toast.talentsQueued'));
      else session.openTalents();
    },
  });
  /** Where the player is, for the exit point of the playtest funnel. */
  const screen = (): Screen => {
    if (intro.visible) return 'intro';
    return session.phase === 'idle' ? 'intro' : session.phase;
  };
  window.addEventListener('pagehide', (event) => {
    const run = session.currentRun;
    analytics.track(
      'session_end',
      sessionEndFields(
        screen(),
        run?.number ?? null,
        run?.sim.state.wave ?? null,
        profile.playSeconds,
      ),
    );
    analytics.flush(true);
    // A reload or a closed tab ends the running run: bank its drops so far (which saves).
    // A page kept in the back/forward cache may come back to the run, so it only saves.
    if (!event.persisted && session.abandonRun()) return;
    save();
  });
  // A hidden tab may never come back (mobile browsers skip pagehide): send what is pending.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') analytics.flush(true);
  });
  setInterval(() => analytics.flush(), ANALYTICS_FLUSH_MS);
  setSpeed(profile.speed);
  // A fresh profile learns the rules first; a returning one lands on the talent web.
  if (meta.runs === 0) intro.show();
  else resumeAtWave(session, flags.wave, pickStartWave);
  app.ticker.add((ticker) => loop.tick(ticker.elapsedMS));
}

function toHudInfo(run: ActiveRun, speed: number): HudInfo {
  const state = run.sim.state;
  return {
    runNumber: run.number,
    startWave: run.config.startWave,
    wave: state.wave,
    life: state.player.life,
    maxLife: state.player.maxLife,
    shards: state.shards,
    cores: state.cores,
    elapsedSec: state.tick / TICK_RATE,
    limitSec: (run.config.maxTicks ?? MAX_RUN_SECONDS * TICK_RATE) / TICK_RATE,
    speed,
  };
}

function toResultInfo(report: RunReport, feedbackUrl: string | null): ResultInfo {
  const { run, result, settlement } = report;
  const { hit, crit, burn, chain, poison, bleed } = result.damage;
  const seconds = result.ticks / TICK_RATE;
  return {
    runNumber: run.number,
    endReason: result.endReason,
    startWave: result.startWave,
    highestWave: result.highestWaveReached,
    limitSec: (run.config.maxTicks ?? MAX_RUN_SECONDS * TICK_RATE) / TICK_RATE,
    maxLife: run.sim.state.player.maxLife,
    glassCannon: run.config.rules.some((rule) => rule.id === 'glassCannon'),
    kills: result.kills,
    averageDps:
      seconds > 0
        ? div(add(add(add(hit, crit), add(burn, chain)), add(poison, bleed)), seconds)
        : ZERO,
    leaks: result.leaks,
    damageTaken: result.damageTaken,
    damageTakenBy: result.damageTakenBy,
    killedBy: result.killedBy,
    shardsFromRun: settlement.shardsFromRun,
    coresFromRun: settlement.coresFromRun,
    clearedStartWave: result.clearedStartWave,
    nextStartWave: report.nextStartWave,
    skipShards: settlement.skipShards,
    skipCores: settlement.skipCores,
    affordable: report.affordable,
    toTalents: leadsToTalents(report),
    feedbackUrl,
  };
}

function showFatal(root: HTMLElement, error: unknown): void {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const box = document.createElement('div');
  box.className = 'bc-error';
  box.textContent = t('error.init', { message });
  root.replaceChildren(box);
}

/** The browser's language, or `?lang=` in the page URL (e.g. `?lang=zh-TW`) to override it. */
function chooseLocale(): Locale {
  const requested = new URLSearchParams(window.location.search).get('lang');
  if (requested !== null && isLocale(requested)) return requested;
  return pickLocale(navigator.languages.length > 0 ? navigator.languages : [navigator.language]);
}

function isLocale(tag: string): tag is Locale {
  return (LOCALES as readonly string[]).includes(tag);
}

const locale = chooseLocale();
setLocale(locale);
document.documentElement.lang = locale;

const root = document.getElementById('app');
if (root === null) throw new Error('Missing #app element');
main(root, locale, readDevFlags(window.location.search, WAVE_CAP)).catch((error: unknown) =>
  showFatal(root, error),
);
