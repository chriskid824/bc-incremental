import { describe, expect, it } from 'vitest';
import { mul, num } from '../../core/num';
import { createRng } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { EnemyId } from '../../data/types';
import { TAG } from '../../data/tags';
import { PROJECTILE_CAP, SHOT_MEMORY, SMALL_PROJECTILE_TICKS } from '../caps';
import { createPayload, ROWS } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import { countAttack, fireAttack } from '../emitters/volley';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  segDistSqRef,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import { moveProjectiles } from './projectiles';
import {
  compactShots,
  liveProjectiles,
  MOTION_HOMING,
  MOTION_LOB,
  MOTION_STRAIGHT,
  spawnShot,
  stepShot,
} from './shots';
import { addEnemy } from './spawn';

/** No crits and no ailments: hits draw only their crit roll, which never succeeds. */
const PLAIN = makeStats({ critChance: 0, igniteChance: 0 });

/** A projectile payload credited to `source`, as an effect's would be. */
function shotPayload(ctx: RunContext, source = 'center'): Payload {
  return createPayload({
    baseDamage: mul(num(ctx.build.values.damage), 0.5),
    tags: TAG.hit | TAG.projectile,
    source: ctx.sources.index(source),
    flags: 0,
    rng: ctx.effectsRng,
    chains: false,
    rollsAilments: false,
    canCrit: true,
    damageMode: ROWS,
  });
}

interface ShotOptions {
  readonly motion?: number;
  readonly vx?: number;
  readonly vy?: number;
  readonly until?: number;
  readonly pierce?: number;
  readonly bounce?: number;
  readonly radius?: number;
  readonly target?: Enemy | null;
  readonly payload?: Payload;
}

/** Spawns a shot at (x, y), straight with no limits unless told otherwise; returns its slot. */
function shoot(ctx: RunContext, x: number, y: number, o: ShotOptions = {}): number {
  const slot = spawnShot(
    ctx,
    o.motion ?? MOTION_STRAIGHT,
    x,
    y,
    o.vx ?? 0,
    o.vy ?? 0,
    o.until ?? ctx.now + 1000,
    o.payload ?? shotPayload(ctx),
    1,
    o.pierce ?? -1,
    o.bounce ?? 0,
    0,
    -1,
    false,
    -1,
    -1,
    o.target ?? null,
  );
  if (slot >= 0 && o.radius !== undefined) ctx.shots.radius[slot] = o.radius;
  return slot;
}

/** Ids of the enemies hit by this tick's events so far, in order. */
const hitIds = (ctx: RunContext): number[] =>
  eventsOf([ctx.events], 'hit').map((hit) => hit.targetId);

/** Runs the projectile stage of the next tick. */
function nextTick(ctx: RunContext): void {
  ctx.now++;
  ctx.events.length = 0;
  ctx.grid.rebuild(ctx.enemies, (enemy) => enemy.tough);
  moveProjectiles(ctx);
}

describe('straight shots against a swept-circle reference', () => {
  const TYPES: readonly EnemyId[] = ['triangle', 'square', 'pentagon', 'shard', 'hexagon', 'boss'];

  /** Entry parameter of the circle of radius `reach` around (px, py) on the move A → B. */
  function entryRef(
    px: number,
    py: number,
    reach: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): number {
    const dx = bx - ax;
    const dy = by - ay;
    const fx = ax - px;
    const fy = ay - py;
    const c = fx * fx + fy * fy - reach * reach;
    if (c <= 0) return 0;
    const a = dx * dx + dy * dy;
    const b = 2 * (dx * fx + dy * fy);
    const t = (-b - Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
    return Math.min(1, Math.max(0, t));
  }

  /** `count` enemies of random types around (cx, cy), some sharing a position, some dead. */
  function fixture(rng: Rng, count: number): RunContext {
    const cx = rng.range(-100, ARENA_WIDTH + 100);
    const cy = rng.range(-100, ARENA_HEIGHT + 100);
    const placed: PlacedEnemy[] = [];
    for (let i = 0; i < count; i++) {
      const twin = i > 0 && rng.chance(0.05) ? (placed[rng.int(i)] as PlacedEnemy) : null;
      placed.push({
        x: twin?.x ?? cx + rng.range(-250, 250),
        y: twin?.y ?? cy + rng.range(-250, 250),
        type: TYPES[rng.chance(0.15) ? 4 + rng.int(2) : rng.int(4)] as EnemyId,
      });
    }
    const ctx = placedEnemies(placed, { stats: PLAIN, seed: 1 + rng.int(1000) });
    for (const enemy of ctx.enemies) if (rng.chance(0.1)) removeEnemy(ctx, enemy);
    // Enemies added after the grid's sort are scanned apart (split children).
    ctx.grid.markedCount();
    const late = rng.int(4);
    for (let i = 0; i < late; i++) {
      const parent = ctx.enemies[rng.int(ctx.enemies.length)] as Enemy;
      const def = ctx.data.enemies[TYPES[rng.int(TYPES.length)] as EnemyId];
      addEnemy(ctx, def, parent.rec, 1, 0, 0);
      const child = ctx.enemies.at(-1) as Enemy;
      child.x = cx + rng.range(-250, 250);
      child.y = cy + rng.range(-250, 250);
    }
    if (rng.chance(0.3)) ctx.grid.sortNow();
    return ctx;
  }

  it('hits exactly the enemies within reach of its move, by entry then id, each once', () => {
    const rng = createRng(20261014);
    const SIZES = [8, 40, 100, 127, 130, 220, 400];
    let steps = 0;
    let skipped = 0;
    let hits = 0;
    let toughOutside = 0;
    const modes = { linear: 0, sorted: 0 };
    for (let f = 0; f < 50; f++) {
      const ctx = fixture(rng, SIZES[f % SIZES.length] as number);
      const p = shotPayload(ctx);
      if (ctx.grid.linearSource() === null) modes.sorted++;
      else modes.linear++;
      for (let k = 0; k < 200; k++) {
        const ax = (ctx.enemies[rng.int(ctx.enemies.length)] as Enemy).x + rng.range(-150, 150);
        const ay = (ctx.enemies[rng.int(ctx.enemies.length)] as Enemy).y + rng.range(-150, 150);
        const angle = rng.range(0, 2 * Math.PI);
        const length = [0, 5, 23, 23, 60, 200][rng.int(6)] as number;
        const vx = Math.cos(angle) * length;
        const vy = Math.sin(angle) * length;
        const radius = [0, 0, 4, 12, 30][rng.int(5)] as number;
        const bx = ax + vx;
        const by = ay + vy;
        // The reference: every alive enemy whose distance to the move is within its reach.
        const expected: { id: number; t: number }[] = [];
        let ambiguous = false;
        for (const enemy of ctx.enemies) {
          if (!enemy.alive) continue;
          const reach = enemy.radius + radius;
          const d = segDistSqRef(enemy.x, enemy.y, ax, ay, bx, by) - reach * reach;
          if (Math.abs(d) <= 1e-9 * Math.max(1, reach * reach)) ambiguous = true;
          if (d > 0) continue;
          expected.push({ id: enemy.id, t: entryRef(enemy.x, enemy.y, reach, ax, ay, bx, by) });
          const pad = ctx.shotPad + radius;
          const outside =
            enemy.x < Math.min(ax, bx) - pad ||
            enemy.x > Math.max(ax, bx) + pad ||
            enemy.y < Math.min(ay, by) - pad ||
            enemy.y > Math.max(ay, by) + pad;
          if (outside) {
            expect(enemy.tough, 'only a tough enemy reaches out of the padded box').toBe(true);
            toughOutside++;
          }
        }
        expected.sort((a, b) => a.t - b.t || a.id - b.id);
        for (let i = 1; i < expected.length; i++) {
          const [prev, next] = [expected[i - 1], expected[i]] as [{ t: number }, { t: number }];
          if (next.t - prev.t < 1e-9 && next.t !== prev.t) ambiguous = true;
        }
        ctx.events.length = 0;
        const slot = shoot(ctx, ax, ay, { vx, vy, radius, payload: p });
        stepShot(ctx, slot);
        // Empty the pool for the next shot.
        ctx.shots.count = 0;
        ctx.shots.straight = 0;
        steps++;
        if (ambiguous) {
          skipped++;
          continue;
        }
        const got = hitIds(ctx);
        expect(new Set(got).size, 'no enemy hit twice in one step').toBe(got.length);
        expect(got).toEqual(expected.map((e) => e.id));
        hits += got.length;
      }
    }
    expect(steps).toBe(10_000);
    expect(skipped).toBeLessThan(10);
    // The fixtures exercise both grid modes, many hits and tough enemies out of the box.
    expect(modes.linear).toBeGreaterThan(10);
    expect(modes.sorted).toBeGreaterThan(10);
    expect(hits).toBeGreaterThan(20_000);
    expect(toughOutside).toBeGreaterThan(100);
  });

  it('takes candidates once each: the box query plus the tough enemies outside the box', () => {
    const rng = createRng(7);
    for (let f = 0; f < 40; f++) {
      const ctx = fixture(rng, [30, 160][f % 2] as number);
      const grid = ctx.grid;
      const out = new Int32Array(ctx.enemies.length);
      for (let k = 0; k < 50; k++) {
        const enemy = ctx.enemies[rng.int(ctx.enemies.length)] as Enemy;
        const [x, y] = [enemy.x + rng.range(-100, 100), enemy.y + rng.range(-100, 100)];
        const pad = ctx.shotPad + rng.range(0, 30);
        const [minX, maxX] = [x - pad, x + rng.range(0, 60) + pad];
        const [minY, maxY] = [y - pad, y + rng.range(0, 60) + pad];
        const n = grid.boxIndices(minX, minY, maxX, maxY, out);
        const candidates = Array.from(out.subarray(0, n), (i) => grid.item(i));
        for (let m = 0; m < grid.markedCount(); m++) {
          const t = grid.marked(m);
          const inBox = t.x >= minX && t.x <= maxX && t.y >= minY && t.y <= maxY;
          if (t.tough && t.alive && !inBox) candidates.push(t);
        }
        expect(new Set(candidates).size).toBe(candidates.length);
        const inBox = ctx.enemies.filter(
          (e) => e.alive && e.x >= minX && e.x <= maxX && e.y >= minY && e.y <= maxY,
        );
        const tough = ctx.enemies.filter((e) => e.alive && e.tough);
        expect(new Set(candidates)).toEqual(new Set([...inBox, ...tough]));
      }
    }
  });
});

describe('straight shots', () => {
  /** A row of squares along y = 500 from x = 200, 50 apart, and a shot from x = 100 along it. */
  function row(count: number, extra: readonly PlacedEnemy[] = []): RunContext {
    const placed = Array.from({ length: count }, (_, i) => ({ x: 200 + 50 * i, y: 500 }));
    return placedEnemies([...placed, ...extra], { stats: PLAIN });
  }

  it('hits by entry along its move, ties by id, also when the cells order them otherwise', () => {
    // Far-off squares make the grid sort its 130 enemies into cells.
    const filler = Array.from({ length: 125 }, (_, i) => ({ x: 1500 + (i % 25) * 10, y: 900 }));
    const ctx = placedEnemies(
      [
        // Ids 1 and 2 share an entry; 2 sits in an earlier row of cells than 1.
        { x: 320, y: 520 },
        { x: 320, y: 480 },
        { x: 250, y: 500 },
        { x: 110, y: 505 },
        { x: 100, y: 490 },
        ...filler,
      ],
      { stats: PLAIN },
    );
    expect(ctx.grid.linearSource()).toBeNull();
    shoot(ctx, 100, 500, { vx: 300, vy: 0 });
    stepShot(ctx, 0);
    // 4 and 5 are within reach at the start (entry 0), then 3, then the tied 1 and 2.
    expect(hitIds(ctx)).toEqual([4, 5, 3, 1, 2]);
  });

  it.each([0, 1, 3])('with pierce %i hits that many enemies and one more, then ends', (n) => {
    const ctx = row(8);
    shoot(ctx, 100, 500, { vx: 1000, vy: 0, pierce: n + 1 });
    nextTick(ctx);
    expect(hitIds(ctx)).toEqual(Array.from({ length: n + 1 }, (_, i) => i + 1));
    expect(ctx.shots.count).toBe(0);
    expect(ctx.state.shotCount).toBe(0);
    expect(ctx.shots.straight).toBe(0);
  });

  it('pierces without limit at −1, and keeps flying', () => {
    const ctx = row(8);
    shoot(ctx, 100, 500, { vx: 1000, vy: 0 });
    nextTick(ctx);
    expect(hitIds(ctx)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ctx.shots.count).toBe(1);
    expect(ctx.shots.pierced[0]).toBe(8);
  });

  it('passes over an enemy that died earlier in its step without spending pierce', () => {
    // Hitting the first square kills the second, as a chain or a split would.
    let killed = false;
    const module: TestModule = (b) =>
      b.hook('onHit', (ctx, hit) => {
        if (killed || hit.target.id !== 1) return;
        killed = true;
        removeEnemy(ctx, ctx.enemies[1] as Enemy);
      });
    const ctx = placedEnemies(
      Array.from({ length: 4 }, (_, i) => ({ x: 200 + 50 * i, y: 500 })),
      { stats: PLAIN, modules: [module] },
    );
    shoot(ctx, 100, 500, { vx: 1000, vy: 0, pierce: 2 });
    nextTick(ctx);
    expect(hitIds(ctx)).toEqual([1, 3]);
  });

  it('hits each enemy it remembers once, and forgets the oldest after SHOT_MEMORY hits', () => {
    // A wide, slow shot whose reach covers a cluster for many ticks.
    const cluster = (count: number): PlacedEnemy[] =>
      Array.from({ length: count }, (_, i) => ({ x: 600 + (i % 6) * 8, y: 500 + 8 * (i >> 3) }));
    const small = placedEnemies(cluster(SHOT_MEMORY), { stats: PLAIN });
    shoot(small, 610, 505, { vx: 0.5, vy: 0, radius: 200 });
    const seen: number[] = [];
    for (let t = 0; t < 10; t++) {
      nextTick(small);
      seen.push(...hitIds(small));
    }
    expect(seen.sort((a, b) => a - b)).toEqual(
      Array.from({ length: SHOT_MEMORY }, (_, i) => i + 1),
    );

    // One more enemy than it remembers: each tick, the oldest hit is forgotten and hit again.
    const big = placedEnemies(cluster(SHOT_MEMORY + 1), { stats: PLAIN });
    shoot(big, 610, 505, { vx: 0.5, vy: 0, radius: 200 });
    nextTick(big);
    expect(hitIds(big)).toHaveLength(SHOT_MEMORY + 1);
    nextTick(big);
    // Its first SHOT_MEMORY + 1 hits overwrote the first one only.
    expect(hitIds(big)).toEqual([1]);
    nextTick(big);
    expect(hitIds(big)).toEqual([2]);
  });

  it('bounces off the edges while it has bounces left, once per tick at a corner', () => {
    const ctx = placedEnemies([], { stats: PLAIN });
    shoot(ctx, 6, 500, { vx: -4, vy: 0, bounce: 2 });
    const xs: number[] = [];
    for (let t = 0; t < 4; t++) {
      nextTick(ctx);
      xs.push(ctx.shots.x[0] as number);
    }
    // At −2 it is outside and moving out: it turns and flies back in.
    expect(xs).toEqual([2, -2, 2, 6]);
    expect(ctx.shots.vx[0]).toBe(4);
    expect(ctx.shots.bounce[0]).toBe(1);

    const corner = placedEnemies([], { stats: PLAIN });
    shoot(corner, ARENA_WIDTH - 1, ARENA_HEIGHT - 1, { vx: 3, vy: 2, bounce: 1 });
    nextTick(corner);
    expect([corner.shots.vx[0], corner.shots.vy[0], corner.shots.bounce[0]]).toEqual([-3, -2, 0]);
    // Back inside, then out again with no bounce left: it ends.
    for (let t = 0; t < 2000 && corner.shots.count > 0; t++) nextTick(corner);
    expect(corner.shots.count).toBe(0);
    // Turned at y 1081 on tick 2, it climbs 2 a tick and leaves at y −1, 541 ticks later.
    expect(corner.now).toBe(2 + (ARENA_HEIGHT + 2) / 2);
  });

  it('ends when it leaves the arena without a bounce, not while it flies in from outside', () => {
    const ctx = placedEnemies([], { stats: PLAIN });
    shoot(ctx, ARENA_WIDTH - 5, 500, { vx: 2, vy: 0 });
    shoot(ctx, -50, 500, { vx: 10, vy: 0 });
    const counts: number[] = [];
    for (let t = 0; t < 4; t++) {
      nextTick(ctx);
      counts.push(ctx.shots.count);
    }
    // 1917, 1919, 1921: out and moving out on the third tick.
    expect(counts).toEqual([2, 2, 1, 1]);
    expect(ctx.shots.x[0]).toBe(-10);
  });

  it(`expires ${SMALL_PROJECTILE_TICKS} ticks after it is spawned`, () => {
    // An enemy too far for the homing shot to reach in time.
    const ctx = placedEnemies([{ x: 4000, y: 400 }], { stats: PLAIN });
    const [target] = ctx.enemies as [Enemy];
    expect(SMALL_PROJECTILE_TICKS * ctx.projectileStep).toBeLessThan(4000 - 900 - target.radius);
    shoot(ctx, 900, 500, { vx: 0.1, vy: 0, until: ctx.now + SMALL_PROJECTILE_TICKS });
    shoot(ctx, 900, 400, {
      motion: MOTION_HOMING,
      target,
      until: ctx.now + SMALL_PROJECTILE_TICKS,
    });
    let steps = 0;
    while (ctx.shots.count === 2) {
      nextTick(ctx);
      steps++;
    }
    expect(ctx.shots.count).toBe(0);
    // Spawned on tick 1, they fly on ticks 2 .. 120 and end on tick 121.
    expect(steps).toBe(SMALL_PROJECTILE_TICKS);
  });
});

describe('homing shots', () => {
  it('fly to their target and hit it once, with no attack: no chain, serial or inbound', () => {
    const ctx = placedEnemies(
      [
        { x: 1200, y: 540 },
        { x: 1230, y: 540 },
      ],
      { stats: makeStats({ critChance: 0, igniteChance: 0, chainCount: 3, chainRange: 500 }) },
    );
    const [target] = ctx.enemies as [Enemy];
    const serial = ctx.attackSerial;
    shoot(ctx, 960, 540, { motion: MOTION_HOMING, target });
    const ticks: number[] = [];
    for (let t = 0; t < 20 && ctx.shots.count > 0; t++) {
      nextTick(ctx);
      if (hitIds(ctx).length > 0) ticks.push(ctx.now);
      for (const enemy of ctx.enemies) expect(enemy.inbound).toBe(0);
    }
    expect(ticks).toHaveLength(1);
    const hit = eventsOf([ctx.events], 'hit');
    expect(hit.map((h) => [h.targetId, h.chainIndex])).toEqual([[1, 0]]);
    expect(ctx.attackSerial).toBe(serial);
    expect(ctx.chainBudget.hits).toBe(0);
  });

  it('turn to the enemy nearest to them when the target dies, or fizzle', () => {
    const ctx = placedEnemies(
      [
        { x: 1300, y: 540 },
        { x: 600, y: 540 },
        { x: 1000, y: 700 },
      ],
      { stats: PLAIN },
    );
    const [far, other, near] = ctx.enemies as [Enemy, Enemy, Enemy];
    shoot(ctx, 1100, 540, { motion: MOTION_HOMING, target: far });
    removeEnemy(ctx, far);
    nextTick(ctx);
    expect(ctx.shots.target[0]).toBe(near);
    removeEnemy(ctx, near);
    removeEnemy(ctx, other);
    nextTick(ctx);
    expect(ctx.shots.count).toBe(0);
    expect(hitIds(ctx)).toEqual([]);
  });
});

describe('lobbed shots', () => {
  it('end exactly 24 ticks after a test module launches one', () => {
    const LAUNCH = 10;
    const FLIGHT = 24;
    const module: TestModule = (b) =>
      b.hook('tick', (ctx) => {
        if (ctx.now !== LAUNCH) return;
        const { x, y } = ctx.player;
        spawnShot(
          ctx,
          MOTION_LOB,
          x + 200,
          y,
          x,
          y,
          ctx.now + FLIGHT,
          shotPayload(ctx),
          1,
          0,
          0,
          0,
          -1,
          false,
          -1,
          0,
          null,
        );
      });
    const sim = createSimulation(makeConfig({ stats: PLAIN, maxTicks: 60 }), makeTestData(), [
      module,
    ]);
    const live: number[] = [];
    while (!sim.state.finished) {
      sim.step(NO_INPUT);
      if (sim.state.shotCount > 0) live.push(sim.state.tick);
    }
    expect(live[0]).toBe(LAUNCH);
    expect(live.at(-1)).toBe(LAUNCH + FLIGHT - 1);
    expect(live).toHaveLength(FLIGHT);
  });
});

describe('the projectile stage', () => {
  it('steps the volley projectiles and the shots in one id order', () => {
    const ctx = placedEnemies([{ x: 1000, y: 540 }], {
      stats: makeStats({ critChance: 0, igniteChance: 0, projectileCount: 1 }),
    });
    const em = ctx.emitters[0] as EmitterRuntime;
    const [enemy] = ctx.enemies as [Enemy];
    const shot = shotPayload(ctx, 'outer.barrage');
    // Ids 1 and 3 are the volley's, 2 and 4 homing shots; all arrive on the next tick.
    fireAttack(ctx, em, enemy, 0, -1);
    shoot(ctx, 960, 540, { motion: MOTION_HOMING, target: enemy, payload: shot });
    fireAttack(ctx, em, enemy, 0, -1);
    shoot(ctx, 960, 540, { motion: MOTION_HOMING, target: enemy, payload: shot });
    expect(ctx.projectiles.map((p) => p.id)).toEqual([1, 3]);
    expect(Array.from(ctx.shots.id.subarray(0, ctx.shots.count))).toEqual([2, 4]);
    ctx.events.length = 0;
    moveProjectiles(ctx);
    const sources = eventsOf([ctx.events], 'hit').map((hit) => ctx.sources.names[hit.source]);
    expect(sources).toEqual(['center', 'outer.barrage', 'center', 'outer.barrage']);
  });

  it('spawns nothing while it runs: both lists keep their length until it ends', () => {
    let spawned = -1;
    let volley = -1;
    const counts: [number, number][] = [];
    const module: TestModule = (b) => {
      // The tick hooks run right before the projectile stage.
      b.hook('tick', (ctx) => {
        if (ctx.now % 3 === 0) {
          const { x, y } = ctx.player;
          for (let i = 0; i < 4; i++) {
            const angle = (i * Math.PI) / 2 + ctx.now;
            shoot(ctx, x, y, { vx: 20 * Math.cos(angle), vy: 20 * Math.sin(angle), pierce: 2 });
          }
          shoot(ctx, x, y, { motion: MOTION_HOMING });
        }
        spawned = ctx.shots.count;
        volley = ctx.projectiles.length;
      });
      b.hook('onHit', (ctx) => {
        counts.push([ctx.shots.count - spawned, ctx.projectiles.length - volley]);
      });
    };
    const stats = makeStats({ critChance: 0, igniteChance: 0, projectileCount: 3 });
    const sim = createSimulation(
      makeConfig({ stats, startWave: 8, maxTicks: 600 }),
      makeTestData(),
      [module],
    );
    while (!sim.state.finished) sim.step(NO_INPUT);
    expect(counts.length).toBeGreaterThan(200);
    expect(counts.every(([s, v]) => s === 0 && v === 0)).toBe(true);
  });
});

describe('the projectile cap', () => {
  it(`refuses the shot past ${PROJECTILE_CAP} in flight and counts it`, () => {
    const ctx = placedEnemies([{ x: 1500, y: 540 }], { stats: PLAIN });
    const p = shotPayload(ctx);
    for (let i = 0; i < PROJECTILE_CAP; i++) {
      expect(shoot(ctx, 960, 540, { vx: 1, vy: 0, payload: p })).toBe(i);
    }
    expect(liveProjectiles(ctx)).toBe(PROJECTILE_CAP);
    const nextId = ctx.nextProjectileId;
    expect(shoot(ctx, 960, 540, { vx: 1, vy: 0, payload: p })).toBe(-1);
    expect(ctx.counters.projectilesCapped).toBe(1);
    expect(ctx.nextProjectileId).toBe(nextId);
    expect(ctx.shots.count).toBe(PROJECTILE_CAP);
  });

  it('refuses the volley projectile too, counting it, with no attack event or inbound', () => {
    const ctx = placedEnemies(
      [
        { x: 1500, y: 540 },
        { x: 1500, y: 600 },
        { x: 1500, y: 480 },
      ],
      { stats: makeStats({ critChance: 0, igniteChance: 0, projectileCount: 3 }) },
    );
    const em = ctx.emitters[0] as EmitterRuntime;
    const p = shotPayload(ctx);
    for (let i = 0; i < PROJECTILE_CAP - 2; i++) shoot(ctx, 960, 540, { vx: 1, payload: p });
    const first = ctx.enemies[0] as Enemy;
    countAttack(ctx, em, first);
    fireAttack(ctx, em, first, 0, -1);
    // Two of the three fit; the third is refused.
    expect(eventsOf([ctx.events], 'attack')).toHaveLength(2);
    expect(ctx.projectiles).toHaveLength(2);
    expect(ctx.counters.projectilesCapped).toBe(1);
    expect(ctx.enemies.map((enemy) => enemy.inbound).sort()).toEqual([0, 1, 1]);
    expect(liveProjectiles(ctx)).toBe(PROJECTILE_CAP);
  });

  it('frees the slots of ended shots, keeping the others in id order with their memory', () => {
    const ctx = placedEnemies([], { stats: PLAIN });
    for (let i = 0; i < 6; i++) shoot(ctx, 900, 500, { vx: 1, until: ctx.now + 2 + (i % 2) });
    const shots = ctx.shots;
    const blocks = Array.from(shots.memBase.subarray(0, 6));
    nextTick(ctx);
    expect(shots.count).toBe(6);
    nextTick(ctx);
    // The even slots expired; the odd ones moved down with their memory blocks.
    expect(Array.from(shots.id.subarray(0, shots.count))).toEqual([2, 4, 6]);
    expect(Array.from(shots.memBase.subarray(0, 3))).toEqual([blocks[1], blocks[3], blocks[5]]);
    expect(new Set(shots.memBase).size).toBe(PROJECTILE_CAP);
    expect(ctx.state.shotCount).toBe(3);
    compactShots(ctx);
    expect(shots.count).toBe(3);
  });
});
