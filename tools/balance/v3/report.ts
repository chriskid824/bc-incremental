/**
 * Turns character sessions into the v3 balance outputs (docs/v3 C10 design §1.4): runs.csv with
 * its per-type columns, milestones.csv, curve_check.csv, budget.csv and a compact stdout summary.
 * M1's outputs stay in tools/balance/report.ts, unchanged (W10).
 */

import { PACING_TARGETS, PACING_TOLERANCE } from '../../../src/data';
import { toCsv } from '../csv';
import type { CsvValue } from '../csv';
import { formatTable, quantile } from '../report';
import { BUDGET_COUNTERS, TYPE_COLUMNS, V3_MILESTONE_WAVES } from './session';
import type { CharacterRunRow, CharacterSessionResult } from './session';

const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);
const nullIfNaN = (value: number): number | null => (Number.isNaN(value) ? null : value);

/** The sessions' (character, strategy) pairs, in the order the results first name them. */
function groups(
  results: readonly CharacterSessionResult[],
): { readonly key: string; readonly sessions: CharacterSessionResult[] }[] {
  const byKey = new Map<string, CharacterSessionResult[]>();
  for (const result of results) {
    const key = `${result.character} ${result.strategy}`;
    const list = byKey.get(key) ?? [];
    list.push(result);
    byKey.set(key, list);
  }
  return [...byKey].map(([key, sessions]) => ({ key, sessions }));
}

// ---- runs.csv ----

/** The row fields printed as they are, in column order; per-type tallies, bombs and bought follow. */
const RUN_FIELDS = [
  'character',
  'scope',
  'strategy',
  'session',
  'run',
  'minutes',
  'startWave',
  'highestWaveReached',
  'highestWaveCleared',
  'endReason',
  'runSeconds',
  'cycleBest',
  'bestWave',
  'prestiges',
  'kills',
  'leaks',
  'damageTaken',
  'killedBy',
  'shardsFromRun',
  'skipShards',
  'coresFromRun',
  'skipCores',
  'shardsBank',
  'coresBank',
  'purchases',
  'nodesCenter',
  'nodesHub',
  'nodesOuter',
  'outersUsed',
  'keystones',
  'fusionCores',
  'dmgCenter',
  'dmgHub',
  'dmgOuter',
  'dmgFusion',
  'dmgAsc',
  'centerShare',
] as const satisfies readonly (keyof CharacterRunRow)[];

/** The v3 runs.csv columns: leaks_<r>, contact_<r> and bullet_<r> per TYPE_COLUMNS column r. */
export const V3_RUN_COLUMNS: readonly string[] = [
  ...RUN_FIELDS,
  ...TYPE_COLUMNS.flatMap((column) => [`leaks_${column}`, `contact_${column}`, `bullet_${column}`]),
  'bombs',
  'bought',
];

export function characterRunsCsv(results: readonly CharacterSessionResult[]): string {
  const rows: CsvValue[][] = [];
  for (const result of results) {
    for (const row of result.rows) {
      rows.push([
        ...RUN_FIELDS.map((field) => row[field]),
        ...TYPE_COLUMNS.flatMap((column) => {
          const tally = row.byType[column];
          return [tally.leaks, tally.contact, tally.bullet];
        }),
        row.bombs,
        row.bought,
      ]);
    }
  }
  return toCsv(V3_RUN_COLUMNS, rows);
}

// ---- milestones.csv ----

export function characterMilestonesCsv(results: readonly CharacterSessionResult[]): string {
  const header = [
    'character',
    'scope',
    'strategy',
    'session',
    ...V3_MILESTONE_WAVES.map((wave) => `minToWave${wave}`),
    'firstOuterNode',
    'firstFusionCore',
    'firstKeystoneAffordable',
    'firstKeystone',
    'prestigeMinutes',
    'prestigePurchases',
    'centerThreshold',
    'wallMinutes',
    'wallWave',
    'runs',
    'endMinutes',
    'endBestWave',
    'stop',
  ];
  const rows = results.map((result): CsvValue[] => {
    const { milestones } = result;
    return [
      result.character,
      result.scope,
      result.strategy,
      result.session,
      ...V3_MILESTONE_WAVES.map((wave) => milestones.minutesToWave[wave] ?? null),
      milestones.firstOuterNode,
      milestones.firstFusionCore,
      milestones.firstKeystoneAffordable,
      milestones.firstKeystone,
      milestones.prestigePoint?.minutes ?? null,
      milestones.prestigePoint?.purchases ?? null,
      milestones.centerThreshold,
      milestones.wall?.minutes ?? null,
      milestones.wall?.wave ?? null,
      result.rows.length,
      result.endMinutes,
      result.rows.at(-1)?.bestWave ?? 0,
      result.stop,
    ];
  });
  return toCsv(header, rows);
}

// ---- curve_check.csv ----

/**
 * The pacing targets of character sessions (初始值): src/data/curve.ts' PACING_TARGETS plus F5's
 * wave 100 at 5 h, kept in the tools so M1's curve check never moves.
 */
export const V3_PACING_TARGETS: readonly {
  readonly minutes: number;
  readonly frontierWave: number;
  readonly event: string;
}[] = [...PACING_TARGETS, { minutes: 300, frontierWave: 100, event: 'clear' }];

/**
 * A session's row at play time `minutes`, as the pacing check reads it (design §2.2): the last run
 * that ended by then, or the first run when none had (M1's rowAt). A session that stopped at the
 * prestige point or the clear keeps its last row (`carried`); one its budget stopped has none past
 * its end.
 */
export function characterRowAt(
  result: CharacterSessionResult,
  minutes: number,
): { readonly row: CharacterRunRow; readonly carried: boolean } | null {
  const first = result.rows[0];
  if (first === undefined) return null;
  const past = minutes > result.endMinutes + 1e-9;
  if (past && result.stop === 'budget') return null;
  let found = first;
  for (const row of result.rows) {
    if (row.minutes > minutes) break;
    found = row;
  }
  return { row: found, carried: past };
}

export interface CharacterCurvePoint {
  readonly character: string;
  readonly scope: string;
  readonly strategy: string;
  readonly minutes: number;
  readonly event: string;
  /** Sessions read at `minutes`, the carried ones included; the statistics are over these. */
  readonly sessions: number;
  readonly carried: number;
  readonly targetWave: number;
  /** Quantiles of bestWave over the sessions read. */
  readonly waveP25: number;
  readonly waveMedian: number;
  readonly waveP75: number;
  /** null when no session was read. */
  readonly withinTolerance: boolean | null;
}

/** V3_PACING_TARGETS against the median bestWave of one character's and strategy's sessions. */
export function characterCurvePoints(
  sessions: readonly CharacterSessionResult[],
): CharacterCurvePoint[] {
  const head = sessions[0];
  if (head === undefined) return [];
  return V3_PACING_TARGETS.map((target) => {
    const read = sessions
      .map((result) => characterRowAt(result, target.minutes))
      .filter((found) => found !== null);
    const waves = ascending(read.map((found) => found.row.bestWave));
    const waveMedian = quantile(waves, 0.5);
    return {
      character: head.character,
      scope: head.scope,
      strategy: head.strategy,
      minutes: target.minutes,
      event: target.event,
      sessions: read.length,
      carried: read.filter((found) => found.carried).length,
      targetWave: target.frontierWave,
      waveP25: quantile(waves, 0.25),
      waveMedian,
      waveP75: quantile(waves, 0.75),
      withinTolerance:
        read.length === 0
          ? null
          : Math.abs(waveMedian - target.frontierWave) <= PACING_TOLERANCE * target.frontierWave,
    };
  });
}

export function characterCurveCheckCsv(results: readonly CharacterSessionResult[]): string {
  const header = [
    'character',
    'scope',
    'strategy',
    'minutes',
    'event',
    'sessions',
    'carried',
    'targetWave',
    'waveP25',
    'waveMedian',
    'waveP75',
    'withinTolerance',
  ];
  const rows: CsvValue[][] = [];
  for (const { sessions } of groups(results)) {
    for (const point of characterCurvePoints(sessions)) {
      rows.push([
        point.character,
        point.scope,
        point.strategy,
        point.minutes,
        point.event,
        point.sessions,
        point.carried,
        point.targetWave,
        nullIfNaN(point.waveP25),
        nullIfNaN(point.waveMedian),
        nullIfNaN(point.waveP75),
        point.withinTolerance === null ? 'n/a' : point.withinTolerance ? 'yes' : 'no',
      ]);
    }
  }
  return toCsv(header, rows);
}

// ---- budget.csv ----

/** Per run: the budget and cap counters by name (blank for one the run lacks) and the bombs. */
export function budgetCsv(results: readonly CharacterSessionResult[]): string {
  const header = ['character', 'scope', 'strategy', 'session', 'run', ...BUDGET_COUNTERS, 'bombs'];
  const rows: CsvValue[][] = [];
  for (const result of results) {
    for (const row of result.rows) {
      rows.push([
        row.character,
        row.scope,
        row.strategy,
        row.session,
        row.run,
        ...BUDGET_COUNTERS.map((name) => row.budget[name]),
        row.bombs,
      ]);
    }
  }
  return toCsv(header, rows);
}

// ---- stdout summary ----

const SUMMARY_MINUTES = [10, 20, 40, 60] as const;

const fmt = (value: number): string =>
  Number.isFinite(value) ? String(Number(value.toFixed(1))) : '-';

/**
 * Per character and strategy: median bestWave at 10/20/40/60 min (the targets on top), runs per
 * session, median minutes and purchases at the prestige point over the sessions that reached it,
 * and how the sessions stopped.
 */
export function characterSummaryTable(results: readonly CharacterSessionResult[]): string {
  const targetAt = (minutes: number): number | undefined =>
    V3_PACING_TARGETS.find((t) => t.minutes === minutes)?.frontierWave;
  const lines: string[][] = [
    [
      'character strategy',
      ...SUMMARY_MINUTES.map((m) => `wave@${m}`),
      'runs/session',
      'prestige min',
      'purchases',
      'stops',
    ],
    ['target (±15%)', ...SUMMARY_MINUTES.map((m) => String(targetAt(m) ?? '-')), '', '', '', ''],
  ];
  for (const { key, sessions } of groups(results)) {
    const points = characterCurvePoints(sessions);
    const waveCell = (minutes: number): string => {
      const point = points.find((p) => p.minutes === minutes && p.sessions > 0);
      if (!point) return '-';
      return fmt(point.waveMedian) + (point.withinTolerance ? '' : '*');
    };
    const reached = sessions.flatMap((result) =>
      result.milestones.prestigePoint === null ? [] : [result.milestones.prestigePoint],
    );
    const median = (values: readonly number[]): string => fmt(quantile(ascending(values), 0.5));
    const stops = new Map<string, number>();
    for (const result of sessions) stops.set(result.stop, (stops.get(result.stop) ?? 0) + 1);
    lines.push([
      key,
      ...SUMMARY_MINUTES.map(waveCell),
      fmt(sessions.reduce((sum, result) => sum + result.rows.length, 0) / sessions.length),
      `${median(reached.map((point) => point.minutes))} (${reached.length}/${sessions.length})`,
      median(reached.map((point) => point.purchases)),
      [...stops].map(([stop, count]) => `${count} ${stop}`).join(', '),
    ]);
  }
  return (
    formatTable(lines) +
    '\n* = median bestWave outside ±15% of the target. Waves are medians over sessions; a session' +
    '\n  stopped at the prestige point keeps its last bestWave. Prestige minutes and purchases are' +
    '\n  medians over the sessions that reached it.'
  );
}
