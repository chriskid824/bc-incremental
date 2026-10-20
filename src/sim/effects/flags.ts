/**
 * Bits of the flags a trigger event carries (fire and fireOne in dispatch.ts): what the hit
 * behind the event was and, on kill events, what the victim held when it died. Payload.flags
 * holds SIGNATURE; a hit adds HIT, CHAIN_JUMP and CRIT, and an attack's primary hit PRIMARY; a
 * lethal hit's dispatch adds KILLED; a kill's snapshot adds the ailments the victim held and
 * what killed it. Conditions read them (hitIs, victimHas, killedBy; src/sim/build/eval.ts), and
 * onKill hooks see the kill's flags.
 *
 * Layout, bit: meaning (commit):
 * - 0: SIGNATURE, damage of the signature attack (C3.5, src/sim/emitters/types.ts);
 * - 1: CRIT, 2: HIT, 3: CHAIN_JUMP, 4: KILLED (C3.6);
 * - 5–10: the held ailments, one bit per HeldAilment from HELD_SHIFT: burn (C3.6); poison, bleed
 *   and shock (C3.8); frost and frozen (C3.9);
 * - 11–14: the kill kind, one bit per KillKind from KILL_KIND_SHIFT: hit and burn (C3.6); poison
 *   and bleed (C3.8);
 * - 15–17: the kind an ailmentApplied event applied, its AilmentKind ordinal + 1 (C3.8);
 * - 18: PRIMARY, 19: REPEAT (C4.1);
 * - 20: ALWAYS_IGNITES, a Payload.flags bit of 火地's payloads that only hitPulse reads (C4.7,
 *   src/sim/emitters/types.ts); it rides into their hits' events, where no condition reads it,
 *   and is not in HIT_BITS.
 */

import { AILMENT_KINDS, HELD_AILMENTS, KILL_KINDS } from '../../data/triggers';
import type { AppliedAilment, HeldAilment, KillKind } from '../../data/triggers';
import { SIGNATURE } from '../emitters/types';

export { SIGNATURE };

/** The hit crit. */
export const CRIT_HIT = 1 << 1;
/** The event comes from a hit (a kill: the killing blow was a hit). */
export const HIT_EVENT = 1 << 2;
/** The hit is a chain jump, not an attack's primary hit. */
export const CHAIN_JUMP = 1 << 3;
/** The hit killed its target: a lethal hit's hit and crit events and onHit hooks. */
export const KILLED = 1 << 4;
/**
 * The hit is the primary hit of an attack of the signature, or of a repeat of one; effect hits,
 * chain jumps and the hits of granted emitters never are. It comes from primaryHit
 * (src/sim/combat/chain.ts), which a volley projectile's arrival (src/sim/systems/projectiles.ts)
 * and a signature turret shot's (src/sim/systems/shots.ts) reach through chainAttack, as do a
 * discharge's targets (src/sim/emitters/arc.ts) and a fan round's first cone hit (shots.ts);
 * from a bomb's landing (land, src/sim/emitters/lob.ts); and from a signature drone's impact
 * (impactAt, src/sim/systems/drones.ts).
 */
export const PRIMARY = 1 << 18;
/** The hit belongs to a repeat of the signature attack, which never repeats in turn. */
export const REPEAT = 1 << 19;
/** The bits a kill keeps of its killing hit's flags. */
export const HIT_BITS = SIGNATURE | CRIT_HIT | HIT_EVENT | CHAIN_JUMP | PRIMARY | REPEAT;

export const HELD_SHIFT = 5;
/** The six bits of the held ailments. */
export const HELD_MASK = 0b111111 << HELD_SHIFT;
export const KILL_KIND_SHIFT = 11;

/** The flag of a held ailment (victimHas). */
export const heldFlag = (ailment: HeldAilment): number =>
  1 << (HELD_SHIFT + HELD_AILMENTS.indexOf(ailment));

/** The flag of a kill kind (killedBy). */
export const killKindFlag = (kind: KillKind): number =>
  1 << (KILL_KIND_SHIFT + KILL_KINDS.indexOf(kind));

/** Enemy.killKind values: KILL_KINDS ordinals. */
export const KILL_BY_HIT = KILL_KINDS.indexOf('hit');
export const KILL_BY_BURN = KILL_KINDS.indexOf('burn');
export const KILL_BY_POISON = KILL_KINDS.indexOf('poison');
export const KILL_BY_BLEED = KILL_KINDS.indexOf('bleed');

export const AILMENT_FLAG_SHIFT = 15;
/** The three bits of the applied ailment. */
export const AILMENT_FLAG_MASK = 0b111 << AILMENT_FLAG_SHIFT;

/** The flags of an ailmentApplied event that applied `ailment` (the ailment condition). */
export const appliedFlag = (ailment: AppliedAilment): number =>
  (AILMENT_KINDS.indexOf(ailment) + 1) << AILMENT_FLAG_SHIFT;
