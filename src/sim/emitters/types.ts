/**
 * Emitters (docs/v3/implementation-plan-v3.md §2.15): what deals the build's own damage. An
 * EmitterSpec says what an emitter is; each run gives it an EmitterRuntime with its counters and
 * a Payload, the compiled form of its damage: base damage, tags, credit sources, RNG stream,
 * flags and the ModTable rows of its hits and ailments, cached by slot. The signature attack is
 * the emitter at index 0 (CompiledBuild.emitters); M1's is the volley (volley.ts), 熔核's the lob
 * (lob.ts). The talent nodes' emitter grants (src/data/emitters.ts) follow it, such as thorns,
 * whose hits the contact stage deals (src/sim/systems/contact.ts).
 */

import type { Num } from '../../core/num';
import { mul, num } from '../../core/num';
import type { Rng } from '../../core/rng';
import { THORNS_DAMAGE_PCT } from '../../data/emitters';
import type { EmitterGrant } from '../../data/emitters';
import { ailmentMask, ELEMENT_MASK, jumpMask, TAG } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import type { CompiledBuild } from '../build/compile';
import { ailmentCredit, rowKey } from '../build/sources';
import type { RunContext } from '../systems/context';
import { TICK_RATE } from '../types';

/** What every emitter kind has: how its payload is made (emitterPayload). */
interface EmitterBase {
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

/** Fires volleys of homing projectiles (volley.ts). */
export interface VolleySpec extends EmitterBase {
  readonly kind: 'volley';
}

/**
 * Lobs bombs (lob.ts): projectileCount of them a firing, each flying flightTicks to a point by a
 * crowded spot, where it explodes over `radius` and leaves a fire zone (`zone`,
 * src/sim/systems/zones.ts) that deals damagePctPerSec of the damage stat a second to the
 * enemies in it for durationSec.
 */
export interface LobSpec extends EmitterBase {
  readonly kind: 'lob';
  /** Firings a second at BASE_ATTACK_SPEED. */
  readonly baseRate: number;
  /** The explosion's radius. */
  readonly radius: number;
  /** Ticks from a bomb's launch to its landing. */
  readonly flightTicks: number;
  readonly zone: {
    readonly radius: number;
    readonly durationSec: number;
    readonly damagePctPerSec: number;
  };
}

/**
 * A thorns grant: hits each enemy that touches the player before it deals its contact damage
 * (src/sim/systems/contact.ts). It never attacks on its own.
 */
export interface ThornsSpec extends EmitterBase {
  readonly kind: 'thorns';
}

/** What an emitter is; `kind` says how it deals its damage. */
export type EmitterSpec = VolleySpec | LobSpec | ThornsSpec;

/**
 * The emitter of a talent node's grant (src/data/emitters.ts), credited to the node's source:
 * never the signature attack, never chaining.
 */
export function grantEmitter(source: string, grant: EmitterGrant): EmitterSpec {
  switch (grant.kind) {
    case 'thorns':
      return {
        kind: 'thorns',
        signature: false,
        source,
        damagePct: grant.damagePct ?? THORNS_DAMAGE_PCT,
        tags: TAG.hit | TAG.thorns,
        chains: false,
        rollsAilments: true,
        canCrit: true,
      };
  }
}

/**
 * Bits of Payload.flags. SIGNATURE marks damage of the signature attack; the dispatch flags
 * share its bit (full layout in src/sim/effects/flags.ts).
 */
export const SIGNATURE = 1;
/**
 * The bit of Payload.flags that makes every hit of a pulse payload ignite, its roll still drawn
 * (hitPulse, src/sim/systems/zones.ts): set on 火地's, the lob's fire zones (Payload.zoneVariant),
 * a repeat's bombs' included.
 * It rides into the hits' dispatch flags, where no condition reads it, and kills drop it
 * (HIT_BITS); bit 20 of the layout in src/sim/effects/flags.ts.
 */
export const ALWAYS_IGNITES = 1 << 20;

/**
 * Bits of Payload.bypass: its hits pass through an enemy's shield, its armour (coinHit's
 * ignoreShield and ignoreArmour). No enemy has either yet; the defences that read them come
 * with C7.
 */
export const IGNORE_SHIELD = 1;
export const IGNORE_ARMOUR = 2;

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
  /**
   * SIGNATURE for the signature emitter's payload, SIGNATURE and REPEAT for a repeat's
   * (src/sim/effects/flags.ts); ALWAYS_IGNITES for 火地's, and REPEAT too for a repeat bomb's.
   */
  readonly flags: number;
  /** Stream of its rolls: combat for emitters, effects for effects and repeats. */
  readonly rng: Rng;
  readonly chains: boolean;
  readonly rollsAilments: boolean;
  /** False skips the whole crit decision: the roll, forced crits and critAlways. */
  readonly canCrit: boolean;
  readonly damageMode: DamageMode;
  /** ModTable row of each slot (SLOT_*), −1 until first use (slotRow). */
  readonly rows: Int32Array;
  /** The payload of the zone each attack of it leaves: a lob's fire zone (火地); null for none. */
  readonly zoneVariant: Payload | null;
  /**
   * A pulse's payload (a zone's): its hits add to the pulse's tally (PulseAcc) instead of each
   * raising a hit event, and the pulse raises one pulse event (src/sim/systems/zones.ts).
   */
  readonly aggregate: boolean;
  /** IGNORE_SHIELD and IGNORE_ARMOUR: a coinHit's; 0 for every other payload. */
  readonly bypass: number;
}

/**
 * What a payload is made of; jumpSource defaults to source, zoneVariant to null, aggregate to
 * false, bypass to 0. `rowsOf` is a payload of the same tags, source and jumpSource, so whose
 * slots key the same rows: the new payload shares its row cache (Payload.rows) instead of
 * starting its own.
 */
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
  readonly zoneVariant?: Payload | null;
  readonly aggregate?: boolean;
  readonly bypass?: number;
  readonly rowsOf?: Payload;
}

/** A payload with every member written in one order, so all payloads share one shape. */
export function createPayload(spec: PayloadSpec): Payload {
  const payload: { -readonly [K in keyof Payload]: Payload[K] } = {
    baseDamage: spec.baseDamage,
    tags: spec.tags,
    source: spec.source,
    jumpSource: spec.jumpSource ?? spec.source,
    // Its own payload, which does not exist yet: set right below.
    extraJumpPayload: null as unknown as Payload,
    flags: spec.flags,
    rng: spec.rng,
    chains: spec.chains,
    rollsAilments: spec.rollsAilments,
    canCrit: spec.canCrit,
    damageMode: spec.damageMode,
    rows: spec.rowsOf === undefined ? new Int32Array(SLOT_COUNT).fill(-1) : sharedRows(spec),
    zoneVariant: spec.zoneVariant ?? null,
    aggregate: spec.aggregate ?? false,
    bypass: spec.bypass ?? 0,
  };
  payload.extraJumpPayload = payload;
  return payload;
}

/** The row cache of spec.rowsOf, whose slots must key the rows of the spec's. */
function sharedRows(spec: PayloadSpec): Int32Array {
  const of = spec.rowsOf as Payload;
  const jumpSource = spec.jumpSource ?? spec.source;
  if (of.tags !== spec.tags || of.source !== spec.source || of.jumpSource !== jumpSource) {
    throw new Error('A payload shares the rows only of one with its tags and sources');
  }
  return of.rows;
}

/**
 * The payload of an emitter: its share of the damage stat, its tags and source, on `rng`; a
 * lob's carries its fire zone's (lobZonePayload).
 */
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
    zoneVariant: spec.kind === 'lob' ? lobZonePayload(build, spec, rng) : null,
  });
}

/**
 * The payload of a lob's fire zones (火地): the damage stat, which each zone scales by its
 * damagePctPerSec, tagged hit and zone with the lob's element, credited to the lob's source, on
 * `rng`. Its pulse hits crit and roll ailments as other hits do (Hoshi's Q4 (B)), and every one
 * ignites, its roll still drawn (ALWAYS_IGNITES, Hoshi's Q4/F1). It is not the signature's: its
 * hits carry no SIGNATURE and raise no center event.
 */
function lobZonePayload(build: CompiledBuild, spec: LobSpec, rng: Rng): Payload {
  return createPayload({
    baseDamage: num(build.values.damage),
    tags: TAG.hit | TAG.zone | (spec.tags & ELEMENT_MASK),
    source: build.sources.index(spec.source),
    flags: ALWAYS_IGNITES,
    rng,
    chains: false,
    rollsAilments: true,
    canCrit: true,
    damageMode: ROWS,
    aggregate: true,
  });
}

/** Ticks between periodic events at `rate` per second: Infinity (never) at a rate ≤ 0. */
export function periodTicks(rate: number): number {
  return rate > 0 ? TICK_RATE / rate : Infinity;
}

/**
 * The attackSpeed at which an emitter attacks at its base rate, the stat's base value
 * (BASE_STATS.attackSpeed, src/data/stats.ts); other values scale the rate in proportion.
 */
export const BASE_ATTACK_SPEED = 4;
/** The volley's attacks per second at BASE_ATTACK_SPEED: M1 attacks attackSpeed times a second. */
export const VOLLEY_RATE = 4;

/** Ticks between the attacks of an emitter of `spec` in `build` (EmitterRuntime.interval). */
export function emitterInterval(build: CompiledBuild, spec: EmitterSpec): number {
  switch (spec.kind) {
    case 'volley':
      return periodTicks((VOLLEY_RATE * build.values.attackSpeed) / BASE_ATTACK_SPEED);
    case 'lob': {
      // 火山 fires every periodSec at the base attack speed, in place of the lob's rate.
      const volcano = build.signature.lob?.volcano ?? null;
      return volcano === null
        ? periodTicks((spec.baseRate * build.values.attackSpeed) / BASE_ATTACK_SPEED)
        : periodTicks(build.values.attackSpeed / BASE_ATTACK_SPEED / volcano.periodSec);
    }
    case 'thorns':
      // Its hits come with the contacts, not on a period.
      return Infinity;
  }
}

/** One emitter of the run: its spec, payload and counters. */
export interface EmitterRuntime {
  readonly spec: EmitterSpec;
  readonly payload: Payload;
  /**
   * Its position in CompiledBuild.emitters (0: the signature attack); the stages keep that order:
   * runEmitters walks RunContext.emitters and skips the kinds whose EMITTER_STEPS entry is null,
   * which the other stages run from their own lists (RunContext.thornsEmitters).
   */
  readonly index: number;
  /** Ticks between its attacks (emitterInterval); Infinity disables attacking. */
  interval: number;
  /** Ticks accumulated towards the next attack, cadence per tick. */
  acc: number;
  /** Shots fired (a volley's projectiles, a lob's bombs), for steadyAim's every-Nth shot. */
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

export function createEmitterRuntime(
  spec: EmitterSpec,
  payload: Payload,
  index: number,
  interval: number,
): EmitterRuntime {
  return {
    spec,
    payload,
    index,
    interval,
    acc: 0,
    shots: 0,
    attacks: 0,
    volley: 0,
    steadyAttack: false,
    cadence: 1,
  };
}

/**
 * Counts one shot of a counted attack of `em` (a bomb; the volley counts its projectiles in
 * fireAttack itself, by the same rule) and tells whether it is steady: steadyAim's every-Nth
 * shot, or every shot of a steady attack (EmitterRuntime.steadyAttack, or an onAttack hook's
 * ShotScratch.forceCrit). A shot that PROJECTILE_CAP refuses still counts.
 */
export function nextShotSteady(ctx: RunContext, em: EmitterRuntime): boolean {
  em.shots++;
  const { forceCritEvery, counts } = ctx.build.signature;
  return (
    (counts === 'shot' && forceCritEvery > 0 && em.shots % forceCritEvery === 0) ||
    em.steadyAttack ||
    ctx.shotScratch.forceCrit
  );
}

/**
 * What one attack and its chain have used of their caps; one reused object per run, reset at
 * each attack (beginAttack, src/sim/combat/chain.ts). CHAIN_HIT_CAP reads hits; the caps that
 * read the other fields come later in C4.
 */
export interface ChainBudget {
  /** Hits of the attack so far, its primary hit included (CHAIN_HIT_CAP, src/sim/caps.ts). */
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
