/**
 * Spawn system (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2.1): releases each
 * open wave's queued enemies over spawnDurationSec, and adds split children when a splitting
 * enemy dies. A v3 run holds at most its enemy cap alive (docs/v3 C7 design §2.3): wave enemies
 * past it wait, oldest wave first, and enemy-made spawns past it are skipped; an M1 run's cap is
 * Infinity.
 */

import type { Num } from '../../core/num';
import { mul, num, ZERO } from '../../core/num';
import { AFFIX_BERSERK, AFFIX_FROST, AFFIX_GUARDIAN, AFFIX_REGEN } from '../../data/affixes';
import type { EnemyDef, V3WaveRules } from '../../data/types';
import { RING_SLOTS } from '../ailments/rings';
import { MAX_DEPTH } from '../effects/types';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, PLAYER_RADIUS } from '../types';
import type { Enemy, RunContext, WaveRecord } from './context';
import { affixCount, AI_NONE, createEnemyV3, pickAffixes } from './enemyRecord';
import type { EnemyV3, SpawnOrigin } from './enemyRecord';

const TAU = Math.PI * 2;
const HALF_WIDTH = ARENA_WIDTH / 2;
const HALF_HEIGHT = ARENA_HEIGHT / 2;

/** How many of `rec`'s queue are due by `now`: spread evenly over spawnTicks, the first at once. */
function dueOf(rec: WaveRecord, now: number, spawnTicks: number): number {
  const total = rec.queue.length;
  return spawnTicks > 0
    ? Math.min(total, Math.floor(((now - rec.startTick) * total) / spawnTicks) + 1)
    : total;
}

/**
 * The enemies alive in the run: each open wave's `alive`, which addEnemy raises and removeEnemy
 * lowers, so it is exact at any point of a tick (an open record holds every live enemy's wave).
 */
export function aliveCount(ctx: RunContext): number {
  const open = ctx.open;
  let alive = 0;
  for (let w = 0; w < open.length; w++) alive += (open[w] as WaveRecord).alive;
  return alive;
}

/**
 * Releases each open wave's queue evenly over spawnDurationSec, the first enemy at once, while
 * the run's enemy cap has room: the room is the cap less the enemies alive, taken once a tick, so
 * the oldest wave's due enemies go first, in queue order. Where the room runs out, the due
 * enemies of that wave and of every later one wait for a later tick and draw their spawn angle
 * when they are released (docs/v3 C7 design §2.3).
 */
export function releaseEnemies(ctx: RunContext): void {
  const open = ctx.open;
  const now = ctx.now;
  const spawnTicks = ctx.spawnTicks;
  const cap = ctx.sys.enemyAi.cap;
  // An M1 run has no cap: its room never runs out.
  let room = cap === Infinity ? Infinity : cap - aliveCount(ctx);
  for (let w = 0; w < open.length; w++) {
    const rec = open[w] as WaveRecord;
    if (rec.released >= rec.queue.length) continue;
    const due = dueOf(rec, now, spawnTicks);
    while (rec.released < due) {
      if (room <= 0) {
        delayFrom(ctx, w, now, spawnTicks);
        return;
      }
      room--;
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
 * The cap holds back the due enemies of open wave `from` and of every later one: each counts once
 * in enemyCapDelayed, at the first tick it waits, however long it waits (`delayed` is where the
 * counted ones end).
 */
function delayFrom(ctx: RunContext, from: number, now: number, spawnTicks: number): void {
  const open = ctx.open;
  let delayed = 0;
  for (let w = from; w < open.length; w++) {
    const rec = open[w] as WaveRecord;
    if (rec.released >= rec.queue.length) continue;
    const due = dueOf(rec, now, spawnTicks);
    delayed += due - Math.max(rec.released, rec.delayed);
    rec.delayed = due;
  }
  ctx.counters.enemyCapDelayed += delayed;
}

/**
 * Adds an enemy of `def` to wave `rec`, `dist` from the player along (ux, uy). Its def's flags
 * make it tough or a boss. In a v3 run (ctx.sys.enemyAi.enabled) it carries a record
 * (src/sim/systems/enemyRecord.ts) and takes `origin`'s hp and radius scales, and a layered def
 * one layer's share of its hp (the onion, src/sim/systems/onion.ts); an M1 run's enemies take
 * their def's and have none. A v3 enemy with a behaviour or regeneration joins the enemy AI
 * step's list (src/sim/systems/enemyAi.ts) last, which keeps the list in id order.
 *
 * An elite (tough, not a boss: the hexagon in v3 data) draws its affixes here, unless its
 * `origin` gives them (a 增殖 child inherits its parent's, src/sim/systems/affixes.ts): their
 * count follows the wave the record belongs to (affixCount), so an elite the enemy cap released
 * late draws its own wave's count, and the picks are the only draw on the `affixes` stream, in
 * release order (C7/F8, C7/F21). The record holds every at-spawn effect but the three lists the
 * per-tick rules walk, which the spawn joins last, after the enemy is in ctx.enemies, so all
 * three stay in id order. 狂暴 or 再生 joins the AI step's list, each enemy at most once.
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
  let stepDist = def.speed * DT;
  let v3: EnemyV3 | null = null;
  if (ctx.sys.enemyAi.enabled) {
    // A layered def (洋蔥) holds one shell's share of its hpMult, the total over its layers
    // (C7.7); x / 1 is x, so every other def keeps its hp bit for bit.
    const behaviour = def.behaviour;
    const layers = behaviour?.kind === 'layers' ? behaviour.layers : 1;
    hp = mul(num((def.hpMult * (origin?.hpScale ?? 1)) / layers), rec.stdHp);
    radius = def.radius * (origin?.radiusScale ?? 1);
    // Given bits (0 included) are taken as they are, whatever the def; −1, or no origin, draws
    // for an elite and leaves every other type without affixes.
    const given = origin?.affixes ?? -1;
    const affixes =
      given >= 0
        ? given
        : def.tough && !def.boss
          ? pickAffixes(
              ctx.sys.affixes.rng,
              affixCount(rec.wave, (ctx.data.waves.v3 as V3WaveRules).affixes),
            )
          : 0;
    v3 = createEnemyV3(
      def,
      origin,
      ctx.sys.enemyAi.toughDropMult,
      affixes,
      hp,
      (affixes & AFFIX_REGEN) !== 0 ? regenRateOf(ctx) : 0,
    );
    stepDist = v3.baseStep;
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
    stepDist,
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
  if (v3 !== null) {
    const affixes = v3.affixes;
    if (v3.ai !== AI_NONE || v3.regen > 0 || (affixes & AFFIX_BERSERK) !== 0) {
      ctx.sys.enemyAi.list.push(enemy);
    }
    if (affixes !== 0) {
      const sys = ctx.sys.affixes;
      if ((affixes & AFFIX_GUARDIAN) !== 0) sys.guardians.push(enemy);
      if ((affixes & AFFIX_FROST) !== 0) sys.frostElites.push(enemy);
    }
  }
}

/**
 * The life fraction a second 再生 regains: the run data's regenerator rate (gd:709 「和再生者
 * 一樣」), 0 for data whose regenerator has no regen behaviour. Read once per elite that draws
 * the affix.
 */
function regenRateOf(ctx: RunContext): number {
  const behaviour = ctx.data.enemies.regenerator.behaviour;
  return behaviour?.kind === 'regen' ? behaviour.lifePctPerSec : 0;
}

/**
 * Adds an enemy-made spawn (a split child) of `def` as addEnemy does, unless the run's enemy cap
 * is reached: then it adds nothing, counts it in enemySpawnsSkipped and returns false. Its caller
 * has drawn the spawn's angle already, so no stream's position depends on how full the field is
 * (docs/v3 C7 design §2.3; the lead's ruling L4).
 */
export function spawnOrSkip(
  ctx: RunContext,
  def: EnemyDef,
  rec: WaveRecord,
  ux: number,
  uy: number,
  dist: number,
  origin?: SpawnOrigin,
): boolean {
  if (aliveCount(ctx) >= ctx.sys.enemyAi.cap) {
    ctx.counters.enemySpawnsSkipped++;
    return false;
  }
  addEnemy(ctx, def, rec, ux, uy, dist, origin);
  return true;
}

/**
 * Children appear around the parent and belong to its wave. Their angles come from their
 * own stream: kills depend on combat, and must not shift later waves' spawns. In a v3 run each
 * child draws its angle, then goes through spawnOrSkip, so a child past the enemy cap is skipped.
 * Returns where the children start in ctx.enemies: they are `ctx.enemies[start ..]` right after
 * the call, an empty range for an enemy that does not split or whose children were all skipped
 * (kill step 2, src/sim/systems/death.ts).
 */
export function split(ctx: RunContext, parent: Enemy): number {
  const start = ctx.enemies.length;
  const splitInto = parent.def.splitInto;
  if (splitInto === undefined) return start;
  const def = ctx.data.enemies[splitInto.enemy];
  const player = ctx.player;
  if (ctx.sys.enemyAi.cap === Infinity) {
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
  for (let i = 0; i < splitInto.count; i++) {
    const angle = ctx.splitRng.range(0, TAU);
    const dx = parent.x + Math.cos(angle) * parent.radius - player.x;
    const dy = parent.y + Math.sin(angle) * parent.radius - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0) spawnOrSkip(ctx, def, parent.rec, dx / dist, dy / dist, dist);
    else spawnOrSkip(ctx, def, parent.rec, 1, 0, 0);
  }
  return start;
}
