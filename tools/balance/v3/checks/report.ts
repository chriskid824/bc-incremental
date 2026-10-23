/**
 * The checks' report (docs/v3 C10 design §1.4): report.md (the header, the counts, the FAILs
 * first, every check under 檢查 | 對象 | 標準 | 量到 | 結果 in the set's order, the n/a rows by
 * reason with what unlocks each, the files written), the same for the terminal (M1's
 * formatTable), and the machine forms checks.json and checks.csv. Each is a function of the plan,
 * the rows and the header the CLI passes in (design G11), so a test pins it byte for byte.
 */

import { Buffer } from 'node:buffer';
import { toCsv } from '../../csv';
import { formatTable } from '../../report';
import { formatContentRef } from '../content';
import { formatC7Parts } from './c7';
import { PR_TARGET_SECONDS } from './run';
import { NA_REASONS, NA_UNLOCKS } from './types';
import type { CheckPlan, CheckResult } from './types';

/** The step summary's cap in bytes (初始值): under GitHub's 1 MiB a step (design §0.1 G9). */
export const SUMMARY_MAX_BYTES = 900 * 1024;

/** The header fields the CLI reads from the run's environment. */
export interface ReportHeader {
  /** The git ref and commit the checks ran on ('unknown' when unread). */
  readonly ref: string;
  readonly commit: string;
  /** UTC, 'YYYY-MM-DD HH:MM UTC'. */
  readonly date: string;
  readonly wallSeconds: number;
}

/** The UTC date as the header prints it. */
export const formatDate = (date: Date): string =>
  `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export interface StatusCounts {
  readonly FAIL: number;
  /** FAILs accepted, among FAIL. */
  readonly accepted: number;
  readonly pass: number;
  readonly info: number;
  readonly 'n/a': number;
}

export function statusCounts(rows: readonly CheckResult[]): StatusCounts {
  const count = (test: (row: CheckResult) => boolean): number => rows.filter(test).length;
  return {
    FAIL: count((row) => row.status === 'FAIL'),
    accepted: count((row) => row.status === 'FAIL' && row.accepted !== undefined),
    pass: count((row) => row.status === 'pass'),
    info: count((row) => row.status === 'info'),
    'n/a': count((row) => row.status === 'n/a'),
  };
}

const countsLine = (counts: StatusCounts): string =>
  `${counts.FAIL} FAIL` +
  (counts.accepted > 0 ? ` (${counts.accepted} accepted)` : '') +
  ` · ${counts.pass} pass · ${counts.info} info · ${counts['n/a']} n/a`;

/** The 結果 cell: pass, FAIL, FAIL (accepted: <reason>), info, or n/a (<reason>). */
export function resultCell(row: CheckResult): string {
  if (row.status === 'FAIL' && row.accepted !== undefined) {
    return `FAIL (accepted: ${row.accepted})`;
  }
  if (row.status === 'n/a') return `n/a (${row.reason?.id ?? '—'})`;
  return row.status;
}

/** The FAILs, unaccepted ones first, each group in check order. */
export const failsFirst = (rows: readonly CheckResult[]): CheckResult[] => [
  ...rows.filter((row) => row.status === 'FAIL' && row.accepted === undefined),
  ...rows.filter((row) => row.status === 'FAIL' && row.accepted !== undefined),
];

const TABLE_HEAD = ['檢查', '對象', '標準', '量到', '結果'] as const;

const cells = (row: CheckResult): string[] => [
  row.name,
  row.subject,
  row.target,
  row.measured,
  resultCell(row),
];

const wallLine = (plan: CheckPlan, header: ReportHeader): string =>
  `${header.wallSeconds.toFixed(1)} s` +
  (plan.set === 'pr' ? ` (PR_TARGET_SECONDS ${PR_TARGET_SECONDS} s: printed, never gated)` : '');

const setLine = (plan: CheckPlan): string => `${plan.set}${plan.quick ? ' (quick)' : ''}`;

/** The n/a rows grouped by reason, in NA_REASONS order. */
function naGroups(
  rows: readonly CheckResult[],
): { readonly reason: (typeof NA_REASONS)[number]; readonly rows: CheckResult[] }[] {
  return NA_REASONS.map((reason) => ({
    reason,
    rows: rows.filter((row) => row.status === 'n/a' && row.reason?.id === reason),
  })).filter((group) => group.rows.length > 0);
}

const mdCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function mdTable(rows: readonly CheckResult[]): string[] {
  return [
    `| ${TABLE_HEAD.join(' | ')} |`,
    `|${TABLE_HEAD.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${cells(row).map(mdCell).join(' | ')} |`),
  ];
}

/** report.md. `files` are the files the run wrote, in the order written. */
export function reportMarkdown(
  header: ReportHeader,
  plan: CheckPlan,
  rows: readonly CheckResult[],
  files: readonly string[],
): string {
  const fails = failsFirst(rows);
  const lines = [
    `# §4 checks: ${plan.set}`,
    '',
    `- ref: ${header.ref}`,
    `- commit: ${header.commit}`,
    `- content: ${formatContentRef(plan.content)}`,
    `- set: ${setLine(plan)}`,
    `- date: ${header.date}`,
    `- wall time: ${wallLine(plan, header)}`,
    `- C7 parts live: ${formatC7Parts(plan.c7)}`,
    '',
    `**${countsLine(statusCounts(rows))}**`,
    '',
    '## FAIL',
    '',
    ...(fails.length === 0 ? ['None.'] : mdTable(fails)),
    '',
    '## Checks',
    '',
    ...mdTable(rows),
    '',
    '## n/a by reason',
    '',
  ];
  const groups = naGroups(rows);
  if (groups.length === 0) lines.push('None.');
  for (const group of groups) {
    lines.push(`- **${group.reason}** (${group.rows.length}): until ${NA_UNLOCKS[group.reason]}`);
    for (const row of group.rows) {
      lines.push(`  - ${row.name} · ${mdCell(row.subject)}: ${mdCell(row.reason?.detail ?? '')}`);
    }
  }
  lines.push('', '## Files', '', files.join(', '));
  return lines.join('\n') + '\n';
}

/** The terminal's form of report.md. */
export function reportTerminal(
  header: ReportHeader,
  plan: CheckPlan,
  rows: readonly CheckResult[],
  files: readonly string[],
  out: string,
): string {
  const fails = failsFirst(rows);
  const table = (list: readonly CheckResult[]): string =>
    formatTable([[...TABLE_HEAD], ...list.map(cells)]);
  const lines = [
    `§4 checks: ${setLine(plan)} on ${formatContentRef(plan.content)}; ref ${header.ref}, ` +
      `commit ${header.commit}, ${header.date}`,
    `Wall time ${wallLine(plan, header)}`,
    `C7 parts live: ${formatC7Parts(plan.c7)}`,
    countsLine(statusCounts(rows)),
    '',
    fails.length === 0 ? 'FAIL: none' : `FAIL:\n${table(fails)}`,
    '',
    table(rows),
  ];
  const groups = naGroups(rows);
  if (groups.length > 0) lines.push('', 'n/a by reason:');
  for (const group of groups) {
    lines.push(`  ${group.reason} (${group.rows.length}): until ${NA_UNLOCKS[group.reason]}`);
    for (const row of group.rows) {
      lines.push(`    ${row.name} · ${row.subject}: ${row.reason?.detail ?? ''}`);
    }
  }
  lines.push('', `Wrote ${files.join(', ')} to ${out}`);
  return lines.join('\n');
}

/** checks.json: the header, the C7 parts, the counts and every row, in check order. */
export function checksJson(
  header: ReportHeader,
  plan: CheckPlan,
  rows: readonly CheckResult[],
): string {
  const document = {
    version: 1,
    header: {
      ref: header.ref,
      commit: header.commit,
      content: formatContentRef(plan.content),
      set: plan.set,
      quick: plan.quick,
      date: header.date,
      wallSeconds: Number(header.wallSeconds.toFixed(1)),
      c7: plan.c7,
    },
    counts: statusCounts(rows),
    results: rows,
  };
  return JSON.stringify(document, null, 2) + '\n';
}

/** checks.csv's columns: CheckResult's fields in order, the n/a reason split in two. */
export const CHECKS_CSV_COLUMNS = [
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
] as const;

/** checks.csv: one line per row, the evidence joined with '; '. */
export function checksCsv(rows: readonly CheckResult[]): string {
  return toCsv(
    CHECKS_CSV_COLUMNS,
    rows.map((row) => [
      row.id,
      row.set,
      row.name,
      row.source,
      row.subject,
      row.target,
      row.measured,
      row.status,
      row.reason?.id ?? null,
      row.reason?.detail ?? null,
      row.accepted ?? null,
      row.evidence.join('; '),
    ]),
  );
}

/**
 * The step summary: report.md as it is when it fits in `max` bytes; else its lines up to the
 * last one that fits with a note naming the cut, the whole at most `max` bytes.
 */
export function trimSummary(markdown: string, max = SUMMARY_MAX_BYTES): string {
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes <= max) return markdown;
  const note =
    `\n> Cut: report.md is ${bytes} bytes, over SUMMARY_MAX_BYTES (${max}); the run's ` +
    'output directory holds all of it.\n';
  const room = Math.max(0, max - Buffer.byteLength(note, 'utf8'));
  const head = Buffer.from(markdown, 'utf8').subarray(0, room).toString('utf8');
  return head.slice(0, head.lastIndexOf('\n') + 1) + note;
}
