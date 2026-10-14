import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { createRng } from '../../core/rng';
import type { Rng } from '../../core/rng';
import { DT } from '../types';
import { DOT_STEP_TICKS, RING_BUCKETS, RingPool } from './rings';

const W = DOT_STEP_TICKS;

/** A stack as the naive reference keeps it: dps from tick t to tick e (already windowed). */
interface NaiveStack {
  readonly d: number;
  readonly t: number;
  readonly e: number;
}

/** The last step a stack ending at tick e reaches. */
const lastStep = (e: number): number => Math.ceil(e / W);

/**
 * The per-stack reference a ring must reproduce: every stack kept on its own, damage counted
 * over (15(k − 1), 15k] for step k. Stack counts are kept apart (by their last step), since a
 * spread moves counts and damage separately (A6).
 */
class Naive {
  readonly stacks: NaiveStack[] = [];
  /** The last step of each counted stack. */
  readonly counts: number[] = [];

  apply(d: number, t: number, end: number, n: number): void {
    const e = Math.min(end, W * (Math.ceil(t / W) + RING_BUCKETS - 1));
    if (!(e > t)) return;
    for (let i = 0; i < n; i++) {
      this.stacks.push({ d, t, e });
      this.counts.push(lastStep(e));
    }
  }

  step(k: number): number {
    let sum = 0;
    for (const s of this.stacks) {
      const ticks = Math.min(s.e, W * k) - Math.max(s.t, W * (k - 1));
      if (ticks > 0) sum += s.d * ticks * DT;
    }
    return sum;
  }

  /** Damage after tick `at`. */
  left(at: number): number {
    let sum = 0;
    for (const s of this.stacks) {
      const ticks = s.e - Math.max(s.t, at);
      if (ticks > 0) sum += s.d * ticks * DT;
    }
    return sum;
  }

  /** Stacks counted after step k. */
  live(k: number): number {
    return this.counts.filter((last) => last > k).length;
  }

  /** The damage scale of step k, for relative comparisons: what its stacks deal at full rate. */
  scale(k: number): number {
    let sum = 0;
    for (const s of this.stacks) if (s.e > W * (k - 1) && s.t < W * k) sum += s.d * W * DT;
    return sum;
  }

  /**
   * Spread at tick `now` into `dst`: f of every stack's damage after now, and the
   * floor(sf × live) live stacks with the latest last step. Returns the stacks moved.
   */
  spreadTo(dst: Naive, f: number, sf: number, now: number): number {
    for (const s of this.stacks) if (s.e > now) dst.stacks.push({ d: f * s.d, t: now, e: s.e });
    // Live: stacks whose last step has not been dealt; on a step tick that step is done.
    const u0 = now % W === 0 ? now / W + 1 : Math.ceil(now / W);
    const live = this.counts.filter((last) => last >= u0).sort((a, b) => b - a);
    const moved = live.slice(0, Math.floor(sf * live.length + 1e-9));
    dst.counts.push(...moved);
    return moved.length;
  }
}

/** Log-uniform in [lo, hi). */
const logUniform = (rng: Rng, lo: number, hi: number): number =>
  Math.exp(rng.range(Math.log(lo), Math.log(hi)));

const expectClose = (actual: number, expected: number, scale: number, label: string): void => {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-9 * Math.max(scale, 1e-300));
};

/** A random stack: log-uniform dps, a fractional end from 0.1 s to 20 s away (some windowed). */
function randomStack(rng: Rng, now: number): { d: number; end: number; n: number } {
  return {
    d: logUniform(rng, 0.01, 1000),
    end: now + rng.range(0.1, 20) * 60,
    n: rng.chance(0.2) ? 1 + rng.int(4) : 1,
  };
}

describe('RingPool', () => {
  it('matches the per-stack reference on random schedules, applying before and after steps', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = createRng(seed);
      const pool = new RingPool(1);
      const naive = new Naive();
      let r = pool.alloc(0, 0);
      let applied = 0;
      for (let now = 1; now <= 3000; now++) {
        const apply = (): void => {
          if (!rng.chance(0.08)) return;
          const { d, end, n } = randomStack(rng, now);
          pool.apply(r, num(d), now, end, n);
          naive.apply(d, now, end, n);
          applied++;
        };
        const stepTick = now % W === 0;
        // On a step tick, stacks applied before the step and after it both start next step.
        const before = stepTick && rng.chance(0.5);
        if (!stepTick || before) apply();
        if (stepTick) {
          const k = now / W;
          const dealt = toNumber(pool.step(r, k));
          expectClose(dealt, naive.step(k), naive.scale(k), `seed ${seed} step ${k}`);
          expectClose(
            pool.remaining[r] as number,
            naive.left(now),
            naive.left(W * (k - 1)),
            `left ${k}`,
          );
          expect(pool.stacks[r], `stacks after step ${k}`).toBe(naive.live(k));
          if (!before) apply();
          if (pool.ended(r, k) && naive.left(now) === 0 && naive.live(k) === 0) {
            // A3: the ring goes back at its last step and comes back cleared.
            pool.release(r);
            r = pool.alloc(0, 0);
            naive.stacks.length = 0;
            naive.counts.length = 0;
          }
        }
      }
      expect(applied).toBeGreaterThan(100);
    }
  });

  it('spreads on a step tick exactly: f of the damage after now and the longest stacks (A6)', () => {
    for (const sf of [1, 0.5, 0.3, 0.1]) {
      for (const seed of [11, 12, 13]) {
        const rng = createRng(seed);
        const pool = new RingPool();
        const src = pool.alloc(0, 0);
        const dst = pool.alloc(0, 0);
        const nSrc = new Naive();
        const nDst = new Naive();
        // Both rings carry stacks before the spread; the destination keeps its own.
        for (let now = 1; now <= 600; now++) {
          if (rng.chance(0.1)) {
            const { d, end, n } = randomStack(rng, now);
            pool.apply(src, num(d), now, end, n);
            nSrc.apply(d, now, end, n);
          }
          if (rng.chance(0.03)) {
            const { d, end, n } = randomStack(rng, now);
            pool.apply(dst, num(d), now, end, n);
            nDst.apply(d, now, end, n);
          }
          if (now % W === 0) {
            const k = now / W;
            expectClose(toNumber(pool.step(src, k)), nSrc.step(k), nSrc.scale(k), 'src');
            expectClose(toNumber(pool.step(dst, k)), nDst.step(k), nDst.scale(k), 'dst');
          }
        }
        // Spread at tick 615, before or after that tick's step.
        const now = 615;
        const stepFirst = seed !== 12;
        if (stepFirst) {
          pool.step(src, 41);
          pool.step(dst, 41);
          nSrc.step(41);
          nDst.step(41);
        }
        const f = 0.4 * sf;
        const moved = pool.spread(src, dst, f, sf, now);
        expect(moved, `sf ${sf} seed ${seed}`).toBe(nSrc.spreadTo(nDst, f, sf, now));
        if (sf === 1) expect(moved).toBeGreaterThan(0);
        // Before its step 41 the destination still holds that step's damage of its own stacks.
        const from = stepFirst ? now : now - W;
        expectClose(pool.remaining[dst] as number, nDst.left(from), nDst.left(from), 'left');
        for (let k = stepFirst ? 42 : 41; k <= 41 + RING_BUCKETS; k++) {
          const dealt = toNumber(pool.step(dst, k));
          expectClose(dealt, nDst.step(k), nDst.scale(k), `sf ${sf} seed ${seed} step ${k}`);
          expect(pool.stacks[dst], `dst stacks after ${k}`).toBe(nDst.live(k));
          if (k >= (pool.last[dst] as number)) break;
        }
        expect(pool.ended(dst, pool.last[dst] as number)).toBe(true);
        expect(nDst.live(pool.last[dst] as number)).toBe(0);
      }
    }
  });

  it('bounds a mid-step spread by one step of the source, and is exact after it', () => {
    const rng = createRng(21);
    for (let trial = 0; trial < 40; trial++) {
      const pool = new RingPool();
      const src = pool.alloc(0, 0);
      const dst = pool.alloc(0, 0);
      const nSrc = new Naive();
      const nDst = new Naive();
      const now = 300 + 1 + rng.int(W - 1); // inside step 21
      for (let t = 1; t <= now; t++) {
        if (rng.chance(0.2)) {
          const { d, end, n } = randomStack(rng, t);
          pool.apply(src, num(d), t, end, n);
          nSrc.apply(d, t, end, n);
        }
        if (t % W === 0) pool.step(src, t / W);
      }
      const f = 0.5;
      pool.spread(src, dst, f, 1, now);
      nSrc.spreadTo(nDst, f, 1, now);
      const u = Math.ceil(now / W);
      const bound = f * nSrc.scale(u);
      expect(Math.abs(toNumber(pool.step(dst, u)) - nDst.step(u))).toBeLessThanOrEqual(bound);
      for (let k = u + 1; k <= (pool.last[dst] as number); k++) {
        expectClose(toNumber(pool.step(dst, k)), nDst.step(k), nDst.scale(k), `step ${k}`);
      }
    }
  });

  it('clamps a stack to the 64-step window and frees at k >= last', () => {
    const pool = new RingPool();
    const r = pool.alloc(1, 3);
    expect([pool.cls[r], pool.credit[r]]).toEqual([1, 3]);
    pool.apply(r, num(2), 7, 1e6);
    const last = Math.ceil(7 / W) + RING_BUCKETS - 1;
    expect(pool.last[r]).toBe(last);
    expect(pool.end[r]).toBe(W * last);
    expect(pool.remaining[r]).toBeCloseTo(2 * (W * last - 7) * DT, 9);
    let dealt = 0;
    for (let k = 1; k <= last; k++) {
      expect(pool.ended(r, k - 1)).toBe(false);
      dealt += toNumber(pool.step(r, k));
    }
    expect(pool.ended(r, last)).toBe(true);
    expect(pool.stacks[r]).toBe(0);
    expect(dealt).toBeCloseTo(2 * (W * last - 7) * DT, 9);
    expect(Math.abs(pool.remaining[r] as number)).toBeLessThan(1e-9);
    // A stack applied on a step tick starts with the next step, so it never touches a stepped one.
    const s = pool.alloc(0, 0);
    pool.apply(s, num(4), 30, 45);
    expect(pool.last[s]).toBe(3);
    expect(toNumber(pool.step(s, 2))).toBe(0);
    expect(toNumber(pool.step(s, 3))).toBeCloseTo(4 * W * DT, 12);
    expect(pool.ended(s, 3)).toBe(true);
  });

  it('reuses a released slot cleared, whenever its holder died (A3)', () => {
    const rng = createRng(31);
    for (let trial = 0; trial < 60; trial++) {
      const pool = new RingPool(1);
      const first = pool.alloc(0, 0);
      // A stack whose +dps bucket is stepped or not when its enemy dies.
      const t = 1 + rng.int(40);
      pool.apply(first, num(logUniform(rng, 1, 1e6)), t, t + rng.range(30, 900));
      const dieAt = t + rng.int(60);
      for (let k = 1; k * W <= dieAt; k++) pool.step(first, k);
      pool.release(first);
      expect(pool.live).toBe(0);
      const second = pool.alloc(2, 5);
      expect(second).toBe(first);
      expect([pool.rate[second], pool.remaining[second], pool.stacks[second]]).toEqual([0, 0, 0]);
      expect([pool.last[second], pool.end[second], pool.cls[second], pool.credit[second]]).toEqual([
        0, 0, 2, 5,
      ]);
      const naive = new Naive();
      const d = logUniform(rng, 0.01, 10);
      pool.apply(second, num(d), dieAt, dieAt + 200.5);
      naive.apply(d, dieAt, dieAt + 200.5, 1);
      for (let k = Math.floor(dieAt / W) + 1; k <= (pool.last[second] as number); k++) {
        expectClose(toNumber(pool.step(second, k)), naive.step(k), naive.scale(k), `step ${k}`);
      }
    }
  });

  it('grows past its capacity, keeping the rings in use', () => {
    const pool = new RingPool(2);
    const rings = Array.from({ length: 9 }, (_, i) => {
      const r = pool.alloc(0, i);
      pool.apply(r, num(i + 1), 1, 31);
      return r;
    });
    expect(pool.live).toBe(9);
    rings.forEach((r, i) => {
      expect(pool.credit[r]).toBe(i);
      expect(toNumber(pool.step(r, 1))).toBeCloseTo((i + 1) * 14 * DT, 12);
    });
  });

  it('does the same work per step and per application for 5 and 500 stacks', () => {
    const ops = (stacks: number): number[] => {
      const pool = new RingPool();
      const r = pool.alloc(0, 0);
      const counts: number[] = [];
      for (let now = 1; now <= 300; now++) {
        const before = pool.ops;
        // The same number of applications; only the stacks each one adds differ.
        if (now % 48 === 0) pool.apply(r, num(1), now, now + 240, stacks / 5);
        if (now % W === 0) pool.step(r, now / W);
        counts.push(pool.ops - before);
      }
      expect(pool.stacks[r]).toBe(stacks);
      return counts;
    };
    expect(ops(500)).toEqual(ops(5));
  });
});
