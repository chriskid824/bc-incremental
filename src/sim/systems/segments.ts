/**
 * Segments (docs/v3 C4 design D18, §4.11): the segment grants, 雷網 among them. Each segment
 * emitter judges every em.interval ticks (periodSec; 15 at 0.25 s), from a phase its emitter
 * index gives it (EmitterRuntime.timer), so emitters judge on different ticks. A judgement's
 * endpoints are the alive enemies that hold shock, in id order. Each links to its `links` (1 or
 * 2) nearest other endpoints within `range`, by the endpoint grid (SegmentState.grid,
 * SpatialGrid.nearestTwo; ties to the lower id), and a link two endpoints both make is one
 * link, so there are at most 2 per endpoint. Every alive enemy within its radius of a link is
 * marked (Enemy.segMark): the main grid's box query around the link, padded by ctx.shotPad,
 * then the tough enemies outside the box, as a straight shot finds them (shots.ts). Then one
 * pass over the enemies in id order hits each marked one once with the emitter's payload, and
 * gives each it does not kill shockStacks shock stacks, without a roll. The endpoints lie on
 * their own links, so they are hit too; enemies a hit's kill appends (split children) come
 * after the pass's count and are not.
 *
 * The hits crit, roll no ailments (Hoshi's Q4 (B) names zone and aura hits only, so segments
 * keep (A)'s: Q4/F7) and raise no hit events: they add to the judgement's tally (PulseAcc), and
 * a judgement with 2 endpoints or more raises one pulse event. The links' endpoints, where they
 * stood at the judgement, go to the emitter's SimState.segments lines for render. The stage runs
 * after the projectiles and before the zones; nothing it reaches adds a segment emitter.
 */

import { ZERO } from '../../core/num';
import { addShock } from '../ailments/shock';
import { segDistSq } from '../effects/execute';
import type { EmitterRuntime, SegmentSpec } from '../emitters/types';
import type { Enemy, RunContext } from './context';
import { growShotScratch } from './shots';
import type { PulseAcc, SegmentLines, SegmentState } from './systemState';
import { hitPulse, hoistPulseRows } from './zones';

/** The segment stage: each segment emitter whose timer reaches its interval judges, in order. */
export function stepSegments(ctx: RunContext): void {
  const sys = ctx.sys;
  const sg = sys.segments;
  const list = sg.emitters;
  for (let i = 0; i < list.length; i++) {
    const em = list[i] as EmitterRuntime;
    em.timer += 1;
    if (em.timer < em.interval) continue;
    em.timer -= em.interval;
    judge(ctx, sg, sys.pulse, em, sg.lines[i] as SegmentLines);
  }
}

/** One judgement of segment emitter `em`, whose links go to `ln`, its tally to `acc`. */
function judge(
  ctx: RunContext,
  sg: SegmentState,
  acc: PulseAcc,
  em: EmitterRuntime,
  ln: SegmentLines,
): void {
  const serial = ++sg.serial;
  const ends = sg.ends;
  const enemies = ctx.enemies;
  const now = ctx.now;
  let k = 0;
  for (let j = 0; j < enemies.length; j++) {
    const enemy = enemies[j] as Enemy;
    if (enemy.alive && enemy.shockStacks > 0 && enemy.shockUntil > now) ends[k++] = enemy;
  }
  if (k < 2) {
    ln.count = 0;
    return;
  }
  // Cut to this judgement's endpoints, or the grid would also take the last one's leftovers.
  ends.length = k;
  const grid = sg.grid;
  grid.rebuild(ends);
  if (sg.pick1.length < k) growPicks(sg, k);
  if (sg.a.length < 2 * k) growPairs(sg, 2 * k);
  if (ln.x1.length < 2 * k) growLines(ln, 2 * k);
  const spec = em.spec as SegmentSpec;
  const rangeSq = spec.range * spec.range;
  const both = spec.links === 2;
  const two = sg.nearTwo;
  const p1 = sg.pick1;
  const p2 = sg.pick2;
  for (let i = 0; i < k; i++) {
    const end = ends[i] as Enemy;
    const c = grid.nearestTwo(end.x, end.y, rangeSq, i, two);
    p1[i] = c > 0 ? (two[0] as number) : -1;
    p2[i] = both && c > 1 ? (two[1] as number) : -1;
  }
  // Each link once: from i, unless its other end q came first and linked to i too.
  const pa = sg.a;
  const pb = sg.b;
  let pairs = 0;
  for (let i = 0; i < k; i++) {
    for (let side = 0; side < 2; side++) {
      const q = side === 0 ? (p1[i] as number) : (p2[i] as number);
      if (q < 0) continue;
      if (q < i && (p1[q] === i || p2[q] === i)) continue;
      pa[pairs] = i;
      pb[pairs] = q;
      pairs++;
    }
  }
  markLinks(ctx, sg, serial, pairs);
  // The count is fixed first: children appended by a kill in the pass are not hit.
  const m = enemies.length;
  const p = em.payload;
  acc.hits = 0;
  acc.total = ZERO;
  acc.critCount = 0;
  hoistPulseRows(ctx, acc, p);
  const stacks = spec.shockStacks;
  for (let j = 0; j < m; j++) {
    const enemy = enemies[j] as Enemy;
    if (enemy.segMark !== serial || !enemy.alive) continue;
    hitPulse(ctx, acc, enemy, p, 1, 0, -1);
    if (enemy.alive) addShock(ctx, enemy, stacks, 0);
  }
  ctx.events.push({
    type: 'pulse',
    kind: 'segment',
    id: em.index,
    hits: acc.hits,
    total: acc.total,
    crits: acc.crits.slice(0, acc.critCount),
  });
  const x1 = ln.x1;
  const y1 = ln.y1;
  const x2 = ln.x2;
  const y2 = ln.y2;
  for (let s = 0; s < pairs; s++) {
    const a = ends[pa[s] as number] as Enemy;
    const b = ends[pb[s] as number] as Enemy;
    x1[s] = a.x;
    y1[s] = a.y;
    x2[s] = b.x;
    y2[s] = b.y;
  }
  ln.count = pairs;
}

/**
 * Marks with `serial` every alive enemy within its radius of one of the judgement's `pairs`
 * links: the candidates of the main grid's box around each link, padded by ctx.shotPad, which
 * holds every enemy within reach but the tough ones, larger than the pad; then the tough ones
 * whose centre lies outside the box (grid.marked), so none is a candidate twice.
 */
function markLinks(ctx: RunContext, sg: SegmentState, serial: number, pairs: number): void {
  const grid = ctx.grid;
  const pad = ctx.shotPad;
  const ends = sg.ends;
  const pa = sg.a;
  const pb = sg.b;
  // Every candidate is a distinct enemy of the grid's source.
  if (ctx.candidates.length < ctx.enemies.length) growShotScratch(ctx, ctx.enemies.length);
  const candidates = ctx.candidates;
  for (let s = 0; s < pairs; s++) {
    const a = ends[pa[s] as number] as Enemy;
    const b = ends[pb[s] as number] as Enemy;
    const ax = a.x;
    const ay = a.y;
    const bx = b.x;
    const by = b.y;
    const minX = (ax < bx ? ax : bx) - pad;
    const maxX = (ax < bx ? bx : ax) + pad;
    const minY = (ay < by ? ay : by) - pad;
    const maxY = (ay < by ? by : ay) + pad;
    const n = grid.boxIndices(minX, minY, maxX, maxY, candidates);
    for (let i = 0; i < n; i++) {
      mark(grid.item(candidates[i] as number), serial, ax, ay, bx, by);
    }
    const marked = grid.markedCount();
    for (let t = 0; t < marked; t++) {
      const enemy = grid.marked(t);
      if (!enemy.tough || !enemy.alive) continue;
      const x = enemy.x;
      const y = enemy.y;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
      mark(enemy, serial, ax, ay, bx, by);
    }
  }
}

/** Marks `enemy` with `serial` when it is alive and within its radius of the link. */
function mark(enemy: Enemy, serial: number, ax: number, ay: number, bx: number, by: number): void {
  if (!enemy.alive || enemy.segMark === serial) return;
  const r = enemy.radius;
  if (segDistSq(enemy.x, enemy.y, ax, ay, bx, by) <= r * r) enemy.segMark = serial;
}

/** Grows the endpoints' link arrays to hold at least `n` endpoints. */
function growPicks(sg: SegmentState, n: number): void {
  const size = Math.max(n, 2 * sg.pick1.length);
  sg.pick1 = new Int32Array(size);
  sg.pick2 = new Int32Array(size);
}

/** Grows the pair arrays to hold at least `n` pairs. */
function growPairs(sg: SegmentState, n: number): void {
  const size = Math.max(n, 2 * sg.a.length);
  sg.a = new Int32Array(size);
  sg.b = new Int32Array(size);
}

/** Grows an emitter's line arrays to hold at least `n` links. */
function growLines(ln: SegmentLines, n: number): void {
  const size = Math.max(n, 2 * ln.x1.length);
  ln.x1 = new Float64Array(size);
  ln.y1 = new Float64Array(size);
  ln.x2 = new Float64Array(size);
  ln.y2 = new Float64Array(size);
}
