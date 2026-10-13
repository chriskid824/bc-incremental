/**
 * Keystone and notable rule changes. Rules are enumerated in code with typed parameters;
 * data files can only reference rules defined here (docs/ARCHITECTURE.md §4.4).
 * The simulation compiles them in src/sim/rules.ts. A change that modifiers can express (a
 * tagged chance, an *Always stat, a scaling, notTags) is data instead, like the bridge notables
 * and Searing Crits (src/data/talents.ts).
 */

export type RuleSpec =
  /** Every Nth shot crits, no random crits; crit multiplier gets an extra more multiplier. */
  | { readonly id: 'steadyAim'; readonly everyNth: number; readonly critMultiplierMore: number }
  /**
   * Burning enemies spread their burns on death to enemies within spreadRadius, each spread
   * stack dealing spreadEffect × the source stack's damage; hit damage gets (1 + hitMore).
   */
  | {
      readonly id: 'pandemic';
      readonly spreadRadius: number;
      readonly spreadEffect: number;
      readonly hitMore: number;
    }
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
  'steadyAim',
  'pandemic',
  'eternalFlame',
  'overload',
  'glassCannon',
];
