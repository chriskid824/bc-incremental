/**
 * Projectiles system (docs/v3/implementation-plan-v3.md §2.15): moves homing projectiles and
 * resolves each attack the moment a projectile arrives: its payload's primary hit and chain
 * (src/sim/combat/chain.ts).
 */

import { chainAttack } from '../combat/chain';
import { pickTargetInGrid } from '../targeting';
import { focused } from './context';
import type { Projectile, RunContext } from './context';

/** Homes each projectile on its target, retargeting first if the target died. */
export function moveProjectiles(ctx: RunContext): void {
  const projectiles = ctx.projectiles;
  const projectileStep = ctx.projectileStep;
  for (let i = 0; i < projectiles.length; i++) {
    const projectile = projectiles[i] as Projectile;
    projectile.prevX = projectile.x;
    projectile.prevY = projectile.y;
    let target = projectile.target;
    if (!target.alive) {
      target.inbound--;
      const next = pickTargetInGrid(ctx.grid, projectile.x, projectile.y, ctx.shootable, focused);
      if (next === null) {
        projectile.alive = false;
        ctx.projectilesDirty = true;
        continue;
      }
      target = next;
      target.inbound++;
      projectile.target = target;
      projectile.targetId = target.id;
    }
    const dx = target.x - projectile.x;
    const dy = target.y - projectile.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist - projectileStep <= target.radius) {
      projectile.x = target.x;
      projectile.y = target.y;
      projectile.alive = false;
      ctx.projectilesDirty = true;
      target.inbound--;
      chainAttack(
        ctx,
        projectile.payload,
        target,
        ctx.chainCount,
        projectile.steady,
        projectile.origin,
      );
    } else {
      const k = projectileStep / dist;
      projectile.x += dx * k;
      projectile.y += dy * k;
    }
  }
}
