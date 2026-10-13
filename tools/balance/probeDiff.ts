/**
 * Compares two probe summaries (tools/balance/probe.ts --json) against the gate a refactor or
 * a small behaviour change must meet: per strategy, the pooled frontier at 10/20/40/60 minutes
 * and the pooled minutes to waves 20 and 30 within ±tolerance (5%), and every T1–T8 check still
 * passing. 'info' checks are shown but never fail the gate. Exits 1 when the gate fails.
 *
 *   npx tsx tools/balance/probeDiff.ts <before.json> <after.json> [--tolerance 0.05]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { probeFromJson } from './probe';
import type { ProbeCheck, ProbeSummary, SeedMedians } from './probe';
import { formatTable } from './report';
import type { StrategyId } from './strategies';

export const DEFAULT_TOLERANCE = 0.05;

/** One gated number. `change` is relative; ∞ when exactly one side is not finite. */
export interface MetricDiff {
  readonly metric: string;
  readonly before: number;
  readonly after: number;
  readonly change: number;
  readonly pass: boolean;
}

export interface CheckDiff {
  readonly id: string;
  readonly label: string;
  /** Null when the check was not run before. */
  readonly before: ProbeCheck | null;
  /** Null when the check was not run after. */
  readonly after: ProbeCheck | null;
  readonly pass: boolean;
}

export interface ProbeDiff {
  readonly metrics: readonly MetricDiff[];
  readonly checks: readonly CheckDiff[];
  /** Every number of both summaries is the same. */
  readonly identical: boolean;
  readonly pass: boolean;
}

/** (after − before) ÷ |before|; 0 when equal (∞ = ∞ included), ∞ when only one is finite. */
export function relativeChange(before: number, after: number): number {
  if (Object.is(before, after) || before === after) return 0;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return Infinity;
  return before === 0 ? Infinity : (after - before) / Math.abs(before);
}

const pooled = (medians: Readonly<Record<string, SeedMedians>> | undefined, key: string) =>
  medians?.[key]?.pooled ?? NaN;

export function diffProbes(
  before: ProbeSummary,
  after: ProbeSummary,
  tolerance = DEFAULT_TOLERANCE,
): ProbeDiff {
  const metrics: MetricDiff[] = [];
  const add = (metric: string, was: number, now: number): void => {
    const change = relativeChange(was, now);
    metrics.push({ metric, before: was, after: now, change, pass: Math.abs(change) <= tolerance });
  };
  for (const strategy of Object.keys(before.strategies) as StrategyId[]) {
    const was = before.strategies[strategy];
    const now = after.strategies[strategy];
    for (const key of Object.keys(was?.frontier ?? {})) {
      add(`${strategy} ${key}`, pooled(was?.frontier, key), pooled(now?.frontier, key));
    }
    for (const key of Object.keys(was?.minutesToWave ?? {})) {
      add(
        `${strategy} minutes to wave ${key}`,
        pooled(was?.minutesToWave, key),
        pooled(now?.minutesToWave, key),
      );
    }
  }

  const keyOf = (check: ProbeCheck): string => `${check.id} ${check.label}`;
  const earlier = new Map(before.checks.map((check) => [keyOf(check), check]));
  const checks: CheckDiff[] = after.checks.map((check) => {
    const was = earlier.get(keyOf(check)) ?? null;
    earlier.delete(keyOf(check));
    return { ...check, before: was, after: check, pass: check.id === 'info' || check.pass };
  });
  for (const check of earlier.values()) {
    checks.push({ ...check, before: check, after: null, pass: check.id === 'info' });
  }

  const identical = JSON.stringify(before) === JSON.stringify(after);
  const pass = metrics.every((m) => m.pass) && checks.every((check) => check.pass);
  return { metrics, checks, identical, pass };
}

const show = (value: number): string =>
  Number.isFinite(value) ? String(Number(value.toFixed(2))) : String(value);
const percent = (change: number): string =>
  Number.isFinite(change) ? `${change > 0 ? '+' : ''}${(100 * change).toFixed(1)}%` : '∞';
const status = (check: ProbeCheck | null): string => {
  if (check === null) return '-';
  if (check.id === 'info') return check.pass ? 'in' : 'out';
  return check.pass ? 'pass' : 'FAIL';
};

export function formatProbeDiff(diff: ProbeDiff, tolerance = DEFAULT_TOLERANCE): string {
  const range = `±${Number((100 * tolerance).toFixed(2))}%`;
  const metrics = formatTable([
    ['metric (pooled median)', 'before', 'after', 'change', 'result'],
    ...diff.metrics.map((m) => [
      m.metric,
      show(m.before),
      show(m.after),
      percent(m.change),
      m.pass ? 'ok' : 'FAIL',
    ]),
  ]);
  const checks = formatTable([
    ['check', 'target', 'before', 'after', 'measured after', 'result'],
    ...diff.checks.map((check) => [
      check.id,
      check.label,
      status(check.before),
      status(check.after),
      check.after?.value ?? '-',
      check.pass ? 'ok' : 'FAIL',
    ]),
  ]);
  const verdict = diff.pass ? 'pass' : 'FAIL';
  return [
    `Frontier and minutes to wave within ${range}`,
    metrics,
    '',
    'Checks (T1–T8 must pass after; info never fails)',
    checks,
    '',
    `Gate: ${verdict}${diff.identical ? ' (no change: every number is identical)' : ''}`,
  ].join('\n');
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: { tolerance: { type: 'string', default: String(DEFAULT_TOLERANCE) } },
  });
  const [beforeFile, afterFile] = positionals;
  if (beforeFile === undefined || afterFile === undefined || positionals.length !== 2) {
    throw new Error('Usage: probeDiff.ts <before.json> <after.json> [--tolerance 0.05]');
  }
  const tolerance = Number(values.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(`--tolerance must be a number >= 0, got '${values.tolerance}'`);
  }
  const read = (file: string): ProbeSummary => probeFromJson(readFileSync(file, 'utf8'));
  const diff = diffProbes(read(beforeFile), read(afterFile), tolerance);
  console.log(`Probe diff: ${beforeFile} → ${afterFile}\n`);
  console.log(formatProbeDiff(diff, tolerance));
  if (!diff.pass) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
