import { describe, expect, it } from 'vitest';
import { type Rng, RNG_STREAMS, createRng, createStreams, deriveSeed } from './rng';

const draw = (rng: Rng, count: number): number[] => Array.from({ length: count }, () => rng.next());

describe('createRng', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(draw(a, 1000)).toEqual(draw(b, 1000));
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it('keeps the same sequence for a given seed within a build (golden values)', () => {
    const rng = createRng(12345);
    expect(rng.snapshot()).toEqual([194968149, 4048065787, 4205630669, 2397394848]);
    expect(draw(rng, 3)).toEqual([0.5460953079164028, 0.3131258205976337, 0.6926104435697198]);
  });

  it('gives different sequences for different seeds', () => {
    expect(draw(createRng(1), 10)).not.toEqual(draw(createRng(2), 10));
  });

  it('diverges immediately for nearby seeds', () => {
    const firsts = new Set<number>();
    for (let seed = 0; seed < 1000; seed++) firsts.add(createRng(seed).next());
    expect(firsts.size).toBe(1000);
  });

  it('treats seeds as unsigned 32-bit integers', () => {
    expect(draw(createRng(-1), 5)).toEqual(draw(createRng(0xffffffff), 5));
  });

  it('next() stays in [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 100_000; i++) {
      const value = rng.next();
      expect(value >= 0 && value < 1).toBe(true);
    }
  });

  it('int() stays in range and covers every value', () => {
    const rng = createRng(99);
    for (const maxExclusive of [1, 2, 6, 37]) {
      const seen = new Set<number>();
      for (let i = 0; i < 100 * maxExclusive; i++) {
        const value = rng.int(maxExclusive);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(maxExclusive);
        seen.add(value);
      }
      expect(seen.size).toBe(maxExclusive);
    }
  });

  it('range() stays in [min, max)', () => {
    const rng = createRng(5);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.range(-5, 5);
      expect(value).toBeGreaterThanOrEqual(-5);
      expect(value).toBeLessThan(5);
    }
    expect(rng.range(2, 2)).toBe(2);
  });

  it('range() follows next() linearly', () => {
    const a = createRng(11);
    const b = createRng(11);
    for (let i = 0; i < 100; i++) expect(a.range(10, 20)).toBe(10 + b.next() * 10);
  });

  it('chance() is never true at p <= 0 and always true at p >= 1', () => {
    const rng = createRng(3);
    for (let i = 0; i < 1000; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(-0.5)).toBe(false);
      expect(rng.chance(1)).toBe(true);
      expect(rng.chance(1.5)).toBe(true);
    }
  });

  it('chance() hits about p of the time', () => {
    const rng = createRng(21);
    let hits = 0;
    for (let i = 0; i < 10_000; i++) if (rng.chance(0.3)) hits++;
    expect(hits / 10_000).toBeGreaterThan(0.28);
    expect(hits / 10_000).toBeLessThan(0.32);
  });

  it('pick() returns every item eventually and throws on an empty list', () => {
    const rng = createRng(8);
    const items = ['a', 'b', 'c', 'd'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const item = rng.pick(items);
      expect(items).toContain(item);
      seen.add(item);
    }
    expect(seen.size).toBe(items.length);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it.each([1, 2, 3, 42, 0xdeadbeef])('is roughly uniform for seed %s', (seed) => {
    const rng = createRng(seed);
    const draws = 10_000;
    const buckets = new Array<number>(10).fill(0);
    let sum = 0;
    for (let i = 0; i < draws; i++) {
      const value = rng.next();
      sum += value;
      const bucket = Math.floor(value * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    expect(Math.abs(sum / draws - 0.5)).toBeLessThan(0.02);
    for (const count of buckets) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });
});

describe('deriveSeed', () => {
  it('is stable (golden values)', () => {
    expect(deriveSeed(0, 'spawn')).toBe(975326616);
    expect(deriveSeed(0, 'combat')).toBe(484666913);
    expect(deriveSeed(0, 'drops')).toBe(245270637);
    expect(deriveSeed(12345, 'spawn')).toBe(2828220051);
    expect(deriveSeed(0xdeadbeef, 'drops')).toBe(2823136276);
  });

  it('gives a different seed per stream', () => {
    for (const seed of [0, 1, 12345, 0xdeadbeef]) {
      const derived = new Set(RNG_STREAMS.map((stream) => deriveSeed(seed, stream)));
      expect(derived.size).toBe(RNG_STREAMS.length);
    }
  });

  it('gives a different seed per run seed', () => {
    const derived = new Set<number>();
    for (let seed = 0; seed < 1000; seed++) derived.add(deriveSeed(seed, 'spawn'));
    expect(derived.size).toBe(1000);
  });

  it('returns unsigned 32-bit integers', () => {
    for (const seed of [0, 1, -1, 0xffffffff, 2 ** 31]) {
      for (const stream of RNG_STREAMS) {
        const value = deriveSeed(seed, stream);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(2 ** 32);
      }
    }
  });
});

describe('createStreams', () => {
  it('has one stream per name, seeded through deriveSeed', () => {
    const streams = createStreams(777);
    expect(Object.keys(streams).sort()).toEqual([...RNG_STREAMS].sort());
    for (const name of RNG_STREAMS) {
      expect(draw(streams[name], 20)).toEqual(draw(createRng(deriveSeed(777, name)), 20));
    }
  });

  it('gives different sequences per stream', () => {
    const streams = createStreams(777);
    const firsts = RNG_STREAMS.map((name) => draw(streams[name], 5).join(','));
    expect(new Set(firsts).size).toBe(RNG_STREAMS.length);
  });

  it('keeps streams independent of how much the others consume', () => {
    const busy = createStreams(2026);
    const idle = createStreams(2026);
    draw(busy.drops, 500);
    draw(busy.combat, 123);
    expect(draw(busy.spawn, 50)).toEqual(draw(idle.spawn, 50));
    expect(draw(busy.combat, 50)).toEqual(draw(createStreams(2026).combat, 173).slice(123));
    expect(draw(busy.drops, 50)).toEqual(draw(createStreams(2026).drops, 550).slice(500));
  });

  it('is deterministic per seed', () => {
    const a = createStreams(5);
    const b = createStreams(5);
    for (const name of RNG_STREAMS) expect(draw(a[name], 100)).toEqual(draw(b[name], 100));
    expect(draw(createStreams(5).spawn, 10)).not.toEqual(draw(createStreams(6).spawn, 10));
  });
});
