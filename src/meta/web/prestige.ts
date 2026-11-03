/**
 * A character's prestige (轉生; gd §7's row, gd §1.7, GDD §6): allowed once this cycle's best wave
 * reaches PRESTIGE_RULES.wave. It resets the character's owned nodes (fusion cores and ascendancy
 * nodes included), shards, cores and cycle best; keeps the all-time best wave and the runs; pays
 * floor((cycleBest − 25)^1.5) 迴響 into the wallet and the total earned; counts one more prestige
 * and frees the ascendancy choice (F10's chain is the first ascendancy node bought, so a new
 * cycle picks again, gd:229 「可以和上次選的不同」). 迴響 is kept (GDD §6), so the 迴響 spent on
 * the last cycle's ascendancy nodes comes back with them. The account is untouched: the legacy
 * rewards are B5's. Pure: returns a new progress and changes nothing it is given.
 */

import { ZERO } from '../../core/num';
import type { CharacterProgress } from './types';

/** gd:778 and GDD §6's numbers (初始值). */
export const PRESTIGE_RULES = {
  /** The cycle best wave a prestige needs (gd:229 「第 30 波可以轉生」). */
  wave: 30,
  /** 迴響 = floor((cycleBest − base)^exponent). */
  resonanceBase: 25,
  resonanceExponent: 1.5,
  /** All damage more per 迴響 ever earned, one independent term (GDD:174): 1 + 0.05 × earned. */
  damagePerResonance: 0.05,
} as const;

/** Whether `progress` may prestige now: this cycle's best wave ≥ PRESTIGE_RULES.wave. */
export function canPrestige(progress: CharacterProgress): boolean {
  return progress.cycleBest >= PRESTIGE_RULES.wave;
}

/** The 迴響 a prestige at `cycleBest` pays: floor((cycleBest − 25)^1.5), 0 at or below 25. */
export function prestigeResonance(cycleBest: number): number {
  const over = cycleBest - PRESTIGE_RULES.resonanceBase;
  return over > 0 ? Math.floor(Math.pow(over, PRESTIGE_RULES.resonanceExponent)) : 0;
}

/** The damage more the 迴響 earned gives (value of a `more` modifier): 0.05 × earned. */
export function resonanceDamageMore(resonanceEarned: number): number {
  return resonanceEarned > 0 ? PRESTIGE_RULES.damagePerResonance * resonanceEarned : 0;
}

/**
 * The prestige of `progress` (see the module comment). Throws when canPrestige refuses; callers
 * check first.
 */
export function prestige(progress: CharacterProgress): CharacterProgress {
  if (!canPrestige(progress)) {
    throw new Error(
      `prestige '${progress.character}': cycle best ${progress.cycleBest} below wave ${PRESTIGE_RULES.wave}`,
    );
  }
  const gained = prestigeResonance(progress.cycleBest);
  return {
    ...progress,
    ranks: {},
    wallet: {
      shards: ZERO,
      cores: 0,
      resonance: progress.wallet.resonance + progress.spent.resonance + gained,
    },
    spent: { shards: ZERO, cores: 0, resonance: 0 },
    cycleBest: 0,
    prestiges: progress.prestiges + 1,
    resonanceEarned: progress.resonanceEarned + gained,
    ascendancy: null,
  };
}
