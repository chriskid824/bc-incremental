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
import { REPEAT_CHARGE_CAP, SIGNATURE_ZONE_CAP, ZONE_CAP } from '../caps';
import type { CompiledBuild } from '../build/compile';
import { IN_ZONE } from '../build/eval';
import type { CompiledCondition } from '../build/eval';
import { MAX_SOURCES } from '../build/sources';
import type { CompiledEffect } from '../effects/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { GridPoint, SpatialGrid } from '../grid';
import type { SegmentLinesState, SegmentViewState, ZonePoolState } from '../types';
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
 * src/sim/effects/execute.ts): each repeatAttack effect's payload, and the repeats waiting for
 * the attack's next own firing.
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
}

export function createRepeatState(payloads: readonly (Payload | null)[]): RepeatState {
  return {
    payloads,
    charges: {
      payload: new Array<Payload | null>(REPEAT_CHARGE_CAP).fill(null),
      depth: new Int32Array(REPEAT_CHARGE_CAP),
      origin: new Int32Array(REPEAT_CHARGE_CAP),
      head: 0,
      count: 0,
    },
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
 * The segments of a run (RunContext.sys.segments, src/sim/systems/segments.ts), also
 * SimState.segments: the segment emitters, the links of each one's last judgement, and the
 * judgements' scratch. The scratch arrays grow with the endpoints, never shrink, and hold
 * leftovers past what the current judgement wrote.
 */
export interface SegmentState extends SegmentViewState {
  /** The segment emitters, in emitter order; the segment stage judges for each in turn. */
  readonly emitters: readonly EmitterRuntime[];
  /** The links of each emitter's last judgement, emitters[i]'s at i. */
  readonly lines: readonly SegmentLines[];
  /** The endpoint grid: the judgement's endpoints, `ends`, for their nearest others. */
  readonly grid: SpatialGrid<Enemy>;
  /** The last judgement's serial: the enemies it marks to hit carry it (Enemy.segMark). */
  serial: number;
  /** The judgement's endpoints, in id order; cut to their count before the grid takes them. */
  readonly ends: Enemy[];
  /** Each endpoint's first and second link, as an index into `ends`; −1 for none. */
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

/** No judgement yet, for the segment emitters `emitters`. */
export function createSegmentState(emitters: readonly EmitterRuntime[]): SegmentState {
  return {
    emitters,
    lines: emitters.map(createSegmentLines),
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
