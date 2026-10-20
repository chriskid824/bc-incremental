/**
 * Shot pool (docs/v3/implementation-plan-v3.md §2.10, §2.15, §6): every projectile but the
 * volley's homing ones (RunContext.projectiles), in typed arrays allocated once per run. A shot
 * moves in one of three ways:
 * - straight: at a fixed velocity, hitting each enemy its swept path touches, in the order it
 *   reaches them, until its pierce is spent. It passes through the last SHOT_MEMORY enemies it
 *   hit without hitting them again. Leaving the arena it bounces back while it has bounces
 *   left, else it ends.
 * - homing: at projectileSpeed towards its target, which it hits on arrival; when the target
 *   dies first it turns to the alive enemy nearest to it, or fizzles when there is none.
 * - lobbed: to a fixed point, where it arrives at its `until` tick; a lob's bomb lands there
 *   (src/sim/emitters/lob.ts).
 * Straight and homing shots expire at their `until` tick.
 *
 * Slots 0 .. count − 1 hold the shots in flight, in id order. Their ids come from the volley's
 * projectile counter, so the projectile stage steps both lists in one id order
 * (src/sim/systems/projectiles.ts). A shot that ends keeps its slot until the end of that stage,
 * which compacts the pool in order; nothing spawns during it. A shot's hits are not an attack:
 * they carry no chain, no attack serial and no PRIMARY, but for three. A bomb's landing is one,
 * which lob.ts runs; so is a fan's round: the first hit of its cones is the round's primary hit,
 * which begins the attack and runs its chain, and its other cone hits are plain hits
 * (src/sim/emitters/fan.ts); and so is the arrival of a signature emitter's homing shot, a
 * turret's (src/sim/systems/drones.ts): its hit is the attack's primary hit and its chain
 * follows, as at a volley projectile's arrival (chainAttack, src/sim/combat/chain.ts). The
 * volley's projectiles and the pool share PROJECTILE_CAP (src/sim/caps.ts).
 */

import { PROJECTILE_CAP, SHOT_MEMORY } from '../caps';
import { beginAttack, chainAttack, chainFrom, endAttack, primaryHit } from '../combat/chain';
import { hitWithPayload } from '../combat/hit';
import { land } from '../emitters/lob';
import { SIGNATURE } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { ShotPoolState } from '../types';
import type { Enemy, RunContext } from './context';

/** ShotPool.motion values. */
export const MOTION_STRAIGHT = 0;
export const MOTION_HOMING = 1;
export const MOTION_LOB = 2;

/**
 * Fan rounds ShotPool.roundTaken tells apart: a cone's round takes slot round & ROUND_MASK, whose
 * serial says whether that round's primary hit is taken. A power of 2, far above the rounds in
 * flight at once.
 */
const ROUND_SLOTS = 256;
const ROUND_MASK = ROUND_SLOTS - 1;

/** The shot pool of a run (RunContext.shots), also SimState.shots. */
export interface ShotPool extends ShotPoolState {
  /** Shots in flight: slots 0 .. count − 1, in id order. */
  count: number;
  /** Straight shots among them. */
  straight: number;
  /** Hit radius; 0 for a point. */
  readonly radius: Float64Array;
  /** Multiplier of its hits. */
  readonly scale: Float64Array;
  /** Hits left; −1 for no limit. */
  readonly pierce: Int32Array;
  /** Edge bounces left. */
  readonly bounce: Int16Array;
  /** Enemies it has hit. */
  readonly pierced: Int16Array;
  /** Trigger depth and origin of its hits: 0 and −1 for an emitter's shots. */
  readonly depth: Uint8Array;
  readonly origin: Int32Array;
  /** 1: every hit of it crits (steadyAim). */
  readonly steady: Uint8Array;
  /** Serial of the fan round a cone belongs to; −1 for none. */
  readonly round: Int32Array;
  /** Index of the emitter that fired it; −1 for an effect's. */
  readonly owner: Int16Array;
  /**
   * The ids of the last SHOT_MEMORY enemies each shot hit (0: none), a block of the slab per
   * slot: memBase[slot] is where the slot's block starts, memHead[slot] the entry the next hit
   * overwrites. Compaction moves a block's start with its shot, not the block.
   */
  readonly memory: Int32Array;
  readonly memHead: Uint8Array;
  readonly memBase: Int32Array;
  /** Its payload; null marks a shot that has ended, until the pool compacts. */
  readonly payload: (Payload | null)[];
  /** A homing shot's target; null for the others. */
  readonly target: (Enemy | null)[];
  /**
   * Scratch of a projectiles effect with aim 'distinct' (src/sim/effects/execute.ts): the
   * enemies it fires at, nearest first. Only its spawn loop reads it.
   */
  readonly distinct: Enemy[];
  /** Serial of the last fan round fired (fireRound, src/sim/emitters/fan.ts); 0 before any. */
  roundSerial: number;
  /**
   * The fan rounds whose primary hit is taken: slot round & ROUND_MASK holds the serial of the
   * last round of that slot whose cones hit, so a round whose slot holds another serial has its
   * primary hit still to come.
   */
  readonly roundTaken: Int32Array;
}

/**
 * The enemies one straight shot's step hits (RunContext.shotHits): enemies[0 .. n) with their
 * path parameters t[0 .. n), in hit order. `t` grows with RunContext.candidates.
 */
export interface ShotHits {
  t: Float64Array;
  readonly enemies: Enemy[];
}

/** An empty pool with room for PROJECTILE_CAP shots. */
export function createShotPool(): ShotPool {
  const n = PROJECTILE_CAP;
  const memBase = new Int32Array(n);
  for (let s = 0; s < n; s++) memBase[s] = s * SHOT_MEMORY;
  return {
    count: 0,
    straight: 0,
    id: new Int32Array(n),
    motion: new Uint8Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    until: new Int32Array(n),
    form: new Uint8Array(n),
    radius: new Float64Array(n),
    scale: new Float64Array(n),
    pierce: new Int32Array(n),
    bounce: new Int16Array(n),
    pierced: new Int16Array(n),
    depth: new Uint8Array(n),
    origin: new Int32Array(n),
    steady: new Uint8Array(n),
    round: new Int32Array(n),
    owner: new Int16Array(n),
    memory: new Int32Array(n * SHOT_MEMORY),
    memHead: new Uint8Array(n),
    memBase,
    payload: new Array<Payload | null>(n).fill(null),
    target: new Array<Enemy | null>(n).fill(null),
    distinct: [],
    roundSerial: 0,
    roundTaken: new Int32Array(ROUND_SLOTS),
  };
}

/** Projectiles in flight against PROJECTILE_CAP: the volley's and the pool's. */
export function liveProjectiles(ctx: RunContext): number {
  return ctx.projectiles.length + ctx.shots.count;
}

/**
 * Adds a shot of `motion` at (x, y) with velocity (vx, vy) per tick (a lobbed shot: its landing
 * point and its launch point), ending or landing at tick `until`; its hits deal payload `p` at
 * `scale`, `pierce` of them at most (−1: no limit), and it bounces off the arena's edge
 * `bounce` times. `depth`, `origin` and `steady` are its hits'; `round` the fan round of a cone
 * (−1: none), `owner` its emitter's index (−1: an effect's), `target` a homing shot's first
 * target. Its radius and form start at 0. Returns its slot, or −1 when PROJECTILE_CAP
 * projectiles are in flight, which refuses the shot and counts it in projectilesCapped.
 */
export function spawnShot(
  ctx: RunContext,
  motion: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  until: number,
  p: Payload,
  scale: number,
  pierce: number,
  bounce: number,
  depth: number,
  origin: number,
  steady: boolean,
  round: number,
  owner: number,
  target: Enemy | null,
): number {
  if (liveProjectiles(ctx) >= PROJECTILE_CAP) {
    ctx.counters.projectilesCapped++;
    return -1;
  }
  const shots = ctx.shots;
  const s = shots.count++;
  shots.id[s] = ctx.nextProjectileId++;
  shots.motion[s] = motion;
  shots.x[s] = x;
  shots.y[s] = y;
  shots.vx[s] = vx;
  shots.vy[s] = vy;
  shots.until[s] = until;
  shots.form[s] = 0;
  shots.radius[s] = 0;
  shots.scale[s] = scale;
  shots.pierce[s] = pierce;
  shots.bounce[s] = bounce;
  shots.pierced[s] = 0;
  shots.depth[s] = depth;
  shots.origin[s] = origin;
  shots.steady[s] = steady ? 1 : 0;
  shots.round[s] = round;
  shots.owner[s] = owner;
  const base = shots.memBase[s] as number;
  shots.memory.fill(0, base, base + SHOT_MEMORY);
  shots.memHead[s] = 0;
  shots.payload[s] = p;
  shots.target[s] = target;
  if (motion === MOTION_STRAIGHT) shots.straight++;
  ctx.state.shotCount = shots.count;
  return s;
}

/** One tick of the shot in slot `s` (the projectile stage, in id order). */
export function stepShot(ctx: RunContext, s: number): void {
  const shots = ctx.shots;
  const motion = shots.motion[s];
  if (motion === MOTION_STRAIGHT) stepStraight(ctx, s);
  else if (motion === MOTION_HOMING) stepHoming(ctx, s);
  else if (ctx.now >= (shots.until[s] as number)) {
    // A lobbed shot does nothing in flight and ends where it arrives, where a lob's bomb lands.
    const owner = shots.owner[s] as number;
    const spec = owner >= 0 ? (ctx.emitters[owner] as EmitterRuntime).spec : null;
    if (spec !== null && spec.kind === 'lob') land(ctx, s, spec);
    endShot(shots, s);
  }
}

/** Drops the shots that ended, keeping the others in order; at the end of the stage. */
export function compactShots(ctx: RunContext): void {
  const shots = ctx.shots;
  const payload = shots.payload;
  const n = shots.count;
  let kept = 0;
  for (let s = 0; s < n; s++) {
    if (payload[s] === null) continue;
    if (kept !== s) moveSlot(shots, s, kept);
    kept++;
  }
  shots.count = kept;
  ctx.state.shotCount = kept;
}

/** Ends the shot in slot `s`; its slot is freed when the pool compacts. */
function endShot(shots: ShotPool, s: number): void {
  if (shots.motion[s] === MOTION_STRAIGHT) shots.straight--;
  shots.payload[s] = null;
  shots.target[s] = null;
}

/**
 * Moves the shot in slot `from` to the free slot `to` (to < from). Their memory blocks swap,
 * so every slot keeps a block of its own.
 */
function moveSlot(shots: ShotPool, from: number, to: number): void {
  shots.id[to] = shots.id[from] as number;
  shots.motion[to] = shots.motion[from] as number;
  shots.x[to] = shots.x[from] as number;
  shots.y[to] = shots.y[from] as number;
  shots.vx[to] = shots.vx[from] as number;
  shots.vy[to] = shots.vy[from] as number;
  shots.until[to] = shots.until[from] as number;
  shots.form[to] = shots.form[from] as number;
  shots.radius[to] = shots.radius[from] as number;
  shots.scale[to] = shots.scale[from] as number;
  shots.pierce[to] = shots.pierce[from] as number;
  shots.bounce[to] = shots.bounce[from] as number;
  shots.pierced[to] = shots.pierced[from] as number;
  shots.depth[to] = shots.depth[from] as number;
  shots.origin[to] = shots.origin[from] as number;
  shots.steady[to] = shots.steady[from] as number;
  shots.round[to] = shots.round[from] as number;
  shots.owner[to] = shots.owner[from] as number;
  shots.memHead[to] = shots.memHead[from] as number;
  const base = shots.memBase[to] as number;
  shots.memBase[to] = shots.memBase[from] as number;
  shots.memBase[from] = base;
  shots.payload[to] = shots.payload[from] as Payload | null;
  shots.payload[from] = null;
  shots.target[to] = shots.target[from] as Enemy | null;
  shots.target[from] = null;
}

/**
 * A homing shot: it expires at `until`; a dead target gives way to the alive enemy nearest to
 * the shot, any enemy, or the shot fizzles; then it flies projectileStep towards the target and
 * arrives by the volley's arrival rule. A signature emitter's shot (owner ≥ 0 and SIGNATURE: a
 * turret's of the swarm) arrives as a volley projectile does, as one attack: its primary hit,
 * with PRIMARY, and its chain (chainAttack). Any other, an effect's or a granted turret's, hits
 * its target at its scale as a plain hit. Its targets are not the volley's: they count nothing
 * in Enemy.inbound.
 */
function stepHoming(ctx: RunContext, s: number): void {
  const shots = ctx.shots;
  if (ctx.now >= (shots.until[s] as number)) {
    endShot(shots, s);
    return;
  }
  const x = shots.x[s] as number;
  const y = shots.y[s] as number;
  let target = shots.target[s] as Enemy | null;
  if (target === null || !target.alive) {
    target = ctx.grid.nearest(x, y, Infinity);
    if (target === null) {
      endShot(shots, s);
      return;
    }
    shots.target[s] = target;
  }
  const dx = target.x - x;
  const dy = target.y - y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = ctx.projectileStep;
  if (dist - step <= target.radius) {
    shots.x[s] = target.x;
    shots.y[s] = target.y;
    const p = shots.payload[s] as Payload;
    const scale = shots.scale[s] as number;
    const steady = shots.steady[s] === 1;
    const depth = shots.depth[s] as number;
    const origin = shots.origin[s] as number;
    const owner = shots.owner[s] as number;
    endShot(shots, s);
    if (owner >= 0 && (p.flags & SIGNATURE) !== 0) {
      chainAttack(ctx, p, target, ctx.chainCount, steady, depth, origin);
    } else {
      hitWithPayload(ctx, target, p, 0, scale, null, null, steady, depth, origin);
    }
  } else {
    const k = step / dist;
    shots.x[s] = x + dx * k;
    shots.y[s] = y + dy * k;
  }
}

/**
 * A straight shot: it expires at `until`; otherwise it sweeps the segment of this tick's move,
 * hits the enemies the segment brings within reach in the order it reaches them (pathHits),
 * moves, and ends once its pierce is spent or when it leaves the arena without a bounce left.
 * An enemy that died earlier in the step (a kill's split, a primary hit's chain) is passed over
 * without using pierce. A fan's cone (round ≥ 0) whose round has no primary hit yet makes this
 * hit the round's primary, an attack of its own with the round's chain; under 稜鏡
 * (FanParams.prism) a cone's hits grow with the enemies it passed before.
 */
function stepStraight(ctx: RunContext, s: number): void {
  const shots = ctx.shots;
  if (ctx.now >= (shots.until[s] as number)) {
    endShot(shots, s);
    return;
  }
  const ax = shots.x[s] as number;
  const ay = shots.y[s] as number;
  const vx = shots.vx[s] as number;
  const vy = shots.vy[s] as number;
  const bx = ax + vx;
  const by = ay + vy;
  const count = pathHits(ctx, s, ax, ay, bx, by);
  if (count > 0) {
    const p = shots.payload[s] as Payload;
    const scale = shots.scale[s] as number;
    const steady = shots.steady[s] === 1;
    const depth = shots.depth[s] as number;
    const origin = shots.origin[s] as number;
    const round = shots.round[s] as number;
    const fan = round >= 0 ? ctx.build.signature.fan : null;
    const prism = fan === null ? null : fan.prism;
    const taken = shots.roundTaken;
    const enemies = ctx.shotHits.enemies;
    for (let i = 0; i < count; i++) {
      const pierce = shots.pierce[s] as number;
      if (pierce === 0) break;
      const enemy = enemies[i] as Enemy;
      if (!enemy.alive) continue;
      const pierced = shots.pierced[s] as number;
      const hitScale =
        prism === null
          ? scale
          : scale * Math.min(1 + prism.maxBonus, 1 + prism.perPierce * pierced);
      if (round >= 0 && taken[round & ROUND_MASK] !== round) {
        // The round's first cone hit: its primary, an attack of its own with the round's chain.
        taken[round & ROUND_MASK] = round;
        beginAttack(ctx);
        primaryHit(ctx, p, enemy, hitScale, steady, depth, origin);
        if (p.chains) chainFrom(ctx, p, enemy, ctx.chainCount, steady, depth, origin);
        endAttack(ctx);
      } else {
        hitWithPayload(ctx, enemy, p, 0, hitScale, null, null, steady, depth, origin);
      }
      remember(shots, s, enemy.id);
      shots.pierced[s] = pierced + 1;
      if (pierce > 0) shots.pierce[s] = pierce - 1;
    }
  }
  shots.x[s] = bx;
  shots.y[s] = by;
  // Leaving the arena: outside it on an axis and moving away from it on that axis.
  const outX = (bx < 0 && vx < 0) || (bx > ARENA_WIDTH && vx > 0);
  const outY = (by < 0 && vy < 0) || (by > ARENA_HEIGHT && vy > 0);
  if (outX || outY) {
    const bounce = shots.bounce[s] as number;
    if (bounce > 0) {
      if (outX) shots.vx[s] = -vx;
      if (outY) shots.vy[s] = -vy;
      shots.bounce[s] = bounce - 1;
    } else {
      endShot(shots, s);
      return;
    }
  }
  if (shots.pierce[s] === 0) endShot(shots, s);
}

/**
 * The enemies the straight shot in slot `s` reaches on its move from (ax, ay) to (bx, by),
 * written to ctx.shotHits in hit order: by path parameter t, the fraction of the move at which
 * it first touches the enemy, then by id; returns their count. The candidates are the alive
 * enemies whose centre lies in the move's bounding box padded by ctx.shotPad and the shot's
 * radius (grid.boxIndices), which holds every enemy within reach but the tough ones, larger
 * than the pad; the tough ones whose centre lies outside the box are added from the grid's
 * marked list, so no enemy is a candidate twice. Enemies the shot remembers are left out.
 */
function pathHits(
  ctx: RunContext,
  s: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const shots = ctx.shots;
  const grid = ctx.grid;
  const radius = shots.radius[s] as number;
  const pad = ctx.shotPad + radius;
  const minX = (ax < bx ? ax : bx) - pad;
  const maxX = (ax < bx ? bx : ax) + pad;
  const minY = (ay < by ? ay : by) - pad;
  const maxY = (ay < by ? by : ay) + pad;
  // Every candidate is a distinct enemy of the grid's source.
  if (ctx.candidates.length < ctx.enemies.length) growShotScratch(ctx, ctx.enemies.length);
  const candidates = ctx.candidates;
  const hits = ctx.shotHits;
  const n = grid.boxIndices(minX, minY, maxX, maxY, candidates);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const enemy = grid.item(candidates[i] as number);
    const t = entryAt(enemy, enemy.radius + radius, ax, ay, bx, by);
    if (t >= 0 && !remembers(shots, s, enemy.id)) count = insertHit(hits, count, t, enemy);
  }
  const marked = grid.markedCount();
  for (let k = 0; k < marked; k++) {
    const enemy = grid.marked(k);
    if (!enemy.tough || !enemy.alive) continue;
    const x = enemy.x;
    const y = enemy.y;
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
    const t = entryAt(enemy, enemy.radius + radius, ax, ay, bx, by);
    if (t >= 0 && !remembers(shots, s, enemy.id)) count = insertHit(hits, count, t, enemy);
  }
  return count;
}

/**
 * Where a circle of radius `reach` around the enemy first meets the segment from (ax, ay) to
 * (bx, by): the segment's parameter in [0, 1], 0 when its start is already within reach; −1
 * when the segment stays out of reach. The distance to the segment's line is tested first,
 * which rejects most enemies, then the ends.
 */
function entryAt(
  enemy: Enemy,
  reach: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const wx = enemy.x - ax;
  const wy = enemy.y - ay;
  const reachSq = reach * reach;
  // cross / |d| is the distance from the line.
  const cross = dx * wy - dy * wx;
  if (cross * cross > reachSq * lenSq) return -1;
  if (wx * wx + wy * wy <= reachSq) return 0;
  const dot = dx * wx + dy * wy;
  if (dot <= 0) return -1;
  if (dot >= lenSq) {
    const ex = enemy.x - bx;
    const ey = enemy.y - by;
    if (ex * ex + ey * ey > reachSq) return -1;
  }
  // The start is out of reach and the segment comes within reach: the entry point lies the
  // half chord before the point nearest the enemy.
  const t = (dot - Math.sqrt(reachSq * lenSq - cross * cross)) / lenSq;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Inserts (t, enemy) into hits[0 .. count) by (t, id); returns the new count. */
function insertHit(hits: ShotHits, count: number, t: number, enemy: Enemy): number {
  const ts = hits.t;
  const enemies = hits.enemies;
  let j = count - 1;
  while (j >= 0) {
    const tj = ts[j] as number;
    if (tj < t || (tj === t && (enemies[j] as Enemy).id < enemy.id)) break;
    ts[j + 1] = tj;
    enemies[j + 1] = enemies[j] as Enemy;
    j--;
  }
  ts[j + 1] = t;
  enemies[j + 1] = enemy;
  return count + 1;
}

/** The shot in slot `s` hit the enemy with id `id` among its last SHOT_MEMORY hits. */
function remembers(shots: ShotPool, s: number, id: number): boolean {
  const memory = shots.memory;
  const base = shots.memBase[s] as number;
  for (let i = base; i < base + SHOT_MEMORY; i++) if (memory[i] === id) return true;
  return false;
}

/** Remembers a hit of the shot in slot `s` on enemy `id`, over its oldest one. */
function remember(shots: ShotPool, s: number, id: number): void {
  const head = shots.memHead[s] as number;
  shots.memory[(shots.memBase[s] as number) + head] = id;
  shots.memHead[s] = head + 1 === SHOT_MEMORY ? 0 : head + 1;
}

/**
 * Grows RunContext.candidates and shotHits.t to hold at least `n` enemies; the segment stage's
 * box queries share them (src/sim/systems/segments.ts).
 */
export function growShotScratch(ctx: RunContext, n: number): void {
  const size = Math.max(n, 2 * ctx.candidates.length);
  ctx.candidates = new Int32Array(size);
  ctx.shotHits.t = new Float64Array(size);
}
