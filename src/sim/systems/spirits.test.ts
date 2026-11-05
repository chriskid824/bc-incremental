/**
 * The drone pool's timed rows (C5.7: spirits, DRONE_KIND_SPIRIT): spawnDrone's executor and
 * spawnRows, the pool's capacity and per-spec tables (createDronePool, droneLayout), the cap and
 * its counting, stepDrones' time test, a spirit's step, picks (pickNearest, pickOuter), impact,
 * ailment term and leaving with droneExpire, and the stage's compaction (drones.ts). Most tests
 * run the drone stage alone on placed enemies, a tick at a time; the run order goes through
 * createSimulation.
 */

import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import { createRng, createStreams } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { DroneGrant, SourcedEmitter } from '../../data/emitters';
import type { StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import { APPLIED_AILMENTS } from '../../data/triggers';
import type { SpawnDroneSpec, TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { liveBurnStacks } from '../ailments/records';
import { DRONE_MEMORY, PICK_TICKS, SUMMON_CAP } from '../caps';
import { HIT_EVENT, PRIMARY, SIGNATURE } from '../effects/flags';
import { runEffect, runEffectQueue } from '../effects/execute';
import { createEffectEntry } from '../effects/queue';
import { EVENT, MAX_DEPTH } from '../effects/types';
import type { BuildCompiler, TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  COUNTER_IDS,
  DRONE_DASH,
  DRONE_HOVER,
  DRONE_KIND_DRONE,
  DRONE_KIND_SPIRIT,
  NO_INPUT,
} from '../types';
import type { SimEvent } from '../types';
import { createRunContext } from './context';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import { pickNearest, pickOuter, stepDrones } from './drones';
import { rebuildGrid } from './grid';
import { NEVER_LEAVES } from './systemState';
import type { DronePool, SpawnSpecs } from './systemState';

type ExpireEvent = Extract<SimEvent, { type: 'droneExpire' }>;
type ImpactEvent = Extract<SimEvent, { type: 'impact' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** A point 500 right of the player, where most tests spawn their rows. */
const R = { x: PLAYER.x + 500, y: PLAYER.y };
/** A spirit's step a tick at m = 1 (DRONE_DEFAULTS.speed 600 / 60), and a square's radius. */
const STEP = 10;
const RADIUS = 20;
/** round(4 × 60): a lifeSec of 4 in ticks. */
const LIFE_4S = 240;

const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y + dy,
  ...more,
});
/** An enemy at R + (dx, dy). */
const nearR = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy =>
  at(500 + dx, dy, more);
const drone = (drones: number, fields: Omit<DroneGrant, 'kind' | 'drones'> = {}): DroneGrant => ({
  kind: 'drone',
  drones,
  ...fields,
});
const on = (source: string, grant: SourcedEmitter['grant']): SourcedEmitter => ({ source, grant });
/** A test module that only raises the run's summon cap to `summonCap`. */
const raiseCap = (summonCap: number): TestModule =>
  Object.assign((_b: BuildCompiler) => undefined, { summonCap });

/** Damage 10 and no crits or ignites unless `values` say so: the hits draw nothing. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
const HEAL = { kind: 'heal', lifePct: 0.01 } as const;

/** A spawnDrone of lifeSec 4 and damagePct 1, the rest its defaults, with `fields`. */
const spawnSpec = (fields: Partial<SpawnDroneSpec> = {}): SpawnDroneSpec => ({
  kind: 'spawnDrone',
  lifeSec: 4,
  damagePct: 1,
  ...fields,
});
/** A trigger that never fires in these tests (no enemy reaches the player): it holds a spec. */
const holder = (fields: Partial<SpawnDroneSpec> = {}): TriggerSpec => ({
  on: 'heroHit',
  do: [spawnSpec(fields)],
});

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly grants?: readonly SourcedEmitter[];
  /** The spawnDrone specs held by heroHit triggers after `triggers`: one of defaults if omitted. */
  readonly spawns?: readonly Partial<SpawnDroneSpec>[];
  readonly triggers?: readonly TriggerSpec[];
  readonly modules?: readonly TestModule[];
  readonly signature?: Parameters<typeof placedEnemies>[1] extends infer O
    ? O extends { signature?: infer S }
      ? S
      : never
    : never;
}

/**
 * placedEnemies with these triggers, then one heroHit trigger per spawn spec, all credited to
 * outer.summon, and these grants (none by default) over NO_ROLLS.
 */
function fixture(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  const triggers = [...(options.triggers ?? []), ...(options.spawns ?? [{}]).map(holder)];
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], {
      triggers: triggers.map((spec) => ({ source: 'outer.summon', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    ...(options.signature === undefined ? {} : { signature: options.signature }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const specsOf = (ctx: RunContext): SpawnSpecs => ctx.sys.drones.specs as SpawnSpecs;

/** The compiled effect index of the build's n-th spawnDrone effect. */
function specOf(ctx: RunContext, n = 0): number {
  const found = ctx.build.effects.flatMap((fx, i) => (fx.kind === 'spawnDrone' ? [i] : []));
  const f = found[n];
  if (f === undefined) throw new Error(`no spawnDrone effect ${n}`);
  return f;
}

/** The index of the build's n-th trigger on `event` (an EVENT ordinal). */
function triggerOf(ctx: RunContext, event: number, n = 0): number {
  const found = ctx.build.triggers.filter((t) => t.on === event).map((t) => t.index);
  const i = found[n];
  if (i === undefined) throw new Error(`no trigger ${n} on event ${event}`);
  return i;
}

/**
 * Runs the n-th spawnDrone effect through its executor on the current tick, at `point`, as a
 * trigger's effect at `depth` from trigger `origin` would run in the effect phase.
 */
function spawn(
  ctx: RunContext,
  n = 0,
  point: { readonly x: number; readonly y: number } = R,
  depth = 1,
  origin = -1,
): void {
  const entry = createEffectEntry();
  entry.effect = specOf(ctx, n);
  entry.depth = depth;
  entry.origin = origin;
  entry.x = point.x;
  entry.y = point.y;
  runEffect(ctx, entry);
}

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

/** The next tick's drone stage, then its effect phase, as a run orders them. */
function nextWithEffects(ctx: RunContext): SimEvent[] {
  const events = next(ctx);
  runEffectQueue(ctx);
  return events;
}

const expires = (events: readonly SimEvent[]): ExpireEvent[] => eventsOf([events], 'droneExpire');
const impacts = (events: readonly SimEvent[]): ImpactEvent[] => eventsOf([events], 'impact');
const hitIds = (events: readonly SimEvent[]): number[] =>
  eventsOf([events], 'hit').map((hit) => hit.targetId);
const liveIds = (ds: DronePool): number[] => Array.from(ds.id.subarray(0, ds.count));

/** Puts slot s in DASH at `target`, where it is: what engage leaves. */
function dashing(ctx: RunContext, s: number, target: Enemy): void {
  const ds = ctx.sys.drones;
  ds.mode[s] = DRONE_DASH;
  ds.target[s] = target;
  ds.targetId[s] = target.id;
}

/** The entries of the effect queue, oldest first. */
function queued(
  ctx: RunContext,
): { effect: number; depth: number; origin: number; x: number; y: number; target: number }[] {
  const q = ctx.effectQueue;
  return Array.from({ length: q.size }, (_, n) => {
    const i = (q.head + n) & q.capMask;
    return {
      effect: q.effect[i] as number,
      depth: q.depth[i] as number,
      origin: q.origin[i] as number,
      x: q.x[i] as number,
      y: q.y[i] as number,
      target: q.target[i]?.id ?? -1,
    };
  });
}

/** The pool's per-slot arrays with one entry a slot (the memory has DRONE_MEMORY a slot). */
const PER_SLOT = [
  'id',
  'kind',
  'mode',
  'x',
  'y',
  'prevX',
  'prevY',
  'targetId',
  'owner',
  'seat',
  'size',
  'dockX',
  'dockY',
  'target',
  'nextPick',
  'impactsLeft',
  'dockLeft',
  'acc',
  'until',
  'spec',
  'depth',
  'origin',
  'roleDamage',
  'roleSpeed',
] as const;
const MEMORY = ['memId', 'memUntil'] as const;

/** Everything slot s holds, by array name (a target as its id). */
function rowOf(ds: DronePool, s: number): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const name of PER_SLOT) {
    const value = (ds[name] as ArrayLike<unknown>)[s];
    row[name] = name === 'target' ? ((value as Enemy | null)?.id ?? null) : value;
  }
  for (const name of MEMORY) {
    row[name] = Array.from(ds[name].subarray(s * DRONE_MEMORY, (s + 1) * DRONE_MEMORY));
  }
  return row;
}

/** Fixture data without enemies: a run's waves spawn none. */
const noEnemies = (): GameData =>
  makeTestData({
    waves: {
      rules: [
        { enemy: 'triangle', fromWave: 1, base: 0, perWave: 0, maxCount: 0 },
        { enemy: 'square', fromWave: 1, base: 0, perWave: 0, maxCount: 0 },
        { enemy: 'pentagon', fromWave: 1, base: 0, perWave: 0, maxCount: 0 },
      ],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    },
  });

describe('timed rows: the pool’s capacity and tables (K3)', () => {
  it('holds exactly its fixed rows in a build without spawnDrone, the summon cap with one, and nothing in an M1 run', () => {
    const m1 = placedEnemies([]);
    expect([m1.sys.drones.rows, m1.sys.drones.until.length, m1.sys.drones.specs]).toEqual([
      0,
      0,
      null,
    ]);
    expect(m1.build.flags.spawnsDrones).toBe(false);
    const fixed = fixture([], { grants: [on('outer.summon', drone(3))], spawns: [] });
    const fd = fixed.sys.drones;
    expect(fixed.build.flags.spawnsDrones).toBe(false);
    expect([fd.count, fd.rows, fd.specs]).toEqual([3, 3, null]);
    for (const name of [...PER_SLOT, 'memId'] as const) {
      const per = name === 'memId' ? DRONE_MEMORY : 1;
      expect((fd[name] as ArrayLike<unknown>).length, name).toBe(3 * per);
    }
    expect([Array.from(fd.until), Array.from(fd.spec), Array.from(fd.depth)]).toEqual([
      [NEVER_LEAVES, NEVER_LEAVES, NEVER_LEAVES],
      [-1, -1, -1],
      [0, 0, 0],
    ]);
    expect(Array.from(fd.origin)).toEqual([-1, -1, -1]);
    // With a spawnDrone: the summon cap of slots, its fixed rows first, the rest empty.
    const timed = fixture([], { grants: [on('outer.summon', drone(3))] });
    const td = timed.sys.drones;
    expect(timed.build.flags.spawnsDrones).toBe(true);
    expect([td.count, td.rows, td.nextId]).toEqual([3, SUMMON_CAP, 4]);
    for (const name of [...PER_SLOT, 'memId'] as const) {
      const per = name === 'memId' ? DRONE_MEMORY : 1;
      expect((td[name] as ArrayLike<unknown>).length, name).toBe(SUMMON_CAP * per);
    }
    expect(Array.from(td.id.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(td.kind.subarray(0, 3))).toEqual([0, 0, 0].map(() => DRONE_KIND_DRONE));
    expect(Array.from(td.until)).toEqual(Array<number>(SUMMON_CAP).fill(NEVER_LEAVES));
    // A spawnDrone alone; a test module may raise the cap, and the pool follows it.
    expect(fixture([]).sys.drones.rows).toBe(SUMMON_CAP);
    expect(fixture([]).sys.drones.count).toBe(0);
    expect(fixture([], { modules: [raiseCap(40)] }).sys.drones.rows).toBe(40);
    expect(fixture([], { modules: [raiseCap(40)], spawns: [] }).sys.drones.rows).toBe(0);
  });

  it('sizes its per-spec tables by the build’s effects, each spawnDrone’s numbers with their defaults and 0 for any other effect', () => {
    const ctx = fixture([], {
      triggers: [{ on: 'heroHit', do: [HEAL] }],
      spawns: [
        {},
        {
          lifeSec: 2,
          damagePct: 0.5,
          count: 2,
          impacts: 3,
          maxLive: 5,
          aim: 'outer',
          speed: 300,
          splash: 0,
          ailment: 'burn',
          ailmentStacks: 3,
          ailmentDamagePct: 0.4,
        },
      ],
    });
    const specs = specsOf(ctx);
    expect(ctx.build.effects.map((fx) => fx.kind)).toEqual(['heal', 'spawnDrone', 'spawnDrone']);
    const table = (name: keyof SpawnSpecs): number[] => Array.from(specs[name]);
    expect(table('live')).toEqual([0, 0, 0]);
    expect(table('maxLive')).toEqual([0, SUMMON_CAP, 5]);
    expect(table('stepBase')).toEqual([0, STEP, 5]);
    expect(table('coolTicks')).toEqual([0, 30, 30]);
    expect(table('splashSq')).toEqual([0, 1600, 0]);
    expect(table('impacts')).toEqual([0, 1, 3]);
    expect(table('aim')).toEqual([0, 0, 1]);
    expect(table('scale')).toEqual([0, 1, 0.5]);
    expect(table('ailment')).toEqual([-1, -1, APPLIED_AILMENTS.indexOf('burn')]);
    expect(table('stacks')).toEqual([0, 1, 3]);
    expect(table('ailmentPct')).toEqual([0, 1, 0.4]);
    // Its payload is the effect's: tagged hit, minion and area, on the effects stream, no flags.
    for (const f of [1, 2]) {
      const p = ctx.effectPayloads[f];
      expect(p?.tags).toBe(TAG.hit | TAG.minion | TAG.area);
      expect([
        p?.rng === ctx.effectsRng,
        p?.flags,
        p?.chains,
        p === null || p === undefined ? NaN : toNumber(p.baseDamage),
      ]).toEqual([true, 0, false, 10]);
    }
    // Each run's pool counts its own live rows.
    const other = fixture([], { spawns: [{}] });
    spawn(other);
    expect(specsOf(other).live[specOf(other)]).toBe(1);
    const fresh = fixture([], { spawns: [{}] });
    expect(specsOf(fresh).live[specOf(fresh)]).toBe(0);
  });

  it('adds no member to the run context: 126 own properties (B1’s frostBurnCap among them), as an M1 run’s, and keeps COUNTER_IDS at 20 (E10a’s barrageCapped the last)', () => {
    const m1 = createRunContext(makeConfig(), makeTestData());
    expect(Object.keys(m1).length).toBe(126);
    const timed = fixture([], { grants: [on('outer.summon', drone(3))] });
    expect(Object.keys(timed).length).toBe(126);
    expect(COUNTER_IDS).toHaveLength(20);
    expect(COUNTER_IDS.at(-1)).toBe('barrageCapped');
  });
});

describe('timed rows: spawning (K2, K4)', () => {
  it('appends each row at slot count with the next id, after the fixed rows: a hovering spirit at the point, with its effect, depth, origin and time', () => {
    const ctx = fixture([], { grants: [on('outer.summon', drone(3))], spawns: [{ count: 2 }] });
    const ds = ctx.sys.drones;
    const fixed = [0, 1, 2].map((s) => rowOf(ds, s));
    ctx.now = ctx.state.tick = 7;
    spawn(ctx, 0, { x: 1234, y: 321 }, 2, 5);
    expect([ds.count, ds.nextId, ctx.state.droneCount]).toEqual([5, 6, 5]);
    expect([0, 1, 2].map((s) => rowOf(ds, s))).toEqual(fixed);
    const f = specOf(ctx);
    for (const s of [3, 4]) {
      expect(rowOf(ds, s), `slot ${s}`).toEqual({
        id: s + 1,
        kind: DRONE_KIND_SPIRIT,
        mode: DRONE_HOVER,
        x: 1234,
        y: 321,
        prevX: 1234,
        prevY: 321,
        targetId: -1,
        owner: -1,
        seat: -1,
        size: 1,
        dockX: 1234,
        dockY: 321,
        target: null,
        nextPick: 7,
        impactsLeft: 1,
        dockLeft: 0,
        acc: 0,
        until: 7 + LIFE_4S,
        spec: f,
        depth: 2,
        origin: 5,
        roleDamage: 1,
        roleSpeed: 1,
        memId: [-1, -1, -1, -1],
        memUntil: [0, 0, 0, 0],
      });
    }
    expect(specsOf(ctx).live[f]).toBe(2);
    expect(ctx.counters.summonCapped).toBe(0);
    // The next spawn goes on after them.
    spawn(ctx);
    expect(liveIds(ds)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ds.nextId).toBe(8);
  });

  it('wipes the memory, target, clocks and role columns a slot held before, whatever row it was', () => {
    const ctx = fixture([nearR(0, 0)], { spawns: [{ lifeSec: 1 / 60 }] });
    const ds = ctx.sys.drones;
    spawn(ctx);
    // Slot 0's row leaves at the next stage; what it held stays in the arrays past count.
    ds.memId.fill(7, 0, DRONE_MEMORY);
    ds.memUntil.fill(9999, 0, DRONE_MEMORY);
    ds.impactsLeft[0] = 5;
    ds.acc[0] = 3;
    ds.dockLeft[0] = 2;
    // E4: a role's columns too, as a moved swarm drone's would be (none moves today).
    ds.roleDamage[0] = 5;
    ds.roleSpeed[0] = 0.4;
    ds.size[0] = 1.5;
    next(ctx);
    expect(ds.count).toBe(0);
    spawn(ctx, 0, PLAYER, 1, 4);
    expect(rowOf(ds, 0)).toMatchObject({
      id: 2,
      mode: DRONE_HOVER,
      target: null,
      targetId: -1,
      nextPick: ctx.now,
      impactsLeft: 1,
      acc: 0,
      dockLeft: 0,
      memId: [-1, -1, -1, -1],
      memUntil: [0, 0, 0, 0],
      until: ctx.now + 1,
      origin: 4,
      roleDamage: 1,
      roleSpeed: 1,
      size: 1,
    });
  });

  it('refuses rows past the summon cap, fixed rows counted, one summonCapped each; a place freed in a stage is taken by a later spawn', () => {
    const ctx = fixture([], {
      grants: [on('outer.summon', drone(3))],
      spawns: [{ count: 30 }, { lifeSec: 1 / 60 }],
    });
    const ds = ctx.sys.drones;
    spawn(ctx, 1);
    spawn(ctx, 0);
    // 3 fixed, 1 + 20 timed: 10 of the 30 refused.
    expect([ds.count, ctx.counters.summonCapped]).toEqual([SUMMON_CAP, 10]);
    expect(Array.from(specsOf(ctx).live)).toEqual([20, 1]);
    spawn(ctx, 1);
    expect([ds.count, ctx.counters.summonCapped]).toEqual([SUMMON_CAP, 11]);
    // The one-tick row leaves in the next stage; the next spawn takes its place, and no more.
    expect(expires(next(ctx)).map((e) => [e.droneId, e.cause])).toEqual([[4, 'time']]);
    expect(ds.count).toBe(SUMMON_CAP - 1);
    spawn(ctx, 0);
    expect([ds.count, ctx.counters.summonCapped, ds.nextId]).toEqual([SUMMON_CAP, 40, 26]);
    expect(liveIds(ds)).toEqual([1, 2, 3, ...Array.from({ length: 21 }, (_, k) => k + 5)]);
  });

  it('refuses rows past their own effect’s maxLive, one summonCapped each, while another effect’s rows still come; a row that leaves frees its place', () => {
    const ctx = fixture([], {
      spawns: [
        { maxLive: 2, count: 3, lifeSec: 2 / 60 },
        { maxLive: 3, count: 4 },
      ],
    });
    const ds = ctx.sys.drones;
    const [a, b] = [specOf(ctx, 0), specOf(ctx, 1)];
    spawn(ctx, 0);
    expect([ds.count, ctx.counters.summonCapped]).toEqual([2, 1]);
    spawn(ctx, 1);
    expect([ds.count, ctx.counters.summonCapped]).toEqual([5, 2]);
    spawn(ctx, 0);
    spawn(ctx, 1);
    expect([ds.count, ctx.counters.summonCapped]).toEqual([5, 9]);
    expect([specsOf(ctx).live[a], specsOf(ctx).live[b]]).toEqual([2, 3]);
    next(ctx);
    expect(expires(next(ctx)).map((e) => e.droneId)).toEqual([1, 2]);
    expect([specsOf(ctx).live[a], specsOf(ctx).live[b]]).toEqual([0, 3]);
    spawn(ctx, 0);
    expect([ds.count, ctx.counters.summonCapped]).toEqual([5, 10]);
    // Refused rows take no id.
    expect(liveIds(ds)).toEqual([3, 4, 5, 6, 7]);
    expect(Array.from(ds.spec.subarray(0, 5))).toEqual([b, b, b, a, a]);
  });

  it('keeps slot order = id order, the live rows those before their end and the counts the caps give, over 200 seeded spawn sequences (a model)', () => {
    // Each effect's life in ticks, maxLive and count.
    const SPECS = [
      { ticks: 2, maxLive: 5, count: 2 },
      { ticks: 5, maxLive: SUMMON_CAP, count: 4 },
      { ticks: 12, maxLive: 8, count: 1 },
      { ticks: 7, maxLive: 3, count: 3 },
    ];
    let reachedCap = 0;
    let refusedBySpec = 0;
    for (let seq = 0; seq < 200; seq++) {
      const rng = createRng(7100 + seq);
      const ctx = fixture([], {
        grants: [on('outer.summon', drone(2))],
        values: { attackSpeed: 0 },
        spawns: SPECS.map(({ ticks, maxLive, count }) => ({ lifeSec: ticks / 60, maxLive, count })),
      });
      const ds = ctx.sys.drones;
      const specs = specsOf(ctx);
      const effect = SPECS.map((_, n) => specOf(ctx, n));
      const rows: { id: number; f: number; until: number }[] = [];
      let nextId = 3;
      let refused = 0;
      for (let t = 0; t < 40; t++) {
        const events = next(ctx);
        const now = ctx.now;
        const leaving = rows.filter((r) => r.until <= now);
        expect(
          expires(events).map((e) => e.droneId),
          `seq ${seq} tick ${now}`,
        ).toEqual(leaving.map((r) => r.id));
        rows.splice(0, rows.length, ...rows.filter((r) => r.until > now));
        for (let k = rng.int(4); k > 0; k--) {
          const f = rng.int(SPECS.length);
          const { ticks, maxLive, count } = SPECS[f] as (typeof SPECS)[number];
          const ownRoom = maxLive - rows.filter((r) => r.f === f).length;
          const room = Math.min(SUMMON_CAP - 2 - rows.length, ownRoom);
          const placed = Math.max(0, Math.min(count, room));
          if (placed < count && ownRoom < SUMMON_CAP - 2 - rows.length) refusedBySpec++;
          refused += count - placed;
          for (let j = 0; j < placed; j++) rows.push({ id: nextId++, f, until: now + ticks });
          spawn(ctx, f);
        }
        if (2 + rows.length === SUMMON_CAP) reachedCap++;
        expect(liveIds(ds), `seq ${seq} tick ${now}`).toEqual([1, 2, ...rows.map((r) => r.id)]);
        expect(Array.from(ds.until.subarray(2, ds.count))).toEqual(rows.map((r) => r.until));
        expect(Array.from(ds.spec.subarray(2, ds.count))).toEqual(
          rows.map((r) => effect[r.f] as number),
        );
        expect(effect.map((f) => specs.live[f])).toEqual(
          SPECS.map((_, f) => rows.filter((r) => r.f === f).length),
        );
        expect([ds.nextId, ctx.counters.summonCapped, ctx.state.droneCount]).toEqual([
          nextId,
          refused,
          ds.count,
        ]);
      }
    }
    // The sequences reach the summon cap and each effect's own cap.
    expect(reachedCap).toBeGreaterThan(100);
    expect(refusedBySpec).toBeGreaterThan(100);
  });
});

describe('timed rows: their time (K2, K5)', () => {
  it.each([4, 8, 2, 0])(
    'is in the pool from its spawn tick and leaves 240 ticks later for lifeSec 4 (not 239, not 241), at attack speed %i',
    (attackSpeed) => {
      const ctx = fixture([], { values: { attackSpeed } });
      const ds = ctx.sys.drones;
      spawn(ctx);
      const born = ctx.now;
      expect([ds.count, ctx.state.droneCount, ds.until[0]]).toEqual([1, 1, born + LIFE_4S]);
      while (ctx.now < born + LIFE_4S - 1) {
        expect(expires(next(ctx)), `tick ${ctx.now}`).toEqual([]);
        expect(ctx.state.droneCount).toBe(1);
      }
      const events = next(ctx);
      expect(ctx.now).toBe(born + LIFE_4S);
      expect(expires(events)).toEqual([
        { type: 'droneExpire', droneId: 1, x: R.x, y: R.y, cause: 'time' },
      ]);
      expect([ds.count, ctx.state.droneCount, specsOf(ctx).live[specOf(ctx)]]).toEqual([0, 0, 0]);
      // Nothing is left to leave again.
      expect(expires(next(ctx))).toEqual([]);
    },
  );

  it.each([
    [0.5, 30],
    [1 / 60, 1],
    [0.001, 1],
    [1 / 120, 1],
    [0.025, 2],
    [10, 600],
  ])('lives round(lifeSec × 60) ticks, one at least: lifeSec %d lives %i', (lifeSec, ticks) => {
    const ctx = fixture([], { spawns: [{ lifeSec }] });
    spawn(ctx);
    const born = ctx.now;
    let left = -1;
    while (left < 0 && ctx.now < born + 1000) {
      if (expires(next(ctx)).length > 0) left = ctx.now;
    }
    expect(left - born).toBe(ticks);
  });

  it('leaves mid-dash when its time is up, where its last step left it, its target untouched', () => {
    // 900 right of the spawn point: 29 steps of 10 cover 290 of it.
    const ctx = fixture([at(900, 0)], { spawns: [{ lifeSec: 0.5 }] });
    const ds = ctx.sys.drones;
    spawn(ctx, 0, PLAYER);
    const born = ctx.now;
    const seen: SimEvent[] = [];
    while (ctx.now < born + 29) seen.push(...next(ctx));
    expect([ds.mode[0], ds.targetId[0], ds.x[0]]).toEqual([DRONE_DASH, 1, PLAYER.x + 290]);
    const events = next(ctx);
    expect(expires(events)).toEqual([
      { type: 'droneExpire', droneId: 1, x: PLAYER.x + 290, y: PLAYER.y, cause: 'time' },
    ]);
    expect(ds.count).toBe(0);
    expect([...seen, ...events].filter((e) => e.type === 'hit' || e.type === 'impact')).toEqual([]);
  });

  it('impacts once and leaves on that tick, its droneExpire spent after its impact, its slot dropped at the stage’s end', () => {
    const ctx = fixture([nearR(25, 0)]);
    const ds = ctx.sys.drones;
    spawn(ctx);
    const events = next(ctx);
    expect(events.map((e) => e.type)).toEqual(['hit', 'impact', 'droneExpire']);
    expect(expires(events)).toEqual([
      { type: 'droneExpire', droneId: 1, x: R.x + 25, y: R.y, cause: 'spent' },
    ]);
    expect(impacts(events).map((e) => [e.droneId, e.targetId])).toEqual([[1, 1]]);
    expect([ds.count, ctx.state.droneCount, specsOf(ctx).live[specOf(ctx)]]).toEqual([0, 0, 0]);
    expect(ds.target[0]).toBeNull();
  });

  it.each([
    [4, 30],
    [8, 15],
  ])(
    'impacts its target 3 times at attack speed %i, %i ticks apart (its cooldown at m), and leaves spent at the third',
    (attackSpeed, cooldown) => {
      const ctx = fixture([nearR(25, 0)], { values: { attackSpeed }, spawns: [{ impacts: 3 }] });
      const ds = ctx.sys.drones;
      spawn(ctx);
      const born = ctx.now;
      const ticks: number[] = [];
      let left: ExpireEvent[] = [];
      while (ds.count > 0 && ctx.now < born + 200) {
        const events = next(ctx);
        if (impacts(events).length > 0) ticks.push(ctx.now);
        left = [...left, ...expires(events)];
      }
      const first = born + 1;
      expect(ticks).toEqual([first, first + cooldown, first + 2 * cooldown]);
      expect(left.map((e) => [e.cause, e.droneId])).toEqual([['spent', 1]]);
      expect(ctx.now).toBe(first + 2 * cooldown);
    },
  );
});

describe('timed rows: their step (K5)', () => {
  it.each([
    [4, 600, STEP],
    [8, 600, 2 * STEP],
    [2, 600, STEP / 2],
    [4, 300, STEP / 2],
    [12, 200, STEP],
  ])(
    'steps speed × m / 60 a tick at attack speed %i and speed %i: %d, m = attackSpeed / 4',
    (attackSpeed, speed, step) => {
      const ctx = fixture([at(900, 0)], { values: { attackSpeed }, spawns: [{ speed }] });
      const ds = ctx.sys.drones;
      spawn(ctx, 0, PLAYER);
      next(ctx);
      expect([ds.mode[0], ds.x[0], ds.prevX[0]]).toEqual([DRONE_DASH, PLAYER.x + step, PLAYER.x]);
      next(ctx);
      expect([ds.x[0], ds.prevX[0]]).toEqual([PLAYER.x + 2 * step, PLAYER.x + step]);
    },
  );

  it('arrives when its step reaches the target’s edge, snapping to its center', () => {
    // 45 away: 35 after one step, 25 after two, in reach (≤ 20 + 10) on the third.
    const ctx = fixture([at(45, 0)]);
    const ds = ctx.sys.drones;
    spawn(ctx, 0, PLAYER);
    expect(impacts(next(ctx))).toEqual([]);
    expect(ds.x[0]).toBe(PLAYER.x + STEP);
    expect(impacts(next(ctx))).toEqual([]);
    const events = next(ctx);
    expect(impacts(events).map((e) => [e.x, e.y])).toEqual([[PLAYER.x + 45, PLAYER.y]]);
    expect(expires(events)[0]?.x).toBe(PLAYER.x + 45);
    expect(45 - 3 * STEP).toBeLessThan(RADIUS);
  });

  it.each([
    ['0, at attack speed 0', { attackSpeed: 0 }, [], 0],
    ['below 0', {}, [(b: BuildCompiler) => b.offsetStat('attackSpeed', -8)], -4],
    ['NaN', {}, [(b: BuildCompiler) => b.scaleStat('attackSpeed', NaN)], NaN],
  ] as const)(
    'does nothing at an m of %s, picking and moving nothing, and still leaves on time',
    (_label, values, modules, attackSpeed) => {
      const ctx = fixture([nearR(25, 0)], { values, modules: modules as readonly TestModule[] });
      expect(ctx.build.values.attackSpeed).toBe(attackSpeed);
      const ds = ctx.sys.drones;
      spawn(ctx);
      const born = ctx.now;
      const before = rowOf(ds, 0);
      const seen: SimEvent[] = [];
      while (ctx.now < born + LIFE_4S - 1) seen.push(...next(ctx));
      expect(rowOf(ds, 0)).toEqual(before);
      expect(seen).toEqual([]);
      expect(expires(next(ctx)).map((e) => e.cause)).toEqual(['time']);
    },
  );

  it('first picks on the tick after its spawn, then only when it has lost its target, at most once every PICK_TICKS; it hovers where it is while it finds nothing, never flying home', () => {
    // Outside the arena: not pickable until it walks in.
    const ctx = fixture([{ x: -50, y: R.y }]);
    const ds = ctx.sys.drones;
    spawn(ctx);
    const born = ctx.now;
    next(ctx);
    expect([ds.mode[0], ds.nextPick[0], ds.x[0]]).toEqual([
      DRONE_HOVER,
      born + 1 + PICK_TICKS,
      R.x,
    ]);
    // In the arena from now on; the spirit waits for its clock.
    Object.assign(enemy(ctx, 1), { x: R.x - 300 });
    while (ctx.now < born + PICK_TICKS) {
      next(ctx);
      expect([ds.mode[0], ds.x[0], ds.prevX[0]], `tick ${ctx.now}`).toEqual([
        DRONE_HOVER,
        R.x,
        R.x,
      ]);
    }
    // Its pick dashes on the same tick.
    next(ctx);
    expect([ds.mode[0], ds.targetId[0], ds.x[0]]).toEqual([DRONE_DASH, 1, R.x - STEP]);
    expect(ds.nextPick[0]).toBe(ctx.now + PICK_TICKS);
  });

  it('drops a target another row killed: re-picks at once once its clock allows, dashing from the next tick, else hovers until it does', () => {
    const ctx = fixture([nearR(-300, 0), nearR(0, -200)], { spawns: [{ impacts: 9 }] });
    const ds = ctx.sys.drones;
    spawn(ctx);
    next(ctx);
    const picked = ctx.now;
    expect(ds.targetId[0]).toBe(2);
    // 2 dies before the spirit's next tick, within its clock: it hovers where it is.
    removeEnemy(ctx, enemy(ctx, 2));
    next(ctx);
    expect([ds.mode[0], ds.targetId[0], ds.x[0], ds.y[0]]).toEqual([
      DRONE_HOVER,
      -1,
      R.x,
      R.y - STEP,
    ]);
    while (ctx.now < picked + PICK_TICKS - 1) next(ctx);
    expect(ds.mode[0]).toBe(DRONE_HOVER);
    next(ctx);
    // Its clock allows: it picks 1 and dashes from that tick on.
    expect([ds.mode[0], ds.targetId[0], ds.nextPick[0]]).toEqual([
      DRONE_DASH,
      1,
      ctx.now + PICK_TICKS,
    ]);
    // From where it hovered, 10 above R, towards 1.
    const dist = Math.sqrt(300 * 300 + STEP * STEP);
    expect([ds.x[0], ds.y[0]]).toEqual([
      R.x + -300 * (STEP / dist),
      R.y - STEP + STEP * (STEP / dist),
    ]);
    // A lost target past its clock: it picks at the loss, without a step that tick.
    const ctx2 = fixture([nearR(-300, 0), nearR(0, -250)], { spawns: [{ impacts: 9 }] });
    const d2 = ctx2.sys.drones;
    spawn(ctx2);
    next(ctx2);
    while (ctx2.now < picked + PICK_TICKS + 3) next(ctx2);
    expect([d2.mode[0], d2.targetId[0]]).toEqual([DRONE_DASH, 2]);
    const y = d2.y[0] as number;
    removeEnemy(ctx2, enemy(ctx2, 2));
    next(ctx2);
    expect([d2.mode[0], d2.targetId[0], d2.y[0], d2.nextPick[0]]).toEqual([
      DRONE_DASH,
      1,
      y,
      ctx2.now + PICK_TICKS,
    ]);
  });
});

describe('timed rows: their picks (K6)', () => {
  it('aims nearest from its own position, not the player’s', () => {
    // 1 is 100 from the player and 400 from the row; 2 is 461 from the player, 112 from the row.
    const ctx = fixture([at(100, 0), nearR(-50, 100)]);
    spawn(ctx);
    expect(pickNearest(ctx, 0)?.id).toBe(2);
    next(ctx);
    expect(ctx.sys.drones.targetId[0]).toBe(2);
  });

  it('breaks a tie of distance to the lower id, whichever side it stands on', () => {
    for (const side of [1, -1]) {
      const ctx = fixture([nearR(0, -100 * side), nearR(0, 100 * side), nearR(150, 0)]);
      spawn(ctx);
      expect(pickNearest(ctx, 0)?.id, `side ${side}`).toBe(1);
    }
  });

  it('ranks an enemy another row dashes at after every free one, a drone’s chase and a spirit’s alike; with every one chased, the nearest chased, ties to the lower id', () => {
    const ctx = fixture([nearR(50, 0), nearR(0, 100), nearR(-150, 0)], {
      grants: [on('outer.summon', drone(1))],
      spawns: [{ count: 2 }],
    });
    spawn(ctx);
    const ds = ctx.sys.drones;
    expect(Array.from(ds.kind.subarray(0, 3))).toEqual([
      DRONE_KIND_DRONE,
      DRONE_KIND_SPIRIT,
      DRONE_KIND_SPIRIT,
    ]);
    expect(pickNearest(ctx, 2)?.id).toBe(1);
    dashing(ctx, 0, enemy(ctx, 1));
    expect(pickNearest(ctx, 2)?.id).toBe(2);
    dashing(ctx, 1, enemy(ctx, 2));
    expect(pickNearest(ctx, 2)?.id).toBe(3);
    // Its own chase does not count: slot 1 still takes 2 when the others are chased.
    dashing(ctx, 2, enemy(ctx, 3));
    expect(pickNearest(ctx, 1)?.id).toBe(2);
    // Every one chased by another row: the nearest of those.
    expect(pickNearest(ctx, 0)?.id).toBe(1);
    removeEnemy(ctx, enemy(ctx, 3));
    expect(pickNearest(ctx, 2)?.id).toBe(1);
    // Chased ties go to the lower id.
    const tie = fixture([nearR(0, 60), nearR(0, -60)], { spawns: [{ count: 3 }] });
    spawn(tie);
    dashing(tie, 0, enemy(tie, 2));
    dashing(tie, 1, enemy(tie, 1));
    expect(pickNearest(tie, 2)?.id).toBe(1);
    // A row that is not dashing chases nothing: a hovering one's old target counts for none.
    const hover = fixture([nearR(50, 0), nearR(100, 0)], { spawns: [{ count: 2 }] });
    spawn(hover);
    hover.sys.drones.target[0] = enemy(hover, 1);
    hover.sys.drones.mode[0] = DRONE_HOVER;
    expect(pickNearest(hover, 1)?.id).toBe(1);
  });

  it('counts a dashing spirit as a chase in a drone’s pick (pickOuter) too', () => {
    const ctx = fixture([at(700, 0), at(-600, 0), at(0, 300)], {
      grants: [on('outer.summon', drone(1))],
    });
    spawn(ctx);
    expect(pickOuter(ctx, 0)?.id).toBe(1);
    dashing(ctx, 1, enemy(ctx, 1));
    expect(pickOuter(ctx, 0)?.id).toBe(2);
    // A spirit that left in the stage chases nothing from then on.
    const left = fixture([at(700, 0), at(-600, 0)], {
      grants: [on('outer.summon', drone(1))],
      spawns: [{ lifeSec: 1 / 60 }],
    });
    spawn(left);
    dashing(left, 1, enemy(left, 1));
    next(left);
    expect([left.sys.drones.count, pickOuter(left, 0)?.id]).toEqual([1, 1]);
    // So too for a later slot in the stage it left in: slot 0 leaves dashing at 1, and slot 1,
    // picking for the first time on that tick, takes 1.
    const same = fixture([nearR(100, 0), nearR(200, 0)], { spawns: [{ lifeSec: 2 / 60 }, {}] });
    const ds = same.sys.drones;
    spawn(same, 0);
    next(same);
    expect([ds.mode[0], ds.targetId[0]]).toEqual([DRONE_DASH, 1]);
    spawn(same, 1);
    const events = next(same);
    expect(expires(events).map((e) => [e.droneId, e.cause])).toEqual([[1, 'time']]);
    expect([ds.count, ds.id[0], ds.mode[0], ds.targetId[0]]).toEqual([1, 2, DRONE_DASH, 1]);
  });

  it('skips an enemy outside the arena, a dead one and one in its own cooldown memory', () => {
    const ctx = fixture([nearR(10, 0), nearR(30, 0), nearR(50, 0), nearR(70, 0)]);
    spawn(ctx);
    const ds = ctx.sys.drones;
    removeEnemy(ctx, enemy(ctx, 1));
    ds.memId[0] = 2;
    ds.memUntil[0] = ctx.now + 1;
    Object.assign(enemy(ctx, 3), { y: ARENA_HEIGHT + 1 });
    expect(pickNearest(ctx, 0)?.id).toBe(4);
    // An expired entry holds nothing.
    ds.memUntil[0] = ctx.now;
    expect(pickNearest(ctx, 0)?.id).toBe(2);
  });

  /**
   * A seeded fixture: up to 12 enemies (pairs mirrored about the row at one distance, some on an
   * edge, some just outside one, some dead), 2 drones and 1 to 6 spirits in mixed modes, every
   * enemy chased in some, and memory entries live, expired and unknown. Returns the context and
   * the spirit slot to pick for, moved to a seeded point.
   */
  function nearestFixture(rng: Rng): { ctx: RunContext; s: number } {
    const rx = 200 + rng.int(ARENA_WIDTH - 400);
    const ry = 100 + rng.int(ARENA_HEIGHT - 200);
    const n = rng.int(13);
    const placed: PlacedEnemy[] = [];
    for (let i = 0; i < n; i++) {
      const r = rng.next();
      const prev = placed[i - 1];
      const edge = rng.int(4);
      if (r < 0.25 && prev !== undefined) {
        placed.push({ x: 2 * rx - prev.x, y: 2 * ry - prev.y });
      } else if (r < 0.35) {
        placed.push(
          edge < 2
            ? { x: edge === 0 ? 0 : ARENA_WIDTH, y: rng.int(ARENA_HEIGHT + 1) }
            : { x: rng.int(ARENA_WIDTH + 1), y: edge === 2 ? 0 : ARENA_HEIGHT },
        );
      } else if (r < 0.45) {
        placed.push(
          edge < 2
            ? { x: edge === 0 ? -1 : ARENA_WIDTH + 1, y: rng.int(ARENA_HEIGHT + 1) }
            : { x: rng.int(ARENA_WIDTH + 1), y: edge === 2 ? -1 : ARENA_HEIGHT + 1 },
        );
      } else {
        placed.push({ x: rng.int(ARENA_WIDTH + 121) - 60, y: rng.int(ARENA_HEIGHT + 121) - 60 });
      }
    }
    const spirits = 1 + rng.int(6);
    const ctx = fixture(placed, {
      grants: [on('outer.summon', drone(2))],
      spawns: [{ count: spirits }],
    });
    for (const e of ctx.enemies) if (rng.chance(0.15)) removeEnemy(ctx, e);
    ctx.now = ctx.state.tick = 100 + rng.int(100);
    spawn(ctx, 0, { x: rng.int(ARENA_WIDTH), y: rng.int(ARENA_HEIGHT) });
    const ds = ctx.sys.drones;
    const s = 2 + rng.int(spirits);
    ds.x[s] = rx;
    ds.y[s] = ry;
    const enemies = ctx.enemies;
    for (let o = 0; o < ds.count; o++) {
      if (enemies.length > 0 && rng.chance(0.4)) dashing(ctx, o, rng.pick(enemies));
      else if (rng.chance(0.3) && enemies.length > 0) {
        // Hovering, still holding an old target: it chases nothing.
        ds.target[o] = rng.pick(enemies);
        ds.mode[o] = DRONE_HOVER;
      }
    }
    if (enemies.length > 0 && enemies.length < ds.count && rng.chance(0.25)) {
      let o = 0;
      for (const e of enemies) {
        if (o === s) o++;
        dashing(ctx, o, e);
        o++;
      }
    }
    for (let k = 0; k < ds.count * DRONE_MEMORY; k++) {
      if (rng.chance(0.6)) continue;
      ds.memId[k] = enemies.length > 0 && rng.chance(0.8) ? rng.pick(enemies).id : 999;
      ds.memUntil[k] = ctx.now + rng.int(61) - 30;
    }
    return { ctx, s };
  }

  /** The test's own pick: a sort of the candidates by (chased by another row, d², id). */
  function nearestRef(ctx: RunContext, s: number): Enemy | null {
    const ds = ctx.sys.drones;
    const x = ds.x[s] as number;
    const y = ds.y[s] as number;
    const inArena = (e: Enemy): boolean =>
      e.x >= 0 && e.x <= ARENA_WIDTH && e.y >= 0 && e.y <= ARENA_HEIGHT;
    const remembered = (e: Enemy): boolean => {
      for (let k = s * DRONE_MEMORY; k < (s + 1) * DRONE_MEMORY; k++) {
        if (ds.memId[k] === e.id && (ds.memUntil[k] as number) > ctx.now) return true;
      }
      return false;
    };
    const chasedBy = (e: Enemy): number => {
      for (let o = 0; o < ds.count; o++) {
        if (o !== s && ds.mode[o] === DRONE_DASH && ds.target[o] === e) return 1;
      }
      return 0;
    };
    const d2 = (e: Enemy): number => (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
    const sorted = ctx.enemies
      .filter((e) => e.alive && inArena(e) && !remembered(e))
      .sort((a, b) => chasedBy(a) - chasedBy(b) || d2(a) - d2(b) || a.id - b.id);
    return sorted[0] ?? null;
  }

  it('picks what a brute-force sort by (chased, distance² from the row, id) picks, over 300 seeded fixtures, writing and drawing nothing', () => {
    const seen = { picked: 0, none: 0, chased: 0, tied: 0, edge: 0, remembered: 0 };
    for (let f = 0; f < 300; f++) {
      const { ctx, s } = nearestFixture(createRng(9500 + f));
      const ds = ctx.sys.drones;
      const want = nearestRef(ctx, s);
      const before = Array.from({ length: ds.count }, (_, o) => rowOf(ds, o));
      const streams = rngPositions(ctx);
      const got = pickNearest(ctx, s);
      expect(got?.id ?? null, `fixture ${f}, slot ${s}`).toBe(want?.id ?? null);
      expect(Array.from({ length: ds.count }, (_, o) => rowOf(ds, o))).toEqual(before);
      expect(rngPositions(ctx)).toEqual(streams);
      for (let k = s * DRONE_MEMORY; k < (s + 1) * DRONE_MEMORY; k++) {
        if (ds.memId[k] !== -1 && (ds.memUntil[k] as number) > ctx.now) seen.remembered++;
      }
      if (want === null) {
        seen.none++;
        continue;
      }
      seen.picked++;
      for (let o = 0; o < ds.count; o++) {
        if (o !== s && ds.mode[o] === DRONE_DASH && ds.target[o] === want) {
          seen.chased++;
          break;
        }
      }
      const d2 = (e: Enemy): number =>
        (e.x - (ds.x[s] as number)) ** 2 + (e.y - (ds.y[s] as number)) ** 2;
      if (ctx.enemies.some((e) => e !== want && e.alive && d2(e) === d2(want))) seen.tied++;
      if (want.x === 0 || want.x === ARENA_WIDTH || want.y === 0 || want.y === ARENA_HEIGHT) {
        seen.edge++;
      }
    }
    // The fixtures reach every tier and case.
    expect(seen.picked).toBeGreaterThan(150);
    expect(seen.none).toBeGreaterThan(10);
    expect(seen.chased).toBeGreaterThan(20);
    expect(seen.tied).toBeGreaterThan(10);
    expect(seen.edge).toBeGreaterThan(5);
    expect(seen.remembered).toBeGreaterThan(100);
  });

  it('with aim outer, dashes at exactly what pickOuter picks for it, over 100 seeded fixtures', () => {
    let differs = 0;
    let picked = 0;
    for (let f = 0; f < 100; f++) {
      const rng = createRng(4400 + f);
      const placed = Array.from({ length: 1 + rng.int(10) }, () =>
        at(
          (rng.chance(0.5) ? 1 : -1) * (150 + rng.int(800)),
          (rng.chance(0.5) ? 1 : -1) * rng.int(500),
        ),
      );
      const ctx = fixture(placed, { spawns: [{ aim: 'outer', count: 1 + rng.int(3) }] });
      spawn(ctx, 0, PLAYER);
      const ds = ctx.sys.drones;
      const want: (number | null)[] = [];
      const nearest: (number | null)[] = [];
      ctx.now = ctx.state.tick = ctx.now + 1;
      rebuildGrid(ctx);
      ctx.events.length = 0;
      // Each picks in slot order, seeing the chases of the slots before it.
      for (let s = 0; s < ds.count; s++) {
        want.push(pickOuter(ctx, s)?.id ?? null);
        nearest.push(pickNearest(ctx, s)?.id ?? null);
        const t = pickOuter(ctx, s);
        if (t !== null) dashing(ctx, s, t);
      }
      for (let s = 0; s < ds.count; s++) {
        ds.mode[s] = DRONE_HOVER;
        ds.target[s] = null;
        ds.targetId[s] = -1;
      }
      stepDrones(ctx);
      expect(Array.from(ds.targetId.subarray(0, ds.count)), `fixture ${f}`).toEqual(
        want.map((id) => id ?? -1),
      );
      if (want.some((id, s) => id !== nearest[s])) differs++;
      picked += want.filter((id) => id !== null).length;
    }
    expect(differs).toBeGreaterThan(50);
    expect(picked).toBeGreaterThan(150);
  });
});

describe('timed rows: their impact (K7)', () => {
  it('is an attack of its own: no PRIMARY, no counted attack, no nthAttack, no droneImpact and no center event; its target counted in the chain budget', () => {
    const flags: number[] = [];
    let centerEvents = 0;
    let attacks = 0;
    const hooks: TestModule = (b) => {
      b.hook('onHit', (_ctx, hit) => void flags.push(hit.flags));
      b.hook('onCenterEvent', () => void centerEvents++);
      b.hook('onAttack', () => void attacks++);
    };
    const ctx = fixture([nearR(0, 0), nearR(20, 0), nearR(0, 30)], {
      triggers: [
        { on: 'hit', when: [{ hitIs: 'primary' }], do: [HEAL] },
        { on: 'hit', when: [{ hitIs: 'signature' }], do: [HEAL] },
        { on: 'nthAttack', every: 1, do: [HEAL] },
        { on: 'droneImpact', do: [HEAL] },
      ],
      modules: [hooks],
    });
    spawn(ctx);
    const serial = ctx.attackSerial;
    const events = next(ctx);
    expect(hitIds(events)).toEqual([1, 2, 3]);
    expect(impacts(events).map((e) => [e.droneId, e.targetId, e.count, e.radius])).toEqual([
      [1, 1, 3, 40],
    ]);
    expect(flags).toHaveLength(3);
    for (const f of flags) expect(f & (PRIMARY | SIGNATURE)).toBe(0);
    expect(ctx.effectQueue.size).toBe(0);
    const em = ctx.emitters[0];
    expect([em?.attacks, em?.shots]).toEqual([0, 0]);
    const nth = triggerOf(ctx, EVENT.nthAttack);
    expect(ctx.triggerState.count[nth]).toBe(0);
    expect([centerEvents, attacks]).toEqual([0, 0]);
    expect(ctx.attackSerial).toBe(serial + 1);
    expect(ctx.chainBudget.hits).toBe(1);
    // The same hits fire a hit trigger that asks for a non-crit.
    const control = fixture([nearR(0, 0), nearR(20, 0), nearR(0, 30)], {
      triggers: [{ on: 'hit', when: [{ hitIs: 'nonCrit' }], do: [HEAL] }],
    });
    spawn(control);
    next(control);
    expect(control.effectQueue.size).toBe(3);
  });

  it('fires none of the signature’s waiting repeats: they wait for its next own attack', () => {
    const ctx = fixture([nearR(0, 0), at(-700, 0)], {
      triggers: [
        {
          on: 'heroHit',
          do: [{ kind: 'repeatAttack', count: 2, damagePct: 1, timing: 'nextAttack' }],
        },
      ],
    });
    const entry = createEffectEntry();
    entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === 'repeatAttack');
    entry.depth = 1;
    entry.origin = 0;
    entry.flags = SIGNATURE | HIT_EVENT;
    runEffect(ctx, entry);
    expect(ctx.sys.repeat.charges.count).toBe(2);
    spawn(ctx);
    const events = next(ctx);
    expect(impacts(events).map((e) => [e.droneId, e.targetId])).toEqual([[1, 1]]);
    expect(ctx.sys.repeat.charges.count).toBe(2);
    expect(ctx.projectiles).toHaveLength(0);
  });

  it('hits every alive enemy within its splash of the target once, in id order, at damagePct of the damage stat; at damagePct 0 none, though it impacts', () => {
    const placed = [nearR(0, 0), nearR(39, 0), nearR(0, -41), nearR(-20, 20)];
    const ctx = fixture(placed, { spawns: [{ damagePct: 0.5, splash: 40 }] });
    spawn(ctx);
    const events = next(ctx);
    expect(eventsOf([events], 'hit').map((h) => [h.targetId, toNumber(h.amount)])).toEqual([
      [1, 5],
      [2, 5],
      [4, 5],
    ]);
    expect(impacts(events).map((e) => [e.count, e.radius])).toEqual([[3, 40]]);
    const none = fixture(placed, { spawns: [{ damagePct: 0, ailment: 'poison' }] });
    spawn(none);
    const quiet = next(none);
    expect(hitIds(quiet)).toEqual([]);
    expect(impacts(quiet).map((e) => [e.droneId, e.count])).toEqual([[1, 3]]);
    expect(expires(quiet).map((e) => e.cause)).toEqual(['spent']);
    // A smaller splash lists fewer.
    const small = fixture(placed, { spawns: [{ splash: 30 }] });
    spawn(small);
    expect(hitIds(next(small))).toEqual([1, 4]);
  });

  it('gives each enemy it listed that is still alive its ailment’s stacks after the impact, at the row’s depth, crediting the effect; a dead one takes none', () => {
    // 1 its target, 2 killed by its hit, 3 alive within its splash, 4 outside it.
    const placed = [nearR(0, 0), nearR(20, 0, { hp: 1 }), nearR(0, 30), nearR(100, 0)];
    const ctx = fixture(placed, { spawns: [{ ailment: 'burn', ailmentStacks: 3 }] });
    spawn(ctx, 0, R, 2);
    const events = next(ctx);
    expect(events.map((e) => e.type).filter((t) => t !== 'enemyKilled')).toEqual([
      'hit',
      'hit',
      'hit',
      'impact',
      ...Array<string>(6).fill('ignite'),
      'droneExpire',
    ]);
    // A stack at a time, each its own ignite.
    expect(eventsOf([events], 'ignite').map((e) => [e.targetId, e.stacks])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [3, 1],
      [3, 2],
      [3, 3],
    ]);
    const now = ctx.now;
    expect([1, 2, 3, 4].map((id) => liveBurnStacks(enemy(ctx, id), now))).toEqual([3, 0, 3, 0]);
    expect(enemy(ctx, 2).alive).toBe(false);
    expect(enemy(ctx, 2).burns).toEqual([]);
    for (const id of [1, 3]) {
      expect(enemy(ctx, id).burns.map((b) => b.depth)).toEqual([2, 2, 2]);
    }
    // Its damage is the damage stat × ailmentDamagePct, as an applyAilment of that damagePct's.
    const half = fixture(placed, {
      spawns: [{ ailment: 'burn', ailmentStacks: 3, ailmentDamagePct: 0.5 }],
    });
    spawn(half, 0, R, 2);
    next(half);
    const dps = (c: RunContext): number => {
      const burn = enemy(c, 1).burns[0];
      return burn === undefined ? NaN : toNumber(burn.dps);
    };
    expect(dps(half) / dps(ctx)).toBeCloseTo(0.5, 12);
    expect(enemy(half, 1).burns[0]?.source).toBe(enemy(ctx, 1).burns[0]?.source);
  });

  it('hits and applies at the depth and origin of the effect that spawned it, and raises droneExpire there, at its position with no target', () => {
    const hits: [number, number][] = [];
    const hooks: TestModule = (b) =>
      void b.hook('onHit', (_ctx, hit) => hits.push([hit.depth, hit.origin]));
    const make = (): RunContext =>
      fixture([nearR(25, 0)], {
        triggers: [
          { on: 'droneExpire', do: [HEAL] },
          { on: 'droneExpire', do: [HEAL] },
        ],
        modules: [hooks],
      });
    const ctx = make();
    const [x0, x1] = [triggerOf(ctx, EVENT.droneExpire, 0), triggerOf(ctx, EVENT.droneExpire, 1)];
    const heal = (i: number): number =>
      (ctx.build.triggers[i] as { effectStart: number }).effectStart;
    spawn(ctx, 0, R, 1, x0);
    next(ctx);
    expect(hits).toEqual([[1, x0]]);
    // Its trigger is its origin, so only the other one fires (rule 3), one depth further.
    expect(queued(ctx)).toEqual([
      { effect: heal(x1), depth: 2, origin: x1, x: R.x + 25, y: R.y, target: -1 },
    ]);
    const other = make();
    spawn(other, 0, R, 2, x1);
    hits.length = 0;
    next(other);
    expect(hits).toEqual([[2, x1]]);
    expect(queued(other).map((e) => [e.origin, e.depth])).toEqual([[x0, 3]]);
    const none = make();
    spawn(none, 0, R, 1, -1);
    next(none);
    expect(queued(none).map((e) => [e.origin, e.depth])).toEqual([
      [x0, 2],
      [x1, 2],
    ]);
  });

  it('stops a droneExpire → spawnDrone chain at the depth cap, two triggers spawning each other’s rows', () => {
    const ctx = fixture([], {
      spawns: [],
      triggers: [
        { on: 'droneExpire', do: [spawnSpec({ lifeSec: 1 / 60 })] },
        { on: 'droneExpire', do: [spawnSpec({ lifeSec: 1 / 60 })] },
      ],
    });
    const ds = ctx.sys.drones;
    const [u1, u2] = [triggerOf(ctx, EVENT.droneExpire, 0), triggerOf(ctx, EVENT.droneExpire, 1)];
    spawn(ctx, 0, PLAYER, 1, -1);
    const rows = new Map<number, [number, number]>([[1, [1, -1]]]);
    const left: number[] = [];
    for (let t = 0; t < 10; t++) {
      left.push(...expires(nextWithEffects(ctx)).map((e) => e.droneId));
      for (let s = 0; s < ds.count; s++) {
        rows.set(ds.id[s] as number, [ds.depth[s] as number, ds.origin[s] as number]);
      }
    }
    expect(MAX_DEPTH).toBe(3);
    expect([...rows]).toEqual([
      [1, [1, -1]],
      [2, [2, u1]],
      [3, [2, u2]],
      [4, [3, u2]],
      [5, [3, u1]],
    ]);
    expect(left).toEqual([1, 2, 3, 4, 5]);
    expect(ctx.counters.triggerDepthCapped).toBe(2);
    expect([ds.count, ctx.effectQueue.size]).toEqual([0, 0]);
  });

  it('rolls its hits on the effects stream, one draw a hit at crit chance 0.5, and nothing on the combat stream', () => {
    const ctx = fixture([nearR(0, 0), nearR(20, 0), nearR(0, 30)], { values: { critChance: 0.5 } });
    spawn(ctx);
    const before = rngPositions(ctx);
    const events = next(ctx);
    expect(hitIds(events)).toEqual([1, 2, 3]);
    const after = rngPositions(ctx);
    expect({ ...after, effects: before.effects }).toEqual(before);
    const twin = createStreams(1).effects;
    for (let n = 0; String(twin.snapshot()) !== String(before.effects); n++) {
      if (n > 10_000) throw new Error('the twin never meets the effects stream');
      twin.next();
    }
    for (let n = 0; n < 3; n++) twin.next();
    expect(after.effects).toEqual(twin.snapshot());
  });
});

describe('timed rows: compaction (K7)', () => {
  it('drops the rows that left at the stage’s end, each other row moving down in id order with every per-slot array, its memory and target among them', () => {
    const ctx = fixture([nearR(0, 0), nearR(300, 0)], {
      grants: [on('outer.summon', drone(2))],
      values: { attackSpeed: 0 },
      spawns: [{}, { lifeSec: 2 / 60 }],
    });
    const ds = ctx.sys.drones;
    spawn(ctx, 1); // slot 2, id 3: leaves
    spawn(ctx, 0, { x: 100, y: 200 }, 2, 7); // slot 3, id 4
    spawn(ctx, 1); // slot 4, id 5: leaves
    spawn(ctx, 0, { x: 300, y: 400 }, 1, 3); // slot 5, id 6
    // Every array of the kept rows holds something of its own (at m = 0 nothing reads it).
    for (const [s, k] of [
      [3, 1],
      [5, 2],
    ] as const) {
      dashing(ctx, s, enemy(ctx, k));
      ds.prevX[s] = ds.x[s] as number;
      ds.prevY[s] = ds.y[s] as number;
      ds.dockX[s] = 11 * k;
      ds.dockY[s] = 13 * k;
      ds.nextPick[s] = 900 + k;
      ds.impactsLeft[s] = 40 + k;
      ds.dockLeft[s] = 0.5 * k;
      ds.acc[s] = 0.25 * k;
      ds.roleDamage[s] = 2 + k;
      ds.roleSpeed[s] = 0.5 * k;
      ds.size[s] = 1 + 0.25 * k;
      for (let j = 0; j < DRONE_MEMORY; j++) {
        ds.memId[s * DRONE_MEMORY + j] = 10 * k + j;
        ds.memUntil[s * DRONE_MEMORY + j] = 1000 * k + j;
      }
    }
    const fixed = [0, 1].map((s) => rowOf(ds, s));
    const kept = [3, 5].map((s) => rowOf(ds, s));
    next(ctx);
    const events = next(ctx);
    expect(expires(events).map((e) => e.droneId)).toEqual([3, 5]);
    expect(ds.count).toBe(4);
    expect([0, 1].map((s) => rowOf(ds, s))).toEqual(fixed);
    expect([2, 3].map((s) => rowOf(ds, s))).toEqual(kept);
    // The slots past the rows hold no enemy.
    expect(ds.target.slice(4)).toEqual(Array<null>(SUMMON_CAP - 4).fill(null));
    expect(ctx.state.droneCount).toBe(4);
    // The next spawn appends after them.
    spawn(ctx);
    expect(liveIds(ds)).toEqual([1, 2, 4, 6, 7]);
  });

  it('does no compaction in a stage where nothing left: every slot as it was', () => {
    const ctx = fixture([], { values: { attackSpeed: 0 }, spawns: [{ count: 3 }] });
    const ds = ctx.sys.drones;
    spawn(ctx);
    const before = [0, 1, 2].map((s) => rowOf(ds, s));
    next(ctx);
    expect([0, 1, 2].map((s) => rowOf(ds, s))).toEqual(before);
    expect(ds.left).toBe(0);
  });
});

describe('timed rows: fixed rows never leave', () => {
  it.each([false, true])(
    'keeps every fixed drone and turret and raises no droneExpire for one in a 1,200-tick run (spawnDrone in the build: %s)',
    (withSpawn) => {
      const triggers: TriggerSpec[] = [
        { on: 'droneExpire', do: [HEAL] },
        ...(withSpawn ? [{ on: 'kill', do: [spawnSpec({ impacts: 2 })] } as TriggerSpec] : []),
      ];
      const config = makeConfig({
        seed: 3,
        startWave: 12,
        maxTicks: 1200,
        stats: makeStats({ ...NO_ROLLS, maxLife: 1e12 }, [], {
          triggers: triggers.map((spec) => ({ source: 'outer.summon', spec })),
          conversions: [],
          emitters: [on('outer.summon', drone(3, { turrets: 1 }))],
        }),
      });
      const sim = createSimulation(config, makeTestData());
      const ds = sim.state.drones as DronePool;
      const expired: ExpireEvent[] = [];
      let impactsOfFixed = 0;
      while (!sim.state.finished) {
        const events = sim.step(NO_INPUT);
        expired.push(...expires(events));
        impactsOfFixed += impacts(events).filter((e) => e.droneId <= 4).length;
        expect(Array.from(ds.id.subarray(0, 4))).toEqual([1, 2, 3, 4]);
      }
      expect(impactsOfFixed).toBeGreaterThan(20);
      expect(expired.filter((e) => e.droneId <= 4)).toEqual([]);
      expect(Array.from(ds.until.subarray(0, 4))).toEqual(Array<number>(4).fill(NEVER_LEAVES));
      if (withSpawn) expect(expired.length).toBeGreaterThan(10);
      else expect([expired.length, ds.rows]).toEqual([0, 4]);
    },
  );
});

describe('timed rows in a run', () => {
  /** A run without enemies whose periodic trigger spawns a row every second at the player. */
  function periodicRun(
    fields: Partial<SpawnDroneSpec>,
    maxTicks: number,
  ): ReturnType<typeof createSimulation> {
    const config = makeConfig({
      maxTicks,
      stats: makeStats({ ...NO_ROLLS, maxLife: 1e12 }, [], {
        triggers: [
          { source: 'outer.summon', spec: { on: 'periodic', every: 1, do: [spawnSpec(fields)] } },
        ],
        conversions: [],
        emitters: [],
      }),
    });
    return createSimulation(config, noEnemies());
  }

  it('first steps in the drone stage of the tick after its spawn, the effect phase that spawned it running after that tick’s stage', () => {
    const sim = periodicRun({}, 200);
    const ds = sim.state.drones as DronePool;
    while (ds.count === 0 && !sim.state.finished) sim.step(NO_INPUT);
    const born = sim.state.tick;
    expect(born).toBeGreaterThan(1);
    expect([ds.count, ds.mode[0], ds.nextPick[0], ds.x[0], ds.y[0], ds.until[0]]).toEqual([
      1,
      DRONE_HOVER,
      born,
      sim.state.player.x,
      sim.state.player.y,
      born + LIFE_4S,
    ]);
    sim.step(NO_INPUT);
    // Its first pick, which found nothing: its clock moved on that tick.
    expect([ds.mode[0], ds.nextPick[0]]).toEqual([DRONE_HOVER, born + 1 + PICK_TICKS]);
  });

  it('steps again once the pool has emptied and filled again: each row leaves on time', () => {
    const sim = periodicRun({ lifeSec: 0.25 }, 400);
    const ds = sim.state.drones as DronePool;
    const left: number[] = [];
    const counts: number[] = [];
    let born = -1;
    while (!sim.state.finished) {
      if (expires(sim.step(NO_INPUT)).length > 0) left.push(sim.state.tick);
      if (born < 0 && ds.count > 0) born = sim.state.tick;
      counts.push(ds.count);
    }
    // A row a second from its first, each leaving 15 ticks after it came.
    expect(born).toBeGreaterThan(1);
    expect(left).toEqual([0, 1, 2, 3, 4, 5].map((k) => born + 60 * k + 15));
    // Empty between the rows: 15 ticks of one row a second.
    expect(counts.filter((c) => c === 1)).toHaveLength(6 * 15);
    expect(counts.filter((c) => c > 1)).toEqual([]);
  });
});

describe('timed rows: review cases', () => {
  it('never leaves by time when its life passes what an Int32 holds: its until is NEVER_LEAVES', () => {
    // 4e7 s is 2.4e9 ticks, past 2^31 − 1: unclamped, the Int32 slot would wrap below now.
    const ctx = fixture([], { spawns: [{ lifeSec: 4e7 }] });
    const ds = ctx.sys.drones;
    for (let k = 0; k < 5; k++) next(ctx);
    spawn(ctx);
    expect([ds.count, ds.until[0]]).toEqual([1, NEVER_LEAVES]);
    for (let k = 0; k < 3; k++) expect(expires(next(ctx))).toEqual([]);
    expect([ds.count, specsOf(ctx).live[specOf(ctx)]]).toEqual([1, 1]);
  });

  it('keeps maxLive per compiled effect: two spawnDrones of one trigger each hold their own', () => {
    const ctx = fixture([], {
      triggers: [
        { on: 'heroHit', do: [spawnSpec({ maxLive: 1 }), spawnSpec({ maxLive: 1, lifeSec: 2 })] },
      ],
      spawns: [],
    });
    const origin = triggerOf(ctx, EVENT.heroHit);
    const ds = ctx.sys.drones;
    spawn(ctx, 0, R, 1, origin);
    spawn(ctx, 0, R, 1, origin);
    spawn(ctx, 1, R, 1, origin);
    expect([ds.count, ctx.counters.summonCapped]).toEqual([2, 1]);
    expect(Array.from(ds.spec.subarray(0, 2))).toEqual([specOf(ctx, 0), specOf(ctx, 1)]);
  });

  it('steps by attackSpeed / 4 alone: an emitter’s cadence (a 冰霜 elite’s slow, the combo’s factor) does not reach it', () => {
    const ctx = fixture([at(900, 0)]);
    expect(ctx.emitters.length).toBeGreaterThan(0);
    for (const em of ctx.emitters) em.cadence = 0.5;
    const ds = ctx.sys.drones;
    spawn(ctx, 0, PLAYER);
    next(ctx);
    expect([ds.mode[0], ds.x[0]]).toEqual([DRONE_DASH, PLAYER.x + STEP]);
    next(ctx);
    expect(ds.x[0]).toBe(PLAYER.x + 2 * STEP);
  });

  it('sizes the pool and spawns for a spawnDrone a rule module added (addEffect), as for a trigger’s', () => {
    const added: TestModule = (b) => void b.addEffect('outer.summon', spawnSpec());
    const ctx = fixture([nearR(25, 0)], { spawns: [], modules: [added] });
    expect(ctx.build.triggers.some((t) => t.on === EVENT.heroHit)).toBe(false);
    expect(ctx.build.flags.spawnsDrones).toBe(true);
    const ds = ctx.sys.drones;
    expect([ds.rows, ds.specs === null]).toEqual([SUMMON_CAP, false]);
    spawn(ctx);
    expect([ds.count, ds.kind[0]]).toEqual([1, DRONE_KIND_SPIRIT]);
    expect(next(ctx).map((e) => e.type)).toEqual(['hit', 'impact', 'droneExpire']);
  });

  it('applies, raises and fires nothing for its ailment term in a build without that ailment’s duration, as a zone’s term', () => {
    const placed = [nearR(0, 0), nearR(20, 0)];
    const ctx = fixture(placed, {
      values: { burnDuration: 0 },
      triggers: [{ on: 'ailmentApplied', when: [{ ailment: 'burn' }], do: [HEAL] }],
      spawns: [{ ailment: 'burn', ailmentStacks: 3 }],
    });
    expect(ctx.burnTicks).toBe(0);
    spawn(ctx);
    const events = next(ctx);
    expect(events.map((e) => e.type)).toEqual(['hit', 'hit', 'impact', 'droneExpire']);
    expect([enemy(ctx, 1).burns, enemy(ctx, 2).burns]).toEqual([[], []]);
    expect(queued(ctx)).toEqual([]);
  });

  it('loses a target its own impact killed on that tick: it hovers there until its clock allows, then picks at the loss', () => {
    // 1 dies to the impact (hp 1, damage 10); 2 stands 400 left of R.
    const ctx = fixture([nearR(25, 0, { hp: 1 }), nearR(-400, 0)], { spawns: [{ impacts: 3 }] });
    const ds = ctx.sys.drones;
    spawn(ctx);
    const events = next(ctx);
    expect(impacts(events).map((e) => e.targetId)).toEqual([1]);
    expect(enemy(ctx, 1).alive).toBe(false);
    expect([ds.mode[0], ds.targetId[0], ds.target[0], ds.impactsLeft[0]]).toEqual([
      DRONE_HOVER,
      -1,
      null,
      2,
    ]);
    // Past its clock: 1 is PICK_TICKS of steps away, so the kill comes when it may pick again.
    const far = 25 + STEP * PICK_TICKS;
    const late = fixture([nearR(far, 0, { hp: 1 }), nearR(-400, 0)], { spawns: [{ impacts: 3 }] });
    const dl = late.sys.drones;
    spawn(late);
    let tick = -1;
    while (tick < 0 && late.now < 200) {
      if (impacts(next(late)).length > 0) tick = late.now;
    }
    expect(enemy(late, 1).alive).toBe(false);
    expect([dl.mode[0], dl.targetId[0], dl.x[0], dl.nextPick[0]]).toEqual([
      DRONE_DASH,
      2,
      R.x + far,
      tick + PICK_TICKS,
    ]);
  });

  it('at damagePct 0 gives its ailment to every alive enemy it listed, hitting none', () => {
    const placed = [nearR(0, 0), nearR(39, 0), nearR(0, -41), nearR(-20, 20)];
    const ctx = fixture(placed, {
      spawns: [{ damagePct: 0, splash: 40, ailment: 'burn', ailmentStacks: 2 }],
    });
    spawn(ctx);
    const events = next(ctx);
    expect(hitIds(events)).toEqual([]);
    expect(eventsOf([events], 'ignite').map((e) => [e.targetId, e.stacks])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
      [4, 1],
      [4, 2],
    ]);
    const now = ctx.now;
    expect([1, 2, 3, 4].map((id) => liveBurnStacks(enemy(ctx, id), now))).toEqual([2, 2, 0, 2]);
  });

  it('counts the burns of a row of damagePct 0 among the build’s burn credits, a fusion’s beside the signature’s, as one that hits', () => {
    const mixed = (fields: Partial<SpawnDroneSpec>): [number, boolean] => {
      const ctx = placedEnemies([], {
        stats: makeStats(NO_ROLLS, [], {
          triggers: [{ source: 'fusion.fire.summon', spec: holder(fields) }],
          conversions: [],
          emitters: [],
        }),
      });
      return [ctx.burnCredit, ctx.burnMixed];
    };
    expect(mixed({ damagePct: 0, ailment: 'poison' })).toEqual([0, false]);
    expect(mixed({ damagePct: 1, ailment: 'burn' })).toEqual([0, true]);
    expect(mixed({ damagePct: 0, ailment: 'burn' })).toEqual([0, true]);
  });
});
