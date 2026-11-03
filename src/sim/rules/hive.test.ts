import { describe, expect, it } from 'vitest';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import { SCOPED_STATS } from '../../data/stats';
import { compileBuild } from '../build/compile';
import { createSimulation } from '../simulation';
import type { DronePool } from '../systems/systemState';
import { makeConfig, makeStats, makeTestData } from '../testing';
import { DRONE_KIND_SPIRIT, NO_INPUT } from '../types';
import { COLOSSUS_GROWTH, HAMMER_SLOT, HIVE_TIMED_IMPACTS, QUEEN_SLOT } from './hive';

const SWARM: SignatureSpec = { id: 'swarm' };
const MAGMA: SignatureSpec = { id: 'magmaBomb' };

/** The drones' more modifiers a build's rules added, as their values. */
const droneMores = (rules: readonly RuleSpec[]): number[] =>
  compileBuild(makeStats(), rules, SWARM)
    .mods.filter((m) => m.stat === SCOPED_STATS.indexOf('damage') && m.kind === 2)
    .map((m) => m.value);

/** Runs `rules` on the swarm for `ticks` and counts the timed rows it saw spawn. */
function timedRows(rules: readonly RuleSpec[], ticks: number): { spawned: number; peak: number } {
  const sim = createSimulation(
    makeConfig({ stats: makeStats({ maxLife: 1e12 }), signature: SWARM, rules, maxTicks: ticks }),
    makeTestData(),
  );
  const ds = sim.state.drones as DronePool;
  let expired = 0;
  let peak = 0;
  while (!sim.state.finished) {
    expired += sim.step(NO_INPUT).filter((e) => e.type === 'droneExpire').length;
    let live = 0;
    for (let s = 0; s < ds.count; s++) if (ds.kind[s] === DRONE_KIND_SPIRIT) live++;
    peak = Math.max(peak, live);
  }
  let live = 0;
  for (let s = 0; s < ds.count; s++) if (ds.kind[s] === DRONE_KIND_SPIRIT) live++;
  return { spawned: expired + live, peak };
}

describe('swarm counts (swarmTune, hiveExpand, hiveBuild, colossus)', () => {
  it('量產 adds turrets and 回收 zeroes the dock time', () => {
    const build = compileBuild(
      makeStats(),
      [
        { id: 'swarmTune', turrets: 2, dockSecMult: 1 },
        { id: 'swarmTune', turrets: 0, dockSecMult: 0 },
      ],
      SWARM,
    );
    expect(build.signature.swarm).toMatchObject({ drones: 3, turrets: 3, dockSec: 0 });
  });

  it('擴巢 and 增建 add drones and turrets', () => {
    const build = compileBuild(
      makeStats(),
      [
        { id: 'hiveExpand', drones: 3 },
        { id: 'hiveBuild', turrets: 2 },
      ],
      SWARM,
    );
    expect(build.signature.swarm).toMatchObject({ drones: 6, turrets: 3 });
  });

  it('巨像 keeps one drone and adds a more of 50% per drone given up', () => {
    const build = compileBuild(makeStats(), [{ id: 'colossus', damagePerMissing: 0.5 }], SWARM);
    expect(build.signature.swarm?.drones).toBe(1);
    expect(droneMores([{ id: 'colossus', damagePerMissing: 0.5 }])).toEqual([1]);
  });

  it('under 巨像, 擴巢 gives its drones up too: 1 + 0.5 × 5 in all', () => {
    const rules: RuleSpec[] = [
      { id: 'colossus', damagePerMissing: 0.5 },
      { id: 'hiveExpand', drones: 3 },
    ];
    const build = compileBuild(makeStats(), rules, SWARM);
    expect(build.signature.swarm?.drones).toBe(1);
    const product = droneMores(rules).reduce((p, v) => p * (1 + v), 1);
    expect(product).toBeCloseTo(3.5, 12);
  });

  it.each(['swarmTune', 'colossus', 'hiveExpand', 'hiveBuild', 'motherFactory'] as const)(
    '%s is a compile error in a run of another signature',
    (id) => {
      const spec = {
        swarmTune: { id: 'swarmTune', turrets: 1, dockSecMult: 1 },
        colossus: { id: 'colossus', damagePerMissing: 0.5 },
        hiveExpand: { id: 'hiveExpand', drones: 1 },
        hiveBuild: { id: 'hiveBuild', turrets: 1 },
        motherFactory: { id: 'motherFactory', periodSec: 6, lifeSec: 4, damagePct: 2 },
      }[id] as RuleSpec;
      expect(() => compileBuild(makeStats(), [spec], MAGMA)).toThrow(
        `rule '${id}' tunes the swarm signature, but this run's signature is 'magmaBomb'`,
      );
    },
  );
});

describe('timed drones (hiveSplit, breed, royalJelly, motherFactory)', () => {
  it('分巢 compiles a timed drone of its numbers that flies a sortie at the outer enemies', () => {
    const build = compileBuild(
      makeStats(),
      [{ id: 'hiveSplit', every: 5, lifeSec: 6, damagePct: 2, maxLive: 8 }],
      SWARM,
    );
    expect(build.effects.map((fx) => fx.spec)).toContainEqual(
      expect.objectContaining({
        kind: 'spawnDrone',
        lifeSec: 6,
        damagePct: 2,
        maxLive: 8,
        aim: 'outer',
        impacts: HIVE_TIMED_IMPACTS,
      }),
    );
    expect(build.hooks.onKill).toHaveLength(1);
  });

  it('分巢 spawns at every 5th kill, at most maxLive at once', () => {
    const { spawned, peak } = timedRows(
      [{ id: 'hiveSplit', every: 5, lifeSec: 6, damagePct: 2, maxLive: 3 }],
      1800,
    );
    expect(spawned).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('蜂王漿 lengthens 繁衍’s drones, compiled after it', () => {
    const build = compileBuild(
      makeStats(),
      [
        { id: 'royalJelly', lifeMult: 1.5 },
        { id: 'breed', chance: 0.2, lifeSec: 6, damagePct: 2, maxLive: 12 },
      ],
      SWARM,
    );
    expect(build.effects.map((fx) => fx.spec)).toContainEqual(
      expect.objectContaining({ kind: 'spawnDrone', lifeSec: 9 }),
    );
  });

  it('母艦工廠 launches one drone from each of the swarm’s turrets every period', () => {
    const one = timedRows([{ id: 'motherFactory', periodSec: 1, lifeSec: 0.5, damagePct: 2 }], 600);
    const three = timedRows(
      [
        { id: 'motherFactory', periodSec: 1, lifeSec: 0.5, damagePct: 2 },
        { id: 'hiveBuild', turrets: 2 },
      ],
      600,
    );
    // 10 periods in 600 ticks; the last may still sit in the queue at the end.
    expect(one.spawned).toBeGreaterThanOrEqual(9);
    expect(one.spawned).toBeLessThanOrEqual(10);
    expect(three.spawned).toBeGreaterThanOrEqual(27);
    expect(three.spawned).toBeLessThanOrEqual(30);
  });
});

describe('E4-backed ◆ (queenRole, hammerRole, focusFire, outpost, 巨像 size)', () => {
  it('蜂后 and 重錘 take slots 0 and 1, the queen leading', () => {
    const build = compileBuild(
      makeStats(),
      [
        { id: 'queenRole', damageMult: 2, sizeMult: 1.5, followBonus: 0.2 },
        { id: 'hammerRole', damageMult: 5, speedMult: 0.4 },
      ],
      SWARM,
    );
    expect(build.signature.swarm?.roles).toEqual([
      { slot: QUEEN_SLOT, damageMult: 2, speedMult: 1, sizeMult: 1.5, followBonus: 0.2 },
      { slot: HAMMER_SLOT, damageMult: 5, speedMult: 0.4, sizeMult: 1, followBonus: 0 },
    ]);
  });

  it('集火指令 sets the highest-hp pick; 前哨 moves the turrets out', () => {
    const build = compileBuild(
      makeStats(),
      [{ id: 'focusFire' }, { id: 'outpost', turretRadius: 220 }],
      SWARM,
    );
    expect(build.flags.summonHighestHp).toBe(true);
    expect(build.signature.swarm?.turretRadius).toBe(220);
  });

  it('巨像 grows its drone by COLOSSUS_GROWTH per drone given up, 擴巢 included', () => {
    const one = compileBuild(makeStats(), [{ id: 'colossus', damagePerMissing: 0.5 }], SWARM);
    expect(one.signature.swarm?.sizeMult).toBeCloseTo(1 + 2 * COLOSSUS_GROWTH, 12);
    const more = compileBuild(
      makeStats(),
      [
        { id: 'colossus', damagePerMissing: 0.5 },
        { id: 'hiveExpand', drones: 3 },
      ],
      SWARM,
    );
    expect(more.signature.swarm?.sizeMult).toBeCloseTo(1 + 5 * COLOSSUS_GROWTH, 12);
  });
});

describe('E5-backed ◆ (selfDestruct, interceptors, swarmSurge)', () => {
  it('自爆協議, 攔截守衛 and 蜂潮 write the swarm’s lastImpact, guards and surge', () => {
    const build = compileBuild(
      makeStats(),
      [
        { id: 'selfDestruct', radius: 80, damagePct: 1.5 },
        { id: 'interceptors', count: 2, radius: 120 },
        { id: 'swarmSurge', periodSec: 8, damageMult: 2 },
      ],
      SWARM,
    );
    expect(build.signature.swarm).toMatchObject({
      lastImpact: { radius: 80, damagePct: 1.5 },
      guards: { count: 2, radius: 120 },
      surge: { periodSec: 8, damageMult: 2 },
    });
  });

  it.each([
    { id: 'selfDestruct', radius: 80, damagePct: 1.5 },
    { id: 'interceptors', count: 2, radius: 120 },
    { id: 'swarmSurge', periodSec: 8, damageMult: 2 },
  ] as const)('$id is a compile error in a run of another signature', (spec) => {
    expect(() => compileBuild(makeStats(), [spec], MAGMA)).toThrow(
      `rule '${spec.id}' tunes the swarm signature, but this run's signature is 'magmaBomb'`,
    );
  });

  it('all three play together with the E4 roles for a minute', () => {
    const sim = createSimulation(
      makeConfig({
        stats: makeStats({ maxLife: 1e12 }),
        signature: SWARM,
        rules: [
          { id: 'queenRole', damageMult: 2, sizeMult: 1.5, followBonus: 0.2 },
          { id: 'hammerRole', damageMult: 5, speedMult: 0.4 },
          { id: 'focusFire' },
          { id: 'selfDestruct', radius: 80, damagePct: 1.5 },
          { id: 'interceptors', count: 2, radius: 120 },
          { id: 'swarmSurge', periodSec: 8, damageMult: 2 },
        ],
        maxTicks: 1800,
      }),
      makeTestData(),
    );
    let surges = 0;
    while (!sim.state.finished) {
      surges += sim.step(NO_INPUT).filter((e) => e.type === 'droneSurge').length;
    }
    expect(surges).toBeGreaterThan(0);
  });
});
