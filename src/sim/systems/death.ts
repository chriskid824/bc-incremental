/**
 * Death and drops (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2–3). Kills resolve
 * inline, at the hit or burn tick that kills, in this order:
 * 1. the kill's transfer triggers (Pandemic's spread; src/sim/effects/dispatch.ts), then the rule
 *    modules' onKill hooks, while the victim still holds its ailments;
 * 2. removal, drops, the kill event and split children, so later hits of the same tick can
 *    reach the children; then (2b) the transfer triggers of step 1 with a toSplitChildren spread
 *    give each child its share of the victim's poison;
 * 3. the kill's other triggers, recorded as pending kills (a frozen victim's shatter with them);
 * 4. its DoT rings go back to the pool (src/sim/ailments/apply.ts).
 * The death step of the tick order dispatches the pending kills (their effects run next tick),
 * then compacts the entity arrays.
 */

import { add, mul, num } from '../../core/num';
import { releaseAilments, spreadPoisonToChildren } from '../ailments/apply';
import { heldFlags } from '../build/eval';
import { fireInlineKill, recordPendingKills } from '../effects/dispatch';
import { HIT_BITS, KILL_KIND_SHIFT } from '../effects/flags';
import { MAX_DEPTH } from '../effects/types';
import type { CompiledEffect, CompiledTrigger } from '../effects/types';
import type { Enemy, Projectile, RunContext } from './context';
import { split } from './spawn';
import { toSplitOf } from './systemState';
import type { SplitState } from './systemState';

/** Marks the enemy dead: it leaves targeting at once and the arrays at compaction. */
export function removeEnemy(ctx: RunContext, enemy: Enemy): void {
  enemy.alive = false;
  enemy.rec.alive--;
  ctx.enemiesDirty = true;
}

/**
 * Kills the enemy, whose killDepth and killKind the killing damage has set. `origin` is the
 * trigger whose damage killed it, −1 for emitter hits and DoT kills; `hitFlags` the killing
 * hit's flags, 0 for a DoT kill. Its transfer triggers and the onKill hooks run first, while the
 * enemy is still alive and burning. A v3 enemy's shards and expected cores are × its record's
 * dropScale (src/sim/systems/enemyRecord.ts), before the cores are floored and rolled.
 */
export function killEnemy(ctx: RunContext, enemy: Enemy, origin: number, hitFlags: number): void {
  // The kill's flags: the killing hit's, what the victim held, and what killed it.
  let flags = 0;
  if (ctx.killListeners) {
    flags =
      (hitFlags & HIT_BITS) | heldFlags(enemy, ctx.now) | (1 << (KILL_KIND_SHIFT + enemy.killKind));
    if (ctx.killInline.length !== 0) fireInlineKill(ctx, enemy, origin, flags);
    const onKill = ctx.build.hooks.onKill;
    if (onKill.length !== 0) {
      const kill = ctx.killScratch;
      kill.origin = origin;
      kill.depth = enemy.killDepth;
      kill.x = enemy.x;
      kill.y = enemy.y;
      kill.flags = flags;
      for (const hook of onKill) hook(ctx, enemy, kill);
    }
  }
  removeEnemy(ctx, enemy);
  ctx.kills++;
  const def = enemy.def;
  let shards = mul(mul(num(def.dropMult), enemy.rec.shardsPerStd), ctx.shardGain);
  let expectedCores = def.cores * ctx.coreGain;
  const v3 = enemy.v3;
  if (v3 !== null) {
    shards = mul(shards, v3.dropScale);
    expectedCores *= v3.dropScale;
  }
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
  // The children are ctx.enemies[first ..].
  const first = split(ctx, enemy);
  const ss = ctx.sys.split;
  if (ss.passedCount > 0) splitTransfers(ctx, enemy, first, ss);
  if (ctx.killPending.length !== 0) recordPendingKills(ctx, enemy, origin, flags, shards);
  releaseAilments(ctx, enemy);
}

/**
 * Kill step 2b: for each transfer trigger with a toSplitChildren spread that passed at this kill
 * (ss.passed, fireInlineKill), each such spread gives every child of the victim,
 * ctx.enemies[first ..], its share of the victim's poison, one depth more than the kill, at most
 * MAX_DEPTH. Then the record is cleared, children or not.
 */
function splitTransfers(ctx: RunContext, victim: Enemy, first: number, ss: SplitState): void {
  const end = ctx.enemies.length;
  if (first < end) {
    const { triggers, effects } = ctx.build;
    const depth = Math.min(victim.killDepth + 1, MAX_DEPTH);
    for (let n = 0; n < ss.passedCount; n++) {
      const t = triggers[ss.passed[n] as number] as CompiledTrigger;
      for (let e = t.effectStart; e < t.effectEnd; e++) {
        const f = toSplitOf(effects[e] as CompiledEffect);
        if (f > 0) spreadPoisonToChildren(ctx, victim, first, end, f, depth);
      }
    }
  }
  ss.passedCount = 0;
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
