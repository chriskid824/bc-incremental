/**
 * ★子彈地獄 (the barrage outer's keystone, docs/v3/game-design-v3.md §4.11): the barrage rider
 * (E10a, src/sim/systems/barrage.ts) sends ×2 small shots and they bounce off the arena's edge
 * twice. The −40% damage is the node's own scoped modifier.
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const bulletHell: RuleModule<Extract<RuleSpec, { id: 'bulletHell' }>> = {
  id: 'bulletHell',
  compile(b, specs) {
    if (specs.length === 0) return;
    b.flags.barrage.countMult = 2;
    b.flags.barrage.bounce = 2;
  },
};
