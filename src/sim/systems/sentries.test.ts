/**
 * E8's seated rows (lead rulings T2-T8): a spawnDrone with `seat` and `fires` appends sentries
 * (DRONE_KIND_SENTRY), timed rows that stand where they appeared and fire their effect's fire,
 * compiled once with the row. These tests pin their placement and life, their fire clock, their
 * pick, the fire's entry, origin, depth and start, its tags, the caps and the segments, the
 * compaction of their clock, and a run's determinism. Most run the drone stage alone on placed
 * enemies, a tick at a time, and read the effect queue it fills; a few run the effect phase too.
 * Each test names in a comment the planted bug it kills.
 */

import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import type { SegmentGrant, SourcedEmitter } from '../../data/emitters';
import type { Modifier, StatId } from '../../data/stats';
import { SUMMON } from '../../data/outer/summon';
import { TAG } from '../../data/tags';
import type {
  ChainBoltSpec,
  ProjectilesSpec,
  SeatedFireSpec,
  SpawnDroneFires,
  SpawnDroneSpec,
  TriggerSpec,
} from '../../data/triggers';
import type { BuildFlags } from '../build/compile';
import { SUMMON_CAP } from '../caps';
import { runEffect, runEffectQueue } from '../effects/execute';
import { createEffectEntry, dequeue } from '../effects/queue';
import { MAX_DEPTH } from '../effects/types';
import type { CompiledEffect } from '../effects/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { eventsOf, makeConfig, makeStats, makeTestData, placedEnemies } from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_DASH,
  DRONE_FIXED,
  DRONE_KIND_SENTRY,
  DRONE_KIND_SPIRIT,
  NO_INPUT,
} from '../types';
import type { SimEvent } from '../types';
import type { Enemy, RunContext } from './context';
import { sentryPick, stepDrones } from './drones';
import { minionCount } from './globals';
import { rebuildGrid } from './grid';
import { moveProjectiles } from './projectiles';
import { stepSegments } from './segments';
import type { SpawnSpecs } from './systemState';

/** The player, at the arena's centre, and R, 300 right of it, where the rows stand. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const R = { x: PLAYER.x + 300, y: PLAYER.y };

/** An enemy (dx, dy) from R. */
const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: R.x + dx,
  y: R.y + dy,
  ...more,
});

/** Damage 10 and no crits or ignites unless `values` say so: the hits draw nothing. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
const SHOT: ProjectilesSpec = { kind: 'projectiles', count: 1, aim: 'target', damagePct: 1 };
const BOLT: ChainBoltSpec = { kind: 'chainBolt', jumps: 0, damagePct: 1 };

/** A seated row of 5 s firing `fire` every second, with `fields` and `fires` written over it. */
function seated(
  fire: SeatedFireSpec = SHOT,
  fields: Partial<SpawnDroneSpec> = {},
  fires: Partial<SpawnDroneFires> = {},
): SpawnDroneSpec {
  return {
    kind: 'spawnDrone',
    lifeSec: 5,
    damagePct: 0,
    seat: true,
    fires: { everySec: 1, do: fire, ...fires },
    ...fields,
  };
}

/** A test module writing `flags` over the build's. */
const policy =
  (flags: Partial<BuildFlags>): TestModule =>
  (b) =>
    void Object.assign(b.flags, flags);

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly scoped?: readonly Modifier[];
  readonly flags?: Partial<BuildFlags>;
  readonly grants?: readonly SourcedEmitter[];
  /** Triggers before the holders, so trigger 0 is the first of them. */
  readonly triggers?: readonly TriggerSpec[];
  readonly modules?: readonly TestModule[];
}

/**
 * placedEnemies over NO_ROLLS with one heroHit trigger (which never fires here) holding each of
 * `rows`, after `options.triggers`, all credited to outer.ice.
 */
function fixture(
  placed: readonly PlacedEnemy[],
  rows: readonly SpawnDroneSpec[] = [seated()],
  options: Options = {},
): RunContext {
  const holders = rows.map((row): TriggerSpec => ({ on: 'heroHit', do: [row] }));
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, options.scoped ?? [], {
      triggers: [...(options.triggers ?? []), ...holders].map((spec) => ({
        source: 'outer.ice',
        spec,
      })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    modules: [policy(options.flags ?? {}), ...(options.modules ?? [])],
  });
}

/** The compiled effect index of the build's n-th spawnDrone effect. */
function rowOf(ctx: RunContext, n = 0): number {
  const found = ctx.build.effects.flatMap((fx, i) => (fx.kind === 'spawnDrone' ? [i] : []));
  const f = found[n];
  if (f === undefined) throw new Error(`no spawnDrone effect ${n}`);
  return f;
}

/** The index of the n-th spawnDrone effect's fire. */
const fireOf = (ctx: RunContext, n = 0): number =>
  (ctx.build.effects[rowOf(ctx, n)] as CompiledEffect).fire;

/**
 * Runs the n-th row's spawnDrone effect now at `point`, as a trigger's effect at `depth` from
 * trigger `origin` would run in the effect phase.
 */
function spawn(
  ctx: RunContext,
  n = 0,
  point: { readonly x: number; readonly y: number } = R,
  depth = 1,
  origin = -1,
): void {
  const entry = createEffectEntry();
  entry.effect = rowOf(ctx, n);
  entry.depth = depth;
  entry.origin = origin;
  entry.x = point.x;
  entry.y = point.y;
  runEffect(ctx, entry);
}

/** The next tick's drone stage, the enemies standing where they are; returns its events. */
function next(ctx: RunContext): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  rebuildGrid(ctx);
  ctx.events.length = 0;
  stepDrones(ctx);
  return ctx.events.slice();
}

interface Queued {
  readonly effect: number;
  readonly depth: number;
  readonly origin: number;
  readonly source: number;
  readonly target: number;
  readonly x: number;
  readonly y: number;
  readonly value: number;
  readonly flags: number;
}

/** The effect queue's entries, oldest first, without taking them. */
function queued(ctx: RunContext): Queued[] {
  const q = ctx.effectQueue;
  return Array.from({ length: q.size }, (_, n) => {
    const i = (q.head + n) & q.capMask;
    return {
      effect: q.effect[i] as number,
      depth: q.depth[i] as number,
      origin: q.origin[i] as number,
      source: q.source[i] as number,
      target: q.target[i]?.id ?? -1,
      x: q.x[i] as number,
      y: q.y[i] as number,
      value: q.value[i] as number,
      flags: q.flags[i] as number,
    };
  });
}

/** Takes every queued entry, running none; returns them. */
function drain(ctx: RunContext): Queued[] {
  const out = queued(ctx);
  const entry = createEffectEntry();
  while (ctx.effectQueue.size > 0) dequeue(ctx.effectQueue, entry);
  return out;
}

/**
 * Runs `ticks` drone stages from the last spawn, taking the queue after each; returns the
 * stages (1 the first after the spawn) on which the n-th row's fire was queued, once each, and
 * fails on a stage that queued it twice. `before(stage)` runs before each stage.
 */
function fireStages(
  ctx: RunContext,
  ticks: number,
  n = 0,
  before: (stage: number) => void = () => undefined,
): number[] {
  const born = ctx.now;
  const fire = fireOf(ctx, n);
  const stages: number[] = [];
  for (let k = 1; k <= ticks; k++) {
    before(k);
    next(ctx);
    const fired = drain(ctx).filter((e) => e.effect === fire).length;
    expect(fired, `stage ${k}`).toBeLessThanOrEqual(1);
    if (fired === 1) stages.push(ctx.now - born);
  }
  return stages;
}

/** Writes the attack speed the drone stage reads (m = attackSpeed / 4). */
const setAttackSpeed = (ctx: RunContext, value: number): void =>
  void ((ctx.build.values as Record<StatId, number>).attackSpeed = value);
const setFlags = (ctx: RunContext, flags: Partial<BuildFlags>): void =>
  void Object.assign(ctx.build.flags as BuildFlags, flags);
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const specsOf = (ctx: RunContext): SpawnSpecs => ctx.sys.drones.specs as SpawnSpecs;
const live = (ctx: RunContext, n = 0): number => specsOf(ctx).live[rowOf(ctx, n)] as number;
/** The step every few: 1 + ceil(k × period / m) for k = 0, 1, … while below `life`. */
const expected = (period: number, m: number, life: number): number[] => {
  const out: number[] = [];
  for (let k = 0; ; k++) {
    const stage = 1 + Math.ceil((k * period) / m);
    if (stage >= life) return out;
    out.push(stage);
  }
};

describe('seated rows: compiled once with their row (T2)', () => {
  it('compiles fires.do into an entry of its own after its trigger’s effects, which stay one run, and fills the row’s tables', () => {
    // Planted bugs: the fire compiled inside the trigger's run (its effectEnd past it, so the
    // trigger queues the fire too); the row's fire index not written; the period or range table
    // wrong.
    const trigger: TriggerSpec = {
      on: 'hit',
      do: [
        { kind: 'heal', lifePct: 0.01 },
        seated(SHOT, {}, { everySec: 0.5, range: 250 }),
        { kind: 'heal', lifePct: 0.01 },
      ],
    };
    const ctx = fixture([], [seated(BOLT)], { triggers: [trigger] });
    expect(ctx.build.effects.map((fx) => [fx.kind, fx.fire])).toEqual([
      ['heal', -1],
      ['spawnDrone', 3],
      ['heal', -1],
      ['projectiles', -1],
      ['spawnDrone', 5],
      ['chainBolt', -1],
    ]);
    // Trigger 0 is SHATTER_TRIGGER's place.
    expect(ctx.build.triggers.slice(1).map((tr) => [tr.effectStart, tr.effectEnd])).toEqual([
      [0, 3],
      [4, 5],
    ]);
    const specs = specsOf(ctx);
    expect(Array.from(specs.fireEffect)).toEqual([-1, 3, -1, -1, 5, -1]);
    expect(Array.from(specs.fireTicks)).toEqual([0, 30, 0, 0, 60, 0]);
    expect(Array.from(specs.fireRangeSq)).toEqual([0, 62500, 0, 0, Infinity, 0]);
    // The fire's spec is its do, its source the row's.
    const fire = ctx.build.effects[3] as CompiledEffect;
    expect(fire.spec).toEqual(SHOT);
    expect(fire.source).toBe((ctx.build.effects[1] as CompiledEffect).source);
  });

  it('compiles a module’s seated row the same: addEffect returns the row, its fire right after it', () => {
    // Planted bug: addEffect returning the fire's index, or compiling no fire.
    let at = -1;
    const add: TestModule = (b) => {
      at = b.addEffect('outer.ice', seated(BOLT), 0.5);
    };
    const ctx = fixture([], [], { modules: [add] });
    const row = ctx.build.effects[at] as CompiledEffect;
    expect([row.kind, row.fire]).toEqual(['spawnDrone', at + 1]);
    const fire = ctx.build.effects[at + 1] as CompiledEffect;
    // The coefficient reaches the fire's COEF field.
    expect([fire.kind, fire.spec]).toEqual(['chainBolt', { ...BOLT, damagePct: 0.5 }]);
    expect(fire.source).toBe(row.source);
    expect(specsOf(ctx).fireEffect[at]).toBe(at + 1);
  });

  it('refuses at compile a module’s seated chainBolt whose bolts its start cannot take, in validation’s words (E7, R8)', () => {
    // Planted bug: a fire compiled past compileEffect's bolts check. A module's rows are not
    // validated, so the check runs on its fire as on any chainBolt (chainBoltBoltsIssues).
    const cases: [ChainBoltSpec, string][] = [
      [
        { ...BOLT, bolts: 2 },
        "chainBolt from 'eventTarget' starts on one enemy; bolts 2 needs from 'nearestToPoint' or 'nearestOther'",
      ],
      [{ ...BOLT, from: 'nearestOther', bolts: 4 }, 'bolts must be an integer in [1, 3] (got 4)'],
    ];
    for (const [bolt, issue] of cases) {
      const message = `A chainBolt effect ${JSON.stringify(bolt)}: ${issue}`;
      const viaEffect: TestModule = (b) => void b.addEffect('outer.lightning', seated(bolt));
      const viaTrigger: TestModule = (b) =>
        b.addTrigger('outer.lightning', { on: 'hit', do: [seated(bolt)] });
      expect(() => fixture([], [], { modules: [viaEffect] }), message).toThrow(message);
      expect(() => fixture([], [], { modules: [viaTrigger] }), message).toThrow(message);
    }
    const three: TestModule = (b) =>
      void b.addEffect('outer.lightning', seated({ ...BOLT, from: 'nearestToPoint', bolts: 3 }));
    expect(() => fixture([], [], { modules: [three] })).not.toThrow();
  });

  it('scales the fire by the trigger’s coefficient, as the row', () => {
    // Planted bug: compileFire not passing the coefficient.
    const ctx = placedEnemies([], {
      stats: makeStats(NO_ROLLS, [], {
        triggers: [
          {
            source: 'fusion.ice.fire',
            coef: 0.4,
            spec: { on: 'heroHit', do: [seated({ ...SHOT, damagePct: 2 })] },
          },
        ],
        conversions: [],
        emitters: [],
      }),
    });
    const fire = ctx.build.effects[fireOf(ctx)] as CompiledEffect;
    expect((fire.spec as ProjectilesSpec).damagePct).toBeCloseTo(0.8, 12);
  });

  it('tags the fire’s hits with its own tags, minion and its row’s tags and element: 冰晶哨’s minion, projectile and cold (A12)', () => {
    // Planted bugs: the fire's hits without minion; the row's tags or element dropped; the
    // row's element over the fire's own.
    const ctx = fixture(
      [],
      [
        seated(SHOT, { element: 'cold' }),
        seated({ ...SHOT, element: 'lightning' }, { element: 'cold', tags: ['area'] }),
        seated(BOLT, { element: 'cold' }),
        seated({ ...SHOT, tags: ['area'] }),
      ],
    );
    const tags = [0, 1, 2, 3].map((n) => ctx.effectPayloads[fireOf(ctx, n)]?.tags);
    const shot = TAG.hit | TAG.trigger | TAG.projectile | TAG.minion;
    expect(tags).toEqual([
      shot | TAG.cold,
      shot | TAG.lightning | TAG.area,
      TAG.hit | TAG.trigger | TAG.chain | TAG.lightning | TAG.minion,
      shot | TAG.area,
    ]);
    expect((ctx.build.effects[fireOf(ctx)] as CompiledEffect).tags).toBe(shot | TAG.cold);
  });

  it('lets minion-scoped damage reach the fire’s hits, and a turret-only flag none of them', () => {
    // Planted bugs: the fire's hits without minion; a turret policy reaching the sentries.
    const minion: Modifier = { stat: 'damage', kind: 'more', value: 1, tags: ['minion'] };
    const dealt = (scoped: readonly Modifier[], flags: Partial<BuildFlags>): number[] => {
      const ctx = fixture(
        [at(80, 0, { hp: 1e9 }), at(160, 0, { hp: 1e9 })],
        [seated({ ...BOLT, jumps: 1 })],
        { scoped, flags },
      );
      spawn(ctx);
      next(ctx);
      ctx.events.length = 0;
      runEffectQueue(ctx);
      return eventsOf([ctx.events], 'hit').map((e) => toNumber(e.amount));
    };
    const turrets = { turretSplash: 120, turretChains: 2, turretRateMult: 1 / 3 };
    expect(dealt([], {})).toEqual([10, 7]);
    expect(dealt([minion], {})).toEqual([20, 14]);
    expect(dealt([], turrets)).toEqual([10, 7]);
  });

  it('keeps 加農砲’s ×4 off the fire’s hits, while 砲座’s turret-scoped ranks reach them (A12)', () => {
    // Planted bug: 加農砲's damage scoped to every minion projectile, a sentry's shots included.
    const mods = (id: string): readonly Modifier[] => {
      const node = SUMMON.board.nodes.find((n) => n.id === `outer.summon.emplacement.${id}`);
      if (node === undefined) throw new Error(`no node ${id}`);
      return node.effects.modifiers;
    };
    const firstHit = (scoped: readonly Modifier[]): number[] => {
      const ctx = fixture([at(80, 0, { hp: 1e9 })], [seated(SHOT, { element: 'cold' })], {
        scoped,
      });
      spawn(ctx);
      for (let k = 0; k < 30; k++) {
        next(ctx);
        runEffectQueue(ctx);
        moveProjectiles(ctx);
        const hits = eventsOf([ctx.events], 'hit');
        if (hits.length > 0) return hits.map((e) => toNumber(e.amount));
      }
      return [];
    };
    expect(firstHit([])).toEqual([10]);
    expect(firstHit(mods('cannon'))).toEqual([10]);
    expect(firstHit(mods('r1'))).toEqual([11.5]);
  });
});

describe('seated rows: placement and life (T3)', () => {
  it('appends a sentry at the event’s point, unclamped, with the effect’s depth, origin and life, and keeps it there', () => {
    // Planted bugs: the row placed as a spirit (kind or mode); the point clamped to the arena;
    // the row moving (x, y, prevX or prevY written) or keeping a target.
    const ctx = fixture([at(60, 0), at(-2000, 0)]);
    const ds = ctx.sys.drones;
    const outside = { x: -40, y: ARENA_HEIGHT + 25 };
    spawn(ctx, 0, R, 2, 0);
    spawn(ctx, 0, outside, 1, -1);
    const born = ctx.now;
    expect(ds.count).toBe(2);
    const row = (s: number): unknown[] => [
      ds.kind[s],
      ds.mode[s],
      ds.x[s],
      ds.y[s],
      ds.owner[s],
      ds.seat[s],
      ds.targetId[s],
      ds.target[s] ?? null,
      ds.depth[s],
      ds.origin[s],
      ds.until[s],
    ];
    expect(row(0)).toEqual([
      DRONE_KIND_SENTRY,
      DRONE_FIXED,
      R.x,
      R.y,
      -1,
      -1,
      -1,
      null,
      2,
      0,
      born + 300,
    ]);
    expect(row(1)).toEqual([
      DRONE_KIND_SENTRY,
      DRONE_FIXED,
      outside.x,
      outside.y,
      -1,
      -1,
      -1,
      null,
      1,
      -1,
      born + 300,
    ]);
    for (let k = 0; k < 299; k++) {
      next(ctx);
      drain(ctx);
      for (const s of [0, 1]) {
        expect([ds.x[s], ds.y[s], ds.prevX[s], ds.prevY[s], ds.mode[s], ds.targetId[s]]).toEqual([
          s === 0 ? R.x : outside.x,
          s === 0 ? R.y : outside.y,
          s === 0 ? R.x : outside.x,
          s === 0 ? R.y : outside.y,
          DRONE_FIXED,
          -1,
        ]);
        expect(ds.target[s] ?? null).toBe(null);
      }
    }
    expect([ds.count, live(ctx)]).toEqual([2, 2]);
  });

  it('lives round(lifeSec × 60 × summonDuration) ticks, as a spirit, and counts as a minion', () => {
    // Planted bugs: the life not × summonDuration; minionCount leaving the sentries out.
    const ctx = fixture([at(60, 0)], [seated(), { kind: 'spawnDrone', lifeSec: 5, damagePct: 1 }], {
      values: { summonDuration: 1.5 },
    });
    spawn(ctx);
    spawn(ctx, 1);
    const ds = ctx.sys.drones;
    expect([ds.kind[0], ds.kind[1]]).toEqual([DRONE_KIND_SENTRY, DRONE_KIND_SPIRIT]);
    expect([ds.until[0], ds.until[1]]).toEqual([ctx.now + 450, ctx.now + 450]);
    expect(minionCount(ctx)).toBe(2);
    // Every second from its first stage while it lives: 8 fires in 450 ticks.
    expect(fireStages(ctx, 460)).toEqual([1, 61, 121, 181, 241, 301, 361, 421]);
    expect([ds.count, minionCount(ctx)]).toEqual([0, 0]);
  });

  it('leaves on time with droneExpire at its spot, freeing its maxLive place, and fires not on that stage (T4 e)', () => {
    // Planted bugs: the fire checked before the time; leaving not freeing maxLive.
    const ctx = fixture([at(60, 0)], [seated(SHOT, { lifeSec: 61 / 60, maxLive: 1 })]);
    const ds = ctx.sys.drones;
    spawn(ctx);
    spawn(ctx);
    expect([ds.count, live(ctx), ctx.counters.summonCapped]).toEqual([1, 1, 1]);
    const born = ctx.now;
    const fire = fireOf(ctx);
    const fires: number[] = [];
    const expires: unknown[] = [];
    for (let k = 1; k <= 61; k++) {
      const events = next(ctx);
      if (drain(ctx).some((e) => e.effect === fire)) fires.push(ctx.now - born);
      for (const e of eventsOf([events], 'droneExpire')) expires.push([ctx.now - born, e]);
    }
    // Due on its 61st stage, the one it leaves on: it leaves and does not fire.
    expect(fires).toEqual([1]);
    expect(expires).toEqual([
      [61, { type: 'droneExpire', droneId: 1, x: R.x, y: R.y, cause: 'time' }],
    ]);
    expect([ds.count, live(ctx)]).toEqual([0, 0]);
    spawn(ctx);
    expect([ds.count, live(ctx), ctx.counters.summonCapped]).toEqual([1, 1, 1]);
  });
});

describe('seated rows: the fire clock (T4)', () => {
  it('fires on its first stage and every period / m after: 5 fires at m 1, everySec 1 and lifeSec 5', () => {
    // Planted bugs: a first fire a period late; a period one tick off.
    const ctx = fixture([at(60, 0)]);
    spawn(ctx);
    expect(fireStages(ctx, 310)).toEqual([1, 61, 121, 181, 241]);
  });

  it('fires twice as often at twice the attack speed, and at a fraction of a tick’s period by its carried rest', () => {
    // Planted bugs: the clock not × m; the rest below 0 dropped (a fire every ceil(T / m)).
    const two = fixture([at(60, 0)], [seated()], { values: { attackSpeed: 8 } });
    spawn(two);
    expect(fireStages(two, 310)).toEqual(expected(60, 2, 300));
    expect(expected(60, 2, 300)).toHaveLength(10);
    const frac = fixture([at(60, 0)], [seated(SHOT, {}, { everySec: 50 / 60 })], {
      values: { attackSpeed: 3 },
    });
    spawn(frac);
    // m 0.75, T 50: 66.67 ticks apart, the rest carried: 1, 68, 135, 201, 268.
    expect(fireStages(frac, 310)).toEqual([1, 68, 135, 201, 268]);
    expect(expected(50, 0.75, 300)).toEqual([1, 68, 135, 201, 268]);
  });

  it('counts its period as round(everySec × 60) ticks: 0.51 s is 31, not 30.6', () => {
    // Planted bug: the period left unrounded, so the fires drift from the 4th on (93, not 94).
    const ctx = fixture([at(60, 0)], [seated(SHOT, {}, { everySec: 0.51 })]);
    expect(specsOf(ctx).fireTicks[rowOf(ctx)]).toBe(31);
    spawn(ctx);
    expect(fireStages(ctx, 310)).toEqual(expected(31, 1, 300));
    expect(expected(31, 1, 300)).toEqual([1, 32, 63, 94, 125, 156, 187, 218, 249, 280]);
  });

  it('fires once a stage at a very large m, its clock never below −m', () => {
    // Planted bug: the clock carrying its whole rest, so it sinks without bound.
    const m = 1e9;
    const ctx = fixture([at(60, 0)], [seated(SHOT, { lifeSec: 1 })], {
      values: { attackSpeed: 4 * m },
    });
    spawn(ctx);
    const ds = ctx.sys.drones;
    const lows: number[] = [];
    const stages = fireStages(ctx, 59, 0, () => lows.push(ds.fireLeft[0] as number));
    expect(stages).toEqual(Array.from({ length: 59 }, (_, k) => k + 1));
    expect(Math.min(...lows)).toBe(-m);
  });

  it('waits at 0 while due with no enemy, fires once on the stage it finds one, then a full period later (T4 c)', () => {
    // Planted bugs: a wait banked as fires (two at once), or as a shorter next period.
    const ctx = fixture([at(500, 0)], [seated(SHOT, {}, { range: 200 })]);
    const ds = ctx.sys.drones;
    spawn(ctx);
    const stages = fireStages(ctx, 300, 0, (stage) => {
      if (stage === 101) enemy(ctx, 1).x = R.x + 100;
      if (stage === 100) expect(ds.fireLeft[0]).toBe(0);
    });
    expect(stages).toEqual([101, 161, 221, 281]);
  });

  it('holds its clock at m 0 or NaN and fires nothing, still leaving on time (T4 d)', () => {
    // Planted bugs: the clock running down at m ≤ 0; a NaN m firing; the row kept past its time.
    for (const held of [0, NaN, -4]) {
      const ctx = fixture([at(60, 0)]);
      spawn(ctx);
      const stages = fireStages(ctx, 300, 0, (stage) => {
        if (stage === 31) setAttackSpeed(ctx, held);
        if (stage === 81) setAttackSpeed(ctx, 4);
      });
      // 29 ticks run down before the hold, 30 after it.
      expect(stages, String(held)).toEqual([1, 111, 171, 231, 291]);
      const still = fixture([at(60, 0)], [seated()], { values: { attackSpeed: held } });
      spawn(still);
      expect(fireStages(still, 299)).toEqual([]);
      expect(still.sys.drones.fireLeft[0]).toBe(0);
      expect(eventsOf([next(still)], 'droneExpire')).toHaveLength(1);
    }
  });
});

describe('seated rows: the pick (T5)', () => {
  it('fires at the alive enemy in the arena nearest to the row within its range, the lower id on ties', () => {
    // Planted bugs: the range ignored; a dead or out-of-arena enemy picked; ties to the higher
    // id; the distance from the player, not the row.
    const ctx = fixture([
      at(0, -100),
      at(0, 100),
      at(-150, 0),
      at(140, 0),
      at(30, 0),
      at(ARENA_WIDTH - R.x + 10, 0),
    ]);
    const pick = (r2: number, x = R.x, y = R.y): number | null =>
      sentryPick(ctx, x, y, r2)?.id ?? null;
    expect(pick(Infinity)).toBe(5);
    enemy(ctx, 5).alive = false;
    // 1 and 2 tie at 100: the lower id.
    expect(pick(Infinity)).toBe(1);
    expect(pick(99 * 99)).toBe(null);
    expect(pick(100 * 100)).toBe(1);
    // Enemy 6, just outside the arena's right edge, is nearest to a row at the edge, and skipped.
    expect(pick(Infinity, ARENA_WIDTH, R.y)).toBe(4);
    enemy(ctx, 1).alive = false;
    expect(pick(Infinity)).toBe(2);
    // The same through a fire: the queued entry's enemy.
    const fired = fixture(
      [at(0, 100), at(0, -100), at(250, 0)],
      [seated(SHOT, {}, { range: 120 })],
    );
    spawn(fired);
    next(fired);
    expect(drain(fired).map((e) => e.target)).toEqual([1]);
  });

  it('takes the highest hp within range under 集火指令, and the nearest tough one first under 鎖定信標', () => {
    // Planted bugs: either policy ignored; the policy's pick unbounded by the range; ties on hp
    // to the higher id; the tough tier after the ordinary one.
    const placed = [
      at(40, 0, { hp: 100 }),
      at(150, 0, { hp: 500 }),
      at(-150, 0, { hp: 500 }),
      at(400, 0, { hp: 9000 }),
      at(0, 120, { type: 'hexagon', hp: 50 }),
      at(0, -350, { type: 'boss', hp: 50 }),
    ];
    const ctx = fixture(placed);
    expect([enemy(ctx, 5).tough, enemy(ctx, 6).tough, enemy(ctx, 1).tough]).toEqual([
      true,
      true,
      false,
    ]);
    const pick = (r2: number): number | null => sentryPick(ctx, R.x, R.y, r2)?.id ?? null;
    setFlags(ctx, { summonHighestHp: true });
    expect([pick(Infinity), pick(200 * 200), pick(50 * 50), pick(30 * 30)]).toEqual([
      4,
      2,
      1,
      null,
    ]);
    // 集火指令 wins over 鎖定信標.
    setFlags(ctx, { summonHighestHp: true, summonEliteFirst: true });
    expect(pick(200 * 200)).toBe(2);
    setFlags(ctx, { summonHighestHp: false, summonEliteFirst: true });
    expect([pick(Infinity), pick(200 * 200), pick(100 * 100)]).toEqual([5, 5, 1]);
    enemy(ctx, 5).alive = false;
    expect([pick(Infinity), pick(200 * 200)]).toEqual([6, 1]);
  });

  it('breaks a tie among the tough to the lower id under 鎖定信標, as in the other tiers', () => {
    // Planted bug: the tough tier's ties to the higher id (<= in its scan).
    const ctx = fixture([
      at(0, 30),
      at(0, -90, { type: 'hexagon' }),
      at(0, 90, { type: 'hexagon' }),
      at(-90, 0, { type: 'hexagon' }),
    ]);
    setFlags(ctx, { summonEliteFirst: true });
    const pick = (): number | null => sentryPick(ctx, R.x, R.y, Infinity)?.id ?? null;
    expect([enemy(ctx, 1).tough, enemy(ctx, 2).tough, enemy(ctx, 3).tough]).toEqual([
      false,
      true,
      true,
    ]);
    expect(pick()).toBe(2);
    enemy(ctx, 2).alive = false;
    expect(pick()).toBe(3);
  });

  it('claims no enemy: a spirit’s nearest pick takes the enemy a sentry fires at', () => {
    // Planted bug: a sentry counted as chasing its target (mode DASH or a target kept).
    const ctx = fixture(
      [at(50, 0), at(150, 0)],
      [seated(), { kind: 'spawnDrone', lifeSec: 5, damagePct: 1, aim: 'nearest' }],
    );
    spawn(ctx);
    spawn(ctx, 1);
    next(ctx);
    const ds = ctx.sys.drones;
    expect(
      drain(ctx)
        .filter((e) => e.effect === fireOf(ctx))
        .map((e) => e.target),
    ).toEqual([1]);
    expect([ds.mode[0], ds.targetId[0], ds.target[0] ?? null]).toEqual([DRONE_FIXED, -1, null]);
    expect([ds.mode[1], ds.targetId[1]]).toEqual([DRONE_DASH, 1]);
  });
});

describe('seated rows: the fire (T6)', () => {
  it('queues its fire at the row’s depth and origin, the enemy its target and the row’s spot its point, value 0', () => {
    // Planted bugs: the fire at depth + 1 or 0; the origin dropped; the point the player's; the
    // source the row's trigger's, not the fire's.
    const ctx = fixture([at(80, 30)]);
    spawn(ctx, 0, R, 2, 0);
    spawn(ctx, 0, { x: R.x - 40, y: R.y }, 3, 1);
    next(ctx);
    const fire = fireOf(ctx);
    const source = (ctx.build.effects[fire] as CompiledEffect).source;
    expect(queued(ctx)).toEqual([
      { effect: fire, depth: 2, origin: 0, source, target: 1, x: R.x, y: R.y, value: 0, flags: 0 },
      {
        effect: fire,
        depth: 3,
        origin: 1,
        source,
        target: 1,
        x: R.x - 40,
        y: R.y,
        value: 0,
        flags: 0,
      },
    ]);
  });

  it('starts its projectiles at the row, a fan’s middle one at the enemy, at the row’s depth and origin', () => {
    // Planted bugs: the shots from the player; a fan aimed from the player at the enemy.
    const fan: ProjectilesSpec = {
      kind: 'projectiles',
      count: 3,
      aim: 'fan',
      spreadDeg: 40,
      damagePct: 1,
    };
    const ctx = fixture([at(100, 100)], [seated(fan), seated(SHOT)]);
    spawn(ctx, 0, R, 2, 0);
    spawn(ctx, 1, { x: R.x, y: R.y + 50 }, 1, -1);
    next(ctx);
    runEffectQueue(ctx);
    const shots = ctx.shots;
    expect(shots.count).toBe(4);
    const row = (s: number): unknown[] => [
      shots.x[s],
      shots.y[s],
      shots.depth[s],
      shots.origin[s],
      shots.owner[s],
    ];
    expect([0, 1, 2].map(row)).toEqual([0, 1, 2].map(() => [R.x, R.y, 2, 0, -1]));
    expect(row(3)).toEqual([R.x, R.y + 50, 1, -1, -1]);
    expect(shots.target[3]?.id).toBe(1);
    const angle = (s: number): number => Math.atan2(shots.vy[s] as number, shots.vx[s] as number);
    expect(angle(1)).toBeCloseTo(Math.PI / 4, 12);
    expect(angle(2) - angle(0)).toBeCloseTo((40 * Math.PI) / 180, 12);
  });

  it('starts a chainBolt at its target, or with nearestToPoint at the enemy nearest the row', () => {
    // Planted bug: the bolt's point the player's, or its first enemy not the row's pick.
    const placed = [at(60, 0, { hp: 100 }), at(-200, 0, { hp: 5000 }), at(-600, 0, { hp: 9000 })];
    const firstHit = (bolt: ChainBoltSpec): number | undefined => {
      const ctx = fixture(placed, [seated(bolt, {}, { range: 300 })], {
        flags: { summonHighestHp: true },
      });
      spawn(ctx);
      next(ctx);
      ctx.events.length = 0;
      runEffectQueue(ctx);
      return eventsOf([ctx.events], 'hit')[0]?.targetId;
    };
    expect(firstHit(BOLT)).toBe(2);
    expect(firstHit({ ...BOLT, from: 'eventTarget' })).toBe(2);
    expect(firstHit({ ...BOLT, from: 'nearestToPoint' })).toBe(1);
  });

  it('gives E7’s bolt fields its pick as the event’s enemy and its spot as the event’s point', () => {
    // Planted bugs: the pick not the entry's enemy, so 'nearestOther' takes it; the bolts or the
    // arc measured from the player. The pick is 2 (集火指令, the most hp within 300); 1 and 3 are
    // the nearest the row, 4 is past the chain range (260).
    const placed = [
      at(60, 0, { hp: 100 }),
      at(-200, 0, { hp: 5000 }),
      at(100, 100, { hp: 50 }),
      at(-600, 0, { hp: 9000 }),
    ];
    const hits = (bolt: ChainBoltSpec): unknown[] => {
      const ctx = fixture(placed, [seated(bolt, {}, { range: 300 })], {
        flags: { summonHighestHp: true },
      });
      spawn(ctx);
      next(ctx);
      ctx.events.length = 0;
      runEffectQueue(ctx);
      return eventsOf([ctx.events], 'hit').map((hit) => [
        hit.targetId,
        hit.chainIndex,
        hit.fromX,
        hit.fromY,
      ]);
    };
    const first = (id: number): unknown[] => [id, 0, null, null];
    expect(hits({ ...BOLT, from: 'nearestOther' })).toEqual([first(1)]);
    expect(hits({ ...BOLT, from: 'nearestOther', bolts: 3 })).toEqual([first(1), first(3)]);
    expect(hits({ ...BOLT, from: 'nearestToPoint', bolts: 3 })).toEqual([
      first(1),
      first(3),
      first(2),
    ]);
    expect(hits({ ...BOLT, from: 'nearestOther', arc: true })).toEqual([[1, 0, R.x, R.y]]);
    // With arc only the first hit starts at the row; its jump starts at the enemy before.
    expect(hits({ ...BOLT, jumps: 1, arc: true })).toEqual([
      [2, 0, R.x, R.y],
      [1, 1, R.x - 200, R.y],
    ]);
  });

  it('ends a shatter loop of two seated triggers at MAX_DEPTH: rows at depths 1 to 3 and no deeper', () => {
    // Planted bug: the fire at depth 0 (or the row's depth − 1), so the loop never ends.
    const sentry = seated(SHOT, { maxLive: 24, lifeSec: 2 }, { everySec: 0.25 });
    const stats = makeStats(
      { damage: 40, critChance: 0, igniteChance: 0, frostOnHit: 1, maxLife: 1e6, attackSpeed: 6 },
      [],
      {
        triggers: [
          { source: 'outer.ice', spec: { on: 'shatter', do: [sentry] } },
          { source: 'center', spec: { on: 'shatter', do: [sentry] } },
        ],
        conversions: [],
        emitters: [],
      },
    );
    let ctx: RunContext | null = null;
    const grab: TestModule = (b) =>
      void b.hook('tick', (c) => {
        ctx = c;
      });
    const sim = createSimulation(
      makeConfig({ stats, startWave: 12, maxTicks: 1200 }),
      makeTestData(),
      [grab],
    );
    const depths = new Set<number>();
    while (!sim.state.finished) {
      sim.step(NO_INPUT);
      const ds = (ctx as RunContext | null)?.sys.drones;
      if (ds === undefined) continue;
      for (let s = 0; s < ds.count; s++) {
        if (ds.kind[s] === DRONE_KIND_SENTRY) depths.add(ds.depth[s] as number);
      }
    }
    expect([...depths].sort()).toEqual([1, 2, MAX_DEPTH]);
    expect(sim.result().counters.triggerDepthCapped).toBeGreaterThan(0);
  });
});

describe('seated rows: caps and segments (T7)', () => {
  it('refuses the sentries past the summon cap, fixed rows counted, and past maxLive, counting them', () => {
    // Planted bug: the sentries left out of the summon cap or of maxLive.
    const grants: SourcedEmitter[] = [
      { source: 'outer.summon', grant: { kind: 'drone', drones: 3, turrets: 1 } },
    ];
    const ctx = fixture(
      [at(60, 0)],
      [seated(SHOT, { count: 30 }), seated(SHOT, { maxLive: 4, count: 6 })],
      {
        grants,
      },
    );
    const ds = ctx.sys.drones;
    expect(ds.count).toBe(4);
    spawn(ctx, 1);
    expect([ds.count, live(ctx, 1), ctx.counters.summonCapped]).toEqual([8, 4, 2]);
    spawn(ctx);
    expect([ds.count, live(ctx), ctx.counters.summonCapped]).toEqual([SUMMON_CAP, 16, 16]);
    // The drones' count multiplier never reaches a timed row.
    const many = fixture([], [seated(SHOT, { count: 2 })], { flags: { droneCountMult: 3 } });
    spawn(many);
    expect(many.sys.drones.count).toBe(2);
  });

  it('makes a sentry an endpoint of a summons segment and not of a drones one', () => {
    // Planted bug: the drones segment taking every timed row, or the summons one leaving them.
    const lines = (endpoints: SegmentGrant['endpoints']): number[][] => {
      const ctx = fixture([], [seated()], {
        values: { attackSpeed: 0 },
        grants: [
          { source: 'outer.summon', grant: { kind: 'drone', drones: 1 } },
          { source: 'outer.summon', grant: { kind: 'segment', endpoints, links: 1, range: 1000 } },
        ],
      });
      const ds = ctx.sys.drones;
      ds.x[0] = R.x - 100;
      ds.y[0] = R.y;
      spawn(ctx);
      for (const em of ctx.sys.segments.emitters) em.timer = em.interval - 1;
      stepSegments(ctx);
      const ln = ctx.state.segments.lines[0];
      if (ln === undefined) throw new Error('no lines');
      return Array.from({ length: ln.count }, (_, s) => [
        ln.x1[s] as number,
        ln.y1[s] as number,
        ln.x2[s] as number,
        ln.y2[s] as number,
      ]);
    };
    expect(lines('summons')).toEqual([[R.x - 100, R.y, R.x, R.y]]);
    expect(lines('drones')).toEqual([]);
  });
});

describe('seated rows: the pool', () => {
  it('carries a sentry’s clock when it moves down a slot (moveRow)', () => {
    // Planted bug: moveRow not carrying fireLeft.
    const ctx = fixture([at(60, 0)], [seated(SHOT, { lifeSec: 0.5 }), seated()]);
    spawn(ctx);
    for (let k = 0; k < 10; k++) {
      next(ctx);
      drain(ctx);
    }
    spawn(ctx, 1);
    // Row 0 leaves on its 30th stage, the 20th of row 1, which then moves to slot 0.
    const stages = fireStages(ctx, 200, 1);
    expect(stages).toEqual([1, 61, 121, 181]);
    expect(ctx.sys.drones.count).toBe(1);
  });

  it('starts a sentry’s clock at 0 in a slot that an older one left with its clock running', () => {
    // Planted bug: spawnRows not writing fireLeft, so a new row takes the slot's stale clock.
    const ctx = fixture([at(60, 0)], [seated(SHOT, { lifeSec: 10 / 60 }), seated()]);
    spawn(ctx);
    expect(fireStages(ctx, 10)).toEqual([1]);
    const ds = ctx.sys.drones;
    // Gone, its slot past the rows still holding its clock: 59 less 8 stages.
    expect([ds.count, ds.fireLeft[0]]).toEqual([0, 51]);
    spawn(ctx, 1);
    expect(fireStages(ctx, 70, 1)).toEqual([1, 61]);
  });

  it('runs the same twice for a build and seed: a periodic seated chainBolt and a shatter fan', () => {
    // Planted bug: a draw or a state the run does not own in the sentries' step.
    const stats = makeStats(
      { damage: 6, critChance: 0.2, frostOnHit: 0.5, maxLife: 1e6, attackSpeed: 6 },
      [],
      {
        triggers: [
          {
            source: 'outer.ice',
            spec: {
              on: 'shatter',
              when: [{ chance: 0.5 }],
              do: [seated({ kind: 'projectiles', count: 3, aim: 'fan', damagePct: 0.5 })],
            },
          },
          {
            source: 'outer.summon',
            spec: { on: 'periodic', every: 1, do: [seated({ ...BOLT, jumps: 2 }, { maxLive: 3 })] },
          },
        ],
        conversions: [],
        emitters: [],
      },
    );
    const run = (seed: number): string => {
      const sim = createSimulation(
        makeConfig({ stats, seed, startWave: 12, maxTicks: 600 }),
        makeTestData(),
      );
      const out: string[] = [];
      while (!sim.state.finished) out.push(JSON.stringify(sim.step(NO_INPUT)));
      out.push(JSON.stringify(sim.result().counters));
      return out.join('\n');
    };
    const once = run(1);
    expect(run(1)).toBe(once);
    expect(run(2)).not.toBe(once);
    expect(once).toContain('"cause":"time"');
  });
});
