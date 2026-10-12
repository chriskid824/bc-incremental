/**
 * Compiles keystone and notable rules (src/data/rules.ts) into the numbers the simulation
 * reads each hit. Multipliers from several rules multiply; chances add.
 */

import type { RuleSpec } from '../data/rules';

export interface RuleEffects {
  /** Crits always ignite (critsAlwaysIgnite). */
  readonly critsAlwaysIgnite: boolean;
  /** Multiplier on non-crit hit damage. */
  readonly nonCritHitMult: number;
  /** Every Nth shot crits and random crits are off; 0 when steadyAim is not taken. */
  readonly steadyAimEvery: number;
  /** Extra multiplier on the crit multiplier. */
  readonly critMultiplierMult: number;
  /** Burn spreads on death within this radius; 0 when pandemic is not taken. */
  readonly pandemicRadius: number;
  /** Damage of a spread stack relative to its source stack. */
  readonly pandemicEffect: number;
  /** Multiplier on hit damage (crit or not; burn excluded). */
  readonly hitMult: number;
  /** Burn stacks are uncapped (eternalFlame). */
  readonly burnUncapped: boolean;
  readonly burnDurationMult: number;
  readonly chainCountMult: number;
  /** Subtracted from chain retention (absolute). */
  readonly chainRetentionPenalty: number;
  /** Multiplier on all damage, hits and burns. */
  readonly allDamageMult: number;
  /** Max life override (glassCannon), or null. */
  readonly maxLife: number | null;
  readonly critIgniteChance: number;
  readonly chainIgniteChance: number;
  readonly chainCritPerJump: number;
}

export const NO_RULES: RuleEffects = {
  critsAlwaysIgnite: false,
  nonCritHitMult: 1,
  steadyAimEvery: 0,
  critMultiplierMult: 1,
  pandemicRadius: 0,
  pandemicEffect: 0,
  hitMult: 1,
  burnUncapped: false,
  burnDurationMult: 1,
  chainCountMult: 1,
  chainRetentionPenalty: 0,
  allDamageMult: 1,
  maxLife: null,
  critIgniteChance: 0,
  chainIgniteChance: 0,
  chainCritPerJump: 0,
};

export function compileRules(rules: readonly RuleSpec[]): RuleEffects {
  const fx = { ...NO_RULES } as { -readonly [K in keyof RuleEffects]: RuleEffects[K] };
  for (const rule of rules) {
    switch (rule.id) {
      case 'critsAlwaysIgnite':
        fx.critsAlwaysIgnite = true;
        fx.nonCritHitMult *= 1 + rule.nonCritHitMore;
        break;
      case 'steadyAim':
        fx.steadyAimEvery =
          fx.steadyAimEvery === 0 ? rule.everyNth : Math.min(fx.steadyAimEvery, rule.everyNth);
        fx.critMultiplierMult *= 1 + rule.critMultiplierMore;
        break;
      case 'pandemic':
        fx.pandemicRadius = Math.max(fx.pandemicRadius, rule.spreadRadius);
        fx.pandemicEffect = Math.max(fx.pandemicEffect, rule.spreadEffect);
        fx.hitMult *= 1 + rule.hitMore;
        break;
      case 'eternalFlame':
        fx.burnUncapped = true;
        fx.burnDurationMult *= 1 + rule.durationMore;
        break;
      case 'overload':
        fx.chainCountMult *= rule.chainCountMultiplier;
        fx.chainRetentionPenalty += rule.retentionPenalty;
        break;
      case 'glassCannon':
        fx.allDamageMult *= 1 + rule.damageMore;
        fx.maxLife = 1;
        break;
      case 'critIgniteChance':
        fx.critIgniteChance += rule.chance;
        break;
      case 'chainIgniteChance':
        fx.chainIgniteChance += rule.chance;
        break;
      case 'chainCritChance':
        fx.chainCritPerJump += rule.perJump;
        break;
    }
  }
  return fx;
}
