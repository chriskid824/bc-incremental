import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureContent } from '../../../../src/data/web/testing';
import type { CliIo } from '../../cli';
import { deadBoardsCsv, deadNodesCsv } from './boards';
import type { ChecksDeps } from './cli';
import { main, parseChecksOptions, planOutputs, readCommit } from './cli';
import { doublesCsv, fusionsCsv, triplesCsv } from './fusions';
import { keystonesCsv } from './keystones';
import { SUMMARY_MAX_BYTES, trimSummary } from './report';
import { affixesCsv, enemyRowCsv, outerRowCsv } from './rows';
import { checkSet, SET_CHECKS } from './run';
import type { PlanRun } from './run';
import { NO_C7, runRow, sessionResult, sessionResults } from './testing';
import type { CheckPlan, CheckSetId } from './types';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bc-checks-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function capture(): CliIo & { readonly lines: string[] } {
  const lines: string[] = [];
  const push = (message: string): void => void lines.push(message);
  return { lines, log: push, warn: push, error: push };
}

/** The header fields a test fixes: a ref, a commit, a date and a 1.5 s wall time. */
const fixed = (overrides: ChecksDeps = {}): ChecksDeps => {
  let ms = 0;
  return {
    now: () => new Date(Date.UTC(2026, 9, 28, 3, 17)),
    clock: () => (ms += 1500) - 1500,
    commit: () => '0123abc',
    ref: () => 'claude/v3-engine',
    ...overrides,
  };
};

/** The default sessions as one run each, a death at `wave`. */
const deathsAt =
  (wave: number) =>
  (plan: CheckPlan): Promise<PlanRun> =>
    Promise.resolve({
      results: sessionResults(
        plan.characters.flatMap((character) =>
          Array.from({ length: plan.sessions }, (_, session) =>
            sessionResult(character, session, {
              rows: [runRow({ character, session, highestWaveReached: wave, bestWave: wave })],
            }),
          ),
        ),
      ),
      modes: ['in-process'],
    });

const read = (name: string): string => readFileSync(join(root, name), 'utf8');

const OUTPUTS = [
  'budget.csv',
  'center_share.csv',
  'checks.csv',
  'checks.json',
  'curve_check.csv',
  'milestones.csv',
  'report.md',
  'runs.csv',
];

describe('npm run checks', () => {
  it('parses its options; --quick is accepted and the defaults are the CI step', () => {
    const options = parseChecksOptions([]);
    expect(options).toMatchObject({
      content: 'registered',
      out: join('out', 'checks'),
      summary: null,
      quick: false,
    });
    expect(options?.workers).toBeGreaterThanOrEqual(1);
    expect(options?.workers).toBeLessThanOrEqual(4);
    expect(
      parseChecksOptions([
        '--content',
        'fixture',
        '--out',
        'x',
        '--summary',
        's.md',
        '--quick',
        '--workers',
        '3',
      ]),
    ).toStrictEqual({
      content: { fixture: 'B5' },
      out: 'x',
      summary: 's.md',
      quick: true,
      workers: 3,
    });
    expect(parseChecksOptions(['--help'])).toBeNull();
  });

  it('prints its help with exit 0, and exits 2 on a usage error', async () => {
    const help = capture();
    expect(await main(['--help'], help)).toBe(0);
    expect(help.lines[0]).toMatch(/^Usage: npm run checks -- \[options\]/);
    for (const argv of [
      ['--bogus'],
      ['--workers', '0'],
      ['--workers', '1.5'],
      ['--content', 'nope'],
      ['extra'],
    ]) {
      const io = capture();
      expect(await main([...argv, '--out', root], io), argv.join(' ')).toBe(2);
      expect(io.lines.join('\n')).toContain('Usage: npm run checks');
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('exits 0 on registered content before B1, every check n/a and why, its outputs written', async () => {
    const io = capture();
    expect(await main(['--out', root], io, fixed())).toBe(0);
    expect(readdirSync(root).sort()).toEqual(OUTPUTS);
    const report = read('report.md');
    expect(report).toContain('**0 FAIL · 0 pass · 0 info · 6 n/a**');
    expect(report).toContain(
      '- **noCenter** (6): until B1 registers 熔核, the first character with a center',
    );
    expect(report.match(/\| n\/a \(noCenter\) \|$/gm)).toHaveLength(6);
    expect(read('runs.csv').trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(read('checks.json')).header).toMatchObject({
      ref: 'claude/v3-engine',
      commit: '0123abc',
      content: 'registered',
      set: 'pr',
      date: '2026-10-28 03:17 UTC',
      wallSeconds: 1.5,
    });
    expect(io.lines.join('\n')).toContain(`Wrote report.md, checks.json, checks.csv`);
  });

  it('writes the same outputs twice for the same header fields', async () => {
    const first = join(root, 'a');
    const second = join(root, 'b');
    expect(
      await main(
        ['--out', first, '--content', 'fixture:B2'],
        capture(),
        fixed({ run: deathsAt(12) }),
      ),
    ).toBe(1);
    expect(
      await main(
        ['--out', second, '--content', 'fixture:B2'],
        capture(),
        fixed({ run: deathsAt(12) }),
      ),
    ).toBe(1);
    for (const name of OUTPUTS) {
      expect(readFileSync(join(second, name), 'utf8'), name).toBe(
        readFileSync(join(first, name), 'utf8'),
      );
    }
  });

  it('exits 1 on an unaccepted FAIL and 0 once every FAIL is accepted', async () => {
    expect(
      await main(
        ['--out', root, '--content', 'fixture:B2'],
        capture(),
        fixed({ run: deathsAt(12) }),
      ),
    ).toBe(1);
    const results: { id: string; subject: string; status: string }[] = JSON.parse(
      read('checks.json'),
    ).results;
    const fails = results.filter((row) => row.status === 'FAIL');
    expect(fails.map((row) => `${row.id}:${row.subject}`)).toContain('centerShare:fire');
    const accepted = Object.fromEntries(fails.map((row) => [`${row.id}:${row.subject}`, 'test']));
    const io = capture();
    expect(
      await main(
        ['--out', root, '--content', 'fixture:B2'],
        io,
        fixed({ run: deathsAt(12), plan: { accepted } }),
      ),
    ).toBe(0);
    expect(io.lines.join('\n')).toContain(`${fails.length} FAIL (${fails.length} accepted)`);
  });

  it('exits 3 on a crash, with its stack', async () => {
    const io = capture();
    const run = (): Promise<PlanRun> => Promise.reject(new Error('worker died'));
    expect(await main(['--out', root, '--content', 'fixture:B1'], io, fixed({ run }))).toBe(3);
    expect(io.lines.join('\n')).toMatch(/^Error: worker died\n {4}at /m);
  });

  it('appends report.md to --summary, cut at SUMMARY_MAX_BYTES with its note past it', async () => {
    const summary = join(root, 'summary.md');
    writeFileSync(summary, '## an earlier step\n');
    expect(await main(['--out', root, '--summary', summary], capture(), fixed())).toBe(0);
    expect(readFileSync(summary, 'utf8')).toBe(`## an earlier step\n${read('report.md')}`);

    // A ref of 50,000 lines makes report.md longer than the summary may be.
    const ref = Array.from({ length: 50_000 }, (_, i) => `claude/v3-engine-${i}`).join('\n');
    writeFileSync(summary, '');
    expect(
      await main(['--out', root, '--summary', summary], capture(), fixed({ ref: () => ref })),
    ).toBe(0);
    const report = read('report.md');
    expect(Buffer.byteLength(report)).toBeGreaterThan(SUMMARY_MAX_BYTES);
    const cut = readFileSync(summary, 'utf8');
    expect(cut).toBe(trimSummary(report));
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(cut).toMatch(/\n> Cut: report\.md is \d+ bytes, over SUMMARY_MAX_BYTES/);
  });

  it('reads the commit from GITHUB_SHA, else git, else unknown, never failing the run', async () => {
    vi.stubEnv('GITHUB_SHA', 'f00d');
    expect(readCommit()).toBe('f00d');
    vi.stubEnv('GITHUB_SHA', '');
    expect(readCommit()).toMatch(/^([0-9a-f]{40}|unknown)$/);
    vi.stubEnv('PATH', '');
    expect(readCommit()).toBe('unknown');
    vi.stubEnv('GITHUB_HEAD_REF', '');
    vi.stubEnv('GITHUB_REF_NAME', '');
    const deps: ChecksDeps = { now: () => new Date(Date.UTC(2026, 9, 28, 3, 17)) };
    expect(await main(['--out', root], capture(), deps)).toBe(0);
    expect(JSON.parse(read('checks.json')).header).toMatchObject({
      commit: 'unknown',
      ref: 'unknown',
    });
  });

  it('runs the plan on --workers; --quick changes nothing', async () => {
    const seen: number[] = [];
    const run = (plan: CheckPlan, workers: number): Promise<PlanRun> => {
      seen.push(workers);
      return deathsAt(40)(plan);
    };
    await main(
      ['--out', root, '--content', 'fixture:B1', '--workers', '3', '--quick'],
      capture(),
      fixed({ run }),
    );
    expect(seen).toEqual([3]);
    expect(JSON.parse(read('checks.json')).header.quick).toBe(false);
    expect(read('report.md')).toMatch(/^- set: pr$/m);
    expect(existsSync(join(root, 'keystones.csv'))).toBe(false);
  });

  it("writes beside the report C10.2's CSVs, then the CSV of each check the set holds", () => {
    const names = (set: CheckSetId): string[] =>
      planOutputs(
        checkSet(set, fixtureContent('B1'), { fixture: 'B1' }, { sessions: 1, c7: NO_C7 }),
        {},
      ).map(([name]) => name);
    const pr = ['runs.csv', 'milestones.csv', 'curve_check.csv', 'budget.csv', 'center_share.csv'];
    expect(names('pr')).toEqual(pr);
    expect(names('nightly')).toEqual([
      ...pr,
      'keystones.csv',
      'enemy_row.csv',
      'outer_row.csv',
      'affixes.csv',
      'dead_boards.csv',
      'dead_nodes.csv',
      'fusions.csv',
      'doubles.csv',
    ]);
    expect(names('weekly')).toEqual([...names('nightly'), 'triples.csv']);
    // Each file holds its own check's CSV.
    const nightly = checkSet(
      'nightly',
      fixtureContent('B1'),
      { fixture: 'B1' },
      { sessions: 1, c7: NO_C7 },
    );
    expect(planOutputs(nightly, {}).slice(pr.length)).toEqual([
      ['keystones.csv', keystonesCsv(nightly, {})],
      ['enemy_row.csv', enemyRowCsv(nightly, {})],
      ['outer_row.csv', outerRowCsv(nightly, {})],
      ['affixes.csv', affixesCsv(nightly, {})],
      ['dead_boards.csv', deadBoardsCsv(nightly, {})],
      ['dead_nodes.csv', deadNodesCsv(nightly, {})],
      ['fusions.csv', fusionsCsv(nightly, {})],
      ['doubles.csv', doublesCsv(nightly, {})],
    ]);
    const weekly = { ...nightly, set: 'weekly' as const, checks: SET_CHECKS.weekly };
    expect(planOutputs(weekly, {}).at(-1)).toEqual(['triples.csv', triplesCsv(weekly, {})]);
  });
});
