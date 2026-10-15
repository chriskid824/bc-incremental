/**
 * The state of the systems that keep their own (RunContext.sys, docs/v3 C4 design §0.7): one
 * member per system, each with its type and factory here. createRunContext builds `sys` as one
 * literal, so its shape is fixed when it is created. The systems import their state types from
 * this module, which stays a leaf: its value imports are only core/num.ts, caps.ts,
 * build/sources.ts and build/eval.ts, which reach nothing that imports systems/context.ts
 * (systemState.test.ts checks it); every other import is an `import type` declaration.
 */

import type { Num } from '../../core/num';
import { ZERO } from '../../core/num';
import { SIGNATURE_ZONE_CAP, ZONE_CAP } from '../caps';
import type { CompiledBuild } from '../build/compile';
import { IN_ZONE } from '../build/eval';
import type { CompiledCondition } from '../build/eval';
import { MAX_SOURCES } from '../build/sources';
import type { Payload } from '../emitters/types';
import type { GridPoint } from '../grid';
import type { ZonePoolState } from '../types';
import type { Enemy } from './context';

/** RunContext.sys: one member per system that keeps state of its own. */
export interface SystemState {
  /** The tally of the pulse being dealt (src/sim/systems/zones.ts). */
  readonly pulse: PulseAcc;
  /** The ground zones (src/sim/systems/zones.ts), also SimState.zones. */
  readonly zones: ZonePool;
  /** The lob's aim and landing (src/sim/emitters/lob.ts). */
  readonly lob: LobState;
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
  /** 1 when a bomb of this firing aimed at block[i]; the scan writes 0 for each candidate. */
  readonly aimed: number[];
  /** The enemies this firing's bombs aimed at, in order: picked[0 .. picks). */
  readonly picked: Enemy[];
  picks: number;
  /** The firing's candidates, block[0 .. m); −1 before its dense scan. */
  m: number;
  /** The explosion's radius, squared, and SALVO_SEPARATION radii, squared: set per firing. */
  radiusSq: number;
  sepSq: number;
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
  };
}
