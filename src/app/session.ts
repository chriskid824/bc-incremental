/**
 * Run lifecycle of the browser build: run → result screen → talent web → next run.
 * The talent web opens on its own when something is affordable; otherwise the result screen
 * counts down and the next run starts, so a player who only watches still progresses.
 * The start wave follows the highest allowed wave unless the player picks a lower one, and
 * steps down on its own when the build gets weaker (a respec) or a run fails to clear it.
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
  estimateBuild,
  refundAll,
  settleRun,
  statBlockFor,
} from '../meta';
import type { BuildEstimate, EconomyConfig, MetaState, Settlement } from '../meta';
import { NO_INPUT, createSimulation } from '../sim';
import type { RunConfig, RunResult, SimEvent, Simulation } from '../sim';

/** How long the result screen stays up before the next run starts (a click skips it). */
export const RESULT_SCREEN_MS = 3000;

/** Seeds derive from the run counter so a fresh profile replays the same runs. */
const SEED_BASE = 1000;

/**
 * After a run that did not clear its start wave (so it earned no skip compensation), the next
 * start wave is at most this share of the wave the run reached, and always lower than before.
 */
export const FAILED_START_RATIO = 0.7;

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
}

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
}

export type SessionPhase = 'idle' | 'running' | 'results' | 'talents';

export class Session {
  private phaseValue: SessionPhase = 'idle';
  private active: ActiveRun | null = null;
  private resultMsLeft = 0;
  private lastReport: RunReport | null = null;
  /** Start wave picked on the talent screen; null follows the highest allowed wave. */
  private startWaveChoice: number | null = null;
  /**
   * The choice was lowered by the session, not picked by the player, so it climbs back on its
   * own as the build gets stronger and runs clear it.
   */
  private startWaveAuto = false;
  /** T was pressed during the run: open the talent web when it ends. */
  private talentsQueuedValue = false;
  private readonly economy: EconomyConfig;
  private readonly waveCap: number | undefined;

  constructor(
    private readonly data: GameData,
    private readonly meta: MetaState,
    private readonly listener: SessionListener,
    options: SessionOptions = {},
  ) {
    this.economy = options.economy ?? DEFAULT_ECONOMY;
    this.waveCap = options.waveCap;
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

  /** Whether the talent web will open when the current run ends. */
  get talentsQueued(): boolean {
    return this.talentsQueuedValue;
  }

  get report(): RunReport | null {
    return this.lastReport;
  }

  /** Remaining time on the result screen while it counts down, 0 otherwise. */
  get resultTimeLeftMs(): number {
    return this.phaseValue === 'results' && !this.lastReport?.affordable
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
    const max = this.maxStartWave;
    return this.startWaveChoice === null ? max : Math.min(this.startWaveChoice, max);
  }

  /** Picks the next run's start wave; picking the highest allowed wave follows it upward. */
  setStartWave(wave: number): void {
    const max = this.maxStartWave;
    const clamped = Math.max(1, Math.min(max, Math.round(wave)));
    this.startWaveChoice = clamped >= max ? null : clamped;
    this.startWaveAuto = false;
  }

  /** How far the current talents should get (src/meta/estimate.ts). */
  get estimate(): BuildEstimate {
    return estimateBuild(this.meta, this.data, this.economy);
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

  /** Counts down the result screen by wall-clock time when nothing is affordable. */
  update(frameMs: number): void {
    if (this.phaseValue !== 'results' || this.lastReport?.affordable !== false) return;
    this.resultMsLeft -= frameMs;
    if (this.resultMsLeft <= 0) this.nextRun();
  }

  /** Leaves the result screen: to the talent web if something is affordable, else a new run. */
  continueFromResults(): void {
    if (this.phaseValue !== 'results') return;
    if (this.lastReport?.affordable === true) this.openTalents();
    else this.nextRun();
  }

  /**
   * Asks for the talent web during a run: it opens when the run ends, instead of the result
   * screen and its countdown to the next run. Returns whether it was queued.
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

  /** Buys a node (or its next rank). Only between runs. Returns whether it was bought. */
  allocate(nodeId: string): boolean {
    if (this.phaseValue !== 'talents') return false;
    if (!canAllocate(this.meta, nodeId, this.data, this.economy).ok) return false;
    const before = this.estimate.startWave;
    allocate(this.meta, nodeId, this.data, this.economy);
    this.followEstimate(before);
    this.listener.profileChanged();
    return true;
  }

  /** Free full respec. Only between runs. Lowers the start wave to what the new build can do. */
  refund(): void {
    if (this.phaseValue !== 'talents') return;
    refundAll(this.meta);
    this.followEstimate(null);
    this.listener.profileChanged();
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
    };
    this.listener.profileChanged();
    this.listener.runFinished(this.lastReport);
    if (queued) this.openTalents();
  }

  /**
   * Re-aims the start wave after the allocation changed; `previous` is the estimated start wave
   * before the change, null after a respec. The start wave drops to the estimate when the
   * change made the build weaker than its start wave; a start wave the session lowered climbs
   * back with the estimate when the change made the build stronger.
   */
  private followEstimate(previous: number | null): void {
    const target = this.estimate.startWave;
    const current = this.startWave;
    const weaker = previous === null || target < previous;
    if (weaker && target < current) this.setAutoStartWave(target);
    else if (this.startWaveAuto && previous !== null && target > previous && target > current) {
      this.setAutoStartWave(target);
    }
  }

  /**
   * A run that did not clear its start wave lowers the next one, more so the earlier it died.
   * A start wave the session lowered climbs back once runs clear it, to the start wave the run
   * would allow as a frontier.
   */
  private followRun(result: RunResult): void {
    if (result.startWave > 1 && !result.clearedStartWave) {
      this.setAutoStartWave(
        Math.min(result.startWave - 1, Math.floor(result.highestWaveReached * FAILED_START_RATIO)),
      );
    } else if (this.startWaveAuto) {
      this.setAutoStartWave(
        Math.max(
          this.startWave,
          Math.floor(result.highestWaveReached * this.economy.startWaveRatio),
        ),
      );
    }
  }

  /** Sets a start wave chosen by the session, never above the allowed wave. */
  private setAutoStartWave(wave: number): void {
    const max = this.maxStartWave;
    const clamped = Math.max(1, Math.min(max, Math.floor(wave)));
    this.startWaveChoice = clamped >= max ? null : clamped;
    this.startWaveAuto = this.startWaveChoice !== null;
  }

  private nextRun(): void {
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
