/**
 * Movement system (docs/v3/implementation-plan-v3.md §2.15): enemies walk straight towards
 * the player, who stays at the center. Contact is resolved after every enemy has moved
 * (src/sim/systems/contact.ts).
 */

import type { Enemy, RunContext } from './context';

export function moveEnemies(ctx: RunContext): void {
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
