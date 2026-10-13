import { describe, expect, it } from 'vitest';
import { DEFAULT_ECONOMY } from '../../src/meta';
import {
  firstRepeatableRun,
  median,
  medianMinutesToWave,
  nearFrontierRate,
  probeReport,
  spread,
} from './probe';
import { runSession } from './session';
import type { RunRow, SessionResult, ToughTarget } from './session';

const target = (overrides: Partial<ToughTarget>): ToughTarget => ({
  run: 1,
  enemy: 'hexagon',
  wave: 10,
  frontier: 10,
  outcome: 'killed',
  killSeconds: 2,
  ...overrides,
});

describe('nearFrontierRate', () => {
  it('counts only the given type within three waves of the frontier', () => {
    const rate = nearFrontierRate(
      [
        target({}),
        target({ wave: 13, outcome: 'reached', killSeconds: null }),
        target({ wave: 7, outcome: 'alive', killSeconds: null }),
        target({ wave: 14 }), // too far
        target({ enemy: 'boss' }),
      ],
      'hexagon',
    );
    expect(rate).toEqual({ killed: 1, reached: 1, alive: 1, killSeconds: [2] });
  });

  it('treats the first run (frontier 0) as frontier 1', () => {
    expect(nearFrontierRate([target({ wave: 4, frontier: 0 })], 'hexagon').killed).toBe(1);
    expect(nearFrontierRate([target({ wave: 5, frontier: 0 })], 'hexagon').killed).toBe(0);
  });
});

describe('median', () => {
  it('averages the middle pair and keeps infinity', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([1, 2, Infinity])).toBe(2);
    expect(median([1, Infinity])).toBe(Infinity);
    expect(median([])).toBeNaN();
  });
});

describe('spread', () => {
  it('is max ÷ min, NaN when a value is missing', () => {
    expect(spread([10, 12, 11])).toBeCloseTo(1.2, 12);
    expect(spread([10, Infinity])).toBeNaN();
    expect(spread([])).toBeNaN();
  });
});

function session(rows: readonly Partial<RunRow>[]): SessionResult {
  return {
    strategy: 'crit-greedy',
    session: 0,
    rows: rows.map((row, i) => ({ run: i + 1, minutes: i + 1, maxWave: 1, bought: '', ...row })),
    endMinutes: rows.length,
    firstNotableMinutes: null,
    firstKeystoneMinutes: null,
  } as SessionResult;
}

describe('session helpers', () => {
  it('finds the run after which the first repeatable rank was bought', () => {
    const result = session([{ bought: 'a b' }, { bought: 'c might×3' }, { bought: 'might' }]);
    expect(firstRepeatableRun(result, new Set(['might']))).toBe(2);
    expect(firstRepeatableRun(result, new Set(['other']))).toBeNull();
  });

  it('takes the median minutes to a wave, never reaching it counting as infinite', () => {
    const fast = session([{ maxWave: 5 }, { maxWave: 20 }]);
    const slow = session([{ maxWave: 5 }, { maxWave: 10 }, { maxWave: 20 }]);
    const never = session([{ maxWave: 5 }]);
    expect(medianMinutesToWave([fast, slow, never], 20)).toBe(3);
    expect(medianMinutesToWave([fast, never, never], 20)).toBe(Infinity);
  });
});

describe('probe on a short session', () => {
  const result = runSession({
    strategy: 'crit-greedy',
    session: 0,
    seed: 1,
    minutes: 6,
    startWave: { kind: 'max' },
    economy: DEFAULT_ECONOMY,
    menuSeconds: 20,
    waveCap: null,
    trackToughTargets: true,
  });

  it('tracks every elite and boss with a consistent outcome', () => {
    const targets = result.toughTargets ?? [];
    expect(targets.length).toBeGreaterThan(0);
    for (const tough of targets) {
      expect(tough.wave % 5).toBe(0);
      expect(tough.enemy).toBe(tough.wave % 10 === 0 ? 'boss' : 'hexagon');
      expect(tough.killSeconds === null).toBe(tough.outcome !== 'killed');
      const row = result.rows[tough.run - 1];
      expect(row).toBeDefined();
      expect(tough.wave).toBeLessThanOrEqual(row?.highestWaveReached ?? 0);
    }
  });

  it('leaves results without tracking unchanged', () => {
    const plain = runSession({
      strategy: 'crit-greedy',
      session: 0,
      seed: 1,
      minutes: 6,
      startWave: { kind: 'max' },
      economy: DEFAULT_ECONOMY,
      menuSeconds: 20,
      waveCap: null,
    });
    expect(plain.toughTargets).toBeUndefined();
    expect(plain.rows).toEqual(result.rows);
  });

  it('renders every table', () => {
    const report = probeReport(new Map([[1, [result]]]), ['crit-greedy'], new Set(['might']));
    for (const heading of ['Frontier', 'Time to wave', 'First purchases', 'Elites', 'Might vs']) {
      expect(report).toContain(heading);
    }
    expect(report).toMatch(/\ncrit-greedy\s/);
  });
});
