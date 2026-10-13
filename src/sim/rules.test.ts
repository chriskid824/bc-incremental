import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed } from '../core/rng';
import type { RuleSpec } from '../data/rules';
import type { Modifier } from '../data/stats';
import type { GameData, WaveTable } from '../data/types';
import { compileRules, NO_RULES } from './rules';
import { createSimulation, UNCAPPED_BURN_STACKS } from './simulation';
import { makeConfig, makeStats, makeTestData, recordRun, SEARING_CRITS_MODS } from './testing';
import { NO_INPUT } from './types';
import type { RunConfig, SimEvent } from './types';

type EventOf<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;

function eventsOf<T extends SimEvent['type']>(
  ticks: readonly (readonly SimEvent[])[],
  type: T,
): EventOf<T>[] {
  return ticks.flat().filter((event): event is EventOf<T> => event.type === type);
}

/** One wave of `count` stationary squares with the given HP multiplier; no later waves. */
function dummyData(count: number, hpMult = 1e12, waves: Partial<WaveTable> = {}): GameData {
  return makeTestData({
    enemies: { square: { hpMult, speed: 0 } },
    waves: {
      rules: [{ enemy: 'square', fromWave: 1, base: count, perWave: 0, maxCount: count }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
      ...waves,
    },
  });
}

function run(config: Partial<RunConfig>, data: GameData) {
  return recordRun(makeConfig({ maxTicks: 600, ...config }), data);
}

describe('compileRules', () => {
  it('is neutral without rules', () => {
    expect(compileRules([])).toEqual(NO_RULES);
  });

  it('multiplies multipliers and adds penalties', () => {
    const rules: RuleSpec[] = [
      { id: 'glassCannon', damageMore: 1 },
      { id: 'glassCannon', damageMore: 0.5 },
      { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.25 },
      { id: 'overload', chainCountMultiplier: 1.5, retentionPenalty: 0.1 },
    ];
    const fx = compileRules(rules);
    expect(fx.allDamageMult).toBe(3);
    expect(fx.maxLife).toBe(1);
    expect(fx.chainCountMult).toBe(3);
    expect(fx.chainRetentionPenalty).toBeCloseTo(0.35, 12);
  });
});

describe('keystones in the simulation', () => {
  it('glassCannon doubles damage and sets life to 1', () => {
    const stats = makeStats({ damage: 10, critChance: 0 });
    const data = dummyData(1);
    const plain = run({ stats }, data);
    const glass = run({ stats, rules: [{ id: 'glassCannon', damageMore: 1 }] }, data);
    expect(eventsOf(plain.ticks, 'hit')[0]?.amount).toBe(10);
    expect(eventsOf(glass.ticks, 'hit')[0]?.amount).toBe(20);
    const sim = createSimulation(
      makeConfig({ stats, rules: [{ id: 'glassCannon', damageMore: 1 }] }),
      data,
    );
    expect(sim.state.player.maxLife).toBe(1);
    expect(sim.state.player.life).toBe(1);
  });

  it('steadyAim crits exactly every Nth shot with the extra crit multiplier', () => {
    const stats = makeStats({ damage: 10, critChance: 0.9, critMultiplier: 2, attackSpeed: 6 });
    const { ticks } = run(
      { stats, rules: [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5 }] },
      dummyData(1),
    );
    const hits = eventsOf(ticks, 'hit');
    expect(hits.length).toBeGreaterThanOrEqual(9);
    hits.forEach((hit, i) => {
      const crit = (i + 1) % 3 === 0;
      expect(hit.crit).toBe(crit);
      expect(hit.amount).toBe(crit ? 10 * 2 * 1.5 : 10);
    });
  });

  it('pandemic spreads the burns of a dying enemy to enemies in range', () => {
    // Enemies with 30 HP: the first hit ignites, burn kills, the burn spreads.
    const stats = makeStats({
      damage: 1,
      attackSpeed: 0.2,
      critChance: 0,
      igniteChance: 1,
      burnDamage: 20,
      burnDuration: 4,
    });
    const data = dummyData(30, 30 / 20);
    const rules: RuleSpec[] = [
      { id: 'pandemic', spreadRadius: 5000, spreadEffect: 1, hitMore: -0.3 },
    ];
    const { ticks } = run({ stats, rules, maxTicks: 1200 }, data);
    const hits = eventsOf(ticks, 'hit');
    expect(hits[0]?.amount).toBeCloseTo(0.7, 12);
    const spreads = eventsOf(ticks, 'burnSpread');
    expect(spreads.length).toBeGreaterThan(0);
    expect(spreads[0]?.targets).toBeGreaterThan(0);
    // Far more enemies burn than were hit directly.
    const ignited = new Set(eventsOf(ticks, 'ignite').map((event) => event.targetId));
    const hitIds = new Set(hits.map((hit) => hit.targetId));
    expect(ignited.size).toBeGreaterThan(hitIds.size);
  });

  it('eternalFlame removes the stack cap and shortens burns', () => {
    const stats = makeStats({
      damage: 1,
      attackSpeed: 20,
      igniteChance: 1,
      burnDuration: 4,
      burnMaxStacks: 5,
    });
    const capped = run({ stats, maxTicks: 120 }, dummyData(1));
    const flame = run(
      { stats, rules: [{ id: 'eternalFlame', durationMore: -0.5 }], maxTicks: 120 },
      dummyData(1),
    );
    const maxStacks = (ticks: readonly (readonly SimEvent[])[]): number =>
      Math.max(...eventsOf(ticks, 'ignite').map((event) => event.stacks));
    expect(maxStacks(capped.ticks)).toBe(5);
    expect(maxStacks(flame.ticks)).toBeGreaterThan(5);
    expect(maxStacks(flame.ticks)).toBeLessThan(UNCAPPED_BURN_STACKS);
  });

  it('overload doubles chain jumps and lowers retention', () => {
    const stats = makeStats({
      damage: 10,
      critChance: 0,
      chainCount: 2,
      chainRetention: 0.7,
      chainRange: 5000,
    });
    const { ticks } = run(
      { stats, rules: [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 }] },
      dummyData(8),
    );
    const hits = eventsOf(ticks, 'hit');
    expect(Math.max(...hits.map((hit) => hit.chainIndex))).toBe(4);
    const first = hits.find((hit) => hit.chainIndex === 1);
    expect(first?.amount).toBeCloseTo(5, 12);
  });
});

/** A flat `stat` modifier for the hits that carry `tag`. */
const tagged = (stat: Modifier['stat'], tag: 'crit' | 'chain', value = 1): Modifier => ({
  stat,
  kind: 'flat',
  value,
  tags: [tag],
});

describe('bridge notables and Searing Crits as data', () => {
  it('Searing Crits ignites every crit and halves non-crit hits', () => {
    const crits = run(
      { stats: makeStats({ damage: 10, critChance: 1, igniteChance: 0 }, SEARING_CRITS_MODS) },
      dummyData(1),
    );
    const critHits = eventsOf(crits.ticks, 'hit');
    expect(critHits.length).toBeGreaterThan(0);
    expect(critHits.every((hit) => hit.crit && hit.amount === 15)).toBe(true);
    expect(eventsOf(crits.ticks, 'ignite').length).toBe(critHits.length);
    const plain = run(
      { stats: makeStats({ damage: 10, critChance: 0, igniteChance: 0 }, SEARING_CRITS_MODS) },
      dummyData(1),
    );
    expect(eventsOf(plain.ticks, 'hit').every((hit) => hit.amount === 5)).toBe(true);
    expect(eventsOf(plain.ticks, 'ignite')).toHaveLength(0);
  });

  it('Searing Crits still draws the ignite roll of a crit', () => {
    // Nothing dies, so each hit draws exactly its crit roll, then its ignite roll.
    const stats = makeStats(
      { damage: 10, critChance: 0.5, igniteChance: 0.3, attackSpeed: 6, projectileCount: 1 },
      SEARING_CRITS_MODS,
    );
    const { ticks } = run({ seed: 5, stats }, dummyData(1));
    const hits = eventsOf(ticks, 'hit');
    expect(hits.length).toBeGreaterThan(30);
    const combat = createRng(deriveSeed(5, 'combat'));
    let ignites = 0;
    for (const hit of hits) {
      const crit = combat.chance(0.5);
      const rolled = combat.chance(0.3);
      expect(hit.crit).toBe(crit);
      if (crit || rolled) ignites++;
    }
    expect(hits.some((hit) => hit.crit) && hits.some((hit) => !hit.crit)).toBe(true);
    expect(eventsOf(ticks, 'ignite')).toHaveLength(ignites);
  });

  it('Static Focus adds crit chance per jump', () => {
    const stats = makeStats(
      { damage: 10, critChance: 0, chainCount: 1, chainRange: 5000, attackSpeed: 10 },
      [{ stat: 'critChance', kind: 'flat', value: 1, scaling: { per: 'chainJump' } }],
    );
    const { ticks } = run({ stats }, dummyData(4));
    const hits = eventsOf(ticks, 'hit');
    expect(hits.length).toBeGreaterThan(10);
    for (const hit of hits) expect(hit.crit).toBe(hit.chainIndex > 0);
  });

  it('steadyAim turns off the crit chance Static Focus adds', () => {
    const stats = makeStats(
      { damage: 10, critChance: 0, chainCount: 1, chainRange: 5000, attackSpeed: 10 },
      [{ stat: 'critChance', kind: 'flat', value: 1, scaling: { per: 'chainJump' } }],
    );
    const rules: RuleSpec[] = [{ id: 'steadyAim', everyNth: 1000, critMultiplierMore: 0 }];
    const hits = eventsOf(run({ stats, rules }, dummyData(4)).ticks, 'hit');
    expect(hits.some((hit) => hit.chainIndex > 0)).toBe(true);
    expect(hits.every((hit) => !hit.crit)).toBe(true);
  });

  it('Conduction and Flashpoint add ignite chance to their hits only', () => {
    const base = { damage: 10, chainCount: 1, chainRange: 5000, attackSpeed: 10, igniteChance: 0 };
    const chain = run(
      { stats: makeStats({ ...base, critChance: 0 }, [tagged('igniteChance', 'chain')]) },
      dummyData(4),
    );
    const chainHits = eventsOf(chain.ticks, 'hit').filter((hit) => hit.chainIndex > 0);
    const ignited = eventsOf(chain.ticks, 'ignite').length;
    expect(chainHits.length).toBeGreaterThan(0);
    expect(ignited).toBe(chainHits.length);

    const crit = run(
      {
        stats: makeStats({ ...base, chainCount: 0, critChance: 1 }, [
          tagged('igniteChance', 'crit'),
        ]),
      },
      dummyData(4),
    );
    expect(eventsOf(crit.ticks, 'ignite').length).toBe(eventsOf(crit.ticks, 'hit').length);
    const plain = run(
      {
        stats: makeStats({ ...base, chainCount: 0, critChance: 0 }, [
          tagged('igniteChance', 'crit'),
        ]),
      },
      dummyData(4),
    );
    expect(eventsOf(plain.ticks, 'ignite')).toHaveLength(0);
  });

  it('critAlways crits the hits with its tags and reads the crit multiplier of their row', () => {
    const stats = makeStats(
      {
        damage: 10,
        critChance: 0,
        critMultiplier: 2,
        chainCount: 1,
        chainRange: 5000,
        chainRetention: 1,
        attackSpeed: 10,
      },
      [
        tagged('critAlways', 'chain'),
        { stat: 'critMultiplier', kind: 'more', value: 0.5, tags: ['chain'] },
      ],
    );
    const hits = eventsOf(run({ stats }, dummyData(4)).ticks, 'hit');
    expect(hits.some((hit) => hit.chainIndex > 0)).toBe(true);
    for (const hit of hits) {
      expect(hit.crit).toBe(hit.chainIndex > 0);
      expect(hit.amount).toBe(hit.chainIndex > 0 ? 30 : 10);
    }
  });
});

describe('projectileCount', () => {
  it('fires one projectile per whole count, each at a different target', () => {
    const stats = makeStats({ damage: 1, projectileCount: 3, attackSpeed: 1 });
    const sim = createSimulation(makeConfig({ stats, maxTicks: 61 }), dummyData(5));
    const events: SimEvent[] = [];
    while (!sim.state.finished) events.push(...sim.step(NO_INPUT));
    const attacks = eventsOf([events], 'attack');
    expect(attacks.length % 3).toBe(0);
    expect(new Set(attacks.slice(0, 3).map((attack) => attack.targetId)).size).toBe(3);
  });
});

describe('targeting doomed enemies', () => {
  it('does not shoot an enemy its burns will already kill', () => {
    const stats = makeStats({
      damage: 1,
      attackSpeed: 2,
      critChance: 0,
      igniteChance: 1,
      burnDamage: 100,
      burnDuration: 3,
      projectileSpeed: 1e6,
    });
    // Projectiles land on the next tick. 100 HP each: one hit ignites 300 burn damage, enough to kill within the second.
    const { ticks } = run({ stats, maxTicks: 150 }, dummyData(2, 5));
    const hits = eventsOf(ticks, 'hit');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[1]?.targetId).not.toBe(hits[0]?.targetId);
  });
});
