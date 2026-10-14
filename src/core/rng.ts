/**
 * Seeded, deterministic random numbers (sfc32 seeded through splitmix32).
 *
 * Each subsystem gets its own stream derived from the run seed, so changing how drops
 * consume randomness does not shift spawn or combat rolls (docs/ARCHITECTURE.md §4.2).
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** True with probability p (p <= 0 never, p >= 1 always). */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Snapshot of the internal state, for tests and debugging. */
  snapshot(): readonly [number, number, number, number];
}

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export function createRng(seed: number): Rng {
  const init = splitmix32(seed);
  let a = init();
  let b = init();
  let c = init();
  let d = init();

  const nextU32 = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };

  // Discard the first outputs so nearby seeds diverge quickly.
  for (let i = 0; i < 12; i++) nextU32();

  const next = (): number => nextU32() / 4294967296;

  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    range: (lo, hi) => lo + next() * (hi - lo),
    chance: (p) => (p <= 0 ? false : p >= 1 ? true : next() < p),
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError('pick() from an empty list');
      return items[Math.floor(next() * items.length)] as T;
    },
    snapshot: () => [a, b, c, d] as const,
  };
}

/** FNV-1a hash of the stream name mixed with the seed. */
export function deriveSeed(seed: number, stream: string): number {
  let hash = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < stream.length; i++) {
    hash ^= stream.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * `spawn`: wave shuffles and spawn positions. `split`: split children around their parent,
 * kept apart from `spawn` because how many split and when depends on combat. `combat`: hit
 * rolls. `drops`: drop rolls. `trigger`: trigger chance conditions, rolled when the event
 * happens. `effects`: rolls inside the hits of triggered effects. A build without triggers never
 * draws from the last two, so the other sequences do not depend on them.
 */
export const RNG_STREAMS = ['spawn', 'split', 'combat', 'drops', 'trigger', 'effects'] as const;
export type RngStreamName = (typeof RNG_STREAMS)[number];
export type RngStreams = Readonly<Record<RngStreamName, Rng>>;

export function createStreams(seed: number): RngStreams {
  return {
    spawn: createRng(deriveSeed(seed, 'spawn')),
    split: createRng(deriveSeed(seed, 'split')),
    combat: createRng(deriveSeed(seed, 'combat')),
    drops: createRng(deriveSeed(seed, 'drops')),
    trigger: createRng(deriveSeed(seed, 'trigger')),
    effects: createRng(deriveSeed(seed, 'effects')),
  };
}
