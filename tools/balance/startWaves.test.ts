import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../src/data';
import { measureStartWaves, startWaveReport } from './startWaves';

describe('start-wave probe', () => {
  it('asks the picker and measures the reach of every sector', () => {
    const rows = measureStartWaves(loadGameData(), {
      might: [0],
      maxStartWave: 12,
      seeds: [1],
      startWave: 8,
      keystone: true,
    });
    expect(rows.map((row) => row.sector)).toEqual(['crit', 'dot', 'chain']);
    for (const row of rows) {
      expect(row.picked).toBeGreaterThanOrEqual(1);
      expect(row.picked).toBeLessThanOrEqual(12);
      expect(row.reach).toBeGreaterThanOrEqual(8);
      expect(row.runs).toBe(1);
    }
    const report = startWaveReport(rows, 12);
    expect(report).toContain('picked ÷ reach');
    expect(report).toMatch(/\ndot\s+0\s/);
  });
});
