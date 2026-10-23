/**
 * The enemy cap (docs/v3 C7 design §2.3; the lead's ruling L4): a v3 run holds at most its
 * enemyCap alive. Wave enemies past it wait, oldest wave first and then in queue order, each
 * counted once in enemyCapDelayed and drawing its spawn angle when it is released; split
 * children past it are skipped and counted in enemySpawnsSkipped, their angles drawn all the
 * same; a wave with enemies still waiting stays open while the wave timer starts the next one; an
 * M1 table's cap is Infinity.
 */

import { describe, expect, it } from 'vitest';
import { characterGameData, loadGameData } from '../../data';
import type { EnemyId, GameData, WaveTable } from '../../data/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
  stressData,
  TEST_V3_WAVES,
  TEST_WAVES,
  v3TestData,
} from '../testing';
import type { TestDataOverrides } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import { createRunContext } from './context';
import type { Enemy, RunContext, WaveRecord } from './context';
import { compact, killEnemy, removeEnemy } from './death';
import { aliveCount, releaseEnemies, spawnOrSkip } from './spawn';
import { startWave } from './waves';

/**
 * A v3 table with enemy cap `enemyCap`, M1's fixture types and `waves` over TEST_V3_WAVES, with no
 * elite, boss, affix or treasure (TEST_V3_WAVES.v3 spread, as v3TestData's merge is shallow), and
 * the enemies of `overrides`.
 */
function capData(
  enemyCap: number,
  waves: Partial<WaveTable> = {},
  overrides: TestDataOverrides = {},
): GameData {
  return v3TestData({
    ...overrides,
    waves: {
      rules: TEST_WAVES.rules,
      eliteEvery: 1000,
      bossEvery: 1000,
      ...waves,
      v3: {
        ...TEST_V3_WAVES.v3,
        enemyCap,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });
}

/** One rule a wave: `count` of `enemy`, the same every wave. */
const every = (enemy: EnemyId, count: number): WaveTable['rules'][number] => ({
  enemy,
  fromWave: 1,
  base: count,
  perWave: 0,
  maxCount: count,
});

/** Immortal squares that stand where they spawn, outside the arena. */
const STILL = { enemies: { square: { hpMult: 1e12, speed: 0 } } } as const;

/** A run context of `data` on tick 1 with waves 1 to `waves` started and nothing released. */
function started(data: GameData, waves: number): RunContext {
  const ctx = createRunContext(makeConfig(), data);
  ctx.now = 1;
  ctx.state.tick = 1;
  for (let wave = 1; wave <= waves; wave++) startWave(ctx, wave);
  return ctx;
}

/** What tells released enemies apart: id, wave, type and spawn direction. */
const spawnsOf = (enemies: readonly Enemy[]) =>
  enemies.map(({ id, wave, type, ux, uy }) => ({ id, wave, type, ux, uy }));

/** Removes `n` of ctx's living enemies, first first, and compacts, as a tick's deaths would. */
function free(ctx: RunContext, n: number): void {
  for (const enemy of ctx.enemies.filter((e) => e.alive).slice(0, n)) removeEnemy(ctx, enemy);
  compact(ctx);
}

/** A test module that removes `n` living enemies at tick `tick` (in its tick hook). */
const freeAt =
  (tick: number, n: number): TestModule =>
  (b) =>
    void b.hook('tick', (ctx) => {
      if (ctx.now !== tick) return;
      for (const enemy of ctx.enemies.filter((e) => e.alive).slice(0, n)) removeEnemy(ctx, enemy);
    });

/** A test module that hands the run's context to `seen` at every tick hook. */
const watch =
  (seen: { ctx: RunContext | null }): TestModule =>
  (b) =>
    void b.hook('tick', (ctx) => {
      seen.ctx = ctx;
    });

/** The events of every tick of a run of `ticks` ticks, by tick. */
function eventsOf(data: GameData, ticks: number, modules: readonly TestModule[] = []) {
  const seen: { ctx: RunContext | null } = { ctx: null };
  const sim = createSimulation(makeConfig({ maxTicks: ticks }), data, [...modules, watch(seen)]);
  const byTick: SimEvent[][] = [[]];
  while (!sim.state.finished) byTick.push([...sim.step(NO_INPUT)]);
  return { byTick, ctx: seen.ctx as RunContext, result: sim.result() };
}

/** The ticks of `type` events, with the event. */
function ticksOf<T extends SimEvent['type']>(byTick: readonly SimEvent[][], type: T) {
  return byTick.flatMap((events, tick) =>
    events
      .filter((event): event is Extract<SimEvent, { type: T }> => event.type === type)
      .map((event) => ({ tick, event })),
  );
}

/**
 * C7.5's GOLDEN-C4 build (src/sim/goldenC4.test.ts enemyCap): damage 500 on BASE_STATS' volley,
 * with too much life to die, does not hold the field of a wave every 2 s from about wave 18.
 */
const WEAK = makeStats({ damage: 500, maxLife: 1e6 });

describe('releaseEnemies under the enemy cap (docs/v3 C7 design §2.3)', () => {
  it('releases the deferred enemies oldest wave first, then in queue order, each drawing its spawn angle as it is released (OWN test 1)', () => {
    // Two waves of 6 triangles and 6 squares, all due at once, under a cap of 10 and of 1,000:
    // the uncapped context releases every enemy on tick 1, in the order the capped one must.
    const waves = { rules: [every('triangle', 6), every('square', 6)], spawnDurationSec: 0 };
    const capped = started(capData(10, waves), 2);
    const uncapped = started(capData(1000, waves), 2);
    const [first, second] = capped.open as [WaveRecord, WaveRecord];
    // The queue mixes the two types, so its order shows.
    expect(new Set(first.queue.slice(0, 10).map((def) => def.id)).size).toBe(2);
    releaseEnemies(capped);
    releaseEnemies(uncapped);
    const order = spawnsOf(uncapped.enemies);
    expect(order.map((spawn) => spawn.wave)).toEqual([...Array(12).fill(1), ...Array(12).fill(2)]);
    expect(order.map((spawn) => spawn.type)).toEqual(
      [...first.queue, ...second.queue].map((def) => def.id),
    );
    // Tick 1: the room is 10, all of it the first wave's.
    expect(spawnsOf(capped.enemies)).toEqual(order.slice(0, 10));
    expect([first.released, second.released]).toEqual([10, 0]);
    // Each enemy left waiting counts once: the first wave's last 2 and the second wave's 12.
    expect(capped.counters.enemyCapDelayed).toBe(14);
    expect([first.delayed, second.delayed]).toEqual([12, 12]);
    // Tick 2, five enemies gone: the first wave's last 2, then the second wave's first 3.
    free(capped, 5);
    capped.now = 2;
    releaseEnemies(capped);
    expect(spawnsOf(capped.enemies.slice(5))).toEqual(order.slice(10, 15));
    expect([first.released, second.released]).toEqual([12, 3]);
    expect(capped.counters.enemyCapDelayed).toBe(14);
    expect(aliveCount(capped)).toBe(10);
    expect(uncapped.counters.enemyCapDelayed).toBe(0);
  });

  it('draws a waiting enemy’s spawn angle when it is released, not when it falls due, so the spawn stream keeps release order', () => {
    // Two waves of 6 started together and released over a second fall due by turns, first wave
    // and second. Under a cap of 12 that 12 placed enemies fill, they all wait until tick 41,
    // when the field empties and the first wave's 5 due enemies go out before the second's.
    const waves = { rules: [every('square', 3), every('triangle', 3)], spawnDurationSec: 1 };
    const capped = started(capData(12, waves), 2);
    const uncapped = started(capData(1000, waves), 2);
    const [first, second] = capped.open as [WaveRecord, WaveRecord];
    for (let k = 0; k < 12; k++) spawnOrSkip(capped, capped.data.enemies.square, first, 1, 0, 3000);
    for (let now = 1; now <= 41; now++) {
      capped.now = now;
      uncapped.now = now;
      if (now === 41) free(capped, 12);
      releaseEnemies(capped);
      releaseEnemies(uncapped);
    }
    expect(uncapped.enemies.map((enemy) => enemy.wave)).toEqual([1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
    expect(capped.enemies.map((enemy) => enemy.wave)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    expect(capped.enemies.map((enemy) => enemy.type)).toEqual(
      [...first.queue.slice(0, 5), ...second.queue.slice(0, 5)].map((def) => def.id),
    );
    // The k-th release takes the spawn stream's k-th angle, however long it waited.
    const directions = (ctx: RunContext) => ctx.enemies.map(({ ux, uy }) => ({ ux, uy }));
    expect(directions(capped)).toEqual(directions(uncapped));
    expect(capped.counters.enemyCapDelayed).toBe(8);
  });

  it('counts an enemy the cap delays once, however long it waits, in a wave released over a second (OWN test 2)', () => {
    // 30 immortal squares over 60 ticks under a cap of 10: the first 10 are out by tick 19, the
    // other 20 wait as they fall due. Room comes at ticks 101 (3), 201 and 301 (all of it).
    const data = capData(
      10,
      { rules: [every('square', 30)], spawnDurationSec: 1, waveTimerSec: 1000 },
      STILL,
    );
    const seen: { ctx: RunContext | null } = { ctx: null };
    const delayedAt: number[] = [];
    const sim = createSimulation(makeConfig({ maxTicks: 400 }), data, [
      freeAt(100, 3),
      freeAt(200, 10),
      freeAt(300, 10),
      watch(seen),
    ]);
    let spawned = 0;
    while (!sim.state.finished) {
      for (const event of sim.step(NO_INPUT)) if (event.type === 'enemySpawned') spawned++;
      delayedAt.push((seen.ctx as RunContext).counters.enemyCapDelayed);
    }
    // Each waiting square counts at the tick it falls due (one every two ticks from tick 21) and
    // never again, however long it waits.
    expect(delayedAt.slice(0, 20)).toEqual(Array(20).fill(0));
    expect(delayedAt[20]).toBe(1);
    expect(delayedAt[58]).toBe(20);
    expect(new Set(delayedAt.slice(58))).toEqual(new Set([20]));
    expect(spawned).toBe(30);
    expect(sim.result().counters.enemyCapDelayed).toBe(20);
  });

  it('shares one room among the open waves of a tick and counts the waiting of every later wave', () => {
    // Three waves of 4 under a cap of 6, on top of 2 placed in the first wave.
    const waves = { rules: [every('square', 4)], spawnDurationSec: 0 };
    const ctx = started(capData(6, waves), 3);
    const recs = ctx.open as [WaveRecord, WaveRecord, WaveRecord];
    for (let k = 0; k < 2; k++) spawnOrSkip(ctx, ctx.data.enemies.square, recs[0], 1, 0, 3000);
    releaseEnemies(ctx);
    expect(recs.map((rec) => rec.released)).toEqual([4, 0, 0]);
    expect(recs.map((rec) => rec.delayed)).toEqual([0, 4, 4]);
    expect(ctx.counters.enemyCapDelayed).toBe(8);
    expect(aliveCount(ctx)).toBe(6);
  });

  it('takes its room from the enemies alive, so one dead but not yet compacted out leaves room', () => {
    const waves = { rules: [every('square', 4)], spawnDurationSec: 0 };
    const ctx = started(capData(4, waves), 1);
    const rec = ctx.open[0] as WaveRecord;
    spawnOrSkip(ctx, ctx.data.enemies.square, rec, 1, 0, 3000);
    removeEnemy(ctx, ctx.enemies[0] as Enemy);
    releaseEnemies(ctx);
    expect([ctx.enemies.length, aliveCount(ctx), rec.released, rec.delayed]).toEqual([5, 4, 4, 0]);
  });
});

describe('split and spawnOrSkip under the enemy cap (L4)', () => {
  // A v3 table whose waves spawn nothing: the placed enemies alone are alive.
  const noWaves = (enemyCap: number): GameData =>
    capData(enemyCap, {
      rules: [every('triangle', 0), every('square', 0), every('pentagon', 0)],
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    });
  const placed = (enemyCap: number): RunContext =>
    placedEnemies(
      [
        { x: 300, y: 0, type: 'pentagon' },
        { x: -300, y: 0 },
        { x: 0, y: 300 },
        { x: 0, y: -300 },
      ],
      { data: noWaves(enemyCap) },
    );

  it('skips and counts the split children past the cap, and the split stream moves as in a run where they spawned (OWN test 3)', () => {
    const capped = placed(4);
    const uncapped = placed(100);
    // The placed enemies' wave is no longer the current one when the pentagon dies.
    const parentRec = capped.current as WaveRecord;
    startWave(capped, 2);
    startWave(uncapped, 2);
    const kill = (ctx: RunContext): void => killEnemy(ctx, ctx.enemies[0] as Enemy, -1, 0);
    const before = rngPositions(capped);
    kill(capped);
    kill(uncapped);
    // The pentagon's death leaves 3 alive: one shard fills the cap, the other two are skipped.
    const children = (ctx: RunContext) => ctx.enemies.slice(4).filter((e) => e.type === 'shard');
    expect(children(uncapped)).toHaveLength(3);
    expect(children(capped).map(({ ux, uy, dist }) => ({ ux, uy, dist }))).toEqual(
      children(uncapped)
        .slice(0, 1)
        .map(({ ux, uy, dist }) => ({ ux, uy, dist })),
    );
    expect(capped.counters.enemySpawnsSkipped).toBe(2);
    expect(uncapped.counters.enemySpawnsSkipped).toBe(0);
    // Every child's angle, a skipped one's too, comes from the split stream, and from no other.
    expect(rngPositions(capped).split).toEqual(rngPositions(uncapped).split);
    expect(rngPositions(capped).split).not.toEqual(before.split);
    expect({ ...rngPositions(capped), split: before.split }).toEqual(before);
    // The child joins its parent's wave.
    expect(children(capped).map((child) => child.rec === parentRec)).toEqual([true]);
    expect([aliveCount(capped), parentRec.alive]).toEqual([4, 4]);
  });

  it('spawnOrSkip adds below the cap, with its origin, and refuses at it, counting each refusal', () => {
    const ctx = placed(5);
    const rec = ctx.current as WaveRecord;
    const square = ctx.data.enemies.square;
    const field = () => [ctx.enemies.length, aliveCount(ctx), ctx.counters.enemySpawnsSkipped];
    const origin = { hpScale: 1, radiusScale: 0.5, dropScale: 1, extra: true, affixes: 0 };
    expect(spawnOrSkip(ctx, square, rec, 0, 1, 3000, origin)).toBe(true);
    expect(field()).toEqual([5, 5, 0]);
    const added = ctx.enemies[4] as Enemy;
    expect([added.y - ctx.player.y, added.radius, added.v3?.extra]).toEqual([
      3000,
      square.radius / 2,
      true,
    ]);
    expect(spawnOrSkip(ctx, square, rec, 1, 0, 3000)).toBe(false);
    expect(spawnOrSkip(ctx, square, rec, 1, 0, 3000)).toBe(false);
    expect(field()).toEqual([5, 5, 2]);
  });

  it('skips a child born on the player past the cap as well (L4)', () => {
    // A pentagon of radius 0 on the player: each child lands at distance 0, along (1, 0).
    const onPlayer = (enemyCap: number): RunContext =>
      placedEnemies(
        [
          { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2, type: 'pentagon', radius: 0 },
          { x: -300, y: 0 },
        ],
        { data: noWaves(enemyCap) },
      );
    const capped = onPlayer(2);
    const uncapped = onPlayer(100);
    for (const ctx of [capped, uncapped]) killEnemy(ctx, ctx.enemies[0] as Enemy, -1, 0);
    const children = (ctx: RunContext) =>
      ctx.enemies.slice(2).map(({ type, dist, ux, uy }) => ({ type, dist, ux, uy }));
    expect(children(uncapped)).toEqual(Array(3).fill({ type: 'shard', dist: 0, ux: 1, uy: 0 }));
    // The pentagon's death leaves 1 alive: one child fills the cap of 2, the other two are skipped.
    expect(children(capped)).toEqual(children(uncapped).slice(0, 1));
    expect([aliveCount(capped), capped.counters.enemySpawnsSkipped]).toEqual([2, 2]);
    expect(rngPositions(capped).split).toEqual(rngPositions(uncapped).split);
  });
});

describe('the cap over whole runs', () => {
  it('ends no tick above the cap over 3 seeds × 3,600 ticks of a weak v3 build (OWN test 4)', () => {
    const data = capData(30, { waveTimerSec: 2 });
    for (const seed of [1, 2, 3]) {
      const sim = createSimulation(
        makeConfig({ seed, stats: WEAK, startWave: 12, maxTicks: 3600 }),
        data,
      );
      let most = 0;
      let over = 0;
      while (!sim.state.finished) {
        sim.step(NO_INPUT);
        most = Math.max(most, sim.state.enemies.length);
        if (sim.state.enemies.length > 30) over++;
      }
      const { counters, ticks } = sim.result();
      expect({ seed, over, most, ticks }).toEqual({ seed, over: 0, most: 30, ticks: 3600 });
      // The cap both held wave enemies back and skipped split children.
      expect(counters.enemyCapDelayed).toBeGreaterThan(0);
      expect(counters.enemySpawnsSkipped).toBeGreaterThan(0);
    }
  });

  it('reads its cap once from the data: the v3 block’s enemyCap, Infinity for M1, test and stress tables (OWN test 5)', () => {
    const cap = (data: GameData): number => createRunContext(makeConfig(), data).sys.enemyAi.cap;
    expect([loadGameData(), makeTestData(), stressData()].map(cap)).toEqual([
      Infinity,
      Infinity,
      Infinity,
    ]);
    expect([characterGameData(), v3TestData(), capData(60)].map(cap)).toEqual([400, 400, 60]);
  });

  it('keeps a wave with enemies waiting open, and the timer still starts the next waves (OWN test 6)', () => {
    // 20 immortal squares a wave under a cap of 10, a wave every 2 s: every wave after the first
    // waits whole, with nothing alive, and stays open.
    const data = capData(
      10,
      { rules: [every('square', 20)], spawnDurationSec: 0, waveTimerSec: 2 },
      STILL,
    );
    const { byTick, ctx, result } = eventsOf(data, 300);
    expect(ticksOf(byTick, 'waveStarted').map(({ tick, event }) => [tick, event.wave])).toEqual([
      [1, 1],
      [121, 2],
      [241, 3],
    ]);
    expect(ticksOf(byTick, 'waveCleared')).toEqual([]);
    expect(ctx.open.map(({ wave, released, alive }) => ({ wave, released, alive }))).toEqual([
      { wave: 1, released: 10, alive: 10 },
      { wave: 2, released: 0, alive: 0 },
      { wave: 3, released: 0, alive: 0 },
    ]);
    expect(result.counters.enemyCapDelayed).toBe(50);
    expect(result.highestWaveCleared).toBe(0);
  });

  it('clears a wave, and ends the run at the wave cap, only once its last waiting enemy is out and gone (OWN test 6)', () => {
    // 20 squares in one wave under a cap of 10, every enemy removed at every tick: 10 come out on
    // tick 1 and the other 10 on tick 2, and the wave clears on tick 2.
    const data = capData(10, { rules: [every('square', 20)], spawnDurationSec: 0 }, STILL);
    const clearField: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        for (const enemy of ctx.enemies) if (enemy.alive) removeEnemy(ctx, enemy);
      });
    const sim = createSimulation(makeConfig({ waveCap: 1, maxTicks: 60 }), data, [clearField]);
    const spawnedAt: number[] = [];
    const clearedAt: number[] = [];
    while (!sim.state.finished) {
      for (const event of sim.step(NO_INPUT)) {
        if (event.type === 'enemySpawned') spawnedAt.push(sim.state.tick);
        if (event.type === 'waveCleared') clearedAt.push(sim.state.tick);
      }
    }
    expect(spawnedAt).toEqual([...Array(10).fill(1), ...Array(10).fill(2)]);
    expect(clearedAt).toEqual([2]);
    expect(sim.result()).toMatchObject({ endReason: 'waveCap', ticks: 2 });
  });

  it('keeps aliveCount equal to the enemies alive after every step of a v3 run, through kills, leaks and splits (OWN test 8)', () => {
    const data = capData(30, { waveTimerSec: 2 });
    const seen: { ctx: RunContext | null } = { ctx: null };
    const sim = createSimulation(makeConfig({ stats: WEAK, startWave: 12, maxTicks: 1800 }), data, [
      watch(seen),
    ]);
    let mismatches = 0;
    let wrongRecords = 0;
    while (!sim.state.finished) {
      sim.step(NO_INPUT);
      const ctx = seen.ctx as RunContext;
      if (aliveCount(ctx) !== sim.state.enemies.length) mismatches++;
      for (const rec of ctx.open) {
        if (rec.alive !== ctx.enemies.filter((enemy) => enemy.rec === rec).length) wrongRecords++;
      }
    }
    const result = sim.result();
    expect({ mismatches, wrongRecords }).toEqual({ mismatches: 0, wrongRecords: 0 });
    // Kills, leaks and split children all happened.
    expect(result.kills).toBeGreaterThan(100);
    expect(result.leaks).toBeGreaterThan(0);
    expect(result.counters.enemySpawnsSkipped).toBeGreaterThan(0);
  });
});
