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
 *   with Pandemic, Eternal Flame and a longer burn on a build that clears wave 30. Eternal
 *   Flame's burns live in DoT rings (src/sim/ailments/rings.ts); M1's one record per burn
 *   stack took seconds per run here. The budget is 50 ms per warm run.
 * - effects: the effect queue, 30 s at wave 30 with normal's build plus a trigger that
 *   explodes every kill (src/sim/effects/) but its own explosions' (rule 3). It pins its start
 *   wave like hits.
 * - poisonBoss: DoT rings (src/sim/ailments/rings.ts) under many stacks, 30 s on one immortal,
 *   stationary boss on fixture data, hit about 32 times a second by a build whose poison lasts
 *   16 s. Two variants draw the same rolls: poisonChance 0.99 keeps about 500 stacks on the
 *   boss, 0.01 about 5. A ring's step costs the same whatever its stacks, so the ratio of their
 *   p50s must stay under 1.3 (docs/v3 C3.8). It ignores --start-wave.
 * - stressM1: the stress fixture (stressData and stressStats, src/sim/testing.ts), 30 s from
 *   wave 30 with about 300 enemies alive from tick 300 on, under M1's attack alone. It is the
 *   first of the stress family, the scenarios on that fixture that the C4 systems add (docs/v3
 *   C4 design §7). A stress-family scenario ignores --start-wave, and its report adds its
 *   workload: one untimed run's average alive over ticks 301–1800, its peaks and its counters.
 * - stress: the stress family's gated scenario (the STRESS gate of docs/v3 C4 design §0.5),
 *   grown with the C4 systems. v1 (C4.6) adds four ground zone triggers on the signature's hits,
 *   one source each, which hold about 64 live effect zones: 'outer.fire', 'outer.ice' (slowing)
 *   and 'outer.poison' (poison only) on hits, 'outer.aura' on crits. Their zones kill few enough
 *   that stressStats' damage keeps the alive band. Its report adds the zone workload: pulses,
 *   zone hits and hits per pulse, and the average live effect zones over ticks 301–1800.
 *
 *   npm run bench -- [--scenario normal|hits|ailments|effects|poisonBoss|stressM1|stress]
 *     [--runs 50]
 *     [--warmup 5] [--seed 1] [--start-wave 30]
 *   npm run bench -- --check [--write] [--scenario <id>]
 *
 * --runs and --warmup default to the scenario's own counts.
 *
 * --check is CI's performance check (docs/v3/implementation-plan-v3.md §6, benchCheck.ts): in one
 * process, each scenario (each variant of poisonBoss) times its runs alternating with runs of
 * normal, the reference, at the scenarios' own counts, seeds from 1 and normal's start wave 30.
 * It fails when a scenario's ratio to the reference exceeds 1.5 × the ratio recorded in
 * bench.baseline.json, or when normal's median run exceeds 50 ms. --write records the ratios
 * instead. --scenario limits the check to one scenario; normal alone checks only its budget.
 * A stress-family scenario also fails when its seed-1 run's average alive leaves 280–320, which
 * pins its workload, and prints a stress report line: its median, its ratio, the median of the
 * normal runs timed with it and its workload (the STRESS gate of docs/v3 C4 design §0.5).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGameData, targetDamage } from '../../src/data';
import type { GameData, StatBlock } from '../../src/data';
import type { StatExtras } from '../../src/data/stats';
import type { TriggerSpec } from '../../src/data/triggers';
import { COUNTER_IDS, createSimulation, MAX_RUN_SECONDS, NO_INPUT, TICK_RATE } from '../../src/sim';
import type { CounterId, RunConfig } from '../../src/sim';
import type { TestModule } from '../../src/sim/rules';
import {
  centerTriggers,
  makeStats,
  makeTestData,
  PANDEMIC_MODS,
  PANDEMIC_TRIGGER,
  STRESS_START_WAVE,
  stressData,
  stressStats,
} from '../../src/sim/testing';
import {
  ALIVE_MAX,
  ALIVE_MIN,
  checkBench,
  entryRatio,
  formatBaseline,
  median,
  parseBaseline,
} from './benchCheck';
import type { BenchTimings, EntryTimings } from './benchCheck';
import { quantile } from './report';

const SCENARIO_IDS = [
  'normal',
  'hits',
  'ailments',
  'effects',
  'poisonBoss',
  'stressM1',
  'stress',
] as const;
/** Length of a stress-scenario run (docs/v3/implementation-plan-v3.md §6). */
const STRESS_SECONDS = 30;
/** The hits scenario's start wave, whatever --start-wave says. */
const HITS_START_WAVE = 40;
/** The effects scenario's start wave, whatever --start-wave says: normal's default. */
const EFFECTS_START_WAVE = 30;
/** --start-wave's default, and the start wave of every --check. */
const DEFAULT_START_WAVE = 30;
/** A stress-family run's average alive counts the ticks after this one (docs/v3 C4 design §7.2). */
const ALIVE_FROM_TICK = 300;
/** The ratios --check compares against (benchCheck.ts). */
export const BASELINE_FILE = fileURLToPath(new URL('./bench.baseline.json', import.meta.url));
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
  /**
   * Variants, each with the scenario's warm-up runs and runs: every variant's warm-up runs come
   * first, then the timed runs take turns, the order of the variants reversed every round. Timed
   * one variant after the other, the later one gains from the JIT's further work: about 1.3–1.8
   * for 500 ÷ 5 poison stacks against 0.8 the other way round and 1.05 taking turns. With two,
   * the ratio of their p50s (first ÷ second) is reported.
   */
  readonly variants?: readonly string[];
  /** Game data of its runs; the real game data without it. */
  data?(): GameData;
  /** Test modules of its runs (createSimulation's testModules), for workloads data cannot set. */
  readonly testModules?: readonly TestModule[];
  /**
   * A stress-family scenario: on the stress fixture, with its workload in the report and its
   * average alive checked against ALIVE_MIN–ALIVE_MAX by --check.
   */
  readonly stress?: boolean;
  /** Config of one run; runs differ only in their seed. */
  config(seed: number, startWave: number, variant: string): RunConfig;
}

/**
 * stress v1's zone triggers (docs/v3 C4 design §7.3), each on the signature's hits only, so
 * zone hits never trigger them (L2), and each able to hold its source's 16 zones at stressM1's
 * rates (about 24 hits and 6 crits a second).
 */
const STRESS_ZONE_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'outer.fire',
    {
      on: 'hit',
      when: [{ hitIs: 'signature' }],
      do: [{ kind: 'groundZone', radius: 40, durationSec: 1, damagePctPerSec: 0.2 }],
    },
  ],
  [
    'outer.ice',
    {
      on: 'hit',
      when: [{ hitIs: 'signature' }],
      do: [{ kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0.05, slow: 0.3 }],
    },
  ],
  [
    'outer.poison',
    {
      on: 'hit',
      when: [{ hitIs: 'signature' }],
      do: [
        {
          kind: 'groundZone',
          radius: 60,
          durationSec: 2,
          damagePctPerSec: 0,
          ailment: 'poison',
          ailmentStacks: 1,
        },
      ],
    },
  ],
  [
    'outer.aura',
    {
      on: 'crit',
      when: [{ hitIs: 'signature' }],
      do: [{ kind: 'groundZone', radius: 80, durationSec: 3, damagePctPerSec: 0.1 }],
    },
  ],
];
const STRESS_EXTRAS: StatExtras = {
  triggers: STRESS_ZONE_TRIGGERS.map(([source, spec]) => ({ source, spec })),
  conversions: [],
  emitters: [],
};

/** The poisonBoss scenario's poison chance per variant. */
const POISON_BOSS_CHANCE: Readonly<Record<string, number>> = {
  '500 stacks': 0.99,
  '5 stacks': 0.01,
};

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

/**
 * A stress-family scenario: `build`'s runs on the stress fixture, 20 timed and 3 warm-up runs
 * of 30 s from STRESS_START_WAVE, whatever --start-wave says.
 */
function stressScenario(
  build: () => Pick<RunConfig, 'stats' | 'rules' | 'signature'>,
  testModules?: readonly TestModule[],
): Scenario {
  return {
    runs: 20,
    warmup: 3,
    seconds: STRESS_SECONDS,
    // §6's stress-scenario budget, on its reference machine; --check gates the ratio instead.
    targetMs: 50,
    startWave: STRESS_START_WAVE,
    stress: true,
    data: stressData,
    ...(testModules === undefined ? {} : { testModules }),
    config: (seed) => ({
      seed,
      ...build(),
      startWave: STRESS_START_WAVE,
      mode: 'auto',
      maxTicks: STRESS_SECONDS * TICK_RATE,
    }),
  };
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
    // No budget of its own: benchAB.ts --inproc gates it on its ratio to the previous commit
    // (docs/v3 C4 design §0.4). This is §6's stress-scenario budget.
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
    runs: 20,
    warmup: 3,
    seconds: STRESS_SECONDS,
    targetMs: 50,
    // The start wave's frontier damage, every hit ignites, burns last 1.2 s + 0.4 s (slowBurn),
    // then Eternal Flame (no stack cap, half duration) and Pandemic (spread on death). Immortal.
    config: (seed, startWave) => ({
      seed,
      stats: makeStats(
        {
          damage: targetDamage(startWave),
          igniteChance: 1,
          burnDuration: 1.6,
          maxLife: 1e12,
        },
        PANDEMIC_MODS,
        centerTriggers([PANDEMIC_TRIGGER]),
      ),
      rules: [{ id: 'eternalFlame', durationMore: -0.5 }],
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
      stats: normalStats(
        EFFECTS_START_WAVE,
        centerTriggers([{ on: 'kill', do: [{ kind: 'explode', radius: 90, damagePct: 0.5 }] }]),
      ),
      rules: [],
      startWave: EFFECTS_START_WAVE,
      mode: 'auto',
      maxTicks: STRESS_SECONDS * TICK_RATE,
    }),
  },
  poisonBoss: {
    runs: 20,
    warmup: 3,
    seconds: STRESS_SECONDS,
    // The gate is the variants' p50 ratio; this is §6's stress-scenario budget.
    targetMs: 50,
    startWave: 1,
    variants: Object.keys(POISON_BOSS_CHANCE),
    // Each wave is one boss that never moves or dies, and the next wave is 60 s away.
    data: () =>
      makeTestData({
        waves: { rules: [], bossEvery: 1, waveTimerSec: 60 },
        enemies: { boss: { hpMult: 1e12, speed: 0 } },
      }),
    // 8 attacks of 4 projectiles a second, all on the boss: about 32 poison rolls a second,
    // each a 16 s stack.
    config: (seed, _startWave, variant) => ({
      seed,
      stats: makeStats({
        poisonChance: POISON_BOSS_CHANCE[variant] ?? 0,
        poisonDuration: 16,
        attackSpeed: 8,
        projectileCount: 4,
        maxLife: 1e12,
      }),
      rules: [],
      startWave: 1,
      mode: 'auto',
      maxTicks: STRESS_SECONDS * TICK_RATE,
    }),
  },
  // About 300 alive from tick 300 on, under M1's attack (docs/v3 C4 design §7.2).
  stressM1: stressScenario(() => ({ stats: stressStats(), rules: [] })),
  // v1 (C4.6): stressM1 plus the zones; stressStats' damage keeps 287 alive at seed 1.
  stress: stressScenario(() => ({ stats: stressStats({}, STRESS_EXTRAS), rules: [] })),
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

function runOnce(
  config: RunConfig,
  data: GameData,
  testModules: readonly TestModule[] = [],
): Sample {
  const start = performance.now();
  const sim = createSimulation(config, data, testModules);
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

/** What an untimed run of a stress-family scenario did (docs/v3 C4 design §7.2). */
interface Workload {
  /** Alive enemies after each tick past ALIVE_FROM_TICK, averaged. */
  readonly averageAlive: number;
  readonly peakAlive: number;
  /** Most projectiles in flight after a tick. */
  readonly peakProjectiles: number;
  readonly kills: number;
  /** Zones created, zone pulses, and the hits of the pulses: in all and the most in one. */
  readonly zones: number;
  readonly pulses: number;
  readonly zoneHits: number;
  readonly peakPulseHits: number;
  /** Live effect zones (not the signature's) after each tick past ALIVE_FROM_TICK, averaged. */
  readonly averageEffectZones: number;
  /** The run's counters that are not 0, in COUNTER_IDS order. */
  readonly counters: readonly (readonly [CounterId, number])[];
}

/** The workload of an untimed run of `config`. */
function measureWorkload(
  config: RunConfig,
  data: GameData,
  testModules: readonly TestModule[] = [],
): Workload {
  const sim = createSimulation(config, data, testModules);
  const { state } = sim;
  let aliveSum = 0;
  let aliveTicks = 0;
  let peakAlive = 0;
  let peakProjectiles = 0;
  let zones = 0;
  let pulses = 0;
  let zoneHits = 0;
  let peakPulseHits = 0;
  let effectZoneSum = 0;
  while (!state.finished) {
    for (const event of sim.step(NO_INPUT)) {
      if (event.type === 'zone') zones++;
      else if (event.type === 'pulse' && event.kind === 'zone') {
        pulses++;
        zoneHits += event.hits;
        if (event.hits > peakPulseHits) peakPulseHits = event.hits;
      }
    }
    let alive = 0;
    for (const enemy of state.enemies) if (enemy.alive) alive++;
    if (state.tick > ALIVE_FROM_TICK) {
      aliveSum += alive;
      aliveTicks++;
      for (let i = 0; i < state.zoneCount; i++) if (state.zones.signature[i] === 0) effectZoneSum++;
    }
    if (alive > peakAlive) peakAlive = alive;
    if (state.projectiles.length > peakProjectiles) peakProjectiles = state.projectiles.length;
  }
  const result = sim.result();
  return {
    averageAlive: aliveTicks === 0 ? NaN : aliveSum / aliveTicks,
    peakAlive,
    peakProjectiles,
    kills: result.kills,
    zones,
    pulses,
    zoneHits,
    peakPulseHits,
    averageEffectZones: aliveTicks === 0 ? NaN : effectZoneSum / aliveTicks,
    counters: COUNTER_IDS.filter((id) => result.counters[id] !== 0).map(
      (id) => [id, result.counters[id]] as const,
    ),
  };
}

/** The workload as report text: everything but the average alive. */
function workloadText(workload: Workload): string {
  const counters =
    workload.counters.length === 0
      ? 'none'
      : workload.counters.map(([id, value]) => `${id} ${value}`).join(', ');
  const zones =
    workload.zones === 0
      ? ''
      : `${workload.zones} zones, average ${workload.averageEffectZones.toFixed(1)} live ` +
        `effect zones, ${workload.pulses} pulses, ${workload.zoneHits} zone hits ` +
        `(${(workload.pulses === 0 ? 0 : workload.zoneHits / workload.pulses).toFixed(2)} ` +
        `a pulse, at most ${workload.peakPulseHits}), `;
  return (
    `peak ${workload.peakAlive} alive, peak ${workload.peakProjectiles} projectiles, ` +
    `${workload.kills} kills, ${zones}counters: ${counters}`
  );
}

/**
 * The most poison stacks an enemy holds in an untimed run of `config`, as its ailmentApplied
 * events report them; scanning the events would weigh on the timed runs of the busier variant.
 */
function maxPoisonStacks(config: RunConfig, data: GameData): number {
  const sim = createSimulation(config, data);
  let most = 0;
  while (!sim.state.finished) {
    for (const event of sim.step(NO_INPUT)) {
      if (event.type === 'ailmentApplied' && event.ailment === 'poison' && event.stacks > most) {
        most = event.stacks;
      }
    }
  }
  return most;
}

/** A check entry's name: the scenario id, with its variant in parentheses. */
const entryName = (id: ScenarioId, variant: string): string =>
  variant === '' ? id : `${id} (${variant})`;

/**
 * Every entry --check times, in check order: each scenario but normal, the reference, once per
 * variant. bench.baseline.json records a ratio for each.
 */
export const CHECK_ENTRIES: readonly string[] = SCENARIO_IDS.filter(
  (id) => id !== 'normal',
).flatMap((id) => (SCENARIOS[id].variants ?? ['']).map((variant) => entryName(id, variant)));

/** A timed check, with the workload of each stress-family entry by entry name. */
interface CheckTimings {
  readonly timings: BenchTimings;
  readonly workloads: ReadonlyMap<string, Workload>;
}

/**
 * Times the check of scenarios `ids`, normal's warm-up runs first. Each other scenario runs its
 * warm-up runs, then its timed rounds: in each, one normal run and one run of every variant,
 * the order reversed every other round, so the reference runs share the scenario's conditions.
 * Checking normal alone times its own runs only. A stress-family scenario first measures the
 * workload of an untimed seed-1 run of each variant.
 */
function timeCheck(ids: readonly ScenarioId[]): CheckTimings {
  const normal = SCENARIOS.normal;
  const realData = loadGameData();
  const referenceRun = (i: number): number =>
    runOnce(normal.config(1 + i, DEFAULT_START_WAVE, ''), realData).ms;
  for (let i = 0; i < normal.warmup; i++) referenceRun(normal.runs + i);
  const reference: number[] = [];
  const entries: EntryTimings[] = [];
  const workloads = new Map<string, Workload>();
  const others = ids.filter((id) => id !== 'normal');
  if (others.length === 0) {
    for (let i = 0; i < normal.runs; i++) reference.push(referenceRun(i));
  }
  for (const id of others) {
    const scenario = SCENARIOS[id];
    const data = scenario.data?.() ?? realData;
    const startWave = scenario.startWave ?? DEFAULT_START_WAVE;
    const variants = scenario.variants ?? [''];
    const run = (variant: string, i: number): number =>
      runOnce(scenario.config(1 + i, startWave, variant), data, scenario.testModules).ms;
    if (scenario.stress === true) {
      for (const variant of variants) {
        const config = scenario.config(1, startWave, variant);
        workloads.set(entryName(id, variant), measureWorkload(config, data, scenario.testModules));
      }
    }
    for (const variant of variants) {
      for (let i = 0; i < scenario.warmup; i++) run(variant, scenario.runs + i);
    }
    const referenceMs: number[] = [];
    const ms: number[][] = variants.map(() => []);
    for (let i = 0; i < scenario.runs; i++) {
      // Slot 0 is the reference, slot v + 1 variant v.
      for (let n = 0; n <= variants.length; n++) {
        const slot = i % 2 === 0 ? n : variants.length - n;
        if (slot === 0) referenceMs.push(referenceRun(i));
        else (ms[slot - 1] as number[]).push(run(variants[slot - 1] as string, i));
      }
    }
    reference.push(...referenceMs);
    variants.forEach((variant, v) => {
      const name = entryName(id, variant);
      const alive = workloads.get(name)?.averageAlive;
      entries.push({
        id: name,
        ms: ms[v] as number[],
        referenceMs,
        ...(alive === undefined ? {} : { alive }),
      });
    });
  }
  return { timings: { reference, entries }, workloads };
}

/** --check: times scenarios `ids` against normal and checks or, with `write`, records them. */
function check(ids: readonly ScenarioId[], write: boolean): void {
  const file = relative(process.cwd(), BASELINE_FILE);
  const recorded = existsSync(BASELINE_FILE)
    ? parseBaseline(readFileSync(BASELINE_FILE, 'utf8'))
    : null;
  const { timings, workloads } = timeCheck(ids);
  const result = checkBench(timings, recorded, CHECK_ENTRIES, write);
  console.log(`bench check: ratio to normal's median run, against ${file}`);
  for (const line of result.lines) console.log(line);
  for (const entry of timings.entries) {
    const workload = workloads.get(entry.id);
    if (workload === undefined) continue;
    console.log(
      `stress report ${entry.id}: median ${median(entry.ms).toFixed(2)} ms, ` +
        `ratio ${entryRatio(entry).toFixed(3)}, ` +
        `normal median ${median(entry.referenceMs).toFixed(2)} ms, ` +
        `average alive ${workload.averageAlive.toFixed(1)}; ${workloadText(workload)}`,
    );
  }
  if (write) {
    writeFileSync(BASELINE_FILE, formatBaseline(result.baseline));
    console.log(`wrote ${file}`);
  }
  if (!result.ok) process.exitCode = 1;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      scenario: { type: 'string' },
      runs: { type: 'string' },
      warmup: { type: 'string' },
      seed: { type: 'string' },
      'start-wave': { type: 'string' },
      check: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
    },
  });
  const id = values.scenario ?? 'normal';
  if (!isScenarioId(id)) {
    throw new Error(`--scenario must be one of ${SCENARIO_IDS.join(', ')}, got '${id}'`);
  }
  if (values.check) {
    for (const name of ['runs', 'warmup', 'seed', 'start-wave'] as const) {
      if (values[name] !== undefined) {
        throw new Error(`--${name} does not go with --check, whose workloads are fixed`);
      }
    }
    check(values.scenario === undefined ? SCENARIO_IDS : [id], values.write);
    return;
  }
  if (values.write) throw new Error('--write records the ratios of --check; add --check');
  const scenario = SCENARIOS[id];
  const runs = positiveInt('runs', values.runs ?? String(scenario.runs));
  const warmup = positiveInt('warmup', values.warmup ?? String(scenario.warmup), 0);
  const seed = positiveInt('seed', values.seed ?? '1', 0);
  const startWave =
    scenario.startWave ??
    positiveInt('start-wave', values['start-wave'] ?? String(DEFAULT_START_WAVE));
  const data = scenario.data?.() ?? loadGameData();
  const variants = scenario.variants ?? [''];
  const modules = scenario.testModules;
  const configFor = (variant: string, i: number): RunConfig =>
    scenario.config(seed + i, startWave, variant);
  for (const variant of variants) {
    for (let i = 0; i < warmup; i++) runOnce(configFor(variant, runs + i), data, modules);
  }
  const samples: Sample[][] = variants.map(() => []);
  for (let i = 0; i < runs; i++) {
    for (let n = 0; n < variants.length; n++) {
      const v = i % 2 === 0 ? n : variants.length - 1 - n;
      (samples[v] as Sample[]).push(runOnce(configFor(variants[v] as string, i), data, modules));
    }
  }
  const p50s = variants.map((variant, v) => {
    const poison =
      scenario.variants === undefined ? 0 : maxPoisonStacks(configFor(variant, 0), data);
    const timed = samples[v] as Sample[];
    const p50 = report(id, variant, scenario, timed, poison, { runs, warmup, startWave });
    if (scenario.stress === true) {
      const workload = measureWorkload(configFor(variant, 0), data, modules);
      console.log(
        `stress workload (seed ${seed}): average alive ${workload.averageAlive.toFixed(1)} ` +
          `over ticks ${ALIVE_FROM_TICK + 1}+ (--check band ${ALIVE_MIN}–${ALIVE_MAX} at seed 1), ` +
          workloadText(workload),
      );
    }
    return p50;
  });
  if (p50s.length === 2) {
    const [first, second] = p50s as [number, number];
    const [a, b] = scenario.variants as [string, string];
    console.log(`p50 ratio ${a} / ${b}: ${(first / second).toFixed(3)}`);
  }
}

/**
 * Prints a scenario variant's timings and workload, with the most poison stacks an enemy held
 * when not 0; returns its p50 run time.
 */
function report(
  id: ScenarioId,
  variant: string,
  scenario: Scenario,
  samples: readonly Sample[],
  poison: number,
  { runs, warmup, startWave }: { runs: number; warmup: number; startWave: number },
): number {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const totalMs = ms.reduce((sum, value) => sum + value, 0);
  const totalTicks = samples.reduce((sum, s) => sum + s.ticks, 0);
  const mean = (pick: (s: Sample) => number): number =>
    samples.reduce((sum, s) => sum + pick(s), 0) / samples.length;
  const p95 = quantile(ms, 0.95);
  const { seconds, targetMs } = scenario;
  const name = `${id === 'normal' ? '' : ` ${id}`}${variant === '' ? '' : ` (${variant})`}`;

  console.log(
    `bench${name}: ${runs} runs × ${seconds} s ` +
      `(${seconds * TICK_RATE} ticks), start wave ${startWave}, ${warmup} warm-up runs, ` +
      (scenario.data === undefined ? 'real game data' : 'fixture data'),
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
      `up to ${Math.max(...samples.map((s) => s.maxAlive))} enemies alive` +
      (poison > 0 ? `, up to ${poison} poison stacks on one enemy` : ''),
  );
  return quantile(ms, 0.5);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
