/**
 * The web fuzz at CI's length (docs/v3 C6 design D25, §4.9, §4.11; B-1, S-1, P2, P3; the lead's
 * ruling R2): runWebFuzz in-process on 1,000 builds of the registered webs, then on 100 builds of
 * fixtureContent(), a second call, so the harness and the engine paths the fixture's builds reach
 * run before any real content (no fixture build reaches a third fusion core). Before B1 the
 * registered content has no web, and the fixture's builds run alone (F57). Each run lasts 3,600
 * ticks (60 s) or to the build's death under §4.9's checks.
 *
 * Per set it prints the runs, ticks and wall time, the runs stopped early, the failures by kind,
 * the peaks and where they were, the work done, the time against an in-process run of the bench's
 * normal scenario (tools/balance/bench.ts, timed first: its warm-up runs, then its runs; the only
 * reading of a character run's cost before C10, P2), a line per build with its µs a tick and its
 * ratio to normal's, the ten slowest builds, the fixed cases, the warnings, and each failure with
 * its repro line and the build's owned ids. Any failure exits non-zero. Writes nothing.
 *
 *   npm run fuzz:web -- [--fixture] [--builds N] [--ticks 3600] [--seed 1029] [--only <build>]
 *
 * --fixture runs the fixture's builds alone; --builds, --ticks and --seed override each set's for
 * a local run. --only reruns one build of the registered webs (or a fixed case by name), or with
 * --fixture one of the fixture's, exactly as the full run draws it: a failure's repro line.
 */

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGameData } from '../../src/data';
import type { GameData } from '../../src/data/types';
import { loadContent } from '../../src/data/web';
import type { Content } from '../../src/data/web';
import { fixtureContent } from '../../src/data/web/testing';
import {
  ALIVE_WARNING,
  BUDGET_STREAK_LIMIT,
  FIXED_WEB_CASES,
  fuzzWebs,
  HASH_EVERY,
  runWebFuzz,
  WEB_FUZZ_BUILDS,
  WEB_FUZZ_FIXTURE_BUILDS,
  WEB_FUZZ_SEED,
  WEB_FUZZ_TICKS,
} from '../../src/meta/web/fuzz';
import type {
  WebFuzzBuild,
  WebFuzzCase,
  WebFuzzFailure,
  WebFuzzPeaks,
  WebFuzzReport,
} from '../../src/meta/web/fuzz';
import { CHAIN_HIT_CAP, PROJECTILE_CAP, SUMMON_CAP } from '../../src/sim/caps';
import { createSimulation } from '../../src/sim/simulation';
import { NO_INPUT, TICK_RATE } from '../../src/sim/types';
import { SCENARIOS } from '../balance/bench';
import { median } from '../balance/benchCheck';
import { formatTable } from '../balance/report';

/** The start wave bench.ts times normal from (its DEFAULT_START_WAVE). */
const NORMAL_START_WAVE = 30;
/** Failures and warnings printed in full; the rest are counted. */
const SHOWN = 20;
const SLOWEST = 10;

/**
 * normal's µs a tick in-process (P2): bench.ts' warm-up runs, then the median of its runs, each
 * timed from createSimulation to its last tick as bench.ts times them.
 */
export function normalMicrosPerTick(data: GameData): number {
  const normal = SCENARIOS.normal;
  const micros = (seed: number): number => {
    const started = performance.now();
    const sim = createSimulation(normal.config(seed, NORMAL_START_WAVE, ''), data, []);
    while (!sim.state.finished) sim.step(NO_INPUT);
    return ((performance.now() - started) * 1000) / sim.result().ticks;
  };
  for (let i = 0; i < normal.warmup; i++) micros(1 + normal.runs + i);
  return median(Array.from({ length: normal.runs }, (_, i) => micros(1 + i)));
}

/** A build's µs a tick over its runs; null without a time or a tick. */
const microsOf = (build: WebFuzzBuild): number | null =>
  build.time === null || build.ticks === 0 ? null : (build.time * 1000) / build.ticks;

const fixed = (value: number | null, digits = 1): string =>
  value === null ? '-' : value.toFixed(digits);
const yes = (value: boolean): string => (value ? 'yes' : '-');
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/** The build with the largest `pick`, the first of equals; null for none. */
function largest(
  builds: readonly WebFuzzBuild[],
  pick: (build: WebFuzzBuild) => number,
): WebFuzzBuild | null {
  let best: WebFuzzBuild | null = null;
  for (const build of builds) if (best === null || pick(build) > pick(best)) best = build;
  return best;
}

const sumOf = (builds: readonly WebFuzzBuild[], pick: (build: WebFuzzBuild) => number): number =>
  builds.reduce((sum, build) => sum + pick(build), 0);

/** A build's line of the report: its draw, what its runs did, and its time against normal's. */
export function buildRow(build: WebFuzzBuild, normalMicros: number): string[] {
  const micros = microsOf(build);
  const { peaks } = build;
  return [
    build.name,
    String(build.purchases),
    String(build.ranks),
    yes(build.account.singularityBeaten),
    String(build.bestWave),
    yes(build.prestiged),
    yes(build.coefs !== null),
    String(build.startWave),
    String(build.runs),
    String(build.ticks),
    String(build.highestWaveCleared),
    String(peaks.alive),
    String(peaks.summons),
    String(peaks.inFlight),
    String(peaks.chainHits),
    String(peaks.effectQueue),
    String(peaks.budgetStreak),
    String(build.kills),
    String(build.hits),
    String(build.impacts),
    build.hash === null ? '-' : build.hash.slice(0, 8),
    fixed(micros),
    micros === null ? '-' : `×${(micros / normalMicros).toFixed(1)}`,
  ];
}

export const BUILD_HEADER: readonly string[] = [
  'build',
  'buys',
  'ranks',
  'slot3',
  'best',
  'prestige',
  'ends',
  'start',
  'runs',
  'ticks',
  'cleared',
  'alive',
  'summons',
  'flying',
  'chain',
  'queue',
  'streak',
  'kills',
  'hits',
  'impacts',
  'hash',
  'µs/tick',
  '×normal',
];

const PEAK_LINES: readonly (readonly [keyof WebFuzzPeaks, string])[] = [
  ['alive', `alive {n} of ALIVE_WARNING ${ALIVE_WARNING}`],
  ['summons', `summons {n} of SUMMON_CAP ${SUMMON_CAP}`],
  ['inFlight', `in flight {n} of PROJECTILE_CAP ${PROJECTILE_CAP}`],
  ['chainHits', `chain hits {n} of CHAIN_HIT_CAP ${CHAIN_HIT_CAP}`],
  ['effectQueue', 'effect queue {n}'],
  ['budgetStreak', `budget streak {n}, below ${BUDGET_STREAK_LIMIT}`],
];

/** What the report of one set says: its lines, and whether it passed. */
export interface WebFuzzLines {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/** The report of one set's run in L22's form (§4.9), `wallSeconds` long. */
export function webFuzzLines(
  title: string,
  report: WebFuzzReport,
  wallSeconds: number,
  normalMicros: number,
): WebFuzzLines {
  const all = [...report.builds, ...report.cases];
  const count = (kind: WebFuzzFailure['kind']): number =>
    report.failures.filter((failure) => failure.kind === kind).length;
  const where = (build: WebFuzzBuild | null): string => (build === null ? 'no build' : build.name);
  const timed = all.map(microsOf).filter((micros): micros is number => micros !== null);
  const slowest = [...all]
    .filter((build) => microsOf(build) !== null)
    .sort((a, b) => (microsOf(b) as number) - (microsOf(a) as number))
    .slice(0, SLOWEST);
  const ratio = (micros: number): string => `×${(micros / normalMicros).toFixed(1)}`;
  const runSeconds = sumOf(all, (build) => build.time ?? 0) / 1000;
  const lines = [
    `web fuzz, ${title}: ${plural(report.builds.length, 'build')} (seed ${report.seed}) dealt ` +
      `over ${plural(report.webs.length, 'web')} (${report.webs.join(', ')}), up to ` +
      `${report.ticksPerRun} ticks (${report.ticksPerRun / TICK_RATE} s) a run, every ` +
      `${HASH_EVERY}th build twice; ${plural(report.cases.length, 'fixed case')}`,
    `runs ${report.runs}, ticks ${report.ticks}, wall ${wallSeconds.toFixed(1)} s; ` +
      `${report.stoppedEarly} runs stopped early`,
    // No layout count: checkSummonTick has no layout check, only runSummonFuzz's own checks do.
    `failures: NaN/Infinity ${count('nonFinite')}, caps ${count('cap')}, threw ` +
      `${count('threw')}, hash mismatches ${count('hash')}, dropped ${count('dropped')}, budget ` +
      `${count('budget')}, enemies ${count('enemies')} (a warning until C7, D31)`,
    `peaks: ${PEAK_LINES.map(([key, text]) => {
      const most = largest(all, (build) => build.peaks[key]);
      return `${text.replace('{n}', String(report.peaks[key]))} (${where(most)})`;
    }).join('; ')}`,
    `work: kills ${report.kills}, hits ${report.hits}, impacts ${report.impacts}; builds with ` +
      `no kill ${all.filter((build) => build.kills === 0).length}, with no hit ` +
      `${all.filter((build) => build.hits === 0).length}; cleared up to wave ` +
      `${Math.max(0, ...all.map((build) => build.highestWaveCleared))}`,
    `time: normal ${normalMicros.toFixed(2)} µs a tick in-process; the builds' median ` +
      (timed.length === 0
        ? '- (no build ticked)'
        : `${median(timed).toFixed(1)} µs a tick (${ratio(median(timed))}), slowest ` +
          `${Math.max(...timed).toFixed(1)} (${ratio(Math.max(...timed))}), over ` +
          `${runSeconds.toFixed(1)} s of runs`),
    '',
    formatTable([BUILD_HEADER, ...all.map((build) => buildRow(build, normalMicros))]),
    '',
    `the ${slowest.length} slowest builds against normal's ${normalMicros.toFixed(2)} µs a tick:`,
    formatTable(
      slowest.map((build) => [
        `  ${build.name}`,
        `${fixed(microsOf(build))} µs a tick`,
        ratio(microsOf(build) as number),
        `${build.ticks} ticks`,
      ]),
    ),
    report.cases.length === 0
      ? 'fixed cases: none (FIXED_WEB_CASES is empty until B1)'
      : `fixed cases: ${report.cases
          .map(
            (at) =>
              `${at.name} from wave ${at.startWave}: ${at.cleared ? 'cleared' : 'not cleared'} ` +
              `(highest wave cleared ${at.highestWaveCleared})`,
          )
          .join('; ')}`,
  ];
  if (report.warnings.length > 0) {
    lines.push('', `warnings: ${report.warnings.length}`);
    for (const warning of report.warnings.slice(0, SHOWN)) {
      lines.push(`WARN ${warning.text}`, `  repro: ${warning.repro}`);
    }
    if (report.warnings.length > SHOWN) lines.push(`… and ${report.warnings.length - SHOWN} more`);
  }
  if (report.failures.length === 0) {
    lines.push('', `web fuzz, ${title}: passed`);
    return { ok: true, lines };
  }
  lines.push('');
  for (const failure of report.failures.slice(0, SHOWN)) {
    lines.push(
      `FAIL ${failure.kind}: ${failure.text}`,
      `  repro: ${failure.repro}`,
      `  owned: ${failure.ids.join(', ')}`,
    );
  }
  if (report.failures.length > SHOWN) lines.push(`… and ${report.failures.length - SHOWN} more`);
  const failed = [...new Set(report.failures.map((failure) => failure.repro))];
  lines.push(
    `web fuzz, ${title} FAILED: ${report.failures.length} failures in ${failed.length} builds`,
  );
  return { ok: false, lines };
}

const intFlag = (name: string, text: string | undefined, min: number): number | undefined => {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`--${name} must be an integer >= ${min}, got '${text}'`);
  }
  return value;
};

/** One set of the run: its content, its build count and whether it is the fixture. */
interface FuzzSet {
  readonly title: string;
  readonly content: Content;
  readonly builds: number;
  readonly fixture: boolean;
  readonly cases: readonly WebFuzzCase[];
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      fixture: { type: 'boolean', default: false },
      builds: { type: 'string' },
      ticks: { type: 'string' },
      seed: { type: 'string' },
      only: { type: 'string' },
    },
  });
  const builds = intFlag('builds', values.builds, 1);
  const ticks = intFlag('ticks', values.ticks, 1) ?? WEB_FUZZ_TICKS;
  const seed = intFlag('seed', values.seed, 0) ?? WEB_FUZZ_SEED;
  const { only } = values;
  const started = performance.now();
  const data = loadGameData();
  const sets: FuzzSet[] = [];
  if (!values.fixture) {
    const content = loadContent();
    if (fuzzWebs(content).length > 0 || only !== undefined) {
      sets.push({
        title: 'registered content',
        content,
        builds: builds ?? WEB_FUZZ_BUILDS,
        fixture: false,
        cases: FIXED_WEB_CASES,
      });
    } else {
      console.log(
        'web fuzz, registered content: no character has a center, so there is no web to fuzz ' +
          "(F57); the fixture's builds run alone",
      );
    }
  }
  if (values.fixture || only === undefined) {
    sets.push({
      title: 'fixture (src/data/web/testing.ts)',
      content: fixtureContent(),
      builds: builds ?? WEB_FUZZ_FIXTURE_BUILDS,
      fixture: true,
      cases: [],
    });
  }
  const normalMicros = normalMicrosPerTick(data);
  let ok = true;
  for (const set of sets) {
    const from = performance.now();
    let report: WebFuzzReport;
    try {
      report = runWebFuzz({
        content: set.content,
        data,
        builds: set.builds,
        ticks,
        seed,
        clock: () => performance.now(),
        fixture: set.fixture,
        cases: set.cases,
        ...(only === undefined ? {} : { only }),
      });
    } catch (error) {
      console.log(
        `web fuzz, ${set.title}: ${error instanceof Error ? error.message : String(error)}`,
      );
      ok = false;
      continue;
    }
    const lines = webFuzzLines(set.title, report, (performance.now() - from) / 1000, normalMicros);
    console.log(lines.lines.join('\n'));
    console.log('');
    ok &&= lines.ok;
  }
  console.log(
    `web fuzz: ${ok ? 'passed' : 'FAILED'}; wall ${((performance.now() - started) / 1000).toFixed(1)} s ` +
      `in all, normal's timing included`,
  );
  if (!ok) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
