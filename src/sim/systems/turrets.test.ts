/**
 * Turrets (docs/v3 C5 design D11–D16, §4.1, §4.5, §5 part 2, §9's C5.4 oracles): their rows
 * and payloads (src/sim/emitters/drone.ts, turretPayload in src/sim/emitters/types.ts), their
 * firings in the drone stage (turretStep, src/sim/systems/drones.ts) and their shots' arrival
 * (stepHoming, src/sim/systems/shots.ts). Most tests run the drone stage, then the projectile
 * stage, on placed enemies, a tick at a time; the stage order goes through createSimulation.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { createRng, createStreams } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { DroneGrant, SourcedEmitter } from '../../data/emitters';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { PROJECTILE_CAP, SMALL_PROJECTILE_TICKS } from '../caps';
import { runEffect } from '../effects/execute';
import { CHAIN_JUMP, HIT_EVENT, PRIMARY, REPEAT, SIGNATURE } from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import { EVENT } from '../effects/types';
import { createPayload, ROWS } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { FOCUS_RANGE, pickTargetInGrid } from '../targeting';
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
  DRONE_FIXED,
  DRONE_KIND_DRONE,
  DRONE_KIND_TURRET,
  NO_INPUT,
} from '../types';
import type { SimEvent } from '../types';
import { focused, rollCount } from './context';
import type { Enemy, RunContext } from './context';
import { stepDrones } from './drones';
import { rebuildGrid } from './grid';
import { moveProjectiles } from './projectiles';
import { MOTION_HOMING, MOTION_STRAIGHT, spawnShot } from './shots';

type TurretFire = Extract<SimEvent, { type: 'turretFire' }>;

const SWARM: SignatureSpec = { id: 'swarm' };
/** The player's position. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** The turrets' distance from the player (DRONE_DEFAULTS.turretRadius), written out. */
const SEAT_RADIUS = 90;
/** The seat of an emitter's only turret when it has no drone: angle 0, right of the player. */
const SEAT = { x: P.x + SEAT_RADIUS, y: P.y };
/** A turret shot's hits' tags (F6), and its chain jumps' (jumpMask keeps the owner tag). */
const SHOT_TAGS = TAG.hit | TAG.minion | TAG.projectile;
const JUMP_TAGS = TAG.hit | TAG.chain | TAG.minion;
/** Damage 10 and no crits or ignites unless `values` say so: the hits draw nothing. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
/** An effect that touches no enemy and draws nothing. */
const HEAL: EffectSpec = { kind: 'heal', lifePct: 0.01 };
/** An idle trigger (never firing here) whose effect waits for the signature's next attack. */
const ONE_CHARGE: TriggerSpec = {
  on: 'periodic',
  every: 1000,
  do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.25, timing: 'nextAttack' }],
};

/** An enemy (dx, dy) from the player. */
const at = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...extra,
});
/** An enemy (dx, dy) from SEAT. */
const fromSeat = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: SEAT.x + dx,
  y: SEAT.y + dy,
  ...extra,
});

/** A test module that writes the swarm's counts. */
const counts =
  (drones: number, turrets: number): TestModule =>
  (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, { drones, turrets });
  };

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
  readonly grants?: readonly SourcedEmitter[];
}

/**
 * placedEnemies with the swarm signature at `swarm` [drones, turrets] (one turret and no drone
 * by default: slot 0, at SEAT) over NO_ROLLS; triggers credited to the center.
 */
function hive(
  placed: readonly PlacedEnemy[],
  options: Options & { readonly swarm?: readonly [number, number] } = {},
): RunContext {
  const [drones, turrets] = options.swarm ?? [0, 1];
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    rules: options.rules ?? [],
    modules: [counts(drones, turrets), ...(options.modules ?? [])],
    signature: SWARM,
  });
}

/** A drone grant of `turrets` turrets and no drone on outer.summon, with `fields`. */
const turretGrant = (
  turrets = 2,
  fields: Omit<DroneGrant, 'kind' | 'turrets'> = {},
): SourcedEmitter => ({ source: 'outer.summon', grant: { kind: 'drone', turrets, ...fields } });

/**
 * placedEnemies with M1's volley and `grants` ({turrets: 2} on outer.summon by default: slots 0
 * and 1, at SEAT and opposite it) over NO_ROLLS; triggers credited to outer.summon.
 */
function m1(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'outer.summon', spec })),
      conversions: [],
      emitters: options.grants ?? [turretGrant()],
    }),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
  });
}

/** The enemy with id `id` (placedEnemies numbers them 1, 2, … in order). */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
/** The emitter of slot `s`. */
const ownerOf = (ctx: RunContext, s: number): EmitterRuntime =>
  ctx.emitters[ctx.sys.drones.owner[s] as number] as EmitterRuntime;

const fires = (events: readonly SimEvent[]): TurretFire[] => eventsOf([events], 'turretFire');

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

/** The drone stage on the current tick with turret slot `s` due: its one firing's events. */
function fire(ctx: RunContext, s = 0): SimEvent[] {
  ctx.sys.drones.acc[s] = ownerOf(ctx, s).interval;
  return stage(ctx);
}

/** The next tick's projectile stage; returns its events. */
function fly(ctx: RunContext): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  rebuildGrid(ctx);
  ctx.events.length = 0;
  moveProjectiles(ctx);
  return ctx.events.slice();
}

/** The targets' ids of the pool's shots, in slot order. */
const shotTargets = (ctx: RunContext): (number | null)[] =>
  Array.from({ length: ctx.shots.count }, (_, s) => ctx.shots.target[s]?.id ?? null);

/** A twin of `rng` advanced until it stands where `rng` does; throws when it never does. */
function sync(twin: Rng, rng: Rng): void {
  for (let n = 0; n < 100_000; n++) {
    if (String(twin.snapshot()) === String(rng.snapshot())) return;
    twin.next();
  }
  throw new Error('the twin stream never meets the run’s');
}

interface SeenHit {
  readonly id: number;
  readonly k: number;
  readonly mask: number;
  readonly flags: number;
  readonly depth: number;
  readonly origin: number;
  readonly amount: number;
}

/** A hook that records every hit, in order. */
function watch(): { module: TestModule; hits: SeenHit[] } {
  const hits: SeenHit[] = [];
  const module: TestModule = (b) => {
    b.hook('onHit', (_ctx, hit) => {
      hits.push({
        id: hit.target.id,
        k: hit.chainIndex,
        mask: hit.mask,
        flags: hit.flags & (SIGNATURE | PRIMARY | REPEAT | CHAIN_JUMP),
        depth: hit.depth,
        origin: hit.origin,
        amount: toNumber(hit.amount),
      });
    });
  };
  return { module, hits };
}

/** A hook that counts the center events of each kind, and one that counts onAttack calls. */
function spies(): { module: TestModule; centers: number[]; attacks: number[] } {
  const centers: number[] = [];
  const attacks: number[] = [];
  const module: TestModule = (b) => {
    b.hook('onCenterEvent', (_ctx, ev) => void centers.push(ev.event));
    b.hook('onAttack', (_ctx, em) => void attacks.push(em.index));
  };
  return { module, centers, attacks };
}

/** Runs the build's first repeatAttack effect as a signature hit's trigger at depth 1, origin 9. */
function runRepeat(ctx: RunContext): void {
  const entry = createEffectEntry();
  entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === 'repeatAttack');
  entry.depth = 1;
  entry.origin = 9;
  entry.flags = SIGNATURE | HIT_EVENT;
  runEffect(ctx, entry);
}

describe('turret rows and payloads (§4.1, D16)', () => {
  it('seats the swarm’s turret between its drones: radius 90, angle π/D + 2πj/T, fixed, after the drones (D15, D16)', () => {
    const ctx = hive([], { swarm: [3, 1] });
    const ds = ctx.sys.drones;
    expect([ds.count, Array.from(ds.kind), Array.from(ds.owner), Array.from(ds.seat)]).toEqual([
      4,
      [DRONE_KIND_DRONE, DRONE_KIND_DRONE, DRONE_KIND_DRONE, DRONE_KIND_TURRET],
      [0, 0, 0, 0],
      [0, 1, 2, 0],
    ]);
    expect([ds.id[3], ds.mode[3], ds.acc[3], ds.targetId[3]]).toEqual([4, DRONE_FIXED, 0, -1]);
    expect(ds.x[3]).toBeCloseTo(P.x + SEAT_RADIUS * Math.cos(Math.PI / 3), 9);
    expect(ds.y[3]).toBeCloseTo(P.y + SEAT_RADIUS * Math.sin(Math.PI / 3), 9);
    // Two turrets between three drones, and a grant's three between its two drones.
    const two = hive([], { swarm: [3, 2], grants: [turretGrant(3, { drones: 2 })] });
    const ts = two.sys.drones;
    expect([Array.from(ts.kind), Array.from(ts.owner), Array.from(ts.seat)]).toEqual([
      [0, 0, 0, 1, 1, 0, 0, 1, 1, 1].map((k) => (k === 1 ? DRONE_KIND_TURRET : DRONE_KIND_DRONE)),
      [0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
      [0, 1, 2, 0, 1, 0, 1, 0, 1, 2],
    ]);
    const seats: [number, number][] = [
      [3, Math.PI / 3],
      [4, Math.PI / 3 + Math.PI],
      [7, Math.PI / 2],
      [8, Math.PI / 2 + (2 * Math.PI) / 3],
      [9, Math.PI / 2 + (4 * Math.PI) / 3],
    ];
    for (const [s, angle] of seats) {
      expect(ts.x[s], `slot ${s}`).toBeCloseTo(P.x + SEAT_RADIUS * Math.cos(angle), 9);
      expect(ts.y[s], `slot ${s}`).toBeCloseTo(P.y + SEAT_RADIUS * Math.sin(angle), 9);
      expect([ts.prevX[s], ts.prevY[s]]).toEqual([ts.x[s], ts.y[s]]);
    }
  });

  it('seats the turrets of an emitter without drones at angles 2πj/T: 0 and π for {turrets: 2}, finite (D16, C5CHK2-1)', () => {
    const ctx = m1([]);
    const ds = ctx.sys.drones;
    expect([ds.count, Array.from(ds.kind), Array.from(ds.owner), Array.from(ds.seat)]).toEqual([
      2,
      [DRONE_KIND_TURRET, DRONE_KIND_TURRET],
      [1, 1],
      [0, 1],
    ]);
    for (const v of [...ds.x, ...ds.y]) expect(Number.isFinite(v)).toBe(true);
    expect([ds.x[0], ds.y[0]]).toEqual([SEAT.x, SEAT.y]);
    expect(ds.x[1]).toBeCloseTo(P.x - SEAT_RADIUS, 9);
    expect(ds.y[1]).toBeCloseTo(P.y, 9);
    // The swarm without drones, too.
    const lone = hive([]);
    expect([lone.sys.drones.x[0], lone.sys.drones.y[0]]).toEqual([SEAT.x, SEAT.y]);
  });

  it('gives every drone emitter a turret payload: hit, minion and projectile, its source, the combat stream; SIGNATURE and the chain policy for the signature’s alone (IS6)', () => {
    const policy: TestModule = (b) => void (b.chainPolicy().branchFirst = 2);
    const ctx = hive([], { modules: [policy], grants: [turretGrant(1)] });
    const ds = ctx.sys.drones;
    const own = ds.turretPayload[0] as Payload;
    const granted = ds.turretPayload[1] as Payload;
    const swarm = ctx.emitters[0] as EmitterRuntime;
    expect([own.tags, own.flags, own.rng, own.chains, own.rollsAilments, own.canCrit]).toEqual([
      SHOT_TAGS,
      SIGNATURE,
      ctx.combatRng,
      true,
      true,
      true,
    ]);
    expect(own.source).toBe(ctx.build.sources.index('center'));
    expect(own.policy).not.toBeNull();
    expect([own.policy, own.general]).toEqual([swarm.payload.policy, true]);
    expect(granted.tags).toBe(SHOT_TAGS);
    expect([granted.flags, granted.policy, granted.general, granted.chains]).toEqual([
      0,
      null,
      false,
      false,
    ]);
    expect([granted.rng, granted.source]).toEqual([
      ctx.combatRng,
      ctx.build.sources.index('outer.summon'),
    ]);
    // Without a policy, the signature's carries none either.
    const plain = hive([]).sys.drones.turretPayload[0] as Payload;
    expect([plain.policy, plain.general]).toEqual([null, false]);
  });

  it('gives emitter 0’s turret shots SwarmParams.turretDamagePct of the damage stat, never its spec’s; a grant’s its own (C5CHK2-4)', () => {
    const share: TestModule = (b) => {
      const swarm = b.signature().swarm;
      if (swarm !== null) swarm.turretDamagePct = 0.6;
    };
    const baseOf = (ctx: RunContext, i: number): number =>
      toNumber((ctx.sys.drones.turretPayload[i] as Payload).baseDamage);
    const tuned = hive([], {
      modules: [share],
      grants: [turretGrant(1, { turretDamagePct: 0.25 }), turretGrant(1, { name: 'b' })],
    });
    expect(tuned.build.emitters[0]).toMatchObject({ kind: 'drone', turretDamagePct: 0.4 });
    expect([baseOf(tuned, 0), baseOf(tuned, 1), baseOf(tuned, 2)]).toEqual([6, 2.5, 4]);
    expect(baseOf(hive([]), 0)).toBe(4);
  });

  it('refuses the rows past the summon cap, turret rows after drone rows too, and counts them in summonCapped (D15)', () => {
    // The swarm's 3 drones and turret, then a grant's 20 drones and 4 turrets: 28 rows, 24 placed.
    const ctx = hive([], { swarm: [3, 1], grants: [turretGrant(4, { drones: 20 })] });
    const ds = ctx.sys.drones;
    expect([ds.count, ctx.counters.summonCapped]).toEqual([24, 4]);
    expect(Array.from(ds.kind).filter((k) => k === DRONE_KIND_TURRET)).toHaveLength(1);
    expect(Array.from(ds.owner).filter((owner) => owner === 1)).toHaveLength(20);
    // The swarm's own turret after 24 drones of its own.
    const full = hive([], { swarm: [24, 1] });
    expect([full.sys.drones.count, full.counters.summonCapped]).toEqual([24, 1]);
    expect(Array.from(full.sys.drones.kind).includes(DRONE_KIND_TURRET)).toBe(false);
  });

  it('keeps every row’s first pick in step past a turret row: a grant’s drones after the swarm’s turret pick first on ticks 1 and 11', () => {
    const ctx = hive([], { swarm: [3, 1], grants: [turretGrant(0, { drones: 2 })] });
    const ds = ctx.sys.drones;
    expect(Array.from(ds.kind)).toEqual([
      DRONE_KIND_DRONE,
      DRONE_KIND_DRONE,
      DRONE_KIND_DRONE,
      DRONE_KIND_TURRET,
      DRONE_KIND_DRONE,
      DRONE_KIND_DRONE,
    ]);
    // The turret's own entry, by the drones' rule from its seat, is never read.
    expect(Array.from(ds.nextPick)).toEqual([1, 11, 21, 1, 1, 11]);
  });
});

describe('turret firings (§4.5, D11)', () => {
  /** The ticks of slot 0's firings over ticks 1 .. last, one immortal enemy standing by. */
  function firingTicks(
    values: Partial<Record<StatId, number>>,
    last: number,
    setup: (ctx: RunContext) => void = () => undefined,
  ): number[] {
    const ctx = hive([at(-300, 0)], { values });
    setup(ctx);
    const ticks = fires(stage(ctx)).map(() => ctx.now);
    while (ctx.now < last) ticks.push(...fires(next(ctx)).map(() => ctx.now));
    return ticks;
  }
  const gaps = (ticks: readonly number[]): number[] =>
    ticks.slice(1).map((tick, k) => tick - (ticks[k] as number));

  it('fires twice a second at attackSpeed 4, the base: 20 firings in 600 ticks', () => {
    const ticks = firingTicks({ attackSpeed: 4 }, 600);
    expect(ticks).toHaveLength(20);
    expect(ticks[0]).toBe(30);
    expect(new Set(gaps(ticks))).toEqual(new Set([30]));
  });

  it('fires 30 times in 600 ticks at attackSpeed 6, every 20 ticks', () => {
    const ticks = firingTicks({ attackSpeed: 6 }, 600);
    expect(ticks).toHaveLength(30);
    expect(new Set(gaps(ticks))).toEqual(new Set([20]));
  });

  it('fires 34 times in 590 ticks at attackSpeed 7: its period of 120/7 ticks carries the fraction (PG15)', () => {
    const ticks = firingTicks({ attackSpeed: 7 }, 590);
    expect(ticks).toHaveLength(34);
    expect(ticks.slice(0, 4)).toEqual([18, 35, 52, 69]);
    expect(new Set(gaps(ticks))).toEqual(new Set([17, 18]));
  });

  it('fires every 10 ticks at cadence 3: the accumulator gains the emitter’s cadence a tick', () => {
    const ticks = firingTicks({ attackSpeed: 4 }, 100, (ctx) => {
      (ctx.emitters[0] as EmitterRuntime).cadence = 3;
    });
    expect(ticks).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it('never fires at attackSpeed 0, its interval Infinity, and keeps its state finite', () => {
    const ctx = hive([at(-300, 0)], { values: { attackSpeed: 0 } });
    expect(ownerOf(ctx, 0).interval).toBe(Infinity);
    let firings = fires(stage(ctx)).length;
    while (ctx.now < 600) firings += fires(next(ctx)).length;
    const ds = ctx.sys.drones;
    expect(firings).toBe(0);
    for (const v of [ds.acc[0], ds.x[0], ds.y[0]]) expect(Number.isFinite(v)).toBe(true);
    expect([ctx.shots.count, ctx.counters.projectilesCapped]).toEqual([0, 0]);
  });

  it('fires nothing and banks nothing while no enemy is alive, and fires once on the tick one appears', () => {
    const ctx = hive([at(-300, 0)]);
    const em = ownerOf(ctx, 0);
    enemy(ctx, 1).alive = false;
    rebuildGrid(ctx);
    const silent = fires(stage(ctx)).length;
    let later = 0;
    while (ctx.now < 100) later += fires(next(ctx)).length;
    expect([silent, later, ctx.shots.count, em.attacks]).toEqual([0, 0, 0, 0]);
    expect(ctx.sys.drones.acc[0]).toBe(em.interval - em.cadence);
    enemy(ctx, 1).alive = true;
    expect(fires(next(ctx))).toHaveLength(1);
    expect(ctx.now).toBe(101);
    let wait = 0;
    while (fires(next(ctx)).length === 0) wait++;
    expect([wait + 1, ctx.now]).toEqual([30, 131]);
  });

  it('fires the character’s projectileCount of shots: 1 for the swarm at base, 2 for a granted turret on M1 (C5CHK3-8)', () => {
    const placed = [fromSeat(200, 0), fromSeat(0, 200), fromSeat(-300, 0)];
    const swarm = hive(placed);
    expect(swarm.projectileCount).toBe(1);
    expect(fires(fire(swarm)).map((e) => e.count)).toEqual([1]);
    expect(swarm.shots.count).toBe(1);
    const granted = m1(placed);
    expect(granted.projectileCount).toBe(2);
    expect(fires(fire(granted)).map((e) => e.count)).toEqual([2]);
    expect(granted.shots.count).toBe(2);
  });

  it.each([1, 2, 2.5, 3.3])(
    'rolls projectileCount %d as rollCount does on twin streams, drawing nothing for a whole count (C5CHK3-4)',
    (pc) => {
      const placed = [1, 2, 3, 4, 5].map((k) => fromSeat(60 * k, 0));
      // The swarm fires projectileCount − 1 (F16).
      const ctx = hive(placed, { values: { projectileCount: pc + 1 } });
      expect(ctx.projectileCount).toBeCloseTo(pc, 12);
      const twin = createStreams(1).combat;
      sync(twin, ctx.combatRng);
      const before = rngPositions(ctx);
      const seen = new Set<number>();
      for (let k = 0; k < 40; k++) {
        const expected = rollCount(ctx.projectileCount, (chance) => twin.chance(chance));
        const [event] = fires(fire(ctx));
        expect(event?.count, `firing ${k}`).toBe(expected);
        expect(rngPositions(ctx).combat, `firing ${k}`).toEqual(twin.snapshot());
        seen.add(expected);
      }
      expect({ ...rngPositions(ctx), combat: null }).toEqual({ ...before, combat: null });
      if (Number.isInteger(pc)) {
        expect(rngPositions(ctx)).toEqual(before);
        expect([...seen]).toEqual([pc]);
      } else {
        expect([...seen].sort()).toEqual([Math.floor(pc), Math.floor(pc) + 1]);
      }
    },
  );

  it('sends each shot at an enemy of its own while there are enough, nearest to its seat first, then at the nearest again (CD4)', () => {
    // 1 nearest to the seat, then 2 and 3; 4 nearest to the player, the farthest from the seat.
    const placed = [fromSeat(50, 0), fromSeat(0, 80), fromSeat(0, -150), at(-100, 0)];
    const values = { projectileCount: 5 };
    const four = hive(placed, { values });
    fire(four);
    expect(shotTargets(four)).toEqual([1, 2, 3, 4]);
    const two = hive(placed.slice(0, 2), { values });
    fire(two);
    expect(shotTargets(two)).toEqual([1, 2, 1, 1]);
    const one = hive(placed.slice(0, 1), { values });
    fire(one);
    expect(shotTargets(one)).toEqual([1, 1, 1, 1]);
    // The firing's count is its shots, whatever their targets.
    expect(fires(fire(one)).map((e) => e.count)).toEqual([4]);
  });

  it('takes as its first target what pickTargetInGrid picks from its seat with the volley’s predicates, over 300 seeded fixtures (reference)', () => {
    const rng = createRng(5454);
    let differs = 0;
    let fired = 0;
    for (let f = 0; f < 300; f++) {
      const n = 1 + Math.floor(rng.next() * 8);
      const placed = Array.from({ length: n }, (): PlacedEnemy => {
        const r = rng.next();
        const type = r < 0.2 ? 'hexagon' : r < 0.3 ? 'boss' : 'square';
        // Half within 300 of the player, where the seat's offset counts; some beyond FOCUS_RANGE
        // of the player, some past the arena's edge.
        const dist = rng.next() < 0.5 ? 40 + rng.next() * 260 : 60 + rng.next() * 1000;
        const angle = rng.next() * 2 * Math.PI;
        return at(dist * Math.cos(angle), dist * Math.sin(angle), { type });
      });
      const ctx = hive(placed);
      for (const e of ctx.enemies) if (rng.next() < 0.2) e.alive = false;
      rebuildGrid(ctx);
      const alive = ctx.enemies.filter((e) => e.alive);
      const distSq = (e: Enemy): number => (e.x - SEAT.x) ** 2 + (e.y - SEAT.y) ** 2;
      const nearest = (list: readonly Enemy[]): Enemy | null =>
        list.reduce<Enemy | null>(
          (best, e) => (best === null || distSq(e) < distSq(best) ? e : best),
          null,
        );
      const expected =
        nearest(alive.filter((e) => focused(e) && ctx.shootable(e))) ??
        nearest(alive.filter((e) => ctx.shootable(e))) ??
        nearest(alive);
      expect(pickTargetInGrid(ctx.grid, SEAT.x, SEAT.y, ctx.shootable, focused)).toBe(expected);
      const fromPlayer = pickTargetInGrid(ctx.grid, P.x, P.y, ctx.shootable, focused);
      if (fromPlayer !== expected) differs++;
      const events = fires(fire(ctx));
      if (expected === null) {
        expect(events, `fixture ${f}`).toEqual([]);
        continue;
      }
      fired++;
      expect(
        events.map((e) => e.targetId),
        `fixture ${f}`,
      ).toEqual([expected.id]);
      expect(ctx.shots.target[0], `fixture ${f}`).toBe(expected);
    }
    // 291 fixtures fire, and in 34 the player's pick is another enemy.
    expect(fired).toBeGreaterThan(250);
    expect(differs).toBeGreaterThan(20);
  });

  it('puts a focus target first and sends the firing’s next shot past it while another enemy is worth a shot, else to it again (C5CR-2)', () => {
    // An elite 300 below the player (a focus target) and a square 60 from the seat: the square
    // is the nearer to the seat, the elite comes first.
    const elite = at(0, 300, { type: 'hexagon' });
    const values = { projectileCount: 3 };
    const both = hive([elite, fromSeat(60, 0)], { values });
    expect(focused(enemy(both, 1))).toBe(true);
    fire(both);
    expect(shotTargets(both)).toEqual([1, 2]);
    // Alone, it takes both shots: the fallback, the nearest alive enemy (targeting.ts).
    const alone = hive([elite], { values });
    expect(fires(fire(alone)).map((e) => [e.targetId, e.count])).toEqual([[1, 2]]);
    expect(shotTargets(alone)).toEqual([1, 1]);
  });

  it('takes as focus targets the elites near the player, not near its seat (CD17)', () => {
    // An elite FOCUS_RANGE + 5 right of the player, 715 from the seat, is none: the square 300
    // from the seat comes first.
    const far = hive([at(FOCUS_RANGE + 5, 0, { type: 'hexagon' }), fromSeat(0, 300)]);
    expect(focused(enemy(far, 1))).toBe(false);
    expect(fires(fire(far)).map((e) => e.targetId)).toEqual([2]);
    // An elite 790 left of the player, 880 from the seat, is one: it comes before the square 100
    // from the seat.
    const near = hive([at(-790, 0, { type: 'hexagon' }), fromSeat(0, 100)]);
    expect(focused(enemy(near, 1))).toBe(true);
    expect(fires(fire(near)).map((e) => e.targetId)).toEqual([1]);
  });

  it('fires homing shots of the pool from its seat: owner its emitter, its turret payload, 120 ticks to live, no inbound', () => {
    const ctx = hive([fromSeat(200, 0)]);
    const ds = ctx.sys.drones;
    const now = ctx.now;
    const events = fires(fire(ctx));
    const shots = ctx.shots;
    expect(shots.count).toBe(1);
    expect([
      shots.motion[0],
      shots.owner[0],
      shots.x[0],
      shots.y[0],
      shots.vx[0],
      shots.vy[0],
      shots.until[0],
      shots.scale[0],
      shots.pierce[0],
      shots.bounce[0],
      shots.depth[0],
      shots.origin[0],
      shots.round[0],
      shots.steady[0],
    ]).toEqual([
      MOTION_HOMING,
      0,
      SEAT.x,
      SEAT.y,
      0,
      0,
      now + SMALL_PROJECTILE_TICKS,
      1,
      1,
      0,
      0,
      -1,
      -1,
      0,
    ]);
    expect(shots.payload[0]).toBe(ds.turretPayload[0]);
    expect(shots.target[0]).toBe(enemy(ctx, 1));
    expect([enemy(ctx, 1).inbound, ctx.projectiles.length, ds.targetId[0]]).toEqual([0, 0, 1]);
    expect(events).toEqual([
      { type: 'turretFire', droneId: 1, x: SEAT.x, y: SEAT.y, targetId: 1, count: 1 },
    ]);
    // A granted turret's shots carry its emitter's index and payload.
    const granted = m1([fromSeat(200, 0)]);
    fire(granted, 1);
    expect([granted.shots.owner[0], granted.shots.owner[1]]).toEqual([1, 1]);
    expect(granted.shots.payload[0]).toBe(granted.sys.drones.turretPayload[1]);
    expect([granted.shots.x[0], granted.shots.y[0]]).toEqual([
      granted.sys.drones.x[1],
      granted.sys.drones.y[1],
    ]);
  });

  it('counts the shots a firing tried, a refused one too: at 511 live shots a 2-shot firing spawns 1 (C5CHK2-3)', () => {
    const ctx = hive([fromSeat(200, 0), fromSeat(0, 200)], { values: { projectileCount: 3 } });
    const filler = ctx.sys.drones.turretPayload[0] as Payload;
    for (let k = 0; k < PROJECTILE_CAP - 1; k++) {
      spawnShot(
        ctx,
        MOTION_STRAIGHT,
        0,
        0,
        0,
        0,
        10_000,
        filler,
        1,
        1,
        0,
        0,
        -1,
        false,
        -1,
        -1,
        null,
      );
    }
    expect([ctx.shots.count, ctx.counters.projectilesCapped]).toEqual([PROJECTILE_CAP - 1, 0]);
    const em = ownerOf(ctx, 0);
    const events = fires(fire(ctx));
    expect(events.map((e) => [e.targetId, e.count])).toEqual([[1, 2]]);
    expect([ctx.shots.count, ctx.state.shotCount, ctx.counters.projectilesCapped]).toEqual([
      PROJECTILE_CAP,
      PROJECTILE_CAP,
      1,
    ]);
    expect(ctx.shots.target[PROJECTILE_CAP - 1]).toBe(enemy(ctx, 1));
    // The firing still counts: one attack, two shots.
    expect([em.attacks, em.shots]).toEqual([1, 2]);
  });

  it('counts a signature firing as one attack and each shot as one shot (steadyAim, nthAttack); a granted firing counts nothing (D12, CD1)', () => {
    const placed = [fromSeat(200, 0), fromSeat(0, 200), fromSeat(0, -200)];
    const steadiness = (rules: readonly RuleSpec[]): boolean[][] => {
      const ctx = hive(placed, { values: { projectileCount: 3 }, rules });
      return [0, 1, 2].map(() => {
        const from = ctx.shots.count;
        fire(ctx);
        return Array.from(ctx.shots.steady.subarray(from, ctx.shots.count), (v) => v === 1);
      });
    };
    const steady = (counts: 'shot' | 'attack', everyNth: number): RuleSpec => ({
      id: 'steadyAim',
      everyNth,
      critMultiplierMore: 0,
      counts,
    });
    expect(steadiness([steady('shot', 3)])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
    expect(steadiness([steady('attack', 2)])).toEqual([
      [false, false],
      [true, true],
      [false, false],
    ]);
    const nthAttack: TriggerSpec = { on: 'nthAttack', every: 2, do: [HEAL] };
    const spy = spies();
    const ctx = hive(placed, {
      values: { projectileCount: 3 },
      triggers: [nthAttack],
      modules: [spy.module],
    });
    for (let k = 0; k < 4; k++) fire(ctx);
    const em = ownerOf(ctx, 0);
    const nth = (c: RunContext): number =>
      c.triggerState.count[
        (c.build.triggersOn[EVENT.nthAttack] as Int32Array)[0] as number
      ] as number;
    expect([em.attacks, em.shots, nth(ctx), spy.attacks]).toEqual([4, 8, 4, [0, 0, 0, 0]]);
    expect(ctx.effectQueue.size).toBe(2);
    // A granted turret: no attack, no shot, no onAttack hook, no nthAttack, never steady.
    const grantSpy = spies();
    const granted = m1(placed, {
      rules: [steady('shot', 1)],
      triggers: [{ on: 'nthAttack', every: 1, do: [HEAL] }],
      modules: [grantSpy.module],
    });
    for (let k = 0; k < 3; k++) fire(granted);
    const grantEm = ownerOf(granted, 0);
    expect(grantEm.index).toBe(1);
    expect([
      grantEm.attacks,
      grantEm.shots,
      (granted.emitters[0] as EmitterRuntime).attacks,
    ]).toEqual([0, 0, 0]);
    expect([nth(granted), grantSpy.attacks.length, granted.effectQueue.size]).toEqual([0, 0, 0]);
    expect(Array.from(granted.shots.steady.subarray(0, granted.shots.count))).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
  });

  it('counts a signature firing as an attack before it rolls its projectiles: onAttack sees the combat stream untouched (CD4)', () => {
    const before: unknown[] = [];
    const seen: unknown[] = [];
    const hook: TestModule = (b) =>
      void b.hook('onAttack', (c) => void seen.push(String(c.combatRng.snapshot())));
    const ctx = hive([fromSeat(200, 0), fromSeat(0, 200), fromSeat(0, -200)], {
      values: { projectileCount: 3.5 },
      modules: [hook],
    });
    for (let k = 0; k < 10; k++) {
      before.push(String(ctx.combatRng.snapshot()));
      fire(ctx);
      // Each firing drew its roll after the hook.
      expect(String(ctx.combatRng.snapshot())).not.toBe(before.at(-1));
    }
    expect(seen).toEqual(before);
  });

  it('follows a signature firing with the waiting repeats as impacts of no drone at the outermost enemy, never as more shots (CD14)', () => {
    const { module, hits } = watch();
    const spy = spies();
    // 1 is the seat's nearest, 2 the outermost.
    const ctx = hive([fromSeat(60, 0), at(-500, 0)], {
      triggers: [ONE_CHARGE],
      modules: [module, spy.module],
    });
    runRepeat(ctx);
    expect(ctx.sys.repeat.charges.count).toBe(1);
    const events = fire(ctx);
    expect(ctx.sys.repeat.charges.count).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['turretFire', 'hit', 'impact']);
    expect(eventsOf([events], 'impact')).toEqual([
      expect.objectContaining({ droneId: -1, targetId: 2 }),
    ]);
    expect(hits.map((hit) => [hit.id, hit.flags])).toEqual([[2, SIGNATURE | REPEAT | PRIMARY]]);
    expect(spy.centers.filter((event) => event === EVENT.droneImpact)).toEqual([]);
    // One attack and its one shot, the firing's: the repeat fired no shot and counted nothing.
    expect(ctx.shots.count).toBe(1);
    expect([ownerOf(ctx, 0).attacks, ownerOf(ctx, 0).shots]).toEqual([1, 1]);
  });

  it('leaves the repeats waiting after a granted turret’s firing: they wait for the signature’s own attack', () => {
    const ctx = m1([fromSeat(60, 0), at(-500, 0)], { triggers: [ONE_CHARGE] });
    runRepeat(ctx);
    expect(ctx.sys.repeat.charges.count).toBe(1);
    const events = fire(ctx);
    expect(fires(events)).toHaveLength(1);
    expect(ctx.sys.repeat.charges.count).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['turretFire']);
    expect([ctx.projectiles.length, ctx.shots.count]).toEqual([0, 2]);
  });

  it('fires every firing its accumulator holds in one tick, each picking its targets afresh: two a tick at attackSpeed 240 (§4.5’s while)', () => {
    // 1 and 2 are the seat's nearest, 3 and 4 farther.
    const placed = [fromSeat(50, 0), fromSeat(0, 80), fromSeat(0, -150), fromSeat(-300, 0)];
    const ctx = hive(placed, { values: { attackSpeed: 240, projectileCount: 3 } });
    const em = ownerOf(ctx, 0);
    expect(em.interval).toBe(0.5);
    expect(fires(stage(ctx)).map((e) => [e.targetId, e.count])).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(shotTargets(ctx)).toEqual([1, 2, 1, 2]);
    expect([em.attacks, em.shots, ctx.sys.drones.acc[0]]).toEqual([2, 4, 0]);
    // No firing's picks outlive it: the next tick's two pick the same enemies again.
    expect(fires(next(ctx)).map((e) => e.targetId)).toEqual([1, 1]);
    expect(shotTargets(ctx).slice(4)).toEqual([1, 2, 1, 2]);
  });

  it('follows each firing of a tick with the repeats waiting for it, before the tick’s next firing (CD14)', () => {
    const ctx = hive([fromSeat(60, 0), at(-500, 0)], {
      values: { attackSpeed: 240 },
      triggers: [ONE_CHARGE],
    });
    runRepeat(ctx);
    expect(ctx.sys.repeat.charges.count).toBe(1);
    const events = stage(ctx);
    expect(events.map((e) => e.type)).toEqual(['turretFire', 'hit', 'impact', 'turretFire']);
    expect(ctx.sys.repeat.charges.count).toBe(0);
  });

  it('lets each turret of a tick pick for itself: a second turret’s later shot may go where the first’s did', () => {
    // M1's {turrets: 2}: slot 0 at SEAT, slot 1 opposite. 1 is slot 0's nearest and 3 slot 1's; 2,
    // below the player, is both seats' second nearest; 4 is farther from both.
    const ctx = m1([fromSeat(40, 0), at(0, 60), at(-SEAT_RADIUS - 40, 0), at(0, -200)]);
    const ds = ctx.sys.drones;
    ds.acc[0] = ownerOf(ctx, 0).interval;
    ds.acc[1] = ownerOf(ctx, 1).interval;
    expect(fires(stage(ctx)).map((e) => [e.droneId, e.targetId, e.count])).toEqual([
      [1, 1, 2],
      [2, 3, 2],
    ]);
    expect(shotTargets(ctx)).toEqual([1, 2, 3, 2]);
  });

  it('gains its own emitter’s cadence, not the signature’s: a granted turret at cadence 3 beside M1’s volley at 1 fires every 10 ticks', () => {
    const ctx = m1([fromSeat(200, 0)]);
    (ctx.emitters[1] as EmitterRuntime).cadence = 3;
    const ticks: number[] = [];
    const record = (events: readonly SimEvent[]): void => {
      for (const e of fires(events)) if (e.droneId === 1) ticks.push(ctx.now);
    };
    record(stage(ctx));
    while (ctx.now < 60) record(next(ctx));
    expect(ticks).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('sends a firing’s later shots to the other focus targets first, then to the nearest (F24)', () => {
    // Two elites near the player and a square 60 from the seat, the seat's nearest enemy.
    const placed = [
      at(0, 300, { type: 'hexagon' }),
      at(0, -350, { type: 'hexagon' }),
      fromSeat(60, 0),
    ];
    const ctx = hive(placed, { values: { projectileCount: 4 } });
    expect([1, 2, 3].map((id) => focused(enemy(ctx, id)))).toEqual([true, true, false]);
    fire(ctx);
    expect(shotTargets(ctx)).toEqual([1, 2, 3]);
  });

  it('picks each firing’s first target afresh: the nearest again, whatever the firing before picked (§4.5)', () => {
    const ctx = hive([fromSeat(50, 0), fromSeat(0, 80), fromSeat(0, -150)], {
      values: { projectileCount: 3 },
    });
    const events = [...fires(fire(ctx)), ...fires(fire(ctx))];
    expect(events.map((e) => [e.targetId, e.count])).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(shotTargets(ctx)).toEqual([1, 2, 1, 2]);
  });

  it('picks a firing’s later targets from its seat, not from its first target (§4.5)', () => {
    // From the seat 1 is 60 away, 2 100 and 3 130; from 1, 3 is the nearer (70 against 117).
    const ctx = hive([fromSeat(60, 0), fromSeat(0, 100), fromSeat(130, 0)], {
      values: { projectileCount: 4 },
    });
    fire(ctx);
    expect(shotTargets(ctx)).toEqual([1, 2, 3]);
  });

  it('keeps its firing’s first target as the slot’s targetId and the event’s, whatever the later shots’ (§4.5)', () => {
    const ctx = hive([fromSeat(50, 0), fromSeat(0, 80), fromSeat(0, -150)], {
      values: { projectileCount: 4 },
    });
    const events = fires(fire(ctx));
    expect(shotTargets(ctx)).toEqual([1, 2, 3]);
    expect(events.map((e) => [e.targetId, e.count])).toEqual([[1, 3]]);
    expect(ctx.sys.drones.targetId[0]).toBe(1);
  });

  it('fires each turret with its own emitter’s payload: a granted turret beside the swarm’s fires the grant’s, counts nothing and lands plain (D12, D14)', () => {
    const { module, hits } = watch();
    // Slot 0 the swarm's turret, slot 1 a {turrets: 1} grant's, both at SEAT; 1 within a step.
    const ctx = hive([fromSeat(30, 0)], { grants: [turretGrant(1)], modules: [module] });
    const ds = ctx.sys.drones;
    expect([Array.from(ds.owner), Array.from(ds.kind)]).toEqual([
      [0, 1],
      [DRONE_KIND_TURRET, DRONE_KIND_TURRET],
    ]);
    const swarm = ctx.emitters[0] as EmitterRuntime;
    const grant = ctx.emitters[1] as EmitterRuntime;
    // The granted turret fires alone: its emitter's payload and index, no attack counted.
    expect(fires(fire(ctx, 1)).map((e) => [e.droneId, e.count])).toEqual([[2, 1]]);
    expect([ctx.shots.count, ctx.shots.owner[0]]).toEqual([1, 1]);
    expect(ctx.shots.payload[0]).toBe(ds.turretPayload[1]);
    expect([swarm.attacks, swarm.shots, grant.attacks, grant.shots]).toEqual([0, 0, 0, 0]);
    fly(ctx);
    expect(hits.map((hit) => [hit.id, hit.flags])).toEqual([[1, 0]]);
    // Then the swarm's: the signature's payload, one attack and one shot, a PRIMARY arrival.
    hits.length = 0;
    expect(fires(fire(ctx, 0)).map((e) => [e.droneId, e.count])).toEqual([[1, 1]]);
    expect([ctx.shots.count, ctx.shots.owner[0]]).toEqual([1, 0]);
    expect(ctx.shots.payload[0]).toBe(ds.turretPayload[0]);
    expect([swarm.attacks, swarm.shots, grant.attacks, grant.shots]).toEqual([1, 1, 0, 0]);
    fly(ctx);
    expect(hits.map((hit) => [hit.id, hit.flags])).toEqual([[1, SIGNATURE | PRIMARY]]);
  });
});

describe('turret shots’ arrival (§4.5, stepHoming)', () => {
  it('lands a signature turret’s shot as an attack: PRIMARY on its target, then its chain, counted in chainHitsPeak (chainAttack)', () => {
    const { module, hits } = watch();
    // 1 within a step of the seat; 2 100 beyond it, in chain range.
    const ctx = hive([fromSeat(30, 0), fromSeat(130, 0)], {
      values: { chainCount: 1 },
      modules: [module],
    });
    fire(ctx);
    const serial = ctx.attackSerial;
    const events = fly(ctx);
    expect(hits.map((hit) => [hit.id, hit.k, hit.mask, hit.flags])).toEqual([
      [1, 0, SHOT_TAGS, SIGNATURE | PRIMARY],
      [2, 1, JUMP_TAGS, SIGNATURE | CHAIN_JUMP],
    ]);
    expect(eventsOf([events], 'hit').map((hit) => hit.targetId)).toEqual([1, 2]);
    expect([ctx.attackSerial, ctx.chainBudget.hits, ctx.counters.chainHitsPeak]).toEqual([
      serial + 1,
      2,
      2,
    ]);
    expect(ctx.shots.count).toBe(0);
    // Without a chain count, its primary hit alone.
    hits.length = 0;
    const plain = hive([fromSeat(30, 0), fromSeat(130, 0)], { modules: [module] });
    fire(plain);
    fly(plain);
    expect(hits.map((hit) => [hit.id, hit.flags])).toEqual([[1, SIGNATURE | PRIMARY]]);
  });

  it('lands a granted turret’s shot as a plain hit: no PRIMARY, no chain, no attack, no nthAttack (CD1)', () => {
    const { module, hits } = watch();
    const spy = spies();
    const ctx = m1([fromSeat(30, 0), fromSeat(130, 0)], {
      values: { chainCount: 1, projectileCount: 1 },
      triggers: [
        { on: 'hit', when: [{ hitIs: 'primary' }], do: [HEAL] },
        { on: 'nthAttack', every: 1, do: [HEAL] },
      ],
      modules: [module, spy.module],
    });
    fire(ctx);
    const serial = ctx.attackSerial;
    fly(ctx);
    expect(hits.map((hit) => [hit.id, hit.k, hit.mask, hit.flags, hit.amount])).toEqual([
      [1, 0, SHOT_TAGS, 0, 4],
    ]);
    expect([ctx.attackSerial, ctx.effectQueue.size, spy.attacks.length]).toEqual([serial, 0, 0]);
    expect(ctx.shots.count).toBe(0);
  });

  it('lands an effect’s homing shot as before: a plain hit at its scale, a signature payload’s too (owner −1)', () => {
    const { module, hits } = watch();
    const ctx = hive([fromSeat(30, 0), fromSeat(130, 0)], {
      values: { chainCount: 1 },
      modules: [module],
    });
    const effect = createPayload({
      baseDamage: num(8),
      tags: TAG.hit | TAG.projectile,
      source: 0,
      flags: 0,
      rng: ctx.effectsRng,
      chains: false,
      rollsAilments: true,
      canCrit: true,
      damageMode: ROWS,
    });
    const target = enemy(ctx, 1);
    const until = ctx.now + SMALL_PROJECTILE_TICKS;
    const signature = ctx.sys.drones.turretPayload[0] as Payload;
    spawnShot(
      ctx,
      MOTION_HOMING,
      SEAT.x,
      SEAT.y,
      0,
      0,
      until,
      effect,
      0.5,
      1,
      0,
      2,
      7,
      false,
      -1,
      -1,
      target,
    );
    spawnShot(
      ctx,
      MOTION_HOMING,
      SEAT.x,
      SEAT.y,
      0,
      0,
      until,
      signature,
      0.5,
      1,
      0,
      2,
      7,
      false,
      -1,
      -1,
      target,
    );
    const serial = ctx.attackSerial;
    fly(ctx);
    expect(
      hits.map((hit) => [hit.id, hit.k, hit.flags, hit.depth, hit.origin, hit.amount]),
    ).toEqual([
      [1, 0, 0, 2, 7, 4],
      [1, 0, SIGNATURE, 2, 7, 2],
    ]);
    expect([ctx.attackSerial, ctx.counters.chainHitsPeak]).toEqual([serial, 0]);
  });

  it('raises no droneImpact for a turret’s firing or its shots’ hits (D13)', () => {
    const spy = spies();
    const { module, hits } = watch();
    const ctx = hive([fromSeat(30, 0), fromSeat(0, 120)], {
      values: { projectileCount: 3 },
      triggers: [{ on: 'droneImpact', do: [HEAL] }],
      modules: [spy.module, module],
    });
    fire(ctx);
    for (let t = 0; t < 10; t++) fly(ctx);
    expect(hits.map((hit) => hit.id)).toEqual([1, 2]);
    expect(spy.centers.filter((event) => event === EVENT.droneImpact)).toEqual([]);
    const raised = (ctx.build.triggersOn[EVENT.droneImpact] as Int32Array)[0] as number;
    expect([ctx.triggerState.count[raised], ctx.effectQueue.size]).toEqual([0, 0]);
  });

  it('lands a steady shot as a crit, its chain jumps too: steadyAim’s every-Nth shot carries to the arrival', () => {
    const crits: [number, number, boolean][] = [];
    const hook: TestModule = (b) =>
      void b.hook(
        'onHit',
        (_ctx, hit) => void crits.push([hit.target.id, hit.chainIndex, hit.crit]),
      );
    const steadyAim: RuleSpec = {
      id: 'steadyAim',
      everyNth: 1,
      critMultiplierMore: 0,
      counts: 'shot',
    };
    // No crit chance: only a steady shot crits.
    const ctx = hive([fromSeat(30, 0), fromSeat(130, 0)], {
      values: { chainCount: 1 },
      rules: [steadyAim],
      modules: [hook],
    });
    fire(ctx);
    expect(ctx.shots.steady[0]).toBe(1);
    fly(ctx);
    expect(crits).toEqual([
      [1, 0, true],
      [2, 1, true],
    ]);
  });

  it('turns a signature turret’s shot whose target died to the alive enemy nearest the shot, not by the turret’s picker, and lands it there as the attack (D11, §4.5)', () => {
    const { module, hits } = watch();
    // 1 straight out from the seat, 2 beside its path; 3 an elite near the player, a focus
    // target, alive only once the shot is on its way.
    const ctx = hive([fromSeat(300, 0), fromSeat(280, 150), at(-110, 0, { type: 'hexagon' })], {
      modules: [module],
    });
    const elite = enemy(ctx, 3);
    elite.alive = false;
    rebuildGrid(ctx);
    expect(fires(fire(ctx)).map((e) => e.targetId)).toEqual([1]);
    for (let t = 0; t < 60 && (ctx.shots.x[0] as number) < SEAT.x + 200; t++) fly(ctx);
    expect([ctx.shots.count, (ctx.shots.x[0] as number) >= SEAT.x + 200]).toEqual([1, true]);
    // 1 dies on the way; the elite comes in at least 400 from the shot, 2 at most 170 from it.
    enemy(ctx, 1).alive = false;
    elite.alive = true;
    expect(focused(elite)).toBe(true);
    for (let t = 0; t < 60 && hits.length === 0; t++) fly(ctx);
    expect(hits.map((hit) => [hit.id, hit.flags])).toEqual([[2, SIGNATURE | PRIMARY]]);
    expect(ctx.shots.count).toBe(0);
  });
});

describe('turrets in a run (§5)', () => {
  it('moves a turret shot on the tick it is fired: the drone stage runs before the projectiles (§5, part 2; PG8)', () => {
    let ctx: RunContext | null = null;
    let firstId = 0;
    // The tick hooks run after the emitters, before the drone stage.
    const capture: TestModule = (b) =>
      void b.hook('tick', (c) => {
        ctx = c;
        firstId = c.nextProjectileId;
      });
    const config = makeConfig({
      seed: 3,
      startWave: 5,
      maxTicks: 900,
      signature: SWARM,
      stats: makeStats({ damage: 2, maxLife: 1e12, attackSpeed: 6 }),
    });
    const sim = createSimulation(config, makeTestData(), [capture]);
    let firings = 0;
    let moved = 0;
    while (!sim.state.finished) {
      const events = sim.step(NO_INPUT);
      const c = ctx as RunContext | null;
      if (c === null) throw new Error('the tick hook never ran');
      firings += fires(events).length;
      const ds = c.sys.drones;
      const turret = Array.from(ds.kind).indexOf(DRONE_KIND_TURRET);
      const shots = c.shots;
      for (let s = 0; s < shots.count; s++) {
        if ((shots.id[s] as number) < firstId || shots.owner[s] !== 0) continue;
        // In flight after its first move: one projectileStep from the seat.
        const dist = Math.hypot(
          (shots.x[s] as number) - (ds.x[turret] as number),
          (shots.y[s] as number) - (ds.y[turret] as number),
        );
        expect(dist, `tick ${c.now}`).toBeCloseTo(c.projectileStep, 6);
        moved++;
      }
    }
    // 45 firings, 42 of whose shots are seen in flight (the others arrived at once).
    expect(firings).toBeGreaterThan(40);
    expect(moved).toBeGreaterThan(35);
  });
});
