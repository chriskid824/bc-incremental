/**
 * poisonSlow (神經毒, docs/v3/game-design-v3.md:389 「每 5 層毒減速 2%，最多 40%」; C4 design §11's
 * B1 row, I7; lead ruling H3): an enemy is slowed by slowPer for every stacksPer of its live
 * poison stacks, at most max. The module only writes BuildFlags.poisonSlowStacks, poisonSlowPer
 * and poisonSlowMax, the first instance's; enemySlow (src/sim/ailments/frost.ts) takes the term
 * as one more of its sources, the largest of which wins, and movement routes the run to its slow
 * path (src/sim/systems/movement.ts).
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const poisonSlow: RuleModule<Extract<RuleSpec, { id: 'poisonSlow' }>> = {
  id: 'poisonSlow',
  compile(b, specs) {
    const [spec] = specs;
    if (spec === undefined) return;
    b.flags.poisonSlowStacks = spec.stacksPer;
    b.flags.poisonSlowPer = spec.slowPer;
    b.flags.poisonSlowMax = spec.max;
  },
};
