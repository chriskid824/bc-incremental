/**
 * Turns session results into the balance simulator's outputs (docs/ARCHITECTURE.md §12):
 * runs.csv, milestones.csv, curve_check.csv and a compact stdout summary.
 */

import { formatNum } from '../../src/core/format';
import { num } from '../../src/core/num';
import { PACING_TARGETS, PACING_TOLERANCE, stdHp, targetDamage } from '../../src/data';
import { toCsv } from './csv';
import type { CsvValue } from './csv';
import type { RunRow, SessionResult } from './session';
import type { StrategyId } from './strategies';

/**
 * Sessions ordered by strategy (in `strategies` order) and then session index, so the output
 * does not depend on which worker finished first.
 */
export function sortResults(
  results: readonly SessionResult[],
  strategies: readonly StrategyId[],
): SessionResult[] {
  const rank = (strategy: StrategyId): number => {
    const index = strategies.indexOf(strategy);
    return index === -1 ? strategies.length : index;
  };
  return [...results].sort(
    (a, b) =>
      rank(a.strategy) - rank(b.strategy) ||
      a.strategy.localeCompare(b.strategy) ||
      a.session - b.session,
  );
}

/** Linear-interpolated quantile of ascending values; NaN for an empty list. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const a = sorted[lo] as number;
  const b = sorted[Math.min(sorted.length - 1, lo + 1)] as number;
  return a + (b - a) * (pos - lo);
}

const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

// ---- runs.csv ----

export const RUN_COLUMNS = [
  'strategy',
  'session',
  'run',
  'minutes',
  'startWave',
  'highestWaveReached',
  'highestWaveCleared',
  'clearedStartWave',
  'endReason',
  'runSeconds',
  'maxWave',
  'kills',
  'stdHpAtFrontier',
  'effectiveHit',
  'hitsToKillFrontier',
  'overkillShare',
  'dmgHit',
  'dmgCrit',
  'dmgBurn',
  'dmgChain',
  'shardsFromRun',
  'skipShards',
  'coresFromRun',
  'skipCores',
  'nodesAllocated',
  'repeatableRanks',
  'shardsBank',
  'coresBank',
  'bought',
] as const satisfies readonly (keyof RunRow)[];

export function runsCsv(sorted: readonly SessionResult[]): string {
  const rows: CsvValue[][] = [];
  for (const result of sorted) {
    for (const row of result.rows) rows.push(RUN_COLUMNS.map((column) => row[column]));
  }
  return toCsv(RUN_COLUMNS, rows);
}

// ---- milestones.csv ----

export const MILESTONE_WAVES = [5, 10, 15, 20, 25, 30, 40] as const;

/** Run-end minutes of the first run after which maxWave ≥ wave, or null if never. */
export function minutesToWave(result: SessionResult, wave: number): number | null {
  for (const row of result.rows) if (row.maxWave >= wave) return row.minutes;
  return null;
}

export function milestonesCsv(sorted: readonly SessionResult[]): string {
  const header = [
    'strategy',
    'session',
    ...MILESTONE_WAVES.map((wave) => `minToWave${wave}`),
    'minToFirstNotable',
    'minToFirstKeystone',
    'runs',
    'endMinutes',
    'endMaxWave',
  ];
  const rows = sorted.map((result): CsvValue[] => [
    result.strategy,
    result.session,
    ...MILESTONE_WAVES.map((wave) => minutesToWave(result, wave)),
    result.firstNotableMinutes,
    result.firstKeystoneMinutes,
    result.rows.length,
    result.endMinutes,
    result.rows.at(-1)?.maxWave ?? 0,
  ]);
  return toCsv(header, rows);
}

// ---- curve_check.csv ----

/**
 * The row describing a session at play time `minutes`: the last run that ended by then, or
 * the first run when none had (minute 0 shows what the fresh build reaches). Null when the
 * session stopped before `minutes`.
 */
export function rowAt(result: SessionResult, minutes: number): RunRow | null {
  if (minutes > result.endMinutes + 1e-9 || result.rows.length === 0) return null;
  let found = result.rows[0] as RunRow;
  for (const row of result.rows) {
    if (row.minutes > minutes) break;
    found = row;
  }
  return found;
}

export interface CurvePoint {
  readonly strategy: StrategyId;
  readonly minutes: number;
  readonly event: string;
  readonly targetWave: number;
  /** Sessions that lasted until `minutes`; the statistics below are over these. */
  readonly sessions: number;
  readonly waveP25: number;
  readonly waveMedian: number;
  readonly waveP75: number;
  readonly targetD: number;
  readonly medianD: number;
  /** Median over sessions of stdHp(maxWave) ÷ D. */
  readonly medianHitsToKill: number;
  /** null when no session lasted until `minutes`. */
  readonly withinTolerance: boolean | null;
}

export function curvePoints(sorted: readonly SessionResult[], strategy: StrategyId): CurvePoint[] {
  const sessions = sorted.filter((result) => result.strategy === strategy);
  return PACING_TARGETS.map((target) => {
    const rows: RunRow[] = [];
    for (const result of sessions) {
      const row = rowAt(result, target.minutes);
      if (row) rows.push(row);
    }
    const waves = ascending(rows.map((row) => row.maxWave));
    const ds = ascending(rows.map((row) => row.effectiveHit));
    const hits = ascending(rows.map((row) => stdHp(row.maxWave) / row.effectiveHit));
    const waveMedian = quantile(waves, 0.5);
    return {
      strategy,
      minutes: target.minutes,
      event: target.event,
      targetWave: target.frontierWave,
      sessions: rows.length,
      waveP25: quantile(waves, 0.25),
      waveMedian,
      waveP75: quantile(waves, 0.75),
      targetD: targetDamage(target.frontierWave),
      medianD: quantile(ds, 0.5),
      medianHitsToKill: quantile(hits, 0.5),
      withinTolerance:
        rows.length === 0
          ? null
          : Math.abs(waveMedian - target.frontierWave) <= PACING_TOLERANCE * target.frontierWave,
    };
  });
}

const nullIfNaN = (value: number): number | null => (Number.isNaN(value) ? null : value);

export function curveCheckCsv(
  sorted: readonly SessionResult[],
  strategies: readonly StrategyId[],
): string {
  const header = [
    'strategy',
    'minutes',
    'event',
    'sessions',
    'targetWave',
    'waveP25',
    'waveMedian',
    'waveP75',
    'targetD',
    'medianD',
    'medianHitsToKill',
    'withinTolerance',
  ];
  const rows: CsvValue[][] = [];
  for (const strategy of strategies) {
    for (const point of curvePoints(sorted, strategy)) {
      rows.push([
        point.strategy,
        point.minutes,
        point.event,
        point.sessions,
        point.targetWave,
        nullIfNaN(point.waveP25),
        nullIfNaN(point.waveMedian),
        nullIfNaN(point.waveP75),
        point.targetD,
        nullIfNaN(point.medianD),
        nullIfNaN(point.medianHitsToKill),
        point.withinTolerance === null ? 'n/a' : point.withinTolerance ? 'yes' : 'no',
      ]);
    }
  }
  return toCsv(header, rows);
}

// ---- stdout summary ----

const SUMMARY_MINUTES = [10, 20, 40, 60] as const;
/** Runs ending within this many minutes count as "early" for the run-length column. */
const EARLY_MINUTES = 10;
/** docs/GDD.md §2.2: share of run time in 10× overkill waves should stay ≤ 30%. */
const OVERKILL_LIMIT = 0.3;

const fmt = (value: number): string =>
  Number.isFinite(value) ? formatNum(num(value), { format: 'short' }) : '-';
/** Ratios span orders of magnitude, so keep two significant digits: 0.00041, 1.2, 3500. */
const ratio = (value: number): string =>
  Number.isFinite(value) ? String(Number(value.toPrecision(2))) : '-';
const pct = (value: number): string =>
  Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '-';

/** Fixed-width table: first column left-aligned, the rest right-aligned. */
export function formatTable(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/**
 * Per strategy: median frontier wave at 10/20/40/60 min (with the §7.3 targets on top), run
 * count and median run length (all runs and the first 10 minutes), overkill share (time-weighted,
 * and the share of runs above 30%), and median D vs target D at the last pacing point covered.
 */
export function summaryTable(
  sorted: readonly SessionResult[],
  strategies: readonly StrategyId[],
): string {
  const targetAt = (minutes: number): number | undefined =>
    PACING_TARGETS.find((t) => t.minutes === minutes)?.frontierWave;
  const header = [
    'strategy',
    ...SUMMARY_MINUTES.map((m) => `wave@${m}`),
    'runs/session',
    'run s',
    'run s ≤10m',
    'overkill',
    'runs >30%',
    'D vs target',
    'hits@F',
  ];
  const targets = [
    'target (±15%)',
    ...SUMMARY_MINUTES.map((m) => String(targetAt(m) ?? '-')),
    '',
    '',
    '',
    '≤30%',
    '0%',
    '',
    '2-4',
  ];
  const lines: string[][] = [header, targets];

  for (const strategy of strategies) {
    const sessions = sorted.filter((result) => result.strategy === strategy);
    const allRows = sessions.flatMap((result) => result.rows);
    if (allRows.length === 0) continue;
    const points = curvePoints(sorted, strategy);
    const pointAt = (minutes: number): CurvePoint | undefined =>
      points.find((p) => p.minutes === minutes && p.sessions > 0);
    const waveCell = (minutes: number): string => {
      const point = pointAt(minutes);
      if (!point) return '-';
      return fmt(point.waveMedian) + (point.withinTolerance ? '' : '*');
    };

    const runSeconds = ascending(allRows.map((row) => row.runSeconds));
    const earlySeconds = ascending(
      allRows.filter((row) => row.minutes <= EARLY_MINUTES).map((row) => row.runSeconds),
    );
    let overkill = 0;
    let total = 0;
    let overLimit = 0;
    for (const row of allRows) {
      overkill += row.overkillShare * row.runSeconds;
      total += row.runSeconds;
      if (row.overkillShare > OVERKILL_LIMIT) overLimit++;
    }
    const last = [...points].reverse().find((p) => p.sessions > 0);
    const dCell = last
      ? `${fmt(last.medianD)} / ${fmt(last.targetD)} @${last.minutes}m (${ratio(last.medianD / last.targetD)}x)`
      : '-';

    lines.push([
      strategy,
      ...SUMMARY_MINUTES.map(waveCell),
      fmt(allRows.length / sessions.length),
      fmt(quantile(runSeconds, 0.5)),
      fmt(quantile(earlySeconds, 0.5)),
      pct(total > 0 ? overkill / total : NaN),
      pct(overLimit / allRows.length),
      dCell,
      last ? fmt(last.medianHitsToKill) : '-',
    ]);
  }
  return (
    formatTable(lines) +
    '\n* = median frontier outside ±15% of the target. Waves and D are medians over sessions;' +
    '\n  "runs >30%" = share of runs over the overkill limit; hits@F = stdHp(frontier) ÷ D.'
  );
}
