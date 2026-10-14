/**
 * GOLDEN-C4: fixture runs of the C4 mechanics (docs/v3 C4 design §0.3, §9), each for 1,200
 * ticks at seeds 1 and 2, hashed whole: every tick's events as they are (no projection to M1
 * keys, unlike src/sim/golden.test.ts), then the result's M1 fields (projectResult), its damage
 * per source and its counters that are not 0, in COUNTER_IDS order. A counter appended later is
 * 0 in every run that came before it, so it moves no recorded hash. Each case runs twice and
 * must hash the same both times.
 *
 * A commit that lands a mechanic appends its entries with the hashes recorded at that commit.
 * A later commit leaves every recorded hash alone, unless its message names the entries it
 * re-records and why.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mul, num } from '../core/num';
import type { Modifier } from '../data/stats';
import { TAG } from '../data/tags';
import type { TriggerSpec } from '../data/triggers';
import type { GameData } from '../data/types';
import { SMALL_PROJECTILE_TICKS } from './caps';
import { createPayload, ROWS } from './emitters/types';
import type { Payload } from './emitters/types';
import type { BuildCompiler, TestModule } from './rules';
import { createSimulation } from './simulation';
import { MOTION_HOMING, MOTION_LOB, MOTION_STRAIGHT, spawnShot } from './systems/shots';
import {
  GOLDEN_BUILDS,
  makeConfig,
  makeStats,
  makeTestData,
  maskProbeMods,
  projectResult,
} from './testing';
import { COUNTER_IDS, NO_INPUT } from './types';
import type { CounterId, RunConfig } from './types';

const GOLDEN_C4_TICKS = 1200;
const GOLDEN_C4_SEEDS = [1, 2] as const;

interface GoldenC4Entry {
  /** The entry's name; its cases are '<name>/s1' and '<name>/s2'. */
  readonly name: string;
  /** The run's config but its seed and length; makeConfig's defaults for the rest. */
  readonly config: Partial<RunConfig>;
  /** The run's data; makeTestData() when omitted. */
  readonly data?: () => GameData;
  /** createSimulation's test modules. */
  readonly modules?: () => readonly TestModule[];
  /** The hash recorded for each seed of GOLDEN_C4_SEEDS, in order. */
  readonly expected: readonly [string, string];
}

/**
 * C4.2's shot pool beside the volley: every 15 ticks, a ring of six straight shots from the
 * player (pierce 1 to 6 or without limit, bounces, one wide shot), a homing shot (steady every
 * fourth round) and a lob landing 24 ticks later, all on one payload credited to
 * outer.barrage.
 */
function shotsModule(): TestModule {
  let payload: Payload | null = null;
  const module = (b: BuildCompiler, source: number): void => {
    b.hook('tick', (ctx) => {
      if (ctx.now % 15 !== 0) return;
      payload ??= createPayload({
        baseDamage: mul(num(ctx.build.values.damage), 0.4),
        tags: TAG.hit | TAG.projectile,
        source,
        flags: 0,
        rng: ctx.effectsRng,
        chains: false,
        rollsAilments: true,
        canCrit: true,
        damageMode: ROWS,
      });
      const round = ctx.now / 15;
      const until = ctx.now + SMALL_PROJECTILE_TICKS;
      const { x, y } = ctx.player;
      for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI) / 3 + round * 0.37;
        const pierce = i === 0 ? -1 : i;
        const vx = 16 * Math.cos(angle);
        const vy = 16 * Math.sin(angle);
        const s = spawnShot(
          ctx,
          MOTION_STRAIGHT,
          x,
          y,
          vx,
          vy,
          until,
          payload,
          0.5,
          pierce,
          i % 3,
          0,
          -1,
          false,
          -1,
          -1,
          null,
        );
        if (s >= 0 && i === 3) ctx.shots.radius[s] = 14;
      }
      const steady = round % 4 === 0;
      spawnShot(
        ctx,
        MOTION_HOMING,
        x,
        y,
        0,
        0,
        until,
        payload,
        1,
        1,
        0,
        0,
        -1,
        steady,
        -1,
        -1,
        null,
      );
      const angle = round * 0.9;
      const lx = x + 300 * Math.cos(angle);
      const ly = y + 300 * Math.sin(angle);
      spawnShot(
        ctx,
        MOTION_LOB,
        lx,
        ly,
        x,
        y,
        ctx.now + 24,
        payload,
        1,
        1,
        0,
        0,
        -1,
        false,
        -1,
        -1,
        null,
      );
    });
  };
  return Object.assign(module, { source: 'outer.barrage' });
}

/**
 * C4.3's thorns: outer.thorns grants thorns at the default 300% and the center at 100%, each
 * contact raises a thorns nova at the toucher, and thorns damage is doubled by a thorns-scoped
 * more. The volley is too weak to clear wave 12, so some touchers die to the thorns (pentagons
 * among them, whose shards touch from the next tick) and others leak.
 */
const THORNS_NOVA: TriggerSpec = {
  on: 'contact',
  do: [{ kind: 'nova', radius: 120, damagePct: 1.5, tags: ['thorns'], at: 'event' }],
};
const THORNS_MORE: Modifier = { stat: 'damage', kind: 'more', value: 1, tags: ['thorns'] };
const THORNS_STATS = makeStats(
  { damage: 5, maxLife: 1e6, critChance: 0.2, critMultiplier: 2, igniteChance: 0.3 },
  [...maskProbeMods(), THORNS_MORE],
  {
    triggers: [{ source: 'center', spec: THORNS_NOVA }],
    conversions: [],
    emitters: [
      { source: 'outer.thorns', grant: { kind: 'thorns' } },
      { source: 'center', grant: { kind: 'thorns', damagePct: 1 } },
    ],
  },
);

/** The entries, in the order their commits appended them. */
const ENTRIES: readonly GoldenC4Entry[] = [
  {
    name: 'shots/testModule',
    config: { ...GOLDEN_BUILDS.bridges, startWave: 8 },
    modules: () => [shotsModule()],
    expected: ['d32decc45c4cb5c1', 'a3baa3324af324b2'],
  },
  {
    name: 'thorns',
    config: { stats: THORNS_STATS, rules: [], startWave: 12 },
    expected: ['9a4af4a9ea58986a', 'be2d89ddac3465ef'],
  },
];

/** [id, value] of each counter that is not 0, in COUNTER_IDS order. */
function nonzeroCounters(counters: Readonly<Record<CounterId, number>>): [CounterId, number][] {
  return COUNTER_IDS.filter((id) => counters[id] !== 0).map((id) => [id, counters[id]]);
}

/**
 * The first 16 hex digits of the SHA-256 of every tick's events, whole, then the result's M1
 * fields, damage per source and nonzero counters.
 */
function goldenC4Hash(
  config: RunConfig,
  data: GameData,
  modules: readonly TestModule[] = [],
): string {
  const sim = createSimulation(config, data, modules);
  const hash = createHash('sha256');
  while (!sim.state.finished) hash.update(JSON.stringify(sim.step(NO_INPUT)));
  const result = sim.result();
  hash.update(
    JSON.stringify([
      projectResult(result),
      result.damageBySource,
      nonzeroCounters(result.counters),
    ]),
  );
  return hash.digest('hex').slice(0, 16);
}

/** One entry at one seed, hashed twice. */
function runCase(entry: GoldenC4Entry, seed: number): [string, string] {
  const config = makeConfig({ ...entry.config, seed, maxTicks: GOLDEN_C4_TICKS });
  const once = (): string =>
    goldenC4Hash(config, entry.data?.() ?? makeTestData(), entry.modules?.() ?? []);
  return [once(), once()];
}

describe('golden C4 runner', () => {
  it('lists the counters that are not 0, in COUNTER_IDS order', () => {
    const counters = Object.fromEntries(COUNTER_IDS.map((id) => [id, 0])) as Record<
      CounterId,
      number
    >;
    expect(nonzeroCounters(counters)).toEqual([]);
    const [first, second] = COUNTER_IDS;
    const last = COUNTER_IDS.at(-1) as CounterId;
    counters[last] = 2;
    counters[first] = 7;
    expect(nonzeroCounters(counters)).toEqual([
      [first, 7],
      [last, 2],
    ]);
    counters[second] = -1;
    expect(nonzeroCounters(counters)).toEqual([
      [first, 7],
      [second, -1],
      [last, 2],
    ]);
  });

  it('hashes a run the same twice, and another seed or build differently', () => {
    const data = makeTestData();
    const hashOf = (build: keyof typeof GOLDEN_BUILDS, seed: number): string =>
      goldenC4Hash(
        makeConfig({ ...GOLDEN_BUILDS[build], seed, startWave: 8, maxTicks: GOLDEN_C4_TICKS }),
        data,
      );
    const chain = hashOf('chain', 1);
    expect(chain).toMatch(/^[0-9a-f]{16}$/);
    expect(hashOf('chain', 1)).toBe(chain);
    expect(hashOf('chain', 2)).not.toBe(chain);
    expect(hashOf('pandemic', 1)).not.toBe(chain);
  });
});

describe('golden C4 runs', () => {
  const cases = ENTRIES.flatMap((entry) =>
    GOLDEN_C4_SEEDS.map((seed, i) => ({
      id: `${entry.name}/s${seed}`,
      entry,
      seed,
      expected: entry.expected[i] as string,
    })),
  );

  it('names every entry once and records a hash per seed', () => {
    const names = ENTRIES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const { id, expected } of cases) expect(expected, id).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each(cases)('$id', ({ entry, seed, expected }) => {
    const [first, second] = runCase(entry, seed);
    expect(second, 'the second run of the same case').toBe(first);
    expect(first).toBe(expected);
  });
});
