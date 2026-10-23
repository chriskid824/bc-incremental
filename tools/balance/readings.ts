/**
 * This machine's simulation readings for Hoshi's C9 sitting (docs/v3 C10 design §2.5, the
 * machine-readings runbook's §8.1): `npm run readings` runs bench's --share, then its --check,
 * each with --json, as children through process.execPath with this process's flags (tsx's
 * loader), as --share runs its processes, so it works alike on macOS, Windows and Linux. Then it
 * prints the block below and writes it to out/readings/readings.txt, for Hoshi to paste into the
 * thread; the two JSON records stay beside it. C10.6 records the numbers as pasted: no limit
 * changes here (L8), the block prints them.
 *
 *   bc-incremental readings v1
 *   commit <sha7>  os <platform> <release> <arch>  cpu <model> x<n>  node <version>
 *   share: v4 <x> (limit 4.5)  stressBase <x> (limit 3.5)  share <x>  normal <ms> ms (<= 25)  …
 *   check: normal <ms> ms (<= 50); <entry> <ratio> vs <recorded>      (one line per entry)
 *   implied: v4 <ms> ms per 30 s; 50 ms at this machine's normal = ratio <50/normal>
 *   rerun: yes|no
 *   end readings
 *
 * The share line ends `gate run yes|no  alive <v4>/<stressBase>`. A check line's normal is the
 * median of the normal runs timed with its entry, its ratio's reference. The implied ratio is
 * impl §6's 50 ms for a 30 s stress run in the STRESS gate's terms: 50 ms ÷ the share's normal
 * median. `rerun: yes` when that median exceeds NORMAL_PRECONDITION_MS or the share was not a
 * gate run; the runbook then asks for one more run. A failing share or check still reads: only a
 * run that writes no record stops it.
 *
 *   npm run readings
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NORMAL_PRECONDITION_MS, STRESS_BASE_LIMIT, STRESS_TOTAL_LIMIT } from './bench';
import type { CheckRecord, ShareRecord } from './bench';
import { median, NORMAL_BUDGET_MS } from './benchCheck';

/** impl §6's budget for a 30 s stress run, ms (初始值 there): printed, never gated here (L8). */
export const STRESS_RUN_BUDGET_MS = 50;
/** Where the block and the two records go, from the repository root as npm runs it. */
export const READINGS_DIR = join('out', 'readings');

const BENCH = fileURLToPath(new URL('./bench.ts', import.meta.url));

/** One bench run of the readings: its arguments, and the record it writes. */
export interface BenchStep {
  readonly args: readonly string[];
  readonly file: string;
}

/** The bench runs, in order: --share, then --check, each recording to a file in `dir`. */
export function benchSteps(dir: string): readonly BenchStep[] {
  return (['share', 'check'] as const).map((mode) => {
    const file = join(dir, `${mode}.json`);
    return { args: [`--${mode}`, '--json', file], file };
  });
}

/**
 * A step's child: bench.ts on this node with this process's flags (tsx's loader), as --share
 * spawns its processes, so no shell or npx is needed on any system.
 */
export function benchCommand(step: BenchStep): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return { command: process.execPath, args: [...process.execArgv, BENCH, ...step.args] };
}

/** Where the readings ran: the commit and the machine. */
export interface ReadingsEnv {
  /** The commit's first 7 hex digits, or 'unknown' outside a git checkout. */
  readonly commit: string;
  readonly platform: string;
  readonly release: string;
  readonly arch: string;
  readonly cpu: string;
  readonly cpus: number;
  /** process.version. */
  readonly node: string;
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

/** The readings block, from `bc-incremental readings v1` to `end readings`. */
export function readingsBlock(
  share: ShareRecord,
  check: CheckRecord,
  env: ReadingsEnv,
): readonly string[] {
  const normal = share.normalMs;
  const v4Ms = median(share.processes.flatMap((p) => p.gate.map((r) => r.ms.stress as number)));
  const checks =
    check.entries.length === 0
      ? [`check: normal ${check.normal.medianMs.toFixed(1)} ms (<= ${NORMAL_BUDGET_MS})`]
      : check.entries.map(
          (entry) =>
            `check: normal ${entry.referenceMs.toFixed(1)} ms (<= ${NORMAL_BUDGET_MS}); ` +
            `${entry.id} ${entry.ratio.toFixed(3)} vs ${entry.recorded ?? 'none'}`,
        );
  return [
    'bc-incremental readings v1',
    `commit ${env.commit}  os ${env.platform} ${env.release} ${env.arch}  ` +
      `cpu ${env.cpu} x${env.cpus}  node ${env.node}`,
    `share: v4 ${share.total.median.toFixed(3)} (limit ${STRESS_TOTAL_LIMIT})  ` +
      `stressBase ${share.stressBase.median.toFixed(3)} (limit ${STRESS_BASE_LIMIT})  ` +
      `share ${share.share.median.toFixed(3)}  ` +
      `normal ${normal.toFixed(2)} ms (<= ${NORMAL_PRECONDITION_MS})  ` +
      `gate run ${yesNo(share.gateRun)}  ` +
      `alive ${share.alive.v4.toFixed(1)}/${share.alive.stressBase.toFixed(1)}`,
    ...checks,
    `implied: v4 ${v4Ms.toFixed(1)} ms per ${share.seconds} s; ${STRESS_RUN_BUDGET_MS} ms at ` +
      `this machine's normal = ratio ${(STRESS_RUN_BUDGET_MS / normal).toFixed(3)}`,
    `rerun: ${yesNo(normal > NORMAL_PRECONDITION_MS || !share.gateRun)}`,
    'end readings',
  ];
}

/** A --json record of `kind` read from `text`; throws when it is not one. */
export function parseRecord(text: string, kind: 'share'): ShareRecord;
export function parseRecord(text: string, kind: 'check'): CheckRecord;
export function parseRecord(text: string, kind: 'share' | 'check'): ShareRecord | CheckRecord {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { kind?: unknown }).kind !== kind
  ) {
    throw new Error(`readings: expected bench's --${kind} --json record`);
  }
  return parsed as ShareRecord | CheckRecord;
}

/** The commit's first 7 hex digits; 'unknown' when git cannot say. */
function commitOf(): string {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const sha = git.status === 0 ? git.stdout.trim() : '';
  return /^[0-9a-f]{7,}$/.test(sha) ? sha.slice(0, 7) : 'unknown';
}

function machine(): ReadingsEnv {
  const cores = cpus();
  return {
    commit: commitOf(),
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cores[0]?.model.trim() || 'unknown',
    cpus: cores.length,
    node: process.version,
  };
}

function main(): void {
  mkdirSync(READINGS_DIR, { recursive: true });
  const records: string[] = [];
  for (const step of benchSteps(READINGS_DIR)) {
    // A record left from an earlier run must not stand in for this one's.
    rmSync(step.file, { force: true });
    const { command, args } = benchCommand(step);
    const child = spawnSync(command, args, { stdio: 'inherit' });
    if (child.error !== undefined) throw child.error;
    if (!existsSync(step.file)) {
      throw new Error(
        `readings: bench ${step.args.join(' ')} wrote no record (status ${child.status})`,
      );
    }
    records.push(readFileSync(step.file, 'utf8'));
  }
  const [share = '', check = ''] = records;
  const block = readingsBlock(
    parseRecord(share, 'share'),
    parseRecord(check, 'check'),
    machine(),
  ).join('\n');
  console.log(block);
  writeFileSync(join(READINGS_DIR, 'readings.txt'), `${block}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
