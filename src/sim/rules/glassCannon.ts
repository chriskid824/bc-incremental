/**
 * glassCannon: every damage instance, hits and burns alike, gets (1 + damageMore) as an untagged
 * damage more of each instance, and max life becomes 1. Shatter, which takes no untagged more,
 * gets the same factor through BuildFlags.shatterMult.
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const glassCannon: RuleModule<Extract<RuleSpec, { id: 'glassCannon' }>> = {
  id: 'glassCannon',
  compile(b, specs) {
    for (const spec of specs) {
      b.addModifier({ stat: 'damage', kind: 'more', value: spec.damageMore });
      b.flags.shatterMult *= 1 + spec.damageMore;
    }
    b.flags.maxLife = 1;
  },
};
