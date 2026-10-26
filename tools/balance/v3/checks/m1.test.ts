import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobResult } from '../../jobs';
import { DEFAULT_TOLERANCE } from '../../probeDiff';
import { resolveContent } from '../content';
import {
  M1_TOLERANCE,
  m1Check,
  m1Command,
  m1UnitId,
  m1Units,
  measureM1,
  PROBE_BASELINE,
  runTsx,
} from './m1';
import type { TsxRun } from './m1';
import { checkSet, evaluate, exitCodeOf } from './run';
import { NO_C7 } from './testing';
import type { CheckResult, UnitResults } from './types';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const BASELINE = readFileSync(join(REPO, PROBE_BASELINE), 'utf8');
const MATCHES = 'fingerprint matches tools/balance/fingerprint.baseline.txt: 1032 cases';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bc-m1-'));
  mkdirSync(join(root, 'tools', 'balance'), { recursive: true });
  writeFileSync(join(root, PROBE_BASELINE), BASELINE);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The baseline with crit-greedy's pooled F@10 times `factor`. */
function scaled(factor: number): string {
  const json = JSON.parse(BASELINE) as {
    strategies: Record<string, { frontier: Record<string, { pooled: number }> }>;
  };
  const f10 = json.strategies['crit-greedy']?.frontier['F@10'] as { pooled: number };
  f10.pooled *= factor;
  return `${JSON.stringify(json, null, 2)}\n`;
}

/**
 * A tsx that records its calls: the probe writes `json` to its --json file (none crashes it); the
 * fingerprint prints MATCHES, or that it differs.
 */
function stubTsx(json: string | null, status = 0) {
  const calls: (readonly [readonly string[], string])[] = [];
  const run: TsxRun = (args, cwd) => {
    calls.push([args, cwd]);
    if (args[0] === 'tools/balance/probe.ts') {
      if (json === null) return { status, output: 'Error: the probe crashed' };
      writeFileSync(args[2] as string, json);
      return { status, output: `wrote ${args[2] as string}` };
    }
    return { status, output: status === 0 ? MATCHES : 'fingerprint differs from x on 2 lines:' };
  };
  return { calls, run };
}

/** The m1 units' results: each tool as measureM1 reads it through `run`. */
const m1Results = (run: TsxRun): UnitResults =>
  Object.fromEntries(
    (['fingerprint', 'probe'] as const).map((tool): [string, JobResult] => [
      m1UnitId(tool),
      { kind: 'measure', measure: 'm1', result: measureM1({ tool }, run, root) },
    ]),
  );

const plan = checkSet('nightly', resolveContent('registered'), 'registered', { c7: NO_C7 });
const m1Rows = (results: UnitResults): CheckResult[] => m1Check(plan, results);
const probeRow = (json: string): CheckResult =>
  m1Rows(m1Results(stubTsx(json).run)).find((row) => row.subject === 'probe') as CheckResult;

describe('m1 (the M1 diffs)', () => {
  it('runs each tool as its npm script runs it, in the root, the probe into out/ and back', () => {
    const scripts = (
      JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts.fingerprint).toBe(`tsx ${m1Command('fingerprint', '')[0] as string}`);
    expect(m1Command('fingerprint', '')).toEqual(['tools/balance/fingerprint.ts', '--check']);
    expect(m1Command('probe', 'p.json')).toEqual(['tools/balance/probe.ts', '--json', 'p.json']);
    const { calls, run } = stubTsx(BASELINE);
    const probe = measureM1({ tool: 'probe' }, run, root);
    expect(probe).toEqual({
      tool: 'probe',
      exitCode: 0,
      output: expect.stringMatching(/^wrote .*m1-probe-.*probe\.json$/) as string,
      json: BASELINE,
      baseline: BASELINE,
    });
    expect(measureM1({ tool: 'fingerprint' }, run, root)).toEqual({
      tool: 'fingerprint',
      exitCode: 0,
      output: MATCHES,
      json: null,
      baseline: null,
    });
    expect(calls.map(([args, cwd]) => [args[0], cwd])).toEqual([
      ['tools/balance/probe.ts', root],
      ['tools/balance/fingerprint.ts', root],
    ]);
    // The probe's directory under out/ is gone once read.
    expect(readdirSync(join(root, 'out'))).toEqual([]);
  });

  it('runs tsx as a child of this node, reading its exit code and its output', () => {
    writeFileSync(
      join(root, 'exit.ts'),
      "const n: number = 3;\nconsole.log('ran');\nprocess.exitCode = n;\n",
    );
    expect(runTsx(['exit.ts'], root)).toEqual({ status: 3, output: 'ran\n' });
  }, 60_000);

  it('FAILs a probe 6 % off the baseline and passes one 4 % off, the gate a fraction (OWN 9)', () => {
    expect(M1_TOLERANCE).toBe(DEFAULT_TOLERANCE);
    expect(M1_TOLERANCE).toBe(0.05);
    expect(probeRow(scaled(1.06))).toMatchObject({
      status: 'FAIL',
      measured: '18 metrics, the largest change crit-greedy F@10 6%; outside: crit-greedy F@10',
    });
    expect(probeRow(scaled(0.94)).status).toBe('FAIL');
    expect(probeRow(scaled(1.04))).toMatchObject({
      status: 'pass',
      measured: '18 metrics, the largest change crit-greedy F@10 4%; every T check passes',
    });
    expect(probeRow(BASELINE)).toMatchObject({
      status: 'pass',
      target: expect.stringContaining('within ±5%') as string,
      measured: '18 metrics, the largest change crit-greedy F@10 0%; every T check passes',
    });
  });

  it("reports the probe's byte identity as info, and FAILs a probe that did not run", () => {
    const bytes = (json: string): CheckResult =>
      m1Rows(m1Results(stubTsx(json).run)).find(
        (row) => row.subject === 'probe bytes',
      ) as CheckResult;
    expect(bytes(BASELINE)).toMatchObject({ status: 'info', measured: 'byte-identical' });
    expect(bytes(scaled(1.04))).toMatchObject({
      status: 'info',
      measured: 'differs: 1 of 18 metrics changed',
    });
    // Same numbers, other bytes: info says so; the gate passes.
    const reformatted = `${JSON.stringify(JSON.parse(BASELINE))}\n`;
    expect(bytes(reformatted).measured).toBe('differs: 0 of 18 metrics changed');
    expect(probeRow(reformatted).status).toBe('pass');
    const crashed = m1Rows(m1Results(stubTsx(null, 1).run));
    expect(crashed.find((row) => row.subject === 'probe')).toMatchObject({
      status: 'FAIL',
      measured: 'the probe exited 1: Error: the probe crashed',
    });
    rmSync(join(root, PROBE_BASELINE));
    expect(probeRow(BASELINE)).toMatchObject({
      status: 'FAIL',
      measured: `no ${PROBE_BASELINE}`,
    });
  });

  it("passes the fingerprint on its --check's exit 0, FAILs it on any other", () => {
    const fingerprint = (status: number): CheckResult =>
      m1Rows(m1Results(stubTsx(BASELINE, status).run))[0] as CheckResult;
    expect(fingerprint(0)).toMatchObject({
      subject: 'fingerprint',
      status: 'pass',
      measured: MATCHES,
    });
    expect(fingerprint(1)).toMatchObject({
      subject: 'fingerprint',
      status: 'FAIL',
      measured: 'exit 1: fingerprint differs from x on 2 lines:',
    });
    expect(m1Rows({}).map((row) => [row.subject, row.status, row.reason?.id])).toEqual([
      ['fingerprint', 'n/a', 'noData'],
      ['probe', 'n/a', 'noData'],
    ]);
  });

  it('reports pass or FAIL on the registered content before B1, exempt from noCenter (lead ruling U15)', () => {
    expect(plan.characters).toEqual([]);
    expect(plan.units).toEqual(m1Units());
    expect(plan.units.map((unit) => unit.id)).toEqual([m1UnitId('fingerprint'), m1UnitId('probe')]);
    const rows = evaluate(plan, m1Results(stubTsx(BASELINE).run));
    expect(rows.filter((row) => row.id === 'm1').map((row) => [row.subject, row.status])).toEqual([
      ['fingerprint', 'pass'],
      ['probe', 'pass'],
      ['probe bytes', 'info'],
    ]);
    // Every other check, the fuzz with no web to fuzz among them, waits for B1's center.
    const others = rows.filter((row) => row.id !== 'm1');
    expect(others.length).toBeGreaterThan(0);
    expect(others.filter((row) => row.reason?.id !== 'noCenter')).toEqual([]);
    expect(others.map((row) => row.id)).toContain('fuzz');
    expect(exitCodeOf(rows)).toBe(0);
    const failed = evaluate(plan, m1Results(stubTsx(scaled(1.06)).run));
    expect(failed.find((row) => row.subject === 'probe')?.status).toBe('FAIL');
    expect(exitCodeOf(failed)).toBe(1);
  });
});
