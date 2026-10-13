import { describe, expect, it } from 'vitest';
import { num } from '../../src/core/num';
import { computeStatBlock } from '../../src/meta';
import type { RunResult, SimEvent } from '../../src/sim';
import { maskProbeMods, projectEvent, projectResult } from '../../src/sim/testing';
import {
  caseLine,
  compareResults,
  differingLines,
  fingerprintCases,
  parseCaseLines,
  RULE_SETS,
  runCase,
  STAT_PROFILES,
} from './fingerprint';

describe('fingerprint cases', () => {
  const cases = fingerprintCases();

  it('has 972 synthetic and 60 talent cases with unique ids', () => {
    expect(Object.keys(STAT_PROFILES)).toHaveLength(6);
    expect(Object.keys(RULE_SETS)).toHaveLength(9);
    expect(cases.filter((c) => !c.id.startsWith('talent/'))).toHaveLength(972);
    expect(cases.filter((c) => c.id.startsWith('talent/'))).toHaveLength(60);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('runs the M1 rules through the real talent builds', () => {
    const rulesOf = (id: string): string[] =>
      (cases.find((c) => c.id === id)?.config.rules ?? []).map((rule) => rule.id);
    expect(rulesOf('talent/crit/keystone/s1/w1')).toEqual(['steadyAim']);
    expect(rulesOf('talent/dot/keystone/s1/w1')).toEqual(['pandemic']);
    expect(rulesOf('talent/chain/keystone/s1/w1')).toEqual(['overload']);
    expect(rulesOf('talent/dot/glassCannon/s1/w1')).toEqual(['glassCannon']);
    expect(rulesOf('talent/chain/plain/s1/w1')).toEqual([]);
    expect(rulesOf('talent/crit/bridges/s1/w1').sort()).toEqual([
      'chainCritChance',
      'chainIgniteChance',
      'critIgniteChance',
      'critsAlwaysIgnite',
    ]);
  });

  it('gives the synthetic builds the damage table of maskProbeMods', () => {
    const stats = cases.find((c) => c.id === 'test/crit/none/s1/w1')?.config.stats;
    expect(stats?.values.critChance).toBe(0.4);
    expect(stats?.damageMult).toEqual(computeStatBlock(maskProbeMods()).damageMult);
  });

  it('runs a case to the same digest twice, and its line reads back', () => {
    const one = cases.find((c) => c.id === 'test/burn/pandemic/s2/w12');
    if (one === undefined) throw new Error('missing case');
    const run = runCase(one);
    expect(runCase(one).digest).toBe(run.digest);
    const line = caseLine(one.id, run);
    expect(parseCaseLines([line]).get(one.id)).toMatchObject({
      digest: run.digest,
      wave: run.result.highestWaveReached,
      kills: run.result.kills,
      leaks: run.result.leaks,
      burn: run.result.damage.burn,
    });
  });
});

describe('maskProbeMods', () => {
  it('folds to 1 + 0.07 × mask, bit for bit, for every M1 tag mask', () => {
    const { damageMult } = computeStatBlock(maskProbeMods());
    damageMult.forEach((mult, mask) => expect(mult).toBe(1 + 0.07 * mask));
  });
});

describe('M1 projection', () => {
  it('keeps the M1 keys of an M1 event in a fixed order and drops later ones', () => {
    const hit = {
      type: 'hit',
      tags: 9,
      targetId: 3,
      x: 1,
      y: 2,
      amount: num(5),
      crit: false,
      chainIndex: 1,
      fromX: 0,
      fromY: 0,
    } as SimEvent;
    expect(projectEvent(hit)).toEqual(['hit', 3, 1, 2, 5, false, 1, 0, 0]);
  });

  it('keeps an event type M1 did not have whole', () => {
    const event = { type: 'shatter', x: 1, y: 2, radius: 90 } as unknown as SimEvent;
    expect(projectEvent(event)).toBe(event);
  });

  it('ignores result fields M1 did not have', () => {
    const tally = { hits: 0, damage: 0 };
    const result = {
      startWave: 1,
      highestWaveReached: 2,
      highestWaveCleared: 1,
      clearedStartWave: true,
      endReason: 'death',
      ticks: 60,
      shards: num(3),
      cores: 0,
      kills: 4,
      damage: { hit: num(1), crit: num(2), burn: num(3), chain: num(4) },
      maxHit: num(2),
      overkillSeconds: 0,
      leaks: 1,
      damageTaken: 8,
      damageTakenBy: {
        triangle: { hits: 1, damage: 8 },
        square: tally,
        pentagon: tally,
        shard: tally,
        hexagon: tally,
        boss: tally,
      },
      killedBy: 'triangle',
    } satisfies RunResult;
    const later = {
      ...result,
      damage: { ...result.damage, poison: num(7) },
      damageBySource: { center: num(10) },
    };
    expect(projectResult(later)).toEqual(projectResult(result));
  });
});

describe('baseline comparison', () => {
  const line = (id: string, digest: string, wave: number, damage: number, burn = 0): string =>
    `${id} ${digest} wave ${wave} kills 10 leaks 2 damage ${damage} burn ${burn}`;
  const baseline = [
    line('a/s1', '0000000000000001', 5, 100),
    line('b/s1', '0000000000000002', 7, 200, 50),
    'cases 2, ticks 99, fingerprint ff',
  ];

  it('finds no difference against itself', () => {
    expect(differingLines(baseline, baseline)).toEqual([]);
    expect(compareResults(baseline, baseline)).toBe('changed 0 of 2 cases');
  });

  it('lists changed, missing and new lines', () => {
    const current = [
      line('b/s1', '00000000000000aa', 8, 202, 51),
      line('c/s1', '0000000000000003', 1, 1),
      'cases 2, ticks 98, fingerprint ee',
    ];
    expect(differingLines(baseline, current)).toEqual([
      [baseline[0], null],
      [baseline[1], current[0]],
      [baseline[2], current[2]],
      [null, current[1]],
    ]);
    const report = compareResults(baseline, current);
    expect(report).toMatch(/^b\/s1\s+1\s+0\s+0\s+1\.000\s+2\.000$/m);
    expect(report).toContain('changed 1 of 2 cases');
    expect(report).toContain('same wave, kills and leaks: 0 of 1 (0.0%)');
    expect(report).toContain('max |Δwave| 1, max |Δdamage| 1.000%, max |Δburn| 2.000%');
    expect(report).toContain('missing now: a/s1');
    expect(report).toContain('new cases: c/s1');
  });
});
