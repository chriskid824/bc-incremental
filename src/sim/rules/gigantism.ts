/**
 * gigantism (巨大化, docs/v3/game-design-v3.md:268): 「範圍、爆炸、投射物、無人機的大小 ×2；數量類
 * （投射物、冰錐、連鎖跳數、無人機）減半，一律無條件捨去，最少 1」. Its sizeMult multiplies
 * BuildFlags.sizeFactor, which compileBuild folds into the area factor every area radius is read
 * through (sizeOf, src/sim/build/size.ts), the bomb's and the drones' splash included, and which
 * the straight shots' hit radius reads (src/sim/systems/shots.ts); BuildFlags.halveCounts halves
 * the four counts where the run reads them (countOf). The first instance's sizeMult: a second one
 * doubles nothing again.
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const gigantism: RuleModule<Extract<RuleSpec, { id: 'gigantism' }>> = {
  id: 'gigantism',
  compile(b, specs) {
    const [spec] = specs;
    if (spec === undefined) return;
    b.flags.sizeFactor *= spec.sizeMult;
    b.flags.halveCounts = true;
  },
};
