import { describe, expect, it } from 'vitest';
import type { ProbeCheck, ProbeSummary, StrategySummary } from './probe';
import { diffProbes, formatProbeDiff, relativeChange } from './probeDiff';

const strategy = (f20: number, wave30: number): StrategySummary => ({
  frontier: {
    'F@10': { pooled: 13, perSeed: [13, 14] },
    'F@20': { pooled: f20, perSeed: [f20, f20] },
  },
  minutesToWave: {
    '20': { pooled: 15, perSeed: [15, 15] },
    '30': { pooled: wave30, perSeed: [wave30, wave30] },
  },
  firstNotableMinutes: 5,
  firstKeystoneMinutes: 14,
  firstRepeatableRun: 12,
  elites: { killed: 9, reached: 1, alive: 2 },
  bosses: { killed: 3, reached: 0, alive: 1 },
  bossKillSeconds: 9,
  multipliers: {
    ranks: 16,
    repeatableMultD: 5,
    sectorMultD: 8,
    sectorMultAttack: 8,
    sectorMultCrowd: 12,
  },
  overkill: { maxShare: 0.05, runsOver: 0, runs: 100 },
});

const check = (id: string, pass: boolean, label = `${id} target`): ProbeCheck => ({
  id,
  label,
  value: pass ? 'in' : 'out',
  pass,
});

const summary = (
  overrides: { f20?: number; wave30?: number; checks?: ProbeCheck[] } = {},
): ProbeSummary => ({
  seeds: [1, 2],
  sessions: 12,
  minutes: 60,
  strategies: {
    'crit-greedy': strategy(overrides.f20 ?? 24, overrides.wave30 ?? 25),
    'dot-greedy': strategy(23, 29),
  },
  checks: overrides.checks ?? [check('T1', true), check('info', false)],
});

describe('relativeChange', () => {
  it('is 0 for equal values, ∞ included, and ∞ when only one side is finite', () => {
    expect(relativeChange(20, 21)).toBeCloseTo(0.05, 12);
    expect(relativeChange(20, 19)).toBeCloseTo(-0.05, 12);
    expect(relativeChange(Infinity, Infinity)).toBe(0);
    expect(relativeChange(NaN, NaN)).toBe(0);
    expect(relativeChange(30, Infinity)).toBe(Infinity);
    expect(relativeChange(0, 1)).toBe(Infinity);
  });
});

describe('diffProbes', () => {
  it('reports no change for the same summary', () => {
    const diff = diffProbes(summary(), summary());
    expect(diff.identical).toBe(true);
    expect(diff.pass).toBe(true);
    expect(diff.metrics.map((m) => m.metric)).toEqual([
      'crit-greedy F@10',
      'crit-greedy F@20',
      'crit-greedy minutes to wave 20',
      'crit-greedy minutes to wave 30',
      'dot-greedy F@10',
      'dot-greedy F@20',
      'dot-greedy minutes to wave 20',
      'dot-greedy minutes to wave 30',
    ]);
    expect(formatProbeDiff(diff)).toContain('Gate: pass (no change: every number is identical)');
  });

  it('passes changes within the tolerance and fails larger ones', () => {
    const near = diffProbes(summary(), summary({ f20: 25 }));
    expect(near.identical).toBe(false);
    expect(near.pass).toBe(true);
    const far = diffProbes(summary(), summary({ f20: 22.5 }));
    expect(far.pass).toBe(false);
    expect(far.metrics.filter((m) => !m.pass).map((m) => m.metric)).toEqual(['crit-greedy F@20']);
    expect(formatProbeDiff(far)).toMatch(/crit-greedy F@20\s+24\s+22\.5\s+-6\.3%\s+FAIL/);
    expect(formatProbeDiff(far)).toContain('Gate: FAIL');
    expect(diffProbes(summary(), summary({ f20: 22.5 }), 0.1).pass).toBe(true);
  });

  it('fails when a wave is no longer reached', () => {
    const diff = diffProbes(summary(), summary({ wave30: Infinity }));
    expect(diff.pass).toBe(false);
    expect(formatProbeDiff(diff)).toMatch(/minutes to wave 30\s+25\s+Infinity\s+∞\s+FAIL/);
  });

  it('fails a T check that fails or disappears after, never an info check', () => {
    const failing = summary({ checks: [check('T1', false), check('info', false)] });
    expect(diffProbes(summary(), failing).pass).toBe(false);
    const dropped = summary({ checks: [check('info', true)] });
    const diff = diffProbes(summary(), dropped);
    expect(diff.pass).toBe(false);
    expect(diff.checks.map((c) => [c.id, c.pass])).toEqual([
      ['info', true],
      ['T1', false],
    ]);
  });
});
