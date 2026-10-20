/**
 * The drone pool and its stage (docs/v3 C5 design §4.1–§4.4, §4.7, §5, §9's C5.1 oracles):
 * droneLayout and createDronePool (src/sim/emitters/drone.ts, systemState.ts), and stepDrones,
 * pickOuter and impactAt (drones.ts). Most tests run the drone stage alone on placed enemies, a
 * tick at a time; the stage order and the long runs go through createSimulation.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { createRng, createStreams } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { DroneGrant, SegmentGrant, SourcedEmitter } from '../../data/emitters';
import type { StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { DRONE_COOLDOWN_MAX, DRONE_MEMORY, PICK_TICKS, SUMMON_CAP } from '../caps';
import { PRIMARY, SIGNATURE } from '../effects/flags';
import { EVENT } from '../effects/types';
import { droneLayout } from '../emitters/drone';
import { BASE_ATTACK_SPEED, shotsInFlight } from '../emitters/types';
import type { EmitterRuntime } from '../emitters/types';
import type { BuildCompiler, TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
  segDistSqRef,
  withinRef,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_DASH,
  DRONE_DOCKED,
  DRONE_HOVER,
  DRONE_KIND_DRONE,
  DRONE_RETURN,
  NO_INPUT,
  TICK_RATE,
} from '../types';
import type { SimEvent } from '../types';
import { createRunContext } from './context';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import { impactAt, pickOuter, stepDrones } from './drones';
import { EMITTER_STEPS, runEmitters } from './emitters';
import { rebuildGrid } from './grid';
import { moveEnemies } from './movement';
import { createDronePool } from './systemState';
import type { DronePool } from './systemState';

type ImpactEvent = Extract<SimEvent, { type: 'impact' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** The docks' distance from the player (DRONE_DEFAULTS.dockRadius), written out. */
const DOCK_RADIUS = 43;
/** Seat 0's dock, at angle 0. */
const DOCK0 = { x: PLAYER.x + DOCK_RADIUS, y: PLAYER.y };
/** The splash radius (DRONE_DEFAULTS.splash) and a drone's step at m = 1 (600 / 60). */
const SPLASH = 40;
const STEP = 10;

const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y + dy,
  ...more,
});
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
/** The drone hits' tags (grantEmitter's drone case). */
const DRONE_TAGS = TAG.hit | TAG.minion | TAG.area;
const HEAL = { kind: 'heal', lifePct: 0.01 } as const;

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly grants?: readonly SourcedEmitter[];
  readonly triggers?: readonly TriggerSpec[];
  readonly modules?: readonly TestModule[];
}

/**
 * placedEnemies with these grants (one drone on outer.summon by default) and triggers (credited
 * to outer.summon) over NO_ROLLS.
 */
function fixture(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'outer.summon', spec })),
      conversions: [],
      emitters: options.grants ?? [on('outer.summon', drone(1))],
    }),
    ...(options.modules === undefined ? {} : { modules: options.modules }),
  });
}

/** A run's config with these grants over NO_ROLLS, an immortal player and `values`. */
const runConfig = (
  grants: readonly SourcedEmitter[],
  overrides: Parameters<typeof makeConfig>[0] = {},
  values: Partial<Record<StatId, number>> = {},
): ReturnType<typeof makeConfig> =>
  makeConfig({
    ...overrides,
    stats: makeStats({ ...NO_ROLLS, maxLife: 1e12, ...values }, [], {
      triggers: [],
      conversions: [],
      emitters: grants,
    }),
  });

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const droneEm = (ctx: RunContext, i = 1): EmitterRuntime => ctx.emitters[i] as EmitterRuntime;
const kill = (e: Enemy): void => void Object.assign(e, { hp: num(1) });

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

/** The next tick's drone stage after the enemies walk, as in a run. */
function nextWalking(ctx: RunContext): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  moveEnemies(ctx);
  rebuildGrid(ctx);
  return stage(ctx);
}

/** Runs the stage on the current tick, then on the next ones through `last`: the impacts' ticks. */
function impactTicks(ctx: RunContext, last: number): number[] {
  const ticks = impacts(stage(ctx)).length > 0 ? [ctx.now] : [];
  return [...ticks, ...laterImpactTicks(ctx, last)];
}

/** Runs the stage on the next ticks through `last`; returns the ticks with an impact. */
function laterImpactTicks(ctx: RunContext, last: number): number[] {
  const ticks: number[] = [];
  while (ctx.now < last) if (impacts(next(ctx)).length > 0) ticks.push(ctx.now);
  return ticks;
}

const impacts = (events: readonly SimEvent[]): ImpactEvent[] => eventsOf([events], 'impact');
const hitIds = (events: readonly SimEvent[]): number[] =>
  eventsOf([events], 'hit').map((hit) => hit.targetId);

/** Puts slot s in DASH at `target` from (x, y), its center by default: what engage leaves. */
function dashing(ctx: RunContext, s: number, target: Enemy, x = target.x, y = target.y): void {
  const ds = ctx.sys.drones;
  ds.mode[s] = DRONE_DASH;
  ds.target[s] = target;
  ds.targetId[s] = target.id;
  ds.x[s] = x;
  ds.y[s] = y;
}

/** The pool's per-slot arrays, by name. */
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
  'dockX',
  'dockY',
  'target',
  'nextPick',
  'impactsLeft',
  'dockLeft',
  'acc',
  'memId',
  'memUntil',
] as const;
/** The pool's per-emitter arrays, by name. */
const PER_EMITTER = [
  'stepBase',
  'dockTicks',
  'coolTicks',
  'impacts',
  'splashSq',
  'turretPayload',
] as const;
/** Its scratch lists. */
const SCRATCH = ['splash', 'picked'] as const;

const lengthOf = (ds: DronePool, name: keyof DronePool): number =>
  (ds[name] as ArrayLike<unknown>).length;

/** The slot state that a pick, a move or an impact changes (prevX and prevY left out). */
function slotState(ds: DronePool): unknown {
  return {
    mode: Array.from(ds.mode),
    x: Array.from(ds.x),
    y: Array.from(ds.y),
    targetId: Array.from(ds.targetId),
    target: ds.target.map((t) => (t === null ? null : t.id)),
    nextPick: Array.from(ds.nextPick),
    impactsLeft: Array.from(ds.impactsLeft),
    dockLeft: Array.from(ds.dockLeft),
    memId: Array.from(ds.memId),
    memUntil: Array.from(ds.memUntil),
  };
}

/** The test's own same-enemy cooldown at frequency m: 30 / m ticks rounded up, in [1, 90]. */
const cooldownOf = (m: number): number => Math.min(90, Math.max(1, Math.ceil(30 / m)));

/** The one tick an entry is live by D10's predicate: until it ends, strictly. */
const live = (until: number, now: number): boolean => until > now;

describe('the drone pool', () => {
  it('stays empty in an M1 run: count 0, every array empty, and SimState holds the pool itself', () => {
    const ctx = placedEnemies([at(300, 0)]);
    const ds = ctx.sys.drones;
    expect([ds.count, ds.rows, ds.nextId, ds.pickedCount]).toEqual([0, 0, 1, 0]);
    const arrays = Object.entries(ds).filter(
      ([, value]) => ArrayBuffer.isView(value) || Array.isArray(value),
    );
    expect(arrays.map(([name]) => name).sort()).toEqual(
      [...PER_SLOT, ...PER_EMITTER, ...SCRATCH].sort(),
    );
    for (const [name, value] of arrays) expect((value as ArrayLike<unknown>).length, name).toBe(0);
    expect(ctx.state.drones).toBe(ds);
    expect(ctx.state.droneCount).toBe(0);
  });

  it('adds no member to the run context: below 128, as many as an M1 run’s', () => {
    const m1 = createRunContext(makeConfig(), makeTestData());
    const withDrones = createRunContext(runConfig([on('outer.summon', drone(3))]), makeTestData());
    expect(Object.keys(withDrones).length).toBe(Object.keys(m1).length);
    expect(Object.keys(withDrones).length).toBeLessThan(128);
  });

  it.each([1, 3, 6])(
    'docks drone k of %i at angle 2πk/D, 43 from the player, with a full sortie and a staggered first pick',
    (count) => {
      const ctx = fixture([], { grants: [on('outer.summon', drone(count))] });
      const ds = ctx.sys.drones;
      // Independent of the code: cos and sin of the multiples of 60° (D = 1, 3, 6).
      const sixth = (k: number): number => (6 * k) / count;
      const cos = (k: number): number => [1, 0.5, -0.5, -1, -0.5, 0.5][sixth(k)] as number;
      const sin = (k: number): number =>
        ([0, 1, 1, 0, -1, -1][sixth(k)] as number) * (Math.sqrt(3) / 2);
      const seats = Array.from({ length: count }, (_, k) => k);
      expect([ds.count, ds.rows, ds.nextId]).toEqual([count, count, count + 1]);
      expect(Array.from(ds.id)).toEqual(seats.map((k) => k + 1));
      expect(Array.from(ds.kind)).toEqual(seats.map(() => DRONE_KIND_DRONE));
      expect(Array.from(ds.mode)).toEqual(seats.map(() => DRONE_DOCKED));
      expect(Array.from(ds.owner)).toEqual(seats.map(() => 1));
      expect(Array.from(ds.seat)).toEqual(seats);
      for (const k of seats) {
        expect(ds.x[k], `x of ${k}`).toBeCloseTo(PLAYER.x + DOCK_RADIUS * cos(k), 9);
        expect(ds.y[k], `y of ${k}`).toBeCloseTo(PLAYER.y + DOCK_RADIUS * sin(k), 9);
        // Exactly the fill's arithmetic, done once per run.
        expect(ds.x[k]).toBe(PLAYER.x + DOCK_RADIUS * Math.cos((2 * Math.PI * k) / count));
        expect(ds.y[k]).toBe(PLAYER.y + DOCK_RADIUS * Math.sin((2 * Math.PI * k) / count));
        expect([ds.dockX[k], ds.dockY[k], ds.prevX[k], ds.prevY[k]]).toEqual([
          ds.x[k],
          ds.y[k],
          ds.x[k],
          ds.y[k],
        ]);
      }
      expect(Array.from(ds.targetId)).toEqual(seats.map(() => -1));
      expect(ds.target).toEqual(seats.map(() => null));
      expect(Array.from(ds.nextPick)).toEqual(seats.map((k) => 1 + ((10 * k) % PICK_TICKS)));
      expect(Array.from(ds.impactsLeft)).toEqual(seats.map(() => 3));
      expect(Array.from(ds.dockLeft)).toEqual(seats.map(() => 0));
      expect(Array.from(ds.memId)).toEqual(Array<number>(count * DRONE_MEMORY).fill(-1));
      expect(Array.from(ds.memUntil)).toEqual(Array<number>(count * DRONE_MEMORY).fill(0));
      // Per emitter: 0 for the signature, its numbers at m = 1 for the drone emitter.
      expect(
        [ds.stepBase, ds.dockTicks, ds.coolTicks, ds.impacts, ds.splashSq].map((a) =>
          Array.from(a),
        ),
      ).toEqual([
        [0, STEP],
        [0, 30],
        [0, 30],
        [0, 3],
        [0, SPLASH * SPLASH],
      ]);
      // Every drone emitter's turret payload is built, its turrets placed or not (C5.4).
      expect(ds.turretPayload[0]).toBeNull();
      expect(ds.turretPayload[1]).toMatchObject({ tags: TAG.hit | TAG.minion | TAG.projectile });
    },
  );

  it('is built with drone grants without calling shootable, and holds its drones from tick 0', () => {
    const grants = [on('outer.summon', drone(3))];
    const ctx = fixture([at(300, 0)], { grants });
    let calls = 0;
    const layout = droneLayout(ctx.build, ctx.emitters, SUMMON_CAP, ctx.combatRng, null);
    const pool = createDronePool(layout, () => {
      calls++;
      return true;
    });
    expect([calls, pool.count]).toEqual([0, 3]);
    // Its turrets' later picks (C5.4) go through it: shootable, and not picked yet.
    const first = enemy(ctx, 1);
    expect(pool.turretAccept(first)).toBe(true);
    expect(calls).toBe(1);
    pool.picked[0] = first;
    pool.pickedCount = 1;
    expect(pool.turretAccept(first)).toBe(false);
    // Tick 0: the SimState literal already counts them.
    const fresh = createRunContext(runConfig(grants), makeTestData());
    expect([fresh.state.tick, fresh.state.droneCount, fresh.sys.drones.count]).toEqual([0, 3, 3]);
    const sim = createSimulation(runConfig(grants), makeTestData());
    expect([sim.state.tick, sim.state.droneCount, sim.state.drones.x.length]).toEqual([0, 3, 3]);
  });

  it('sizes the per-emitter arrays for every emitter once a drone grant exists, though it places no drone', () => {
    // Built from StatExtras, as the bench builds grants: validation would reject drones 0.
    const ctx = fixture([at(300, 0)], { grants: [on('outer.summon', drone(0))] });
    const ds = ctx.sys.drones;
    expect([ds.rows, ds.count, ctx.emitters.length]).toEqual([0, 0, 2]);
    for (const name of PER_EMITTER) expect(lengthOf(ds, name), name).toBe(2);
    for (const name of PER_SLOT) expect(lengthOf(ds, name), name).toBe(0);
    expect(ds.splashSq[1]).toBe(SPLASH * SPLASH);
    expect(stage(ctx)).toEqual([]);
  });

  it('gives a drone emitter its turrets’ period as its interval, and no shots in flight', () => {
    // TURRET_RATE firings a second at BASE_ATTACK_SPEED: 2 at attackSpeed 4, 3 at 6 (C5.4 fires
    // on it; its drones keep their own clocks).
    expect(droneEm(fixture([])).interval).toBe(TICK_RATE / 2);
    const fast = fixture([], { values: { attackSpeed: 6 } });
    expect(droneEm(fast).interval).toBe(TICK_RATE / 3);
    expect(shotsInFlight(droneEm(fast).spec)).toBe(false);
  });

  it('places at most SUMMON_CAP summons in emitter order and counts the rest; a test module may raise the cap', () => {
    const grants = [on('outer.summon', drone(20)), on('outer.summon', drone(12, { name: 'b' }))];
    const seats = (n: number): number[] => Array.from({ length: n }, (_, k) => k);
    const capped = fixture([], { grants });
    const ds = capped.sys.drones;
    expect(SUMMON_CAP).toBe(24);
    expect([ds.rows, capped.counters.summonCapped]).toEqual([24, 8]);
    expect(Array.from(ds.owner)).toEqual([
      ...Array<number>(20).fill(1),
      ...Array<number>(4).fill(2),
    ]);
    expect(Array.from(ds.seat)).toEqual([...seats(20), ...seats(4)]);
    expect(Array.from(ds.id)).toEqual(seats(24).map((k) => k + 1));
    expect(
      droneLayout(capped.build, capped.emitters, SUMMON_CAP, capped.combatRng, null),
    ).toMatchObject({ rows: 24, refused: 8, summonCap: 24 });
    const raised = fixture([], { grants, modules: [raiseCap(32)] });
    expect([raised.sys.drones.rows, raised.counters.summonCapped]).toEqual([32, 0]);
    expect(droneLayout(raised.build, raised.emitters, 32, raised.combatRng, null)).toMatchObject({
      rows: 32,
      refused: 0,
      summonCap: 32,
    });
    // The run takes the largest cap, never one below SUMMON_CAP.
    const lower = fixture([], { grants, modules: [raiseCap(10)] });
    expect([lower.sys.drones.rows, lower.counters.summonCapped]).toEqual([24, 8]);
    const two = fixture([], { grants, modules: [raiseCap(28), raiseCap(26)] });
    expect([two.sys.drones.rows, two.counters.summonCapped]).toEqual([28, 4]);
    // The run's result counts them.
    const sim = createSimulation(runConfig(grants, { maxTicks: 1 }), makeTestData());
    sim.step(NO_INPUT);
    expect(sim.result().counters.summonCapped).toBe(8);
  });

  it('docks a capped emitter’s placed drones at 2πk/D of its grant’s D, as if all D were placed (§4.1)', () => {
    const grants = [on('outer.summon', drone(20)), on('outer.summon', drone(12, { name: 'b' }))];
    const ds = fixture([], { grants }).sys.drones;
    // The second grant's four placed drones: seats 0–3 of its D = 12, spaced 30°, not 90°.
    expect([ds.rows, ...ds.seat.subarray(20)]).toEqual([24, 0, 1, 2, 3]);
    for (const [slot, k, d] of [
      [5, 5, 20],
      [20, 0, 12],
      [21, 1, 12],
      [22, 2, 12],
      [23, 3, 12],
    ] as const) {
      const angle = (2 * Math.PI * k) / d;
      expect([ds.dockX[slot], ds.dockY[slot]], `slot ${slot}`).toEqual([
        PLAYER.x + DOCK_RADIUS * Math.cos(angle),
        PLAYER.y + DOCK_RADIUS * Math.sin(angle),
      ]);
    }
  });

  it('numbers its slots by id across two drone emitters and steps them in id order (CD11)', () => {
    // Drone 1 (outer.summon, seat 0) and drone 3 (hub, seat 0) both pick on tick 1, from one dock.
    const ctx = fixture([at(60, 0), at(40, 10)], {
      grants: [on('outer.summon', drone(2)), on('hub', drone(3))],
    });
    const ds = ctx.sys.drones;
    expect(Array.from(ds.id)).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(ds.owner)).toEqual([1, 1, 2, 2, 2]);
    expect(Array.from(ds.seat)).toEqual([0, 1, 0, 1, 2]);
    expect(Array.from(ds.stepBase)).toEqual([0, STEP, STEP]);
    // Drone 1 takes the farthest enemy; drone 3, stepped after it, the other.
    expect(impacts(stage(ctx)).map((e) => [e.droneId, e.targetId])).toEqual([
      [1, 1],
      [3, 2],
    ]);
  });

  it('steps each drone with its own emitter: its cadence, and its hits credited to its source (CD11)', () => {
    const ctx = fixture([at(60, 0), at(40, 10)], {
      grants: [on('outer.summon', drone(1)), on('hub', drone(1))],
    });
    const ds = ctx.sys.drones;
    const sources = (events: readonly SimEvent[]): string[] =>
      eventsOf([events], 'hit').map((hit) => ctx.state.sources[hit.source] as string);
    expect([...ds.owner, ...ds.seat]).toEqual([1, 2, 0, 0]);
    // hub's drone (id 2) at cadence 0 does nothing; outer.summon's impacts the farthest enemy.
    droneEm(ctx, 2).cadence = 0;
    const first = stage(ctx);
    expect(impacts(first).map((e) => [e.droneId, e.targetId])).toEqual([[1, 1]]);
    expect(sources(first)).toEqual(['outer.summon', 'outer.summon']);
    expect([ds.mode[1], ds.x[1], ds.y[1], ds.nextPick[1]]).toEqual([
      DRONE_DOCKED,
      DOCK0.x,
      DOCK0.y,
      1,
    ]);
    // The other way round: drone 1 sits still, and hub's drone impacts the enemy left over.
    droneEm(ctx, 1).cadence = 0;
    droneEm(ctx, 2).cadence = 1;
    const second = next(ctx);
    expect(impacts(second).map((e) => [e.droneId, e.targetId])).toEqual([[2, 2]]);
    expect(sources(second)).toEqual(['hub', 'hub']);
    expect([ds.x[0], ds.y[0], ds.prevX[0]]).toEqual([PLAYER.x + 60, PLAYER.y, PLAYER.x + 60]);
  });

  it('is skipped by the emitter stage: runEmitters leaves a due drone emitter and its drones alone', () => {
    const ctx = fixture([at(300, 0)]);
    const [signature] = ctx.emitters as EmitterRuntime[];
    const em = droneEm(ctx);
    expect(ctx.emitters.filter((e) => EMITTER_STEPS[e.spec.kind] !== null)).toEqual([signature]);
    // Due by both clocks an emitter keeps (acc, timer); the signature is not due.
    em.acc = em.interval - 1;
    em.timer = em.interval - 1;
    (signature as EmitterRuntime).acc = 0;
    const before = { ...em };
    const pool = slotState(ctx.sys.drones);
    ctx.events.length = 0;
    for (let k = 0; k < 3; k++) runEmitters(ctx);
    expect(ctx.events).toEqual([]);
    expect({ ...em }).toEqual(before);
    expect(slotState(ctx.sys.drones)).toEqual(pool);
  });
});

describe('the drone stage: picks', () => {
  it('staggers the first picks of three drones at ticks 1, 11 and 21, and a docked pick dashes on its tick', () => {
    const ctx = fixture([at(500, 0)], { grants: [on('outer.summon', drone(3))] });
    const ds = ctx.sys.drones;
    const picks: number[][] = [[], [], []];
    let before = Array.from(ds.nextPick);
    for (let tick = 1; tick <= 40; tick++) {
      if (tick === 1) stage(ctx);
      else next(ctx);
      for (let s = 0; s < 3; s++) if (ds.nextPick[s] !== before[s]) picks[s]?.push(tick);
      before = Array.from(ds.nextPick);
      if (tick === 1) {
        // Picked, and one step out on the same tick.
        expect([ds.mode[0], ds.targetId[0], ds.x[0], ds.y[0]]).toEqual([
          DRONE_DASH,
          1,
          DOCK0.x + STEP,
          DOCK0.y,
        ]);
        expect([ds.mode[1], ds.mode[2]]).toEqual([DRONE_DOCKED, DRONE_DOCKED]);
      }
    }
    // Drone 1 reaches its target, 457 from its dock, on tick 44: it has not picked again.
    expect(picks).toEqual([[1], [11], [21]]);
    expect(Array.from(ds.mode)).toEqual([DRONE_DASH, DRONE_DASH, DRONE_DASH]);
  });

  /**
   * Reference (§4.4's key): sort the enemies alive, with their center in the arena (edges
   * included) and not in a live entry of slot s's memory by (chased by another dashing slot,
   * −dist, id), and take the first. Written here; it imports nothing from drones.ts.
   */
  function pickRef(ctx: RunContext, s: number): Enemy | null {
    const ds = ctx.sys.drones;
    const now = ctx.now;
    const remembered = (id: number): boolean => {
      for (let k = s * 4; k < s * 4 + 4; k++) {
        if (ds.memId[k] === id && live(ds.memUntil[k] as number, now)) return true;
      }
      return false;
    };
    const chased = (e: Enemy): number => {
      for (let o = 0; o < ds.count; o++) {
        if (o !== s && ds.mode[o] === DRONE_DASH && ds.target[o] === e) return 1;
      }
      return 0;
    };
    const inside = (e: Enemy): boolean =>
      e.x >= 0 && e.x <= ARENA_WIDTH && e.y >= 0 && e.y <= ARENA_HEIGHT;
    const keyed = ctx.enemies
      .filter((e) => e.alive && inside(e) && !remembered(e.id))
      .map((e) => ({ e, chased: chased(e) }));
    keyed.sort((a, b) => a.chased - b.chased || b.e.dist - a.e.dist || a.e.id - b.e.id);
    return keyed[0]?.e ?? null;
  }

  /**
   * A seeded fixture: up to 12 enemies (mirrored pairs at one dist, some on an edge, some just
   * outside one, some dead), 8 drones in mixed modes, some fixtures with every enemy chased, and
   * memory entries live, expired and unknown. Returns the context and the slot to pick for.
   */
  function pickFixture(rng: Rng): { ctx: RunContext; s: number } {
    const SLOTS = 8;
    const n = rng.int(13);
    const placed: PlacedEnemy[] = [];
    for (let i = 0; i < n; i++) {
      const r = rng.next();
      const prev = placed[i - 1];
      const edge = rng.int(4);
      if (r < 0.2 && prev !== undefined) {
        placed.push({ x: 2 * PLAYER.x - prev.x, y: 2 * PLAYER.y - prev.y });
      } else if (r < 0.35) {
        placed.push(
          edge < 2
            ? { x: edge === 0 ? 0 : ARENA_WIDTH, y: rng.int(ARENA_HEIGHT + 1) }
            : { x: rng.int(ARENA_WIDTH + 1), y: edge === 2 ? 0 : ARENA_HEIGHT },
        );
      } else if (r < 0.45) {
        const off = rng.chance(0.5) ? 0.5 : 1;
        placed.push(
          edge < 2
            ? { x: edge === 0 ? -off : ARENA_WIDTH + off, y: rng.int(ARENA_HEIGHT + 1) }
            : { x: rng.int(ARENA_WIDTH + 1), y: edge === 2 ? -off : ARENA_HEIGHT + off },
        );
      } else {
        placed.push({ x: rng.int(ARENA_WIDTH + 121) - 60, y: rng.int(ARENA_HEIGHT + 121) - 60 });
      }
    }
    const ctx = fixture(placed, { grants: [on('outer.summon', drone(SLOTS))] });
    for (const e of ctx.enemies) if (rng.chance(0.15)) removeEnemy(ctx, e);
    ctx.now = ctx.state.tick = 100 + rng.int(100);
    const ds = ctx.sys.drones;
    const s = rng.int(SLOTS);
    const enemies = ctx.enemies;
    const modes = [DRONE_DOCKED, DRONE_DASH, DRONE_DASH, DRONE_HOVER, DRONE_RETURN];
    for (let o = 0; o < SLOTS; o++) {
      const mode = modes[rng.int(modes.length)] as number;
      const holds = mode === DRONE_DASH || (mode === DRONE_RETURN && rng.chance(0.5));
      ds.mode[o] = enemies.length === 0 && mode === DRONE_DASH ? DRONE_DOCKED : mode;
      // A dashing slot holds its target; one flying home may still hold its sortie's last.
      if (enemies.length > 0 && holds) {
        const t = rng.pick(enemies);
        ds.target[o] = t;
        ds.targetId[o] = t.id;
      }
    }
    if (enemies.length > 0 && enemies.length < SLOTS && rng.chance(0.25)) {
      // Every enemy chased by another slot: the chased tier decides.
      let o = 0;
      for (const e of enemies) {
        if (o === s) o++;
        ds.mode[o] = DRONE_DASH;
        ds.target[o] = e;
        ds.targetId[o] = e.id;
        o++;
      }
    }
    // Memory, slot s's and the others': live, expired (memUntil <= now) and unknown ids.
    for (let k = 0; k < SLOTS * DRONE_MEMORY; k++) {
      if (rng.chance(0.5)) continue;
      ds.memId[k] = enemies.length > 0 && rng.chance(0.8) ? rng.pick(enemies).id : 999;
      ds.memUntil[k] = ctx.now + rng.int(61) - 30;
    }
    return { ctx, s };
  }

  it('picks what a brute-force sort by (chased, −dist, id) picks, over 300 seeded fixtures, writing and drawing nothing', () => {
    const seen = { picked: 0, none: 0, chased: 0, tied: 0, edge: 0, remembered: 0 };
    for (let f = 0; f < 300; f++) {
      const { ctx, s } = pickFixture(createRng(9000 + f));
      const ds = ctx.sys.drones;
      const want = pickRef(ctx, s);
      const before = slotState(ds);
      const streams = rngPositions(ctx);
      const got = pickOuter(ctx, s);
      expect(got?.id ?? null, `fixture ${f}, slot ${s}`).toBe(want?.id ?? null);
      expect(slotState(ds), `fixture ${f} writes nothing`).toEqual(before);
      expect(rngPositions(ctx)).toEqual(streams);
      for (let k = s * 4; k < s * 4 + 4; k++) {
        if (ds.memId[k] !== -1 && live(ds.memUntil[k] as number, ctx.now)) seen.remembered++;
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
      if (ctx.enemies.some((e) => e !== want && e.alive && e.dist === want.dist)) seen.tied++;
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

  it('draws nothing while its drones dock, dash, pick, impact and fly home at no rolls (600 ticks)', () => {
    const ctx = fixture(
      [at(400, 0), at(-300, 200), at(100, -350, { speed: 40 }), at(-500, -100, { speed: 60 })],
      { grants: [on('outer.summon', drone(3))] },
    );
    const ds = ctx.sys.drones;
    const before = rngPositions(ctx);
    let impactCount = 0;
    let picks = 0;
    let docks = 0;
    let pickedAt = Array.from(ds.nextPick);
    let modes = Array.from(ds.mode);
    for (let tick = 1; tick <= 600; tick++) {
      impactCount += impacts(tick === 1 ? stage(ctx) : nextWalking(ctx)).length;
      for (let s = 0; s < 3; s++) {
        if (ds.nextPick[s] !== pickedAt[s]) picks++;
        if (modes[s] === DRONE_RETURN && ds.mode[s] === DRONE_DOCKED) docks++;
      }
      pickedAt = Array.from(ds.nextPick);
      modes = Array.from(ds.mode);
    }
    expect(rngPositions(ctx)).toEqual(before);
    expect(impactCount).toBeGreaterThan(30);
    expect(picks).toBeGreaterThan(10);
    expect(docks).toBeGreaterThan(3);
  });

  it('rolls its hits on the combat stream, one draw a hit at crit chance 0.5, and moves no other stream', () => {
    // The target (60 from the player, 17 from the dock) and two enemies within its splash.
    const ctx = fixture([at(60, 0), at(40, 0), at(30, 10)], { values: { critChance: 0.5 } });
    const before = rngPositions(ctx);
    const events = stage(ctx);
    expect(impacts(events)).toHaveLength(1);
    expect(hitIds(events)).toEqual([1, 2, 3]);
    const after = rngPositions(ctx);
    expect({ ...after, combat: before.combat }).toEqual(before);
    // A twin of the run's combat stream, three draws past where the stage began.
    const twin = createStreams(1).combat;
    for (let n = 0; String(twin.snapshot()) !== String(before.combat); n++) {
      if (n > 10_000) throw new Error('the twin never meets the combat stream');
      twin.next();
    }
    for (let n = 0; n < 3; n++) twin.next();
    expect(after.combat).toEqual(twin.snapshot());
  });
});

describe('the drone stage: flight', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'arrives at m = %i on the tick a swept reference gives, never passing through its target',
    (m) => {
      for (const degrees of [20, 75, 140, 200, 290]) {
        const angle = (degrees * Math.PI) / 180;
        const dist = 300 + 20 * m;
        const shard: PlacedEnemy = {
          x: PLAYER.x + dist * Math.cos(angle),
          y: PLAYER.y + dist * Math.sin(angle),
          type: 'shard',
          speed: 260,
        };
        const ctx = fixture([shard], { values: { attackSpeed: BASE_ATTACK_SPEED * m } });
        const ds = ctx.sys.drones;
        const target = enemy(ctx, 1);
        expect(target.radius).toBe(10);
        // The reference drone: a step of STEP × m towards the shard's center a tick; it arrives
        // when the step's segment reaches the shard's disc, and sits on its center.
        let rx = ds.x[0] as number;
        let ry = ds.y[0] as number;
        let refArrival = -1;
        let arrival = -1;
        for (let tick = 1; tick <= 200 && arrival < 0; tick++) {
          const events = tick === 1 ? stage(ctx) : nextWalking(ctx);
          const dx = target.x - rx;
          const dy = target.y - ry;
          const d = Math.sqrt(dx * dx + dy * dy);
          const qx = rx + (dx / d) * STEP * m;
          const qy = ry + (dy / d) * STEP * m;
          if (segDistSqRef(target.x, target.y, rx, ry, qx, qy) <= target.radius ** 2) {
            refArrival = tick;
            rx = target.x;
            ry = target.y;
          } else {
            rx = qx;
            ry = qy;
          }
          if (impacts(events).length > 0) arrival = tick;
          expect(ds.x[0], `${degrees}°, tick ${tick}`).toBeCloseTo(rx, 6);
          expect(ds.y[0], `${degrees}°, tick ${tick}`).toBeCloseTo(ry, 6);
        }
        expect(arrival, `${degrees}°`).toBe(refArrival);
        expect(arrival).toBeGreaterThan(1);
        expect([ds.x[0], ds.y[0]]).toEqual([target.x, target.y]);
      }
    },
  );

  it('steps 15 a tick and docks 20 ticks at attack speed 6; cadence 0.5 halves the step and doubles the dock', () => {
    const ctx = fixture([at(800, 0)], { values: { attackSpeed: 6 } });
    const ds = ctx.sys.drones;
    stage(ctx);
    expect(ds.x[0]).toBe(DOCK0.x + 15);
    next(ctx);
    expect([(ds.x[0] as number) - (ds.prevX[0] as number), ds.y[0]]).toEqual([15, DOCK0.y]);
    droneEm(ctx).cadence = 0.5;
    next(ctx);
    expect((ds.x[0] as number) - (ds.prevX[0] as number)).toBe(7.5);
    // Flying home from 1 away: it docks on the next tick, then waits out its dock time.
    const dockFor = (cadence: number): number => {
      droneEm(ctx).cadence = cadence;
      ds.mode[0] = DRONE_RETURN;
      ds.x[0] = DOCK0.x + 1;
      ds.y[0] = DOCK0.y;
      ds.nextPick[0] = 0;
      next(ctx);
      expect([ds.mode[0], ds.x[0], ds.dockLeft[0]]).toEqual([DRONE_DOCKED, DOCK0.x, 30]);
      const docked = ctx.now;
      while (ds.mode[0] === DRONE_DOCKED) next(ctx);
      // It picks, and dashes, on the tick after its dock time has run out.
      return ctx.now - docked - 1;
    };
    expect(dockFor(1)).toBe(20);
    expect(dockFor(0.5)).toBe(40);
  });

  it.each([
    ['0, at attack speed 0', { attackSpeed: 0 }, [], 0],
    ['below 0', {}, [(b: BuildCompiler) => b.offsetStat('attackSpeed', -8)], -4],
    ['NaN', {}, [(b: BuildCompiler) => b.scaleStat('attackSpeed', NaN)], NaN],
  ] as const)(
    'does nothing at an m of %s: no pick, no move and no impact, its positions finite',
    (_label, values, modules, attackSpeed) => {
      const ctx = fixture([at(50, 0)], {
        values,
        modules: modules as readonly TestModule[],
        grants: [on('outer.summon', drone(4))],
      });
      expect(ctx.build.values.attackSpeed).toBe(attackSpeed);
      const ds = ctx.sys.drones;
      // Docked and due; on its target's center; flying home; hovering with its clock out.
      dashing(ctx, 1, enemy(ctx, 1));
      ds.mode[2] = DRONE_RETURN;
      ds.x[2] = 1200;
      ds.y[2] = 300;
      ds.mode[3] = DRONE_HOVER;
      ds.x[3] = 800;
      ds.y[3] = 700;
      ds.nextPick[3] = 1;
      const before = slotState(ds);
      for (let tick = 1; tick <= 60; tick++) {
        expect(tick === 1 ? stage(ctx) : next(ctx)).toEqual([]);
      }
      expect(slotState(ds)).toEqual(before);
      for (const v of [...ds.x, ...ds.y, ...ds.prevX, ...ds.prevY]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    },
  );

  it('moves its previous position up to its position on a tick it does nothing at m = 0 (§4.2)', () => {
    const ctx = fixture([at(800, 0)]);
    const ds = ctx.sys.drones;
    stage(ctx);
    expect([ds.prevX[0], ds.x[0]]).toEqual([DOCK0.x, DOCK0.x + STEP]);
    droneEm(ctx).cadence = 0;
    expect(next(ctx)).toEqual([]);
    expect([ds.x[0], ds.y[0]]).toEqual([DOCK0.x + STEP, DOCK0.y]);
    // prevX and prevY are written before the m test: no motion is left to draw.
    expect([ds.prevX[0], ds.prevY[0]]).toEqual([ds.x[0], ds.y[0]]);
  });
});

describe('the drone stage: impacts', () => {
  it('hits every enemy alive within the splash of its target once, in id order, then raises its impact', () => {
    const T = { x: 1300, y: 540 };
    const ctx = fixture([
      { x: T.x + 40, y: T.y }, // 1: 40 away, in
      { x: T.x, y: 499.9999 }, // 2: 40.0001 away, out
      T, // 3: the target
      { x: T.x + 24, y: T.y + 32 }, // 4: 40 away, in
      { x: 1259.9999, y: T.y }, // 5: 40.0001 away, out
      { x: T.x, y: T.y + 40 }, // 6: 40 away, in
      { x: T.x + 10, y: T.y + 5 }, // 7: dead
    ]);
    removeEnemy(ctx, enemy(ctx, 7));
    rebuildGrid(ctx);
    dashing(ctx, 0, enemy(ctx, 3));
    const events = stage(ctx);
    const inside = withinRef(ctx.enemies, T.x, T.y, SPLASH * SPLASH).map((e) => e.id);
    expect(inside).toEqual([1, 3, 4, 6]);
    expect(hitIds(events)).toEqual(inside);
    for (const hit of eventsOf([events], 'hit')) {
      expect([hit.tags, hit.chainIndex, hit.crit]).toEqual([DRONE_TAGS, 0, false]);
    }
    expect(impacts(events)).toEqual([
      { type: 'impact', droneId: 1, x: T.x, y: T.y, radius: SPLASH, targetId: 3, count: 4 },
    ]);
    expect(events.at(-1)?.type).toBe('impact');
  });

  it('lists its splash before any hit: the children of a target it kills take none of its hits (CD7)', () => {
    const ctx = fixture([at(340, 0, { type: 'pentagon', hp: 5 }), at(360, 0)]);
    const pentagon = enemy(ctx, 1);
    dashing(ctx, 0, pentagon);
    const events = stage(ctx);
    expect(pentagon.alive).toBe(false);
    const children = ctx.enemies.slice(2);
    expect(children.map((e) => [e.type, e.alive])).toEqual(Array(3).fill(['shard', true]));
    for (const child of children) {
      expect(Math.hypot(child.x - pentagon.x, child.y - pentagon.y)).toBeLessThan(SPLASH);
      expect(toNumber(child.hp)).toBe(toNumber(child.maxHp));
    }
    expect(hitIds(events)).toEqual([1, 2]);
    expect(impacts(events).map((e) => [e.targetId, e.count])).toEqual([[1, 2]]);
  });

  it('skips a listed enemy that dies before its turn: no hit and no draw, though the impact counts it', () => {
    // The target (60 from the player, 17 from the dock) and two enemies in its splash. A hook
    // kills enemy 3 on the target's hit, after the list was taken: nothing in C5.1's content
    // kills inline, so the hook stands in for whatever will.
    const killer: TestModule = (b) =>
      b.hook('onHit', (c, hit) => {
        const third = enemy(c, 3);
        if (hit.target.id === 1 && third.alive) removeEnemy(c, third);
      });
    const ctx = fixture([at(60, 0), at(40, 0), at(30, 10)], {
      values: { critChance: 0.5 },
      modules: [killer],
    });
    const before = rngPositions(ctx);
    const events = stage(ctx);
    const third = enemy(ctx, 3);
    expect(third.alive).toBe(false);
    expect(hitIds(events)).toEqual([1, 2]);
    expect(toNumber(third.hp)).toBe(toNumber(third.maxHp));
    // count is the list as it struck (D8 step 3): three enemies, two of them hit.
    expect(impacts(events).map((e) => [e.targetId, e.count])).toEqual([[1, 3]]);
    expect(ctx.chainBudget.hits).toBe(1);
    // One combat draw a hit at crit chance 0.5, so two: none for the dead enemy.
    const twin = createStreams(1).combat;
    for (let n = 0; String(twin.snapshot()) !== String(before.combat); n++) {
      if (n > 10_000) throw new Error('the twin never meets the combat stream');
      twin.next();
    }
    twin.next();
    twin.next();
    expect(rngPositions(ctx).combat).toEqual(twin.snapshot());
  });

  it('is an attack of its own, not the signature’s: no PRIMARY, no counted attack, no nthAttack and no center event (CD1)', () => {
    const flags: number[] = [];
    let centerEvents = 0;
    let attacks = 0;
    const hooks: TestModule = (b) => {
      b.hook('onHit', (_ctx, hit) => void flags.push(hit.flags));
      b.hook('onCenterEvent', () => void centerEvents++);
      b.hook('onAttack', () => void attacks++);
    };
    // The target, 60 from the player and 17 from the dock, and two enemies in its splash.
    const placed = [at(60, 0), at(40, 0), at(30, 10)];
    const ctx = fixture(placed, {
      triggers: [
        { on: 'hit', when: [{ hitIs: 'primary' }], do: [HEAL] },
        { on: 'hit', when: [{ hitIs: 'signature' }], do: [HEAL] },
        { on: 'nthAttack', every: 1, do: [HEAL] },
      ],
      modules: [hooks],
    });
    const serial = ctx.attackSerial;
    const events = stage(ctx);
    expect(hitIds(events)).toEqual([1, 2, 3]);
    expect(flags).toHaveLength(3);
    for (const f of flags) expect(f & (PRIMARY | SIGNATURE)).toBe(0);
    expect(ctx.effectQueue.size).toBe(0);
    const em = droneEm(ctx);
    expect([em.attacks, em.shots, droneEm(ctx, 0).attacks]).toEqual([0, 0, 0]);
    const nth = (ctx.build.triggersOn[EVENT.nthAttack] as Int32Array)[0] as number;
    expect(ctx.triggerState.count[nth]).toBe(0);
    expect([centerEvents, attacks]).toEqual([0, 0]);
    // One attack, whose chain budget counts the target alone.
    expect(ctx.attackSerial).toBe(serial + 1);
    expect(ctx.chainBudget.hits).toBe(1);
    expect(ctx.counters.chainHitsPeak).toBe(1);
    // A second impact is a second attack.
    impactAt(ctx, 0, enemy(ctx, 1), em.payload, em, false, 0, -1);
    expect([ctx.attackSerial, ctx.chainBudget.hits]).toEqual([serial + 2, 1]);
    // The same hits do fire a hit trigger that asks for a non-crit.
    const control = fixture(placed, {
      triggers: [{ on: 'hit', when: [{ hitIs: 'nonCrit' }], do: [HEAL] }],
    });
    stage(control);
    expect(control.effectQueue.size).toBe(3);
  });
});

describe('the drone stage: the same-enemy cooldown', () => {
  /** The ticks of the impacts of one drone sitting on an immortal square 7 from its dock. */
  const sitting = (values: Partial<Record<StatId, number>>, last: number): number[] =>
    impactTicks(fixture([at(50, 0)], { values }), last);

  it.each([
    [1, 30],
    [2, 15],
    [4, 8],
  ])('re-impacts a target it sits on at m = %i exactly %i ticks after its last impact', (m, c) => {
    expect(cooldownOf(m)).toBe(c);
    expect(sitting({ attackSpeed: BASE_ATTACK_SPEED * m }, 1 + 2 * c + 3)).toEqual([
      1,
      1 + c,
      1 + 2 * c,
    ]);
  });

  it('clamps the cooldown to DRONE_COOLDOWN_MAX: 90 ticks at m = 0.25, not 120', () => {
    expect(DRONE_COOLDOWN_MAX).toBe(90);
    expect(cooldownOf(0.25)).toBe(90);
    expect(sitting({ attackSpeed: 1 }, 200)).toEqual([1, 91, 181]);
  });

  it('keeps each drone to its own cooldown: two drones may hit one enemy closer together', () => {
    const ctx = fixture([at(50, 0)], { grants: [on('outer.summon', drone(2))] });
    const byDrone: number[][] = [[], []];
    for (let tick = 1; tick <= 90; tick++) {
      for (const hit of impacts(tick === 1 ? stage(ctx) : next(ctx))) {
        byDrone[hit.droneId - 1]?.push(tick);
      }
    }
    const [one = [], two = []] = byDrone;
    expect(one).toEqual([1, 31, 61]);
    expect(two).toHaveLength(3);
    for (let i = 1; i < 3; i++) expect((two[i] as number) - (two[i - 1] as number)).toBe(30);
    const gaps = one.flatMap((a) => two.map((b) => Math.abs(a - b)));
    expect(Math.min(...gaps)).toBeLessThan(30);
  });

  it('rewrites the entry of a target it impacts again and leaves the other three alone', () => {
    const ctx = fixture([at(50, 0)]);
    const ds = ctx.sys.drones;
    const target = enemy(ctx, 1);
    dashing(ctx, 0, target);
    // An expired entry that ends first, the target's ending now (expired), two live ones.
    ds.memId.set([903, target.id, 900, 901]);
    ds.memUntil.set([0, 1, 500, 500]);
    expect(impacts(stage(ctx))).toHaveLength(1);
    expect([Array.from(ds.memId), Array.from(ds.memUntil)]).toEqual([
      [903, target.id, 900, 901],
      [0, 31, 500, 500],
    ]);
    expect(laterImpactTicks(ctx, 31)).toEqual([31]);
    expect(Array.from(ds.memUntil)).toEqual([0, 61, 500, 500]);
  });

  it('writes its fifth id over the expired entry in the scripted worst case, over no live one (D10)', () => {
    // Five shards, the farthest first: A on the dock, B, C and D around the player, E 20 from
    // the dock.
    const ctx = fixture(
      [at(43, 0), at(0, 38), at(-33, 0), at(0, -28), at(23, 0)].map((p) => ({
        ...p,
        type: 'shard' as const,
      })),
    );
    const ds = ctx.sys.drones;
    const [A, B, C, D, E] = [1, 2, 3, 4, 5].map((id) => enemy(ctx, id)) as [
      Enemy,
      Enemy,
      Enemy,
      Enemy,
      Enemy,
    ];
    const em = droneEm(ctx);
    const t = 200;
    // A and C die to the impact that ends their entry's wait, at t − 90 and t − 30.
    const killAt = new Map<Enemy, number>([
      [A, t - 90],
      [C, t - 30],
    ]);
    // The cadence a tick hook would set before the stage (attack speed 4, so m is it): 0 while
    // the drone sits on A or C between their two impacts; 0.25 (a 90-tick cooldown) for their
    // second impacts and for B's and D's only one, which it slows down for once a step at 3
    // would arrive; 3 for the rest of the travel and docking.
    const cadenceAt = (tick: number): number => {
      const tgt = ds.target[0] ?? null;
      if (ds.mode[0] !== DRONE_DASH || tgt === null) return 3;
      const due = killAt.get(tgt);
      if (due !== undefined && ds.x[0] === tgt.x && ds.y[0] === tgt.y) return tick < due ? 0 : 0.25;
      const d = Math.hypot(tgt.x - (ds.x[0] as number), tgt.y - (ds.y[0] as number));
      return (tgt === B || tgt === D) && d - 3 * STEP <= tgt.radius ? 0.25 : 3;
    };
    const seen: { tick: number; id: number; m: number }[] = [];
    const picks: number[] = [];
    let memBefore: number[][] = [];
    ctx.now = ctx.state.tick = t - 121;
    while (ctx.now < t) {
      const tick = ctx.now + 1;
      em.cadence = cadenceAt(tick);
      for (const [e, due] of killAt) if (due === tick) kill(e);
      const pickBefore = ds.nextPick[0];
      memBefore = [Array.from(ds.memId), Array.from(ds.memUntil)];
      for (const hit of impacts(next(ctx))) seen.push({ tick, id: hit.targetId, m: em.cadence });
      if (ds.nextPick[0] !== pickBefore) picks.push(tick);
    }
    const of = (e: Enemy): number[] => seen.filter((s) => s.id === e.id).map((s) => s.tick);
    // A held from t − 120 (one pick ago) and killed at t − 90, which picks B on the same tick;
    // C and D picked at t − 60 and t − 30; E picked docked at t, and impacted at once at m 3.
    expect(picks).toEqual([t - 120, t - 90, t - 60, t - 30, t]);
    expect([A.alive, C.alive]).toEqual([false, false]);
    expect(of(A)).toEqual([t - 120, t - 90]);
    expect(of(B)).toHaveLength(1);
    expect(of(C)).toHaveLength(2);
    expect(of(C)[1]).toBe(t - 30);
    expect(of(D)).toHaveLength(1);
    expect(seen.at(-1)).toEqual({ tick: t, id: E.id, m: 3 });
    // The first sortie ends at B's impact and docks before t − 60; the second at D's.
    expect(seen.map((s) => s.id)).toEqual([A.id, A.id, B.id, C.id, C.id, D.id, E.id]);
    // Four ids impacted within t − 90 .. t − 1, each at m ≤ 1/3 at its last impact.
    for (const e of [A, B, C, D]) {
      const last = seen.filter((s) => s.id === e.id).at(-1);
      expect(last?.tick).toBeGreaterThanOrEqual(t - 90);
      expect(last?.tick).toBeLessThan(t);
      expect(last?.m).toBeLessThanOrEqual(1 / 3);
    }
    // At t, E's write took A's entry, which ends at t: expired (live only under the non-strict
    // reading, until >= now). B's, C's and D's live entries are untouched.
    const [ids = [], untils = []] = memBefore;
    expect(ids).toEqual([A.id, B.id, C.id, D.id]);
    expect(untils[0]).toBe(t);
    expect(live(untils[0] as number, t)).toBe(false);
    for (const k of [1, 2, 3]) expect(live(untils[k] as number, t)).toBe(true);
    expect(Array.from(ds.memId)).toEqual([E.id, B.id, C.id, D.id]);
    expect(Array.from(ds.memUntil)).toEqual([t + 10, ...untils.slice(1)]);
  });
});

describe('the drone stage: sorties and lost targets', () => {
  it('flies home after 3 impacts, snaps to its dock, docks 30 ticks at m = 1 with a full sortie, then picks again', () => {
    const ctx = fixture([at(50, 0)]);
    const ds = ctx.sys.drones;
    expect(impactTicks(ctx, 61)).toEqual([1, 31, 61]);
    // It keeps its sortie's last target while it flies home.
    expect([ds.mode[0], ds.impactsLeft[0], ds.targetId[0]]).toEqual([DRONE_RETURN, 0, 1]);
    next(ctx);
    // 7 from its dock, within a step: docked there exactly.
    expect([
      ds.mode[0],
      ds.x[0],
      ds.y[0],
      ds.dockLeft[0],
      ds.impactsLeft[0],
      ds.targetId[0],
    ]).toEqual([DRONE_DOCKED, DOCK0.x, DOCK0.y, 30, 3, -1]);
    expect(ds.target[0]).toBeNull();
    // Docked on tick 62: ticks 63–92 run its dock time out; on tick 93 it picks the square again
    // (its entry ended on tick 91) and impacts it on the same tick.
    expect(laterImpactTicks(ctx, 100)).toEqual([93]);
  });

  it('flies home in straight steps from a distant last impact and snaps onto its dock', () => {
    // 300 out from the dock: it arrives on tick 28 and impacts on 28, 58 and 88.
    const ctx = fixture([at(343, 0)]);
    const ds = ctx.sys.drones;
    expect(impactTicks(ctx, 88)).toEqual([28, 58, 88]);
    expect([ds.mode[0], ds.x[0], ds.y[0]]).toEqual([DRONE_RETURN, DOCK0.x + 300, DOCK0.y]);
    const steps: number[] = [];
    while (ds.mode[0] === DRONE_RETURN) {
      next(ctx);
      steps.push(
        Math.hypot((ds.x[0] as number) - (ds.prevX[0] as number), (ds.y[0] as number) - DOCK0.y),
      );
    }
    // 30 steps of 10 along the line home, the last onto the dock.
    expect(steps).toHaveLength(30);
    for (const step of steps) expect(step).toBeCloseTo(STEP, 9);
    expect([ds.mode[0], ds.x[0], ds.y[0], ctx.now]).toEqual([DRONE_DOCKED, DOCK0.x, DOCK0.y, 118]);
  });

  it('flies home when its sortie’s last impact kills its target, though another enemy is in reach', () => {
    const ctx = fixture([at(50, 0), at(-30, 0)]);
    const ds = ctx.sys.drones;
    expect(impactTicks(ctx, 60)).toEqual([1, 31]);
    kill(enemy(ctx, 1));
    expect(impacts(next(ctx)).map((e) => e.targetId)).toEqual([1]);
    expect(enemy(ctx, 1).alive).toBe(false);
    expect([ds.mode[0], ds.impactsLeft[0], ds.nextPick[0]]).toEqual([DRONE_RETURN, 0, 31]);
  });

  it('loses a target another drone kills on the same tick, hovers until its clock, then picks without moving', () => {
    const ctx = fixture([at(300, 0, { hp: 5 }), at(-200, 100)], {
      grants: [on('outer.summon', drone(2))],
    });
    const ds = ctx.sys.drones;
    const [X, Y] = [enemy(ctx, 1), enemy(ctx, 2)];
    // Drone 1 sits on X, its clock out: its impact kills X. Drone 2 dashes at X from 200 away.
    dashing(ctx, 0, X);
    ds.nextPick[0] = 1;
    dashing(ctx, 1, X, X.x - 200, X.y);
    ds.nextPick[1] = 11;
    stage(ctx);
    expect(X.alive).toBe(false);
    // Drone 1 picks again at once (Y); drone 2 sees X dead on the same tick and hovers.
    expect([ds.mode[0], ds.targetId[0], ds.nextPick[0]]).toEqual([DRONE_DASH, Y.id, 31]);
    expect([ds.mode[1], ds.targetId[1], ds.target[1], ds.x[1], ds.y[1]]).toEqual([
      DRONE_HOVER,
      -1,
      null,
      X.x - 200,
      X.y,
    ]);
    for (let tick = 2; tick < 11; tick++) {
      next(ctx);
      expect([ds.mode[1], ds.x[1], ds.y[1]]).toEqual([DRONE_HOVER, X.x - 200, X.y]);
    }
    // Its clock: it picks Y, chased by drone 1, as nothing else is left, and moves from tick 12.
    next(ctx);
    expect([ds.mode[1], ds.targetId[1], ds.target[1], ds.nextPick[1]]).toEqual([
      DRONE_DASH,
      Y.id,
      Y,
      11 + PICK_TICKS,
    ]);
    expect([ds.x[1], ds.y[1]]).toEqual([X.x - 200, X.y]);
    next(ctx);
    expect(Math.hypot((ds.x[1] as number) - (X.x - 200), (ds.y[1] as number) - X.y)).toBeCloseTo(
      STEP,
      9,
    );
  });

  it('drops a target pushed out of the arena past x = 1920, and keeps one on the edge (CD8)', () => {
    const ctx = fixture([at(900, 0), at(-300, 0)]);
    const ds = ctx.sys.drones;
    const [X, Y] = [enemy(ctx, 1), enemy(ctx, 2)];
    dashing(ctx, 0, X, 1500, X.y);
    ds.nextPick[0] = 3;
    X.x = ARENA_WIDTH;
    stage(ctx);
    expect([ds.mode[0], ds.targetId[0], ds.x[0]]).toEqual([DRONE_DASH, X.id, 1500 + STEP]);
    X.x = ARENA_WIDTH + 0.5;
    next(ctx);
    expect([ds.mode[0], ds.targetId[0], ds.target[0], ds.x[0]]).toEqual([
      DRONE_HOVER,
      -1,
      null,
      1500 + STEP,
    ]);
    // On its clock it picks Y, the only enemy inside.
    next(ctx);
    expect([ds.mode[0], ds.targetId[0]]).toEqual([DRONE_DASH, Y.id]);
    // Pushed out with its clock out: it picks again on the same tick.
    ds.nextPick[0] = 0;
    Y.x = -0.5;
    X.x = ARENA_WIDTH - 20;
    next(ctx);
    expect([ds.mode[0], ds.targetId[0], ds.nextPick[0]]).toEqual([DRONE_DASH, X.id, 4 + 30]);
  });

  it('stays docked with no enemy inside the arena, and a hovering drone with nothing to pick flies home', () => {
    const outside = [
      { x: -21, y: 540 },
      { x: 1941, y: 300 },
      { x: 900, y: -21 },
      { x: 500, y: 1101 },
    ];
    const ctx = fixture(outside, { grants: [on('outer.summon', drone(3))] });
    const ds = ctx.sys.drones;
    const docks = [Array.from(ds.x), Array.from(ds.y)];
    for (let tick = 1; tick <= 100; tick++) {
      expect(tick === 1 ? stage(ctx) : next(ctx)).toEqual([]);
    }
    expect(Array.from(ds.mode)).toEqual([DRONE_DOCKED, DRONE_DOCKED, DRONE_DOCKED]);
    expect([Array.from(ds.x), Array.from(ds.y)]).toEqual(docks);
    // Each picked on its clock and found nothing: tick 91 was seat 0's fourth pick.
    expect(Array.from(ds.nextPick)).toEqual([121, 101, 111]);
    ds.mode[2] = DRONE_HOVER;
    ds.x[2] = 1500;
    ds.y[2] = 300;
    ds.nextPick[2] = 0;
    next(ctx);
    expect([ds.mode[2], ds.nextPick[2]]).toEqual([DRONE_RETURN, 101 + PICK_TICKS]);
    while (ds.mode[2] === DRONE_RETURN) next(ctx);
    expect([ds.mode[2], ds.x[2], ds.y[2]]).toEqual([DRONE_DOCKED, docks[0]?.[2], docks[1]?.[2]]);
  });

  it('re-picks at once when it loses a target past its clock, and every DASH it enters holds its target (C5CHK4-1)', () => {
    // W stands farther than two steps plus its radius from where the drone is.
    const holds = (ctx: RunContext): boolean => {
      const ds = ctx.sys.drones;
      const t = ds.target[0] ?? null;
      return (
        ds.mode[0] === DRONE_RETURN ||
        (ds.mode[0] === DRONE_DASH && t !== null && ds.targetId[0] === t.id)
      );
    };
    // A lost target: killed while 2 impacts are left, the clock out.
    const lost = fixture([at(300, 0), at(-400, 0)]);
    const [X, W] = [enemy(lost, 1), enemy(lost, 2)];
    dashing(lost, 0, X);
    lost.sys.drones.impactsLeft[0] = 2;
    lost.sys.drones.nextPick[0] = 0;
    removeEnemy(lost, X);
    expect(() => {
      stage(lost);
      expect(holds(lost)).toBe(true);
      next(lost);
      expect(holds(lost)).toBe(true);
    }).not.toThrow();
    expect([lost.sys.drones.mode[0], lost.sys.drones.targetId[0]]).toEqual([DRONE_DASH, W.id]);
    // A hovering drone whose clock runs out.
    const hovering = fixture([at(-400, 0)]);
    hovering.sys.drones.mode[0] = DRONE_HOVER;
    hovering.sys.drones.nextPick[0] = 2;
    expect(() => {
      stage(hovering);
      next(hovering);
      expect(holds(hovering)).toBe(true);
      next(hovering);
    }).not.toThrow();
    expect([hovering.sys.drones.mode[0], hovering.sys.drones.targetId[0]]).toEqual([DRONE_DASH, 1]);
    // A docked pick.
    const docked = fixture([at(-400, 0)]);
    expect(() => {
      stage(docked);
      expect(holds(docked)).toBe(true);
      next(docked);
    }).not.toThrow();
    expect([docked.sys.drones.mode[0], docked.sys.drones.targetId[0]]).toEqual([DRONE_DASH, 1]);
  });
});

/** stationarySquares' one wave of 60 immortal squares, walking in at 20 a second. */
const walkingSquares = (): GameData =>
  makeTestData({
    enemies: { square: { hpMult: 1e12, speed: 20 } },
    waves: {
      rules: [{ enemy: 'square', fromWave: 1, base: 60, perWave: 0, maxCount: 60 }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    },
  });

describe('the drone stage in a run', () => {
  it('runs after the emitters, before the projectiles and the segments: lob → impact → explosion → segment pulse (§5, part 1)', () => {
    // segments.test.ts's magmaBomb run with 雷網, plus three drones. Its squares stand outside the
    // arena there, where no drone picks; here they walk in.
    const web: SegmentGrant = { kind: 'segment', endpoints: 'shocked' };
    const config = makeConfig({
      seed: 3,
      startWave: 1,
      maxTicks: 30 * TICK_RATE,
      signature: { id: 'magmaBomb' },
      stats: makeStats({ damage: 3, attackSpeed: 20, shockChance: 1, maxLife: 1e12 }, [], {
        triggers: [],
        conversions: [],
        emitters: [on('outer.lightning', web), on('outer.summon', drone(3))],
      }),
    });
    const sim = createSimulation(config, walkingSquares());
    let impactTicksSeen = 0;
    let withExplosion = 0;
    let withLob = 0;
    while (!sim.state.finished) {
      const events = sim.step(NO_INPUT);
      const where = (test: (e: SimEvent) => boolean): number[] =>
        events.flatMap((e, k) => (test(e) ? [k] : []));
      const hits = where((e) => e.type === 'impact');
      if (hits.length === 0) continue;
      impactTicksSeen++;
      const [first = 0, last = 0] = [hits[0], hits.at(-1)];
      const lobs = where((e) => e.type === 'lob');
      const later = where(
        (e) => e.type === 'explosion' || (e.type === 'pulse' && e.kind === 'segment'),
      );
      for (const k of lobs) expect(k).toBeLessThan(first);
      for (const k of later) expect(k).toBeGreaterThan(last);
      if (lobs.length > 0) withLob++;
      if (events.some((e) => e.type === 'explosion')) withExplosion++;
    }
    // 301 ticks with an impact at seed 3, 42 of them with a bomb fired and 42 with one landing.
    expect(impactTicksSeen).toBeGreaterThan(250);
    expect(withLob).toBeGreaterThan(30);
    expect(withExplosion).toBeGreaterThan(30);
  });

  it('never enters the stage in an M1 run: its pool stays empty (§5, part 3)', () => {
    let ctx: RunContext | null = null;
    const capture: TestModule = (b) => void b.hook('tick', (c) => void (ctx = c));
    const sim = createSimulation(makeConfig({ startWave: 3, maxTicks: 600 }), makeTestData(), [
      capture,
    ]);
    while (!sim.state.finished) {
      sim.step(NO_INPUT);
      expect(sim.state.droneCount).toBe(0);
    }
    const ds = (ctx as RunContext | null)?.sys.drones;
    expect(ds).toBe(sim.state.drones);
    expect([ds?.count, ds?.rows]).toEqual([0, 0]);
    for (const name of [...PER_SLOT, ...PER_EMITTER, ...SCRATCH]) {
      expect(lengthOf(ds as DronePool, name), name).toBe(0);
    }
    expect(sim.result().counters.summonCapped).toBe(0);
  });

  it('keeps its drones’ flights, clocks and memory across a wave start (D23)', () => {
    // Immortal squares that never clear a wave: a wave starts every second, on ticks 1, 61, 121.
    const data = makeTestData({
      enemies: { square: { hpMult: 1e12, speed: 20 } },
      waves: {
        rules: [{ enemy: 'square', fromWave: 1, base: 5, perWave: 0, maxCount: 5 }],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
        waveTimerSec: 1,
      },
    });
    const sim = createSimulation(
      runConfig([on('outer.summon', drone(2))], { startWave: 1, maxTicks: 1000 }),
      data,
    );
    // SimState.drones is the pool itself (D18).
    const ds = sim.state.drones as DronePool;
    const far = { x: DOCK0.x + 500, y: DOCK0.y };
    const still = { x: 700, y: 300 };
    const started: number[] = [];
    for (let tick = 1; tick <= 150; tick++) {
      // Before every tick: drone 1 flies home from far out, its sortie spent; drone 2 hovers
      // with its pick clock far off and one live memory entry.
      ds.mode[0] = DRONE_RETURN;
      ds.x[0] = far.x;
      ds.y[0] = far.y;
      ds.impactsLeft[0] = 0;
      ds.mode[1] = DRONE_HOVER;
      ds.x[1] = still.x;
      ds.y[1] = still.y;
      ds.nextPick[1] = 10_000;
      ds.memId[DRONE_MEMORY] = 77;
      ds.memUntil[DRONE_MEMORY] = 10_000;
      const events = sim.step(NO_INPUT);
      started.push(...eventsOf([events], 'waveStarted').map((e) => e.wave));
      expect([ds.mode[0], ds.x[0], ds.y[0], ds.impactsLeft[0]], `tick ${tick}`).toEqual([
        DRONE_RETURN,
        far.x - STEP,
        far.y,
        0,
      ]);
      expect(
        [ds.mode[1], ds.x[1], ds.y[1], ds.nextPick[1], ds.memId[DRONE_MEMORY]],
        `tick ${tick}`,
      ).toEqual([DRONE_HOVER, still.x, still.y, 10_000, 77]);
      expect(ds.memUntil[DRONE_MEMORY], `tick ${tick}`).toBe(10_000);
    }
    expect(started).toEqual([1, 2, 3]);
  });

  /** One 10,000-tick run of 5 drones on two emitters, its drone cadence random in 0.25–3. */
  interface RandomRun {
    readonly writes: number;
    readonly liveOverwrites: string[];
    readonly dashWithoutTarget: string[];
    readonly cooldownBroken: string[];
    readonly impacts: number;
    readonly slowImpacts: number;
    readonly pickGaps: number[];
    readonly hovering: number;
    readonly ticks: number;
  }
  let memo: RandomRun | null = null;

  /**
   * The run, once for the tests below: a tick hook switches the drone emitters' cadence to a
   * random value in [0.25, 3] every 7–40 ticks, drawn on a stream of its own (the run's are
   * untouched), 4 times in 10 in [0.25, 1/3], where the cooldown is the longest. After every
   * tick the shadow model checks each memory entry written against its value before the tick,
   * by D10's predicate written here (live while memUntil > now).
   */
  function randomRun(): RandomRun {
    if (memo !== null) return memo;
    const rng = createRng(4242);
    let ctx: RunContext | null = null;
    let switchAt = 0;
    const cadence: TestModule = (b) =>
      void b.hook('tick', (c) => {
        ctx = c;
        if (c.now < switchAt) return;
        const value = rng.chance(0.4) ? rng.range(0.25, 1 / 3) : rng.range(0.25, 3);
        for (const em of c.emitters) if (em.spec.kind === 'drone') em.cadence = value;
        switchAt = c.now + 7 + rng.int(34);
      });
    const config = runConfig(
      [on('outer.summon', drone(3)), on('hub', drone(2))],
      { seed: 11, startWave: 8, maxTicks: 10_000 },
      { damage: 40, critChance: 0.2 },
    );
    const initial = createRunContext(config, makeTestData()).sys.drones;
    let memId = Array.from(initial.memId);
    let memUntil = Array.from(initial.memUntil);
    let nextPick = Array.from(initial.nextPick);
    const lastPick = nextPick.map(() => -1);
    const lastImpact = new Map<string, { tick: number; cooldown: number }>();
    const run = {
      writes: 0,
      liveOverwrites: [] as string[],
      dashWithoutTarget: [] as string[],
      cooldownBroken: [] as string[],
      impacts: 0,
      slowImpacts: 0,
      pickGaps: [] as number[],
      hovering: 0,
      ticks: 0,
    };
    const sim = createSimulation(config, makeTestData(), [cadence]);
    while (!sim.state.finished) {
      const events = sim.step(NO_INPUT);
      const c = ctx as RunContext | null;
      if (c === null) throw new Error('the tick hook never ran');
      const ds = c.sys.drones;
      const now = c.now;
      run.ticks++;
      for (let k = 0; k < ds.memId.length; k++) {
        if (ds.memId[k] === memId[k] && ds.memUntil[k] === memUntil[k]) continue;
        run.writes++;
        if (live(memUntil[k] as number, now)) {
          run.liveOverwrites.push(`tick ${now}: entry ${k} (${memId[k]} until ${memUntil[k]})`);
        }
      }
      for (let s = 0; s < ds.count; s++) {
        if (ds.mode[s] === DRONE_HOVER) run.hovering++;
        if (ds.mode[s] !== DRONE_DASH) continue;
        const t = ds.target[s];
        if (t === null || t === undefined || ds.targetId[s] !== t.id) {
          run.dashWithoutTarget.push(`tick ${now}: slot ${s}`);
        }
      }
      for (let s = 0; s < ds.count; s++) {
        if (ds.nextPick[s] === nextPick[s]) continue;
        if ((lastPick[s] as number) >= 0) run.pickGaps.push(now - (lastPick[s] as number));
        lastPick[s] = now;
      }
      for (const hit of impacts(events)) {
        const s = hit.droneId - 1;
        const em = c.emitters[ds.owner[s] as number] as EmitterRuntime;
        const m = (c.build.values.attackSpeed / BASE_ATTACK_SPEED) * em.cadence;
        const key = `${hit.droneId}:${hit.targetId}`;
        const last = lastImpact.get(key);
        if (last !== undefined && now - last.tick < last.cooldown) {
          run.cooldownBroken.push(`tick ${now}: ${key} after ${last.tick}`);
        }
        lastImpact.set(key, { tick: now, cooldown: cooldownOf(m) });
        run.impacts++;
        if (cooldownOf(m) === DRONE_COOLDOWN_MAX) run.slowImpacts++;
      }
      memId = Array.from(ds.memId);
      memUntil = Array.from(ds.memUntil);
      nextPick = Array.from(ds.nextPick);
    }
    memo = run;
    return run;
  }

  it('never overwrites a live memory entry over 10,000 ticks of random cadence (D10, C5CHK-5)', () => {
    const run = randomRun();
    expect(run.ticks).toBe(10_000);
    expect(run.liveOverwrites).toEqual([]);
    expect(run.writes).toBeGreaterThan(300);
    expect(run.slowImpacts).toBeGreaterThan(30);
  });

  it('holds a target and its id in every DASH slot on every tick of that run (C5CHK4-1)', () => {
    expect(randomRun().dashWithoutTarget).toEqual([]);
  });

  it('keeps every drone off an enemy it impacted within its cooldown at that impact’s m, in that run', () => {
    const run = randomRun();
    expect(run.cooldownBroken).toEqual([]);
    expect(run.impacts).toBeGreaterThan(500);
  });

  it('never picks twice within PICK_TICKS for one drone in that run, though targets die and drones hover', () => {
    const run = randomRun();
    expect(Math.min(...run.pickGaps)).toBe(PICK_TICKS);
    expect(run.pickGaps.length).toBeGreaterThan(200);
    expect(run.hovering).toBeGreaterThan(0);
  });
});
