/**
 * Projectiles system (docs/v3/implementation-plan-v3.md §2.15): moves homing projectiles and
 * resolves each hit the moment a projectile arrives (src/sim/systems/hits.ts).
 */

import { pickTargetInGrid } from '../targeting';
import { focused } from './context';
import type { Projectile, RunContext } from './context';
import { resolveAttack } from './hits';

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
      resolveAttack(ctx, target, projectile.steady);
    } else {
      const k = projectileStep / dist;
      projectile.x += dx * k;
      projectile.y += dy * k;
    }
  }
}
