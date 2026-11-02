/**
 * C7b's bullet hooks (docs/v3 C7 design §2.10, src/sim/systems/bullets.ts): 節奏閃避 (lead ruling
 * W5), 攔截軌道 (W6) and 反射 (W7) in stepBullets. §2.10's tests are named in their titles with a
 * comment naming the planted bug each kills; the rest pin W5–W7's edges. Shooters stand at 100
 * from the player inside their post with a period too long to fire on their own (fire() fires
 * one, as their AI step would on that tick), so a bullet reaches the player 20 ticks after its
 * fire tick (ceil((100 − 36) / (200 / 60))). tick() runs one tick's enemy AI stage, whose walk
 * ends with stepBullets, then movement and the tick's compaction.
 */

import { describe, expect, it } from 'vitest';
import { mul, num, toNumber } from '../../core/num';
import type { SourcedEmitter } from '../../data/emitters';
import type { StatId } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import type { EnemyBehaviour, GameData } from '../../data/types';
import { compileBuild } from '../build/compile';
import { runOrbit } from '../emitters/orbit';
import type { EmitterRuntime, OrbitSpec } from '../emitters/types';
import type { TestModule } from '../rules';
import { makeStats, placedEnemies, TEST_ENEMIES, TEST_V3_WAVES, v3TestData } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, PLAYER_RADIUS, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import { BULLET_RADIUS, fireBullet, growBullets, stepBullets } from './bullets';
import { addComboStacks } from './combo';
import type { Enemy, RunContext } from './context';
import { compact, removeEnemy } from './death';
import { stepEnemyAi } from './enemyAi';
import { rebuildGrid } from './grid';
import { moveEnemies } from './movement';
import type { PlayerDefence } from './systemState';

type ShootBehaviour = Extract<EnemyBehaviour, { readonly kind: 'shoot' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const SHOOT = TEST_ENEMIES.shooter.behaviour as ShootBehaviour;
/** A bullet's step a tick. */
const STEP = SHOOT.bulletSpeed / TICK_RATE;
/** Fired at 100, a bullet is within reach of the player this many ticks after its fire tick. */
const FLIGHT = Math.ceil((100 - PLAYER_RADIUS - BULLET_RADIUS) / STEP);

/** A v3 table with only placed enemies, whose shooters never fire on their own in a test. */
const shooterData = (): GameData =>
  v3TestData({
    enemies: { shooter: { behaviour: { ...SHOOT, periodSec: 1000 } } },
    waves: {
      rules: [{ enemy: 'triangle', fromWave: 1, base: 0, perWave: 0, maxCount: 0 }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

/** A standing shooter `d` from the player at bearing `angle`. */
const shooterAt = (d = 100, angle = 0, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + d * Math.cos(angle),
  y: PLAYER.y + d * Math.sin(angle),
  type: 'shooter',
  ...more,
});

/** heroHit queues effect 0. */
const TRIGGERS: readonly TriggerSpec[] = [{ on: 'heroHit', do: [{ kind: 'heal', lifePct: 0.01 }] }];

/** Keeps every combo stack through a hit on the player. */
const KEEP_ALL: TestModule = (b) => {
  b.flags.comboHitKeep = 1;
};

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly grants?: readonly SourcedEmitter[];
  readonly modules?: readonly TestModule[];
  readonly stacks?: number;
}

/** placedEnemies on shooterData(), max life 1000, no crits or ignites, `stacks` combo stacks. */
function placed(enemies: readonly PlacedEnemy[], options: Options = {}): RunContext {
  const ctx = placedEnemies(enemies, {
    stats: makeStats({ critChance: 0, igniteChance: 0, maxLife: 1000, ...options.values }, [], {
      triggers: TRIGGERS.map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    data: shooterData(),
    modules: options.modules ?? [],
  });
  if (options.stacks !== undefined) addComboStacks(ctx, options.stacks);
  return ctx;
}

/** 節奏閃避 as B4 writes it: 3 s, at 15 stacks. */
const DODGE = { bulletDodgeSec: 3, bulletDodgeCombo: 15 } as const;
const THORNS: SourcedEmitter = { source: 'outer.thorns', grant: { kind: 'thorns' } };
const ORBIT: SourcedEmitter = { source: 'outer.aura', grant: { kind: 'orbit', count: 3 } };
const OUTER_RING: SourcedEmitter = {
  source: 'outer.aura',
  grant: { kind: 'orbit', count: 2, ring: 1 },
};

interface Tick {
  readonly now: number;
  readonly events: SimEvent[];
  readonly heroHits: number;
}

/** Fires these shooters' bullets, then runs tick ctx.now's AI stage and movement, and compacts. */
function tick(ctx: RunContext, fire: readonly Enemy[] = []): Tick {
  const now = ctx.now;
  ctx.events.length = 0;
  for (const shooter of fire) fireBullet(ctx, shooter);
  stepEnemyAi(ctx);
  moveEnemies(ctx);
  compact(ctx);
  const q = ctx.effectQueue;
  const heroHits = q.size;
  q.head = (q.head + q.size) & q.capMask;
  q.size = 0;
  ctx.now++;
  ctx.state.tick++;
  return { now, events: [...ctx.events], heroHits };
}

/** Runs to tick `to`, firing `shooter` on each tick of `fires`: every tick's record. */
function runTo(ctx: RunContext, to: number, shooter: Enemy, fires: readonly number[]): Tick[] {
  const seen: Tick[] = [];
  while (ctx.now <= to) seen.push(tick(ctx, fires.includes(ctx.now) ? [shooter] : []));
  return seen;
}

const ticksOf = (seen: readonly Tick[], type: SimEvent['type']): number[] =>
  seen.filter((t) => t.events.some((e) => e.type === type)).map((t) => t.now);

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies.find((e) => e.id === id) as Enemy;
const defence = (ctx: RunContext): PlayerDefence => ctx.sys.defence as PlayerDefence;
const pool = (ctx: RunContext) => ctx.sys.bullets;

describe('節奏閃避 (bulletDodgeSec, bulletDodgeCombo; lead ruling W5)', () => {
  it('dodges the first of two bullets 1 s apart at 15 stacks, and the second lands (§2.10 節奏閃避 test)', () => {
    // Planted bugs: no cooldown; the dodge halving the stacks.
    const ctx = placed([shooterAt()], { values: DODGE, stacks: 15 });
    const shooter = enemy(ctx, 1);
    const seen = runTo(ctx, 100, shooter, [10, 70]);
    const dodged = seen.find((t) => t.now === 10 + FLIGHT) as Tick;
    expect(dodged.events).toEqual([
      { type: 'bulletDodged', bulletId: 1, enemyId: 1, enemy: 'shooter' },
    ]);
    expect(ticksOf(seen, 'bulletDodged')).toEqual([30]);
    expect(ticksOf(seen, 'bulletHit')).toEqual([90]);
    expect(seen.filter((t) => t.heroHits > 0).map((t) => t.now)).toEqual([90]);
    expect([ctx.player.life, ctx.sys.combo.stacks]).toEqual([997, 7]);
    expect(pool(ctx).takenBy.shooter).toEqual({ hits: 1, damage: 3 });
    expect(defence(ctx).dodgeReadyAt).toBe(30 + 180);
  });

  it('keeps the stacks at a dodge and dodges nothing at 14 stacks', () => {
    const ctx = placed([shooterAt()], { values: DODGE, stacks: 15 });
    runTo(ctx, 30, enemy(ctx, 1), [10]);
    expect([ctx.sys.combo.stacks, ctx.player.life]).toEqual([15, 1000]);
    const short = placed([shooterAt()], { values: DODGE, stacks: 14 });
    const seen = runTo(short, 100, enemy(short, 1), [10, 70]);
    expect(ticksOf(seen, 'bulletDodged')).toEqual([]);
    expect(ticksOf(seen, 'bulletHit')).toEqual([30, 90]);
  });

  it('cools down exactly 180 ticks: a bullet 179 ticks after a dodge lands, one 180 after is dodged', () => {
    // Planted bug: the cooldown off by one.
    const ctx = placed([shooterAt()], { values: DODGE, stacks: 15, modules: [KEEP_ALL] });
    const seen = runTo(ctx, 400, enemy(ctx, 1), [10, 189, 190, 369, 370]);
    expect(ticksOf(seen, 'bulletDodged')).toEqual([30, 210, 390]);
    expect(ticksOf(seen, 'bulletHit')).toEqual([209, 389]);
    expect(defence(ctx).dodgeTicks).toBe(180);
    expect(ctx.sys.combo.stacks).toBe(15);
  });

  it('dodges a bullet the shield would absorb whole, leaving the shield alone', () => {
    const ctx = placed([shooterAt()], { values: DODGE, stacks: 15 });
    ctx.player.shield = 50;
    const seen = runTo(ctx, 30, enemy(ctx, 1), [10]);
    expect(ticksOf(seen, 'bulletDodged')).toEqual([30]);
    expect(seen.flatMap((t) => t.events.filter((e) => e.type === 'shieldAbsorbed'))).toEqual([]);
    expect([ctx.player.shield, ctx.player.life]).toEqual([50, 1000]);
    expect(pool(ctx).takenBy.shooter).toEqual({ hits: 0, damage: 0 });
  });

  it('is off unless both stats are above 0', () => {
    for (const values of [{ bulletDodgeSec: 3 }, { bulletDodgeCombo: 15 }]) {
      const ctx = placed([shooterAt()], { values, stacks: 20 });
      const seen = runTo(ctx, 30, enemy(ctx, 1), [10]);
      expect(ticksOf(seen, 'bulletHit'), JSON.stringify(values)).toEqual([30]);
      expect(defence(ctx).dodgeCombo, JSON.stringify(values)).toBe(Infinity);
    }
  });

  it('keeps the combo stacks for bulletDodgeCombo alone, with no combo source (BuildFlags.combo)', () => {
    const flags = (values: Partial<Record<StatId, number>>): boolean =>
      compileBuild(makeStats(values), []).flags.combo;
    expect(flags({ bulletDodgeCombo: 15 })).toBe(true);
    expect(flags({ bulletDodgeCombo: 15, bulletDodgeSec: 3 })).toBe(true);
    expect(flags({ bulletDodgeSec: 3 })).toBe(false);
    expect(flags({})).toBe(false);
  });
});

describe('攔截軌道 (orbitBlocksBullets; lead ruling W6)', () => {
  /** The build's orbit emitters. */
  const orbits = (ctx: RunContext): EmitterRuntime[] =>
    ctx.emitters.filter((em) => em.spec.kind === 'orbit');

  /** Orb o of `em` on tick `now`, as orbit.ts places it. */
  const orbAt = (ctx: RunContext, em: EmitterRuntime, o: number, now: number): [number, number] => {
    const spec = em.spec as OrbitSpec;
    const n = (em.orbs as { n: number }).n;
    const a = 2 * Math.PI * (spec.revPerSec * (now / TICK_RATE) + o / n);
    return [ctx.player.x + spec.radius * Math.cos(a), ctx.player.y + spec.radius * Math.sin(a)];
  };

  /** A bullet of the shooter at (x, y) on tick ctx.now, stepped alone: blocked or not. */
  function blockedAt(ctx: RunContext, shooter: Enemy, x: number, y: number): boolean {
    const p = pool(ctx);
    p.count = 0;
    fireBullet(ctx, shooter);
    p.x[0] = x;
    p.y[0] = y;
    ctx.events.length = 0;
    stepBullets(ctx);
    const blocked = ctx.events.some((e) => e.type === 'bulletBlocked');
    expect(p.count, `${x}, ${y}`).toBe(blocked ? 0 : 1);
    p.count = 0;
    return blocked;
  }

  it('stops a bullet that touches an orb, with bulletBlocked, and lets one just outside fly on (§2.10 攔截軌道 test)', () => {
    const ctx = placed([shooterAt(400)], {
      values: { orbitBlocksBullets: 1 },
      grants: [ORBIT, OUTER_RING],
    });
    const shooter = enemy(ctx, 1);
    const [inner, outer] = orbits(ctx) as [EmitterRuntime, EmitterRuntime];
    expect(pool(ctx).blockers).toEqual([inner, outer]);
    ctx.now = 37;
    const reach = (inner.spec as OrbitSpec).orbRadius + BULLET_RADIUS;
    for (const [em, o] of [
      [inner, 0],
      [inner, 2],
      [outer, 1],
    ] as const) {
      const [ox, oy] = orbAt(ctx, em, o, ctx.now);
      expect(blockedAt(ctx, shooter, ox + reach - 0.01, oy), `${o}`).toBe(true);
      expect(blockedAt(ctx, shooter, ox, oy - reach + 0.01), `${o}`).toBe(true);
      expect(blockedAt(ctx, shooter, ox + reach + 0.01, oy), `${o}`).toBe(false);
      expect(blockedAt(ctx, shooter, ox - reach - 0.01, oy), `${o}`).toBe(false);
    }
    // Its event: the bullet's and its shooter's ids, as bulletHit's.
    const [ox, oy] = orbAt(ctx, inner, 1, ctx.now);
    pool(ctx).count = 0;
    fireBullet(ctx, shooter);
    const id = pool(ctx).id[0];
    pool(ctx).x[0] = ox;
    pool(ctx).y[0] = oy;
    ctx.events.length = 0;
    stepBullets(ctx);
    expect(ctx.events).toEqual([
      { type: 'bulletBlocked', bulletId: id, enemyId: 1, enemy: 'shooter' },
    ]);
    expect([ctx.player.life, ctx.sys.combo.stacks]).toEqual([1000, 0]);
  });

  it('places each orb where runOrbit places it on the same tick: a bullet is blocked exactly where an enemy of its radius is hit', () => {
    // Planted bug: the orb positions a tick stale.
    const probes: PlacedEnemy[] = [];
    const spec = { radius: [110, 180], orbRadius: 12 };
    const reach = spec.orbRadius + BULLET_RADIUS;
    for (let k = 0; k < 72; k++) {
      const a = (2 * Math.PI * k) / 72;
      for (const ring of spec.radius) {
        for (const off of [-reach - 0.5, -reach + 0.5, 0, reach - 0.5, reach + 0.5]) {
          probes.push({
            x: PLAYER.x + (ring + off) * Math.cos(a),
            y: PLAYER.y + (ring + off) * Math.sin(a),
            type: 'square',
            radius: BULLET_RADIUS,
          });
        }
      }
    }
    const ctx = placed([shooterAt(400), ...probes], {
      values: { orbitBlocksBullets: 1 },
      grants: [ORBIT, OUTER_RING],
    });
    const shooter = enemy(ctx, 1);
    const probed = ctx.enemies.slice(1);
    for (const now of [1, 2, 23, 40]) {
      ctx.now = now;
      ctx.events.length = 0;
      rebuildGrid(ctx);
      for (const em of orbits(ctx)) runOrbit(ctx, em);
      const hit = new Set(ctx.events.flatMap((e) => (e.type === 'hit' ? [e.targetId] : [])));
      const blocked = new Set(
        probed.filter((e) => blockedAt(ctx, shooter, e.x, e.y)).map((e) => e.id),
      );
      expect(blocked, `tick ${now}`).toEqual(hit);
      expect(hit.size, `tick ${now}`).toBeGreaterThan(5);
      expect(hit.size, `tick ${now}`).toBeLessThan(probed.length / 2);
      // Each orb's cooldown is a fresh one on the next tick probed.
      for (const em of orbits(ctx)) em.orbs?.count.fill(0);
    }
  });

  it('blocks nothing with orbitBlocksBullets 0 or without an orbit emitter', () => {
    for (const options of [
      { grants: [ORBIT] },
      { values: { orbitBlocksBullets: 1 } },
      { values: { orbitBlocksBullets: 1 }, grants: [THORNS] },
    ]) {
      const ctx = placed([shooterAt(400)], options);
      expect(pool(ctx).blockers, JSON.stringify(options)).toEqual([]);
      const orbit = orbits(ctx)[0];
      ctx.now = 37;
      const [x, y] =
        orbit === undefined ? [PLAYER.x + 110, PLAYER.y] : orbAt(ctx, orbit, 0, ctx.now);
      expect(blockedAt(ctx, enemy(ctx, 1), x, y), JSON.stringify(options)).toBe(false);
    }
  });
});

describe('反射 (reflectBullets; lead ruling W7)', () => {
  it('turns a bullet at the player, dealing nothing, back towards its shooter at its own speed', () => {
    const ctx = placed([shooterAt(100, Math.PI / 3)], {
      values: { reflectBullets: 1, ...DODGE },
      stacks: 15,
    });
    const shooter = enemy(ctx, 1);
    const seen = runTo(ctx, 10 + FLIGHT, shooter, [10]);
    const p = pool(ctx);
    expect([p.count, p.reflected[0]]).toEqual([1, 1]);
    // It aimed at the shooter from where it turned, and flew one step there.
    const [bx, by] = [p.prevX[0] as number, p.prevY[0] as number];
    const d = Math.hypot(shooter.x - bx, shooter.y - by);
    expect(p.vx[0]).toBeCloseTo(((shooter.x - bx) / d) * STEP, 12);
    expect(p.vy[0]).toBeCloseTo(((shooter.y - by) / d) * STEP, 12);
    expect(Math.hypot(p.vx[0] as number, p.vy[0] as number)).toBeCloseTo(STEP, 12);
    for (const type of ['bulletHit', 'bulletDodged', 'bulletBlocked', 'playerHit'] as const) {
      expect(ticksOf(seen, type), type).toEqual([]);
    }
    expect(seen.some((t) => t.heroHits > 0)).toBe(false);
    expect([ctx.player.life, ctx.sys.combo.stacks, defence(ctx).dodgeReadyAt]).toEqual([
      1000, 15, 0,
    ]);
    expect(p.takenBy.shooter).toEqual({ hits: 0, damage: 0 });
  });

  it('gives its shooter one hit of the first thorns payload when it arrives, within a step of it', () => {
    const ctx = placed([shooterAt(100, Math.PI / 3, { hp: 1000 })], {
      values: { reflectBullets: 1 },
      grants: [THORNS],
    });
    const shooter = enemy(ctx, 1);
    const seen = runTo(ctx, 10 + FLIGHT, shooter, [10]);
    const p = pool(ctx);
    // From where it turned, the ticks until its shooter is within a step at a tick's start.
    let d = Math.hypot(shooter.x - (p.prevX[0] as number), shooter.y - (p.prevY[0] as number));
    let back = 0;
    while (d > STEP) {
      d -= STEP;
      back++;
    }
    seen.push(...runTo(ctx, 10 + FLIGHT + back + 5, shooter, []));
    const hits = seen.flatMap((t) =>
      t.events.flatMap((e) => (e.type === 'hit' ? [[t.now, e.targetId, toNumber(e.amount)]] : [])),
    );
    expect(hits).toEqual([[10 + FLIGHT + back, 1, 30]]);
    expect([p.count, toNumber(shooter.hp)]).toEqual([0, 970]);
  });

  it('deals nothing to its shooter on arrival without a thorns payload', () => {
    const ctx = placed([shooterAt(100, 0, { hp: 1000 })], { values: { reflectBullets: 1 } });
    const shooter = enemy(ctx, 1);
    const seen = runTo(ctx, 80, shooter, [10]);
    expect(seen.flatMap((t) => t.events.filter((e) => e.type !== 'bulletFired'))).toEqual([]);
    expect([pool(ctx).count, toNumber(shooter.hp)]).toEqual([0, 1000]);
  });

  it('homes on its shooter’s place of each tick', () => {
    const ctx = placed([shooterAt(100)], { values: { reflectBullets: 1 } });
    const shooter = enemy(ctx, 1);
    runTo(ctx, 10 + FLIGHT, shooter, [10]);
    // Pushed out and around (it stands, so movement keeps it there), the shooter is aimed at
    // where it is now.
    const dist = Math.hypot(50, 150);
    Object.assign(shooter, { dist, ux: 50 / dist, uy: 150 / dist });
    shooter.x = PLAYER.x + 50;
    shooter.y = PLAYER.y + 150;
    tick(ctx);
    const p = pool(ctx);
    const [bx, by] = [p.prevX[0] as number, p.prevY[0] as number];
    const d = Math.hypot(shooter.x - bx, shooter.y - by);
    expect(p.vx[0]).toBeCloseTo(((shooter.x - bx) / d) * STEP, 12);
    expect(p.vy[0]).toBeCloseTo(((shooter.y - by) / d) * STEP, 12);
  });

  it('aims at its shooter’s place of the tick it turns, though the shooter moved while it flew', () => {
    // Planted bug: the bullet turned by flipping its velocity, homing only from the next tick.
    const ctx = placed([shooterAt(100)], { values: { reflectBullets: 1 } });
    const shooter = enemy(ctx, 1);
    runTo(ctx, 15, shooter, [10]);
    const dist = Math.hypot(60, 120);
    Object.assign(shooter, { dist, ux: 60 / dist, uy: 120 / dist });
    shooter.x = PLAYER.x + 60;
    shooter.y = PLAYER.y + 120;
    runTo(ctx, 10 + FLIGHT, shooter, []);
    const p = pool(ctx);
    expect(p.reflected[0]).toBe(1);
    const [bx, by] = [p.prevX[0] as number, p.prevY[0] as number];
    const d = Math.hypot(shooter.x - bx, shooter.y - by);
    expect(p.vx[0]).toBeCloseTo(((shooter.x - bx) / d) * STEP, 12);
    expect(p.vy[0]).toBeCloseTo(((shooter.y - by) / d) * STEP, 12);
  });

  it('is gone without an event once its shooter is dead or off the field', () => {
    for (const how of ['dead', 'compacted'] as const) {
      const ctx = placed([shooterAt(100)], { values: { reflectBullets: 1 }, grants: [THORNS] });
      const shooter = enemy(ctx, 1);
      runTo(ctx, 10 + FLIGHT, shooter, [10]);
      expect(pool(ctx).count).toBe(1);
      if (how === 'dead') shooter.alive = false;
      else {
        removeEnemy(ctx, shooter);
        compact(ctx);
      }
      const t = tick(ctx);
      expect([pool(ctx).count, t.events], how).toEqual([0, []]);
    }
  });

  it('finds its shooter by id once other enemies left the field before it (never by a slot)', () => {
    // Planted bug: the shooter found by its slot (ctx.enemies' index), which a compaction moves.
    const ctx = placed(
      [
        { x: PLAYER.x - 300, y: PLAYER.y, type: 'square', hp: 1000 },
        shooterAt(100, 0, { hp: 1000 }),
        { x: PLAYER.x + 200, y: PLAYER.y + 200, type: 'square', hp: 1000 },
        { x: PLAYER.x - 200, y: PLAYER.y - 200, type: 'square', hp: 1000 },
      ],
      { values: { reflectBullets: 1 }, grants: [THORNS] },
    );
    const shooter = enemy(ctx, 2);
    runTo(ctx, 10 + FLIGHT, shooter, [10]);
    removeEnemy(ctx, enemy(ctx, 1));
    const seen = runTo(ctx, 80, shooter, []);
    const hits = seen.flatMap((t) =>
      t.events.flatMap((e) => (e.type === 'hit' ? [e.targetId] : [])),
    );
    expect(hits).toEqual([2]);
    expect(ctx.enemies.map((e) => e.id)).toEqual([2, 3, 4]);
  });

  it('keeps its flag through a slot move and the pool’s growth', () => {
    // Planted bug: the flag lost in moveSlot or growBullets.
    const ctx = placed([shooterAt(100), shooterAt(120, Math.PI / 2), shooterAt(400, Math.PI)], {
      values: { reflectBullets: 1 },
      grants: [THORNS],
    });
    const [near, mid, far] = [enemy(ctx, 1), enemy(ctx, 2), enemy(ctx, 3)];
    // The near shooter's bullet takes slot 0 and turns at tick 21; the next one's, from 120,
    // slot 1, turning at 28, before the first is home.
    tick(ctx, [near]);
    tick(ctx, [mid]);
    const p = pool(ctx);
    runTo(ctx, 27, near, []);
    expect([p.count, Array.from(p.reflected.subarray(0, 2))]).toEqual([2, [1, 0]]);
    tick(ctx);
    expect(Array.from(p.reflected.subarray(0, 2))).toEqual([1, 1]);
    // Grown past 16 slots, the pool keeps both flags.
    for (let k = 0; k < 20; k++) fireBullet(ctx, far);
    expect(p.id.length).toBeGreaterThanOrEqual(32);
    expect(Array.from(p.reflected.subarray(0, p.count))).toEqual([1, 1, ...Array(20).fill(0)]);
    // The near one arrives home first: the far one moves down to slot 0, still reflected.
    let t = tick(ctx);
    while (!t.events.some((e) => e.type === 'hit' && e.targetId === near.id) && t.now < 200) {
      t = tick(ctx);
    }
    expect(t.now).toBeLessThan(200);
    expect([p.id[0], p.reflected[0], p.reflected[1]]).toEqual([2, 1, 0]);
    growBullets(p);
    expect(p.reflected[0]).toBe(1);
  });

  it('is never dodged, blocked or counted at the player again, and never spends the dodge', () => {
    // Planted bug: the dodge spent on a reflected bullet.
    const ctx = placed([shooterAt(400)], {
      values: { reflectBullets: 1, orbitBlocksBullets: 1, ...DODGE },
      grants: [ORBIT],
      stacks: 15,
    });
    const shooter = enemy(ctx, 1);
    const p = pool(ctx);
    const orbit = ctx.emitters.find((em) => em.spec.kind === 'orbit') as EmitterRuntime;
    fireBullet(ctx, shooter);
    p.reflected[0] = 1;
    // On an orb of this tick, then within reach of the player with the dodge ready.
    const spec = orbit.spec as OrbitSpec;
    const a = 2 * Math.PI * spec.revPerSec * (ctx.now / TICK_RATE);
    p.x[0] = ctx.player.x + spec.radius * Math.cos(a);
    p.y[0] = ctx.player.y + spec.radius * Math.sin(a);
    ctx.events.length = 0;
    stepBullets(ctx);
    p.x[0] = ctx.player.x + 10;
    p.y[0] = ctx.player.y;
    stepBullets(ctx);
    expect(ctx.events).toEqual([]);
    expect([p.count, p.reflected[0], defence(ctx).dodgeReadyAt, ctx.player.life]).toEqual([
      1, 1, 0, 1000,
    ]);
  });
});

describe('反射 at a dead player, in a reused slot, and on its arrival (second review)', () => {
  /** 129 standing squares far off on an ellipse around the player, as bullets.test.ts' Y5. */
  const farSquares = (): PlacedEnemy[] =>
    Array.from({ length: 129 }, (_, k) => ({
      x: PLAYER.x + 500 * Math.cos((k / 129) * 2 * Math.PI),
      y: PLAYER.y + 330 * Math.sin((k / 129) * 2 * Math.PI),
      type: 'square',
    }));

  /** placedEnemies on shooterData() with reflectBullets, these triggers and emitters. */
  const reflecting = (
    enemies: readonly PlacedEnemy[],
    triggers: readonly TriggerSpec[],
    emitters: readonly SourcedEmitter[],
  ): RunContext =>
    placedEnemies(enemies, {
      stats: makeStats({ critChance: 0, igniteChance: 0, maxLife: 1000, reflectBullets: 1 }, [], {
        triggers: triggers.map((spec) => ({ source: 'center', spec })),
        conversions: [],
        emitters,
      }),
      data: shooterData(),
    });

  it('fires every bullet unreflected, though its slot last held a reflected bullet that went home', () => {
    const ctx = placed([shooterAt(100, 0, { hp: 1000 })], {
      values: { reflectBullets: 1 },
      grants: [THORNS],
    });
    const shooter = enemy(ctx, 1);
    const p = pool(ctx);
    runTo(ctx, 80, shooter, [10]);
    // The first bullet turned, went home and hit; slot 0 is free again.
    expect([p.count, toNumber(shooter.hp)]).toEqual([0, 970]);
    const t = tick(ctx, [shooter]);
    // The next one takes slot 0, flies at the player and hits nothing.
    expect([p.count, p.reflected[0]]).toEqual([1, 0]);
    expect(t.events.filter((e) => e.type === 'hit')).toEqual([]);
    expect(toNumber(shooter.hp)).toBe(970);
    expect(Math.hypot((p.x[0] as number) - PLAYER.x, (p.y[0] as number) - PLAYER.y)).toBeCloseTo(
      100 - STEP,
      9,
    );
  });

  it('turns no bullet once the player is dead: it is gone, as it would be without 反射', () => {
    const ctx = placed([shooterAt(100)], { values: { reflectBullets: 1, ...DODGE }, stacks: 15 });
    const p = pool(ctx);
    fireBullet(ctx, enemy(ctx, 1));
    p.x[0] = ctx.player.x + 10;
    p.y[0] = ctx.player.y;
    ctx.player.life = 0;
    ctx.events.length = 0;
    stepBullets(ctx);
    expect([p.count, p.reflected[0], defence(ctx).dodgeReadyAt, ctx.events]).toEqual([0, 0, 0, []]);
  });

  it('hits its shooter with the first thorns emitter’s payload, by the call a contact’s thorns hit makes (origin −1)', () => {
    // A hit trigger at index 1, after the shatter's 0: a hit made with origin 1, that trigger's
    // own, would skip it.
    const onHit: TriggerSpec = { on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] };
    const ctx = reflecting(
      [shooterAt(100, 0, { hp: 1000 })],
      [onHit],
      [
        { source: 'outer.thorns', grant: { kind: 'thorns', damagePct: 1 } },
        { source: 'outer.aura', grant: { kind: 'thorns', damagePct: 4 } },
      ],
    );
    const [first, second] = ctx.thornsEmitters as [EmitterRuntime, EmitterRuntime];
    const base = (em: EmitterRuntime): number => toNumber(em.payload.baseDamage);
    expect(base(first)).not.toBe(base(second));
    const shooter = enemy(ctx, 1);
    const seen = runTo(ctx, 80, shooter, [10]);
    const hits = seen.flatMap((t) =>
      t.events.flatMap((e) => (e.type === 'hit' ? [[t.now, e.targetId, toNumber(e.amount)]] : [])),
    );
    expect(hits.map(([, id, amount]) => [id, amount])).toEqual([[1, base(first)]]);
    const arrival = (hits[0] as number[])[0];
    // Its hit trigger fired on the arrival's tick: one heal queued.
    expect(seen.filter((t) => t.heroHits > 0).map((t) => [t.now, t.heroHits])).toEqual([
      [arrival, 1],
    ]);
  });

  it('kills a frozen shooter with its shatter, as a contact’s thorns kill does (no trigger’s origin)', () => {
    // frostOnHit lets the build freeze, so the shatter (trigger 0) listens to kills; a kill made
    // with origin 0 would skip it.
    const ctx = placed([shooterAt(100, 0, { hp: 30 })], {
      values: { reflectBullets: 1, frostOnHit: 1e-9 },
      grants: [THORNS],
    });
    const shooter = enemy(ctx, 1);
    shooter.frozenUntil = 1000;
    runTo(ctx, 80, shooter, [10]);
    expect(shooter.alive).toBe(false);
    expect(
      ctx.pendingKills.slice(0, ctx.pendingCount).map((k) => [k.trigger, k.victim.id]),
    ).toEqual([[0, 1]]);
  });

  it('rebuilds the grid before its arrival’s hit triggers query it, which a compaction left stale', () => {
    const nearest: TriggerSpec = {
      on: 'hit',
      target: { pick: 'nearest', excludeEventTarget: true },
      do: [{ kind: 'heal', lifePct: 0.01 }],
    };
    // The shooter, 129 squares far off, then one 80 from the shooter, the nearest to it: 131
    // enemies, so the grid sorts them into its cells.
    const ctx = reflecting(
      [shooterAt(100, 0, { hp: 1000 }), ...farSquares(), { x: PLAYER.x + 100, y: PLAYER.y + 80 }],
      [nearest],
      [THORNS],
    );
    const shooter = enemy(ctx, 1);
    const near = ctx.enemies.at(-1) as Enemy;
    runTo(ctx, 10 + FLIGHT, shooter, [10]);
    expect(pool(ctx).reflected[0]).toBe(1);
    // A query sorts the grid; then a square dies and the arrays compact, as at a tick's end,
    // moving every later enemy down a slot.
    expect(ctx.grid.nearest(shooter.x, shooter.y, Infinity, (e) => e !== shooter)).toBe(near);
    removeEnemy(ctx, ctx.enemies[1] as Enemy);
    compact(ctx);
    runTo(ctx, 80, shooter, []);
    expect([pool(ctx).count, toNumber(shooter.hp)]).toEqual([0, 970]);
    expect(ctx.selected).toBe(near);
  });
});

describe('反射’s kill of its shooter (verification)', () => {
  it('credits its kill of the shooter to no trigger: no killShards on its drop', () => {
    // A hit given a trigger's origin credits that trigger's killShards (killEnemy indexes
    // triggers[origin], C6b.3).
    const greedy: TriggerSpec = {
      on: 'hit',
      when: [{ hitIs: 'signature' }],
      do: [{ kind: 'heal', lifePct: 0.01 }],
      killShards: 1,
    };
    const ctx = placedEnemies([shooterAt(100, 0, { hp: 1 })], {
      stats: makeStats({ critChance: 0, igniteChance: 0, maxLife: 1000, reflectBullets: 1 }, [], {
        triggers: [...TRIGGERS, greedy].map((spec) => ({ source: 'center', spec })),
        conversions: [],
        emitters: [THORNS],
      }),
      data: shooterData(),
    });
    expect(ctx.build.triggers.map((t) => t.killShards)).toEqual([0, 0, 1]);
    const shooter = enemy(ctx, 1);
    const v = shooter.v3 as { readonly dropScale: number };
    const drop = toNumber(
      mul(
        mul(mul(num(shooter.def.dropMult), shooter.rec.shardsPerStd), ctx.shardGain),
        v.dropScale,
      ),
    );
    const seen = runTo(ctx, 120, shooter, [10]);
    const kills = seen.flatMap((t) =>
      t.events.flatMap((e) => (e.type === 'enemyKilled' ? [toNumber(e.shards)] : [])),
    );
    expect(kills).toHaveLength(1);
    expect(kills[0]).toBeCloseTo(drop, 9);
  });
});
