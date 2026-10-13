/**
 * Damage tags (docs/v3/implementation-plan-v3.md §2.1): what a damage instance is and how it
 * was delivered, as a 17-bit mask. A tagged modifier applies to an instance only when every
 * tag on the modifier is present on the instance (and none of its notTags).
 *
 * The tags fall into groups:
 * - KIND (hit, burn, poison, bleed): exactly one per instance.
 * - ELEMENT (cold, lightning): only together with hit.
 * - QUALIFIER (crit).
 * - OWNER (minion, aura, orbit, zone, strike, thorns, trigger) and GEOMETRY (projectile,
 *   chain, area): how the instance was delivered.
 */

/** Bit i is DAMAGE_TAGS[i]. M1's four tags come first and keep their bits. */
export const DAMAGE_TAGS = [
  'hit',
  'crit',
  'burn',
  'chain',
  'projectile',
  'area',
  'zone',
  'aura',
  'orbit',
  'strike',
  'minion',
  'thorns',
  'trigger',
  'poison',
  'bleed',
  'cold',
  'lightning',
] as const;
export type DamageTag = (typeof DAMAGE_TAGS)[number];

/** OR of tag bits; below 2^17. */
export type TagMask = number;

/** Bit of each tag: hit 1, crit 2, burn 4, chain 8, … lightning 1 << 16. */
export const TAG: Readonly<Record<DamageTag, TagMask>> = Object.fromEntries(
  DAMAGE_TAGS.map((tag, i) => [tag, 1 << i]),
) as Record<DamageTag, TagMask>;

export function tagMask(tags: readonly DamageTag[]): TagMask {
  let mask = 0;
  for (const tag of tags) mask |= TAG[tag];
  return mask;
}

export const KIND_MASK: TagMask = tagMask(['hit', 'burn', 'poison', 'bleed']);
export const ELEMENT_MASK: TagMask = tagMask(['cold', 'lightning']);
export const OWNER_MASK: TagMask = tagMask([
  'minion',
  'aura',
  'orbit',
  'zone',
  'strike',
  'thorns',
  'trigger',
]);
export const GEOMETRY_MASK: TagMask = tagMask(['projectile', 'chain', 'area']);
export const DELIVERY_MASK: TagMask = OWNER_MASK | GEOMETRY_MASK;
export const DOT_MASK: TagMask = tagMask(['burn', 'poison', 'bleed']);

/** The damage-over-time kinds. */
export type DotTag = 'burn' | 'poison' | 'bleed';
export const DOT_KIND: Readonly<Record<DotTag, TagMask>> = {
  burn: TAG.burn,
  poison: TAG.poison,
  bleed: TAG.bleed,
};

/**
 * A chain jump from a primary hit: a hit with the chain tag that keeps the primary's owner and
 * element but not its geometry. Crit is added separately when the jump crits.
 */
export const jumpMask = (primary: TagMask): TagMask =>
  TAG.hit | TAG.chain | (primary & (OWNER_MASK | ELEMENT_MASK));

/**
 * An ailment's damage: its kind, the applier's owner tags ("who dealt it", not "how it
 * travelled"), and crit when a crit applied it. A burn from a chain jump is a plain burn.
 */
export const ailmentMask = (applier: TagMask, kind: DotTag, crit: boolean): TagMask =>
  DOT_KIND[kind] | (applier & OWNER_MASK) | (crit ? TAG.crit : 0);

/**
 * The converted part of an instance: a damage-over-time kind replaces the kind and element; an
 * element replaces the element and keeps the instance a hit. Delivery tags and crit stay.
 */
export function convertMask(mask: TagMask, to: DotTag | 'cold' | 'lightning'): TagMask {
  if (to === 'cold' || to === 'lightning') return (mask & ~ELEMENT_MASK) | TAG.hit | TAG[to];
  return (mask & ~(KIND_MASK | ELEMENT_MASK)) | TAG[to];
}
