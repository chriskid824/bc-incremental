import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import { createRng } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { EmitterGrant, SegmentGrant, SourcedEmitter } from '../../data/emitters';
import type { Modifier, StatBlock, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TriggerSpec } from '../../data/triggers';
import type { EnemyId } from '../../data/types';
import { addShock } from '../ailments/shock';
import { statAt } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { SHATTER_TRIGGER } from '../effects/types';
import type { CompiledTrigger } from '../effects/types';
import { grantEmitter, SLOT_HIT, SLOT_HIT_CRIT, slotRow } from '../emitters/types';
import type { EmitterRuntime, Payload, SegmentSpec } from '../emitters/types';
import { createSimulation } from '../simulation';
import {
  makeConfig,
  makeStats,
  placedEnemies,
  rngPositions,
  segDistSqRef,
  stationarySquares,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import type { Enemy, RunContext } from './context';
import { EMITTER_STEPS } from './emitters';
import { stepSegments } from './segments';

type PulseEvent = Extract<SimEvent, { type: 'pulse' }>;

/** 雷網 at its defaults: links 2, range 200, 10% of the damage stat, 1 shock stack, 0.25 s. */
const WEB: SegmentGrant = { kind: 'segment', endpoints: 'shocked' };
const webOn = (source: string, grant: EmitterGrant = WEB): SourcedEmitter => ({ source, grant });

/** Where these tests' enemies stand: 400 right of the player. */
const C = { x: ARENA_WIDTH / 2 + 400, y: ARENA_HEIGHT / 2 };
/** An enemy (dx, dy) from C. */
const at = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: C.x + dx,
  y: C.y + dy,
  ...extra,
});

/**
 * Stats with damage 1000 (a segment hit of 100 at the default share) and no crits unless
 * `values` say so, with these segment grants, center triggers and scoped modifiers.
 */
function segStats(
  values: Partial<Record<StatId, number>> = {},
  grants: readonly SourcedEmitter[] = [webOn('outer.lightning')],
  triggers: readonly (readonly [string, TriggerSpec])[] = [],
  scoped: readonly Modifier[] = [],
): StatBlock {
  return makeStats({ damage: 1000, critChance: 0, critMultiplier: 2, ...values }, scoped, {
    triggers: triggers.map(([source, spec]) => ({ source, spec })),
    conversions: [],
    emitters: grants,
  });
}

interface SegOptions {
  readonly values?: Partial<Record<StatId, number>>;
  readonly grants?: readonly SourcedEmitter[];
  readonly triggers?: readonly (readonly [string, TriggerSpec])[];
  readonly scoped?: readonly Modifier[];
  /** Ids of the enemies shocked with one stack before anything runs. */
  readonly shocked?: readonly number[];
  readonly seed?: number;
}

/** placedEnemies with segStats, and the `shocked` enemies holding one shock stack. */
function segCtx(placed: readonly PlacedEnemy[], options: SegOptions = {}): RunContext {
  const ctx = placedEnemies(placed, {
    stats: segStats(options.values, options.grants, options.triggers, options.scoped),
    seed: options.seed ?? 1,
  });
  for (const id of options.shocked ?? []) addShock(ctx, enemy(ctx, id), 1, 0);
  return ctx;
}

/** The enemy with id `id` (placedEnemies numbers them 1, 2, … in order). */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

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

const pulsesOf = (events: readonly SimEvent[]): PulseEvent[] =>
  events.filter((event): event is PulseEvent => event.type === 'pulse');

/** Damage taken so far by each enemy, by id. */
const lossOf = (ctx: RunContext, id: number): number =>
  toNumber(enemy(ctx, id).maxHp) - toNumber(enemy(ctx, id).hp);

/** Ids of the enemies that have taken damage. */
const damagedIds = (ctx: RunContext): number[] =>
  ctx.enemies.filter((e) => toNumber(e.hp) < toNumber(e.maxHp)).map((e) => e.id);

/** The segment lines of emitter `i`, each as its two ends' "x,y" keys sorted, in line order. */
function linesOf(ctx: RunContext, i = 0): string[] {
  const ln = ctx.state.segments.lines[i];
  if (ln === undefined) throw new Error(`no lines for segment emitter ${i}`);
  return Array.from({ length: ln.count }, (_, s) =>
    lineKey(ln.x1[s] as number, ln.y1[s] as number, ln.x2[s] as number, ln.y2[s] as number),
  );
}

const lineKey = (x1: number, y1: number, x2: number, y2: number): string =>
  [`${x1},${y1}`, `${x2},${y2}`].sort().join(' | ');

/**
 * Reference judgement by brute force over all enemies and all pairs: the endpoints are the
 * alive shocked enemies; each picks its `links` nearest other endpoints within `range` (ties to
 * the lower id); a link two endpoints both pick is one; every alive enemy within its radius of
 * a link is hit once.
 */
function referenceJudgement(
  enemies: readonly Enemy[],
  now: number,
  links: number,
  range: number,
): { ends: number; lines: string[]; hit: number[] } {
  const ends = enemies.filter((e) => e.alive && e.shockStacks > 0 && e.shockUntil > now);
  const pairs = new Map<string, [Enemy, Enemy]>();
  ends.forEach((e, i) => {
    const near = ends
      .map((o, j) => [(o.x - e.x) ** 2 + (o.y - e.y) ** 2, j] as const)
      .filter(([d, j]) => j !== i && d <= range * range)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .slice(0, links);
    for (const [, j] of near) {
      const o = ends[j] as Enemy;
      const key = e.id < o.id ? `${e.id}-${o.id}` : `${o.id}-${e.id}`;
      if (!pairs.has(key)) pairs.set(key, [e, o]);
    }
  });
  const segs = [...pairs.values()];
  const hit = enemies
    .filter(
      (e) =>
        e.alive &&
        segs.some(([a, b]) => segDistSqRef(e.x, e.y, a.x, a.y, b.x, b.y) <= e.radius * e.radius),
    )
    .map((e) => e.id);
  return {
    ends: ends.length,
    lines: segs.map(([a, b]) => lineKey(a.x, a.y, b.x, b.y)).sort(),
    hit,
  };
}

/** Random fixtures for the reference tests: lattice points (ties), jitter, tough and dead ones. */
const TYPES: readonly EnemyId[] = ['square', 'triangle', 'pentagon', 'shard', 'hexagon', 'boss'];

function randomFixture(rng: Rng): { placed: PlacedEnemy[]; shocked: number[]; dead: number[] } {
  const count = [2, 3, 5, 12, 40, 150, 260][rng.int(7)] as number;
  // Mostly by C; sometimes by the arena's corner, so some stand in the outer ring's cells.
  const [cx, cy] = rng.chance(0.75) ? [C.x, C.y] : [ARENA_WIDTH - 60, 60];
  const spread = [150, 300, 600][rng.int(3)] as number;
  const shockShare = [0.2, 0.5, 0.9][rng.int(3)] as number;
  const placed: PlacedEnemy[] = [];
  const shocked: number[] = [];
  const dead: number[] = [];
  for (let id = 1; id <= count; id++) {
    const lattice = rng.chance(0.5);
    const x = lattice ? cx + 30 * (rng.int(21) - 10) : cx + rng.range(-spread, spread);
    const y = lattice ? cy + 30 * (rng.int(15) - 7) : cy + rng.range(-spread, spread);
    placed.push({ x, y, type: TYPES[rng.int(TYPES.length)] as EnemyId, hp: 1e6 });
    if (rng.chance(shockShare)) shocked.push(id);
    if (rng.chance(0.05)) dead.push(id);
  }
  return { placed, shocked, dead };
}

describe('segment grants', () => {
  it('compile to a segment emitter of the defaults: a pulse payload that crits and rolls nothing', () => {
    const spec = grantEmitter('outer.lightning', WEB) as SegmentSpec;
    expect(spec).toEqual({
      kind: 'segment',
      signature: false,
      source: 'outer.lightning',
      damagePct: 0.1,
      tags: TAG.hit | TAG.lightning | TAG.area,
      chains: false,
      rollsAilments: false,
      canCrit: true,
      endpoints: 'shocked',
      links: 2,
      range: 200,
      shockStacks: 1,
      periodSec: 0.25,
    });
    const full: SegmentGrant = {
      kind: 'segment',
      endpoints: 'shocked',
      links: 1,
      range: 150,
      damagePct: 0.3,
      shockStacks: 2,
      periodSec: 0.5,
    };
    expect(grantEmitter('center', full)).toMatchObject({ ...full, kind: 'segment' });

    const ctx = segCtx([], { grants: [webOn('outer.lightning'), webOn('center', full)] });
    const segs = ctx.sys.segments.emitters;
    expect(segs.map((em) => [em.index, em.interval, em.timer, em.payload.aggregate])).toEqual([
      // Phases (3 + 4 × index) % 15: 7 and 11 ticks.
      [1, 15, -7, true],
      [2, 30, -11, true],
    ]);
    expect(segs.map((em) => toNumber(em.payload.baseDamage))).toEqual([100, 300]);
    // The emitter stage steps only the signature; the segment stage has its own list.
    expect(ctx.emitters.filter((em) => EMITTER_STEPS[em.spec.kind] !== null)).toEqual([
      ctx.emitters[0],
    ]);
    expect(segs).toEqual(ctx.emitters.slice(1));
    expect(ctx.thornsEmitters).toEqual([]);
    expect(ctx.emitters[0]?.timer).toBe(0);
    // SimState.segments is the stage's state, one line set per segment emitter.
    expect(ctx.state.segments).toBe(ctx.sys.segments);
    expect(ctx.state.segments.lines.map((ln) => ln.count)).toEqual([0, 0]);
  });

  it('take the phase (3 + 4 × index) % 15 whatever their period, and judge from it', () => {
    // Indices 1–4; index 3's phase wraps to 0, and its period is 30 ticks, not 15.
    const half: SegmentGrant = { kind: 'segment', endpoints: 'shocked', periodSec: 0.5 };
    const ctx = segCtx([at(0, 0), at(100, 0)], {
      values: { shockDuration: 100 },
      grants: [webOn('outer.lightning'), webOn('center'), webOn('hub', half), webOn('outer.fire')],
      shocked: [1, 2],
    });
    const segs = ctx.sys.segments.emitters;
    expect(segs.map((em) => [em.index, em.interval, em.timer + 0])).toEqual([
      [1, 15, -7],
      [2, 15, -11],
      [3, 30, 0],
      [4, 15, -4],
    ]);
    const first = new Map<number, number>();
    for (let t = 1; t <= 60; t++) {
      if (t > 1) ctx.now = ++ctx.state.tick;
      ctx.events.length = 0;
      stepSegments(ctx);
      for (const pulse of pulsesOf(ctx.events)) if (!first.has(pulse.id)) first.set(pulse.id, t);
    }
    expect([...first].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 22],
      [2, 26],
      [3, 30],
      [4, 19],
    ]);
  });

  it('keep the remainder of a fractional period: 0.375 s judges 22 and 23 ticks apart', () => {
    // periodSec 0.375 is 22.5 ticks; from the phase 7, the timer reaches it at ticks 30, 52, 75,
    // 97 and 120, its half tick carried over from one judgement to the next.
    const grant: SegmentGrant = { kind: 'segment', endpoints: 'shocked', periodSec: 0.375 };
    const ctx = segCtx([at(0, 0), at(100, 0)], {
      values: { shockDuration: 100 },
      grants: [webOn('outer.lightning', grant)],
      shocked: [1, 2],
    });
    expect(ctx.sys.segments.emitters[0]?.interval).toBe(22.5);
    const ticks: number[] = [];
    for (let t = 1; t <= 130; t++) {
      if (t > 1) ctx.now = ++ctx.state.tick;
      ctx.events.length = 0;
      stepSegments(ctx);
      if (pulsesOf(ctx.events).length > 0) ticks.push(t);
    }
    expect(ticks).toEqual([30, 52, 75, 97, 120]);
  });
});

describe('segment judgements (D18)', () => {
  it('writes each emitter’s links to its own line set, leaving the others’ alone', () => {
    // 1–2 is 100, 2–3 is 120 and 1–3 is 156.2: the center segment (1 link within 150) draws
    // 1–2 and 2–3, 雷網 (2 links within 200) all three.
    const one: SegmentGrant = { kind: 'segment', endpoints: 'shocked', links: 1, range: 150 };
    const ctx = segCtx([at(0, 0), at(100, 0), at(100, 120)], {
      grants: [webOn('outer.lightning'), webOn('center', one)],
      shocked: [1, 2, 3],
    });
    const [web, center] = ctx.state.segments.lines;
    const p = (id: number): [number, number] => [enemy(ctx, id).x, enemy(ctx, id).y];
    const key = (a: number, b: number): string => lineKey(...p(a), ...p(b));
    judgeNow(ctx, 1);
    expect([web?.count, center?.count]).toEqual([0, 2]);
    expect(linesOf(ctx, 1).sort()).toEqual([key(1, 2), key(2, 3)].sort());
    judgeNow(ctx, 0);
    expect([web?.count, center?.count]).toEqual([3, 2]);
    expect(linesOf(ctx, 0).sort()).toEqual([key(1, 2), key(1, 3), key(2, 3)].sort());
    expect(linesOf(ctx, 1).sort()).toEqual([key(1, 2), key(2, 3)].sort());
  });

  it('starts each judgement’s tally over: its pulse totals and crits only its own hits', () => {
    const ctx = segCtx([at(0, 0, { hp: 1e6 }), at(100, 0, { hp: 1e6 })], {
      values: { critChance: 1, shockDuration: 100, shockMaxStacks: 100 },
      shocked: [1, 2],
    });
    for (let n = 0; n < 3; n++) {
      const before = lossOf(ctx, 1) + lossOf(ctx, 2);
      const [pulse] = pulsesOf(judgeNow(ctx));
      if (pulse === undefined) throw new Error(`no pulse at judgement ${n}`);
      expect([pulse.hits, pulse.crits]).toEqual([2, [1, 2]]);
      const dealt = lossOf(ctx, 1) + lossOf(ctx, 2) - before;
      // 2 crits of 200 each, raised by the shock stacks they held (1, 2, then 3).
      expect(toNumber(pulse.total)).toBeCloseTo(dealt, 6);
      expect(dealt).toBeGreaterThan(400);
    }
  });

  it('hits an enemy whose centre lies exactly its radius from a link, and not one farther', () => {
    // 3, of radius 20, stands 20 from the link 1–2 (the range of the hit is inclusive).
    expect(segDistSqRef(C.x + 50, C.y + 20, C.x, C.y, C.x + 100, C.y)).toBe(400);
    const ctx = segCtx([at(0, 0), at(100, 0), at(50, 20, { radius: 20 })], { shocked: [1, 2] });
    expect(pulsesOf(judgeNow(ctx))[0]?.hits).toBe(3);
    expect(damagedIds(ctx)).toEqual([1, 2, 3]);
    const off = segCtx([at(0, 0), at(100, 0), at(50, 20.5, { radius: 20 })], { shocked: [1, 2] });
    expect(pulsesOf(judgeNow(off))[0]?.hits).toBe(2);
    expect(damagedIds(off)).toEqual([1, 2]);
  });

  it('hits every enemy on a link through a crowd past the box query’s first scratch', () => {
    // 300 squares on the link 1–2, more than RunContext.candidates holds at first.
    const crowd = Array.from({ length: 300 }, (_, k) =>
      at(1 + (k % 198), ((k % 3) - 1) * 5, { hp: 1e6 }),
    );
    const ctx = segCtx([at(0, 0), at(200, 0), ...crowd], { shocked: [1, 2] });
    expect(ctx.candidates.length).toBeLessThan(ctx.enemies.length);
    const [pulse] = pulsesOf(judgeNow(ctx));
    expect(pulse?.hits).toBe(302);
    expect(damagedIds(ctx)).toHaveLength(302);
  });

  it('match a brute-force reference on random fixtures: links, hits, lines and shock', () => {
    const rng = createRng(20261019);
    let sorted = 0;
    let busy = 0;
    let tough = 0;
    for (let trial = 0; trial < 160; trial++) {
      const { placed, shocked, dead } = randomFixture(rng);
      const links = rng.chance(0.5) ? 1 : 2;
      const range = [60, 120, 200, 350][rng.int(4)] as number;
      const grant: SegmentGrant = { kind: 'segment', endpoints: 'shocked', links, range };
      const ctx = segCtx(placed, { grants: [webOn('outer.lightning', grant)], shocked });
      for (const id of dead) enemy(ctx, id).alive = false;
      const before = ctx.enemies.map((e) => [e.shockStacks, e.shockUntil]);
      const ref = referenceJudgement(ctx.enemies, ctx.now, links, range);
      const pulses = pulsesOf(judgeNow(ctx));

      expect(linesOf(ctx).sort(), `trial ${trial}`).toEqual(ref.lines);
      expect(ref.lines.length).toBeLessThanOrEqual(links * ref.ends);
      expect(damagedIds(ctx), `trial ${trial}`).toEqual(ref.hit);
      if (ref.ends < 2) {
        expect(pulses).toEqual([]);
      } else {
        // Each hit enemy once: as many hits as enemies hit.
        expect(pulses).toHaveLength(1);
        const pulse = pulses[0] as PulseEvent;
        expect(pulse.hits).toBe(ref.hit.length);
        const total = ref.hit.reduce((sum, id) => sum + lossOf(ctx, id), 0);
        expect(toNumber(pulse.total)).toBeCloseTo(total, 4);
      }
      // Every enemy hit takes one shock stack after its hit, without a roll; the rest keep theirs.
      ctx.enemies.forEach((e, k) => {
        const [stacks, until] = before[k] as number[];
        const active = (until as number) > ctx.now ? (stacks as number) : 0;
        expect([e.shockStacks, e.shockUntil], `trial ${trial}, enemy ${e.id}`).toEqual(
          ref.hit.includes(e.id)
            ? [Math.min(3, active + 1), ctx.now + 2 * TICK_RATE]
            : [stacks, until],
        );
      });
      if (ref.ends >= 128) sorted++;
      if (ref.lines.length >= 20) busy++;
      if (ref.hit.some((id) => enemy(ctx, id).tough)) tough++;
    }
    // The fixtures reach the sorted endpoint grid, crowded judgements and tough enemies.
    expect(sorted).toBeGreaterThan(5);
    expect(busy).toBeGreaterThan(20);
    expect(tough).toBeGreaterThan(20);
  });

  it('links each endpoint to its nearest within range, the range included, ties to the lower id', () => {
    // 1 and 2 are 200 apart (the range, included); 3 ties with 4 at 100 from 5; 6 is alone.
    const placed = [at(0, 0), at(200, 0), at(0, 300), at(200, 300), at(100, 300), at(600, 600)];
    const grant: SegmentGrant = { kind: 'segment', endpoints: 'shocked', links: 1 };
    const ctx = segCtx(placed, {
      grants: [webOn('outer.lightning', grant)],
      shocked: [1, 2, 3, 4, 5, 6],
    });
    judgeNow(ctx);
    const p = (id: number): [number, number] => [enemy(ctx, id).x, enemy(ctx, id).y];
    const key = (a: number, b: number): string => lineKey(...p(a), ...p(b));
    // 3 and 4 each pick 5 (100) over the other (200); 5 picks 3, the lower of the two.
    expect(linesOf(ctx).sort()).toEqual([key(1, 2), key(3, 5), key(4, 5)].sort());
    expect(damagedIds(ctx)).toEqual([1, 2, 3, 4, 5]);

    // One unit further, 1 and 2 no longer link.
    const far = segCtx([at(0, 0), at(200.5, 0)], { shocked: [1, 2] });
    expect(pulsesOf(judgeNow(far))).toMatchObject([{ hits: 0 }]);
    expect(far.state.segments.lines[0]?.count).toBe(0);
  });

  it('makes at most 2 links per endpoint, one for a pair that picks each other', () => {
    // A square of side 100 with its centre 5: every corner's two nearest are 5 and the lower of
    // its two neighbours (a tie), and 5's are 1 and 2 (a four-way tie); 7 links of at most 10.
    const placed = [at(-50, -50), at(50, -50), at(-50, 50), at(50, 50), at(0, 0)];
    const ctx = segCtx(placed, { shocked: [1, 2, 3, 4, 5] });
    judgeNow(ctx);
    const p = (id: number): [number, number] => [enemy(ctx, id).x, enemy(ctx, id).y];
    const key = (a: number, b: number): string => lineKey(...p(a), ...p(b));
    expect(linesOf(ctx).sort()).toEqual(
      [key(1, 5), key(1, 2), key(2, 5), key(3, 5), key(1, 3), key(4, 5), key(2, 4)].sort(),
    );
    expect(ctx.state.segments.lines[0]?.count).toBe(7);
    const ref = referenceJudgement(ctx.enemies, ctx.now, 2, 200);
    expect(ref.lines).toEqual(linesOf(ctx).sort());
  });

  it('hits an enemy on several links once', () => {
    // 1–2 and 1–3 both pass within 40 of the hexagon 4 at 1's corner; 5 is on 1–2 only.
    const placed = [
      at(0, 0),
      at(150, 0),
      at(0, 150),
      at(10, 10, { type: 'hexagon', radius: 40 }),
      at(100, 0, { type: 'hexagon', radius: 40 }),
    ];
    const ctx = segCtx(placed, { shocked: [1, 2, 3] });
    const [pulse] = pulsesOf(judgeNow(ctx));
    expect(linesOf(ctx)).toHaveLength(2);
    expect(pulse?.hits).toBe(5);
    expect(lossOf(ctx, 4)).toBe(100);
    expect(lossOf(ctx, 5)).toBe(100);
  });

  it('hits a tough enemy whose centre lies outside the padded box but its radius on the link', () => {
    const ctx = segCtx([at(0, 0), at(150, 0)], { shocked: [1, 2] });
    const pad = ctx.shotPad;
    // A boss of radius 70 whose centre stands farther from the link than the pad but within 70.
    const off = (pad + 70) / 2;
    expect(off).toBeGreaterThan(pad);
    const ctx2 = segCtx([at(0, 0), at(150, 0), at(75, off, { type: 'boss' })], {
      shocked: [1, 2],
    });
    expect(enemy(ctx2, 3).tough).toBe(true);
    const [pulse] = pulsesOf(judgeNow(ctx2));
    expect(pulse?.hits).toBe(3);
    expect(damagedIds(ctx2)).toEqual([1, 2, 3]);
    // Just beyond its radius, it is missed.
    const ctx3 = segCtx([at(0, 0), at(150, 0), at(75, 70.5, { type: 'boss' })], {
      shocked: [1, 2],
    });
    expect(pulsesOf(judgeNow(ctx3))[0]?.hits).toBe(2);
  });

  it('hits in id order, drawing one crit roll per hit and no ailment roll on the combat stream', () => {
    const values = {
      critChance: 0.5,
      igniteChance: 1,
      poisonChance: 1,
      bleedChance: 1,
      shockChance: 1,
      frostOnHit: 0.5,
    };
    const rng = createRng(7);
    let checked = 0;
    for (let trial = 0; trial < 30; trial++) {
      const { placed, shocked } = randomFixture(rng);
      const make = (): RunContext => segCtx(placed, { values, shocked });
      const ctx = make();
      const twin = make();
      expect(ctx.rollsDots).toBe(true);
      const ref = referenceJudgement(ctx.enemies, ctx.now, 2, 200);
      const [pulse] = pulsesOf(judgeNow(ctx));
      if (pulse === undefined) continue;
      // The twin replays the judgement's draws: one crit roll per hit, in id order.
      const rolls = ref.hit.map(() => twin.combatRng.chance(0.5));
      expect(rngPositions(ctx)).toEqual(rngPositions(twin));
      expect(pulse.crits).toEqual(ref.hit.filter((_, k) => rolls[k]));
      for (const e of ctx.enemies) {
        const shockedBefore = shocked.includes(e.id) ? 1 : 0;
        const hit = ref.hit.includes(e.id) ? 1 : 0;
        expect([e.burnStacks, e.poisonStacks, e.bleedUntil, e.frost]).toEqual([0, 0, 0, 0]);
        expect(e.shockStacks).toBe(shockedBefore + hit);
      }
      if (pulse.crits.length > 1) checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('does not hit the children a kill in the pass appends (C18)', () => {
    // The pentagon 3 on the link dies to its hit; its shards appear on the link, after the
    // pass's count.
    const placed = [at(0, 0), at(200, 0), at(100, 0, { type: 'pentagon', radius: 1, hp: 1 })];
    const ctx = segCtx(placed, { shocked: [1, 2] });
    const [pulse] = pulsesOf(judgeNow(ctx));
    expect(enemy(ctx, 3).alive).toBe(false);
    const shards = ctx.enemies.slice(3);
    expect(shards.map((e) => e.def.id)).toEqual(['shard', 'shard', 'shard']);
    for (const shard of shards) {
      expect(segDistSqRef(shard.x, shard.y, C.x, C.y, C.x + 200, C.y)).toBeLessThan(
        shard.radius * shard.radius,
      );
      expect([toNumber(shard.hp), shard.shockStacks]).toEqual([toNumber(shard.maxHp), 0]);
    }
    expect(pulse?.hits).toBe(3);
    // The killed pentagon takes no shock.
    expect(enemy(ctx, 3).shockStacks).toBe(0);
  });

  it('pairs no endpoint of an earlier judgement that is no longer one (R13)', () => {
    // First 1–6 are endpoints; then only 1–3, each nearer to one of 4–6 than to each other.
    const placed = [at(0, 0), at(300, 0), at(600, 0), at(100, 100), at(400, 100), at(700, 100)];
    const grant: SegmentGrant = { kind: 'segment', endpoints: 'shocked', range: 350 };
    const ctx = segCtx(placed, {
      grants: [webOn('outer.lightning', grant)],
      shocked: [1, 2, 3, 4, 5, 6],
    });
    judgeNow(ctx);
    expect(ctx.sys.segments.ends).toHaveLength(6);
    for (const id of [4, 5, 6]) enemy(ctx, id).shockUntil = ctx.now;
    const losses = ctx.enemies.map((e) => lossOf(ctx, e.id));
    const [pulse] = pulsesOf(judgeNow(ctx));
    const p = (id: number): [number, number] => [enemy(ctx, id).x, enemy(ctx, id).y];
    expect(linesOf(ctx).sort()).toEqual(
      [lineKey(...p(1), ...p(2)), lineKey(...p(2), ...p(3))].sort(),
    );
    expect(pulse?.hits).toBe(3);
    // 1–3 hold 2 stacks from the first judgement's hits.
    expect(
      ctx.enemies.map((e, k) => Math.round(lossOf(ctx, e.id) - (losses[k] as number))),
    ).toEqual([120, 120, 120, 0, 0, 0]);
  });

  it('keeps each link where its ends stood at the judgement, and clears them below 2 endpoints', () => {
    const ctx = segCtx([at(0, 0), at(100, 0), at(100, 100)], { shocked: [1, 2, 3] });
    const pulses = pulsesOf(judgeNow(ctx));
    expect(pulses).toHaveLength(1);
    const ln = ctx.state.segments.lines[0];
    if (ln === undefined) throw new Error('no lines');
    expect(ln.count).toBe(3);
    const expected = [
      [C.x, C.y, C.x + 100, C.y],
      [C.x, C.y, C.x + 100, C.y + 100],
      [C.x + 100, C.y, C.x + 100, C.y + 100],
    ];
    const got = Array.from({ length: ln.count }, (_, s) => [
      ln.x1[s],
      ln.y1[s],
      ln.x2[s],
      ln.y2[s],
    ]);
    expect(got).toEqual(expected);
    // The enemies move on; the lines stay where they were judged.
    for (const e of ctx.enemies) e.x += 50;
    expect(Array.from({ length: ln.count }, (_, s) => ln.x1[s])).toEqual([C.x, C.x, C.x + 100]);

    // One endpoint left: no links, no pulse; the serial still counts the judgement.
    enemy(ctx, 2).alive = false;
    enemy(ctx, 3).shockUntil = ctx.now;
    const serial = ctx.sys.segments.serial;
    expect(pulsesOf(judgeNow(ctx))).toEqual([]);
    expect([ln.count, ctx.sys.segments.serial]).toEqual([0, serial + 1]);
  });

  it('judges every period from its phase, each judgement a pulse of its own hits', () => {
    // 雷網 at index 1 (phase 7) every 15 ticks, and a center segment at index 2 (phase 11)
    // every 30, 2 shock stacks a hit, on two endpoints that stay shocked.
    const slow: SegmentGrant = {
      kind: 'segment',
      endpoints: 'shocked',
      periodSec: 0.5,
      damagePct: 0.2,
      shockStacks: 2,
    };
    const ctx = segCtx([at(0, 0), at(100, 0), at(1000, 1000)], {
      values: { shockDuration: 100, shockMaxStacks: 100 },
      grants: [webOn('outer.lightning'), webOn('center', slow)],
      shocked: [1, 2],
    });
    const seen: [number, number, number, number][] = [];
    for (let t = 1; t <= 130; t++) {
      if (t > 1) ctx.now = ++ctx.state.tick;
      ctx.events.length = 0;
      stepSegments(ctx);
      for (const pulse of pulsesOf(ctx.events)) {
        seen.push([t, pulse.id, pulse.hits, toNumber(pulse.total)]);
      }
    }
    const web = [22, 37, 52, 67, 82, 97, 112, 127];
    const center = [41, 71, 101];
    expect(seen.map(([t, id]) => [t, id])).toEqual(
      [...web.map((t) => [t, 1]), ...center.map((t) => [t, 2])].sort(
        (a, b) => (a[0] as number) - (b[0] as number),
      ),
    );
    // Two hits a judgement, never more: the tally starts over each time.
    expect(seen.every(([, , hits]) => hits === 2)).toBe(true);
    // 1 and 2 hold 1 + 8 + 2 × 3 stacks after these judgements.
    expect([enemy(ctx, 1).shockStacks, enemy(ctx, 2).shockStacks]).toEqual([15, 15]);
    // Each pulse's total is its two hits at the stacks they held before them.
    const first = seen.find(([, id]) => id === 1);
    expect(first?.[3]).toBeCloseTo(2 * 100 * 1.1, 9);
  });

  it('hits at depth 0 with no origin: the hit triggers fire, and a kill and a shock are at 0', () => {
    const triggers: [string, TriggerSpec][] = [
      ['outer.lightning', { on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] }],
    ];
    // 3 dies to its hit; 4, not shocked before, takes its first stack from the segment.
    const placed = [at(0, 0), at(100, 0), at(50, 0, { hp: 1 }), at(75, 0)];
    const ctx = segCtx(placed, { triggers, shocked: [1, 2] });
    const trigger = SHATTER_TRIGGER + 1;
    const effect = (ctx.build.triggers[trigger] as CompiledTrigger).effectStart;
    expect(enemy(ctx, 4).ailDepth).toBeGreaterThan(0);
    const [pulse] = pulsesOf(judgeNow(ctx));
    expect([pulse?.hits, ctx.sys.pulse.quiet]).toEqual([4, false]);
    const q = ctx.effectQueue;
    const queued = Array.from({ length: q.size }, (_, n) => {
      const k = (q.head + n) & q.capMask;
      return [q.effect[k], q.depth[k], q.origin[k]];
    });
    // One heal per hit, the kill's included, one deeper than the hits, from the trigger.
    expect(queued).toEqual([
      [effect, 1, trigger],
      [effect, 1, trigger],
      [effect, 1, trigger],
      [effect, 1, trigger],
    ]);
    expect([enemy(ctx, 3).alive, enemy(ctx, 3).killDepth]).toEqual([false, 0]);
    expect([enemy(ctx, 4).shockStacks, enemy(ctx, 4).ailDepth]).toEqual([1, 0]);
  });

  it('shatters a frozen enemy its hit kills, from no trigger, and adds no frost of its own', () => {
    // frostOnHit lets the build freeze, so the shatter listens to kills; the segment's hits roll
    // no ailments, so they add no frost.
    const placed = [at(0, 0), at(100, 0), at(50, 0, { hp: 1 })];
    const ctx = segCtx(placed, { values: { frostOnHit: 0.5 }, shocked: [1, 2] });
    const victim = enemy(ctx, 3);
    victim.frozenUntil = ctx.now + 100;
    const [pulse] = pulsesOf(judgeNow(ctx));
    expect([pulse?.hits, victim.alive]).toEqual([3, false]);
    const pending = ctx.pendingKills.slice(0, ctx.pendingCount);
    expect(pending.map((k) => [k.trigger, k.victim.id, k.depth, k.origin])).toEqual([
      [SHATTER_TRIGGER, 3, 0, -1],
    ]);
    expect([enemy(ctx, 1).frost, enemy(ctx, 2).frost]).toEqual([0, 0]);
  });
});

describe('the segment stage in a run', () => {
  /**
   * 熔核 at attackSpeed 20 (a bomb every 8 ticks) with 雷網 at index 1, on 60 immortal standing
   * squares: bombs land, 雷網 judges and 火地 pulses, all three on one tick every so often;
   * every explosion hit shocks, so endpoints abound.
   */
  const config = makeConfig({
    seed: 3,
    startWave: 1,
    maxTicks: 30 * TICK_RATE,
    signature: { id: 'magmaBomb' },
    stats: makeStats({ damage: 3, attackSpeed: 20, shockChance: 1, maxLife: 1e12 }, [], {
      triggers: [],
      conversions: [],
      emitters: [webOn('outer.lightning')],
    }),
  });

  it('runs after the projectiles and before the zones: explosion → segment pulse → zone pulse', () => {
    const sim = createSimulation(config, stationarySquares(60));
    let all3 = 0;
    let judged = 0;
    while (!sim.state.finished) {
      const events = sim.step(NO_INPUT);
      const tick = sim.state.tick;
      const explosions = events.flatMap((e, k) => (e.type === 'explosion' ? [k] : []));
      const segs = events.flatMap((e, k) =>
        e.type === 'pulse' && e.kind === 'segment' ? [k] : [],
      );
      const zones = events.flatMap((e, k) => (e.type === 'pulse' && e.kind === 'zone' ? [k] : []));
      if (segs.length > 0) {
        judged++;
        // 雷網 is emitter 1: phase 7.
        expect(tick % 15).toBe(7);
        expect(segs).toHaveLength(1);
        for (const k of explosions) expect(k).toBeLessThan(segs[0] as number);
        for (const k of zones) expect(k).toBeGreaterThan(segs[0] as number);
        if (explosions.length > 0 && zones.length > 0) all3++;
      }
    }
    // 118 judgements and 15 ticks with all three at seed 3.
    expect(judged).toBeGreaterThan(100);
    expect(all3).toBeGreaterThan(8);
  });
});

describe('under magmaBomb (D5, narrowed in C4.14)', () => {
  it('a center-board segment hit does not always ignite; the explosion still does', () => {
    const ctx = placedEnemies([], {
      signature: { id: 'magmaBomb' },
      stats: segStats({}, [webOn('center')]),
    });
    const [lob, seg] = ctx.emitters as EmitterRuntime[];
    expect([lob?.spec.kind, seg?.spec.kind, seg?.spec.source]).toEqual([
      'lob',
      'segment',
      'center',
    ]);
    const igniteAlways = (p: Payload, slot: number): number =>
      statAt(ctx.table, slotRow(ctx.build, p, slot), SCOPED_INDEX.igniteAlways, ctx.evalInput);
    for (const slot of [SLOT_HIT, SLOT_HIT_CRIT]) {
      expect(igniteAlways((lob as EmitterRuntime).payload, slot)).toBe(1);
      expect(igniteAlways((seg as EmitterRuntime).payload, slot)).toBe(0);
    }
  });
});
