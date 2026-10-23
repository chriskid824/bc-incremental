import { describe, expect, it } from 'vitest';
import { mul, num, toNumber, ZERO } from '../core/num';
import type { Num } from '../core/num';
import { loadGameData } from '../data';
import { composeWave } from '../data/compose';
import { shardsPerStdEnemy } from '../data/curve';
import { NO_EXTRAS } from '../data/stats';
import type { StatBlock } from '../data/stats';
import { ENEMY_IDS } from '../data/types';
import type { EnemyId, GameData } from '../data/types';
import { COUNTER_IDS } from '../sim/types';
import type { RunResult } from '../sim/types';
import { allowedStartWave, expectedWaveDrops, settleRun, settleUnfinishedRun } from './settle';
import { createMetaState } from './state';
import { computeStatBlock } from './stats';
import { FIXTURE_ENEMIES, fixtureData } from './testing';
import { DEFAULT_ECONOMY } from './types';

const data = fixtureData();
const baseStats = computeStatBlock([], NO_EXTRAS);
const boostedStats = computeStatBlock(
  [
    { stat: 'shardGain', kind: 'increased', value: 1 },
    { stat: 'coreGain', kind: 'increased', value: 0.5 },
  ],
  NO_EXTRAS,
);

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    startWave: 1,
    highestWaveReached: 5,
    highestWaveCleared: 4,
    clearedStartWave: true,
    endReason: 'death',
    ticks: 3600,
    shards: num(50),
    cores: 2,
    kills: 30,
    damage: { hit: ZERO, crit: ZERO, burn: ZERO, chain: ZERO, poison: ZERO, bleed: ZERO },
    damageBySource: { center: ZERO },
    counters: Object.fromEntries(COUNTER_IDS.map((id) => [id, 0])) as RunResult['counters'],
    maxHit: num(10),
    overkillSeconds: 0,
    leaks: 0,
    damageTaken: 0,
    damageTakenBy: Object.fromEntries(
      ENEMY_IDS.map((id) => [id, { hits: 0, damage: 0 }]),
    ) as RunResult['damageTakenBy'],
    killedBy: null,
    ...overrides,
  };
}

function sumExpected(
  toWaveExclusive: number,
  stats = baseStats,
): { shards: number; cores: number } {
  let shards = 0;
  let cores = 0;
  for (let wave = 1; wave < toWaveExclusive; wave++) {
    const drops = expectedWaveDrops(wave, data, stats);
    shards += toNumber(drops.shards);
    cores += drops.cores;
  }
  return { shards, cores };
}

describe('allowedStartWave', () => {
  it('is floor(maxWave × ratio) but never below 1', () => {
    const meta = createMetaState();
    expect(allowedStartWave(meta, DEFAULT_ECONOMY)).toBe(1);
    meta.maxWave = 1;
    expect(allowedStartWave(meta, DEFAULT_ECONOMY)).toBe(1);
    meta.maxWave = 41;
    expect(allowedStartWave(meta, DEFAULT_ECONOMY)).toBe(20);
    expect(allowedStartWave(meta, { ...DEFAULT_ECONOMY, startWaveRatio: 0.75 })).toBe(30);
  });
});

describe('expectedWaveDrops', () => {
  // Fixture drop units: triangle 0.5, square 1, pentagon 1 + 3 × shard 0.25, hexagon 3, boss 6.
  const cases = [
    { wave: 1, shardMult: 4 * 0.5, cores: 0 }, // 4 triangles
    { wave: 3, shardMult: 5 * 0.5 + 2, cores: 0 }, // 5 triangles, 2 squares
    { wave: 5, shardMult: 6 * 0.5 + 2 + 3, cores: 1 }, // + elite
    { wave: 8, shardMult: 7 * 0.5 + 3 + 1.75, cores: 0 }, // + 1 pentagon with 3 split shards
    { wave: 10, shardMult: 8 * 0.5 + 3 + 1.75 + 6, cores: 5 }, // + boss
  ];

  for (const { wave, shardMult, cores } of cases) {
    it(`wave ${wave}`, () => {
      const drops = expectedWaveDrops(wave, data, baseStats);
      expect(toNumber(drops.shards)).toBeCloseTo(shardMult * shardsPerStdEnemy(wave), 9);
      expect(drops.cores).toBe(cores);
    });
  }

  it('scales with shardGain and coreGain', () => {
    const drops = expectedWaveDrops(10, data, boostedStats);
    expect(toNumber(drops.shards)).toBeCloseTo(2 * 14.75 * shardsPerStdEnemy(10), 9);
    expect(drops.cores).toBeCloseTo(7.5, 12);
  });

  it('leaves an M1 block’s drops bit-identical, its toughDropMult being 1, and scales only tough and boss units at 2 (docs/v3 C7 design §2.5, OWN test 14)', () => {
    // Planted bug: multiplying non-tough units.
    /** Drop units, the type's and its split children's (dropUnits). */
    const unitsOf = (d: GameData, enemy: EnemyId): [number, number] => {
      const def = d.enemies[enemy];
      if (def.splitInto === undefined) return [def.dropMult, def.cores];
      const [shardMult, cores] = unitsOf(d, def.splitInto.enemy);
      return [
        def.dropMult + def.splitInto.count * shardMult,
        def.cores + def.splitInto.count * cores,
      ];
    };
    /** expectedWaveDrops as it was before toughDropMult, operation for operation. */
    const before = (
      wave: number,
      d: GameData,
      stats: StatBlock,
    ): { shards: Num; cores: number } => {
      let shardMult = 0;
      let cores = 0;
      for (const entry of composeWave(wave, d.waves)) {
        const units = unitsOf(d, entry.enemy);
        shardMult += entry.count * units[0];
        cores += entry.count * units[1];
      }
      return {
        shards: mul(num(shardsPerStdEnemy(wave)), shardMult * stats.values.shardGain),
        cores: cores * stats.values.coreGain,
      };
    };
    for (const d of [data, loadGameData()]) {
      for (const stats of [baseStats, boostedStats]) {
        expect(stats.values.toughDropMult).toBe(1);
        for (let wave = 1; wave <= 200; wave++) {
          const drops = expectedWaveDrops(wave, d, stats);
          const reference = before(wave, d, stats);
          expect(
            Object.is(toNumber(drops.shards), toNumber(reference.shards)),
            `wave ${wave}`,
          ).toBe(true);
          expect(Object.is(drops.cores, reference.cores), `wave ${wave}`).toBe(true);
        }
      }
    }
    // 菁英賞金's ×2: wave 5's elite (3 units, a core) and wave 10's boss (6 units, 5 cores) double.
    const bounty = computeStatBlock(
      [{ stat: 'toughDropMult', kind: 'increased', value: 1 }],
      NO_EXTRAS,
    );
    expect(bounty.values.toughDropMult).toBe(2);
    for (const { wave, shardMult, cores } of [
      { wave: 3, shardMult: 5 * 0.5 + 2, cores: 0 },
      { wave: 5, shardMult: 6 * 0.5 + 2 + 2 * 3, cores: 2 },
      { wave: 8, shardMult: 7 * 0.5 + 3 + 1.75, cores: 0 },
      { wave: 10, shardMult: 8 * 0.5 + 3 + 1.75 + 2 * 6, cores: 10 },
    ]) {
      const drops = expectedWaveDrops(wave, data, bounty);
      expect(toNumber(drops.shards), `wave ${wave}`).toBeCloseTo(
        shardMult * shardsPerStdEnemy(wave),
        9,
      );
      expect(drops.cores, `wave ${wave}`).toBe(cores);
    }
  });

  it('rejects cyclic splits', () => {
    const cyclic = fixtureData({
      enemies: {
        ...FIXTURE_ENEMIES,
        shard: { ...FIXTURE_ENEMIES.shard, splitInto: { enemy: 'pentagon', count: 1 } },
      },
    });
    expect(() => expectedWaveDrops(8, cyclic, baseStats)).toThrow(/Cyclic/);
  });
});

describe('settleRun', () => {
  it('adds run drops without skip reward when starting at wave 1', () => {
    const meta = createMetaState();
    const settlement = settleRun(meta, runResult(), data, baseStats, DEFAULT_ECONOMY);
    expect(settlement).toEqual({ shardsFromRun: 50, coresFromRun: 2, skipShards: 0, skipCores: 0 });
    expect(toNumber(meta.shards)).toBe(50);
    expect(meta.cores).toBe(2);
    expect(meta.maxWave).toBe(5);
    expect(meta.runs).toBe(1);
  });

  it('gives no skip reward when the start wave was not cleared', () => {
    const meta = createMetaState();
    const result = runResult({ startWave: 6, clearedStartWave: false, highestWaveReached: 6 });
    const settlement = settleRun(meta, result, data, baseStats, DEFAULT_ECONOMY);
    expect(toNumber(settlement.skipShards)).toBe(0);
    expect(settlement.skipCores).toBe(0);
    expect(toNumber(meta.shards)).toBe(50);
    expect(meta.maxWave).toBe(6);
  });

  it('adds the expected drops of every skipped wave', () => {
    const meta = createMetaState();
    meta.shards = num(10);
    meta.cores = 1;
    const result = runResult({ startWave: 6, highestWaveReached: 9 });
    const settlement = settleRun(meta, result, data, baseStats, DEFAULT_ECONOMY);
    const expected = sumExpected(6);
    expect(toNumber(settlement.skipShards)).toBeCloseTo(expected.shards, 9);
    expect(settlement.skipCores).toBe(1); // the wave-5 elite
    expect(toNumber(meta.shards)).toBeCloseTo(10 + 50 + expected.shards, 9);
    expect(meta.cores).toBe(1 + 2 + 1);
    expect(meta.maxWave).toBe(9);
    expect(meta.runs).toBe(1);
  });

  it('applies skipRewardRate and floors skip cores', () => {
    const meta = createMetaState();
    const economy = { ...DEFAULT_ECONOMY, skipRewardRate: 0.5 };
    const result = runResult({ startWave: 11, highestWaveReached: 14, cores: 0 });
    const settlement = settleRun(meta, result, data, boostedStats, economy);
    const expected = sumExpected(11, boostedStats);
    // (1 elite + 5 boss) × coreGain 1.5 × rate 0.5 = 4.5 → 4.
    expect(expected.cores).toBeCloseTo(9, 12);
    expect(settlement.skipCores).toBe(4);
    expect(toNumber(settlement.skipShards)).toBeCloseTo(expected.shards * 0.5, 9);
    expect(meta.cores).toBe(4);
  });

  it('keeps the best maxWave and counts every run', () => {
    const meta = createMetaState();
    meta.maxWave = 30;
    settleRun(meta, runResult({ highestWaveReached: 12 }), data, baseStats, DEFAULT_ECONOMY);
    expect(meta.maxWave).toBe(30);
    settleRun(meta, runResult({ highestWaveReached: 33 }), data, baseStats, DEFAULT_ECONOMY);
    expect(meta.maxWave).toBe(33);
    expect(meta.runs).toBe(2);
  });
});

describe('settleUnfinishedRun', () => {
  it('banks the drops so far, keeps the best maxWave and counts the run, with no skip reward', () => {
    const meta = createMetaState();
    meta.shards = num(100);
    meta.cores = 1;
    meta.maxWave = 30;
    const settlement = settleUnfinishedRun(meta, {
      shards: num(40),
      cores: 2,
      highestWaveReached: 12,
    });
    expect(toNumber(meta.shards)).toBe(140);
    expect(meta.cores).toBe(3);
    expect(meta.maxWave).toBe(30);
    expect(meta.runs).toBe(1);
    expect(toNumber(settlement.shardsFromRun)).toBe(40);
    expect(settlement.coresFromRun).toBe(2);
    expect(toNumber(settlement.skipShards)).toBe(0);
    expect(settlement.skipCores).toBe(0);
    settleUnfinishedRun(meta, { shards: ZERO, cores: 0, highestWaveReached: 31 });
    expect(meta.maxWave).toBe(31);
    expect(meta.runs).toBe(2);
  });
});
