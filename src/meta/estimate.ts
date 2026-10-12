/**
 * Rough reach of a talent build, read off the master curve (docs/GDD.md §7.2). The start-wave
 * picker uses it so a respec or a weaker build does not keep a start wave it cannot clear
 * (docs/GDD.md §2.2). It is an estimate from one number, not a simulation.
 */

import { targetDamage } from '../data/curve';
import type { RuleSpec } from '../data/rules';
import { DAMAGE_TAG_BIT } from '../data/stats';
import type { StatBlock } from '../data/stats';
import type { GameData } from '../data/types';
import { compileRules } from '../sim/rules';
import { collectRules, statBlockFor } from './stats';
import type { EconomyConfig, MetaState } from './types';

export interface BuildEstimate {
  /** Effective damage per attack `D` (see effectiveDamage). */
  readonly damage: number;
  /** Highest wave whose target damage HP(F) ÷ hits-to-kill the build meets; at least 1. */
  readonly frontier: number;
  /**
   * Start wave the build should clear comfortably: the start wave a player whose frontier is
   * `frontier` may pick, max(1, floor(frontier × startWaveRatio)).
   */
  readonly startWave: number;
}

/** Search limit for the frontier, far past any reachable wave. */
const MAX_ESTIMATE_WAVE = 1000;

const HIT = DAMAGE_TAG_BIT.hit;
const CRIT = DAMAGE_TAG_BIT.crit;
const BURN = DAMAGE_TAG_BIT.burn;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Effective damage per attack `D` against one target (docs/GDD.md §7.2): the expected primary
 * hit including crits, plus the total burn that hit is expected to cause. Rules apply as the
 * simulation compiles them: steadyAim crits every Nth shot instead of randomly, glassCannon
 * doubles everything, pandemic and searingCrits cut hit damage. Ignores burn stack caps,
 * pandemic spread, extra projectiles and chains. Same formula as the balance simulator's
 * effectiveHit (tools/balance/session.ts).
 */
export function effectiveDamage(stats: StatBlock, rules: readonly RuleSpec[] = []): number {
  const { values, damageMult } = stats;
  const fx = compileRules(rules);
  const mult = (mask: number): number => damageMult[mask] as number;
  const critChance = fx.steadyAimEvery > 0 ? 1 / fx.steadyAimEvery : clamp01(values.critChance);
  const critFactor = critChance * values.critMultiplier * fx.critMultiplierMult;
  const hit =
    fx.hitMult * ((1 - critChance) * mult(HIT) * fx.nonCritHitMult + critFactor * mult(HIT | CRIT));
  const ignite = clamp01(values.igniteChance);
  const critIgnite = fx.critsAlwaysIgnite ? 1 : clamp01(ignite + fx.critIgniteChance);
  const burnPerDamage =
    (1 - critChance) * ignite * mult(BURN) + critFactor * critIgnite * mult(BURN | CRIT);
  const burn =
    values.burnDamage * Math.max(0, values.burnDuration * fx.burnDurationMult) * burnPerDamage;
  return values.damage * fx.allDamageMult * (hit + burn);
}

/** Highest wave F with targetDamage(F) ≤ damage, at least 1. Non-decreasing in damage. */
export function frontierFor(damage: number): number {
  let wave = 1;
  while (wave < MAX_ESTIMATE_WAVE && targetDamage(wave + 1) <= damage) wave++;
  return wave;
}

/** Estimate of the current talent allocation. */
export function estimateBuild(
  meta: Readonly<MetaState>,
  data: GameData,
  economy: EconomyConfig,
): BuildEstimate {
  const damage = effectiveDamage(statBlockFor(meta, data), collectRules(meta, data));
  const frontier = frontierFor(damage);
  return {
    damage,
    frontier,
    startWave: Math.max(1, Math.floor(frontier * economy.startWaveRatio)),
  };
}
