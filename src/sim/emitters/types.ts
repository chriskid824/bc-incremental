/**
 * Emitters (docs/v3/implementation-plan-v3.md §2.15): what deals the build's own damage. An
 * EmitterSpec says what an emitter is; each run gives it an EmitterRuntime with its counters and
 * a Payload, the compiled form of its damage: base damage, tags, credit sources, RNG stream,
 * flags and the ModTable rows of its hits and ailments, cached by slot. The signature attack is
 * the emitter at index 0 (CompiledBuild.emitters); M1's is the volley (volley.ts).
 */

import type { Num } from '../../core/num';
import { mul, num } from '../../core/num';
import type { Rng } from '../../core/rng';
import { ailmentMask, jumpMask, TAG } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import type { CompiledBuild } from '../build/compile';
import { ailmentCredit, rowKey } from '../build/sources';

export interface EmitterSpec {
  /** How the emitter attacks: 'volley' fires homing projectiles (volley.ts). */
  readonly kind: 'volley';
  /** The character's signature attack (rule 8 of the triggers); sets SIGNATURE on its payload. */
  readonly signature: boolean;
  /** Source id its damage is credited to (src/data/sources.ts). */
  readonly source: string;
  /** Base damage as a fraction of the damage stat. */
  readonly damagePct: number;
  /** Tags of its primary hits; chain jumps take jumpMask of them. */
  readonly tags: TagMask;
  readonly chains: boolean;
  readonly rollsAilments: boolean;
  readonly canCrit: boolean;
}

/**
 * Bits of Payload.flags. SIGNATURE marks damage of the signature attack; the dispatch flags
 * share its bit (full layout in src/sim/effects/flags.ts).
 */
export const SIGNATURE = 1;

/**
 * Payload.damageMode: rows multiplies a hit by its damage row; prescaled deals baseDamage × crit
 * multiplier × scale as given, whatever the damage rows hold; pctMaxHp, a shatter's, multiplies
 * it by pctMaxHpFactor of its damage row only (src/sim/build/eval.ts), with scale its share of
 * the victim's max life.
 */
export const ROWS = 0;
export const PRESCALED = 1;
export const PCT_MAX_HP = 2;
export type DamageMode = typeof ROWS | typeof PRESCALED | typeof PCT_MAX_HP;

/**
 * Payload.rows slots: a hit's row without and with crit, the same for a chain jump, and the row
 * of each ailment the hits apply (poison and bleed from C3.8). A slot's row is fixed by the
 * payload: its tags and source for hits, jumpMask of the tags and jumpSource for jumps,
 * ailmentMask and the ailment's credit for ailments.
 */
export const SLOT_HIT = 0;
export const SLOT_HIT_CRIT = 1;
export const SLOT_JUMP = 2;
export const SLOT_JUMP_CRIT = 3;
export const SLOT_BURN = 4;
export const SLOT_BURN_CRIT = 5;
export const SLOT_POISON = 6;
export const SLOT_POISON_CRIT = 7;
export const SLOT_BLEED = 8;
export const SLOT_BLEED_CRIT = 9;
const SLOT_COUNT = 10;

export interface Payload {
  /** values.damage × damagePct: the hit before crit, chain retention and rows. */
  readonly baseDamage: Num;
  readonly tags: TagMask;
  /** Source index its hits are credited to, and the applier of its ailments. */
  readonly source: number;
  /** Source index of its chain jumps (k ≥ 1): their credit and the key of their rows. */
  readonly jumpSource: number;
  /**
   * The payload of jumps a rule adds (C4): shares rng, baseDamage and flags, with its own source
   * and rows. The payload itself while the sources match.
   */
  readonly extraJumpPayload: Payload;
  /** SIGNATURE for the signature emitter's payload. */
  readonly flags: number;
  /** Stream of its rolls: combat for emitters. */
  readonly rng: Rng;
  readonly chains: boolean;
  readonly rollsAilments: boolean;
  /** False skips the whole crit decision: the roll, forced crits and critAlways. */
  readonly canCrit: boolean;
  readonly damageMode: DamageMode;
  /** ModTable row of each slot (SLOT_*), −1 until first use (slotRow). */
  readonly rows: Int32Array;
}

/** What a payload is made of; jumpSource defaults to source. */
export interface PayloadSpec {
  readonly baseDamage: Num;
  readonly tags: TagMask;
  readonly source: number;
  readonly jumpSource?: number;
  readonly flags: number;
  readonly rng: Rng;
  readonly chains: boolean;
  readonly rollsAilments: boolean;
  readonly canCrit: boolean;
  readonly damageMode: DamageMode;
}

export function createPayload(spec: PayloadSpec): Payload {
  const payload = {
    ...spec,
    jumpSource: spec.jumpSource ?? spec.source,
    rows: new Int32Array(SLOT_COUNT).fill(-1),
  } as { -readonly [K in keyof Payload]: Payload[K] };
  payload.extraJumpPayload = payload;
  return payload;
}

/** The payload of an emitter: its share of the damage stat, its tags and source, on `rng`. */
export function emitterPayload(build: CompiledBuild, spec: EmitterSpec, rng: Rng): Payload {
  return createPayload({
    baseDamage: mul(num(build.values.damage), spec.damagePct),
    tags: spec.tags,
    source: build.sources.index(spec.source),
    flags: spec.signature ? SIGNATURE : 0,
    rng,
    chains: spec.chains,
    rollsAilments: spec.rollsAilments,
    canCrit: spec.canCrit,
    damageMode: ROWS,
  });
}

/** One emitter of the run: its spec, payload and counters. */
export interface EmitterRuntime {
  readonly spec: EmitterSpec;
  readonly payload: Payload;
  /** Ticks accumulated towards the next attack, cadence per tick. */
  acc: number;
  /** Projectiles fired, for steadyAim's every-Nth shot. */
  shots: number;
  /** Attacks made, for steadyAim's every-Nth attack; nthAttack triggers count in TriggerState. */
  attacks: number;
  /** Serial of the current attack's volley; enemies it already targets carry it. */
  volley: number;
  /** Every shot of the current attack is steady (steadyAim counting attacks). */
  steadyAttack: boolean;
  /** Ticks the accumulator gains per tick; exactly 1 until attack-speed buffs exist. */
  cadence: number;
}

export function createEmitterRuntime(spec: EmitterSpec, payload: Payload): EmitterRuntime {
  return {
    spec,
    payload,
    acc: 0,
    shots: 0,
    attacks: 0,
    volley: 0,
    steadyAttack: false,
    cadence: 1,
  };
}

/**
 * What one attack and its chain have used of their caps; one reused object per run, reset at
 * each attack (src/sim/combat/chain.ts). The caps that read it come with C4.
 */
export interface ChainBudget {
  /** Hits of the attack so far, its primary hit included. */
  hits: number;
  extraJumps: number;
  centerEvents: number;
}

const AILMENT_OF_SLOT = ['burn', 'burn', 'poison', 'poison', 'bleed', 'bleed'] as const;

/**
 * Row of `slot` (SLOT_*) of `p` in the build's ModTable, filled on first use. Rows keep their
 * numbers as the table grows, so a row looked up once stays valid for the run.
 */
export function slotRow(build: CompiledBuild, p: Payload, slot: number): number {
  const cached = p.rows[slot] as number;
  return cached >= 0 ? cached : fillSlot(build, p, slot);
}

function fillSlot(build: CompiledBuild, p: Payload, slot: number): number {
  const crit = (slot & 1) !== 0 ? TAG.crit : 0;
  let key: number;
  if (slot < SLOT_JUMP) key = rowKey(p.tags | crit, p.source);
  else if (slot < SLOT_BURN) key = rowKey(jumpMask(p.tags) | crit, p.jumpSource);
  else {
    // The applier of an ailment is the payload's source, also for ailments its jumps apply.
    const kind = AILMENT_OF_SLOT[slot - SLOT_BURN] as (typeof AILMENT_OF_SLOT)[number];
    const credit = ailmentCredit(build.sources, build.attribution, kind, p.source);
    key = rowKey(ailmentMask(p.tags, kind, crit !== 0), credit);
  }
  const row = build.table.row(key);
  p.rows[slot] = row;
  return row;
}
