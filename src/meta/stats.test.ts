import { describe, expect, it } from 'vitest';
import { BASE_STATS, NO_EXTRAS, STAT_IDS } from '../data/stats';
import type { Modifier, StatBlock } from '../data/stats';
import { tagMask } from '../data/tags';
import { damageRow } from '../sim/build/modTable';
import { createMetaState } from './state';
import { collectModifiers, collectRules, computeStatBlock, statBlockFor } from './stats';
import { fixtureData } from './testing';

/** The tag masks of M1's four tags (hit, crit, burn, chain). */
const ALL_MASKS = Array.from({ length: 16 }, (_, m) => m);

const block = (modifiers: readonly Modifier[]): StatBlock => computeStatBlock(modifiers, NO_EXTRAS);
const rows = (stats: StatBlock): number[] => ALL_MASKS.map((mask) => damageRow(stats, mask));

describe('computeStatBlock', () => {
  it('returns base stats and unit damage rows with no modifiers', () => {
    const stats = block([]);
    for (const stat of STAT_IDS) expect(stats.values[stat]).toBe(BASE_STATS[stat]);
    expect(stats.base).toBe(BASE_STATS);
    expect(stats.scoped).toEqual([]);
    expect(rows(stats)).toEqual(ALL_MASKS.map(() => 1));
  });

  it('applies flat before multipliers, adds increased and multiplies more', () => {
    const stats = block([
      { stat: 'attackSpeed', kind: 'flat', value: 0.5 },
      { stat: 'attackSpeed', kind: 'increased', value: 0.2 },
      { stat: 'attackSpeed', kind: 'increased', value: 0.3 },
      { stat: 'attackSpeed', kind: 'more', value: 0.5 },
      { stat: 'attackSpeed', kind: 'more', value: 0.1 },
    ]);
    // (base + 0.5) × (1 + 0.2 + 0.3) × 1.5 × 1.1
    expect(stats.values.attackSpeed).toBeCloseTo(
      (BASE_STATS.attackSpeed + 0.5) * 1.5 * 1.5 * 1.1,
      12,
    );
    expect(stats.values.critChance).toBe(BASE_STATS.critChance);
    expect(stats.scoped).toEqual([]);
  });

  it('supports negative more (penalties) and leaves other stats untouched', () => {
    const stats = block([{ stat: 'burnDuration', kind: 'more', value: -0.5 }]);
    expect(stats.values.burnDuration).toBe(BASE_STATS.burnDuration / 2);
    expect(stats.values.maxLife).toBe(100);
  });

  it('keeps only base + flat in values.damage and every damage modifier in scoped', () => {
    const modifiers: Modifier[] = [
      { stat: 'damage', kind: 'flat', value: 5 },
      { stat: 'attackSpeed', kind: 'flat', value: 1 },
      { stat: 'damage', kind: 'increased', value: 0.5 },
      { stat: 'damage', kind: 'more', value: 1, tags: ['burn'] },
      { stat: 'damage', kind: 'more', value: 1 },
    ];
    const stats = block(modifiers);
    expect(stats.values.damage).toBe(15);
    expect(stats.scoped).toEqual([modifiers[0], modifiers[2], modifiers[3], modifiers[4]]);
    // Untagged scaling reaches every mask: (1 + 0.5) × 2, and × 2 again with burn.
    expect(rows(stats)).toEqual(ALL_MASKS.map((m) => (m & tagMask(['burn']) ? 6 : 3)));
  });

  it('applies tagged damage modifiers only to masks containing all their tags', () => {
    const stats = block([
      { stat: 'damage', kind: 'increased', value: 0.5 },
      { stat: 'damage', kind: 'increased', value: 1, tags: ['burn'] },
      { stat: 'damage', kind: 'more', value: 1, tags: ['crit', 'chain'] },
    ]);
    const burn = tagMask(['burn']);
    const critChain = tagMask(['crit', 'chain']);
    for (const m of ALL_MASKS) {
      const increased = 1 + 0.5 + ((m & burn) === burn ? 1 : 0);
      const more = (m & critChain) === critChain ? 2 : 1;
      expect(damageRow(stats, m), `mask ${m}`).toBeCloseTo(increased * more, 12);
    }
    // Spot checks: untagged only, burn only, crit alone, crit+chain, everything.
    expect(damageRow(stats, 0)).toBe(1.5);
    expect(damageRow(stats, tagMask(['burn']))).toBe(2.5);
    expect(damageRow(stats, tagMask(['crit']))).toBe(1.5);
    expect(damageRow(stats, tagMask(['crit', 'chain']))).toBe(3);
    expect(damageRow(stats, tagMask(['hit', 'crit', 'burn', 'chain']))).toBe(5);
  });

  it('applies a damage modifier with notTags only to masks without them', () => {
    const stats = block([{ stat: 'damage', kind: 'more', value: -0.5, notTags: ['crit'] }]);
    expect(damageRow(stats, tagMask(['hit']))).toBe(0.5);
    expect(damageRow(stats, tagMask(['hit', 'chain']))).toBe(0.5);
    expect(damageRow(stats, tagMask(['hit', 'crit']))).toBe(1);
    expect(damageRow(stats, tagMask(['burn', 'crit']))).toBe(1);
  });

  it('treats an empty tag list as untagged', () => {
    const stats = block([
      { stat: 'damage', kind: 'increased', value: 0.25, tags: [] },
      { stat: 'critChance', kind: 'flat', value: 0.1, tags: [] },
    ]);
    expect(rows(stats)).toEqual(ALL_MASKS.map(() => 1.25));
    expect(stats.values.critChance).toBeCloseTo(0.15, 12);
  });

  it('throws on tags or notTags outside scoped stats and on flat damage', () => {
    const rejected: Modifier[] = [
      { stat: 'critChance', kind: 'increased', value: 1, tags: ['crit'] },
      { stat: 'damage', kind: 'flat', value: 5, tags: ['burn'] },
      { stat: 'critChance', kind: 'flat', value: 0.1, notTags: ['chain'] },
      { stat: 'damage', kind: 'flat', value: 5, notTags: ['burn'] },
    ];
    for (const mod of rejected) expect(() => block([mod]), JSON.stringify(mod)).toThrow(/Tags/);
  });

  it('passes the triggers and conversions through', () => {
    const stats = computeStatBlock([], NO_EXTRAS);
    expect(stats.triggers).toBe(NO_EXTRAS.triggers);
    expect(stats.conversions).toBe(NO_EXTRAS.conversions);
  });
});

describe('collectModifiers / collectRules', () => {
  const data = fixtureData();

  it('includes only the start node on a fresh profile', () => {
    const meta = createMetaState();
    expect(collectModifiers(meta, data)).toEqual([{ stat: 'maxLife', kind: 'flat', value: 20 }]);
    expect(collectRules(meta, data)).toEqual([]);
    expect(statBlockFor(meta, data).values.maxLife).toBe(120);
  });

  it('includes allocated nodes once and their rules', () => {
    const meta = createMetaState();
    for (const id of ['a', 'a2', 'k']) meta.allocated.add(id);
    expect(collectModifiers(meta, data)).toEqual([
      { stat: 'maxLife', kind: 'flat', value: 20 },
      { stat: 'damage', kind: 'increased', value: 0.1 },
      { stat: 'critChance', kind: 'flat', value: 0.05 },
    ]);
    expect(collectRules(meta, data)).toEqual([{ id: 'glassCannon', damageMore: 1 }]);
  });

  it('repeats repeatable modifiers per rank so more multipliers stack', () => {
    const meta = createMetaState();
    meta.allocated.add('r');
    meta.ranks.set('r', 3);
    const repeated = collectModifiers(meta, data).filter((m) => m.stat === 'damage');
    expect(repeated).toHaveLength(3);
    const stats = statBlockFor(meta, data);
    expect(stats.scoped).toEqual(repeated);
    for (const m of ALL_MASKS) expect(damageRow(stats, m)).toBeCloseTo(1.1 ** 3, 12);
  });

  it('keeps the scoped modifiers in data order, ranks repeated, apart from the values', () => {
    const meta = createMetaState();
    for (const id of ['r', 'far', 'a']) meta.allocated.add(id);
    meta.ranks.set('r', 2);
    const stats = statBlockFor(meta, data);
    expect(stats.scoped).toEqual([
      { stat: 'damage', kind: 'increased', value: 0.1 },
      { stat: 'damage', kind: 'flat', value: 3 },
      { stat: 'damage', kind: 'more', value: 0.1 },
      { stat: 'damage', kind: 'more', value: 0.1 },
    ]);
    expect(stats.values.damage).toBe(BASE_STATS.damage + 3);
    expect(stats.values.maxLife).toBe(120);
    expect(damageRow(stats, 0)).toBe(1.1 * 1.1 * 1.1);
  });

  it('does not depend on allocation order', () => {
    const first = createMetaState();
    const second = createMetaState();
    for (const id of ['a', 'b', 'a2']) first.allocated.add(id);
    for (const id of ['a2', 'b', 'a']) second.allocated.add(id);
    expect(collectModifiers(first, data)).toEqual(collectModifiers(second, data));
  });
});
