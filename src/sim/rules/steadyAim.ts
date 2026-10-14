/**
 * steadyAim: every Nth shot crits, or every shot of every Nth attack (the signature attack's
 * forceCritEvery and counts, from the instance with the smallest N, the first on ties), random
 * crits are off, and the crit multiplier gets the product of its extra more multipliers after
 * every modifier, as M1 multiplied it per hit.
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const steadyAim: RuleModule<Extract<RuleSpec, { id: 'steadyAim' }>> = {
  id: 'steadyAim',
  compile(b, specs) {
    let every = 0;
    let counts: 'shot' | 'attack' = 'shot';
    let critMultiplier = 1;
    for (const spec of specs) {
      if (every === 0 || spec.everyNth < every) {
        every = spec.everyNth;
        counts = spec.counts;
      }
      critMultiplier *= 1 + spec.critMultiplierMore;
    }
    b.flags.randomCrits = false;
    const signature = b.signature();
    signature.forceCritEvery = every;
    signature.counts = counts;
    b.scaleStat('critMultiplier', critMultiplier);
  },
};
