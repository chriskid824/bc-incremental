/**
 * Death and drops (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2–3). Kills resolve
 * inline, at the hit or burn tick that kills: pandemic spread, drops and split children
 * happen at once, so later hits of the same tick can reach the children. The death step of
 * the tick order only compacts the entity arrays.
 */

import { add, mul, num } from '../../core/num';
import { spreadBurns } from './burn';
import type { Enemy, Projectile, RunContext } from './context';
import { split } from './spawn';

/** Marks the enemy dead: it leaves targeting at once and the arrays at compaction. */
export function removeEnemy(ctx: RunContext, enemy: Enemy): void {
  enemy.alive = false;
  enemy.rec.alive--;
  ctx.enemiesDirty = true;
}

export function killEnemy(ctx: RunContext, enemy: Enemy): void {
  if (ctx.pandemicRadiusSq > 0) spreadBurns(ctx, enemy);
  removeEnemy(ctx, enemy);
  ctx.kills++;
  const def = enemy.def;
  const shards = mul(mul(num(def.dropMult), enemy.rec.shardsPerStd), ctx.shardGain);
  const expectedCores = def.cores * ctx.coreGain;
  let cores = 0;
  if (expectedCores > 0) {
    cores = Math.floor(expectedCores);
    if (ctx.dropsRng.chance(expectedCores - cores)) cores++;
  }
  const state = ctx.state;
  state.shards = add(state.shards, shards);
  state.cores += cores;
  ctx.events.push({
    type: 'enemyKilled',
    enemyId: enemy.id,
    enemy: def.id,
    x: enemy.x,
    y: enemy.y,
    shards,
    cores,
  });
  split(ctx, enemy);
}

/** Removes dead entities in place, preserving id order. */
export function compact(ctx: RunContext): void {
  if (ctx.enemiesDirty) {
    const enemies = ctx.enemies;
    let kept = 0;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i] as Enemy;
      if (enemy.alive) enemies[kept++] = enemy;
    }
    enemies.length = kept;
    ctx.enemiesDirty = false;
  }
  if (ctx.projectilesDirty) {
    const projectiles = ctx.projectiles;
    let kept = 0;
    for (let i = 0; i < projectiles.length; i++) {
      const projectile = projectiles[i] as Projectile;
      if (projectile.alive) projectiles[kept++] = projectile;
    }
    projectiles.length = kept;
    ctx.projectilesDirty = false;
  }
}
