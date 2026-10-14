/**
 * Shock (docs/v3/game-design-v3.md §1.4): stacks that make an enemy take more damage, up to
 * shockMaxStacks, which all wear off together shockDuration after the latest one landed. Shock
 * deals no damage. Every reader (the damage taken, the conditions, the scaling, a new stack)
 * goes through activeShockStacks, so none sees stacks that have worn off; Enemy.shockStacks
 * keeps its last value until the next application.
 */

import type { Enemy, RunContext } from '../systems/context';

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
 */
export function takenMult(ctx: RunContext, enemy: Enemy): number {
  const now = ctx.now;
  const frozen = enemy.frozenUntil > now ? ctx.frozenDamageTaken : 0;
  return 1 + frozen + ctx.shockEffect * activeShockStacks(enemy, now);
}

/**
 * Adds `stacks` shock stacks, applied at trigger depth `depth`, and restarts the timer of all
 * of them. False, and nothing changes, when the build cannot shock (no stack cap or duration).
 */
export function addShock(ctx: RunContext, enemy: Enemy, stacks: number, depth: number): boolean {
  if (ctx.shockCap <= 0 || ctx.shockTicks <= 0) return false;
  const now = ctx.now;
  enemy.shockStacks = Math.min(ctx.shockCap, activeShockStacks(enemy, now) + stacks);
  enemy.shockUntil = now + ctx.shockTicks;
  if (depth < enemy.ailDepth) enemy.ailDepth = depth;
  return true;
}
