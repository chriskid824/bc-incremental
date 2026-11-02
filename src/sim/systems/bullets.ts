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
 * tallies the hit by its shooter's type and pushes bulletHit; then the combo stacks halve when the
 * build keeps them (src/sim/systems/combo.ts), heroHit is raised at the player (never contact)
 * and the bullet is gone. One that reaches a dead player is gone without a hit,
 * and a revived player takes the bullets after the revive. Otherwise it keeps its position as
 * prevX/prevY and flies its velocity, bulletSpeed × DT straight towards where the player was when
 * it was fired, the player at the arena's centre. So a bullet fired at distance d hits
 * ceil((d − 36) / step) ticks after its fire tick. Bullets test nothing else: no enemy, drone or
 * summon stops one (攔截軌道's orbs do, below), and a dead shooter's bullets fly on.
 *
 * The pool has no cap and no counter (C7/F15) and drops no bullet: it grows by doubling. Slots
 * 0 .. count − 1 hold the bullets in id order, which the step keeps by moving later ones down.
 * Nothing here draws but 反射's arrival hit, which rolls on the thorns payload's stream as a
 * contact's thorns hit does. A run without shooters, every M1 run, never fires: its pool stays
 * empty.
 *
 * C7b's three bullet hooks (docs/v3 C7 design §2.10) act in the same loop, read once a step:
 * - 攔截軌道 (orbitBlocksBullets; BulletPool.blockers): a bullet that has not reached the player
 *   but touches an orb of an orbit emitter, at the orb's place of this tick, the one runOrbit
 *   (src/sim/emitters/orbit.ts) gives it later in the tick, is gone with bulletBlocked; it touches
 *   one within the orb's radius plus BULLET_RADIUS, as an orb touches an enemy within the two
 *   radii.
 * - At the player, in this order: 反射 (reflectBullets; BulletPool.reflect) turns the bullet back,
 *   dealing nothing; else 節奏閃避 (PlayerDefence.dodgeCombo) dodges it when the combo stacks are
 *   at least bulletDodgeCombo and its cooldown is over, which starts it again: the bullet is gone
 *   with bulletDodged, dealing nothing; else it hits.
 * - A reflected bullet (BulletPool.reflected) tests neither the player nor the orbs: each tick it
 *   aims at its shooter's present place, at its own speed, and once the shooter is within a step
 *   of it, it is gone and the shooter, if alive, takes a hit of the build's first thorns payload,
 *   as a thorns hit at contact (none without a thorns emitter). It is gone without an event once
 *   its shooter is dead or has left ctx.enemies, found by id (enemyOf).
 */

import { ZERO } from '../../core/num';
import type { EnemyBehaviour, EnemyId } from '../../data/types';
import { ENEMY_IDS } from '../../data/types';
import { hitWithPayload } from '../combat/hit';
import { fire } from '../effects/dispatch';
import { EVENT } from '../effects/types';
import type { EmitterRuntime, OrbitSpec, OrbMemory } from '../emitters/types';
import { DT, PLAYER_RADIUS, TICK_RATE } from '../types';
import { loseComboOnHit } from './combo';
import { BULLET, damagePlayer } from './contact';
import type { Enemy, RunContext } from './context';
import { rebuildGrid } from './grid';
import type { BulletPool, PlayerDefence } from './systemState';

/** A bullet's collision and draw radius: smaller than a shard (10) (初始值, design §1.8). */
export const BULLET_RADIUS = 6;

/** The squared distance from the player within which a bullet hits. */
const REACH_SQ = (PLAYER_RADIUS + BULLET_RADIUS) * (PLAYER_RADIUS + BULLET_RADIUS);

/** The slots of the pool's first arrays. */
const FIRST_SLOTS = 16;

/** Each enemy type's ENEMY_IDS ordinal (BulletPool.ownerType). */
const ORDINAL = Object.fromEntries(ENEMY_IDS.map((id, i) => [id, i])) as Record<EnemyId, number>;

const TWO_PI = 2 * Math.PI;

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
  pool.reflected[s] = 0;
  ctx.state.bulletCount = pool.count;
  ctx.events.push({ type: 'bulletFired', bulletId, enemyId: shooter.id, x, y });
}

/**
 * A tick of every bullet in flight, in id order, those fired this tick included: within reach
 * of the player it hits if the player is alive (damagePlayer, then heroHit) and is gone either
 * way; else it keeps its position as prevX/prevY and flies. Called after the enemy AI step's walk
 * (src/sim/systems/enemyAi.ts), with at least one bullet in flight. C7b's hooks (the module's
 * doc) are read once, before the loop.
 */
export function stepBullets(ctx: RunContext): void {
  const pool = ctx.sys.bullets;
  const player = ctx.player;
  const px = player.x;
  const py = player.y;
  const { x, y, prevX, prevY, vx, vy, reflected } = pool;
  const n = pool.count;
  const now = ctx.now;
  const reflect = pool.reflect;
  const blockers = pool.blockers;
  const defence = ctx.sys.defence;
  // Infinity, which no stack count reaches, while the dodge is off.
  const dodgeCombo = defence === null ? Infinity : defence.dodgeCombo;
  let kept = 0;
  let gridReady = false;
  for (let s = 0; s < n; s++) {
    const bx = x[s] as number;
    const by = y[s] as number;
    if (reflected[s] === 0) {
      const dx = bx - px;
      const dy = by - py;
      if (dx * dx + dy * dy <= REACH_SQ) {
        if (player.life <= 0) continue;
        if (reflect) {
          // 反射: it flies back from here, this tick (below).
          reflected[s] = 1;
        } else if (
          ctx.sys.combo.stacks >= dodgeCombo &&
          now >= (defence as PlayerDefence).dodgeReadyAt
        ) {
          const dodge = defence as PlayerDefence;
          dodge.dodgeReadyAt = now + dodge.dodgeTicks;
          ctx.events.push({
            type: 'bulletDodged',
            bulletId: pool.id[s] as number,
            enemyId: pool.owner[s] as number,
            enemy: ENEMY_IDS[pool.ownerType[s] as number] as EnemyId,
          });
          continue;
        } else {
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
          if (ctx.build.flags.combo) loseComboOnHit(ctx);
          fire(ctx, EVENT.heroHit, 0, -1, null, px, py, 0, ZERO);
          continue;
        }
      } else if (blockers.length !== 0 && onOrb(blockers, bx, by, px, py, now)) {
        ctx.events.push({
          type: 'bulletBlocked',
          bulletId: pool.id[s] as number,
          enemyId: pool.owner[s] as number,
          enemy: ENEMY_IDS[pool.ownerType[s] as number] as EnemyId,
        });
        continue;
      }
    }
    if (reflected[s] !== 0) {
      // 反射's flight home, by the shooter's id: a slot's shooter may be compacted away.
      const shooter = enemyOf(ctx.enemies, pool.owner[s] as number);
      if (shooter === null || !shooter.alive) continue;
      const tx = shooter.x - bx;
      const ty = shooter.y - by;
      const d = Math.sqrt(tx * tx + ty * ty);
      const ux = vx[s] as number;
      const uy = vy[s] as number;
      const step = Math.sqrt(ux * ux + uy * uy);
      if (d <= step) {
        const thorns = ctx.thornsEmitters;
        if (thorns.length !== 0) {
          // Its hit's triggers query the grid, which last tick's compaction left stale.
          if (!gridReady) {
            rebuildGrid(ctx);
            gridReady = true;
          }
          const p = (thorns[0] as EmitterRuntime).payload;
          hitWithPayload(ctx, shooter, p, 0, 1, null, null, false, 0, -1);
        }
        continue;
      }
      vx[s] = (tx / d) * step;
      vy[s] = (ty / d) * step;
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

/**
 * 攔截軌道: a bullet at (bx, by) touches an orb of one of the orbit emitters `blockers` on tick
 * `now`, around the player at (px, py): within the orb's radius plus BULLET_RADIUS of it, at the
 * place runOrbit (src/sim/emitters/orbit.ts) turns it to on that tick, orb o of n at the angle
 * 2π × revPerSec × now / TICK_RATE + 2π × o / n on its ring, worked out the same way.
 */
function onOrb(
  blockers: readonly EmitterRuntime[],
  bx: number,
  by: number,
  px: number,
  py: number,
  now: number,
): boolean {
  for (let e = 0; e < blockers.length; e++) {
    const em = blockers[e] as EmitterRuntime;
    const n = (em.orbs as OrbMemory).n;
    const spec = em.spec as OrbitSpec;
    const base = (TWO_PI * spec.revPerSec * now) / TICK_RATE;
    const ring = spec.radius;
    const r = spec.orbRadius + BULLET_RADIUS;
    const rSq = r * r;
    for (let o = 0; o < n; o++) {
      const a = base + (TWO_PI * o) / n;
      const dx = bx - (px + ring * Math.cos(a));
      const dy = by - (py + ring * Math.sin(a));
      if (dx * dx + dy * dy <= rSq) return true;
    }
  }
  return false;
}

/**
 * The enemy of id `id` in `enemies` (ctx.enemies, in id order, the dead of this tick included),
 * or null once compaction has dropped it: a binary search, O(log n) a call.
 */
function enemyOf(enemies: readonly Enemy[], id: number): Enemy | null {
  let lo = 0;
  let hi = enemies.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const enemy = enemies[mid] as Enemy;
    if (enemy.id === id) return enemy;
    if (enemy.id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
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
  pool.reflected[to] = pool.reflected[from] as number;
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
  pool.reflected = grown(pool.reflected, new Uint8Array(slots));
}

/** `to`, holding `from`'s entries from its start. */
function grown<T extends Int32Array | Float64Array | Uint8Array>(from: T, to: T): T {
  to.set(from);
  return to;
}
