/**
 * Stat vocabulary shared by data files, meta and the simulation; damage tags are in tags.ts.
 * See docs/GDD.md §3 for the meaning of each stat.
 */

import type { SourceSelector } from './sources';
import { TAG } from './tags';
import type { DamageTag } from './tags';
import type { ScalingSpec } from './triggers';

export const STAT_IDS = [
  /** Flat base damage per attack. Damage modifiers may carry tags; see src/data/tags.ts. */
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
  /** Above 0, a hit crits whatever its crit roll, which is drawn all the same. */
  'critAlways',
  /** Above 0, a hit ignites whatever its ignite roll, which is drawn all the same. */
  'igniteAlways',
] as const;

export type StatId = (typeof STAT_IDS)[number];

/** Base values before any modifier (docs/GDD.md §3.1–3.4). */
export const BASE_STATS: Readonly<Record<StatId, number>> = {
  damage: 10,
  attackSpeed: 4,
  projectileCount: 2,
  critChance: 0.05,
  critMultiplier: 1.5,
  igniteChance: 0.1,
  // 1.5/s for 1.2 s: 180% of the hit, as before, but dealt before the swarm walks in.
  burnDamage: 1.5,
  burnDuration: 1.2,
  burnMaxStacks: 5,
  chainCount: 0,
  chainRetention: 0.7,
  chainRange: 260,
  maxLife: 100,
  projectileSpeed: 1400,
  shardGain: 1,
  coreGain: 1,
  critAlways: 0,
  igniteAlways: 0,
};

/**
 * M1 name of TAG (src/data/tags.ts), kept until the C3 wrap-up so M1 code reads unchanged.
 */
export const DAMAGE_TAG_BIT = TAG;

/**
 * Stats whose modifiers may carry tags, notTags, a scope and a scaling: their value depends on
 * the damage instance, so the simulation reads them from ModTable rows keyed by the instance's
 * tags and source (src/sim/build/modTable.ts). A row holds them in this order.
 */
export const SCOPED_STATS = [
  'damage',
  'critChance',
  'critMultiplier',
  'igniteChance',
  'critAlways',
  'igniteAlways',
] as const satisfies readonly StatId[];
export type ScopedStat = (typeof SCOPED_STATS)[number];

export const isScopedStat = (stat: StatId): stat is ScopedStat =>
  (SCOPED_STATS as readonly StatId[]).includes(stat);

/** Stats that force a roll's outcome rather than change its chance. */
export const ALWAYS_STATS = ['critAlways', 'igniteAlways'] as const satisfies readonly ScopedStat[];

export type ModifierKind = 'flat' | 'increased' | 'more';

/**
 * `flat` adds to the base, `increased` values add together, `more` values multiply:
 * final = (base + Σflat) × (1 + Σincreased) × Π(1 + more).
 * `value` is a fraction for increased/more (0.2 = 20%).
 * Only modifiers of SCOPED_STATS may carry tags, notTags, a scope or a scaling, and flat damage
 * never does: it stays in StatBlock.values.damage. An empty list counts as no list.
 */
export interface Modifier {
  readonly stat: StatId;
  readonly kind: ModifierKind;
  readonly value: number;
  /** Tags the damage instance must all carry. */
  readonly tags?: readonly DamageTag[];
  /** Tags the damage instance must not carry. */
  readonly notTags?: readonly DamageTag[];
  /** Sources the damage instance must be credited to (src/data/sources.ts). */
  readonly scope?: SourceSelector;
  /** The value counts per damage instance, scaled by one of its variables (src/data/triggers.ts). */
  readonly scaling?: ScalingSpec;
}

/**
 * A modifier that changes how hits play out rather than a number the player reads off the
 * stat list: tags on a stat other than damage, notTags, a scaling, or an ALWAYS_STATS stat. The
 * talent screen leaves it to its node's descKey text, which data validation requires.
 */
export function isBehaviourModifier(mod: Modifier): boolean {
  return (
    ((mod.tags?.length ?? 0) > 0 && mod.stat !== 'damage') ||
    (mod.notTags?.length ?? 0) > 0 ||
    mod.scaling !== undefined ||
    (ALWAYS_STATS as readonly StatId[]).includes(mod.stat)
  );
}

/**
 * Triggers and conversions of the allocated nodes, with their sources. The talent vocabulary
 * has none yet (see docs/v3/implementation-plan-v3.md §2.6–2.7).
 */
export interface StatExtras {
  readonly triggers: readonly never[];
  readonly conversions: readonly never[];
}

export const NO_EXTRAS: StatExtras = { triggers: [], conversions: [] };

/** Final stats handed to the simulation for one run. */
export interface StatBlock {
  /** Every stat before modifiers: BASE_STATS, or a test's overridden values. */
  readonly base: Readonly<Record<StatId, number>>;
  /**
   * Final value of every stat from its untagged, unscoped modifiers without a scaling. For
   * `damage` this is the untagged base (base + Σflat); damage increased/more modifiers count per
   * damage instance.
   */
  readonly values: Readonly<Record<StatId, number>>;
  /**
   * Every modifier of a scoped stat, untagged ones included, in data order. The simulation folds
   * them per tag mask and source into ModTable rows: damage of an instance = values.damage × its
   * damage row; another scoped stat of an instance is its row's value.
   */
  readonly scoped: readonly Modifier[];
  readonly triggers: StatExtras['triggers'];
  readonly conversions: StatExtras['conversions'];
}
