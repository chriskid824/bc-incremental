/**
 * Frost (docs/v3/game-design-v3.md §1.3): every enemy has a chill meter from 0 to 1 that hits
 * (frostOnHit) and addFrost effects fill. The meter slows the enemy, up to frostSlowCap at a full
 * meter (BOSS_SLOW_CAP_OFFSET less for a boss). When it fills, a normal enemy freezes for
 * freezeDuration: it stands still, takes frozenDamageTaken more damage (takenMult in shock.ts),
 * and shatters if it dies frozen (SHATTER_TRIGGER, src/sim/effects/types.ts). Its meter is then
 * empty and locked for the freeze plus BuildFlags.frostImmuneTicks. A boss never freezes: its
 * full meter empties and locks for BuildFlags.bossLockTicks (at least bossMinGapTicks). Either
 * way the freeze center event follows (freeze in src/sim/effects/centerEvents.ts).
 *
 * Conditions, scaling and the kill snapshot read the meter through frostMeter, which reads a
 * frozen normal enemy as full; movement and addFrost read the raw field, which is 0 during a
 * freeze, so a thawed enemy is not slowed by a stale meter.
 */

import type { Enemy, RunContext } from '../systems/context';

/** How much less a boss is slowed at a full meter than a normal enemy (frostSlowCap − 0.15). */
export const BOSS_SLOW_CAP_OFFSET = 0.15;

/** The enemy's chill meter at tick `now`, 0 to 1: a frozen normal enemy reads full. */
export function frostMeter(enemy: Enemy, now: number): number {
  return !enemy.boss && enemy.frozenUntil > now ? 1 : enemy.frost;
}

/** The enemy is chilled (its meter reads above 0) at tick `now`. */
export function holdsFrost(enemy: Enemy, now: number): boolean {
  return frostMeter(enemy, now) > 0;
}

/** The enemy is frozen at tick `now`. */
export function holdsFrozen(enemy: Enemy, now: number): boolean {
  return enemy.frozenUntil > now;
}

/**
 * The fraction of its step the enemy loses at tick `now`: all of it while frozen, else the
 * largest of the build's slow on every enemy (BuildFlags.globalSlow), its chill and the live
 * slow of the zones it stands in (src/sim/systems/zones.ts), which bosses take in full.
 */
export function enemySlow(ctx: RunContext, enemy: Enemy, now: number): number {
  if (enemy.frozenUntil > now) return 1;
  const cap = enemy.boss ? ctx.bossFrostSlowCap : ctx.frostSlowCap;
  const slow = Math.max(ctx.globalSlow, cap * enemy.frost);
  return enemy.zoneSlowUntil > now ? Math.max(slow, enemy.zoneSlow) : slow;
}

/**
 * Adds `amount` to the enemy's meter, from an instance of source `applier`; nothing while its
 * meter is locked. True when the meter filled: a normal enemy froze (shattering is then credited
 * from `applier`), or a boss's meter emptied. The caller raises the freeze event.
 */
export function addFrost(ctx: RunContext, enemy: Enemy, amount: number, applier: number): boolean {
  const now = ctx.now;
  if (now < enemy.frostLockUntil) return false;
  ctx.frostApplied = true;
  const frost = Math.min(1, enemy.frost + amount);
  if (frost < 1) {
    enemy.frost = frost;
    return false;
  }
  enemy.frost = 0;
  if (enemy.boss) {
    enemy.frostLockUntil = now + ctx.bossFrostLockTicks;
  } else {
    enemy.frozenUntil = now + ctx.freezeTicks;
    enemy.frostLockUntil = enemy.frozenUntil + ctx.frostImmuneTicks;
    enemy.frostApplier = applier;
  }
  return true;
}
