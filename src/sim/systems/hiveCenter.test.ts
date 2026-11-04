/**
 * E5: 蜂巢's center board parts (docs/v3/game-design-v3.md:181-197; lead rulings K1–K4), which
 * B2's rule modules will set on the swarm's SwarmParams: 自爆協議 (lastImpact: the impact that
 * spends a sortie explodes), 攔截守衛 (guards: the swarm's last drones orbit the player, each on
 * its own angle (K2-R1), charging dashers first, and the charge start's forced picks) and 蜂潮
 * (surge: every swarm drone at the
 * densest enemy at once, its next impact there × damageMult), and compileBuild's checks on them.
 * Test modules stand in for B2's. Each test names in a comment the planted bugs it kills.
 */

import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import { createRng } from '../../core/rng';
import type { SourcedEmitter } from '../../data/emitters';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import type { SpawnDroneSpec, TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { compileBuild } from '../build/compile';
import type { BuildFlags, DroneRole, SwarmParams } from '../build/compile';
import { sizeOf } from '../build/size';
import { DRONE_MEMORY, GUARD_REV_PER_SEC, PICK_TICKS } from '../caps';
import { CHAIN_JUMP, PRIMARY, SIGNATURE } from '../effects/flags';
import { runEffect } from '../effects/execute';
import { createEffectEntry } from '../effects/queue';
import { EVENT } from '../effects/types';
import type { EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { eventsOf, makeStats, placedEnemies, TEST_V3_WAVES, v3TestData } from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_DASH,
  DRONE_DOCKED,
  DRONE_FIXED,
  DRONE_GUARD,
  DRONE_HOVER,
  DRONE_KIND_DRONE,
  DRONE_KIND_SPIRIT,
  DRONE_KIND_TURRET,
  DRONE_RETURN,
  TICK_RATE,
} from '../types';
import type { SimEvent } from '../types';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import { densest, guardPick, pickOuter, stepDrones, swarmRepeat } from './drones';
import { CHARGING, STOPPED, stepEnemyAi } from './enemyAi';
import type { EnemyV3 } from './enemyRecord';
import { rebuildGrid } from './grid';
import type { DroneSurge } from './systemState';

type ImpactEvent = Extract<SimEvent, { type: 'impact' }>;
type SurgeEvent = Extract<SimEvent, { type: 'droneSurge' }>;

/** The player, at the arena's centre. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** Damage 10 and no crits or ignites unless `values` say so: the hits draw nothing. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
const SWARM: SignatureSpec = { id: 'swarm' };
const GIANT: RuleSpec = { id: 'gigantism', sizeMult: 2 };
/** A swarm drone's step a tick at m = 1 (SwarmParams.speed 600 / 60). */
const STEP = 10;
/** The guards' ring in these tests: gd's 攔截守衛, 「半徑 120」. */
const RING = 120;
/** The dock radius (DRONE_DEFAULTS.dockRadius) and the turrets' (turretRadius), written out. */
const DOCK = 43;
const SEAT = 90;
/** An impact of the swarm at its 200% of damage 10, and one of a granted drone at its 80%. */
const IMPACT = 20;
const GRANTED = 8;

const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...more,
});
/** A dasher (衝刺者) at (dx, dy) from the player: at 420 or closer it charges on its AI step. */
const dasher = (dx: number, dy: number): PlacedEnemy => at(dx, dy, { type: 'dasher' });

/** A test module writing `fields` over the swarm's SwarmParams: what B2's modules will do. */
const swarmParams =
  (fields: Partial<SwarmParams>): TestModule =>
  (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, fields);
  };
/** A test module writing `flags` over the build's. */
const policy =
  (flags: Partial<BuildFlags>): TestModule =>
  (b) =>
    void Object.assign(b.flags, flags);
const STAY = policy({ dronesStay: true });
/** 自爆協議 as gd has it: 「半徑 80、150% 傷害」. */
const BLAST: Partial<SwarmParams> = { lastImpact: { radius: 80, damagePct: 1.5 } };
const guards = (count: number, radius = RING): Partial<SwarmParams> => ({
  guards: { count, radius },
});
const surge = (periodSec: number, damageMult = 2): Partial<SwarmParams> => ({
  surge: { periodSec, damageMult },
});

/** v3 data whose waves spawn nothing: only the placed enemies, dashers among them, exist. */
const QUIET_V3: GameData = v3TestData({
  waves: {
    rules: [{ enemy: 'triangle', fromWave: 1, base: 0, perWave: 0, maxCount: 0 }],
    eliteEvery: 1000,
    bossEvery: 1000,
    spawnDurationSec: 0,
    waveTimerSec: 1000,
    v3: {
      ...TEST_V3_WAVES.v3,
      affixes: [],
      treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
    },
  },
});

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly modules?: readonly TestModule[];
  readonly grants?: readonly SourcedEmitter[];
  readonly rules?: readonly RuleSpec[];
  readonly triggers?: readonly TriggerSpec[];
  readonly data?: GameData;
}

/** placedEnemies with the swarm signature, its SwarmParams with `params`, over NO_ROLLS. */
function hive(
  placed: readonly PlacedEnemy[],
  params: Partial<SwarmParams>,
  options: Options = {},
): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    rules: options.rules ?? [],
    modules: [swarmParams(params), ...(options.modules ?? [])],
    signature: SWARM,
    ...(options.data === undefined ? {} : { data: options.data }),
  });
}

/** A swarm of `drones` drones and no turret, its last `count` guards at RING, on QUIET_V3. */
const guarded = (
  placed: readonly PlacedEnemy[],
  count: number,
  drones: number,
  options: Options = {},
): RunContext =>
  hive(placed, { drones, turrets: 0, ...guards(count) }, { data: QUIET_V3, ...options });

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const swarmOf = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;
const impacts = (events: readonly SimEvent[]): ImpactEvent[] => eventsOf([events], 'impact');
const surges = (events: readonly SimEvent[]): SurgeEvent[] => eventsOf([events], 'droneSurge');
/** Every hit of `events` as [target id, amount], in order. */
const hitAmounts = (events: readonly SimEvent[]): number[][] =>
  eventsOf([events], 'hit').map((h) => [h.targetId, toNumber(h.amount)]);
const surgeOf = (ctx: RunContext): DroneSurge => ctx.sys.drones.surge as DroneSurge;
const v3 = (e: Enemy): EnemyV3 => e.v3 as EnemyV3;

/** Runs the drone stage on the current tick; returns its events. */
function stage(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepDrones(ctx);
  return ctx.events.slice();
}

/** The next tick's drone stage, the enemies standing where they are. */
function next(ctx: RunContext): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  rebuildGrid(ctx);
  return stage(ctx);
}

/** The next tick's enemy AI step (a v3 run's: dashers start charging) and drone stage. */
function nextAi(ctx: RunContext): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  ctx.events.length = 0;
  stepEnemyAi(ctx);
  rebuildGrid(ctx);
  stepDrones(ctx);
  return ctx.events.slice();
}

/** Puts slot s in DASH at `target`, at (x, y): what engage leaves. */
function dashing(ctx: RunContext, s: number, target: Enemy, x?: number, y?: number): void {
  const ds = ctx.sys.drones;
  ds.mode[s] = DRONE_DASH;
  ds.target[s] = target;
  ds.targetId[s] = target.id;
  if (x !== undefined) ds.x[s] = x;
  if (y !== undefined) ds.y[s] = y;
}

/** Makes `e` a dasher charging its dash, as its AI step leaves it (CHARGING | STOPPED). */
function charge(e: Enemy): void {
  v3(e).state = CHARGING | STOPPED;
  v3(e).stateUntil = 1e9;
}

/** Slot s remembers enemy `id` until `until`, in memory entry `k`. */
function memorize(ctx: RunContext, s: number, k: number, id: number, until: number): void {
  const ds = ctx.sys.drones;
  ds.memId[s * DRONE_MEMORY + k] = id;
  ds.memUntil[s * DRONE_MEMORY + k] = until;
}

/** A guard's orbit step a tick on its orbit (K2-R1), written out: 0.5 turns a second. */
const OMEGA = (2 * Math.PI * 0.5) / 60;
/** The point at angle `a` on the ring of `radius` around the player. */
const ringPoint = (a: number, radius = RING): { x: number; y: number } => ({
  x: P.x + radius * Math.cos(a),
  y: P.y + radius * Math.sin(a),
});
/**
 * Guard g of n's orbit point after `turns` stage starts on its orbit, by the rulings' formula,
 * written out: angle 2πg/n + turns × OMEGA. A guard that never left its orbit had one a tick from
 * tick 1, so its `turns` is the tick.
 */
function orbitPoint(g: number, n: number, turns: number, radius = RING): { x: number; y: number } {
  return ringPoint((2 * Math.PI * g) / n + turns * OMEGA, radius);
}

/** Slot s's distance from the player and its angle in [0, 2π), each to 9 places. */
function polar(ctx: RunContext, s: number): [number, number] {
  const ds = ctx.sys.drones;
  const dx = (ds.x[s] as number) - P.x;
  const dy = (ds.y[s] as number) - P.y;
  const a = Math.atan2(dy, dx);
  const round = (v: number): number => Math.round(v * 1e9) / 1e9;
  return [round(Math.hypot(dx, dy)), round(a < -1e-12 ? a + 2 * Math.PI : Math.max(0, a))];
}
const round9 = (v: number): number => Math.round(v * 1e9) / 1e9;

describe('自爆協議: the impact that spends a sortie explodes (lead ruling K1)', () => {
  /**
   * E1 300 right of the player, E2 30 from it (in the splash of 40), E3 60 from it (in the
   * explosion's 80 alone) and E4 90 from it (in neither).
   */
  const SPLASH = [at(300, 0), at(300, 30), at(240, 0), at(300, -90)];

  /** A one-drone swarm sitting on E1 in DASH with a full sortie. */
  function onTarget(
    placed: readonly PlacedEnemy[],
    params: Partial<SwarmParams>,
    options: Options = {},
  ): RunContext {
    const ctx = hive(placed, { drones: 1, turrets: 0, ...params }, options);
    const t = enemy(ctx, 1);
    dashing(ctx, 0, t, t.x, t.y);
    return ctx;
  }

  /** The impacts of `ticks` ticks of the stage: [radius, its hits as [id, amount]] each. */
  function sortie(ctx: RunContext, ticks: number): [number, number[][]][] {
    const out: [number, number[][]][] = [];
    for (let k = 0; k < ticks; k++) {
      const events = k === 0 ? stage(ctx) : next(ctx);
      for (const e of impacts(events)) out.push([e.radius, hitAmounts(events)]);
    }
    return out;
  }

  it('hits a sortie’s first two impacts at the splash and scale 1, and explodes its third at 80 and 1.5 / 2 of an impact: an enemy 60 away takes the third alone', () => {
    // Planted bugs: the explosion on the first impact of a sortie; its scale = damagePct (×1.5
    // of an impact's, 30), not over the payload's share (×0.75, 15).
    const ctx = onTarget(SPLASH, BLAST);
    const ds = ctx.sys.drones;
    expect([ds.lastImpactSq, ds.lastImpactScale, swarmOf(ctx).spec.damagePct]).toEqual([
      6400, 0.75, 2,
    ]);
    expect(sortie(ctx, 70)).toEqual([
      [
        40,
        [
          [1, IMPACT],
          [2, IMPACT],
        ],
      ],
      [
        40,
        [
          [1, IMPACT],
          [2, IMPACT],
        ],
      ],
      [
        80,
        [
          [1, 15],
          [2, 15],
          [3, 15],
        ],
      ],
    ]);
    // Then home, as a spent sortie goes.
    expect([ds.mode[0], ds.impactsLeft[0]]).toEqual([DRONE_RETURN, 0]);
    // Without it, the third is an impact like the others.
    const plain = onTarget(SPLASH, {});
    expect(sortie(plain, 70).map(([radius, hits]) => [radius, hits.length])).toEqual([
      [40, 2],
      [40, 2],
      [40, 2],
    ]);
    expect([plain.sys.drones.lastImpactSq, plain.sys.drones.lastImpactScale]).toEqual([0, 0]);
  });

  it('sizes the explosion by the area as the splash: areaSize 1.5 gives 60 and 120, an enemy 110 away in the third alone', () => {
    // Planted bug: the explosion radius not sized (80 at any areaSize).
    const ctx = onTarget([at(300, 0), at(190, 0)], BLAST, { values: { areaSize: 1.5 } });
    expect(ctx.sys.drones.lastImpactSq).toBe(sizeOf(ctx.build, 80) ** 2);
    expect(sortie(ctx, 70)).toEqual([
      [60, [[1, IMPACT]]],
      [60, [[1, IMPACT]]],
      [
        120,
        [
          [1, 15],
          [2, 15],
        ],
      ],
    ]);
  });

  it('explodes every sortie’s only impact with impacts 1, sortie after sortie', () => {
    const run = (params: Partial<SwarmParams>): number[] => {
      const ctx = hive([at(300, 0), at(240, 0)], { drones: 1, turrets: 0, impacts: 1, ...params });
      const radii: number[] = [];
      for (let k = 0; k < 400; k++) {
        for (const e of impacts(k === 0 ? stage(ctx) : next(ctx))) radii.push(e.radius);
      }
      return radii;
    };
    const blasts = run(BLAST);
    expect(blasts.length).toBeGreaterThanOrEqual(3);
    expect(blasts).toEqual(Array<number>(blasts.length).fill(80));
    expect(run({})).toEqual(Array<number>(blasts.length).fill(40));
  });

  it('never explodes under 蟲海 (dronesStay), whose sorties never end: every impact the splash at scale 1', () => {
    // Planted bug: the explosion under dronesStay.
    const ctx = onTarget(SPLASH, BLAST, { modules: [STAY] });
    const ds = ctx.sys.drones;
    expect([ds.lastImpactSq, ds.lastImpactScale, ds.impactRules]).toEqual([0, 0, false]);
    ds.impactsLeft[0] = 1;
    const seen = sortie(ctx, 300);
    expect(seen.length).toBeGreaterThan(5);
    for (const [radius, hits] of seen) {
      expect(radius).toBe(40);
      for (const [, amount] of hits) expect(amount).toBe(IMPACT);
    }
  });

  it('never explodes a granted drone’s last impact, nor a repeat of the swarm', () => {
    // Planted bug: a granted drone exploding (the swarm's explosion on every drone emitter).
    const grant: SourcedEmitter = { source: 'outer.summon', grant: { kind: 'drone', drones: 1 } };
    const ctx = hive(SPLASH, { drones: 1, turrets: 0, ...BLAST }, { grants: [grant] });
    const ds = ctx.sys.drones;
    expect(Array.from(ds.owner.subarray(0, ds.count))).toEqual([0, 1]);
    // The swarm's drone docked out of the way; the granted one on its sortie's last impact.
    ds.dockLeft[0] = 1e9;
    const t = enemy(ctx, 1);
    dashing(ctx, 1, t, t.x, t.y);
    ds.impactsLeft[1] = 1;
    const events = stage(ctx);
    expect(impacts(events).map((e) => [e.droneId, e.radius])).toEqual([[2, 40]]);
    expect(hitAmounts(events)).toEqual([
      [1, GRANTED],
      [2, GRANTED],
    ]);
    // A repeat: an impact of no drone at the farthest enemy (E4, 316 away), its splash and 1.
    ctx.events.length = 0;
    swarmRepeat(ctx, swarmOf(ctx), swarmOf(ctx).payload, 1, -1);
    expect(impacts(ctx.events).map((e) => [e.droneId, e.radius, e.targetId])).toEqual([
      [-1, 40, 4],
    ]);
    expect(hitAmounts(ctx.events)).toEqual([[4, IMPACT]]);
  });

  it('is an impact in all else: counted as an attack, its target the primary hit, its chain, droneImpact and the impact event at 80', () => {
    // Planted bug: the explosion as an uncounted impact (no attack, no PRIMARY, no center event).
    const seen: number[][] = [];
    const attacks: number[] = [];
    let centers = 0;
    const spy: TestModule = (b) => {
      b.hook('onHit', (_ctx, hit) => {
        seen.push([hit.target.id, hit.chainIndex, hit.flags & (SIGNATURE | PRIMARY | CHAIN_JUMP)]);
      });
      b.hook('onAttack', (_ctx, em) => void attacks.push(em.attacks));
      b.hook('onCenterEvent', (_ctx, ev) => {
        if (ev.event === EVENT.droneImpact) centers++;
      });
    };
    const ctx = onTarget(SPLASH, BLAST, { values: { chainCount: 1 }, modules: [spy] });
    ctx.sys.drones.impactsLeft[0] = 1;
    const events = stage(ctx);
    // E4, 90 away, past the explosion: the chain's one jump.
    expect(seen).toEqual([
      [1, 0, SIGNATURE | PRIMARY],
      [2, 0, SIGNATURE],
      [3, 0, SIGNATURE],
      [4, 1, SIGNATURE | CHAIN_JUMP],
    ]);
    expect([attacks, centers]).toEqual([[1], 1]);
    expect(impacts(events)).toEqual([
      { type: 'impact', droneId: 1, x: P.x + 300, y: P.y, radius: 80, targetId: 1, count: 3 },
    ]);
  });
});

describe('攔截守衛: the guards (lead rulings K2 and K2-R1)', () => {
  /** Each row's [kind, mode, seat, distance, angle]. */
  const rows = (ctx: RunContext): number[][] => {
    const ds = ctx.sys.drones;
    return Array.from({ length: ds.count }, (_, s) => [
      ds.kind[s] as number,
      ds.mode[s] as number,
      ds.seat[s] as number,
      ...polar(ctx, s),
    ]);
  };
  const D = DRONE_KIND_DRONE;
  const T = DRONE_KIND_TURRET;
  const third = round9((2 * Math.PI) / 3);
  const sixth = round9(Math.PI / 3);
  const half = round9(Math.PI);
  /** A swarm of one drone, a guard on a ring of `radius`, at `attackSpeed`, on QUIET_V3. */
  const lone = (placed: readonly PlacedEnemy[], radius = RING, attackSpeed = 4): RunContext =>
    hive(
      placed,
      { drones: 1, turrets: 0, ...guards(1, radius) },
      { data: QUIET_V3, values: { attackSpeed } },
    );
  /**
   * Runs the stages from tick 1 to tick `until`, every pick clock held, then sends guard `s` at
   * E1 from where it is with one impact left: the sortie that impact spends sends it home.
   */
  function sendOff(ctx: RunContext, until: number, s = 0): void {
    const ds = ctx.sys.drones;
    ds.nextPick.fill(1e9);
    if (ctx.now === 1) stage(ctx);
    while (ctx.now < until) next(ctx);
    dashing(ctx, s, enemy(ctx, 1));
    ds.impactsLeft[s] = 1;
  }

  it('makes the last dock indices the guards, on their tick-0 orbit points in DRONE_GUARD, every other seat as it was', () => {
    // Planted bug: the guards as the first seats.
    const plain = hive([], {});
    const ctx = hive([], guards(2));
    expect(rows(plain)).toEqual([
      [D, DRONE_DOCKED, 0, DOCK, 0],
      [D, DRONE_DOCKED, 1, DOCK, third],
      [D, DRONE_DOCKED, 2, DOCK, round9((4 * Math.PI) / 3)],
      [T, DRONE_FIXED, 0, SEAT, sixth],
    ]);
    // Dock indices 1 and 2 of 3: guard 0 at angle 0, guard 1 half a turn on.
    expect(rows(ctx)).toEqual([
      [D, DRONE_DOCKED, 0, DOCK, 0],
      [D, DRONE_GUARD, 1, RING, 0],
      [D, DRONE_GUARD, 2, RING, half],
      [T, DRONE_FIXED, 0, SEAT, sixth],
    ]);
    const ds = ctx.sys.drones;
    expect([ds.guardFirst, ds.guardEnd, ds.guardRadius]).toEqual([1, 3, RING]);
    // A guard starts as a docked drone does: no dock time, a full sortie, its first pick staggered.
    expect(Array.from(ds.dockLeft)).toEqual([0, 0, 0, 0]);
    expect(Array.from(ds.impactsLeft.subarray(0, 3))).toEqual([3, 3, 3]);
    expect(Array.from(ds.nextPick.subarray(0, 3))).toEqual([1, 11, 21]);
    expect([ds.x[3], ds.y[3]]).toEqual([plain.sys.drones.x[3], plain.sys.drones.y[3]]);
    expect([plain.sys.drones.guardFirst, plain.sys.drones.guardEnd]).toEqual([0, 0]);
  });

  it('counts the drones as the fill does: 蟲海’s 2 makes 6 and the guards 4 and 5; 巨大化 halves 3 to 1, a guard; count ≥ drones makes every drone one', () => {
    const doubled = hive([], guards(2), { modules: [policy({ droneCountMult: 2 })] });
    const sixths = [0, 1, 2, 3].map((k) => [D, DRONE_DOCKED, k, DOCK, round9((Math.PI * k) / 3)]);
    expect(rows(doubled)).toEqual([
      ...sixths,
      [D, DRONE_GUARD, 4, RING, 0],
      [D, DRONE_GUARD, 5, RING, half],
      [T, DRONE_FIXED, 0, SEAT, round9(Math.PI / 6)],
    ]);
    const giant = hive([], guards(2), { rules: [GIANT] });
    expect(rows(giant)).toEqual([
      [D, DRONE_GUARD, 0, RING, 0],
      [T, DRONE_FIXED, 0, SEAT, half],
    ]);
    expect([giant.sys.drones.guardFirst, giant.sys.drones.guardEnd]).toEqual([0, 1]);
    const all = hive([], guards(5));
    expect(rows(all)).toEqual([
      [D, DRONE_GUARD, 0, RING, 0],
      [D, DRONE_GUARD, 1, RING, third],
      [D, DRONE_GUARD, 2, RING, round9((4 * Math.PI) / 3)],
      [T, DRONE_FIXED, 0, SEAT, sixth],
    ]);
    expect([all.sys.drones.guardFirst, all.sys.drones.guardEnd]).toEqual([0, 3]);
  });

  it('shares the ring among the guards the cap lets in: 26 drones and 4 guards under 24 place 2, half a turn apart', () => {
    // Own planted bug: the ring split over the guards asked for, not the ones placed.
    const ctx = hive([], { drones: 26, turrets: 0, ...guards(4) });
    const ds = ctx.sys.drones;
    expect(ds.count).toBe(24);
    expect(ctx.counters.summonCapped).toBe(2);
    expect([ds.guardFirst, ds.guardEnd]).toEqual([22, 24]);
    expect(rows(ctx).slice(21)).toEqual([
      [D, DRONE_DOCKED, 21, DOCK, round9((2 * Math.PI * 21) / 26)],
      [D, DRONE_GUARD, 22, RING, 0],
      [D, DRONE_GUARD, 23, RING, half],
    ]);
    // The stage's orbit points split the ring over the same 2.
    stage(ctx);
    for (const g of [0, 1]) {
      const point = orbitPoint(g, 2, ctx.now);
      expect(ds.x[22 + g]).toBeCloseTo(point.x, 9);
      expect(ds.y[22 + g]).toBeCloseTo(point.y, 9);
    }
  });

  it('keeps every guard on its orbit point every tick, two half a turn apart at 120, 0.5 turns a second whatever the attack frequency', () => {
    // Planted bugs: the orbit angle not advancing; advancing by m; the orbit at the dock radius.
    // Own (K2-R1): the advance after the per-row loop.
    expect(GUARD_REV_PER_SEC).toBe(0.5);
    for (const attackSpeed of [4, 8, 2.5]) {
      const ctx = guarded([], 2, 2, { values: { attackSpeed } });
      const ds = ctx.sys.drones;
      for (let k = 0; k < 130; k++) {
        if (k === 0) stage(ctx);
        else next(ctx);
        for (const g of [0, 1]) {
          const want = orbitPoint(g, 2, ctx.now);
          expect(ds.mode[g], `${attackSpeed} @${ctx.now}`).toBe(DRONE_GUARD);
          expect(ds.x[g]).toBeCloseTo(want.x, 9);
          expect(ds.y[g]).toBeCloseTo(want.y, 9);
        }
        expect(polar(ctx, 0)[0]).toBe(RING);
      }
      // Tick 120 is a full turn: back at angle 0, the other at π.
      expect(polar(ctx, 0)).toEqual([RING, round9((2 * Math.PI * 130) / 120 - 2 * Math.PI)]);
    }
  });

  it('holds a guard where it is at m = 0, behind its point, and snaps it back onto the point of the next tick with m > 0', () => {
    const ctx = guarded([], 1, 1);
    const ds = ctx.sys.drones;
    stage(ctx);
    next(ctx);
    const held = [ds.x[0], ds.y[0]];
    swarmOf(ctx).cadence = 0;
    for (let k = 0; k < 5; k++) {
      next(ctx);
      expect([ds.x[0], ds.y[0], ds.prevX[0], ds.prevY[0]]).toEqual([...held, ...held]);
    }
    swarmOf(ctx).cadence = 1;
    next(ctx);
    const want = orbitPoint(0, 1, ctx.now);
    expect(ds.x[0]).toBeCloseTo(want.x, 9);
    expect(ds.y[0]).toBeCloseTo(want.y, 9);
    expect([ds.prevX[0], ds.prevY[0]]).toEqual(held);
  });

  it('runs a guard’s dock time down by m a tick on its orbit, then picks: 30 ticks at m = 1, 15 at m = 2', () => {
    for (const [attackSpeed, m, wait] of [
      [4, 1, 30],
      [8, 2, 15],
    ] as const) {
      const ctx = guarded([at(100, 0)], 1, 1, { values: { attackSpeed } });
      const ds = ctx.sys.drones;
      ds.dockLeft[0] = 30;
      ds.nextPick[0] = 0;
      const lefts: number[] = [];
      let launched = -1;
      for (let k = 0; k < 40 && launched < 0; k++) {
        if (k === 0) stage(ctx);
        else next(ctx);
        lefts.push(ds.dockLeft[0] as number);
        if (ds.mode[0] === DRONE_DASH) launched = ctx.now;
      }
      expect(lefts.slice(0, 3)).toEqual([30 - m, 30 - 2 * m, 30 - 3 * m]);
      expect(launched).toBe(1 + wait);
    }
  });

  describe('each guard’s own orbit angle (lead ruling K2-R1)', () => {
    it('(a) docks a guard sent off the ring again, in DRONE_GUARD, at m = 0.25, and at radius 220 with m = 1, where its orbit point outruns its step', () => {
      // Planted bugs (K2-R1): the angle advanced while the guard is away, which makes its dock a
      // moving target it never reaches here; the docking guard put in DRONE_DOCKED.
      for (const [radius, attackSpeed, step] of [
        [RING, 1, STEP / 4],
        [220, 4, STEP],
      ] as const) {
        // The orbit point's speed, 2π × 0.5 × radius / 60 a tick, above the guard's step.
        expect((Math.PI * radius) / 60).toBeGreaterThan(step);
        const ctx = lone([at(0, 300)], radius, attackSpeed);
        const ds = ctx.sys.drones;
        sendOff(ctx, 40);
        const home = [ds.dockX[0], ds.dockY[0]];
        const left = ds.guardAngle[0];
        const modes = new Set<number>();
        let docked = -1;
        for (let k = 0; k < 1000 && docked < 0; k++) {
          next(ctx);
          modes.add(ds.mode[0] as number);
          if (ds.mode[0] === DRONE_GUARD) docked = ctx.now;
        }
        expect(
          [...modes].sort((p, q) => p - q),
          `${radius}`,
        ).toEqual([DRONE_DASH, DRONE_RETURN, DRONE_GUARD]);
        expect(docked).toBeGreaterThan(40);
        expect([ds.x[0], ds.y[0]]).toEqual(home);
        expect(ds.guardAngle[0]).toBe(left);
        expect([ds.dockLeft[0], ds.impactsLeft[0]]).toEqual([30, 3]);
      }
    });

    it('(b) holds an away guard’s angle and dock tick for tick, while the other guard’s angle advances by exactly one step a tick', () => {
      // Planted bugs (K2-R1): the angle advanced while the guard is away; the dock point
      // rewritten while it is away.
      const ctx = guarded([at(0, 300)], 2, 2);
      const ds = ctx.sys.drones;
      sendOff(ctx, 30);
      const held = [ds.guardAngle[0], ds.dockX[0], ds.dockY[0]];
      let other = ds.guardAngle[1] as number;
      let away = 0;
      for (let k = 0; k < 200 && ds.mode[0] !== DRONE_GUARD; k++) {
        next(ctx);
        other += OMEGA;
        expect([ds.mode[1], ds.guardAngle[1]], `@${ctx.now}`).toEqual([DRONE_GUARD, other]);
        expect(ds.x[1]).toBeCloseTo(ringPoint(other).x, 9);
        expect(ds.y[1]).toBeCloseTo(ringPoint(other).y, 9);
        if (ds.mode[0] !== DRONE_GUARD) away++;
        expect([ds.guardAngle[0], ds.dockX[0], ds.dockY[0]], `@${ctx.now}`).toEqual(held);
      }
      expect(ds.mode[0]).toBe(DRONE_GUARD);
      expect(away).toBeGreaterThan(30);
    });

    it('(c) gives a guard back on its orbit its fill angle plus one step for each stage start it spent on its orbit, over two sorties', () => {
      // Planted bugs (K2-R1): re-spacing on docking; all guards advanced from one shared clock;
      // the angle reset to the fill's on docking; an advance on docking.
      const ctx = guarded([at(0, 300)], 2, 2);
      const ds = ctx.sys.drones;
      ds.nextPick.fill(1e9);
      const fill = [0, Math.PI];
      const sum = [...fill];
      const turns = [0, 0];
      /** The next stage, counting each guard's stage starts on its orbit. */
      const tick = (): void => {
        for (const g of [0, 1]) {
          if (ds.mode[g] !== DRONE_GUARD) continue;
          turns[g] = (turns[g] as number) + 1;
          sum[g] = (sum[g] as number) + OMEGA;
        }
        if (ctx.now === 1 && turns[0] === 1) stage(ctx);
        else next(ctx);
      };
      for (const until of [20, 75]) {
        while (ctx.now < until) tick();
        dashing(ctx, 1, enemy(ctx, 1));
        ds.impactsLeft[1] = 1;
        tick();
        for (let k = 0; k < 200 && ds.mode[1] !== DRONE_GUARD; k++) tick();
        expect(ds.mode[1]).toBe(DRONE_GUARD);
      }
      for (let k = 0; k < 10; k++) tick();
      expect(turns[0]).toBe(ctx.now);
      expect(turns[1]).toBeLessThan(ctx.now - 50);
      for (const g of [0, 1]) {
        expect(ds.guardAngle[g]).toBe(sum[g]);
        expect(ds.guardAngle[g]).toBeCloseTo((fill[g] as number) + (turns[g] as number) * OMEGA, 9);
      }
    });

    it('(d) advances the angles alike whatever m: at m = 0.5, 1 and 2, and at m = 0, the same angles tick for tick', () => {
      // Planted bugs (K2-R1): the advance × m; the advance skipped at m = 0.
      const run = (attackSpeed: number, cadence = 1): number[][] => {
        const ctx = guarded([], 2, 2, { values: { attackSpeed } });
        swarmOf(ctx).cadence = cadence;
        const out: number[][] = [];
        for (let k = 0; k < 90; k++) {
          if (k === 0) stage(ctx);
          else next(ctx);
          out.push(Array.from(ctx.sys.drones.guardAngle));
        }
        return out;
      };
      const slow = run(2);
      expect(run(8)).toEqual(slow);
      expect(run(4)).toEqual(slow);
      expect(run(4, 0)).toEqual(slow);
      let sum = [0, Math.PI];
      for (const angles of slow) {
        sum = sum.map((a) => a + OMEGA);
        expect(angles).toEqual(sum);
      }
    });

    it('(e) first advances a guard that docks on tick t at tick t + 1’s stage start, and rides on from there', () => {
      // Planted bugs (K2-R1): the advance after the per-row loop; an advance on docking; the
      // angle reset to the fill's on docking.
      const ctx = lone([at(0, 300)]);
      const ds = ctx.sys.drones;
      sendOff(ctx, 40);
      const left = ds.guardAngle[0] as number;
      expect(left).toBeCloseTo(40 * OMEGA, 12);
      for (let k = 0; k < 100 && ds.mode[0] !== DRONE_GUARD; k++) next(ctx);
      const docked = ctx.now;
      const home = [ds.dockX[0], ds.dockY[0]];
      expect([ds.mode[0], ds.guardAngle[0], ds.x[0], ds.y[0]]).toEqual([
        DRONE_GUARD,
        left,
        ...home,
      ]);
      next(ctx);
      expect(ctx.now).toBe(docked + 1);
      const a = left + OMEGA;
      expect(ds.guardAngle[0]).toBe(a);
      expect(ds.dockX[0]).toBeCloseTo(ringPoint(a).x, 9);
      expect(ds.dockY[0]).toBeCloseTo(ringPoint(a).y, 9);
      expect([ds.x[0], ds.y[0], ds.prevX[0], ds.prevY[0]]).toEqual([
        ds.dockX[0],
        ds.dockY[0],
        ...home,
      ]);
      next(ctx);
      expect(ds.guardAngle[0]).toBe(a + OMEGA);
    });

    it('(f) starts each guard’s own angle at the fill’s 2πg/G over the G guards placed, where its row is', () => {
      // Planted bugs (K2-R1): the fill angle over the requested count; the fill's angles not kept
      // in the pool.
      const angles = (ctx: RunContext): number[] => Array.from(ctx.sys.drones.guardAngle);
      expect(angles(hive([], {}))).toEqual([]);
      expect(angles(hive([], guards(2)))).toEqual([0, Math.PI]);
      expect(angles(hive([], guards(5)))).toEqual([0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]);
      const doubled = hive([], guards(2), { modules: [policy({ droneCountMult: 2 })] });
      expect(angles(doubled)).toEqual([0, Math.PI]);
      // 26 drones and 4 guards under 24: the 2 placed.
      const capped = hive([], { drones: 26, turrets: 0, ...guards(4) });
      expect(angles(capped)).toEqual([0, Math.PI]);
      for (const ctx of [hive([], guards(5)), capped]) {
        const ds = ctx.sys.drones;
        ds.guardAngle.forEach((a, g) => {
          expect(ds.x[ds.guardFirst + g]).toBeCloseTo(ringPoint(a).x, 9);
          expect(ds.y[ds.guardFirst + g]).toBeCloseTo(ringPoint(a).y, 9);
        });
      }
    });
  });

  describe('the charge start', () => {
    /**
     * Three guards (every drone of 3) and E1, a square 300 right of the player, and E2, a
     * dasher at `dasherAt` to its left, which charges on its first AI step at 420 and never at
     * 421: guard 0 orbits with dock time left, guard 1 dashes at E1 and guard 2 flies home.
     */
    function threeGuards(dasherAt: number) {
      const ctx = guarded([at(300, 0), dasher(-dasherAt, 0)], 3, 3);
      const ds = ctx.sys.drones;
      ds.dockLeft[0] = 20;
      ds.nextPick[0] = 999;
      dashing(ctx, 1, enemy(ctx, 1), P.x + 200, P.y);
      ds.impactsLeft[1] = 2;
      ds.nextPick[1] = 999;
      ds.mode[2] = DRONE_RETURN;
      ds.target[2] = enemy(ctx, 1);
      ds.targetId[2] = 1;
      ds.impactsLeft[2] = 0;
      ds.x[2] = P.x + 250;
      ds.y[2] = P.y + 50;
      ds.nextPick[2] = 999;
      return ctx;
    }

    it('sends an orbiting guard with dock time left, one dashing at another enemy and one flying home at the charging dasher that tick, each with a full sortie, from where it is', () => {
      // Planted bug: the charge start ignored while dock time runs.
      const ctx = threeGuards(420);
      const ds = ctx.sys.drones;
      const from = [0, 1, 2].map((s) => [ds.x[s] as number, ds.y[s] as number]);
      const events = nextAi(ctx);
      expect(eventsOf([events], 'dasherCharge')).toEqual([{ type: 'dasherCharge', enemyId: 2 }]);
      const d = enemy(ctx, 2);
      for (const s of [0, 1, 2]) {
        expect([ds.mode[s], ds.targetId[s], ds.impactsLeft[s], ds.nextPick[s]], `${s}`).toEqual([
          DRONE_DASH,
          2,
          3,
          ctx.now + PICK_TICKS,
        ]);
        // One step on from where it was, at the dasher.
        const [x0, y0] = from[s] as [number, number];
        const dist = Math.hypot(d.x - x0, d.y - y0);
        expect(ds.x[s]).toBeCloseTo(x0 + ((d.x - x0) * STEP) / dist, 9);
        expect(ds.y[s]).toBeCloseTo(y0 + ((d.y - y0) * STEP) / dist, 9);
      }
      // No charge start (421): each keeps what it was doing.
      const quiet = threeGuards(421);
      const qs = quiet.sys.drones;
      expect(eventsOf([nextAi(quiet)], 'dasherCharge')).toEqual([]);
      expect([0, 1, 2].map((s) => [qs.mode[s], qs.targetId[s], qs.impactsLeft[s]])).toEqual([
        [DRONE_GUARD, -1, 3],
        [DRONE_DASH, 1, 2],
        [DRONE_RETURN, 1, 0],
      ]);
      expect(qs.dockLeft[0]).toBe(19);
    });

    it('sends none on a tick without a charge start, though a dasher still charges: each guard keeps what it was doing', () => {
      // Own planted bug: the charge start's re-pick on every tick, not only on a charge start.
      const ctx = threeGuards(421);
      const ds = ctx.sys.drones;
      charge(enemy(ctx, 2));
      next(ctx);
      expect(ctx.sys.enemyAi.chargeStartCount).toBe(0);
      expect([0, 1, 2].map((s) => [ds.mode[s], ds.targetId[s], ds.impactsLeft[s]])).toEqual([
        [DRONE_GUARD, -1, 3],
        [DRONE_DASH, 1, 2],
        [DRONE_RETURN, 1, 0],
      ]);
      expect(ds.dockLeft[0]).toBe(19);
    });

    it('leaves a guard dashing at a charging dasher on it when another dasher starts charging, nearer: an orbiting guard takes the new one', () => {
      // Planted bug: the charge start re-picking every guard, the one on a charging dasher too.
      const ctx = guarded([dasher(-420, 0), dasher(0, -430)], 2, 2);
      const ds = ctx.sys.drones;
      const [d1, d2] = [enemy(ctx, 1), enemy(ctx, 2)];
      nextAi(ctx);
      expect([ds.targetId[0], ds.targetId[1]]).toEqual([1, 1]);
      // Guard 0 on d1 with one impact left, beside d2; guard 1 back on its orbit.
      ds.x[0] = d2.x + 30;
      ds.y[0] = d2.y;
      ds.impactsLeft[0] = 1;
      ds.nextPick[0] = 999;
      ds.mode[1] = DRONE_GUARD;
      ds.target[1] = null;
      ds.targetId[1] = -1;
      ds.dockLeft[1] = 30;
      d2.y = P.y - 420;
      d2.dist = 420;
      const events = nextAi(ctx);
      expect(eventsOf([events], 'dasherCharge')).toEqual([{ type: 'dasherCharge', enemyId: 2 }]);
      expect((v3(d1).state & CHARGING) !== 0).toBe(true);
      expect([ds.mode[0], ds.targetId[0], ds.impactsLeft[0], ds.nextPick[0]]).toEqual([
        DRONE_DASH,
        1,
        1,
        999,
      ]);
      expect([ds.mode[1], ds.targetId[1], ds.impactsLeft[1]]).toEqual([DRONE_DASH, 2, 3]);
    });

    it('re-picks a guard whose charging dasher died this tick: a dead one is not one it dashes at', () => {
      const ctx = guarded([dasher(-420, 0), dasher(0, -430)], 1, 1);
      const ds = ctx.sys.drones;
      nextAi(ctx);
      expect(ds.targetId[0]).toBe(1);
      ds.nextPick[0] = 999;
      removeEnemy(ctx, enemy(ctx, 1));
      const d2 = enemy(ctx, 2);
      d2.y = P.y - 420;
      d2.dist = 420;
      nextAi(ctx);
      expect([ds.mode[0], ds.targetId[0], ds.nextPick[0]]).toEqual([
        DRONE_DASH,
        2,
        ctx.now + PICK_TICKS,
      ]);
    });
  });

  describe('guardPick', () => {
    it('sends two guards at one charging dasher: the nearer as the unchased one, the other on the chased fallback before an enemy in the ring', () => {
      // Planted bug: tier 2 before tier 1's chased fallback.
      const ctx = guarded([at(100, 0), dasher(420, 0)], 2, 2);
      const ds = ctx.sys.drones;
      charge(enemy(ctx, 2));
      ds.nextPick.fill(0);
      stage(ctx);
      // Guard 0, east, is the nearer to the dasher, east too.
      expect([ds.targetId[0], ds.targetId[1]]).toEqual([2, 2]);
      expect([ds.mode[0], ds.mode[1]]).toEqual([DRONE_DASH, DRONE_DASH]);
      // Not charging: the guards take the ring, the square, then nothing (the dasher is 420 out).
      const quiet = guarded([at(100, 0), dasher(420, 0)], 2, 2);
      quiet.sys.drones.nextPick.fill(0);
      stage(quiet);
      expect([quiet.sys.drones.targetId[0], quiet.sys.drones.targetId[1]]).toEqual([1, 1]);
    });

    it('takes the charging dasher nearest to the row, not to the player, at any distance and whatever its memory; ties to the lower id', () => {
      // Planted bugs: tier 1 the farthest instead of the nearest; tier 1 respecting the memory.
      const ctx = guarded([dasher(0, -420), dasher(420, 0), at(100, 0)], 1, 1);
      const ds = ctx.sys.drones;
      charge(enemy(ctx, 1));
      charge(enemy(ctx, 2));
      // The row 100 left of the east dasher (id 2): 2 is the nearer, both 420 from the player.
      ds.x[0] = P.x + 320;
      ds.y[0] = P.y;
      expect(guardPick(ctx, ds, 0)?.id).toBe(2);
      memorize(ctx, 0, 0, 2, ctx.now + 100);
      expect(guardPick(ctx, ds, 0)?.id).toBe(2);
      // The row at the player: a tie at 420, to the lower id.
      ds.x[0] = P.x;
      ds.y[0] = P.y;
      enemy(ctx, 1).x = P.x;
      enemy(ctx, 1).y = P.y - 420;
      expect(guardPick(ctx, ds, 0)?.id).toBe(1);
      // A dead one, or one out of the arena, is none.
      removeEnemy(ctx, enemy(ctx, 1));
      expect(guardPick(ctx, ds, 0)?.id).toBe(2);
      enemy(ctx, 2).x = -5;
      expect(guardPick(ctx, ds, 0)?.id).toBe(3);
    });

    it('takes the chased charging dasher another row dashes at when every one is chased, the nearest of them; ties to the lower id', () => {
      // Own planted bug: the chased tier's ties to the higher id.
      const ctx = guarded([dasher(-420, 0), dasher(420, 0)], 3, 3);
      const ds = ctx.sys.drones;
      charge(enemy(ctx, 1));
      charge(enemy(ctx, 2));
      dashing(ctx, 1, enemy(ctx, 1));
      dashing(ctx, 2, enemy(ctx, 2));
      ds.x[0] = P.x + 100;
      ds.y[0] = P.y;
      expect(guardPick(ctx, ds, 0)?.id).toBe(2);
      ds.x[0] = P.x - 100;
      expect(guardPick(ctx, ds, 0)?.id).toBe(1);
      // The row at the player: both 420 from it, to the lower id.
      ds.x[0] = P.x;
      expect(guardPick(ctx, ds, 0)?.id).toBe(1);
      ds.x[0] = P.x - 100;
      // An unchased one, though farther, first.
      dashing(ctx, 1, enemy(ctx, 2));
      expect(guardPick(ctx, ds, 0)?.id).toBe(1);
      ds.x[0] = P.x + 100;
      expect(guardPick(ctx, ds, 0)?.id).toBe(1);
    });

    it('without a charging dasher, takes the drones’ pick within the ring alone: 120 and 119 in, 121 out', () => {
      // Planted bug: tier 2 without the ring bound.
      const ctx = guarded([at(121, 0), at(0, 300), at(-120, 0), at(0, 119)], 1, 1);
      const ds = ctx.sys.drones;
      expect(enemy(ctx, 3).dist).toBe(120);
      expect(guardPick(ctx, ds, 0)?.id).toBe(3);
      expect(pickOuter(ctx, 0)?.id).toBe(2);
      removeEnemy(ctx, enemy(ctx, 3));
      expect(guardPick(ctx, ds, 0)?.id).toBe(4);
      removeEnemy(ctx, enemy(ctx, 4));
      expect(guardPick(ctx, ds, 0)).toBeNull();
      expect(pickOuter(ctx, 0)?.id).toBe(2);
    });

    it('bounds the chased tier and 鎖定信標’s tough tiers by the ring too', () => {
      // Own planted bugs: the chased tier, or the tough tier, without the ring bound.
      const ctx = guarded([at(100, 0), at(-300, 0)], 2, 3);
      const ds = ctx.sys.drones;
      dashing(ctx, 0, enemy(ctx, 2));
      dashing(ctx, 2, enemy(ctx, 1));
      expect(guardPick(ctx, ds, 1)?.id).toBe(1);
      const tough = guarded(
        [at(0, 110), at(200, 0, { type: 'hexagon' }), at(0, -100, { type: 'hexagon' })],
        1,
        1,
        { modules: [policy({ summonEliteFirst: true })] },
      );
      expect(guardPick(tough, tough.sys.drones, 0)?.id).toBe(3);
      removeEnemy(tough, enemy(tough, 3));
      expect(guardPick(tough, tough.sys.drones, 0)?.id).toBe(1);
      expect(pickOuter(tough, 0)?.id).toBe(2);
      // The tough chased tier: the elite in the ring another row dashes at, not the one out.
      const chasedTough = guarded(
        [at(0, 110), at(200, 0, { type: 'hexagon' }), at(0, -100, { type: 'hexagon' })],
        1,
        3,
        { modules: [policy({ summonEliteFirst: true })] },
      );
      dashing(chasedTough, 0, enemy(chasedTough, 2));
      dashing(chasedTough, 1, enemy(chasedTough, 3));
      expect(guardPick(chasedTough, chasedTough.sys.drones, 2)?.id).toBe(3);
    });
  });

  it('flies a spent guard home to the fixed point where it left its orbit, and docks on it in DRONE_GUARD with its dock time and a full sortie', () => {
    // Planted bug (K2-R1): the angle advanced while the guard is away, its dock a moving target.
    const ctx = lone([at(0, 300)]);
    const ds = ctx.sys.drones;
    sendOff(ctx, 40);
    const home = { x: ds.dockX[0] as number, y: ds.dockY[0] as number };
    // Where it left: its point of tick 40, 40 turns on.
    expect(home.x).toBeCloseTo(orbitPoint(0, 1, 40).x, 9);
    expect(home.y).toBeCloseTo(orbitPoint(0, 1, 40).y, 9);
    // Out at E1, its one impact there, and home: its dock where it left, tick for tick.
    const t = enemy(ctx, 1);
    for (let k = 0; k < 100 && ds.mode[0] !== DRONE_RETURN; k++) next(ctx);
    expect([ds.mode[0], ds.x[0], ds.y[0]]).toEqual([DRONE_RETURN, t.x, t.y]);
    let x = t.x;
    let y = t.y;
    let arrived = -1;
    for (let k = 0; k < 100 && arrived < 0; k++) {
      next(ctx);
      const dist = Math.hypot(home.x - x, home.y - y);
      if (dist <= STEP) {
        [x, y] = [home.x, home.y];
        arrived = ctx.now;
      } else {
        x += ((home.x - x) * STEP) / dist;
        y += ((home.y - y) * STEP) / dist;
      }
      expect(ds.x[0]).toBeCloseTo(x, 9);
      expect(ds.y[0]).toBeCloseTo(y, 9);
      expect([ds.dockX[0], ds.dockY[0]]).toEqual([home.x, home.y]);
    }
    expect(arrived).toBeGreaterThan(70);
    expect([ds.x[0], ds.y[0]]).toEqual([home.x, home.y]);
    expect([ds.mode[0], ds.dockLeft[0], ds.impactsLeft[0], ds.targetId[0], ds.target[0]]).toEqual([
      DRONE_GUARD,
      30,
      3,
      -1,
      null,
    ]);
    // On from that angle: 41 turns.
    next(ctx);
    const point = orbitPoint(0, 1, 41);
    expect([ds.mode[0], ds.dockLeft[0]]).toEqual([DRONE_GUARD, 29]);
    expect(ds.x[0]).toBeCloseTo(point.x, 9);
    expect(ds.y[0]).toBeCloseTo(point.y, 9);
  });

  it('flies home to the orbit when a lost target’s pick finds nothing in the ring, and picks one in it when there is', () => {
    const ctx = guarded([at(100, 0), at(400, 0), at(-110, 0)], 1, 1);
    const ds = ctx.sys.drones;
    const t = enemy(ctx, 1);
    dashing(ctx, 0, t, P.x + 50, P.y);
    ds.nextPick[0] = 0;
    removeEnemy(ctx, t);
    stage(ctx);
    // lose() picks with guardPick: the enemy in the ring, not the one 400 out.
    expect([ds.mode[0], ds.targetId[0]]).toEqual([DRONE_DASH, 3]);
    const none = guarded([at(100, 0), at(400, 0)], 1, 1);
    dashing(none, 0, enemy(none, 1), P.x + 50, P.y);
    none.sys.drones.nextPick[0] = 0;
    removeEnemy(none, enemy(none, 1));
    stage(none);
    expect(none.sys.drones.mode[0]).toBe(DRONE_RETURN);
  });

  it('repicks a guard under 蟲海 with guardPick: the ring, a charging dasher first, and its kept target when that finds nothing', () => {
    /** The guard on E1's last impact with its clock out; E2 400 out, E3 110 in. */
    const spent = (placed: readonly PlacedEnemy[]) => {
      const ctx = guarded(placed, 1, 1, { modules: [STAY] });
      const ds = ctx.sys.drones;
      const t = enemy(ctx, 1);
      dashing(ctx, 0, t, t.x, t.y);
      ds.impactsLeft[0] = 1;
      ds.nextPick[0] = 0;
      return ctx;
    };
    const ctx = spent([at(100, 0), at(400, 0), at(-110, 0)]);
    stage(ctx);
    expect([ctx.sys.drones.mode[0], ctx.sys.drones.targetId[0]]).toEqual([DRONE_DASH, 3]);
    const kept = spent([at(100, 0), at(400, 0)]);
    stage(kept);
    expect([kept.sys.drones.mode[0], kept.sys.drones.targetId[0]]).toEqual([DRONE_DASH, 1]);
    const charging = spent([at(100, 0), at(400, 0), at(-110, 0), dasher(0, 420)]);
    charge(enemy(charging, 4));
    stage(charging);
    expect(charging.sys.drones.targetId[0]).toBe(4);
  });

  it('leaves a non-guard drone’s picks as they were: C5CHK4-1’s lost, hovering and docked picks with guards on', () => {
    // Planted bug: the ring bound applied to the non-guard drones' picks too.
    // Slot 0 is the swarm's one drone that is no guard; X 300 and W 400 out, past the ring.
    const lost = guarded([at(300, 0), at(-400, 0)], 2, 3);
    const lds = lost.sys.drones;
    dashing(lost, 0, enemy(lost, 1));
    lds.impactsLeft[0] = 2;
    lds.nextPick[0] = 0;
    removeEnemy(lost, enemy(lost, 1));
    stage(lost);
    expect([lds.mode[0], lds.targetId[0]]).toEqual([DRONE_DASH, 2]);
    const hovering = guarded([at(-400, 0)], 2, 3);
    hovering.sys.drones.mode[0] = DRONE_HOVER;
    hovering.sys.drones.nextPick[0] = 2;
    stage(hovering);
    next(hovering);
    expect([hovering.sys.drones.mode[0], hovering.sys.drones.targetId[0]]).toEqual([DRONE_DASH, 1]);
    const docked = guarded([at(-400, 0)], 2, 3);
    stage(docked);
    expect([docked.sys.drones.mode[0], docked.sys.drones.targetId[0]]).toEqual([DRONE_DASH, 1]);
    // The guards, on their orbits, find nothing in the ring.
    expect([docked.sys.drones.mode[1], docked.sys.drones.mode[2]]).toEqual([
      DRONE_GUARD,
      DRONE_GUARD,
    ]);
  });

  it('picks as pickOuter does for every non-guard drone of a guarded swarm over 100 seeded fields, and as guardPick for every guard', () => {
    const seen = { outside: 0, guards: 0 };
    for (let f = 0; f < 100; f++) {
      const rng = createRng(500 + f);
      const placed: PlacedEnemy[] = [];
      for (let k = 0; k < 1 + rng.int(8); k++)
        placed.push(at(rng.int(801) - 400, rng.int(801) - 400));
      const ctx = guarded(placed, 2, 4);
      const ds = ctx.sys.drones;
      // Every row hovering with its clock out, the others' clocks held: one repick each, in order.
      const s = rng.int(4);
      ds.dockLeft.fill(1e9);
      ds.mode[s] = DRONE_HOVER;
      ds.nextPick[s] = 0;
      const want = s >= 2 ? guardPick(ctx, ds, s) : pickOuter(ctx, s);
      stage(ctx);
      expect(ds.target[s] ?? null, `field ${f}`).toBe(want);
      if (s < 2 && want !== null && want.dist > RING) seen.outside++;
      if (s >= 2) seen.guards++;
    }
    expect(seen.outside).toBeGreaterThan(20);
    expect(seen.guards).toBeGreaterThan(20);
  });
});

describe('蜂潮: the surge (lead ruling K3)', () => {
  it('fires the first surge one period into the run and each later one a period after the last', () => {
    // Planted bug: the surge firing at tick 0.
    const ticks = (periodSec: number, last: number): number[] => {
      const ctx = hive([at(300, 0)], { drones: 1, turrets: 0, ...surge(periodSec) });
      expect(surgeOf(ctx).due).toBe(periodSec * TICK_RATE);
      const out: number[] = [];
      while (ctx.now < last) if (surges(next(ctx)).length > 0) out.push(ctx.now);
      return out;
    };
    expect(ticks(0.5, 100)).toEqual([30, 60, 90]);
    expect(ticks(8, 1000)).toEqual([480, 960]);
  });

  it('stays due while there is no candidate and fires on the first tick that has one, banking none', () => {
    // Planted bug: a surge with no candidate skipped (its next due a period on) instead of kept.
    const ctx = hive([at(-1010, 0)], { drones: 1, turrets: 0, ...surge(0.5) });
    const e = enemy(ctx, 1);
    expect(e.x).toBe(-50);
    const fired: number[] = [];
    while (ctx.now < 100) {
      if (ctx.now === 40) {
        e.x = P.x + 300;
        e.dist = 300;
      }
      if (surges(next(ctx)).length > 0) fired.push(ctx.now);
    }
    expect(fired).toEqual([41, 71]);
  });

  describe('densest', () => {
    /** Cluster A around E1 and B around E4, each of 3 at best; tied, to the lower id. */
    const CLUSTERS = [at(300, 0), at(330, 0), at(270, 0), at(-300, 0), at(-300, 25), at(-300, -25)];

    it('takes the enemy with the most alive enemies in the arena within the sized splash, itself in; ties to the lower id', () => {
      // Planted bugs: ties to the higher id; the densest counting dead enemies.
      const ctx = hive(CLUSTERS, surge(8));
      const ds = ctx.sys.drones;
      expect(densest(ctx, ds)?.id).toBe(1);
      removeEnemy(ctx, enemy(ctx, 2));
      expect(densest(ctx, ds)?.id).toBe(4);
      removeEnemy(ctx, enemy(ctx, 4));
      // E1 and E3, 30 apart, count 2 each; E5 and E6, 50 apart, 1 each.
      expect(densest(ctx, ds)?.id).toBe(1);
    });

    it('never counts or picks an enemy out of the arena', () => {
      // Own planted bugs: an out-of-arena enemy counted around a candidate; one picked.
      const edge = [
        at(300, 0),
        at(330, 0),
        { x: -5, y: P.y },
        { x: -5, y: P.y + 10 },
        { x: -5, y: P.y - 10 },
        { x: -5, y: P.y + 20 },
        { x: 10, y: P.y },
      ];
      const ctx = hive(edge, surge(8));
      expect(densest(ctx, ctx.sys.drones)?.id).toBe(1);
      removeEnemy(ctx, enemy(ctx, 1));
      removeEnemy(ctx, enemy(ctx, 2));
      expect(densest(ctx, ctx.sys.drones)?.id).toBe(7);
      removeEnemy(ctx, enemy(ctx, 7));
      expect(densest(ctx, ctx.sys.drones)).toBeNull();
    });

    it('never picks a dead enemy, not even one its alive neighbours would make the densest', () => {
      // Own planted bug: a dead candidate picked (its neighbours, alive, still count around it).
      // E1 dead between E2 and E3, 60 apart; E4 and E5 a pair, 30 apart.
      const placed = [at(300, 0), at(330, 0), at(270, 0), at(-300, 0), at(-330, 0)];
      const ctx = hive(placed, surge(8));
      removeEnemy(ctx, enemy(ctx, 1));
      expect(densest(ctx, ctx.sys.drones)?.id).toBe(4);
    });

    it('sizes the splash it counts in: two 50 apart are a pair at areaSize 1.5 alone', () => {
      // Own planted bug: the densest over the unsized splash.
      const placed = [at(300, 0), at(-300, 0), at(-300, 50)];
      const plain = hive(placed, surge(8));
      expect(densest(plain, plain.sys.drones)?.id).toBe(1);
      const sized = hive(placed, surge(8), { values: { areaSize: 1.5 } });
      expect(densest(sized, sized.sys.drones)?.id).toBe(2);
    });
  });

  it('sends every swarm drone, docked with dock time left, dashing, hovering, returning and orbiting, at the densest with a full sortie; never a turret, a granted drone or a spirit', () => {
    // Planted bugs: the surge skipping docked drones with dock time left; sending spirits;
    // keeping impactsLeft 0 on a returning drone.
    const grant: SourcedEmitter = { source: 'outer.summon', grant: { kind: 'drone', drones: 1 } };
    const spirit: SpawnDroneSpec = { kind: 'spawnDrone', lifeSec: 4, damagePct: 1 };
    const ctx = hive(
      [at(300, 0), at(320, 0), at(300, 20), at(-300, 0)],
      { drones: 5, turrets: 1, ...guards(1), ...surge(8) },
      { grants: [grant], triggers: [{ on: 'heroHit', do: [spirit] }] },
    );
    const ds = ctx.sys.drones;
    const entry = createEffectEntry();
    entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === 'spawnDrone');
    entry.depth = 1;
    entry.origin = -1;
    entry.x = P.x - 100;
    entry.y = P.y;
    runEffect(ctx, entry);
    const [D, T, S] = [DRONE_KIND_DRONE, DRONE_KIND_TURRET, DRONE_KIND_SPIRIT];
    expect(Array.from(ds.kind.subarray(0, ds.count))).toEqual([D, D, D, D, D, T, D, S]);
    expect([ds.owner[5], ds.owner[6]]).toEqual([0, 1]);
    const far = enemy(ctx, 4);
    ds.dockLeft[0] = 20;
    ds.nextPick[0] = 999;
    dashing(ctx, 1, far, P.x - 200, P.y);
    ds.impactsLeft[1] = 2;
    ds.mode[2] = DRONE_HOVER;
    ds.x[2] = P.x + 100;
    ds.nextPick[2] = 999;
    ds.mode[3] = DRONE_RETURN;
    ds.target[3] = far;
    ds.targetId[3] = far.id;
    ds.impactsLeft[3] = 0;
    ds.dockLeft[4] = 10;
    expect(ds.mode[4]).toBe(DRONE_GUARD);
    ds.dockLeft[6] = 1e9;
    ds.nextPick[7] = 999;
    surgeOf(ctx).due = ctx.now;
    const events = stage(ctx);
    expect(surges(events)).toEqual([
      { type: 'droneSurge', x: P.x + 300, y: P.y, targetId: 1, count: 5 },
    ]);
    for (let s = 0; s < 5; s++) {
      expect([ds.mode[s], ds.targetId[s], ds.impactsLeft[s], ds.nextPick[s]], `${s}`).toEqual([
        DRONE_DASH,
        1,
        3,
        ctx.now + PICK_TICKS,
      ]);
    }
    expect(Array.from(ds.surging.subarray(0, ds.count))).toEqual([1, 1, 1, 1, 1, 0, 0, 0]);
    expect([ds.mode[5], ds.mode[6], ds.mode[7]]).toEqual([DRONE_FIXED, DRONE_DOCKED, DRONE_HOVER]);
    expect([surgeOf(ctx).due, surgeOf(ctx).target]).toEqual([ctx.now + 480, enemy(ctx, 1)]);
  });

  /** One swarm drone on E1, waiting out its memory of it, as a surge at E1 sends it. */
  function surged(
    placed: readonly PlacedEnemy[],
    params: Partial<SwarmParams> = {},
    options: Options = {},
  ): RunContext {
    const ctx = hive(placed, { drones: 1, turrets: 0, ...surge(8), ...params }, options);
    const t = enemy(ctx, 1);
    dashing(ctx, 0, t, t.x, t.y);
    memorize(ctx, 0, 0, 1, ctx.now + 5);
    surgeOf(ctx).due = ctx.now;
    expect(surges(stage(ctx)).map((e) => e.targetId)).toEqual([1]);
    return ctx;
  }

  /** The hits of every impact of the next `ticks` ticks, as [target, amount] lists. */
  function impactHits(ctx: RunContext, ticks: number): number[][][] {
    const out: number[][][] = [];
    for (let k = 0; k < ticks; k++) {
      const events = next(ctx);
      if (impacts(events).length > 0) out.push(hitAmounts(events));
    }
    return out;
  }

  it('takes × damageMult on the next impact on the surge’s target, the whole impact, then × 1', () => {
    // Planted bug: the factor on every impact of the sortie.
    const ctx = surged([at(300, 0), at(300, 30)]);
    expect(ctx.sys.drones.surging[0]).toBe(1);
    expect(impactHits(ctx, 70)).toEqual([
      [
        [1, 2 * IMPACT],
        [2, 2 * IMPACT],
      ],
      [
        [1, IMPACT],
        [2, IMPACT],
      ],
      [
        [1, IMPACT],
        [2, IMPACT],
      ],
    ]);
    expect(ctx.sys.drones.surging[0]).toBe(0);
  });

  it('composes with 自爆協議 when the surge’s impact also spends the sortie: 0.75 × 2', () => {
    const ctx = surged([at(300, 0), at(300, 30)], { impacts: 1, ...BLAST });
    expect(impactHits(ctx, 10)).toEqual([
      [
        [1, 30],
        [2, 30],
      ],
    ]);
  });

  it('clears the mark of a row that lost the surge’s target, dead or out of the arena, or docked: its next impacts × 1', () => {
    // Planted bug: losing the target not clearing the mark (the next target's impact × 2).
    const dead = surged([at(300, 0), at(-300, 0)]);
    dead.sys.drones.nextPick[0] = 0;
    removeEnemy(dead, enemy(dead, 1));
    next(dead);
    expect(dead.sys.drones.targetId[0]).toBe(2);
    next(dead);
    expect(dead.sys.drones.surging[0]).toBe(0);
    expect(impactHits(dead, 80)[0]).toEqual([[2, IMPACT]]);
    // Out of the arena, nothing else to pick: home, docked, then back on it once it walks in.
    const out = surged([at(300, 0)]);
    out.sys.drones.nextPick[0] = 0;
    const t = enemy(out, 1);
    t.x = -50;
    next(out);
    expect(out.sys.drones.mode[0]).toBe(DRONE_RETURN);
    while (out.sys.drones.mode[0] !== DRONE_DOCKED) next(out);
    t.x = P.x + 300;
    const seen = impactHits(out, 120);
    expect(out.sys.drones.targetId[0]).toBe(1);
    expect(seen[0]).toEqual([[1, IMPACT]]);
  });

  it('clears a guard’s mark when a charge start sends it at a charging dasher: its impact there × 1', () => {
    const ctx = hive(
      [at(-100, 0), at(-110, 0), dasher(420, 0)],
      { drones: 1, turrets: 0, ...guards(1), ...surge(8) },
      { data: QUIET_V3 },
    );
    const ds = ctx.sys.drones;
    surgeOf(ctx).due = ctx.now;
    expect(surges(stage(ctx)).map((e) => e.targetId)).toEqual([1]);
    expect(ds.surging[0]).toBe(1);
    nextAi(ctx);
    expect([ds.targetId[0], ds.surging[0]]).toEqual([3, 0]);
    const d = enemy(ctx, 3);
    ds.x[0] = d.x;
    ds.y[0] = d.y;
    expect(impactHits(ctx, 2)[0]).toEqual([[3, IMPACT]]);
  });

  it('carries the mark when a row moves down (moveRow), as every per-slot array', () => {
    // Planted bug: moveRow not carrying `surging`.
    const spirit: SpawnDroneSpec = { kind: 'spawnDrone', lifeSec: 4, damagePct: 1 };
    const ctx = hive(
      [],
      { drones: 1, turrets: 0 },
      { triggers: [{ on: 'heroHit', do: [spirit] }] },
    );
    const ds = ctx.sys.drones;
    const entry = createEffectEntry();
    entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === 'spawnDrone');
    entry.depth = 1;
    entry.origin = -1;
    for (let k = 0; k < 3; k++) runEffect(ctx, entry);
    expect([ds.count, Array.from(ds.surging.subarray(0, 4))]).toEqual([4, [0, 0, 0, 0]]);
    ds.until[1] = ctx.now + 1;
    ds.surging[2] = 1;
    ds.nextPick.fill(999);
    next(ctx);
    expect([ds.count, Array.from(ds.id.subarray(0, 3))]).toEqual([3, [1, 3, 4]]);
    expect(Array.from(ds.surging.subarray(0, 3))).toEqual([0, 1, 0]);
    // A new row appends with none.
    ds.surging[3] = 1;
    runEffect(ctx, entry);
    expect([ds.count, ds.surging[3]]).toEqual([4, 0]);
  });
});

describe('E5’s shapes and what a run without its fields pays (lead ruling K4)', () => {
  it('leaves the pool without them: no explosion, guard or surge, the impact test off', () => {
    const plain = hive([], {}).sys.drones;
    expect([
      plain.lastImpactSq,
      plain.lastImpactScale,
      plain.impactRules,
      plain.guardFirst,
      plain.guardEnd,
      plain.surge,
    ]).toEqual([0, 0, false, 0, 0, null]);
    expect(hive([], BLAST).sys.drones.impactRules).toBe(true);
    expect(hive([], surge(8)).sys.drones.impactRules).toBe(true);
    expect(hive([], guards(1)).sys.drones.impactRules).toBe(false);
    expect(hive([], surge(2, 3)).sys.drones.surge).toEqual({
      period: 120,
      damageMult: 3,
      due: 120,
      target: null,
    });
  });
});

describe('compileBuild’s checks on E5’s SwarmParams', () => {
  const compileWith = (fields: Partial<SwarmParams>) => () =>
    compileBuild(makeStats(), [], SWARM, [swarmParams(fields)]);

  it('throws, naming the field and its values, on a lastImpact whose radius or damagePct is not finite and above 0', () => {
    for (const [radius, damagePct] of [
      [0, 1.5],
      [-80, 1.5],
      [Number.NaN, 1.5],
      [Infinity, 1.5],
      [80, 0],
      [80, -1],
      [80, Number.NaN],
      [80, Infinity],
    ] as const) {
      expect(compileWith({ lastImpact: { radius, damagePct } }), `${radius} ${damagePct}`).toThrow(
        `lastImpact: radius ${radius} and damagePct ${damagePct} must be finite and above 0`,
      );
    }
    expect(compileWith(BLAST)().signature.swarm?.lastImpact).toEqual({
      radius: 80,
      damagePct: 1.5,
    });
  });

  it('throws on guards whose count is not a whole number ≥ 1 or whose radius is not finite and above 0', () => {
    for (const [count, radius] of [
      [0, RING],
      [1.5, RING],
      [-1, RING],
      [Number.NaN, RING],
      [Infinity, RING],
      [2, 0],
      [2, -1],
      [2, Number.NaN],
      [2, Infinity],
    ] as const) {
      expect(compileWith(guards(count, radius)), `${count} ${radius}`).toThrow(
        `guards: count ${count} must be a whole number >= 1, radius ${radius} finite and above 0`,
      );
    }
    for (const count of [1, 2, 30]) {
      expect(compileWith(guards(count))().signature.swarm?.guards).toEqual({ count, radius: RING });
    }
  });

  it('throws on a surge whose periodSec or damageMult is not finite and above 0', () => {
    for (const [periodSec, damageMult] of [
      [0, 2],
      [-8, 2],
      [Number.NaN, 2],
      [Infinity, 2],
      [8, 0],
      [8, -2],
      [8, Number.NaN],
      [8, Infinity],
    ] as const) {
      expect(compileWith(surge(periodSec, damageMult)), `${periodSec} ${damageMult}`).toThrow(
        `surge: periodSec ${periodSec} and damageMult ${damageMult} must be finite and above 0`,
      );
    }
    expect(compileWith(surge(8, 0.5))().signature.swarm?.surge).toEqual({
      periodSec: 8,
      damageMult: 0.5,
    });
  });
});

describe('E4’s roles, 集火指令 and FL’s heading on E5’s rows (port rulings P1–P3)', () => {
  /** The role of dock index `slot`, each factor 1 and no follow bonus but for `fields`. */
  const role = (slot: number, fields: Partial<Omit<DroneRole, 'slot'>> = {}): DroneRole => ({
    slot,
    damageMult: 1,
    speedMult: 1,
    sizeMult: 1,
    followBonus: 0,
    ...fields,
  });
  /** ◆蜂后's and ◆重錘's factors (gd:184, gd:189) on dock index `slot`. */
  const queen = (slot: number): DroneRole =>
    role(slot, { damageMult: 2, sizeMult: 1.5, followBonus: 0.2 });
  const hammer = (slot: number): DroneRole => role(slot, { damageMult: 5, speedMult: 0.4 });
  const FOCUS = policy({ summonHighestHp: true });
  /** A swarm of `drones` drones and no turret, its last `count` guards at RING with `roles`. */
  const roled = (
    placed: readonly PlacedEnemy[],
    drones: number,
    count: number,
    roles: DroneRole[],
    more: Partial<SwarmParams> = {},
  ): RunContext =>
    hive(placed, { drones, turrets: 0, ...guards(count), roles, ...more }, { data: QUIET_V3 });

  it('gives a guard its dock index’s role as any drone: its factors, its size (sizeMult × the role’s) and the lead (P3)', () => {
    // Planted bugs: the role lookup skipping the guards' dock indices; a guard's size 1; a guard
    // never the leader.
    const ctx = roled([], 4, 2, [queen(2), hammer(3)], { sizeMult: 1.2 });
    const ds = ctx.sys.drones;
    expect([ds.guardFirst, ds.guardEnd]).toEqual([2, 4]);
    expect(Array.from(ds.roleDamage.subarray(0, 4))).toEqual([1, 1, 2, 5]);
    expect(Array.from(ds.roleSpeed.subarray(0, 4))).toEqual([1, 1, 1, 0.4]);
    expect(Array.from(ds.size.subarray(0, 4))).toEqual([1.2, 1.2, 1.2 * 1.5, 1.2]);
    expect([ds.leader, ds.followMult]).toEqual([2, 1.2]);
  });

  it('gives the follow bonus of a guard that leads only while it dashes at the target, not on its orbit (P3)', () => {
    // Planted bug: a guard never the leader (no × 1.2 while it dashes at E1).
    const ctx = roled([at(300, 0)], 2, 1, [queen(1)]);
    const ds = ctx.sys.drones;
    const t = enemy(ctx, 1);
    ds.nextPick.fill(1e9);
    // The leader, guard 1, dashes at E1 from its orbit point, 180 short of it; drone 0 on E1.
    dashing(ctx, 1, t);
    dashing(ctx, 0, t, t.x, t.y);
    expect(hitAmounts(stage(ctx))).toEqual([[1, IMPACT * 1.2]]);
    // Back on its orbit: none.
    const orbiting = roled([at(300, 0)], 2, 1, [queen(1)]);
    orbiting.sys.drones.nextPick.fill(1e9);
    const e = enemy(orbiting, 1);
    dashing(orbiting, 0, e, e.x, e.y);
    expect(orbiting.sys.drones.mode[1]).toBe(DRONE_GUARD);
    expect(hitAmounts(stage(orbiting))).toEqual([[1, IMPACT]]);
  });

  describe('a guard’s impact: its role × the follow factor, × 自爆協議’s and 蜂潮’s (P2)', () => {
    /**
     * ◆蜂后 on drone 0 dashing at E1 from its dock when `led`, docked when not; ◆重錘 on guard 1,
     * on E1 with `left` impacts left, marked surging at E1 when `surging`. E2 is in the splash
     * of 40, E3 in the explosion's 80 alone.
     */
    function hammerOnE1(left: number, surging: boolean, led = true): number[][] {
      const ctx = roled([at(300, 0), at(300, 30), at(240, 0)], 2, 1, [queen(0), hammer(1)], {
        ...BLAST,
        ...surge(8),
      });
      const ds = ctx.sys.drones;
      const t = enemy(ctx, 1);
      ds.nextPick.fill(1e9);
      ds.dockLeft[0] = 1e9;
      if (led) dashing(ctx, 0, t);
      dashing(ctx, 1, t, t.x, t.y);
      ds.impactsLeft[1] = left;
      if (surging) {
        surgeOf(ctx).target = t;
        ds.surging[1] = 1;
      }
      return hitAmounts(stage(ctx));
    }

    it('is IMPACT × 5 × 1.2 on a plain impact, × 0.75 on the explosion, × 2 surging and × 0.75 × 2 on both; × 5 without the leader on the target', () => {
      // Planted bugs: the explosion's factor in place of the role's and the follow factor (=),
      // or of the follow factor alone; E5's factors first, then the role's written over them;
      // the role lookup skipping the guards' dock indices.
      const each = (amount: number, n: number): number[][] =>
        [1, 2, 3].slice(0, n).map((id) => [id, amount]);
      const plain = IMPACT * 5 * 1.2;
      expect(hammerOnE1(3, false)).toEqual(each(plain, 2));
      expect(hammerOnE1(1, false)).toEqual(each(plain * 0.75, 3));
      expect(hammerOnE1(3, true)).toEqual(each(plain * 2, 2));
      expect(hammerOnE1(1, true)).toEqual(each(plain * 0.75 * 2, 3));
      expect(hammerOnE1(1, false, false)).toEqual(each(IMPACT * 5 * 0.75, 3));
      expect(hammerOnE1(1, true, false)).toEqual(each(IMPACT * 5 * 0.75 * 2, 3));
    });
  });

  it('dashes a ◆重錘 guard out and flies it home at its role’s speed, 10 × 0.4 = 4 a tick (E4 R1)', () => {
    // Planted bugs: a guard's dash step, or its flight home, without its role's speed factor.
    const ctx = roled([at(0, 300)], 1, 1, [hammer(0)]);
    const ds = ctx.sys.drones;
    const t = enemy(ctx, 1);
    ds.nextPick.fill(1e9);
    const [x0, y0] = [ds.x[0] as number, ds.y[0] as number];
    dashing(ctx, 0, t);
    stage(ctx);
    const out = Math.hypot(t.x - x0, t.y - y0);
    expect(ds.x[0]).toBeCloseTo(x0 + ((t.x - x0) * 4) / out, 9);
    expect(ds.y[0]).toBeCloseTo(y0 + ((t.y - y0) * 4) / out, 9);
    // Home from 100 out of its dock, which stays where it left.
    const home = [ds.dockX[0] as number, ds.dockY[0] as number] as const;
    ds.mode[0] = DRONE_RETURN;
    ds.x[0] = home[0];
    ds.y[0] = home[1] + 100;
    next(ctx);
    expect([ds.mode[0], ds.dockX[0], ds.dockY[0], ds.x[0]]).toEqual([
      DRONE_RETURN,
      ...home,
      home[0],
    ]);
    expect(ds.y[0]).toBeCloseTo(home[1] + 96, 9);
  });

  it('writes a guard’s heading as it dashes from outside its target, and clears it as it docks on its orbit (FL)', () => {
    // Planted bugs: a guard's dash writing no heading; a guard's docking keeping it.
    const ctx = roled([at(0, 300)], 1, 1, []);
    const ds = ctx.sys.drones;
    const t = enemy(ctx, 1);
    ds.nextPick.fill(1e9);
    const [x0, y0] = [ds.x[0] as number, ds.y[0] as number];
    dashing(ctx, 0, t);
    stage(ctx);
    expect([ds.hx[0], ds.hy[0]]).toEqual([t.x - x0, t.y - y0]);
    // Flying home, it keeps it; docking, it has none.
    ds.mode[0] = DRONE_RETURN;
    ds.x[0] = ds.dockX[0] as number;
    ds.y[0] = (ds.dockY[0] as number) + 5;
    next(ctx);
    expect([ds.mode[0], ds.hx[0], ds.hy[0]]).toEqual([DRONE_GUARD, 0, 0]);
  });

  it('under 集火指令 picks a charging dasher first, then the highest-hp enemy in the ring; a swarm drone or turret, the highest at any distance (P1)', () => {
    // Planted bugs: 集火's branch of pickOuter without the ring; pickHighestHp passing over no
    // enemy; 集火 skipping the charging tier; a turret's 集火 pick bounded by the ring.
    const ctx = hive(
      [at(300, 0, { hp: 1e15 }), at(0, 100, { hp: 1e13 }), at(-60, 0), dasher(0, -420)],
      { drones: 2, turrets: 1, ...guards(1) },
      { data: QUIET_V3, modules: [FOCUS] },
    );
    const ds = ctx.sys.drones;
    expect([ds.guardFirst, ds.guardEnd, ds.kind[2]]).toEqual([1, 2, DRONE_KIND_TURRET]);
    expect(guardPick(ctx, ds, 1)?.id).toBe(2);
    expect(pickOuter(ctx, 0)?.id).toBe(1);
    // The turret's first firing: at E1, 300 out.
    let fired: number[] = [];
    for (let k = 0; k < 300 && fired.length === 0; k++) {
      fired = eventsOf([k === 0 ? stage(ctx) : next(ctx)], 'turretFire').map((e) => e.targetId);
    }
    expect(fired).toEqual([1]);
    charge(enemy(ctx, 4));
    expect(guardPick(ctx, ds, 1)?.id).toBe(4);
    expect(pickOuter(ctx, 0)?.id).toBe(1);
  });

  it('checks E4’s members on a swarm with E5’s, and E5’s on a swarm with roles', () => {
    // Planted bugs: checkSwarmParams skipped on a guarded swarm; the guards' check skipped when
    // roles are set.
    const compileWith = (fields: Partial<SwarmParams>) => () =>
      compileBuild(makeStats(), [], SWARM, [swarmParams(fields)]);
    const e5 = { ...BLAST, ...guards(2), ...surge(8) };
    expect(compileWith({ ...e5, roles: [role(0, { damageMult: 0 })] })).toThrow(
      'swarm.roles[0].damageMult: 0 must be finite and above 0',
    );
    expect(compileWith({ ...e5, turretRadius: -1 })).toThrow(
      'swarm.turretRadius: -1 must be finite and >= 0',
    );
    const roles = [queen(0), hammer(1)];
    expect(compileWith({ roles, ...guards(0) })).toThrow(
      'guards: count 0 must be a whole number >= 1, radius 120 finite and above 0',
    );
    expect(compileWith({ roles, lastImpact: { radius: 0, damagePct: 1.5 } })).toThrow(
      'lastImpact: radius 0 and damagePct 1.5 must be finite and above 0',
    );
    expect(compileWith({ roles, ...surge(8, 0) })).toThrow(
      'surge: periodSec 8 and damageMult 0 must be finite and above 0',
    );
    expect(compileWith({ ...e5, roles })().signature.swarm?.roles).toEqual(roles);
  });
});
