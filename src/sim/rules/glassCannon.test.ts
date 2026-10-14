import { describe, expect, it } from 'vitest';
import type { RuleSpec } from '../../data/rules';
import { TAG } from '../../data/tags';
import { compileBuild } from '../build/compile';
import { createSimulation } from '../simulation';
import {
  damageRow,
  eventsOf,
  makeConfig,
  makeStats,
  maskProbeMods,
  recordRun,
  stationarySquares,
} from '../testing';
import type { RunConfig } from '../types';

const GLASS: RuleSpec = { id: 'glassCannon', damageMore: 1 };

const run = (config: Partial<RunConfig>) =>
  recordRun(makeConfig({ maxTicks: 600, ...config }), stationarySquares(1));

describe('glassCannon', () => {
  it('doubles damage and sets life to 1', () => {
    const stats = makeStats({ damage: 10, critChance: 0 });
    const data = stationarySquares(1);
    const plain = run({ stats });
    const glass = run({ stats, rules: [GLASS] });
    expect(eventsOf(plain.ticks, 'hit')[0]?.amount).toBe(10);
    expect(eventsOf(glass.ticks, 'hit')[0]?.amount).toBe(20);
    const sim = createSimulation(makeConfig({ stats, rules: [GLASS] }), data);
    expect(sim.state.player.maxLife).toBe(1);
    expect(sim.state.player.life).toBe(1);
  });

  it('doubles burns too', () => {
    const stats = makeStats({ damage: 10, critChance: 0, igniteChance: 1, attackSpeed: 2 });
    const burns = (rules: RuleSpec[]): number[] =>
      eventsOf(run({ stats, rules }).ticks, 'burnTick').map((tick) => tick.amount);
    const plain = burns([]);
    expect(plain.length).toBeGreaterThan(10);
    expect(burns([GLASS])).toEqual(plain.map((amount) => amount * 2));
  });

  it('adds an untagged damage more after the build modifiers, reaching every row', () => {
    const stats = makeStats({}, maskProbeMods());
    const build = compileBuild(stats, [GLASS]);
    expect(build.mods).toHaveLength(stats.scoped.length + 1);
    expect(build.mods.at(-1)).toMatchObject({ stat: 0, kind: 2, value: 1, untagged: true });
    for (let mask = 0; mask < 16; mask++) {
      expect(damageRow(stats, mask, [GLASS])).toBe(damageRow(stats, mask) * 2);
    }
    expect(damageRow(stats, TAG.poison | TAG.minion, [GLASS])).toBe(2);
    expect(build.flags.maxLife).toBe(1);
  });
});
