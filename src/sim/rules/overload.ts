/**
 * overload: chain count × the product of the instances' multipliers, chain retention minus the
 * sum of their penalties (the simulation clamps it to [0, 1]), and with chainMore a damage more
 * on hits delivered by a chain ([chain, hit]: chain jumps, never a primary projectile hit or a
 * burn). The M1 node has no chainMore; its ×4.5 is a modifier on every hit (src/data/talents.ts).
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const overload: RuleModule<Extract<RuleSpec, { id: 'overload' }>> = {
  id: 'overload',
  compile(b, specs) {
    let chainCount = 1;
    let penalty = 0;
    for (const spec of specs) {
      chainCount *= spec.chainCountMultiplier;
      penalty += spec.retentionPenalty;
      if (spec.chainMore !== undefined) {
        b.addModifier({
          stat: 'damage',
          kind: 'more',
          value: spec.chainMore,
          tags: ['chain', 'hit'],
        });
      }
    }
    b.scaleStat('chainCount', chainCount);
    b.offsetStat('chainRetention', -penalty);
  },
};
