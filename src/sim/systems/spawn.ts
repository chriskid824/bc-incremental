/**
 * Spawn system (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2.1): releases each
 * open wave's queued enemies over spawnDurationSec, and adds split children when a splitting
 * enemy dies.
 */

import { mul, num, ZERO } from '../../core/num';
import type { EnemyDef } from '../../data/types';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, PLAYER_RADIUS } from '../types';
import type { Enemy, RunContext, WaveRecord } from './context';

const TAU = Math.PI * 2;
const HALF_WIDTH = ARENA_WIDTH / 2;
const HALF_HEIGHT = ARENA_HEIGHT / 2;

/** Releases each open wave's queue evenly over spawnDurationSec, the first enemy at once. */
export function releaseEnemies(ctx: RunContext): void {
  const open = ctx.open;
  const now = ctx.now;
  const spawnTicks = ctx.spawnTicks;
  for (let w = 0; w < open.length; w++) {
    const rec = open[w] as WaveRecord;
    const total = rec.queue.length;
    if (rec.released >= total) continue;
    const elapsed = now - rec.startTick;
    const due =
      spawnTicks > 0 ? Math.min(total, Math.floor((elapsed * total) / spawnTicks) + 1) : total;
    while (rec.released < due) {
      const def = rec.queue[rec.released] as EnemyDef;
      rec.released++;
      // Random direction from the center, placed just outside the arena rectangle.
      const angle = ctx.spawnRng.range(0, TAU);
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const dist = Math.min(
        (HALF_WIDTH + def.radius) / Math.abs(ux),
        (HALF_HEIGHT + def.radius) / Math.abs(uy),
      );
      addEnemy(ctx, def, rec, ux, uy, dist);
    }
  }
}

export function addEnemy(
  ctx: RunContext,
  def: EnemyDef,
  rec: WaveRecord,
  ux: number,
  uy: number,
  dist: number,
): void {
  const player = ctx.player;
  const x = player.x + ux * dist;
  const y = player.y + uy * dist;
  const hp = mul(num(def.hpMult), rec.stdHp);
  const enemy: Enemy = {
    id: ctx.nextEnemyId++,
    type: def.id,
    wave: rec.wave,
    x,
    y,
    prevX: x,
    prevY: y,
    hp,
    maxHp: hp,
    radius: def.radius,
    burnStacks: 0,
    alive: true,
    def,
    rec,
    ux,
    uy,
    dist,
    stepDist: def.speed * DT,
    contactDist: PLAYER_RADIUS + def.radius,
    burns: [],
    burnPending: ZERO,
    burnNextEnd: Infinity,
    hitMark: 0,
    inbound: 0,
    volleyMark: 0,
    tough: def.id === 'hexagon' || def.id === 'boss',
  };
  ctx.enemies.push(enemy);
  rec.alive++;
  ctx.events.push({ type: 'enemySpawned', enemyId: enemy.id, enemy: def.id });
}

/**
 * Children appear around the parent and belong to its wave. Their angles come from their
 * own stream: kills depend on combat, and must not shift later waves' spawns.
 */
export function split(ctx: RunContext, parent: Enemy): void {
  const splitInto = parent.def.splitInto;
  if (splitInto === undefined) return;
  const def = ctx.data.enemies[splitInto.enemy];
  const player = ctx.player;
  for (let i = 0; i < splitInto.count; i++) {
    const angle = ctx.splitRng.range(0, TAU);
    const dx = parent.x + Math.cos(angle) * parent.radius - player.x;
    const dy = parent.y + Math.sin(angle) * parent.radius - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0) addEnemy(ctx, def, parent.rec, dx / dist, dy / dist, dist);
    else addEnemy(ctx, def, parent.rec, 1, 0, 0);
  }
}
