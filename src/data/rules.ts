/**
 * Keystone and notable rule changes. Rules are enumerated in code with typed parameters;
 * data files can only reference rules defined here (docs/ARCHITECTURE.md §4.4).
 * The simulation compiles them in src/sim/rules.ts.
 */

export type RuleSpec =
  /** Crits always ignite; non-crit hit damage is multiplied by (1 + nonCritHitMore). */
  | { readonly id: 'critsAlwaysIgnite'; readonly nonCritHitMore: number }
  /** Every Nth shot crits, no random crits; crit multiplier gets an extra more multiplier. */
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
  | { readonly id: 'glassCannon'; readonly damageMore: number }
  /** Notable (crit × burn): crits get `chance` extra ignite chance. */
  | { readonly id: 'critIgniteChance'; readonly chance: number }
  /** Notable (burn × chain): chain jumps get `chance` extra ignite chance. */
  | { readonly id: 'chainIgniteChance'; readonly chance: number }
  /** Notable (chain × crit): the nth chain jump gets n × perJump extra crit chance. */
  | { readonly id: 'chainCritChance'; readonly perJump: number };

export type RuleId = RuleSpec['id'];

export const RULE_IDS: readonly RuleId[] = [
  'critsAlwaysIgnite',
  'steadyAim',
  'pandemic',
  'eternalFlame',
  'overload',
  'glassCannon',
  'critIgniteChance',
  'chainIgniteChance',
  'chainCritChance',
];
