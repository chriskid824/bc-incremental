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

/**
 * The shot pool (src/sim/systems/shots.ts): every projectile but the volley's homing ones, in
 * typed arrays reused from tick to tick. Slots 0 .. SimState.shotCount − 1 hold the shots in
 * flight, in id order.
 */
export interface ShotPoolState {
  readonly id: Int32Array;
  /** How it moves: 0 straight, 1 homing, 2 lobbed (MOTION_*). */
  readonly motion: Uint8Array;
  /** Its position; a lobbed shot's landing point. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Its velocity per tick; a lobbed shot's launch point. */
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** The tick it expires; a lobbed shot's landing tick. */
  readonly until: Int32Array;
  /** A lobbed shot's form, for drawing; 0 for the others. */
  readonly form: Uint8Array;
}

/**
 * The zone pool (src/sim/systems/zones.ts): the ground zones in typed arrays reused from tick to
 * tick. Slots 0 .. SimState.zoneCount − 1 hold the live zones, in id order.
 */
export interface ZonePoolState {
  readonly id: Int32Array;
  /** Its center. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly radiusSq: Float64Array;
  /** The tick it was created, and the tick it ends. */
  readonly created: Int32Array;
  readonly expiresAt: Int32Array;
  /** 1: a signature zone (the signature attack's own), 0: an effect zone (groundZone). */
  readonly signature: Uint8Array;
}

/**
 * The links of a segment emitter's last judgement (src/sim/systems/segments.ts): link i joins
 * (x1[i], y1[i]) and (x2[i], y2[i]), its endpoints' positions at the judgement, for i < count;
 * past count, stale. count is 0 after a judgement that found fewer than 2 endpoints, and before
 * the first.
 */
export interface SegmentLinesState {
  readonly count: number;
  readonly x1: Float64Array;
  readonly y1: Float64Array;
  readonly x2: Float64Array;
  readonly y2: Float64Array;
}

/** The segments (src/sim/systems/segments.ts) as render and tools read them. */
export interface SegmentViewState {
  /** One per segment emitter, in CompiledBuild.emitters order. */
  readonly lines: readonly SegmentLinesState[];
}

/** DroneViewState.kind: a drone, or a turret (a slot that stays in its seat; C5.4). */
export const DRONE_KIND_DRONE = 0;
export const DRONE_KIND_TURRET = 1;
/**
 * DroneViewState.mode: a drone docked at its dock, dashing at its target, hovering where it lost
 * its target until it may pick again, or flying home to dock; a turret fixed in its seat.
 */
export const DRONE_DOCKED = 0;
export const DRONE_DASH = 1;
export const DRONE_HOVER = 2;
export const DRONE_RETURN = 3;
export const DRONE_FIXED = 4;

/**
 * The drone pool (src/sim/systems/drones.ts) as render and tools read it: the summons of every
 * drone emitter, placed once for the run, in typed arrays. Slots 0 .. SimState.droneCount − 1
 * hold them in id order.
 */
export interface DroneViewState {
  /** Its entity id, 1 up in slot order: the order the stage steps them in. */
  readonly id: Int32Array;
  /** DRONE_KIND_*. */
  readonly kind: Uint8Array;
  /** DRONE_DOCKED and the other modes. */
  readonly mode: Uint8Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Its position at the previous tick, for render interpolation and heading. */
  readonly prevX: Float64Array;
  readonly prevY: Float64Array;
  /** The id of the enemy it dashes at, or that its sortie ended on while it flies home; −1 none. */
  readonly targetId: Int32Array;
  /** Its emitter's index in CompiledBuild.emitters. */
  readonly owner: Int16Array;
  /** Its dock index k of its emitter's drones. */
  readonly seat: Int16Array;
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
  /** The other projectiles; the first shotCount slots are in flight. */
  readonly shots: ShotPoolState;
  shotCount: number;
  /** The ground zones; the first zoneCount slots are live. */
  readonly zones: ZonePoolState;
  zoneCount: number;
  /** The segments' links of their last judgements. */
  readonly segments: SegmentViewState;
  /** The drones; the first droneCount slots hold them, docked from tick 0. */
  readonly drones: DroneViewState;
  droneCount: number;
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
  /**
   * An explode or nova effect (src/sim/effects/execute.ts) went off at (x, y) over `radius`,
   * before its hits.
   */
  | {
      readonly type: 'burst';
      readonly kind: 'explode' | 'nova';
      readonly x: number;
      readonly y: number;
      readonly radius: number;
    }
  /**
   * A bomb of the signature attack (src/sim/emitters/lob.ts), shot `id`, was lobbed from
   * (fromX, fromY) to land at (x, y) on tick `landAt`; `form` is its ShotPoolState.form.
   */
  | {
      readonly type: 'lob';
      readonly id: number;
      readonly fromX: number;
      readonly fromY: number;
      readonly x: number;
      readonly y: number;
      readonly landAt: number;
      readonly form: number;
    }
  /**
   * A bomb exploded at (x, y) over `radius`, after its hits and its chain: it hit `count`
   * enemies, the one nearest the point (`primaryId`) as its primary hit; −1 when it hit none.
   */
  | {
      readonly type: 'explosion';
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly primaryId: number;
      readonly count: number;
    }
  /**
   * A ground zone appeared at (x, y), credited to `source`; it lasts until tick `expiresAt`. A
   * signature zone is the signature attack's own.
   */
  | {
      readonly type: 'zone';
      readonly id: number;
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly expiresAt: number;
      readonly source: number;
      readonly signature: boolean;
    }
  /** A ground zone ended: it expired, or a newer one evicted it at a cap (src/sim/caps.ts). */
  | { readonly type: 'zoneEnd'; readonly id: number; readonly evicted: boolean }
  /**
   * One pulse, whose hits raise no hit events: `hits` enemies hit for `total` damage in all,
   * `crits` the ids of those it crit. `id` is the zone's for kind 'zone', and the emitter's index
   * (CompiledBuild.emitters) for kind 'segment', one per judgement that found 2 endpoints or
   * more; the aura pulses come later in C4.
   */
  | {
      readonly type: 'pulse';
      readonly kind: 'zone' | 'aura' | 'segment';
      readonly id: number;
      readonly hits: number;
      readonly total: Num;
      readonly crits: readonly number[];
    }
  /**
   * A slashLine effect (src/sim/effects/execute.ts) cut along the line from (x1, y1) to (x2, y2),
   * `width` wide, before its hits.
   */
  | {
      readonly type: 'slash';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly width: number;
    }
  /** A coinHit effect struck enemy `targetId` at (x, y), before its hit. */
  | { readonly type: 'coin'; readonly x: number; readonly y: number; readonly targetId: number }
  /**
   * A discharge of the signature arc (src/sim/emitters/arc.ts) from its coil `coil` struck enemy
   * `targetId`, before its hit; a discharge at two targets raises one for each, from the next
   * coil.
   */
  | { readonly type: 'discharge'; readonly coil: number; readonly targetId: number }
  /**
   * Drone `droneId` (DroneViewState.id) impacted enemy `targetId` at (x, y), its center, after
   * its hits: `count` enemies were alive within `radius` of the point as it struck, the target
   * among them, and each that was still alive took one hit.
   */
  | {
      readonly type: 'impact';
      readonly droneId: number;
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly targetId: number;
      readonly count: number;
    }
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
  /** Projectiles not fired because PROJECTILE_CAP were already in flight. */
  'projectilesCapped',
  /** Ground zones a newer one evicted at ZONE_CAP, ZONE_SOURCE_CAP or SIGNATURE_ZONE_CAP. */
  'zonesEvicted',
  /** Repeats dropped because REPEAT_CHARGE_CAP were already waiting for the next attack. */
  'repeatChargesDropped',
  /**
   * Extra-jump rolls not made and bounces refused because their attack had added
   * EXTRA_JUMP_CAP jumps.
   */
  'extraJumpsCapped',
  /**
   * chainJump trigger firings refused, drawing nothing, because the trigger had fired
   * CHAIN_JUMP_EVENT_CAP times in the attack.
   */
  'centerEventsCapped',
  /** Drones not placed because the run had placed its summon cap of them (SUMMON_CAP). */
  'summonCapped',
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
