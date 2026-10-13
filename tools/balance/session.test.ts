import { describe, expect, it } from 'vitest';
import { DAMAGE_TAG_BIT, loadGameData } from '../../src/data';
import { createMetaState, DEFAULT_ECONOMY, statBlockFor } from '../../src/meta';
import { makeStats } from '../../src/sim/testing';
import {
  attackDamage,
  buildMultipliers,
  chooseStartWave,
  compressIds,
  crowdDps,
  effectiveHit,
  parseStartWavePolicy,
  runSeed,
  runSession,
} from './session';
import type { SessionConfig } from './session';

const config = (overrides: Partial<SessionConfig> = {}): SessionConfig => ({
  strategy: 'crit-greedy',
  session: 0,
  seed: 1,
  minutes: 3,
  startWave: { kind: 'max' },
  economy: DEFAULT_ECONOMY,
  menuSeconds: 20,
  waveCap: null,
  ...overrides,
});

describe('start-wave policy', () => {
  it('parses max, 1 and ratio:<x>', () => {
    expect(parseStartWavePolicy('max')).toEqual({ kind: 'max' });
    expect(parseStartWavePolicy('1')).toEqual({ kind: 'first' });
    expect(parseStartWavePolicy('ratio:0.25')).toEqual({ kind: 'ratio', ratio: 0.25 });
    for (const bad of ['', '2', 'ratio:', 'ratio:0', 'ratio:1.5', 'ratio:x', 'min']) {
      expect(() => parseStartWavePolicy(bad)).toThrow(/Invalid start-wave policy/);
    }
  });

  it('chooses the allowed wave, wave 1, or a ratio capped at the allowed wave', () => {
    const meta = createMetaState();
    expect(chooseStartWave({ kind: 'max' }, meta, DEFAULT_ECONOMY)).toBe(1);
    meta.maxWave = 41;
    expect(chooseStartWave({ kind: 'max' }, meta, DEFAULT_ECONOMY)).toBe(20);
    expect(chooseStartWave({ kind: 'first' }, meta, DEFAULT_ECONOMY)).toBe(1);
    expect(chooseStartWave({ kind: 'ratio', ratio: 0.25 }, meta, DEFAULT_ECONOMY)).toBe(10);
    expect(chooseStartWave({ kind: 'ratio', ratio: 0.9 }, meta, DEFAULT_ECONOMY)).toBe(20);
    expect(chooseStartWave({ kind: 'ratio', ratio: 0.01 }, meta, DEFAULT_ECONOMY)).toBe(1);
  });
});

describe('effectiveHit', () => {
  it('is the base hit with the crit expectation for base stats', () => {
    expect(effectiveHit(makeStats({ igniteChance: 0 }))).toBeCloseTo(10 * (0.95 + 0.05 * 1.5), 12);
  });

  it('applies keystone rules', () => {
    const stats = makeStats({ igniteChance: 0, critChance: 0.5, critMultiplier: 2 });
    expect(effectiveHit(stats, [{ id: 'glassCannon', damageMore: 1 }])).toBeCloseTo(
      2 * 10 * (0.5 + 0.5 * 2),
      12,
    );
    // steadyAim: one crit in three, crit multiplier × 1.5.
    expect(
      effectiveHit(stats, [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5 }]),
    ).toBeCloseTo(10 * (2 / 3 + (1 / 3) * 3), 12);
  });

  it('adds the expected burn, computed from the crit hit on crits', () => {
    const { hit, crit, burn } = DAMAGE_TAG_BIT;
    const stats = makeStats(
      {
        damage: 100,
        critChance: 0.5,
        critMultiplier: 3,
        igniteChance: 0.4,
        burnDamage: 0.4,
        burnDuration: 4,
      },
      (mask) => ((mask & burn) !== 0 ? 2 : 1) * ((mask & crit) !== 0 ? 1.5 : 1),
    );
    const hitPart = 0.5 * 1 + 0.5 * 3 * 1.5;
    const burnPart = 0.4 * 0.4 * 4 * (0.5 * 2 + 0.5 * 3 * 3);
    expect(stats.damageMult[hit]).toBe(1);
    expect(effectiveHit(stats)).toBeCloseTo(100 * (hitPart + burnPart), 9);
  });
});

describe('attackDamage and crowdDps', () => {
  const { chain } = DAMAGE_TAG_BIT;
  const noCrit = { critChance: 0, igniteChance: 0 };

  it('equal D without chain jumps, times attacks and projectiles for crowdDps', () => {
    const stats = makeStats({ critChance: 0.2, attackSpeed: 3, projectileCount: 2.5 });
    expect(attackDamage(stats)).toBeCloseTo(effectiveHit(stats), 12);
    expect(crowdDps(stats)).toBeCloseTo(effectiveHit(stats) * 3 * 2.5, 9);
  });

  it('adds each jump at its retention with the chain tag, the fraction as a chance', () => {
    const chainDouble = (mask: number): number => ((mask & chain) !== 0 ? 2 : 1);
    const two = makeStats({ ...noCrit, chainCount: 2, chainRetention: 0.5 }, chainDouble);
    expect(attackDamage(two)).toBeCloseTo(10 * (1 + 0.5 * 2 + 0.25 * 2), 12);
    const oneAndHalf = makeStats({ ...noCrit, chainCount: 1.5, chainRetention: 0.5 }, chainDouble);
    expect(attackDamage(oneAndHalf)).toBeCloseTo(10 * (1 + 0.5 * 2 + 0.5 * 0.25 * 2), 12);
    // overload: ×2 jumps, −0.15 retention.
    const overload = [{ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.15 }] as const;
    const one = makeStats({ ...noCrit, chainCount: 1, chainRetention: 0.65 });
    expect(attackDamage(one, overload)).toBeCloseTo(10 * (1 + 0.5 + 0.25), 12);
  });

  it('applies per-jump crit chance, and steady shots crit on every jump', () => {
    const stats = makeStats({ igniteChance: 0, critChance: 0, critMultiplier: 2, chainCount: 1 });
    const retention = stats.values.chainRetention;
    expect(attackDamage(stats, [{ id: 'chainCritChance', perJump: 0.5 }])).toBeCloseTo(
      10 * (1 + retention * (0.5 + 0.5 * 2)),
      12,
    );
    expect(
      attackDamage(stats, [{ id: 'steadyAim', everyNth: 2, critMultiplierMore: 0 }]),
    ).toBeCloseTo(10 * (1 + retention) * (0.5 + 0.5 * 2), 12);
  });
});

describe('buildMultipliers', () => {
  const data = loadGameData();
  const might = data.talents.find((node) => node.kind === 'repeatable');
  const sectorNode = data.talents.find((node) => node.archetype === 'crit');

  it('splits a build into the share of repeatable ranks and of sector nodes', () => {
    expect(might).toBeDefined();
    expect(sectorNode).toBeDefined();
    const perRank = might?.modifiers[0];
    expect(perRank).toMatchObject({ stat: 'damage', kind: 'more' });
    const meta = createMetaState();
    meta.allocated.add(might?.id ?? '');
    meta.ranks.set(might?.id ?? '', 3);
    meta.allocated.add(sectorNode?.id ?? '');

    const mults = buildMultipliers(meta, data);
    expect(mults.repeatableMultD).toBeCloseTo((1 + (perRank?.value ?? 0)) ** 3, 9);
    const without = createMetaState();
    without.allocated.add(might?.id ?? '');
    without.ranks.set(might?.id ?? '', 3);
    expect(mults.sectorMultD).toBeCloseTo(
      effectiveHit(statBlockFor(meta, data)) / effectiveHit(statBlockFor(without, data)),
      9,
    );
    expect(mults.sectorMultD).toBeGreaterThan(1);
    expect(mults.sectorMultAttack).toBeCloseTo(
      attackDamage(statBlockFor(meta, data)) / attackDamage(statBlockFor(without, data)),
      9,
    );
    expect(mults.sectorMultCrowd).toBeGreaterThan(1);
  });

  it('is 1 for an empty build', () => {
    expect(buildMultipliers(createMetaState(), data)).toEqual({
      repeatableMultD: 1,
      sectorMultD: 1,
      sectorMultAttack: 1,
      sectorMultCrowd: 1,
    });
  });
});

describe('runSeed', () => {
  it('differs between sessions and runs and ignores the strategy', () => {
    const seeds = new Set<number>();
    for (let session = 0; session < 5; session++) {
      for (let run = 1; run <= 5; run++) seeds.add(runSeed(1, session, run));
    }
    expect(seeds.size).toBe(25);
    expect(runSeed(1, 2, 3)).toBe(runSeed(1, 2, 3));
    expect(runSeed(2, 2, 3)).not.toBe(runSeed(1, 2, 3));
  });
});

describe('compressIds', () => {
  it('joins ids and collapses consecutive repeats', () => {
    expect(compressIds([])).toBe('');
    expect(compressIds(['a', 'b', 'b', 'b', 'c', 'b'])).toBe('a b×3 c b');
  });
});

describe('runSession', () => {
  it('produces consistent rows for a short session', () => {
    const cfg = config();
    const result = runSession(cfg);
    const rows = result.rows;
    expect(rows.length).toBeGreaterThan(1);

    let clockSeconds = 0;
    let maxWave = 0;
    rows.forEach((row, i) => {
      expect(row.run).toBe(i + 1);
      expect(row.strategy).toBe('crit-greedy');
      clockSeconds += row.runSeconds;
      expect(row.minutes).toBeCloseTo(clockSeconds / 60, 9);
      clockSeconds += cfg.menuSeconds;

      expect(row.maxWave).toBeGreaterThanOrEqual(maxWave);
      expect(row.maxWave).toBeGreaterThanOrEqual(row.highestWaveReached);
      maxWave = row.maxWave;
      expect(row.highestWaveReached).toBeGreaterThanOrEqual(row.startWave);
      expect(row.runSeconds).toBeGreaterThan(0);
      expect(row.runSeconds).toBeLessThanOrEqual(180);
      expect(row.effectiveHit).toBeGreaterThan(0);
      expect(row.hitsToKillFrontier).toBeCloseTo(row.stdHpAtFrontier / row.effectiveHit, 9);
      expect(row.overkillShare).toBeGreaterThanOrEqual(0);
      expect(row.overkillShare).toBeLessThanOrEqual(1);
      expect(row.shardsBank).toBeGreaterThanOrEqual(0);
    });

    // Runs continue until the budget is used, and not beyond.
    expect(result.endMinutes).toBeCloseTo(clockSeconds / 60, 9);
    expect(result.endMinutes).toBeGreaterThanOrEqual(cfg.minutes);
    const beforeLast = rows.at(-2);
    expect(beforeLast).toBeDefined();
    expect((beforeLast?.minutes ?? 0) + cfg.menuSeconds / 60).toBeLessThan(cfg.minutes);
    // The first run uses the fresh build from wave 1, and the strategy spends afterwards.
    expect(rows[0]?.startWave).toBe(1);
    expect(rows[0]?.bought).not.toBe('');
  });

  it('is deterministic', () => {
    expect(runSession(config({ session: 3 }))).toEqual(runSession(config({ session: 3 })));
  });

  it('respects the wave cap and the start-wave policy', () => {
    const capped = runSession(config({ waveCap: 4, minutes: 4 }));
    for (const row of capped.rows) {
      expect(row.highestWaveReached).toBeLessThanOrEqual(4);
      expect(row.maxWave).toBeLessThanOrEqual(4);
    }
    const fromOne = runSession(config({ startWave: { kind: 'first' }, minutes: 4 }));
    expect(fromOne.rows.every((row) => row.startWave === 1 && row.skipShards === 0)).toBe(true);
  });
});
