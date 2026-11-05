/**
 * 血河's bleed spread (docs/v3/game-design-v3.md:402 「每 0.5 秒，流血的敵人讓身後（離中央更遠的一側）60
 * 內的敵人也流血」; the gap map's E9, lead rulings S1-S7 and A14): spreadAilment's bleed member,
 * its `behind` filter, the strongest-only copy (gd:395 「同一隻只算最強的一個」), 大出血's rings raised
 * to the source's count (gd:401), its ailmentSpread event and B3's trigger. Titles name the ruling
 * each test pins; comments name the planted bugs they kill. Unit tests fire the trigger at one
 * enemy (fireOne, then the effect queue), so only that enemy spreads; the trigger tests run the
 * ailments system, whose ailmentTick fires it for every bleeding enemy.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber, ZERO } from '../../core/num';
import type { StatExtras, StatId } from '../../data/stats';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { CENTER } from '../build/sources';
import { fireOne } from '../effects/dispatch';
import { runEffectQueue } from '../effects/execute';
import { MAX_DEPTH, SHATTER_TRIGGER } from '../effects/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { updateAilments } from '../systems/ailments';
import type { Enemy, RunContext } from '../systems/context';
import { WARD_AILMENT_MULT, WARDED } from '../systems/enemyRecord';
import type { EnemyV3 } from '../systems/enemyRecord';
import { makeConfig, makeStats, makeTestData, placedEnemies, v3TestData } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import { applyBleed, spreadBleed } from './apply';
import { addBleed } from './bleed';
import { liveBleedStacks, RING_BLEED } from './rings';

/** The player's position: every placed enemy's dist is its distance from it. */
const PX = ARENA_WIDTH / 2;
const PY = ARENA_HEIGHT / 2;

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

/** The tick the unit tests spread at: a DoT step tick, where a ring's spread is exact. */
const AT = 30;

const NO_ROLLS = { critChance: 0, igniteChance: 0, poisonChance: 0, projectileCount: 1 };

type BleedSpread = Extract<EffectSpec, { kind: 'spreadAilment'; ailment: 'bleed' }>;
type Spread = Extract<SimEvent, { type: 'ailmentSpread' }>;

/** B3's 血河 (the brief's data): every 0.5 s, a bleeding enemy's bleed to the enemies behind it. */
const BLOOD_RIVER: TriggerSpec = {
  on: 'ailmentTick',
  when: [{ ailment: 'bleed' }],
  every: 0.5,
  do: [{ kind: 'spreadAilment', ailment: 'bleed', radius: 60, behind: true }],
};

/** 血河 with its spread's fields changed. */
const river = (more: Partial<BleedSpread>, every = 0.5): TriggerSpec => ({
  ...BLOOD_RIVER,
  every,
  do: [{ kind: 'spreadAilment', ailment: 'bleed', radius: 60, behind: true, ...more }],
});

/** 大出血 (B3) as a test module: bleed in rings, at most 8 live stacks, × 1 while moving. */
const BLEED_RINGS: TestModule = (b) => {
  b.flags.bleedRings = true;
  b.flags.bleedMaxStacks = 8;
  b.flags.bleedMoveMult = 1;
};

interface SceneOptions {
  readonly modules?: readonly TestModule[];
  readonly values?: Partial<Record<StatId, number>>;
  /** v3 enemies, which carry a record (元素護盾's ward). */
  readonly v3?: boolean;
  /** The trigger's source: outer.bleed, where B3 puts 血河, unless given. */
  readonly source?: string;
}

/** The placed enemies (ids 1, 2, …) with `trigger` as the build's one trigger, at tick AT. */
function scene(
  trigger: TriggerSpec,
  placed: readonly PlacedEnemy[],
  options: SceneOptions = {},
): RunContext {
  const extras: StatExtras = {
    triggers: [{ source: options.source ?? 'outer.bleed', spec: trigger }],
    conversions: [],
    emitters: [],
  };
  const ctx = placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], extras),
    modules: options.modules ?? [],
    ...(options.v3 === true ? { data: v3TestData() } : {}),
  });
  ctx.now = AT;
  return ctx;
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/**
 * Fires the trigger at `source` as its ailmentTick does (at its ailment depth) and runs the
 * effect queue: the events of that run.
 */
function spreadFrom(ctx: RunContext, source: Enemy): SimEvent[] {
  ctx.events.length = 0;
  fireOne(ctx, FIRST, source.ailDepth, -1, source, source.x, source.y, 0, ZERO, -1);
  runEffectQueue(ctx);
  return ctx.events.slice();
}

const spreadsOf = (events: readonly SimEvent[]): Spread[] =>
  events.filter((e): e is Spread => e.type === 'ailmentSpread');

/** The ids of the enemies holding a live bleed in the strongest-only slot. */
const bleeding = (ctx: RunContext): number[] =>
  ctx.enemies.filter((e) => e.bleedUntil > ctx.now).map((e) => e.id);

interface SlotView {
  readonly dps: number;
  readonly until: number;
  readonly start: number;
  readonly source: number;
}

const slot = (e: Enemy): SlotView => ({
  dps: toNumber(e.bleedDps),
  until: e.bleedUntil,
  start: e.bleedStart,
  source: e.bleedSource,
});

/**
 * Runs the ailments system and the effect queue on every tick up to `to`, as a run's steps 10
 * and 11 do, keeping each tick's events.
 */
function advance(ctx: RunContext, to: number): Map<number, SimEvent[]> {
  const byTick = new Map<number, SimEvent[]>();
  while (ctx.now < to) {
    ctx.now++;
    ctx.state.tick = ctx.now;
    ctx.events.length = 0;
    updateAilments(ctx);
    runEffectQueue(ctx);
    if (ctx.events.length !== 0) byTick.set(ctx.now, ctx.events.slice());
  }
  return byTick;
}

/** The ticks of the bleed spreads among `byTick`'s events, one per event. */
const spreadTicks = (byTick: Map<number, SimEvent[]>): number[] =>
  [...byTick].flatMap(([tick, events]) =>
    spreadsOf(events)
      .filter((e) => e.ailment === 'bleed')
      .map(() => tick),
  );

/**
 * The source 200 right of the player (id 1); around it, within 60: id 2 nearer the player (dist
 * 170, 30 from it), id 3 as far (192² + 56² = 200², 56.6 from it), id 4 farther (dist 240, 40 from
 * it); id 5 farther still but 62 from it, out of reach.
 */
const AROUND: readonly PlacedEnemy[] = [
  { x: PX + 200, y: PY },
  { x: PX + 170, y: PY },
  { x: PX + 192, y: PY + 56 },
  { x: PX + 240, y: PY },
  { x: PX + 262, y: PY },
];

describe('S3: behind', () => {
  it('reaches only the enemies farther from the player than the source, strictly; without it every other one in reach', () => {
    // Plants: behind with >=, the source's dist read as the target's, and behind ignored.
    const run = (behind: boolean): number[] => {
      const ctx = scene(river({ behind }), AROUND);
      addBleed(ctx, enemy(ctx, 1), num(10), AT + 200, 0, CENTER);
      spreadFrom(ctx, enemy(ctx, 1));
      return bleeding(ctx);
    };
    expect([
      enemy(scene(BLOOD_RIVER, AROUND), 3).dist,
      enemy(scene(BLOOD_RIVER, AROUND), 1).dist,
    ]).toEqual([200, 200]);
    expect(run(true)).toEqual([1, 4]);
    expect(run(false)).toEqual([1, 2, 3, 4]);
    // B3's data reads behind as true.
    const ctx = scene(BLOOD_RIVER, AROUND);
    addBleed(ctx, enemy(ctx, 1), num(10), AT + 200, 0, CENTER);
    spreadFrom(ctx, enemy(ctx, 1));
    expect(bleeding(ctx)).toEqual([1, 4]);
  });

  it('reads both distances as they stand when the effect runs, so a source pushed past a target no longer reaches it', () => {
    const ctx = scene(BLOOD_RIVER, AROUND);
    const source = enemy(ctx, 1);
    addBleed(ctx, source, num(10), AT + 200, 0, CENTER);
    // The source now stands at dist 245, past id 4 (240); ids 2 to 5 as placed.
    source.dist = 245;
    spreadFrom(ctx, source);
    expect(bleeding(ctx)).toEqual([1]);
    source.dist = 239.5;
    spreadFrom(ctx, source);
    expect(bleeding(ctx)).toEqual([1, 4]);
  });

  it('reads a spread that leaves behind out as one without it, as a poison spread', () => {
    // Plants behind on by default.
    const unset: TriggerSpec = {
      ...BLOOD_RIVER,
      do: [{ kind: 'spreadAilment', ailment: 'bleed', radius: 60 }],
    };
    const ctx = scene(unset, AROUND);
    addBleed(ctx, enemy(ctx, 1), num(10), AT + 200, 0, CENTER);
    spreadFrom(ctx, enemy(ctx, 1));
    expect(bleeding(ctx)).toEqual([1, 2, 3, 4]);
  });
});

/**
 * The source 200 right of the player (id 1) and six enemies farther out, all within 60 of it: ids
 * 2 to 7 at dists 210, 220, 230, 240, 250 and 255.
 */
const OUTWARD: readonly PlacedEnemy[] = [200, 210, 220, 230, 240, 250, 255].map((d) => ({
  x: PX + d,
  y: PY,
}));

describe('S2: the copy, weaker targets only', () => {
  /**
   * The source's bleed 12/s until AT + 200 (2400 left at AT); the others' own bleeds by id: 2
   * stronger (20/s for 211 ticks), 3 weaker (2/s for 370), 4 shorter but with more left (40/s for
   * 70), 5 exactly as much left (20/s for 120), 6 none, 7 between the two copies (5/s for 250).
   */
  function weaker(effect?: number): RunContext {
    const ctx = scene(river(effect === undefined ? {} : { effect }), OUTWARD);
    addBleed(ctx, enemy(ctx, 1), num(12), AT + 200, 0, CENTER);
    const own: [number, number, number][] = [
      [2, 20, AT + 211],
      [3, 2, AT + 370],
      [4, 40, AT + 70],
      [5, 20, AT + 120],
      [7, 5, AT + 250],
    ];
    for (const [id, dps, until] of own) addBleed(ctx, enemy(ctx, id), num(dps), until, 0, CENTER);
    return ctx;
  }

  it('gives a weaker or empty slot a copy of the source’s bleed and leaves a stronger one or an equal one as it is', () => {
    // Plants: the copy written past addBleed's rule, a fresh bleedDuration, the source's dps
    // without effect.
    const ctx = weaker();
    const before = ctx.enemies.map(slot);
    const [spread] = spreadsOf(spreadFrom(ctx, enemy(ctx, 1)));
    const copy = { dps: 12, until: AT + 200, start: AT, source: CENTER };
    expect(ctx.enemies.map(slot)).toEqual([
      before[0],
      before[1],
      copy,
      before[3],
      before[4],
      copy,
      copy,
    ]);
    // Its end is the source's, not a fresh one (bleedDuration 4 s: AT + 240).
    expect(ctx.bleedTicks).toBe(240);
    expect(spread?.targets).toBe(3);
  });

  it('copies effect × the source’s damage per second, which decides which slots it takes', () => {
    const ctx = weaker(0.5);
    const before = ctx.enemies.map(slot);
    const [spread] = spreadsOf(spreadFrom(ctx, enemy(ctx, 1)));
    // 6/s for 200 ticks (1200) takes 3 (740) and 6 (none) but not 7 (1250).
    const copy = { dps: 6, until: AT + 200, start: AT, source: CENTER };
    expect(ctx.enemies.map(slot)).toEqual([
      before[0],
      before[1],
      copy,
      before[3],
      before[4],
      copy,
      before[6],
    ]);
    expect(spread?.targets).toBe(2);
  });

  it('keeps the source’s own bleed whole and gives it no copy', () => {
    const ctx = weaker();
    const source = enemy(ctx, 1);
    const own = slot(source);
    const pending = source.bleedPending;
    spreadFrom(ctx, source);
    expect(slot(source)).toEqual(own);
    expect(source.bleedPending).toBe(pending);
  });

  it('banks what a replaced bleed dealt since the last step, as any stronger bleed does', () => {
    const ctx = weaker();
    const target = enemy(ctx, 3);
    // 2/s from AT to AT + 30, never stepped (the last step was tick 0).
    ctx.now = AT + 30;
    spreadFrom(ctx, enemy(ctx, 1));
    expect(toNumber(target.bleedPending)).toBeCloseTo(2 * 30 * (1 / 60), 12);
    expect(slot(target)).toEqual({ dps: 12, until: AT + 200, start: AT + 30, source: CENTER });
  });

  it('applies 元素護盾’s ward to a warded target’s copy', () => {
    const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 3), { v3: true });
    (enemy(ctx, 3).v3 as EnemyV3).defence |= WARDED;
    addBleed(ctx, enemy(ctx, 1), num(12), AT + 200, 0, CENTER);
    spreadFrom(ctx, enemy(ctx, 1));
    expect([toNumber(enemy(ctx, 2).bleedDps), toNumber(enemy(ctx, 3).bleedDps)]).toEqual([
      12,
      12 * WARD_AILMENT_MULT,
    ]);
  });
});

describe('S2: credit and depth', () => {
  it('credits the copy to the source bleed’s credit, not to the trigger’s source', () => {
    // Plant: the copy credited to the trigger's source (outer.bleed).
    for (const credit of ['center', 'fusion.ice.fire']) {
      const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 2));
      const outer = ctx.sources.index('outer.bleed');
      const ix = ctx.sources.index(credit);
      addBleed(ctx, enemy(ctx, 1), num(12), AT + 200, 0, ix);
      spreadFrom(ctx, enemy(ctx, 1));
      expect(ctx.build.triggers[FIRST]?.source).toBe(outer);
      expect(enemy(ctx, 2).bleedSource, credit).toBe(ix);
    }
  });

  it('applies the copy at the effect’s depth, one below the source’s ailment depth, never raising a target’s', () => {
    const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 3));
    addBleed(ctx, enemy(ctx, 1), num(12), AT + 200, 1, CENTER);
    addBleed(ctx, enemy(ctx, 3), num(1), AT + 10, 0, CENTER);
    expect(enemy(ctx, 2).ailDepth).toBe(MAX_DEPTH);
    spreadFrom(ctx, enemy(ctx, 1));
    expect([enemy(ctx, 2).ailDepth, enemy(ctx, 3).ailDepth]).toEqual([2, 0]);
    expect(enemy(ctx, 3).bleedDps).toEqual(num(12));
  });
});

/**
 * The source 200 right of the player (id 1); id 2 at 195 and id 3 at 190 nearer the player, 5 and
 * 10 from it, the nearest of all; ids 4 to 7 farther, at 250, 240, 220 and 259 (50, 40, 20 and 59
 * from it).
 */
const MIXED: readonly PlacedEnemy[] = [200, 195, 190, 250, 240, 220, 259].map((d) => ({
  x: PX + d,
  y: PY,
}));

describe('S4: targets, maxTargets and order', () => {
  const run = (more: Partial<BleedSpread>): { ids: number[]; targets: number | undefined } => {
    const ctx = scene(river(more), MIXED);
    addBleed(ctx, enemy(ctx, 1), num(10), AT + 200, 0, CENTER);
    const [spread] = spreadsOf(spreadFrom(ctx, enemy(ctx, 1)));
    return { ids: bleeding(ctx).filter((id) => id !== 1), targets: spread?.targets };
  };

  it('filters behind before maxTargets counts, so an enemy nearer the player uses no slot', () => {
    // Plant: behind filtering after the cap (ids 2 and 3 would take both slots and be dropped).
    expect(run({ maxTargets: 2 })).toEqual({ ids: [4, 5], targets: 2 });
    expect(run({ maxTargets: 3 })).toEqual({ ids: [4, 5, 6], targets: 3 });
    expect(run({ maxTargets: 9 })).toEqual({ ids: [4, 5, 6, 7], targets: 4 });
    expect(run({})).toEqual({ ids: [4, 5, 6, 7], targets: 4 });
  });

  it("takes the nearest to the source first with order 'nearest', among the enemies behind it", () => {
    // Plant: the nearest picked before behind filters (ids 2 and 3, then dropped).
    expect(run({ maxTargets: 2, order: 'nearest' })).toEqual({ ids: [5, 6], targets: 2 });
    expect(run({ maxTargets: 1, order: 'nearest' })).toEqual({ ids: [6], targets: 1 });
    expect(run({ maxTargets: 2, order: 'id' })).toEqual({ ids: [4, 5], targets: 2 });
    expect(run({ maxTargets: 2, order: 'nearest', behind: false })).toEqual({
      ids: [2, 3],
      targets: 2,
    });
  });

  it('never offers the source its own bleed, so it uses no slot', () => {
    // Plant: the source receiving its own copy (it keeps its own, but takes the one slot).
    expect(run({ maxTargets: 1, behind: false })).toEqual({ ids: [2], targets: 1 });
    expect(run({ maxTargets: 1, behind: false, order: 'nearest' })).toEqual({
      ids: [2],
      targets: 1,
    });
  });

  it('counts an enemy that keeps its stronger bleed in the cap, but not among the targets', () => {
    const ctx = scene(river({ maxTargets: 2 }), MIXED);
    addBleed(ctx, enemy(ctx, 1), num(10), AT + 200, 0, CENTER);
    addBleed(ctx, enemy(ctx, 4), num(50), AT + 200, 0, CENTER);
    const [spread] = spreadsOf(spreadFrom(ctx, enemy(ctx, 1)));
    expect(bleeding(ctx)).toEqual([1, 4, 5]);
    expect(toNumber(enemy(ctx, 4).bleedDps)).toBe(50);
    expect(spread?.targets).toBe(1);
  });

  it('reaches as far as the spread distance: 60 × spreadRadius × areaSize', () => {
    // ids 2 and 3 at 80 and 100 behind the source; 60 × 1.5 × 1.2 = 108 reaches both, 60 × 1.5
    // = 90 the first.
    const placed = [200, 280, 300].map((d) => ({ x: PX + d, y: PY }));
    const reach = (values: Partial<Record<StatId, number>>): number[] => {
      const ctx = scene(BLOOD_RIVER, placed, { values });
      addBleed(ctx, enemy(ctx, 1), num(10), AT + 200, 0, CENTER);
      const [spread] = spreadsOf(spreadFrom(ctx, enemy(ctx, 1)));
      expect(spread?.radius).toBeCloseTo(60 * (values.spreadRadius ?? 1) * (values.areaSize ?? 1));
      return bleeding(ctx);
    };
    expect(reach({})).toEqual([1]);
    expect(reach({ spreadRadius: 1.5 })).toEqual([1, 2]);
    expect(reach({ spreadRadius: 1.5, areaSize: 1.2 })).toEqual([1, 2, 3]);
  });
});

describe('S2, S5: a source without a live bleed', () => {
  it('moves nothing and raises no event when the source’s bleed has ended or it never bled', () => {
    // A hit trigger spreads from its target whether or not it bleeds.
    const onHit: TriggerSpec = { on: 'hit', do: [river({}).do[0] as BleedSpread] };
    const ctx = scene(onHit, OUTWARD.slice(0, 3));
    expect(spreadFrom(ctx, enemy(ctx, 1))).toEqual([]);
    // A bleed that ends at AT holds no more at AT.
    addBleed(ctx, enemy(ctx, 1), num(10), AT, 0, CENTER);
    ctx.now = AT - 10;
    addBleed(ctx, enemy(ctx, 1), num(10), AT, 0, CENTER);
    ctx.now = AT;
    expect(spreadFrom(ctx, enemy(ctx, 1))).toEqual([]);
    expect(bleeding(ctx)).toEqual([]);
    expect(enemy(ctx, 2).bleedUntil).toBe(0);
  });

  it('under bleedRings, moves nothing and raises no event when the source holds no live stack', () => {
    const onHit: TriggerSpec = { on: 'hit', do: [river({}).do[0] as BleedSpread] };
    const ctx = scene(onHit, OUTWARD.slice(0, 3), { modules: [BLEED_RINGS] });
    expect(spreadFrom(ctx, enemy(ctx, 1))).toEqual([]);
    ctx.now = AT - 10;
    applyBleed(ctx, enemy(ctx, 1), num(4), AT, 0, CENTER, 3);
    ctx.now = AT;
    expect(liveBleedStacks(ctx.rings, enemy(ctx, 1), AT)).toBe(0);
    expect(spreadFrom(ctx, enemy(ctx, 1))).toEqual([]);
    expect(ctx.enemies.map((e) => liveBleedStacks(ctx.rings, e, AT))).toEqual([0, 0, 0]);
  });
});

/** The rings of one enemy, slot by slot from RING_BLEED: stacks, damage left, credit, end. */
interface RingView {
  readonly slot: number;
  readonly stacks: number;
  readonly remaining: number;
  readonly credit: number;
  readonly cls: number;
  readonly end: number;
}

function bleedRings(ctx: RunContext, e: Enemy): RingView[] {
  const pool = ctx.rings;
  const views: RingView[] = [];
  for (let s = RING_BLEED; s < RING_BLEED + 3; s++) {
    const r = e.rings[s] as number;
    if (r < 0) continue;
    views.push({
      slot: s - RING_BLEED,
      stacks: pool.stacks[r] as number,
      remaining: pool.remaining[r] as number,
      credit: pool.credit[r] as number,
      cls: pool.cls[r] as number,
      end: pool.end[r] as number,
    });
  }
  return views;
}

const live = (ctx: RunContext): number[] =>
  ctx.enemies.map((e) => liveBleedStacks(ctx.rings, e, ctx.now));

describe('S2: under 大出血’s bleedRings, raised to the source’s count', () => {
  /** The source's 5 stacks of 4/s until AT + 120; ids 2 to 5 holding 2, 5, 7 and none. */
  function rings(effect?: number, v3 = false): RunContext {
    const placed = OUTWARD.slice(0, 5);
    const ctx = scene(river(effect === undefined ? {} : { effect }), placed, {
      modules: [BLEED_RINGS],
      v3,
    });
    const own: [number, number][] = [
      [1, 5],
      [2, 2],
      [3, 5],
      [4, 7],
    ];
    for (const [id, n] of own) applyBleed(ctx, enemy(ctx, id), num(4), AT + 120, 0, CENTER, n);
    return ctx;
  }

  it('raises a target below the source’s count to it and no further, and gives one at it or above nothing', () => {
    // Plants: a target raised past the source's count (to the cap), or one at it given more.
    const ctx = rings();
    const before = ctx.enemies.map((e) => bleedRings(ctx, e));
    const [spread] = spreadsOf(spreadFrom(ctx, enemy(ctx, 1)));
    expect(live(ctx)).toEqual([5, 5, 5, 7, 5]);
    expect(spread?.targets).toBe(2);
    // Those at the source's count or above, and the source itself, are as they were.
    for (const id of [1, 3, 4]) expect(bleedRings(ctx, enemy(ctx, id))).toEqual(before[id - 1]);
    expect(ctx.enemies.every((e) => e.bleedUntil === 0)).toBe(true);
  });

  it('adds each new stack at the source’s per-stack damage × effect, with its ring’s end, class and credit', () => {
    const ctx = rings(0.5);
    const [src] = bleedRings(ctx, enemy(ctx, 1));
    const [two] = bleedRings(ctx, enemy(ctx, 2));
    spreadFrom(ctx, enemy(ctx, 1));
    const per = (src as RingView).remaining / 5;
    // id 2: its own 2, and 3 at 0.5 of a source stack's damage left; id 5: 5 of them.
    expect(bleedRings(ctx, enemy(ctx, 2))).toEqual([
      {
        ...two,
        stacks: 5,
        remaining: expect.closeTo((two as RingView).remaining + 3 * 0.5 * per, 9),
      },
    ]);
    expect(bleedRings(ctx, enemy(ctx, 5))).toEqual([
      { ...src, remaining: expect.closeTo(5 * 0.5 * per, 9) },
    ]);
  });

  it('keeps each moved ring’s class and credit, taking the source’s rings in slot order', () => {
    // The source: 2 center stacks (4/s until AT + 120) and 3 of a fusion (6/s until AT + 90);
    // id 2: one outer stack. Raised to 5: both center stacks and 2 of the fusion's 3.
    const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 2), { modules: [BLEED_RINGS] });
    const fusion = ctx.sources.index('fusion.ice.fire');
    const outer = ctx.sources.index('outer.bleed');
    const [source, target] = [enemy(ctx, 1), enemy(ctx, 2)];
    applyBleed(ctx, source, num(4), AT + 120, 0, CENTER, 2);
    applyBleed(ctx, source, num(6), AT + 90, 0, fusion, 3);
    applyBleed(ctx, target, num(2), AT + 60, 0, outer, 1);
    const [center, fused] = bleedRings(ctx, source) as [RingView, RingView];
    const [own] = bleedRings(ctx, target) as [RingView];
    spreadFrom(ctx, source);
    expect(bleedRings(ctx, target)).toEqual([
      { ...center, remaining: expect.closeTo(center.remaining, 9) },
      own,
      { ...fused, stacks: 2, remaining: expect.closeTo((fused.remaining * 2) / 3, 9) },
    ]);
    expect(live(ctx)).toEqual([5, 5]);
    expect([own.cls, center.cls, fused.cls]).toEqual([1, 0, 2]);
  });

  it('before its tick’s DoT step, leaves the room an ending ring’s stacks did not fill to the next ring', () => {
    // A kill's spread can run on a step tick before the step: the source's 2 center stacks that
    // end at AT still count (liveBleedStacks reads a stack until its last step) but have no
    // damage left after now, so they move none. Plant: the room taken down by a ring's count,
    // not by the stacks it moved.
    const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 2), { modules: [BLEED_RINGS] });
    const outer = ctx.sources.index('outer.bleed');
    const [source, target] = [enemy(ctx, 1), enemy(ctx, 2)];
    ctx.now = 0;
    applyBleed(ctx, source, num(4), AT, 0, CENTER, 2);
    applyBleed(ctx, source, num(4), AT + 120, 0, CENTER, 1);
    applyBleed(ctx, source, num(6), AT + 90, 0, outer, 2);
    applyBleed(ctx, target, num(4), AT + 120, 0, CENTER, 2);
    ctx.now = AT;
    expect(live(ctx)).toEqual([5, 2]);
    spreadFrom(ctx, source);
    // The center ring's live stack and both outer ones: 2 + 1 + 2.
    expect(live(ctx)).toEqual([5, 5]);
    expect(bleedRings(ctx, target).map((r) => r.stacks)).toEqual([3, 2]);
  });

  it('before its tick’s DoT step, moves a ring’s lasting stacks whole, with their damage, when others of its stacks end at that step', () => {
    // A kill's spread on a step tick before the step: the source's center ring holds 3 stacks,
    // 2 of them ending at AT, and the target behind it 2, 1 or none of its own (room 1, 2 or 3).
    // Each time the one stack lasting past AT moves whole: 1 stack with its 8 of damage left (4/s
    // from AT to AT + 120), the target counted and its depth lowered. The room still counts the
    // 2 ending stacks, so after the step the target holds one more than before and the source 1.
    // Plant: the share read from all the ring's stacks (n = pool.stacks[r]), which at room 1 or
    // 2 moved 1/3 or 2/3 of its damage and no stack, and left the target uncounted.
    for (const own of [2, 1, 0]) {
      const label = `room ${3 - own}`;
      const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 2), { modules: [BLEED_RINGS] });
      const [source, target] = [enemy(ctx, 1), enemy(ctx, 2)];
      // Applied after the step at AT − 15, so no step is skipped before the one at AT.
      ctx.now = AT - 14;
      applyBleed(ctx, source, num(4), AT, 0, CENTER, 2);
      applyBleed(ctx, source, num(4), AT + 120, 0, CENTER, 1);
      if (own > 0) applyBleed(ctx, target, num(4), AT + 120, 2, CENTER, own);
      ctx.now = AT;
      expect(live(ctx), label).toEqual([3, own]);
      expect(target.ailDepth, label).toBe(own > 0 ? 2 : MAX_DEPTH);
      const had = bleedRings(ctx, target)[0]?.remaining ?? 0;
      const [spread] = spreadsOf(spreadFrom(ctx, source));
      expect(bleedRings(ctx, target), label).toEqual([
        {
          slot: 0,
          stacks: own + 1,
          remaining: expect.closeTo(had + 8, 9),
          credit: CENTER,
          cls: 0,
          end: AT + 120,
        },
      ]);
      expect(spread?.targets, label).toBe(1);
      expect(target.ailDepth, label).toBe(1);
    }
  });

  it('before its tick’s DoT step, counts the target’s own stacks that end at that step in its room, as liveBleedStacks does', () => {
    // The target's side of what D4 leaves: its center ring holds 3 stacks, 2 of them ending at
    // AT, so it has room for 1 of the source's 4, and after the step it holds 2. Plant: the
    // target's room counted from its stacks that last past now (liveCount), which took 3.
    const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 2), { modules: [BLEED_RINGS] });
    const [source, target] = [enemy(ctx, 1), enemy(ctx, 2)];
    ctx.now = AT - 14;
    applyBleed(ctx, source, num(4), AT + 120, 0, CENTER, 4);
    applyBleed(ctx, target, num(4), AT, 0, CENTER, 2);
    applyBleed(ctx, target, num(4), AT + 120, 0, CENTER, 1);
    ctx.now = AT;
    expect(live(ctx)).toEqual([4, 3]);
    const [spread] = spreadsOf(spreadFrom(ctx, source));
    expect(live(ctx)).toEqual([4, 4]);
    expect(spread?.targets).toBe(1);
  });

  it('moves nothing from a source ring whose stacks have all ended, though its step has not come', () => {
    // Off a step tick (a hit's spread, or one the effect budget deferred), a ring whose stacks
    // all ended before now still holds its count until its last step: it is not live, so it
    // moves no stack and no damage, and the room goes to the live rings. Plant: the ended
    // ring's stacks moved as live ones (its `end <= now` test dropped).
    const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 2), { modules: [BLEED_RINGS] });
    const outer = ctx.sources.index('outer.bleed');
    const [source, target] = [enemy(ctx, 1), enemy(ctx, 2)];
    // Both applied after the step at AT: 2 center stacks to AT + 5, 3 outer ones to AT + 120.
    ctx.now = AT + 1;
    applyBleed(ctx, source, num(4), AT + 5, 0, CENTER, 2);
    applyBleed(ctx, source, num(6), AT + 120, 0, outer, 3);
    ctx.now = AT + 10;
    const before = bleedRings(ctx, source);
    expect(before.map((r) => [r.slot, r.stacks, r.end])).toEqual([
      [0, 2, AT + 5],
      [1, 3, AT + 120],
    ]);
    expect(live(ctx)).toEqual([3, 0]);
    const [spread] = spreadsOf(spreadFrom(ctx, source));
    expect(live(ctx)).toEqual([3, 3]);
    const fromOuter = before[1] as RingView;
    expect(bleedRings(ctx, target)).toEqual([
      { ...fromOuter, remaining: expect.any(Number) as number },
    ]);
    expect(bleedRings(ctx, source)).toEqual(before);
    expect(spread?.targets).toBe(1);
  });

  it('moves nothing from a source ring whose stacks end at now, off a step tick, as from one that ended before', () => {
    // The boundary of the test above: a ring whose last stack ends at now holds no live stack
    // (liveBleedStacks reads end > now), though its count stays until its step. Plant: the
    // ring's end test read as `end < now`, which moved its 2 stacks into the target's room.
    const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 2), { modules: [BLEED_RINGS] });
    const outer = ctx.sources.index('outer.bleed');
    const [source, target] = [enemy(ctx, 1), enemy(ctx, 2)];
    // Both applied after the step at AT: 2 center stacks to AT + 10, 3 outer ones to AT + 120.
    ctx.now = AT + 1;
    applyBleed(ctx, source, num(4), AT + 10, 0, CENTER, 2);
    applyBleed(ctx, source, num(6), AT + 120, 0, outer, 3);
    ctx.now = AT + 10;
    const before = bleedRings(ctx, source);
    expect(live(ctx)).toEqual([3, 0]);
    const [spread] = spreadsOf(spreadFrom(ctx, source));
    expect(bleedRings(ctx, target)).toEqual([
      { ...(before[1] as RingView), remaining: expect.any(Number) as number },
    ]);
    expect(live(ctx)).toEqual([3, 3]);
    expect(bleedRings(ctx, source)).toEqual(before);
    expect(spread?.targets).toBe(1);
  });

  it('never raises a target past bleedMaxStacks, even when the source holds more', () => {
    // A source above the cap, which a run never makes (applyBleed caps every stack), shows the
    // cap bounds the raise too. Plant: the cap left out of the raise.
    const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 4), { modules: [BLEED_RINGS] });
    const n: [number, number][] = [
      [1, 8],
      [2, 2],
      [3, 6],
    ];
    for (const [id, k] of n) applyBleed(ctx, enemy(ctx, id), num(4), AT + 120, 0, CENTER, k);
    (ctx.build.flags as { bleedMaxStacks: number }).bleedMaxStacks = 6;
    const [spread] = spreadsOf(spreadFrom(ctx, enemy(ctx, 1)));
    expect(live(ctx)).toEqual([8, 6, 6, 6]);
    expect(spread?.targets).toBe(2);
  });

  it('applies 元素護盾’s ward to a warded target’s damage, the stack counts as they are', () => {
    // Plant: the raise skipping the ward.
    const ctx = rings(undefined, true);
    (enemy(ctx, 5).v3 as EnemyV3).defence |= WARDED;
    const [src] = bleedRings(ctx, enemy(ctx, 1)) as [RingView];
    spreadFrom(ctx, enemy(ctx, 1));
    expect(bleedRings(ctx, enemy(ctx, 5))).toEqual([
      { ...src, remaining: expect.closeTo(src.remaining * WARD_AILMENT_MULT, 9) },
    ]);
  });

  it('raises the targets at the effect’s depth, behind and in reach only', () => {
    const ctx = scene(BLOOD_RIVER, AROUND, { modules: [BLEED_RINGS] });
    applyBleed(ctx, enemy(ctx, 1), num(4), AT + 120, 1, CENTER, 3);
    spreadFrom(ctx, enemy(ctx, 1));
    expect(live(ctx)).toEqual([3, 0, 0, 3, 0]);
    expect(enemy(ctx, 4).ailDepth).toBe(2);
  });

  it('lowers a raised target’s depth to the effect’s, never raising it', () => {
    // The source at depth 1 spreads at depth 2: id 2, holding a hit's stack (depth 0), keeps
    // depth 0; id 3, holding none, takes depth 2. Plant: the raise setting the target's depth
    // whatever it was.
    const ctx = scene(BLOOD_RIVER, OUTWARD.slice(0, 3), { modules: [BLEED_RINGS] });
    applyBleed(ctx, enemy(ctx, 1), num(4), AT + 120, 1, CENTER, 3);
    applyBleed(ctx, enemy(ctx, 2), num(4), AT + 120, 0, CENTER, 1);
    const [spread] = spreadsOf(spreadFrom(ctx, enemy(ctx, 1)));
    expect(live(ctx)).toEqual([3, 3, 3]);
    expect(spread?.targets).toBe(2);
    expect(ctx.enemies.map((e) => e.ailDepth)).toEqual([1, 0, 2]);
  });
});

describe('S5: the event', () => {
  it('raises one ailmentSpread of bleed per run, at the source, with the enemies that took it', () => {
    // Plant: the event pushed as poison.
    const ctx = scene(BLOOD_RIVER, AROUND, { values: { spreadRadius: 1.5 } });
    const source = enemy(ctx, 1);
    addBleed(ctx, source, num(10), AT + 200, 0, CENTER);
    const events = spreadFrom(ctx, source);
    expect(events).toEqual([
      {
        type: 'ailmentSpread',
        ailment: 'bleed',
        enemyId: 1,
        x: PX + 200,
        y: PY,
        radius: 90,
        targets: 2,
      },
    ]);
    // Again: every enemy behind holds the copy already, so none takes it.
    expect(spreadsOf(spreadFrom(ctx, source))).toEqual([{ ...events[0], targets: 0 }]);
  });

  it('raises no ailmentApplied for a copy, as no spread does', () => {
    const ctx = scene(BLOOD_RIVER, OUTWARD, { modules: [BLEED_RINGS] });
    applyBleed(ctx, enemy(ctx, 1), num(4), AT + 120, 0, CENTER, 3);
    const types = spreadFrom(ctx, enemy(ctx, 1)).map((e) => e.type);
    expect(types).toEqual(['ailmentSpread']);
  });
});

describe('through the trigger (B3’s 血河)', () => {
  /** The source alone with one enemy behind it, out of reach. */
  const ALONE = [200, 400].map((d) => ({ x: PX + d, y: PY }));

  it('spreads every 0.5 s while the source bleeds, at the DoT steps of even index', () => {
    const at = (trigger: TriggerSpec): number[] => {
      const ctx = scene(trigger, ALONE);
      ctx.now = 1;
      addBleed(ctx, enemy(ctx, 1), num(10), 241, 0, CENTER);
      return spreadTicks(advance(ctx, 300));
    };
    expect(at(BLOOD_RIVER)).toEqual([30, 60, 90, 120, 150, 180, 210, 240]);
    expect(at(river({}, 0.25))).toEqual([
      15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240,
    ]);
  });

  it('fires for an enemy that holds only bleed rings under bleedRings', () => {
    const ctx = scene(BLOOD_RIVER, ALONE, { modules: [BLEED_RINGS] });
    ctx.now = 1;
    applyBleed(ctx, enemy(ctx, 1), num(4), 121, 0, CENTER, 3);
    const byTick = advance(ctx, 200);
    expect(enemy(ctx, 1).bleedUntil).toBe(0);
    expect(spreadTicks(byTick)).toEqual([30, 60, 90, 120]);
  });

  it('carries a bleed outwards along a line one enemy a firing, until MAX_DEPTH stops the chain', () => {
    // 50 apart from the source outwards. The hit's bleed (depth 0) spreads at depth 1, its copy
    // at 2 and that one's at 3; the enemy holding the depth-3 copy is capped at each firing
    // (120 and 150), so the fifth enemy never bleeds.
    const placed = [200, 250, 300, 350, 400].map((d) => ({ x: PX + d, y: PY }));
    const ctx = scene(BLOOD_RIVER, placed);
    ctx.now = 1;
    addBleed(ctx, enemy(ctx, 1), num(10), 241, 0, CENTER);
    const byTick = advance(ctx, 150);
    const reached = [...byTick].flatMap(([tick, events]) =>
      spreadsOf(events).map((e) => `${tick}: ${e.enemyId} → ${e.targets}`),
    );
    expect(reached).toEqual([
      '30: 1 → 1',
      '60: 1 → 0',
      '60: 2 → 1',
      '90: 1 → 0',
      '90: 2 → 0',
      '90: 3 → 1',
      '120: 1 → 0',
      '120: 2 → 0',
      '120: 3 → 0',
      '150: 1 → 0',
      '150: 2 → 0',
      '150: 3 → 0',
    ]);
    expect(ctx.enemies.map((e) => [e.ailDepth, e.bleedUntil])).toEqual([
      [0, 241],
      [1, 241],
      [2, 241],
      [3, 241],
      [MAX_DEPTH, 0],
    ]);
    expect(ctx.counters.triggerDepthCapped).toBe(2);
  });

  it('plays the same events twice at one seed, and spreads in a run of bleeding hits', () => {
    const stats = makeStats(
      { damage: 4, bleedChance: 0.3, igniteChance: 0, maxLife: 1e6, projectileCount: 2 },
      [],
      { triggers: [{ source: 'outer.bleed', spec: BLOOD_RIVER }], conversions: [], emitters: [] },
    );
    const run = (seed: number): { json: string; spreads: number; reached: number } => {
      const sim = createSimulation(
        makeConfig({ stats, seed, startWave: 12, maxTicks: 900 }),
        makeTestData(),
      );
      const events: SimEvent[] = [];
      while (!sim.state.finished) events.push(...sim.step(NO_INPUT));
      const spreads = spreadsOf(events).filter((e) => e.ailment === 'bleed');
      return {
        json: JSON.stringify(events),
        spreads: spreads.length,
        reached: spreads.reduce((sum, e) => sum + e.targets, 0),
      };
    };
    const first = run(1);
    expect(run(1)).toEqual(first);
    expect(first.spreads).toBeGreaterThan(20);
    expect(first.reached).toBeGreaterThan(5);
    expect(run(2).json).not.toBe(first.json);
  });
});

describe('spreadBleed, called directly', () => {
  it('takes its cap, order and behind as the executor passes them', () => {
    const ctx = scene(BLOOD_RIVER, MIXED);
    const source = enemy(ctx, 1);
    addBleed(ctx, source, num(10), AT + 200, 0, CENTER);
    const spread = { radius: 60, radiusSq: 3600, effect: 1 };
    spreadBleed(ctx, source, spread, 1, 0, true, true);
    expect(bleeding(ctx)).toEqual([1, 6]);
    spreadBleed(ctx, source, spread, Infinity, 0, false, false);
    expect(bleeding(ctx)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
