import { describe, expect, it } from 'vitest';
import {
  BOSS_HP_MULT,
  ELITE_HP_MULT,
  FRONTIER_HITS_TO_KILL,
  growthInto,
  HP_SEGMENTS,
  HP_WAVE_1,
  shardsPerStdEnemy,
  stdHp,
  stdHpAt,
  targetDamage,
} from './curve';
import { ENEMIES } from './enemies';

describe('stdHp', () => {
  it('starts at 5 on wave 1', () => {
    expect(HP_WAVE_1).toBe(5);
    expect(stdHp(1)).toBe(5);
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
    [3, 8.45],
    [15, 197],
    [22, 1.24e3],
    [30, 6.75e3],
    [40, 4.18e4],
    [70, 4.24e6],
    [100, 2.81e8],
    [110, 8.71e8],
  ])('matches the GDD pacing table at wave %i (≈ %d) within 2%', (wave, expected) => {
    expect(Math.abs(stdHp(wave) / expected - 1)).toBeLessThan(0.02);
  });

  // docs/GDD.md §7.1 segment ends, given there to two significant digits.
  it.each([
    [25, 2.7e3],
    [50, 2.6e5],
    [120, 2.7e9],
  ])('matches the GDD segment end at wave %i (≈ %d) within 5%', (wave, expected) => {
    expect(Math.abs(stdHp(wave) / expected - 1)).toBeLessThan(0.05);
  });

  it.each([0, -1, 1.5, 2001, Number.NaN])('throws for wave %f', (wave) => {
    expect(() => stdHp(wave)).toThrow(RangeError);
  });
});

describe('targetDamage', () => {
  it('is HP at the frontier divided by the hits to kill', () => {
    expect(FRONTIER_HITS_TO_KILL).toBe(2);
    for (const wave of [1, 3, 15, 22, 30, 40, 70, 110]) {
      expect(targetDamage(wave)).toBeCloseTo(stdHp(wave) / 2, 6);
    }
  });

  it('matches the GDD damage targets within 2%', () => {
    expect(Math.abs(targetDamage(15) / 98.4 - 1)).toBeLessThan(0.02);
    expect(Math.abs(targetDamage(30) / 3.38e3 - 1)).toBeLessThan(0.02);
    expect(Math.abs(targetDamage(40) / 2.09e4 - 1)).toBeLessThan(0.02);
  });

  it('agrees with the enemy table on elite and boss HP', () => {
    expect(ENEMIES.hexagon.hpMult).toBe(ELITE_HP_MULT);
    expect(ENEMIES.boss.hpMult).toBe(BOSS_HP_MULT);
    // Regular enemies are the small, fast swarm: one or two hits at the frontier.
    expect(ENEMIES.triangle.hpMult * FRONTIER_HITS_TO_KILL).toBe(1);
    expect(ENEMIES.square.hpMult * FRONTIER_HITS_TO_KILL).toBe(2);
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

describe('growthInto (docs/v3 C6 design §4.10)', () => {
  it.each([
    [-3, 1.3],
    [0, 1.3],
    [1, 1.3],
    [2, 1.3],
    [25, 1.3],
    [26, 1.2],
    [50, 1.2],
    [51, 1.15],
    [100, 1.15],
    [101, 1.12],
    [2000, 1.12],
  ])('gives wave %i the growth of the last segment that has begun: ×%f', (wave, growth) => {
    expect(growthInto(wave)).toBe(growth);
  });

  it('is the growth stdHp applies into each wave', () => {
    expect(growthInto(1)).toBe((HP_SEGMENTS[0] as { growth: number }).growth);
    for (let wave = 2; wave <= 300; wave++) {
      expect(stdHp(wave) / stdHp(wave - 1)).toBeCloseTo(growthInto(wave), 12);
    }
  });
});

describe('stdHpAt (docs/v3 C6 design §4.10, F28)', () => {
  it('equals stdHp at every whole wave', () => {
    for (let wave = 1; wave <= 2000; wave++) expect(stdHpAt(wave)).toBe(stdHp(wave));
  });

  it('is geometric inside a wave, with the growth into the next', () => {
    for (const [x, wave] of [
      [1.5, 1],
      [12.25, 12],
      [25.5, 25],
      [50.75, 50],
      [100.5, 100],
      [140.1, 140],
    ] as const) {
      const into = growthInto(wave + 1);
      expect(stdHpAt(x)).toBeCloseTo(stdHp(wave) * into ** (x - wave), 6);
      // Equal steps inside a wave multiply by the same factor.
      const step = (x - wave) / 2;
      expect(stdHpAt(wave + step) / stdHp(wave)).toBeCloseTo(into ** step, 12);
      expect(stdHpAt(x) / stdHpAt(wave + step)).toBeCloseTo(into ** step, 12);
    }
    // Not linear: half a wave is the square root of the wave's growth.
    expect(stdHpAt(25.5)).toBeCloseTo(stdHp(25) * Math.sqrt(1.2), 6);
    expect(stdHpAt(25.5)).not.toBeCloseTo((stdHp(25) + stdHp(26)) / 2, 2);
  });

  it.each([25, 50, 100])('is continuous across the seam after wave %i', (wave) => {
    for (const end of [wave, wave + 1]) {
      expect(stdHpAt(end - 1e-9) / stdHp(end)).toBeCloseTo(1, 7);
      expect(stdHpAt(end + 1e-9) / stdHp(end)).toBeCloseTo(1, 7);
    }
    // Into the seam's wave at the old growth, out of it at the new one.
    expect(stdHpAt(wave + 0.5) / stdHp(wave)).toBeCloseTo(Math.sqrt(growthInto(wave + 1)), 12);
    expect(stdHpAt(wave - 0.5) / stdHp(wave - 1)).toBeCloseTo(Math.sqrt(growthInto(wave)), 12);
  });

  it("runs below wave 1 at wave 1's growth, to HP_WAVE_1 at 1", () => {
    expect(stdHpAt(1)).toBe(HP_WAVE_1);
    expect(stdHpAt(0)).toBeCloseTo(HP_WAVE_1 / 1.3, 12);
    expect(stdHpAt(0.5)).toBeCloseTo(HP_WAVE_1 / Math.sqrt(1.3), 12);
    expect(stdHpAt(1 - 1e-9)).toBeCloseTo(HP_WAVE_1, 7);
    for (let x = 0; x < 3; x += 0.125) {
      expect(stdHpAt(x + 0.125)).toBeGreaterThan(stdHpAt(x));
    }
  });

  it("throws past stdHp's table", () => {
    expect(stdHpAt(2000.5)).toBeGreaterThan(stdHp(2000));
    expect(() => stdHpAt(2001)).toThrow(RangeError);
    expect(() => stdHpAt(Number.NaN)).toThrow(RangeError);
  });
});
