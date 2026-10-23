/**
 * Spawn system (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2.1): releases each
 * open wave's queued enemies over spawnDurationSec, and adds split children when a splitting
 * enemy dies.
 */

import type { Num } from '../../core/num';
import { mul, num, ZERO } from '../../core/num';
import type { EnemyDef } from '../../data/types';
import { RING_SLOTS } from '../ailments/rings';
import { MAX_DEPTH } from '../effects/types';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, PLAYER_RADIUS } from '../types';
import type { Enemy, RunContext, WaveRecord } from './context';
import { createEnemyV3 } from './enemyRecord';
import type { EnemyV3, SpawnOrigin } from './enemyRecord';

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

/**
 * Adds an enemy of `def` to wave `rec`, `dist` from the player along (ux, uy). Its def's flags
 * make it tough or a boss. In a v3 run (ctx.sys.enemyAi.enabled) it carries a record
 * (src/sim/systems/enemyRecord.ts) and takes `origin`'s hp and radius scales; an M1 run's
 * enemies take their def's and have none.
 */
export function addEnemy(
  ctx: RunContext,
  def: EnemyDef,
  rec: WaveRecord,
  ux: number,
  uy: number,
  dist: number,
  origin?: SpawnOrigin,
): void {
  const player = ctx.player;
  const x = player.x + ux * dist;
  const y = player.y + uy * dist;
  let hp: Num;
  let radius = def.radius;
  let v3: EnemyV3 | null = null;
  if (ctx.sys.enemyAi.enabled) {
    hp = mul(num(def.hpMult * (origin?.hpScale ?? 1)), rec.stdHp);
    radius = def.radius * (origin?.radiusScale ?? 1);
    v3 = createEnemyV3(def, origin);
  } else hp = mul(num(def.hpMult), rec.stdHp);
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
    radius,
    burnStacks: 0,
    alive: true,
    def,
    rec,
    ux,
    uy,
    dist,
    stepDist: def.speed * DT,
    contactDist: PLAYER_RADIUS + radius,
    burns: [],
    burnPending: ZERO,
    burnPendC: ZERO,
    burnPendO: ZERO,
    burnPendF: ZERO,
    burnFusionCredit: -1,
    burnNextEnd: Infinity,
    burnSteppedAt: -1,
    rings: new Int32Array(RING_SLOTS).fill(-1),
    dotRings: 0,
    poisonStacks: 0,
    burnRingEnd: 0,
    poisonRingEnd: 0,
    bleedDps: ZERO,
    bleedStart: 0,
    bleedUntil: 0,
    bleedSource: 0,
    bleedPending: ZERO,
    bleedMovedTicks: 0,
    shockStacks: 0,
    shockUntil: 0,
    frost: 0,
    frozenUntil: 0,
    frostLockUntil: 0,
    frostApplier: 0,
    zoneSlow: 0,
    zoneSlowUntil: 0,
    zoneSource: -1,
    zoneUntil: 0,
    hitMark: 0,
    segMark: 0,
    inbound: 0,
    volleyMark: 0,
    tough: def.tough,
    boss: def.boss,
    ailDepth: MAX_DEPTH,
    killDepth: 0,
    killKind: 0,
    v3,
  };
  ctx.enemies.push(enemy);
  rec.alive++;
  ctx.events.push({ type: 'enemySpawned', enemyId: enemy.id, enemy: def.id });
}

/**
 * Children appear around the parent and belong to its wave. Their angles come from their
 * own stream: kills depend on combat, and must not shift later waves' spawns. Returns where the
 * children start in ctx.enemies: they are `ctx.enemies[start ..]` right after the call, an empty
 * range for an enemy that does not split (kill step 2, src/sim/systems/death.ts).
 */
export function split(ctx: RunContext, parent: Enemy): number {
  const start = ctx.enemies.length;
  const splitInto = parent.def.splitInto;
  if (splitInto === undefined) return start;
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
  return start;
}
