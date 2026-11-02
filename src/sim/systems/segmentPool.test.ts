/**
 * Segments between the drone pool's rows (C5.8; docs/v3 C5 design §8.2, C4 design §11's C5
 * hand-off and N23): the endpoints of 'drones' and 'summons' segments (kinds, slot order = id
 * order, positions as the drone stage left them, the rows that left in it gone), their links
 * (the shocked judgement's rule by a scan of the rows, against SpatialGrid.nearestTwo and a
 * brute-force reference), their hits and minion tag, and pairPeriodSec's held pairs and second
 * timer (EmitterRuntime.pairTimer). Most tests judge one segment emitter on placed enemies with
 * the pool's rows placed by hand; the stage order goes through the drone stage, then the segment
 * stage, as a tick runs them.
 */

import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import { createRng } from '../../core/rng';
import { SEGMENT_DEFAULTS } from '../../data/emitters';
import type { EmitterGrant, SegmentGrant, SourcedEmitter } from '../../data/emitters';
import type { Modifier, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TriggerSpec } from '../../data/triggers';
import type { EnemyId } from '../../data/types';
import { addShock } from '../ailments/shock';
import { flat } from '../../data/templates';
import { SHATTER_TRIGGER } from '../effects/types';
import type { CompiledTrigger } from '../effects/types';
import type { EmitterRuntime, SegmentSpec } from '../emitters/types';
import { SpatialGrid } from '../grid';
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
  v3TestData,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_KIND_DRONE,
  DRONE_KIND_SPIRIT,
  DRONE_KIND_TURRET,
  NO_INPUT,
} from '../types';
import type { SimEvent } from '../types';
import type { Enemy, RunContext } from './context';
import { spawnRows, stepDrones } from './drones';
import { rebuildGrid } from './grid';
import { stepSegments } from './segments';
import type { DronePool, HeldPairs } from './systemState';

type PulseEvent = Extract<SimEvent, { type: 'pulse' }>;
type Endpoints = 'drones' | 'summons';

/** The player, at the arena's centre, and C, 400 right of it, where most rows and enemies sit. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const C = { x: PLAYER.x + 400, y: PLAYER.y };
/** An enemy (dx, dy) from C. */
const at = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: C.x + dx,
  y: C.y + dy,
  ...extra,
});

const on = (source: string, grant: EmitterGrant): SourcedEmitter => ({ source, grant });
/** A drone grant on outer.summon: `drones` drones then `turrets` turrets, rows 1 up. */
const summons = (drones: number, turrets = 0): SourcedEmitter =>
  on('outer.summon', { kind: 'drone', drones, turrets });
/** A segment between the pool's rows, its other fields at their defaults unless given. */
const seg = (endpoints: SegmentGrant['endpoints'], fields: Partial<SegmentGrant> = {}) =>
  on('outer.summon', { kind: 'segment', endpoints, ...fields } as SegmentGrant);
/** A test module that only raises the run's summon cap. */
const raiseCap = (summonCap: number): TestModule =>
  Object.assign((_b: BuildCompiler) => undefined, { summonCap });
/** A heroHit trigger, which never fires here, holding a spawnDrone: the build can add spirits. */
const HOLDER: TriggerSpec = {
  on: 'heroHit',
  do: [{ kind: 'spawnDrone', lifeSec: 4, damagePct: 1 }],
};

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly scoped?: readonly Modifier[];
  readonly triggers?: readonly (readonly [string, TriggerSpec])[];
  readonly cap?: number;
  readonly seed?: number;
  readonly v3?: boolean;
}

/**
 * placedEnemies with these grants over damage 1000 (a segment hit of 100 at the default share)
 * without crits, unless `values` say so, at attack speed 0, so the drone stage moves no row and
 * only the time ends a spirit's; a heroHit trigger holds a spawnDrone, so spirits can be added.
 */
function poolCtx(
  placed: readonly PlacedEnemy[],
  grants: readonly SourcedEmitter[],
  options: Options = {},
): RunContext {
  const triggers = [...(options.triggers ?? []), ['outer.summon', HOLDER] as const];
  return placedEnemies(placed, {
    stats: makeStats(
      { damage: 1000, critChance: 0, critMultiplier: 2, attackSpeed: 0, ...options.values },
      options.scoped ?? [],
      {
        triggers: triggers.map(([source, spec]) => ({ source, spec })),
        conversions: [],
        emitters: grants,
      },
    ),
    seed: options.seed ?? 1,
    ...(options.cap === undefined ? {} : { modules: [raiseCap(options.cap)] }),
    ...(options.v3 === true ? { data: v3TestData() } : {}),
  });
}

/** Appends `n` spirits at C + (dx, dy) that leave `life` ticks from now. */
function addSpirits(ctx: RunContext, n: number, dx = 0, dy = 0, life = 240): void {
  const f = ctx.build.effects.findIndex((fx) => fx.kind === 'spawnDrone');
  spawnRows(ctx, f, n, life, C.x + dx, C.y + dy, 1, -1);
}

/** Puts the row in slot `s` at C + (dx, dy), its previous position left alone. */
function place(ctx: RunContext, s: number, dx: number, dy: number): void {
  const ds = ctx.sys.drones;
  ds.x[s] = C.x + dx;
  ds.y[s] = C.y + dy;
}

/** Places the pool's rows in slot order at these offsets from C. */
function placeAll(ctx: RunContext, offsets: readonly (readonly [number, number])[]): void {
  offsets.forEach(([dx, dy], s) => place(ctx, s, dx, dy));
}

/**
 * Runs the segment stage on the current tick with segment emitter `i` due and none of the
 * others; returns the stage's events.
 */
function judgeNow(ctx: RunContext, i = 0): SimEvent[] {
  ctx.sys.segments.emitters.forEach((em, k) => {
    em.timer = k === i ? em.interval - 1 : -Infinity;
  });
  ctx.events.length = 0;
  stepSegments(ctx);
  return ctx.events.slice();
}

/** The next tick: the grid rebuilt for the enemies where they stand, then the drone stage. */
function droneTick(ctx: RunContext): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  rebuildGrid(ctx);
  ctx.events.length = 0;
  stepDrones(ctx);
  return ctx.events.slice();
}

const pulsesOf = (events: readonly SimEvent[]): PulseEvent[] =>
  events.filter((event): event is PulseEvent => event.type === 'pulse');
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const lossOf = (ctx: RunContext, id: number): number =>
  toNumber(enemy(ctx, id).maxHp) - toNumber(enemy(ctx, id).hp);
const damagedIds = (ctx: RunContext): number[] =>
  ctx.enemies.filter((e) => toNumber(e.hp) < toNumber(e.maxHp)).map((e) => e.id);
const segOf = (ctx: RunContext, i = 0): EmitterRuntime =>
  ctx.sys.segments.emitters[i] as EmitterRuntime;
const heldOf = (ctx: RunContext, i = 0): HeldPairs => ctx.sys.segments.held[i] as HeldPairs;
const liveIds = (ds: DronePool): number[] => Array.from(ds.id.subarray(0, ds.count));

/** Emitter i's links in line order, each [x1, y1, x2, y2]. */
function linesOf(ctx: RunContext, i = 0): number[][] {
  const ln = ctx.state.segments.lines[i];
  if (ln === undefined) throw new Error(`no lines for segment emitter ${i}`);
  return Array.from({ length: ln.count }, (_, s) => [
    ln.x1[s] as number,
    ln.y1[s] as number,
    ln.x2[s] as number,
    ln.y2[s] as number,
  ]);
}

/** The link from slot a to slot b where the pool holds them now, as linesOf writes it. */
const lineOf = (ds: DronePool, a: number, b: number): number[] => [
  ds.x[a] as number,
  ds.y[a] as number,
  ds.x[b] as number,
  ds.y[b] as number,
];

/** Whether the row in slot s is an endpoint of `endpoints`. */
const isEnd = (ds: DronePool, s: number, endpoints: Endpoints): boolean =>
  endpoints === 'summons' || ds.kind[s] === DRONE_KIND_DRONE;

/**
 * Reference pairing by brute force with a sort: the endpoints are the pool's drones, or all its
 * rows; each picks its `links` nearest other endpoints within `range` (ties to the lower slot,
 * distance 0 included); a link from i to q is dropped when q < i and q picked i. The pairs, as
 * slots, in the order the judgement writes them; only the rows `keep` keeps are endpoints.
 */
function referencePairs(
  ds: DronePool,
  endpoints: Endpoints,
  links: number,
  range: number,
  keep: (s: number) => boolean = () => true,
): [number, number][] {
  const ends = Array.from({ length: ds.count }, (_, s) => s).filter(
    (s) => keep(s) && isEnd(ds, s, endpoints),
  );
  const picks = new Map<number, number[]>();
  for (const i of ends) {
    const near = ends
      .filter((j) => j !== i)
      .map((j) => {
        const dx = (ds.x[j] as number) - (ds.x[i] as number);
        const dy = (ds.y[j] as number) - (ds.y[i] as number);
        return [dx * dx + dy * dy, j] as const;
      })
      .filter(([d]) => d <= range * range)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .slice(0, links)
      .map(([, j]) => j);
    picks.set(i, near);
  }
  const pairs: [number, number][] = [];
  for (const i of ends) {
    for (const q of picks.get(i) ?? []) {
      if (q < i && (picks.get(q) ?? []).includes(i)) continue;
      pairs.push([i, q]);
    }
  }
  return pairs;
}

/** The ids of the enemies alive within their radius of one of these lines, in id order. */
function onLines(enemies: readonly Enemy[], lines: readonly number[][]): number[] {
  return enemies
    .filter(
      (e) =>
        e.alive &&
        lines.some(
          ([ax, ay, bx, by]) =>
            segDistSqRef(e.x, e.y, ax as number, ay as number, bx as number, by as number) <=
            e.radius * e.radius,
        ),
    )
    .map((e) => e.id);
}

describe("compiling 'drones' and 'summons' segments (U1)", () => {
  it('keeps one segment emitter per source and kind of endpoints, in data order', () => {
    const ctx = poolCtx(
      [],
      [
        summons(2),
        seg('summons', { range: 150 }),
        on('outer.summon', { kind: 'segment', endpoints: 'shocked' }),
        seg('drones', { pairPeriodSec: 0.5 }),
        seg('summons', { range: 300 }),
        on('hub', { kind: 'segment', endpoints: 'summons', links: 1 }),
      ],
    );
    const specs = ctx.sys.segments.emitters.map((em) => em.spec as SegmentSpec);
    expect(specs.map((spec) => [spec.source, spec.endpoints, spec.range, spec.links])).toEqual([
      ['outer.summon', 'summons', 150, 2],
      ['outer.summon', 'shocked', 200, 2],
      ['outer.summon', 'drones', 200, 2],
      ['hub', 'summons', 200, 1],
    ]);
    expect(ctx.sys.segments.held.map((h) => h.a.length)).toEqual([
      0,
      0,
      2 * ctx.sys.drones.rows,
      0,
    ]);
  });

  it('turns pairPeriodSec into pairTicks, 0 (the default) into 0', () => {
    expect(SEGMENT_DEFAULTS.pairPeriodSec).toBe(0);
    const ticks = (pairPeriodSec?: number): number => {
      const fields = pairPeriodSec === undefined ? {} : { pairPeriodSec };
      const ctx = poolCtx([], [summons(2), seg('drones', fields)]);
      return (segOf(ctx).spec as SegmentSpec).pairTicks;
    };
    expect([ticks(), ticks(0), ticks(0.5), ticks(0.25), ticks(1), ticks(0.1)]).toEqual([
      0, 0, 30, 15, 60, 6,
    ]);
    expect(ticks(0.375)).toBeCloseTo(22.5, 9);
  });
});

describe("segment endpoints 'drones' and 'summons' (U2)", () => {
  /** 2 drones and a turret on outer.summon, 1 drone and 2 turrets on the hub, then 2 spirits. */
  function mixed(endpoints: Endpoints): RunContext {
    const ctx = poolCtx(
      [],
      [
        summons(2, 1),
        on('hub', { kind: 'drone', drones: 1, turrets: 2, name: 'b' }),
        seg(endpoints, { range: 1000 }),
      ],
    );
    addSpirits(ctx, 2);
    // Slots 0–7: drone, drone, turret, drone, turret, turret, spirit, spirit, each 100 apart.
    placeAll(
      ctx,
      Array.from({ length: 8 }, (_, s) => [100 * s, 0]),
    );
    return ctx;
  }

  it('takes the drones only between drones: every drone emitter’s, not the turrets or the spirits', () => {
    const ctx = mixed('drones');
    const ds = ctx.sys.drones;
    expect(Array.from(ds.kind.subarray(0, ds.count))).toEqual([
      DRONE_KIND_DRONE,
      DRONE_KIND_DRONE,
      DRONE_KIND_TURRET,
      DRONE_KIND_DRONE,
      DRONE_KIND_TURRET,
      DRONE_KIND_TURRET,
      DRONE_KIND_SPIRIT,
      DRONE_KIND_SPIRIT,
    ]);
    const [pulse] = pulsesOf(judgeNow(ctx));
    // Drones 0, 1 and 3: 0–1 both ways, 1's second 3, 3's first 1 and second 0.
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 1), lineOf(ds, 0, 3), lineOf(ds, 1, 3)]);
    expect(linesOf(ctx)).toEqual(
      referencePairs(ds, 'drones', 2, 1000).map(([a, b]) => lineOf(ds, a, b)),
    );
    expect(pulse).toMatchObject({ kind: 'segment', id: 3, hits: 0 });
  });

  it('takes every row between summons: drones, turrets and spirits, in slot order', () => {
    const ctx = mixed('summons');
    const ds = ctx.sys.drones;
    judgeNow(ctx);
    // A chain of 8 rows 100 apart: each its neighbours (the lower first, a tie), the ends their
    // two nearest; a link is written from the end that picked it alone, or the lower of two.
    expect(linesOf(ctx)).toEqual([
      lineOf(ds, 0, 1),
      lineOf(ds, 0, 2),
      lineOf(ds, 1, 2),
      lineOf(ds, 2, 3),
      lineOf(ds, 3, 4),
      lineOf(ds, 4, 5),
      lineOf(ds, 5, 6),
      lineOf(ds, 6, 7),
      lineOf(ds, 7, 5),
    ]);
    expect(linesOf(ctx)).toEqual(
      referencePairs(ds, 'summons', 2, 1000).map(([a, b]) => lineOf(ds, a, b)),
    );
  });

  it('reads the rows where the drone stage of the tick left them, not where they stood before it', () => {
    // At attack speed 4 the first drone flies at the square and the spirits dash at it, while
    // the second drone, with no enemy left that no drone chases, stays docked and the turret
    // sits: three rows move in the drone stage, and the segment stage after it links them there.
    const ctx = poolCtx([at(300, 0, { hp: 1e12 })], [summons(2, 1), seg('summons')], {
      values: { attackSpeed: 4 },
    });
    addSpirits(ctx, 2, 0, 0);
    const ds = ctx.sys.drones;
    for (let t = 0; t < 6; t++) droneTick(ctx);
    let moved = 0;
    for (let s = 0; s < ds.count; s++) if (ds.x[s] !== ds.prevX[s]) moved++;
    expect(moved).toBe(3);
    judgeNow(ctx);
    expect(linesOf(ctx).length).toBeGreaterThan(0);
    expect(linesOf(ctx)).toEqual(
      referencePairs(ds, 'summons', 2, 200).map(([a, b]) => lineOf(ds, a, b)),
    );
    const prev = new Set(
      Array.from({ length: ds.count }, (_, s) => `${ds.prevX[s]},${ds.prevY[s]}`),
    );
    const now = new Set(Array.from({ length: ds.count }, (_, s) => `${ds.x[s]},${ds.y[s]}`));
    for (const [x1, y1, x2, y2] of linesOf(ctx)) {
      expect(now.has(`${x1},${y1}`) && now.has(`${x2},${y2}`)).toBe(true);
    }
    // Some end stands where no row stood before the stage.
    const ends = linesOf(ctx).flatMap(([x1, y1, x2, y2]) => [`${x1},${y1}`, `${x2},${y2}`]);
    expect(ends.some((key) => !prev.has(key))).toBe(true);
  });

  it('leaves out a row that left in the tick’s drone stage, the others kept in id order', () => {
    // Drones 1–2 and spirits 3–5 in a row 100 apart; spirit 4 (slot 3) leaves this tick.
    const ctx = poolCtx([], [summons(2), seg('summons', { links: 1 })]);
    addSpirits(ctx, 3);
    const ds = ctx.sys.drones;
    placeAll(ctx, [
      [0, 0],
      [100, 0],
      [200, 0],
      [300, 0],
      [400, 0],
    ]);
    ds.until[3] = ctx.now + 1;
    const events = droneTick(ctx);
    expect(eventsOf([events], 'droneExpire').map((e) => e.droneId)).toEqual([4]);
    expect(liveIds(ds)).toEqual([1, 2, 3, 5]);
    judgeNow(ctx);
    // 5 (now slot 3) links to 3 (slot 2), 200 off; no end where 4 stood.
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 1), lineOf(ds, 2, 1), lineOf(ds, 3, 2)]);
    for (const [x1, , x2] of linesOf(ctx)) {
      expect([x1, x2]).not.toContain(C.x + 300);
    }
  });

  it('breaks a tie of distance by id after a compaction: the lower id, now in the lower slot', () => {
    // Rows 1–5: drone 1 at 0, spirits 2–5. Spirit 2 leaves; 3 and 5 stand 100 either side of
    // 1, 4 far off. 1's one link is a tie between 3 and 5: the lower id, 3.
    const ctx = poolCtx([], [summons(1), seg('summons', { links: 1, range: 150 })]);
    addSpirits(ctx, 4);
    const ds = ctx.sys.drones;
    placeAll(ctx, [
      [0, 0],
      [0, 500],
      [-100, 0],
      [900, 900],
      [100, 0],
    ]);
    ds.until[1] = ctx.now + 1;
    droneTick(ctx);
    expect(liveIds(ds)).toEqual([1, 3, 4, 5]);
    judgeNow(ctx);
    // 1 picks 3 (slot 1); 3 picks 1; 5 (slot 3) picks 1; 4 has none within 150.
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 1), lineOf(ds, 3, 0)]);
    expect(ds.x[1]).toBe(C.x - 100);
  });
});

describe('the links of drone and summon endpoints (U3)', () => {
  it('pick as SpatialGrid.nearestTwo picks over the endpoints, ties and distance 0 included', () => {
    const rng = createRng(20261102);
    let ties = 0;
    let zero = 0;
    let crowded = 0;
    for (let trial = 0; trial < 200; trial++) {
      const endpoints: Endpoints = rng.chance(0.5) ? 'drones' : 'summons';
      const links = rng.chance(0.5) ? 1 : 2;
      const range = [40, 90, 200, 400][rng.int(4)] as number;
      const d1 = rng.int(9);
      const t1 = rng.int(4);
      const d2 = rng.int(6);
      const t2 = rng.int(3);
      const grants = [
        ...(d1 + t1 > 0 ? [summons(d1, t1)] : []),
        ...(d2 + t2 > 0 ? [on('hub', { kind: 'drone', drones: d2, turrets: t2, name: 'b' })] : []),
        seg(endpoints, { links, range }),
      ] as SourcedEmitter[];
      const ctx = poolCtx([], grants, { cap: 48 });
      addSpirits(ctx, rng.int(20));
      const ds = ctx.sys.drones;
      for (let s = 0; s < ds.count; s++) {
        const draw = rng.next();
        if (draw < 0.15 && s > 0) {
          // On another row: a distance of 0.
          const o = rng.int(s);
          ds.x[s] = ds.x[o] as number;
          ds.y[s] = ds.y[o] as number;
        } else if (draw < 0.6) {
          // On a lattice: ties.
          place(ctx, s, 30 * (rng.int(13) - 6), 30 * (rng.int(9) - 4));
        } else {
          place(ctx, s, rng.range(-300, 300), rng.range(-200, 200));
        }
      }
      const ends = Array.from({ length: ds.count }, (_, s) => s).filter((s) =>
        isEnd(ds, s, endpoints),
      );
      judgeNow(ctx);
      if (ends.length < 2) {
        expect(linesOf(ctx), `trial ${trial}`).toEqual([]);
        continue;
      }
      // nearestTwo over the endpoints, both with a sorted grid and with a linear scan.
      const points = ends.map((s) => ({ x: ds.x[s] as number, y: ds.y[s] as number, alive: true }));
      const out = new Int32Array(2);
      const sg = ctx.sys.segments;
      for (const linearBelow of [0, 1000]) {
        const grid = new SpatialGrid<(typeof points)[number]>(
          ARENA_WIDTH,
          ARENA_HEIGHT,
          128,
          linearBelow,
        );
        grid.rebuild(points);
        ends.forEach((s, i) => {
          const c = grid.nearestTwo(ds.x[s] as number, ds.y[s] as number, range * range, i, out);
          const first = c > 0 ? (ends[out[0] as number] as number) : -1;
          const second = links === 2 && c > 1 ? (ends[out[1] as number] as number) : -1;
          expect([sg.pick1[s], sg.pick2[s]], `trial ${trial}, slot ${s}`).toEqual([first, second]);
        });
      }
      const ref = referencePairs(ds, endpoints, links, range);
      expect(linesOf(ctx), `trial ${trial}`).toEqual(ref.map(([a, b]) => lineOf(ds, a, b)));
      // How often the fixtures reach a tie, a distance of 0 and a busy pairing.
      const d2s = ends.flatMap((i) =>
        ends
          .filter((j) => j > i)
          .map(
            (j) =>
              ((ds.x[j] as number) - (ds.x[i] as number)) ** 2 +
              ((ds.y[j] as number) - (ds.y[i] as number)) ** 2,
          ),
      );
      if (new Set(d2s).size < d2s.length) ties++;
      if (d2s.includes(0)) zero++;
      if (ref.length >= 12) crowded++;
    }
    expect(ties).toBeGreaterThan(60);
    expect(zero).toBeGreaterThan(40);
    expect(crowded).toBeGreaterThan(20);
  });

  it('links within range, the range included, ties to the lower slot, at most 2 an endpoint', () => {
    // A square of side 100 with its centre at slot 4: each corner's two nearest are the centre
    // and the lower of its neighbours (a tie), the centre's 0 and 1 (a four-way tie).
    const ctx = poolCtx([], [summons(5), seg('drones')]);
    const ds = ctx.sys.drones;
    placeAll(ctx, [
      [-50, -50],
      [50, -50],
      [-50, 50],
      [50, 50],
      [0, 0],
    ]);
    judgeNow(ctx);
    expect(linesOf(ctx)).toEqual([
      lineOf(ds, 0, 4),
      lineOf(ds, 0, 1),
      lineOf(ds, 1, 4),
      lineOf(ds, 2, 4),
      lineOf(ds, 2, 0),
      lineOf(ds, 3, 4),
      lineOf(ds, 3, 1),
    ]);
    // Two rows exactly the range apart link; half a unit more and they do not.
    const edge = poolCtx([], [summons(2), seg('drones', { range: 200 })]);
    placeAll(edge, [
      [0, 0],
      [200, 0],
    ]);
    judgeNow(edge);
    expect(linesOf(edge)).toHaveLength(1);
    place(edge, 1, 200.5, 0);
    expect(pulsesOf(judgeNow(edge))).toMatchObject([{ hits: 0 }]);
    expect(linesOf(edge)).toEqual([]);
  });

  it('makes one link of a pair that picks each other, and links rows on one point (distance 0)', () => {
    const ctx = poolCtx([], [summons(2, 1), seg('summons', { links: 1 })]);
    const ds = ctx.sys.drones;
    placeAll(ctx, [
      [0, 0],
      [60, 0],
      [60, 0],
    ]);
    judgeNow(ctx);
    // 0 picks 1 (60, the lower of a tie with 2); 1 and 2 pick each other at 0: one link.
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 1), lineOf(ds, 1, 2)]);
    expect(ctx.state.segments.lines[0]?.count).toBe(2);
  });

  it('judges nothing below 2 endpoints: no link, no hit, no pulse, and the last links cleared', () => {
    // A drone, a turret and a spirit 100 apart: one 'drones' endpoint, three 'summons' ones.
    const placed = [at(50, 0), at(150, 0)];
    const ctx = poolCtx(placed, [summons(1, 1), seg('drones'), seg('summons')]);
    addSpirits(ctx, 1);
    const ds = ctx.sys.drones;
    placeAll(ctx, [
      [0, 0],
      [100, 0],
      [200, 0],
    ]);
    const serial = ctx.sys.segments.serial;
    expect(judgeNow(ctx, 0)).toEqual([]);
    expect(linesOf(ctx, 0)).toEqual([]);
    expect(damagedIds(ctx)).toEqual([]);
    expect(ctx.sys.segments.serial).toBe(serial + 1);
    expect(pulsesOf(judgeNow(ctx, 1))).toMatchObject([{ hits: 2 }]);
    expect(linesOf(ctx, 1)).toEqual([lineOf(ds, 0, 1), lineOf(ds, 0, 2), lineOf(ds, 1, 2)]);
    // The spirit leaves: the drone and the turret, two summons, still link.
    ds.until[2] = ctx.now + 1;
    droneTick(ctx);
    expect(pulsesOf(judgeNow(ctx, 1))).toHaveLength(1);
    expect(linesOf(ctx, 1)).toEqual([lineOf(ds, 0, 1)]);
    // A drone and a spirit: one link; once the spirit has left, nothing, and the link is gone.
    const lone = poolCtx(placed, [summons(1), seg('summons')]);
    addSpirits(lone, 1, 100, 0);
    place(lone, 0, 0, 0);
    expect(pulsesOf(judgeNow(lone))).toHaveLength(1);
    expect(linesOf(lone)).toHaveLength(1);
    lone.sys.drones.until[1] = lone.now + 1;
    droneTick(lone);
    expect(lone.sys.drones.count).toBe(1);
    expect(judgeNow(lone)).toEqual([]);
    expect(linesOf(lone)).toEqual([]);
  });
});

describe('the hits of drone and summon segments (U5)', () => {
  it('hits each enemy on its links once, in id order, a crit roll each and no ailment roll', () => {
    const values = {
      critChance: 0.5,
      igniteChance: 1,
      poisonChance: 1,
      bleedChance: 1,
      shockChance: 1,
      frostOnHit: 0.5,
    };
    const rng = createRng(11);
    let checked = 0;
    for (let trial = 0; trial < 40; trial++) {
      const enemies = Array.from({ length: 5 + rng.int(60) }, () =>
        at(rng.range(-250, 250), rng.range(-150, 150), {
          type: (['square', 'triangle', 'hexagon', 'boss'] as const)[rng.int(4)] as EnemyId,
          hp: 1e9,
        }),
      );
      const make = (): RunContext => {
        const ctx = poolCtx(enemies, [summons(6, 2), seg('summons')], { values, seed: trial });
        const ds = ctx.sys.drones;
        const r = createRng(trial + 100);
        for (let s = 0; s < ds.count; s++) place(ctx, s, r.range(-250, 250), r.range(-150, 150));
        return ctx;
      };
      const ctx = make();
      const twin = make();
      const lines = referencePairs(ctx.sys.drones, 'summons', 2, 200).map(([a, b]) =>
        lineOf(ctx.sys.drones, a, b),
      );
      const hit = onLines(ctx.enemies, lines);
      const [pulse] = pulsesOf(judgeNow(ctx));
      expect(linesOf(ctx)).toEqual(lines);
      expect(damagedIds(ctx), `trial ${trial}`).toEqual(hit);
      expect(pulse?.hits).toBe(hit.length);
      // Each enemy hit once: 100 each, or 200 on a crit, raised by no shock it held before.
      for (const id of hit) expect([100, 200]).toContain(lossOf(ctx, id));
      const rolls = hit.map(() => twin.combatRng.chance(0.5));
      expect(rngPositions(ctx)).toEqual(rngPositions(twin));
      expect(pulse?.crits).toEqual(hit.filter((_, k) => rolls[k]));
      for (const e of ctx.enemies) {
        expect([e.burnStacks, e.poisonStacks, e.bleedUntil, e.frost]).toEqual([0, 0, 0, 0]);
        expect(e.shockStacks).toBe(hit.includes(e.id) ? 1 : 0);
      }
      if ((pulse?.crits.length ?? 0) > 1 && lines.length > 4) checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('hits an enemy on several links once, and a tough one whose centre is outside the padded box', () => {
    const ctx = poolCtx(
      [at(10, 10, { type: 'hexagon', radius: 40 }), at(100, 0, { type: 'hexagon', radius: 40 })],
      [summons(3), seg('drones', { range: 250 })],
    );
    placeAll(ctx, [
      [0, 0],
      [150, 0],
      [0, 150],
    ]);
    // 1 lies on the links from slot 0, 2 on 0–1 and 1–2 (35 from it).
    const [pulse] = pulsesOf(judgeNow(ctx));
    expect(linesOf(ctx)).toHaveLength(3);
    expect(pulse?.hits).toBe(2);
    expect([lossOf(ctx, 1), lossOf(ctx, 2)]).toEqual([100, 100]);

    const pad = poolCtx([], [summons(2), seg('drones')]).shotPad;
    const off = (pad + 70) / 2;
    expect(off).toBeGreaterThan(pad);
    const boss = poolCtx([at(75, off, { type: 'boss' })], [summons(2), seg('drones')]);
    placeAll(boss, [
      [0, 0],
      [150, 0],
    ]);
    expect(enemy(boss, 1).tough).toBe(true);
    expect(pulsesOf(judgeNow(boss))[0]?.hits).toBe(1);
    const far = poolCtx([at(75, 70.5, { type: 'boss' })], [summons(2), seg('drones')]);
    placeAll(far, [
      [0, 0],
      [150, 0],
    ]);
    expect(pulsesOf(judgeNow(far))[0]?.hits).toBe(0);
  });

  it('shocks each enemy its hit lands on and does not kill, at depth 0 from no trigger; a kill’s children are not hit', () => {
    const triggers: [string, TriggerSpec][] = [
      ['outer.lightning', { on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] }],
    ];
    // 2 dies to its hit and its shards appear on the link; 1 and 3 take 2 stacks each.
    const placed = [
      at(20, 0),
      at(100, 0, { type: 'pentagon', radius: 1, hp: 1 }),
      at(180, 0, { hp: 1e9 }),
    ];
    const ctx = poolCtx(placed, [summons(2), seg('drones', { shockStacks: 2 })], { triggers });
    placeAll(ctx, [
      [0, 0],
      [200, 0],
    ]);
    const trigger = SHATTER_TRIGGER + 1;
    const effect = (ctx.build.triggers[trigger] as CompiledTrigger).effectStart;
    const [pulse] = pulsesOf(judgeNow(ctx));
    expect(enemy(ctx, 2).alive).toBe(false);
    const shards = ctx.enemies.slice(3);
    expect(shards.map((e) => e.def.id)).toEqual(['shard', 'shard', 'shard']);
    for (const shard of shards) {
      expect([toNumber(shard.hp), shard.shockStacks]).toEqual([toNumber(shard.maxHp), 0]);
    }
    expect(pulse?.hits).toBe(3);
    expect(ctx.enemies.slice(0, 3).map((e) => e.shockStacks)).toEqual([2, 0, 2]);
    expect([enemy(ctx, 2).killDepth, enemy(ctx, 1).ailDepth]).toEqual([0, 0]);
    const q = ctx.effectQueue;
    const queued = Array.from({ length: q.size }, (_, n) => {
      const k = (q.head + n) & q.capMask;
      return [q.effect[k], q.depth[k], q.origin[k]];
    });
    expect(queued).toEqual([
      [effect, 1, trigger],
      [effect, 1, trigger],
      [effect, 1, trigger],
    ]);
  });

  it('shocks no enemy whose shield blocks its hit in full', () => {
    const shocks = (mods: readonly Modifier[]): number[] => {
      const ctx = poolCtx(
        [at(-100, 0, { type: 'shielder', hp: 1000 }), at(-60, 0, { type: 'square', hp: 1e9 })],
        [summons(2), seg('drones')],
        { scoped: mods, v3: true },
      );
      placeAll(ctx, [
        [-150, 0],
        [0, 0],
      ]);
      expect(pulsesOf(judgeNow(ctx))).toHaveLength(1);
      return ctx.enemies.map((e) => e.shockStacks);
    };
    expect(shocks([])).toEqual([0, 1]);
    expect(shocks([flat('ignoreShield', 1)])).toEqual([1, 1]);
  });
});

describe('the minion tag of drone and summon segments (U5, D14)', () => {
  it('tags the links between drones or summons minion, and not a shocked segment’s', () => {
    const ctx = poolCtx(
      [],
      [
        summons(2),
        seg('drones'),
        seg('summons'),
        on('outer.lightning', { kind: 'segment', endpoints: 'shocked' }),
      ],
    );
    const tags = ctx.sys.segments.emitters.map((em) => [em.spec.tags, em.payload.tags]);
    const pool = TAG.hit | TAG.lightning | TAG.area | TAG.minion;
    const shocked = TAG.hit | TAG.lightning | TAG.area;
    expect(tags).toEqual([
      [pool, pool],
      [pool, pool],
      [shocked, shocked],
    ]);
  });

  it('lets minion-scoped damage reach their hits and not a shocked segment’s', () => {
    const minion: Modifier = { stat: 'damage', kind: 'more', value: 1, tags: ['minion'] };
    /** One judgement's damage to the square at C + 50 by the segment of `endpoints`. */
    const dealt = (endpoints: SegmentGrant['endpoints'], mods: readonly Modifier[]): number => {
      const ctx = poolCtx(
        [at(50, 0, { hp: 1e9 }), at(0, 0, { hp: 1e9 }), at(100, 0, { hp: 1e9 })],
        [summons(2), seg(endpoints)],
        { scoped: mods },
      );
      placeAll(ctx, [
        [0, 0],
        [100, 0],
      ]);
      // The shocked segment's endpoints are enemies 2 and 3, standing on the drones.
      addShock(ctx, enemy(ctx, 2), 1, 0);
      addShock(ctx, enemy(ctx, 3), 1, 0);
      const [pulse] = pulsesOf(judgeNow(ctx));
      expect(pulse?.hits).toBe(3);
      return lossOf(ctx, 1);
    };
    expect([dealt('drones', []), dealt('summons', []), dealt('shocked', [])]).toEqual([
      100, 100, 100,
    ]);
    expect([
      dealt('drones', [minion]),
      dealt('summons', [minion]),
      dealt('shocked', [minion]),
    ]).toEqual([200, 200, 100]);
  });
});

describe('pairPeriodSec: the held pairs and the second timer (U4, N23)', () => {
  /**
   * 3 drones with a 'drones' segment of links 1 that pairs every 0.5 s (30 ticks) and judges
   * every 0.25 s (15): drones 0–1 100 apart and drone 2 300 from 0.
   */
  function webCtx(fields: Partial<SegmentGrant> = {}): RunContext {
    const ctx = poolCtx(
      [],
      [summons(3), seg('drones', { links: 1, pairPeriodSec: 0.5, ...fields })],
    );
    placeAll(ctx, [
      [0, 0],
      [100, 0],
      [300, 0],
    ]);
    return ctx;
  }

  it('compiles pairPeriodSec to pairTicks and starts pairTimer at 0 with no pairing held', () => {
    const ctx = webCtx();
    const em = segOf(ctx);
    expect([(em.spec as SegmentSpec).pairTicks, em.interval, em.pairTimer]).toEqual([30, 15, 0]);
    expect(heldOf(ctx)).toMatchObject({ count: -1 });
    // Room for 2 links a slot of the pool.
    expect(heldOf(ctx).a).toHaveLength(2 * ctx.sys.drones.rows);
    // Every other emitter's pairTimer is 0 too.
    for (const other of ctx.emitters) expect(other.pairTimer).toBe(0);
  });

  it('pairs at its first judgement, keeps the pairs while pairTimer is below pairTicks, and pairs again at it', () => {
    const ctx = webCtx();
    const ds = ctx.sys.drones;
    const em = segOf(ctx);
    // 1: pairs. 0 and 1 pick each other; 2 picks 1, 200 off.
    judgeNow(ctx);
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 1), lineOf(ds, 2, 1)]);
    expect([heldOf(ctx).count, em.pairTimer]).toEqual([2, 0]);
    expect(Array.from(heldOf(ctx).a.subarray(0, 2))).toEqual([1, 3]);
    expect(Array.from(heldOf(ctx).b.subarray(0, 2))).toEqual([2, 2]);
    // 2: 15 ticks on, the rows move so that 0 and 2 are nearest and 1 is out of every range:
    // the held links stay, drawn where the rows stand now, 1 to 0 longer than the range.
    placeAll(ctx, [
      [0, 0],
      [600, 0],
      [50, 10],
    ]);
    judgeNow(ctx);
    expect(em.pairTimer).toBe(15);
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 1), lineOf(ds, 2, 1)]);
    expect(Math.hypot(600, 0)).toBeGreaterThan((em.spec as SegmentSpec).range);
    // 3: 30 ticks since the pairing: pairs again where they stand, then pairTimer is 0.
    judgeNow(ctx);
    expect(em.pairTimer).toBe(0);
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 2)]);
    expect(heldOf(ctx).count).toBe(1);
    // 4 keeps that pairing, 5 pairs again.
    place(ctx, 1, 120, 0);
    judgeNow(ctx);
    expect([em.pairTimer, linesOf(ctx)]).toEqual([15, [lineOf(ds, 0, 2)]]);
    judgeNow(ctx);
    expect([em.pairTimer, linesOf(ctx)]).toEqual([0, [lineOf(ds, 0, 2), lineOf(ds, 1, 2)]]);
  });

  it('pairs every 30 ticks and judges every 15 from its phase in a run of the stage', () => {
    const ctx = webCtx();
    const em = segOf(ctx);
    const seen: [number, number, number][] = [];
    for (let t = 1; t <= 135; t++) {
      if (t > 1) ctx.now = ++ctx.state.tick;
      const before = heldOf(ctx).count;
      ctx.events.length = 0;
      stepSegments(ctx);
      if (pulsesOf(ctx.events).length > 0) seen.push([t, em.pairTimer, before]);
    }
    // Index 2, after the signature and the drone emitter: its timer starts at −11, so it judges
    // at 26, 41, …; it pairs at the first judgement and every second one after it.
    expect(em.index).toBe(2);
    expect(seen).toEqual([
      [26, 0, -1],
      [41, 15, 2],
      [56, 0, 2],
      [71, 15, 2],
      [86, 0, 2],
      [101, 15, 2],
      [116, 0, 2],
      [131, 15, 2],
    ]);
  });

  it('keeps a held pair by its rows’ ids across a compaction, and drops one whose row has left', () => {
    // Summons: drone 1 and spirits 2–4; spirit 2 (slot 1) leaves between the pairings, which
    // moves 3 and 4 down a slot each.
    const ctx = poolCtx([], [summons(1), seg('summons', { links: 1, pairPeriodSec: 1 })]);
    addSpirits(ctx, 3);
    const ds = ctx.sys.drones;
    placeAll(ctx, [
      [0, 0],
      [80, 0],
      [300, 0],
      [400, 0],
    ]);
    judgeNow(ctx);
    // 1–2 both ways, 3–4 both ways.
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 1), lineOf(ds, 2, 3)]);
    expect([
      Array.from(heldOf(ctx).a.subarray(0, 2)),
      Array.from(heldOf(ctx).b.subarray(0, 2)),
    ]).toEqual([
      [1, 3],
      [2, 4],
    ]);
    ds.until[1] = ctx.now + 1;
    droneTick(ctx);
    expect(liveIds(ds)).toEqual([1, 3, 4]);
    judgeNow(ctx);
    // 1–2 is gone with 2; 3–4, now slots 1 and 2, is kept where they stand.
    expect(linesOf(ctx)).toEqual([lineOf(ds, 1, 2)]);
    expect(linesOf(ctx)).toEqual([[C.x + 300, C.y, C.x + 400, C.y]]);
    expect(heldOf(ctx).count).toBe(1);
  });

  it('gives a row that came after the pairing no link until the next one', () => {
    const ctx = poolCtx([], [summons(2), seg('summons', { links: 1, pairPeriodSec: 0.5 })]);
    const ds = ctx.sys.drones;
    placeAll(ctx, [
      [0, 0],
      [100, 0],
    ]);
    judgeNow(ctx);
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 1)]);
    // A spirit arrives on drone 0; the next judgement keeps the one held pair.
    addSpirits(ctx, 1, 0, 0);
    judgeNow(ctx);
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 1)]);
    // The next pairing links it: 0 and 2 pick each other at 0, 1 picks 0.
    judgeNow(ctx);
    expect(linesOf(ctx)).toEqual([lineOf(ds, 0, 2), lineOf(ds, 1, 0)]);
  });

  it('hits on a held link where it runs now, and on none of the links it no longer makes', () => {
    // Enemies 1 at C + 50 and 2 at C + (50, 100). The pairing links drones 0–1 along y = 0;
    // the drones move to y = 100 before the next judgement, which hits 2 only.
    const ctx = poolCtx(
      [at(50, 0, { hp: 1e9 }), at(50, 100, { hp: 1e9 })],
      [summons(2), seg('drones', { pairPeriodSec: 0.5 })],
    );
    placeAll(ctx, [
      [0, 0],
      [100, 0],
    ]);
    judgeNow(ctx);
    expect(damagedIds(ctx)).toEqual([1]);
    placeAll(ctx, [
      [0, 100],
      [100, 100],
    ]);
    const [pulse] = pulsesOf(judgeNow(ctx));
    expect([pulse?.hits, lossOf(ctx, 1), lossOf(ctx, 2)]).toEqual([1, 100, 100]);
  });

  it('clears its pairs when fewer than 2 rows are left, and keeps its clock', () => {
    // Pairs every 60 ticks, judges every 15: a drone and a spirit, which leaves after the first
    // pairing; a new spirit has no link until the pairing 60 ticks after the first.
    const ctx = poolCtx([], [summons(1), seg('summons', { pairPeriodSec: 1 })]);
    addSpirits(ctx, 1, 50, 0);
    place(ctx, 0, 0, 0);
    const em = segOf(ctx);
    judgeNow(ctx);
    expect([heldOf(ctx).count, em.pairTimer, linesOf(ctx).length]).toEqual([1, 0, 1]);
    ctx.sys.drones.until[1] = ctx.now + 1;
    droneTick(ctx);
    expect(judgeNow(ctx)).toEqual([]);
    expect([heldOf(ctx).count, em.pairTimer, linesOf(ctx)]).toEqual([0, 15, []]);
    addSpirits(ctx, 1, 50, 0);
    for (const timer of [30, 45]) {
      expect(pulsesOf(judgeNow(ctx))).toMatchObject([{ hits: 0 }]);
      expect([heldOf(ctx).count, em.pairTimer, linesOf(ctx)]).toEqual([0, timer, []]);
    }
    expect(pulsesOf(judgeNow(ctx))).toHaveLength(1);
    expect([heldOf(ctx).count, em.pairTimer, linesOf(ctx)]).toEqual([
      1,
      0,
      [lineOf(ctx.sys.drones, 0, 1)],
    ]);
  });

  it('runs its clock below 2 rows too: a due pairing there is an empty one, which sets pairTimer to 0 (D2)', () => {
    // A drone alone under a segment that pairs every 60 ticks and judges every 15.
    const ctx = poolCtx([], [summons(1), seg('summons', { links: 1, pairPeriodSec: 1 })]);
    place(ctx, 0, 0, 0);
    const em = segOf(ctx);
    // Its first judgement is due, holding no pairing yet: an empty pairing, pairTimer 0.
    expect(judgeNow(ctx)).toEqual([]);
    expect([heldOf(ctx).count, em.pairTimer]).toEqual([0, 0]);
    // A spirit beside it has no link until the pairing 60 ticks after the empty one.
    addSpirits(ctx, 1, 50, 0);
    for (const timer of [15, 30, 45]) {
      expect(pulsesOf(judgeNow(ctx))).toMatchObject([{ hits: 0 }]);
      expect([heldOf(ctx).count, em.pairTimer, linesOf(ctx)]).toEqual([0, timer, []]);
    }
    judgeNow(ctx);
    expect([heldOf(ctx).count, em.pairTimer, linesOf(ctx)]).toEqual([
      1,
      0,
      [lineOf(ctx.sys.drones, 0, 1)],
    ]);
    // The spirit leaves: the pairing due 60 ticks on finds the drone alone, and is empty too.
    ctx.sys.drones.until[1] = ctx.now + 1;
    droneTick(ctx);
    for (const timer of [15, 30, 45, 0]) {
      expect(judgeNow(ctx)).toEqual([]);
      expect([heldOf(ctx).count, em.pairTimer]).toEqual([0, timer]);
    }
    // So a spirit that comes next waits for the pairing 60 ticks after that empty one.
    addSpirits(ctx, 1, 50, 0);
    for (const timer of [15, 30, 45]) {
      judgeNow(ctx);
      expect([em.pairTimer, linesOf(ctx)]).toEqual([timer, []]);
    }
    judgeNow(ctx);
    expect([em.pairTimer, linesOf(ctx)]).toEqual([0, [lineOf(ctx.sys.drones, 0, 1)]]);
  });

  it('never touches pairTimer at pairTicks 0, nor holds a pair, and pairs at every judgement', () => {
    for (const grant of [
      seg('drones', { links: 1 }),
      seg('summons', { links: 1, pairPeriodSec: 0 }),
      on('outer.lightning', { kind: 'segment', endpoints: 'shocked', links: 1 }),
    ]) {
      const ctx = poolCtx([at(0, 0), at(100, 0), at(300, 0)], [summons(3), grant]);
      for (const e of ctx.enemies) addShock(ctx, e, 1, 0);
      placeAll(ctx, [
        [0, 0],
        [100, 0],
        [300, 0],
      ]);
      const em = segOf(ctx);
      expect((em.spec as SegmentSpec).pairTicks).toBe(0);
      expect(heldOf(ctx).a).toHaveLength(0);
      for (let n = 0; n < 4; n++) {
        if (n === 2)
          placeAll(ctx, [
            [0, 0],
            [600, 0],
            [50, 0],
          ]);
        judgeNow(ctx);
        expect(em.pairTimer).toBe(0);
        expect(heldOf(ctx).count).toBe(-1);
      }
      // Paired at the last judgement, from where the rows stand now.
      if (grant.grant.kind === 'segment' && grant.grant.endpoints !== 'shocked') {
        expect(linesOf(ctx)).toEqual([lineOf(ctx.sys.drones, 0, 2)]);
      }
    }
  });
});

describe('the segment stage in a run with drones and summons', () => {
  it('is not called without a segment emitter: a pool alone leaves the segment list empty', () => {
    const ctx = poolCtx([], [summons(2, 1)]);
    expect(ctx.sys.segments.emitters).toEqual([]);
    expect(ctx.sys.segments.held).toEqual([]);
    expect(ctx.state.segments.lines).toEqual([]);
  });

  it('links the rows the drone stage left, after it and before the effects append new ones', () => {
    // The swarm's 3 drones and its turret, a 'summons' segment and a hit trigger spawning rows
    // at the hit's point: every judgement links exactly the rows that were there at stage 8.
    const config = makeConfig({
      seed: 5,
      startWave: 6,
      maxTicks: 900,
      signature: { id: 'swarm' },
      stats: makeStats({ damage: 4, maxLife: 1e9, critChance: 0.2 }, [], {
        triggers: [
          {
            source: 'outer.summon',
            spec: { on: 'hit', do: [{ kind: 'spawnDrone', lifeSec: 1, damagePct: 0.2 }] },
          },
        ],
        conversions: [],
        emitters: [seg('summons', { links: 2, range: 250 })],
      }),
    });
    const seen: { ctx: RunContext | null; nextId: number } = { ctx: null, nextId: 0 };
    const watch: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        seen.ctx = ctx;
        seen.nextId = ctx.sys.drones.nextId;
      });
    const sim = createSimulation(config, makeTestData(), [watch]);
    let judged = 0;
    let appended = 0;
    let spirits = 0;
    for (let t = 0; t < 900; t++) {
      const events = sim.step(NO_INPUT);
      const ctx = seen.ctx;
      if (ctx === null || pulsesOf(events).length === 0) continue;
      const ds = ctx.sys.drones;
      // The rows of stage 8: those with an id the tick hook (stage 6) saw given out, still here.
      const below = (s: number): boolean => (ds.id[s] as number) < seen.nextId;
      const lines = referencePairs(ds, 'summons', 2, 250, below).map(([a, b]) => lineOf(ds, a, b));
      expect(linesOf(ctx), `tick ${ctx.now}`).toEqual(lines);
      judged++;
      let kept = 0;
      for (let s = 0; s < ds.count; s++) {
        if (below(s)) kept++;
        if (ds.kind[s] === DRONE_KIND_SPIRIT) spirits++;
      }
      if (kept < ds.count) appended++;
    }
    expect(judged).toBeGreaterThan(40);
    expect(appended).toBeGreaterThan(5);
    expect(spirits).toBeGreaterThan(20);
  });
});
