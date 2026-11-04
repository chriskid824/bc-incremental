import { describe, expect, it } from 'vitest';
import type { RuleSpec } from '../../data/rules';
import { compileBuild } from '../build/compile';
import { makeStats } from '../testing';

const flagsOf = (rules: readonly RuleSpec[]) => {
  const f = compileBuild(makeStats(), rules).flags;
  return {
    eliteFirst: f.summonEliteFirst,
    countMult: f.droneCountMult,
    stay: f.dronesStay,
    rateMult: f.turretRateMult,
    splash: f.turretSplash,
    chains: f.turretChains,
  };
};

describe("the summon outer's policy rules (C5.9 flags)", () => {
  it('leaves every flag at its default without them', () => {
    expect(flagsOf([])).toEqual({
      eliteFirst: false,
      countMult: 1,
      stay: false,
      rateMult: 1,
      splash: 0,
      chains: 0,
    });
  });

  it('sets 鎖定信標, 加農砲, 特斯拉塔 and 蟲海 at gd’s numbers', () => {
    expect(
      flagsOf([
        { id: 'lockBeacon' },
        { id: 'cannon', rateMult: 1 / 3, splash: 60 },
        { id: 'teslaTower', chains: 2 },
        { id: 'bugSea', countMult: 2 },
      ]),
    ).toEqual({
      eliteFirst: true,
      countMult: 2,
      stay: true,
      rateMult: 1 / 3,
      splash: 60,
      chains: 2,
    });
  });

  it('multiplies the cannon rates, takes the largest splash and count, and adds the chains', () => {
    expect(
      flagsOf([
        { id: 'cannon', rateMult: 0.5, splash: 40 },
        { id: 'cannon', rateMult: 0.5, splash: 60 },
        { id: 'teslaTower', chains: 1 },
        { id: 'teslaTower', chains: 2 },
        { id: 'bugSea', countMult: 3 },
        { id: 'bugSea', countMult: 2 },
      ]),
    ).toMatchObject({ rateMult: 0.25, splash: 60, chains: 3, countMult: 3 });
  });
});
