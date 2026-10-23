import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_ENTRIES, checkLines, checkRecord, shareRecord } from './bench';
import type {
  CheckRecord,
  ShareEntry,
  ShareProcess,
  ShareRecord,
  ShareWork,
  SummonWorkload,
  Workload,
} from './bench';
import { checkBench } from './benchCheck';
import type { BenchTimings } from './benchCheck';
import { benchCommand, benchSteps, parseRecord, readingsBlock } from './readings';
import type { BenchStep, ReadingsEnv } from './readings';

/** A workload as the share report reads it, from stressBase's pinned one, at this alive. */
const pinned = JSON.parse(
  readFileSync(new URL('./stressBase.workload.json', import.meta.url), 'utf8'),
) as Omit<Workload, 'lobAimMicros'>;
const workload = (averageAlive: number): Workload => ({
  ...pinned,
  lobAimMicros: null,
  averageAlive,
});
const NO_SUMMONS: SummonWorkload = {
  seconds: 30,
  drones: 0,
  turrets: 0,
  summonCapped: 0,
  impacts: 0,
  splashVictims: 0,
  firings: 0,
  turretShots: 0,
  listened: 0,
  picks: 0,
  movingTicks: 0,
  idleTicks: 0,
  peakShots: 0,
  peakShotCount: 0,
  projectilesCapped: 0,
  kills: 0,
  ailments: [],
};
const WORK: ShareWork = {
  v4: workload(281.44),
  base: workload(280.61),
  hive: workload(259.1),
  off: workload(279.6),
  v4Summons: NO_SUMMONS,
  baseSummons: NO_SUMMONS,
  pickMicros: null,
};

const GATE: readonly ShareEntry[] = ['stress', 'stressBase', 'normal'];
const PRINT: readonly ShareEntry[] = ['hiveStress', 'stressAilmentsOff', 'stressBase', 'normal'];

/**
 * `procs` processes of 7 rounds at a normal of `normal` ms: round g's stress v4 runs
 * (4.1 + 0.01 g) × normal and its stressBase 3.1 × normal; with `warmup`, two warm-up rounds a
 * phase of 10 ms runs, as --share's children report them.
 */
function processes(normal: number, procs = 3, warmup = false): ShareProcess[] {
  const round = (entries: readonly ShareEntry[], g: number) => ({
    seed: 1 + g,
    order: entries,
    ms: {
      stress: normal * (4.1 + 0.01 * g),
      stressBase: normal * 3.1,
      hiveStress: normal * 1.1,
      stressAilmentsOff: normal * 3.3,
      normal,
    },
  });
  const warm = (entries: readonly ShareEntry[]) =>
    [0, 1].map((w) => ({ seed: 100 + w, order: entries, ms: { stress: 10, normal: 10 } }));
  return Array.from({ length: procs }, (_, p) => ({
    gate: Array.from({ length: 7 }, (_, r) => round(GATE, 7 * p + r)),
    print: Array.from({ length: 7 }, (_, r) => round(PRINT, 7 * p + r)),
    ...(warmup ? { warmup: { gate: warm(GATE), print: warm(PRINT) } } : {}),
  }));
}

/** What `--share --json` records for these processes, read back as readings.ts reads it. */
const shareJson = (procs: readonly ShareProcess[]): ShareRecord =>
  parseRecord(JSON.stringify(shareRecord(procs.length, 7, procs, WORK)), 'share');

/** What `--check --json` records for fan and shots, shots without a recorded ratio. */
function checkJson(): CheckRecord {
  const timings: BenchTimings = {
    reference: [21, 20, 22, 19, 20, 21],
    entries: [
      { id: 'fan', ms: [40, 40, 40], referenceMs: [21, 20, 22] },
      { id: 'shots', ms: [30, 31, 32], referenceMs: [19, 20, 21] },
    ],
  };
  const recorded = { ratios: { fan: 1.8 } };
  const result = checkBench(timings, recorded, CHECK_ENTRIES, false);
  const checked = { timings, workloads: new Map(), summons: new Map() };
  const lines = checkLines('bench.baseline.json', checked, result);
  const record = checkRecord('bench.baseline.json', timings, recorded, result, lines, false);
  return parseRecord(JSON.stringify(record), 'check');
}

const ENV: ReadingsEnv = {
  commit: 'abc1234',
  platform: 'darwin',
  release: '24.1.0',
  arch: 'arm64',
  cpu: 'Apple M2',
  cpus: 8,
  node: 'v22.11.0',
};

describe('the readings block (docs/v3 C10 design §2.5, OWN test 8)', () => {
  it('prints the block from the --json records: the share, a check line per entry, implied and rerun', () => {
    expect(readingsBlock(shareJson(processes(20)), checkJson(), ENV)).toEqual([
      'bc-incremental readings v1',
      'commit abc1234  os darwin 24.1.0 arm64  cpu Apple M2 x8  node v22.11.0',
      'share: v4 4.200 (limit 4.5)  stressBase 3.100 (limit 3.5)  share 1.100  normal 20.00 ms ' +
        '(<= 25)  gate run yes  alive 281.4/280.6',
      'check: normal 21.0 ms (<= 50); fan 1.905 vs 1.8',
      'check: normal 20.0 ms (<= 50); shots 1.550 vs none',
      "implied: v4 84.0 ms per 30 s; 50 ms at this machine's normal = ratio 2.500",
      'rerun: no',
      'end readings',
    ]);
  });

  it('implies 50 ms ÷ the share’s normal, and reruns above 25 ms of normal, not at 25', () => {
    const at = (normal: number): readonly string[] =>
      readingsBlock(shareJson(processes(normal)), checkJson(), ENV);
    expect(at(25).slice(-3)).toEqual([
      "implied: v4 105.0 ms per 30 s; 50 ms at this machine's normal = ratio 2.000",
      'rerun: no',
      'end readings',
    ]);
    expect(at(25.1).slice(-3)).toEqual([
      "implied: v4 105.4 ms per 30 s; 50 ms at this machine's normal = ratio 1.992",
      'rerun: yes',
      'end readings',
    ]);
    expect(at(12.5).at(-3)).toBe(
      "implied: v4 52.5 ms per 30 s; 50 ms at this machine's normal = ratio 4.000",
    );
  });

  it('reruns a share that was not a gate run, whatever its normal', () => {
    const block = readingsBlock(shareJson(processes(20, 2)), checkJson(), ENV);
    expect(block[2]).toContain('normal 20.00 ms (<= 25)  gate run no  ');
    expect(block.at(-2)).toBe('rerun: yes');
  });

  it('reads v4’s ms from the measured rounds, not the warm-up rounds the record holds', () => {
    const share = shareJson(processes(20, 3, true));
    expect(share.processes[0]?.warmup?.gate).toHaveLength(2);
    expect(readingsBlock(share, checkJson(), ENV).at(-3)).toBe(
      "implied: v4 84.0 ms per 30 s; 50 ms at this machine's normal = ratio 2.500",
    );
  });

  it('runs --share, then --check, each with --json to its own file', () => {
    const dir = join('out', 'readings');
    expect(benchSteps(dir)).toEqual([
      { args: ['--share', '--json', join(dir, 'share.json')], file: join(dir, 'share.json') },
      { args: ['--check', '--json', join(dir, 'check.json')], file: join(dir, 'check.json') },
    ]);
  });

  it('runs each step as a child of this node with this process’s flags, as --share spawns', () => {
    const [share] = benchSteps(join('out', 'readings'));
    const { command, args } = benchCommand(share as BenchStep);
    const flags = process.execArgv.length;
    expect(command).toBe(process.execPath);
    expect(args.slice(0, flags)).toEqual(process.execArgv);
    expect(args.slice(flags)).toEqual([
      fileURLToPath(new URL('./bench.ts', import.meta.url)),
      '--share',
      '--json',
      join('out', 'readings', 'share.json'),
    ]);
  });

  it('reads a record of the kind it asks for only', () => {
    const check = JSON.stringify(checkJson());
    expect(parseRecord(check, 'check').kind).toBe('check');
    expect(() => parseRecord(check, 'share')).toThrow(/--share --json record/);
    expect(() => parseRecord('[]', 'check')).toThrow(/--check --json record/);
  });
});

describe('npm run readings (docs/v3 C10 design §2.5)', () => {
  /** The readings' own directory, as `npm run readings` runs from the repository root. */
  const DIR = join('out', 'readings');
  const SHARE = JSON.stringify(shareRecord(3, 7, processes(20), WORK));
  const CHECK = JSON.stringify(checkJson());
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bc-readings-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * readings.ts run as npm runs it, from `root`, with git at a 40-digit commit and each bench
   * child faked: `record(file)` is what the child writes to its --json file, or null for nothing.
   */
  async function npmRunReadings(record: (file: string) => string | null): Promise<{
    readonly printed: readonly string[];
    readonly spawned: readonly (readonly string[])[];
  }> {
    const { argv } = process;
    const cwd = process.cwd();
    const spawned: string[][] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      spawnSync: (command: string, args: readonly string[]) => {
        spawned.push([command, ...args]);
        if (command === 'git') {
          return { status: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n' };
        }
        const file = args.at(-1) as string;
        const text = record(file);
        if (text !== null) writeFileSync(file, text);
        return { status: text === null ? 1 : 0 };
      },
    }));
    try {
      process.chdir(root);
      process.argv = [argv[0] as string, fileURLToPath(new URL('./readings.ts', import.meta.url))];
      vi.resetModules();
      await import('./readings');
      return { printed: log.mock.calls.map(([text]) => String(text)), spawned };
    } finally {
      process.argv = argv;
      process.chdir(cwd);
      log.mockRestore();
      vi.doUnmock('node:child_process');
    }
  }

  it('runs --share, then --check, prints the block and writes it to out/readings/readings.txt', async () => {
    const { printed, spawned } = await npmRunReadings((file) =>
      file.endsWith('share.json') ? SHARE : CHECK,
    );
    expect(spawned.slice(0, 2)).toEqual(
      benchSteps(DIR).map((step) => {
        const { command, args } = benchCommand(step);
        return [command, ...args];
      }),
    );
    expect(printed).toHaveLength(1);
    const block = (printed[0] as string).split('\n');
    // The commit's first 7 hex digits, and this machine.
    expect(block[1]).toMatch(/^commit 0123456 {2}os /);
    expect(block[1]).toContain(` os ${platform()} ${release()} ${arch()}  cpu `);
    expect(block[1]?.endsWith(`  node ${process.version}`)).toBe(true);
    const expected = readingsBlock(parseRecord(SHARE, 'share'), parseRecord(CHECK, 'check'), ENV);
    expect([block[0], ...block.slice(2)]).toEqual([expected[0], ...expected.slice(2)]);
    expect(readFileSync(join(root, DIR, 'readings.txt'), 'utf8')).toBe(`${printed[0]}\n`);
  });

  it('stops at a bench run that writes no record, even with one left from an earlier run', async () => {
    mkdirSync(join(root, DIR), { recursive: true });
    writeFileSync(join(root, DIR, 'check.json'), CHECK);
    await expect(
      npmRunReadings((file) => (file.endsWith('share.json') ? SHARE : null)),
    ).rejects.toThrow(`readings: bench --check --json ${join(DIR, 'check.json')} wrote no record`);
    expect(existsSync(join(root, DIR, 'readings.txt'))).toBe(false);
  });
});
