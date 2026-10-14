/**
 * Keystone and notable rule changes. Rules are enumerated in code with typed parameters;
 * data files can only reference rules defined here (docs/ARCHITECTURE.md §4.4).
 * Each rule is a module of the simulation (src/sim/rules/). A change that modifiers can
 * express (a tagged chance, an *Always stat, a scaling, notTags) is data instead, like the
 * bridge notables and Searing Crits, and so is one that triggers can express, like Pandemic's
 * spread on death (src/data/talents.ts).
 */

export type RuleSpec =
  /**
   * Every Nth shot crits, or every shot of every Nth attack (counts); no random crits; crit
   * multiplier gets an extra more multiplier.
   */
  | {
      readonly id: 'steadyAim';
      readonly everyNth: number;
      readonly critMultiplierMore: number;
      readonly counts: 'shot' | 'attack';
    }
  /** No burn stack cap; burn duration gets (1 + durationMore). */
  | { readonly id: 'eternalFlame'; readonly durationMore: number }
  /**
   * Chain count × chainCountMultiplier; chain retention reduced by retentionPenalty (absolute);
   * with chainMore, hits delivered by a chain ([chain, hit]) deal (1 + chainMore) more.
   */
  | {
      readonly id: 'overload';
      readonly chainCountMultiplier: number;
      readonly retentionPenalty: number;
      readonly chainMore?: number;
    }
  /** All damage gets (1 + damageMore); max life becomes 1. */
  | { readonly id: 'glassCannon'; readonly damageMore: number };

export type RuleId = RuleSpec['id'];

export const RULE_IDS: readonly RuleId[] = ['steadyAim', 'eternalFlame', 'overload', 'glassCannon'];

/**
 * A character's signature attack: the emitter at index 0 of the run (src/sim/rules/, SIGNATURES),
 * one member per signature, with its parameters.
 */
export type SignatureSpec =
  /** M1's volley of homing projectiles. */
  { readonly id: 'm1Volley' };

export type SignatureId = SignatureSpec['id'];

/** The signature attack of runs that name none (RunConfig.signature). */
export const M1_SIGNATURE: SignatureSpec = { id: 'm1Volley' };
