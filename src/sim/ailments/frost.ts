/**
 * Frost (docs/v3/game-design-v3.md §1.3): every enemy has a chill meter from 0 to 1 that hits
 * (frostOnHit) and addFrost effects fill. The meter slows the enemy, up to frostSlowCap at a full
 * meter (BOSS_SLOW_CAP_OFFSET less for a boss). When it fills, a normal enemy freezes for
 * freezeDuration: it stands still, takes frozenDamageTaken more damage (takenMult in shock.ts),
 * and shatters if it dies frozen (SHATTER_TRIGGER, src/sim/effects/types.ts). Its meter is then
 * empty and locked for the freeze plus BuildFlags.frostImmuneTicks. A boss never freezes: its
 * full meter empties and locks for BuildFlags.bossLockTicks (at least bossMinGapTicks). Either
 * way the freeze center event follows (freeze in src/sim/effects/centerEvents.ts). A thaw effect
 * (E6, thawEnemy) ends a normal enemy's freeze early, its lock then frostImmuneTicks from the
 * thaw; and the build's frost gain (E6) scales every frost an enemy takes while shocked or a boss.
 *
 * Conditions, scaling and the kill snapshot read the meter through frostMeter, which reads a
 * frozen normal enemy as full; movement and addFrost read the raw field, which is 0 during a
 * freeze, so a thawed enemy is not slowed by a stale meter.
 */

import type { BuildFlags } from '../build/compile';
import type { Enemy, RunContext } from '../systems/context';
import { WARD_AILMENT_MULT, WARDED } from '../systems/enemyRecord';
import { livePoisonStacks } from './rings';
import { holdsShock } from './shock';

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
 * largest of the build's slow on every enemy (BuildFlags.globalSlow), its chill, the live slow
 * of the zones it stands in (src/sim/systems/zones.ts) and, under 神經毒 (poisonSlow), its poison
 * slow (poisonSlowOf); bosses take the zones' and the poison's in full.
 */
export function enemySlow(ctx: RunContext, enemy: Enemy, now: number): number {
  if (enemy.frozenUntil > now) return 1;
  const cap = enemy.boss ? ctx.bossFrostSlowCap : ctx.frostSlowCap;
  let slow = Math.max(ctx.globalSlow, cap * enemy.frost);
  if (enemy.zoneSlowUntil > now) slow = Math.max(slow, enemy.zoneSlow);
  const flags = ctx.build.flags;
  return flags.poisonSlowPer > 0 ? Math.max(slow, poisonSlowOf(flags, enemy, now)) : slow;
}

/**
 * 神經毒's slow on the enemy at tick `now` (lead rulings H3, H4): poisonSlowPer for every
 * poisonSlowStacks of its live poison stacks (livePoisonStacks: none once every stack has
 * ended), at most poisonSlowMax. Read only in a run with the rule (poisonSlowPer > 0).
 */
export function poisonSlowOf(flags: Readonly<BuildFlags>, enemy: Enemy, now: number): number {
  const steps = Math.floor(livePoisonStacks(enemy, now) / flags.poisonSlowStacks);
  return Math.min(flags.poisonSlowMax, flags.poisonSlowPer * steps);
}

/**
 * Adds `amount` to the enemy's meter, from an instance of source `applier`; nothing while its
 * meter is locked. True when the meter filled: a normal enemy froze (shattering is then credited
 * from `applier`), or a boss's meter emptied. The caller raises the freeze event. Every frost
 * comes through here (a hit's, a zone's pulse, an addFrost effect), so the frost gain of
 * BuildFlags (E6) multiplies each before the ward: × (1 + frostGainShocked on a shocked enemy +
 * frostGainBoss on a boss).
 */
export function addFrost(ctx: RunContext, enemy: Enemy, amount: number, applier: number): boolean {
  const now = ctx.now;
  if (now < enemy.frostLockUntil) return false;
  // 超導 and 霜蝕 (E6). Both are finite and >= 0 (compileBuild), so their sum is 0 only when
  // both are: a run without them pays this one test, and reads no shock.
  const flags = ctx.build.flags;
  const gainShocked = flags.frostGainShocked;
  const gainBoss = flags.frostGainBoss;
  if (gainShocked + gainBoss !== 0) {
    amount *= 1 + (holdsShock(enemy, now) ? gainShocked : 0) + (enemy.boss ? gainBoss : 0);
  }
  // 元素護盾 (C7.6): the ward × WARD_AILMENT_MULT on every ailment applied to the enemy. Only a
  // v3 run's enemies have a record, so an M1 application pays this one test.
  const v = enemy.v3;
  if (v !== null && (v.defence & WARDED) !== 0) amount *= WARD_AILMENT_MULT;
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

/**
 * A thaw (E6, the thaw effect; 熱震's 「解凍」 gd:526): a normal enemy frozen at tick now thaws
 * now, frozenUntil = now, and its meter, which the freeze emptied and the lock has kept empty,
 * stays empty and locked for frostImmuneTicks from now, so the immunity starts at the thaw (lead
 * ruling on A10) as a natural end starts it at frozenUntil. True when it thawed; a boss, which
 * never freezes, and an enemy that is not frozen are left as they are. It raises no event: every
 * reader of the freeze (movement, the enemy AI, takenMult, the conditions, the kill's shatter
 * and the renderer's tint) reads frozenUntil as it is.
 */
export function thawEnemy(ctx: RunContext, enemy: Enemy): boolean {
  const now = ctx.now;
  if (enemy.boss || enemy.frozenUntil <= now) return false;
  enemy.frozenUntil = now;
  enemy.frostLockUntil = now + ctx.frostImmuneTicks;
  return true;
}
