import { describe, expect, it } from 'vitest';
import type { RuleSpec } from '../../data/rules';
import { compileBuild } from '../build/compile';
import { makeStats } from '../testing';

const ZERO: RuleSpec = {
  id: 'absoluteZero',
  globalSlow: 0.3,
  bossGapSec: 1,
  attackSpeedMore: -0.25,
};

describe('absoluteZero (絕對零度)', () => {
  it('slows every enemy, drops the freeze immunity and the boss lock to the gap, and slows attacks', () => {
    const plain = compileBuild(makeStats({ attackSpeed: 2 }), []);
    const build = compileBuild(makeStats({ attackSpeed: 2 }), [ZERO]);
    expect(plain.flags).toMatchObject({
      globalSlow: 0,
      frostImmuneTicks: 180,
      bossLockTicks: 252,
      bossMinGapTicks: 0,
    });
    expect(build.flags).toMatchObject({
      globalSlow: 0.3,
      frostImmuneTicks: 0,
      bossLockTicks: 0,
      bossMinGapTicks: 60,
    });
    expect(build.values.attackSpeed).toBeCloseTo(1.5, 12);
  });

  it('takes the largest slow and gap over instances, and multiplies the attack speed factors', () => {
    const build = compileBuild(makeStats({ attackSpeed: 2 }), [
      ZERO,
      { id: 'absoluteZero', globalSlow: 0.2, bossGapSec: 2, attackSpeedMore: -0.5 },
    ]);
    expect(build.flags.globalSlow).toBe(0.3);
    expect(build.flags.bossMinGapTicks).toBe(120);
    expect(build.values.attackSpeed).toBeCloseTo(0.75, 12);
  });
});
