import { describe, expect, it } from 'vitest';
import type { RuleSpec } from '../../data/rules';
import { compileBuild } from '../build/compile';
import { UNCAPPED_BURN_STACKS } from '../simulation';
import { eventsOf, makeConfig, makeStats, recordRun, stationarySquares } from '../testing';
import type { RunConfig, SimEvent } from '../types';

const ETERNAL: RuleSpec = { id: 'eternalFlame', durationMore: -0.5 };

const run = (config: Partial<RunConfig>) =>
  recordRun(makeConfig({ maxTicks: 600, ...config }), stationarySquares(1));

describe('eternalFlame', () => {
  it('removes the stack cap and shortens burns', () => {
    const stats = makeStats({
      damage: 1,
      attackSpeed: 20,
      igniteChance: 1,
      burnDuration: 4,
      burnMaxStacks: 5,
    });
    const capped = run({ stats, maxTicks: 120 });
    const flame = run({ stats, rules: [ETERNAL], maxTicks: 120 });
    const maxStacks = (ticks: readonly (readonly SimEvent[])[]): number =>
      Math.max(...eventsOf(ticks, 'ignite').map((event) => event.stacks));
    expect(maxStacks(capped.ticks)).toBe(5);
    expect(maxStacks(flame.ticks)).toBeGreaterThan(5);
    expect(maxStacks(flame.ticks)).toBeLessThan(UNCAPPED_BURN_STACKS);
  });

  it('halves the burn of one stack', () => {
    // One attack, at tick 480 of 900: the stack's whole burn is its dps × its duration.
    const stats = makeStats({
      damage: 1,
      attackSpeed: 0.125,
      projectileCount: 1,
      critChance: 0,
      igniteChance: 1,
      burnDamage: 1,
      burnDuration: 4,
    });
    const burnOf = (rules: RuleSpec[]): number => {
      const { ticks } = run({ stats, rules, maxTicks: 900 });
      expect(eventsOf(ticks, 'ignite')).toHaveLength(1);
      return eventsOf(ticks, 'burnTick').reduce((sum, tick) => sum + tick.amount, 0);
    };
    expect(burnOf([])).toBeCloseTo(4, 9);
    expect(burnOf([ETERNAL])).toBeCloseTo(2, 9);
  });

  it('sets the burn rings flag and multiplies the durations of its instances', () => {
    const rules: RuleSpec[] = [ETERNAL, { id: 'eternalFlame', durationMore: 0.25 }];
    const build = compileBuild(makeStats({ burnDuration: 4 }), rules);
    expect(build.flags.burnRings).toBe(true);
    expect(build.values.burnDuration).toBe(4 * (0.5 * 1.25));
    expect(compileBuild(makeStats(), []).flags.burnRings).toBe(false);
  });
});
