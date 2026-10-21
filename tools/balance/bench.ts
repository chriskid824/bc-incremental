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
 *   grown with the C4 systems. v1 (C4.6) added four ground zone triggers on M1's hits, which
 *   held about 64 live effect zones. v2 (C4.7) is the heaviest plausible 熔核 (R1-12, docs/v3
 *   C4 design §7.3): magmaBomb at 12 bombs a second, 6 firings of 2, with 熔核's own zone
 *   sources on their own events (爐光 and 瘟爆 on explode, 毒雲 on a poisoned enemy's kill),
 *   霜焰's explosion frost and slowing fire zones, and poison rolls; a third of stressStats'
 *   damage keeps the alive band. Its report adds the zone workload: zones created per source,
 *   pulses, zone hits and hits per pulse, and the average live effect and signature zones over
 *   ticks 301–1800; and the bombs: bombs a second and per firing, explosions and their hits,
 *   freezes, ignites and µs per firing's lob aim. v3 (C4.14, the C4 final) adds 雷網全開: a
 *   shock chance of .3 and 雷網, the segment grant, on outer.lightning, whose judgements link
 *   the shocked enemies 4 times a second; its report adds the segment workload: judgements, the
 *   endpoints, links and hits of each, and the average shocked. Its local report (not --check)
 *   adds segmentsAllShocked: its runs with every alive enemy shocked before each judgement,
 *   timed in turn with normal's, and their ratio, printed and never gated (docs/v3 C4 design
 *   §7.3, §7.6).
 * - shots: a stress-family scenario (C4.12) whose triggers fire rings of small projectiles
 *   (src/sim/effects/execute.ts): 12 from the player 5 times a second and 4 from each kill, on
 *   M1's attack. Its report's peak shots counts them (the shot pool's), and its local report
 *   (not --check) adds the cap probe: a ring of 64 bouncing shots every 2 ticks on top, which
 *   fills the pool, and the µs per tick at its PROJECTILE_CAP shots against the scenario's own.
 * - fan: a stress-family scenario (C4.19), 霜晶's iceFan at 7.5 rounds a second of 9 cones
 *   (attackSpeed 12, projectileCount 6 and the fan's 3), each through two enemies, with a sixth
 *   of the damage of the stress start wave's target (src/sim/emitters/fan.ts).
 * - arc: a stress-family scenario (C4.20), 雷塔's triphaseArc under 六線圈, 6 discharges a second
 *   at two targets each, chaining 8 times (chainCount 6 and the arc's 2) from both by a test
 *   policy that forks every jump by 2 and adds an extra jump on half of them, so its attacks
 *   reach CHAIN_HIT_CAP, with a sixth of the damage of the stress start wave's target
 *   (src/sim/emitters/arc.ts).
 * - hive: normal's 3-minute runs (C5.5) with 蜂巢's swarm as the signature, filled to the summon
 *   cap of 24 by a test module (20 drones and 4 turrets, src/sim/systems/drones.ts), and a test
 *   module's onCenterEvent hook that counts the droneImpact events, so the listener path runs
 *   (docs/v3 C5 design §7.4). It is not a stress-family scenario: real game data, normal's
 *   build and start wave. Its report adds its summon workload, from one untimed run: the
 *   summons, drone impacts, turret firings and their shots, the droneImpact events its listener
 *   counted, and its median against §6's 50 ms for a 3-minute run, printed and never a failure.
 *
 *   npm run bench --
 *     [--scenario normal|hits|ailments|effects|poisonBoss|stressM1|stress|shots|fan|arc|hive]
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
 * normal runs timed with it and its workload (the STRESS gate of docs/v3 C4 design §0.5). hive
 * prints a summon report line: its median against 50 ms, its ratio, the median of the normal
 * runs timed with it and the summon workload of its seed-1 run.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGameData, targetDamage } from '../../src/data';
import type { GameData, StatBlock } from '../../src/data';
import type { SourcedEmitter } from '../../src/data/emitters';
import type { Modifier, StatExtras } from '../../src/data/stats';
import type { TriggerSpec } from '../../src/data/triggers';
import {
  COUNTER_IDS,
  createSimulation,
  DRONE_KIND_DRONE,
  MAX_RUN_SECONDS,
  NO_INPUT,
  TICK_RATE,
} from '../../src/sim';
import type { CounterId, RunConfig } from '../../src/sim';
import { addShock } from '../../src/sim/ailments/shock';
import { PROJECTILE_CAP } from '../../src/sim/caps';
import { EVENT } from '../../src/sim/effects/types';
import { aimDense, beginAim } from '../../src/sim/emitters/lob';
import type { TestModule } from '../../src/sim/rules';
import type { RunContext } from '../../src/sim/systems/context';
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
  NORMAL_BUDGET_MS,
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
  'shots',
  'fan',
  'arc',
  'hive',
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
  /**
   * Config of a stress-family scenario's cap probe run for a seed (capProbe), which only the
   * local report runs; --check does not (docs/v3 C4 design §7.6).
   */
  capProbe?(seed: number): RunConfig;
  /**
   * Its local report adds segmentsAllShocked (ALL_SHOCKED): its runs with every alive enemy
   * shocked before each segment judgement, timed in turn with normal's; --check does not run it
   * (docs/v3 C4 design §7.3, §7.6).
   */
  readonly allShocked?: boolean;
  /**
   * A summon scenario (hive): --check and its local report add the summon workload of an
   * untimed seed-1 run (summonWorkload) and print its median against §6's 50 ms for a 3-minute
   * run, never a failure (docs/v3 C5 design §7.4).
   */
  readonly summons?: boolean;
}

/**
 * stress v2's zone sources (R1, docs/v3 C4 design §7.3), 熔核's own on their own events: 爐光
 * leaves a zone where each bomb explodes, 瘟爆 poisons each explosion's list, and 毒雲 leaves a
 * poison cloud where a poisoned enemy dies. Zone hits raise none of these events, so zones never
 * feed zones (L2).
 */
const R1_TRIGGERS: readonly (readonly [string, TriggerSpec])[] = [
  [
    'fusion.fire.aura',
    {
      on: 'explode',
      do: [{ kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0.25 }],
    },
  ],
  [
    'fusion.fire.poison',
    { on: 'explode', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }] },
  ],
  [
    'outer.poison',
    {
      on: 'kill',
      when: [{ victimHas: 'poison' }],
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
];
const R1_EXTRAS: StatExtras = {
  triggers: R1_TRIGGERS.map(([source, spec]) => ({ source, spec })),
  conversions: [],
  emitters: [],
};

/** 霜焰's frost on the explosion hits, and 爐光's bonus on the enemies in its zones. */
const R1_SCOPED: readonly Modifier[] = [
  {
    stat: 'frostOnHit',
    kind: 'flat',
    value: 0.3,
    scope: 'center',
    tags: ['area'],
    notTags: ['trigger'],
  },
  {
    stat: 'damage',
    kind: 'increased',
    value: 0.2,
    scope: 'center',
    when: [{ inZone: 'fusion.fire.aura' }],
  },
];

/** 霜焰's 霜火地: the bombs' fire zones slow by 30%, as its B1 module will set. */
const FROST_FIRE: TestModule = (b) => {
  const lob = b.signature().lob;
  if (lob !== null) lob.zone.slow = 0.3;
};

/**
 * stress v3's 雷網 (docs/v3 C4 design §7.3): the segment grant on outer.lightning, which every
 * 0.25 s links each shocked enemy to its 2 nearest shocked others within 200 and hits every
 * enemy on a link for 10% of the damage stat, then gives it a shock stack.
 */
const WEB: SourcedEmitter = {
  source: 'outer.lightning',
  grant: {
    kind: 'segment',
    endpoints: 'shocked',
    links: 2,
    range: 200,
    damagePct: 0.1,
    shockStacks: 1,
  },
};
const R1_WEB_EXTRAS: StatExtras = { ...R1_EXTRAS, emitters: [WEB] };

/**
 * segmentsAllShocked's module: on a tick a segment emitter judges, every alive enemy takes a
 * shock stack first (the tick hooks run before the segment stage), so every one is an endpoint.
 */
const ALL_SHOCKED: TestModule = (b) => {
  b.hook('tick', (ctx) => {
    let due = false;
    for (const em of ctx.sys.segments.emitters) if (em.timer + 1 >= em.interval) due = true;
    if (!due) return;
    for (const enemy of ctx.enemies) if (enemy.alive) addShock(ctx, enemy, 1, 0);
  });
};

/**
 * The shots scenario's projectiles (docs/v3 C4 design §7.3), all from 'outer.barrage': a ring of
 * 12 small projectiles from the player 5 times a second, and a ring of 4 from each kill. A ring's
 * shots fly straight and end on the first enemy they hit or at the arena's edge.
 */
const SHOTS_TRIGGERS: readonly TriggerSpec[] = [
  {
    on: 'periodic',
    every: 0.2,
    do: [{ kind: 'projectiles', count: 12, aim: 'radial', from: 'player', damagePct: 0.1 }],
  },
  {
    on: 'kill',
    do: [{ kind: 'projectiles', count: 4, aim: 'radial', from: 'event', damagePct: 0.1 }],
  },
];

/**
 * The shots cap probe's ring (capProbe): 64 shots from the player every 2 ticks, each bouncing
 * off the arena's edge 6 times, more than the shot pool holds.
 */
const CAP_PROBE_TRIGGER: TriggerSpec = {
  on: 'periodic',
  every: 2 / TICK_RATE,
  do: [
    { kind: 'projectiles', count: 64, aim: 'radial', from: 'player', bounce: 6, damagePct: 0.1 },
  ],
};

/**
 * The shots scenario's build, `triggers` from 'outer.barrage': stressStats' own damage, which
 * keeps the alive band (average 288.9 at seed 1).
 */
function shotsStats(triggers: readonly TriggerSpec[]): StatBlock {
  return stressStats(
    {},
    {
      triggers: triggers.map((spec) => ({ source: 'outer.barrage', spec })),
      conversions: [],
      emitters: [],
    },
  );
}

/**
 * The arc scenario's chain policy (docs/v3 C4 design §7.3, branch [1, 2]): every jump forks by 2,
 * and each jump hit adds an extra jump on half of them, so a discharge at two targets reaches
 * CHAIN_HIT_CAP's 32 hits by its fourth level.
 */
const ARC_POLICY: TestModule = (b) => {
  const spec = b.chainPolicy();
  spec.branchFirst = 2;
  spec.branchLater = 2;
  spec.extraJumpChance = 0.5;
};

/** The hive scenario's swarm (docs/v3 C5 design §7.4): 24 summons, the summon cap. */
export const HIVE_DRONES = 20;
export const HIVE_TURRETS = 4;

/** hive's test module that fills the swarm: its SwarmParams' counts, as a rule would write them. */
const HIVE_SWARM: TestModule = (b) => {
  const swarm = b.signature().swarm;
  if (swarm !== null) Object.assign(swarm, { drones: HIVE_DRONES, turrets: HIVE_TURRETS });
};

/** The droneImpact center events hive's listener has counted in this process, every run's. */
export const hiveListened = { impacts: 0 };

/**
 * hive's droneImpact listener: an onCenterEvent hook that counts the droneImpact events, so the
 * run takes the listener path (src/sim/effects/centerEvents.ts) as a build that listens does.
 */
const HIVE_LISTENER: TestModule = (b) =>
  void b.hook('onCenterEvent', (_ctx, ev) => {
    if (ev.event === EVENT.droneImpact) hiveListened.impacts++;
  });

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

/** What a stress-family scenario's runs vary: the build. */
type StressBuild = () => Pick<RunConfig, 'stats' | 'rules' | 'signature'>;

/** A run of `build` on the stress fixture: 30 s from STRESS_START_WAVE. */
const stressConfig = (seed: number, build: StressBuild): RunConfig => ({
  seed,
  ...build(),
  startWave: STRESS_START_WAVE,
  mode: 'auto',
  maxTicks: STRESS_SECONDS * TICK_RATE,
});

/**
 * A stress-family scenario: `build`'s runs on the stress fixture, 20 timed and 3 warm-up runs
 * of 30 s from STRESS_START_WAVE, whatever --start-wave says; `probe`, when given, is its cap
 * probe's build, and `allShocked` adds segmentsAllShocked to its local report.
 */
function stressScenario(
  build: StressBuild,
  testModules?: readonly TestModule[],
  probe?: StressBuild,
  allShocked = false,
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
    config: (seed) => stressConfig(seed, build),
    ...(probe === undefined ? {} : { capProbe: (seed: number) => stressConfig(seed, probe) }),
    ...(allShocked ? { allShocked } : {}),
  };
}

export const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = {
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
  // v3 (C4.14): v2, R1-12 (6 firings of 2 bombs a second; a third of stressStats' damage keeps
  // the alive band), with 雷網全開: shockChance .3 and 雷網.
  stress: stressScenario(
    () => ({
      stats: stressStats(
        {
          attackSpeed: 16,
          projectileCount: 3,
          poisonChance: 0.3,
          shockChance: 0.3,
          damage: targetDamage(STRESS_START_WAVE) / 7.5,
        },
        R1_WEB_EXTRAS,
        R1_SCOPED,
      ),
      rules: [],
      signature: { id: 'magmaBomb' },
    }),
    [FROST_FIRE],
    undefined,
    true,
  ),
  // C4.12: rings of small projectiles from the player and from each kill, on M1's attack; the
  // cap probe adds a ring that fills the shot pool.
  shots: stressScenario(
    () => ({ stats: shotsStats(SHOTS_TRIGGERS), rules: [] }),
    undefined,
    () => ({ stats: shotsStats([...SHOTS_TRIGGERS, CAP_PROBE_TRIGGER]), rules: [] }),
  ),
  // C4.19: 霜晶's fan, 7.5 rounds a second of 9 cones.
  fan: stressScenario(() => ({
    stats: stressStats({
      attackSpeed: 12,
      projectileCount: 6,
      damage: targetDamage(STRESS_START_WAVE) / 6,
    }),
    rules: [],
    signature: { id: 'iceFan' },
  })),
  // C4.20: 雷塔's arc under 六線圈, its chains forking by 2 at every jump up to CHAIN_HIT_CAP; a
  // sixth of the target's damage keeps the alive band (average 290.3 at seed 1).
  arc: stressScenario(
    () => ({
      stats: stressStats({ chainCount: 6, damage: targetDamage(STRESS_START_WAVE) / 6 }),
      rules: [{ id: 'sixCoils', coils: 6, targets: 2, damageMult: 0.55 }],
      signature: { id: 'triphaseArc' },
    }),
    [ARC_POLICY],
  ),
  // C5.5: normal's runs with the swarm as the signature, filled to the summon cap, and a
  // droneImpact listener (docs/v3 C5 design §7.4).
  hive: {
    runs: 50,
    warmup: 5,
    seconds: MAX_RUN_SECONDS,
    targetMs: 50,
    testModules: [HIVE_SWARM, HIVE_LISTENER],
    summons: true,
    config: (seed, startWave) => ({
      seed,
      stats: normalStats(startWave),
      rules: [],
      signature: { id: 'swarm' },
      startWave,
      mode: 'auto',
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
  /** Most projectiles and shot pool shots (bombs among them) in flight after a tick (N7). */
  readonly peakShots: number;
  readonly kills: number;
  /** Zones created, by source name: the signature's under 'signature'. */
  readonly zonesBySource: readonly (readonly [string, number])[];
  /** Zones created, zone pulses, and the hits of the pulses: in all and the most in one. */
  readonly zones: number;
  readonly pulses: number;
  readonly zoneHits: number;
  readonly peakPulseHits: number;
  /** Live effect and signature zones after each tick past ALIVE_FROM_TICK, averaged. */
  readonly averageEffectZones: number;
  readonly averageSignatureZones: number;
  /** Bombs lobbed, and the ticks that lobbed any: each one firing. */
  readonly bombs: number;
  readonly firings: number;
  /** Explosions, and the enemies their blasts hit. */
  readonly explosions: number;
  readonly explosionHits: number;
  /** freeze and ignite events. */
  readonly freezes: number;
  readonly ignites: number;
  /** Simulated seconds of the run. */
  readonly seconds: number;
  /** The run's counters that are not 0, in COUNTER_IDS order. */
  readonly counters: readonly (readonly [CounterId, number])[];
  /** Microseconds per firing's lob aim (lobAimMicros); null when the signature is not the lob. */
  readonly lobAimMicros: number | null;
  /** The shocked and the segment judgements (segmentWorkload). */
  readonly segments: SegmentWorkload;
}

/** What the segment stage did in an untimed run, and the shocked it judged (segmentWorkload). */
interface SegmentWorkload {
  /** Alive enemies holding shock after each tick past ALIVE_FROM_TICK, averaged. */
  readonly averageShocked: number;
  /** Judgements, and those with 2 endpoints or more: the ones that link and raise a pulse. */
  readonly judgements: number;
  readonly linked: number;
  /** Over the linked judgements: their endpoints, links and hits in all, and the most endpoints. */
  readonly endpoints: number;
  readonly links: number;
  readonly hits: number;
  readonly peakEndpoints: number;
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
  let peakShots = 0;
  const bySource = new Map<string, number>();
  let zones = 0;
  let pulses = 0;
  let zoneHits = 0;
  let peakPulseHits = 0;
  let effectZoneSum = 0;
  let signatureZoneSum = 0;
  let bombs = 0;
  let firings = 0;
  let explosions = 0;
  let explosionHits = 0;
  let freezes = 0;
  let ignites = 0;
  while (!state.finished) {
    let lobbed = false;
    for (const event of sim.step(NO_INPUT)) {
      switch (event.type) {
        case 'zone': {
          zones++;
          const name = event.signature ? 'signature' : (state.sources[event.source] ?? '?');
          bySource.set(name, (bySource.get(name) ?? 0) + 1);
          break;
        }
        case 'pulse':
          if (event.kind === 'zone') {
            pulses++;
            zoneHits += event.hits;
            if (event.hits > peakPulseHits) peakPulseHits = event.hits;
          }
          break;
        case 'lob':
          bombs++;
          lobbed = true;
          break;
        case 'explosion':
          explosions++;
          explosionHits += event.count;
          break;
        case 'freeze':
          freezes++;
          break;
        case 'ignite':
          ignites++;
          break;
        default:
          break;
      }
    }
    if (lobbed) firings++;
    let alive = 0;
    for (const enemy of state.enemies) if (enemy.alive) alive++;
    if (state.tick > ALIVE_FROM_TICK) {
      aliveSum += alive;
      aliveTicks++;
      for (let i = 0; i < state.zoneCount; i++) {
        if (state.zones.signature[i] === 0) effectZoneSum++;
        else signatureZoneSum++;
      }
    }
    if (alive > peakAlive) peakAlive = alive;
    const shots = state.projectiles.length + state.shotCount;
    if (shots > peakShots) peakShots = shots;
  }
  const result = sim.result();
  return {
    averageAlive: aliveTicks === 0 ? NaN : aliveSum / aliveTicks,
    peakAlive,
    peakShots,
    kills: result.kills,
    zonesBySource: [...bySource],
    zones,
    pulses,
    zoneHits,
    peakPulseHits,
    averageEffectZones: aliveTicks === 0 ? NaN : effectZoneSum / aliveTicks,
    averageSignatureZones: aliveTicks === 0 ? NaN : signatureZoneSum / aliveTicks,
    bombs,
    firings,
    explosions,
    explosionHits,
    freezes,
    ignites,
    seconds: result.ticks / TICK_RATE,
    counters: COUNTER_IDS.filter((id) => result.counters[id] !== 0).map(
      (id) => [id, result.counters[id]] as const,
    ),
    lobAimMicros: lobAimMicros(config, data, testModules),
    segments: segmentWorkload(config, data, testModules),
  };
}

/**
 * The segment workload of another untimed run of `config`, the same run, which a test module
 * watches: after each tick, its segment judgements (SegmentState: the serial, and the endpoints
 * and links of a judgement that raised a pulse; the segment emitters of one period judge on
 * different ticks) and, past ALIVE_FROM_TICK, the alive enemies holding shock.
 */
function segmentWorkload(
  config: RunConfig,
  data: GameData,
  testModules: readonly TestModule[],
): SegmentWorkload {
  const seen: { ctx: RunContext | null } = { ctx: null };
  const watch: TestModule = (b) => {
    b.hook('tick', (ctx) => {
      seen.ctx = ctx;
    });
  };
  const sim = createSimulation(config, data, [...testModules, watch]);
  let shockedSum = 0;
  let shockedTicks = 0;
  let linked = 0;
  let endpoints = 0;
  let links = 0;
  let hits = 0;
  let peakEndpoints = 0;
  while (!sim.state.finished) {
    const events = sim.step(NO_INPUT);
    const ctx = seen.ctx;
    if (ctx === null) continue;
    const sg = ctx.sys.segments;
    for (const event of events) {
      if (event.type !== 'pulse' || event.kind !== 'segment') continue;
      const ends = sg.ends.length;
      const i = sg.emitters.findIndex((em) => em.index === event.id);
      linked++;
      endpoints += ends;
      links += sg.lines[i]?.count ?? 0;
      hits += event.hits;
      if (ends > peakEndpoints) peakEndpoints = ends;
    }
    if (ctx.now > ALIVE_FROM_TICK) {
      const now = ctx.now;
      for (const enemy of ctx.enemies) {
        if (enemy.alive && enemy.shockStacks > 0 && enemy.shockUntil > now) shockedSum++;
      }
      shockedTicks++;
    }
  }
  return {
    averageShocked: shockedTicks === 0 ? NaN : shockedSum / shockedTicks,
    judgements: seen.ctx?.sys.segments.serial ?? 0,
    linked,
    endpoints,
    links,
    hits,
    peakEndpoints,
  };
}

/** Ticks between two timings of a firing's lob aim past ALIVE_FROM_TICK, and the repeats of each. */
const AIM_EVERY_TICKS = 30;
const AIMS_PER_TIMING = 50;

/**
 * Microseconds per firing's lob aim (beginAim, then aimDense for each of its bombs,
 * src/sim/emitters/lob.ts) in another untimed run of `config`, whose signature is magmaBomb;
 * printed, not asserted (docs/v3 C4 design §4.5, R23). Every AIM_EVERY_TICKS ticks past
 * ALIVE_FROM_TICK, after the tick's attacks, a test module times AIMS_PER_TIMING aims of a firing
 * of ceil(projectileCount) bombs. An aim rewrites only the lob's aim scratch (ctx.sys.lob), which
 * the next firing's aim writes anew, and the grid's last densest block, which every reader
 * finds anew; it draws nothing. Null for another signature.
 */
function lobAimMicros(
  config: RunConfig,
  data: GameData,
  testModules: readonly TestModule[],
): number | null {
  if (config.signature?.id !== 'magmaBomb') return null;
  let ms = 0;
  let aims = 0;
  const timer: TestModule = (b) =>
    b.hook('tick', (ctx) => {
      const em = ctx.emitters[0];
      if (ctx.now <= ALIVE_FROM_TICK || ctx.now % AIM_EVERY_TICKS !== 0 || em === undefined) {
        return;
      }
      const bombs = Math.ceil(ctx.projectileCount);
      const start = performance.now();
      for (let i = 0; i < AIMS_PER_TIMING; i++) {
        beginAim(ctx, em);
        for (let n = 0; n < bombs; n++) if (aimDense(ctx, em) === null) break;
      }
      ms += performance.now() - start;
      aims += AIMS_PER_TIMING;
    });
  const sim = createSimulation(config, data, [...testModules, timer]);
  while (!sim.state.finished) sim.step(NO_INPUT);
  return aims === 0 ? null : (ms * 1000) / aims;
}

/** A shots cap probe's timings (capProbe). */
interface CapProbe {
  /** Microseconds per tick past ALIVE_FROM_TICK of the scenario's own run. */
  readonly ownMicros: number;
  /** Microseconds per tick of the probe run's ticks that start with PROJECTILE_CAP shots live. */
  readonly fullMicros: number;
  /** Those ticks, and the probe run's projectilesCapped. */
  readonly fullTicks: number;
  readonly capped: number;
}

/**
 * The cap probe (docs/v3 C4 design §7.3, §7.4): an untimed run of the scenario's `config`, each
 * tick past ALIVE_FROM_TICK timed on its own, and one of `probe`, whose extra ring fills the shot
 * pool, each tick that starts with PROJECTILE_CAP shots live timed on its own. Printed by the
 * local report, not asserted.
 */
function capProbe(
  config: RunConfig,
  probe: RunConfig,
  data: GameData,
  testModules: readonly TestModule[] = [],
): CapProbe {
  // With `full`, the ticks that start with the pool full; otherwise those past ALIVE_FROM_TICK.
  const timeTicks = (run: RunConfig, full: boolean): readonly [number, number, number] => {
    const sim = createSimulation(run, data, testModules);
    const { state } = sim;
    let ms = 0;
    let ticks = 0;
    while (!state.finished) {
      const timed = full ? state.shotCount >= PROJECTILE_CAP : state.tick >= ALIVE_FROM_TICK;
      const start = performance.now();
      sim.step(NO_INPUT);
      if (timed) {
        ms += performance.now() - start;
        ticks++;
      }
    }
    return [
      ticks === 0 ? NaN : (ms * 1000) / ticks,
      ticks,
      sim.result().counters.projectilesCapped,
    ];
  };
  const [ownMicros] = timeTicks(config, false);
  const [fullMicros, fullTicks, capped] = timeTicks(probe, true);
  return { ownMicros, fullMicros, fullTicks, capped };
}

/** The workload as report text: everything but the average alive. */
function workloadText(workload: Workload): string {
  const counters =
    workload.counters.length === 0
      ? 'none'
      : workload.counters.map(([id, value]) => `${id} ${value}`).join(', ');
  const perSecond = (n: number): string => (n / workload.seconds).toFixed(1);
  const bombs =
    workload.bombs === 0
      ? ''
      : `${workload.bombs} bombs (${perSecond(workload.bombs)}/s, ` +
        `${(workload.bombs / workload.firings).toFixed(2)} per firing), ` +
        `${workload.explosions} explosions (` +
        `${(workload.explosions === 0 ? 0 : workload.explosionHits / workload.explosions).toFixed(2)} ` +
        `hits each), `;
  const zones =
    workload.zones === 0
      ? ''
      : `${workload.zones} zones (` +
        workload.zonesBySource.map(([source, n]) => `${source} ${n}`).join(', ') +
        `), average ${workload.averageEffectZones.toFixed(1)} live effect zones and ` +
        `${workload.averageSignatureZones.toFixed(1)} live signature zones, ` +
        `${workload.pulses} pulses, ${workload.zoneHits} zone hits ` +
        `(${(workload.pulses === 0 ? 0 : workload.zoneHits / workload.pulses).toFixed(2)} ` +
        `a pulse, at most ${workload.peakPulseHits}), `;
  const aim =
    workload.lobAimMicros === null
      ? ''
      : `, ${workload.lobAimMicros.toFixed(2)} µs per firing's lob aim`;
  return (
    `peak ${workload.peakAlive} alive, peak ${workload.peakShots} shots, ` +
    `${workload.kills} kills, ${bombs}${zones}${workload.freezes} freezes, ` +
    `${workload.ignites} ignites, ${segmentText(workload.segments)}counters: ${counters}${aim}`
  );
}

/** The segment workload as report text: the average shocked, and the judgements if any. */
function segmentText(segments: SegmentWorkload): string {
  const shocked = `average ${segments.averageShocked.toFixed(1)} shocked, `;
  if (segments.judgements === 0) return shocked;
  const per = (n: number): string => (segments.linked === 0 ? 0 : n / segments.linked).toFixed(1);
  return (
    shocked +
    `${segments.judgements} segment judgements (${segments.linked} with 2 endpoints or more: ` +
    `${per(segments.endpoints)} endpoints, ${per(segments.links)} links and ` +
    `${per(segments.hits)} hits each, at most ${segments.peakEndpoints} endpoints), `
  );
}

/** What an untimed run of a summon scenario did (summonWorkload). */
export interface SummonWorkload {
  /** Its drones and turrets, placed at tick 0. */
  readonly drones: number;
  readonly turrets: number;
  /** Impacts of drones (a repeat's impact has droneId −1). */
  readonly impacts: number;
  /** turretFire events, and the shots they tried. */
  readonly firings: number;
  readonly turretShots: number;
  /** The droneImpact center events its listener counted (hiveListened). */
  readonly listened: number;
  /** Most projectiles and shot pool shots in flight after a tick. */
  readonly peakShots: number;
  readonly kills: number;
}

/** The summon workload of an untimed run of `config`. */
export function summonWorkload(
  config: RunConfig,
  data: GameData,
  testModules: readonly TestModule[] = [],
): SummonWorkload {
  const sim = createSimulation(config, data, testModules);
  const { state } = sim;
  let drones = 0;
  for (let s = 0; s < state.droneCount; s++) {
    if (state.drones.kind[s] === DRONE_KIND_DRONE) drones++;
  }
  const listened = hiveListened.impacts;
  let impacts = 0;
  let firings = 0;
  let turretShots = 0;
  let peakShots = 0;
  while (!state.finished) {
    for (const event of sim.step(NO_INPUT)) {
      if (event.type === 'impact' && event.droneId >= 0) impacts++;
      else if (event.type === 'turretFire') {
        firings++;
        turretShots += event.count;
      }
    }
    const shots = state.projectiles.length + state.shotCount;
    if (shots > peakShots) peakShots = shots;
  }
  return {
    drones,
    turrets: state.droneCount - drones,
    impacts,
    firings,
    turretShots,
    listened: hiveListened.impacts - listened,
    peakShots,
    kills: sim.result().kills,
  };
}

/** The summon workload as report text. */
const summonText = (summons: SummonWorkload): string =>
  `${summons.drones} drones and ${summons.turrets} turrets, ${summons.impacts} drone impacts, ` +
  `${summons.listened} droneImpact events counted by its listener, ${summons.firings} turret ` +
  `firings (${summons.turretShots} shots), peak ${summons.peakShots} shots, ` +
  `${summons.kills} kills`;

/** A summon scenario's median against §6's budget for a 3-minute run: printed, never gated. */
const budgetText = (medianMs: number): string =>
  `median ${medianMs.toFixed(2)} ms against §6's ${NORMAL_BUDGET_MS} ms for a 3-minute run ` +
  `(${medianMs <= NORMAL_BUDGET_MS ? 'within' : 'OVER'}; printed, never a failure)`;

/**
 * segmentsAllShocked (docs/v3 C4 design §7.3): `runs` runs of `config(i)` with ALL_SHOCKED
 * among the test modules, each timed in turn with a normal run (seeds from `seed`, normal's
 * start wave 30), after `warmup` of each; prints their medians, the ratio and the probe run's
 * segment workload. Printed, never gated; --check does not run it (§7.6).
 */
function allShockedReport(
  config: (i: number) => RunConfig,
  data: GameData,
  testModules: readonly TestModule[],
  { runs, warmup, seed }: { runs: number; warmup: number; seed: number },
): void {
  const normal = SCENARIOS.normal;
  const realData = loadGameData();
  const modules = [...testModules, ALL_SHOCKED];
  const normalRun = (i: number): number =>
    runOnce(normal.config(seed + i, DEFAULT_START_WAVE, ''), realData).ms;
  const probeRun = (i: number): number => runOnce(config(i), data, modules).ms;
  for (let i = 0; i < warmup; i++) {
    normalRun(runs + i);
    probeRun(runs + i);
  }
  const normalMs: number[] = [];
  const probeMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    if (i % 2 === 0) {
      normalMs.push(normalRun(i));
      probeMs.push(probeRun(i));
    } else {
      probeMs.push(probeRun(i));
      normalMs.push(normalRun(i));
    }
  }
  const segments = segmentWorkload(config(0), data, modules);
  console.log(
    `segmentsAllShocked (report only, seeds from ${seed}): median ${median(probeMs).toFixed(2)} ` +
      `ms, ratio ${(median(probeMs) / median(normalMs)).toFixed(3)} to normal's median ` +
      `${median(normalMs).toFixed(2)} ms timed in turn; ${segmentText(segments)}` +
      `of ${runs} runs`,
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

/**
 * A timed check, with the workload of each stress-family entry and the summon workload of each
 * summon entry by entry name.
 */
interface CheckTimings {
  readonly timings: BenchTimings;
  readonly workloads: ReadonlyMap<string, Workload>;
  readonly summons: ReadonlyMap<string, SummonWorkload>;
}

/**
 * Times the check of scenarios `ids`, normal's warm-up runs first. Each other scenario runs its
 * warm-up runs, then its timed rounds: in each, one normal run and one run of every variant,
 * the order reversed every other round, so the reference runs share the scenario's conditions.
 * Checking normal alone times its own runs only. A stress-family scenario first measures the
 * workload of an untimed seed-1 run of each variant, and a summon scenario its summon workload.
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
  const summons = new Map<string, SummonWorkload>();
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
    if (scenario.summons === true) {
      for (const variant of variants) {
        const config = scenario.config(1, startWave, variant);
        summons.set(entryName(id, variant), summonWorkload(config, data, scenario.testModules));
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
  return { timings: { reference, entries }, workloads, summons };
}

/** --check: times scenarios `ids` against normal and checks or, with `write`, records them. */
function check(ids: readonly ScenarioId[], write: boolean): void {
  const file = relative(process.cwd(), BASELINE_FILE);
  const recorded = existsSync(BASELINE_FILE)
    ? parseBaseline(readFileSync(BASELINE_FILE, 'utf8'))
    : null;
  const { timings, workloads, summons } = timeCheck(ids);
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
  for (const entry of timings.entries) {
    const workload = summons.get(entry.id);
    if (workload === undefined) continue;
    console.log(
      `summon report ${entry.id}: ${budgetText(median(entry.ms))}, ` +
        `ratio ${entryRatio(entry).toFixed(3)}, ` +
        `normal median ${median(entry.referenceMs).toFixed(2)} ms; seed 1: ${summonText(workload)}`,
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
      if (scenario.capProbe !== undefined) {
        const probe = capProbe(configFor(variant, 0), scenario.capProbe(seed), data, modules);
        console.log(
          `cap probe (seed ${seed}): ${probe.fullMicros.toFixed(1)} µs per tick at ` +
            `${PROJECTILE_CAP} shots (${probe.fullTicks} ticks, projectilesCapped ` +
            `${probe.capped}), against ${probe.ownMicros.toFixed(1)} µs per tick of its own run ` +
            `past tick ${ALIVE_FROM_TICK}`,
        );
      }
      if (scenario.allShocked === true) {
        allShockedReport((i) => configFor(variant, i), data, modules ?? [], {
          runs,
          warmup,
          seed,
        });
      }
    }
    if (scenario.summons === true) {
      const summons = summonWorkload(configFor(variant, 0), data, modules);
      console.log(`summon workload (seed ${seed}): ${budgetText(p50)}; ${summonText(summons)}`);
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
