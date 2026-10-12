import { describe, expect, it } from 'vitest';
import { DEFAULT_ECONOMY } from '../../src/meta';
import { parseOptions, runBalance } from './cli';
import type { CliOptions } from './cli';

const tiny: CliOptions = {
  strategies: ['chain-greedy', 'crit-greedy', 'balanced'],
  sessions: 2,
  minutes: 1.5,
  seed: 7,
  startWave: { kind: 'max' },
  economy: DEFAULT_ECONOMY,
  menuSeconds: 20,
  waveCap: null,
  out: 'unused',
  workers: 1,
};

describe('runBalance', () => {
  it('gives identical output in-process and on worker threads', async () => {
    const inProcess = await runBalance(tiny);
    const warnings: string[] = [];
    const workers = await runBalance({ ...tiny, workers: 3 }, (message) => warnings.push(message));

    expect(inProcess.mode).toBe('in-process');
    expect(warnings).toEqual([]);
    expect(workers.mode).toBe('3 workers');
    expect(workers.runsCsv).toBe(inProcess.runsCsv);
    expect(workers.milestonesCsv).toBe(inProcess.milestonesCsv);
    expect(workers.curveCheckCsv).toBe(inProcess.curveCheckCsv);
    expect(workers.summary).toBe(inProcess.summary);

    // Strategy order follows the request, then session, then run.
    const keys = inProcess.runsCsv
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((line) => line.split(',').slice(0, 2).join('/'));
    const order = [...new Set(keys)];
    expect(order).toEqual([
      'chain-greedy/0',
      'chain-greedy/1',
      'crit-greedy/0',
      'crit-greedy/1',
      'balanced/0',
      'balanced/1',
    ]);
  }, 20_000);
});

describe('parseOptions', () => {
  it('applies defaults', () => {
    const options = parseOptions([]);
    expect(options).toMatchObject({
      strategies: ['crit-greedy'],
      sessions: 20,
      minutes: 60,
      seed: 1,
      startWave: { kind: 'max' },
      economy: DEFAULT_ECONOMY,
      menuSeconds: 20,
      waveCap: null,
    });
    expect(options?.workers).toBeGreaterThanOrEqual(1);
    expect(options?.workers).toBeLessThanOrEqual(4);
  });

  it('parses every option', () => {
    const options = parseOptions([
      '--strategy',
      'all',
      '--sessions',
      '3',
      '--minutes',
      '12.5',
      '--seed',
      '9',
      '--start-wave',
      'ratio:0.4',
      '--start-wave-ratio',
      '0.75',
      '--skip-reward-rate',
      '0.5',
      '--menu-seconds',
      '0',
      '--wave-cap',
      '40',
      '--out',
      'out/x',
      '--workers',
      '2',
    ]);
    expect(options).toEqual({
      strategies: ['crit-greedy', 'dot-greedy', 'chain-greedy', 'cheapest', 'balanced'],
      sessions: 3,
      minutes: 12.5,
      seed: 9,
      startWave: { kind: 'ratio', ratio: 0.4 },
      economy: { ...DEFAULT_ECONOMY, startWaveRatio: 0.75, skipRewardRate: 0.5 },
      menuSeconds: 0,
      waveCap: 40,
      out: 'out/x',
      workers: 2,
    });
    expect(parseOptions(['--strategy', 'dot-greedy,cheapest'])?.strategies).toEqual([
      'dot-greedy',
      'cheapest',
    ]);
    expect(parseOptions(['--help'])).toBeNull();
  });

  it('rejects invalid values', () => {
    expect(() => parseOptions(['--strategy', 'summon-greedy'])).toThrow(/Unknown strategy/);
    expect(() => parseOptions(['--sessions', '0'])).toThrow(/--sessions must be an integer/);
    expect(() => parseOptions(['--minutes', 'abc'])).toThrow(/--minutes/);
    expect(() => parseOptions(['--workers', '1.5'])).toThrow(/--workers/);
    expect(() => parseOptions(['--start-wave', 'ratio:2'])).toThrow(/start-wave policy/);
    expect(() => parseOptions(['--bogus'])).toThrow();
  });
});
