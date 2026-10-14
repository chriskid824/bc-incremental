/**
 * eternalFlame: burn stacks are uncapped (BuildFlags.burnRings: burns live in DoT rings instead
 * of M1's capped records, src/sim/ailments/rings.ts), and burn duration gets the product of its
 * instances' (1 + durationMore).
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
