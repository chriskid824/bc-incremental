import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import type { Rng } from '../../core/rng';
import { loadGameData } from '../../data';
import { BASE_STATS, NO_EXTRAS, SCOPED_STATS, STAT_IDS } from '../../data/stats';
import type { Modifier, ModifierKind, StatId } from '../../data/stats';
import { DAMAGE_TAGS, TAG, tagMask } from '../../data/tags';
import type { DamageTag } from '../../data/tags';
import { computeStatBlock } from '../../meta/stats';
import { makeStats } from '../testing';
import { compileMods, damageRow, ModTable, modTableFor } from './modTable';

const S = SCOPED_STATS.length;
const DAMAGE = SCOPED_STATS.indexOf('damage');
const M1_TAGS = ['hit', 'crit', 'burn', 'chain'] as const satisfies readonly DamageTag[];
const M1_MASKS = Array.from({ length: 16 }, (_, mask) => mask);
const KINDS: readonly ModifierKind[] = ['flat', 'increased', 'more'];

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

/** computeStatBlock and its damage rows equal M1's values and damageMult exactly. */
function expectM1(modifiers: readonly Modifier[], label: string): void {
  const m1 = m1ComputeStatBlock(modifiers);
  const stats = computeStatBlock(modifiers, NO_EXTRAS);
  for (const stat of STAT_IDS) expect(stats.values[stat], `${label} ${stat}`).toBe(m1.values[stat]);
  const table = modTableFor(stats);
  for (const mask of M1_MASKS) {
    expect(damageRow(stats, mask), `${label} mask ${mask}`).toBe(m1.damageMult[mask]);
    expect(table.damage(mask), `${label} mask ${mask}`).toBe(m1.damageMult[mask]);
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
  const stat = rng.chance(0.6) ? 'damage' : rng.pick(STAT_IDS);
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
  });
});

interface Reference {
  readonly final: number;
  readonly flat: number;
  readonly inc: number;
  readonly more: number;
}

/** The ModTable formula for damage, written out per key. */
function reference(modifiers: readonly Modifier[], base: number, key: number): Reference {
  const untagged = (m: Modifier): boolean =>
    (m.tags?.length ?? 0) === 0 && (m.notTags?.length ?? 0) === 0;
  const matching = modifiers.filter(
    (m) => (tagMask(m.tags ?? []) & ~key) === 0 && (tagMask(m.notTags ?? []) & key) === 0,
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
  return { final: (1 + inc) * more, flat, inc, more };
}

/** Damage modifiers over all 17 tags: tags, notTags, both or neither, tagged flats included. */
function randomScopedModifier(rng: Rng): Modifier {
  const kind = rng.pick(KINDS);
  const value = randomValue(rng);
  const tags = someTags(rng, DAMAGE_TAGS, 0.12);
  const notTags = someTags(rng, DAMAGE_TAGS, 0.06).filter((tag) => !tags.includes(tag));
  return {
    stat: 'damage',
    kind,
    value,
    ...(tags.length > 0 ? { tags } : {}),
    ...(notTags.length > 0 ? { notTags } : {}),
  };
}

function expectRow(table: ModTable, modifiers: readonly Modifier[], base: number, key: number) {
  const row = table.row(key);
  const ref = reference(modifiers, base, key);
  const at = row * S + DAMAGE;
  expect(table.final[at], `key ${key}`).toBe(ref.final);
  expect(table.flatV[at], `key ${key}`).toBe(ref.flat);
  expect(table.inc[at], `key ${key}`).toBe(ref.inc);
  expect(table.more[at], `key ${key}`).toBe(ref.more);
}

describe('ModTable', () => {
  it('matches the formula written out per key for random 17-bit keys', () => {
    const rng = createRng(23);
    for (let n = 0; n < 200; n++) {
      const modifiers = Array.from({ length: rng.int(25) }, () => randomScopedModifier(rng));
      const base = rng.range(0, 100);
      const table = new ModTable(compileMods(modifiers), Float64Array.of(base));
      for (let k = 0; k < 200; k++) expectRow(table, modifiers, base, rng.int(1 << 17));
      // Keys with every tag of one modifier, so tagged modifiers match often.
      for (const mod of modifiers) expectRow(table, modifiers, base, tagMask(mod.tags ?? []));
    }
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
    const table = new ModTable(compileMods(modifiers), Float64Array.of(1));
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
    const table = new ModTable(compileMods(modifiers), Float64Array.of(10));
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
    expect(() => compileMods([{ stat: 'critChance', kind: 'flat', value: 0.1 }])).toThrow(/scoped/);
  });
});
