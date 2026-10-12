/**
 * Run lifecycle of the browser build: run → result screen → talent web → next run.
 * The talent web opens on its own when something is affordable; otherwise the result screen
 * counts down and the next run starts, so a player who only watches still progresses.
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
  refundAll,
  settleRun,
  statBlockFor,
} from '../meta';
import type { EconomyConfig, MetaState, Settlement } from '../meta';
import { NO_INPUT, createSimulation } from '../sim';
import type { RunConfig, RunResult, SimEvent, Simulation } from '../sim';

/** How long the result screen stays up before the next run starts (a click skips it). */
export const RESULT_SCREEN_MS = 3000;

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
    allocate(this.meta, nodeId, this.data, this.economy);
    this.listener.profileChanged();
    return true;
  }

  /** Free full respec. Only between runs. */
  refund(): void {
    if (this.phaseValue !== 'talents') return;
    refundAll(this.meta);
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
    this.listener.runStarted(this.active);
  }
}
