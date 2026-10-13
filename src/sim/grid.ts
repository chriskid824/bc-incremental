/**
 * Uniform spatial grid for nearby-target queries (docs/v3/implementation-plan-v3.md §2.3).
 *
 * The area [0, width) × [0, height) is cut into square cells, with one extra ring of cells
 * around it for entities just outside (enemies spawn there); anything farther out is clamped
 * into that ring, whose cells reach to infinity. The grid indexes a source array: rebuild()
 * hands it over, and the first query after that sorts it into the cells with a counting sort
 * into flat typed arrays. Once those arrays have grown to the largest population, sorting
 * allocates nothing, and neither does any query. Sorting at the first query rather than in
 * rebuild() means a tick without queries costs nothing. A source smaller than the
 * constructor's `linearBelow` is not sorted at all: scanning a few dozen items beats the
 * sort and the cell walk, so every query then scans the whole source (linearSource()).
 *
 * Every query returns exactly what a linear scan over the source array would, for any finite
 * query point and any radius:
 * - alive items only; `alive` is read at query time, so items that die after the sort drop
 *   out at once;
 * - squared distances are computed as dx = item.x - x, dy = item.y - y, dx * dx + dy * dy;
 * - ties go to the earlier source entry, i.e. the lower id for arrays ordered by id;
 * - items appended to the source array after the sort (split children of a kill) are not in
 *   the cells, but every query also scans them linearly.
 * A cell is skipped only when a lower bound of the squared distance to anything in it,
 * computed with the same rounded arithmetic, already loses to the best candidate; rounding is
 * monotonic, so the bound never exceeds a real distance and skipping changes no result.
 *
 * From the first query after rebuild() until the next rebuild(), the source array may only
 * grow: entries must not move, be removed, or change position. The simulation rebuilds right
 * after enemy movement and compacts its arrays after the tick's last query; an entity moved
 * during a tick (knockback, none yet) is found at its new cell only from the next tick on.
 * Positions must be finite.
 */

/** What the grid needs to know about an item. */
export interface GridItem {
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
}

/** A point a query writes its answer into. */
export interface GridPoint {
  x: number;
  y: number;
}

/** Hits up to this many are ordered by insertion sort, more by a sweep over source indices. */
const INSERTION_SORT_MAX = 24;

const NO_INDEX = 0x7fffffff;

export class SpatialGrid<T extends GridItem> {
  /** Columns and rows, the outer ring included. */
  readonly cols: number;
  readonly rows: number;
  private readonly cellSize: number;
  /** 1 / cellSize: a power of two, so multiplying by it is exact. */
  private readonly perCell: number;
  private readonly width: number;
  private readonly height: number;
  /** Extent of the inner cells, whole cells from 0, so at least width × height. */
  private readonly spanX: number;
  private readonly spanY: number;
  /** Column and row bounds [lo, hi); the outer ring reaches to -Infinity and Infinity. */
  private readonly colLo: Float64Array;
  private readonly colHi: Float64Array;
  private readonly rowLo: Float64Array;
  private readonly rowHi: Float64Array;
  /** Cell c holds the slots cellStart[c] .. cellStart[c + 1] - 1. */
  private readonly cellStart: Int32Array;
  /** Alive items per cell, scratch for densest(). */
  private readonly cellAlive: Int32Array;
  /** Sources with fewer entries are not sorted into the cells. */
  private readonly linearBelow: number;

  private source: readonly T[] = [];
  private mark: ((item: T) => boolean) | undefined = undefined;
  /** rebuild() was called and the source is not sorted into the cells yet. */
  private stale = false;
  /** Items in the cells: source[0 .. size); 0 when the source was too small to sort. */
  private size = 0;
  private markedSize = 0;
  /** Source index of the item in each slot; each cell keeps its items in source order. */
  private slotIndex = new Int32Array(0);
  /** Cell of each source index at the sort. */
  private itemCell = new Int32Array(0);
  /** Source indices of the marked items, ascending. */
  private markedIndex = new Int32Array(0);
  /** Source indices hit by within() and inSegmentBox(), before ordering. */
  private hits = new Int32Array(0);
  /** Per source index: the stamp of the last ordering sweep that saw it. */
  private stamps = new Int32Array(0);
  private stamp = 0;

  /** nearest() state: the best candidate so far. */
  private best: T | null = null;
  private bestIndex = NO_INDEX;
  private bestDistSq = 0;

  /**
   * `cellSize` must be a power of two: dividing by it is then exact, so every item lies
   * inside the bounds of its cell and skipping cells stays exact. A source with fewer than
   * `linearBelow` entries at the first query after rebuild() stays out of the cells, and the
   * queries until the next rebuild() scan it linearly; 0 (the default) always sorts.
   */
  constructor(width: number, height: number, cellSize: number, linearBelow = 0) {
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
      throw new RangeError(`Grid area must be positive and finite, got ${width} × ${height}`);
    }
    if (!(cellSize > 0) || 2 ** Math.round(Math.log2(cellSize)) !== cellSize) {
      throw new RangeError(`Grid cellSize must be a power of two, got ${cellSize}`);
    }
    const innerCols = Math.ceil(width / cellSize);
    const innerRows = Math.ceil(height / cellSize);
    this.cellSize = cellSize;
    this.perCell = 1 / cellSize;
    this.width = width;
    this.height = height;
    this.cols = innerCols + 2;
    this.rows = innerRows + 2;
    this.spanX = innerCols * cellSize;
    this.spanY = innerRows * cellSize;
    this.colLo = new Float64Array(this.cols);
    this.colHi = new Float64Array(this.cols);
    this.rowLo = new Float64Array(this.rows);
    this.rowHi = new Float64Array(this.rows);
    fillBounds(this.colLo, this.colHi, cellSize);
    fillBounds(this.rowLo, this.rowHi, cellSize);
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    this.cellAlive = new Int32Array(this.cols * this.rows);
    this.linearBelow = linearBelow;
  }

  /**
   * Indexes `source` (kept by reference) as it is at the next query. Every entry goes into the
   * cells, dead ones too (queries skip them), unless the source is too small to sort. Items
   * for which `mark` returns true are also listed apart (marked()), for the few items a caller
   * scans directly, such as focus targets.
   */
  rebuild(source: readonly T[], mark?: (item: T) => boolean): void {
    this.source = source;
    this.mark = mark;
    this.stale = true;
  }

  /**
   * Number of items that may be marked: those marked when the source was sorted, then every
   * item appended to the source since (the grid cannot tell whether those are). Read them
   * with marked(0 .. count - 1), in source order.
   */
  markedCount(): number {
    if (this.stale) this.prepare();
    return this.markedSize + this.source.length - this.size;
  }

  /**
   * The source when no item sits in the cells (it was too small to sort), so that every query
   * would scan it whole anyway; a caller with its own scan for the query can run that instead.
   * Null when the source is sorted into the cells.
   */
  linearSource(): readonly T[] | null {
    if (this.stale) this.prepare();
    return this.size === 0 ? this.source : null;
  }

  /** The k-th item that may be marked (see markedCount(), which must be called first). */
  marked(k: number): T {
    const index =
      k < this.markedSize ? (this.markedIndex[k] as number) : this.size + k - this.markedSize;
    return this.source[index] as T;
  }

  /**
   * Alive item closest to (x, y) within squared distance maxDistSq (inclusive) for which
   * `accept` returns true, or any alive one without `accept`; ties go to the earlier source
   * entry. Null when there is none. Searches rings of cells outwards from the cell of (x, y)
   * and stops once the next ring cannot hold anything closer. `accept` is only asked about
   * items closer than the best so far, so it must be pure.
   */
  nearest(x: number, y: number, maxDistSq: number, accept?: (item: T) => boolean): T | null {
    if (this.stale) this.prepare();
    this.best = null;
    this.bestIndex = NO_INDEX;
    this.bestDistSq = maxDistSq;
    const source = this.source;
    for (let i = this.size; i < source.length; i++) {
      this.consider(source[i] as T, i, x, y, accept);
    }
    if (this.size > 0) this.searchRings(x, y, accept);
    const best = this.best;
    this.best = null;
    return best;
  }

  /**
   * Alive items within squared distance radiusSq (inclusive) of (x, y), written to out[0 ..
   * count) in source order; returns count. `out` is reused as is: entries from count on are
   * left over from earlier calls, so read only the first count.
   */
  within(x: number, y: number, radiusSq: number, out: T[]): number {
    if (this.stale) this.prepare();
    const source = this.source;
    let count = 0;
    if (this.size > 0) {
      const slotIndex = this.slotIndex;
      const cellStart = this.cellStart;
      const hits = this.hits;
      const cols = this.cols;
      const rowLo = this.rowLo;
      const rowHi = this.rowHi;
      const colLo = this.colLo;
      const colHi = this.colHi;
      // Widen the block of cells from the cell of (x, y) while the gap to the next column or
      // row, in the arithmetic of the distances, is within the radius: exact at any distance.
      const c0 = this.colOf(x);
      const r0 = this.rowOf(y);
      let cFrom = c0;
      while (cFrom > 0 && square(x - (colLo[cFrom] as number)) <= radiusSq) cFrom--;
      let cTo = c0;
      while (cTo < cols - 1 && square((colHi[cTo] as number) - x) <= radiusSq) cTo++;
      let rFrom = r0;
      while (rFrom > 0 && square(y - (rowLo[rFrom] as number)) <= radiusSq) rFrom--;
      let rTo = r0;
      while (rTo < this.rows - 1 && square((rowHi[rTo] as number) - y) <= radiusSq) rTo++;
      for (let row = rFrom; row <= rTo; row++) {
        for (let c = cFrom; c <= cTo; c++) {
          const cell = row * cols + c;
          const end = cellStart[cell + 1] as number;
          let s = cellStart[cell] as number;
          if (s === end || this.cellGapSq(c, row, x, y) > radiusSq) continue;
          for (; s < end; s++) {
            const index = slotIndex[s] as number;
            const item = source[index] as T;
            if (!item.alive) continue;
            const dx = item.x - x;
            const dy = item.y - y;
            if (dx * dx + dy * dy <= radiusSq) hits[count++] = index;
          }
        }
      }
      count = this.ordered(count, out);
    }
    for (let i = this.size; i < source.length; i++) {
      const item = source[i] as T;
      if (!item.alive) continue;
      const dx = item.x - x;
      const dy = item.y - y;
      if (dx * dx + dy * dy <= radiusSq) out[count++] = item;
    }
    return count;
  }

  /**
   * Alive items inside the bounding box of the segment from (ax, ay) to (bx, by), grown by
   * `pad` on every side (bounds inclusive), written to out[0 .. count) in source order like
   * within(); returns count. Only the cells the box touches are read. For segment damage, pad
   * by the largest enemy radius and test each item's distance to the segment.
   */
  inSegmentBox(ax: number, ay: number, bx: number, by: number, pad: number, out: T[]): number {
    if (this.stale) this.prepare();
    const minX = Math.min(ax, bx) - pad;
    const maxX = Math.max(ax, bx) + pad;
    const minY = Math.min(ay, by) - pad;
    const maxY = Math.max(ay, by) + pad;
    const source = this.source;
    const slotIndex = this.slotIndex;
    const cellStart = this.cellStart;
    const hits = this.hits;
    const cols = this.cols;
    const cFrom = this.colOf(minX);
    const cTo = this.colOf(maxX);
    const rTo = this.rowOf(maxY);
    let count = 0;
    for (let row = this.rowOf(minY); row <= rTo; row++) {
      // The cells of one row hold consecutive slots.
      const end = cellStart[row * cols + cTo + 1] as number;
      for (let s = cellStart[row * cols + cFrom] as number; s < end; s++) {
        const index = slotIndex[s] as number;
        const item = source[index] as T;
        if (item.alive && item.x >= minX && item.x <= maxX && item.y >= minY && item.y <= maxY) {
          hits[count++] = index;
        }
      }
    }
    count = this.ordered(count, out);
    for (let i = this.size; i < source.length; i++) {
      const item = source[i] as T;
      if (item.alive && item.x >= minX && item.x <= maxX && item.y >= minY && item.y <= maxY) {
        out[count++] = item;
      }
    }
    return count;
  }

  /**
   * Densest point: the inner cell whose 3 × 3 block of cells holds the most alive items (the
   * outer ring counts as neighbours but is never the center). Writes the center of that cell,
   * clamped to the area, into `out` and returns the block's count; ties go to the first cell
   * in row-major order. Returns 0 and leaves `out` alone when nothing is alive.
   */
  densest(out: GridPoint): number {
    if (this.stale) this.prepare();
    const source = this.source;
    const itemCell = this.itemCell;
    const cellAlive = this.cellAlive;
    const cols = this.cols;
    cellAlive.fill(0);
    for (let i = 0; i < this.size; i++) {
      if ((source[i] as T).alive) addOne(cellAlive, itemCell[i] as number);
    }
    for (let i = this.size; i < source.length; i++) {
      const item = source[i] as T;
      if (item.alive) addOne(cellAlive, this.rowOf(item.y) * cols + this.colOf(item.x));
    }
    let bestCount = 0;
    let bestCol = 0;
    let bestRow = 0;
    for (let row = 1; row < this.rows - 1; row++) {
      for (let c = 1; c < cols - 1; c++) {
        let count = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const base = (row + dr) * cols + c;
          count +=
            (cellAlive[base - 1] as number) +
            (cellAlive[base] as number) +
            (cellAlive[base + 1] as number);
        }
        if (count > bestCount) {
          bestCount = count;
          bestCol = c;
          bestRow = row;
        }
      }
    }
    if (bestCount > 0) {
      const half = this.cellSize / 2;
      out.x = Math.min((this.colLo[bestCol] as number) + half, this.width);
      out.y = Math.min((this.rowLo[bestRow] as number) + half, this.height);
    }
    return bestCount;
  }

  /** At the first query after rebuild(): sorts the source, unless it is too small to. */
  private prepare(): void {
    if (this.source.length >= this.linearBelow) {
      this.sort();
      return;
    }
    // Every entry counts as appended after an empty sort, so the queries scan them all.
    this.stale = false;
    this.cellStart.fill(0);
    this.size = 0;
    this.markedSize = 0;
  }

  /** Counting sort of the source into the cells; each cell keeps its items in source order. */
  private sort(): void {
    this.stale = false;
    const source = this.source;
    const mark = this.mark;
    const n = source.length;
    if (n > this.slotIndex.length) this.grow(n);
    const cellStart = this.cellStart;
    const itemCell = this.itemCell;
    const markedIndex = this.markedIndex;
    const cells = cellStart.length - 1;
    const cols = this.cols;
    const lastCol = cols - 1;
    const lastRow = this.rows - 1;
    const spanX = this.spanX;
    const spanY = this.spanY;
    const perCell = this.perCell;
    cellStart.fill(0);
    let marked = 0;
    for (let i = 0; i < n; i++) {
      const item = source[i] as T;
      // colOf and rowOf, inlined.
      const x = item.x;
      const y = item.y;
      const c = x < 0 ? 0 : x >= spanX ? lastCol : 1 + ((x * perCell) | 0);
      const row = y < 0 ? 0 : y >= spanY ? lastRow : 1 + ((y * perCell) | 0);
      const cell = row * cols + c;
      itemCell[i] = cell;
      cellStart[cell] = (cellStart[cell] as number) + 1;
      if (mark !== undefined && mark(item)) markedIndex[marked++] = i;
    }
    // Running totals give each cell's end; placing the items backwards then counts every
    // cell down to its start and leaves each cell's items in source order.
    let total = 0;
    for (let c = 0; c < cells; c++) {
      total += cellStart[c] as number;
      cellStart[c] = total;
    }
    cellStart[cells] = n;
    const slotIndex = this.slotIndex;
    for (let i = n - 1; i >= 0; i--) {
      const cell = itemCell[i] as number;
      const slot = (cellStart[cell] as number) - 1;
      cellStart[cell] = slot;
      slotIndex[slot] = i;
    }
    this.size = n;
    this.markedSize = marked;
  }

  private colOf(x: number): number {
    // `| 0` floors the non-negative, exact quotient.
    return x < 0 ? 0 : x >= this.spanX ? this.cols - 1 : 1 + ((x * this.perCell) | 0);
  }

  private rowOf(y: number): number {
    return y < 0 ? 0 : y >= this.spanY ? this.rows - 1 : 1 + ((y * this.perCell) | 0);
  }

  /**
   * Lower bound of dx * dx + dy * dy from (x, y) to any point of the cell, in the same rounded
   * arithmetic: |dx| is never below the gap to the cell's nearest edge.
   */
  private cellGapSq(c: number, row: number, x: number, y: number): number {
    const lo = this.colLo[c] as number;
    const hi = this.colHi[c] as number;
    const top = this.rowLo[row] as number;
    const bottom = this.rowHi[row] as number;
    const gx = x < lo ? lo - x : x >= hi ? x - hi : 0;
    const gy = y < top ? top - y : y >= bottom ? y - bottom : 0;
    return gx * gx + gy * gy;
  }

  /**
   * Lower bound of the distance from (x, y), which lies in the block of columns cFrom .. cTo
   * and rows rFrom .. rTo, to any cell outside the block; Infinity when there is none.
   */
  private blockGap(
    x: number,
    y: number,
    cFrom: number,
    cTo: number,
    rFrom: number,
    rTo: number,
  ): number {
    let gap = Infinity;
    if (cFrom > 0) gap = Math.min(gap, x - (this.colLo[cFrom] as number));
    if (cTo < this.cols - 1) gap = Math.min(gap, (this.colHi[cTo] as number) - x);
    if (rFrom > 0) gap = Math.min(gap, y - (this.rowLo[rFrom] as number));
    if (rTo < this.rows - 1) gap = Math.min(gap, (this.rowHi[rTo] as number) - y);
    return gap;
  }

  /** nearest() over the cells: rings of cells outwards from the cell of (x, y). */
  private searchRings(x: number, y: number, accept: ((item: T) => boolean) | undefined): void {
    const cols = this.cols;
    const rows = this.rows;
    const c0 = this.colOf(x);
    const r0 = this.rowOf(y);
    this.scanNearest(c0, r0, x, y, accept);
    for (let k = 1; ; k++) {
      // Cells left to search lie outside the block of the rings searched so far.
      const gap = this.blockGap(x, y, c0 - k + 1, c0 + k - 1, r0 - k + 1, r0 + k - 1);
      if (gap * gap > this.bestDistSq) break;
      const cMin = c0 - k;
      const cMax = c0 + k;
      const rMin = r0 - k;
      const rMax = r0 + k;
      const cFrom = cMin > 0 ? cMin : 0;
      const cTo = cMax < cols - 1 ? cMax : cols - 1;
      if (rMin >= 0) {
        for (let c = cFrom; c <= cTo; c++) this.scanNearest(c, rMin, x, y, accept);
      }
      if (rMax < rows) {
        for (let c = cFrom; c <= cTo; c++) this.scanNearest(c, rMax, x, y, accept);
      }
      const rFrom = rMin + 1 > 0 ? rMin + 1 : 0;
      const rTo = rMax - 1 < rows - 1 ? rMax - 1 : rows - 1;
      if (cMin >= 0) {
        for (let r = rFrom; r <= rTo; r++) this.scanNearest(cMin, r, x, y, accept);
      }
      if (cMax < cols) {
        for (let r = rFrom; r <= rTo; r++) this.scanNearest(cMax, r, x, y, accept);
      }
      if (cMin <= 0 && cMax >= cols - 1 && rMin <= 0 && rMax >= rows - 1) break;
    }
  }

  private scanNearest(
    c: number,
    row: number,
    x: number,
    y: number,
    accept: ((item: T) => boolean) | undefined,
  ): void {
    const cell = row * this.cols + c;
    const start = this.cellStart[cell] as number;
    const end = this.cellStart[cell + 1] as number;
    if (start === end || this.cellGapSq(c, row, x, y) > this.bestDistSq) return;
    const source = this.source;
    const slotIndex = this.slotIndex;
    for (let s = start; s < end; s++) {
      const index = slotIndex[s] as number;
      this.consider(source[index] as T, index, x, y, accept);
    }
  }

  private consider(
    item: T,
    index: number,
    x: number,
    y: number,
    accept: ((item: T) => boolean) | undefined,
  ): void {
    if (!item.alive) return;
    const dx = item.x - x;
    const dy = item.y - y;
    const distSq = dx * dx + dy * dy;
    if (
      (distSq < this.bestDistSq || (distSq === this.bestDistSq && index < this.bestIndex)) &&
      (accept === undefined || accept(item))
    ) {
      this.best = item;
      this.bestIndex = index;
      this.bestDistSq = distSq;
    }
  }

  /** Writes the items of hits[0 .. count) to out[0 .. count) in source order. */
  private ordered(count: number, out: T[]): number {
    const hits = this.hits;
    const source = this.source;
    if (count <= INSERTION_SORT_MAX) {
      for (let i = 1; i < count; i++) {
        const index = hits[i] as number;
        let j = i - 1;
        while (j >= 0 && (hits[j] as number) > index) {
          hits[j + 1] = hits[j] as number;
          j--;
        }
        hits[j + 1] = index;
      }
      for (let i = 0; i < count; i++) out[i] = source[hits[i] as number] as T;
      return count;
    }
    // Many hits: stamp them, then sweep the source indices from the lowest to the highest.
    const stamps = this.stamps;
    if (++this.stamp === NO_INDEX) {
      stamps.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    let low = NO_INDEX;
    let high = -1;
    for (let i = 0; i < count; i++) {
      const index = hits[i] as number;
      stamps[index] = stamp;
      if (index < low) low = index;
      if (index > high) high = index;
    }
    let written = 0;
    for (let index = low; index <= high; index++) {
      if (stamps[index] === stamp) out[written++] = source[index] as T;
    }
    return written;
  }

  private grow(n: number): void {
    const capacity = Math.max(n, this.slotIndex.length * 2, 64);
    this.slotIndex = new Int32Array(capacity);
    this.itemCell = new Int32Array(capacity);
    this.markedIndex = new Int32Array(capacity);
    this.hits = new Int32Array(capacity);
    this.stamps = new Int32Array(capacity);
    this.stamp = 0;
  }
}

const square = (v: number): number => v * v;

const addOne = (counts: Int32Array, i: number): void => {
  counts[i] = (counts[i] as number) + 1;
};

/** Bounds of the outer ring, the inner cells, then the outer ring again. */
function fillBounds(lo: Float64Array, hi: Float64Array, cellSize: number): void {
  const last = lo.length - 1;
  for (let i = 0; i <= last; i++) {
    lo[i] = i === 0 ? -Infinity : (i - 1) * cellSize;
    hi[i] = i === last ? Infinity : i * cellSize;
  }
}
