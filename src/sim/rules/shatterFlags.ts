/**
 * 霜晶's two shatter notables (docs/v3/game-design-v3.md §5.1 碎裂 branch), on E6's build flags:
 * - shatterChain (◆連鎖碎裂): an enemy a shatter kills shatters too, frozen or not
 *   (BuildFlags.shatterChain, src/sim/effects/dispatch.ts caps the chain's depth).
 * - frozenNoSplit (◆粉碎): an enemy that dies frozen does not split (BuildFlags.frozenNoSplit).
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const shatterChain: RuleModule<Extract<RuleSpec, { id: 'shatterChain' }>> = {
  id: 'shatterChain',
  compile(b) {
    b.flags.shatterChain = true;
  },
};

export const frozenNoSplit: RuleModule<Extract<RuleSpec, { id: 'frozenNoSplit' }>> = {
  id: 'frozenNoSplit',
  compile(b) {
    b.flags.frozenNoSplit = true;
  },
};
