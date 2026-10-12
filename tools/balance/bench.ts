/**
 * Simulation benchmark (docs/ARCHITECTURE.md §12: a 3-minute run should simulate in under
 * 100 ms). Runs full 180 s runs on the real game data with a build that cannot die and starts
 * below its frontier, so it kills quickly at first and ends with enemies piling up.
 *
 *   npm run bench -- [--runs 50] [--warmup 5] [--seed 1] [--start-wave 30]
 */

import { parseArgs } from 'node:util';
import { loadGameData, targetDamage } from '../../src/data';
import { createSimulation, MAX_RUN_SECONDS, NO_INPUT, TICK_RATE } from '../../src/sim';
import type { RunConfig } from '../../src/sim';
import { makeStats } from '../../src/sim/testing';
import { quantile } from './report';

const TARGET_MS = 100;

function positiveInt(name: string, text: string, min = 1): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`--${name} must be an integer >= ${min}, got '${text}'`);
  }
  return value;
}

interface Sample {
  readonly ms: number;
  readonly ticks: number;
  readonly kills: number;
  readonly highestWave: number;
  readonly maxAlive: number;
}

function runOnce(config: RunConfig): Sample {
  const data = loadGameData();
  const start = performance.now();
  const sim = createSimulation(config, data);
  let maxAlive = 0;
  while (!sim.state.finished) {
    sim.step(NO_INPUT);
    const alive = sim.state.enemies.length;
    if (alive > maxAlive) maxAlive = alive;
  }
  const ms = performance.now() - start;
  const result = sim.result();
  return {
    ms,
    ticks: result.ticks,
    kills: result.kills,
    highestWave: result.highestWaveReached,
    maxAlive,
  };
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      runs: { type: 'string', default: '50' },
      warmup: { type: 'string', default: '5' },
      seed: { type: 'string', default: '1' },
      'start-wave': { type: 'string', default: '30' },
    },
  });
  const runs = positiveInt('runs', values.runs);
  const warmup = positiveInt('warmup', values.warmup, 0);
  const seed = positiveInt('seed', values.seed, 0);
  const startWave = positiveInt('start-wave', values['start-wave']);

  // Strong enough to one-shot the start wave, about 10 waves short of its frontier, immortal.
  const stats = makeStats({
    damage: targetDamage(startWave + 10) / 2.5,
    attackSpeed: 4,
    critChance: 0.25,
    critMultiplier: 2,
    igniteChance: 0.4,
    chainCount: 2,
    maxLife: 1e12,
  });
  const configFor = (i: number): RunConfig => ({
    seed: seed + i,
    stats,
    rules: [],
    startWave,
    mode: 'auto',
  });

  loadGameData();
  for (let i = 0; i < warmup; i++) runOnce(configFor(runs + i));
  const samples: Sample[] = [];
  for (let i = 0; i < runs; i++) samples.push(runOnce(configFor(i)));

  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const totalMs = ms.reduce((sum, value) => sum + value, 0);
  const totalTicks = samples.reduce((sum, s) => sum + s.ticks, 0);
  const mean = (pick: (s: Sample) => number): number =>
    samples.reduce((sum, s) => sum + pick(s), 0) / samples.length;
  const p95 = quantile(ms, 0.95);

  console.log(
    `bench: ${runs} runs × ${MAX_RUN_SECONDS} s (${MAX_RUN_SECONDS * TICK_RATE} ticks), ` +
      `start wave ${startWave}, ${warmup} warm-up runs, real game data`,
  );
  console.log(
    `per run: mean ${(totalMs / runs).toFixed(1)} ms, p50 ${quantile(ms, 0.5).toFixed(1)} ms, ` +
      `p95 ${p95.toFixed(1)} ms, max ${(ms.at(-1) ?? 0).toFixed(1)} ms ` +
      `(target < ${TARGET_MS} ms: ${p95 < TARGET_MS ? 'ok' : 'MISSED'})`,
  );
  console.log(
    `throughput: ${Math.round(totalTicks / (totalMs / 1000)).toLocaleString('en-US')} ticks/s, ` +
      `${((MAX_RUN_SECONDS * 1000 * runs) / totalMs).toFixed(0)}x real time`,
  );
  console.log(
    `workload: mean ${mean((s) => s.kills).toFixed(0)} kills, ` +
      `highest wave ${mean((s) => s.highestWave).toFixed(1)}, ` +
      `up to ${Math.max(...samples.map((s) => s.maxAlive))} enemies alive`,
  );
}

main();
