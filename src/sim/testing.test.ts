import { describe, expect, it } from 'vitest';
import { createRng } from '../core/rng';
import { characterGameData, loadGameData, parseGameData } from '../data';
import { targetDamage } from '../data/curve';
import { ENEMIES } from '../data/enemies';
import { V3_ENEMIES } from '../data/enemiesV3';
import type { Modifier } from '../data/stats';
import { TALENTS } from '../data/talents';
import { ENEMY_IDS } from '../data/types';
import { V3_WAVES } from '../data/wavesV3';
import type { Enemy } from './systems/context';
import {
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
  segDistSqRef,
  STRESS_START_WAVE,
  stressData,
  stressStats,
  TEST_ENEMIES,
  TEST_V3_WAVES,
  TEST_WAVES,
  v3TestData,
  withinRef,
} from './testing';
import { DT, PLAYER_RADIUS } from './types';

interface Point {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
}

const point = (id: number, x: number, y: number, alive = true): Point => ({ id, x, y, alive });
const idsOf = (items: readonly { readonly id: number }[]): number[] => items.map((i) => i.id);

describe('placedEnemies', () => {
  it('places exactly the given enemies, in order, with their radius, speed and hp', () => {
    const ctx = placedEnemies([
      { x: 1234.567, y: 89.0123 },
      { x: 960, y: 540, type: 'triangle', radius: 7, speed: 33, hp: 5 },
      { x: 0.1, y: 1079.9, type: 'hexagon', hp: 2e6 },
      { x: 1500.25, y: 600.75, type: 'pentagon', radius: 40, speed: 250 },
    ]);
    const square = makeTestData().enemies.square;
    expect(ctx.now).toBe(1);
    expect(ctx.state.tick).toBe(1);
    expect(ctx.events).toEqual([]);
    expect(
      ctx.enemies.map((e) => [e.id, e.type, e.x, e.y, e.prevX, e.prevY, e.radius, e.hp, e.maxHp]),
    ).toEqual([
      [1, 'square', 1234.567, 89.0123, 1234.567, 89.0123, square.radius, 1e12, 1e12],
      [2, 'triangle', 960, 540, 960, 540, 7, 5, 5],
      [3, 'hexagon', 0.1, 1079.9, 0.1, 1079.9, 34, 2e6, 2e6],
      [4, 'pentagon', 1500.25, 600.75, 1500.25, 600.75, 40, 1e12, 1e12],
    ]);
    const [a, b, c, d] = ctx.enemies as [Enemy, Enemy, Enemy, Enemy];
    expect([a.stepDist, b.stepDist, c.stepDist, d.stepDist]).toEqual([0, 33 * DT, 0, 250 * DT]);
    expect(b.contactDist).toBe(PLAYER_RADIUS + 7);
    expect([a.tough, b.tough, c.tough, d.tough]).toEqual([false, false, true, false]);
    // The one at the player's position stands at distance 0; the others at their distance.
    expect(b.dist).toBe(0);
    expect(a.dist).toBeCloseTo(Math.hypot(1234.567 - 960, 89.0123 - 540), 9);
    // They belong to the start wave, the only wave, and split as their type does.
    expect(ctx.open).toHaveLength(1);
    expect(ctx.enemies.every((e) => e.rec === ctx.current && e.alive)).toBe(true);
    expect(ctx.current?.alive).toBe(4);
    expect(d.def.splitInto).toEqual({ enemy: 'shard', count: 3 });
  });

  it('rebuilds the grid for the tick, and draws nothing', () => {
    const rng = createRng(7);
    const placed = Array.from({ length: 200 }, () => ({
      x: rng.range(-50, 1970),
      y: rng.range(-50, 1130),
    }));
    const ctx = placedEnemies(placed, { seed: 3 });
    const fresh = placedEnemies([], { seed: 3 });
    expect(rngPositions(ctx)).toEqual(rngPositions(fresh));
    const out: Enemy[] = [];
    for (let q = 0; q < 50; q++) {
      const x = rng.range(0, 1920);
      const y = rng.range(0, 1080);
      const radiusSq = rng.range(0, 400) ** 2;
      const count = ctx.grid.within(x, y, radiusSq, out);
      expect(idsOf(out.slice(0, count))).toEqual(idsOf(withinRef(ctx.enemies, x, y, radiusSq)));
    }
  });

  it('compiles the given build', () => {
    const ctx = placedEnemies([{ x: 100, y: 100 }], {
      stats: makeStats({ chainCount: 3 }),
      rules: [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 }],
    });
    expect(ctx.chainCount).toBe(6);
  });
});

describe('rngPositions', () => {
  it('moves only for the stream that drew', () => {
    const ctx = placedEnemies([]);
    const before = rngPositions(ctx);
    expect(rngPositions(ctx)).toEqual(before);
    ctx.combatRng.next();
    const after = rngPositions(ctx);
    expect(after.combat).not.toEqual(before.combat);
    expect({ ...after, combat: before.combat }).toEqual(before);
    expect(Object.keys(after)).toEqual([
      'spawn',
      'split',
      'combat',
      'drops',
      'trigger',
      'effects',
      'affixes',
    ]);
  });
});

describe('segDistSqRef', () => {
  it('agrees with the closed forms', () => {
    // Segment (0, 0)–(10, 0): over it, beyond either end, on it.
    expect(segDistSqRef(4, 3, 0, 0, 10, 0)).toBe(9);
    expect(segDistSqRef(4, -3, 0, 0, 10, 0)).toBe(9);
    expect(segDistSqRef(-3, 4, 0, 0, 10, 0)).toBe(25);
    expect(segDistSqRef(13, -4, 0, 0, 10, 0)).toBe(25);
    expect(segDistSqRef(0, 2, 0, 0, 10, 0)).toBe(4);
    expect(segDistSqRef(10, 2, 0, 0, 10, 0)).toBe(4);
    expect(segDistSqRef(7.5, 0, 0, 0, 10, 0)).toBe(0);
    // Diagonal (0, 0)–(6, 8), length 10: 10 off its middle at a right angle, 10 behind A, 5
    // past B.
    expect(segDistSqRef(3 + 8, 4 - 6, 0, 0, 6, 8)).toBeCloseTo(100, 9);
    expect(segDistSqRef(-6, -8, 0, 0, 6, 8)).toBe(100);
    expect(segDistSqRef(9, 12, 0, 0, 6, 8)).toBe(25);
    // A segment that is a point.
    expect(segDistSqRef(4, 6, 1, 2, 1, 2)).toBe(25);
  });

  it('is the minimum over points along the segment', () => {
    const rng = createRng(11);
    const coord = (): number => rng.range(-200, 200);
    const steps = 20_000;
    for (let i = 0; i < 300; i++) {
      const [ax, ay, bx, by, px, py] = [coord(), coord(), coord(), coord(), coord(), coord()];
      let best = Infinity;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const dx = ax + t * (bx - ax) - px;
        const dy = ay + t * (by - ay) - py;
        best = Math.min(best, dx * dx + dy * dy);
      }
      const ref = segDistSqRef(px, py, ax, ay, bx, by);
      expect(ref).toBeLessThanOrEqual(best * (1 + 1e-12) + 1e-9);
      // The sampled minimum is within half a step of the true one.
      const halfStep = Math.hypot(bx - ax, by - ay) / steps / 2;
      expect(Math.sqrt(best) - Math.sqrt(ref)).toBeLessThanOrEqual(halfStep + 1e-9);
    }
  });
});

describe('withinRef', () => {
  it('agrees with the closed forms: alive, inclusive, in source order', () => {
    const items = [
      point(1, 13, 14), // 5 from (10, 10)
      point(2, 10, 10), // 0
      point(3, 14, 13, false), // 5, dead
      point(4, 16, 18), // 10
      point(5, 7, 6), // 5
      point(6, 10.000001, 15), // just over 5
    ];
    expect(idsOf(withinRef(items, 10, 10, 25))).toEqual([1, 2, 5]);
    expect(idsOf(withinRef(items, 10, 10, 0))).toEqual([2]);
    expect(idsOf(withinRef(items, 10, 10, 100))).toEqual([1, 2, 4, 5, 6]);
    expect(idsOf(withinRef(items, 10, 10, Infinity))).toEqual([1, 2, 4, 5, 6]);
    expect(withinRef([], 0, 0, 1e9)).toEqual([]);
  });
});

describe('stress fixture', () => {
  it('is the normal build at its frontier on the start wave, on waves of 18, 11 and 4 a second', () => {
    expect(STRESS_START_WAVE).toBe(30);
    const stats = stressStats({ attackSpeed: 32 });
    expect(stats.values.damage).toBe(targetDamage(STRESS_START_WAVE) / 2.5);
    expect(stats.values.attackSpeed).toBe(32);
    expect(stats.values.maxLife).toBe(1e12);
    expect(stats.scoped).toEqual([]);
    const frost: Modifier = { stat: 'frostOnHit', kind: 'flat', value: 0.3, tags: ['area'] };
    expect(stressStats({}, undefined, [frost]).scoped).toEqual([frost]);
    const data = stressData();
    expect(data.waves.rules.map((r) => [r.enemy, r.base, r.perWave])).toEqual([
      ['triangle', 18, 0],
      ['square', 11, 0],
      ['pentagon', 4, 0],
    ]);
    expect(data.waves.waveTimerSec).toBe(1);
    expect(data.enemies.triangle.speed).toBe(110);
    expect(data.enemies.boss.speed).toBe(makeTestData().enemies.boss.speed);
  });
});

describe('fixture enemies and v3 waves (docs/v3 C7 design §1.2)', () => {
  it('parses M1, v3 and test data, each with a def for every one of the 13 ids', () => {
    const datas = {
      m1: loadGameData(),
      v3: characterGameData(),
      test: parseGameData({ ...makeTestData(), talents: TALENTS }),
      v3Test: parseGameData({ ...v3TestData(), talents: TALENTS }),
    };
    expect(ENEMY_IDS).toHaveLength(13);
    for (const [name, data] of Object.entries(datas)) {
      expect(Object.keys(data.enemies).sort(), name).toEqual([...ENEMY_IDS].sort());
      for (const id of ENEMY_IDS) expect(data.enemies[id].id, `${name} ${id}`).toBe(id);
    }
  });

  it('gives TEST_ENEMIES the content’s flags, and the v3 types unchanged', () => {
    for (const id of ENEMY_IDS) {
      expect([TEST_ENEMIES[id].tough, TEST_ENEMIES[id].boss], id).toEqual([
        ENEMIES[id].tough,
        ENEMIES[id].boss,
      ]);
    }
    for (const def of Object.values(V3_ENEMIES)) expect(TEST_ENEMIES[def.id]).toEqual(def);
  });

  it('makes TEST_V3_WAVES TEST_WAVES plus the v3 rules at the content’s first waves, and its v3 block', () => {
    const m1 = TEST_WAVES.rules.length;
    expect(TEST_V3_WAVES.rules.slice(0, m1)).toEqual(TEST_WAVES.rules);
    expect(TEST_V3_WAVES.rules.slice(m1).map((r) => [r.enemy, r.fromWave])).toEqual(
      V3_WAVES.rules.slice(V3_WAVES.rules.length - 5).map((r) => [r.enemy, r.fromWave]),
    );
    for (const rule of TEST_V3_WAVES.rules.slice(m1)) {
      expect([rule.base, rule.perWave, rule.maxCount], rule.enemy).toEqual([1, 0.2, 8]);
    }
    const { rules, v3, ...settings } = TEST_V3_WAVES;
    const { rules: m1Rules, ...m1Settings } = TEST_WAVES;
    expect([rules.length - m1Rules.length, settings]).toEqual([5, m1Settings]);
    expect(v3).toEqual(V3_WAVES.v3);
  });

  it('merges v3TestData’s overrides into TEST_V3_WAVES, and leaves makeTestData an M1 table', () => {
    expect(makeTestData().waves.v3).toBeUndefined();
    expect(v3TestData().waves).toEqual(TEST_V3_WAVES);
    const data = v3TestData({
      waves: { eliteEvery: 1000, v3: { ...TEST_V3_WAVES.v3, affixes: [] } },
      enemies: { square: { speed: 0 } },
    });
    expect(data.waves).toEqual({
      ...TEST_V3_WAVES,
      eliteEvery: 1000,
      v3: { ...TEST_V3_WAVES.v3, affixes: [] },
    });
    expect(data.enemies.square).toEqual({ ...TEST_ENEMIES.square, speed: 0 });
    expect(data.enemies.shielder).toEqual(TEST_ENEMIES.shielder);
  });
});
