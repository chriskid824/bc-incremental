/**
 * Movement system (docs/v3/implementation-plan-v3.md §2.15): enemies walk straight towards
 * the player, who stays at the center. Contact is resolved after every enemy has moved
 * (src/sim/systems/contact.ts). Once a bleed has been applied in the run
 * (RunContext.bleedApplied), a bleeding enemy that moves counts the tick for its bleed
 * (src/sim/ailments/bleed.ts).
 */

import { countBleedMove } from '../ailments/bleed';
import type { Enemy, RunContext } from './context';

export function moveEnemies(ctx: RunContext): void {
  if (ctx.bleedApplied) {
    moveCountingBleeds(ctx);
    return;
  }
  const enemies = ctx.enemies;
  const px = ctx.player.x;
  const py = ctx.player.y;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    enemy.prevX = enemy.x;
    enemy.prevY = enemy.y;
    const dist = enemy.dist - enemy.stepDist;
    enemy.dist = dist > 0 ? dist : 0;
    enemy.x = px + enemy.ux * enemy.dist;
    enemy.y = py + enemy.uy * enemy.dist;
  }
}

/** moveEnemies once some enemy may bleed: the same moves, counted for bleeding enemies. */
function moveCountingBleeds(ctx: RunContext): void {
  const enemies = ctx.enemies;
  const px = ctx.player.x;
  const py = ctx.player.y;
  const now = ctx.now;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    enemy.prevX = enemy.x;
    enemy.prevY = enemy.y;
    const before = enemy.dist;
    const dist = before - enemy.stepDist;
    enemy.dist = dist > 0 ? dist : 0;
    enemy.x = px + enemy.ux * enemy.dist;
    enemy.y = py + enemy.uy * enemy.dist;
    if (enemy.bleedUntil !== 0 && enemy.dist < before) countBleedMove(enemy, now);
  }
}
