import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadGameData, parseGameData, validateGameData } from '../../src/data';
import type { GameData, TalentNode } from '../../src/data';
import type { DroneGrant } from '../../src/data/emitters';
import { createSimulation, DRONE_KIND_DRONE, DRONE_KIND_TURRET, NO_INPUT } from '../../src/sim';
import type { RunConfig } from '../../src/sim';
import { SUMMON_CAP, ZONE_CAP, ZONE_SOURCE_CAP } from '../../src/sim/caps';
import { BASE_ATTACK_SPEED } from '../../src/sim/emitters/types';
import type { TestModule } from '../../src/sim/rules';
import type { RunContext } from '../../src/sim/systems/context';
import { stressData } from '../../src/sim/testing';
import {
  aliveTwin,
  ALIVE_TWIN_DELTA,
  CHECK_ENTRIES,
  HIVE_DRONES,
  HIVE_TURRETS,
  hiveListened,
  measureWorkload,
  PRINT_ONLY,
  SCENARIO_IDS,
  SCENARIOS,
  shareBody,
  shareHead,
  shareReport,
  STRESS_DRONE_DAMAGE_PCT,
  STRESS_DRONES,
  STRESS_SUMMON_CAP,
  STRESS_SUMMON_M,
  STRESS_TOTAL_LIMIT,
  STRESS_TURRET_DAMAGE_PCT,
  STRESS_TURRETS,
  stressSummons,
  summonWorkload,
} from './bench';
import type {
  Scenario,
  ShareEntry,
  ShareProcess,
  ShareWork,
  SummonWorkload,
  Workload,
} from './bench';
import { ALIVE_MAX, ALIVE_MIN } from './benchCheck';

const hive = SCENARIOS.hive;
const data = loadGameData();

describe('the hive bench scenario', () => {
  it('is normal’s 3-minute run with the swarm as the signature, and not of the stress family', () => {
    const { normal } = SCENARIOS;
    expect([hive.runs, hive.warmup, hive.seconds, hive.targetMs]).toEqual([
      normal.runs,
      normal.warmup,
      normal.seconds,
      normal.targetMs,
    ]);
    expect(hive.config(3, 30, '')).toEqual({
      ...normal.config(3, 30, ''),
      signature: { id: 'swarm' },
    });
    expect([hive.data, hive.startWave, hive.stress, hive.summons]).toEqual([
      undefined,
      undefined,
      undefined,
      true,
    ]);
  });

  it('has 24 slots: 20 drones and 4 turrets, the summon cap, none refused', () => {
    expect([HIVE_DRONES, HIVE_TURRETS]).toEqual([20, 4]);
    expect(HIVE_DRONES + HIVE_TURRETS).toBe(SUMMON_CAP);
    const sim = createSimulation(
      { ...hive.config(1, 30, ''), maxTicks: 1 },
      data,
      hive.testModules,
    );
    const { drones, droneCount } = sim.state;
    const kinds = Array.from(drones.kind.subarray(0, droneCount));
    expect(kinds.filter((kind) => kind === DRONE_KIND_DRONE)).toHaveLength(20);
    expect(kinds.filter((kind) => kind === DRONE_KIND_TURRET)).toHaveLength(4);
    expect(droneCount).toBe(24);
    sim.step(NO_INPUT);
    expect(sim.result().counters.summonCapped).toBe(0);
  });

  it('listens to droneImpact: its listener counts every impact, and its turrets fire', () => {
    const before = hiveListened.impacts;
    const workload = summonWorkload(
      { ...hive.config(1, 30, ''), maxTicks: 600 },
      data,
      hive.testModules,
    );
    expect([workload.drones, workload.turrets]).toEqual([20, 4]);
    expect(workload.impacts).toBeGreaterThan(0);
    // No repeats: every impact is the signature's own, which raises droneImpact (rule 8).
    expect(workload.listened).toBe(workload.impacts);
    expect(hiveListened.impacts - before).toBe(workload.impacts);
    expect(workload.firings).toBeGreaterThan(0);
    expect(workload.turretShots).toBeGreaterThanOrEqual(workload.firings);
    expect(workload.kills).toBeGreaterThan(0);
  });
});

/** A snapshot beside this file: stress v3's seed-1 config or workload on C5.6's parent. */
const snapshot = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
/** A value as its JSON reads back, as the snapshots hold it. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const pinned = snapshot('stressBase.workload.json') as Omit<Workload, 'lobAimMicros'>;

/** A scenario's seed-1 run as --check and --share take it: its config, data and modules. */
function seedOne(scenario: Scenario): {
  config: RunConfig;
  data: GameData;
  modules: readonly TestModule[];
} {
  return {
    config: scenario.config(1, 30, ''),
    data: scenario.data?.() ?? data,
    modules: scenario.testModules ?? [],
  };
}

/** The seed-1 workload of stress (v4) or stressBase, measured once per file (measureWorkload). */
const workloads = new Map<'stress' | 'stressBase', Workload>();
function seedOneWorkload(id: 'stress' | 'stressBase'): Workload {
  let workload = workloads.get(id);
  if (workload === undefined) {
    const { config, data: runData, modules } = seedOne(SCENARIOS[id]);
    workload = measureWorkload(config, runData, modules);
    workloads.set(id, workload);
  }
  return workload;
}

/** The ctx of a run of `run` for `ticks` ticks, and its turretFire events. */
function watchRun(
  run: ReturnType<typeof seedOne>,
  ticks: number,
): { ctx: RunContext; firings: number } {
  const seen: { ctx: RunContext | null } = { ctx: null };
  const watch: TestModule = (b) =>
    void b.hook('tick', (ctx) => {
      seen.ctx = ctx;
    });
  const sim = createSimulation({ ...run.config, maxTicks: ticks }, run.data, [
    ...run.modules,
    watch,
  ]);
  let firings = 0;
  while (!sim.state.finished) {
    for (const event of sim.step(NO_INPUT)) if (event.type === 'turretFire') firings++;
  }
  return { ctx: seen.ctx as RunContext, firings };
}

/** The attack frequency m of each drone emitter of a run's ctx (src/sim/systems/drones.ts). */
const droneFrequencies = (ctx: RunContext): number[] =>
  ctx.emitters
    .filter((em) => em.spec.kind === 'drone')
    .map((em) => (ctx.build.values.attackSpeed / BASE_ATTACK_SPEED) * em.cadence);

/** The kinds and owners of a run's summon rows at tick 0, and its summonCapped after a tick. */
function placed(run: ReturnType<typeof seedOne>): {
  drones: number;
  turrets: number;
  owners: number[];
  capped: number;
} {
  const sim = createSimulation({ ...run.config, maxTicks: 1 }, run.data, run.modules);
  const { drones, droneCount } = sim.state;
  const kinds = Array.from(drones.kind.subarray(0, droneCount));
  const owners = [...new Set(drones.owner.subarray(0, droneCount))];
  sim.step(NO_INPUT);
  return {
    drones: kinds.filter((kind) => kind === DRONE_KIND_DRONE).length,
    turrets: kinds.filter((kind) => kind === DRONE_KIND_TURRET).length,
    owners,
    capped: sim.result().counters.summonCapped,
  };
}

describe('stressBase (docs/v3 C5 design §7.3, §9 C5.6)', () => {
  it('is a stress-family scenario on v3’s modules, after hive in SCENARIO_IDS and CHECK_ENTRIES', () => {
    const base = SCENARIOS.stressBase;
    // Right after hive; C4.21's grants comes after it.
    const afterHive = (ids: readonly string[]): string[] =>
      ids.slice(ids.indexOf('hive'), ids.indexOf('hive') + 2);
    expect(afterHive(SCENARIO_IDS)).toEqual(['hive', 'stressBase']);
    expect(afterHive(CHECK_ENTRIES)).toEqual(['hive', 'stressBase']);
    expect([base.runs, base.warmup, base.seconds, base.targetMs, base.startWave]).toEqual([
      20, 3, 30, 50, 30,
    ]);
    expect([base.stress, base.allShocked, base.capProbe, base.summons]).toEqual([
      true,
      true,
      undefined,
      undefined,
    ]);
    expect(base.data).toBe(stressData);
    // v3's FROST_FIRE alone, the module stress v4 also starts with.
    expect(base.testModules).toHaveLength(1);
    expect(base.testModules?.[0]).toBe(SCENARIOS.stress.testModules?.[0]);
  });

  it('is stress v3 as its parent built it: its seed-1 config equals stressBase.config.json', () => {
    const { config } = seedOne(SCENARIOS.stressBase);
    expect(asJson(config)).toEqual(snapshot('stressBase.config.json'));
  });

  it('runs v3’s workload: its seed-1 measureWorkload equals stressBase.workload.json', () => {
    const { lobAimMicros, ...workload } = seedOneWorkload('stressBase');
    // Every field but the timed lob aim.
    expect(asJson(workload)).toEqual(pinned);
    expect(lobAimMicros).toBeGreaterThan(0);
  });

  it('pins every workload field but lobAimMicros (§9 C5.6, PGR2-6)', () => {
    const fields = [
      'averageAlive',
      'peakAlive',
      'peakShots',
      'kills',
      'zonesBySource',
      'zones',
      'pulses',
      'zoneHits',
      'peakPulseHits',
      'averageEffectZones',
      'averageSignatureZones',
      'bombs',
      'firings',
      'explosions',
      'explosionHits',
      'freezes',
      'ignites',
      'seconds',
      'counters',
      'segments',
    ];
    const segments = [
      'averageShocked',
      'judgements',
      'linked',
      'endpoints',
      'links',
      'hits',
      'peakEndpoints',
    ];
    expect(Object.keys(pinned)).toEqual(fields);
    expect(Object.keys(pinned.segments)).toEqual(segments);
    const measured = seedOneWorkload('stressBase');
    expect(Object.keys(measured)).toEqual([...fields.slice(0, -1), 'lobAimMicros', 'segments']);
    expect(Object.keys(measured.segments)).toEqual(segments);
  });
});

describe('stress v4 (docs/v3 C5 design §7.3, §9 C5.6)', () => {
  it('is v3 with the summon grant on outer.summon, at the summon cap of 32', () => {
    const v4 = seedOne(SCENARIOS.stress);
    const v3 = seedOne(SCENARIOS.stressBase);
    const { emitters, ...stats } = v4.config.stats;
    const { emitters: v3Emitters, ...v3Stats } = v3.config.stats;
    expect({ ...v4.config, stats }).toEqual({ ...v3.config, stats: v3Stats });
    expect(emitters).toEqual([
      ...v3Emitters,
      stressSummons(STRESS_DRONE_DAMAGE_PCT, STRESS_TURRET_DAMAGE_PCT),
    ]);
    expect(stressSummons(0.5, 0.25)).toEqual({
      source: 'outer.summon',
      grant: {
        kind: 'drone',
        drones: 24,
        turrets: 8,
        damagePct: 0.5,
        turretDamagePct: 0.25,
        name: 'stress',
      },
    });
    expect(STRESS_SUMMON_CAP).toBe(32);
    expect(v4.modules.map((module) => module.summonCap).filter((cap) => cap !== undefined)).toEqual(
      [STRESS_SUMMON_CAP],
    );
    expect(v4.modules).toHaveLength(3);
    // Its other fields are stressBase's: 20 timed runs and 3 warm-ups, segmentsAllShocked.
    const fields = (scenario: Scenario) => ({ ...scenario, config: null, testModules: null });
    expect(fields(SCENARIOS.stress)).toEqual(fields(SCENARIOS.stressBase));
  });

  it('places its 24 drones and 8 turrets under the cap of 32, none refused (summonCapped 0)', () => {
    expect([STRESS_DRONES, STRESS_TURRETS]).toEqual([24, 8]);
    const run = placed(seedOne(SCENARIOS.stress));
    expect(run).toEqual({ drones: 24, turrets: 8, owners: [run.owners[0]], capped: 0 });
    const { config, data: runData, modules } = seedOne(SCENARIOS.stress);
    expect(summonWorkload(config, runData, modules).summonCapped).toBe(0);
  });

  it('flies its drones and fires its turrets at m = 2 from tick 1 (Q3 (A))', () => {
    expect(STRESS_SUMMON_M).toBe(2);
    const { ctx, firings } = watchRun(seedOne(SCENARIOS.stress), 600);
    expect(droneFrequencies(ctx)).toEqual([2]);
    // 8 turrets at 2 firings a second at the base attack speed, × m: 32 a second, 320 in 10 s.
    expect(firings).toBe(320);
  });

  it(`keeps its seed-1 alive within ${ALIVE_TWIN_DELTA} of stressBase’s and inside 280–320`, () => {
    const alive = seedOneWorkload('stress').averageAlive;
    const base = seedOneWorkload('stressBase').averageAlive;
    expect(Math.abs(alive - base)).toBeLessThanOrEqual(3);
    expect(alive).toBeGreaterThanOrEqual(ALIVE_MIN);
    expect(alive).toBeLessThanOrEqual(ALIVE_MAX);
    expect(aliveTwin(alive, base)).toBe(true);
  });

  it('has a grant data validation rejects, so building it without validation stays deliberate', () => {
    const start = data.talents.find((node) => node.kind === 'start') as TalentNode;
    const id = 'outer.summon.stress';
    // The real game data with one more node, linked to the start, that grants `grant`.
    const withGrant = (grant: DroneGrant): GameData => {
      const node: TalentNode = {
        id,
        kind: 'small',
        pos: { x: 600, y: 600 },
        links: [start.id],
        modifiers: [],
        rules: [],
        triggers: [],
        conversions: [],
        emitters: [grant],
        archetype: 'none',
        nameKey: `talent.${id}.name`,
        descKey: `talent.${id}.desc`,
      };
      const talents = data.talents.map((n) =>
        n === start ? { ...n, links: [...n.links, id] } : n,
      );
      return { ...data, talents: [...talents, node] };
    };
    const grant = stressSummons(STRESS_DRONE_DAMAGE_PCT, STRESS_TURRET_DAMAGE_PCT)
      .grant as DroneGrant;
    // The same grant at 24 slots passes, so the node reaches validation whole.
    expect(validateGameData(withGrant({ ...grant, drones: 16 }))).toEqual([]);
    expect(validateGameData(withGrant(grant))).toEqual([
      `talent '${id}': emitters[0] drones + turrets must be in [1, 24] (got 32)`,
    ]);
    expect(() => parseGameData(withGrant(grant))).toThrow(
      /Invalid game data.*drones \+ turrets must be in \[1, 24\] \(got 32\)/s,
    );
  });
});

describe('hiveStress (docs/v3 C5 design §7.4)', () => {
  const hiveStress = PRINT_ONLY.hiveStress;

  it('is print-only: in neither SCENARIO_IDS nor CHECK_ENTRIES, so --check never times it', () => {
    expect(Object.keys(PRINT_ONLY)).toEqual(['hiveStress']);
    expect(SCENARIO_IDS).not.toContain('hiveStress');
    expect(Object.keys(SCENARIOS)).toEqual([...SCENARIO_IDS]);
    expect(CHECK_ENTRIES.filter((entry) => entry.startsWith('hive'))).toEqual(['hive']);
  });

  it('is the stress fixture under the swarm, chainCount 2, with 螢火’s droneImpact pulse zone', () => {
    const { config } = seedOne(hiveStress);
    expect(hiveStress.data).toBe(stressData);
    expect([config.signature, config.startWave, config.maxTicks]).toEqual([
      { id: 'swarm' },
      30,
      1800,
    ]);
    expect(config.stats.values.chainCount).toBe(2);
    expect(config.stats.triggers).toEqual([
      {
        source: 'fusion.summon.aura',
        spec: {
          on: 'droneImpact',
          do: [{ kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 0.25 }],
        },
      },
    ]);
    expect(config.stats.emitters).toEqual([]);
  });

  it('fills the signature’s 24 slots, 20 drones and 4 turrets, at m = 2', () => {
    expect(placed(seedOne(hiveStress))).toEqual({ drones: 20, turrets: 4, owners: [0], capped: 0 });
    const { ctx, firings } = watchRun(seedOne(hiveStress), 600);
    expect(droneFrequencies(ctx)).toEqual([2]);
    // 4 turrets at 2 firings a second at the base attack speed, × m: 16 a second, 160 in 10 s.
    expect(firings).toBe(160);
  });

  it('queues a 2 s pulse zone of radius 80 at each drone impact, within C4’s zone caps', () => {
    const { config, data: runData, modules } = seedOne(hiveStress);
    const sim = createSimulation({ ...config, maxTicks: 600 }, runData, modules);
    const { state } = sim;
    let impacts = 0;
    let zones = 0;
    let mostEffectZones = 0;
    while (!state.finished) {
      for (const event of sim.step(NO_INPUT)) {
        if (event.type === 'impact' && event.droneId >= 0) impacts++;
        if (event.type !== 'zone') continue;
        zones++;
        expect([state.sources[event.source], event.signature, event.radius]).toEqual([
          'fusion.summon.aura',
          false,
          80,
        ]);
        const slot = state.zones.id.indexOf(event.id);
        const created = state.zones.created[slot] as number;
        expect((state.zones.expiresAt[slot] as number) - created).toBe(120);
      }
      expect(state.zoneCount).toBeLessThanOrEqual(ZONE_CAP);
      let effectZones = 0;
      for (let i = 0; i < state.zoneCount; i++) if (state.zones.signature[i] === 0) effectZones++;
      mostEffectZones = Math.max(mostEffectZones, effectZones);
    }
    expect(impacts).toBeGreaterThan(0);
    expect(zones).toBe(impacts);
    // One source's zones: ZONE_SOURCE_CAP at once, its next evicting its own oldest.
    expect(mostEffectZones).toBe(ZONE_SOURCE_CAP);
  });
});

describe('--share’s alive band (docs/v3 C5 design §7.3, PGR2-3)', () => {
  it(`holds within ${ALIVE_TWIN_DELTA} of stressBase and inside ${ALIVE_MIN}–${ALIVE_MAX}`, () => {
    expect(ALIVE_TWIN_DELTA).toBe(3);
    expect(aliveTwin(280.983, 280.894)).toBe(true);
    expect(aliveTwin(283, 280)).toBe(true);
    expect(aliveTwin(280, 283)).toBe(true);
    expect(aliveTwin(284, 280.5)).toBe(false);
    expect(aliveTwin(281, 285)).toBe(false);
    expect(aliveTwin(279.5, 281)).toBe(false);
    expect(aliveTwin(281, 279.5)).toBe(false);
    expect(aliveTwin(320, 318)).toBe(true);
    expect(aliveTwin(321, 319)).toBe(false);
  });
});

/** The gate's entries and the print-only ones, in shareChild's order. */
const GATE: readonly ShareEntry[] = ['stress', 'stressBase', 'normal'];
const PRINT: readonly ShareEntry[] = ['hiveStress', 'stressAilmentsOff', 'stressBase', 'normal'];
const rotated = (entries: readonly ShareEntry[], by: number): ShareEntry[] =>
  entries.map((_, i) => entries[(i + by) % entries.length] as ShareEntry);

/**
 * --share's processes on fixed numbers: `procs` of `rounds` rounds, round g = rounds × p + r on
 * seed 1 + g in shareChild's rotation, its gate runs' ms `gate(g)` and every print-only round's
 * hiveStress 22, ailments-off 66, stressBase 60 and normal 20 ms.
 */
function fixedProcesses(
  procs: number,
  rounds: number,
  gate: (g: number) => Partial<Record<ShareEntry, number>>,
): ShareProcess[] {
  const print = { hiveStress: 22, stressAilmentsOff: 66, stressBase: 60, normal: 20 };
  return Array.from({ length: procs }, (_, p) => {
    const round =
      (entries: readonly ShareEntry[], ms: (g: number) => Partial<Record<ShareEntry, number>>) =>
      (r: number) => {
        const g = rounds * p + r;
        return { seed: 1 + g, order: rotated(entries, g), ms: ms(g) };
      };
    return {
      gate: Array.from({ length: rounds }, (_, r) => round(GATE, gate)(r)),
      print: Array.from({ length: rounds }, (_, r) => round(PRINT, () => print)(r)),
    };
  });
}

/** Round g's share is 0.3 + 0.02 g at a normal of `normal` ms and stressBase 3 × normal. */
const shareRounds =
  (normal = 20) =>
  (g: number) => ({ stress: normal * (3.3 + 0.02 * g), stressBase: normal * 3, normal });
/** Rounds whose median total is `total` (round 10's), with stressBase 60 and normal 20 ms. */
const totalRounds = (total: number) => (g: number) => ({
  stress: 20 * total + 0.4 * (g - 10),
  stressBase: 60,
  normal: 20,
});

/** A workload as the share report reads it: its alive and its segment judgements. */
const work = (averageAlive: number, endpoints: number, averageShocked: number): Workload => ({
  ...pinned,
  lobAimMicros: null,
  averageAlive,
  segments: { ...pinned.segments, linked: 118, endpoints, averageShocked },
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
  v4: work(280.983, 13629, 133.3),
  base: work(280.894, 6757, 66.21466666666667),
  hive: work(259.1, 0, 0),
  off: work(279.571, 6431, 62.7),
  v4Summons: {
    ...NO_SUMMONS,
    drones: 24,
    turrets: 8,
    impacts: 922,
    splashVictims: 1254,
    firings: 960,
    turretShots: 1920,
    picks: 350,
    movingTicks: 37907,
    idleTicks: 5293,
    peakShots: 52,
    peakShotCount: 46,
    kills: 423,
    ailments: [
      ['outer.summon', { burn: 1278, poison: 954, bleed: 0, shock: 933 }],
      ['zone signature', { burn: 300, poison: 300, bleed: 0, shock: 150 }],
      ['no hit', { burn: 24, poison: 4380, bleed: 3, shock: 18 }],
    ],
  },
  baseSummons: {
    ...NO_SUMMONS,
    kills: 449,
    ailments: [['center', { burn: 2838, poison: 1008, bleed: 0, shock: 1020 }]],
  },
  pickMicros: 1.25,
};
const LIMIT = STRESS_TOTAL_LIMIT.toFixed(1);

describe('--share’s report (docs/v3 C5 design §7.3, §9 C5.6)', () => {
  it('prints every field: rounds, medians, IQRs, print-only rounds, report rows, decomposition', () => {
    const { lines, pass } = shareBody(fixedProcesses(3, 7, shareRounds()), WORK);
    expect(lines.slice(0, 8)).toEqual([
      'process 1, seed 1 (stress, stressBase, normal): stress 66.00 ms, stressBase 60.00 ms, ' +
        'normal 20.00 ms; total 3.300, stressBase 3.000, share 0.300',
      'process 1, seed 2 (stressBase, normal, stress): stress 66.40 ms, stressBase 60.00 ms, ' +
        'normal 20.00 ms; total 3.320, stressBase 3.000, share 0.320',
      'process 1, seed 3 (normal, stress, stressBase): stress 66.80 ms, stressBase 60.00 ms, ' +
        'normal 20.00 ms; total 3.340, stressBase 3.000, share 0.340',
      'process 1, seed 4 (stress, stressBase, normal): stress 67.20 ms, stressBase 60.00 ms, ' +
        'normal 20.00 ms; total 3.360, stressBase 3.000, share 0.360',
      'process 1, seed 5 (stressBase, normal, stress): stress 67.60 ms, stressBase 60.00 ms, ' +
        'normal 20.00 ms; total 3.380, stressBase 3.000, share 0.380',
      'process 1, seed 6 (normal, stress, stressBase): stress 68.00 ms, stressBase 60.00 ms, ' +
        'normal 20.00 ms; total 3.400, stressBase 3.000, share 0.400',
      'process 1, seed 7 (stress, stressBase, normal): stress 68.40 ms, stressBase 60.00 ms, ' +
        'normal 20.00 ms; total 3.420, stressBase 3.000, share 0.420',
      'process 1: median total 3.360, median share 0.360',
    ]);
    expect(lines[8]).toBe(
      'process 2, seed 8 (stressBase, normal, stress): stress 68.80 ms, stressBase 60.00 ms, ' +
        'normal 20.00 ms; total 3.440, stressBase 3.000, share 0.440',
    );
    expect([lines[15], lines[22], lines[23]]).toEqual([
      'process 2: median total 3.500, median share 0.500',
      'process 3, seed 21 (normal, stress, stressBase): stress 74.00 ms, stressBase 60.00 ms, ' +
        'normal 20.00 ms; total 3.700, stressBase 3.000, share 0.700',
      'process 3: median total 3.640, median share 0.640',
    ]);
    expect(lines.slice(24)).toEqual([
      'share (stress − stressBase) ÷ normal: median 0.500, IQR 0.400–0.600 over 21 rounds ' +
        '(design target 0.5, reported, never gated)',
      `total stress ÷ normal: median 3.500, IQR 3.400–3.600 over 21 rounds (the gate, against ` +
        `${LIMIT}: the verdict is the last line)`,
      "stressBase ÷ normal: median 3.000, IQR 3.000–3.000, against C4's 3.5 (within; recorded " +
        "for the C4 commits after C5.6, not C5.6's gate)",
      'normal: median 20.00 ms over the 21 rounds (precondition ≤ 25 ms: ok)',
      'hiveStress (print-only, docs/v3 C5 design §7.4): median 22.00 ms, median 1.100 × normal ' +
        "(IQR 1.100–1.100) beside stress v4's total 3.500; seed-1 average alive 259.1; 21 " +
        'rounds, normal median 20.00 ms',
      "ailments-off diagnostic (not the gate; the summons' ailment chances × 0): share median " +
        '0.300 (IQR 0.300–0.300), total median 3.300, seed-1 average alive 279.6; with them the ' +
        'share is 0.500',
      'stress v4 summons (seed 1, untimed):',
      '  24 drones and 8 turrets placed, summonCapped 0 (ok)',
      '  impacts 30.7/s (922), 1.36 splash victims per impact',
      '  turret firings 32.0/s (960), shots 64.0/s (1920 tried), projectilesCapped 0',
      '  picks 11.7/s (350), 1.25 µs per pick',
      '  drone-ticks 43200: 37907 moving, 5293 idle',
      '  peak shotCount 46',
      'decomposition against v3 (stressBase), seed 1, untimed:',
      '  stress v4: 115.5 shocked endpoints per judgement (average shocked 133.3); stressBase: ' +
        '57.3 shocked endpoints per judgement (average shocked 66.2)',
      '  kills/s: stress v4 14.1, stressBase 15.0',
      '  ailment applications/s of stress v4, by source class:',
      '    outer: burn 42.6, poison 31.8, shock 31.1',
      '    center (zones): burn 10.0, poison 10.0, shock 5.0',
      '    no hit: burn 0.8, poison 146.0, shock 0.6, bleed 0.1',
      '  ailment applications/s of stress v4, by source:',
      '    outer.summon: burn 42.6, poison 31.8, shock 31.1',
      '    zone signature: burn 10.0, poison 10.0, shock 5.0',
      '    no hit: burn 0.8, poison 146.0, shock 0.6, bleed 0.1',
      '  ailment applications/s of stressBase, by source class:',
      '    center: burn 94.6, poison 33.6, shock 34.0',
      '  ailment applications/s of stressBase, by source:',
      '    center: burn 94.6, poison 33.6, shock 34.0',
      `STRESS v4 (docs/v3 C5 design §7.3): median total 3.500 against ${LIMIT}: pass`,
    ]);
    expect(pass).toBe(true);
  });

  it('starts with the run, NOT A GATE RUN below 3 processes or 20 rounds, and the alive band', () => {
    const [run, alive] = shareHead(3, 7, 280.983, 280.894);
    expect(run).toBe(
      'bench --share (docs/v3 C5 design §7.3): 3 processes × (2 warm-up + 7 measured) rounds of ' +
        'stress, stressBase, normal, the order rotated every round, then as many print-only ' +
        'rounds of hiveStress, stressAilmentsOff, stressBase, normal',
    );
    expect(alive).toBe(
      'seed-1 average alive (ticks 301+): stress (v4) 280.983, stressBase 280.894 (difference ' +
        '0.089; within 3 and 280–320: valid); summons d 0.184, t 0.092, 24 drones + 8 turrets ' +
        'at cap 32, m 2',
    );
    expect(shareHead(4, 5, 281, 281)[0]).not.toContain('NOT A GATE RUN');
    for (const [procs, rounds] of [
      [2, 10],
      [3, 6],
      [1, 21],
    ] as const) {
      expect(shareHead(procs, rounds, 281, 281)[0]).toMatch(
        /; NOT A GATE RUN \(fewer than 3 processes or 20 measured rounds\)$/,
      );
    }
    expect(shareHead(3, 7, 285, 281)[1]).toContain('(difference 4.000; within 3 and 280–320: VOID');
  });

  it('never passes a run of fewer than 3 processes or 20 measured rounds', () => {
    for (const [procs, rounds] of [
      [2, 10],
      [3, 6],
      [1, 21],
    ] as const) {
      const { lines, pass } = shareBody(fixedProcesses(procs, rounds, shareRounds()), WORK);
      expect(pass).toBe(false);
      const counted = `${procs} process${procs === 1 ? '' : 'es'}, ${procs * rounds} measured rounds`;
      // The median of rounds 0 … n − 1, whose totals are 3.3 + 0.02 g.
      const median = 3.3 + 0.01 * (procs * rounds - 1);
      expect(lines.at(-1)).toBe(
        `STRESS v4 (docs/v3 C5 design §7.3): median total ${median.toFixed(3)} against ` +
          `${LIMIT}: NOT A GATE RUN ` +
          `(${counted}; a gate run takes at least 3 processes and 20 measured rounds in all), ` +
          'never a pass',
      );
    }
    expect(shareBody(fixedProcesses(4, 5, shareRounds()), WORK).pass).toBe(true);
  });

  it('prints the report and exits 1 unless it passes the run, so no run below the gate exits 0', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitCode = process.exitCode;
    try {
      for (const [procs, rounds, pass] of [
        [1, 21, false],
        [2, 10, false],
        [3, 7, true],
      ] as const) {
        process.exitCode = undefined;
        log.mockClear();
        const processes = fixedProcesses(procs, rounds, shareRounds());
        expect(shareReport(processes, WORK)).toBe(pass);
        expect(process.exitCode).toBe(pass ? undefined : 1);
        expect(log.mock.calls).toEqual(shareBody(processes, WORK).lines.map((line) => [line]));
      }
    } finally {
      process.exitCode = exitCode;
      log.mockRestore();
    }
  });

  it('passes only within the limit, the alive band and the normal precondition', () => {
    const verdict = (processes: ShareProcess[], shareWork = WORK) => {
      const { lines, pass } = shareBody(processes, shareWork);
      return [lines.at(-1)?.replace(/^STRESS v4 \(docs\/v3 C5 design §7\.3\): /, ''), pass];
    };
    const over = STRESS_TOTAL_LIMIT + 0.25;
    expect(verdict(fixedProcesses(3, 7, totalRounds(over)))).toEqual([
      `median total ${over.toFixed(3)} against ${LIMIT}: OVER THE LIMIT`,
      false,
    ]);
    expect(verdict(fixedProcesses(3, 7, totalRounds(STRESS_TOTAL_LIMIT)))[1]).toBe(true);
    expect(verdict(fixedProcesses(3, 7, shareRounds()), { ...WORK, v4: work(285, 0, 0) })).toEqual([
      `median total 3.500 against ${LIMIT}: VOID (seed-1 alive outside the band: retune d and t)`,
      false,
    ]);
    expect(verdict(fixedProcesses(3, 7, shareRounds(26)))).toEqual([
      `median total 3.500 against ${LIMIT}: not read (normal precondition failed)`,
      false,
    ]);
    const { lines } = shareBody(fixedProcesses(3, 7, shareRounds(26)), WORK);
    expect(lines).toContain(
      'normal: median 26.00 ms over the 21 rounds (precondition ≤ 25 ms: FAILED, rerun at most 3 ' +
        'times, then stop and report)',
    );
  });

  it('within 3 % of the limit, prints the rerun rule: two more runs, the median of three', () => {
    const window =
      `(${(STRESS_TOTAL_LIMIT * 0.97).toFixed(3)}–${(STRESS_TOTAL_LIMIT * 1.03).toFixed(3)}): ` +
      'run the same command twice more, and the gate is the median of the three totals';
    for (const [total, verdict, pass] of [
      [STRESS_TOTAL_LIMIT * 0.99, 'pass', true],
      [STRESS_TOTAL_LIMIT * 1.01, 'OVER THE LIMIT', false],
    ] as const) {
      const result = shareBody(fixedProcesses(3, 7, totalRounds(total)), WORK);
      expect(result.lines.at(-1)).toBe(
        `STRESS v4 (docs/v3 C5 design §7.3): median total ${total.toFixed(3)} against ${LIMIT}: ` +
          `${verdict}; within 3 % of the limit ${window}`,
      );
      expect(result.pass).toBe(pass);
    }
  });
});

describe('grants (docs/v3 C4 design §7.3, §8.3 C4.21)', () => {
  it('is a stress-family scenario, last in SCENARIO_IDS and CHECK_ENTRIES: an aura, two rings of 4 orbs and thorns on M1’s attack', () => {
    const grants = SCENARIOS.grants;
    expect(SCENARIO_IDS.at(-1)).toBe('grants');
    expect(CHECK_ENTRIES.at(-1)).toBe('grants');
    expect([grants.runs, grants.warmup, grants.seconds, grants.targetMs, grants.startWave]).toEqual(
      [20, 3, 30, 50, 30],
    );
    expect([grants.stress, grants.testModules, grants.capProbe, grants.allShocked]).toEqual([
      true,
      undefined,
      undefined,
      undefined,
    ]);
    expect(grants.data).toBe(stressData);
    const run = seedOne(grants);
    expect(run.config.signature).toBeUndefined();
    expect(run.config.stats.values.auraRadius).toBe(160);
    expect(run.config.stats.emitters).toEqual([
      { source: 'outer.aura', grant: { kind: 'aura', everyNth: { n: 4, mult: 4 } } },
      { source: 'outer.aura', grant: { kind: 'orbit', count: 4 } },
      { source: 'outer.aura', grant: { kind: 'orbit', ring: 1, count: 4 } },
      { source: 'outer.thorns', grant: { kind: 'thorns' } },
    ]);
    const { ctx } = watchRun(run, 1);
    expect(ctx.emitters.map((em) => [em.spec.kind, em.orbs?.n ?? null])).toEqual([
      ['volley', null],
      ['aura', null],
      ['orbit', 4],
      ['orbit', 4],
      ['thorns', null],
    ]);
  });
});
