import { describe, expect, it } from 'vitest';
import { DEFAULT_ECONOMY } from '../../src/meta';
import {
  firstRepeatableRun,
  formatChecks,
  median,
  medianMinutesToWave,
  nearFrontierRate,
  probeChecks,
  probeFromJson,
  probeReport,
  probeSummary,
  probeToJson,
  spread,
} from './probe';
import { runSession } from './session';
import type { RunRow, SessionResult, ToughTarget } from './session';
import type { StrategyId } from './strategies';

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

describe('probeChecks', () => {
  /** A pure session that meets every target: waves 14, 22, 30, 40 at 10, 20, 40, 60 min. */
  const pureSession = (strategy: StrategyId, wave60 = 40): SessionResult =>
    ({
      strategy,
      session: 0,
      rows: (
        [
          [10, 14],
          [15, 20],
          [20, 22],
          [28, 30],
          [30, 31],
          [40, 30],
          [60, wave60],
        ] as const
      ).map(([minutes, maxWave], i) => ({
        run: i + 1,
        minutes,
        maxWave,
        bought: i === 0 ? 'might' : '',
        overkillShare: 0.1,
        repeatableMultD: 2,
        sectorMultD: strategy === 'chain-greedy' ? 1 : 3,
        sectorMultAttack: 3,
      })),
      endMinutes: 60,
      firstNotableMinutes: 5,
      firstKeystoneMinutes: 12,
      toughTargets: [
        target({ wave: 30, frontier: 30, enemy: 'boss', killSeconds: 9 }),
        target({ wave: 25, frontier: 26, outcome: 'reached', killSeconds: null }),
        target({ wave: 25, frontier: 26 }),
      ],
    }) as unknown as SessionResult;
  const pure: StrategyId[] = ['crit-greedy', 'dot-greedy', 'chain-greedy'];
  const ids = new Set(['might']);

  it('passes results that meet every round-2 target', () => {
    const results = pure.map((strategy) => pureSession(strategy));
    const checks = probeChecks(new Map([[1, results]]), pure, ids);
    expect(checks.map((c) => c.id)).toEqual([
      'T1',
      'T2',
      'T2',
      'T4',
      'T4',
      'T4',
      'T4',
      'T4',
      'T6',
      'T7',
      'info',
      'T8',
    ]);
    expect(checks.filter((c) => !c.pass)).toEqual([]);
    expect(formatChecks(checks)).not.toContain('FAIL');
  });

  it('fails a frontier out of range and skips checks without their strategies', () => {
    const results = [
      pureSession('crit-greedy', 50),
      pureSession('dot-greedy'),
      pureSession('chain-greedy'),
    ];
    const checks = probeChecks(new Map([[1, results]]), pure, ids);
    expect(checks.find((c) => c.id === 'T1')?.pass).toBe(false);
    expect(formatChecks(checks)).toMatch(/T1 .*FAIL/);
    expect(
      probeChecks(new Map([[1, results.slice(0, 1)]]), ['crit-greedy'], ids).map((c) => c.id),
    ).toEqual(['T8']);
  });

  it('summarises the numbers behind the tables, and keeps ∞ and NaN through JSON', () => {
    const results = [
      { ...pureSession('crit-greedy'), firstKeystoneMinutes: null },
      pureSession('dot-greedy', 38),
      pureSession('chain-greedy'),
    ];
    const bySeed = new Map([[1, results]]);
    const summary = probeSummary(bySeed, pure, ids, { sessions: 1, minutes: 60 });
    expect(Object.keys(summary.strategies)).toEqual(pure);
    expect(summary).toMatchObject({ seeds: [1], sessions: 1, minutes: 60 });
    expect(summary.checks).toEqual(probeChecks(bySeed, pure, ids));
    const crit = summary.strategies['crit-greedy'];
    expect(crit?.frontier['F@20']).toEqual({ pooled: 22, perSeed: [22] });
    expect(summary.strategies['dot-greedy']?.frontier['F@60']?.pooled).toBe(38);
    expect(crit?.minutesToWave['30']?.pooled).toBe(medianMinutesToWave(results.slice(0, 1), 30));
    expect(crit?.firstKeystoneMinutes).toBe(Infinity);
    expect(crit?.firstRepeatableRun).toBe(1);
    expect(crit?.elites).toEqual({ killed: 1, reached: 1, alive: 0 });
    expect(crit?.bossKillSeconds).toBe(9);
    expect(crit?.overkill).toEqual({ maxShare: 0.1, runsOver: 0, runs: 7 });
    const text = probeToJson(summary);
    expect(text).toContain('"firstKeystoneMinutes": "Infinity"');
    expect(probeFromJson(text)).toEqual(summary);
  });

  it('checks balanced, cheapest and might-only when they ran', () => {
    const results = [
      ...pure.map((strategy) => pureSession(strategy)),
      pureSession('balanced', 38),
      pureSession('cheapest', 27),
      pureSession('might-only', 11),
    ];
    const strategies: StrategyId[] = [...pure, 'balanced', 'cheapest', 'might-only'];
    const checks = probeChecks(new Map([[1, results]]), strategies, ids);
    expect(checks.find((c) => c.id === 'T3')?.pass).toBe(true);
    expect(checks.find((c) => c.id === 'T5')?.pass).toBe(true);
  });
});
