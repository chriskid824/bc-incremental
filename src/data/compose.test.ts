import { describe, expect, it } from 'vitest';
import { composeWave, isBossWave, isEliteWave } from './compose';
import type { WaveEntry } from './compose';
import type { EnemyId } from './types';
import { WAVES } from './waves';

const countOf = (entries: readonly WaveEntry[], enemy: EnemyId): number =>
  entries.find((entry) => entry.enemy === enemy)?.count ?? 0;

describe('composeWave', () => {
  it('spawns only 5 triangles on wave 1', () => {
    expect(composeWave(1, WAVES)).toEqual([{ enemy: 'triangle', count: 5 }]);
  });

  it('adds squares from wave 3', () => {
    expect(countOf(composeWave(2, WAVES), 'square')).toBe(0);
    expect(composeWave(3, WAVES)).toEqual([
      { enemy: 'triangle', count: 5 },
      { enemy: 'square', count: 2 },
    ]);
  });

  it('adds pentagons from wave 8', () => {
    expect(countOf(composeWave(7, WAVES), 'pentagon')).toBe(0);
    expect(countOf(composeWave(8, WAVES), 'pentagon')).toBe(1);
  });

  it('adds one hexagon on elite waves', () => {
    const wave5 = composeWave(5, WAVES);
    expect(countOf(wave5, 'hexagon')).toBe(1);
    expect(countOf(wave5, 'boss')).toBe(0);
    expect(wave5.at(-1)).toEqual({ enemy: 'hexagon', count: 1 });
    expect(countOf(composeWave(15, WAVES), 'hexagon')).toBe(1);
    expect(countOf(composeWave(6, WAVES), 'hexagon')).toBe(0);
  });

  it('adds one boss and no hexagon on boss waves', () => {
    for (const wave of [10, 20, 100]) {
      const entries = composeWave(wave, WAVES);
      expect(countOf(entries, 'boss')).toBe(1);
      expect(countOf(entries, 'hexagon')).toBe(0);
      expect(entries.at(-1)).toEqual({ enemy: 'boss', count: 1 });
    }
  });

  it('caps every rule at its maxCount on very high waves', () => {
    for (const wave of [200, 1000, 2000]) {
      const entries = composeWave(wave, WAVES);
      for (const rule of WAVES.rules) {
        expect(countOf(entries, rule.enemy)).toBe(rule.maxCount);
      }
    }
  });

  it('never produces empty or fractional groups', () => {
    for (let wave = 1; wave <= 150; wave++) {
      for (const entry of composeWave(wave, WAVES)) {
        expect(Number.isInteger(entry.count)).toBe(true);
        expect(entry.count).toBeGreaterThan(0);
      }
    }
  });
});

describe('isBossWave / isEliteWave', () => {
  it('gives boss waves precedence over elite waves', () => {
    expect(isBossWave(10, WAVES)).toBe(true);
    expect(isEliteWave(10, WAVES)).toBe(false);
    expect(isEliteWave(5, WAVES)).toBe(true);
    expect(isBossWave(5, WAVES)).toBe(false);
    expect(isEliteWave(4, WAVES)).toBe(false);
  });
});
