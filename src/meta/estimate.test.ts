import { describe, expect, it } from 'vitest';
import { targetDamage } from '../data/curve';
import { makeStats } from '../sim/testing';
import { effectiveDamage, estimateBuild, frontierFor } from './estimate';
import { createMetaState } from './state';
import { fixtureData } from './testing';
import { DEFAULT_ECONOMY } from './types';

const data = fixtureData();

describe('effectiveDamage', () => {
  it('is the base hit with the crit expectation for base stats', () => {
    expect(effectiveDamage(makeStats({ igniteChance: 0 }))).toBeCloseTo(
      10 * (0.95 + 0.05 * 1.5),
      12,
    );
  });

  it('doubles everything under glassCannon', () => {
    const stats = makeStats({ critChance: 0.2, igniteChance: 0.5 });
    expect(effectiveDamage(stats, [{ id: 'glassCannon', damageMore: 1 }])).toBeCloseTo(
      2 * effectiveDamage(stats),
      12,
    );
  });

  it('crits every Nth shot under steadyAim, ignoring the random crit chance', () => {
    const steady = [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5 }] as const;
    const low = makeStats({ igniteChance: 0, critChance: 0.05, critMultiplier: 2 });
    const high = makeStats({ igniteChance: 0, critChance: 0.9, critMultiplier: 2 });
    // One crit in three at 2 × 1.5 = 3 times the hit.
    const expected = 10 * (2 / 3 + (1 / 3) * 3);
    expect(effectiveDamage(low, steady)).toBeCloseTo(expected, 12);
    expect(effectiveDamage(high, steady)).toBeCloseTo(expected, 12);
  });

  it('cuts only hit damage under pandemic and adds the burn of each hit', () => {
    const stats = makeStats({
      damage: 100,
      critChance: 0,
      igniteChance: 0.5,
      burnDamage: 0.6,
      burnDuration: 3,
    });
    const burn = 0.5 * 0.6 * 3;
    expect(effectiveDamage(stats)).toBeCloseTo(100 * (1 + burn), 9);
    expect(
      effectiveDamage(stats, [
        { id: 'pandemic', spreadRadius: 250, spreadEffect: 0.8, hitMore: -0.3 },
      ]),
    ).toBeCloseTo(100 * (0.7 + burn), 9);
  });
});

describe('frontierFor', () => {
  it('is the highest wave whose target damage is met, at least 1', () => {
    expect(frontierFor(0)).toBe(1);
    expect(frontierFor(targetDamage(1))).toBe(1);
    for (const wave of [2, 7, 15, 30, 60]) {
      expect(frontierFor(targetDamage(wave))).toBe(wave);
      expect(frontierFor(targetDamage(wave) * 0.999)).toBe(wave - 1);
    }
  });

  it('never goes down as damage goes up', () => {
    let previous = 1;
    for (let damage = 1; damage < 1e12; damage *= 1.37) {
      const frontier = frontierFor(damage);
      expect(frontier).toBeGreaterThanOrEqual(previous);
      previous = frontier;
    }
    expect(previous).toBeGreaterThan(60);
  });
});

describe('estimateBuild', () => {
  it('derives the start wave from the frontier with the start-wave ratio', () => {
    const estimate = estimateBuild(createMetaState(), data, DEFAULT_ECONOMY);
    expect(estimate.damage).toBeCloseTo(effectiveDamage(makeStats()), 12);
    expect(estimate.frontier).toBe(frontierFor(estimate.damage));
    expect(estimate.startWave).toBe(
      Math.max(1, Math.floor(estimate.frontier * DEFAULT_ECONOMY.startWaveRatio)),
    );
    const generous = estimateBuild(createMetaState(), data, {
      ...DEFAULT_ECONOMY,
      startWaveRatio: 1,
    });
    expect(generous.startWave).toBe(estimate.frontier);
  });

  it('grows with damage talents and keystones', () => {
    const meta = createMetaState();
    const base = estimateBuild(meta, data, DEFAULT_ECONOMY);
    meta.allocated.add('r');
    meta.ranks.set('r', 30);
    const ranked = estimateBuild(meta, data, DEFAULT_ECONOMY);
    expect(ranked.damage).toBeCloseTo(base.damage * 1.1 ** 30, 6);
    expect(ranked.frontier).toBeGreaterThan(base.frontier);
    expect(ranked.startWave).toBeGreaterThan(base.startWave);
    for (const id of ['a', 'a2', 'k']) meta.allocated.add(id);
    const glass = estimateBuild(meta, data, DEFAULT_ECONOMY);
    expect(glass.damage).toBeGreaterThan(2 * ranked.damage);
    expect(glass.frontier).toBeGreaterThanOrEqual(ranked.frontier);
  });
});
