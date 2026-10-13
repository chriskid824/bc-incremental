/**
 * Ailments system (docs/v3/implementation-plan-v3.md §2.15): the per-tick burn update. Burn
 * stacks themselves live in src/sim/systems/burn.ts.
 */

import { add, assertFinite, gt, lte, sub, ZERO } from '../../core/num';
import { accrued, BURN_TICK_INTERVAL, expireBurns } from './burn';
import type { BurnStack, Enemy, RunContext } from './context';
import { killEnemy } from './death';

/** Expires stacks every tick; deals accrued burn damage every BURN_TICK_INTERVAL ticks. */
export function updateBurns(ctx: RunContext): void {
  const enemies = ctx.enemies;
  const now = ctx.now;
  const burnTick = now % BURN_TICK_INTERVAL === 0;
  // Children spawned by burn kills are appended past `count`; they cannot be burning yet.
  for (let i = 0, count = enemies.length; i < count; i++) {
    const enemy = enemies[i] as Enemy;
    if (!enemy.alive) continue;
    if (now >= enemy.burnNextEnd) expireBurns(ctx, enemy);
    if (!burnTick) continue;
    let amount = enemy.burnPending;
    const burns = enemy.burns;
    for (let s = 0; s < burns.length; s++) {
      amount = add(amount, accrued(ctx, burns[s] as BurnStack, now));
    }
    enemy.burnPending = ZERO;
    if (!gt(amount, ZERO)) continue;
    assertFinite(amount, 'burn damage');
    enemy.hp = sub(enemy.hp, amount);
    ctx.damageBurn = add(ctx.damageBurn, amount);
    if (gt(amount, ctx.maxHit)) ctx.maxHit = amount;
    ctx.events.push({ type: 'burnTick', targetId: enemy.id, x: enemy.x, y: enemy.y, amount });
    if (lte(enemy.hp, ZERO)) killEnemy(ctx, enemy);
  }
  if (burnTick) ctx.lastBurnTick = now;
}
