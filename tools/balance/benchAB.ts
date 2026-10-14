/**
 * Same-code A/B timing driver (docs/v3 C3 plan §8 BENCH). Times bench.ts's `normal` or `hits`
 * workload on the src of the tree at <tree>, so the same configs run on two commits even where
 * one tree's bench.ts lacks the scenario or the option. It needs only APIs that every compared
 * tree has (532074c onward): loadGameData, targetDamage, createSimulation, NO_INPUT,
 * RunConfig.maxTicks and a one-argument makeStats(values).
 *
 *   npx tsx tools/balance/benchAB.ts <tree> <normal|hits> [runs=80]
 *
 * One invocation runs 5 warm-up runs and `runs` timed runs with bench.ts's seeds (1 + i, then
 * 1 + runs + i for the warm-up) and prints one JSON line with the median run time. A/B pairs
 * run the two trees in separate processes, alternating which goes first; the pair ratio is
 * candidate median ÷ reference median. Keep the configs equal to bench.ts's.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WARMUP = 5;
const DEFAULT_RUNS = 80;

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

async function main(): Promise<void> {
  const [treeArg, scenario, runsArg] = process.argv.slice(2);
  if (treeArg === undefined || (scenario !== 'normal' && scenario !== 'hits')) {
    throw new Error('usage: benchAB.ts <tree> <normal|hits> [runs]');
  }
  const runs = runsArg === undefined ? DEFAULT_RUNS : Number(runsArg);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be >= 1, got '${runsArg}'`);
  const tree = resolve(treeArg);
  const api = await loadTree(tree);
  const data = api.loadGameData();
  for (let i = 0; i < WARMUP; i++) timeRun(api, data, configFor(api, scenario, 1 + runs + i));
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) ms.push(timeRun(api, data, configFor(api, scenario, 1 + i)));
  ms.sort((a, b) => a - b);
  const mid = Math.floor(runs / 2);
  const median =
    runs % 2 === 1 ? (ms[mid] as number) : ((ms[mid - 1] as number) + (ms[mid] as number)) / 2;
  console.log(JSON.stringify({ tree, scenario, runs, median }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
