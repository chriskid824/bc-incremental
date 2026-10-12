/**
 * Run lifecycle of the browser build: start a run, settle it, show the result, start the next.
 * M0 has no talent UI, so the placeholder auto-buyer spends shards between runs.
 */

import type { Num } from '../core/num';
import { DAMAGE_TAG_BIT } from '../data/stats';
import type { GameData } from '../data/types';
import { DEFAULT_ECONOMY, allowedStartWave, collectRules, settleRun, statBlockFor } from '../meta';
import type { EconomyConfig, MetaState, Settlement } from '../meta';
import { NO_INPUT, createSimulation } from '../sim';
import type { RunConfig, RunResult, SimEvent, Simulation } from '../sim';
import { autoBuyTalents } from './autoBuy';
import type { Purchase } from './autoBuy';

/** How long the result screen stays up before the next run starts (a click skips it). */
export const RESULT_SCREEN_MS = 2500;

/** Seeds derive from the run counter so a fresh profile replays the same runs. */
const SEED_BASE = 1000;

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
  readonly purchases: readonly Purchase[];
  /** Profile currencies after settlement and purchases. */
  readonly bankShards: Num;
  readonly bankCores: number;
}

export interface SessionListener {
  runStarted(run: ActiveRun): void;
  runFinished(report: RunReport): void;
}

export type SessionPhase = 'idle' | 'running' | 'results';

export class Session {
  private phaseValue: SessionPhase = 'idle';
  private active: ActiveRun | null = null;
  private resultMsLeft = 0;

  constructor(
    private readonly data: GameData,
    private readonly meta: MetaState,
    private readonly listener: SessionListener,
    private readonly economy: EconomyConfig = DEFAULT_ECONOMY,
  ) {}

  get phase(): SessionPhase {
    return this.phaseValue;
  }

  get run(): ActiveRun {
    if (this.active === null) throw new Error('Session.start() has not been called');
    return this.active;
  }

  /** Remaining time on the result screen, 0 outside it. */
  get resultTimeLeftMs(): number {
    return this.phaseValue === 'results' ? Math.max(0, this.resultMsLeft) : 0;
  }

  /** Starts the first run. */
  start(): void {
    if (this.phaseValue !== 'idle') throw new Error('Session already started');
    this.nextRun();
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

  /** Counts down the result screen by wall-clock time and starts the next run when it ends. */
  update(frameMs: number): void {
    if (this.phaseValue !== 'results') return;
    this.resultMsLeft -= frameMs;
    if (this.resultMsLeft <= 0) this.nextRun();
  }

  /** Ends the result screen early (click). */
  skipResults(): void {
    if (this.phaseValue === 'results') this.nextRun();
  }

  private finishRun(run: ActiveRun): void {
    const result = run.sim.result();
    const settlement = settleRun(this.meta, result, this.data, run.config.stats, this.economy);
    const purchases = autoBuyTalents(this.meta, this.data, this.economy);
    this.phaseValue = 'results';
    this.resultMsLeft = RESULT_SCREEN_MS;
    this.listener.runFinished({
      run,
      result,
      settlement,
      purchases,
      bankShards: this.meta.shards,
      bankCores: this.meta.cores,
    });
  }

  private nextRun(): void {
    const stats = statBlockFor(this.meta, this.data);
    const config: RunConfig = {
      seed: SEED_BASE + this.meta.runs,
      stats,
      rules: collectRules(this.meta, this.data),
      startWave: allowedStartWave(this.meta, this.economy),
      mode: 'auto',
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
    this.listener.runStarted(this.active);
  }
}
