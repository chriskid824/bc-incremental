/**
 * hemorrhage (大出血, the bleed outer's ★; docs/v3/game-design-v3.md §4.3): bleeds live in DoT
 * rings instead of the strongest-only slot, at most maxStacks live stacks an enemy
 * (BuildFlags.bleedRings, bleedMaxStacks; src/sim/ailments/rings.ts), and a moving enemy no longer
 * bleeds ×3 (bleedMoveMult 1). Of several instances, the largest cap, at most
 * BLEED_RING_MAX_STACKS, the rings' slots.
 */

import type { RuleSpec } from '../../data/rules';
import { BLEED_RING_MAX_STACKS } from '../ailments/rings';
import type { RuleModule } from './module';

export const hemorrhage: RuleModule<Extract<RuleSpec, { id: 'hemorrhage' }>> = {
  id: 'hemorrhage',
  compile(b, specs) {
    let cap = 0;
    for (const spec of specs) cap = Math.max(cap, spec.maxStacks);
    if (cap === 0) return;
    b.flags.bleedRings = true;
    b.flags.bleedMaxStacks = Math.min(BLEED_RING_MAX_STACKS, cap);
    b.flags.bleedMoveMult = 1;
  },
};
