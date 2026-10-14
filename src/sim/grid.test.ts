import { describe, expect, it } from 'vitest';
import type { Num } from '../core/num';
import { num } from '../core/num';
import { createRng } from '../core/rng';
import type { Rng } from '../core/rng';
import { SpatialGrid } from './grid';
import type { GridPoint } from './grid';
import { isCovered, pickTarget, pickTargetInGrid } from './targeting';
import { ARENA_HEIGHT, ARENA_WIDTH } from './types';

const CELL = 128;

interface Item {
  readonly id: number;
  x: number;
  y: number;
  alive: boolean;
  hp: Num;
  inbound: number;
  readonly tough: boolean;
  /** Random bits for the random predicates. */
  readonly tag: number;
}

function item(id: number, x: number, y: number, alive = true, tough = false): Item {
  return { id, x, y, alive, hp: num(10), inbound: 0, tough, tag: 0 };
}

const newGrid = (linearBelow = 0): SpatialGrid<Item> =>
  new SpatialGrid<Item>(ARENA_WIDTH, ARENA_HEIGHT, CELL, linearBelow);
const isTough = (target: Item): boolean => target.tough;
const idOf = (target: Item | null): number | null => target?.id ?? null;
const idsOf = (items: readonly Item[], count = items.length): number[] =>
  items.slice(0, count).map((target) => target.id);

function gridOf(items: readonly Item[]): SpatialGrid<Item> {
  const grid = newGrid();
  grid.rebuild(items, isTough);
  return grid;
}

// ---- Linear references: the scans the grid replaced, unchanged apart from the predicate ----

/** nearestChainTarget before the grid (src/sim/combat/chain.ts), with any predicate. */
function linearNearest(
  enemies: readonly Item[],
  x: number,
  y: number,
  maxDistSq: number,
  accept?: (enemy: Item) => boolean,
): Item | null {
  let best: Item | null = null;
  let bestDistSq = maxDistSq;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Item;
    if (!enemy.alive || (accept !== undefined && !accept(enemy))) continue;
    const dx = enemy.x - x;
    const dy = enemy.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq || (distSq === bestDistSq && best === null)) {
      best = enemy;
      bestDistSq = distSq;
    }
  }
  return best;
}

/** spreadBurns' target selection before the grid (src/sim/systems/burn.ts). */
function linearWithin(enemies: readonly Item[], x: number, y: number, radiusSq: number): Item[] {
  const found: Item[] = [];
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Item;
    if (!enemy.alive) continue;
    const dx = enemy.x - x;
    const dy = enemy.y - y;
    if (dx * dx + dy * dy > radiusSq) continue;
    found.push(enemy);
  }
  return found;
}

function linearBox(
  items: readonly Item[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  pad: number,
): Item[] {
  const [minX, maxX] = [Math.min(ax, bx) - pad, Math.max(ax, bx) + pad];
  const [minY, maxY] = [Math.min(ay, by) - pad, Math.max(ay, by) + pad];
  return items.filter((t) => t.alive && t.x >= minX && t.x <= maxX && t.y >= minY && t.y <= maxY);
}

/** Densest 3 × 3 block by brute force, with cells computed independently. */
function bruteDensest(items: readonly Item[], out: GridPoint): number {
  const innerCols = Math.ceil(ARENA_WIDTH / CELL);
  const innerRows = Math.ceil(ARENA_HEIGHT / CELL);
  const cellOf = (v: number, inner: number): number =>
    v < 0 ? 0 : Math.min(inner + 1, 1 + Math.floor(v / CELL));
  const counts = new Map<string, number>();
  for (const t of items) {
    if (!t.alive) continue;
    const key = `${cellOf(t.x, innerCols)},${cellOf(t.y, innerRows)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestCol = 0;
  let bestRow = 0;
  for (let row = 1; row <= innerRows; row++) {
    for (let col = 1; col <= innerCols; col++) {
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) count += counts.get(`${col + dc},${row + dr}`) ?? 0;
      }
      if (count > best) [best, bestCol, bestRow] = [count, col, row];
    }
  }
  if (best > 0) {
    out.x = Math.min((bestCol - 0.5) * CELL, ARENA_WIDTH);
    out.y = Math.min((bestRow - 0.5) * CELL, ARENA_HEIGHT);
  }
  return best;
}

describe('SpatialGrid', () => {
  it('covers the arena with 15 × 9 cells plus the outer ring', () => {
    const grid = newGrid();
    expect([grid.cols, grid.rows]).toEqual([17, 11]);
  });

  it('only accepts power-of-two cell sizes', () => {
    expect(() => new SpatialGrid<Item>(1920, 1080, 100)).toThrow(RangeError);
    expect(() => new SpatialGrid<Item>(1920, 1080, 0)).toThrow(RangeError);
    expect(() => new SpatialGrid<Item>(0, 1080, 128)).toThrow(RangeError);
    expect(() => new SpatialGrid<Item>(1920, 1080, 64)).not.toThrow();
  });

  describe('nearest', () => {
    it('finds the closest alive item, also far outside the arena', () => {
      const items = [item(1, 500, 500, false), item(2, 700, 500), item(3, -9000, 40000)];
      const grid = gridOf(items);
      expect(idOf(grid.nearest(510, 500, Infinity))).toBe(2);
      expect(idOf(grid.nearest(-8000, 30000, Infinity))).toBe(3);
      expect(idOf(grid.nearest(1e6, -1e6, Infinity))).toBe(2);
      expect(idOf(gridOf([]).nearest(0, 0, Infinity))).toBeNull();
    });

    it('prefers the earlier source entry on equal distance', () => {
      // Equal distances from (960, 540), in different cells.
      const items = [item(1, 960, 940), item(2, 1360, 540), item(3, 560, 540), item(4, 960, 140)];
      const grid = gridOf(items);
      expect(idOf(grid.nearest(960, 540, Infinity))).toBe(1);
      items[0]!.alive = false;
      expect(idOf(grid.nearest(960, 540, Infinity))).toBe(2);
    });

    it('searches past a cell edge for anything as close as the best so far', () => {
      // The query is 28 from one edge of the cell [512, 640) × [256, 384). Item 1 lies at
      // that distance or just past it, across the edge where it can; item 2 lies inside the
      // cell on the other side, as far or slightly farther.
      const sides = [
        [612, 320, 1, 0],
        [540, 320, -1, 0],
        [576, 356, 0, 1],
        [576, 284, 0, -1],
      ] as const;
      for (const [qx, qy, dx, dy] of sides) {
        for (const across of [28, 28.5]) {
          for (const farther of [0, 0.25]) {
            const near = item(1, qx + dx * across, qy + dy * across);
            const far = item(2, qx - dx * (across + farther), qy - dy * (across + farther));
            expect(idOf(gridOf([near, far]).nearest(qx, qy, Infinity))).toBe(1);
          }
        }
      }
    });

    it('includes the limit and respects the predicate', () => {
      const items = [item(1, 100, 0), item(2, 0, 100), item(3, 0, 50)];
      const grid = gridOf(items);
      expect(idOf(grid.nearest(0, 0, 100 * 100, (t) => t.id !== 3))).toBe(1);
      expect(idOf(grid.nearest(0, 0, 100 * 100 - 1, (t) => t.id !== 3))).toBeNull();
      expect(idOf(grid.nearest(0, 0, 0))).toBeNull();
      expect(idOf(grid.nearest(0, 50, 0))).toBe(3);
    });

    it('sees items added after the sort, ties going to the earlier entry', () => {
      const items = [item(1, 300, 300)];
      const grid = gridOf(items);
      expect(idOf(grid.nearest(0, 0, Infinity))).toBe(1);
      items.push(item(2, 300, 300), item(3, 200, 200));
      expect(idOf(grid.nearest(0, 0, Infinity))).toBe(3);
      expect(idOf(grid.nearest(400, 400, Infinity))).toBe(1);
      items[0]!.alive = false;
      expect(idOf(grid.nearest(400, 400, Infinity))).toBe(2);
    });

    it('sorts items added between rebuild() and the first query', () => {
      const items = [item(1, 300, 300)];
      const grid = gridOf(items);
      items.push(item(2, 1500, 900));
      expect(idOf(grid.nearest(1600, 900, Infinity))).toBe(2);
      expect(grid.markedCount()).toBe(0);
    });
  });

  describe('within', () => {
    it('lists alive items in source order, the radius included', () => {
      const items = [
        item(1, 900, 500),
        item(2, 1100, 540),
        item(3, 960, 540, false),
        item(4, 960, 640),
        item(5, 960, 641),
      ];
      const grid = gridOf(items);
      const out: Item[] = [];
      const count = grid.within(960, 540, 100 * 100, out);
      expect(idsOf(out, count)).toEqual([1, 4]);
      items.push(item(6, 960, 540));
      expect(idsOf(out, grid.within(960, 540, 200 * 200, out))).toEqual([1, 2, 4, 5, 6]);
    });

    it('finds items on the radius from a query point far outside the arena', () => {
      // From 2^64 away, x - r rounds to well inside the arena; a range of columns computed
      // from r missed the item's column.
      const items = [item(1, 1100, 0), item(2, 700, 900)];
      const grid = gridOf(items);
      const out: Item[] = [];
      for (const [qx, qy] of [
        [2 ** 64, 0],
        [-(2 ** 64), 0],
        [0, 2 ** 64],
        [2 ** 61, -(2 ** 62)],
        [1e300, 1e300],
      ] as const) {
        for (const target of items) {
          const dx = target.x - qx;
          const dy = target.y - qy;
          const radiusSq = dx * dx + dy * dy;
          const expected = idsOf(linearWithin(items, qx, qy, radiusSq));
          expect(expected).toContain(target.id);
          expect(idsOf(out, grid.within(qx, qy, radiusSq, out))).toEqual(expected);
        }
      }
    });

    it('keeps source order with many hits, and reuses the output array', () => {
      const items: Item[] = [];
      for (let i = 0; i < 200; i++) items.push(item(i + 1, (i * 37) % 400, (i * 53) % 300));
      const grid = gridOf(items);
      const out: Item[] = [];
      expect(idsOf(out, grid.within(200, 150, 1e6, out))).toEqual(idsOf(items));
      expect(idsOf(out, grid.within(0, 0, 0, out))).toEqual([1]);
      expect(out.length).toBe(200);
    });
  });

  describe('inSegmentBox', () => {
    it('lists alive items in the padded box of a segment, in source order', () => {
      const items = [
        item(1, 1000, 600),
        item(2, 100, 100),
        item(3, 210, 90),
        item(4, 600, 300, false),
        item(5, 50, 50),
        item(6, 211, 89),
      ];
      const grid = gridOf(items);
      const out: Item[] = [];
      expect(idsOf(out, grid.inSegmentBox(1000, 600, 100, 100, 10, out))).toEqual([1, 2, 3]);
      expect(idsOf(out, grid.inSegmentBox(100, 100, 100, 100, 0, out))).toEqual([2]);
      items.push(item(7, 500, 400));
      expect(idsOf(out, grid.inSegmentBox(100, 600, 1000, 100, 0, out))).toEqual([1, 2, 7]);
    });
  });

  describe('densest', () => {
    it('finds the 3 × 3 block with the most alive items', () => {
      const items = [
        item(1, 100, 100),
        item(2, 1000, 600),
        item(3, 1100, 650),
        item(4, 900, 700),
        item(5, 1010, 610, false),
      ];
      const grid = gridOf(items);
      const point = { x: -1, y: -1 };
      expect(grid.densest(point)).toBe(3);
      expect(point).toEqual({ x: 960, y: 576 });
      expect(gridOf([item(1, 0, 0, false)]).densest(point)).toBe(0);
      expect(point).toEqual({ x: 960, y: 576 });
    });

    it('counts the outer ring and late items, and keeps the point in the arena', () => {
      const items = [item(1, 5000, 5000), item(2, 1919, 1079)];
      const grid = gridOf(items);
      const point = { x: 0, y: 0 };
      expect(grid.densest(point)).toBe(2);
      expect(point).toEqual({ x: 1856, y: 1080 });
      items.push(item(3, 0, 0), item(4, 10, 10), item(5, 200, 0));
      expect(grid.densest(point)).toBe(3);
      expect(point).toEqual({ x: 64, y: 64 });
    });
  });

  it('scans a source smaller than linearBelow instead of sorting it', () => {
    const grid = newGrid(4);
    const many = [item(1, 0, 0, true, true), item(2, 5, 5), item(3, 9, 9), item(4, 1, 1)];
    grid.rebuild(many, isTough);
    expect(grid.linearSource()).toBeNull();
    expect(grid.markedCount()).toBe(1);

    const items = [item(5, 100, 100), item(6, 900, 500, true, true), item(7, 900, 500)];
    grid.rebuild(items, isTough);
    expect(grid.linearSource()).toBe(items);
    // Every item counts as possibly marked, as if added after an empty sort.
    expect(grid.markedCount()).toBe(3);
    expect(grid.marked(0)).toBe(items[0]);
    const out: Item[] = [];
    expect(idOf(grid.nearest(1000, 500, Infinity))).toBe(6);
    expect(idsOf(out, grid.within(900, 500, 0, out))).toEqual([6, 7]);
    expect(idsOf(out, grid.inSegmentBox(0, 0, 900, 500, 0, out))).toEqual([5, 6, 7]);
    const point = { x: 0, y: 0 };
    // The first block in row-major order that holds items 6 and 7.
    expect(grid.densest(point)).toBe(2);
    expect(point).toEqual({ x: 832, y: 320 });

    // Items added later in the tick are scanned too; the decision waits for the next rebuild.
    items.push(item(8, 1000, 500), item(9, 1000, 520));
    expect(grid.linearSource()).toBe(items);
    expect(idOf(grid.nearest(1000, 500, Infinity))).toBe(8);
    grid.rebuild(items, isTough);
    expect(grid.linearSource()).toBeNull();
    expect(grid.markedCount()).toBe(1);
    expect(idOf(grid.nearest(1000, 500, Infinity))).toBe(8);
  });

  it('lists marked items in source order, then every item added since', () => {
    const items = [item(1, 0, 0, true, true), item(2, 0, 0), item(3, 900, 900, true, true)];
    const grid = gridOf(items);
    const marked = (): number[] =>
      Array.from({ length: grid.markedCount() }, (_, k) => grid.marked(k).id);
    expect(marked()).toEqual([1, 3]);
    items.push(item(4, 5, 5));
    expect(marked()).toEqual([1, 3, 4]);
    grid.rebuild(items);
    expect(marked()).toEqual([]);
  });
});

// ---- Randomized equivalence with the linear scans ----

type Point = readonly [number, number];

const PLAYER: Point = [ARENA_WIDTH / 2, ARENA_HEIGHT / 2];
/** Exact cell edges and arena borders, nudged by nothing, a hair, or half a unit. */
const edge = (rng: Rng, cells: number): number =>
  CELL * (rng.int(cells + 3) - 1) + ([0, 0, 1e-9, -1e-9, 0.5, -0.5][rng.int(6)] as number);

/** Offsets from anchors: few values, so many items share a distance to an anchor. */
const OFFSETS = [0, 0.5, 37, 63.5, 64, 100, 127.5, 128, 200, 256, 390];

/** Random positions, biased towards duplicates, exact ties around anchors and cell edges. */
function randomPoint(rng: Rng, anchors: readonly Point[], items: readonly Item[]): Point {
  const kind = rng.int(10);
  if (kind === 0) {
    return [rng.range(-300, ARENA_WIDTH + 300), rng.range(-300, ARENA_HEIGHT + 300)];
  }
  if (kind === 1) return [rng.int(ARENA_WIDTH + 1), rng.int(ARENA_HEIGHT + 1)];
  if (kind === 2) return [edge(rng, 15), edge(rng, 9)];
  if (kind === 3 && items.length > 0) {
    const other = rng.pick(items);
    return [other.x, other.y];
  }
  if (kind === 4 || kind === 8) {
    // The same distance from an anchor in several directions.
    const [ax, ay] = rng.pick(anchors);
    const p = rng.pick(OFFSETS) * (rng.chance(0.5) ? 1 : -1);
    const q = rng.pick(OFFSETS) * (rng.chance(0.5) ? 1 : -1);
    return rng.chance(0.5) ? [ax + p, ay + q] : [ax + q, ay + p];
  }
  if (kind === 5) {
    const far = rng.range(2000, 1e5) * (rng.chance(0.5) ? 1 : -1);
    return rng.chance(0.5) ? [PLAYER[0] + far, rng.range(-1e5, 1e5)] : [rng.range(-1e5, 1e5), far];
  }
  if (kind === 6) {
    // Just outside the arena, where enemies spawn.
    const out = rng.range(0, 80);
    return rng.chance(0.5)
      ? [rng.chance(0.5) ? -out : ARENA_WIDTH + out, rng.range(-80, ARENA_HEIGHT + 80)]
      : [rng.range(-80, ARENA_WIDTH + 80), rng.chance(0.5) ? -out : ARENA_HEIGHT + out];
  }
  return [rng.range(0, ARENA_WIDTH), rng.range(0, ARENA_HEIGHT)];
}

function randomItem(rng: Rng, id: number, anchors: readonly Point[], items: Item[]): Item {
  const [x, y] = randomPoint(rng, anchors, items);
  return {
    id,
    x,
    y,
    alive: rng.chance(0.85),
    hp: num([1, 5, 10, 20, 25, 40][rng.int(6)] as number),
    inbound: rng.chance(0.6) ? 0 : 1 + rng.int(3),
    tough: rng.chance(0.08),
    tag: rng.int(1 << 16),
  };
}

/** Squared radii: exact distances to items (inclusive bounds), zero, typical and huge ones. */
function randomRadiusSq(rng: Rng, x: number, y: number, items: readonly Item[]): number {
  const kind = rng.int(6);
  if (kind === 0 && items.length > 0) {
    const other = rng.pick(items);
    const dx = other.x - x;
    const dy = other.y - y;
    return dx * dx + dy * dy;
  }
  if (kind === 1) return 0;
  if (kind === 2) return rng.int(700) ** 2;
  if (kind === 3) return rng.range(0, 700) ** 2;
  if (kind === 4) return [Infinity, Number.MAX_VALUE, 1e12][rng.int(3)] as number;
  return rng.range(0, 3000) ** 2;
}

interface Tally {
  queries: number;
  /** Nearest queries where several candidates shared the smallest distance. */
  ties: number;
  /** Queries that saw items added after the sort. */
  late: number;
}

function checkQueries(rng: Rng, grid: SpatialGrid<Item>, items: Item[], anchors: Point[]): Tally {
  const tally: Tally = { queries: 0, ties: 0, late: 0 };
  const out: Item[] = [];
  for (let q = 0; q < 6; q++) {
    const [x, y] = rng.chance(0.6) ? rng.pick(anchors) : randomPoint(rng, anchors, items);
    const radiusSq = randomRadiusSq(rng, x, y, items);
    const mod = 1 + rng.int(4);
    const accept = rng.chance(0.3) ? undefined : (t: Item): boolean => t.tag % mod !== 0;

    const expected = linearNearest(items, x, y, radiusSq, accept);
    expect(grid.nearest(x, y, radiusSq, accept)).toBe(expected);
    if (expected !== null) {
      const dx = expected.x - x;
      const dy = expected.y - y;
      const best = dx * dx + dy * dy;
      const tied = items.filter(
        (t) =>
          t.alive &&
          (accept === undefined || accept(t)) &&
          (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y) === best,
      );
      if (tied.length > 1) tally.ties++;
    }

    const within = linearWithin(items, x, y, radiusSq);
    expect(idsOf(out, grid.within(x, y, radiusSq, out))).toEqual(idsOf(within));

    const [bx, by] = randomPoint(rng, anchors, items);
    const pad = [0, 10, 70, 300][rng.int(4)] as number;
    const box = linearBox(items, x, y, bx, by, pad);
    expect(idsOf(out, grid.inSegmentBox(x, y, bx, by, pad, out))).toEqual(idsOf(box));

    // pickTarget with every combination of avoid and focus; focus implies tough (marked).
    const estimate = num([0, 5, 10, 25][rng.int(4)] as number);
    const avoidMod = rng.int(4);
    const avoid = avoidMod === 0 ? undefined : (t: Item): boolean => t.tag % (avoidMod + 1) === 0;
    const focusMod = rng.int(3);
    const focus =
      focusMod === 0 ? undefined : (t: Item): boolean => t.tough && t.tag % focusMod === 0;
    const shootable = (t: Item): boolean =>
      !isCovered(t, estimate) && (avoid === undefined || !avoid(t));
    expect(pickTargetInGrid(grid, x, y, shootable, focus)).toBe(
      pickTarget(items, x, y, estimate, avoid, focus),
    );
    tally.queries++;
  }
  const point = { x: NaN, y: NaN };
  const expectedPoint = { x: NaN, y: NaN };
  expect(grid.densest(point)).toBe(bruteDensest(items, expectedPoint));
  expect(point).toEqual(expectedPoint);
  return tally;
}

const STATES = 800;
/** Lower bounds for the tallies below; seed 20261013 gives 391 ties and 3960 late queries. */
const TIES_MIN = 250;
const LATE_MIN = 2500;

describe('grid queries match the linear scans', () => {
  it('on hundreds of random states, ties, late additions and dead items included', () => {
    const rng = createRng(20261013);
    // Mostly a grid that always sorts, so the cells are exercised; sometimes one that scans
    // sources with fewer than 128 items, as the simulation's does.
    const sorting = newGrid();
    const scanning = newGrid(128);
    const total: Tally = { queries: 0, ties: 0, late: 0 };
    const add = (tally: Tally, late: boolean): void => {
      total.queries += tally.queries;
      total.ties += tally.ties;
      if (late) total.late += tally.queries;
    };
    let nextId = 1;
    for (let state = 0; state < STATES; state++) {
      const grid = rng.chance(0.25) ? scanning : sorting;
      const anchors: Point[] = [PLAYER];
      for (let a = 0; a < 3; a++) anchors.push(randomPoint(rng, anchors, []));
      // An offset away from a cell corner, so that tied items sit right on cell edges.
      const offset = (): number => rng.pick(OFFSETS) * (rng.chance(0.5) ? 1 : -1);
      anchors.push([edge(rng, 15) + offset(), edge(rng, 9) + offset()]);
      const items: Item[] = [];
      const count = [0, 1, 2, 5, 20, 80, 170, 320][rng.int(8)] as number;
      for (let i = 0; i < count; i++) items.push(randomItem(rng, nextId++, anchors, items));
      for (let a = 0; a < 2 && items.length > 0; a++) {
        const other = rng.pick(items);
        anchors.push([other.x, other.y]);
      }
      grid.rebuild(items, isTough);
      // Items added before the first query are sorted in with the rest.
      if (rng.chance(0.3)) items.push(randomItem(rng, nextId++, anchors, items));
      add(checkQueries(rng, grid, items, anchors), false);

      // Later in the same tick: kills, new items (split children), changed inbound counts.
      for (const target of items) {
        if (rng.chance(0.1)) target.alive = false;
        if (rng.chance(0.1)) target.inbound = rng.int(4);
      }
      const extra = rng.int(6);
      for (let i = 0; i < extra; i++) items.push(randomItem(rng, nextId++, anchors, items));
      add(checkQueries(rng, grid, items, anchors), extra > 0);

      // Next tick: everything moves, the dead are compacted out, the grid is rebuilt.
      for (const target of items) {
        target.x += rng.range(-5, 5);
        target.y += rng.range(-5, 5);
      }
      let kept = 0;
      for (const target of items) if (target.alive) items[kept++] = target;
      items.length = kept;
      grid.rebuild(items, isTough);
      add(checkQueries(rng, grid, items, anchors), false);
    }
    expect(total.queries).toBe(STATES * 3 * 6);
    // The random states really exercise tie-breaking and late items.
    expect(total.ties).toBeGreaterThan(TIES_MIN);
    expect(total.late).toBeGreaterThan(LATE_MIN);
  });
});
