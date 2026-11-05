/**
 * E11, a groundZone effect's own zone cap (GroundZoneSpec.maxLive; the gap map's E11, lead
 * rulings Z1-Z7): its schema and validation, the pool's counters (ZonePool.effectCap, perEffect,
 * capEffect) through spawns, evictions and expiry beside the source cap and the pool's 64, the
 * executor's key, a module's out-of-range cap, and a seeded run's determinism.
 */

import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../../data/enemies';
import { parseGameData } from '../../data/index';
import { EffectSpecSchema } from '../../data/schema';
import { TALENTS } from '../../data/talents';
import type { EffectSpec, GroundZoneSpec, TriggerSpec } from '../../data/triggers';
import type { GameData, TalentNode } from '../../data/types';
import { validateGameData } from '../../data/validate';
import { WAVES } from '../../data/waves';
import { PayloadEffectSchema } from '../../data/web/schema';
import { compileBuild } from '../build/compile';
import { PULSE_TICKS, SIGNATURE_ZONE_CAP, ZONE_CAP, ZONE_SOURCE_CAP } from '../caps';
import { createEffectEntry } from '../effects/queue';
import { runEffect } from '../effects/execute';
import { SHATTER_TRIGGER } from '../effects/types';
import type { CompiledTrigger } from '../effects/types';
import type { Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData, maskProbeMods, placedEnemies } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import type { RunContext } from './context';
import { createZonePool } from './systemState';
import type { ZonePool } from './systemState';
import { addZone, stepZones } from './zones';

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

/** Where the zones of these tests stand: 300 right of the player. */
const Z = { x: ARENA_WIDTH / 2 + 300, y: ARENA_HEIGHT / 2 };

/** A zone of radius 50 for 1 s that hits for 100% of the damage stat a second. */
const ZONE: GroundZoneSpec = { kind: 'groundZone', radius: 50, durationSec: 1, damagePctPerSec: 1 };

/** A trigger that never fires in these tests, so its effects run only when a test runs them. */
const idle = (...effects: TriggerSpec['do']): TriggerSpec => ({
  on: 'periodic',
  every: 1000,
  do: effects,
});

/**
 * An empty arena whose data triggers are `triggers` ([source, effects] each, every effect a
 * groundZone), and a function adding zones of the n-th effect in trigger order, as addZone's
 * caller would, at the source its trigger credits; each zone pulses `pulses` times.
 */
function pool(triggers: readonly (readonly [string, readonly GroundZoneSpec[]])[]) {
  const ctx = placedEnemies([], {
    stats: makeStats({ damage: 400 }, [], {
      triggers: triggers.map(([source, effects]) => ({ source, spec: idle(...effects) })),
      conversions: [],
      emitters: [],
    }),
  });
  const effects: number[] = [];
  triggers.forEach(([, specs], k) => {
    const start = (ctx.build.triggers[FIRST + k] as CompiledTrigger).effectStart;
    specs.forEach((_spec, n) => effects.push(start + n));
  });
  const zones = ctx.sys.zones;
  /** Adds a zone of effect `n` (trigger order); returns its id. */
  const add = (n: number, pulses = 8): number => {
    const effect = effects[n] as number;
    const fx = ctx.build.effects[effect];
    const p = ctx.effectPayloads[effect] as Payload;
    addZone(ctx, false, Z.x, Z.y, 50, pulses, p, 0.25, fx?.source ?? 0, effect, 0, -1);
    expect(ctx.state.zoneCount).toBe(zones.count);
    return zones.nextId;
  };
  /** Adds a signature zone; returns its id. */
  const addSignature = (): number => {
    const p = ctx.effectPayloads[effects[0] as number] as Payload;
    addZone(ctx, true, Z.x, Z.y, 50, 8, p, 0.25, p.source, -1, 0, -1);
    return zones.nextId;
  };
  const live = (): number[] => Array.from(zones.id.subarray(0, zones.count));
  const evicted = (): number[] =>
    ctx.events.flatMap((event) => (event.type === 'zoneEnd' && event.evicted ? [event.id] : []));
  const expired = (): number[] =>
    ctx.events.flatMap((event) => (event.type === 'zoneEnd' && !event.evicted ? [event.id] : []));
  const sourceOf = (n: number): number => ctx.build.effects[effects[n] as number]?.source ?? -1;
  return { ctx, zones, effects, add, addSignature, live, evicted, expired, sourceOf };
}

/** The next tick of `ctx`, its zone stage alone. */
function tick(ctx: RunContext): void {
  ctx.now = ++ctx.state.tick;
  stepZones(ctx);
}

/**
 * The pool's counters against its zones: each source's perSource the zones of it no own cap
 * counts, each effect's perEffect the zones its own cap counts, at most that cap, live the
 * effect zones and liveSignature the signature zones; every record's mark −1 or an effect with
 * a cap.
 */
function checkCounts(z: ZonePool, sources: readonly number[]): void {
  const perEffect = new Map<number, number>();
  const perSource = new Map<number, number>();
  let live = 0;
  let signature = 0;
  for (let s = 0; s < z.count; s++) {
    const r = z.record[s] as number;
    if (z.signature[s] === 1) {
      signature++;
      continue;
    }
    live++;
    const f = z.capEffect[r] as number;
    if (f < 0)
      perSource.set(z.source[r] as number, (perSource.get(z.source[r] as number) ?? 0) + 1);
    else {
      expect(z.effectCap[f], `effect ${f}'s cap`).toBeGreaterThan(0);
      perEffect.set(f, (perEffect.get(f) ?? 0) + 1);
    }
  }
  expect([z.live, z.liveSignature]).toEqual([live, signature]);
  for (const source of sources)
    expect(z.perSource[source], `source ${source}`).toBe(perSource.get(source) ?? 0);
  for (let f = 0; f < z.perEffect.length; f++) {
    expect(z.perEffect[f], `effect ${f}`).toBe(perEffect.get(f) ?? 0);
    expect(z.perEffect[f] as number).toBeLessThanOrEqual(Math.max(z.effectCap[f] as number, 0));
  }
}

describe('a groundZone’s maxLive in the data (Z1)', () => {
  const content = (): Mutable<GameData> =>
    structuredClone({ enemies: ENEMIES, waves: WAVES, talents: TALENTS }) as Mutable<GameData>;
  const vitality = (data: Mutable<GameData>): Mutable<TalentNode> =>
    data.talents.find((n) => n.id === 'vitality') as Mutable<TalentNode>;
  /** Issues of the real content with a freeze trigger of `zone` on 'vitality'. */
  const issuesOf = (zone: EffectSpec): string[] => {
    const data = content();
    const node = vitality(data);
    node.triggers.push({ on: 'freeze', do: [zone] } as Mutable<TriggerSpec>);
    node.descKey = 'talent.vitality.desc';
    return validateGameData(data);
  };
  /** 凍土's zone (gd:104) with `maxLive`, unchecked, as data that skipped the schema. */
  const frozenGround = (maxLive: unknown): EffectSpec =>
    ({
      kind: 'groundZone',
      radius: 60,
      durationSec: 2,
      damagePctPerSec: 0,
      addFrostPerSec: 0.2,
      maxLive,
    }) as unknown as EffectSpec;
  const at = "talent 'vitality': triggers[0] do[0]";

  it('takes maxLive in both schemas, and only as a number that is there', () => {
    const zone = frozenGround(4);
    expect(EffectSpecSchema.parse(zone)).toEqual(zone);
    expect(PayloadEffectSchema.parse(zone)).toEqual(zone);
    expect(EffectSpecSchema.safeParse(frozenGround('4')).success).toBe(false);
    expect(EffectSpecSchema.safeParse(frozenGround(undefined)).success).toBe(false);
    expect(EffectSpecSchema.parse({ ...ZONE })).toEqual(ZONE);
  });

  it.each([1, 8, ZONE_SOURCE_CAP])('accepts maxLive %i', (maxLive) => {
    expect(issuesOf(frozenGround(maxLive))).toEqual([]);
  });

  it.each([0, -1, 2.5, ZONE_SOURCE_CAP + 1, NaN, Infinity])('refuses maxLive %s', (maxLive) => {
    expect(issuesOf(frozenGround(maxLive))).toEqual([
      `${at} maxLive must be an integer in [1, ${ZONE_SOURCE_CAP}] (got ${maxLive})`,
    ]);
  });

  it('refuses maxLive 0 through parseGameData too', () => {
    const data = content();
    vitality(data).triggers.push({
      on: 'freeze',
      do: [frozenGround(0)],
    } as Mutable<TriggerSpec>);
    vitality(data).descKey = 'talent.vitality.desc';
    expect(() => parseGameData(data)).toThrow('maxLive must be an integer in [1, 16] (got 0)');
  });
});

describe('the pool’s own caps (Z1, Z6)', () => {
  it('folds each groundZone’s maxLive by effect index, 0 for every other effect', () => {
    const { zones, effects } = pool([
      ['center', [ZONE, { ...ZONE, maxLive: 3 }]],
      ['outer.ice', [{ ...ZONE, maxLive: ZONE_SOURCE_CAP }, ZONE]],
    ]);
    expect(Array.from(zones.effectCap)).toHaveLength(zones.perEffect.length);
    expect(effects.map((f) => zones.effectCap[f])).toEqual([0, 3, ZONE_SOURCE_CAP, 0]);
    expect(Array.from(zones.perEffect).every((n) => n === 0)).toBe(true);
  });

  it('gives a build without maxLive no own cap, and every zone the source’s counter', () => {
    const { zones, add, addSignature, sourceOf } = pool([['center', [ZONE, ZONE]]]);
    for (let n = 0; n < 20; n++) add(n % 2);
    addSignature();
    expect(Array.from(zones.effectCap).every((n) => n === 0)).toBe(true);
    expect(Array.from(zones.perEffect).every((n) => n === 0)).toBe(true);
    for (let s = 0; s < zones.count; s++)
      expect(zones.capEffect[zones.record[s] as number]).toBe(-1);
    expect(zones.perSource[sourceOf(0)]).toBe(ZONE_SOURCE_CAP);
    checkCounts(zones, [sourceOf(0)]);
  });

  it.each([0, -2, 1.5, ZONE_SOURCE_CAP + 1, NaN])(
    'throws on a module’s groundZone with maxLive %s, which no validation saw',
    (maxLive) => {
      const module: TestModule = (b) => void b.addEffect('center', { ...ZONE, maxLive });
      const build = compileBuild(makeStats(), [], undefined, [module]);
      expect(() => createZonePool(build)).toThrow(
        `groundZone effect ${build.effects.length - 1}: maxLive must be an integer in [1, ` +
          `${ZONE_SOURCE_CAP}] (got ${maxLive})`,
      );
    },
  );

  it.each([1, ZONE_SOURCE_CAP])('takes a module’s groundZone with maxLive %i', (maxLive) => {
    const module: TestModule = (b) => void b.addEffect('center', { ...ZONE, maxLive });
    const build = compileBuild(makeStats(), [], undefined, [module]);
    expect(createZonePool(build).effectCap[build.effects.length - 1]).toBe(maxLive);
  });
});

describe('an effect’s own zone cap (Z2-Z4)', () => {
  it('evicts its own oldest at maxLive 3 when a 4th zone spawns, as an eviction', () => {
    const { ctx, zones, effects, add, live, evicted, sourceOf } = pool([
      ['center', [{ ...ZONE, maxLive: 3 }]],
    ]);
    const a = effects[0] as number;
    const ids = [add(0), add(0), add(0)];
    expect(evicted()).toEqual([]);
    expect([zones.perEffect[a], zones.perSource[sourceOf(0)], zones.live]).toEqual([3, 0, 3]);
    const freeBefore = zones.freeCount;
    const fourth = add(0);
    expect(evicted()).toEqual([ids[0]]);
    expect(ctx.counters.zonesEvicted).toBe(1);
    expect(live()).toEqual([ids[1], ids[2], fourth]);
    // The evicted zone's record is freed and taken again by the new zone (K5's path).
    expect(zones.freeCount).toBe(freeBefore);
    expect([zones.perEffect[a], zones.perSource[sourceOf(0)], zones.live]).toEqual([3, 0, 3]);
    const ends = ctx.events.filter((e) => e.type === 'zoneEnd');
    expect(ends).toEqual([{ type: 'zoneEnd', id: ids[0], evicted: true }]);
    // The eviction comes before the new zone's event.
    const types = ctx.events.map((e) => e.type);
    expect(types.indexOf('zoneEnd')).toBe(types.lastIndexOf('zone') - 1);
    const fifth = add(0);
    expect(evicted()).toEqual([ids[0], ids[1]]);
    expect(live()).toEqual([ids[2], fourth, fifth]);
    expect(ctx.counters.zonesEvicted).toBe(2);
    checkCounts(zones, [sourceOf(0)]);
  });

  it('keeps one zone at maxLive 1, each spawn evicting the last', () => {
    const { ctx, zones, add, live, evicted } = pool([['center', [{ ...ZONE, maxLive: 1 }]]]);
    const ids = [add(0), add(0), add(0)];
    expect(evicted()).toEqual([ids[0], ids[1]]);
    expect(live()).toEqual([ids[2]]);
    expect(ctx.counters.zonesEvicted).toBe(2);
    checkCounts(zones, [0]);
  });

  it.each(['own first', 'source first'] as const)(
    'keeps A (maxLive 4) and B (none) of one source apart, B at 16, %s',
    (order) => {
      const { ctx, zones, effects, add, live, evicted, sourceOf } = pool([
        ['center', [{ ...ZONE, maxLive: 4 }, ZONE]],
      ]);
      const [a, b] = effects as [number, number];
      const source = sourceOf(0);
      expect(sourceOf(1)).toBe(source);
      const fill = (n: number, k: number): number[] => Array.from({ length: k }, () => add(n));
      const own = order === 'own first' ? fill(0, 4) : [];
      const theirs = fill(1, ZONE_SOURCE_CAP);
      if (order === 'source first') own.push(...fill(0, 4));
      expect(evicted()).toEqual([]);
      // A never counts in perSource: B alone holds the source's 16.
      expect([zones.perSource[source], zones.perEffect[a], zones.perEffect[b]]).toEqual([
        ZONE_SOURCE_CAP,
        4,
        0,
      ]);
      // A's spawns evict A's oldest, never B's, whichever is older.
      const a5 = add(0);
      const a6 = add(0);
      expect(evicted()).toEqual([own[0], own[1]]);
      // B's spawns evict B's oldest, never A's, whichever is older.
      const b17 = add(1);
      expect(evicted()).toEqual([own[0], own[1], theirs[0]]);
      expect(ctx.counters.zonesEvicted).toBe(3);
      expect([zones.perSource[source], zones.perEffect[a], zones.live]).toEqual([
        ZONE_SOURCE_CAP,
        4,
        ZONE_SOURCE_CAP + 4,
      ]);
      expect(new Set(live())).toEqual(new Set([...own.slice(2), a5, a6, ...theirs.slice(1), b17]));
      checkCounts(zones, [source]);
    },
  );

  it('counts two capped effects of one source apart, each by its own index', () => {
    const { ctx, zones, effects, add, live, evicted, sourceOf } = pool([
      [
        'center',
        [
          { ...ZONE, maxLive: 3 },
          { ...ZONE, maxLive: 2 },
        ],
      ],
    ]);
    const [a, c] = effects as [number, number];
    const aIds = [add(0), add(0), add(0)];
    const c1 = add(1);
    const c2 = add(1);
    expect(evicted()).toEqual([]);
    expect([zones.perEffect[a], zones.perEffect[c], zones.perSource[sourceOf(0)]]).toEqual([
      3, 2, 0,
    ]);
    const c3 = add(1);
    expect(evicted()).toEqual([c1]);
    const a4 = add(0);
    expect(evicted()).toEqual([c1, aIds[0]]);
    expect(live()).toEqual([aIds[1], aIds[2], c2, c3, a4]);
    expect(ctx.counters.zonesEvicted).toBe(2);
    checkCounts(zones, [sourceOf(0)]);
  });

  it('keeps a capped effect of one source out of another source’s cap', () => {
    const { zones, effects, add, evicted, sourceOf } = pool([
      ['center', [{ ...ZONE, maxLive: 2 }]],
      ['outer.ice', [ZONE]],
    ]);
    const a = effects[0] as number;
    const own = [add(0), add(0)];
    const theirs = Array.from({ length: ZONE_SOURCE_CAP }, () => add(1));
    add(1);
    expect(evicted()).toEqual([theirs[0]]);
    add(0);
    expect(evicted()).toEqual([theirs[0], own[0]]);
    expect([
      zones.perEffect[a],
      zones.perSource[sourceOf(0)],
      zones.perSource[sourceOf(1)],
    ]).toEqual([2, 0, ZONE_SOURCE_CAP]);
    checkCounts(zones, [sourceOf(0), sourceOf(1)]);
  });
});

describe('the pool’s 64 over own caps (Z3)', () => {
  /** A (maxLive 4) on center, and four other sources without a cap to fill the pool. */
  const full = () =>
    pool([
      ['center', [{ ...ZONE, maxLive: 4 }]],
      ['outer.fire', [ZONE]],
      ['outer.ice', [ZONE]],
      ['outer.poison', [ZONE]],
      ['outer.aura', [ZONE]],
    ]);

  it('evicts the global oldest, another source’s, when A spawns under its cap at 64', () => {
    const { ctx, zones, effects, add, live, evicted, sourceOf } = full();
    const a = effects[0] as number;
    const first = add(1);
    add(0);
    add(0);
    for (let n = 3; n < ZONE_CAP; n++) add(1 + (n % 4));
    expect(zones.live).toBe(ZONE_CAP);
    const id = add(0);
    expect(evicted()).toEqual([first]);
    expect(live()[0]).toBe(first + 1);
    expect(live().at(-1)).toBe(id);
    expect([zones.live, zones.perEffect[a]]).toEqual([ZONE_CAP, 3]);
    expect(ctx.counters.zonesEvicted).toBe(1);
    checkCounts(zones, [1, 2, 3, 4].map(sourceOf));
  });

  it('evicts A’s own zone when it is the global oldest, through the 64’s rule, and A’s count with it', () => {
    const { ctx, zones, effects, add, evicted, sourceOf } = full();
    const a = effects[0] as number;
    const first = add(0);
    add(0);
    for (let n = 2; n < ZONE_CAP; n++) add(1 + (n % 4));
    expect([zones.live, zones.perEffect[a]]).toEqual([ZONE_CAP, 2]);
    add(0);
    expect(evicted()).toEqual([first]);
    expect([zones.live, zones.perEffect[a]]).toEqual([ZONE_CAP, 2]);
    // Another source's spawn at 64 evicts A's oldest too when it is the pool's oldest.
    add(2);
    expect(evicted()).toEqual([first, first + 1]);
    expect([zones.live, zones.perEffect[a]]).toEqual([ZONE_CAP, 1]);
    expect(ctx.counters.zonesEvicted).toBe(2);
    checkCounts(zones, [1, 2, 3, 4].map(sourceOf));
  });

  it('evicts only A’s own oldest when A is at its cap and the pool at 64', () => {
    const { ctx, zones, effects, add, evicted, sourceOf } = full();
    const a = effects[0] as number;
    const others = [add(1), add(2)];
    const own = [add(0), add(0), add(0), add(0)];
    for (let n = 6; n < ZONE_CAP; n++) add(1 + (n % 4));
    expect([zones.live, zones.perEffect[a]]).toEqual([ZONE_CAP, 4]);
    add(0);
    expect(evicted()).toEqual([own[0]]);
    expect(evicted()).not.toContain(others[0]);
    expect([zones.live, zones.perEffect[a]]).toEqual([ZONE_CAP, 4]);
    expect(ctx.counters.zonesEvicted).toBe(1);
    checkCounts(zones, [1, 2, 3, 4].map(sourceOf));
  });

  it('keeps the signature zones apart from A’s cap and the effect zones’ 64 (Z5)', () => {
    const { ctx, zones, effects, add, addSignature, evicted, sourceOf } = full();
    const a = effects[0] as number;
    const signature = Array.from({ length: SIGNATURE_ZONE_CAP }, () => addSignature());
    const own = [add(0), add(0), add(0), add(0)];
    add(0);
    expect(evicted()).toEqual([own[0]]);
    addSignature();
    expect(evicted()).toEqual([own[0], signature[0]]);
    expect([zones.liveSignature, zones.perEffect[a], zones.live]).toEqual([
      SIGNATURE_ZONE_CAP,
      4,
      4,
    ]);
    expect(ctx.counters.zonesEvicted).toBe(2);
    checkCounts(zones, [1, 2, 3, 4].map(sourceOf));
  });
});

describe('ends take a zone out of its own counter (Z6)', () => {
  it('expires A’s zones, one evicted at its cap, from A’s count and B’s from the source’s', () => {
    const { ctx, zones, effects, add, expired, evicted, sourceOf } = pool([
      ['center', [{ ...ZONE, maxLive: 3 }, ZONE]],
    ]);
    const [a] = effects as [number];
    const source = sourceOf(0);
    // B's zones pulse 8 times, A's 2: A's end first.
    const b = [add(1, 8), add(1, 8)];
    const own = [add(0, 2), add(0, 2), add(0, 2), add(0, 2)];
    expect(evicted()).toEqual([own[0]]);
    expect([zones.perEffect[a], zones.perSource[source]]).toEqual([3, 2]);
    ctx.events.length = 0;
    for (let n = 0; n < 2 * PULSE_TICKS; n++) {
      tick(ctx);
      checkCounts(zones, [source]);
    }
    expect(expired()).toEqual(own.slice(1));
    expect([zones.perEffect[a], zones.perSource[source], zones.live]).toEqual([0, 2, 2]);
    // A's count is free again: three more spawn without an eviction.
    ctx.events.length = 0;
    add(0, 2);
    add(0, 2);
    add(0, 2);
    expect(evicted()).toEqual([]);
    for (let n = 0; n < 8 * PULSE_TICKS; n++) {
      tick(ctx);
      checkCounts(zones, [source]);
    }
    expect(expired()).toEqual(expect.arrayContaining(b));
    expect([zones.count, zones.live, zones.perEffect[a], zones.perSource[source]]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(zones.freeCount).toBe(ZONE_CAP + SIGNATURE_ZONE_CAP);
  });

  it('expires B’s zones from the source’s count, leaving A’s alone', () => {
    const { ctx, zones, effects, add, sourceOf } = pool([
      ['center', [{ ...ZONE, maxLive: 3 }, ZONE]],
    ]);
    const [a] = effects as [number];
    const source = sourceOf(0);
    for (let n = 0; n < 5; n++) add(1, 2);
    for (let n = 0; n < 3; n++) add(0, 8);
    for (let n = 0; n < 3 * PULSE_TICKS; n++) tick(ctx);
    expect([zones.perEffect[a], zones.perSource[source], zones.live]).toEqual([3, 0, 3]);
    checkCounts(zones, [source]);
  });
});

describe('the executor keys a zone by its compiled effect (Z2)', () => {
  it('runs a capped groundZone through runEffect, counted under the entry’s effect', () => {
    const { ctx, zones, effects, live, evicted, sourceOf } = pool([
      ['center', [ZONE, { ...ZONE, maxLive: 2 }]],
    ]);
    const [b, a] = effects as [number, number];
    const run = (effect: number): number => {
      const entry = createEffectEntry();
      entry.effect = effect;
      entry.depth = 0;
      entry.origin = -1;
      entry.source = ctx.build.effects[effect]?.source ?? 0;
      entry.x = Z.x;
      entry.y = Z.y;
      runEffect(ctx, entry);
      return zones.nextId;
    };
    const ids = [run(a), run(a), run(b), run(a)];
    expect(evicted()).toEqual([ids[0]]);
    expect(live()).toEqual([ids[1], ids[2], ids[3]]);
    expect([zones.perEffect[a], zones.perEffect[b], zones.perSource[sourceOf(0)]]).toEqual([
      2, 0, 1,
    ]);
    checkCounts(zones, [sourceOf(0)]);
  });
});

/**
 * A seeded run of the M1 volley with frost on hit: each freeze drops a small zone of maxLive 4
 * (凍土's shape, gd:104) and every 0.25 s a large 5 s zone lands on the densest spot (暴風雪's,
 * gd:114, fast enough to fill the center's 16), both the center's.
 */
const RUN_STATS = makeStats(
  {
    damage: 6,
    maxLife: 1e6,
    critChance: 0.2,
    critMultiplier: 2,
    frostOnHit: 0.5,
    chainCount: 1,
    attackSpeed: 6,
    projectileCount: 2,
  },
  maskProbeMods(),
  {
    triggers: [
      {
        source: 'center',
        spec: {
          on: 'freeze',
          do: [
            {
              kind: 'groundZone',
              radius: 60,
              durationSec: 2,
              damagePctPerSec: 0,
              addFrostPerSec: 0.2,
              maxLive: 4,
            },
          ],
        },
      },
      {
        source: 'center',
        spec: {
          on: 'periodic',
          every: 0.25,
          target: { pick: 'densest' },
          do: [
            {
              kind: 'groundZone',
              radius: 200,
              durationSec: 5,
              damagePctPerSec: 0.6,
              addFrostPerSec: 0.4,
            },
          ],
        },
      },
    ],
    conversions: [],
    emitters: [],
  },
);

describe('a seeded run with an own cap', () => {
  /** Every tick's events of the run at `seed`, with the pool's counters checked each tick. */
  function run(seed: number): SimEvent[][] {
    const watched: { ctx: RunContext | null } = { ctx: null };
    const grab: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        watched.ctx = ctx;
      });
    const config = makeConfig({ stats: RUN_STATS, rules: [], startWave: 12, seed, maxTicks: 1200 });
    const sim = createSimulation(config, makeTestData(), [grab]);
    const ticks: SimEvent[][] = [];
    while (!sim.state.finished) {
      // step() reuses its array: keep a copy of each tick's.
      ticks.push(sim.step(NO_INPUT).slice());
      const ctx = watched.ctx as RunContext;
      checkCounts(ctx.sys.zones, [0]);
    }
    return ticks;
  }

  it('gives the same events twice at one seed, reaching both caps', () => {
    const first = run(1);
    expect(JSON.stringify(run(1))).toBe(JSON.stringify(first));
    // The radius of the zone each eviction made room for: the next event, the new zone's.
    const by = new Set<number>();
    for (const events of first) {
      events.forEach((e, i) => {
        const next = events[i + 1];
        if (e.type === 'zoneEnd' && e.evicted && next?.type === 'zone') by.add(next.radius);
      });
    }
    expect([...by].sort((x, y) => x - y)).toEqual([60, 200]);
    expect(JSON.stringify(run(2))).not.toBe(JSON.stringify(first));
  });
});
