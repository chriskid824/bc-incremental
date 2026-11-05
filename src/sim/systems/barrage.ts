/**
 * The barrage rider (副彈, docs/v3/game-design-v3.md §4.11, E10a): 「小彈是跟著你的攻擊一起射出的
 * 小投射物，每發是一次小擊中」. Each counted attack of the signature emitter, once its own
 * projectiles, cones, bombs, discharge, impact hits or turret shots are out, fires the rider's
 * small shots (EmitterRuntime.barrage) from the attack's origin: the player for the volley, the
 * lob (at the throw), the fan and the arc; a swarm drone's position at its impact; a signature
 * turret's seat. Its picks are the `count` nearest distinct alive enemies to the origin, ties to
 * the lower id, at any distance, outside the arena too (nearestAlive: the projectiles effects'
 * 'distinct' aim; lead ruling W16); with fewer enemies, the shots past them are lost. A drone's
 * origin lies inside the enemy it impacted, so its rider skips that enemy in its picks and each
 * shot starts out remembering it (SHOT_MEMORY), passing through it (lead ruling W15): the picks
 * are the nearest others, 「射向不同的敵人」 (gd:488). Each shot flies straight from the origin towards
 * its pick's position at the firing, at the straight projectiles effects' speed
 * (RunContext.projectileStep), for SMALL_PROJECTILE_TICKS: no homing. As any straight shot of the
 * pool (src/sim/systems/shots.ts) it hits the enemies its path touches, `hits` of them at most,
 * and bounces off the arena's edge `bounce` times. Its hits are plain hits of the rider's
 * payload, at depth 0 from origin −1 on the barrage stream: no attack, no PRIMARY, no chain. A
 * shot is refused while SMALL_SHOT_CAP projectiles are in flight, and each refused one counts in
 * barrageCapped, so the rider leaves the pool's last slots to the others. A repeat, a granted
 * emitter, a spirit and a triggered effect carry no rider and fire none.
 *
 * Its ◆ params (BuildFlags.barrage, E10b; lead rulings X1-X9), each a null or boolean test a
 * firing when the build has none of it:
 * - 扇形 (aim 'fan', gd:489): the attack's first pick alone (as above, an impact's target
 *   skipped), every shot at its position at the firing, shot i of N turned by
 *   spread × (i / (N − 1) − 0.5) (one shot: straight at it); no pick, no shots.
 * - 環射 (ring, gd:489): the rider counts the counted attacks it follows (BarrageRider.attacks,
 *   once a run); on every ring.every-th, after that attack's shots, ring.count more from the same
 *   origin, evenly round, the first as a 'radial' projectiles effect's first one from there.
 * - 子母彈 and the 分裂 rank (split, gd:490, A19): the rider's shots are generation 0
 *   (ShotPool.round SPLIT_ROUND); a hit of one that kills its enemy rolls the split's chance and
 *   records the split (splitOnKill, from the projectile stage), and the records spawn their
 *   children once the stage has compacted (spawnSplits): generation 1, which never split.
 * - 聚焦 (focus, gd:490, A20): while its condition holds at the firing, every shot of the attack
 *   and of its ring goes at the one target (with the attack's aim), at scale 1 + bonus; the
 *   impact's target is then neither skipped nor remembered: 「所有小彈都打它」.
 * - 彈雨 (rain, gd:493): the shots, the ring and the children × rain.mult while the run's tick
 *   is in the window, a stateless test of ctx.now.
 */

import { SMALL_PROJECTILE_TICKS, SMALL_SHOT_CAP } from '../caps';
import { nearestAlive } from '../effects/execute';
import type { BarrageRider, BarrageSplits, EmitterRuntime } from '../emitters/types';
import type { Enemy, RunContext } from './context';
import { liveProjectiles, MOTION_STRAIGHT, remember, spawnShot, SPLIT_ROUND } from './shots';

/**
 * Fires `rider`'s shots from (x, y), the origin of the attack it follows; `skip`, an impact's
 * target, is no pick and every shot passes through it (null for every other origin). A pick on
 * the origin gives no direction: its shot flies away from the player, as a 'radial' projectiles
 * effect's first one does, +x when the origin is the player too. With its ◆ params: 聚焦's
 * target first when its condition holds, else 扇形's first pick or the distinct picks; then
 * 環射's ring when due; 彈雨's factor on every count.
 */
export function fireBarrage(
  ctx: RunContext,
  rider: BarrageRider,
  x: number,
  y: number,
  skip: Enemy | null = null,
): void {
  const rain = rider.rain;
  const mult = rain === null ? 1 : rainFactor(rain, ctx.now);
  // Generation 0 when the rider splits: the stage tells its shots apart by their round.
  const round = rider.split === null ? -1 : SPLIT_ROUND;
  const focus = rider.focus;
  if (focus !== null) {
    const target = focusTarget(ctx, focus.boss, x, y);
    if (target !== null) {
      // 聚焦: every shot at it, ring and all, × (1 + bonus); no skip, nothing remembered.
      const scale = 1 + focus.bonus;
      aimAt(ctx, rider, x, y, target, rider.count * mult, scale, round, null);
      const ring = rider.ring;
      if (ring !== null && ++rider.attacks % ring.every === 0) {
        aimAt(ctx, rider, x, y, target, ring.count * mult, scale, round, null);
      }
      return;
    }
  }
  if (rider.fan) {
    // 扇形: the first pick alone, every shot at it.
    if (nearestAlive(ctx, 1, x, y, skip) === 1) {
      aimAt(ctx, rider, x, y, ctx.shots.distinct[0] as Enemy, rider.count * mult, 1, round, skip);
    }
  } else {
    distinctShots(ctx, rider, x, y, rider.count * mult, round, skip);
  }
  const ring = rider.ring;
  if (ring !== null && ++rider.attacks % ring.every === 0) {
    ringShots(ctx, rider, x, y, ring.count * mult, round, skip);
  }
}

/**
 * E10a's shots: one at each of the `n` nearest distinct alive enemies to (x, y) but `skip`, each
 * remembering `skip`; the shots past the enemies there are are lost.
 */
function distinctShots(
  ctx: RunContext,
  rider: BarrageRider,
  x: number,
  y: number,
  n: number,
  round: number,
  skip: Enemy | null,
): void {
  const picks = nearestAlive(ctx, n, x, y, skip);
  const distinct = ctx.shots.distinct;
  const step = ctx.projectileStep;
  const until = ctx.now + SMALL_PROJECTILE_TICKS;
  const { payload, hits, bounce } = rider;
  for (let i = 0; i < picks; i++) {
    if (liveProjectiles(ctx) >= SMALL_SHOT_CAP) {
      // No shot ends within the call, so the rest are refused too.
      ctx.counters.barrageCapped += picks - i;
      return;
    }
    const e = distinct[i] as Enemy;
    let dx = e.x - x;
    let dy = e.y - y;
    if (dx === 0 && dy === 0) {
      dx = x - ctx.player.x;
      dy = y - ctx.player.y;
      if (dx === 0 && dy === 0) dx = 1;
    }
    const k = step / Math.sqrt(dx * dx + dy * dy);
    // Below SMALL_SHOT_CAP, PROJECTILE_CAP never refuses it: its slot is a shot's.
    const slot = spawnShot(
      ctx,
      MOTION_STRAIGHT,
      x,
      y,
      dx * k,
      dy * k,
      until,
      payload,
      1,
      hits,
      bounce,
      0,
      -1,
      false,
      round,
      -1,
      null,
    );
    if (skip !== null) remember(ctx.shots, slot, skip.id);
  }
}

/**
 * Fires `n` of `rider`'s shots from (x, y) at `target`'s position at the firing: straight at
 * it, or under 扇形 shot i of n turned by rider.spread × (i / (n − 1) − 0.5) (one shot: straight
 * at it), each hitting at `scale` and remembering `skip` (null for none). A target on the origin
 * gives the direction away from the player, +x when the origin is the player too.
 */
function aimAt(
  ctx: RunContext,
  rider: BarrageRider,
  x: number,
  y: number,
  target: Enemy,
  n: number,
  scale: number,
  round: number,
  skip: Enemy | null,
): void {
  let dx = target.x - x;
  let dy = target.y - y;
  if (dx === 0 && dy === 0) {
    dx = x - ctx.player.x;
    dy = y - ctx.player.y;
    if (dx === 0 && dy === 0) dx = 1;
  }
  const k = ctx.projectileStep / Math.sqrt(dx * dx + dy * dy);
  const ux = dx * k;
  const uy = dy * k;
  const spread = rider.fan && n > 1 ? rider.spread : 0;
  for (let i = 0; i < n; i++) {
    if (liveProjectiles(ctx) >= SMALL_SHOT_CAP) {
      ctx.counters.barrageCapped += n - i;
      return;
    }
    if (spread === 0) {
      smallShot(ctx, rider, x, y, ux, uy, scale, round, skip);
    } else {
      const a = spread * (i / (n - 1) - 0.5);
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      smallShot(ctx, rider, x, y, ux * cos - uy * sin, ux * sin + uy * cos, scale, round, skip);
    }
  }
}

/**
 * 環射's `n` shots from (x, y), evenly round, the first as a 'radial' projectiles effect's first
 * one from there: away from the player, +x on it; each remembering `skip` (null for none).
 */
function ringShots(
  ctx: RunContext,
  rider: BarrageRider,
  x: number,
  y: number,
  n: number,
  round: number,
  skip: Enemy | null,
): void {
  const dx = x - ctx.player.x;
  const dy = y - ctx.player.y;
  const first = dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx);
  const gap = (2 * Math.PI) / n;
  const step = ctx.projectileStep;
  for (let i = 0; i < n; i++) {
    if (liveProjectiles(ctx) >= SMALL_SHOT_CAP) {
      ctx.counters.barrageCapped += n - i;
      return;
    }
    const a = first + gap * i;
    smallShot(ctx, rider, x, y, Math.cos(a) * step, Math.sin(a) * step, 1, round, skip);
  }
}

/** One straight small shot of `rider` from (x, y) at (vx, vy) a tick; below SMALL_SHOT_CAP. */
function smallShot(
  ctx: RunContext,
  rider: BarrageRider,
  x: number,
  y: number,
  vx: number,
  vy: number,
  scale: number,
  round: number,
  skip: Enemy | null,
): void {
  // Below SMALL_SHOT_CAP, PROJECTILE_CAP never refuses it: its slot is a shot's.
  const slot = spawnShot(
    ctx,
    MOTION_STRAIGHT,
    x,
    y,
    vx,
    vy,
    ctx.now + SMALL_PROJECTILE_TICKS,
    rider.payload,
    scale,
    rider.hits,
    rider.bounce,
    0,
    -1,
    false,
    round,
    -1,
    null,
  );
  if (skip !== null) remember(ctx.shots, slot, skip.id);
}

/**
 * 聚焦's target at a firing from (x, y), from the alive list as nearestAlive reads it; null while
 * its condition does not hold. With `boss` (A20 (b)): the nearest alive boss, ties to the lower
 * id, while one lives, a scan of the whole list. Otherwise (A20 (a)): the one alive enemy while
 * exactly one is, a scan that stops at the second alive enemy.
 */
function focusTarget(ctx: RunContext, boss: boolean, x: number, y: number): Enemy | null {
  const enemies = ctx.enemies;
  let best: Enemy | null = null;
  if (boss) {
    let bestD = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i] as Enemy;
      if (!e.alive || !e.boss) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d = dx * dx + dy * dy;
      // In id order with a strict <, so ties keep the lower id.
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i] as Enemy;
    if (!e.alive) continue;
    if (best !== null) return null;
    best = e;
  }
  return best;
}

/** 彈雨's factor at tick `now`: its mult while now % period < active, 1 otherwise. */
function rainFactor(rain: NonNullable<BarrageRider['rain']>, now: number): number {
  return now % rain.period < rain.active ? rain.mult : 1;
}

/**
 * A generation-0 shot's hit took `victim` from alive to dead (the projectile stage, shots.ts),
 * its velocity (vx, vy): the rider rolls its split's chance on the barrage stream (Rng.chance
 * draws nothing at 1) and, on success, records the split for spawnSplits, in hit order. The
 * records past SMALL_SHOT_CAP are never kept: each record spawns one child at least, so the
 * reserve would refuse every child of theirs, which count in barrageCapped at once instead.
 */
export function splitOnKill(ctx: RunContext, victim: Enemy, vx: number, vy: number): void {
  const rider = (ctx.emitters[0] as EmitterRuntime).barrage as BarrageRider;
  const split = rider.split as BarrageSplits;
  if (!rider.payload.rng.chance(split.chance)) return;
  const n = split.pending;
  if (n === SMALL_SHOT_CAP) {
    const rain = rider.rain;
    ctx.counters.barrageCapped += split.count * (rain === null ? 1 : rainFactor(rain, ctx.now));
    return;
  }
  split.victim[n] = victim.id;
  split.x[n] = victim.x;
  split.y[n] = victim.y;
  split.vx[n] = vx;
  split.vy[n] = vy;
  split.pending = n + 1;
}

/**
 * The children of the splits the projectile stage recorded, once it has compacted (the tick's
 * step, src/sim/simulation.ts), in the order they were recorded: each split's count × 彈雨's
 * factor now, generation 1 (round −1, so they never split), straight from the victim's position
 * at its kill, evenly round, the first along the killing shot's velocity, with the rider's
 * payload at full shot damage (scale 1, A19), pierce, bounce and SMALL_PROJECTILE_TICKS of life,
 * each remembering the victim. The reserve refuses each child while SMALL_SHOT_CAP projectiles
 * are in flight, counted in barrageCapped.
 */
export function spawnSplits(ctx: RunContext, rider: BarrageRider): void {
  const split = rider.split as BarrageSplits;
  const pending = split.pending;
  if (pending === 0) return;
  split.pending = 0;
  const rain = rider.rain;
  const n = split.count * (rain === null ? 1 : rainFactor(rain, ctx.now));
  const step = ctx.projectileStep;
  const gap = (2 * Math.PI) / n;
  for (let r = 0; r < pending; r++) {
    const vx = split.vx[r] as number;
    const vy = split.vy[r] as number;
    const len = Math.sqrt(vx * vx + vy * vy);
    const k = len === 0 ? 0 : step / len;
    const ux = vx * k;
    const uy = vy * k;
    const x = split.x[r] as number;
    const y = split.y[r] as number;
    const victim = split.victim[r] as number;
    for (let c = 0; c < n; c++) {
      if (liveProjectiles(ctx) >= SMALL_SHOT_CAP) {
        // No shot ends here, so every child left is refused too.
        ctx.counters.barrageCapped += (pending - r) * n - c;
        return;
      }
      const a = gap * c;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const slot = spawnShot(
        ctx,
        MOTION_STRAIGHT,
        x,
        y,
        ux * cos - uy * sin,
        ux * sin + uy * cos,
        ctx.now + SMALL_PROJECTILE_TICKS,
        rider.payload,
        1,
        rider.hits,
        rider.bounce,
        0,
        -1,
        false,
        -1,
        -1,
        null,
      );
      remember(ctx.shots, slot, victim);
    }
  }
}
