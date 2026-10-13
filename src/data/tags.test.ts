import { describe, expect, it } from 'vitest';
import {
  ailmentMask,
  convertMask,
  DAMAGE_TAGS,
  DELIVERY_MASK,
  DOT_KIND,
  DOT_MASK,
  ELEMENT_MASK,
  GEOMETRY_MASK,
  jumpMask,
  KIND_MASK,
  OWNER_MASK,
  TAG,
  tagMask,
} from './tags';
import type { DotTag } from './tags';

const QUALIFIER_MASK = TAG.crit;
const ALL = (1 << DAMAGE_TAGS.length) - 1;

/** A mask with one tag from every group: a projectile minion's crit lightning hit. */
const FULL = tagMask(['hit', 'lightning', 'crit', 'minion', 'projectile']);

describe('damage tags', () => {
  it('has 17 bits and keeps the M1 bits', () => {
    expect(DAMAGE_TAGS).toHaveLength(17);
    expect([TAG.hit, TAG.crit, TAG.burn, TAG.chain]).toEqual([1, 2, 4, 8]);
    DAMAGE_TAGS.forEach((tag, i) => expect(TAG[tag], tag).toBe(1 << i));
    expect(tagMask([...DAMAGE_TAGS])).toBe(ALL);
    expect(tagMask([])).toBe(0);
  });

  it('splits the tags into disjoint groups that cover all 17', () => {
    const groups = [KIND_MASK, ELEMENT_MASK, QUALIFIER_MASK, OWNER_MASK, GEOMETRY_MASK];
    expect(groups.reduce((a, b) => a | b, 0)).toBe(ALL);
    expect(groups.reduce((a, b) => a + b, 0)).toBe(ALL);
    expect(KIND_MASK).toBe(tagMask(['hit', 'burn', 'poison', 'bleed']));
    expect(ELEMENT_MASK).toBe(tagMask(['cold', 'lightning']));
    expect(GEOMETRY_MASK).toBe(tagMask(['projectile', 'chain', 'area']));
    expect(DELIVERY_MASK).toBe(OWNER_MASK | GEOMETRY_MASK);
    expect(DOT_MASK).toBe(DOT_KIND.burn | DOT_KIND.poison | DOT_KIND.bleed);
  });
});

describe('derived masks', () => {
  it('makes a chain jump a hit that keeps owner and element but not geometry', () => {
    expect(jumpMask(tagMask(['hit', 'projectile']))).toBe(TAG.hit | TAG.chain);
    expect(jumpMask(FULL)).toBe(tagMask(['hit', 'chain', 'minion', 'lightning']));
    // Crit is added by the jump's own roll, not inherited.
    expect(jumpMask(FULL) & TAG.crit).toBe(0);
    expect(jumpMask(tagMask(['hit', 'area', 'trigger', 'cold']))).toBe(
      tagMask(['hit', 'chain', 'trigger', 'cold']),
    );
  });

  it('gives an ailment its kind, the applier owner tags and crit only', () => {
    for (const kind of ['burn', 'poison', 'bleed'] as const) {
      expect(ailmentMask(FULL, kind, false)).toBe(DOT_KIND[kind] | TAG.minion);
      expect(ailmentMask(FULL, kind, true)).toBe(DOT_KIND[kind] | TAG.minion | TAG.crit);
    }
    // M1: a burn from a crit chain jump is a plain crit burn.
    const jump = jumpMask(tagMask(['hit', 'projectile'])) | TAG.crit;
    expect(ailmentMask(jump, 'burn', true)).toBe(TAG.burn | TAG.crit);
  });

  it('converts to a damage-over-time kind keeping delivery and crit', () => {
    const kinds: readonly DotTag[] = ['burn', 'poison', 'bleed'];
    for (const kind of kinds) {
      const converted = convertMask(FULL, kind);
      expect(converted & KIND_MASK).toBe(DOT_KIND[kind]);
      expect(converted & ELEMENT_MASK).toBe(0);
      expect(converted & (DELIVERY_MASK | TAG.crit)).toBe(FULL & (DELIVERY_MASK | TAG.crit));
    }
    expect(convertMask(tagMask(['hit', 'projectile']), 'poison')).toBe(
      tagMask(['poison', 'projectile']),
    );
  });

  it('converts to an element keeping the hit, delivery and crit', () => {
    expect(convertMask(FULL, 'cold')).toBe((FULL & ~TAG.lightning) | TAG.cold);
    expect(convertMask(tagMask(['hit', 'minion']), 'lightning')).toBe(
      tagMask(['hit', 'minion', 'lightning']),
    );
    expect(convertMask(tagMask(['hit', 'chain', 'crit', 'cold']), 'cold')).toBe(
      tagMask(['hit', 'chain', 'crit', 'cold']),
    );
  });
});
