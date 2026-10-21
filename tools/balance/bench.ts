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
 * - stress: the stress family's gated scenario (the STRESS gate of docs/v3 C4 design §0.5 and
 *   C5 design §7.3), grown with the C4 and C5 systems. v1 (C4.6) added four ground zone
 *   triggers on M1's hits, which held about 64 live effect zones. v2 (C4.7) is the heaviest
 *   plausible 熔核 (R1-12, docs/v3 C4 design §7.3): magmaBomb at 12 bombs a second, 6 firings of
 *   2, with 熔核's own zone sources on their own events (爐光 and 瘟爆 on explode, 毒雲 on a
 *   poisoned enemy's kill), 霜焰's explosion frost and slowing fire zones, and poison rolls; a
 *   third of stressStats' damage keeps the alive band. Its report adds the zone workload: zones
 *   created per source, pulses, zone hits and hits per pulse, and the average live effect and
 *   signature zones over ticks 301–1800; and the bombs: bombs a second and per firing,
 *   explosions and their hits, freezes, ignites and µs per firing's lob aim. v3 (C4.14, the C4
 *   final) adds 雷網全開: a shock chance of .3 and 雷網, the segment grant, on outer.lightning,
 *   whose judgements link the shocked enemies 4 times a second; its report adds the segment
 *   workload: judgements, the endpoints, links and hits of each, and the average shocked. Its
 *   local report (not --check) adds segmentsAllShocked: its runs with every alive enemy shocked
 *   before each judgement, timed in turn with normal's, and their ratio, printed and never gated
 *   (docs/v3 C4 design §7.3, §7.6). v4 (C5.6, docs/v3 C5 design §7.3) adds impl §6's 32
 *   summons: 24 drones and 8 turrets granted on outer.summon at the summon cap of 32, flying and
 *   firing at m = 2 (Q3 (A)), their damage shares tuned so that its seed-1 average alive stays
 *   within 3 of stressBase's.
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
 * - stressBase: v3, the stress scenario as C4.14 left it, under its own key (C5.6, docs/v3 C5
 *   design §7.3), which keeps C4's ratio lineage; two JSON snapshots beside this file pin its
 *   seed-1 config and workload (bench.test.ts). --check prints stress − stressBase when it times
 *   both.
 *
 * hiveStress (C5.6, docs/v3 C5 design §7.4) is print-only: the stress fixture under 蜂巢's swarm
 * at 24 units with 螢火's pulse zones, timed only by --share and printed beside stress v4. It is
 * no scenario of SCENARIO_IDS, so --check neither times nor records it, and no alive band
 * applies to it.
 *
 *   npm run bench --
 *     [--scenario normal|hits|ailments|effects|poisonBoss|stressM1|stress|shots|fan|arc|hive|
 *       stressBase]
 *     [--runs 50]
 *     [--warmup 5] [--seed 1] [--start-wave 30]
 *   npm run bench -- --check [--write] [--scenario <id>]
 *   npm run bench -- --share [--procs N] [--rounds R]
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
 *
 * --share is STRESS v4's gate (docs/v3 C5 design §7.3), run exactly as
 * `flock -x /home/claude/.bench.lock npm run bench -- --share`: SHARE_PROCS child processes, one
 * after another, each running SHARE_WARMUP_ROUNDS warm-up rounds and then SHARE_ROUNDS measured
 * rounds of one run each of stress (v4), stressBase and normal, the order rotated every round.
 * Per round, the share is (v4 − stressBase) ÷ normal and the total v4 ÷ normal. It prints every
 * round, the share's median and IQR, the median total against STRESS_TOTAL_LIMIT (the gate, Q4's
 * limit), the median of stressBase ÷ normal against C4's STRESS_BASE_LIMIT, the median of the
 * rounds' normal runs against NORMAL_PRECONDITION_MS, and both scenarios' seed-1 average alive,
 * valid only within ALIVE_TWIN_DELTA of each other and inside 280–320 (aliveTwin). Each process
 * then runs the print-only rounds, timed the same way after their own warm-up rounds: hiveStress
 * and the ailments-off diagnostic (stress v4 with its summons' ailment chances zeroed), against
 * stressBase and normal; neither is the gate. Last come the summons' report rows and the
 * decomposition against v3 of untimed seed-1 runs. --procs and --rounds override the counts; a
 * run of fewer than SHARE_GATE_PROCS processes or SHARE_GATE_ROUNDS measured rounds in all is
 * NOT A GATE RUN. It exits 0 only for a gate run whose alive band holds, whose normal median meets
 * the precondition and whose total is within the limit; a total within NEAR_LIMIT of the limit
 * prints the rerun rule: two more runs, and the gate is the median of the three.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGameData, targetDamage } from '../../src/data';
import type { GameData, StatBlock } from '../../src/data';
import type { SourcedEmitter } from '../../src/data/emitters';
import { sourceClass } from '../../src/data/sources';
import type { Modifier, SourcedTrigger, StatExtras } from '../../src/data/stats';
import type { TriggerSpec } from '../../src/data/triggers';
import {
  COUNTER_IDS,
  createSimulation,
  DRONE_KIND_DRONE,
  MAX_RUN_SECONDS,
  NO_INPUT,
  TICK_RATE,
} from '../../src/sim';
import type { CounterId, RunConfig, SimEvent } from '../../src/sim';
import { addShock } from '../../src/sim/ailments/shock';
import { PROJECTILE_CAP } from '../../src/sim/caps';
import { EVENT } from '../../src/sim/effects/types';
import { aimDense, beginAim } from '../../src/sim/emitters/lob';
import { BASE_ATTACK_SPEED } from '../../src/sim/emitters/types';
import type { BuildCompiler, TestModule } from '../../src/sim/rules';
import type { RunContext } from '../../src/sim/systems/context';
import { pickOuter } from '../../src/sim/systems/drones';
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

export const SCENARIO_IDS = [
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
  'stressBase',
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
export type ScenarioId = (typeof SCENARIO_IDS)[number];

const isScenarioId = (value: string): value is ScenarioId =>
  (SCENARIO_IDS as readonly string[]).includes(value);

export interface Scenario {
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

/**
 * stress v3's build (C4.14): v2, R1-12 (6 firings of 2 bombs a second; a third of stressStats'
 * damage keeps the alive band), with 雷網全開: shockChance .3 and 雷網. stressBase runs it as it
 * is, and stress v4 adds the summons to it (docs/v3 C5 design §7.3).
 */
const stressV3: StressBuild = () => ({
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
});

/**
 * stress v4's summons (docs/v3 C5 design §7.3; impl §6's 「召喚物 32 個（24 架無人機＋8 座砲台）」):
 * STRESS_DRONES drones and STRESS_TURRETS turrets of one drone grant on outer.summon, a plain
 * grant (no signature, chain or droneImpact). Its impacts deal STRESS_DRONE_DAMAGE_PCT of the
 * damage stat and its turret shots STRESS_TURRET_DAMAGE_PCT, tuned once so that v4's seed-1
 * average alive stays within ALIVE_TWIN_DELTA of stressBase's and inside ALIVE_MIN–ALIVE_MAX
 * (PF6, PGR2-3); only these two move, never the counts. They are 0.23 × DRONE_DEFAULTS' 0.8 and
 * 0.4, the largest common factor of the two in steps of 0.005 that holds that band at seed 1
 * (average alive 280.983 against stressBase's 280.894). The grant goes through StatExtras
 * without data validation, as the bench builds every grant: validation refuses more than 24
 * summons a grant (src/data/validate.ts), and only a test module raises the run's SUMMON_CAP
 * (D15, C5CHK3-13).
 */
export const STRESS_DRONES = 24;
export const STRESS_TURRETS = 8;
export const STRESS_DRONE_DAMAGE_PCT = 0.184;
export const STRESS_TURRET_DAMAGE_PCT = 0.092;
/** The summon cap stress v4 runs under: its 32 summons, past SUMMON_CAP's 24. */
export const STRESS_SUMMON_CAP = STRESS_DRONES + STRESS_TURRETS;
/**
 * The summons' attack frequency in stress v4 and hiveStress: ×2, Hoshi's Q3 (A), about the
 * sustained rate of a late hive (docs/v3 C5 design §7.3).
 */
export const STRESS_SUMMON_M = 2;

/** stress v4's summon grant with impact share `damagePct` and turret share `turretDamagePct`. */
export function stressSummons(damagePct: number, turretDamagePct: number): SourcedEmitter {
  return {
    source: 'outer.summon',
    grant: {
      kind: 'drone',
      drones: STRESS_DRONES,
      turrets: STRESS_TURRETS,
      damagePct,
      turretDamagePct,
      name: 'stress',
    },
  };
}

/** A test module that only raises the run's summon cap to `summonCap` (TestModule.summonCap). */
const raiseSummonCap = (summonCap: number): TestModule =>
  Object.assign((_b: BuildCompiler) => undefined, { summonCap });

/**
 * A test module whose tick hook sets every drone emitter's cadence at tick 1, before the drone
 * stage, so that its drones fly and its turrets fire at attack frequency `m`: a drone's m is
 * attackSpeed ÷ BASE_ATTACK_SPEED × its emitter's cadence, and a turret's accumulator gains the
 * cadence a tick towards the emitter's interval, which attackSpeed already scales
 * (src/sim/systems/drones.ts). At stress's attackSpeed of 16, m = 2 is a cadence of 0.5.
 */
export const summonFrequency =
  (m: number): TestModule =>
  (b) => {
    b.hook('tick', (ctx) => {
      if (ctx.now !== 1) return;
      const cadence = m / (ctx.build.values.attackSpeed / BASE_ATTACK_SPEED);
      for (const em of ctx.emitters) if (em.spec.kind === 'drone') em.cadence = cadence;
    });
  };

/** stress v4's build: v3's with the summon grant after its emitters. */
const stressV4 =
  (damagePct: number, turretDamagePct: number): StressBuild =>
  () => {
    const v3 = stressV3();
    const emitters = [...v3.stats.emitters, stressSummons(damagePct, turretDamagePct)];
    return { ...v3, stats: { ...v3.stats, emitters } };
  };

/**
 * stress v4 with these damage shares (docs/v3 C5 design §7.3): v3's build and test module, the
 * summon grant, the summon cap of 32 and m = STRESS_SUMMON_M, then `extra` test modules (the
 * ailments-off diagnostic's). The stress scenario is the one at the tuned shares.
 */
export function stressV4Scenario(
  damagePct: number,
  turretDamagePct: number,
  extra: readonly TestModule[] = [],
): Scenario {
  return stressScenario(
    stressV4(damagePct, turretDamagePct),
    [FROST_FIRE, raiseSummonCap(STRESS_SUMMON_CAP), summonFrequency(STRESS_SUMMON_M), ...extra],
    undefined,
    true,
  );
}

/**
 * The ailments-off diagnostic's test module (docs/v3 C5 design §7.3, perf :669; not the gate):
 * every minion-tagged hit, in stress v4 its summons' alone, has its ignite, poison, bleed and
 * shock chances × 0 (a more of −100 %), so its summons apply no ailment. A chance of 0 draws no
 * roll (rng.chance, src/core/rng.ts), so the combat stream, on which every emitter's hits roll,
 * the bombs' among them (src/sim/systems/context.ts), draws less than in v4, and the run leaves
 * v4's trajectory at the summons' first hit: its seed-1 average alive is its own, printed.
 */
export const SUMMON_AILMENTS_OFF: TestModule = (b) => {
  for (const stat of ['igniteChance', 'poisonChance', 'bleedChance', 'shockChance'] as const) {
    b.addModifier({ stat, kind: 'more', value: -1, tags: ['minion'] });
  }
};

/**
 * hiveStress's 螢火-like listener (docs/v3 C5 design §7.4; game-design-v3 「光環召喚 螢火：撞擊
 * 在目標留下 2 秒脈衝區」): each impact of the swarm's drones leaves a pulse zone of 80 at its
 * target for 2 s, a quarter of the damage stat a second as 爐光's, credited to the summon × aura
 * fusion, within C4's zone caps (ZONE_CAP and ZONE_SOURCE_CAP, src/sim/caps.ts). A pulse zone,
 * not a fire ground: it applies no ailment of its own.
 */
const FIREFLY: SourcedTrigger = {
  source: 'fusion.summon.aura',
  spec: {
    on: 'droneImpact',
    do: [{ kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0.25 }],
  },
};

/**
 * Scenarios only --share times and prints (docs/v3 C5 design §7.4, PG3): outside SCENARIO_IDS,
 * so --check neither times nor records them, and no alive band applies.
 */
export const PRINT_ONLY = {
  // hiveStress: the stress fixture under the swarm signature filled to 24 units as hive's
  // (HIVE_SWARM: 20 drones and 4 turrets), stressStats' own damage and chainCount of 2, at m =
  // STRESS_SUMMON_M, with 螢火's pulse zones.
  hiveStress: stressScenario(
    () => ({
      stats: stressStats({}, { triggers: [FIREFLY], conversions: [], emitters: [] }),
      rules: [],
      signature: { id: 'swarm' },
    }),
    [HIVE_SWARM, summonFrequency(STRESS_SUMMON_M)],
  ),
} as const satisfies Readonly<Record<string, Scenario>>;

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
  // v4 (C5.6, docs/v3 C5 design §7.3): v3 with 24 drones and 8 turrets on outer.summon at the
  // summon cap of 32 and m = 2, their damage shares tuned to keep v3's alive band.
  stress: stressV4Scenario(STRESS_DRONE_DAMAGE_PCT, STRESS_TURRET_DAMAGE_PCT),
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
  // C5.6: stress v3 (C4.14) under its own key, as C4.14 recorded it under stress (docs/v3 C5
  // design §7.3): magmaBomb at 12 bombs a second with 熔核's zone sources and 雷網全開.
  stressBase: stressScenario(stressV3, [FROST_FIRE], undefined, true),
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
export interface Workload {
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
export interface SegmentWorkload {
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
export function measureWorkload(
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

/** The ailments an application raises an event for: ignite (burn) and ailmentApplied. */
const AILMENTS = ['burn', 'poison', 'bleed', 'shock'] as const;
type Ailment = (typeof AILMENTS)[number];

/** The ailment an event says was applied, or null for another event. */
function appliedAilment(event: SimEvent): Ailment | null {
  if (event.type === 'ignite') return 'burn';
  if (event.type === 'ailmentApplied') return event.ailment;
  return null;
}

/** Ailment applications whose hit or pulse names no source: zone terms, effects and spreads. */
const NO_HIT = 'no hit';

/**
 * What an untimed run of a summon scenario did (summonWorkload): hive's summon workload, and
 * stress v4's report rows and the decomposition's counts (docs/v3 C5 design §7.3, PF7).
 */
export interface SummonWorkload {
  /** Simulated seconds of the run. */
  readonly seconds: number;
  /** Its drones and turrets, placed at tick 0, and the rows refused past the cap (summonCapped). */
  readonly drones: number;
  readonly turrets: number;
  readonly summonCapped: number;
  /**
   * Impacts of drones (a repeat's impact has droneId −1), and the enemies alive within their
   * splash as they struck, targets included.
   */
  readonly impacts: number;
  readonly splashVictims: number;
  /** turretFire events, and the shots they tried (PROJECTILE_CAP's refusals among them). */
  readonly firings: number;
  readonly turretShots: number;
  /** The droneImpact center events its listener counted (hiveListened). */
  readonly listened: number;
  /** Picks: the drone-ticks whose pick clock (DronePool.nextPick) moved, one per pickOuter. */
  readonly picks: number;
  /** Drone-ticks (drones, not turrets) whose drone moved, and those whose drone stood still. */
  readonly movingTicks: number;
  readonly idleTicks: number;
  /** Most projectiles and shot pool shots in flight after a tick. */
  readonly peakShots: number;
  /** The most shot pool shots in flight after a tick (SimState.shotCount), bombs among them. */
  readonly peakShotCount: number;
  readonly projectilesCapped: number;
  readonly kills: number;
  /**
   * Ailment applications by who applied them, in first-seen order: a hit's source id, a zone
   * pulse's 'zone <source>' ('zone signature' for the signature's), or NO_HIT.
   */
  readonly ailments: readonly (readonly [string, Readonly<Record<Ailment, number>>])[];
}

/**
 * The summon workload of an untimed run of `config`, which a test module watches. A tick's events
 * attribute each ailment application: the ailment events of a hit follow its hit event at once,
 * on its target, so they go to the hit's source; those of a zone pulse's hits and terms precede
 * its pulse event, which raises no hit event, so they go to the zone's source; the rest (terms of
 * a pulse that hit nothing, effects' applications, spreads) go to NO_HIT. An application on the
 * enemy of the tick's last hit event, with no other event but applications since, is credited to
 * that hit even when another stage made it: a zone pulse's term on that enemy, for one. With its
 * summons' chances at 0, stress v4 credits them 36 such applications in its seed-1 run, against
 * 3,166 of their own with the chances on.
 */
export function summonWorkload(
  config: RunConfig,
  data: GameData,
  testModules: readonly TestModule[] = [],
): SummonWorkload {
  // The pick clocks as the last drone stage left them: the first tick hook, before tick 1's drone
  // stage, takes them as placed.
  const seen: { ctx: RunContext | null; lastPick: Int32Array | null } = {
    ctx: null,
    lastPick: null,
  };
  const watch: TestModule = (b) => {
    b.hook('tick', (ctx) => {
      seen.ctx = ctx;
      seen.lastPick ??= ctx.sys.drones.nextPick.slice();
    });
  };
  const sim = createSimulation(config, data, [...testModules, watch]);
  const { state } = sim;
  const ds = state.drones;
  const count = state.droneCount;
  let drones = 0;
  for (let s = 0; s < count; s++) if (ds.kind[s] === DRONE_KIND_DRONE) drones++;
  const listened = hiveListened.impacts;
  let impacts = 0;
  let splashVictims = 0;
  let firings = 0;
  let turretShots = 0;
  let picks = 0;
  let movingTicks = 0;
  let idleTicks = 0;
  let peakShots = 0;
  let peakShotCount = 0;
  const ailments = new Map<string, Record<Ailment, number>>();
  const zoneSource = new Map<number, string>();
  const pending: Record<Ailment, number> = { burn: 0, poison: 0, bleed: 0, shock: 0 };
  const credit = (key: string, ailment: Ailment, n: number): void => {
    if (n === 0) return;
    let row = ailments.get(key);
    if (row === undefined) {
      row = { burn: 0, poison: 0, bleed: 0, shock: 0 };
      ailments.set(key, row);
    }
    row[ailment] += n;
  };
  const flush = (key: string): void => {
    for (const ailment of AILMENTS) {
      credit(key, ailment, pending[ailment]);
      pending[ailment] = 0;
    }
  };
  while (!state.finished) {
    let lastTarget = -1;
    let lastSource = '';
    for (const event of sim.step(NO_INPUT)) {
      const ailment = appliedAilment(event);
      if (ailment !== null) {
        if ('targetId' in event && event.targetId === lastTarget) credit(lastSource, ailment, 1);
        else pending[ailment]++;
        continue;
      }
      if (event.type === 'pulse' && event.kind === 'zone') {
        flush(`zone ${zoneSource.get(event.id) ?? '?'}`);
      } else {
        flush(NO_HIT);
      }
      lastTarget = -1;
      switch (event.type) {
        case 'hit':
          lastTarget = event.targetId;
          lastSource = state.sources[event.source] ?? '?';
          break;
        case 'zone':
          zoneSource.set(
            event.id,
            event.signature ? 'signature' : (state.sources[event.source] ?? '?'),
          );
          break;
        case 'impact':
          if (event.droneId >= 0) {
            impacts++;
            splashVictims += event.count;
          }
          break;
        case 'turretFire':
          firings++;
          turretShots += event.count;
          break;
        default:
          break;
      }
    }
    flush(NO_HIT);
    for (let s = 0; s < count; s++) {
      if (ds.kind[s] !== DRONE_KIND_DRONE) continue;
      if (ds.x[s] !== ds.prevX[s] || ds.y[s] !== ds.prevY[s]) movingTicks++;
      else idleTicks++;
    }
    const { ctx, lastPick } = seen;
    if (ctx !== null && lastPick !== null) {
      const nextPick = ctx.sys.drones.nextPick;
      for (let s = 0; s < count; s++) {
        if (nextPick[s] !== lastPick[s]) {
          picks++;
          lastPick[s] = nextPick[s] as number;
        }
      }
    }
    const shots = state.projectiles.length + state.shotCount;
    if (shots > peakShots) peakShots = shots;
    if (state.shotCount > peakShotCount) peakShotCount = state.shotCount;
  }
  const result = sim.result();
  return {
    seconds: result.ticks / TICK_RATE,
    drones,
    turrets: count - drones,
    summonCapped: result.counters.summonCapped,
    impacts,
    splashVictims,
    firings,
    turretShots,
    listened: hiveListened.impacts - listened,
    picks,
    movingTicks,
    idleTicks,
    peakShots,
    peakShotCount,
    projectilesCapped: result.counters.projectilesCapped,
    kills: result.kills,
    ailments: [...ailments],
  };
}

/** Ticks between two timings of the drones' picks past ALIVE_FROM_TICK, and the repeats of each. */
const PICK_EVERY_TICKS = 30;
const PICKS_PER_TIMING = 20;

/**
 * Microseconds per pick (pickOuter, src/sim/systems/drones.ts) in another untimed run of
 * `config`; printed, not asserted. Every PICK_EVERY_TICKS ticks past ALIVE_FROM_TICK, a tick hook
 * (before the drone stage) times PICKS_PER_TIMING picks of every drone slot, as each would pick
 * then. A pick reads the pool and the enemies and writes and draws nothing. Null without a drone.
 */
export function pickMicros(
  config: RunConfig,
  data: GameData,
  testModules: readonly TestModule[] = [],
): number | null {
  let ms = 0;
  let picks = 0;
  const timer: TestModule = (b) =>
    b.hook('tick', (ctx) => {
      if (ctx.now <= ALIVE_FROM_TICK || ctx.now % PICK_EVERY_TICKS !== 0) return;
      const ds = ctx.sys.drones;
      let n = 0;
      const start = performance.now();
      for (let i = 0; i < PICKS_PER_TIMING; i++) {
        for (let s = 0; s < ds.count; s++) {
          if (ds.kind[s] !== DRONE_KIND_DRONE) continue;
          pickOuter(ctx, s);
          n++;
        }
      }
      ms += performance.now() - start;
      picks += n;
    });
  const sim = createSimulation(config, data, [...testModules, timer]);
  while (!sim.state.finished) sim.step(NO_INPUT);
  return picks === 0 ? null : (ms * 1000) / picks;
}

/** A summon workload's ailment applications a second, summed by source class (sourceClass). */
function ailmentsByClass(
  summons: SummonWorkload,
): readonly (readonly [string, Readonly<Record<Ailment, number>>])[] {
  const byClass = new Map<string, Record<Ailment, number>>();
  for (const [key, row] of summons.ailments) {
    const name = key.startsWith('zone ') ? key.slice(5) : key;
    const cls = key === NO_HIT ? NO_HIT : name === 'signature' ? 'center' : sourceClass(name);
    const at = `${cls ?? '?'}${key.startsWith('zone ') ? ' (zones)' : ''}`;
    const sum = byClass.get(at) ?? { burn: 0, poison: 0, bleed: 0, shock: 0 };
    for (const ailment of AILMENTS) sum[ailment] += row[ailment] / summons.seconds;
    byClass.set(at, sum);
  }
  return [...byClass];
}

/** Ailment applications a second as report text: burn, poison and shock (bleed when any). */
function ailmentRateText(row: Readonly<Record<Ailment, number>>, seconds = 1): string {
  const rate = (n: number): string => (n / seconds).toFixed(1);
  const bleed = row.bleed === 0 ? '' : `, bleed ${rate(row.bleed)}`;
  return `burn ${rate(row.burn)}, poison ${rate(row.poison)}, shock ${rate(row.shock)}${bleed}`;
}

/** The summons' report rows (docs/v3 C5 design §7.3) as report lines; `micros` per pick. */
function summonRows(summons: SummonWorkload, micros: number | null): string[] {
  const perSecond = (n: number): string => (n / summons.seconds).toFixed(1);
  const droneTicks = summons.movingTicks + summons.idleTicks;
  return [
    `${summons.drones} drones and ${summons.turrets} turrets placed, summonCapped ` +
      `${summons.summonCapped} (${summons.summonCapped === 0 ? 'ok' : 'NOT 0'})`,
    `impacts ${perSecond(summons.impacts)}/s (${summons.impacts}), ` +
      `${(summons.impacts === 0 ? 0 : summons.splashVictims / summons.impacts).toFixed(2)} ` +
      `splash victims per impact`,
    `turret firings ${perSecond(summons.firings)}/s (${summons.firings}), shots ` +
      `${perSecond(summons.turretShots)}/s (${summons.turretShots} tried), projectilesCapped ` +
      `${summons.projectilesCapped}`,
    `picks ${perSecond(summons.picks)}/s (${summons.picks}), ` +
      `${micros === null ? '-' : micros.toFixed(2)} µs per pick`,
    `drone-ticks ${droneTicks}: ${summons.movingTicks} moving, ${summons.idleTicks} idle`,
    `peak shotCount ${summons.peakShotCount}`,
  ];
}

/** The summon workload as report text (hive's line). */
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
  const v4 = timings.entries.find((entry) => entry.id === 'stress');
  const v3 = timings.entries.find((entry) => entry.id === 'stressBase');
  if (v4 !== undefined && v3 !== undefined) {
    console.log(
      `stress − stressBase: ${(entryRatio(v4) - entryRatio(v3)).toFixed(3)} (stress v4 ` +
        `${entryRatio(v4).toFixed(3)}, stressBase ${entryRatio(v3).toFixed(3)}: C5's share on ` +
        `this check's scale, docs/v3 C5 design §7.3; --share measures the gate)`,
    );
  }
  if (write) {
    writeFileSync(BASELINE_FILE, formatBaseline(result.baseline));
    console.log(`wrote ${file}`);
  }
  if (!result.ok) process.exitCode = 1;
}

/** --share's counts (docs/v3 C5 design §7.3): processes, and measured and warm-up rounds each. */
const SHARE_PROCS = 3;
const SHARE_ROUNDS = 7;
const SHARE_WARMUP_ROUNDS = 2;
/** A gate run's least processes, and measured rounds in all; a smaller run never passes. */
export const SHARE_GATE_PROCS = 3;
export const SHARE_GATE_ROUNDS = 20;
/** stress v4's total, × normal: the STRESS gate from C5.6 on (docs/v3 C5 design §0.2, §12). */
export const STRESS_TOTAL_LIMIT = 4.5; // Hoshi's 「放寬到 4.5」 on the STRESS card (Q4 (C))
/** The design target of v4's share, × normal: reported, never gated (docs/v3 C5 design §7.3). */
export const SHARE_TARGET = 0.5;
/** C4's STRESS limit, which stressBase keeps for the C4 commits after C5.6 (C4 design §0.5). */
export const STRESS_BASE_LIMIT = 3.5;
/** Above this median of the rounds' normal runs, ms, the run is rerun (C4 design §0.5). */
export const NORMAL_PRECONDITION_MS = 25;
/** A total within this fraction of the limit runs two more --share runs: the median of three. */
export const NEAR_LIMIT = 0.03;
/** v4's seed-1 average alive stays within this of stressBase's (PF6, PGR2-3). */
export const ALIVE_TWIN_DELTA = 3;
/** The flag a --share parent starts its processes with. */
const SHARE_CHILD_FLAG = '--share-child';

/**
 * Whether stress v4's seed-1 average alive `v4` and stressBase's `base` make a --share run
 * valid (docs/v3 C5 design §7.3, PGR2-3): within ALIVE_TWIN_DELTA of each other, and both inside
 * CIBENCH's ALIVE_MIN–ALIVE_MAX. A total or share measured outside it is void.
 */
export const aliveTwin = (v4: number, base: number): boolean =>
  Math.abs(v4 - base) <= ALIVE_TWIN_DELTA &&
  [v4, base].every((alive) => alive >= ALIVE_MIN && alive <= ALIVE_MAX);

/** The entries --share times: the gate's, then the print-only ones (docs/v3 C5 design §7.3). */
const SHARE_GATE = ['stress', 'stressBase', 'normal'] as const;
const SHARE_PRINT = ['hiveStress', 'stressAilmentsOff', 'stressBase', 'normal'] as const;
export type ShareEntry = (typeof SHARE_GATE)[number] | (typeof SHARE_PRINT)[number];

/** The scenario a --share entry runs. */
function shareScenario(name: ShareEntry): Scenario {
  switch (name) {
    case 'stress':
    case 'stressBase':
    case 'normal':
      return SCENARIOS[name];
    case 'hiveStress':
      return PRINT_ONLY.hiveStress;
    case 'stressAilmentsOff':
      return stressV4Scenario(STRESS_DRONE_DAMAGE_PCT, STRESS_TURRET_DAMAGE_PCT, [
        SUMMON_AILMENTS_OFF,
      ]);
  }
}

/** One --share round: its seed, the order its entries ran in, and their run times, ms. */
export interface ShareRound {
  readonly seed: number;
  readonly order: readonly ShareEntry[];
  readonly ms: Readonly<Partial<Record<ShareEntry, number>>>;
}

/** What one --share process measured: its gate rounds, then its print-only rounds. */
export interface ShareProcess {
  readonly gate: readonly ShareRound[];
  readonly print: readonly ShareRound[];
}

/** `entries` rotated left by `by` places. */
const rotate = <T>(entries: readonly T[], by: number): T[] =>
  entries.map((_, i) => entries[(i + by) % entries.length] as T);

/**
 * --share process `proc` of `procs`, `rounds` measured rounds a phase: the gate's phase, then the
 * print-only one, each SHARE_WARMUP_ROUNDS warm-up rounds and then its measured rounds of one run
 * of each of its entries. Measured round r is round g = proc × rounds + r of the whole run: seed
 * 1 + g, its entries rotated by g places, so over the processes each entry takes each place about
 * equally often; the warm-up rounds take the seeds after every measured round's.
 */
function shareChild(proc: number, procs: number, rounds: number): ShareProcess {
  const realData = loadGameData();
  const timers = new Map<ShareEntry, (seed: number) => number>();
  for (const name of [...SHARE_GATE, ...SHARE_PRINT]) {
    if (timers.has(name)) continue;
    const scenario = shareScenario(name);
    const data = scenario.data?.() ?? realData;
    const startWave = scenario.startWave ?? DEFAULT_START_WAVE;
    timers.set(
      name,
      (seed) => runOnce(scenario.config(seed, startWave, ''), data, scenario.testModules).ms,
    );
  }
  const time = (name: ShareEntry, seed: number): number =>
    (timers.get(name) as (seed: number) => number)(seed);
  const phase = (entries: readonly ShareEntry[]): ShareRound[] => {
    for (let w = 0; w < SHARE_WARMUP_ROUNDS; w++) {
      const seed = 1 + procs * rounds + proc * SHARE_WARMUP_ROUNDS + w;
      for (const name of rotate(entries, w)) time(name, seed);
    }
    const measured: ShareRound[] = [];
    for (let r = 0; r < rounds; r++) {
      const g = proc * rounds + r;
      const order = rotate(entries, g);
      const ms: Partial<Record<ShareEntry, number>> = {};
      for (const name of order) ms[name] = time(name, 1 + g);
      measured.push({ seed: 1 + g, order, ms });
    }
    return measured;
  };
  return { gate: phase(SHARE_GATE), print: phase(SHARE_PRINT) };
}

/** A round's run time of `name`, ms. */
const msOf = (round: ShareRound, name: ShareEntry): number => round.ms[name] as number;

/** `n` processes, as the report counts them. */
const processesText = (n: number): string => `${n} process${n === 1 ? '' : 'es'}`;

/** The median and the quartiles of `values`. */
function spread(values: readonly number[]): { median: number; q1: number; q3: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: quantile(sorted, 0.5),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
  };
}

/** The untimed seed-1 runs --share reports beside its timings (shareWork). */
export interface ShareWork {
  /** The workloads of stress v4, stressBase, hiveStress and the ailments-off diagnostic. */
  readonly v4: Workload;
  readonly base: Workload;
  readonly hive: Workload;
  readonly off: Workload;
  /** The summon workloads of stress v4 and stressBase, and stress v4's µs per pick. */
  readonly v4Summons: SummonWorkload;
  readonly baseSummons: SummonWorkload;
  readonly pickMicros: number | null;
}

/** A stress-family scenario's seed-1 run, as --check takes it: its config, data and modules. */
function seedOne(scenario: Scenario): [RunConfig, GameData, readonly TestModule[]] {
  return [
    scenario.config(1, STRESS_START_WAVE, ''),
    scenario.data?.() ?? loadGameData(),
    scenario.testModules ?? [],
  ];
}

/** --share's untimed seed-1 runs, given stress v4's and stressBase's workloads. */
function shareWork(v4: Workload, base: Workload): ShareWork {
  return {
    v4,
    base,
    hive: measureWorkload(...seedOne(PRINT_ONLY.hiveStress)),
    off: measureWorkload(...seedOne(shareScenario('stressAilmentsOff'))),
    v4Summons: summonWorkload(...seedOne(SCENARIOS.stress)),
    baseSummons: summonWorkload(...seedOne(SCENARIOS.stressBase)),
    pickMicros: pickMicros(...seedOne(SCENARIOS.stress)),
  };
}

/**
 * --share's first lines (docs/v3 C5 design §7.3): what `procs` processes of `rounds` measured
 * rounds run, NOT A GATE RUN below SHARE_GATE_PROCS processes or SHARE_GATE_ROUNDS rounds, and
 * stress v4's and stressBase's seed-1 average alive `v4Alive` and `baseAlive` (aliveTwin).
 */
export function shareHead(
  procs: number,
  rounds: number,
  v4Alive: number,
  baseAlive: number,
): string[] {
  const gateRun = procs >= SHARE_GATE_PROCS && procs * rounds >= SHARE_GATE_ROUNDS;
  return [
    `bench --share (docs/v3 C5 design §7.3): ${processesText(procs)} × ` +
      `(${SHARE_WARMUP_ROUNDS} warm-up + ${rounds} measured) rounds of ${SHARE_GATE.join(', ')}, ` +
      `the order rotated every round, then as many print-only rounds of ` +
      `${SHARE_PRINT.join(', ')}` +
      (gateRun
        ? ''
        : `; NOT A GATE RUN (fewer than ${SHARE_GATE_PROCS} processes or ` +
          `${SHARE_GATE_ROUNDS} measured rounds)`),
    `seed-1 average alive (ticks ${ALIVE_FROM_TICK + 1}+): stress (v4) ${v4Alive.toFixed(3)}, ` +
      `stressBase ${baseAlive.toFixed(3)} (difference ${(v4Alive - baseAlive).toFixed(3)}; ` +
      `within ${ALIVE_TWIN_DELTA} and ${ALIVE_MIN}–${ALIVE_MAX}: ` +
      `${aliveTwin(v4Alive, baseAlive) ? 'valid' : 'VOID, retune d and t'}); summons d ` +
      `${STRESS_DRONE_DAMAGE_PCT}, t ${STRESS_TURRET_DAMAGE_PCT}, ${STRESS_DRONES} drones + ` +
      `${STRESS_TURRETS} turrets at cap ${STRESS_SUMMON_CAP}, m ${STRESS_SUMMON_M}`,
  ];
}

/**
 * --share's report on its `processes`' rounds and the untimed `work` (docs/v3 C5 design §7.3;
 * see the header): every gate round, each process's medians, the share's median and IQR, the
 * total's, stressBase's against STRESS_BASE_LIMIT, the normal median against
 * NORMAL_PRECONDITION_MS, hiveStress and the ailments-off diagnostic from the print-only rounds,
 * the summons' report rows, the decomposition, and the verdict on the median total against
 * STRESS_TOTAL_LIMIT. It passes only a gate run (SHARE_GATE_PROCS processes and SHARE_GATE_ROUNDS
 * rounds in all, counted from `processes`) whose alive band holds (aliveTwin), whose normal
 * median meets the precondition and whose median total is within the limit.
 */
export function shareBody(
  processes: readonly ShareProcess[],
  work: ShareWork,
): { readonly lines: readonly string[]; readonly pass: boolean } {
  const lines: string[] = [];
  const shares: number[] = [];
  const totals: number[] = [];
  const bases: number[] = [];
  const normals: number[] = [];
  processes.forEach((proc, p) => {
    const procTotals: number[] = [];
    const procShares: number[] = [];
    for (const round of proc.gate) {
      const v4 = msOf(round, 'stress');
      const base = msOf(round, 'stressBase');
      const normal = msOf(round, 'normal');
      const s = (v4 - base) / normal;
      shares.push(s);
      totals.push(v4 / normal);
      bases.push(base / normal);
      normals.push(normal);
      procTotals.push(v4 / normal);
      procShares.push(s);
      lines.push(
        `process ${p + 1}, seed ${round.seed} (${round.order.join(', ')}): stress ` +
          `${v4.toFixed(2)} ms, stressBase ${base.toFixed(2)} ms, normal ${normal.toFixed(2)} ` +
          `ms; total ${(v4 / normal).toFixed(3)}, stressBase ${(base / normal).toFixed(3)}, ` +
          `share ${s.toFixed(3)}`,
      );
    }
    lines.push(
      `process ${p + 1}: median total ${median(procTotals).toFixed(3)}, median share ` +
        `${median(procShares).toFixed(3)}`,
    );
  });
  const range = (x: { q1: number; q3: number }): string => `${x.q1.toFixed(3)}–${x.q3.toFixed(3)}`;
  const shareSpread = spread(shares);
  const totalSpread = spread(totals);
  const baseSpread = spread(bases);
  const total = totalSpread.median;
  const normal = median(normals);
  const gateRun = processes.length >= SHARE_GATE_PROCS && totals.length >= SHARE_GATE_ROUNDS;
  const valid = aliveTwin(work.v4.averageAlive, work.base.averageAlive);
  const precondition = normal <= NORMAL_PRECONDITION_MS;
  lines.push(
    `share (stress − stressBase) ÷ normal: median ${shareSpread.median.toFixed(3)}, IQR ` +
      `${range(shareSpread)} over ${shares.length} rounds (design target ${SHARE_TARGET}, ` +
      `reported, never gated)`,
    `total stress ÷ normal: median ${total.toFixed(3)}, IQR ${range(totalSpread)} over ` +
      `${totals.length} rounds (the gate, against ${STRESS_TOTAL_LIMIT.toFixed(1)}: the verdict ` +
      'is the last line)',
    `stressBase ÷ normal: median ${baseSpread.median.toFixed(3)}, IQR ${range(baseSpread)}, ` +
      `against C4's ${STRESS_BASE_LIMIT} ` +
      `(${baseSpread.median <= STRESS_BASE_LIMIT ? 'within' : 'OVER'}; recorded for the C4 ` +
      `commits after C5.6, not C5.6's gate)`,
    `normal: median ${normal.toFixed(2)} ms over the ${normals.length} rounds ` +
      `(precondition ≤ ${NORMAL_PRECONDITION_MS} ms: ` +
      `${precondition ? 'ok' : 'FAILED, rerun at most 3 times, then stop and report'})`,
  );

  // The print-only rounds: hiveStress beside v4, and the ailments-off diagnostic.
  const prints = processes.flatMap((proc) => proc.print);
  const hive = spread(prints.map((r) => msOf(r, 'hiveStress') / msOf(r, 'normal')));
  const hiveMs = median(prints.map((r) => msOf(r, 'hiveStress')));
  const offShare = spread(
    prints.map((r) => (msOf(r, 'stressAilmentsOff') - msOf(r, 'stressBase')) / msOf(r, 'normal')),
  );
  const offTotal = median(prints.map((r) => msOf(r, 'stressAilmentsOff') / msOf(r, 'normal')));
  const printNormal = median(prints.map((r) => msOf(r, 'normal')));
  lines.push(
    `hiveStress (print-only, docs/v3 C5 design §7.4): median ${hiveMs.toFixed(2)} ms, median ` +
      `${hive.median.toFixed(3)} × normal (IQR ${range(hive)}) beside stress v4's total ` +
      `${total.toFixed(3)}; seed-1 average alive ${work.hive.averageAlive.toFixed(1)}; ` +
      `${prints.length} rounds, normal median ${printNormal.toFixed(2)} ms`,
    `ailments-off diagnostic (not the gate; the summons' ailment chances × 0): share median ` +
      `${offShare.median.toFixed(3)} (IQR ${range(offShare)}), total median ` +
      `${offTotal.toFixed(3)}, seed-1 average alive ${work.off.averageAlive.toFixed(1)}; with ` +
      `them the share is ${shareSpread.median.toFixed(3)}`,
  );

  // The report rows and the decomposition against v3, of untimed seed-1 runs.
  lines.push('stress v4 summons (seed 1, untimed):');
  for (const line of summonRows(work.v4Summons, work.pickMicros)) lines.push(`  ${line}`);
  const judged = (w: Workload): string =>
    `${(w.segments.linked === 0 ? 0 : w.segments.endpoints / w.segments.linked).toFixed(1)} ` +
    `shocked endpoints per judgement (average shocked ${w.segments.averageShocked.toFixed(1)})`;
  const killRate = (summons: SummonWorkload): string =>
    (summons.kills / summons.seconds).toFixed(1);
  lines.push(
    'decomposition against v3 (stressBase), seed 1, untimed:',
    `  stress v4: ${judged(work.v4)}; stressBase: ${judged(work.base)}`,
    `  kills/s: stress v4 ${killRate(work.v4Summons)}, stressBase ${killRate(work.baseSummons)}`,
  );
  for (const [name, summons] of [
    ['stress v4', work.v4Summons],
    ['stressBase', work.baseSummons],
  ] as const) {
    lines.push(`  ailment applications/s of ${name}, by source class:`);
    for (const [cls, row] of ailmentsByClass(summons)) {
      lines.push(`    ${cls}: ${ailmentRateText(row)}`);
    }
    lines.push(`  ailment applications/s of ${name}, by source:`);
    for (const [key, row] of summons.ailments) {
      lines.push(`    ${key}: ${ailmentRateText(row, summons.seconds)}`);
    }
  }

  const limit = STRESS_TOTAL_LIMIT;
  const near = Math.abs(total - limit) <= NEAR_LIMIT * limit;
  const read = gateRun && valid && precondition;
  const pass = read && total <= limit;
  lines.push(
    `STRESS v4 (docs/v3 C5 design §7.3): median total ${total.toFixed(3)} against ` +
      `${limit.toFixed(1)}: ` +
      (!gateRun
        ? `NOT A GATE RUN (${processesText(processes.length)}, ${totals.length} measured ` +
          `rounds; a gate run takes at least ${processesText(SHARE_GATE_PROCS)} and ` +
          `${SHARE_GATE_ROUNDS} measured rounds in all), never a pass`
        : !valid
          ? 'VOID (seed-1 alive outside the band: retune d and t)'
          : !precondition
            ? 'not read (normal precondition failed)'
            : pass
              ? 'pass'
              : 'OVER THE LIMIT') +
      (read && near
        ? `; within ${Math.round(NEAR_LIMIT * 100)} % of the limit ` +
          `(${(limit * (1 - NEAR_LIMIT)).toFixed(3)}–${(limit * (1 + NEAR_LIMIT)).toFixed(3)}): ` +
          'run the same command twice more, and the gate is the median of the three totals'
        : ''),
  );
  return { lines, pass };
}

/**
 * Prints shareBody's report on `processes` and `work`, and sets the exit code to 1 unless it
 * passes the run, so that only a passing gate run exits 0 (docs/v3 C5 design §7.3).
 */
export function shareReport(processes: readonly ShareProcess[], work: ShareWork): boolean {
  const { lines, pass } = shareBody(processes, work);
  for (const line of lines) console.log(line);
  if (!pass) process.exitCode = 1;
  return pass;
}

/**
 * --share (docs/v3 C5 design §7.3; see the header): stress v4's and stressBase's seed-1 alive,
 * then `procs` processes of `rounds` measured rounds, one after another, then the report
 * (shareReport).
 */
function share(procs: number, rounds: number): void {
  const v4 = measureWorkload(...seedOne(SCENARIOS.stress));
  const base = measureWorkload(...seedOne(SCENARIOS.stressBase));
  for (const line of shareHead(procs, rounds, v4.averageAlive, base.averageAlive)) {
    console.log(line);
  }
  const script = fileURLToPath(import.meta.url);
  const processes: ShareProcess[] = [];
  for (let p = 0; p < procs; p++) {
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, script, SHARE_CHILD_FLAG, String(p), String(procs), String(rounds)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const line = child.stdout.trim().split('\n').at(-1) ?? '';
    if (child.status !== 0 || line === '') {
      throw new Error(`process ${p + 1} failed (status ${child.status}): ${child.stdout}`);
    }
    processes.push(JSON.parse(line) as ShareProcess);
  }
  shareReport(processes, shareWork(v4, base));
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === SHARE_CHILD_FLAG) {
    const [, proc = '', procs = '', rounds = ''] = args;
    const result = shareChild(
      positiveInt('proc', proc, 0),
      positiveInt('procs', procs),
      positiveInt('rounds', rounds),
    );
    console.log(JSON.stringify(result));
    return;
  }
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      scenario: { type: 'string' },
      runs: { type: 'string' },
      warmup: { type: 'string' },
      seed: { type: 'string' },
      'start-wave': { type: 'string' },
      check: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      share: { type: 'boolean', default: false },
      procs: { type: 'string' },
      rounds: { type: 'string' },
    },
  });
  if (values.share) {
    for (const name of ['scenario', 'runs', 'warmup', 'seed', 'start-wave'] as const) {
      if (values[name] !== undefined) {
        throw new Error(`--${name} does not go with --share, whose entries are fixed`);
      }
    }
    if (values.check || values.write) throw new Error('--share goes without --check and --write');
    share(
      positiveInt('procs', values.procs ?? String(SHARE_PROCS)),
      positiveInt('rounds', values.rounds ?? String(SHARE_ROUNDS)),
    );
    return;
  }
  for (const name of ['procs', 'rounds'] as const) {
    if (values[name] !== undefined) throw new Error(`--${name} goes with --share; add --share`);
  }
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
