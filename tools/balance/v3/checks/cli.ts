/**
 * The PR subset of implementation-plan-v3 §4's checks (docs/v3 C10 design §1.5; docs/ARCHITECTURE.md
 * §12):
 *
 *   npm run checks
 *   npm run checks -- --content fixture --summary "$GITHUB_STEP_SUMMARY"
 *
 * Plays the pr set's plan (run.ts) on the balance pool, evaluates it and writes report.md,
 * checks.json, checks.csv and the sessions' CSVs to --out; prints the report. Exits 0 without an
 * unaccepted FAIL, 1 with one, 2 for a usage error and 3 for a crash. The nightly and weekly sets
 * are C10.4's (`npm run nightly`).
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { CliIo } from '../../cli';
import { parseContentRef, resolveContent } from '../content';
import type { ContentRef } from '../content';
import {
  budgetCsv,
  characterCurveCheckCsv,
  characterMilestonesCsv,
  characterRunsCsv,
} from '../report';
import { deadBoardsCsv, deadNodesCsv } from './boards';
import { keystonesCsv } from './keystones';
import {
  checksCsv,
  checksJson,
  formatDate,
  reportMarkdown,
  reportTerminal,
  SUMMARY_MAX_BYTES,
  trimSummary,
} from './report';
import type { ReportHeader } from './report';
import { checkSet, evaluate, exitCodeOf, PR_SESSIONS, PR_TARGET_SECONDS, runPlan } from './run';
import type { CheckSetOptions, PlanRun } from './run';
import { affixesCsv, enemyRowCsv, outerRowCsv } from './rows';
import { centerShareCsv } from './sessions';
import { defaultSessions } from './types';
import type { CheckId, CheckPlan, UnitResults } from './types';

const HELP = `Usage: npm run checks -- [options]

The pr set of implementation-plan-v3 §4's checks: the built characters' default sessions
(${PR_SESSIONS} each: pacing, newbie fairness, the center share), the strength of the first hand
and template fusions with calibration entries, and ci.yml's fuzz and performance steps.

  --content <c>     registered | fixture | fixture:<B1..B5> (default registered)
  --out <dir>       output directory (default out/checks)
  --summary <file>  append report.md, cut to ${SUMMARY_MAX_BYTES} bytes ($GITHUB_STEP_SUMMARY in CI)
  --quick           the nightly's flag; the pr set always plays ${PR_SESSIONS} sessions a character
  --workers <k>     worker threads (default min(4, CPUs))
  --help            show this help

Exit codes: 0 no unaccepted FAIL (n/a and info never fail), 1 an unaccepted FAIL, 2 usage,
3 a crash. The wall time is printed against ${PR_TARGET_SECONDS} s, never gated.`;

export interface ChecksOptions {
  readonly content: ContentRef;
  readonly out: string;
  readonly summary: string | null;
  readonly quick: boolean;
  readonly workers: number;
}

/** Parses the arguments; null for --help. Throws on invalid input. */
export function parseChecksOptions(argv: readonly string[]): ChecksOptions | null {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      content: { type: 'string', default: 'registered' },
      out: { type: 'string', default: join('out', 'checks') },
      summary: { type: 'string' },
      quick: { type: 'boolean', default: false },
      workers: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return null;
  let workers = Math.max(1, Math.min(4, availableParallelism()));
  if (values.workers !== undefined) {
    workers = Number(values.workers);
    if (values.workers.trim() === '' || !Number.isInteger(workers) || workers < 1) {
      throw new Error(`--workers must be an integer >= 1, got '${values.workers}'`);
    }
  }
  return {
    content: parseContentRef(values.content),
    out: values.out,
    summary: values.summary ?? null,
    quick: values.quick,
    workers,
  };
}

/** process.env's value, or a git command's output, or 'unknown'; never throws. */
function fromGit(env: string | undefined, args: readonly string[]): string {
  if (env !== undefined && env !== '') return env;
  try {
    const out = execFileSync('git', [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? 'unknown' : out;
  } catch {
    return 'unknown';
  }
}

/** GITHUB_SHA, else `git rev-parse HEAD`, else 'unknown' (design G11). */
export const readCommit = (): string => fromGit(process.env.GITHUB_SHA, ['rev-parse', 'HEAD']);

/** The PR's branch, the pushed ref, else `git rev-parse --abbrev-ref HEAD`, else 'unknown'. */
export const readRef = (): string =>
  fromGit(process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME, [
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);

/** What main reads from the world; tests pass their own. */
export interface ChecksDeps {
  /** The plan's options in place of checkSet's defaults. */
  readonly plan?: CheckSetOptions;
  readonly run?: (
    plan: CheckPlan,
    workers: number,
    log: (message: string) => void,
  ) => Promise<PlanRun>;
  readonly now?: () => Date;
  /** Milliseconds, for the wall time. */
  readonly clock?: () => number;
  readonly commit?: () => string;
  readonly ref?: () => string;
}

/** The CSVs a check of the set writes beside report.md, when the set holds it (design §1.4). */
const CHECK_CSVS: readonly (readonly [
  CheckId,
  string,
  (plan: CheckPlan, results: UnitResults) => string,
])[] = [
  ['keystones', 'keystones.csv', keystonesCsv],
  ['enemyRow', 'enemy_row.csv', enemyRowCsv],
  ['outerRow', 'outer_row.csv', outerRowCsv],
  ['affixes', 'affixes.csv', affixesCsv],
  ['deadBoards', 'dead_boards.csv', deadBoardsCsv],
  ['deadNodes', 'dead_nodes.csv', deadNodesCsv],
];

/**
 * The files beside report.md, checks.json and checks.csv, by name: the default sessions' runs,
 * milestones, curve check and budget, the center share, then each CHECK_CSVS file whose check the
 * set holds.
 */
export function planOutputs(plan: CheckPlan, results: UnitResults): [string, string][] {
  const sessions = plan.characters.flatMap((character) =>
    defaultSessions(plan, results, character),
  );
  return [
    ['runs.csv', characterRunsCsv(sessions)],
    ['milestones.csv', characterMilestonesCsv(sessions)],
    ['curve_check.csv', characterCurveCheckCsv(sessions)],
    ['budget.csv', budgetCsv(sessions)],
    ['center_share.csv', centerShareCsv(plan, results)],
    ...CHECK_CSVS.filter(([id]) => plan.checks.includes(id)).map(
      ([, name, csv]): [string, string] => [name, csv(plan, results)],
    ),
  ];
}

const CONSOLE: CliIo = {
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** The CLI: parses `argv`, runs the pr set, writes the outputs; resolves to the exit code. */
export async function main(
  argv: readonly string[],
  io: CliIo = CONSOLE,
  deps: ChecksDeps = {},
): Promise<number> {
  let options: ChecksOptions | null;
  try {
    options = parseChecksOptions(argv);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error(`\n${HELP}`);
    return 2;
  }
  if (options === null) {
    io.log(HELP);
    return 0;
  }
  try {
    const clock = deps.clock ?? (() => performance.now());
    const started = clock();
    const plan = checkSet('pr', resolveContent(options.content), options.content, {
      ...deps.plan,
    });
    const run = deps.run ?? ((p, workers, log) => runPlan(p, workers, log));
    const { results } = await run(plan, options.workers, (message) => io.warn(message));
    const rows = evaluate(plan, results);
    const header: ReportHeader = {
      ref: (deps.ref ?? readRef)(),
      commit: (deps.commit ?? readCommit)(),
      date: formatDate((deps.now ?? (() => new Date()))()),
      wallSeconds: (clock() - started) / 1000,
    };

    const outputs = planOutputs(plan, results);
    const files = ['report.md', 'checks.json', 'checks.csv', ...outputs.map(([name]) => name)];
    const markdown = reportMarkdown(header, plan, rows, files);
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, 'report.md'), markdown);
    writeFileSync(join(options.out, 'checks.json'), checksJson(header, plan, rows));
    writeFileSync(join(options.out, 'checks.csv'), checksCsv(rows));
    for (const [name, text] of outputs) writeFileSync(join(options.out, name), text);
    if (options.summary !== null) appendFileSync(options.summary, trimSummary(markdown));
    io.log(reportTerminal(header, plan, rows, files, options.out));
    return exitCodeOf(rows);
  } catch (error) {
    io.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 3;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 3;
    },
  );
}
