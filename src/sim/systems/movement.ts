/**
 * Movement system (docs/v3/implementation-plan-v3.md §2.15): enemies walk straight towards
 * the player, who stays at the center. Contact is resolved after every enemy has moved
 * (src/sim/systems/contact.ts). A slowed enemy walks only the part of its step its slow leaves
 * (enemySlow in src/sim/ailments/frost.ts: nothing while frozen; frost, a global slow or a
 * zone's). Once a bleed has been applied in the run (RunContext.bleedApplied), a bleeding enemy
 * that moves counts the tick for its bleed (src/sim/ailments/bleed.ts), so a frozen one bleeds
 * as if standing still.
 */

import { countBleedMove } from '../ailments/bleed';
import { enemySlow } from '../ailments/frost';
import type { Enemy, RunContext } from './context';

export function moveEnemies(ctx: RunContext): void {
  if (ctx.bleedApplied || ctx.frostApplied || ctx.globalSlow !== 0 || ctx.sys.zones.slowApplied) {
    moveSlowedOrBleeding(ctx);
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

/**
 * moveEnemies once some enemy may be slowed or bleed: the same moves, each slowed enemy's step
 * shortened, counted for bleeding enemies. An enemy with no slow walks its whole step, as
 * moveEnemies does.
 */
function moveSlowedOrBleeding(ctx: RunContext): void {
  const enemies = ctx.enemies;
  const px = ctx.player.x;
  const py = ctx.player.y;
  const now = ctx.now;
  const slowsAll = ctx.globalSlow !== 0;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    enemy.prevX = enemy.x;
    enemy.prevY = enemy.y;
    const before = enemy.dist;
    let step = enemy.stepDist;
    if (slowsAll || enemy.frost !== 0 || enemy.frozenUntil > now || enemy.zoneSlowUntil > now) {
      step *= 1 - enemySlow(ctx, enemy, now);
    }
    const dist = before - step;
    enemy.dist = dist > 0 ? dist : 0;
    enemy.x = px + enemy.ux * enemy.dist;
    enemy.y = py + enemy.uy * enemy.dist;
    if (enemy.bleedUntil !== 0 && enemy.dist < before) countBleedMove(enemy, now);
  }
}
