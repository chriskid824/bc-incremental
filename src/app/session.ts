/**
 * Run lifecycle of the browser build: run → result screen → talent web → next run.
 * The result screen leads to the talent web when something is affordable or T was pressed
 * during the run; otherwise it counts down and the next run starts, so a player who only
 * watches still progresses. The start wave follows the highest allowed wave unless the player
 * picks a lower one. The session lowers it on its own to the highest start wave the talents
 * clear (src/meta/startWave.ts) on load, after a respec and when the talents or the allowed
 * start wave change, and steps it down after a run that does not clear it.
 */

import type { Num } from '../core/num';
import { DAMAGE_TAG_BIT } from '../data/stats';
import type { GameData } from '../data/types';
import {
  DEFAULT_ECONOMY,
  allocate,
  allowedStartWave,
  canAllocate,
  collectRules,
  highestClearedStartWave,
  nodeRank,
  refundAll,
  settleRun,
  statBlockFor,
} from '../meta';
import type { EconomyConfig, MetaState, Settlement } from '../meta';
import { NO_INPUT, createSimulation } from '../sim';
import type { RunConfig, RunResult, SimEvent, Simulation } from '../sim';

/** How long the result screen stays up before the next run starts (a click skips it). */
export const RESULT_SCREEN_MS = 6000;

/**
 * The countdown takes at most this much of one frame, so the first frame after a hidden tab
 * (where the browser stops drawing frames) does not skip the result screen.
 */
export const RESULT_FRAME_MAX_MS = 100;

/** Seeds derive from the run counter so a fresh profile replays the same runs. */
const SEED_BASE = 1000;

/**
 * After a run that did not clear its start wave (so it earned no skip compensation), the next
 * start wave is at most this share of the wave the run reached, and always lower than before.
 */
export const FAILED_START_RATIO = 0.7;

/** Why the session lowered the start wave below the one the player picked. */
export type StartWaveLowering =
  /** The talents do not clear it (after a respec, on load, or after talents changed). */
  | 'build'
  /** The last run did not clear its start wave. */
  | 'failedRun'
  /** Lowered earlier; it rises again as runs clear it. */
  | 'climbing';

export interface ActiveRun {
  /** 1-based. */
  readonly number: number;
  readonly config: RunConfig;
  readonly sim: Simulation;
  /** Damage of a plain (non-crit, non-chain) hit; scales damage numbers and screen shake. */
  readonly typicalHit: number;
}

export interface RunReport {
  readonly run: ActiveRun;
  readonly result: RunResult;
  readonly settlement: Settlement;
  /** Profile currencies after settlement. */
  readonly bankShards: Num;
  readonly bankCores: number;
  /** A talent can be bought now, so the result screen leads to the talent web. */
  readonly affordable: boolean;
  /** T was pressed during the run, so the result screen leads to the talent web. */
  readonly talentsQueued: boolean;
  /** Start wave of the next run, after any step down for a start wave the run did not clear. */
  readonly nextStartWave: number;
}

/** The result screen waits for the player and leads to the talent web instead of counting down. */
export const leadsToTalents = (report: RunReport): boolean =>
  report.affordable || report.talentsQueued;

export interface SessionListener {
  runStarted(run: ActiveRun): void;
  runFinished(report: RunReport): void;
  /** The talent web opened (after a run, or on request). */
  talentsOpened(): void;
  /** Talents or currencies changed outside a run: a good moment to save. */
  profileChanged(): void;
}

export interface SessionOptions {
  readonly economy?: EconomyConfig;
  /** Runs end once this wave is cleared; start waves never exceed it (M1 prototype: 40). */
  readonly waveCap?: number;
  /**
   * Highest start wave up to `maxStartWave` that the talents in `meta` clear. Defaults to the
   * simulation (highestClearedStartWave); tests may pass a stand-in.
   */
  readonly reach?: (meta: Readonly<MetaState>, maxStartWave: number) => number;
}

export type SessionPhase = 'idle' | 'running' | 'results' | 'talents';

/** Highest start wave a build clears, measured with the allowed start wave at the time. */
interface Reach {
  /** buildKey() of the talents it was measured for. */
  readonly build: string;
  readonly maxStartWave: number;
  readonly wave: number;
}

export class Session {
  private phaseValue: SessionPhase = 'idle';
  private active: ActiveRun | null = null;
  private resultMsLeft = 0;
  private lastReport: RunReport | null = null;
  /** Start wave picked on the talent screen; null follows the highest allowed wave. */
  private startWavePick: number | null = null;
  /** A lower start wave set by the session, below the pick; null when none applies. */
  private startWaveLowered: number | null = null;
  private loweredBy: StartWaveLowering | null = null;
  /**
   * The player picked the start wave above the build's measured reach, warning in view: the
   * session leaves it there until the next respec.
   */
  private pickedPastReach = false;
  /** Last reach measurement (it costs a few ms of simulation, so it is kept). */
  private reachCache: Reach | null = null;
  /** Reach of the talents the start wave was last aimed for; null before the first aim. */
  private aimed: Reach | null = null;
  /** T was pressed during the run: the result screen leads to the talent web. */
  private talentsQueuedValue = false;
  private readonly economy: EconomyConfig;
  private readonly waveCap: number | undefined;
  private readonly reachFor: (meta: Readonly<MetaState>, maxStartWave: number) => number;

  constructor(
    private readonly data: GameData,
    private readonly meta: MetaState,
    private readonly listener: SessionListener,
    options: SessionOptions = {},
  ) {
    this.economy = options.economy ?? DEFAULT_ECONOMY;
    const waveCap = options.waveCap;
    this.waveCap = waveCap;
    this.reachFor =
      options.reach ??
      ((meta, maxStartWave) =>
        highestClearedStartWave(
          meta,
          data,
          maxStartWave,
          waveCap === undefined ? {} : { waveCap },
        ));
  }

  get phase(): SessionPhase {
    return this.phaseValue;
  }

  get run(): ActiveRun {
    if (this.active === null) throw new Error('Session.start() has not been called');
    return this.active;
  }

  /** The run in progress or the last one played; null before the first run. */
  get currentRun(): ActiveRun | null {
    return this.active;
  }

  /** Whether the result screen of the current run will lead to the talent web. */
  get talentsQueued(): boolean {
    return this.talentsQueuedValue;
  }

  get report(): RunReport | null {
    return this.lastReport;
  }

  /** Remaining time on the result screen while it counts down, 0 otherwise. */
  get resultTimeLeftMs(): number {
    return this.phaseValue === 'results' &&
      this.lastReport !== null &&
      !leadsToTalents(this.lastReport)
      ? Math.max(0, this.resultMsLeft)
      : 0;
  }

  /** Highest start wave the player may pick now. */
  get maxStartWave(): number {
    const allowed = allowedStartWave(this.meta, this.economy);
    return this.waveCap === undefined ? allowed : Math.min(allowed, this.waveCap);
  }

  /** The start wave of the next run. */
  get startWave(): number {
    const picked = this.pickedStartWave;
    return this.startWaveLowered === null ? picked : Math.min(this.startWaveLowered, picked);
  }

  /** Why the start wave is below the player's pick, or null when it is not. */
  get startWaveLowering(): StartWaveLowering | null {
    return this.startWave < this.pickedStartWave ? this.loweredBy : null;
  }

  /**
   * Highest start wave the current talents clear (src/meta/startWave.ts), or null when the
   * talents or the allowed start wave changed since it was last measured.
   */
  get reach(): number | null {
    const cache = this.reachCache;
    return cache !== null &&
      cache.build === this.buildKey() &&
      cache.maxStartWave === this.maxStartWave
      ? cache.wave
      : null;
  }

  /** Picks the next run's start wave; picking the highest allowed wave follows it upward. */
  setStartWave(wave: number): void {
    const max = this.maxStartWave;
    const clamped = Math.max(1, Math.min(max, Math.round(wave)));
    this.startWavePick = clamped >= max ? null : clamped;
    this.startWaveLowered = null;
    this.loweredBy = null;
    // Picked with the build's reach in view (the talent web warns above it): keep it.
    this.pickedPastReach = clamped > this.measureReach();
  }

  /** Starts the first run. */
  start(): void {
    if (this.phaseValue !== 'idle') throw new Error('Session already started');
    this.nextRun();
  }

  /**
   * Opens on the talent web instead of a run, for a returning profile: the player sees where
   * they are and starts the run from there.
   */
  resume(): void {
    if (this.phaseValue !== 'idle') throw new Error('Session already started');
    this.aimStartWave(true);
    this.phaseValue = 'talents';
    this.listener.talentsOpened();
  }

  /**
   * Advances the running simulation one tick. Settles the run on the tick it finishes.
   * The returned array is the simulation's and is reused by the next call.
   */
  step(): readonly SimEvent[] {
    if (this.phaseValue !== 'running') throw new Error(`Cannot step in phase ${this.phaseValue}`);
    const run = this.run;
    const events = run.sim.step(NO_INPUT);
    if (run.sim.state.finished) this.finishRun(run);
    return events;
  }

  /**
   * Counts down the result screen by wall-clock time while it counts down at all. `paused`
   * holds it (the pointer is on the result card, or the page is hidden).
   */
  update(frameMs: number, paused = false): void {
    if (this.resultTimeLeftMs <= 0 || paused) return;
    this.resultMsLeft -= Math.min(Math.max(0, frameMs), RESULT_FRAME_MAX_MS);
    if (this.resultMsLeft <= 0) this.nextRun();
  }

  /** Leaves the result screen: to the talent web if it leads there, else a new run. */
  continueFromResults(): void {
    if (this.phaseValue !== 'results') return;
    if (this.lastReport !== null && leadsToTalents(this.lastReport)) this.openTalents();
    else this.nextRun();
  }

  /**
   * Asks for the talent web during a run: the run's result screen then waits for the player
   * instead of counting down to the next run, and leads to the talent web. Returns whether it
   * was queued.
   */
  queueTalents(): boolean {
    if (this.phaseValue !== 'running') return false;
    this.talentsQueuedValue = true;
    return true;
  }

  /** Opens the talent web between runs. */
  openTalents(): void {
    if (this.phaseValue !== 'results' && this.phaseValue !== 'talents') return;
    this.phaseValue = 'talents';
    this.listener.talentsOpened();
  }

  /** Starts the next run from the result screen or the talent web. */
  startNextRun(): void {
    if (this.phaseValue === 'results' || this.phaseValue === 'talents') this.nextRun();
  }

  /**
   * Buys a node (or its next rank). Only between runs. Returns whether it was bought. The
   * start wave is re-aimed later (refreshStartWave, or when the next run starts), not on every
   * purchase, since measuring the build takes a few ms of simulation.
   */
  allocate(nodeId: string): boolean {
    if (this.phaseValue !== 'talents') return false;
    if (!canAllocate(this.meta, nodeId, this.data, this.economy).ok) return false;
    allocate(this.meta, nodeId, this.data, this.economy);
    this.listener.profileChanged();
    return true;
  }

  /** Free full respec. Only between runs. Lowers the start wave to what the new build clears. */
  refund(): void {
    if (this.phaseValue !== 'talents') return;
    refundAll(this.meta);
    this.aimStartWave(true);
    this.listener.profileChanged();
  }

  /**
   * Re-aims the start wave if the talents or the allowed start wave changed since it was last
   * aimed. Between runs only.
   */
  refreshStartWave(): void {
    if (this.phaseValue === 'talents' || this.phaseValue === 'results') this.aimIfStale();
  }

  /** Whether any node can be bought with the current currencies. */
  canAffordAny(): boolean {
    return this.data.talents.some(
      (node) => canAllocate(this.meta, node.id, this.data, this.economy).ok,
    );
  }

  private finishRun(run: ActiveRun): void {
    const result = run.sim.result();
    const settlement = settleRun(this.meta, result, this.data, run.config.stats, this.economy);
    this.followRun(result);
    // A deeper run allows higher start waves: aim now, so the result screen tells the truth.
    this.aimIfStale();
    const queued = this.talentsQueuedValue;
    this.talentsQueuedValue = false;
    this.phaseValue = 'results';
    this.resultMsLeft = RESULT_SCREEN_MS;
    this.lastReport = {
      run,
      result,
      settlement,
      bankShards: this.meta.shards,
      bankCores: this.meta.cores,
      affordable: this.canAffordAny(),
      talentsQueued: queued,
      nextStartWave: this.startWave,
    };
    this.listener.profileChanged();
    this.listener.runFinished(this.lastReport);
  }

  /** Identifies the talents (ids and ranks) that the stats and rules come from. */
  private buildKey(): string {
    const parts: string[] = [];
    for (const node of this.data.talents) {
      const rank = nodeRank(this.meta, node);
      if (rank > 0 && node.kind !== 'start') parts.push(`${node.id}:${rank}`);
    }
    return parts.join(',');
  }

  /** Highest start wave the current talents clear, measured once per build and allowed wave. */
  private measureReach(): number {
    const cached = this.reach;
    if (cached !== null) return cached;
    const maxStartWave = this.maxStartWave;
    const wave = Math.max(1, Math.min(maxStartWave, this.reachFor(this.meta, maxStartWave)));
    this.reachCache = { build: this.buildKey(), maxStartWave, wave };
    return wave;
  }

  private aimIfStale(): void {
    const aimed = this.aimed;
    if (
      aimed === null ||
      aimed.build !== this.buildKey() ||
      aimed.maxStartWave !== this.maxStartWave
    ) {
      this.aimStartWave(false);
    }
  }

  /**
   * Re-aims the start wave for the current talents; `fresh` after a respec or on load, where
   * nothing the player picked before carries over. A start wave above the build's reach drops
   * to the reach, unless the player picked it above the reach. A start wave the session lowered
   * climbs toward the reach as the build gets stronger, by no more than the reach gained, so
   * the step down after a failed run is not undone by the next purchase (the reach is measured
   * on fixed seeds; the failed run had its own). A reach that was capped by the allowed wave
   * says nothing about the gain, so it does not climb.
   */
  private aimStartWave(fresh: boolean): void {
    const reach = this.measureReach();
    const previous = fresh ? null : this.aimed;
    if (fresh) this.pickedPastReach = false;
    const current = this.startWave;
    if (current > reach && !this.pickedPastReach) {
      this.lowerStartWave(reach, 'build');
    } else if (
      this.startWaveLowered !== null &&
      previous !== null &&
      previous.wave < previous.maxStartWave &&
      reach > previous.wave &&
      reach > current
    ) {
      this.raiseLowered(Math.min(reach, current + reach - previous.wave));
    }
    this.aimed = this.reachCache;
  }

  /**
   * A run that did not clear its start wave lowers the next one, more so the earlier it died.
   * A start wave the session lowered climbs back once runs clear it, to the start wave the run
   * would allow as a frontier, but not past the build's measured reach.
   */
  private followRun(result: RunResult): void {
    if (result.startWave > 1 && !result.clearedStartWave) {
      const next = Math.min(
        result.startWave - 1,
        Math.floor(result.highestWaveReached * FAILED_START_RATIO),
      );
      if (next < this.startWave) this.lowerStartWave(next, 'failedRun');
    } else if (this.startWaveLowered !== null) {
      const aimed = this.aimed;
      // A reach below the allowed wave it was measured with is a ceiling; one at it is not.
      const ceiling =
        aimed !== null && aimed.build === this.buildKey() && aimed.wave < aimed.maxStartWave
          ? aimed.wave
          : Infinity;
      const frontier = Math.floor(result.highestWaveReached * this.economy.startWaveRatio);
      this.raiseLowered(Math.min(ceiling, Math.max(this.startWave, frontier)));
      // This run cleared its start wave, so a failed run is no longer the reason.
      if (this.loweredBy === 'failedRun') this.loweredBy = 'climbing';
    }
  }

  /** The player's pick, or the highest allowed wave when following it. */
  private get pickedStartWave(): number {
    const max = this.maxStartWave;
    return this.startWavePick === null ? max : Math.min(this.startWavePick, max);
  }

  /** Lowers the start wave below the pick; a wave at or above the pick clears the lowering. */
  private lowerStartWave(wave: number, reason: StartWaveLowering): void {
    const lowered = Math.max(1, Math.floor(wave));
    if (lowered >= this.pickedStartWave) {
      this.startWaveLowered = null;
      this.loweredBy = null;
    } else {
      this.startWaveLowered = lowered;
      this.loweredBy = reason;
    }
    this.pickedPastReach = false;
  }

  /** Raises a start wave the session lowered, never past the player's pick. */
  private raiseLowered(wave: number): void {
    if (this.startWaveLowered === null || wave <= this.startWaveLowered) return;
    const reason = this.loweredBy ?? 'build';
    this.lowerStartWave(wave, reason);
  }

  private nextRun(): void {
    // Lazily, once per change of talents rather than on every purchase.
    this.aimIfStale();
    const stats = statBlockFor(this.meta, this.data);
    const config: RunConfig = {
      seed: SEED_BASE + this.meta.runs,
      stats,
      rules: collectRules(this.meta, this.data),
      startWave: this.startWave,
      mode: 'auto',
      ...(this.waveCap === undefined ? {} : { waveCap: Math.max(this.waveCap, this.startWave) }),
    };
    const typicalHit = stats.values.damage * (stats.damageMult[DAMAGE_TAG_BIT.hit] ?? 1);
    this.active = {
      number: this.meta.runs + 1,
      config,
      sim: createSimulation(config, this.data),
      typicalHit,
    };
    this.phaseValue = 'running';
    this.resultMsLeft = 0;
    this.talentsQueuedValue = false;
    this.listener.runStarted(this.active);
  }
}
