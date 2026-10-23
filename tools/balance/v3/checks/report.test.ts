import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { fixtureContent } from '../../../../src/data/web/testing';
import {
  CHECKS_CSV_COLUMNS,
  checksCsv,
  checksJson,
  formatDate,
  reportMarkdown,
  reportTerminal,
  statusCounts,
  SUMMARY_MAX_BYTES,
  trimSummary,
} from './report';
import type { ReportHeader } from './report';
import { checkSet } from './run';
import { NO_C7 } from './testing';
import { checkRow, naRow } from './types';
import type { CheckResult } from './types';

const plan = checkSet(
  'pr',
  fixtureContent('B1'),
  { fixture: 'B1' },
  { c7: { ...NO_C7, 'C7.5': true } },
);
const header: ReportHeader = {
  ref: 'claude/v3-engine',
  commit: '0123abc',
  date: '2026-10-28 03:17 UTC',
  wallSeconds: 41.26,
};
const files = ['report.md', 'checks.json', 'checks.csv', 'runs.csv'];

/** Rows in check order: a pass, an accepted FAIL, three n/a, an unaccepted FAIL and an info. */
const rows: CheckResult[] = [
  checkRow('pacing', 'pr', {
    subject: 'fire @ 10 min',
    target: 'bestWave 15 ±15% (初始值)',
    measured: 'median 15 over 4 sessions',
    status: 'pass',
    evidence: ['curve_check.csv: fire default 10'],
  }),
  checkRow('pacing', 'pr', {
    subject: 'fire @ 20 min',
    target: 'bestWave 22 ±15% (初始值)',
    measured: 'median 17 over 4 sessions',
    status: 'FAIL',
    accepted: 'B1 tuning, 10/28',
    evidence: ['curve_check.csv: fire default 20'],
  }),
  naRow(
    'pacing',
    'pr',
    'fire @ 60 min',
    'bestWave 40 ±15% (初始值)',
    'noPrestige',
    'stops at wave 30',
  ),
  naRow(
    'newbie',
    'pr',
    'all @ 10 min',
    'max |front − median| ÷ median ≤ 0.1 (初始值)',
    'oneCharacter',
    'one character has a center',
    'fronts fire 15',
  ),
  naRow(
    'fusionStrength',
    'pr',
    'fire.lightning',
    'every seed in [1.1, 1.3]',
    'uncalibrated',
    'no entry',
  ),
  checkRow('centerShare', 'pr', {
    subject: 'fire',
    target: 'median ≥ 0.5 (初始值)',
    measured: 'median 40 % (asc 0 % of all) over 4 sessions',
    status: 'FAIL',
    evidence: ['center_share.csv: fire'],
  }),
  checkRow('fuzz', 'pr', {
    subject: 'all',
    target: "ci.yml's `npm run fuzz:web` passes",
    measured: 'not run here',
    status: 'info',
    evidence: ['ci.yml: npm run fuzz:web'],
  }),
];

const TABLE = ['| 檢查 | 對象 | 標準 | 量到 | 結果 |', '|---|---|---|---|---|'];
const CENTER =
  '| 中心主體性 | fire | median ≥ 0.5 (初始值) | median 40 % (asc 0 % of all) over 4 sessions | FAIL |';
const ACCEPTED =
  '| 前線節奏 | fire @ 20 min | bestWave 22 ±15% (初始值) | median 17 over 4 sessions | FAIL (accepted: B1 tuning, 10/28) |';

describe('the checks report', () => {
  it('writes report.md: the header, the counts, the FAILs first, every row, n/a by reason, the files', () => {
    expect(reportMarkdown(header, plan, rows, files)).toBe(
      [
        '# §4 checks: pr',
        '',
        '- ref: claude/v3-engine',
        '- commit: 0123abc',
        '- content: fixture:B1',
        '- set: pr',
        '- date: 2026-10-28 03:17 UTC',
        '- wall time: 41.3 s (PR_TARGET_SECONDS 90 s: printed, never gated)',
        '- C7 parts live: live: C7.5 (enemyCapDelayed, enemySpawnsSkipped); pending: C7.3 (defence), ' +
          'C7.4a (state), C7.4b (bulletTakenBy), C7.6 (affixes), C7.7 (layersLeft)',
        '',
        '**2 FAIL (1 accepted) · 1 pass · 1 info · 3 n/a**',
        '',
        '## FAIL',
        '',
        ...TABLE,
        CENTER,
        ACCEPTED,
        '',
        '## Checks',
        '',
        ...TABLE,
        '| 前線節奏 | fire @ 10 min | bestWave 15 ±15% (初始值) | median 15 over 4 sessions | pass |',
        ACCEPTED,
        '| 前線節奏 | fire @ 60 min | bestWave 40 ±15% (初始值) | — | n/a (noPrestige) |',
        '| 新手公平 | all @ 10 min | max \\|front − median\\| ÷ median ≤ 0.1 (初始值) | fronts fire 15 | n/a (oneCharacter) |',
        '| 融合強度 | fire.lightning | every seed in [1.1, 1.3] | — | n/a (uncalibrated) |',
        CENTER,
        "| 模糊測試 | all | ci.yml's `npm run fuzz:web` passes | not run here | info |",
        '',
        '## n/a by reason',
        '',
        '- **oneCharacter** (1): until B2 registers 蜂巢, the second character',
        '  - 新手公平 · all @ 10 min: one character has a center',
        '- **noPrestige** (1): until B2 writes the prestige (PRESTIGE, tools/balance/v3/prestige.ts)',
        '  - 前線節奏 · fire @ 60 min: stops at wave 30',
        "- **uncalibrated** (1): until npm run calibrate writes the fusion's entry",
        '  - 融合強度 · fire.lightning: no entry',
        '',
        '## Files',
        '',
        'report.md, checks.json, checks.csv, runs.csv',
        '',
      ].join('\n'),
    );
  });

  it('says so when nothing FAILs or is n/a', () => {
    const markdown = reportMarkdown(header, plan, [rows[0] as CheckResult], files);
    expect(markdown).toContain('## FAIL\n\nNone.\n');
    expect(markdown).toContain('## n/a by reason\n\nNone.\n');
    expect(statusCounts(rows)).toEqual({ FAIL: 2, accepted: 1, pass: 1, info: 1, 'n/a': 3 });
  });

  it('prints the same to the terminal, the FAILs first', () => {
    const text = reportTerminal(header, plan, rows, files, 'out/checks');
    const lines = text.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      '§4 checks: pr on fixture:B1; ref claude/v3-engine, commit 0123abc, 2026-10-28 03:17 UTC',
      'Wall time 41.3 s (PR_TARGET_SECONDS 90 s: printed, never gated)',
      expect.stringMatching(/^C7 parts live: live: C7\.5/),
      '2 FAIL (1 accepted) · 1 pass · 1 info · 3 n/a',
    ]);
    expect(lines.slice(4, 7)).toEqual([
      '',
      'FAIL:',
      expect.stringMatching(/^檢查 +對象 +標準 +量到 +結果$/),
    ]);
    expect(lines[7]).toMatch(/^中心主體性 +fire /);
    expect(lines[8]).toMatch(/^前線節奏 +fire @ 20 min .*FAIL \(accepted: B1 tuning, 10\/28\)$/);
    expect(text).toContain('  noPrestige (1): until B2 writes the prestige');
    expect(lines.at(-1)).toBe('Wrote report.md, checks.json, checks.csv, runs.csv to out/checks');
  });

  it('lists the FAILs in check order, the unaccepted ones before the accepted ones', () => {
    const fail = (id: CheckResult['id'], subject: string, accepted?: string): CheckResult =>
      checkRow(id, 'pr', {
        subject,
        target: 't',
        measured: 'm',
        status: 'FAIL',
        evidence: [],
        ...(accepted === undefined ? {} : { accepted }),
      });
    // Check order is neither subject order nor its reverse: newbie's 'all …' sorts first.
    const fails = [
      fail('pacing', 'fire @ 10 min'),
      fail('pacing', 'fire @ 20 min', 'B1 tuning'),
      fail('newbie', 'all @ 10 min'),
      fail('centerShare', 'fire', 'B1 tuning'),
      fail('centerShare', 'summon'),
    ];
    const order = ['fire @ 10 min', 'all @ 10 min', 'summon', 'fire @ 20 min', 'fire'];
    const section = reportMarkdown(header, plan, fails, files).split('\n## Checks')[0] ?? '';
    expect(
      [...section.matchAll(/^\| [^|]+ \| ([^|]+) \| t \|/gm)].map((m) => m[1]?.trim()),
    ).toEqual(order);
    const terminal = reportTerminal(header, plan, fails, files, 'out/checks').split('\n');
    const first = terminal.indexOf('FAIL:') + 2;
    expect(
      terminal.slice(first, first + order.length).map((line) => line.split(/ {2,}/)[1]),
    ).toEqual(order);
  });

  it("writes checks.csv's columns in CheckResult's order", () => {
    expect(CHECKS_CSV_COLUMNS).toEqual([
      'id',
      'set',
      'name',
      'source',
      'subject',
      'target',
      'measured',
      'status',
      'reason',
      'detail',
      'accepted',
      'evidence',
    ]);
    const csv = checksCsv(rows).split('\n');
    const [head, accepted, na] = [csv[0], csv[2], csv[3]];
    expect(head).toBe(CHECKS_CSV_COLUMNS.join(','));
    expect(accepted).toBe(
      'pacing,pr,前線節奏,impl:474; GDD:208-219,fire @ 20 min,bestWave 22 ±15% (初始值),' +
        'median 17 over 4 sessions,FAIL,,,"B1 tuning, 10/28",curve_check.csv: fire default 20',
    );
    expect(na).toBe(
      'pacing,pr,前線節奏,impl:474; GDD:208-219,fire @ 60 min,bestWave 40 ±15% (初始值),—,n/a,' +
        'noPrestige,stops at wave 30,,',
    );
  });

  it('writes checks.json: the header, the C7 parts, the counts and the rows', () => {
    const json = checksJson(header, plan, rows);
    expect(JSON.parse(json)).toEqual({
      version: 1,
      header: {
        ref: 'claude/v3-engine',
        commit: '0123abc',
        content: 'fixture:B1',
        set: 'pr',
        quick: false,
        date: '2026-10-28 03:17 UTC',
        wallSeconds: 41.3,
        c7: { ...NO_C7, 'C7.5': true },
      },
      counts: { FAIL: 2, accepted: 1, pass: 1, info: 1, 'n/a': 3 },
      results: rows,
    });
    expect(checksJson(header, plan, rows)).toBe(json);
    expect(json.endsWith('}\n')).toBe(true);
  });

  it('prints the date in UTC to the minute', () => {
    expect(formatDate(new Date(Date.UTC(2026, 9, 28, 3, 17, 59)))).toBe('2026-10-28 03:17 UTC');
  });

  it('cuts the step summary at a line to SUMMARY_MAX_BYTES with a note, and leaves a short one', () => {
    expect(trimSummary('# short\n')).toBe('# short\n');
    // Three bytes a character: a cut by characters would be three times too long.
    const line = `| 前線節奏 | ${'中'.repeat(200)} |\n`;
    const long = line.repeat(Math.ceil((SUMMARY_MAX_BYTES * 1.5) / Buffer.byteLength(line)));
    const cut = trimSummary(long);
    const bytes = Buffer.byteLength(cut);
    expect(bytes).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(bytes).toBeGreaterThan(SUMMARY_MAX_BYTES - Buffer.byteLength(line) - 200);
    expect(cut).toMatch(
      new RegExp(
        `\\|\\n\\n> Cut: report\\.md is ${Buffer.byteLength(long)} bytes, over SUMMARY_MAX_BYTES ` +
          `\\(${SUMMARY_MAX_BYTES}\\); the run's output directory holds all of it\\.\\n$`,
      ),
    );
    expect(long.startsWith(cut.slice(0, cut.indexOf('\n> Cut')))).toBe(true);
    expect(cut).not.toContain('�');
    expect(SUMMARY_MAX_BYTES).toBe(900 * 1024);
  });
});
