/**
 * Projectiles system (docs/v3/implementation-plan-v3.md §2.15): moves the volley's homing
 * projectiles and resolves each attack the moment a projectile arrives: its payload's primary
 * hit and chain (src/sim/combat/chain.ts). The shot pool's shots (src/sim/systems/shots.ts) step
 * in the same stage, merged with the projectiles by id, and the pool compacts at its end.
 */

import { chainAttack } from '../combat/chain';
import { pickTargetInGrid } from '../targeting';
import { focused } from './context';
import type { Projectile, RunContext } from './context';
import { compactShots, stepShot } from './shots';

/**
 * Straight shots × enemies above which the stage sorts the grid even while it would scan its
 * few enemies linearly, so that the shots' box queries read cells instead of every enemy. The
 * results are the same either way.
 */
const SORT_ABOVE = 4096;

/**
 * Steps every projectile and shot in id order. Nothing spawns during the stage (hits only queue
 * effects), so both lists keep their length until it ends.
 */
export function moveProjectiles(ctx: RunContext): void {
  const shots = ctx.shots;
  if (shots.count === 0) {
    moveHoming(ctx, 0, ctx.projectiles.length);
    return;
  }
  if (
    shots.straight > 0 &&
    shots.straight * ctx.enemies.length > SORT_ABOVE &&
    ctx.grid.linearSource() !== null
  ) {
    ctx.grid.sortNow();
  }
  const projectiles = ctx.projectiles;
  const ids = shots.id;
  const hn = projectiles.length;
  const sn = shots.count;
  let h = 0;
  let s = 0;
  while (h < hn || s < sn) {
    if (s >= sn || (h < hn && (projectiles[h] as Projectile).id < (ids[s] as number))) {
      moveHoming(ctx, h, h + 1);
      h++;
    } else {
      stepShot(ctx, s++);
    }
  }
  compactShots(ctx);
}

/** Homes projectiles[from .. to) on their targets, retargeting first if a target died. */
function moveHoming(ctx: RunContext, from: number, to: number): void {
  const projectiles = ctx.projectiles;
  const projectileStep = ctx.projectileStep;
  for (let i = from; i < to; i++) {
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
        projectile.depth,
        projectile.origin,
      );
    } else {
      const k = projectileStep / dist;
      projectile.x += dx * k;
      projectile.y += dy * k;
    }
  }
}
