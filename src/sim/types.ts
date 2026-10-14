/**
 * Public contract of the run simulation (docs/ARCHITECTURE.md §3–4).
 * The simulation is pure and deterministic: same build + same RunConfig + same input
 * sequence gives the same events and result.
 */

import type { Num } from '../core/num';
import type { Vec2 } from '../core/vec';
import type { EnemyId } from '../data/types';
import type { RuleSpec, SignatureSpec } from '../data/rules';
import type { StatBlock } from '../data/stats';

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

/** Logical arena size; the renderer scales it to the screen. The player sits at the center. */
export const ARENA_WIDTH = 1920;
export const ARENA_HEIGHT = 1080;

/** Player collision radius in arena units; an enemy touches the player at this + its radius. */
export const PLAYER_RADIUS = 30;

/** Hard cap on run length (docs/GDD.md §2.1). */
export const MAX_RUN_SECONDS = 180;

/** Full auto is the only mode (docs/GDD.md §2.3); InputFrame is kept for future input. */
export type ControlMode = 'auto';

/** Player input for one tick, in arena coordinates. The simulation does not read it yet. */
export interface InputFrame {
  readonly cursor: Vec2 | null;
  readonly activate: boolean;
}

export const NO_INPUT: InputFrame = { cursor: null, activate: false };

export interface RunConfig {
  readonly seed: number;
  readonly stats: StatBlock;
  readonly rules: readonly RuleSpec[];
  /** The signature attack; M1_SIGNATURE (src/data/rules.ts) when omitted. */
  readonly signature?: SignatureSpec;
  /** First wave of the run (docs/GDD.md §2.2). */
  readonly startWave: number;
  readonly mode: ControlMode;
  /** Optional hard wave cap (demo / M1 prototype). The run ends once this wave is cleared. */
  readonly waveCap?: number;
  /** Defaults to MAX_RUN_SECONDS × TICK_RATE. */
  readonly maxTicks?: number;
}

export interface EnemyState {
  readonly id: number;
  readonly type: EnemyId;
  /** Wave this enemy belongs to. */
  readonly wave: number;
  x: number;
  y: number;
  /** Position at the previous tick, for render interpolation. */
  prevX: number;
  prevY: number;
  hp: Num;
  readonly maxHp: Num;
  readonly radius: number;
  /** Number of active burn stacks. */
  burnStacks: number;
  alive: boolean;
}

export interface ProjectileState {
  readonly id: number;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /**
   * Enemy id the projectile homes on. An attack picks the alive enemy nearest to the player
   * that projectiles already in flight are not expected to kill, an elite or boss within
   * FOCUS_RANGE first (src/sim/targeting.ts), else the nearest alive one.
   * If the target dies first, the projectile retargets by the same rule measured from its own
   * position; it fizzles only when no enemy is alive.
   */
  targetId: number;
  /** A steadyAim shot: every hit of it crits. */
  readonly steady: boolean;
  alive: boolean;
}

export interface PlayerState {
  readonly x: number;
  readonly y: number;
  life: number;
  readonly maxLife: number;
}

export interface SimState {
  tick: number;
  /** Wave currently spawning or most recently started. */
  wave: number;
  /** Highest wave whose spawning has started this run. */
  highestWaveReached: number;
  /**
   * Highest wave whose enemies, split children included, are all spawned and gone this run,
   * whether killed or removed on reaching the player.
   */
  highestWaveCleared: number;
  readonly player: PlayerState;
  /** Dense arrays; dead entries may be reused or compacted by the simulation. */
  readonly enemies: EnemyState[];
  readonly projectiles: ProjectileState[];
  /** Currencies collected so far this run (before skip compensation, which meta adds). */
  shards: Num;
  cores: number;
  finished: boolean;
  /**
   * Damage source ids by index (src/sim/build/sources.ts), as hit events' `source` refers to
   * them; index 0 is 'center'. A run may number more sources as it goes.
   */
  readonly sources: readonly string[];
}

export type EndReason = 'death' | 'timeout' | 'waveCap';

export type SimEvent =
  | { readonly type: 'waveStarted'; readonly wave: number }
  /** Every enemy of the wave is gone, killed or not (see SimState.highestWaveCleared). */
  | { readonly type: 'waveCleared'; readonly wave: number }
  | { readonly type: 'enemySpawned'; readonly enemyId: number; readonly enemy: EnemyId }
  /** `targetId` is the first target; see ProjectileState.targetId for retargeting. */
  | { readonly type: 'attack'; readonly projectileId: number; readonly targetId: number }
  | {
      readonly type: 'hit';
      readonly targetId: number;
      readonly x: number;
      readonly y: number;
      readonly amount: Num;
      /** The instance's damage tags (src/data/tags.ts). */
      readonly tags: number;
      /** Index of the source it is credited to, in SimState.sources. */
      readonly source: number;
      readonly crit: boolean;
      /** 0 for the primary hit, n for the nth chain jump. */
      readonly chainIndex: number;
      /** Chain jump source position (for drawing the arc); null for the primary hit. */
      readonly fromX: number | null;
      readonly fromY: number | null;
    }
  /** A burn stack landed; `stacks` is the target's burn stacks now. */
  | { readonly type: 'ignite'; readonly targetId: number; readonly stacks: number }
  /** Poison, bleed or shock landed; `stacks` is the target's stacks of it now (bleed: 1). */
  | {
      readonly type: 'ailmentApplied';
      readonly targetId: number;
      readonly ailment: 'poison' | 'bleed' | 'shock';
      readonly stacks: number;
    }
  /** A burning enemy passed its burn stacks to `targets` enemies nearby (spreadAilment). */
  | {
      readonly type: 'burnSpread';
      readonly enemyId: number;
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly targets: number;
    }
  | {
      readonly type: 'burnTick';
      readonly targetId: number;
      readonly x: number;
      readonly y: number;
      readonly amount: Num;
    }
  /** A poisoned enemy passed its poison stacks to `targets` enemies nearby (spreadAilment). */
  | {
      readonly type: 'ailmentSpread';
      readonly ailment: 'poison';
      readonly enemyId: number;
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly targets: number;
    }
  /** A damage-over-time step of poison or bleed, as burnTick is burn's. */
  | {
      readonly type: 'dotTick';
      readonly ailment: 'poison' | 'bleed';
      readonly targetId: number;
      readonly x: number;
      readonly y: number;
      readonly amount: Num;
    }
  /**
   * An enemy's chill meter filled (src/sim/ailments/frost.ts): it froze, or, a boss, its meter
   * emptied without freezing.
   */
  | { readonly type: 'freeze'; readonly targetId: number; readonly boss: boolean }
  /** A frozen enemy died at (x, y) and shattered over `radius`. */
  | { readonly type: 'shatter'; readonly x: number; readonly y: number; readonly radius: number }
  | {
      readonly type: 'enemyKilled';
      readonly enemyId: number;
      readonly enemy: EnemyId;
      readonly x: number;
      readonly y: number;
      readonly shards: Num;
      readonly cores: number;
    }
  | {
      readonly type: 'playerHit';
      readonly enemyId: number;
      readonly damage: number;
      readonly lifeLeft: number;
    }
  | { readonly type: 'runEnded'; readonly reason: EndReason };

/**
 * Damage totals by kind of instance, for balance reporting: burn, poison and bleed by their
 * kind tag; any other instance is crit if it crit, else chain if it is a chain jump, else hit.
 */
export interface DamageBreakdown {
  readonly hit: Num;
  readonly crit: Num;
  readonly burn: Num;
  readonly chain: Num;
  readonly poison: Num;
  readonly bleed: Num;
}

/**
 * Run counters for the effect, freeze and chain budgets and the spec caps (RunResult.counters,
 * src/sim/caps.ts). They stay 0 until the systems that count them exist
 * (docs/v3/implementation-plan-v3.md §2.4–§2.6, §6); new ones are appended.
 */
export const COUNTER_IDS = [
  /** Effects run from the effect queue. */
  'effectsRun',
  /** Most entries the effect queue held at once. */
  'effectQueuePeak',
  /** Ticks that ended with effects still queued past the per-tick budget. */
  'effectBudgetTicks',
  /** Σ entries carried over to the next tick by the budget. */
  'effectsDeferred',
  /** Entries dropped at the queue's hard cap. */
  'effectsDropped',
  /** Trigger events not dispatched because they came at the maximum depth. */
  'triggerDepthCapped',
  /** Freezes past the rate limit, which froze without running their triggers. */
  'freezePayloadsLimited',
  /** Most ticks in a row that ended with effects carried over (effectBudgetTicks' longest run). */
  'effectBudgetStreakMax',
  /** Chain jumps refused because their attack had dealt CHAIN_HIT_CAP hits. */
  'chainHitCapped',
  /** Most hits one attack dealt, its primary hit included (a gauge). */
  'chainHitsPeak',
] as const;
export type CounterId = (typeof COUNTER_IDS)[number];

/** Enemies of one type that reached the player, and their contact damage. */
export interface ContactTally {
  readonly hits: number;
  readonly damage: number;
}

export interface RunResult {
  readonly startWave: number;
  readonly highestWaveReached: number;
  /** See SimState.highestWaveCleared: enemies that reached the player count as gone. */
  readonly highestWaveCleared: number;
  /**
   * True only when the start wave was cleared by killing: all of its enemies spawned and every
   * one of them, split children included, was killed; none reached the player. Stricter than
   * highestWaveCleared, which also counts a wave whose enemies reached the player. Skip
   * compensation requires it (docs/GDD.md §2.2).
   */
  readonly clearedStartWave: boolean;
  readonly endReason: EndReason;
  readonly ticks: number;
  readonly shards: Num;
  readonly cores: number;
  readonly kills: number;
  /** Damage dealt, split by kind of instance. `hit` counts non-crit primary hits only. */
  readonly damage: DamageBreakdown;
  /**
   * Damage dealt per source id, in SimState.sources order, every numbered source present. Its
   * total is the breakdown's, summed in another order.
   */
  readonly damageBySource: Readonly<Record<string, Num>>;
  /** Budget and cap counters, every id present. */
  readonly counters: Readonly<Record<CounterId, number>>;
  /** Largest single damage instance this run. */
  readonly maxHit: Num;
  /** Seconds spent in waves where the enemies' standard HP was ≤ 1/10 of the average hit. */
  readonly overkillSeconds: number;
  /** Enemies that reached the player (one playerHit event each). */
  readonly leaks: number;
  /**
   * Their total contact damage, as in the playerHit events: the hit that brings life to 0
   * counts in full, so this can exceed max life.
   */
  readonly damageTaken: number;
  /** leaks and damageTaken by enemy type; every type is present, zero if it never got through. */
  readonly damageTakenBy: Readonly<Record<EnemyId, ContactTally>>;
  /** Type of the enemy whose contact brought life to 0; null unless endReason is 'death'. */
  readonly killedBy: EnemyId | null;
}

export interface Simulation {
  readonly state: Readonly<SimState>;
  /**
   * Advance one tick. Returns the events produced this tick. The returned array is reused
   * between calls; copy it if you need to keep it.
   */
  step(input: InputFrame): readonly SimEvent[];
  /** Available once state.finished is true. */
  result(): RunResult;
}
