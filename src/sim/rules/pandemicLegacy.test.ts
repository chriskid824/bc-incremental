import { describe, expect, it } from 'vitest';
import type { RuleSpec } from '../../data/rules';
import { compileBuild } from '../build/compile';
import { makeStats } from '../testing';

describe('pandemicLegacy', () => {
  it('multiplies the hit multipliers of its instances and spreads once per kill', () => {
    const rules: RuleSpec[] = [
      { id: 'pandemic', spreadRadius: 250, spreadEffect: 0.4, hitMore: -0.3 },
      { id: 'pandemic', spreadRadius: 100, spreadEffect: 0.5, hitMore: -0.5 },
    ];
    const build = compileBuild(makeStats(), rules);
    expect(build.legacyHitMult).toBe(0.7 * 0.5);
    expect(build.hooks.onKill).toHaveLength(1);
    expect(build.hooks.tick).toHaveLength(0);
    expect(compileBuild(makeStats(), []).legacyHitMult).toBe(1);
  });
});
