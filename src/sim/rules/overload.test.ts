import { describe, expect, it } from 'vitest';
import type { RuleSpec } from '../../data/rules';
import { TAG } from '../../data/tags';
import { compileBuild } from '../build/compile';
import {
  damageRow,
  eventsOf,
  makeConfig,
  makeStats,
  maskProbeMods,
  recordRun,
  stationarySquares,
} from '../testing';

const M1_OVERLOAD: RuleSpec = { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 };

describe('overload', () => {
  it('doubles chain jumps and lowers retention', () => {
    const stats = makeStats({
      damage: 10,
      critChance: 0,
      chainCount: 2,
      chainRetention: 0.7,
      chainRange: 5000,
    });
    const { ticks } = recordRun(
      makeConfig({ stats, rules: [M1_OVERLOAD], maxTicks: 600 }),
      stationarySquares(8),
    );
    const hits = eventsOf(ticks, 'hit');
    expect(Math.max(...hits.map((hit) => hit.chainIndex))).toBe(4);
    const first = hits.find((hit) => hit.chainIndex === 1);
    expect(first?.amount).toBeCloseTo(5, 12);
  });

  it('changes only chain count and retention with the M1 parameters', () => {
    const stats = makeStats({ chainCount: 1.5, chainRetention: 0.7 }, maskProbeMods());
    const plain = compileBuild(stats, []);
    const build = compileBuild(stats, [M1_OVERLOAD]);
    expect(build.values).toEqual({ ...plain.values, chainCount: 3, chainRetention: 0.7 - 0.2 });
    expect(build.mods).toHaveLength(stats.scoped.length);
    for (let mask = 0; mask < 16; mask++) {
      expect(damageRow(stats, mask, [M1_OVERLOAD])).toBe(damageRow(stats, mask));
    }
  });

  it('with chainMore multiplies chain jumps only, not primary hits or burns', () => {
    const stats = makeStats({
      damage: 10,
      critChance: 0,
      igniteChance: 1,
      chainCount: 2,
      chainRetention: 1,
      chainRange: 5000,
      attackSpeed: 4,
    });
    const neutral = { id: 'overload', chainCountMultiplier: 1, retentionPenalty: 0 } as const;
    const recorded = (rules: RuleSpec[]) =>
      recordRun(makeConfig({ stats, rules, maxTicks: 300 }), stationarySquares(4)).ticks;
    const plain = recorded([neutral]);
    const more = recorded([{ ...neutral, chainMore: 3.5 }]);
    const plainHits = eventsOf(plain, 'hit');
    const moreHits = eventsOf(more, 'hit');
    expect(plainHits.some((hit) => hit.chainIndex > 0)).toBe(true);
    expect(moreHits).toEqual(
      plainHits.map((hit) => (hit.chainIndex > 0 ? { ...hit, amount: hit.amount * 4.5 } : hit)),
    );
    const burns = eventsOf(plain, 'burnTick');
    expect(burns.length).toBeGreaterThan(10);
    expect(eventsOf(more, 'burnTick')).toEqual(burns);
  });

  it("with chainMore leaves a jump's converted part unchanged: it is no hit", () => {
    const stats = makeStats(
      { damage: 10, critChance: 0, chainCount: 2, chainRetention: 1, chainRange: 5000 },
      [],
      {
        triggers: [],
        conversions: [{ source: 'center', spec: { to: 'poison', fraction: 0.3 } }],
        emitters: [],
      },
    );
    const neutral = { id: 'overload', chainCountMultiplier: 1, retentionPenalty: 0 } as const;
    const recorded = (rules: RuleSpec[]) =>
      recordRun(makeConfig({ stats, rules, maxTicks: 300 }), stationarySquares(4)).result;
    const plain = recorded([neutral]);
    const more = recorded([{ ...neutral, chainMore: 3.5 }]);
    expect(plain.damage.chain).toBeGreaterThan(0);
    expect(plain.damage.poison).toBeGreaterThan(0);
    // Every jump's poison part, and every primary hit, as without chainMore.
    expect(more.damage.poison).toBe(plain.damage.poison);
    expect(more.damage.hit).toBe(plain.damage.hit);
    expect(more.damage.chain).toBeCloseTo(plain.damage.chain * 4.5, 9);
  });

  it('compiles chainMore to a [chain, hit] damage more', () => {
    const build = compileBuild(makeStats(), [{ ...M1_OVERLOAD, chainMore: 3.5 }]);
    expect(build.mods).toHaveLength(1);
    expect(damageRow(makeStats(), TAG.hit | TAG.chain, [{ ...M1_OVERLOAD, chainMore: 3.5 }])).toBe(
      4.5,
    );
    for (const mask of [TAG.hit, TAG.hit | TAG.projectile, TAG.burn | TAG.chain, TAG.chain]) {
      expect(damageRow(makeStats(), mask, [{ ...M1_OVERLOAD, chainMore: 3.5 }])).toBe(1);
    }
  });
});
