/**
 * The shooters' bullets (docs/v3 C7 design §2.6, src/sim/systems/bullets.ts) and damagePlayer's
 * bullet branch (src/sim/systems/contact.ts): firing, travel and hits, the player's defences and
 * the per-type tally, the pool's order and growth, and RunResult.bulletTakenBy. §2.6's OWN tests
 * 2 to 6 are named in their titles, each with a comment naming the planted bug it kills; the rest
 * pin the lead's rulings Y3, Y5 and Y6. Placed shooters stand (speed 0) inside their post
 * unless a test says, so each stops on tick 1 and fires first on tick 121; tick() runs one tick's
 * enemy AI and movement stages, as step does.
 */

import { describe, expect, it } from 'vitest';
import type { StatExtras, StatId } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import { ENEMY_IDS } from '../../data/types';
import type { EnemyBehaviour, EnemyId, GameData } from '../../data/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  centerTriggers,
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  TEST_ENEMIES,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import type { PlacedEnemy, TestDataOverrides } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, NO_INPUT, PLAYER_RADIUS } from '../types';
import type { SimEvent } from '../types';
import { BULLET_RADIUS } from './bullets';
import { BULLET, CONTACT, damagePlayer } from './contact';
import type { Enemy, RunContext } from './context';
import { compact, removeEnemy } from './death';
import { stepEnemyAi } from './enemyAi';
import { moveEnemies } from './movement';

type ShootBehaviour = Extract<EnemyBehaviour, { readonly kind: 'shoot' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/** The shooter's def's behaviour: stopDist 300, periodSec 2, bulletSpeed 200, bulletDamage 3. */
const SHOOT = TEST_ENEMIES.shooter.behaviour as ShootBehaviour;

/** The ticks a bullet fired at distance d flies before it hits (docs/v3 C7 design §2.6). */
const flight = (d: number): number => Math.ceil((d - 36) / (200 / 60));

/**
 * A v3 table whose waves hold no enemy, elite, boss, affix or treasure (docs/v3 C7 design §1.9),
 * so that only placed enemies exist, with the shooter's behaviour over its def's.
 */
function shooterData(
  behaviour: Partial<ShootBehaviour> = {},
  enemies: NonNullable<TestDataOverrides['enemies']> = {},
): GameData {
  return v3TestData({
    enemies: { ...enemies, shooter: { ...enemies.shooter, behaviour: { ...SHOOT, ...behaviour } } },
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
}

/** A shooter `d` from the player at bearing `angle`, standing unless `more` gives it a speed. */
const shooterAt = (
  d: number,
  angle = 0,
  more: Omit<PlacedEnemy, 'x' | 'y' | 'type'> = {},
): PlacedEnemy => ({
  x: PLAYER.x + d * Math.cos(angle),
  y: PLAYER.y + d * Math.sin(angle),
  type: 'shooter',
  ...more,
});

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly extras?: StatExtras;
  readonly data?: GameData;
}

/** placedEnemies on shooterData() unless `options.data`, with these stats. */
function placed(enemies: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(enemies, {
    stats: makeStats(options.values ?? { maxLife: 1e6 }, [], options.extras),
    data: options.data ?? shooterData(),
  });
}

/**
 * Runs tick ctx.now's enemy AI and movement stages, as step runs them (no contact, hits or
 * deaths), and moves on to the next tick: the tick's events.
 */
function tick(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepEnemyAi(ctx);
  moveEnemies(ctx);
  const events = [...ctx.events];
  ctx.now++;
  ctx.state.tick++;
  return events;
}

/** Ticks until tick `to` has run: each tick's events, by tick. */
function runTo(ctx: RunContext, to: number): Map<number, SimEvent[]> {
  const byTick = new Map<number, SimEvent[]>();
  while (ctx.now <= to) {
    const now = ctx.now;
    const events = tick(ctx);
    if (events.length > 0) byTick.set(now, events);
  }
  return byTick;
}

/** The ticks of `byTick` with an event of `type`. */
const ticksOf = (byTick: Map<number, SimEvent[]>, type: SimEvent['type']): number[] =>
  [...byTick].filter(([, events]) => events.some((e) => e.type === type)).map(([t]) => t);

/** The pool's live ids, slot order. */
const liveIds = (ctx: RunContext): number[] =>
  Array.from(ctx.sys.bullets.id.subarray(0, ctx.sys.bullets.count));

/** The queued effects (CompiledBuild.effects indices), oldest first. */
function queuedEffects(ctx: RunContext): number[] {
  const q = ctx.effectQueue;
  return Array.from({ length: q.size }, (_, n) => q.effect[(q.head + n) & q.capMask] as number);
}

describe('the bullets (docs/v3 C7 design §2.6)', () => {
  it('fires from the shooter straight at the player, bulletSpeed × DT a tick, with its id, type and damage (Y5)', () => {
    const ctx = placed([shooterAt(250, 0.7)]);
    const shooter = ctx.enemies[0] as Enemy;
    const byTick = runTo(ctx, 121);
    expect(ticksOf(byTick, 'bulletFired')).toEqual([121]);
    expect(eventsOf([...byTick.values()], 'bulletFired')).toEqual([
      { type: 'bulletFired', bulletId: 1, enemyId: shooter.id, x: shooter.x, y: shooter.y },
    ]);
    const pool = ctx.sys.bullets;
    expect(ctx.state.bullets).toBe(pool);
    expect([pool.count, ctx.state.bulletCount, pool.nextId]).toEqual([1, 1, 2]);
    expect([pool.id[0], pool.owner[0], pool.ownerType[0], pool.damage[0]]).toEqual([
      1,
      shooter.id,
      ENEMY_IDS.indexOf('shooter'),
      3,
    ]);
    // Inwards along the shooter's bearing, 200 a second, and one step flown on its fire tick.
    const vx = pool.vx[0] as number;
    const vy = pool.vy[0] as number;
    expect(Math.hypot(vx, vy)).toBeCloseTo(200 * DT, 12);
    expect(vx / Math.hypot(vx, vy)).toBeCloseTo(-Math.cos(0.7), 12);
    expect(vy / Math.hypot(vx, vy)).toBeCloseTo(-Math.sin(0.7), 12);
    expect([pool.prevX[0], pool.prevY[0]]).toEqual([shooter.x, shooter.y]);
    expect([pool.x[0], pool.y[0]]).toEqual([shooter.x + vx, shooter.y + vy]);
    expect(BULLET_RADIUS).toBe(6);
  });

  it('hits ceil((d − 36) / (200/60)) ticks after its fire tick when fired at distance d (§2.6 OWN test 2)', () => {
    // Planted bug: the speed per second applied per tick (no × DT). Each d is at least 0.1 of a
    // tick from a whole flight, so the bullets' float steps cannot tip a case.
    const cases: [number, number][] = [
      [300, 0],
      [250, 2.1],
      [437, -2.6],
      [500, 4],
      [101, Math.PI / 2],
    ];
    for (const [d, angle] of cases) {
      const ticks = (d - 36) / (200 / 60);
      expect(Math.abs(ticks - Math.round(ticks)), `d ${d}`).toBeGreaterThanOrEqual(0.1);
      const ctx = placed([shooterAt(d, angle)], { data: shooterData({ stopDist: 600 }) });
      const byTick = runTo(ctx, 121 + flight(d) + 1);
      // A flight over 120 ticks sees the next bullet fired on tick 241.
      expect(ticksOf(byTick, 'bulletFired')[0], `d ${d}`).toBe(121);
      expect(ticksOf(byTick, 'bulletHit'), `d ${d}`).toEqual([121 + flight(d)]);
      const hits = eventsOf([byTick.get(121 + flight(d)) ?? []], 'bulletHit');
      expect(hits.map((e) => e.bulletId)).toEqual([1]);
    }
    expect([flight(300), flight(250), flight(437), flight(500), flight(101)]).toEqual([
      80, 65, 121, 140, 20,
    ]);
    expect(PLAYER_RADIUS + BULLET_RADIUS).toBe(36);
  });

  it('hits a player exactly PLAYER_RADIUS + BULLET_RADIUS away: the reach is ≤, not < (§2.6)', () => {
    // Planted bug: the hit test's ≤ narrowed to <, which a bullet exactly at reach flies through.
    const ctx = placed([shooterAt(36)]);
    const shooter = ctx.enemies[0] as Enemy;
    expect([shooter.x - PLAYER.x, shooter.y - PLAYER.y]).toEqual([
      PLAYER_RADIUS + BULLET_RADIUS,
      0,
    ]);
    expect(flight(36)).toBe(0);
    const byTick = runTo(ctx, 122);
    // Fired from exactly the reach, it hits on its fire tick, before it ever moves.
    expect(ticksOf(byTick, 'bulletFired')).toEqual([121]);
    expect(ticksOf(byTick, 'bulletHit')).toEqual([121]);
    expect(eventsOf([byTick.get(121) ?? []], 'bulletHit').map((e) => e.damage)).toEqual([3]);
    expect(liveIds(ctx)).toEqual([]);
  });

  it('keeps each bullet’s last position as prevX/prevY and flies it its velocity a tick (Y5)', () => {
    const ctx = placed([shooterAt(280, -0.4)]);
    runTo(ctx, 121);
    const pool = ctx.sys.bullets;
    for (let k = 0; k < 5; k++) {
      const [x, y] = [pool.x[0] as number, pool.y[0] as number];
      tick(ctx);
      expect([pool.prevX[0], pool.prevY[0]]).toEqual([x, y]);
      expect([pool.x[0], pool.y[0]]).toEqual([
        x + (pool.vx[0] as number),
        y + (pool.vy[0] as number),
      ]);
    }
  });

  it('passes a drone and an enemy on its path (§2.6 OWN test 6)', () => {
    // Planted bug: a target lookup, the bullet stopped by what stands in its way.
    const drone: StatExtras = {
      triggers: [],
      conversions: [],
      emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 1 } }],
    };
    const ctx = placed([shooterAt(300), { x: PLAYER.x + 150, y: PLAYER.y, type: 'square' }], {
      values: { maxLife: 1e6 },
      extras: drone,
    });
    const square = ctx.enemies[1] as Enemy;
    const drones = ctx.sys.drones;
    expect(drones.count).toBe(1);
    drones.x[0] = drones.prevX[0] = PLAYER.x + 100;
    drones.y[0] = drones.prevY[0] = PLAYER.y;
    const hp = square.hp;
    const byTick = runTo(ctx, 121 + flight(300));
    expect(ticksOf(byTick, 'bulletHit')).toEqual([121 + flight(300)]);
    expect([square.alive, square.hp, eventsOf([...byTick.values()], 'hit')]).toEqual([
      true,
      hp,
      [],
    ]);
    expect([drones.x[0], drones.y[0]]).toEqual([PLAYER.x + 100, PLAYER.y]);
  });

  it('frees each bullet that hits and keeps the rest in id order, never the last moved into its slot (Y5)', () => {
    // Four shooters fire once, on tick 601 (a period of 10 s), ids 1 to 4; the nearest's bullet
    // (1) hits first.
    const t0 = 601;
    const starts: [number, number][] = [
      [100, 0],
      [500, 1],
      [450, 2],
      [400, 3],
    ];
    const ctx = placed(
      starts.map(([d, angle]) => shooterAt(d, angle)),
      { data: shooterData({ stopDist: 600, periodSec: 10 }) },
    );
    const byTick = runTo(ctx, t0);
    expect(liveIds(ctx)).toEqual([1, 2, 3, 4]);
    const pool = ctx.sys.bullets;
    // Each bullet's own path: its start, flown once a tick from its fire tick.
    const at = (id: number, now: number): [number, number] => {
      const [d, angle] = starts[id - 1] as [number, number];
      const step = 200 * DT;
      const k = now - t0 + 1;
      return [
        PLAYER.x + (d - k * step) * Math.cos(angle),
        PLAYER.y + (d - k * step) * Math.sin(angle),
      ];
    };
    const order: number[][] = [];
    for (let now = t0 + 1; now <= t0 + flight(500); now++) {
      const events = tick(ctx);
      for (const e of events) if (e.type === 'bulletHit') order.push([now, e.bulletId]);
      for (let s = 0; s < pool.count; s++) {
        const [x, y] = at(pool.id[s] as number, now);
        expect(pool.x[s] as number).toBeCloseTo(x, 9);
        expect(pool.y[s] as number).toBeCloseTo(y, 9);
      }
      const ids = liveIds(ctx);
      expect(ids, `tick ${now}`).toEqual([...ids].sort((a, b) => a - b));
      if (now === t0 + flight(100)) expect(ids).toEqual([2, 3, 4]);
    }
    expect(order).toEqual([
      [t0 + flight(100), 1],
      [t0 + flight(400), 4],
      [t0 + flight(450), 3],
      [t0 + flight(500), 2],
    ]);
    expect([pool.count, ctx.state.bulletCount]).toEqual([0, 0]);
    expect(ticksOf(byTick, 'bulletFired')).toEqual([t0]);
  });

  it('flies on when its shooter dies, and a shooter dead on its due tick fires nothing (§2.6)', () => {
    // Planted bug: a dead shooter's bullets removed with it.
    const ctx = placed([shooterAt(250), shooterAt(260, Math.PI)]);
    const [first, second] = ctx.enemies as [Enemy, Enemy];
    runTo(ctx, 121);
    expect(liveIds(ctx)).toEqual([1, 2]);
    removeEnemy(ctx, first);
    compact(ctx);
    const byTick = runTo(ctx, 240);
    // The second dies at its next due tick, before the step.
    removeEnemy(ctx, second);
    compact(ctx);
    for (const [now, events] of runTo(ctx, 400)) byTick.set(now, events);
    expect(
      eventsOf([...byTick.values()], 'bulletHit').map((e) => [e.bulletId, e.enemyId, e.enemy]),
    ).toEqual([
      [1, first.id, 'shooter'],
      [2, second.id, 'shooter'],
    ]);
    expect(ticksOf(byTick, 'bulletHit')).toEqual([121 + flight(250), 121 + flight(260)]);
    expect(ticksOf(byTick, 'bulletFired')).toEqual([]);
    expect(ctx.sys.enemyAi.list).toEqual([]);
  });

  it('hits only a live player: a bullet that reaches a dead one is freed without a hit (Y5)', () => {
    // Two bullets reach the player on one tick; the first kills (no extra life).
    const ctx = placed([shooterAt(200), shooterAt(200, Math.PI)], { values: { maxLife: 3 } });
    expect(ctx.sys.defence).toBeNull();
    const byTick = runTo(ctx, 121 + flight(200));
    const hits = eventsOf([...byTick.values()], 'bulletHit');
    expect(hits).toEqual([
      { type: 'bulletHit', bulletId: 1, enemyId: 1, enemy: 'shooter', damage: 3, lifeLeft: 0 },
    ]);
    expect(ctx.sys.bullets.count).toBe(0);
    expect(ctx.sys.bullets.takenBy.shooter).toEqual({ hits: 1, damage: 3 });
    expect(ctx.killedBy).toBe('shooter');
  });

  it('revive mid-volley: the bullets after the revive hit the revived life (§2.6, Y5)', () => {
    // Planted bug: an early exit after a revive. Three bullets of 6 on one tick, on 12 of life.
    const ctx = placed([shooterAt(200), shooterAt(200, 2), shooterAt(200, 4)], {
      values: { maxLife: 12, extraLives: 1 },
      data: shooterData({ bulletDamage: 6 }),
    });
    const byTick = runTo(ctx, 121 + flight(200));
    const events = byTick.get(121 + flight(200)) ?? [];
    expect(events.filter((e) => e.type === 'bulletHit' || e.type === 'revive')).toEqual([
      { type: 'bulletHit', bulletId: 1, enemyId: 1, enemy: 'shooter', damage: 6, lifeLeft: 6 },
      { type: 'bulletHit', bulletId: 2, enemyId: 2, enemy: 'shooter', damage: 6, lifeLeft: 0 },
      { type: 'revive', lifeLeft: 6, livesLeft: 0 },
      { type: 'bulletHit', bulletId: 3, enemyId: 3, enemy: 'shooter', damage: 6, lifeLeft: 0 },
    ]);
    expect([ctx.player.life, ctx.killedBy]).toEqual([0, 'shooter']);
    expect(ctx.sys.bullets.takenBy.shooter).toEqual({ hits: 3, damage: 18 });
  });

  it('raises heroHit at the player for each bullet hit, never contact (Y5)', () => {
    // heroHit queues effect 0, contact effect 1.
    const triggers: TriggerSpec[] = [
      { on: 'heroHit', do: [{ kind: 'heal', lifePct: 0.01 }] },
      { on: 'contact', do: [{ kind: 'heal', lifePct: 0.02 }] },
    ];
    const ctx = placed([shooterAt(200), shooterAt(200, Math.PI)], {
      values: { maxLife: 100 },
      extras: centerTriggers(triggers),
    });
    runTo(ctx, 121 + flight(200) - 1);
    expect(queuedEffects(ctx)).toEqual([]);
    tick(ctx);
    expect(queuedEffects(ctx)).toEqual([0, 0]);
    expect(ctx.player.life).toBe(94);
  });

  it('rebuilds the grid before a heroHit selector queries it, which last tick’s compaction left stale (Y5)', () => {
    // 129 squares far off, then one 60 below the player, the nearest of all: 131 enemies, so the
    // grid sorts them into its cells. Then the second dies and the arrays compact, as at a tick's
    // end, moving every later enemy down a slot.
    const far: PlacedEnemy[] = Array.from({ length: 129 }, (_, k) => ({
      x: PLAYER.x + 500 * Math.cos((k / 129) * 2 * Math.PI),
      y: PLAYER.y + 330 * Math.sin((k / 129) * 2 * Math.PI),
      type: 'square',
    }));
    const nearest: TriggerSpec = {
      on: 'heroHit',
      target: { pick: 'nearest' },
      do: [{ kind: 'heal', lifePct: 0.01 }],
    };
    const ctx = placed(
      [shooterAt(100), ...far, { x: PLAYER.x, y: PLAYER.y + 60, type: 'square' }],
      { values: { maxLife: 100 }, extras: centerTriggers([nearest]) },
    );
    const near = ctx.enemies.at(-1) as Enemy;
    expect(ctx.grid.nearest(PLAYER.x, PLAYER.y, Infinity, () => true)).toBe(near);
    removeEnemy(ctx, ctx.enemies[1] as Enemy);
    compact(ctx);
    runTo(ctx, 121 + flight(100));
    expect(ctx.sys.bullets.takenBy.shooter.hits).toBe(1);
    expect(ctx.selected).toBe(near);
  });

  it('grows its arrays by doubling, keeping every bullet and SimState.bullets the same object (Y5, C7/F15)', () => {
    const shooters = Array.from({ length: 20 }, (_, k) => shooterAt(500, (k / 20) * 2 * Math.PI));
    const ctx = placed(shooters, { data: shooterData({ stopDist: 600 }) });
    const pool = ctx.sys.bullets;
    expect([pool.id.length, pool.x.length, pool.ownerType.length, pool.count]).toEqual([
      0, 0, 0, 0,
    ]);
    runTo(ctx, 121);
    expect(ctx.state.bullets).toBe(pool);
    expect([pool.count, ctx.state.bulletCount, pool.id.length, pool.vx.length]).toEqual([
      20, 20, 32, 32,
    ]);
    expect(liveIds(ctx)).toEqual(Array.from({ length: 20 }, (_, k) => k + 1));
    expect(Array.from(pool.owner.subarray(0, 20))).toEqual(liveIds(ctx));
    const byTick = runTo(ctx, 121 + flight(500));
    expect(eventsOf([...byTick.values()], 'bulletHit').map((e) => e.bulletId)).toEqual(
      Array.from({ length: 20 }, (_, k) => k + 1),
    );
    expect(pool.takenBy.shooter).toEqual({ hits: 20, damage: 60 });
  });

  it('never fires in an M1 run: its pool stays empty, its bulletTakenBy all zeros (Y2)', () => {
    const sim = createSimulation(makeConfig({ startWave: 8, maxTicks: 1200 }), makeTestData());
    const types = new Set<SimEvent['type']>();
    while (!sim.state.finished) for (const e of sim.step(NO_INPUT)) types.add(e.type);
    const pool = sim.state.bullets;
    expect([pool.id.length, pool.x.length, sim.state.bulletCount]).toEqual([0, 0, 0]);
    expect(
      [...types].filter((t) => t === 'bulletFired' || t === 'bulletHit' || t === 'summoned'),
    ).toEqual([]);
    const result = sim.result();
    expect(Object.keys(result.bulletTakenBy)).toEqual([...ENEMY_IDS]);
    for (const id of ENEMY_IDS)
      expect(result.bulletTakenBy[id], id).toEqual({ hits: 0, damage: 0 });
  });
});

describe('damagePlayer’s bullet branch (docs/v3 C7 design §2.2, §2.6; Y6)', () => {
  it('takes a bullet hit from the shield, then life, then an extra life, outside contactDamageTaken (§2.6 OWN test 3)', () => {
    // Planted bug: the contact multiplier applied to bullets. 6 a bullet, ×0.5 contacts, a
    // shield of 2, 10 of life and an extra life.
    const ctx = placed([shooterAt(100)], {
      values: { maxLife: 10, contactDamageTaken: 0.5, extraLives: 1 },
      data: shooterData({ bulletDamage: 6 }),
    });
    expect(ctx.sys.defence).toMatchObject({ contactTaken: 0.5, livesLeft: 1 });
    ctx.player.shield = 2;
    const byTick = runTo(ctx, 241 + flight(100));
    const of = (t: number) =>
      (byTick.get(t) ?? []).filter((e) => e.type !== 'bulletFired' && e.type !== 'enemySpawned');
    expect(of(121 + flight(100))).toEqual([
      { type: 'shieldAbsorbed', amount: 2, shieldLeft: 0 },
      { type: 'bulletHit', bulletId: 1, enemyId: 1, enemy: 'shooter', damage: 4, lifeLeft: 6 },
    ]);
    expect(of(241 + flight(100))).toEqual([
      { type: 'bulletHit', bulletId: 2, enemyId: 1, enemy: 'shooter', damage: 6, lifeLeft: 0 },
      { type: 'revive', lifeLeft: 5, livesLeft: 0 },
    ]);
    expect([ctx.player.life, ctx.killedBy]).toEqual([5, null]);
    expect(ctx.sys.bullets.takenBy.shooter).toEqual({ hits: 2, damage: 10 });
    expect(ctx.taken.shooter).toEqual({ hits: 0, damage: 0 });
    expect(eventsOf([...byTick.values()], 'playerHit')).toEqual([]);
  });

  it('takes M1’s life loss without a defence: bulletHit in playerHit’s place, tallied apart, killedBy on a death (Y6)', () => {
    // Planted bugs: the fast path pushing playerHit, or tallying in ctx.taken.
    const ctx = placed([shooterAt(100)], { values: { maxLife: 10 } });
    expect(ctx.sys.defence).toBeNull();
    damagePlayer(ctx, 1, 'shooter', 4, BULLET, 7);
    damagePlayer(ctx, 2, 'square', 3, CONTACT, -1);
    damagePlayer(ctx, 1, 'shooter', 4, BULLET, 8);
    expect(ctx.events).toEqual([
      { type: 'bulletHit', bulletId: 7, enemyId: 1, enemy: 'shooter', damage: 4, lifeLeft: 6 },
      { type: 'playerHit', enemyId: 2, damage: 3, lifeLeft: 3 },
      { type: 'bulletHit', bulletId: 8, enemyId: 1, enemy: 'shooter', damage: 4, lifeLeft: 0 },
    ]);
    expect(ctx.sys.bullets.takenBy.shooter).toEqual({ hits: 2, damage: 8 });
    expect(ctx.sys.bullets.takenBy.square).toEqual({ hits: 0, damage: 0 });
    expect(ctx.taken.shooter).toEqual({ hits: 0, damage: 0 });
    expect(ctx.taken.square).toEqual({ hits: 1, damage: 3 });
    expect(ctx.killedBy).toBe('shooter');
  });

  it('takes the full path with a defence: the shield, then life, the tally apart, killedBy without a life left (Y6)', () => {
    const ctx = placed([shooterAt(100)], { values: { maxLife: 10, lifeRegen: 0.5 } });
    expect(ctx.sys.defence).toMatchObject({ contactTaken: 1, livesLeft: 0 });
    ctx.player.shield = 1;
    damagePlayer(ctx, 1, 'shooter', 4, BULLET, 3);
    damagePlayer(ctx, 1, 'shooter', 9, BULLET, 4);
    expect(ctx.events).toEqual([
      { type: 'shieldAbsorbed', amount: 1, shieldLeft: 0 },
      { type: 'bulletHit', bulletId: 3, enemyId: 1, enemy: 'shooter', damage: 3, lifeLeft: 7 },
      { type: 'bulletHit', bulletId: 4, enemyId: 1, enemy: 'shooter', damage: 9, lifeLeft: 0 },
    ]);
    expect(ctx.sys.bullets.takenBy.shooter).toEqual({ hits: 2, damage: 12 });
    expect(ctx.taken.shooter).toEqual({ hits: 0, damage: 0 });
    expect(ctx.killedBy).toBe('shooter');
  });
});

/** A v3 run of `count` shooters from wave 1 that the build cannot kill, with these overrides. */
function shooterRun(
  values: Partial<Record<StatId, number>>,
  rules: { enemy: EnemyId; count: number }[] = [{ enemy: 'shooter', count: 2 }],
  modules: readonly TestModule[] = [],
) {
  const data = shooterData({}, { shooter: { hpMult: 1e9 }, triangle: { hpMult: 1e9 } });
  const waves = {
    ...data.waves,
    rules: rules.map(({ enemy, count }) => ({
      enemy,
      fromWave: 1,
      base: count,
      perWave: 0,
      maxCount: count,
    })),
  };
  return createSimulation(
    makeConfig({ stats: makeStats(values), maxTicks: 1200 }),
    { ...data, waves },
    modules,
  );
}

describe('RunResult.bulletTakenBy (docs/v3 C7 design §1.5; Y3, Y6)', () => {
  it('counts the bullets’ hits and damage in bulletTakenBy.shooter, leaks and damageTaken staying the contacts’ (§2.6 OWN test 4)', () => {
    // Planted bug: bullets counted as leaks. Two shooters fire while three triangles walk in.
    const sim = shooterRun({ maxLife: 1e6 }, [
      { enemy: 'shooter', count: 2 },
      { enemy: 'triangle', count: 3 },
    ]);
    const ticks: SimEvent[][] = [];
    while (!sim.state.finished) ticks.push([...sim.step(NO_INPUT)]);
    const result = sim.result();
    const bullets = eventsOf(ticks, 'bulletHit');
    const contacts = eventsOf(ticks, 'playerHit');
    expect([bullets.length > 4, contacts.length]).toEqual([true, 3]);
    expect(result.bulletTakenBy.shooter).toEqual({
      hits: bullets.length,
      damage: bullets.reduce((sum, e) => sum + e.damage, 0),
    });
    expect([result.leaks, result.damageTaken]).toEqual([
      3,
      contacts.reduce((sum, e) => sum + e.damage, 0),
    ]);
    expect(result.damageTakenBy.shooter).toEqual({ hits: 0, damage: 0 });
    expect(result.damageTakenBy.triangle.hits).toBe(3);
    expect(result.bulletTakenBy.triangle).toEqual({ hits: 0, damage: 0 });
  });

  it('sets killedBy shooter on a bullet death, with and without defences (§2.6 OWN test 5)', () => {
    // Planted bug: killedBy null. One bullet of 3 kills 2 of life.
    for (const values of [{ maxLife: 2 }, { maxLife: 2, contactDamageTaken: 0.5 }]) {
      const sim = shooterRun(values);
      const ticks: SimEvent[][] = [];
      while (!sim.state.finished) ticks.push([...sim.step(NO_INPUT)]);
      const result = sim.result();
      expect([result.endReason, result.killedBy, result.leaks], JSON.stringify(values)).toEqual([
        'death',
        'shooter',
        0,
      ]);
      expect(eventsOf(ticks, 'bulletHit').at(-1)?.lifeLeft).toBe(0);
    }
  });

  it('builds a copy of each type’s tally, every type present, never the live one (Y3)', () => {
    // Planted bug: bulletTakenBy sharing the pool's tally objects.
    let ctx: RunContext | null = null;
    const watch: TestModule = (b) =>
      void b.hook('tick', (c) => {
        ctx = c;
      });
    const sim = shooterRun({ maxLife: 1e6 }, undefined, [watch]);
    while (!sim.state.finished) sim.step(NO_INPUT);
    const result = sim.result();
    const live = (ctx as unknown as RunContext).sys.bullets.takenBy;
    expect(Object.keys(result.bulletTakenBy)).toEqual([...ENEMY_IDS]);
    expect(result.bulletTakenBy.shooter.hits).toBeGreaterThan(0);
    expect(result.bulletTakenBy).toEqual(live);
    for (const id of ENEMY_IDS) expect(result.bulletTakenBy[id], id).not.toBe(live[id]);
    live.shooter.hits += 100;
    expect(result.bulletTakenBy.shooter.hits).toBe(live.shooter.hits - 100);
  });
});
