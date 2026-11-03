/**
 * Segments (docs/v3 C4 design D18, §4.11; C5 design §8.2's C5.8): the segment grants, 雷網,
 * 雷射柵欄 and 雷網蜂 among them. Each segment emitter judges every em.interval ticks (periodSec;
 * 15 at 0.25 s), from a phase its emitter index gives it (EmitterRuntime.timer), so emitters
 * judge on different ticks. A shocked segment's judgement (judge) takes as endpoints the alive
 * enemies that hold shock, in id order. Each links to its `links` (1 or 2) nearest other endpoints
 * within `range`, by the endpoint grid (SegmentState.grid, SpatialGrid.nearestTwo; ties to the
 * lower id), and a link two endpoints both make is one link, so there are at most 2 per endpoint.
 * Every alive enemy within its radius of a link is marked (Enemy.segMark): the main grid's box
 * query around the link, padded by ctx.shotPad, then the tough enemies outside the box, as a
 * straight shot finds them (shots.ts). Then one pass over the enemies in id order hits each marked
 * one once with the emitter's payload, and gives each it lands on (its defences did not block the
 * hit in full: lead ruling R1) and does not kill shockStacks shock stacks, without a roll. The
 * endpoints lie on their own links, so they are hit too; enemies a hit's kill appends (split
 * children) come after the pass's count and are not.
 *
 * A segment between drones or summons (judgePool) takes the drone pool's rows instead, as the
 * drone stage of the tick left them: the drones ('drones': every drone emitter's, docked or
 * flying, not the turrets or spirits) or every row ('summons'), in slot order, which is id
 * order, at their positions. They link by the same rule, found by a scan of the rows (the pool
 * holds at most its summon cap) rather than a grid, and their links mark and hit as the shocked
 * enemies' do. With pairTicks above 0 it pairs only when its second timer (pairTimer) reaches
 * them, and the judgements between keep the pairs by the rows' ids (HeldPairs), each while both
 * its rows live, wherever they move, and drawn where they stand.
 *
 * The hits crit, roll no ailments (Hoshi's Q4 (B) names zone and aura hits only, so segments
 * keep (A)'s: Q4/F7) and raise no hit events: they add to the judgement's tally (PulseAcc), and
 * a judgement with 2 endpoints or more raises one pulse event. The links' endpoints, where they
 * stood at the judgement, and their ids (an enemy's, or a drone pool row's) go to the emitter's
 * SimState.segments lines for render, which draws each end where its endpoint is while it lives
 * (src/render/segmentLines.ts); nothing in the sim reads the ids. The stage runs
 * after the projectiles and before the zones; nothing it reaches adds a segment emitter or moves
 * a row of the pool.
 */

import { ZERO } from '../../core/num';
import { addShock } from '../ailments/shock';
import { segDistSq } from '../effects/execute';
import type { EmitterRuntime, SegmentSpec } from '../emitters/types';
import { DRONE_KIND_DRONE } from '../types';
import type { Enemy, RunContext } from './context';
import { growShotScratch } from './shots';
import type { DronePool, HeldPairs, PulseAcc, SegmentLines, SegmentState } from './systemState';
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
    const ln = sg.lines[i] as SegmentLines;
    if ((em.spec as SegmentSpec).endpoints === 'shocked') judge(ctx, sg, sys.pulse, em, ln);
    else judgePool(ctx, sg, sys.pulse, em, ln, sg.held[i] as HeldPairs);
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
    const landed = hitPulse(ctx, acc, enemy, p, 1, 0, -1);
    if (landed && enemy.alive) addShock(ctx, enemy, stacks, 0);
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
  const id1 = ln.id1;
  const id2 = ln.id2;
  for (let s = 0; s < pairs; s++) {
    const a = ends[pa[s] as number] as Enemy;
    const b = ends[pb[s] as number] as Enemy;
    x1[s] = a.x;
    y1[s] = a.y;
    x2[s] = b.x;
    y2[s] = b.y;
    id1[s] = a.id;
    id2[s] = b.id;
  }
  ln.count = pairs;
}

/**
 * One judgement of segment emitter `em` between the drone pool's rows (lead rulings U2–U5), whose
 * links go to `ln` and, with pairTicks above 0, its pairs to `held`. Its endpoints are the
 * pool's drones or all its rows, in slot order. Each pairing links each endpoint to its `links`
 * nearest other endpoints within `range`, by a scan of the rows (ties to the lower slot, a
 * distance of 0 included, as nearestTwo picks), and keeps a link both ends make once. With
 * pairTicks above 0 the judgement first advances pairTimer by its interval, pairs when it holds
 * no pairing yet or pairTimer has reached pairTicks, then sets it to 0, and otherwise keeps the
 * held pairs whose two rows live, each drawn between where they stand now; one whose rows are
 * fewer than 2 pairs nothing and holds no pair. The hits are the shocked judgement's.
 */
function judgePool(
  ctx: RunContext,
  sg: SegmentState,
  acc: PulseAcc,
  em: EmitterRuntime,
  ln: SegmentLines,
  held: HeldPairs,
): void {
  const serial = ++sg.serial;
  const ds = ctx.sys.drones;
  const spec = em.spec as SegmentSpec;
  const all = spec.endpoints === 'summons';
  const n = ds.count;
  const kind = ds.kind;
  let k = n;
  if (!all) {
    k = 0;
    for (let s = 0; s < n; s++) if (kind[s] === DRONE_KIND_DRONE) k++;
  }
  const every = spec.pairTicks;
  let pair = true;
  if (every > 0) {
    em.pairTimer += em.interval;
    pair = held.count < 0 || em.pairTimer >= every;
    if (pair) em.pairTimer = 0;
  }
  if (k < 2) {
    // Fewer than 2 rows hold no pair: each held one has lost a row.
    if (every > 0) held.count = 0;
    ln.count = 0;
    return;
  }
  if (ln.x1.length < 2 * k) growLines(ln, 2 * k);
  const x = ds.x;
  const y = ds.y;
  const x1 = ln.x1;
  const y1 = ln.y1;
  const x2 = ln.x2;
  const y2 = ln.y2;
  const id1 = ln.id1;
  const id2 = ln.id2;
  const id = ds.id;
  let pairs = 0;
  if (pair) {
    if (sg.pick1.length < n) growPicks(sg, n);
    const p1 = sg.pick1;
    const p2 = sg.pick2;
    const rangeSq = spec.range * spec.range;
    const both = spec.links === 2;
    for (let i = 0; i < n; i++) {
      if (!all && kind[i] !== DRONE_KIND_DRONE) continue;
      const xi = x[i] as number;
      const yi = y[i] as number;
      // nearestTwo's rule over the rows in slot order: within rangeSq, ties to the lower slot.
      let i0 = -1;
      let d0 = rangeSq;
      let i1 = -1;
      let d1 = rangeSq;
      for (let j = 0; j < n; j++) {
        if (j === i || (!all && kind[j] !== DRONE_KIND_DRONE)) continue;
        const dx = (x[j] as number) - xi;
        const dy = (y[j] as number) - yi;
        const d = dx * dx + dy * dy;
        if (d < d0 || (d === d0 && i0 < 0)) {
          i1 = i0;
          d1 = d0;
          i0 = j;
          d0 = d;
        } else if (d < d1 || (d === d1 && i1 < 0)) {
          i1 = j;
          d1 = d;
        }
      }
      p1[i] = i0;
      p2[i] = both ? i1 : -1;
    }
    // Each link once: from i, unless its other end q came first and linked to i too.
    for (let i = 0; i < n; i++) {
      if (!all && kind[i] !== DRONE_KIND_DRONE) continue;
      for (let side = 0; side < 2; side++) {
        const q = side === 0 ? (p1[i] as number) : (p2[i] as number);
        if (q < 0) continue;
        if (q < i && (p1[q] === i || p2[q] === i)) continue;
        x1[pairs] = x[i] as number;
        y1[pairs] = y[i] as number;
        x2[pairs] = x[q] as number;
        y2[pairs] = y[q] as number;
        id1[pairs] = id[i] as number;
        id2[pairs] = id[q] as number;
        if (every > 0) {
          held.a[pairs] = id[i] as number;
          held.b[pairs] = id[q] as number;
        }
        pairs++;
      }
    }
    if (every > 0) held.count = pairs;
  } else {
    // The held pairs whose rows both live, by id, at their slots now.
    const a = held.a;
    const b = held.b;
    for (let h = 0; h < held.count; h++) {
      const sa = slotOf(ds, a[h] as number);
      if (sa < 0) continue;
      const sb = slotOf(ds, b[h] as number);
      if (sb < 0) continue;
      a[pairs] = a[h] as number;
      b[pairs] = b[h] as number;
      x1[pairs] = x[sa] as number;
      y1[pairs] = y[sa] as number;
      x2[pairs] = x[sb] as number;
      y2[pairs] = y[sb] as number;
      id1[pairs] = a[h] as number;
      id2[pairs] = b[h] as number;
      pairs++;
    }
    held.count = pairs;
  }
  ln.count = pairs;
  markLines(ctx, serial, ln);
  // As judge's pass: the count is fixed first, so children appended by a kill are not hit.
  const enemies = ctx.enemies;
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
    const landed = hitPulse(ctx, acc, enemy, p, 1, 0, -1);
    if (landed && enemy.alive) addShock(ctx, enemy, stacks, 0);
  }
  ctx.events.push({
    type: 'pulse',
    kind: 'segment',
    id: em.index,
    hits: acc.hits,
    total: acc.total,
    crits: acc.crits.slice(0, acc.critCount),
  });
}

/** The slot of the pool's row of id `id`, or −1 once it has left: slots are in id order. */
function slotOf(ds: DronePool, id: number): number {
  const ids = ds.id;
  let lo = 0;
  let hi = ds.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = ids[mid] as number;
    if (at === id) return mid;
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Marks with `serial` every alive enemy within its radius of one of the links in `ln`, as
 * markLinks marks the shocked endpoints' links: the main grid's box around each, padded by
 * ctx.shotPad, then the tough enemies outside the box.
 */
function markLines(ctx: RunContext, serial: number, ln: SegmentLines): void {
  const grid = ctx.grid;
  const pad = ctx.shotPad;
  if (ctx.candidates.length < ctx.enemies.length) growShotScratch(ctx, ctx.enemies.length);
  const candidates = ctx.candidates;
  for (let s = 0; s < ln.count; s++) {
    const ax = ln.x1[s] as number;
    const ay = ln.y1[s] as number;
    const bx = ln.x2[s] as number;
    const by = ln.y2[s] as number;
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
      const ex = enemy.x;
      const ey = enemy.y;
      if (ex >= minX && ex <= maxX && ey >= minY && ey <= maxY) continue;
      mark(enemy, serial, ax, ay, bx, by);
    }
  }
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

/** Grows an emitter's line arrays, its endpoints' ids with them, to hold at least `n` links. */
function growLines(ln: SegmentLines, n: number): void {
  const size = Math.max(n, 2 * ln.x1.length);
  ln.x1 = new Float64Array(size);
  ln.y1 = new Float64Array(size);
  ln.x2 = new Float64Array(size);
  ln.y2 = new Float64Array(size);
  ln.id1 = new Int32Array(size);
  ln.id2 = new Int32Array(size);
}
