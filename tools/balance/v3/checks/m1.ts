/**
 * The M1 diffs, m1 (docs/v3 C10 design §2.4's m1 row; C3D:1778; lead rulings L4 and U4): the
 * frozen M1 path judged by its own tools. `npm run fingerprint -- --check` must pass (its cases
 * against tools/balance/fingerprint.baseline.txt; ci.yml does not run it), and probe.ts' `--json`
 * with its defaults must pass probeDiff's diffProbes against tools/balance/probe.baseline.json at
 * M1_TOLERANCE; whether the JSON is byte-identical to the baseline is info. Each tool runs as its
 * npm script runs it, `tsx <script>` in the repository's root: a child process of this node
 * (process.execPath) running tsx's CLI. m1 judges the M1 path, which exists before B1, so it is
 * exempt from the noCenter rule (run.ts' evaluate; lead ruling U15).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeFromJson } from '../../probe';
import { DEFAULT_TOLERANCE, diffProbes } from '../../probeDiff';
import type { ProbeDiff } from '../../probeDiff';
import { checkRow, measureResultOf, naRow } from './types';
import type { CheckPlan, CheckResult, PlanUnit, UnitResults } from './types';

export const M1_TOOLS = ['fingerprint', 'probe'] as const;
export type M1Tool = (typeof M1_TOOLS)[number];

/** The probe's reference, beside fingerprint.baseline.txt and bench.baseline.json (lead ruling L4). */
export const PROBE_BASELINE = 'tools/balance/probe.baseline.json';
/**
 * diffProbes' gate (probeDiff.ts' DEFAULT_TOLERANCE, 初始值): every pooled frontier and minutes
 * to a wave within ±5 %, a fraction, as probeDiff reads it.
 */
export const M1_TOLERANCE = DEFAULT_TOLERANCE;
/** The lines of a tool's output a reading keeps, its last. */
const OUTPUT_LINES = 40;

/** The repository's root, where the npm scripts run. */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export interface M1Input {
  readonly tool: M1Tool;
}

export interface M1Reading {
  readonly tool: M1Tool;
  /** The child's exit code; null when a signal ended it. */
  readonly exitCode: number | null;
  /** The last OUTPUT_LINES lines of its stdout, then its stderr. */
  readonly output: string;
  /** The probe's JSON and the baseline's text as read; null for the fingerprint, or when missing. */
  readonly json: string | null;
  readonly baseline: string | null;
}

/** `tsx <args>` as the tool's npm script runs it: probe.ts has no script, so `npx tsx` (L4). */
export function m1Command(tool: M1Tool, json: string): readonly string[] {
  return tool === 'fingerprint'
    ? ['tools/balance/fingerprint.ts', '--check']
    : ['tools/balance/probe.ts', '--json', json];
}

/** Runs `tsx <args>` in `cwd`: its exit code (null when a signal ended it) and its output. */
export type TsxRun = (
  args: readonly string[],
  cwd: string,
) => { readonly status: number | null; readonly output: string };

/** A child process of this node running tsx's CLI, as `npm run <script>` runs `tsx`. */
export const runTsx: TsxRun = (args, cwd) => {
  const cli = createRequire(import.meta.url).resolve('tsx/cli');
  const child = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error !== undefined) throw child.error;
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
};

const tail = (text: string): string => text.trimEnd().split('\n').slice(-OUTPUT_LINES).join('\n');

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * One M1 tool's run: the fingerprint's `--check`, or the probe with its defaults writing its JSON
 * into a directory under `<root>/out/` (not in git), read back with the baseline and removed.
 */
export function measureM1(input: M1Input, run: TsxRun = runTsx, root: string = ROOT): M1Reading {
  if (input.tool === 'fingerprint') {
    const { status, output } = run(m1Command('fingerprint', ''), root);
    return {
      tool: 'fingerprint',
      exitCode: status,
      output: tail(output),
      json: null,
      baseline: null,
    };
  }
  mkdirSync(join(root, 'out'), { recursive: true });
  const dir = mkdtempSync(join(root, 'out', 'm1-probe-'));
  try {
    const file = join(dir, 'probe.json');
    const { status, output } = run(m1Command('probe', file), root);
    return {
      tool: 'probe',
      exitCode: status,
      output: tail(output),
      json: readOrNull(file),
      baseline: readOrNull(join(root, PROBE_BASELINE)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An m1 unit's id: the tool. */
export const m1UnitId = (tool: M1Tool): string => `measure:m1:${tool}`;

/** One unit per tool; they read no session and no content. */
export const m1Units = (): PlanUnit[] =>
  M1_TOOLS.map((tool) => ({
    id: m1UnitId(tool),
    job: { kind: 'measure', measure: 'm1', input: { tool } },
  }));

const percent = (fraction: number): string => `${Number((fraction * 100).toFixed(2))}%`;
const lastLine = (text: string): string => text.split('\n').at(-1) ?? '';

export const M1_STANDARD =
  '`npm run fingerprint -- --check` passes; probe.ts --json (its defaults) passes diffProbes ' +
  `against ${PROBE_BASELINE} at ±${percent(M1_TOLERANCE)}; byte identity info (初始值)`;

function fingerprintRow(plan: CheckPlan, reading: M1Reading | null): CheckResult {
  const target =
    '`npm run fingerprint -- --check` passes: every M1 case as in ' +
    'tools/balance/fingerprint.baseline.txt';
  if (reading === null) {
    return naRow('m1', plan.set, 'fingerprint', target, 'noData', 'the fingerprint was not run');
  }
  const verdict = reading.output
    .split('\n')
    .find((line) => /^fingerprint (matches|differs)/.test(line));
  return checkRow('m1', plan.set, {
    subject: 'fingerprint',
    target,
    measured:
      reading.exitCode === 0 && verdict !== undefined
        ? verdict
        : `exit ${String(reading.exitCode)}: ${verdict ?? lastLine(reading.output)}`,
    status: reading.exitCode === 0 ? 'pass' : 'FAIL',
    evidence: ['tools/balance/fingerprint.baseline.txt'],
  });
}

/** What diffProbes' gate says: the largest change, and the checks and metrics outside it. */
function diffText(diff: ProbeDiff): string {
  const largest = diff.metrics.reduce<ProbeDiff['metrics'][number] | null>(
    (best, metric) =>
      best === null || Math.abs(metric.change) > Math.abs(best.change) ? metric : best,
    null,
  );
  const failing = [
    ...diff.metrics.filter((metric) => !metric.pass).map((metric) => metric.metric),
    ...diff.checks.filter((check) => !check.pass).map((check) => `${check.id} ${check.label}`),
  ];
  return (
    `${diff.metrics.length} metrics, the largest change ` +
    (largest === null ? '—' : `${largest.metric} ${percent(largest.change)}`) +
    (failing.length === 0 ? '; every T check passes' : `; outside: ${failing.join(', ')}`)
  );
}

function probeRows(plan: CheckPlan, reading: M1Reading | null): CheckResult[] {
  const target =
    `probe.ts --json (its defaults) against ${PROBE_BASELINE}: every pooled frontier and ` +
    `minutes to a wave within ±${percent(M1_TOLERANCE)}, every T check passing (初始值)`;
  if (reading === null) {
    return [naRow('m1', plan.set, 'probe', target, 'noData', 'the probe was not run')];
  }
  const evidence = [PROBE_BASELINE];
  const failed = (measured: string): CheckResult[] => [
    checkRow('m1', plan.set, { subject: 'probe', target, measured, status: 'FAIL', evidence }),
  ];
  if (reading.exitCode !== 0 || reading.json === null) {
    return failed(`the probe exited ${String(reading.exitCode)}: ${lastLine(reading.output)}`);
  }
  if (reading.baseline === null) return failed(`no ${PROBE_BASELINE}`);
  const diff = diffProbes(
    probeFromJson(reading.baseline),
    probeFromJson(reading.json),
    M1_TOLERANCE,
  );
  const changed = diff.metrics.filter((metric) => metric.change !== 0).length;
  return [
    checkRow('m1', plan.set, {
      subject: 'probe',
      target,
      measured: diffText(diff),
      status: diff.pass ? 'pass' : 'FAIL',
      evidence,
    }),
    checkRow('m1', plan.set, {
      subject: 'probe bytes',
      target: `the probe's JSON byte-identical to ${PROBE_BASELINE}: info (the M1 path is frozen)`,
      measured:
        reading.json === reading.baseline
          ? 'byte-identical'
          : `differs: ${changed} of ${diff.metrics.length} metrics changed`,
      status: 'info',
      evidence,
    }),
  ];
}

/** The m1 rows: the fingerprint, the probe's diff, and the probe's byte identity. */
export function m1Check(plan: CheckPlan, results: UnitResults): CheckResult[] {
  return [
    fingerprintRow(plan, measureResultOf(results, m1UnitId('fingerprint'), 'm1')),
    ...probeRows(plan, measureResultOf(results, m1UnitId('probe'), 'm1')),
  ];
}
