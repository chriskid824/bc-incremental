/**
 * Bleed (docs/v3/game-design-v3.md §4.3): an enemy keeps only its strongest bleed, one slot
 * per enemy (Enemy.bleed*). A new bleed takes the slot when it has more damage left than the
 * current one, or when the slot is empty or its bleed has ended; the damage the replaced bleed
 * dealt since the last step is kept (bleedPending) and dealt at the next step, as burn records
 * do (records.ts).
 *
 * A bleeding enemy takes bleedDps per second while it stands still × bleedStationaryMult, and
 * × BuildFlags.bleedMoveMult on the ticks it moves: movement counts the ticks it moved while
 * bleeding (countBleedMove), and the damage-over-time step (src/sim/systems/ailments.ts) weighs
 * them. Ticks are counted as the part of each tick (t − 1, t] inside (bleedStart, bleedUntil],
 * so a bleed ending mid-tick is exact.
 */

import type { Num } from '../../core/num';
import { add, gt, mul, ZERO } from '../../core/num';
import type { Enemy, RunContext } from '../systems/context';
import { DT } from '../types';

/** The enemy bleeds at tick `now`. Damage left from an ended bleed does not count. */
export function holdsBleed(enemy: Enemy, now: number): boolean {
  return enemy.bleedUntil > now;
}

/** Damage of the enemy's bleed from tick `from` to now, its moving ticks weighted. */
export function accruedBleed(ctx: RunContext, enemy: Enemy, from: number): Num {
  const ticks = Math.min(enemy.bleedUntil, ctx.now) - Math.max(enemy.bleedStart, from);
  if (!(ticks > 0)) return ZERO;
  const still = ctx.bleedStationaryMult;
  const moved = enemy.bleedMovedTicks;
  return mul(enemy.bleedDps, DT * (still * ticks + (ctx.bleedMoveMult - still) * moved));
}

/**
 * The last damage-over-time step the enemy took: the previous step tick, or this tick once the
 * step has reached it (Enemy.burnSteppedAt).
 */
export const lastStep = (ctx: RunContext, enemy: Enemy): number =>
  Math.max(ctx.lastBurnTick, enemy.burnSteppedAt);

/**
 * A bleed of `dps` until tick `until`, applied at trigger depth `depth`, credited to `source`.
 * True when it takes the slot: more damage left than the current bleed, or no current bleed;
 * from then on movement counts bleeding enemies' moves (RunContext.bleedApplied).
 */
export function addBleed(
  ctx: RunContext,
  enemy: Enemy,
  dps: Num,
  until: number,
  depth: number,
  source: number,
): boolean {
  const now = ctx.now;
  if (!(until > now)) return false;
  if (
    enemy.bleedUntil > now &&
    !gt(mul(dps, until - now), mul(enemy.bleedDps, enemy.bleedUntil - now))
  ) {
    return false;
  }
  if (enemy.bleedUntil !== 0) {
    enemy.bleedPending = add(enemy.bleedPending, accruedBleed(ctx, enemy, lastStep(ctx, enemy)));
  }
  enemy.bleedDps = dps;
  enemy.bleedStart = now;
  enemy.bleedUntil = until;
  enemy.bleedSource = source;
  enemy.bleedMovedTicks = 0;
  ctx.bleedApplied = true;
  if (depth < enemy.ailDepth) enemy.ailDepth = depth;
  return true;
}

/** Movement: the enemy moved this tick; the part of it inside its bleed counts as moving. */
export function countBleedMove(enemy: Enemy, now: number): void {
  const ticks = Math.min(now, enemy.bleedUntil) - Math.max(now - 1, enemy.bleedStart);
  if (ticks > 0) enemy.bleedMovedTicks += ticks;
}

/**
 * The bleed damage of this step (at tick 15k, before RunContext.lastBurnTick moves to it): what
 * was pending plus what the bleed dealt since the last step. An ended bleed leaves the slot.
 */
export function stepBleed(ctx: RunContext, enemy: Enemy): Num {
  const amount = add(enemy.bleedPending, accruedBleed(ctx, enemy, ctx.lastBurnTick));
  enemy.bleedPending = ZERO;
  enemy.bleedMovedTicks = 0;
  if (enemy.bleedUntil <= ctx.now) {
    enemy.bleedUntil = 0;
    enemy.bleedDps = ZERO;
  }
  return amount;
}

/** The bleed damage the enemy has yet to take, standing still from now on (doomed). */
export function bleedLeft(ctx: RunContext, enemy: Enemy): Num {
  const ticks = enemy.bleedUntil - Math.max(enemy.bleedStart, lastStep(ctx, enemy));
  return ticks > 0 ? add(enemy.bleedPending, mul(enemy.bleedDps, ticks * DT)) : enemy.bleedPending;
}
