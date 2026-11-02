/**
 * frostflame (霜焰, 熔核's 火冰 hand core; docs/v3/game-design-v3.md §5.2): each explosion of the
 * magma bombs adds frostPct chill to the enemies it hit (an explode trigger, fanned out over the
 * explosion's list); an enemy holding frost can carry burnCapBonus more burn stacks than the
 * records cap (BuildFlags.frostBurnCap, read by burnCapOf; under eternalFlame's rings the cap
 * stays BURN_RINGS_MAX_STACKS); and the bombs' fire zones become frost-fire zones that slow the
 * enemies in them by zoneSlow (LobParams.zone.slow). Instances: the frost and the cap bonus add
 * up, the slow takes the largest. A compile error in a run of another signature.
 */

import type { RuleSpec } from '../../data/rules';
import { lobParams } from './lobForms';
import type { RuleModule } from './module';

export const frostflame: RuleModule<Extract<RuleSpec, { id: 'frostflame' }>> = {
  id: 'frostflame',
  compile(b, specs) {
    const lob = lobParams(b, 'frostflame');
    const { name } = b.credit();
    let frost = 0;
    let cap = 0;
    let slow = 0;
    for (const spec of specs) {
      frost += spec.frostPct;
      cap += spec.burnCapBonus;
      slow = Math.max(slow, spec.zoneSlow);
    }
    if (frost > 0) {
      b.addTrigger(name, { on: 'explode', do: [{ kind: 'addFrost', amount: Math.min(1, frost) }] });
    }
    b.flags.frostBurnCap += Math.floor(cap);
    lob.zone.slow = Math.max(lob.zone.slow, Math.min(1, slow));
  },
};
