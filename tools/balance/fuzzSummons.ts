/**
 * The summon fuzz at length (docs/v3 C5 design D22, §0.2 FUZZ, §8.1 C5.5): the seeded builds of
 * src/sim/summonFuzz.test.ts (summonFuzzBuilds, src/sim/testing.ts), more of them and for longer.
 * Each build runs `--seconds` from each of SUMMON_FUZZ_START_WAVES, twice, under the test's checks
 * (runSummonFuzzCase): after every tick, every enemy's hp and position and every summon's position
 * (turrets' included) finite, the summons within the run's summonCap, the shots within
 * PROJECTILE_CAP and no attack past CHAIN_HIT_CAP hits; the layout the cap allows; and the two
 * runs' hashes equal. It prints the runs, ticks and wall time, the failures by kind, the largest
 * droneCount against its cap, shotCount and chainHitsPeak with the cap counters in all, the work
 * the summons did and a line per shape, then the failures, each naming its build, seed and start
 * wave. Any failure exits non-zero. Writes nothing.
 *
 *   npx tsx tools/balance/fuzzSummons.ts [--builds 100] [--seconds 60]
 *
 * The first 20 builds are the test's, and summonFuzzBuilds(i + 1)[i] rebuilds build i.
 */

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { TICK_RATE } from '../../src/sim';
import type { CounterId } from '../../src/sim';
import { CHAIN_HIT_CAP, PROJECTILE_CAP } from '../../src/sim/caps';
import {
  runSummonFuzzCase,
  SUMMON_FUZZ_SEED,
  SUMMON_FUZZ_SHAPES,
  SUMMON_FUZZ_START_WAVES,
  summonFuzzBuilds,
  summonFuzzName,
} from '../../src/sim/testing';
import type { SummonFuzzCase, SummonFuzzFailure, SummonFuzzRun } from '../../src/sim/testing';
import { formatTable } from './report';

export const FUZZ_BUILDS = 100;
export const FUZZ_SECONDS = 60;
/** Failures printed in full; the rest are counted. */
const SHOWN_FAILURES = 20;

/** Every build's cases, one per start wave, each two runs `seconds` long. */
export function fuzzSummons(builds: number, seconds: number): SummonFuzzCase[] {
  const ticks = seconds * TICK_RATE;
  return summonFuzzBuilds(builds).flatMap((build) =>
    SUMMON_FUZZ_START_WAVES.map((wave) => runSummonFuzzCase(build, wave, ticks)),
  );
}

/** A run with its case. */
interface FuzzRun {
  readonly at: SummonFuzzCase;
  readonly run: SummonFuzzRun;
}

const runsOf = (cases: readonly SummonFuzzCase[]): FuzzRun[] =>
  cases.flatMap((at) => at.runs.map((run) => ({ at, run })));

const sumOf = (runs: readonly FuzzRun[], pick: (run: SummonFuzzRun) => number): number =>
  runs.reduce((sum, { run }) => sum + pick(run), 0);

/** The run with the largest `pick`, the first of equals; null for none. */
function largest(runs: readonly FuzzRun[], pick: (run: SummonFuzzRun) => number): FuzzRun | null {
  let best: FuzzRun | null = null;
  for (const entry of runs) if (best === null || pick(entry.run) > pick(best.run)) best = entry;
  return best;
}

/** A run's counter at its end; 0 when the run stopped early. */
const counter =
  (id: CounterId) =>
  (run: SummonFuzzRun): number =>
    run.counters?.[id] ?? 0;

const where = (entry: FuzzRun | null): string =>
  entry === null ? 'no runs' : `${summonFuzzName(entry.at.build)} from wave ${entry.at.startWave}`;

const peakChain = counter('chainHitsPeak');

/** What the report says: its lines, and whether every case passed. */
export interface FuzzReport {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/** The report of `cases`, run `seconds` long each, in `wallSeconds`. */
export function fuzzReport(
  cases: readonly SummonFuzzCase[],
  seconds: number,
  wallSeconds: number,
): FuzzReport {
  const runs = runsOf(cases);
  const failures = cases.flatMap((at) => at.failures);
  const count = (kind: SummonFuzzFailure['kind']): number =>
    failures.filter((failure) => failure.kind === kind).length;
  const builds = new Set(cases.map((at) => at.build.index)).size;
  const summons = largest(runs, (run) => run.placed);
  const shots = largest(runs, (run) => run.peakShots);
  const chains = largest(runs, peakChain);
  const capped = runs.filter(({ run }) => counter('summonCapped')(run) > 0).length;
  const idle = runs.filter(({ run }) => run.impacts + run.repeatImpacts + run.firings === 0);
  const idleStill = idle.filter(({ at }) => at.build.stats.values.attackSpeed === 0).length;
  const lines = [
    `summon fuzz: ${builds} builds (seed ${SUMMON_FUZZ_SEED}) × start waves ` +
      `${SUMMON_FUZZ_START_WAVES.join(' and ')} × ${seconds} s (${seconds * TICK_RATE} ticks), ` +
      'each run twice',
    `runs ${runs.length}, ticks ${sumOf(runs, (run) => run.ticks)}, ` +
      `wall ${wallSeconds.toFixed(1)} s`,
    `failures: NaN/Infinity ${count('nonFinite')}, hash mismatches ${count('hash')}, ` +
      `caps ${count('cap')}, layout ${count('layout')}, threw ${count('threw')}`,
    `summons: largest droneCount ${summons?.run.placed ?? 0} against its cap ` +
      `${summons?.run.cap ?? 0} (${where(summons)}); summonCapped ` +
      `${sumOf(runs, counter('summonCapped'))} in all, in ${capped} runs`,
    `shots: largest shotCount ${shots?.run.peakShots ?? 0} of PROJECTILE_CAP ${PROJECTILE_CAP} ` +
      `(${where(shots)}), largest with projectiles ` +
      `${largest(runs, (run) => run.peakInFlight)?.run.peakInFlight ?? 0}; projectilesCapped ` +
      `${sumOf(runs, counter('projectilesCapped'))} in all`,
    `chains: largest chainHitsPeak ${chains === null ? 0 : peakChain(chains.run)} of ` +
      `CHAIN_HIT_CAP ${CHAIN_HIT_CAP} (${where(chains)}); chainHitCapped ` +
      `${sumOf(runs, counter('chainHitCapped'))} in all`,
    `work: drone impacts ${sumOf(runs, (run) => run.impacts)}, repeat impacts ` +
      `${sumOf(runs, (run) => run.repeatImpacts)}, turret firings ` +
      `${sumOf(runs, (run) => run.firings)} (${sumOf(runs, (run) => run.turretShots)} shots), ` +
      `kills ${sumOf(runs, (run) => run.kills)}; runs with no impact or firing ${idle.length} ` +
      `(${idleStill} of them at attack speed 0)`,
    '',
    formatTable([
      [
        'shape',
        'builds',
        'placed',
        'cap',
        'capped',
        'shots',
        'chain',
        'impacts',
        'firings',
        'kills',
      ],
      ...SUMMON_FUZZ_SHAPES.map((shape) => {
        const mine = runs.filter(({ at }) => at.build.shape === shape);
        const most = largest(mine, (run) => run.placed);
        return [
          shape,
          String(new Set(mine.map(({ at }) => at.build.index)).size),
          String(most?.run.placed ?? 0),
          String(most?.run.cap ?? 0),
          String(sumOf(mine, counter('summonCapped'))),
          String(largest(mine, (run) => run.peakShots)?.run.peakShots ?? 0),
          String(Math.max(0, ...mine.map(({ run }) => peakChain(run)))),
          String(sumOf(mine, (run) => run.impacts + run.repeatImpacts)),
          String(sumOf(mine, (run) => run.firings)),
          String(sumOf(mine, (run) => run.kills)),
        ];
      }),
    ]),
  ];
  if (failures.length === 0) {
    lines.push('', 'summon fuzz passed');
    return { ok: true, lines };
  }
  lines.push('');
  for (const failure of failures.slice(0, SHOWN_FAILURES)) {
    lines.push(`FAIL ${failure.kind}: ${failure.text}`);
  }
  if (failures.length > SHOWN_FAILURES) {
    lines.push(`… and ${failures.length - SHOWN_FAILURES} more`);
  }
  const failed = cases.filter((at) => at.failures.length > 0);
  lines.push(
    `summon fuzz FAILED: ${failures.length} failures in ${failed.length} cases: ` +
      failed.map((at) => `${summonFuzzName(at.build)} from wave ${at.startWave}`).join('; '),
  );
  return { ok: false, lines };
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      builds: { type: 'string', default: String(FUZZ_BUILDS) },
      seconds: { type: 'string', default: String(FUZZ_SECONDS) },
    },
  });
  const builds = Number(values.builds);
  const seconds = Number(values.seconds);
  if (!Number.isInteger(builds) || builds < 1) throw new Error('--builds must be >= 1');
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error('--seconds must be >= 1');
  const started = performance.now();
  const cases = fuzzSummons(builds, seconds);
  const report = fuzzReport(cases, seconds, (performance.now() - started) / 1000);
  for (const line of report.lines) console.log(line);
  if (!report.ok) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
