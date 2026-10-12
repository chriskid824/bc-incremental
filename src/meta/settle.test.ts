import { describe, expect, it } from 'vitest';
import { num, toNumber, ZERO } from '../core/num';
import { shardsPerStdEnemy } from '../data/curve';
import { ENEMY_IDS } from '../data/types';
import type { RunResult } from '../sim/types';
import { allowedStartWave, expectedWaveDrops, settleRun } from './settle';
import { createMetaState } from './state';
import { computeStatBlock } from './stats';
import { FIXTURE_ENEMIES, fixtureData } from './testing';
import { DEFAULT_ECONOMY } from './types';

const data = fixtureData();
const baseStats = computeStatBlock([]);
const boostedStats = computeStatBlock([
  { stat: 'shardGain', kind: 'increased', value: 1 },
  { stat: 'coreGain', kind: 'increased', value: 0.5 },
]);

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
    damage: { hit: ZERO, crit: ZERO, burn: ZERO, chain: ZERO },
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
