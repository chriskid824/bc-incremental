/**
 * The damage an ailment has left on an enemy, and taking a share of it (docs/v3 C4 design
 * §4.16): what a detonate deals (src/sim/effects/execute.ts) and what a kill trigger's pending
 * kill carries for it, read before the victim's rings go back (recordPendingKills,
 * src/sim/effects/dispatch.ts).
 *
 * Damage left is everything not dealt yet: what is pending until the next step, what the
 * ailment accrued since its last step, and what it will deal. Burn records count from their last
 * step (burnLeft: the previous step tick, or this tick once the enemy's step has dealt it), DoT
 * rings their remaining, and bleed what it accrued at the rates that applied, then the rest at
 * the rate the enemy takes now: moving, or standing still, frozen or fully slowed
 * (bleedRemaining, Hoshi's Q7 (A)). A victim its burn or poison step killed never took that
 * step's bleed, so its bleed still counts from the previous step tick (Hoshi's Q7/F1).
 *
 * A consume takes a share f of it: every stack keeps going, its damage × (1 − f), so the stack
 * counts stay (a ring scales each step, RingPool.consume); f = 1 takes it all and removes the
 * ailment. Only execute.ts and dispatch.ts import this module: the stack caps that
 * stacksAtLeast 'max' reads live beside their appliers (burnCapOf, shockCapOf), so the build
 * modules and the appliers never reach it (§0.7).
 */

import type { Num } from '../../core/num';
import { add, mul, num, ZERO } from '../../core/num';
import type { DetonateAilment } from '../../data/triggers';
import { KILL_BY_BURN, KILL_BY_POISON } from '../effects/flags';
import type { BurnStack, Enemy, RunContext } from '../systems/context';
import { DT } from '../types';
import { syncRingStacks } from './apply';
import { accruedBleed, lastStep } from './bleed';
import { enemySlow } from './frost';
import { RING_BURN, RING_POISON } from './rings';

/** The damage the enemy's `ailment` has yet to deal. */
export function remainingOf(ctx: RunContext, enemy: Enemy, ailment: DetonateAilment): Num {
  if (ailment === 'bleed') return bleedRemaining(ctx, enemy);
  if (ailment === 'poison') return ringsRemaining(ctx, enemy, RING_POISON);
  return ctx.burnRings ? ringsRemaining(ctx, enemy, RING_BURN) : burnLeft(ctx, enemy);
}

/**
 * The damage the burn records have yet to deal: what is pending, then each stack from its start
 * or the enemy's last step, whichever is later. recordsLeft (records.ts) counts from the previous
 * step tick, so on a tick the enemy has already been stepped it still counts that step, which
 * this does not.
 */
export function burnLeft(ctx: RunContext, enemy: Enemy): Num {
  const from = Math.max(ctx.lastBurnTick, enemy.burnSteppedAt);
  let left = enemy.burnPending;
  const burns = enemy.burns;
  for (let s = 0; s < burns.length; s++) {
    const stack = burns[s] as BurnStack;
    const ticks = stack.end - Math.max(stack.start, from);
    if (ticks > 0) left = add(left, mul(stack.dps, ticks * DT));
  }
  return left;
}

/**
 * The damage the bleed has yet to deal: what is pending, what it accrued since it was last dealt
 * (bleedDealtAt; its moving ticks weighted), and the rest of it at the rate the enemy takes now,
 * moving or standing still (a dead, frozen or fully slowed enemy stands).
 */
export function bleedRemaining(ctx: RunContext, enemy: Enemy): Num {
  const now = ctx.now;
  const moving = enemy.alive && enemy.stepDist * (1 - enemySlow(ctx, enemy, now)) > 0;
  const mult = moving ? ctx.bleedMoveMult : ctx.bleedStationaryMult;
  const ticks = Math.max(0, enemy.bleedUntil - Math.max(enemy.bleedStart, now));
  const future = mul(enemy.bleedDps, ticks * DT * mult);
  return add(add(enemy.bleedPending, accruedBleed(ctx, enemy, bleedDealtAt(ctx, enemy))), future);
}

/**
 * The step the enemy's bleed was last dealt at: the enemy's last step (lastStep), except for a
 * victim its burn or poison step killed (Hoshi's Q7/F1). The step deals burn, poison, then bleed
 * (src/sim/systems/ailments.ts), so that kill came before the bleed's share of the step, which
 * is still to deal: the bleed was last dealt at the previous step tick. Only those steps kill by
 * burn or poison, and lastStep is the previous step tick but for an enemy the running step has
 * reached, so the kill kind alone tells them apart: a live enemy, a kill by a hit or by its own
 * bleed step, and a kill on any other tick read lastStep as before.
 */
function bleedDealtAt(ctx: RunContext, enemy: Enemy): number {
  const kind = enemy.killKind;
  return kind === KILL_BY_BURN || kind === KILL_BY_POISON ? ctx.lastBurnTick : lastStep(ctx, enemy);
}

/** What the enemy's rings of one ailment (first: RING_BURN or RING_POISON) have yet to deal. */
function ringsRemaining(ctx: RunContext, enemy: Enemy, first: number): Num {
  const rings = enemy.rings;
  const remaining = ctx.rings.remaining;
  let left = 0;
  for (let slot = first; slot < first + 3; slot++) {
    const r = rings[slot] as number;
    if (r >= 0) left += remaining[r] as number;
  }
  return num(left);
}

/**
 * Takes `f` (0 < f ≤ 1) of the damage the enemy's `ailment` has yet to deal, and returns it:
 * f × remainingOf. Its stacks keep going at 1 − f of their damage; f = 1 removes the ailment.
 */
export function consumeAilment(
  ctx: RunContext,
  enemy: Enemy,
  ailment: DetonateAilment,
  f: number,
): Num {
  const left = remainingOf(ctx, enemy, ailment);
  if (ailment === 'bleed') consumeBleed(enemy, f);
  else if (ailment === 'poison') consumeRings(ctx, enemy, RING_POISON, f);
  else if (ctx.burnRings) consumeRings(ctx, enemy, RING_BURN, f);
  else consumeRecords(enemy, f);
  return f >= 1 ? left : mul(left, f);
}

/**
 * The rings of one ailment keep 1 − f of what they deal (RingPool.consume); with f ≥ 1 they go
 * back to the pool and the enemy holds none of the ailment, as releaseAilments leaves it.
 */
function consumeRings(ctx: RunContext, enemy: Enemy, first: number, f: number): void {
  const pool = ctx.rings;
  const rings = enemy.rings;
  for (let slot = first; slot < first + 3; slot++) {
    const r = rings[slot] as number;
    if (r < 0) continue;
    pool.consume(r, f);
    if (f >= 1) {
      rings[slot] = -1;
      enemy.dotRings--;
    }
  }
  if (f >= 1) {
    if (first === RING_BURN) enemy.burnRingEnd = 0;
    else enemy.poisonRingEnd = 0;
  }
  syncRingStacks(ctx, enemy, first);
}

/**
 * Every burn record and what is pending keep 1 − f of their damage, per source class too, so the
 * burn tick's credit shares still add up to burnPending; with f ≥ 1 the records are gone.
 */
function consumeRecords(enemy: Enemy, f: number): void {
  if (f >= 1) {
    enemy.burns.length = 0;
    enemy.burnStacks = 0;
    enemy.burnNextEnd = Infinity;
    enemy.burnPending = ZERO;
    enemy.burnPendC = ZERO;
    enemy.burnPendO = ZERO;
    enemy.burnPendF = ZERO;
    return;
  }
  const keep = 1 - f;
  const burns = enemy.burns;
  for (let s = 0; s < burns.length; s++) {
    const stack = burns[s] as BurnStack;
    stack.dps = mul(stack.dps, keep);
  }
  enemy.burnPending = mul(enemy.burnPending, keep);
  enemy.burnPendC = mul(enemy.burnPendC, keep);
  enemy.burnPendO = mul(enemy.burnPendO, keep);
  enemy.burnPendF = mul(enemy.burnPendF, keep);
}

/**
 * The bleed and what it has pending keep 1 − f of their damage; with f ≥ 1 the slot is empty, as
 * a bleed that ended leaves it (stepBleed, bleed.ts).
 */
function consumeBleed(enemy: Enemy, f: number): void {
  if (f >= 1) {
    enemy.bleedDps = ZERO;
    enemy.bleedPending = ZERO;
    enemy.bleedUntil = 0;
    enemy.bleedMovedTicks = 0;
    return;
  }
  const keep = 1 - f;
  enemy.bleedDps = mul(enemy.bleedDps, keep);
  enemy.bleedPending = mul(enemy.bleedPending, keep);
}
