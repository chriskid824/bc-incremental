/**
 * Stat and damage-tag vocabulary shared by data files, meta and the simulation.
 * See docs/GDD.md §3 for the meaning of each stat.
 */

export const STAT_IDS = [
  /** Flat base damage per attack. Damage modifiers may carry tags; see DamageTag. */
  'damage',
  /** Attacks per second. */
  'attackSpeed',
  /** Projectiles per attack, each at its own target. Fractional part is a chance for one more. */
  'projectileCount',
  /** Probability in [0, 1]; the simulation clamps it. */
  'critChance',
  /** Damage multiplier on crit, e.g. 1.5 = 150%. */
  'critMultiplier',
  /** Probability in [0, 1] that a hit ignites. */
  'igniteChance',
  /** Burn damage per second, as a fraction of the igniting hit's damage. */
  'burnDamage',
  /** Burn duration in seconds. */
  'burnDuration',
  /** Maximum simultaneous burn stacks on one enemy. */
  'burnMaxStacks',
  /** Number of additional enemies a hit chains to. Fractional part is a chance for one more. */
  'chainCount',
  /** Fraction of the previous jump's damage kept on each chain jump. */
  'chainRetention',
  /** Maximum chain jump distance in arena units. */
  'chainRange',
  /** Player life. */
  'maxLife',
  /** Projectile speed in arena units per second. */
  'projectileSpeed',
  /** Multiplier on shard drops. */
  'shardGain',
  /** Multiplier on core drops. */
  'coreGain',
] as const;

export type StatId = (typeof STAT_IDS)[number];

/** Base values before any modifier (docs/GDD.md §3.1–3.4). */
export const BASE_STATS: Readonly<Record<StatId, number>> = {
  damage: 10,
  attackSpeed: 2,
  projectileCount: 1,
  critChance: 0.05,
  critMultiplier: 1.5,
  igniteChance: 0.1,
  burnDamage: 0.6,
  burnDuration: 3,
  burnMaxStacks: 5,
  chainCount: 0,
  chainRetention: 0.7,
  chainRange: 260,
  maxLife: 100,
  projectileSpeed: 1400,
  shardGain: 1,
  coreGain: 1,
};

/**
 * Tags describing a damage instance. A tagged damage modifier applies to an instance only
 * when every tag on the modifier is present on the instance.
 */
export const DAMAGE_TAGS = ['hit', 'crit', 'burn', 'chain'] as const;
export type DamageTag = (typeof DAMAGE_TAGS)[number];

/** Bit for each tag; an instance's tag set is the OR of its bits (16 combinations). */
export const DAMAGE_TAG_BIT: Readonly<Record<DamageTag, number>> = {
  hit: 1,
  crit: 2,
  burn: 4,
  chain: 8,
};

export const DAMAGE_TAG_MASK_COUNT = 16;

export function tagMask(tags: readonly DamageTag[]): number {
  let mask = 0;
  for (const tag of tags) mask |= DAMAGE_TAG_BIT[tag];
  return mask;
}

export type ModifierKind = 'flat' | 'increased' | 'more';

/**
 * `flat` adds to the base, `increased` values add together, `more` values multiply:
 * final = (base + Σflat) × (1 + Σincreased) × Π(1 + more).
 * `value` is a fraction for increased/more (0.2 = 20%).
 * Only `damage` modifiers of kind increased/more may carry tags.
 */
export interface Modifier {
  readonly stat: StatId;
  readonly kind: ModifierKind;
  readonly value: number;
  readonly tags?: readonly DamageTag[];
}

/** Final stats handed to the simulation for one run. */
export interface StatBlock {
  /** Final value of every stat. For `damage` this is the untagged base (base + Σflat). */
  readonly values: Readonly<Record<StatId, number>>;
  /**
   * Damage multiplier for each tag mask (index = mask, length DAMAGE_TAG_MASK_COUNT), combining
   * every increased/more damage modifier whose tags are a subset of the mask.
   * Damage of an instance = values.damage × damageMult[mask].
   */
  readonly damageMult: readonly number[];
}
