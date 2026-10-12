/**
 * Keystone and ascendancy rule changes. Rules are enumerated in code with typed parameters;
 * data files can only reference rules defined here (docs/ARCHITECTURE.md §4.4).
 * M0 defines the vocabulary; the simulation implements rules from M1 onward.
 */

export type RuleSpec =
  /** Crits always ignite; non-crit hit damage is multiplied by (1 + nonCritHitMore). */
  | { readonly id: 'critsAlwaysIgnite'; readonly nonCritHitMore: number }
  /** Every Nth attack crits, no random crits; crit multiplier gets an extra more multiplier. */
  | { readonly id: 'steadyAim'; readonly everyNth: number; readonly critMultiplierMore: number }
  /** Burning enemies spread their burn on death; hit damage gets (1 + hitMore). */
  | { readonly id: 'pandemic'; readonly spreadRadius: number; readonly hitMore: number }
  /** No burn stack cap; burn duration gets (1 + durationMore). */
  | { readonly id: 'eternalFlame'; readonly durationMore: number }
  /** Chain count × chainCountMultiplier; chain retention reduced by retentionPenalty (absolute). */
  | {
      readonly id: 'overload';
      readonly chainCountMultiplier: number;
      readonly retentionPenalty: number;
    }
  /** All damage gets (1 + damageMore); max life becomes 1. */
  | { readonly id: 'glassCannon'; readonly damageMore: number };

export type RuleId = RuleSpec['id'];

export const RULE_IDS: readonly RuleId[] = [
  'critsAlwaysIgnite',
  'steadyAim',
  'pandemic',
  'eternalFlame',
  'overload',
  'glassCannon',
];
