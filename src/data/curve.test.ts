import { describe, expect, it } from 'vitest';
import { FRONTIER_HITS_TO_KILL, HP_WAVE_1, shardsPerStdEnemy, stdHp, targetDamage } from './curve';

describe('stdHp', () => {
  it('starts at 20 on wave 1', () => {
    expect(HP_WAVE_1).toBe(20);
    expect(stdHp(1)).toBe(20);
  });

  it.each([
    [2, 1.3],
    [25, 1.3],
    [26, 1.2],
    [50, 1.2],
    [51, 1.15],
    [100, 1.15],
    [101, 1.12],
    [500, 1.12],
  ])('grows wave %i by ×%f over the previous wave', (wave, growth) => {
    expect(stdHp(wave) / stdHp(wave - 1)).toBeCloseTo(growth, 12);
  });

  it('is strictly increasing up to the table end', () => {
    for (let wave = 2; wave <= 2000; wave++) {
      expect(stdHp(wave)).toBeGreaterThan(stdHp(wave - 1));
    }
    expect(Number.isFinite(stdHp(2000))).toBe(true);
  });

  // docs/GDD.md §7.3 pacing table.
  it.each([
    [3, 34],
    [15, 787],
    [22, 4.94e3],
    [30, 2.7e4],
    [40, 1.67e5],
    [70, 1.69e7],
    [100, 1.12e9],
    [110, 3.49e9],
  ])('matches the GDD pacing table at wave %i (≈ %d) within 2%', (wave, expected) => {
    expect(Math.abs(stdHp(wave) / expected - 1)).toBeLessThan(0.02);
  });

  // docs/GDD.md §7.1 segment ends, given there to two significant digits.
  it.each([
    [25, 1.1e4],
    [50, 1.0e6],
    [120, 1.1e10],
  ])('matches the GDD segment end at wave %i (≈ %d) within 5%', (wave, expected) => {
    expect(Math.abs(stdHp(wave) / expected - 1)).toBeLessThan(0.05);
  });

  it.each([0, -1, 1.5, 2001, Number.NaN])('throws for wave %f', (wave) => {
    expect(() => stdHp(wave)).toThrow(RangeError);
  });
});

describe('targetDamage', () => {
  it('is HP at the frontier divided by the hits to kill', () => {
    expect(FRONTIER_HITS_TO_KILL).toBe(3);
    for (const wave of [1, 3, 15, 22, 30, 40, 70, 110]) {
      expect(targetDamage(wave)).toBeCloseTo(stdHp(wave) / 3, 6);
    }
  });

  it('matches the GDD damage targets within 2%', () => {
    expect(Math.abs(targetDamage(15) / 262 - 1)).toBeLessThan(0.02);
    expect(Math.abs(targetDamage(30) / 9.0e3 - 1)).toBeLessThan(0.02);
    expect(Math.abs(targetDamage(40) / 5.6e4 - 1)).toBeLessThan(0.02);
  });
});

describe('shardsPerStdEnemy', () => {
  it('is positive and strictly increasing', () => {
    expect(shardsPerStdEnemy(1)).toBeGreaterThan(0);
    for (let wave = 2; wave <= 200; wave++) {
      expect(shardsPerStdEnemy(wave)).toBeGreaterThan(shardsPerStdEnemy(wave - 1));
    }
  });
});
