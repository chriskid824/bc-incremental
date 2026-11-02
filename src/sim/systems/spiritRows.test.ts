/**
 * More checks of the drone pool's timed rows (C5.7, spirits), beside spirits.test.ts: leaving on
 * time on a tick its pick is due, its frequency apart from the emitters' cadence, its time past
 * the Int32 range, its ailment term's origin and a build without the ailment's duration, the burn
 * credit of a row without damage, each row reading its own effect's tables, and a target its own
 * impact killed. Each test runs the drone stage alone on placed enemies, a tick at a time.
 */

import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import type { StatId } from '../../data/stats';
import type { SpawnDroneSpec, TriggerSpec } from '../../data/triggers';
import { runEffect } from '../effects/execute';
import { createEffectEntry } from '../effects/queue';
import { EVENT } from '../effects/types';
import type { Payload } from '../emitters/types';
import { eventsOf, makeStats, placedEnemies } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DRONE_DASH } from '../types';
import type { SimEvent } from '../types';
import type { Enemy, RunContext } from './context';
import { stepDrones } from './drones';
import { rebuildGrid } from './grid';
import { NEVER_LEAVES } from './systemState';
import type { SpawnSpecs } from './systemState';

/** The player, at the arena's centre, and a point 500 right of it, where the rows spawn. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const R = { x: PLAYER.x + 500, y: PLAYER.y };

const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y + dy,
  ...more,
});

/** Damage 10 and no crits or ignites unless `values` say so: the hits draw nothing. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
const HEAL = { kind: 'heal', lifePct: 0.01 } as const;

/**
 * placedEnemies with `triggers`, then one heroHit trigger (which never fires here) per spawnDrone
 * spec, of lifeSec 4 and damagePct 1 unless the spec says otherwise, all credited to `source`.
 */
function fixture(
  placed: readonly PlacedEnemy[],
  spawns: readonly Partial<SpawnDroneSpec>[] = [{}],
  values: Partial<Record<StatId, number>> = {},
  triggers: readonly TriggerSpec[] = [],
  source = 'outer.summon',
): RunContext {
  const holders: TriggerSpec[] = spawns.map((fields) => ({
    on: 'heroHit',
    do: [{ kind: 'spawnDrone', lifeSec: 4, damagePct: 1, ...fields }],
  }));
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...values }, [], {
      triggers: [...triggers, ...holders].map((spec) => ({ source, spec })),
      conversions: [],
      emitters: [],
    }),
  });
}

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
 * Runs the n-th spawnDrone effect's executor now at `point`, as a trigger's effect at `depth`
 * from trigger `origin` would run in the effect phase.
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

/** The effect queue's entries, oldest first: each one's trigger origin and depth. */
function queued(ctx: RunContext): [origin: number, depth: number][] {
  const q = ctx.effectQueue;
  return Array.from({ length: q.size }, (_, n) => {
    const i = (q.head + n) & q.capMask;
    return [q.origin[i] as number, q.depth[i] as number];
  });
}

/** The next tick's drone stage, the enemies standing where they are; returns its events. */
function next(ctx: RunContext): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  rebuildGrid(ctx);
  ctx.events.length = 0;
  stepDrones(ctx);
  return ctx.events.slice();
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const live = (ctx: RunContext, n = 0): number =>
  (ctx.sys.drones.specs as SpawnSpecs).live[specOf(ctx, n)] as number;
const expires = (events: readonly SimEvent[]) => eventsOf([events], 'droneExpire');
const impacts = (events: readonly SimEvent[]) => eventsOf([events], 'impact');

describe('timed rows: leaving on time', () => {
  it('leaves once, on time, when its pick is due on its last tick and an enemy stands at it: no pick, no impact', () => {
    // 31 ticks of life; the enemy stays out of the arena until the pick due at born + 31.
    const ctx = fixture([at(-1000, 0)], [{ lifeSec: 31 / 60 }]);
    const ds = ctx.sys.drones;
    spawn(ctx);
    const born = ctx.now;
    while (ctx.now < born + 30) expect(next(ctx)).toEqual([]);
    expect(ds.nextPick[0]).toBe(born + 31);
    enemy(ctx, 1).x = R.x;
    enemy(ctx, 1).y = R.y;
    const events = next(ctx);
    expect(events).toEqual([{ type: 'droneExpire', droneId: 1, x: R.x, y: R.y, cause: 'time' }]);
    expect([ds.count, live(ctx)]).toEqual([0, 0]);
    expect(impacts(events)).toEqual([]);
  });
});

describe('timed rows: their frequency', () => {
  it('steps and cools down at m = attackSpeed / 4 alone, whatever cadence the emitters run at (冰霜, the combo, the buffs)', () => {
    // 45 away: in reach (≤ 20 + 10) on the third step of 10.
    const ctx = fixture([at(45, 0)], [{ impacts: 2 }]);
    for (const em of ctx.emitters) em.cadence = 0.5;
    const ds = ctx.sys.drones;
    spawn(ctx, 0, PLAYER);
    const born = ctx.now;
    next(ctx);
    expect(ds.x[0]).toBe(PLAYER.x + 10);
    const ticks: number[] = [];
    while (ds.count > 0 && ctx.now < born + 100) {
      if (impacts(next(ctx)).length > 0) ticks.push(ctx.now);
    }
    // DRONE_DEFAULTS.cooldownSec 0.5 at m = 1: 30 ticks between its two impacts.
    expect(ticks).toEqual([born + 3, born + 33]);
  });
});

describe('timed rows: their time past the Int32 range', () => {
  it('keeps a row whose lifeSec runs past 2^31 ticks: its until is NEVER_LEAVES, never a wrapped tick', () => {
    // round(5e7 × 60) = 3e9 ticks, past 2147483647.
    const ctx = fixture([], [{ lifeSec: 5e7 }]);
    const ds = ctx.sys.drones;
    spawn(ctx);
    expect(ds.until[0]).toBe(NEVER_LEAVES);
    expect(expires(next(ctx))).toEqual([]);
    expect([ds.count, live(ctx)]).toEqual([1, 1]);
  });
});

describe('timed rows: their ailment term', () => {
  it('applies it from the row’s own origin: the trigger that spawned it does not fire on it, another one fires a depth further', () => {
    const triggers: TriggerSpec[] = [
      { on: 'ailmentApplied', when: [{ ailment: 'poison' }], do: [HEAL] },
      { on: 'ailmentApplied', when: [{ ailment: 'poison' }], do: [HEAL] },
    ];
    const ctx = fixture(
      [at(500, 0), at(520, 0)],
      [{ damagePct: 0, ailment: 'poison' }],
      {},
      triggers,
    );
    const [a0, a1] = [0, 1].map((n) => triggerOf(ctx, EVENT.ailmentApplied, n)) as [number, number];
    spawn(ctx, 0, R, 2, a0);
    const events = next(ctx);
    expect(eventsOf([events], 'ailmentApplied').map((e) => e.targetId)).toEqual([1, 2]);
    // Rule 3: the origin a0 fires on neither application; a1 on both, at depth 3.
    expect(queued(ctx)).toEqual([
      [a1, 3],
      [a1, 3],
    ]);
  });

  it.each([
    ['burn', 'burnDuration'],
    ['poison', 'poisonDuration'],
  ] as const)(
    'skips its %s term in a build without %s: nothing applied, raised or fired, as a zone’s',
    (ailment, stat) => {
      const triggers: TriggerSpec[] = [{ on: 'ailmentApplied', when: [{ ailment }], do: [HEAL] }];
      const ctx = fixture([at(500, 0)], [{ damagePct: 0, ailment }], { [stat]: 0 }, triggers);
      spawn(ctx);
      const events = next(ctx);
      expect(events.map((e) => e.type)).toEqual(['impact', 'droneExpire']);
      const e = enemy(ctx, 1);
      expect([e.burns.length, e.burnStacks, e.poisonStacks]).toEqual([0, 0, 0]);
      expect(ctx.effectQueue.size).toBe(0);
    },
  );
});

describe('timed rows: the burn credit', () => {
  it.each([
    ['fusion.fire.poison', 'burn', 0, true],
    ['fusion.fire.poison', 'poison', 0, false],
    ['fusion.fire.poison', 'poison', 1, true],
    ['outer.summon', 'burn', 0, false],
  ] as const)(
    'a %s spawnDrone of ailment %s and damagePct %i beside the signature mixes the burn credits: %s',
    (source, ailment, damagePct, mixed) => {
      const ctx = fixture([], [{ damagePct, ailment }], {}, [], source);
      const p = ctx.effectPayloads[specOf(ctx)] as Payload;
      // A row without damage rolls nothing, so only its burn term makes it a burn applier.
      expect(p.rollsAilments).toBe(damagePct > 0);
      expect(ctx.burnMixed).toBe(mixed);
    },
  );
});

describe('timed rows: each row reads its own effect', () => {
  it('steps, aims, splashes and hits by its own spawnDrone, beside a row of another one in a lower slot', () => {
    // 1 the nearest to R; 2 and 3 the farthest from the player, 2 the farther.
    const ctx = fixture(
      [at(560, 0), at(-700, 0), at(-650, 0)],
      [
        { speed: 300, aim: 'outer' },
        { speed: 1200, aim: 'nearest', splash: 0, damagePct: 0.5 },
      ],
    );
    const ds = ctx.sys.drones;
    spawn(ctx, 0);
    spawn(ctx, 1);
    next(ctx);
    // Row 1 dashes at 2, the farthest, 5 a tick; row 2 at 1, its nearest, 20 a tick.
    expect([ds.targetId[0], ds.x[0], ds.targetId[1], ds.x[1]]).toEqual([2, R.x - 5, 1, R.x + 20]);
    const events = next(ctx);
    expect(impacts(events).map((e) => [e.droneId, e.targetId, e.radius])).toEqual([[2, 1, 0]]);
    expect(eventsOf([events], 'hit').map((h) => [h.targetId, toNumber(h.amount)])).toEqual([
      [1, 5],
    ]);
  });
});

describe('timed rows: a target its own impact killed', () => {
  it('is lost at once: with impacts left and its clock due, the row picks again on that tick and dashes from the next', () => {
    // 400 away: its 38th step reaches the target's edge, past its clock's 30 ticks.
    const ctx = fixture([at(400, 0, { hp: 1 }), at(400, 100)], [{ impacts: 2 }]);
    const ds = ctx.sys.drones;
    spawn(ctx, 0, PLAYER);
    const born = ctx.now;
    while (ctx.now < born + 37) expect(impacts(next(ctx))).toEqual([]);
    const events = next(ctx);
    expect(impacts(events).map((e) => e.targetId)).toEqual([1]);
    expect(enemy(ctx, 1).alive).toBe(false);
    expect([ds.mode[0], ds.targetId[0], ds.nextPick[0]]).toEqual([DRONE_DASH, 2, born + 38 + 30]);
    next(ctx);
    expect([ds.x[0], ds.y[0]]).toEqual([PLAYER.x + 400, PLAYER.y + 10]);
  });
});
