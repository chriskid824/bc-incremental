/**
 * Run context: everything the systems of one run share (docs/v3/implementation-plan-v3.md
 * §2.15). Built once per run by createRunContext: the config-derived constants, the seeded
 * RNG streams, the entity arrays, SimState, the events buffer and the run's counters. Every
 * system is a plain function taking the context as its first parameter.
 */

import type { Num } from '../../core/num';
import { mul, toNumber, ZERO } from '../../core/num';
import type { Rng } from '../../core/rng';
import { createStreams } from '../../core/rng';
import { ENEMY_IDS } from '../../data/types';
import type { EnemyDef, EnemyId, GameData } from '../../data/types';
import { doomed } from '../ailments/apply';
import { BOSS_SLOW_CAP_OFFSET } from '../ailments/frost';
import { RingPool } from '../ailments/rings';
import { compileBuild } from '../build/compile';
import type { CompiledBuild } from '../build/compile';
import { statAt, staticInput } from '../build/eval';
import type { EvalInput } from '../build/eval';
import type { ModTable } from '../build/modTable';
import { SCOPED_INDEX } from '../build/modTable';
import { ailmentCredit, MAX_SOURCES, SOURCE_CLASS_ORDINAL } from '../build/sources';
import type { AttributionPolicy, SourceTable } from '../build/sources';
import { createCenterEventState, FREEZE_PAYLOADS } from '../effects/centerEvents';
import type { CenterEventState } from '../effects/centerEvents';
import { createEffectEntry, createEffectQueue } from '../effects/queue';
import type { EffectEntry, EffectQueue, PendingKill, TriggerState } from '../effects/queue';
import { createSelectionScratch, selectable } from '../effects/select';
import type { SelectionScratch } from '../effects/select';
import { EVENT } from '../effects/types';
import type { CompiledEffect, CompiledTrigger } from '../effects/types';
import {
  createEmitterRuntime,
  createPayload,
  emitterInterval,
  emitterPayload,
  ROWS,
  SLOT_HIT,
  SLOT_HIT_CRIT,
  slotRow,
} from '../emitters/types';
import type { ChainBudget, EmitterRuntime, Payload } from '../emitters/types';
import type { SpatialGrid } from '../grid';
import type {
  CenterEventScratch,
  HitScratch,
  KillScratch,
  ShotScratch,
  TestModule,
} from '../rules';
import { FOCUS_RANGE, isCovered } from '../targeting';
import { ARENA_HEIGHT, ARENA_WIDTH, COUNTER_IDS, DT, MAX_RUN_SECONDS, TICK_RATE } from '../types';
import type {
  CounterId,
  EnemyState,
  PlayerState,
  ProjectileState,
  RunConfig,
  RunResult,
  SimEvent,
  SimState,
} from '../types';
import { createEnemyGrid } from './grid';
import { createShotPool } from './shots';
import type { ShotHits, ShotPool } from './shots';
import { isToughType } from './spawn';

const DAMAGE = SCOPED_INDEX.damage;
const CRIT_MULTIPLIER = SCOPED_INDEX.critMultiplier;
const FUSION = SOURCE_CLASS_ORDINAL.fusion;

const HALF_WIDTH = ARENA_WIDTH / 2;
const HALF_HEIGHT = ARENA_HEIGHT / 2;

/** Enemies the shots' box query scratch holds at first (RunContext.candidates). */
const SHOT_SCRATCH = 256;

export interface WaveRecord {
  readonly wave: number;
  /** Enemies of the wave in (shuffled) spawn order. */
  readonly queue: readonly EnemyDef[];
  released: number;
  readonly startTick: number;
  /** Released enemies of this wave, split children included, that are still alive. */
  alive: number;
  /** Every enemy is released and gone, killed or not. */
  cleared: boolean;
  /** One of its enemies, split children included, reached the player. */
  leaked: boolean;
  readonly stdHp: number;
  readonly shardsPerStd: number;
}

export interface BurnStack {
  dps: Num;
  /** Tick the stack was applied, and the (possibly fractional) tick it ends. */
  start: number;
  end: number;
  /** Trigger depth of what applied it (src/sim/ailments/records.ts). */
  depth: number;
  /** Source credited with its damage (ailmentCredit), and that source's class. */
  source: number;
  cls: number;
}

export interface Enemy extends EnemyState {
  readonly def: EnemyDef;
  readonly rec: WaveRecord;
  /** Unit vector from the player towards the enemy; the enemy walks it inwards. */
  readonly ux: number;
  readonly uy: number;
  /** Distance from the player along (ux, uy). */
  dist: number;
  /** Distance covered per tick. */
  readonly stepDist: number;
  /** Player radius + enemy radius. */
  readonly contactDist: number;
  readonly burns: BurnStack[];
  /** Damage of stacks that ended or were replaced since the last burn tick. */
  burnPending: Num;
  /**
   * burnPending by the source class of its stacks (center, outer, fusion), kept only when the
   * build's burns can have more than one credit (RunContext.burnMixed); fusion's goes to
   * burnFusionCredit.
   */
  burnPendC: Num;
  burnPendO: Num;
  burnPendF: Num;
  /** The first fusion source whose burn record landed on it; −1 before any. */
  burnFusionCredit: number;
  /** Earliest end tick among the active stacks; Infinity when there are none. */
  burnNextEnd: number;
  /**
   * The last burn tick the ailments system stepped this enemy on (−1 before any), stacks or
   * not: a stack replaced later in that tick has already been paid up to now (addBurn).
   */
  burnSteppedAt: number;
  /**
   * Its DoT rings (src/sim/ailments/rings.ts) by ailment and source class: burn's center, outer
   * and fusion rings, then poison's; −1 for none.
   */
  readonly rings: Int32Array;
  /** Rings it holds; 0 skips them in the DoT step and in doomed. */
  dotRings: number;
  /** Live stacks of its poison rings. */
  poisonStacks: number;
  /**
   * The latest tick a stack in its burn or poison rings ends at; 0 for none. The ailment is held
   * while it is ahead of now (presence, as for burn records), though a ring lasts until its last
   * step.
   */
  burnRingEnd: number;
  poisonRingEnd: number;
  /**
   * Its bleed (src/sim/ailments/bleed.ts), the strongest one applied: damage per second, the
   * tick it started and the tick it ends (0 for none), the credited source, the damage of the
   * bleed it replaced since the last step, and its moving ticks since the last step.
   */
  bleedDps: Num;
  bleedStart: number;
  bleedUntil: number;
  bleedSource: number;
  bleedPending: Num;
  bleedMovedTicks: number;
  /** Shock stacks (src/sim/ailments/shock.ts), all of which wear off at shockUntil. */
  shockStacks: number;
  shockUntil: number;
  /**
   * Its chill meter (src/sim/ailments/frost.ts), 0 to 1 and 0 while frozen (read it through
   * frostMeter); the tick its freeze ends (0 for none); the tick before which frost adds
   * nothing; and the source of the frost that froze it, which its shatter is credited from.
   */
  frost: number;
  frozenUntil: number;
  frostLockUntil: number;
  frostApplier: number;
  /** Serial of the last attack that hit this enemy, so chains skip it. */
  hitMark: number;
  /** Projectiles in flight towards this enemy (see src/sim/targeting.ts). */
  inbound: number;
  /** Serial of the last volley that targeted this enemy. */
  volleyMark: number;
  /** An elite or boss: a focus target once within FOCUS_RANGE (src/sim/targeting.ts). */
  readonly tough: boolean;
  /** A boss (targetKind); `tough` without it is an elite. */
  readonly boss: boolean;
  /**
   * Lowest trigger depth of any ailment applied to it, MAX_DEPTH before any: the depth of its
   * damage over time and of a kill by it.
   */
  ailDepth: number;
  /** Depth of the damage that killed it: the hit's, or ailDepth for damage over time. */
  killDepth: number;
  /** What killed it (killedBy): a KILL_KINDS ordinal (src/sim/effects/flags.ts). */
  killKind: number;
}

export interface Projectile extends ProjectileState {
  target: Enemy;
  /** The damage it delivers: its emitter's payload. */
  readonly payload: Payload;
  /** Trigger depth and origin of its damage: 0 and −1 for an emitter's shots. */
  readonly depth: number;
  readonly origin: number;
}

export interface RunContext {
  // ---- Run inputs and constants ----
  readonly data: GameData;
  /**
   * The build compiled for this run (src/sim/build/compile.ts): final stat values, ModTable,
   * sources, flags, the signature attack's parameters and the rule modules' hooks.
   */
  readonly build: CompiledBuild;
  readonly spawnRng: Rng;
  readonly splitRng: Rng;
  readonly combatRng: Rng;
  readonly dropsRng: Rng;
  /** Trigger chance conditions, rolled at dispatch. */
  readonly triggerRng: Rng;
  /** Rolls inside the hits of triggered effects. */
  readonly effectsRng: Rng;
  readonly startWaveNumber: number;
  readonly waveCap: number;
  readonly maxTicks: number;
  readonly spawnTicks: number;
  readonly waveTimerTicks: number;

  // ---- Damage sources (src/sim/build/sources.ts) ----
  /** The run's source ids; index 0 is 'center'. The same object as build.sources. */
  readonly sources: SourceTable;
  /** Who ailment damage is credited to (build.attribution); in M1 every ailment is the center's. */
  readonly attribution: AttributionPolicy;
  /**
   * Source credited with the damage of burn records: the one credit any burn of the build can
   * have (in M1 the signature attack's), unless burnMixed.
   */
  readonly burnCredit: number;
  /**
   * The build's burns can have more than one credit (a fusion's effect that ignites, say): burn
   * records keep their damage per source class (src/sim/ailments/records.ts).
   */
  readonly burnMixed: boolean;

  // ---- Derived stats, clamped as documented in src/data/stats.ts ----
  /**
   * Scoped stats (damage multiplier, crit and ignite chances, crit multiplier) per tag mask and
   * source (rowKey), from the build's scoped and rule-added modifiers, filled on first use; read
   * through statAt (src/sim/build/eval.ts). The same object as build.table.
   */
  readonly table: ModTable;
  readonly burnDamage: number;
  readonly burnTicks: number;
  readonly burnCap: number;
  /** Burns live in DoT rings (BuildFlags.burnRings, eternalFlame) rather than records. */
  readonly burnRings: boolean;
  readonly poisonDamage: number;
  readonly poisonTicks: number;
  readonly bleedDamage: number;
  readonly bleedTicks: number;
  readonly bleedStationaryMult: number;
  readonly bleedMoveMult: number;
  readonly shockEffect: number;
  readonly shockCap: number;
  readonly shockTicks: number;
  /**
   * Some hit can poison, bleed or shock: the scoped chance or always stat of one of them is not
   * 0 somewhere. Without it, hits skip those rolls, which would draw nothing.
   */
  readonly rollsDots: boolean;
  /**
   * Frost (src/sim/ailments/frost.ts): the slow at a full meter, a normal enemy's and a boss's,
   * and the slow every enemy has (BuildFlags.globalSlow), each 0 to 1; ticks a freeze lasts,
   * then frost adds nothing for frostImmuneTicks; ticks a boss's filled meter stays locked; the
   * extra damage a frozen enemy takes.
   */
  readonly frostSlowCap: number;
  readonly bossFrostSlowCap: number;
  readonly globalSlow: number;
  readonly freezeTicks: number;
  readonly frostImmuneTicks: number;
  readonly bossFrostLockTicks: number;
  readonly frozenDamageTaken: number;
  /** A shatter's share of the victim's max life, and its radius. */
  readonly shatterDamage: number;
  readonly shatterRadius: number;
  /**
   * Some hit adds frost: frostOnHit or a modifier of it is not 0 somewhere. Without it, hits
   * skip reading it.
   */
  readonly hitsFrost: boolean;
  /**
   * The build has damage conversions (src/sim/combat/convert.ts). Without them, hits skip
   * looking for their rows' conversion parts.
   */
  readonly converts: boolean;
  readonly chainCount: number;
  readonly chainRetention: number;
  readonly projectileCount: number;
  readonly chainRangeSq: number;
  readonly projectileStep: number;
  readonly shardGain: number;
  readonly coreGain: number;
  /**
   * Average primary hit of the signature attack, for overkill tracking (docs/GDD.md §2.2): its
   * payload's hit and crit rows, crits with the crit row's multiplier.
   */
  readonly expectedHit: number;
  /**
   * Damage a projectile in flight is expected to deal, for targeting: the signature attack's
   * non-crit primary hit.
   */
  readonly projectileEstimate: Num;

  // ---- Emitters (src/sim/emitters/) ----
  /**
   * The build's emitters with their payloads and counters; index 0 is the signature attack. The
   * emitter stage walks them in this order, skipping the kinds another stage runs
   * (src/sim/systems/emitters.ts).
   */
  readonly emitters: readonly EmitterRuntime[];
  /**
   * The emitters of the kinds another stage runs, each list in emitter order: the contact stage's
   * thorns (src/sim/systems/contact.ts) and the segment stage's, which come later in C4.
   */
  readonly thornsEmitters: readonly EmitterRuntime[];
  readonly segmentEmitters: readonly EmitterRuntime[];

  // ---- Triggers and effects (src/sim/effects/) ----
  /**
   * The input of every stat read and condition check (src/sim/build/eval.ts): hits set its
   * target and chain jump; the contact step sets the player's life fraction once per tick.
   */
  readonly evalInput: EvalInput;
  /** Per trigger index: nthAttack counts, cooldowns, periodic firings. */
  readonly triggerState: TriggerState;
  readonly effectQueue: EffectQueue;
  /**
   * Per effect index, the payload of its hits (explode, nova) or of the hit its ailments count
   * as (applyAilment), on the effects stream; null for the others.
   */
  readonly effectPayloads: readonly (Payload | null)[];
  /** Some hit or crit trigger or onHit hook listens: the hit path dispatches. */
  readonly hitListeners: boolean;
  /** Some ailmentApplied trigger listens: applications dispatch. */
  readonly appliedListeners: boolean;
  /** The shatter triggers, recorded with a frozen victim's shatter, in order. */
  readonly shatterTriggers: Int32Array;
  /**
   * Per credited source index, the payload of shatter hits credited to it, filled on first use
   * (src/sim/effects/execute.ts).
   */
  readonly shatterPayloads: (Payload | null)[];
  /**
   * The freeze payload limit (src/sim/effects/centerEvents.ts); null when no fusion's trigger or
   * hook listens to freezes.
   */
  readonly freezeLimiter: FreezeLimiter | null;
  /**
   * Who listens to each center event, whether its list is read, and the freeze list's query
   * scratch (src/sim/effects/centerEvents.ts).
   */
  readonly centerEvents: CenterEventState;
  /** Triggers on kill or diedWithAilment that run at the kill (transfers), in trigger order. */
  readonly killInline: Int32Array;
  /** The other triggers on kill or diedWithAilment, recorded as pending kills, in order. */
  readonly killPending: Int32Array;
  /** Kills take a snapshot of their flags: kill triggers or onKill hooks exist. */
  readonly killListeners: boolean;
  /** This tick's pending kills: pendingKills[0 .. pendingCount), reused objects. */
  readonly pendingKills: PendingKill[];
  pendingCount: number;
  /** The entry the effect phase runs, and the one a kill's transfer triggers run. */
  readonly effectEntry: EffectEntry;
  readonly inlineEntry: EffectEntry;
  /** Ticks in a row that ended with effects left past the budget. */
  budgetStreak: number;
  /**
   * The enemy the last trigger selector picked (src/sim/effects/select.ts), null for 'player':
   * written by the dispatch gates and read by the same firing right after.
   */
  selected: Enemy | null;
  /** The selection in progress, which selAccept reads (src/sim/effects/select.ts). */
  readonly selection: SelectionScratch;

  // ---- Entities and public state ----
  readonly enemies: Enemy[];
  /** The volley's homing projectiles; every other projectile is in the shot pool. */
  readonly projectiles: Projectile[];
  /** The shot pool (src/sim/systems/shots.ts), also SimState.shots. */
  readonly shots: ShotPool;
  readonly player: PlayerState;
  readonly state: SimState;
  /** Events of the current tick; step() clears it at the start of each tick. */
  readonly events: SimEvent[];
  /** The enemies sorted into cells, rebuilt every tick after movement (systems/grid.ts). */
  readonly grid: SpatialGrid<Enemy>;
  /** The kill the onKill hooks see, refilled at every kill (killEnemy in death.ts). */
  readonly killScratch: KillScratch;
  /** The hit modifyDamage and onHit hooks see (src/sim/combat/hit.ts). */
  readonly hitScratch: HitScratch;
  /** The center event onCenterEvent hooks see (src/sim/effects/centerEvents.ts). */
  readonly centerScratch: CenterEventScratch;
  /** The attack the onAttack hooks see, reset at every attack (countAttack in volley.ts). */
  readonly shotScratch: ShotScratch;
  /** The current attack's chain budget, reset at every attack (src/sim/combat/chain.ts). */
  readonly chainBudget: ChainBudget;
  /**
   * The spreads' scratch list for the targets of one spread (spreadAilment,
   * src/sim/ailments/); only spreads may use it. A kill spreads ailments, so a query whose
   * targets can die needs a list of its own.
   */
  readonly spreadTargets: Enemy[];
  /** The effect executors' scratch list for area targets (src/sim/effects/execute.ts). */
  readonly effectTargets: Enemy[];
  /**
   * The largest radius of an enemy type that is not tough: a straight shot looks for the enemies
   * it can reach in its path's box padded by this (src/sim/systems/shots.ts), and for the tough
   * ones apart.
   */
  readonly shotPad: number;
  /**
   * Grid source indices of a box query's candidates (SpatialGrid.boxIndices), read before any of
   * them is hit; grown by its users to hold every enemy.
   */
  candidates: Int32Array;
  /** The enemies one straight shot's step hits, in hit order (src/sim/systems/shots.ts). */
  readonly shotHits: ShotHits;
  /** The DoT rings of every enemy (src/sim/ailments/rings.ts). */
  readonly rings: RingPool;
  /** The step's damage per credited source of one ailment (src/sim/systems/ailments.ts). */
  readonly dotParts: DotParts;
  /** The parts of the converted hit being dealt (src/sim/combat/convert.ts). */
  readonly hitParts: HitParts;
  /**
   * Some bleed has taken an enemy's slot this run (src/sim/ailments/bleed.ts): until then no
   * enemy bleeds, and movement skips counting bleeding enemies' moves.
   */
  bleedApplied: boolean;
  /**
   * Some frost has reached an enemy's meter this run (src/sim/ailments/frost.ts): until then,
   * without a global slow, movement skips slowing enemies.
   */
  frostApplied: boolean;

  // ---- Waves ----
  /** Started waves that are not cleared yet, in wave order. */
  readonly open: WaveRecord[];
  current: WaveRecord | null;
  /** The start wave, once started; it decides RunResult.clearedStartWave. */
  startRec: WaveRecord | null;

  // ---- Counters ----
  /** The current tick (state.tick). */
  now: number;
  nextEnemyId: number;
  nextProjectileId: number;
  /** Serial of the current attack's chain; enemies it already hit carry it (hitMark). */
  attackSerial: number;
  lastBurnTick: number;
  enemiesDirty: boolean;
  projectilesDirty: boolean;

  // ---- Run tallies (RunResult) ----
  kills: number;
  overkillTicks: number;
  damageHit: Num;
  damageCrit: Num;
  damageChain: Num;
  damageBurn: Num;
  damagePoison: Num;
  damageBleed: Num;
  /** Damage dealt per source index (RunResult.damageBySource); see tally in combat/hit.ts. */
  readonly bySource: Num[];
  maxHit: Num;
  /** Contact hits and damage per enemy type (RunResult.damageTakenBy). */
  readonly taken: Record<EnemyId, { hits: number; damage: number }>;
  killedBy: EnemyId | null;
  /** RunResult.counters. */
  readonly counters: Record<CounterId, number>;
  runResult: RunResult | null;

  // ---- Target predicates for grid queries (src/sim/targeting.ts), bound once per run ----
  /**
   * Worth a projectile: not covered by the projectiles in flight, and the burns already on it
   * will not kill it.
   */
  readonly shootable: (enemy: Enemy) => boolean;
  /**
   * shootable for later projectiles of a volley: they spread over other enemies than the
   * volley's earlier ones, except onto a focus target.
   */
  readonly shootableInVolley: (enemy: Enemy) => boolean;
  /** Not hit by the current attack yet, so a chain jump can reach it. */
  readonly chainable: (enemy: Enemy) => boolean;
  /** Accepted by the current trigger selection (selectable in src/sim/effects/select.ts). */
  readonly selAccept: (enemy: Enemy) => boolean;
}

/**
 * The freeze payload limit's state: which triggers (by trigger index) and onCenterEvent hooks
 * (by hook index) are a fusion's, and a ring of the ticks of the last freezes whose fusion
 * payloads ran, `count` of them, the oldest at `next` once full.
 */
export interface FreezeLimiter {
  readonly fusionTrigger: Uint8Array;
  readonly fusionHook: Uint8Array;
  readonly ticks: Float64Array;
  next: number;
  count: number;
}

/**
 * One ailment's damage of one DoT step on one enemy, split by the sources it is credited to:
 * source[0 .. n) and amount[0 .. n).
 */
export interface DotParts {
  n: number;
  readonly source: Int32Array;
  readonly amount: Num[];
}

/**
 * The parts of one converted hit before takenMult and the hooks, in its row's part order: tags
 * mask[0 .. n) and amount[0 .. n), which add up to total.
 */
export interface HitParts {
  n: number;
  readonly mask: Int32Array;
  readonly amount: Num[];
  total: Num;
}

/** Stats that let a hit poison, bleed or shock (RunContext.rollsDots). */
const DOT_ROLL_STATS = [
  'poisonChance',
  'bleedChance',
  'shockChance',
  'poisonAlways',
  'bleedAlways',
  'shockAlways',
] as const;

/** Whole part plus a chance for one more, e.g. 2.3 → 2 or 3 (30%). */
export function rollCount(value: number, roll: (chance: number) => boolean): number {
  const whole = Math.floor(value);
  return whole + (value > whole && roll(value - whole) ? 1 : 0);
}

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Elites and bosses close to the player draw every shot until covered. */
export const focused = (enemy: Enemy): boolean => enemy.tough && enemy.dist <= FOCUS_RANGE;

/**
 * The payload of an effect that hits (explode, nova) or applies an ailment (applyAilment), on the
 * effects stream: its tags and source, no flags, never chaining. An applied ailment's damage is
 * that of a hit of the payload, so only its burn row is read.
 */
function effectPayload(fx: CompiledEffect, rng: Rng): Payload | null {
  // A shatter's payload depends on its credit (RunContext.shatterPayloads).
  if (fx.tags === 0 || fx.kind === 'shatter') return null;
  const hits = fx.kind !== 'applyAilment';
  return createPayload({
    baseDamage: fx.baseDamage,
    tags: fx.tags,
    source: fx.source,
    flags: 0,
    rng,
    chains: false,
    rollsAilments: hits,
    canCrit: hits,
    damageMode: ROWS,
  });
}

/**
 * Builds the context of one run; the config must already be validated. testModules are for
 * tests only (src/sim/rules/module.ts).
 */
export function createRunContext(
  config: RunConfig,
  data: GameData,
  testModules: readonly TestModule[] = [],
): RunContext {
  const build = compileBuild(config.stats, config.rules, config.signature, testModules);
  const { values, flags, signature, sources, attribution, table } = build;
  const {
    spawn: spawnRng,
    split: splitRng,
    combat: combatRng,
    drops: dropsRng,
    trigger: triggerRng,
    effects: effectsRng,
  } = createStreams(config.seed);
  const startWaveNumber = config.startWave;

  // Emitters fire on the combat stream; the emitter stage runs those of the kinds it steps, the
  // contact stage the thorns.
  const emitters = build.emitters.map((spec, index) =>
    createEmitterRuntime(
      spec,
      emitterPayload(build, spec, combatRng),
      index,
      emitterInterval(build, spec),
    ),
  );
  const thornsEmitters = emitters.filter((em) => em.spec.kind === 'thorns');
  const signatureEmitter = emitters[0] as EmitterRuntime;
  const signaturePayload = signatureEmitter.payload;

  // Derived stats, clamped as documented in src/data/stats.ts. The estimates read the signature
  // payload's primary hit rows (rows first: filling one may grow the table's arrays).
  const hitRow = slotRow(build, signaturePayload, SLOT_HIT);
  const critRow = slotRow(build, signaturePayload, SLOT_HIT_CRIT);
  const estimate = staticInput();
  const hitMult = statAt(table, hitRow, DAMAGE, estimate);
  const critHitMult = statAt(table, critRow, DAMAGE, estimate);
  const critMultiplier = statAt(table, critRow, CRIT_MULTIPLIER, estimate);
  const forceCritEvery = signature.forceCritEvery;
  const averageCrit = forceCritEvery > 0 ? 1 / forceCritEvery : clamp01(values.critChance);
  const expectedHit =
    toNumber(signaturePayload.baseDamage) *
    ((1 - averageCrit) * hitMult + averageCrit * critMultiplier * critHitMult);

  const projectileEstimate = mul(signaturePayload.baseDamage, hitMult);

  const enemies: Enemy[] = [];
  const projectiles: Projectile[] = [];
  const shots = createShotPool();
  let shotPad = 0;
  for (const id of ENEMY_IDS) {
    if (!isToughType(id)) shotPad = Math.max(shotPad, data.enemies[id].radius);
  }
  const maxLife = flags.maxLife ?? values.maxLife;
  const player = {
    x: HALF_WIDTH,
    y: HALF_HEIGHT,
    life: maxLife,
    maxLife,
  };
  const state: SimState = {
    tick: 0,
    wave: startWaveNumber,
    highestWaveReached: 0,
    highestWaveCleared: 0,
    player,
    enemies,
    projectiles,
    shots,
    shotCount: 0,
    shards: ZERO,
    cores: 0,
    finished: false,
    sources: sources.names,
  };
  // Triggers: per-trigger state, the kill lists, and the payloads of effects that hit.
  const { triggers, triggersOn, effects, hooks } = build;
  const nextPeriodic = new Float64Array(triggers.length);
  for (const t of triggers) {
    if (t.periodTicks > 0) nextPeriodic[t.index] = t.periodTicks + (t.index % t.periodTicks);
  }
  const killTriggers = [
    ...(triggersOn[EVENT.kill] as Int32Array),
    ...(triggersOn[EVENT.diedWithAilment] as Int32Array),
  ]
    .sort((a, b) => a - b)
    .map((i) => triggers[i] as CompiledTrigger);
  const killInline = Int32Array.from(killTriggers.filter((t) => t.inline).map((t) => t.index));
  const killPending = Int32Array.from(killTriggers.filter((t) => !t.inline).map((t) => t.index));
  const effectPayloads = effects.map((fx) => effectPayload(fx, effectsRng));
  // Who burn damage can be credited to: the applier of every payload whose hits ignite, and of
  // every applyAilment burn.
  const burnCredits = new Set<number>();
  for (const emitter of emitters) {
    if (emitter.payload.rollsAilments) {
      burnCredits.add(ailmentCredit(sources, attribution, 'burn', emitter.payload.source));
    }
  }
  effects.forEach((fx, i) => {
    const p = effectPayloads[i];
    const burns = fx.spec.kind === 'applyAilment' && fx.spec.ailment === 'burn';
    if (p !== undefined && p !== null && (p.rollsAilments || burns)) {
      burnCredits.add(ailmentCredit(sources, attribution, 'burn', p.source));
    }
  });
  const burnCredit =
    burnCredits.size === 1
      ? ([...burnCredits][0] as number)
      : ailmentCredit(sources, attribution, 'burn', signaturePayload.source);
  const rollsDots = DOT_ROLL_STATS.some(
    (stat) => values[stat] !== 0 || build.mods.some((mod) => mod.stat === SCOPED_INDEX[stat]),
  );
  const hitListeners =
    (triggersOn[EVENT.hit] as Int32Array).length !== 0 ||
    (triggersOn[EVENT.crit] as Int32Array).length !== 0 ||
    hooks.onHit.length !== 0;
  const hitsFrost =
    values.frostOnHit !== 0 || build.mods.some((mod) => mod.stat === SCOPED_INDEX.frostOnHit);
  // The freeze payload limit gates the fusions' triggers and hooks on freeze.
  const fusionOf = (t: CompiledTrigger): number => (sources.cls[t.source] === FUSION ? 1 : 0);
  const fusionTrigger = Uint8Array.from(triggers, fusionOf);
  const fusionHook = Uint8Array.from(build.hookOwners.onCenterEvent, (i) =>
    fusionOf(triggers[i] as CompiledTrigger),
  );
  const freezeFusions =
    (triggersOn[EVENT.freeze] as Int32Array).some((i) => fusionTrigger[i] === 1) ||
    fusionHook.includes(1);
  const frostSlowCap = clamp01(values.frostSlowCap);

  const taken = {} as Record<EnemyId, { hits: number; damage: number }>;
  for (const id of ENEMY_IDS) taken[id] = { hits: 0, damage: 0 };
  const counters = {} as Record<CounterId, number>;
  for (const id of COUNTER_IDS) counters[id] = 0;

  const ctx: RunContext = {
    data,
    build,
    spawnRng,
    splitRng,
    combatRng,
    dropsRng,
    triggerRng,
    effectsRng,
    startWaveNumber,
    waveCap: config.waveCap ?? Infinity,
    maxTicks: config.maxTicks ?? MAX_RUN_SECONDS * TICK_RATE,
    spawnTicks: data.waves.spawnDurationSec * TICK_RATE,
    waveTimerTicks: data.waves.waveTimerSec * TICK_RATE,

    sources,
    attribution,
    burnCredit,
    burnMixed: burnCredits.size > 1,

    table,
    burnDamage: values.burnDamage,
    burnTicks: Math.max(0, values.burnDuration * TICK_RATE),
    burnCap: Math.max(1, Math.floor(values.burnMaxStacks)),
    burnRings: flags.burnRings,
    poisonDamage: values.poisonDamage,
    poisonTicks: Math.max(0, values.poisonDuration * TICK_RATE),
    bleedDamage: values.bleedDamage,
    bleedTicks: Math.max(0, values.bleedDuration * TICK_RATE),
    bleedStationaryMult: values.bleedStationaryMult,
    bleedMoveMult: flags.bleedMoveMult,
    shockEffect: values.shockEffect,
    shockCap: Math.max(0, Math.floor(values.shockMaxStacks)),
    shockTicks: Math.max(0, values.shockDuration * TICK_RATE),
    rollsDots,
    frostSlowCap,
    bossFrostSlowCap: clamp01(values.frostSlowCap - BOSS_SLOW_CAP_OFFSET),
    globalSlow: clamp01(flags.globalSlow),
    freezeTicks: Math.max(0, values.freezeDuration * TICK_RATE),
    frostImmuneTicks: Math.max(0, flags.frostImmuneTicks),
    bossFrostLockTicks: Math.max(0, flags.bossLockTicks, flags.bossMinGapTicks),
    frozenDamageTaken: values.frozenDamageTaken,
    shatterDamage: values.shatterDamage,
    shatterRadius: Math.max(0, values.shatterRadius),
    hitsFrost,
    converts: build.conversions.length !== 0,
    chainCount: Math.max(0, values.chainCount),
    chainRetention: clamp01(values.chainRetention),
    projectileCount: Math.max(1, values.projectileCount),
    chainRangeSq: Math.max(0, values.chainRange) ** 2,
    projectileStep: values.projectileSpeed * DT,
    shardGain: values.shardGain,
    coreGain: Math.max(0, values.coreGain),
    expectedHit,
    projectileEstimate,

    emitters,
    thornsEmitters,
    segmentEmitters: [],

    evalInput: { now: 0, target: null, chainJump: 0, playerLifeFrac: 1 },
    triggerState: {
      count: new Int32Array(triggers.length),
      readyAt: new Float64Array(triggers.length),
      nextPeriodic,
    },
    effectQueue: createEffectQueue(),
    effectPayloads,
    hitListeners,
    appliedListeners: (triggersOn[EVENT.ailmentApplied] as Int32Array).length !== 0,
    shatterTriggers: triggersOn[EVENT.shatter] as Int32Array,
    shatterPayloads: new Array<Payload | null>(MAX_SOURCES).fill(null),
    freezeLimiter: freezeFusions
      ? {
          fusionTrigger,
          fusionHook,
          ticks: new Float64Array(FREEZE_PAYLOADS),
          next: 0,
          count: 0,
        }
      : null,
    centerEvents: createCenterEventState(build),
    killInline,
    killPending,
    killListeners: killInline.length !== 0 || killPending.length !== 0 || hooks.onKill.length !== 0,
    pendingKills: [],
    pendingCount: 0,
    effectEntry: createEffectEntry(),
    inlineEntry: createEffectEntry(),
    budgetStreak: 0,
    selected: null,
    selection: createSelectionScratch(),

    enemies,
    projectiles,
    shots,
    player,
    state,
    events: [],
    grid: createEnemyGrid(),
    killScratch: { origin: -1, depth: 0, x: 0, y: 0, flags: 0 },
    hitScratch: {
      target: null as unknown as Enemy,
      x: 0,
      y: 0,
      mask: 0,
      source: 0,
      crit: false,
      chainIndex: 0,
      depth: 0,
      origin: -1,
      flags: 0,
      amount: ZERO,
    },
    centerScratch: {
      event: 0,
      depth: 0,
      origin: -1,
      flags: 0,
      target: null,
      x: 0,
      y: 0,
      radius: 0,
      list: [],
      listCount: 0,
      fromX: 0,
      fromY: 0,
    },
    shotScratch: { forceCrit: false },
    chainBudget: { hits: 0, extraJumps: 0, centerEvents: 0 },
    spreadTargets: [],
    effectTargets: [],
    shotPad,
    candidates: new Int32Array(SHOT_SCRATCH),
    shotHits: { t: new Float64Array(SHOT_SCRATCH), enemies: [] },
    rings: new RingPool(),
    dotParts: { n: 0, source: new Int32Array(6), amount: new Array<Num>(6).fill(ZERO) },
    // A hit row has the share that stays a hit and one part per conversion at most.
    hitParts: {
      n: 0,
      mask: new Int32Array(1 + build.conversions.length),
      amount: new Array<Num>(1 + build.conversions.length).fill(ZERO),
      total: ZERO,
    },
    bleedApplied: false,
    frostApplied: false,

    open: [],
    current: null,
    startRec: null,

    now: 0,
    nextEnemyId: 1,
    nextProjectileId: 1,
    attackSerial: 0,
    lastBurnTick: 0,
    enemiesDirty: false,
    projectilesDirty: false,

    kills: 0,
    overkillTicks: 0,
    damageHit: ZERO,
    damageCrit: ZERO,
    damageChain: ZERO,
    damageBurn: ZERO,
    damagePoison: ZERO,
    damageBleed: ZERO,
    bySource: new Array<Num>(MAX_SOURCES).fill(ZERO),
    maxHit: ZERO,
    taken,
    killedBy: null,
    counters,
    runResult: null,

    shootable: (enemy) => !isCovered(enemy, projectileEstimate) && !doomed(ctx, enemy),
    // The volley is the signature attack's, the only emitter that fires volleys.
    shootableInVolley: (enemy) =>
      !isCovered(enemy, projectileEstimate) &&
      !((enemy.volleyMark === signatureEmitter.volley && !focused(enemy)) || doomed(ctx, enemy)),
    chainable: (enemy) => enemy.hitMark !== ctx.attackSerial,
    selAccept: (enemy) => selectable(ctx, enemy),
  };
  return ctx;
}
