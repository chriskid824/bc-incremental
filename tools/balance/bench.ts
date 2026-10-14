/**
 * Simulation benchmark. Scenarios:
 *
 * - normal (default): full 180 s runs on the real game data with a build that cannot die and
 *   starts below its frontier, so it kills quickly at first and ends with enemies piling up
 *   (docs/v3/implementation-plan-v3.md §6: under 50 ms per run, compared at p95 here).
 * - hits: the hit path under load, 30 s at wave 40 with six projectiles and eight chain jumps,
 *   about 8.6 hits per tick. It pins its start wave and ignores --start-wave, so it is the
 *   same workload as tools/balance/benchAB.ts's, which times it across commits.
 * - ailments: the ailment stress case of docs/v3/implementation-plan-v3.md §6, 30 s at wave 30
 *   with Pandemic, Eternal Flame and a longer burn on a build that clears wave 30. M1 keeps
 *   one record per burn stack, which takes seconds per run here; the budget is 50 ms. Slow, so
 *   it runs only when asked for and with few runs.
 * - effects: the effect queue, 30 s at wave 30 with normal's build plus a trigger that
 *   explodes every kill (src/sim/effects/) but its own explosions' (rule 3). It pins its start
 *   wave like hits.
 *
 *   npm run bench -- [--scenario normal|hits|ailments|effects] [--runs 50] [--warmup 5]
 *     [--seed 1] [--start-wave 30]
 *
 * --runs and --warmup default to the scenario's own counts.
 */

import { parseArgs } from 'node:util';
import { loadGameData, targetDamage } from '../../src/data';
import type { StatBlock } from '../../src/data';
import type { StatExtras } from '../../src/data/stats';
import { createSimulation, MAX_RUN_SECONDS, NO_INPUT, TICK_RATE } from '../../src/sim';
import type { RunConfig } from '../../src/sim';
import { makeStats } from '../../src/sim/testing';
import { quantile } from './report';

const SCENARIO_IDS = ['normal', 'hits', 'ailments', 'effects'] as const;
/** Length of a stress-scenario run (docs/v3/implementation-plan-v3.md §6). */
const STRESS_SECONDS = 30;
/** The hits scenario's start wave, whatever --start-wave says. */
const HITS_START_WAVE = 40;
/** The effects scenario's start wave, whatever --start-wave says: normal's default. */
const EFFECTS_START_WAVE = 30;
type ScenarioId = (typeof SCENARIO_IDS)[number];

const isScenarioId = (value: string): value is ScenarioId =>
  (SCENARIO_IDS as readonly string[]).includes(value);

interface Scenario {
  readonly runs: number;
  readonly warmup: number;
  /** Simulated seconds per run. */
  readonly seconds: number;
  /** Budget for the p95 run time. */
  readonly targetMs: number;
  /** Start wave the scenario always uses, in place of --start-wave. */
  readonly startWave?: number;
  /** Config of one run; runs differ only in their seed. */
  config(seed: number, startWave: number): RunConfig;
}

/** normal's build at `startWave`, with these triggers and conversions. */
function normalStats(startWave: number, extras?: StatExtras): StatBlock {
  return makeStats(
    {
      damage: targetDamage(startWave + 10) / 2.5,
      attackSpeed: 4,
      critChance: 0.25,
      critMultiplier: 2,
      igniteChance: 0.4,
      chainCount: 2,
      maxLife: 1e12,
    },
    [],
    extras,
  );
}

const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = {
  normal: {
    runs: 50,
    warmup: 5,
    seconds: MAX_RUN_SECONDS,
    targetMs: 50,
    // Strong enough to one-shot the start wave, about 10 waves short of its frontier, immortal.
    config: (seed, startWave) => ({
      seed,
      stats: normalStats(startWave),
      rules: [],
      startWave,
      mode: 'auto',
    }),
  },
  hits: {
    runs: 50,
    warmup: 5,
    seconds: STRESS_SECONDS,
    // No budget of its own: benchAB.ts gates it on its ratio to the previous commit and to
    // 532074c. This is §6's stress-scenario budget.
    targetMs: 50,
    startWave: HITS_START_WAVE,
    // Kills an enemy in a few hits, so targets stay plentiful and most hits chain. Immortal.
    config: (seed) => ({
      seed,
      stats: makeStats({
        damage: targetDamage(HITS_START_WAVE) / 4,
        attackSpeed: 12,
        projectileCount: 6,
        chainCount: 8,
        critChance: 0.25,
        critMultiplier: 2,
        igniteChance: 0.4,
        maxLife: 1e12,
      }),
      rules: [],
      startWave: HITS_START_WAVE,
      mode: 'auto',
      maxTicks: STRESS_SECONDS * TICK_RATE,
    }),
  },
  ailments: {
    runs: 3,
    warmup: 0,
    seconds: STRESS_SECONDS,
    targetMs: 50,
    // The start wave's frontier damage, every hit ignites, burns last 1.2 s + 0.4 s (slowBurn),
    // then Eternal Flame (no stack cap, half duration) and Pandemic (spread on death). Immortal.
    config: (seed, startWave) => ({
      seed,
      stats: makeStats({
        damage: targetDamage(startWave),
        igniteChance: 1,
        burnDuration: 1.6,
        maxLife: 1e12,
      }),
      rules: [
        { id: 'eternalFlame', durationMore: -0.5 },
        { id: 'pandemic', spreadRadius: 250, spreadEffect: 0.4, hitMore: -0.3 },
      ],
      startWave,
      mode: 'auto',
      maxTicks: STRESS_SECONDS * TICK_RATE,
    }),
  },
  effects: {
    runs: 20,
    warmup: 3,
    seconds: STRESS_SECONDS,
    targetMs: 50,
    startWave: EFFECTS_START_WAVE,
    // Every kill but an explosion's own explodes on the enemies around it, at half the damage
    // stat.
    config: (seed) => ({
      seed,
      stats: normalStats(EFFECTS_START_WAVE, {
        triggers: [
          {
            source: 'center',
            spec: { on: 'kill', do: [{ kind: 'explode', radius: 90, damagePct: 0.5 }] },
          },
        ],
        conversions: [],
      }),
      rules: [],
      startWave: EFFECTS_START_WAVE,
      mode: 'auto',
      maxTicks: STRESS_SECONDS * TICK_RATE,
    }),
  },
};

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
      scenario: { type: 'string', default: 'normal' },
      runs: { type: 'string' },
      warmup: { type: 'string' },
      seed: { type: 'string', default: '1' },
      'start-wave': { type: 'string', default: '30' },
    },
  });
  const id = values.scenario;
  if (!isScenarioId(id)) {
    throw new Error(`--scenario must be one of ${SCENARIO_IDS.join(', ')}, got '${id}'`);
  }
  const scenario = SCENARIOS[id];
  const runs = positiveInt('runs', values.runs ?? String(scenario.runs));
  const warmup = positiveInt('warmup', values.warmup ?? String(scenario.warmup), 0);
  const seed = positiveInt('seed', values.seed, 0);
  const startWave = scenario.startWave ?? positiveInt('start-wave', values['start-wave']);
  const configFor = (i: number): RunConfig => scenario.config(seed + i, startWave);

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
  const { seconds, targetMs } = scenario;

  console.log(
    `bench${id === 'normal' ? '' : ` ${id}`}: ${runs} runs × ${seconds} s ` +
      `(${seconds * TICK_RATE} ticks), start wave ${startWave}, ${warmup} warm-up runs, ` +
      'real game data',
  );
  console.log(
    `per run: mean ${(totalMs / runs).toFixed(1)} ms, p50 ${quantile(ms, 0.5).toFixed(1)} ms, ` +
      `p95 ${p95.toFixed(1)} ms, max ${(ms.at(-1) ?? 0).toFixed(1)} ms ` +
      `(target < ${targetMs} ms: ${p95 < targetMs ? 'ok' : 'MISSED'})`,
  );
  console.log(
    `throughput: ${Math.round(totalTicks / (totalMs / 1000)).toLocaleString('en-US')} ticks/s, ` +
      `${((seconds * 1000 * runs) / totalMs).toFixed(0)}x real time`,
  );
  console.log(
    `workload: mean ${mean((s) => s.kills).toFixed(0)} kills, ` +
      `highest wave ${mean((s) => s.highestWave).toFixed(1)}, ` +
      `up to ${Math.max(...samples.map((s) => s.maxAlive))} enemies alive`,
  );
}

main();
