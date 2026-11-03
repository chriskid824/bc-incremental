/**
 * FL's drone flight (lead rulings F1–F3, FL-R1 and FL-R2; docs/v3/game-design-v3.md:643, 刃翼
 * 「撞擊時沿飛行方向畫一條必定暴擊的斬擊線」): the heading a drone's dash writes (DronePool.hx, hy),
 * its reset at the dock and its carry through a compaction, the droneImpact event's value
 * (flightAngle) and when it is computed, and slashLine toward 'flight', which reads that value. Most tests run the drone stage
 * on placed enemies with the swarm signature, whose drones alone raise droneImpact, and a hook
 * that records each droneImpact's value; each test names in a comment the planted bug it kills.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { toNumber } from '../../core/num';
import type { SourcedEmitter } from '../../data/emitters';
import type { BuildFlags } from '../build/compile';
import type { SignatureSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import type { EffectSpec, SpawnDroneSpec, TriggerSpec } from '../../data/triggers';
import { DRONE_MEMORY } from '../caps';
import { runEffect, runEffectQueue } from '../effects/execute';
import { createEffectEntry } from '../effects/queue';
import { EVENT } from '../effects/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { eventsOf, makeStats, placedEnemies } from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_DASH,
  DRONE_DOCKED,
  DRONE_KIND_DRONE,
  DRONE_KIND_SPIRIT,
  DRONE_KIND_TURRET,
  DRONE_RETURN,
} from '../types';
import type { SimEvent } from '../types';
import type { Enemy, RunContext } from './context';
import { impactAt, stepDrones, swarmRepeat } from './drones';
import { rebuildGrid } from './grid';
import { moveEnemies } from './movement';
import { NEVER_LEAVES } from './systemState';

type ImpactEvent = Extract<SimEvent, { type: 'impact' }>;
type HitEvent = Extract<SimEvent, { type: 'hit' }>;
type SlashEvent = Extract<SimEvent, { type: 'slash' }>;

/** The player, at the arena's centre. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** The dock of a lone swarm drone: angle 0, DRONE_DEFAULTS.dockRadius 43 right of the player. */
const DOCK = { x: P.x + 43, y: P.y };
/** Most tests' target, off both axes from the player, so no approach of theirs runs outward. */
const T = { x: P.x + 250, y: P.y + 150 };
/** The angle from the player to T: the outward angle there. */
const OUTWARD = Math.atan2(150, 250);
/** A tick no pick of these tests reaches: the slot it is written on stays where it is. */
const NEVER = 1e9;
const SWARM: SignatureSpec = { id: 'swarm' };
/** An effect that touches no enemy and draws nothing. */
const HEAL: EffectSpec = { kind: 'heal', lifePct: 0.01 };
/** A droneImpact listener that does nothing to the run. */
const LISTEN: TriggerSpec = { on: 'droneImpact', do: [HEAL] };
/** An idle trigger (never firing here) holding a repeat of the swarm (swarm.test.ts' idiom). */
const IDLE_REPEAT: TriggerSpec = {
  on: 'periodic',
  every: 1000,
  do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }],
};
/** A trigger that never fires here (no enemy reaches the player): it holds a spawnDrone spec. */
const holder = (fields: Partial<SpawnDroneSpec> = {}): TriggerSpec => ({
  on: 'heroHit',
  do: [{ kind: 'spawnDrone', lifeSec: 4, damagePct: 1, ...fields }],
});
/** A test module writing `flags` over the build's: what B1's modules will do. */
const policy =
  (flags: Partial<BuildFlags>): TestModule =>
  (b) =>
    void Object.assign(b.flags, flags);

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  readonly grants?: readonly SourcedEmitter[];
  readonly modules?: readonly TestModule[];
  /** The swarm's drones and turrets: one drone and no turret unless given. */
  readonly swarm?: readonly [number, number];
  /** The onCenterEvent hook that records the droneImpacts (`seen`): on unless false. */
  readonly hook?: boolean;
}

/** A droneImpact center event as its hooks saw it. */
interface Seen {
  readonly target: number | null;
  readonly value: number;
}

/**
 * placedEnemies with the swarm signature, damage 10 and no crits or ignites unless `values` say
 * so; `seen` collects every droneImpact the hook sees, with its value as a number.
 */
function hive(
  placed: readonly PlacedEnemy[],
  options: Options = {},
): { ctx: RunContext; seen: Seen[] } {
  const seen: Seen[] = [];
  const [drones, turrets] = options.swarm ?? [1, 0];
  const counts: TestModule = (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, { drones, turrets });
  };
  const spy: TestModule = (b) =>
    void b.hook('onCenterEvent', (_ctx, ev) => {
      if (ev.event === EVENT.droneImpact) {
        seen.push({ target: ev.target?.id ?? null, value: toNumber(ev.value) });
      }
    });
  const ctx = placedEnemies(placed, {
    stats: makeStats({ damage: 10, critChance: 0, igniteChance: 0, ...options.values }, [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    rules: [],
    modules: [counts, ...(options.hook === false ? [] : [spy]), ...(options.modules ?? [])],
    signature: SWARM,
  });
  return { ctx, seen };
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const impacts = (events: readonly SimEvent[]): ImpactEvent[] => eventsOf([events], 'impact');
const hits = (events: readonly SimEvent[]): HitEvent[] => eventsOf([events], 'hit');
const slashes = (events: readonly SimEvent[]): SlashEvent[] => eventsOf([events], 'slash');
/** The swarm's emitter, the signature's. */
const swarmOf = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;
/** Slot s's heading, [hx, hy]. */
const headingOf = (ctx: RunContext, s: number): [number, number] => [
  ctx.sys.drones.hx[s] as number,
  ctx.sys.drones.hy[s] as number,
];

/** Runs the drone stage on the current tick; returns its events. */
function stage(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepDrones(ctx);
  return ctx.events.slice();
}

/** The next tick's drone stage, the enemies standing where they are (or `walk`: moving first). */
function next(ctx: RunContext, walk = false): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  if (walk) moveEnemies(ctx);
  rebuildGrid(ctx);
  return stage(ctx);
}

/** Puts slot s at (x, y), dashing at `target`: what engage leaves, from there. */
function dashFrom(ctx: RunContext, s: number, target: Enemy, x: number, y: number): void {
  const ds = ctx.sys.drones;
  ds.x[s] = x;
  ds.y[s] = y;
  ds.mode[s] = DRONE_DASH;
  ds.target[s] = target;
  ds.targetId[s] = target.id;
}

/** The next ticks' drone stages until one impacts; returns that tick's events. */
function untilImpact(ctx: RunContext, walk = false, limit = 300): SimEvent[] {
  for (let n = 0; n < limit; n++) {
    const events = next(ctx, walk);
    if (impacts(events).length > 0) return events;
  }
  throw new Error('no impact');
}

/** The repeat payload of the build's first repeatAttack effect (RunContext.sys.repeat). */
function repeatPayloadOf(ctx: RunContext): Payload {
  const effect = ctx.build.effects.findIndex((fx) => fx.kind === 'repeatAttack');
  return ctx.sys.repeat.payloads[effect] as Payload;
}

/** Runs the build's first spawnDrone effect through its executor on the current tick at `point`. */
function spawn(ctx: RunContext, point: { readonly x: number; readonly y: number }): void {
  const entry = createEffectEntry();
  entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === 'spawnDrone');
  entry.depth = 1;
  entry.origin = -1;
  entry.x = point.x;
  entry.y = point.y;
  runEffect(ctx, entry);
}

describe('the heading (lead ruling F1) and the droneImpact value (F2)', () => {
  /** Five starts 200 from T (the diagonal's 199.8): [side, dx, dy] from T. */
  const SIDES: readonly (readonly [string, number, number])[] = [
    ['the left', -200, 0],
    ['the right', 200, 0],
    ['above', 0, -200],
    ['below', 0, 200],
    ['a diagonal', -170, 105],
  ];

  it.each(SIDES)(
    'impacts from %s with the angle of its approach, to 1e-12, its heading the last outside tick’s',
    (_side, dx, dy) => {
      // Planted bugs: hx and hy swapped; the angle negated or atan2's arguments swapped; the
      // heading never written on the arrival tick (it would be the tick before's, 30 to 40 long).
      const { ctx, seen } = hive([T]);
      dashFrom(ctx, 0, enemy(ctx, 1), T.x + dx, T.y + dy);
      const theta = Math.atan2(0 - dy, 0 - dx);
      untilImpact(ctx);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.target).toBe(1);
      expect(seen[0]?.value).toBeCloseTo(theta, 12);
      expect(Math.abs((seen[0]?.value as number) - OUTWARD)).toBeGreaterThan(0.1);
      const [hx, hy] = headingOf(ctx, 0);
      expect(Math.atan2(hy, hx)).toBeCloseTo(theta, 12);
      // Unnormalised: the arrival tick starts within a step (10) of the target's edge (20).
      expect(Math.hypot(hx, hy)).toBeGreaterThan(20);
      expect(Math.hypot(hx, hy)).toBeLessThanOrEqual(30 + 1e-9);
    },
  );

  it('writes the arrival tick’s heading when it snaps in from just outside: (0, −28), −π/2', () => {
    // Planted bugs: the heading never written on the arrival tick; the value computed with the
    // position after the snap (0, 0), which would fall back on the outward angle.
    const { ctx, seen } = hive([T]);
    dashFrom(ctx, 0, enemy(ctx, 1), T.x, T.y + 28);
    expect(impacts(next(ctx))).toHaveLength(1);
    expect(headingOf(ctx, 0)).toEqual([0, -28]);
    expect(seen).toEqual([{ target: 1, value: -Math.PI / 2 }]);
  });

  it('keeps the heading while the drone rides its target through its cooldown memory, the target shaking within its body', () => {
    // Planted bug: the heading written on riding ticks (dist ≤ radius): each later impact would
    // carry the last shake, (0, ±3), at ±π/2.
    const { ctx, seen } = hive([T]);
    const t = enemy(ctx, 1);
    dashFrom(ctx, 0, t, T.x - 25, T.y);
    untilImpact(ctx);
    const ds = ctx.sys.drones;
    for (let n = 0; n < 100 && ds.mode[0] === DRONE_DASH; n++) {
      t.y = T.y + (n % 2 === 0 ? 3 : -3);
      next(ctx);
    }
    // The sortie's three impacts, 30 ticks apart, all at its approach's angle, 0.
    expect(seen.map((e) => e.value)).toEqual([0, 0, 0]);
    expect(headingOf(ctx, 0)).toEqual([25, 0]);
    expect(ds.mode[0]).toBe(DRONE_RETURN);
  });

  it('keeps it through 蟲海’s re-rams (dronesStay): every impact on the target it stays on carries its approach', () => {
    // Planted bugs: the heading written on riding ticks; a repick or engage that clears it (the
    // impacts after the first refill would carry the outward angle).
    const { ctx, seen } = hive([T], { modules: [policy({ dronesStay: true })] });
    const t = enemy(ctx, 1);
    dashFrom(ctx, 0, t, T.x, T.y - 25);
    const ds = ctx.sys.drones;
    for (let n = 0; n < 240; n++) {
      if (n > 0) t.y = T.y + (n % 2 === 0 ? 3 : -3);
      next(ctx);
      expect(ds.mode[0], `tick ${ctx.now}`).not.toBe(DRONE_RETURN);
    }
    // Two sorties and more, each refilled at once on the same target.
    expect(seen.length).toBeGreaterThanOrEqual(7);
    expect(seen.every((e) => e.target === 1 && e.value === Math.PI / 2)).toBe(true);
    expect(headingOf(ctx, 0)).toEqual([0, 25]);
  });

  it('docks with no heading, and a relaunched drone carries its new sortie’s approach, or the outward angle with none', () => {
    // Planted bug: the docking reset missing: the relaunch at an enemy on its dock, which it never
    // flies in to, would carry the first sortie's heading (25, 0), at 0.
    const ON_DOCK = { x: DOCK.x, y: DOCK.y + 12 };
    const FAR = { x: P.x - 300, y: P.y + 200 };
    const CASES: readonly (readonly [PlacedEnemy, number])[] = [
      [ON_DOCK, Math.atan2(12, 43)],
      [FAR, Math.atan2(FAR.y - DOCK.y, FAR.x - DOCK.x)],
    ];
    for (const [second, expected] of CASES) {
      // T dies to the first impact, so the relaunch picks the second enemy.
      const { ctx, seen } = hive([{ ...T, hp: 1 }, second]);
      const ds = ctx.sys.drones;
      expect([ds.dockX[0], ds.dockY[0]]).toEqual([DOCK.x, DOCK.y]);
      dashFrom(ctx, 0, enemy(ctx, 1), T.x - 25, T.y);
      ds.impactsLeft[0] = 1;
      untilImpact(ctx);
      expect(ds.mode[0]).toBe(DRONE_RETURN);
      // Flying home keeps it; docking clears it.
      for (let n = 0; n < 100 && ds.mode[0] !== DRONE_DOCKED; n++) {
        next(ctx);
        if (ds.mode[0] === DRONE_RETURN) expect(headingOf(ctx, 0)).toEqual([25, 0]);
      }
      expect([ds.mode[0], ...headingOf(ctx, 0)]).toEqual([DRONE_DOCKED, 0, 0]);
      untilImpact(ctx);
      expect(seen.map((e) => e.target)).toEqual([1, 2]);
      expect(seen[0]?.value).toBe(0);
      expect(seen[1]?.value).toBeCloseTo(expected, 12);
    }
  });

  it('clears both of the heading’s components at the dock, so a relaunch at an enemy on its dock carries the outward angle', () => {
    // Planted bug (review): the docking reset clearing hx alone. The first sortie flies in with
    // both components set, so its hy would stay, and the relaunch at the enemy on the dock, which
    // it never flies in to, would carry atan2(15, 0), π/2, for atan2(12, 43).
    const ON_DOCK = { x: DOCK.x, y: DOCK.y + 12 };
    const { ctx, seen } = hive([{ ...T, hp: 1 }, ON_DOCK]);
    const ds = ctx.sys.drones;
    dashFrom(ctx, 0, enemy(ctx, 1), T.x - 20, T.y - 15);
    ds.impactsLeft[0] = 1;
    untilImpact(ctx);
    expect([ds.mode[0], ...headingOf(ctx, 0)]).toEqual([DRONE_RETURN, 20, 15]);
    for (let n = 0; n < 100 && ds.mode[0] !== DRONE_DOCKED; n++) next(ctx);
    expect([ds.mode[0], ...headingOf(ctx, 0)]).toEqual([DRONE_DOCKED, 0, 0]);
    untilImpact(ctx);
    expect(seen.map((e) => e.target)).toEqual([1, 2]);
    expect(seen[0]?.value).toBeCloseTo(Math.atan2(15, 20), 12);
    expect(seen[1]?.value).toBeCloseTo(Math.atan2(12, 43), 12);
  });

  it('carries the outward angle for a drone launched at an enemy already within its body, or right on its edge, at droneSpeed 1 and 0', () => {
    // Planted bugs: the fallback using (0, 0) instead of the outward angle (it would carry 0); the
    // heading written on a tick that starts on the edge (dist ≥ radius: (0, 20), at π/2).
    for (const [dx, dy] of [
      [5, 12],
      [0, 20],
    ] as const) {
      for (const droneSpeed of [1, 0]) {
        const { ctx, seen } = hive([{ x: DOCK.x + dx, y: DOCK.y + dy }], {
          values: { droneSpeed },
        });
        ctx.sys.drones.nextPick[0] = 0;
        expect(impacts(stage(ctx))).toHaveLength(1);
        expect(headingOf(ctx, 0)).toEqual([0, 0]);
        expect(seen).toEqual([{ target: 1, value: Math.atan2(dy, 43 + dx) }]);
      }
    }
  });

  it('carries the outward angle at droneSpeed 0 when an enemy walks onto the docked drone along its ray (P6’s case)', () => {
    // An enemy walking in from 150 at 2 a tick along the drone's ray: the drone launches and never
    // moves, and impacts it once its edge reaches the dock. Its heading points down the ray, as
    // the outward angle does: 0.
    const { ctx, seen } = hive([{ x: P.x + 150, y: P.y, speed: 120 }], {
      values: { droneSpeed: 0 },
    });
    const ds = ctx.sys.drones;
    ds.nextPick[0] = 0;
    untilImpact(ctx, true);
    const e = enemy(ctx, 1);
    expect([ds.x[0], ds.y[0]]).toEqual([e.x, e.y]);
    expect(seen).toEqual([{ target: 1, value: Math.atan2(e.y - P.y, e.x - P.x) }]);
    expect(seen[0]?.value).toBe(0);
  });

  it('at droneSpeed 0 writes the target’s center minus the drone on each tick the enemy is outside its body, as F1 reads (FL-R2)', () => {
    // Off the drone's ray, the heading is the last outside tick's target minus slot, not the
    // outward angle: F1 writes on every dash tick outside the body, at step 0 too (the lead's
    // FL-R2: F2's 0-speed example holds on the drone's own ray).
    const { ctx, seen } = hive([{ x: P.x + 150, y: P.y + 60, speed: 120 }], {
      values: { droneSpeed: 0 },
    });
    const ds = ctx.sys.drones;
    ds.nextPick[0] = 0;
    const e = enemy(ctx, 1);
    let last = { x: e.x, y: e.y };
    for (let n = 0; n < 200 && seen.length === 0; n++) {
      const before = { x: e.x, y: e.y };
      next(ctx, true);
      if (seen.length === 0) last = { x: e.x, y: e.y };
      else expect(before).toEqual(last);
    }
    expect(seen).toHaveLength(1);
    const angle = Math.atan2(last.y - DOCK.y, last.x - DOCK.x);
    expect(seen[0]?.value).toBeCloseTo(angle, 12);
    expect(Math.abs((seen[0]?.value as number) - Math.atan2(e.y - P.y, e.x - P.x))).toBeGreaterThan(
      0.5,
    );
  });
});

describe('impacts that write or raise nothing (F1, F2)', () => {
  it('raises no droneImpact for a repeat’s impact (s = −1), and gives an impact of no slot on the signature’s payload the outward angle, 0 on the player', () => {
    // Planted bug: the fallback using (0, 0) instead of the outward angle.
    const { ctx, seen } = hive([T, P], { triggers: [IDLE_REPEAT, LISTEN] });
    const em = swarmOf(ctx);
    swarmRepeat(ctx, em, repeatPayloadOf(ctx), 1, 9);
    expect(impacts(ctx.events).map((e) => [e.droneId, e.targetId])).toEqual([[-1, 1]]);
    expect(seen).toEqual([]);
    // No run makes one (only a repeat impacts with no slot), but its value is defined.
    impactAt(ctx, -1, enemy(ctx, 1), em.payload, em, false, 0, -1);
    impactAt(ctx, -1, enemy(ctx, 2), em.payload, em, false, 0, -1);
    expect(seen).toEqual([
      { target: 1, value: OUTWARD },
      { target: 2, value: 0 },
    ]);
  });

  it('lets a spirit dash and impact with no heading, raising no droneImpact', () => {
    // Planted bug: the spirits writing the heading in their dash.
    const { ctx, seen } = hive([T], { triggers: [LISTEN, holder({ impacts: 2 })] });
    const ds = ctx.sys.drones;
    ds.nextPick[0] = NEVER;
    spawn(ctx, { x: P.x - 100, y: P.y + 80 });
    expect(ds.kind[1]).toBe(DRONE_KIND_SPIRIT);
    const id = ds.id[1];
    let hit = 0;
    for (let n = 0; n < 200 && ds.count > 1; n++) {
      hit += impacts(next(ctx)).filter((e) => e.droneId === id).length;
      expect(headingOf(ctx, 1), `tick ${ctx.now}`).toEqual([0, 0]);
    }
    expect(hit).toBe(2);
    expect(seen).toEqual([]);
  });

  it('writes a granted drone’s heading as a swarm drone’s, one code path, though it raises no droneImpact; a turret’s stays 0', () => {
    // Planted bug: the heading written by the swarm's drones alone (a granted drone's would stay 0).
    const { ctx, seen } = hive([T], {
      triggers: [LISTEN],
      grants: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 1, turrets: 1 } }],
      swarm: [1, 1],
    });
    const ds = ctx.sys.drones;
    const slots = Array.from({ length: ds.count }, (_, s) => s);
    const granted = slots.find((s) => ds.kind[s] === DRONE_KIND_DRONE && ds.owner[s] !== 0);
    const turrets = slots.filter((s) => ds.kind[s] === DRONE_KIND_TURRET);
    expect([granted === undefined, turrets.length]).toEqual([false, 2]);
    const g = granted as number;
    for (const s of slots) ds.nextPick[s] = NEVER;
    dashFrom(ctx, g, enemy(ctx, 1), T.x, T.y - 200);
    for (let n = 0; n < 30; n++) {
      next(ctx);
      for (const s of turrets) expect(headingOf(ctx, s)).toEqual([0, 0]);
    }
    expect(ds.mode[g]).toBe(DRONE_DASH);
    const [hx, hy] = headingOf(ctx, g);
    expect([hx, Math.atan2(hy, hx)]).toEqual([0, Math.PI / 2]);
    expect(seen).toEqual([]);
  });

  it('starts every row of the fill with no heading', () => {
    // Planted bug: the fill writing a heading (the dock's offset), which a launch within the
    // target's body would carry.
    const { ctx } = hive([], {
      swarm: [3, 1],
      grants: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 2, turrets: 1 } }],
    });
    const ds = ctx.sys.drones;
    expect(ds.count).toBe(7);
    expect(Array.from(ds.hx.subarray(0, ds.count))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(ds.hy.subarray(0, ds.count))).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('the heading through the pool’s compaction (moveRow) and a spawn (spawnRows)', () => {
  it('zeroes a spawned row’s heading, and carries a row’s heading when a timed row before it leaves', () => {
    // Planted bugs: spawnRows not zeroing the heading a slot past the rows holds; moveRow not
    // carrying hx or hy. No run puts a drone after a timed row (fixed rows come first, and only
    // timed rows leave), so the test makes one: two spirits spawn, the second made a swarm drone
    // riding T with a heading, its memory holding T for one more tick; the first leaves now.
    const { ctx, seen } = hive([T], { triggers: [holder({ count: 2 })] });
    const ds = ctx.sys.drones;
    ds.nextPick[0] = NEVER;
    ds.hx[1] = 5;
    ds.hy[1] = 6;
    ds.hx[2] = 7;
    ds.hy[2] = 8;
    spawn(ctx, P);
    expect([ds.count, ...headingOf(ctx, 1), ...headingOf(ctx, 2)]).toEqual([3, 0, 0, 0, 0]);
    const t = enemy(ctx, 1);
    const id = ds.id[2] as number;
    ds.kind[2] = DRONE_KIND_DRONE;
    ds.owner[2] = 0;
    ds.until[2] = NEVER_LEAVES;
    dashFrom(ctx, 2, t, t.x, t.y);
    ds.impactsLeft[2] = 3;
    ds.hx[2] = -7;
    ds.hy[2] = 24;
    ds.memId[2 * DRONE_MEMORY] = t.id;
    ds.memUntil[2 * DRONE_MEMORY] = ctx.now + 2;
    ds.until[1] = ctx.now + 1;
    // The first spirit leaves; the drone waits on T and moves down to slot 1.
    expect(impacts(next(ctx))).toEqual([]);
    expect([ds.count, ds.id[1], ds.kind[1], ...headingOf(ctx, 1)]).toEqual([
      2,
      id,
      DRONE_KIND_DRONE,
      -7,
      24,
    ]);
    // Its memory over, it impacts T with the heading it was given.
    expect(impacts(next(ctx)).map((e) => e.droneId)).toEqual([id]);
    expect(seen).toEqual([{ target: 1, value: Math.atan2(24, -7) }]);
  });
});

describe('the value is computed only for an event that is raised (F2, as raiseChainJump does)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * How many times Math.atan2 runs in one drone stage whose swarm drone (or granted drone, with
   * `granted`) snaps in to T from 25 left of it and impacts, with chainCount 0; or, with
   * `repeat`, in one repeat of the swarm instead.
   */
  function atan2Calls(options: Options, how: 'swarm' | 'granted' | 'repeat' = 'swarm'): number {
    const { ctx } = hive([T], {
      ...options,
      values: { chainCount: 0 },
      triggers: [IDLE_REPEAT, ...(options.triggers ?? [])],
      grants: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 1 } }],
    });
    const ds = ctx.sys.drones;
    ds.nextPick[0] = NEVER;
    ds.nextPick[1] = NEVER;
    if (how !== 'repeat') dashFrom(ctx, how === 'swarm' ? 0 : 1, enemy(ctx, 1), T.x - 25, T.y);
    const spy = vi.spyOn(Math, 'atan2');
    ctx.now = ++ctx.state.tick;
    ctx.events.length = 0;
    if (how === 'repeat') swarmRepeat(ctx, swarmOf(ctx), repeatPayloadOf(ctx), 1, 9);
    else stepDrones(ctx);
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(impacts(ctx.events)).toHaveLength(1);
    return calls;
  }

  it('runs atan2 once for a swarm impact with a droneImpact trigger or an onCenterEvent hook, and never without either', () => {
    // Planted bug: the guard removed (the angle computed for every impact, the event then dropped
    // by emitCenterEvent): the run without a listener would call atan2 once. A spy on Math.atan2
    // counts the calls; nothing else in these stages calls it (no chain, no shot).
    const EXPLODE: TriggerSpec = { on: 'explode', do: [HEAL] };
    expect(atan2Calls({ hook: false })).toBe(0);
    expect(atan2Calls({ hook: false, triggers: [EXPLODE] })).toBe(0);
    expect(atan2Calls({ hook: false, triggers: [LISTEN] })).toBe(1);
    expect(atan2Calls({ hook: true })).toBe(1);
    // Rule 8 first: a granted drone's impact and a repeat's raise nothing, so compute nothing.
    expect(atan2Calls({ hook: true, triggers: [LISTEN] }, 'granted')).toBe(0);
    expect(atan2Calls({ hook: true, triggers: [LISTEN] }, 'repeat')).toBe(0);
  });
});

describe("slashLine toward 'flight' (lead ruling F3)", () => {
  const FLIGHT_SLASH: EffectSpec = {
    kind: 'slashLine',
    length: 150,
    width: 24,
    damagePct: 1,
    alwaysCrit: true,
    from: 'target',
    toward: 'flight',
  };

  it('starts at the target and runs along the drone’s flight: it hits an enemy on that line, every hit a crit, and not one on the outward line', () => {
    // Planted bug: the executor's 'flight' branch reading the outward direction.
    const A = { x: T.x, y: T.y + 100 };
    const B = { x: T.x + 100 * Math.cos(OUTWARD), y: T.y + 100 * Math.sin(OUTWARD) };
    const { ctx, seen } = hive([T, A, B], {
      values: { chainCount: 0 },
      triggers: [{ on: 'droneImpact', do: [FLIGHT_SLASH] }],
    });
    // From above, flying down the screen: π/2.
    dashFrom(ctx, 0, enemy(ctx, 1), T.x, T.y - 200);
    const impact = untilImpact(ctx);
    expect(hits(impact).map((h) => h.targetId)).toEqual([1]);
    expect(seen).toEqual([{ target: 1, value: Math.PI / 2 }]);
    ctx.events.length = 0;
    runEffectQueue(ctx);
    const [slash, ...more] = slashes(ctx.events);
    expect(more).toEqual([]);
    expect([slash?.x1, slash?.y1, slash?.width]).toEqual([T.x, T.y, 24]);
    expect(slash?.x2).toBeCloseTo(T.x, 9);
    expect(slash?.y2).toBeCloseTo(T.y + 150, 9);
    const slashHits = hits(ctx.events);
    expect(slashHits.map((h) => h.targetId)).toEqual([1, 2]);
    expect(slashHits.every((h) => h.crit)).toBe(true);
  });

  it('reads the event’s value as its angle in the executor, as along does: 3π/4 from the target', () => {
    // Planted bug: the executor's 'flight' branch reading the outward direction (it would hit 3).
    const angle = (3 * Math.PI) / 4;
    const ON = { x: T.x + 100 * Math.cos(angle), y: T.y + 100 * Math.sin(angle) };
    const OUT = { x: T.x + 100 * Math.cos(OUTWARD), y: T.y + 100 * Math.sin(OUTWARD) };
    const { ctx } = hive([T, ON, OUT], {
      triggers: [{ on: 'droneImpact', do: [FLIGHT_SLASH] }],
    });
    const entry = createEffectEntry();
    entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === 'slashLine');
    entry.depth = 1;
    entry.target = enemy(ctx, 1);
    entry.x = T.x;
    entry.y = T.y;
    entry.value = angle;
    runEffect(ctx, entry);
    const [slash] = slashes(ctx.events);
    expect(slash?.x2).toBeCloseTo(T.x + 150 * Math.cos(angle), 9);
    expect(slash?.y2).toBeCloseTo(T.y + 150 * Math.sin(angle), 9);
    expect(hits(ctx.events).map((h) => h.targetId)).toEqual([1, 2]);
  });

  it('cuts its slash from the event’s point, the target’s center, when the impact kills the target, as the generator places it on droneImpact (FL-R1)', () => {
    // Planted bug: the executor taking the live target for from 'event' (the killing impact would
    // cut nothing, as from 'target' does).
    const A = { x: T.x, y: T.y + 100 };
    const B = { x: T.x + 100 * Math.cos(OUTWARD), y: T.y + 100 * Math.sin(OUTWARD) };
    const cut = (from: 'event' | 'target'): SlashEvent[] => {
      const { ctx, seen } = hive([{ ...T, hp: 1 }, A, B], {
        values: { chainCount: 0 },
        triggers: [{ on: 'droneImpact', do: [{ ...FLIGHT_SLASH, from }] }],
      });
      // From above, flying down the screen: π/2; the impact kills T.
      dashFrom(ctx, 0, enemy(ctx, 1), T.x, T.y - 200);
      expect(hits(untilImpact(ctx)).map((h) => h.targetId)).toEqual([1]);
      expect(enemy(ctx, 1).alive).toBe(false);
      expect(seen).toEqual([{ target: 1, value: Math.PI / 2 }]);
      ctx.events.length = 0;
      runEffectQueue(ctx);
      const cuts = slashes(ctx.events);
      // A on the flight's line takes the slash's hit, a crit; B on the outward line none.
      const slashHits = hits(ctx.events);
      expect(slashHits.map((h) => h.targetId)).toEqual(cuts.length === 0 ? [] : [2]);
      expect(slashHits.every((h) => h.crit)).toBe(true);
      return cuts;
    };
    const [slash, ...more] = cut('event');
    expect(more).toEqual([]);
    expect([slash?.x1, slash?.y1, slash?.width]).toEqual([T.x, T.y, 24]);
    expect(slash?.x2).toBeCloseTo(T.x, 9);
    expect(slash?.y2).toBeCloseTo(T.y + 150, 9);
    // From the dead target it cuts nothing: why the generator places it from the event.
    expect(cut('target')).toEqual([]);
  });
});
