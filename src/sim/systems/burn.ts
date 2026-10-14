/**
 * Burn stacks (docs/GDD.md §2–3): applying, expiring and spreading stacks, and the damage a
 * stack accrues between burn ticks. Shared by hits (ignite), death (pandemic spread),
 * ailments (the burn tick) and targeting (doomed). The per-tick burn update is the ailments
 * system (src/sim/systems/ailments.ts).
 */

import type { Num } from '../../core/num';
import { add, lt, lte, mul, ZERO } from '../../core/num';
import { DT } from '../types';
import type { BurnStack, Enemy, RunContext } from './context';

/** Burn damage is dealt on a global cadence of this many ticks (0.25 s). */
export const BURN_TICK_INTERVAL = 15;

/** Stack cap under eternalFlame ("no cap"); a guard against runaway stack lists. */
export const UNCAPPED_BURN_STACKS = 1000;

/** Damage of a stack between the last burn tick (or its start) and `until`. */
export function accrued(ctx: RunContext, stack: BurnStack, until: number): Num {
  const ticks = Math.min(stack.end, until) - Math.max(stack.start, ctx.lastBurnTick);
  return ticks > 0 ? mul(stack.dps, ticks * DT) : ZERO;
}

/** Burns already on the enemy will kill it: shots should go elsewhere. */
export function doomed(ctx: RunContext, enemy: Enemy): boolean {
  if (enemy.burns.length === 0) return false;
  let left = enemy.burnPending;
  for (let s = 0; s < enemy.burns.length; s++) {
    left = add(left, accrued(ctx, enemy.burns[s] as BurnStack, Infinity));
  }
  return lte(enemy.hp, left);
}

/** Moves ended stacks into burnPending and recomputes burnNextEnd. */
export function expireBurns(ctx: RunContext, enemy: Enemy): void {
  const now = ctx.now;
  const burns = enemy.burns;
  let kept = 0;
  let nextEnd = Infinity;
  for (let r = 0; r < burns.length; r++) {
    const stack = burns[r] as BurnStack;
    if (stack.end <= now) {
      enemy.burnPending = add(enemy.burnPending, accrued(ctx, stack, stack.end));
    } else {
      burns[kept++] = stack;
      if (stack.end < nextEnd) nextEnd = stack.end;
    }
  }
  burns.length = kept;
  enemy.burnNextEnd = nextEnd;
  enemy.burnStacks = kept;
}

/** Adds a stack ending at tick `end` (spread stacks keep their source's end). */
export function addBurn(ctx: RunContext, enemy: Enemy, dps: Num, end: number): void {
  const now = ctx.now;
  if (now >= enemy.burnNextEnd) expireBurns(ctx, enemy);
  const burns = enemy.burns;
  if (burns.length < ctx.burnCap) {
    burns.push({ dps, start: now, end });
    if (end < enemy.burnNextEnd) enemy.burnNextEnd = end;
  } else {
    // At the cap, replace the stack with the least remaining damage (first on ties).
    let weakest = burns[0] as BurnStack;
    let weakestLeft = mul(weakest.dps, weakest.end - now);
    for (let i = 1; i < burns.length; i++) {
      const stack = burns[i] as BurnStack;
      const left = mul(stack.dps, stack.end - now);
      if (lt(left, weakestLeft)) {
        weakest = stack;
        weakestLeft = left;
      }
    }
    enemy.burnPending = add(enemy.burnPending, accrued(ctx, weakest, now));
    weakest.dps = dps;
    weakest.start = now;
    weakest.end = end;
    let nextEnd = Infinity;
    for (let i = 0; i < burns.length; i++) {
      const stackEnd = (burns[i] as BurnStack).end;
      if (stackEnd < nextEnd) nextEnd = stackEnd;
    }
    enemy.burnNextEnd = nextEnd;
  }
  enemy.burnStacks = burns.length;
  ctx.events.push({ type: 'ignite', targetId: enemy.id, stacks: burns.length });
}

/** How far a dying enemy's burns spread, and how strong a spread stack is. */
export interface BurnSpread {
  readonly radius: number;
  readonly radiusSq: number;
  /** Damage of a spread stack relative to its source stack. */
  readonly effect: number;
}

/**
 * pandemic (src/sim/rules/pandemicLegacy.ts): copies the dying enemy's active stacks (same end,
 * effect × damage) onto every alive enemy within the spread radius, in id order. Spread stacks
 * spread again, weaker each time.
 */
export function spreadBurns(ctx: RunContext, source: Enemy, spread: BurnSpread): void {
  if (ctx.now >= source.burnNextEnd) expireBurns(ctx, source);
  const burns = source.burns;
  if (burns.length === 0) return;
  // In id order; addBurn kills nothing, so collecting the targets first changes nothing.
  const targets = ctx.spreadTargets;
  const count = ctx.grid.within(source.x, source.y, spread.radiusSq, targets);
  let spreadTo = 0;
  for (let i = 0; i < count; i++) {
    const enemy = targets[i] as Enemy;
    if (enemy === source) continue;
    for (let s = 0; s < burns.length; s++) {
      const stack = burns[s] as BurnStack;
      addBurn(ctx, enemy, mul(stack.dps, spread.effect), stack.end);
    }
    spreadTo++;
  }
  ctx.events.push({
    type: 'burnSpread',
    enemyId: source.id,
    x: source.x,
    y: source.y,
    radius: spread.radius,
    targets: spreadTo,
  });
}
