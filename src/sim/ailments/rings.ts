/**
 * DoT rings (docs/v3/implementation-plan-v3.md §2.5): uncapped damage-over-time stacks at O(1)
 * per application and per step, whatever the number of stacks. Poison always lives in rings;
 * burn does under eternalFlame (BuildFlags.burnRings), and capped burns stay records
 * (records.ts).
 *
 * Damage over time is dealt in steps at ticks 15k (BURN_TICK_INTERVAL); step k covers the ticks
 * (15(k−1), 15k]. A ring holds what its stacks will deal in the next RING_BUCKETS steps: bucket
 * k & 63 has the change of the damage rate at step k (dRate), the damage of partial steps at a
 * stack's start and end (extra) and the stacks ending in step k (dCount). The
 * header has the current rate, the damage left to deal, the live stacks, the last step any
 * stack reaches, and the ring's source class and credit. A stack lasts at most 63 full steps
 * after the one it starts in (15.75–16 s); a longer one is cut there.
 *
 * Each enemy has at most one ring per ailment and source class (center, outer, fusion), so a
 * ring credits one source: the center, the ailment's outer board, or the first fusion that
 * applied to it. The pool keeps rings in typed arrays that double when full; a ring is taken
 * with alloc(), which clears it, and given back with release(): on its last step, at its
 * enemy's death or when its enemy leaks (ailments/apply.ts).
 *
 * Buckets and header hold the doubles behind Num (src/core/num.ts), which typed arrays need;
 * damage leaves a ring as a Num.
 */

import { num, toNumber } from '../../core/num';
import type { Num } from '../../core/num';
import type { Enemy } from '../systems/context';
import { DT } from '../types';

/** Damage over time is dealt every this many ticks (0.25 s): BURN_TICK_INTERVAL. */
export const DOT_STEP_TICKS = 15;
/** Steps a ring looks ahead; a power of two. */
export const RING_BUCKETS = 64;
const BUCKET_MASK = RING_BUCKETS - 1;
const W = DOT_STEP_TICKS;
/** A step's length in seconds, 0.25 exactly. */
const STEP_SEC = W * DT;

/**
 * Enemy.rings layout: a ring per source class (SOURCE_CLASS_ORDINAL center 0, outer 1,
 * fusion 2) from each ailment's first slot.
 */
export const RING_BURN = 0;
export const RING_POISON = 3;
/** Ailments kept in rings. */
export const RING_SLOTS = 6;

/**
 * The enemy holds poison at tick `now`: one of its poison stacks has not ended yet. Damage left
 * from ended stacks until the next step does not count, as with burn records (records.ts).
 */
export function holdsPoison(enemy: Enemy, now: number): boolean {
  return enemy.poisonRingEnd > now;
}

/** The enemy's poison stacks at tick `now`: none once every stack has ended. */
export function livePoisonStacks(enemy: Enemy, now: number): number {
  return enemy.poisonRingEnd > now ? enemy.poisonStacks : 0;
}

/** Rings a pool holds before its first growth. */
const INITIAL_RINGS = 64;

/** A pool of DoT rings; a ring is an index into its arrays. */
export class RingPool {
  /** Damage per second of the stacks running through the current step. */
  rate: Float64Array;
  /** Damage the ring has yet to deal. */
  remaining: Float64Array;
  /** Stacks that have not reached their last step. */
  stacks: Int32Array;
  /** The last step any of its stacks reaches. */
  last: Int32Array;
  /** The latest tick any of its stacks ends at. */
  end: Float64Array;
  /** Source class (SOURCE_CLASS_ORDINAL) and credited source index. */
  cls: Int32Array;
  credit: Int32Array;
  /** Per ring × RING_BUCKETS. */
  dRate: Float64Array;
  extra: Float64Array;
  dCount: Int32Array;
  /** Rings in use. */
  live = 0;
  /**
   * Units of work done (an apply, a step, a bucket a spread visits): tests check that a step
   * costs the same for 5 and 500 stacks.
   */
  ops = 0;
  private capacity = 0;
  /** Rings ever handed out; slots below it are in use or on the free list. */
  private used = 0;
  private free: Int32Array;
  private freeCount = 0;

  constructor(capacity = INITIAL_RINGS) {
    this.rate = new Float64Array(capacity);
    this.remaining = new Float64Array(capacity);
    this.stacks = new Int32Array(capacity);
    this.last = new Int32Array(capacity);
    this.end = new Float64Array(capacity);
    this.cls = new Int32Array(capacity);
    this.credit = new Int32Array(capacity);
    this.dRate = new Float64Array(capacity * RING_BUCKETS);
    this.extra = new Float64Array(capacity * RING_BUCKETS);
    this.dCount = new Int32Array(capacity * RING_BUCKETS);
    this.free = new Int32Array(capacity);
    this.capacity = capacity;
  }

  /** A cleared ring of source class `cls` crediting `credit`. */
  alloc(cls: number, credit: number): number {
    let r: number;
    if (this.freeCount > 0) r = this.free[--this.freeCount] as number;
    else {
      if (this.used === this.capacity) this.grow();
      r = this.used++;
    }
    this.rate[r] = 0;
    this.remaining[r] = 0;
    this.stacks[r] = 0;
    this.last[r] = 0;
    this.end[r] = 0;
    this.cls[r] = cls;
    this.credit[r] = credit;
    const b = r * RING_BUCKETS;
    this.dRate.fill(0, b, b + RING_BUCKETS);
    this.extra.fill(0, b, b + RING_BUCKETS);
    this.dCount.fill(0, b, b + RING_BUCKETS);
    this.live++;
    return r;
  }

  /** Gives ring `r` back; alloc() clears it before reuse. */
  release(r: number): void {
    this.free[this.freeCount++] = r;
    this.live--;
  }

  /**
   * Adds `n` stacks of `dps` each, from tick `t` to tick `end` (end > t; fractional ticks are
   * exact), cut at the ring's window.
   */
  apply(r: number, dps: Num, t: number, end: number, n = 1): void {
    this.ops++;
    const rate = toNumber(dps) * n;
    const e = Math.min(end, W * (Math.ceil(t / W) + BUCKET_MASK));
    if (!(e > t)) return;
    const k0 = Math.floor(t / W) + 1;
    const last = Math.ceil(e / W);
    const b = r * RING_BUCKETS;
    const { dRate, extra, dCount } = this;
    const first = b + (k0 & BUCKET_MASK);
    const tail = b + (last & BUCKET_MASK);
    // Damage as burn records count it (records.ts accrued): dps × (ticks × DT).
    if (last === k0) extra[first] = (extra[first] as number) + rate * ((e - t) * DT);
    else {
      const next = b + ((k0 + 1) & BUCKET_MASK);
      extra[first] = (extra[first] as number) + rate * ((W * k0 - t) * DT);
      dRate[next] = (dRate[next] as number) + rate;
      dRate[tail] = (dRate[tail] as number) - rate;
      extra[tail] = (extra[tail] as number) + rate * ((e - W * (last - 1)) * DT);
    }
    dCount[tail] = (dCount[tail] as number) + n;
    this.stacks[r] = (this.stacks[r] as number) + n;
    this.remaining[r] = (this.remaining[r] as number) + rate * ((e - t) * DT);
    if (last > (this.last[r] as number)) this.last[r] = last;
    if (e > (this.end[r] as number)) this.end[r] = e;
  }

  /**
   * Step k of ring `r`, at tick 15k: the damage it deals, never negative. Afterwards the ring is
   * done when k ≥ last[r] (ended()), and its owner releases it.
   */
  step(r: number, k: number): Num {
    this.ops++;
    const at = r * RING_BUCKETS + (k & BUCKET_MASK);
    const rate = (this.rate[r] as number) + (this.dRate[at] as number);
    this.rate[r] = rate;
    const dealt = rate * STEP_SEC + (this.extra[at] as number);
    this.stacks[r] = (this.stacks[r] as number) - (this.dCount[at] as number);
    this.dRate[at] = 0;
    this.extra[at] = 0;
    this.dCount[at] = 0;
    this.remaining[r] = (this.remaining[r] as number) - dealt;
    return num(dealt > 0 ? dealt : 0);
  }

  /** Ring `r` has dealt its last step once step k is done. */
  ended(r: number, k: number): boolean {
    return k >= (this.last[r] as number);
  }

  /**
   * Copies `f` of the damage ring `src` has left after tick `now` into ring `dst`, and moves
   * floor(sf × its live stacks) stack counts, those that last longest first. Exact but for the
   * step under way, whose share after `now` is taken as its average. Returns the stacks moved.
   */
  spread(src: number, dst: number, f: number, sf: number, now: number): number {
    const u = Math.ceil(now / W);
    const sb = src * RING_BUCKETS;
    const db = dst * RING_BUCKETS;
    const { dRate, extra, dCount } = this;
    const srcLast = this.last[src] as number;
    const rateU = (this.rate[src] as number) + (dRate[sb + (u & BUCKET_MASK)] as number);
    let total = 0;
    // The step under way: its share after now. A spread on a step tick has none.
    if (now < W * u) {
      const left = W * u - now;
      const share = rateU * (left * DT) + ((extra[sb + (u & BUCKET_MASK)] as number) * left) / W;
      const d = db + (u & BUCKET_MASK);
      extra[d] = (extra[d] as number) + f * share;
      total += share;
    }
    const next = db + ((u + 1) & BUCKET_MASK);
    dRate[next] = (dRate[next] as number) + f * rateU;
    let rate = rateU;
    for (let k = u + 1; k <= srcLast; k++) {
      this.ops++;
      const s = sb + (k & BUCKET_MASK);
      const d = db + (k & BUCKET_MASK);
      rate += dRate[s] as number;
      total += rate * STEP_SEC + (extra[s] as number);
      dRate[d] = (dRate[d] as number) + f * (dRate[s] as number);
      extra[d] = (extra[d] as number) + f * (extra[s] as number);
    }
    this.remaining[dst] = (this.remaining[dst] as number) + f * total;
    if (srcLast > (this.last[dst] as number)) this.last[dst] = srcLast;
    if ((this.end[src] as number) > (this.end[dst] as number))
      this.end[dst] = this.end[src] as number;
    // Stack counts: before its step, bucket u still holds live stacks.
    const u0 = now < W * u ? u : u + 1;
    let live = 0;
    for (let k = u0; k <= srcLast; k++) live += dCount[sb + (k & BUCKET_MASK)] as number;
    let move = Math.floor(sf * live + 1e-9);
    const moved = move;
    for (let k = srcLast; k >= u0 && move > 0; k--) {
      const n = Math.min(dCount[sb + (k & BUCKET_MASK)] as number, move);
      dCount[db + (k & BUCKET_MASK)] = (dCount[db + (k & BUCKET_MASK)] as number) + n;
      move -= n;
    }
    this.stacks[dst] = (this.stacks[dst] as number) + moved;
    return moved;
  }

  /**
   * Takes `f` (0 < f ≤ 1) of the damage ring `r` has left: returns it, and scales what the ring
   * deals from now on by 1 − f, every step's rate change and partial damage alike, so each
   * stack keeps going, weaker, and the stack counts stay. f ≥ 1 takes it all and gives the ring
   * back; its owner drops it from the enemy's slots.
   */
  consume(r: number, f: number): number {
    const total = this.remaining[r] as number;
    if (f >= 1) {
      this.release(r);
      return total;
    }
    this.ops++;
    const keep = 1 - f;
    this.rate[r] = (this.rate[r] as number) * keep;
    this.remaining[r] = total * keep;
    const b = r * RING_BUCKETS;
    const { dRate, extra } = this;
    for (let i = b; i < b + RING_BUCKETS; i++) {
      dRate[i] = (dRate[i] as number) * keep;
      extra[i] = (extra[i] as number) * keep;
    }
    return f * total;
  }

  /** Doubles every array, keeping the rings in use. */
  private grow(): void {
    const capacity = this.capacity * 2;
    const f64 = (a: Float64Array, n: number): Float64Array => {
      const b = new Float64Array(n);
      b.set(a);
      return b;
    };
    const i32 = (a: Int32Array, n: number): Int32Array => {
      const b = new Int32Array(n);
      b.set(a);
      return b;
    };
    this.rate = f64(this.rate, capacity);
    this.remaining = f64(this.remaining, capacity);
    this.stacks = i32(this.stacks, capacity);
    this.last = i32(this.last, capacity);
    this.end = f64(this.end, capacity);
    this.cls = i32(this.cls, capacity);
    this.credit = i32(this.credit, capacity);
    this.dRate = f64(this.dRate, capacity * RING_BUCKETS);
    this.extra = f64(this.extra, capacity * RING_BUCKETS);
    this.dCount = i32(this.dCount, capacity * RING_BUCKETS);
    this.free = i32(this.free, capacity);
    this.capacity = capacity;
  }
}
