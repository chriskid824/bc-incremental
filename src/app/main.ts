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
import { LocalSaveStorage, MemorySaveStorage } from '../platform/storage';
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
import { injectStyle } from '../ui/style';
import { TalentWebPanel } from '../ui/talentWeb';
import type { TalentWebView } from '../ui/talentWeb';
import { Toast } from '../ui/toast';
import { bindMenuKeys, bindSpeedKeys } from './input';
import { GameLoop, SPEEDS } from './loop';
import type { Speed } from './loop';
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

function openStorage(): SaveStorage {
  try {
    return new LocalSaveStorage(window.localStorage);
  } catch {
    return new MemorySaveStorage();
  }
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

async function main(root: HTMLElement): Promise<void> {
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
  const storage = openStorage();
  const profile = loadProfile(storage, data);
  const meta = profile.meta;
  const renderer = new Renderer(app, data, {
    reducedMotion: REDUCED_MOTION,
    hitStop: (ms) => loop.hitStop(ms),
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
  });
  let reaimTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelReaim = (): void => {
    if (reaimTimer !== null) clearTimeout(reaimTimer);
    reaimTimer = null;
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
      talentWeb.update(webView());
      scheduleReaim();
    },
    refund: () => {
      cancelReaim();
      session.refund();
      talentWeb.update(webView());
    },
    setStartWave: (wave) => {
      session.setStartWave(wave);
      talentWeb.update(webView());
    },
    start: () => session.startNextRun(),
  });
  const startFirstRun = (): void => {
    if (!intro.visible || session.phase !== 'idle') return;
    intro.hide();
    session.start();
  };
  const intro = new IntroPanel(document, startFirstRun);
  const toast = new Toast(document);
  root.append(hud.root, results.root, talentWeb.root, intro.root, toast.root);

  const webView = (): TalentWebView => ({
    talents: data.talents,
    shards: meta.shards,
    cores: meta.cores,
    rank: (node) => nodeRank(meta, node),
    check: (node) => canAllocate(meta, node.id, data, DEFAULT_ECONOMY),
    price: (node) => nodePrice(meta, node, DEFAULT_ECONOMY),
    stats: statBlockFor(meta, data),
    rules: collectRules(meta, data),
    startWave: session.startWave,
    maxStartWave: session.maxStartWave,
    reach: session.reach,
    lowering: session.startWaveLowering,
    priceGrowth: DEFAULT_ECONOMY.talentGrowth,
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
        results.show(toResultInfo(report));
        results.setTimeLeft(session.resultTimeLeftMs);
      },
      talentsOpened() {
        results.hide();
        talentWeb.show(webView());
      },
      profileChanged: save,
    },
    { waveCap: WAVE_CAP },
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
  window.addEventListener('pagehide', save);
  setSpeed(profile.speed);
  // A fresh profile learns the rules first; a returning one lands on the talent web.
  if (meta.runs === 0) intro.show();
  else session.resume();
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

function toResultInfo(report: RunReport): ResultInfo {
  const { run, result, settlement } = report;
  const { hit, crit, burn, chain } = result.damage;
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
    averageDps: seconds > 0 ? div(add(add(hit, crit), add(burn, chain)), seconds) : ZERO,
    leaks: result.leaks,
    damageTaken: result.damageTaken,
    damageTakenBy: result.damageTakenBy,
    killedBy: result.killedBy,
    shardsFromRun: settlement.shardsFromRun,
    coresFromRun: settlement.coresFromRun,
    clearedStartWave: result.clearedStartWave,
    skipShards: settlement.skipShards,
    skipCores: settlement.skipCores,
    affordable: report.affordable,
    toTalents: leadsToTalents(report),
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
main(root).catch((error: unknown) => showFatal(root, error));
