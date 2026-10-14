/**
 * steadyAim: every Nth shot crits (the signature attack's forceCritEvery, the smallest N of its
 * instances), random crits are off, and the crit multiplier gets the product of its extra more
 * multipliers after every modifier, as M1 multiplied it per hit.
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const steadyAim: RuleModule<Extract<RuleSpec, { id: 'steadyAim' }>> = {
  id: 'steadyAim',
  compile(b, specs) {
    let every = 0;
    let critMultiplier = 1;
    for (const spec of specs) {
      every = every === 0 ? spec.everyNth : Math.min(every, spec.everyNth);
      critMultiplier *= 1 + spec.critMultiplierMore;
    }
    b.flags.randomCrits = false;
    b.signature().forceCritEvery = every;
    b.scaleStat('critMultiplier', critMultiplier);
  },
};
