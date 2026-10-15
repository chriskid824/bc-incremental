import { describe, expect, it } from 'vitest';
import type { RuleSpec } from '../../data/rules';
import type { Modifier } from '../../data/stats';
import { TAG } from '../../data/tags';
import { centerStat, compileBuild } from '../build/compile';
import { SCOPED_INDEX } from '../build/modTable';
import { eventsOf, makeConfig, makeStats, recordRun, stationarySquares } from '../testing';

const CRIT_MULTIPLIER = SCOPED_INDEX.critMultiplier;
const STEADY: RuleSpec = { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' };

/** Crit multiplier +1 per chain jump: a dynamic entry, read through evalDynamic. */
const PER_JUMP: Modifier = {
  stat: 'critMultiplier',
  kind: 'flat',
  value: 1,
  scaling: { per: 'chainJump' },
};

describe('steadyAim', () => {
  it('crits exactly every Nth shot with the extra crit multiplier', () => {
    const stats = makeStats({ damage: 10, critChance: 0.9, critMultiplier: 2, attackSpeed: 6 });
    const { ticks } = recordRun(
      makeConfig({ stats, rules: [STEADY], maxTicks: 600 }),
      stationarySquares(1),
    );
    const hits = eventsOf(ticks, 'hit');
    expect(hits.length).toBeGreaterThanOrEqual(9);
    hits.forEach((hit, i) => {
      const crit = (i + 1) % 3 === 0;
      expect(hit.crit).toBe(crit);
      expect(hit.amount).toBe(crit ? 10 * 2 * 1.5 : 10);
    });
  });

  it('turns random crits off and merges instances: smallest N, multipliers multiply', () => {
    const rules: RuleSpec[] = [
      { id: 'steadyAim', everyNth: 5, critMultiplierMore: 0.5, counts: 'shot' },
      { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.25, counts: 'attack' },
      { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0, counts: 'shot' },
    ];
    const build = compileBuild(makeStats({ critMultiplier: 2 }), rules);
    expect(build.flags.randomCrits).toBe(false);
    // What N counts comes with the smallest N, from its first instance.
    expect(build.signature).toEqual({ forceCritEvery: 3, counts: 'attack', lob: null });
    expect(build.values.critMultiplier).toBe(2 * (1.5 * 1.25));
    const plain = compileBuild(makeStats(), []);
    expect(plain.flags.randomCrits).toBe(true);
    expect(plain.signature).toEqual({ forceCritEvery: 0, counts: 'shot', lob: null });
  });

  it('multiplies static and dynamic crit multiplier entries alike', () => {
    const stats = makeStats({ critMultiplier: 2 }, [
      { stat: 'critMultiplier', kind: 'more', value: 0.5, tags: ['chain'] },
      PER_JUMP,
    ]);
    const plain = compileBuild(stats, []);
    const steady = compileBuild(stats, [STEADY]);
    const crit = TAG.hit | TAG.crit;
    expect(centerStat(steady, crit, CRIT_MULTIPLIER)).toBe(3);
    expect(centerStat(steady, crit, CRIT_MULTIPLIER)).toBe(steady.values.critMultiplier);
    for (const jump of [1, 2, 5]) {
      const chained = crit | TAG.chain;
      const expected = (2 + jump) * 1.5;
      expect(centerStat(plain, chained, CRIT_MULTIPLIER, jump)).toBe(expected);
      expect(centerStat(steady, chained, CRIT_MULTIPLIER, jump)).toBe(expected * 1.5);
    }
  });

  it('multiplies a per-jump crit multiplier in the simulation', () => {
    // Jumps always crit, primary hits never do (random crits off, the 1000th shot is far off).
    const stats = makeStats(
      {
        damage: 10,
        critChance: 0,
        critMultiplier: 2,
        chainCount: 2,
        chainRange: 5000,
        chainRetention: 1,
        attackSpeed: 10,
      },
      [{ stat: 'critAlways', kind: 'flat', value: 1, tags: ['chain'] }, PER_JUMP],
    );
    const rules: RuleSpec[] = [
      { id: 'steadyAim', everyNth: 1000, critMultiplierMore: 0.5, counts: 'shot' },
    ];
    const { ticks } = recordRun(makeConfig({ stats, rules, maxTicks: 300 }), stationarySquares(4));
    const hits = eventsOf(ticks, 'hit');
    expect(hits.some((hit) => hit.chainIndex === 2)).toBe(true);
    for (const hit of hits) {
      expect(hit.crit).toBe(hit.chainIndex > 0);
      expect(hit.amount).toBe(hit.chainIndex > 0 ? 10 * ((2 + hit.chainIndex) * 1.5) : 10);
    }
  });
});
