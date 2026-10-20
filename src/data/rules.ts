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
  | { readonly id: 'glassCannon'; readonly damageMore: number }
  /**
   * 遠投 (magmaBomb): every `every`th bomb is thrown at the farthest enemy in the arena instead
   * of a crowded spot. Of several instances, the smallest `every`.
   */
  | { readonly id: 'farThrow'; readonly every: number }
  /**
   * 火山 (magmaBomb): the bombs are thrown every periodSec at the base attack speed instead, each
   * of radiusMult × the radius (its fire zone too) and damageMult × the damage of its explosion
   * hits. The first instance's.
   */
  | {
      readonly id: 'volcano';
      readonly periodSec: number;
      readonly radiusMult: number;
      readonly damageMult: number;
    }
  /**
   * 連環爆 (magmaBomb): an enemy a bomb's explosion kills explodes too, at most perBomb of them a
   * bomb: radius and damagePct of the damage stat. The first instance's.
   */
  | {
      readonly id: 'chainBlast';
      readonly radius: number;
      readonly damagePct: number;
      readonly perBomb: number;
    }
  /**
   * 冰柱 (iceFan): every `every`th round fires one cone of damagePct of the damage stat at its
   * target instead of the fan. Of several instances, the smallest `every`; the first instance's
   * damagePct.
   */
  | { readonly id: 'icicle'; readonly every: number; readonly damagePct: number }
  /**
   * 稜鏡 (iceFan): every round fires one cone at its target that passes through every enemy on
   * its line; each enemy it passed adds perPierce to the factor of its later hits, at most
   * maxBonus. The first instance's.
   */
  | { readonly id: 'prism'; readonly perPierce: number; readonly maxBonus: number }
  /**
   * 六線圈 (triphaseArc): `coils` discharges a second at the base attack speed instead of three,
   * each at `targets` enemies (1 or 2; two distinct ones, picked before either is hit, share one
   * chain) for damageMult × its damage. The first instance's.
   */
  | {
      readonly id: 'sixCoils';
      readonly coils: number;
      readonly targets: number;
      readonly damageMult: number;
    };

export type RuleId = RuleSpec['id'];

export const RULE_IDS: readonly RuleId[] = [
  'steadyAim',
  'eternalFlame',
  'overload',
  'glassCannon',
  'farThrow',
  'volcano',
  'chainBlast',
  'icicle',
  'prism',
  'sixCoils',
];

/**
 * A character's signature attack: the emitter at index 0 of the run (src/sim/rules/, SIGNATURES),
 * one member per signature, with its parameters.
 */
export type SignatureSpec =
  /** M1's volley of homing projectiles. */
  | { readonly id: 'm1Volley' }
  /**
   * 熔核's magma bombs: lobbed at the most crowded spots, they explode where they land and each
   * leaves a fire zone (src/sim/emitters/lob.ts).
   */
  | { readonly id: 'magmaBomb' }
  /**
   * 霜晶's ice-cone fan: rounds of straight cones spread over 30° about the target, each through
   * two enemies, that chill what they hit (src/sim/emitters/fan.ts).
   */
  | { readonly id: 'iceFan' }
  /**
   * 雷塔's three-phase arc: discharges that strike the volley's pick of target at any range and
   * chain on from it at once, every hit a lightning chain hit that shocks, its three coils taking
   * turns (src/sim/emitters/arc.ts).
   */
  | { readonly id: 'triphaseArc' };

export type SignatureId = SignatureSpec['id'];

/** The signature attack of runs that name none (RunConfig.signature). */
export const M1_SIGNATURE: SignatureSpec = { id: 'm1Volley' };
