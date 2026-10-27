/**
 * Shock (docs/v3/game-design-v3.md §1.4): stacks that make an enemy take more damage, up to
 * shockMaxStacks, which all wear off together shockDuration after the latest one landed. Shock
 * deals no damage. Every reader (the damage taken, the conditions, the scaling, a new stack)
 * goes through activeShockStacks, so none sees stacks that have worn off; Enemy.shockStacks
 * keeps its last value until the next application.
 */

import type { Enemy, RunContext } from '../systems/context';
import { WARD_AILMENT_MULT, WARDED } from '../systems/enemyRecord';

/** The enemy's shock stacks at tick `now`. */
export function activeShockStacks(enemy: Enemy, now: number): number {
  return enemy.shockUntil > now ? enemy.shockStacks : 0;
}

/** The enemy is shocked at tick `now`. */
export function holdsShock(enemy: Enemy, now: number): boolean {
  return activeShockStacks(enemy, now) > 0;
}

/**
 * Damage the enemy takes per unit dealt: 1 + frozenDamageTaken while it is frozen (frost.ts)
 * + shockEffect × its shock stacks. Hits and damage over time take it once the enemy is shocked
 * or frozen (`(shockStacks !== 0 && shockUntil > now) || frozenUntil > now`).
 *
 * 元素護盾 (C7.6) is the seventh ailment entry: while the enemy holds the ward, the shock term
 * alone is × WARD_AILMENT_MULT, the frozen term is not, and the stacks themselves keep their
 * count (addShock applies them whole), so every other reader of the stacks sees them as they are.
 * Only a v3 run's enemies have a record, and a caller reaches here only for a shocked or frozen
 * enemy, so an M1 run pays this one test per such read.
 */
export function takenMult(ctx: RunContext, enemy: Enemy): number {
  const now = ctx.now;
  const frozen = enemy.frozenUntil > now ? ctx.frozenDamageTaken : 0;
  const shock = ctx.shockEffect * activeShockStacks(enemy, now);
  const v = enemy.v3;
  return v !== null && (v.defence & WARDED) !== 0
    ? 1 + frozen + shock * WARD_AILMENT_MULT
    : 1 + frozen + shock;
}

/**
 * The shock stacks the enemy can hold (RunContext.shockCap, 0 for a build that cannot shock),
 * which addShock reads; what stacksAtLeast 'max' compares with, at least 1
 * (src/sim/build/eval.ts).
 */
export function shockCapOf(ctx: RunContext, _enemy: Enemy): number {
  return ctx.shockCap;
}

/**
 * Adds `stacks` shock stacks, applied at trigger depth `depth`, and restarts the timer of all
 * of them. False, and nothing changes, when the build cannot shock (no stack cap or duration).
 */
export function addShock(ctx: RunContext, enemy: Enemy, stacks: number, depth: number): boolean {
  const cap = shockCapOf(ctx, enemy);
  if (cap <= 0 || ctx.shockTicks <= 0) return false;
  const now = ctx.now;
  enemy.shockStacks = Math.min(cap, activeShockStacks(enemy, now) + stacks);
  enemy.shockUntil = now + ctx.shockTicks;
  if (depth < enemy.ailDepth) enemy.ailDepth = depth;
  return true;
}
