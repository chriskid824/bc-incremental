/**
 * The shooters' bullets (docs/v3 C7 design §2.6, gd:694): the bullet pool
 * (RunContext.sys.bullets, src/sim/systems/systemState.ts), also SimState.bullets. A shooter at
 * its post fires one straight at the player during the enemy AI step's walk (fireBullet,
 * src/sim/systems/enemyAi.ts), and the step moves every bullet in flight right after its walk
 * (stepBullets), so before movement and contacts: a bullet hits the player before any contact of
 * its tick, and a bullet death ends the run at that tick's checkRunEnd.
 *
 * Each tick a bullet first tests the player, then flies: within PLAYER_RADIUS + BULLET_RADIUS of
 * the player it hits, through damagePlayer as a BULLET (src/sim/systems/contact.ts), which takes
 * the player's shield, life and extra lives as for a contact but outside contactDamageTaken,
 * tallies the hit by its shooter's type and pushes bulletHit; then heroHit is raised at the player
 * (never contact) and the bullet is gone. One that reaches a dead player is gone without a hit,
 * and a revived player takes the bullets after the revive. Otherwise it keeps its position as
 * prevX/prevY and flies its velocity, bulletSpeed × DT straight towards where the player was when
 * it was fired, the player at the arena's centre. So a bullet fired at distance d hits
 * ceil((d − 36) / step) ticks after its fire tick. Bullets test nothing else: no enemy, drone or
 * summon stops one, and a dead shooter's bullets fly on.
 *
 * The pool has no cap and no counter (C7/F15) and drops no bullet: it grows by doubling. Slots
 * 0 .. count − 1 hold the bullets in id order, which the step keeps by moving later ones down.
 * Nothing here draws. A run without shooters, every M1 run, never fires: its pool stays empty.
 */

import { ZERO } from '../../core/num';
import type { EnemyBehaviour, EnemyId } from '../../data/types';
import { ENEMY_IDS } from '../../data/types';
import { fire } from '../effects/dispatch';
import { EVENT } from '../effects/types';
import { DT, PLAYER_RADIUS } from '../types';
import { BULLET, damagePlayer } from './contact';
import type { Enemy, RunContext } from './context';
import { rebuildGrid } from './grid';
import type { BulletPool } from './systemState';

/** A bullet's collision and draw radius: smaller than a shard (10) (初始值, design §1.8). */
export const BULLET_RADIUS = 6;

/** The squared distance from the player within which a bullet hits. */
const REACH_SQ = (PLAYER_RADIUS + BULLET_RADIUS) * (PLAYER_RADIUS + BULLET_RADIUS);

/** The slots of the pool's first arrays. */
const FIRST_SLOTS = 16;

/** Each enemy type's ENEMY_IDS ordinal (BulletPool.ownerType). */
const ORDINAL = Object.fromEntries(ENEMY_IDS.map((id, i) => [id, i])) as Record<EnemyId, number>;

type ShootBehaviour = Extract<EnemyBehaviour, { readonly kind: 'shoot' }>;

/**
 * Shooter `shooter` fires a bullet from where it stands straight at the player, at its
 * behaviour's bulletSpeed, dealing its bulletDamage: a new slot after the others, with the next
 * id. Pushes bulletFired.
 */
export function fireBullet(ctx: RunContext, shooter: Enemy): void {
  const pool = ctx.sys.bullets;
  if (pool.count === pool.id.length) growBullets(pool);
  const behaviour = shooter.def.behaviour as ShootBehaviour;
  const step = behaviour.bulletSpeed * DT;
  const s = pool.count++;
  const bulletId = pool.nextId++;
  const x = shooter.x;
  const y = shooter.y;
  pool.id[s] = bulletId;
  pool.x[s] = x;
  pool.y[s] = y;
  pool.prevX[s] = x;
  pool.prevY[s] = y;
  // Along its bearing from the player, (ux, uy), inwards.
  pool.vx[s] = -shooter.ux * step;
  pool.vy[s] = -shooter.uy * step;
  pool.damage[s] = behaviour.bulletDamage;
  pool.owner[s] = shooter.id;
  pool.ownerType[s] = ORDINAL[shooter.type];
  ctx.state.bulletCount = pool.count;
  ctx.events.push({ type: 'bulletFired', bulletId, enemyId: shooter.id, x, y });
}

/**
 * A tick of every bullet in flight, in id order, those fired this tick included: within reach
 * of the player it hits if the player is alive (damagePlayer, then heroHit) and is gone either
 * way; else it keeps its position as prevX/prevY and flies. Called after the enemy AI step's walk
 * (src/sim/systems/enemyAi.ts), with at least one bullet in flight.
 */
export function stepBullets(ctx: RunContext): void {
  const pool = ctx.sys.bullets;
  const player = ctx.player;
  const px = player.x;
  const py = player.y;
  const { x, y, prevX, prevY, vx, vy } = pool;
  const n = pool.count;
  let kept = 0;
  let gridReady = false;
  for (let s = 0; s < n; s++) {
    const bx = x[s] as number;
    const by = y[s] as number;
    const dx = bx - px;
    const dy = by - py;
    if (dx * dx + dy * dy <= REACH_SQ) {
      if (player.life > 0) {
        const type = ENEMY_IDS[pool.ownerType[s] as number] as EnemyId;
        damagePlayer(
          ctx,
          pool.owner[s] as number,
          type,
          pool.damage[s] as number,
          BULLET,
          pool.id[s] as number,
        );
        // heroHit's selectors query the grid, which last tick's compaction left stale.
        if (!gridReady) {
          rebuildGrid(ctx);
          gridReady = true;
        }
        fire(ctx, EVENT.heroHit, 0, -1, null, px, py, 0, ZERO);
      }
      continue;
    }
    prevX[s] = bx;
    prevY[s] = by;
    x[s] = bx + (vx[s] as number);
    y[s] = by + (vy[s] as number);
    if (kept !== s) moveSlot(pool, s, kept);
    kept++;
  }
  pool.count = kept;
  ctx.state.bulletCount = kept;
}

/** Moves the bullet in slot `from` down to the free slot `to` (to < from). */
function moveSlot(pool: BulletPool, from: number, to: number): void {
  pool.id[to] = pool.id[from] as number;
  pool.x[to] = pool.x[from] as number;
  pool.y[to] = pool.y[from] as number;
  pool.prevX[to] = pool.prevX[from] as number;
  pool.prevY[to] = pool.prevY[from] as number;
  pool.vx[to] = pool.vx[from] as number;
  pool.vy[to] = pool.vy[from] as number;
  pool.damage[to] = pool.damage[from] as number;
  pool.owner[to] = pool.owner[from] as number;
  pool.ownerType[to] = pool.ownerType[from] as number;
}

/**
 * Doubles the pool's slots (FIRST_SLOTS at first), keeping its bullets: every array is replaced
 * by a larger copy, and the pool object, SimState.bullets, stays.
 */
export function growBullets(pool: BulletPool): void {
  const slots = Math.max(FIRST_SLOTS, pool.id.length * 2);
  pool.id = grown(pool.id, new Int32Array(slots));
  pool.x = grown(pool.x, new Float64Array(slots));
  pool.y = grown(pool.y, new Float64Array(slots));
  pool.prevX = grown(pool.prevX, new Float64Array(slots));
  pool.prevY = grown(pool.prevY, new Float64Array(slots));
  pool.vx = grown(pool.vx, new Float64Array(slots));
  pool.vy = grown(pool.vy, new Float64Array(slots));
  pool.damage = grown(pool.damage, new Float64Array(slots));
  pool.owner = grown(pool.owner, new Int32Array(slots));
  pool.ownerType = grown(pool.ownerType, new Uint8Array(slots));
}

/** `to`, holding `from`'s entries from its start. */
function grown<T extends Int32Array | Float64Array | Uint8Array>(from: T, to: T): T {
  to.set(from);
  return to;
}
