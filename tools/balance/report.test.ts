import { describe, expect, it } from 'vitest';
import { PACING_TARGETS, stdHp } from '../../src/data';
import {
  curveCheckCsv,
  curvePoints,
  milestonesCsv,
  minutesToWave,
  multiplierTable,
  quantile,
  rowAt,
  RUN_COLUMNS,
  runsCsv,
  sortResults,
  summaryTable,
} from './report';
import type { RunRow, SessionResult } from './session';
import type { StrategyId } from './strategies';

function row(overrides: Partial<RunRow>): RunRow {
  return {
    strategy: 'crit-greedy',
    session: 0,
    run: 1,
    minutes: 1,
    startWave: 1,
    highestWaveReached: 4,
    highestWaveCleared: 3,
    clearedStartWave: true,
    endReason: 'death',
    runSeconds: 40,
    maxWave: 4,
    kills: 10,
    stdHpAtFrontier: stdHp(4),
    effectiveHit: 10,
    hitsToKillFrontier: stdHp(4) / 10,
    overkillShare: 0,
    dmgHit: 1,
    dmgCrit: 0,
    dmgBurn: 0,
    dmgChain: 0,
    shardsFromRun: 20,
    skipShards: 0,
    coresFromRun: 0,
    skipCores: 0,
    nodesAllocated: 1,
    repeatableRanks: 0,
    repeatableMultD: 1,
    sectorMultD: 1,
    sectorMultCrowd: 1,
    shardsBank: 0,
    coresBank: 0,
    bought: 'a',
    ...overrides,
  };
}

/** A session whose frontier after run i (ending at minute 5·i) is `waves[i - 1]`. */
function session(strategy: StrategyId, index: number, waves: readonly number[]): SessionResult {
  const rows = waves.map((wave, i) =>
    row({
      strategy,
      session: index,
      run: i + 1,
      minutes: 5 * (i + 1),
      maxWave: wave,
      highestWaveReached: wave,
      effectiveHit: stdHp(wave) / 3,
    }),
  );
  return {
    strategy,
    session: index,
    rows,
    endMinutes: 5 * waves.length + 0.3,
    firstNotableMinutes: 10,
    firstKeystoneMinutes: null,
  };
}

describe('quantile', () => {
  it('interpolates linearly', () => {
    expect(quantile([], 0.5)).toBeNaN();
    expect(quantile([7], 0.25)).toBe(7);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([0, 10], 0.75)).toBe(7.5);
  });
});

describe('rowAt', () => {
  const result = session('crit-greedy', 0, [4, 6, 9]);

  it('takes the last run that ended by then, or the first run before any ended', () => {
    expect(rowAt(result, 0)?.run).toBe(1);
    expect(rowAt(result, 5)?.run).toBe(1);
    expect(rowAt(result, 9.9)?.run).toBe(1);
    expect(rowAt(result, 10)?.run).toBe(2);
    expect(rowAt(result, 15.2)?.run).toBe(3);
  });

  it('is null after the session stopped', () => {
    expect(rowAt(result, 15.3)?.run).toBe(3);
    expect(rowAt(result, 16)).toBeNull();
  });
});

describe('sortResults', () => {
  it('orders by the given strategy order, then session', () => {
    const results = [
      session('dot-greedy', 1, [4]),
      session('crit-greedy', 1, [4]),
      session('dot-greedy', 0, [4]),
      session('crit-greedy', 0, [4]),
    ];
    const sorted = sortResults(results, ['dot-greedy', 'crit-greedy']);
    expect(sorted.map((r) => `${r.strategy}/${r.session}`)).toEqual([
      'dot-greedy/0',
      'dot-greedy/1',
      'crit-greedy/0',
      'crit-greedy/1',
    ]);
  });
});

describe('outputs', () => {
  // Frontier 15 at 10 min and 22 at 20 min hits the targets; 8 sessions with spread.
  const results = Array.from({ length: 4 }, (_, i) =>
    session('balanced', i, [3, 15 + (i % 2), 20, 22 + i]),
  );

  it('curve check reports quantiles, targets and tolerance per pacing point', () => {
    const points = curvePoints(results, 'balanced');
    expect(points.map((p) => p.minutes)).toEqual(PACING_TARGETS.map((t) => t.minutes));
    const at10 = points.find((p) => p.minutes === 10);
    expect(at10).toMatchObject({ sessions: 4, targetWave: 15, waveMedian: 15.5 });
    expect(at10?.withinTolerance).toBe(true);
    expect(at10?.medianHitsToKill).toBeCloseTo(3, 9);
    const at20 = points.find((p) => p.minutes === 20);
    expect(at20).toMatchObject({ waveP25: 22.75, waveMedian: 23.5, waveP75: 24.25 });
    const at60 = points.find((p) => p.minutes === 60);
    expect(at60).toMatchObject({ sessions: 0, withinTolerance: null });

    const csv = curveCheckCsv(results, ['balanced']).split('\n');
    expect(csv[0]).toBe(
      'strategy,minutes,event,sessions,targetWave,waveP25,waveMedian,waveP75,targetD,medianD,' +
        'medianHitsToKill,withinTolerance',
    );
    expect(csv.find((line) => line.startsWith('balanced,60,'))).toMatch(/,,,,.*,,n\/a$/);
  });

  it('milestones give the first run end reaching each wave', () => {
    expect(minutesToWave(results[0] as SessionResult, 15)).toBe(10);
    expect(minutesToWave(results[0] as SessionResult, 40)).toBeNull();
    const lines = milestonesCsv(results).split('\n');
    expect(lines[0]).toMatch(/^strategy,session,minToWave5,minToWave10,/);
    expect(lines[1]).toBe('balanced,0,10,10,10,15,,,,10,,4,20.3,22');
  });

  it('runs.csv has one line per run with every column', () => {
    const lines = runsCsv(results).trimEnd().split('\n');
    expect(lines).toHaveLength(1 + 16);
    expect(lines[0]?.split(',')).toEqual([...RUN_COLUMNS]);
    expect(lines[1]?.split(',')).toHaveLength(RUN_COLUMNS.length);
  });

  it('summary lists each strategy with targets', () => {
    const summary = summaryTable(results, ['balanced']);
    expect(summary).toMatch(/^strategy\s+wave@10\s+wave@20/);
    expect(summary).toMatch(/\nbalanced\s+15\.5\s+23\.5\s+-\s+-/);
  });

  it('multiplier table gives medians of the build playing at the given minute', () => {
    // Runs end at minutes 5, 10, 15, 20; at minute 12 the second run's build is playing.
    const withMults = results.map((result, i) => ({
      ...result,
      rows: result.rows.map((r) => ({
        ...r,
        repeatableRanks: r.run * 2,
        repeatableMultD: r.run + i,
        sectorMultD: 10 * r.run,
        sectorMultCrowd: 100 * r.run,
      })),
    }));
    const table = multiplierTable(withMults, ['balanced', 'dot-greedy'], 12);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^@12m\s+ranks\s+Might× D\s+sector× D\s+sector× crowd$/);
    // Might× over sessions: 2, 3, 4, 5 → median 3.5. No dot-greedy sessions, so no row.
    expect(lines[1]).toMatch(/^balanced\s+4\s+3\.5\s+20\s+200$/);
    expect(lines[2]).toMatch(/^Might× = /);
  });
});
