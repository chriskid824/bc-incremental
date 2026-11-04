import { describe, expect, it } from 'vitest';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import { compileBuild } from '../build/compile';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData } from '../testing';
import { NO_INPUT } from '../types';
import type { SimEvent } from '../types';

const SWARM: SignatureSpec = { id: 'swarm' };
const MAGMA: SignatureSpec = { id: 'magmaBomb' };
const FLAME: RuleSpec = { id: 'flameBee', burnStacks: 2, blastRadius: 60, blastDamagePct: 1 };
const FROST: RuleSpec = { id: 'frostBee', frostPct: 0.5 };

/** 6 squares that walk in and never die to damage. */
const TOUGH_SQUARES = makeTestData({
  enemies: { square: { hpMult: 1e12 } },
  waves: {
    rules: [{ enemy: 'square', fromWave: 1, base: 6, perWave: 0, maxCount: 6 }],
    eliteEvery: 1000,
    bossEvery: 1000,
    spawnDurationSec: 0,
    waveTimerSec: 1000,
  },
});

/** The events of a swarm run of `rules` on TOUGH_SQUARES, `ticks` long. */
function run(rules: readonly RuleSpec[], ticks: number): SimEvent[] {
  const sim = createSimulation(
    makeConfig({ stats: makeStats({ maxLife: 1e12 }), signature: SWARM, rules, maxTicks: ticks }),
    TOUGH_SQUARES,
  );
  const events: SimEvent[] = [];
  while (!sim.state.finished) events.push(...sim.step(NO_INPUT));
  return events;
}

const count = (events: readonly SimEvent[], type: SimEvent['type']): number =>
  events.filter((e) => e.type === type).length;

describe('flameBee (焰蜂)', () => {
  it('compiles an impact burn and a kill blast', () => {
    const build = compileBuild(makeStats(), [FLAME], SWARM);
    const specs = build.effects.map((fx) => fx.spec);
    expect(specs).toContainEqual(
      expect.objectContaining({ kind: 'applyAilment', ailment: 'burn', stacks: 2 }),
    );
    expect(specs).toContainEqual(
      expect.objectContaining({ kind: 'explode', radius: 60, damagePct: 1 }),
    );
  });

  it('ignites the enemies the drones impact', () => {
    const plain = run([], 1800);
    const flame = run([FLAME], 1800);
    expect(count(plain, 'impact')).toBeGreaterThan(0);
    expect(count(flame, 'ignite')).toBeGreaterThan(count(plain, 'ignite'));
  });

  it('is a compile error in a run of another signature', () => {
    expect(() => compileBuild(makeStats(), [FLAME], MAGMA)).toThrow(
      "rule 'flameBee' tunes the swarm signature, but this run's signature is 'magmaBomb'",
    );
  });
});

describe('frostBee (霜蜂) and the execute effect', () => {
  it('compiles an impact chill and an execute for normal and elite enemies only', () => {
    const build = compileBuild(makeStats(), [FROST], SWARM);
    const specs = build.effects.map((fx) => fx.spec);
    expect(specs).toContainEqual({ kind: 'addFrost', amount: 0.5 });
    expect(specs.filter((s) => s.kind === 'execute')).toHaveLength(2);
  });

  it('freezes the enemies it impacts and then executes them', () => {
    const plain = run([], 1800);
    const frost = run([FROST], 1800);
    expect(count(plain, 'enemyKilled')).toBe(0);
    expect(count(frost, 'freeze')).toBeGreaterThan(0);
    expect(count(frost, 'enemyKilled')).toBeGreaterThan(0);
  });
});
