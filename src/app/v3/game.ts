/**
 * The v3 game page (game.html; docs/v3/game-design-v3.md §1, §1.1, §7, A.4; the B1 row of
 * docs/v3/implementation-plan-v3.md §8.1): select a character → its talent web → a run from the
 * chosen start wave (HUD, 1x/2x/4x, pause, the new-enemy banner) → the result screen → back to the
 * web, each step saved as save v2 through the ProfileStore with the M1 import. The M1 page
 * (src/app/main.ts) is untouched; this page shares its loop, HUD and renderer.
 */

import type { Application } from 'pixi.js';
import { AudioEngine, browserAudioContext, readMuted, SimAudio, writeMuted } from '../../audio';
import { add, div, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import { characterGameData } from '../../data';
import { CHARACTER_IDS } from '../../data/sources';
import type { CharacterId } from '../../data/sources';
import type { EnemyId, GameData } from '../../data/types';
import { assembleWeb, FULL_SCOPE, scopeHolds } from '../../data/web';
import type { AssembledWeb, CharacterDef, Content } from '../../data/web';
import { FIRST_PICK } from '../../data/characters';
import { t } from '../../i18n';
import type { Locale } from '../../i18n';
import type { CharacterProgress } from '../../meta/web';
import { Renderer } from '../../render';
import { killTier } from '../../render/killTier';
import {
  accountProgress,
  addPlaySeconds,
  recordRun,
  recordSeenEnemies,
  selectCharacter,
  setProgress,
  setSpeed,
  setStartWave,
} from '../../save/profile';
import type { SaveProfile } from '../../save/profile';
import { MAX_RUN_SECONDS, TICK_RATE } from '../../sim';
import type { RunResult } from '../../sim';
import { EnemyBanner } from '../../ui/banner';
import { BannerLine } from '../../ui/bannerView';
import { Hud } from '../../ui/hud';
import { MuteControl, NoticeList, PauseControl, StartWavePicker } from '../../ui/v3/controls';
import { V3ResultPanel } from '../../ui/v3/result';
import type { V3ResultInfo } from '../../ui/v3/result';
import { damageBreakdown } from '../../ui/v3/damageBreakdown';
import { SelectScreen } from '../../ui/v3/select';
import { WebPanel } from '../../ui/v3/webPanel';
import { GameLoop, SPEEDS } from '../loop';
import type { Speed } from '../loop';
import type { ProfileStore } from '../profileStore';
import { FLAVOR } from '../../platform/flavor';
import { openKeyValueStore } from '../../platform';
import type { KeyValueStore } from '../../platform/analytics';
import { bindSpeedKeys } from '../input';
import { ConstructStills, mountCardPreview } from './preview';
import { characterRendererOptions } from './renderOptions';
import { CharacterRunState, maxStartWave, startWaveOf, storedPick } from './run';
import type { FinishedRun } from './run';

/** Becomes a settings toggle later (docs/ARCHITECTURE.md §10). */
const REDUCED_MOTION = false;

type Screen = 'select' | 'web' | 'run' | 'result';

/** Sum of a run's damage by source: the result screen's average DPS. */
function totalDamage(result: RunResult): Num {
  let total = ZERO;
  for (const value of Object.values(result.damageBySource)) total = add(total, value);
  return total;
}

export interface GamePageOptions {
  readonly root: HTMLElement;
  readonly app: Application;
  readonly locale: Locale;
  readonly content: Content;
  readonly store: ProfileStore;
}

export class GamePage {
  private readonly root: HTMLElement;
  private readonly app: Application;
  private readonly locale: Locale;
  private readonly content: Content;
  private readonly store: ProfileStore;
  private readonly data: GameData = characterGameData();
  private readonly webs = new Map<CharacterId, AssembledWeb | null>();
  private readonly hud: Hud<Speed>;
  private readonly loop: GameLoop;
  private readonly results: V3ResultPanel;
  private readonly picker: StartWavePicker;
  private readonly pause: PauseControl;
  private readonly mute: MuteControl;
  /** The mute choice's store: per device, outside the save (src/audio/prefs.ts). */
  private readonly prefs: KeyValueStore = openKeyValueStore();
  private readonly audio: AudioEngine;
  private readonly simAudio: SimAudio;
  private readonly notices: NoticeList;
  private readonly bannerLine: BannerLine;
  private readonly stills = new ConstructStills();
  private screen: Screen = 'select';
  private character: CharacterId | null = null;
  private select: SelectScreen | null = null;
  private panel: WebPanel | null = null;
  private run: CharacterRunState | null = null;
  private banner: EnemyBanner | null = null;
  private renderer: Renderer | null = null;
  private rendererKey: string | null = null;
  /** Play time not yet added to the profile (it is added on each save). */
  private unsavedSeconds = 0;

  constructor(options: GamePageOptions) {
    this.root = options.root;
    this.app = options.app;
    this.locale = options.locale;
    this.content = options.content;
    this.store = options.store;
    const doc = this.root.ownerDocument;
    this.hud = new Hud(doc, SPEEDS, (speed) => this.setSpeed(speed));
    this.hud.root.hidden = true;
    this.results = new V3ResultPanel(doc, this.data.enemies, {
      toWeb: () => this.openWeb(),
      nextRun: () => this.startRun(),
    });
    this.picker = new StartWavePicker(doc, (wave) => this.pickStartWave(wave));
    this.pause = new PauseControl(doc, () => this.togglePause());
    this.audio = new AudioEngine({
      createContext: browserAudioContext,
      muted: readMuted(this.prefs),
    });
    this.simAudio = new SimAudio(this.audio, (id) => killTier(this.data.enemies[id]));
    this.mute = new MuteControl(doc, () => this.toggleMute());
    this.mute.muted = this.audio.muted;
    this.pause.root.append(this.mute.button);
    this.notices = new NoticeList(doc, (c) => t(this.def(c).nameKey));
    this.bannerLine = new BannerLine(doc);
    this.loop = new GameLoop(
      {
        isRunning: () =>
          this.screen === 'run' && !this.pause.paused && this.run !== null && !this.run.finished,
        step: () => this.step(),
        frame: (alpha, elapsedMs, speed) => this.frame(alpha, elapsedMs, speed),
      },
      { reducedMotion: REDUCED_MOTION },
    );
    this.root.append(
      this.hud.root,
      this.pause.root,
      this.bannerLine.root,
      this.results.root,
      this.picker.root,
      this.notices.root,
    );
  }

  /** Opens the store, shows its notices and the select screen, and starts the frame loop. */
  start(): void {
    const opened = this.store.open();
    this.notices.show(opened.notices, () => {
      const again = this.store.startOver();
      this.notices.show(again.notices);
      this.showSelect();
    });
    if (FLAVOR === 'demo') {
      // The demo plays at 1× only: no buttons, no keys (Hoshi's playtest, 2026-11-03).
      this.hud.showSpeed(false);
      this.loop.speed = 1;
    } else {
      this.loop.speed = this.store.profile.account.settings.speed;
      bindSpeedKeys(window, (speed) => {
        if (this.screen === 'run') this.setSpeed(speed);
      });
    }
    window.addEventListener('keydown', (event) => this.key(event));
    // Browsers start audio only from a user gesture; capture runs before the page's own handlers.
    const unlock = (): void => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    this.root.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('button') !== null) {
        this.audio.play('uiClick');
      }
    });
    if (import.meta.env.DEV || new URLSearchParams(window.location.search).has('audioDebug')) {
      (window as { bcAudio?: AudioEngine }).bcAudio = this.audio;
    }
    // Not before the first pick: a fresh profile written by a visit that picked nothing would
    // take the place of the M1 save's one-time import (profileStore.ts' fresh path).
    window.addEventListener('pagehide', () => {
      if (this.character !== null) this.save();
    });
    this.app.stage.visible = false;
    this.showSelect();
    this.app.ticker.add((ticker) => this.loop.tick(ticker.elapsedMS));
  }

  private get profile(): SaveProfile {
    return this.store.profile;
  }

  private update(profile: SaveProfile): void {
    this.store.set(profile);
  }

  private save(): void {
    if (this.unsavedSeconds > 0) {
      this.update(addPlaySeconds(this.profile, this.unsavedSeconds));
      this.unsavedSeconds = 0;
    }
    const outcome = this.store.save();
    if (outcome === 'failed' || outcome === 'invalid') console.warn(`The save was ${outcome}`);
  }

  private def(c: CharacterId): CharacterDef {
    return this.content.characters[c];
  }

  /** c's web in FULL_SCOPE, or null while c is 「製作中」 (no center) or outside the scope. */
  private webOf(c: CharacterId): AssembledWeb | null {
    if (!this.webs.has(c)) {
      const playable = this.def(c).center !== null && scopeHolds(FULL_SCOPE.characters, c);
      this.webs.set(c, playable ? assembleWeb(this.content, c, FULL_SCOPE) : null);
    }
    return this.webs.get(c) ?? null;
  }

  private current(): { readonly c: CharacterId; readonly web: AssembledWeb } {
    const c = this.character;
    const web = c === null ? null : this.webOf(c);
    if (c === null || web === null) throw new Error('GamePage: no playable character picked');
    return { c, web };
  }

  private progressOf(c: CharacterId): CharacterProgress {
    return this.profile.characters[c].progress;
  }

  // Screens.

  private showSelect(): void {
    this.leaveScreens();
    this.screen = 'select';
    const last = this.profile.account.lastCharacter;
    const cursor = last !== null && this.webOf(last) !== null ? last : FIRST_PICK;
    this.select = new SelectScreen(this.root.ownerDocument, {
      cards: CHARACTER_IDS.map((c) => ({
        def: this.def(c),
        playable: this.webOf(c) !== null,
        bestWave: this.progressOf(c).bestWave,
      })),
      cursor,
      firstPick: FIRST_PICK,
      mountPreview: mountCardPreview(this.stills),
      onPick: (c) => this.pick(c),
    });
    this.root.append(this.select.root);
  }

  private pick(c: CharacterId): void {
    if (this.screen !== 'select' || this.webOf(c) === null) return;
    const { profile, claimed } = selectCharacter(this.profile, c);
    this.update(profile);
    if (claimed !== null) {
      this.notices.dismiss('v1Waiting');
      this.notices.show([{ kind: 'v1Claimed', character: c, pending: claimed }]);
    }
    this.character = c;
    this.save();
    this.openWeb();
  }

  private openWeb(): void {
    const { c, web } = this.current();
    this.leaveScreens();
    this.screen = 'web';
    this.panel = new WebPanel(this.root, {
      web,
      account: accountProgress(this.profile),
      locale: this.locale,
      initial: this.progressOf(c),
      onChange: (progress) => {
        this.audio.play('buy');
        this.update(setProgress(this.profile, c, progress));
        this.save();
        this.showPicker();
      },
      onStartRun: () => this.startRun(),
      onBack: () => this.showSelect(),
    });
    // Over the panel, which was appended after it.
    this.root.append(this.picker.root);
    this.showPicker();
  }

  private showPicker(): void {
    const { c, web } = this.current();
    const progress = this.progressOf(c);
    this.picker.set(
      startWaveOf(web, progress, this.profile.characters[c].startWave),
      maxStartWave(web, progress),
    );
    this.picker.root.hidden = false;
  }

  private pickStartWave(wave: number): void {
    const { c, web } = this.current();
    this.update(setStartWave(this.profile, c, storedPick(web, this.progressOf(c), wave)));
    this.showPicker();
    this.save();
  }

  /** Tears down whatever screen shows, keeping the arena's last frame. */
  private leaveScreens(): void {
    this.select?.destroy();
    this.select = null;
    this.panel?.destroy();
    this.panel = null;
    this.picker.root.hidden = true;
    this.results.hide();
    this.hud.root.hidden = true;
    this.pause.root.hidden = true;
    this.pause.paused = false;
    this.bannerLine.hide();
    this.app.stage.visible = false;
  }

  // Runs.

  private rendererFor(web: AssembledWeb, progress: CharacterProgress): Renderer {
    const options = characterRendererOptions(web, progress);
    const key = JSON.stringify(options);
    if (this.renderer === null || this.rendererKey !== key) {
      this.renderer?.destroy();
      this.renderer = new Renderer(this.app, this.data, {
        reducedMotion: REDUCED_MOTION,
        hitStop: (ms) => this.loop.hitStop(ms),
        ...options,
      });
      this.rendererKey = key;
    }
    return this.renderer;
  }

  private startRun(): void {
    if (this.screen !== 'web' && this.screen !== 'result') return;
    const { c, web } = this.current();
    const progress = this.progressOf(c);
    const startWave = startWaveOf(web, progress, this.profile.characters[c].startWave);
    this.leaveScreens();
    this.screen = 'run';
    const run = new CharacterRunState(web, progress, startWave, this.data);
    this.run = run;
    this.rendererFor(web, progress).beginRun(run.typicalHit);
    this.simAudio.reset();
    this.banner = new EnemyBanner(
      this.data.enemies,
      this.profile.account.seenEnemies as readonly EnemyId[],
      this.bannerLine,
      (id) => this.update(recordSeenEnemies(this.profile, [id])),
    );
    this.app.stage.visible = true;
    this.hud.root.hidden = false;
    this.hud.setHint(run.number === 1 ? t('hud.hintAuto') : null);
    this.pause.root.hidden = false;
    this.loop.resetClock();
  }

  private step(): void {
    const run = this.run;
    if (run === null) return;
    const events = run.step();
    this.renderer?.handleEvents(events);
    this.simAudio.handleEvents(events);
    this.banner?.events(events);
    if (run.finished) this.finishRun(run);
  }

  private finishRun(run: CharacterRunState): void {
    const { c, web } = this.current();
    const finished = run.finish();
    let profile = setProgress(this.profile, c, finished.progress);
    profile = recordRun(profile, c, {
      highestWave: finished.result.highestWaveReached,
      beatSingularity: false,
    });
    this.update(profile);
    this.save();
    this.screen = 'result';
    this.hud.setHint(null);
    this.pause.root.hidden = true;
    this.results.show(this.resultInfo(run, finished, web));
  }

  private resultInfo(
    run: CharacterRunState,
    finished: FinishedRun,
    web: AssembledWeb,
  ): V3ResultInfo {
    const { result, settlement, progress } = finished;
    const seconds = result.ticks / TICK_RATE;
    return {
      runNumber: run.number,
      characterName: t(web.def.nameKey),
      endReason: result.endReason,
      startWave: result.startWave,
      clearedStartWave: result.clearedStartWave,
      nextStartWave: startWaveOf(web, progress, this.profile.characters[web.character].startWave),
      highestWave: result.highestWaveReached,
      limitSec: (run.config.maxTicks ?? MAX_RUN_SECONDS * TICK_RATE) / TICK_RATE,
      maxLife: run.sim.state.player.maxLife,
      glassCannon: false,
      leaks: result.leaks,
      damageTaken: result.damageTaken,
      damageTakenBy: result.damageTakenBy,
      bulletTakenBy: result.bulletTakenBy,
      killedBy: result.killedBy,
      killedByBullet: finished.killedByBullet,
      kills: result.kills,
      averageDps: seconds > 0 ? div(totalDamage(result), seconds) : ZERO,
      shardsFromRun: settlement.shardsFromRun,
      coresFromRun: settlement.coresFromRun,
      skipShards: settlement.skipShards,
      skipCores: settlement.skipCores,
      bestWave: progress.bestWave,
      walletShards: progress.wallet.shards,
      damage: damageBreakdown(result.damageBySource, result.damage, t(web.def.nameKey)),
    };
  }

  private frame(alpha: number, elapsedMs: number, speed: Speed): void {
    if (document.visibilityState === 'visible') this.unsavedSeconds += elapsedMs / 1000;
    const run = this.run;
    if (run === null || (this.screen !== 'run' && this.screen !== 'result')) return;
    this.renderer?.render(run.sim.state, alpha, this.pause.paused ? 0 : elapsedMs);
    this.banner?.update(this.pause.paused ? 0 : elapsedMs);
    const state = run.sim.state;
    this.hud.update({
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
    });
  }

  private setSpeed(speed: Speed): void {
    this.loop.speed = speed;
    this.update(setSpeed(this.profile, speed));
  }

  private toggleMute(): void {
    this.audio.muted = !this.audio.muted;
    this.mute.muted = this.audio.muted;
    writeMuted(this.prefs, this.audio.muted);
  }

  private togglePause(): void {
    if (this.screen !== 'run') return;
    this.pause.paused = !this.pause.paused;
    if (!this.pause.paused) this.loop.resetClock();
  }

  private key(event: KeyboardEvent): void {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement && event.key !== 'Enter') return;
    if (event.key === 'p' || event.key === 'P' || event.key === 'Escape') {
      this.togglePause();
    } else if (event.key === 'm' || event.key === 'M') {
      this.toggleMute();
    } else if (event.key === ' ' || event.key === 'Enter') {
      if (this.screen === 'web') {
        event.preventDefault();
        this.startRun();
      } else if (this.screen === 'result') {
        event.preventDefault();
        this.openWeb();
      }
    }
  }
}
