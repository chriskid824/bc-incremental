import { describe, expect, it } from 'vitest';
import { BASE_STATS, DAMAGE_TAG_MASK_COUNT, STAT_IDS, tagMask } from '../data/stats';
import type { Modifier } from '../data/stats';
import { createMetaState } from './state';
import { collectModifiers, collectRules, computeStatBlock, statBlockFor } from './stats';
import { fixtureData } from './testing';

const ALL_MASKS = Array.from({ length: DAMAGE_TAG_MASK_COUNT }, (_, m) => m);

describe('computeStatBlock', () => {
  it('returns base stats and unit damage multipliers with no modifiers', () => {
    const block = computeStatBlock([]);
    for (const stat of STAT_IDS) expect(block.values[stat]).toBe(BASE_STATS[stat]);
    expect(block.damageMult).toEqual(ALL_MASKS.map(() => 1));
  });

  it('applies flat before multipliers, adds increased and multiplies more', () => {
    const block = computeStatBlock([
      { stat: 'attackSpeed', kind: 'flat', value: 0.5 },
      { stat: 'attackSpeed', kind: 'increased', value: 0.2 },
      { stat: 'attackSpeed', kind: 'increased', value: 0.3 },
      { stat: 'attackSpeed', kind: 'more', value: 0.5 },
      { stat: 'attackSpeed', kind: 'more', value: 0.1 },
    ]);
    // (base + 0.5) × (1 + 0.2 + 0.3) × 1.5 × 1.1
    expect(block.values.attackSpeed).toBeCloseTo(
      (BASE_STATS.attackSpeed + 0.5) * 1.5 * 1.5 * 1.1,
      12,
    );
    expect(block.values.critChance).toBe(BASE_STATS.critChance);
  });

  it('supports negative more (penalties) and leaves other stats untouched', () => {
    const block = computeStatBlock([{ stat: 'burnDuration', kind: 'more', value: -0.5 }]);
    expect(block.values.burnDuration).toBe(BASE_STATS.burnDuration / 2);
    expect(block.values.maxLife).toBe(100);
  });

  it('keeps only base + flat in values.damage', () => {
    const block = computeStatBlock([
      { stat: 'damage', kind: 'flat', value: 5 },
      { stat: 'damage', kind: 'increased', value: 0.5 },
      { stat: 'damage', kind: 'more', value: 1 },
    ]);
    expect(block.values.damage).toBe(15);
    // Untagged scaling reaches every mask: (1 + 0.5) × 2.
    expect(block.damageMult).toEqual(ALL_MASKS.map(() => 3));
  });

  it('applies tagged damage modifiers only to masks containing all their tags', () => {
    const block = computeStatBlock([
      { stat: 'damage', kind: 'increased', value: 0.5 },
      { stat: 'damage', kind: 'increased', value: 1, tags: ['burn'] },
      { stat: 'damage', kind: 'more', value: 1, tags: ['crit', 'chain'] },
    ]);
    const burn = tagMask(['burn']);
    const critChain = tagMask(['crit', 'chain']);
    for (const m of ALL_MASKS) {
      const increased = 1 + 0.5 + ((m & burn) === burn ? 1 : 0);
      const more = (m & critChain) === critChain ? 2 : 1;
      expect(block.damageMult[m], `mask ${m}`).toBeCloseTo(increased * more, 12);
    }
    // Spot checks: untagged only, burn only, crit alone, crit+chain, everything.
    expect(block.damageMult[0]).toBe(1.5);
    expect(block.damageMult[tagMask(['burn'])]).toBe(2.5);
    expect(block.damageMult[tagMask(['crit'])]).toBe(1.5);
    expect(block.damageMult[tagMask(['crit', 'chain'])]).toBe(3);
    expect(block.damageMult[tagMask(['hit', 'crit', 'burn', 'chain'])]).toBe(5);
  });

  it('treats an empty tag list as untagged', () => {
    const block = computeStatBlock([
      { stat: 'damage', kind: 'increased', value: 0.25, tags: [] },
      { stat: 'critChance', kind: 'flat', value: 0.1, tags: [] },
    ]);
    expect(block.damageMult).toEqual(ALL_MASKS.map(() => 1.25));
    expect(block.values.critChance).toBeCloseTo(0.15, 12);
  });

  it('throws on tagged modifiers outside increased/more damage', () => {
    const taggedStat: Modifier = {
      stat: 'critChance',
      kind: 'increased',
      value: 1,
      tags: ['crit'],
    };
    const taggedFlat: Modifier = { stat: 'damage', kind: 'flat', value: 5, tags: ['burn'] };
    expect(() => computeStatBlock([taggedStat])).toThrow(/Tags/);
    expect(() => computeStatBlock([taggedFlat])).toThrow(/Tags/);
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
    const block = statBlockFor(meta, data);
    for (const m of ALL_MASKS) expect(block.damageMult[m]).toBeCloseTo(1.1 ** 3, 12);
  });

  it('does not depend on allocation order', () => {
    const first = createMetaState();
    const second = createMetaState();
    for (const id of ['a', 'b', 'a2']) first.allocated.add(id);
    for (const id of ['a2', 'b', 'a']) second.allocated.add(id);
    expect(collectModifiers(first, data)).toEqual(collectModifiers(second, data));
  });
});
