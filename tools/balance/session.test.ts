import { describe, expect, it } from 'vitest';
import { loadGameData, TAG } from '../../src/data';
import type { SignatureSpec } from '../../src/data';
import { createMetaState, DEFAULT_ECONOMY, statBlockFor } from '../../src/meta';
import { damageRow, makeStats } from '../../src/sim/testing';
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
      effectiveHit(stats, [
        { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' },
      ]),
    ).toBeCloseTo(10 * (2 / 3 + (1 / 3) * 3), 12);
  });

  it('adds the expected burn, computed from the crit hit on crits', () => {
    const { hit } = TAG;
    const stats = makeStats(
      {
        damage: 100,
        critChance: 0.5,
        critMultiplier: 3,
        igniteChance: 0.4,
        burnDamage: 0.4,
        burnDuration: 4,
      },
      [
        { stat: 'damage', kind: 'more', value: 1, tags: ['burn'] },
        { stat: 'damage', kind: 'more', value: 0.5, tags: ['crit'] },
      ],
    );
    const hitPart = 0.5 * 1 + 0.5 * 3 * 1.5;
    const burnPart = 0.4 * 0.4 * 4 * (0.5 * 2 + 0.5 * 3 * 3);
    expect(damageRow(stats, hit)).toBe(1);
    expect(effectiveHit(stats)).toBeCloseTo(100 * (hitPart + burnPart), 9);
  });
});

describe('attackDamage and crowdDps', () => {
  const noCrit = { critChance: 0, igniteChance: 0 };

  it('equal D without chain jumps, times attacks and projectiles for crowdDps', () => {
    const stats = makeStats({ critChance: 0.2, attackSpeed: 3, projectileCount: 2.5 });
    expect(attackDamage(stats)).toBeCloseTo(effectiveHit(stats), 12);
    expect(crowdDps(stats)).toBeCloseTo(effectiveHit(stats) * 3 * 2.5, 9);
  });

  it('adds each jump at its retention with the chain tag, the fraction as a chance', () => {
    const chainDouble = [{ stat: 'damage', kind: 'more', value: 1, tags: ['chain'] }] as const;
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
    const values = { igniteChance: 0, critChance: 0, critMultiplier: 2, chainCount: 1 } as const;
    const stats = makeStats(values);
    const retention = stats.values.chainRetention;
    const perJump = makeStats(values, [
      { stat: 'critChance', kind: 'flat', value: 0.5, scaling: { per: 'chainJump' } },
    ]);
    expect(attackDamage(perJump)).toBeCloseTo(10 * (1 + retention * (0.5 + 0.5 * 2)), 12);
    expect(
      attackDamage(stats, [
        { id: 'steadyAim', everyNth: 2, critMultiplierMore: 0, counts: 'shot' },
      ]),
    ).toBeCloseTo(10 * (1 + retention) * (0.5 + 0.5 * 2), 12);
  });
});

describe("the estimators on the signature attack's rows", () => {
  const MAGMA_BOMB: SignatureSpec = { id: 'magmaBomb' };
  const noCrit = { critChance: 0, igniteChance: 0, burnDamage: 0 };

  it('count the compiled projectiles: 熔核 throws one bomb a firing at base (D28)', () => {
    const stats = makeStats({ attackSpeed: 3 });
    expect(stats.values.projectileCount).toBe(2);
    expect(crowdDps(stats, [], MAGMA_BOMB)).toBe(attackDamage(stats, [], MAGMA_BOMB) * 3 * 1);
    expect(crowdDps(stats)).toBe(attackDamage(stats) * 3 * 2);
    // The fraction above the offset counts as it does for M1.
    const more = makeStats({ attackSpeed: 3, projectileCount: 3.5 });
    expect(crowdDps(more, [], MAGMA_BOMB)).toBe(attackDamage(more, [], MAGMA_BOMB) * 3 * 2.5);
    // Below one after the offset, a firing still throws one bomb (ctx.projectileCount).
    const fewer = makeStats({ attackSpeed: 3, projectileCount: 1.5 });
    expect(crowdDps(fewer, [], MAGMA_BOMB)).toBe(attackDamage(fewer, [], MAGMA_BOMB) * 3 * 1);
  });

  it('read the primary hit from the hit row and the jumps from the jump row', () => {
    // ×2 on projectile hits, ×3 on area hits, ×5 on chain hits.
    const stats = makeStats({ ...noCrit, chainCount: 1, chainRetention: 0.5 }, [
      { stat: 'damage', kind: 'more', value: 1, tags: ['projectile'] },
      { stat: 'damage', kind: 'more', value: 2, tags: ['area'] },
      { stat: 'damage', kind: 'more', value: 4, tags: ['chain'] },
    ]);
    expect(effectiveHit(stats)).toBe(10 * 2);
    expect(effectiveHit(stats, [], MAGMA_BOMB)).toBe(10 * 6);
    expect(attackDamage(stats)).toBe(10 * (2 + 0.5 * 5));
    expect(attackDamage(stats, [], MAGMA_BOMB)).toBe(10 * (6 + 0.5 * 5));
  });

  it('read the crit chance and multiplier from the hit and hit-crit rows', () => {
    const stats = makeStats({ ...noCrit, critMultiplier: 2 }, [
      { stat: 'critChance', kind: 'flat', value: 0.5, tags: ['projectile'] },
      { stat: 'critMultiplier', kind: 'flat', value: 1, tags: ['projectile', 'crit'] },
      { stat: 'damage', kind: 'more', value: 1, tags: ['projectile', 'crit'] },
    ]);
    // Half the hits crit at ×3 through a ×2 crit row: 0.5 × 1 + 0.5 × 3 × 2.
    expect(effectiveHit(stats)).toBe(10 * (0.5 + 0.5 * 3 * 2));
  });

  it('read whether a hit crits from its hit row, not its hit-crit row (combat/hit.ts)', () => {
    // On the hit-crit row only: no hit crits.
    const critRowOnly = makeStats({ ...noCrit, critMultiplier: 2 }, [
      { stat: 'critChance', kind: 'flat', value: 0.5, tags: ['projectile', 'crit'] },
      { stat: 'critAlways', kind: 'flat', value: 1, tags: ['projectile', 'crit'] },
    ]);
    expect(effectiveHit(critRowOnly)).toBe(10);
    // On the hit row only: half the hits crit, then every hit.
    const chance = makeStats({ ...noCrit, critMultiplier: 2 }, [
      { stat: 'critChance', kind: 'flat', value: 0.5, tags: ['projectile'], notTags: ['crit'] },
    ]);
    expect(effectiveHit(chance)).toBe(10 * (0.5 + 0.5 * 2));
    const always = makeStats({ ...noCrit, critMultiplier: 2 }, [
      { stat: 'critAlways', kind: 'flat', value: 1, tags: ['projectile'], notTags: ['crit'] },
    ]);
    expect(effectiveHit(always)).toBe(10 * 2);
  });

  it("read a jump's crit chance from the jump row and its multiplier from the jump-crit row", () => {
    // Jumps crit half the time at ×3; primary hits never crit (they would at ×2).
    const stats = makeStats({ ...noCrit, critMultiplier: 2, chainCount: 1, chainRetention: 0.5 }, [
      { stat: 'critChance', kind: 'flat', value: 0.5, tags: ['chain'] },
      { stat: 'critMultiplier', kind: 'flat', value: 1, tags: ['chain', 'crit'] },
    ]);
    expect(effectiveHit(stats)).toBe(10);
    expect(attackDamage(stats)).toBeCloseTo(10 * (1 + 0.5 * (0.5 * 1 + 0.5 * 3)), 12);
  });

  it('read primary crits from the hit-crit row and jump crits from the jump-crit row', () => {
    // Every hit crits at ×2: ×2 more on primary crits (projectile), ×3 on jump crits (chain).
    const stats = makeStats(
      { ...noCrit, critChance: 1, critMultiplier: 2, chainCount: 1, chainRetention: 0.5 },
      [
        { stat: 'damage', kind: 'more', value: 1, tags: ['projectile', 'crit'] },
        { stat: 'damage', kind: 'more', value: 2, tags: ['chain', 'crit'] },
      ],
    );
    expect(effectiveHit(stats)).toBe(10 * 2 * 2);
    expect(attackDamage(stats)).toBe(10 * (2 * 2 + 0.5 * 2 * 3));
  });

  it("ignite 熔核's explosions always (its area projectile rows), its jumps at the chance", () => {
    const stats = makeStats(
      { critChance: 0, igniteChance: 0.2, burnDamage: 1, burnDuration: 2, chainCount: 1 },
      [],
    );
    const retention = stats.values.chainRetention;
    // A hit's burn: burnDamage × duration × the ignite chance, per point of damage.
    expect(effectiveHit(stats)).toBeCloseTo(10 * (1 + 2 * 0.2), 12);
    expect(effectiveHit(stats, [], MAGMA_BOMB)).toBeCloseTo(10 * (1 + 2 * 1), 12);
    expect(attackDamage(stats, [], MAGMA_BOMB)).toBeCloseTo(
      10 * (1 + 2 * 1 + retention * (1 + 2 * 0.2)),
      12,
    );
  });

  it("read a jump's burn from the burn row at jump 0: burns are no chain instances", () => {
    // ×(1 + jumps) on burns: read at the jump, the jump's burn would double.
    const stats = makeStats(
      {
        critChance: 0,
        igniteChance: 1,
        burnDamage: 1,
        burnDuration: 2,
        chainCount: 1,
        chainRetention: 0.5,
      },
      [{ stat: 'damage', kind: 'more', value: 1, tags: ['burn'], scaling: { per: 'chainJump' } }],
    );
    // Each hit deals 1 and ignites a burn of 1 × 2 × 1.
    expect(attackDamage(stats)).toBeCloseTo(10 * (3 + 0.5 * 3), 12);
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
