/**
 * eternalFlame: burn stacks are uncapped (BuildFlags.burnRings, which keeps M1's records with
 * the UNCAPPED_BURN_STACKS guard as their cap until burns move to rings), and burn duration gets
 * the product of its instances' (1 + durationMore).
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const eternalFlame: RuleModule<Extract<RuleSpec, { id: 'eternalFlame' }>> = {
  id: 'eternalFlame',
  compile(b, specs) {
    let duration = 1;
    for (const spec of specs) duration *= 1 + spec.durationMore;
    b.flags.burnRings = true;
    b.scaleStat('burnDuration', duration);
  },
};
