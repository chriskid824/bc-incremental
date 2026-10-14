/**
 * Same-code A/B timing driver (docs/v3 C3 plan §8 BENCH, docs/v3 C4 design §0.4). Times
 * bench.ts's `normal` or `hits` workload on the src of other trees, so the same configs run on
 * two commits even where one tree's bench.ts lacks the scenario or the option. It needs only
 * APIs that every compared tree has (532074c onward): loadGameData, targetDamage,
 * createSimulation, NO_INPUT, RunConfig.maxTicks and a one-argument makeStats(values).
 *
 *   npx tsx tools/balance/benchAB.ts <tree> <normal|hits> [runs=80]
 *   npx tsx tools/balance/benchAB.ts --inproc <treeA> <treeB> <normal|hits> [--procs 7]
 *
 * Pair mode: one invocation runs 5 warm-up runs and `runs` timed runs with bench.ts's seeds
 * (1 + i, then 1 + runs + i for the warm-up) and prints one JSON line with the median run time.
 * A/B pairs run the two trees in separate processes, alternating which goes first; the pair
 * ratio is candidate median ÷ reference median. Two processes of the same code measured ratios
 * of 0.64–1.57, so a pair says little about a few percent.
 *
 * --inproc times both trees in each of `procs` processes, run one after another. A process
 * imports both trees' src/data, src/sim and src/sim/testing, runs 5 warm-up runs of each, then
 * INPROC_RUNS rounds of one run of each, the order flipped every round, with bench.ts's seeds,
 * and prints {a, b, ratio}: the median of treeB's runs ÷ the median of treeA's. With a fixed
 * import order, two copies of one commit measured about 2% apart, so even processes import
 * treeA first and odd ones treeB first. The parent prints every process's ratio, the median
 * ratio of each import order and the median of all, then one JSON line with them. treeA is the
 * reference (the parent commit), treeB the candidate. Keep the configs equal to bench.ts's.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { median } from './benchCheck';

const WARMUP = 5;
const DEFAULT_RUNS = 80;
/** Timed runs of each tree per --inproc process. */
const INPROC_RUNS = 40;
const DEFAULT_PROCS = 7;
/** The flag a --inproc parent starts its processes with. */
const CHILD_FLAG = '--inproc-child';

/** The parts of a tree's src/data, src/sim and src/sim/testing this driver calls. */
interface TreeApi {
  loadGameData(): unknown;
  targetDamage(wave: number): number;
  createSimulation(
    config: unknown,
    data: unknown,
  ): { readonly state: { readonly finished: boolean }; step(input: unknown): unknown };
  readonly NO_INPUT: unknown;
  makeStats(values: Record<string, number>): unknown;
}

type ScenarioId = 'normal' | 'hits';

const isScenarioId = (value: string | undefined): value is ScenarioId =>
  value === 'normal' || value === 'hits';

/** bench.ts's scenario configs, at its default start wave (30) for normal. */
function configFor(api: TreeApi, scenario: ScenarioId, seed: number): unknown {
  if (scenario === 'hits') {
    const startWave = 40;
    return {
      seed,
      stats: api.makeStats({
        damage: api.targetDamage(startWave) / 4,
        attackSpeed: 12,
        projectileCount: 6,
        chainCount: 8,
        critChance: 0.25,
        critMultiplier: 2,
        igniteChance: 0.4,
        maxLife: 1e12,
      }),
      rules: [],
      startWave,
      mode: 'auto',
      maxTicks: 30 * 60,
    };
  }
  const startWave = 30;
  return {
    seed,
    stats: api.makeStats({
      damage: api.targetDamage(startWave + 10) / 2.5,
      attackSpeed: 4,
      critChance: 0.25,
      critMultiplier: 2,
      igniteChance: 0.4,
      chainCount: 2,
      maxLife: 1e12,
    }),
    rules: [],
    startWave,
    mode: 'auto',
  };
}

async function loadTree(tree: string): Promise<TreeApi> {
  const load = (path: string) => import(pathToFileURL(resolve(tree, path)).href);
  const [data, sim, testing] = await Promise.all([
    load('src/data/index.ts'),
    load('src/sim/index.ts'),
    load('src/sim/testing.ts'),
  ]);
  return {
    loadGameData: data.loadGameData,
    targetDamage: data.targetDamage,
    createSimulation: sim.createSimulation,
    NO_INPUT: sim.NO_INPUT,
    makeStats: testing.makeStats,
  };
}

/** Run time in ms, from createSimulation to the end, as bench.ts measures it. */
function timeRun(api: TreeApi, data: unknown, config: unknown): number {
  const start = performance.now();
  const sim = api.createSimulation(config, data);
  while (!sim.state.finished) sim.step(api.NO_INPUT);
  return performance.now() - start;
}

/** Times a run of `scenario` on a loaded tree, by seed. */
function timer(api: TreeApi, scenario: ScenarioId): (seed: number) => number {
  const data = api.loadGameData();
  return (seed) => timeRun(api, data, configFor(api, scenario, seed));
}

/** Pair mode: the median run of `scenario` on one tree. */
async function pair(treeArg: string, scenario: ScenarioId, runsArg: string | undefined) {
  const runs = runsArg === undefined ? DEFAULT_RUNS : Number(runsArg);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be >= 1, got '${runsArg}'`);
  const tree = resolve(treeArg);
  const time = timer(await loadTree(tree), scenario);
  for (let i = 0; i < WARMUP; i++) time(1 + runs + i);
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) ms.push(time(1 + i));
  console.log(JSON.stringify({ tree, scenario, runs, median: median(ms) }));
}

/** What one --inproc process measured: each tree's median run, ms, and b ÷ a. */
interface InprocResult {
  readonly a: number;
  readonly b: number;
  readonly ratio: number;
}

/** One --inproc process; `first` ('a' or 'b') names the tree it imports first. */
async function inprocChild(treeA: string, treeB: string, scenario: ScenarioId, first: string) {
  if (first !== 'a' && first !== 'b') throw new Error(`expected a or b, got '${first}'`);
  const loadedFirst = await loadTree(first === 'a' ? treeA : treeB);
  const loadedSecond = await loadTree(first === 'a' ? treeB : treeA);
  const timeA = timer(first === 'a' ? loadedFirst : loadedSecond, scenario);
  const timeB = timer(first === 'a' ? loadedSecond : loadedFirst, scenario);
  for (let i = 0; i < WARMUP; i++) {
    timeA(1 + INPROC_RUNS + i);
    timeB(1 + INPROC_RUNS + i);
  }
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < INPROC_RUNS; i++) {
    if (i % 2 === 0) {
      a.push(timeA(1 + i));
      b.push(timeB(1 + i));
    } else {
      b.push(timeB(1 + i));
      a.push(timeA(1 + i));
    }
  }
  const result: InprocResult = { a: median(a), b: median(b), ratio: median(b) / median(a) };
  console.log(JSON.stringify(result));
}

/** --inproc: `procs` processes one after another, the import order alternating. */
function inproc(treeA: string, treeB: string, scenario: ScenarioId, procs: number): void {
  const script = fileURLToPath(import.meta.url);
  const byOrder: Record<'a' | 'b', number[]> = { a: [], b: [] };
  const ratios: number[] = [];
  console.log(`benchAB --inproc ${scenario}: a = ${treeA}, b = ${treeB}`);
  for (let p = 0; p < procs; p++) {
    const first = p % 2 === 0 ? 'a' : 'b';
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, script, CHILD_FLAG, treeA, treeB, scenario, first],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const line = child.stdout.trim().split('\n').at(-1) ?? '';
    if (child.status !== 0 || line === '') {
      throw new Error(`process ${p + 1} failed (status ${child.status}): ${child.stdout}`);
    }
    const result = JSON.parse(line) as InprocResult;
    ratios.push(result.ratio);
    byOrder[first].push(result.ratio);
    console.log(
      `process ${p + 1} (${first} imported first): a ${result.a.toFixed(3)} ms, ` +
        `b ${result.b.toFixed(3)} ms, ratio ${result.ratio.toFixed(4)}`,
    );
  }
  const round = (value: number): number => Number(value.toFixed(4));
  const summary = {
    scenario,
    procs,
    ratios: ratios.map(round),
    aFirst: round(median(byOrder.a)),
    bFirst: round(median(byOrder.b)),
    median: round(median(ratios)),
  };
  console.log(
    `median ratio b / a: a first ${summary.aFirst} (${byOrder.a.length} processes), ` +
      `b first ${summary.bFirst} (${byOrder.b.length}), all ${summary.median} (${procs})`,
  );
  console.log(JSON.stringify(summary));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === CHILD_FLAG) {
    const [, treeA, treeB, scenario, first] = args;
    if (treeA === undefined || treeB === undefined || !isScenarioId(scenario)) {
      throw new Error(`usage: benchAB.ts ${CHILD_FLAG} <treeA> <treeB> <normal|hits> <a|b>`);
    }
    await inprocChild(treeA, treeB, scenario, first ?? '');
    return;
  }
  if (args[0] === '--inproc') {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: { procs: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
    const [treeA, treeB, scenario] = positionals;
    if (treeA === undefined || treeB === undefined || !isScenarioId(scenario)) {
      throw new Error('usage: benchAB.ts --inproc <treeA> <treeB> <normal|hits> [--procs 7]');
    }
    const procs = values.procs === undefined ? DEFAULT_PROCS : Number(values.procs);
    if (!Number.isInteger(procs) || procs < 1) {
      throw new Error(`--procs must be an integer >= 1, got '${values.procs}'`);
    }
    inproc(resolve(treeA), resolve(treeB), scenario, procs);
    return;
  }
  const [treeArg, scenario, runsArg] = args;
  if (treeArg === undefined || !isScenarioId(scenario)) {
    throw new Error('usage: benchAB.ts <tree> <normal|hits> [runs]');
  }
  await pair(treeArg, scenario, runsArg);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
