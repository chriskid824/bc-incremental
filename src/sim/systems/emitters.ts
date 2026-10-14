/**
 * Emitters (docs/v3/implementation-plan-v3.md §2.15): the signature attack. Due attacks fire
 * homing projectiles at targets picked by src/sim/targeting.ts; the projectiles system moves
 * them and resolves their hits. The rule modules' tick hooks run after the attacks.
 */

import { pickTargetInGrid } from '../targeting';
import { focused, rollCount } from './context';
import type { Enemy, Projectile, RunContext } from './context';

/**
 * Fires every due attack. An attack fires projectileCount projectiles, each at its own
 * target so projectiles spread over enemies; extra projectiles without a target are lost.
 */
export function attack(ctx: RunContext): void {
  const grid = ctx.grid;
  const player = ctx.player;
  const attackInterval = ctx.attackInterval;
  ctx.attackTicks += 1;
  while (ctx.attackTicks >= attackInterval) {
    let target = pickTargetInGrid(grid, player.x, player.y, ctx.shootable, focused);
    if (target === null) {
      // Stay ready without banking attacks: fire on the tick a target appears.
      ctx.attackTicks = attackInterval - 1;
      return;
    }
    ctx.attackTicks -= attackInterval;
    const count = rollCount(ctx.projectileCount, (p) => ctx.combatRng.chance(p));
    ctx.volley++;
    for (let n = 0; n < count && target !== null; n++) {
      target.volleyMark = ctx.volley;
      fire(ctx, target);
      if (n + 1 < count) {
        target = pickTargetInGrid(grid, player.x, player.y, ctx.shootableInVolley, focused);
      }
    }
  }
}

/** The rule modules' tick hooks, after this tick's attacks (src/sim/rules/module.ts). */
export function runTickHooks(ctx: RunContext): void {
  for (const hook of ctx.build.hooks.tick) hook(ctx);
}

function fire(ctx: RunContext, target: Enemy): void {
  const player = ctx.player;
  const every = ctx.build.signature.forceCritEvery;
  ctx.shots++;
  target.inbound++;
  const projectile: Projectile = {
    id: ctx.nextProjectileId++,
    x: player.x,
    y: player.y,
    prevX: player.x,
    prevY: player.y,
    targetId: target.id,
    steady: every > 0 && ctx.shots % every === 0,
    alive: true,
    target,
  };
  ctx.projectiles.push(projectile);
  ctx.events.push({ type: 'attack', projectileId: projectile.id, targetId: target.id });
}
