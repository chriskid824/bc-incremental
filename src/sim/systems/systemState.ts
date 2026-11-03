/**
 * The state of the systems that keep their own (RunContext.sys, docs/v3 C4 design §0.7): one
 * member per system, each with its type and factory here. createRunContext builds `sys` as one
 * literal, so its shape is fixed when it is created. The systems import their state types from
 * this module, which stays a leaf: its value imports are only core/num.ts, caps.ts,
 * build/sources.ts, build/eval.ts and systems/grid.ts, with grid.ts and types.ts, which reach
 * nothing that imports systems/context.ts (systemState.test.ts checks it); every other import is
 * an `import type` declaration.
 */

import type { Num } from '../../core/num';
import { ZERO } from '../../core/num';
import type { Rng } from '../../core/rng';
import type { EnemyId } from '../../data/types';
import {
  CHAIN_HIT_CAP,
  DRONE_MEMORY,
  EXTRA_JUMP_CAP,
  REPEAT_CHARGE_CAP,
  SIGNATURE_ZONE_CAP,
  ZONE_CAP,
} from '../caps';
import type { CompiledBuild } from '../build/compile';
import { IN_ZONE } from '../build/eval';
import type { CompiledCondition } from '../build/eval';
import { MAX_SOURCES } from '../build/sources';
import type { CompiledEffect } from '../effects/types';
import type { EmitterRuntime, Payload, SegmentSpec } from '../emitters/types';
import type { GridPoint, SpatialGrid } from '../grid';
import { DRONE_DOCKED, DRONE_FIXED, DRONE_KIND_TURRET, DT, TICK_RATE } from '../types';
import type {
  BulletViewState,
  DroneViewState,
  SegmentLinesState,
  SegmentViewState,
  ZonePoolState,
} from '../types';
import type { Enemy } from './context';
import { createEnemyGrid } from './grid';

/** RunContext.sys: one member per system that keeps state of its own. */
export interface SystemState {
  /** The tally of the pulse being dealt (src/sim/systems/zones.ts). */
  readonly pulse: PulseAcc;
  /** The ground zones (src/sim/systems/zones.ts), also SimState.zones. */
  readonly zones: ZonePool;
  /** The lob's aim and landing (src/sim/emitters/lob.ts). */
  readonly lob: LobState;
  /** The repeats of the signature attack (repeatAttack, src/sim/effects/execute.ts). */
  readonly repeat: RepeatState;
  /** A kill's transfers to its split children (toSplitChildren, src/sim/systems/death.ts). */
  readonly split: SplitState;
  /** The segments and their judgements (src/sim/systems/segments.ts), also SimState.segments. */
  readonly segments: SegmentState;
  /** The general chain path's levels and the run's table without a policy (combat/policy.ts). */
  readonly chain: ChainState;
  /** The drones and their stage's scratch (src/sim/systems/drones.ts), also SimState.drones. */
  readonly drones: DronePool;
  /**
   * The v3 enemies' state: whether the run is a v3 run, whose enemies carry a record, its enemy
   * cap, and the enemy AI step's list and inputs (src/sim/systems/enemyAi.ts).
   */
  readonly enemyAi: EnemyAiState;
  /** The player's defences (src/sim/systems/contact.ts damagePlayer); null in an M1 build. */
  readonly defence: PlayerDefenceState;
  /** The shooters' bullets (src/sim/systems/bullets.ts), also SimState.bullets. */
  readonly bullets: BulletPool;
  /** The elite affixes' stream, lists and cadence factor (src/sim/systems/affixes.ts). */
  readonly affixes: AffixState;
  /** The combo stacks and the timed buffs, with their cadence factors (src/sim/systems/combo.ts). */
  readonly combo: ComboState;
}

/**
 * One pulse's tally: the pulse's owner (stepZones) reads it once and passes it down to its
 * hits, which add to it instead of raising hit events (applyHitDamage in combat/hit.ts).
 */
export interface PulseAcc {
  /** Enemies the pulse hit, and the damage it dealt them in all. */
  hits: number;
  total: Num;
  /** Ids of the enemies it crit, in hit order: crits[0 .. critCount); past it, stale. */
  readonly crits: number[];
  critCount: number;
  /** The pulse payload's hit row without and with crit (hoistPulseRows). */
  row: number;
  critRow: number;
  /**
   * Something listens to hits, but no hit or crit trigger and no onHit hook can act on the
   * pulse's hits (hoistPulseRows).
   */
  quiet: boolean;
}

export function createPulseAcc(): PulseAcc {
  return { hits: 0, total: ZERO, crits: [], critCount: 0, row: -1, critRow: -1, quiet: false };
}

/**
 * The zone pool of a run (RunContext.sys.zones), also SimState.zones: ZONE_CAP effect zones
 * and SIGNATURE_ZONE_CAP signature zones in one pool. Slots 0 .. count − 1 hold the live zones
 * in id order, kept in order when zones end: the view's arrays (ZonePoolState) and `record`,
 * which are indexed by slot. Every other per-zone array is indexed by the zone's record, which
 * it keeps from its creation to its end, so closing a slot moves only the slot arrays.
 */
export interface ZonePool extends ZonePoolState {
  /** Live zones; effect zones among them, and signature zones. */
  count: number;
  live: number;
  liveSignature: number;
  /**
   * The record of the zone in each slot. A byte holds it while the caps total at most 256
   * (ZONE_CAP + SIGNATURE_ZONE_CAP, 80); caps past that must widen record and free.
   */
  readonly record: Uint8Array;
  /** The free records, the next to use on top: free[0 .. freeCount). */
  readonly free: Uint8Array;
  freeCount: number;
  /** Multiplier of its hits, damagePctPerSec × 0.25 of the payload; 0: it hits nothing. */
  readonly scale: Float64Array;
  /** The payload that created it: its hits' and its ailment's base, rows and stream. */
  readonly payload: Payload[];
  /** Source index its hits and terms are credited to. */
  readonly source: Int16Array;
  /** Trigger depth and origin of its hits and terms. */
  readonly depth: Uint8Array;
  readonly origin: Int32Array;
  /** The ailment it applies (APPLIED_AILMENTS ordinal); −1 for none. */
  readonly ailment: Int8Array;
  /** Stacks of it per pulse (ailmentStacks), and its damage as a share of the payload's. */
  readonly stacks: Int32Array;
  readonly ailmentPct: Float64Array;
  /** Frost it adds per pulse: addFrostPerSec × 0.25. */
  readonly frost: Float64Array;
  /** The slow it holds on the enemies in it; 0 for none. */
  readonly slow: Float64Array;
  /** 1: its pulses mark the enemies in it for inZone (stampSources). */
  readonly stamp: Uint8Array;
  /** Live effect zones per source index (ZONE_SOURCE_CAP). */
  readonly perSource: Uint8Array;
  /** The last zone id given. */
  nextId: number;
  /** A zone has slowed an enemy this run: movement takes its slow path from then on. */
  slowApplied: boolean;
  /** 1 for each source index an inZone condition names: only their zones mark enemies. */
  readonly stampSources: Uint8Array;
  /** The pulse's within() output (stepZones). */
  readonly targets: Enemy[];
}

/** Every source index an inZone condition of `conds` names, marked in `out`. */
function markZoneSources(conds: readonly CompiledCondition[] | null, out: Uint8Array): void {
  if (conds === null) return;
  for (const c of conds) if (c.code === IN_ZONE) out[c.a] = 1;
}

/** An empty pool for `build`, whose inZone conditions decide which sources mark enemies. */
export function createZonePool(build: CompiledBuild): ZonePool {
  const n = ZONE_CAP + SIGNATURE_ZONE_CAP;
  // Record 0 on top, so a run's records are first taken in order and `payload` grows packed.
  const free = new Uint8Array(n);
  for (let k = 0; k < n; k++) free[k] = n - 1 - k;
  const stampSources = new Uint8Array(MAX_SOURCES);
  for (const mod of build.mods) markZoneSources(mod.cond, stampSources);
  for (const t of build.triggers) markZoneSources(t.conds, stampSources);
  return {
    count: 0,
    live: 0,
    liveSignature: 0,
    record: new Uint8Array(n),
    free,
    freeCount: n,
    id: new Int32Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    radiusSq: new Float64Array(n),
    created: new Int32Array(n),
    expiresAt: new Int32Array(n),
    signature: new Uint8Array(n),
    scale: new Float64Array(n),
    payload: [],
    source: new Int16Array(n),
    depth: new Uint8Array(n),
    origin: new Int32Array(n),
    ailment: new Int8Array(n),
    stacks: new Int32Array(n),
    ailmentPct: new Float64Array(n),
    frost: new Float64Array(n),
    slow: new Float64Array(n),
    stamp: new Uint8Array(n),
    perSource: new Uint8Array(MAX_SOURCES),
    nextId: 0,
    slowApplied: false,
    stampSources,
    targets: [],
  };
}

/**
 * The lob's aim and landing scratch (RunContext.sys.lob, src/sim/emitters/lob.ts). A firing's
 * one dense scan fills block, counts and aimed; each bomb it aims adds its enemy to picked.
 */
export interface LobState {
  /** The current bomb's landing point: the aim writes it, the launch reads it. */
  x: number;
  y: number;
  /** The dense scan's densest point: its own, not the selectors' (RunContext.selection). */
  readonly dense: GridPoint;
  /** A landing's within() output: the enemies its explosion hits. */
  readonly blast: Enemy[];
  /** The firing's candidates: the alive enemies of the densest block, in source order. */
  readonly block: Enemy[];
  /** Alive enemies within the explosion's radius of each candidate, block[i]'s at i. */
  readonly counts: number[];
  /**
   * 1 when a dense bomb of this firing aimed at block[i]; the scan writes 0 for each candidate.
   * A far bomb (遠投) marks nothing, so a later dense bomb may aim at its enemy again (Q3/F15).
   */
  readonly aimed: number[];
  /** The enemies this firing's bombs aimed at, in order: picked[0 .. picks). */
  readonly picked: Enemy[];
  picks: number;
  /** The firing's candidates, block[0 .. m); −1 before its dense scan. */
  m: number;
  /** The explosion's radius, squared, and SALVO_SEPARATION radii, squared: set per firing. */
  radiusSq: number;
  sepSq: number;
  /**
   * The event a landing queues a 連環爆 explosion on (a ModuleEvent, src/sim/rules/api.ts): the
   * victim's point, no target, flags 0. Rewritten for each kill: the queue copies its fields.
   */
  readonly event: {
    target: null;
    x: number;
    y: number;
    depth: number;
    origin: number;
    flags: number;
  };
}

export function createLobState(): LobState {
  return {
    x: 0,
    y: 0,
    dense: { x: 0, y: 0 },
    blast: [],
    block: [],
    counts: [],
    aimed: [],
    picked: [],
    picks: 0,
    m: -1,
    radiusSq: 0,
    sepSq: 0,
    event: { target: null, x: 0, y: 0, depth: 0, origin: -1, flags: 0 },
  };
}

/**
 * The repeats of the signature attack (RunContext.sys.repeat, the repeatAttack executor in
 * src/sim/effects/execute.ts): each repeatAttack effect's payload, the repeats waiting for the
 * attack's next own firing, 殘影's echo, and the repeats waiting for a tick.
 */
export interface RepeatState {
  /**
   * The payload of each repeatAttack effect, by its index in CompiledBuild.effects; null for
   * every other effect.
   */
  readonly payloads: readonly (Payload | null)[];
  /**
   * The repeats waiting for the next counted attack (timing 'nextAttack'), first in first out:
   * a ring of REPEAT_CHARGE_CAP slots, each with its repeat's payload and its hits' trigger depth
   * and origin; the oldest at head, count of them.
   */
  readonly charges: {
    readonly payload: (Payload | null)[];
    readonly depth: Int32Array;
    readonly origin: Int32Array;
    head: number;
    count: number;
  };
  /**
   * 殘影 (BuildFlags.comboEcho, src/sim/systems/combo.ts): the payload of its echoes, the
   * signature's at its damagePct as a repeatAttack's (repeatPayload in context.ts), and their
   * delay in whole ticks; null without comboEcho.
   */
  readonly echo: { readonly payload: Payload; readonly ticks: number } | null;
  /** The repeats waiting for their tick (DelayedRepeats). */
  readonly delayed: DelayedRepeats;
}

/**
 * The repeats waiting for their tick (scheduleRepeat in src/sim/effects/queue.ts, fired by
 * drainDelayedRepeats in src/sim/effects/execute.ts): a ring of entries ordered by their due tick
 * and then by their seq, the run's count of schedulings when each was scheduled, so of two due
 * on one tick the one scheduled first fires first. Each entry carries what a repeat charge
 * carries, its payload and its hits' trigger depth and origin, and its due tick; the earliest at
 * head, count of them. Its arrays hold no slot until the first scheduling, and double when full,
 * so scheduling allocates nothing once they have grown; nothing caps them.
 */
export interface DelayedRepeats {
  /** Slot of the earliest entry. */
  head: number;
  count: number;
  /** Capacity − 1; the capacity is 0 or a power of two. */
  capMask: number;
  /** Schedulings so far in the run: the seq of the next entry. */
  scheduled: number;
  /** Per slot: the entry's due tick and seq, payload, and its hits' trigger depth and origin. */
  due: Float64Array;
  seq: Float64Array;
  payload: (Payload | null)[];
  depth: Int32Array;
  origin: Int32Array;
}

/** Delayed repeats of `capacity` slots (0, or a power of two), none waiting. */
export function createDelayedRepeats(capacity = 0): DelayedRepeats {
  return {
    head: 0,
    count: 0,
    capMask: capacity - 1,
    scheduled: 0,
    due: new Float64Array(capacity),
    seq: new Float64Array(capacity),
    payload: new Array<Payload | null>(capacity).fill(null),
    depth: new Int32Array(capacity),
    origin: new Int32Array(capacity),
  };
}

export function createRepeatState(
  payloads: readonly (Payload | null)[],
  echo: RepeatState['echo'],
): RepeatState {
  return {
    payloads,
    charges: {
      payload: new Array<Payload | null>(REPEAT_CHARGE_CAP).fill(null),
      depth: new Int32Array(REPEAT_CHARGE_CAP),
      origin: new Int32Array(REPEAT_CHARGE_CAP),
      head: 0,
      count: 0,
    },
    echo,
    delayed: createDelayedRepeats(),
  };
}

/**
 * A kill's transfers to the enemies its victim splits into (RunContext.sys.split): the kill's
 * transfer triggers that carry a toSplitChildren spread and pass at the kill are recorded here
 * (fireInlineKill in src/sim/effects/dispatch.ts), and once split() has appended the children,
 * killEnemy moves the victim's poison to them for each (step 2b, src/sim/systems/death.ts).
 */
export interface SplitState {
  /** The triggers of `transfers` that passed at the kill being resolved: passed[0 .. passedCount). */
  readonly passed: Int32Array;
  passedCount: number;
  /**
   * The kill triggers that run at the kill (CompiledTrigger.inline) with a toSplitChildren
   * spread, in trigger order; empty: no kill records anything.
   */
  readonly transfers: readonly number[];
}

/** The share of the victim's poison effect `fx` moves to each split child: toSplitChildren, or 0. */
export function toSplitOf(fx: CompiledEffect): number {
  const spec = fx.spec;
  return spec.kind === 'spreadAilment' && spec.ailment === 'poison'
    ? (spec.toSplitChildren ?? 0)
    : 0;
}

/** Nothing recorded, for `build`'s transfer triggers with a toSplitChildren spread. */
export function createSplitState(build: CompiledBuild): SplitState {
  const transfers: number[] = [];
  for (const t of build.triggers) {
    if (!t.inline) continue;
    for (let e = t.effectStart; e < t.effectEnd; e++) {
      if (toSplitOf(build.effects[e] as CompiledEffect) > 0) {
        transfers.push(t.index);
        break;
      }
    }
  }
  // A trigger passes at most once per kill.
  return { passed: new Int32Array(transfers.length), passedCount: 0, transfers };
}

/** One segment emitter's links (SegmentLinesState), with room for the pairs its arrays hold. */
export interface SegmentLines extends SegmentLinesState {
  count: number;
  x1: Float64Array;
  y1: Float64Array;
  x2: Float64Array;
  y2: Float64Array;
}

/**
 * The pairs a segment between drone or summon endpoints keeps from its last pairing
 * (SegmentSpec.pairTicks > 0): a[p] linked to b[p] for p < count, by the drone pool's row ids,
 * which a compaction does not move; −1 until its first pairing. Its arrays hold the 2 links a
 * row can make for each slot of the pool (DronePool.rows), and none for a segment that pairs at
 * every judgement.
 */
export interface HeldPairs {
  count: number;
  readonly a: Int32Array;
  readonly b: Int32Array;
}

/**
 * The segments of a run (RunContext.sys.segments, src/sim/systems/segments.ts), also
 * SimState.segments: the segment emitters, the links of each one's last judgement, the pairs
 * each keeps between its pairings, and the judgements' scratch. The scratch arrays grow with the
 * endpoints, never shrink, and hold leftovers past what the current judgement wrote.
 */
export interface SegmentState extends SegmentViewState {
  /** The segment emitters, in emitter order; the segment stage judges for each in turn. */
  readonly emitters: readonly EmitterRuntime[];
  /** The links of each emitter's last judgement, emitters[i]'s at i. */
  readonly lines: readonly SegmentLines[];
  /** The pairs each emitter keeps between its pairings, emitters[i]'s at i. */
  readonly held: readonly HeldPairs[];
  /** The endpoint grid: the judgement's endpoints, `ends`, for their nearest others. */
  readonly grid: SpatialGrid<Enemy>;
  /** The last judgement's serial: the enemies it marks to hit carry it (Enemy.segMark). */
  serial: number;
  /** The judgement's endpoints, in id order; cut to their count before the grid takes them. */
  readonly ends: Enemy[];
  /**
   * Each endpoint's first and second link, as an index into `ends`, or for drone and summon
   * endpoints both as a slot of the drone pool; −1 for none.
   */
  pick1: Int32Array;
  pick2: Int32Array;
  /** The judgement's pairs, a[s] with b[s] as indices into `ends`: at most 2 per endpoint. */
  a: Int32Array;
  b: Int32Array;
  /** SpatialGrid.nearestTwo's output. */
  readonly nearTwo: Int32Array;
}

/** Endpoints the scratch of a segment judgement holds at first; it grows past them. */
const SEGMENT_ENDS = 64;

function createSegmentLines(): SegmentLines {
  const n = 2 * SEGMENT_ENDS;
  return {
    count: 0,
    x1: new Float64Array(n),
    y1: new Float64Array(n),
    x2: new Float64Array(n),
    y2: new Float64Array(n),
  };
}

/** No pairing yet, room for 2 links a slot of a pool of `rows` slots, or none at pairTicks 0. */
function createHeldPairs(em: EmitterRuntime, rows: number): HeldPairs {
  const n = (em.spec as SegmentSpec).pairTicks > 0 ? 2 * rows : 0;
  return { count: -1, a: new Int32Array(n), b: new Int32Array(n) };
}

/**
 * No judgement yet, for the segment emitters `emitters`, beside a drone pool of `rows` slots
 * (DronePool.rows).
 */
export function createSegmentState(
  emitters: readonly EmitterRuntime[],
  rows: number,
): SegmentState {
  return {
    emitters,
    lines: emitters.map(createSegmentLines),
    held: emitters.map((em) => createHeldPairs(em, rows)),
    grid: createEnemyGrid(),
    serial: 0,
    ends: [],
    pick1: new Int32Array(SEGMENT_ENDS),
    pick2: new Int32Array(SEGMENT_ENDS),
    a: new Int32Array(2 * SEGMENT_ENDS),
    b: new Int32Array(2 * SEGMENT_ENDS),
    nearTwo: new Int32Array(2),
  };
}

/**
 * A payload's chain policy (Payload.policy), compiled once per run from the build's
 * ChainPolicySpec (compilePolicy): what the general chain path (chainGeneral,
 * src/sim/combat/policy.ts) reads at each level k of the chain, the primary hit at level 0.
 */
export interface ChainPolicy {
  /**
   * Jumps from each enemy of level k − 1 to level k: branch[min(k, length − 1)]; [1, 1]: no
   * fork.
   */
  readonly branch: Uint8Array;
  /** Chance of one extra jump per jump hit (跳電); 0: none. */
  readonly extraJumpChance: number;
  /** Times the chain re-hits the enemy it ends on when no other is in range (回彈); 0: none. */
  readonly bounces: number;
  /** The last level's jumps go to the farthest enemy in range, not the nearest (遠雷). */
  readonly lastFarthest: boolean;
  /**
   * The share of the attack's damage at level k, for k in 0 .. CHAIN_HIT_CAP + EXTRA_JUMP_CAP:
   * the running product of chainRetention, a decay entry's factor in its place on its levels.
   */
  readonly scale: Float64Array;
}

/**
 * The chain policy the build's rules write through BuildCompiler.chainPolicy()
 * (CompiledBuild.chainPolicy): branches 1 or more, extraJumpChance in [0, 1], bounces 0 or more.
 */
export interface ChainPolicySpec {
  /** Jumps from the primary hit, and from each enemy of the later levels. */
  branchFirst: number;
  branchLater: number;
  extraJumpChance: number;
  bounces: number;
  lastFarthest: boolean;
  /**
   * Levels from `from` to `to` (inclusive; no end without it) whose damage keeps `factor` of the
   * level before instead of chainRetention; of the entries covering a level, the last counts.
   */
  decay: { from: number; to?: number; factor: number }[];
}

const NO_DECAY: ChainPolicySpec['decay'] = [];
Object.freeze(NO_DECAY);

/** No fork, no extra jumps, no bounces, no decay: the linear chain's policy. */
export const NO_POLICY_SPEC: Readonly<ChainPolicySpec> = Object.freeze({
  branchFirst: 1,
  branchLater: 1,
  extraJumpChance: 0,
  bounces: 0,
  lastFarthest: false,
  decay: NO_DECAY,
});

/**
 * `spec` for a run whose chain jumps keep `chainRetention` of the level before. Without decay,
 * scale[k] is the product the linear chain forms over k jumps, in the same order (chainFrom).
 */
export function compilePolicy(
  spec: Readonly<ChainPolicySpec>,
  chainRetention: number,
): ChainPolicy {
  const fork = spec.branchFirst !== 1 || spec.branchLater !== 1;
  const n = CHAIN_HIT_CAP + EXTRA_JUMP_CAP + 1;
  const scale = new Float64Array(n);
  scale[0] = 1;
  for (let k = 1; k < n; k++) {
    let factor = chainRetention;
    for (const d of spec.decay) {
      if (k >= d.from && (d.to === undefined || k <= d.to)) factor = d.factor;
    }
    scale[k] = (scale[k - 1] as number) * factor;
  }
  return {
    branch: fork ? Uint8Array.of(1, spec.branchFirst, spec.branchLater) : Uint8Array.of(1, 1),
    extraJumpChance: spec.extraJumpChance,
    bounces: spec.bounces,
    lastFarthest: spec.lastFarthest,
    scale,
  };
}

/**
 * The general chain path's state (RunContext.sys.chain, src/sim/combat/policy.ts). Chains never
 * nest (a hit starts none), so one set of level buffers serves every chain.
 */
export interface ChainState {
  /**
   * The enemies of the level the chain jumps from, and of the level it jumps to: at most
   * CHAIN_HIT_CAP each. A chain's caller places its roots in frontier.
   */
  readonly frontier: Enemy[];
  readonly next: Enemy[];
  /** NO_POLICY_SPEC for this run's chainRetention: the policy of a payload without one. */
  readonly noPolicy: ChainPolicy;
  /** farthestChainTarget's within() output. */
  readonly far: Enemy[];
}

/** Empty levels, and the table without a policy of a run whose jumps keep `chainRetention`. */
export function createChainState(chainRetention: number): ChainState {
  return {
    frontier: [],
    next: [],
    noPolicy: compilePolicy(NO_POLICY_SPEC, chainRetention),
    far: [],
  };
}

/**
 * The numbers of the timed rows (C5.7) of each spawnDrone effect, by compiled effect index
 * (CompiledBuild.effects), one entry for every effect of a build with a spawnDrone
 * (BuildFlags.spawnsDrones), 0 for an effect of another kind: droneLayout fills them once, and
 * the pool keeps them, `live` aside, which it counts.
 */
export interface SpawnSpecs {
  /** Live rows of each effect, which a spawn checks against its maxLive. */
  readonly live: Int32Array;
  /** Its maxLive: the per-kind cap. */
  readonly maxLive: Int32Array;
  /** A row's step a tick (its speed over TICK_RATE) and same-enemy cooldown in ticks, at m = 1. */
  readonly stepBase: Float64Array;
  readonly coolTicks: Float64Array;
  /** Its splash radius squared (sizeOf), its impacts a row, and its aim (0 nearest, 1 outer). */
  readonly splashSq: Float64Array;
  readonly impacts: Int16Array;
  readonly aim: Uint8Array;
  /**
   * Its impacts' hit scale (damagePct) and ailment term: the ailment's APPLIED_AILMENTS index
   * (−1 for none), its stacks and its share of the damage stat (ailmentDamagePct).
   */
  readonly scale: Float64Array;
  readonly ailment: Int8Array;
  readonly stacks: Int32Array;
  readonly ailmentPct: Float64Array;
}

/** SpawnSpecs.aim: the nearest enemy to the row (pickNearest), or the drones' pick (pickOuter). */
export const AIM_NEAREST = 0;
export const AIM_OUTER = 1;

/**
 * The drone pool of a run as droneLayout (src/sim/emitters/drone.ts) places it, once: plain
 * arrays, which createDronePool copies, and the timed rows' tables, which it keeps. Rows come in
 * emitter order, each emitter's drones before its turrets (C5.4), and stop at summonCap.
 */
export interface DroneLayout {
  /** Rows placed: at most summonCap. */
  readonly rows: number;
  /** Rows refused past summonCap (the summonCapped counter). */
  readonly refused: number;
  /** The cap the rows were placed under: SUMMON_CAP, or a test module's larger summonCap. */
  readonly summonCap: number;
  /** Per row: its kind (DRONE_KIND_*), its emitter's index and its seat (DroneViewState). */
  readonly kind: readonly number[];
  readonly owner: readonly number[];
  readonly seat: readonly number[];
  /** Per row: its dock, where it starts. */
  readonly x: readonly number[];
  readonly y: readonly number[];
  /** Per row: the tick of its first pick, 1 + (10 × seat) mod PICK_TICKS, so launches stagger. */
  readonly firstPick: readonly number[];
  /**
   * Per emitter index, one entry for each emitter once any of them is a drone emitter, whether
   * or not it placed a row, and none otherwise (0 for the other kinds): a drone's step a tick
   * (its speed over TICK_RATE), its dock time and same-enemy cooldown in ticks, all at m = 1, its
   * impacts a sortie, its splash radius squared, and its turrets' payload (null until C5.4).
   */
  readonly stepBase: readonly number[];
  readonly dockTicks: readonly number[];
  readonly coolTicks: readonly number[];
  readonly impacts: readonly number[];
  readonly splashSq: readonly number[];
  readonly turretPayload: readonly (Payload | null)[];
  /** The timed rows' tables in a build with a spawnDrone effect, its `live` all 0; else null. */
  readonly spawnSpecs: SpawnSpecs | null;
  /**
   * Every turret shot's 加農砲 splash, its radius squared (BuildFlags.turretSplash through sizeOf;
   * 0 for none), and its 特斯拉塔 jumps (BuildFlags.turretChains through countOf), for the run's
   * turrets alike (C5.9).
   */
  readonly turretSplashSq: number;
  readonly turretJumps: number;
}

/**
 * The drone pool (RunContext.sys.drones), also SimState.drones: DroneLayout's rows in typed
 * arrays, then the timed rows the spawnDrone effects append (C5.7), the slots 0 .. count − 1 in
 * id order, and its per-emitter numbers. Slot s's cooldown memory is the DRONE_MEMORY entries
 * from s × DRONE_MEMORY of memId and memUntil: an entry is live while its memUntil is above the
 * current tick, and expired from then on.
 */
export interface DronePool extends DroneViewState {
  /** Live slots, 0 .. count − 1, in id order. */
  count: number;
  /**
   * The slots its arrays hold: DroneLayout.summonCap in a build with a spawnDrone effect, which
   * no spawn passes (fixed and timed rows together); else DroneLayout.rows (0 in a run without
   * drones).
   */
  readonly rows: number;
  /** The id the next slot would take. */
  nextId: number;
  /** Each slot's dock, or a turret's seat. */
  readonly dockX: Float64Array;
  readonly dockY: Float64Array;
  /**
   * The enemy each slot dashes at (every DRONE_DASH slot has one), or that its sortie ended on
   * while it flies home or, under 蟲海 (BuildFlags.dronesStay), hovers to pick again; null for
   * none.
   */
  readonly target: (Enemy | null)[];
  /** The first tick each slot may pick again. */
  readonly nextPick: Int32Array;
  /** Impacts each slot has left on its sortie. */
  readonly impactsLeft: Int16Array;
  /** Dock time each slot has left, counted down by m a tick; it stays docked while above 0. */
  readonly dockLeft: Float64Array;
  /** A turret's ticks towards its next firing (C5.4). */
  readonly acc: Float64Array;
  /** The cooldown memory: the enemy ids (−1 at first) and the ticks their entries end (0). */
  readonly memId: Int32Array;
  readonly memUntil: Int32Array;
  /**
   * The tick each slot leaves at, the first on which it is gone: a timed row's spawn tick +
   * max(1, round(lifeSec × 60)), or the tick its impacts were spent; 2147483647 for a fixed row,
   * which never leaves.
   */
  readonly until: Int32Array;
  /**
   * A timed row's spawnDrone effect (CompiledBuild.effects index, −1 for a fixed row), and the
   * trigger depth and origin of the effect that spawned it, which its hits, its ailment term and
   * its droneExpire take (0 and −1 for a fixed row).
   */
  readonly spec: Int32Array;
  readonly depth: Uint8Array;
  readonly origin: Int32Array;
  /** Slots marked as leaving in the current stage, dropped at its end (0 outside the stage). */
  left: number;
  /** DroneLayout.spawnSpecs, with its own `live` counts; null in a build without spawnDrone. */
  readonly specs: SpawnSpecs | null;
  /** Per emitter index: DroneLayout's numbers. */
  readonly stepBase: Float64Array;
  readonly dockTicks: Float64Array;
  readonly coolTicks: Float64Array;
  readonly impacts: Int16Array;
  readonly splashSq: Float64Array;
  readonly turretPayload: (Payload | null)[];
  /**
   * An impact's within() output (impactAt, src/sim/systems/drones.ts), and a turret shot's
   * splash's (turretArrival, src/sim/systems/shots.ts), which the projectile stage lists after
   * the drone stage's last impact.
   */
  readonly splash: Enemy[];
  /** One turret firing's targets, picked[0 .. pickedCount) (C5.4). */
  readonly picked: Enemy[];
  pickedCount: number;
  /**
   * DroneLayout's turret splash squared and jumps, read by every turret shot's arrival
   * (turretArrival, src/sim/systems/shots.ts), which lists the splash in `splash`.
   */
  readonly turretSplashSq: number;
  readonly turretJumps: number;
  /** A turret firing's later picks: shootable, and not one of the firing's targets yet (C5.4). */
  readonly turretAccept: (enemy: Enemy) => boolean;
}

/** DronePool.until of a fixed row: no tick reaches it. */
export const NEVER_LEAVES = 2147483647;

/**
 * The pool of `layout`: every row placed, ids 1 .. rows in row order, each at its dock; drones
 * docked with no dock time left and a full sortie, turrets fixed; none leaves. Its arrays hold
 * the summon cap of slots in a build with a spawnDrone effect, the slots past the placed rows
 * empty until a spawn appends one, and exactly the placed rows otherwise. `shootable` stands for
 * RunContext.shootable, which the context is still being built for: the pool keeps it for its
 * turrets and does not call it here.
 */
export function createDronePool(
  layout: DroneLayout,
  shootable: (enemy: Enemy) => boolean,
): DronePool {
  const n = layout.rows;
  const spawnSpecs = layout.spawnSpecs;
  const cap = spawnSpecs === null ? n : Math.max(n, layout.summonCap);
  /** A typed array of `cap` slots, its first n from `rows`. */
  const slots = <T extends Int32Array | Int16Array | Uint8Array | Float64Array>(
    make: new (length: number) => T,
    rows: ArrayLike<number>,
  ): T => {
    const out = new make(cap);
    for (let s = 0; s < n; s++) out[s] = rows[s] as number;
    return out;
  };
  const ids = Array.from({ length: n }, (_, s) => s + 1);
  const pool: DronePool = {
    id: slots(Int32Array, ids),
    kind: slots(Uint8Array, layout.kind),
    mode: slots(
      Uint8Array,
      layout.kind.map((k) => (k === DRONE_KIND_TURRET ? DRONE_FIXED : DRONE_DOCKED)),
    ),
    x: slots(Float64Array, layout.x),
    y: slots(Float64Array, layout.y),
    prevX: slots(Float64Array, layout.x),
    prevY: slots(Float64Array, layout.y),
    targetId: new Int32Array(cap).fill(-1),
    owner: slots(Int16Array, layout.owner),
    seat: slots(Int16Array, layout.seat),
    count: n,
    rows: cap,
    nextId: n + 1,
    dockX: slots(Float64Array, layout.x),
    dockY: slots(Float64Array, layout.y),
    target: new Array<Enemy | null>(cap).fill(null),
    nextPick: slots(Int32Array, layout.firstPick),
    impactsLeft: slots(
      Int16Array,
      layout.owner.map((i) => layout.impacts[i] as number),
    ),
    dockLeft: new Float64Array(cap),
    acc: new Float64Array(cap),
    memId: new Int32Array(cap * DRONE_MEMORY).fill(-1),
    memUntil: new Int32Array(cap * DRONE_MEMORY),
    until: new Int32Array(cap).fill(NEVER_LEAVES),
    spec: new Int32Array(cap).fill(-1),
    depth: new Uint8Array(cap),
    origin: new Int32Array(cap).fill(-1),
    left: 0,
    specs: spawnSpecs === null ? null : { ...spawnSpecs, live: new Int32Array(spawnSpecs.live) },
    stepBase: Float64Array.from(layout.stepBase),
    dockTicks: Float64Array.from(layout.dockTicks),
    coolTicks: Float64Array.from(layout.coolTicks),
    impacts: Int16Array.from(layout.impacts),
    splashSq: Float64Array.from(layout.splashSq),
    turretPayload: layout.turretPayload.slice(),
    splash: [],
    picked: [],
    pickedCount: 0,
    turretSplashSq: layout.turretSplashSq,
    turretJumps: layout.turretJumps,
    turretAccept: (enemy) => shootable(enemy) && !isPicked(pool, enemy),
  };
  return pool;
}

/** `enemy` is one of the current turret firing's targets (DronePool.picked). */
function isPicked(pool: DronePool, enemy: Enemy): boolean {
  const picked = pool.picked;
  for (let k = 0; k < pool.pickedCount; k++) if (picked[k] === enemy) return true;
  return false;
}

/**
 * The v3 enemies' state (docs/v3 C7 design §1.4). `enabled` is the run's v3 gate,
 * data.waves.v3 !== undefined (§1.1): addEnemy tests it once per spawn, and an M1 run never
 * creates a record (Enemy.v3, src/sim/systems/enemyRecord.ts), runs no enemy AI step
 * (src/sim/systems/enemyAi.ts) and schedules no treasure.
 */
export interface EnemyAiState {
  readonly enabled: boolean;
  /**
   * Enemies alive at once: the v3 block's enemyCap, Infinity in an M1 run, whose releases and
   * splits then take M1's statements (§2.3, src/sim/systems/spawn.ts).
   */
  readonly cap: number;
  /**
   * The enemies with work in the AI step (a behaviour, or regeneration), in id order: addEnemy
   * appends each such spawn, and the step drops the dead ones.
   */
  readonly list: Enemy[];
  /**
   * The dashers that began charging this tick, in id order, filled before the drones' stage reads
   * them (C5b's 攔截守衛): chargeStarts[0 .. chargeStartCount); past it, stale.
   */
  readonly chargeStarts: Enemy[];
  chargeStartCount: number;
  /** The ModTable row enemyRegen is read on: the untagged center row; −1 in an M1 run. */
  readonly regenRow: number;
  /** × on the drops of tough kills (values.toughDropMult), which each record's dropScale holds. */
  readonly toughDropMult: number;
  /** × on the treasure schedule's rate (values.treasureRate). */
  readonly treasureRate: number;
  /**
   * C7b's hooks on v3 enemies (src/sim/systems/contact.ts, src/sim/combat/defend.ts), read only
   * where a v3 record is: 拒馬's push-back of a dashing enemy at its touch, values.dashRepel (0:
   * none); 荊棘纏繞's hold of a boss at its touch, round(values.bossHoldSec × TICK_RATE) ticks
   * (−1: none, for a bossHoldSec of 0 or below); and 集火's window, round(values.shieldPoolSec ×
   * TICK_RATE) ticks (−1: none, likewise).
   */
  readonly dashRepel: number;
  readonly holdTicks: number;
  readonly poolTicks: number;
}

/** round(sec × TICK_RATE) ticks for `sec` above 0, else −1: a C7b hook that is off. */
const hookTicks = (sec: number): number => (sec > 0 ? Math.round(sec * TICK_RATE) : -1);

/**
 * The state of a run that is a v3 run when `enabled`, holding at most `cap` enemies alive, whose
 * enemies read enemyRegen on row `regenRow` and drop × `toughDropMult` when tough, whose
 * treasures come at `treasureRate` × the schedule's rate, and whose build's 拒馬, 荊棘纏繞 and
 * 集火 are `dashRepel`, `bossHoldSec` and `shieldPoolSec` (values').
 */
export function createEnemyAiState(
  enabled: boolean,
  cap: number,
  regenRow: number,
  toughDropMult: number,
  treasureRate: number,
  dashRepel: number,
  bossHoldSec: number,
  shieldPoolSec: number,
): EnemyAiState {
  return {
    enabled,
    cap,
    list: [],
    chargeStarts: [],
    chargeStartCount: 0,
    regenRow,
    toughDropMult,
    treasureRate,
    dashRepel,
    holdTicks: hookTicks(bossHoldSec),
    poolTicks: hookTicks(shieldPoolSec),
  };
}

/**
 * The player's defences against contact damage (docs/v3 C7 design §1.4, §2.2): damagePlayer in
 * src/sim/systems/contact.ts reads them, and its shield lives on PlayerState.shield.
 */
export interface PlayerDefence {
  /** × on the contact damage the player takes, before the shield: values.contactDamageTaken. */
  readonly contactTaken: number;
  /** Life regained at the end of each contact stage while alive: lifeRegen × maxLife × DT. */
  readonly regenPerTick: number;
  /** Revives left this run: floor(values.extraLives) at its start. */
  livesLeft: number;
  /**
   * 節奏閃避 (C7b, src/sim/systems/bullets.ts): the combo stacks a dodge needs,
   * values.bulletDodgeCombo, or Infinity when the dodge is off (bulletDodgeSec or
   * bulletDodgeCombo not above 0); its cooldown, round(values.bulletDodgeSec × TICK_RATE) ticks;
   * and the first tick it can dodge again, 0 at the start.
   */
  readonly dodgeCombo: number;
  readonly dodgeTicks: number;
  dodgeReadyAt: number;
}

/** sys.defence: null is M1's fast path, where damagePlayer runs the life loss alone. */
export type PlayerDefenceState = PlayerDefence | null;

/**
 * The defences of a build whose final stat values are `values`, for a player of `maxLife` (after
 * flags.maxLife). Null exactly when no defence stat moved from its base (節奏閃避's two included)
 * and `hasShieldEffect`, the compiled build holding an effect of kind 'shield', is false: then
 * nothing can block, reduce, regain, revive or dodge, and contact keeps M1's statements.
 */
export function createPlayerDefence(
  values: CompiledBuild['values'],
  maxLife: number,
  hasShieldEffect: boolean,
): PlayerDefenceState {
  const { contactDamageTaken, lifeRegen, extraLives, bulletDodgeSec, bulletDodgeCombo } = values;
  if (
    contactDamageTaken === 1 &&
    lifeRegen === 0 &&
    extraLives === 0 &&
    !hasShieldEffect &&
    bulletDodgeSec === 0 &&
    bulletDodgeCombo === 0
  ) {
    return null;
  }
  // Floored at 0 (the lead's ruling on C7.2): increased modifiers that sum past −100 % never
  // make a contact heal, and a lifeRegen below 0 never drains life.
  return {
    contactTaken: Math.max(0, contactDamageTaken),
    regenPerTick: Math.max(0, lifeRegen * maxLife * DT),
    livesLeft: Math.floor(extraLives),
    dodgeCombo: bulletDodgeSec > 0 && bulletDodgeCombo > 0 ? bulletDodgeCombo : Infinity,
    dodgeTicks: Math.round(bulletDodgeSec * TICK_RATE),
    dodgeReadyAt: 0,
  };
}

/**
 * The bullet pool (RunContext.sys.bullets, docs/v3 C7 design §1.4), also SimState.bullets: the
 * bullets in flight in typed arrays, the slots 0 .. count − 1 in id order, and the hits they
 * dealt by their shooter's type. It has no cap and drops no bullet (C7/F15): it grows by doubling
 * (growBullets, src/sim/systems/bullets.ts), which replaces every array but keeps the object, so
 * SimState.bullets stays this object. A run without shooters (every M1 run) never fills a slot,
 * and its arrays stay empty.
 */
export interface BulletPool extends BulletViewState {
  id: Int32Array;
  x: Float64Array;
  y: Float64Array;
  prevX: Float64Array;
  prevY: Float64Array;
  /** Live slots, 0 .. count − 1, in id order. */
  count: number;
  /** The id the next bullet takes. */
  nextId: number;
  /** Its velocity per tick. */
  vx: Float64Array;
  vy: Float64Array;
  /** The damage it deals the player: its shooter's bulletDamage. */
  damage: Float64Array;
  /** Its shooter's id, and type as its ENEMY_IDS ordinal. */
  owner: Int32Array;
  ownerType: Uint8Array;
  /** 1 once 反射 has turned it back towards its shooter (C7b), else 0. */
  reflected: Uint8Array;
  /**
   * The bullets that hit the player and their damage, by their shooter's type, every type present
   * (RunResult.bulletTakenBy is a copy, src/sim/systems/runEnd.ts).
   */
  readonly takenBy: Record<EnemyId, { hits: number; damage: number }>;
  /** 反射 (values.reflectBullets above 0): a bullet that reaches the player flies back. */
  readonly reflect: boolean;
  /**
   * 攔截軌道 (values.orbitBlocksBullets above 0): the build's orbit emitters, whose orbs stop the
   * bullets they touch; none when it is off.
   */
  readonly blockers: readonly EmitterRuntime[];
}

/**
 * An empty bullet pool, with a tally for each type of `ids` (ENEMY_IDS, passed in), whose
 * bullets 反射 turns back when `reflect` and the orbs of `blockers` stop (攔截軌道).
 */
export function createBulletPool(
  ids: readonly EnemyId[],
  reflect = false,
  blockers: readonly EmitterRuntime[] = [],
): BulletPool {
  const takenBy = {} as Record<EnemyId, { hits: number; damage: number }>;
  for (const id of ids) takenBy[id] = { hits: 0, damage: 0 };
  return {
    id: new Int32Array(0),
    x: new Float64Array(0),
    y: new Float64Array(0),
    prevX: new Float64Array(0),
    prevY: new Float64Array(0),
    count: 0,
    nextId: 1,
    vx: new Float64Array(0),
    vy: new Float64Array(0),
    damage: new Float64Array(0),
    owner: new Int32Array(0),
    ownerType: new Uint8Array(0),
    reflected: new Uint8Array(0),
    takenBy,
    reflect,
    blockers,
  };
}

/**
 * The elite affixes' state (RunContext.sys.affixes, docs/v3 C7 design §1.4, §2.7): the stream an
 * elite's picks are drawn on, the two lists the per-tick rules walk, and 冰霜's factor on every
 * emitter's cadence. An M1 run never puts an enemy in either list and never draws a pick, so its
 * factor stays 1 and `refreshCadence` never runs (src/sim/systems/affixes.ts).
 */
export interface AffixState {
  /** The run's `affixes` stream (src/core/rng.ts), drawn only by an elite's picks. */
  readonly rng: Rng;
  /** The live 守護 elites, in id order; the AI step's start drops the dead ones. */
  readonly guardians: Enemy[];
  /** The live 冰霜 elites, in id order, compacted with the guardians. */
  readonly frostElites: Enemy[];
  /** Every emitter's cadence: 1, or FROST_CADENCE while a 冰霜 elite is within FROST_RANGE. */
  frostFactor: number;
  /** The block 守護 lends a neighbour: the run data's shielder blockBelowPct, 0 without one. */
  readonly guardBlockPct: number;
}

/**
 * The affix state of a run whose picks are drawn on `rng` and whose 守護 elites lend
 * `guardBlockPct` (「盾兵的護盾」). Both lists start empty and the cadence factor at exactly 1.
 */
export function createAffixState(rng: Rng, guardBlockPct: number): AffixState {
  return { rng, guardians: [], frostElites: [], frostFactor: 1, guardBlockPct };
}

/**
 * What createRunContext works out for the combo state from the compiled build (comboLayout in
 * src/sim/systems/context.ts), per emitter of the run and per buff effect of the build.
 */
export interface ComboLayout {
  /** The run steps the state every tick (stepCombo): BuildFlags.combo, or a buff effect. */
  readonly ticks: boolean;
  /**
   * The signature emitter picks only enemies inside the arena: a swarm without a turret, whose
   * drones' picks are the only ones it makes (pickOuter, src/sim/systems/drones.ts).
   */
  readonly inArenaOnly: boolean;
  /**
   * Per emitter, its combo factor at 0 stacks: the product of the per-instance attackSpeed
   * modifiers its payload's hit row matches, 1 for an emitter that does not read cadence.
   */
  readonly comboFactor: Float64Array;
  /** The emitters whose factor moves with the stacks: their row holds a scaling entry. */
  readonly scaled: Int32Array;
  /** Per effect index, its buff's slot (0 … buffs − 1, in effect order), −1 for another effect. */
  readonly buffSlot: Int32Array;
  /** Per buff slot: 1 + its more, and its window, round(durationSec × TICK_RATE) ticks. */
  readonly buffMult: Float64Array;
  readonly buffTicks: Float64Array;
  /**
   * Per buff slot × emitter (slot × emitters + index): 1 when the emitter reads cadence and its
   * payload carries every tag of the buff, which takes it.
   */
  readonly buffMatch: Uint8Array;
}

/**
 * The combo stacks and the timed buffs (RunContext.sys.combo, docs/v3/game-design-v3.md §4.5,
 * docs/v3 C6 design §7.4 C6b.2): one member for both, since both are factors on the emitters'
 * cadence, which refreshCadence composes with 冰霜's (src/sim/systems/affixes.ts), and the one
 * per-tick combo step runs both (stepCombo, src/sim/systems/combo.ts). A run whose build neither
 * reads the stacks (BuildFlags.combo false) nor has a buff never steps it or changes it: its
 * stacks stay 0 and every factor exactly 1.
 */
export interface ComboState extends ComboLayout {
  /** The run's combo stacks, an integer from 0 to BuildFlags.comboCap. */
  stacks: number;
  /** Ticks in a row on which the signature emitter had no target to pick. */
  idle: number;
  /** Per emitter, the product of the active buffs it takes, 1 without one. */
  readonly buffFactor: Float64Array;
  /** Per buff slot, the last tick of its window, −1 while it is not active. */
  readonly buffEnd: Float64Array;
  /** The buffs active now. */
  active: number;
}

/** The combo state of `layout` for a run of `emitters` emitters: no stacks and no buff active. */
export function createComboState(layout: ComboLayout, emitters: number): ComboState {
  return {
    ticks: layout.ticks,
    inArenaOnly: layout.inArenaOnly,
    comboFactor: layout.comboFactor,
    scaled: layout.scaled,
    buffSlot: layout.buffSlot,
    buffMult: layout.buffMult,
    buffTicks: layout.buffTicks,
    buffMatch: layout.buffMatch,
    stacks: 0,
    idle: 0,
    buffFactor: new Float64Array(emitters).fill(1),
    buffEnd: new Float64Array(layout.buffMult.length).fill(-1),
    active: 0,
  };
}
