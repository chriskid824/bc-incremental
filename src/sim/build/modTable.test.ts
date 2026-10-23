import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import type { Rng } from '../../core/rng';
import { loadGameData } from '../../data';
import type { SourceSelector } from '../../data/sources';
import {
  BASE_STATS,
  isBehaviourModifier,
  isScopedStat,
  NO_EXTRAS,
  SCOPED_STATS,
  STAT_IDS,
} from '../../data/stats';
import type { Modifier, ModifierKind, ScopedStat, StatId } from '../../data/stats';
import { DAMAGE_TAGS, TAG, tagMask } from '../../data/tags';
import type { DamageTag } from '../../data/tags';
import { computeStatBlock } from '../../meta/stats';
import { BRIDGE_MODS, damageRow, makeStats, maskProbeMods, SEARING_CRITS_MODS } from '../testing';
import { statAt, staticInput } from './eval';
import { compileMods, ModTable, modTableFor, SCOPED_INDEX } from './modTable';
import { createSourceTable, rowKey, SOURCE_SHIFT } from './sources';
import type { SourceTable } from './sources';

const S = SCOPED_STATS.length;
const DAMAGE = SCOPED_INDEX.damage;
const M1_TAGS = ['hit', 'crit', 'burn', 'chain'] as const satisfies readonly DamageTag[];
const M1_MASKS = Array.from({ length: 16 }, (_, mask) => mask);
const KINDS: readonly ModifierKind[] = ['flat', 'increased', 'more'];
/** Stats M1 did not have: C3.3's *Always flags and C3.8's poison, bleed and shock. */
const POST_M1_STATS: ReadonlySet<StatId> = new Set<StatId>([
  'critAlways',
  'igniteAlways',
  'poisonChance',
  'poisonDamage',
  'poisonDuration',
  'bleedChance',
  'bleedDamage',
  'bleedDuration',
  'shockChance',
  'shockEffect',
  'shockMaxStacks',
  'shockDuration',
  'poisonAlways',
  'bleedAlways',
  'shockAlways',
  'bleedStationaryMult',
]);
const M1_STAT_IDS = STAT_IDS.filter((stat) => !POST_M1_STATS.has(stat));

/** Row base values: `damage` for damage, StatBlock.base for the other scoped stats. */
function baseRow(damage: number): Float64Array {
  const base = Float64Array.from(SCOPED_STATS, (stat) => BASE_STATS[stat]);
  base[DAMAGE] = damage;
  return base;
}

/**
 * M1's computeStatBlock (src/meta/stats.ts before C3), kept as the reference the damage rows
 * must reproduce bit for bit: damageMult[mask] for each of the 16 masks of M1's four tags.
 */
function m1ComputeStatBlock(modifiers: readonly Modifier[]): {
  values: Record<StatId, number>;
  damageMult: number[];
} {
  const DAMAGE_TAG_MASK_COUNT = 16;
  const acc = {} as Record<StatId, { flat: number; increased: number; more: number }>;
  for (const stat of STAT_IDS) acc[stat] = { flat: 0, increased: 0, more: 1 };
  const damageIncreased = new Array<number>(DAMAGE_TAG_MASK_COUNT).fill(0);
  const damageMore = new Array<number>(DAMAGE_TAG_MASK_COUNT).fill(1);

  for (const mod of modifiers) {
    const mask = mod.tags ? tagMask(mod.tags) : 0;
    const scaling = mod.stat === 'damage' && mod.kind !== 'flat';
    if (mask !== 0 && !scaling) {
      throw new Error(`Tags are only allowed on increased/more damage: ${JSON.stringify(mod)}`);
    }
    if (scaling) {
      for (let m = 0; m < DAMAGE_TAG_MASK_COUNT; m++) {
        if ((mask & m) !== mask) continue;
        if (mod.kind === 'increased') {
          damageIncreased[m] = (damageIncreased[m] as number) + mod.value;
        } else {
          damageMore[m] = (damageMore[m] as number) * (1 + mod.value);
        }
      }
      continue;
    }
    const a = acc[mod.stat];
    if (mod.kind === 'flat') a.flat += mod.value;
    else if (mod.kind === 'increased') a.increased += mod.value;
    else a.more *= 1 + mod.value;
  }

  const values = {} as Record<StatId, number>;
  for (const stat of STAT_IDS) {
    const a = acc[stat];
    values[stat] = (BASE_STATS[stat] + a.flat) * (1 + a.increased) * a.more;
  }
  const damageMult = damageIncreased.map((inc, m) => (1 + inc) * (damageMore[m] as number));
  return { values, damageMult };
}

/**
 * computeStatBlock and its damage rows equal M1's values and damageMult exactly. Behaviour
 * modifiers were rules in M1 (Searing Crits, the bridge notables): M1's values and damageMult
 * never saw them, and the only one on damage, Searing Crits' −50% on non-crit hits, was a
 * separate factor that the row now holds; ×0.5 is exact, so the row is damageMult × 0.5.
 */
function expectM1(modifiers: readonly Modifier[], label: string): void {
  const m1 = m1ComputeStatBlock(modifiers.filter((mod) => !isBehaviourModifier(mod)));
  const stats = computeStatBlock(modifiers, NO_EXTRAS);
  for (const stat of STAT_IDS) expect(stats.values[stat], `${label} ${stat}`).toBe(m1.values[stat]);
  const table = modTableFor(stats);
  const ruleFactor = (mask: number): number =>
    modifiers
      .filter((mod) => mod.stat === 'damage' && isBehaviourModifier(mod))
      .filter((mod) => (tagMask(mod.tags ?? []) & ~mask) === 0)
      .filter((mod) => (tagMask(mod.notTags ?? []) & mask) === 0)
      .reduce((product, mod) => product * (1 + mod.value), 1);
  for (const mask of M1_MASKS) {
    const expected = (m1.damageMult[mask] as number) * ruleFactor(mask);
    expect(damageRow(stats, mask), `${label} mask ${mask}`).toBe(expected);
    expect(table.damage(mask), `${label} mask ${mask}`).toBe(expected);
  }
  // The untagged base of a row is values.damage (base + Σflat), bit for bit.
  expect(table.flatV[table.row(0) * S + DAMAGE], label).toBe(stats.values.damage);
}

/** A random subset of `tags`, each with probability p. */
function someTags(rng: Rng, tags: readonly DamageTag[], p: number): DamageTag[] {
  return tags.filter(() => rng.chance(p));
}

/** A value with a few decimals (as content writes them) or an arbitrary one, in (−1, 3). */
function randomValue(rng: Rng): number {
  const value = rng.range(-0.95, 3);
  return rng.chance(0.5) ? Math.round(value * 100) / 100 : value;
}

/** A modifier M1 accepts: tags (M1's four) only on increased/more damage. */
function randomM1Modifier(rng: Rng): Modifier {
  const stat = rng.chance(0.6) ? 'damage' : rng.pick(M1_STAT_IDS);
  const kind = rng.pick(KINDS);
  const value = randomValue(rng);
  if (stat !== 'damage' || kind === 'flat') return { stat, kind, value };
  const tags = someTags(rng, M1_TAGS, 0.35);
  return tags.length === 0 ? { stat, kind, value } : { stat, kind, value, tags };
}

describe('damage rows against M1 damageMult', () => {
  it('match on the M1 talent web: everything, each node alone, random allocations', () => {
    const talents = loadGameData().talents;
    /** Every node's modifiers in data order, repeated per rank. */
    const modifiersOf = (ranks: readonly number[]): Modifier[] =>
      talents.flatMap((node, i) =>
        Array.from({ length: ranks[i] ?? 0 }, () => node.modifiers).flat(),
      );
    expectM1(modifiersOf(talents.map((node) => (node.kind === 'repeatable' ? 12 : 1))), 'all');
    talents.forEach((node, i) => {
      expectM1(modifiersOf(talents.map((_, j) => (j === i ? 1 : 0))), node.id);
    });
    const rng = createRng(7);
    for (let n = 0; n < 300; n++) {
      const ranks = talents.map((node) =>
        node.kind === 'repeatable' ? rng.int(20) : rng.chance(0.5) ? 1 : 0,
      );
      expectM1(modifiersOf(ranks), `allocation ${n}`);
    }
  });

  it('match on 2,000 random modifier lists', () => {
    const rng = createRng(11);
    for (let n = 0; n < 2000; n++) {
      const modifiers = Array.from({ length: rng.int(13) }, () => randomM1Modifier(rng));
      expectM1(modifiers, `list ${n}: ${JSON.stringify(modifiers)}`);
    }
  }, 30_000);
});

interface Reference {
  readonly final: number;
  readonly flat: number;
  readonly inc: number;
  readonly more: number;
}

/**
 * The ModTable formula of one scoped stat (damage by default), written out per key (tags, and
 * the source above them), without dynamic entries.
 */
function reference(
  modifiers: readonly Modifier[],
  base: number,
  key: number,
  sources: SourceTable = createSourceTable(),
  stat: ScopedStat = 'damage',
): Reference {
  const tags = key & ((1 << SOURCE_SHIFT) - 1);
  const source = key >>> SOURCE_SHIFT;
  const untagged = (m: Modifier): boolean =>
    (m.tags?.length ?? 0) === 0 && (m.notTags?.length ?? 0) === 0 && m.scope === undefined;
  const matching = modifiers.filter(
    (m) =>
      m.stat === stat &&
      m.scaling === undefined &&
      (tagMask(m.tags ?? []) & ~tags) === 0 &&
      (tagMask(m.notTags ?? []) & tags) === 0 &&
      (m.scope === undefined || sources.matches(m.scope, source)),
  );
  const of = (kind: ModifierKind): Modifier[] => matching.filter((m) => m.kind === kind);
  const untaggedFlat = of('flat')
    .filter(untagged)
    .reduce((sum, m) => sum + m.value, 0);
  const flat = of('flat')
    .filter((m) => !untagged(m))
    .reduce((sum, m) => sum + m.value, base + untaggedFlat);
  const inc = of('increased').reduce((sum, m) => sum + m.value, 0);
  const more = of('more').reduce((product, m) => product * (1 + m.value), 1);
  const final = stat === 'damage' ? (1 + inc) * more : flat * (1 + inc) * more;
  return { final, flat, inc, more };
}

/** Sources of the random keys; SELECTORS pick them by class and by exact id. */
const SOURCE_NAMES = ['center', 'outer.poison', 'fusion.fire.poison', 'hub', 'outer.fire', 'asc'];
const SELECTORS: readonly SourceSelector[] = [
  'center',
  'outer',
  'fusion',
  'hub',
  'asc',
  'outer.poison',
  'outer.greed',
  'fusion.fire.poison',
  'fusion.ice.poison',
];

function sourcesOf(names: readonly string[]): SourceTable {
  const sources = createSourceTable();
  for (const name of names) sources.index(name);
  return sources;
}

/**
 * Modifiers of the scoped stats (half of them damage) over all 17 tags: tags, notTags, both or
 * neither, tagged flats included (not on damage), some scoped to a source class or id.
 */
function randomScopedModifier(rng: Rng): Modifier {
  const stat = rng.chance(0.5) ? 'damage' : rng.pick(SCOPED_STATS);
  const kind = rng.pick(KINDS);
  const value = randomValue(rng);
  if (stat === 'damage' && kind === 'flat') return { stat, kind, value };
  const tags = someTags(rng, DAMAGE_TAGS, 0.12);
  const notTags = someTags(rng, DAMAGE_TAGS, 0.06).filter((tag) => !tags.includes(tag));
  return {
    stat,
    kind,
    value,
    ...(tags.length > 0 ? { tags } : {}),
    ...(notTags.length > 0 ? { notTags } : {}),
    ...(rng.chance(0.2) ? { scope: rng.pick(SELECTORS) } : {}),
  };
}

/** Every scoped stat of `key`'s row against the reference; `base` is the damage base. */
function expectRow(
  table: ModTable,
  modifiers: readonly Modifier[],
  base: number,
  key: number,
  sources?: SourceTable,
) {
  const row = table.row(key);
  const actual = SCOPED_STATS.map((stat) => {
    const at = row * S + SCOPED_INDEX[stat];
    return [table.final[at], table.flatV[at], table.inc[at], table.more[at], table.dynCount[at]];
  });
  const expected = SCOPED_STATS.map((stat) => {
    const ref = reference(
      modifiers,
      stat === 'damage' ? base : BASE_STATS[stat],
      key,
      sources,
      stat,
    );
    return [ref.final, ref.flat, ref.inc, ref.more, 0];
  });
  // toEqual compares numbers with Object.is: bit for bit.
  expect(actual, `key ${key}`).toEqual(expected);
}

describe('ModTable', () => {
  it('matches the formula written out per key for random 17-bit tags and sources', () => {
    const rng = createRng(23);
    for (let n = 0; n < 100; n++) {
      const sources = sourcesOf(SOURCE_NAMES);
      const modifiers = Array.from({ length: rng.int(25) }, () => randomScopedModifier(rng));
      const base = rng.range(0, 100);
      const table = new ModTable(compileMods(modifiers, sources), baseRow(base));
      const randomSource = (): number => rng.int(SOURCE_NAMES.length);
      for (let k = 0; k < 200; k++) {
        expectRow(table, modifiers, base, rowKey(rng.int(1 << 17), randomSource()), sources);
      }
      // Keys with every tag of one modifier, so tagged modifiers match often.
      for (const mod of modifiers) {
        const key = rowKey(tagMask(mod.tags ?? []), randomSource());
        expectRow(table, modifiers, base, key, sources);
      }
    }
  });

  it('applies a scoped modifier only to the sources its class or exact id selects', () => {
    const sources = sourcesOf(['outer.poison', 'outer.fire', 'fusion.fire.poison', 'hub']);
    const [center, poison, fire, fusion, hub] = [0, 1, 2, 3, 4];
    const stats = makeStats({}, [
      { stat: 'damage', kind: 'more', value: 1, scope: 'outer' },
      { stat: 'damage', kind: 'increased', value: 0.5, scope: 'outer.poison' },
      { stat: 'damage', kind: 'more', value: 2, tags: ['hit'], scope: 'fusion.fire.poison' },
      { stat: 'damage', kind: 'increased', value: 1, scope: 'center' },
      { stat: 'damage', kind: 'more', value: 9, scope: 'outer.greed' },
    ]);
    const table = modTableFor(stats, sources);
    const at = (tags: number, source: number): number => table.damage(rowKey(tags, source));
    expect(at(TAG.hit, center)).toBe(2);
    expect(at(TAG.burn, center)).toBe(2);
    expect(at(TAG.hit, poison)).toBe(1.5 * 2);
    expect(at(TAG.hit, fire)).toBe(2);
    expect(at(TAG.hit, fusion)).toBe(3);
    expect(at(TAG.burn, fusion)).toBe(1);
    expect(at(TAG.hit, hub)).toBe(1);
    // The same tags under another source are another row.
    expect(table.row(rowKey(TAG.hit, center))).not.toBe(table.row(rowKey(TAG.hit, poison)));
    expect(damageRow(stats, TAG.hit)).toBe(2);
  });

  it('keeps scopes current for sources numbered after the table was built', () => {
    const sources = createSourceTable();
    const table = new ModTable(
      compileMods(
        [
          { stat: 'damage', kind: 'more', value: 1, scope: 'outer' },
          { stat: 'damage', kind: 'more', value: 2, scope: 'outer.bleed' },
        ],
        sources,
      ),
      baseRow(1),
    );
    const fire = sources.index('outer.fire');
    const bleed = sources.index('outer.bleed');
    expect(table.damage(rowKey(TAG.hit, 0))).toBe(1);
    expect(table.damage(rowKey(TAG.hit, fire))).toBe(2);
    expect(table.damage(rowKey(TAG.hit, bleed))).toBe(6);
  });

  it('adds a scoped flat after the untagged sum, like a tagged one', () => {
    const sources = sourcesOf(['hub']);
    const modifiers: Modifier[] = [
      { stat: 'damage', kind: 'flat', value: 0.1, scope: 'hub' },
      { stat: 'damage', kind: 'flat', value: 0.2 },
      { stat: 'damage', kind: 'flat', value: 0.3 },
    ];
    const mods = compileMods(modifiers, sources);
    expect(mods.map((mod) => mod.untagged)).toEqual([false, true, true]);
    const table = new ModTable(mods, baseRow(1));
    expect(table.flatV[table.row(rowKey(0, 1)) * S + DAMAGE]).toBe(1 + (0.2 + 0.3) + 0.1);
    expect(table.flatV[table.row(rowKey(0, 0)) * S + DAMAGE]).toBe(1 + (0.2 + 0.3));
  });

  it('rejects a scope that is not a source class or id', () => {
    const scope = 'outer.water' as SourceSelector;
    expect(() =>
      compileMods([{ stat: 'damage', kind: 'more', value: 1, scope }], createSourceTable()),
    ).toThrow(/source selector/);
  });

  it('skips modifiers whose notTags the key carries', () => {
    const stats = makeStats({}, [
      { stat: 'damage', kind: 'more', value: -0.5, tags: ['hit'], notTags: ['crit'] },
      { stat: 'damage', kind: 'increased', value: 1, notTags: ['chain', 'poison'] },
    ]);
    const table = modTableFor(stats);
    expect(table.damage(TAG.hit)).toBe(2 * 0.5);
    expect(table.damage(TAG.hit | TAG.crit)).toBe(2);
    expect(table.damage(TAG.hit | TAG.chain)).toBe(0.5);
    expect(table.damage(TAG.burn)).toBe(2);
    expect(table.damage(TAG.poison | TAG.minion)).toBe(1);
    expect(table.damage(TAG.burn | TAG.crit)).toBe(2);
  });

  it('adds tagged flats after the untagged sum, each in data order', () => {
    const modifiers: Modifier[] = [
      { stat: 'damage', kind: 'flat', value: 0.1, tags: ['crit'] },
      { stat: 'damage', kind: 'flat', value: 0.2 },
      { stat: 'damage', kind: 'flat', value: 0.7, tags: ['hit'] },
      { stat: 'damage', kind: 'flat', value: 0.3 },
    ];
    const table = new ModTable(compileMods(modifiers, createSourceTable()), baseRow(1));
    const row = table.row(TAG.hit | TAG.crit);
    expect(table.flatV[row * S + DAMAGE]).toBe(1 + (0.2 + 0.3) + 0.1 + 0.7);
    expect(table.flatV[table.row(0) * S + DAMAGE]).toBe(1 + (0.2 + 0.3));
  });

  it('fills a row only when its key is first used, numbering rows in first-use order', () => {
    const table = modTableFor(makeStats({}, [{ stat: 'damage', kind: 'more', value: 1 }]));
    expect(table.rows).toBe(0);
    expect(table.damage(TAG.hit)).toBe(2);
    expect(table.rows).toBe(1);
    expect(table.row(TAG.hit)).toBe(0);
    expect(table.row(TAG.burn | TAG.crit)).toBe(1);
    expect(table.damage(TAG.hit)).toBe(2);
    expect(table.row(TAG.burn | TAG.crit)).toBe(1);
    expect(table.rows).toBe(2);
    expect(table.row(1 << 16)).toBe(2);
    expect(table.rows).toBe(3);
  });

  it('grows past its first slots, keeping every row and its number', () => {
    const rng = createRng(31);
    const modifiers = Array.from({ length: 12 }, () => randomScopedModifier(rng));
    const table = new ModTable(compileMods(modifiers, createSourceTable()), baseRow(10));
    const keys: number[] = [];
    const seen = new Set<number>();
    while (keys.length < 3000) {
      const key = rng.int(1 << 17);
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      // The first use may grow the table; damage() must read the grown arrays.
      expect(table.damage(key)).toBe(reference(modifiers, 10, key).final);
    }
    expect(table.rows).toBe(keys.length);
    expect(table.final.length).toBeGreaterThanOrEqual(keys.length * S);
    keys.forEach((key, i) => expect(table.row(key)).toBe(i));
    for (const key of keys) expectRow(table, modifiers, 10, key);
    expect(table.rows).toBe(keys.length);
  });

  it('rejects a modifier of a stat that is not scoped', () => {
    expect(() =>
      compileMods([{ stat: 'attackSpeed', kind: 'flat', value: 0.1 }], createSourceTable()),
    ).toThrow(/scoped/);
  });

  it('folds an untagged row of every scoped stat to StatBlock.values exactly', () => {
    const rng = createRng(41);
    const scopedStats = STAT_IDS.filter(isScopedStat);
    for (let n = 0; n < 300; n++) {
      const modifiers = Array.from({ length: rng.int(10) }, (): Modifier => {
        const stat = rng.pick(scopedStats);
        const kind = stat === 'damage' ? 'flat' : rng.pick(KINDS);
        return { stat, kind, value: randomValue(rng) };
      });
      const stats = computeStatBlock(modifiers, NO_EXTRAS);
      const table = modTableFor(stats);
      for (const mask of [0, TAG.hit, TAG.hit | TAG.crit | TAG.chain, TAG.burn]) {
        const row = table.row(mask);
        for (const stat of scopedStats) {
          if (stat === 'damage') continue;
          expect(statAt(table, row, SCOPED_INDEX[stat], staticInput(0)), `${n} ${stat}`).toBe(
            stats.values[stat],
          );
        }
      }
    }
  });

  it('applies postScale, then postOffset, to the folded value of every stat but damage', () => {
    const modifiers: Modifier[] = [
      { stat: 'critMultiplier', kind: 'flat', value: 0.5, tags: ['crit'] },
      { stat: 'critMultiplier', kind: 'more', value: 0.25, tags: ['chain'] },
      { stat: 'critChance', kind: 'increased', value: 0.5 },
      { stat: 'damage', kind: 'more', value: 1, tags: ['hit'] },
    ];
    const postScale = new Float64Array(S).fill(1);
    const postOffset = new Float64Array(S);
    postScale[SCOPED_INDEX.critMultiplier] = 1.5;
    postScale[SCOPED_INDEX.critChance] = 3;
    postOffset[SCOPED_INDEX.critChance] = -0.125;
    // Damage rows ignore both arrays.
    postScale[DAMAGE] = 7;
    postOffset[DAMAGE] = 5;
    const mods = compileMods(modifiers, createSourceTable());
    const plain = new ModTable(mods, baseRow(1));
    const post = new ModTable(mods, baseRow(1), postScale, postOffset);
    for (let key = 0; key < 1 << 6; key++) {
      for (let s = 0; s < S; s++) {
        const folded = plain.final[plain.row(key) * S + s] as number;
        const expected =
          s === DAMAGE ? folded : folded * (postScale[s] as number) + (postOffset[s] as number);
        expect(post.final[post.row(key) * S + s], `key ${key} stat ${s}`).toBe(expected);
      }
    }
    expect(post.damage(TAG.hit)).toBe(2);
  });

  it('rejects post arrays that do not hold one value per scoped stat', () => {
    const mods = compileMods([], createSourceTable());
    expect(() => new ModTable(mods, baseRow(1), new Float64Array(S - 1))).toThrow(RangeError);
    expect(
      () => new ModTable(mods, baseRow(1), new Float64Array(S), new Float64Array(S + 1)),
    ).toThrow(RangeError);
  });
});

/**
 * M1's crit and ignite chances of a hit (src/sim/systems/hits.ts before C3.3), from the bridge
 * notables' rule parameters: the crit roll clamp01(clamp01(critChance) + perJump × jump), the
 * ignite roll clamp01(clamp01(igniteChance) + critIgnite on crits + chainIgnite on jumps), and
 * Searing Crits forcing every crit's ignite.
 */
function m1Chances(
  values: { readonly critChance: number; readonly igniteChance: number },
  crit: boolean,
  jump: number,
  searing: boolean,
): { critChance: number; igniteChance: number; igniteAlways: boolean } {
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  let ignite = clamp01(values.igniteChance);
  if (crit) ignite += 0.3;
  if (jump > 0) ignite += 0.25;
  return {
    critChance: clamp01(clamp01(values.critChance) + 0.1 * jump),
    igniteChance: clamp01(ignite),
    igniteAlways: crit && searing,
  };
}

describe('chance rows against the M1 bridge rules', () => {
  /** critChance and igniteChance of the fingerprint's stat profiles, and a few past 1. */
  const PROFILES = [
    { critChance: 0.05, igniteChance: 0.1 },
    { critChance: 0.4, igniteChance: 0.1 },
    { critChance: 0.05, igniteChance: 0.6 },
    { critChance: 0.05, igniteChance: 0.3 },
    { critChance: 0.3, igniteChance: 0.3 },
    { critChance: 0.95, igniteChance: 0.7 },
    { critChance: 1.2, igniteChance: 1.35 },
  ];

  it.each(PROFILES)('reproduce the M1 chances bit for bit at %o', (values) => {
    for (const searing of [false, true]) {
      const modifiers = [
        ...maskProbeMods(),
        ...BRIDGE_MODS,
        ...(searing ? SEARING_CRITS_MODS : []),
      ];
      const table = modTableFor(makeStats(values, modifiers));
      const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
      for (let jump = 0; jump <= 6; jump++) {
        const plain = jump > 0 ? TAG.hit | TAG.chain : TAG.hit;
        for (const crit of [false, true]) {
          const m1 = m1Chances(values, crit, jump, searing);
          const at = (mask: number, stat: ScopedStat): number =>
            statAt(table, table.row(mask), SCOPED_INDEX[stat], staticInput(jump));
          const label = `${JSON.stringify(values)} searing ${searing} jump ${jump} crit ${crit}`;
          const row = crit ? plain | TAG.crit : plain;
          expect(clamp01(at(plain, 'critChance')), label).toBe(m1.critChance);
          expect(clamp01(at(row, 'igniteChance')), label).toBe(m1.igniteChance);
          expect(at(row, 'igniteAlways') > 0, label).toBe(m1.igniteAlways);
          expect(at(plain, 'critAlways'), label).toBe(0);
        }
      }
    }
  });
});
