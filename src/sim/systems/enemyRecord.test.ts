import { describe, expect, it } from 'vitest';
import { mul, num } from '../../core/num';
import { characterGameData, loadGameData } from '../../data';
import { V3_ENEMIES } from '../../data/enemiesV3';
import type { EnemyDef, EnemyId, GameData } from '../../data/types';
import { createSimulation } from '../simulation';
import {
  makeConfig,
  makeTestData,
  placedEnemies,
  stressData,
  TEST_ENEMIES,
  v3TestData,
} from '../testing';
import { NO_INPUT, PLAYER_RADIUS } from '../types';
import type { EnemyState } from '../types';
import { createRunContext } from './context';
import type { Enemy, RunContext, WaveRecord } from './context';
import {
  AI_DASH,
  AI_NONE,
  AI_SHOOT,
  AI_SUMMON,
  AI_TREASURE,
  ARMOURED,
  createEnemyV3,
  SHIELDED,
} from './enemyRecord';
import type { SpawnOrigin } from './enemyRecord';
import { addEnemy } from './spawn';

/** Every enemy a run of `data` from `startWave` has had by `ticks`, by id. */
function enemiesOf(data: GameData, startWave: number, ticks: number): EnemyState[] {
  const sim = createSimulation(makeConfig({ startWave }), data);
  const seen = new Map<number, EnemyState>();
  for (let t = 0; t < ticks && !sim.state.finished; t++) {
    sim.step(NO_INPUT);
    for (const enemy of sim.state.enemies) seen.set(enemy.id, enemy);
  }
  return [...seen.values()];
}

/** The types among `enemies`, each once, in order of first appearance. */
const typesOf = (enemies: readonly EnemyState[]): EnemyId[] => [
  ...new Set(enemies.map((enemy) => enemy.type)),
];

/** An enemy of `def` added to the start wave of `ctx`, 500 right of the player. */
function spawned(ctx: RunContext, def: EnemyDef, origin?: SpawnOrigin): Enemy {
  addEnemy(ctx, def, ctx.current as WaveRecord, 1, 0, 500, origin);
  return ctx.enemies.at(-1) as Enemy;
}

const ORIGIN: SpawnOrigin = {
  hpScale: 0.25,
  radiusScale: 0.7,
  dropScale: 0.25,
  extra: true,
  affixes: 0,
};

describe('createEnemyV3 (docs/v3 C7 design §1.3)', () => {
  it('gives each behaviour its AI kind, and a plain walker, a shield, regeneration and layers none', () => {
    const ai = Object.fromEntries(
      Object.values(TEST_ENEMIES).map((def) => [def.id, createEnemyV3(def, undefined).ai]),
    );
    expect(ai).toEqual({
      triangle: AI_NONE,
      square: AI_NONE,
      pentagon: AI_NONE,
      shard: AI_NONE,
      hexagon: AI_NONE,
      boss: AI_NONE,
      shielder: AI_NONE,
      regenerator: AI_NONE,
      dasher: AI_DASH,
      shooter: AI_SHOOT,
      summoner: AI_SUMMON,
      treasure: AI_TREASURE,
      onion: AI_NONE,
    });
    expect([AI_NONE, AI_DASH, AI_SHOOT, AI_SUMMON, AI_TREASURE]).toEqual([0, 1, 2, 3, 4]);
  });

  it('holds `extra` from the origin, and true for the treasure whatever spawns it', () => {
    const { square, treasure } = TEST_ENEMIES;
    expect(createEnemyV3(square, undefined)).toEqual({
      ai: AI_NONE,
      extra: false,
      defence: 0,
      blockPct: 0,
      contactMult: 1,
    });
    expect(createEnemyV3(square, ORIGIN)).toEqual({
      ai: AI_NONE,
      extra: true,
      defence: 0,
      blockPct: 0,
      contactMult: 1,
    });
    expect(createEnemyV3(square, { ...ORIGIN, extra: false }).extra).toBe(false);
    expect(createEnemyV3(treasure, undefined)).toEqual({
      ai: AI_TREASURE,
      extra: true,
      defence: 0,
      blockPct: 0,
      contactMult: 1,
    });
    expect(createEnemyV3(treasure, { ...ORIGIN, extra: false }).extra).toBe(true);
  });

  it('reads the AI kind and the treasure’s `extra` from the def’s behaviour, not its id', () => {
    const { square } = TEST_ENEMIES;
    // The four AI types' ids on a square's def, which has no behaviour: plain walkers.
    for (const id of ['dasher', 'shooter', 'summoner', 'treasure'] as const) {
      expect(createEnemyV3({ ...square, id }, undefined), id).toEqual({
        ai: AI_NONE,
        extra: false,
        defence: 0,
        blockPct: 0,
        contactMult: 1,
      });
    }
    // A square given each behaviour acts as the type that has it.
    const { dasher, shooter, summoner, treasure } = V3_ENEMIES;
    for (const def of [dasher, shooter, summoner, treasure]) {
      const behaving: EnemyDef = { ...square, behaviour: def.behaviour };
      expect(createEnemyV3(behaving, undefined), def.id).toEqual(createEnemyV3(def, undefined));
    }
    expect(createEnemyV3({ ...square, behaviour: treasure.behaviour }, undefined)).toEqual({
      ai: AI_TREASURE,
      extra: true,
      defence: 0,
      blockPct: 0,
      contactMult: 1,
    });
  });

  it('gives a shield behaviour SHIELDED and its blockBelowPct, read from the behaviour, not the id', () => {
    const { square, shielder } = TEST_ENEMIES;
    expect([SHIELDED, ARMOURED]).toEqual([1, 2]);
    expect(createEnemyV3(shielder, undefined)).toEqual({
      ai: AI_NONE,
      extra: false,
      defence: SHIELDED,
      blockPct: 0.15,
      contactMult: 1,
    });
    // The shielder's id on a square's def, which has no behaviour: no defence.
    expect(createEnemyV3({ ...square, id: 'shielder' }, undefined)).toMatchObject({
      defence: 0,
      blockPct: 0,
    });
    // A square given a shield of its own holds that shield's share, whatever spawned it.
    const shielded: EnemyDef = { ...square, behaviour: { kind: 'shield', blockBelowPct: 0.4 } };
    expect(createEnemyV3(shielded, ORIGIN)).toEqual({
      ai: AI_NONE,
      extra: true,
      defence: SHIELDED,
      blockPct: 0.4,
      contactMult: 1,
    });
    // Every other v3 behaviour holds none.
    for (const def of Object.values(V3_ENEMIES)) {
      if (def.id === 'shielder') continue;
      expect(createEnemyV3(def, undefined), def.id).toMatchObject({ defence: 0, blockPct: 0 });
    }
  });
});

describe('addEnemy: the v3 record (docs/v3 C7 design §1.3)', () => {
  it('gives no enemy of an M1 run a record, and every enemy of a v3 run one, M1 types included', () => {
    for (const data of [loadGameData(), makeTestData()]) {
      const enemies = enemiesOf(data, 10, 600);
      expect(typesOf(enemies)).toEqual(expect.arrayContaining(['triangle', 'pentagon', 'boss']));
      expect(enemies.filter((enemy) => enemy.v3 !== null)).toEqual([]);
    }
    for (const data of [characterGameData(), v3TestData()]) {
      const enemies = enemiesOf(data, 50, 600);
      expect(typesOf(enemies)).toEqual(
        expect.arrayContaining(['triangle', 'square', 'shielder', 'dasher', 'summoner', 'onion']),
      );
      for (const enemy of enemies) {
        // Wave spawns and their splits: none is extra, and only the treasure would be.
        expect(enemy.v3, enemy.type).toEqual(createEnemyV3(data.enemies[enemy.type], undefined));
      }
    }
  });

  it('adds the record as the literal’s 58th key in either run', () => {
    for (const data of [makeTestData(), v3TestData()]) {
      const keys = Object.keys(placedEnemies([{ x: 1400, y: 540 }], { data }).enemies[0] as Enemy);
      expect(keys).toHaveLength(58);
      expect(keys).toContain('v3');
    }
  });

  it('takes the origin’s hp and radius scales in a v3 run, and a wave spawn’s def values', () => {
    const ctx = placedEnemies([], { data: v3TestData() });
    const rec = ctx.current as WaveRecord;
    const def = ctx.data.enemies.hexagon;
    const plain = spawned(ctx, def);
    expect([plain.hp, plain.maxHp]).toEqual([
      mul(num(def.hpMult), rec.stdHp),
      mul(num(def.hpMult), rec.stdHp),
    ]);
    expect([plain.radius, plain.contactDist]).toEqual([def.radius, PLAYER_RADIUS + def.radius]);
    const child = spawned(ctx, def, ORIGIN);
    expect([child.hp, child.maxHp]).toEqual([
      mul(num(def.hpMult * 0.25), rec.stdHp),
      mul(num(def.hpMult * 0.25), rec.stdHp),
    ]);
    expect(child.radius).toBe(def.radius * 0.7);
    expect(child.contactDist).toBe(PLAYER_RADIUS + def.radius * 0.7);
    expect(child.v3).toEqual({ ai: AI_NONE, extra: true, defence: 0, blockPct: 0, contactMult: 1 });
    expect([child.tough, child.boss, child.stepDist]).toEqual([true, false, plain.stepDist]);
  });

  it('keeps an M1 run’s hp, radius and contact distance, with no record, whatever the origin', () => {
    const ctx = placedEnemies([], { data: makeTestData() });
    const rec = ctx.current as WaveRecord;
    const def = ctx.data.enemies.hexagon;
    for (const origin of [undefined, ORIGIN]) {
      const enemy = spawned(ctx, def, origin);
      expect(enemy.hp).toEqual(mul(num(def.hpMult), rec.stdHp));
      expect([enemy.radius, enemy.contactDist]).toEqual([def.radius, PLAYER_RADIUS + def.radius]);
      expect(enemy.v3).toBeNull();
    }
  });

  it('reads tough and boss from the def’s flags, not its id', () => {
    const ctx = placedEnemies([], { data: v3TestData() });
    const { enemies } = ctx.data;
    const flags = (def: EnemyDef): [boolean, boolean] => {
      const enemy = spawned(ctx, def);
      return [enemy.tough, enemy.boss];
    };
    expect(flags(enemies.triangle)).toEqual([false, false]);
    expect(flags(enemies.shielder)).toEqual([false, false]);
    expect(flags(enemies.hexagon)).toEqual([true, false]);
    expect(flags(enemies.boss)).toEqual([true, true]);
    expect(flags(enemies.onion)).toEqual([true, true]);
    expect(flags({ ...enemies.square, tough: true })).toEqual([true, false]);
    expect(flags({ ...enemies.hexagon, tough: false })).toEqual([false, false]);
  });
});

describe('shotPad (docs/v3 C7 design §2.1; C4 N18)', () => {
  const padOf = (data: GameData): number => createRunContext(makeConfig(), data).shotPad;

  it('is 22 for M1, test, stress and v3 data, and ignores a large type the run cannot spawn', () => {
    for (const data of [
      loadGameData(),
      makeTestData(),
      stressData(),
      characterGameData(),
      v3TestData(),
    ]) {
      expect(padOf(data)).toBe(22);
    }
    // A shielder or treasure of radius 30 in M1 test data: nothing in an M1 run brings it.
    expect(padOf(makeTestData({ enemies: { shielder: { radius: 30 } } }))).toBe(22);
    expect(padOf(makeTestData({ enemies: { treasure: { radius: 30 } } }))).toBe(22);
  });

  it('covers every non-tough type a v3 run can spawn: its rules’, its treasure, its summons and bursts', () => {
    expect(padOf(v3TestData({ enemies: { shielder: { radius: 30 } } }))).toBe(30);
    expect(padOf(v3TestData({ enemies: { treasure: { radius: 31 } } }))).toBe(31);
    // A summoner whose summons are squares, and an onion that bursts into shards.
    const summons = v3TestData({
      enemies: {
        square: { radius: 32 },
        summoner: {
          behaviour: { kind: 'summon', stopDist: 480, periodSec: 3, enemy: 'square', count: 2 },
        },
      },
      waves: { rules: [{ enemy: 'summoner', fromWave: 1, base: 1, perWave: 0, maxCount: 1 }] },
    });
    expect(padOf(summons)).toBe(32);
    const bursts = v3TestData({
      enemies: {
        shard: { radius: 33 },
        onion: { behaviour: { kind: 'layers', layers: 3, burst: { enemy: 'shard', count: 12 } } },
      },
      waves: { rules: [{ enemy: 'square', fromWave: 1, base: 1, perWave: 0, maxCount: 1 }] },
    });
    expect(padOf(bursts)).toBe(33);
    // The tough ones stay out of it, the onion's 70 among them.
    expect(padOf(v3TestData({ enemies: { hexagon: { radius: 40 } } }))).toBe(22);
  });
});
