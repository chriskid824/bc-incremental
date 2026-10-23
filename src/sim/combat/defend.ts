/**
 * Enemy defences (docs/v3 C7 design §2.4; C3D:1739-1744): the shield and the armour a v3 run's
 * enemy holds in its record (EnemyV3.defence and blockPct, src/sim/systems/enemyRecord.ts). Both
 * hit paths, hitWithPayload (src/sim/combat/hit.ts) and a pulse's hitPulse
 * (src/sim/systems/zones.ts), pass a hit on such an enemy through defend once takenMult and the
 * modifyDamage hooks have applied, before the hit is dealt; an M1 run's enemies have no record,
 * so its hits never come here. A hit is its parts: one for a hit that does not convert, its
 * conversion's parts (RunContext.hitParts) for one that does. A part of a damage-over-time kind
 * (burn, poison or bleed) passes both defences untouched, and damage over time itself (burn
 * ticks, poison and bleed steps) never meets them (gd:53). The shield blocks every other part
 * below blockPct of the enemy's max life (「小於」: strictly below), tested on the part before the
 * armour (lead ruling L8); the armour takes ARMOUR_TAKEN of each part that passed. The hit row's
 * ignoreShield and ignoreArmour stats and the payload's bypass bits (coinHit's) pass them
 * (bypassOf). Only the shield blocks a hit in full, and only a hit with no part of a
 * damage-over-time kind whose every part landed 0 (lead ruling R2): the armour alone never does, so
 * a hit of 0 on an enemy whose shield is absent or passed lands 0, as on an enemy without defences.
 * A hit blocked in full (blockedHit) deals nothing, raises no hit event or trigger, and applies
 * only its burn and the poison and bleed that ailmentOnBlock lets through (lead ruling L1); its hit
 * path returns false, so the shocks its caller adds after a hit skip it (lead ruling R1).
 */

import type { Num } from '../../core/num';
import { add, isZero, lt, mul, toNumber, ZERO } from '../../core/num';
import { DOT_MASK } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import { statAt } from '../build/eval';
import type { EvalInput } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import type { ModTable } from '../build/modTable';
import {
  IGNORE_ARMOUR,
  IGNORE_SHIELD,
  SLOT_BLEED,
  SLOT_BLEED_CRIT,
  SLOT_POISON,
  SLOT_POISON_CRIT,
  slotRow,
} from '../emitters/types';
import type { Payload } from '../emitters/types';
import type { Enemy, RunContext } from '../systems/context';
import { ARMOURED, SHIELDED } from '../systems/enemyRecord';
import type { EnemyV3 } from '../systems/enemyRecord';
import { applyDots, applyHitBurn, BLEEDS, POISONS } from './hit';

export { ARMOURED, SHIELDED };

/** The share of a hit part that passed its shield an ARMOURED enemy takes (gd:708 「−50%」). */
export const ARMOUR_TAKEN = 0.5;

const IGNORE_SHIELD_STAT = SCOPED_INDEX.ignoreShield;
const IGNORE_ARMOUR_STAT = SCOPED_INDEX.ignoreArmour;
const AILMENT_ON_BLOCK = SCOPED_INDEX.ailmentOnBlock;

/**
 * The bypass bits of a hit of payload `p` whose row, after its crit roll, is `row`, for the
 * instance `ev`: the payload's own (Payload.bypass), IGNORE_SHIELD when the row's ignoreShield is
 * above 0 and IGNORE_ARMOUR when its ignoreArmour is. So a crit-tagged ignoreArmour (破甲) passes
 * armour on crits only, and a chain-tagged ignoreShield (破盾電弧) passes shields on chain jumps only
 * (C7/F22).
 */
export function bypassOf(
  p: Payload,
  table: ModTable,
  row: number,
  ev: Readonly<EvalInput>,
): number {
  let bypass = p.bypass;
  if (statAt(table, row, IGNORE_SHIELD_STAT, ev) > 0) bypass |= IGNORE_SHIELD;
  if (statAt(table, row, IGNORE_ARMOUR_STAT, ev) > 0) bypass |= IGNORE_ARMOUR;
  return bypass;
}

/** What a hit part of `amount` with tags `mask` lands through the defences that apply. */
function landedPart(
  amount: Num,
  mask: number,
  shield: boolean,
  armour: boolean,
  threshold: Num,
): Num {
  if ((mask & DOT_MASK) !== 0) return amount;
  if (shield && lt(amount, threshold)) return ZERO;
  return armour ? mul(amount, ARMOUR_TAKEN) : amount;
}

/**
 * What a hit of `amount` with tags `mask` lands on `enemy`, whose record is `v`, through its
 * defences that the hit's `bypass` bits (bypassOf) leave: the amount to deal, or null when it is
 * blocked in full, which takes all three of: the shield applies, no part is of a damage-over-time
 * kind, and every part landed 0, a hit of 0 included (lead ruling R2). So the armour alone never
 * blocks a hit in full, nor does the shield a hit with a damage-over-time part: either lands what
 * it lands, 0 included. A `converted` hit is its parts (RunContext.hitParts), each its share of
 * `amount`, since takenMult and the hooks scale every part alike; what each part landed is
 * written back into the parts, with their total, so the tallies take each part as it landed
 * (tallyParts, src/sim/combat/hit.ts). A converted hit with a part that landed is no full block
 * either: it deals what landed, and its ailments apply as any hit's.
 */
export function defend(
  ctx: RunContext,
  enemy: Enemy,
  v: EnemyV3,
  amount: Num,
  mask: TagMask,
  converted: boolean,
  bypass: number,
): Num | null {
  const shield = (v.defence & SHIELDED) !== 0 && (bypass & IGNORE_SHIELD) === 0;
  const armour = (v.defence & ARMOURED) !== 0 && (bypass & IGNORE_ARMOUR) === 0;
  if (!shield && !armour) return amount;
  const threshold = shield ? mul(enemy.maxHp, v.blockPct) : ZERO;
  if (!converted) {
    const landed = landedPart(amount, mask, shield, armour, threshold);
    return shield && (mask & DOT_MASK) === 0 && isZero(landed) ? null : landed;
  }
  const parts = ctx.hitParts;
  // As in tallyParts, a hook can turn a hit of 0 into damage, which no share can scale: it is
  // the first part's.
  const whole = toNumber(parts.total) === 0;
  const scale = whole || amount === parts.total ? 1 : toNumber(amount) / toNumber(parts.total);
  let total = ZERO;
  let blocked = shield;
  for (let i = 0; i < parts.n; i++) {
    const share = whole ? (i === 0 ? amount : ZERO) : (parts.amount[i] as Num);
    const part = scale === 1 ? share : mul(share, scale);
    const partMask = parts.mask[i] as number;
    const landed = landedPart(part, partMask, shield, armour, threshold);
    parts.amount[i] = landed;
    total = i === 0 ? landed : add(total, landed);
    if ((partMask & DOT_MASK) !== 0 || !isZero(landed)) blocked = false;
  }
  parts.total = total;
  return blocked ? null : total;
}

/**
 * A hit of payload `p` on `enemy` that its defences blocked in full (defend returned null),
 * which its hit path hands here in place of applyHitDamage and all that follows it: `amount` is
 * its damage after takenMult and the hooks, `base` its damage before its damage row, and
 * `crit`, `ignites` and `rolled` its rolls, drawn before its defences, so the payload's stream
 * stands where a landed hit leaves it; the trigger stream does not, since a blocked hit
 * dispatches no hit or crit trigger and so draws none of their chance rolls. The enemy counts as
 * hit by the attack (Enemy.hitMark), so a chain does not jump back to it, and the hit pushes
 * hitBlocked unless it is a pulse's (`aggregate`).
 * It deals, tallies and dispatches nothing: no hp, tally, hit event, maxHit, hit or crit trigger
 * or onHit hook, nor a pulse's tally or quiet dispatch. Its burn applies as a landed hit's
 * (applyHitBurn, through applyPulseBurn in a pulse; lead ruling L1); its poison and its bleed
 * only where ailmentOnBlock is above 0 on that ailment's own row, crit or not, so a
 * [poison]-tagged one lets poison through and not bleed; its shock and frost never apply, nor
 * do the shocks its caller adds after it, since its hit path returns false (lead ruling R1).
 */
export function blockedHit(
  ctx: RunContext,
  enemy: Enemy,
  p: Payload,
  amount: Num,
  base: Num,
  crit: boolean,
  ignites: boolean,
  rolled: number,
  depth: number,
  origin: number,
  aggregate: boolean,
): void {
  enemy.hitMark = ctx.attackSerial;
  if (!aggregate) {
    ctx.events.push({
      type: 'hitBlocked',
      targetId: enemy.id,
      x: enemy.x,
      y: enemy.y,
      amount,
      crit,
    });
  }
  if (ignites && ctx.burnTicks > 0) {
    applyHitBurn(ctx, enemy, p, base, crit, depth, origin, aggregate);
  }
  if (rolled === 0) return;
  const build = ctx.build;
  const table = ctx.table;
  const ev = ctx.evalInput;
  // Read at jump 0, as the ailment's damage is (ailmentDps).
  ev.chainJump = 0;
  let through = 0;
  if (
    (rolled & POISONS) !== 0 &&
    statAt(table, slotRow(build, p, crit ? SLOT_POISON_CRIT : SLOT_POISON), AILMENT_ON_BLOCK, ev) >
      0
  ) {
    through |= POISONS;
  }
  if (
    (rolled & BLEEDS) !== 0 &&
    statAt(table, slotRow(build, p, crit ? SLOT_BLEED_CRIT : SLOT_BLEED), AILMENT_ON_BLOCK, ev) > 0
  ) {
    through |= BLEEDS;
  }
  if (through !== 0) applyDots(ctx, enemy, p, base, crit, through, depth, origin);
}
