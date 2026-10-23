/**
 * The replay's preset workloads (docs/v3 C10 design §2.5). renderStress is impl §6's frame-time
 * scene, 「模擬的壓力場景，再加兩圈共 8 顆環繞球、光環、Boss 身上 500 層毒」: stress v4's workload
 * (tools/balance/bench.ts: stressData(), stressStats() from STRESS_START_WAVE, 24 drones and 8
 * turrets, 熔核's zone sources, 雷網全開), the grants scenario's aura (auraRadius 160, every fourth
 * pulse × 4) and two rings of 4 orbs, and an immortal boss holding about 500 poison stacks. It is
 * composed here from src/sim/testing.ts and copies of bench.ts's specs, as bench.ts builds them:
 * importing bench.ts would make the page depend on tools, and moving its builders into src/sim
 * would touch the run path. tools/balance/bench.test.ts pins the copies to bench.ts's stress v4
 * and grants, and presets.test.ts pins renderStress's numbers.
 */

import { targetDamage } from '../../data/curve';
import type { SourcedEmitter } from '../../data/emitters';
import type { Modifier, StatExtras } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import type { EnemyDef } from '../../data/types';
import type { RunConfig } from '../../sim';
import { BASE_ATTACK_SPEED } from '../../sim/emitters/types';
import { enqueueModuleEffect } from '../../sim/rules';
import type { BuildCompiler, ModuleEvent, TestModule } from '../../sim/rules';
import type { Enemy } from '../../sim/systems/context';
import { addEnemy } from '../../sim/systems/spawn';
import { STRESS_START_WAVE, stressData, stressStats } from '../../sim/testing';
import type { RunSetup } from './types';

/**
 * stress v2's zone sources (bench.ts' R1_TRIGGERS): 爐光 leaves a zone where each bomb explodes,
 * 瘟爆 poisons each explosion's list, and 毒雲 leaves a poison cloud where a poisoned enemy dies.
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

/** 霜焰's frost on the explosion hits, and 爐光's bonus on the enemies in its zones (R1_SCOPED). */
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

/** stress v3's 雷網 (bench.ts' WEB): the segment grant on outer.lightning. */
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

/**
 * stress v4's summons (bench.ts' stressSummons at its tuned shares): 24 drones and 8 turrets of
 * one drone grant on outer.summon, impacts at 0.184 of the damage stat and turret shots at 0.092.
 */
const SUMMONS: SourcedEmitter = {
  source: 'outer.summon',
  grant: {
    kind: 'drone',
    drones: 24,
    turrets: 8,
    damagePct: 0.184,
    turretDamagePct: 0.092,
    name: 'stress',
  },
};

/** The summon cap stress v4 runs under: its 32 summons, past SUMMON_CAP's 24. */
const SUMMON_CAP = 32;
/** The summons' attack frequency in stress v4: × 2 (bench.ts' STRESS_SUMMON_M). */
const SUMMON_M = 2;

/**
 * The grants scenario's aura and orbits (bench.ts' GRANTS_EMITTERS, docs/v3 C4 design §7.3): an
 * aura whose every fourth pulse is merged at × 4 (聚能脈衝), ring 0 and ring 1 (雙軌) of 4 orbs
 * each, all on outer.aura. Its thorns grant is not impl §6's.
 */
export const RENDER_STRESS_GRANTS: readonly SourcedEmitter[] = [
  { source: 'outer.aura', grant: { kind: 'aura', everyNth: { n: 4, mult: 4 } } },
  { source: 'outer.aura', grant: { kind: 'orbit', count: 4 } },
  { source: 'outer.aura', grant: { kind: 'orbit', ring: 1, count: 4 } },
];
/** The grants scenario's aura radius. */
export const RENDER_STRESS_AURA_RADIUS = 160;

/** impl §6's 「Boss 身上 500 層毒」: the poison stacks the boss holds (初始值). */
export const BOSS_POISON_STACKS = 500;
/** Doses per poison duration (初始值): 25 stacks each, so the count dips by a twentieth at most. */
const BOSS_POISON_DOSES = 20;
/**
 * The boss's distance from the player (初始值): past FOCUS_RANGE (800, src/sim/targeting.ts), so
 * the build's shots keep to the crowd as stress v4's do; inside the arena's half-width (960), so
 * it is drawn.
 */
const BOSS_DISTANCE = 820;
/** The boss never moves or dies, as poisonBoss's boss (bench.ts). */
const BOSS_HP_MULT = 1e12;

/** 霜焰's 霜火地 (bench.ts' FROST_FIRE): the bombs' fire zones slow by 30%. */
const FROST_FIRE: TestModule = (b) => {
  const lob = b.signature().lob;
  if (lob !== null) lob.zone.slow = 0.3;
};

/** A test module that only raises the run's summon cap (bench.ts' raiseSummonCap). */
const raiseSummonCap = (summonCap: number): TestModule =>
  Object.assign((_b: BuildCompiler) => undefined, { summonCap });

/**
 * Sets every drone emitter's cadence at tick 1 so that the summons attack at frequency `m`
 * (bench.ts' summonFrequency).
 */
const summonFrequency =
  (m: number): TestModule =>
  (b) => {
    b.hook('tick', (ctx) => {
      if (ctx.now !== 1) return;
      const cadence = m / (ctx.build.values.attackSpeed / BASE_ATTACK_SPEED);
      for (const em of ctx.emitters) if (em.spec.kind === 'drone') em.cadence = cadence;
    });
  };

/**
 * The poisoned boss: on the first tick with a wave, the fixture's boss, stationary and immortal,
 * BOSS_DISTANCE to the right of the player; then BOSS_POISON_STACKS of poison held on it, renewed
 * in BOSS_POISON_DOSES doses per poison duration. Its own tick hook, so the build is stress v4's.
 */
const poisonedBoss: TestModule = (b) => {
  const dose = b.addEffect('center', {
    kind: 'applyAilment',
    ailment: 'poison',
    stacks: BOSS_POISON_STACKS / BOSS_POISON_DOSES,
  });
  /** The doses' event, on the boss, once it is placed; it never moves. */
  let event: ModuleEvent | null = null;
  let every = 1;
  let next = 0;
  const trigger = b.hook('tick', (ctx) => {
    if (event === null) {
      const rec = ctx.current;
      if (rec === null) return;
      const def: EnemyDef = { ...ctx.data.enemies.boss, speed: 0, hpMult: BOSS_HP_MULT };
      addEnemy(ctx, def, rec, 1, 0, BOSS_DISTANCE);
      const boss = ctx.enemies[ctx.enemies.length - 1] as Enemy;
      event = { depth: 0, origin: -1, target: boss, x: boss.x, y: boss.y, flags: 0 };
      every = Math.max(1, Math.round(ctx.poisonTicks / BOSS_POISON_DOSES));
      next = ctx.now;
    }
    if (ctx.now < next) return;
    next = ctx.now + every;
    enqueueModuleEffect(ctx, trigger, dose, event);
  });
};

/** stress v4's build (bench.ts' stressV4 at its tuned shares), with these grants and values. */
function stressV4Config(
  seed: number,
  startWave: number,
  grants: readonly SourcedEmitter[],
  values: { readonly auraRadius?: number },
): RunConfig {
  const extras: StatExtras = {
    triggers: R1_TRIGGERS.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: [WEB, SUMMONS, ...grants],
  };
  return {
    seed,
    stats: stressStats(
      {
        attackSpeed: 16,
        projectileCount: 3,
        poisonChance: 0.3,
        shockChance: 0.3,
        damage: targetDamage(STRESS_START_WAVE) / 7.5,
        ...values,
      },
      extras,
      R1_SCOPED,
    ),
    rules: [],
    signature: { id: 'magmaBomb' },
    startWave,
    mode: 'auto',
  };
}

const STRESS_V4_MODULES: readonly TestModule[] = [
  FROST_FIRE,
  raiseSummonCap(SUMMON_CAP),
  summonFrequency(SUMMON_M),
];

/** stress v4's workload as composed here, which bench.test.ts pins to bench.ts' stress. */
export function stressV4Setup(): RunSetup {
  return {
    data: stressData(),
    testModules: STRESS_V4_MODULES,
    config: (seed, startWave) => stressV4Config(seed, startWave, [], {}),
  };
}

/** renderStress: stress v4 with the aura, 2 × 4 orbs and the poisoned boss. */
export function renderStressSetup(): RunSetup {
  return {
    data: stressData(),
    testModules: [...STRESS_V4_MODULES, poisonedBoss],
    config: (seed, startWave) =>
      stressV4Config(seed, startWave, RENDER_STRESS_GRANTS, {
        auraRadius: RENDER_STRESS_AURA_RADIUS,
      }),
  };
}
