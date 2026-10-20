/**
 * triphaseArc: 雷塔's attack as a signature emitter (src/sim/emitters/arc.ts). It discharges 3
 * times a second at the base attack speed, once per coil, at the volley's pick of target at any
 * range: a center hit of 100% of the damage stat, tagged hit, chain and lightning, its primary
 * hit, and at once its chain, whose jumps raise the chainJump center event. Every one of its
 * hits, the primary included, is a lightning chain hit, so each takes what chain hits take, and
 * each shocks (the shockAlways row, which takes the center's lightning hits); it chains 2 jumps
 * more than the chain count says. Its form, 六線圈, is a rule of its own that changes its arc
 * params (src/sim/rules/sixCoils.ts).
 */

import type { SignatureSpec } from '../../data/rules';
import { TAG } from '../../data/tags';
import type { ArcSpec } from '../emitters/types';
import type { SignatureModule } from './module';

export const triphaseArc: SignatureModule<Extract<SignatureSpec, { id: 'triphaseArc' }>> = {
  id: 'triphaseArc',
  emitter: arcSpec,
  compile(b) {
    // Two jumps more than the chain count says (D5).
    b.offsetStat('chainCount', 2);
    // The center's lightning hits: the discharges' and their jumps' (jumpMask keeps the element).
    b.addModifier({
      stat: 'shockAlways',
      kind: 'flat',
      value: 1,
      scope: 'center',
      tags: ['lightning'],
    });
    // The run reads its coil count here (ArcParams.coils), which 六線圈 may change.
    b.signature().arc = { coils: arcSpec().coils, targets: 1, damageMult: 1 };
  },
};

/** The arc's emitter: three coils, a discharge a second from each at the base attack speed. */
function arcSpec(): ArcSpec {
  return {
    kind: 'arc',
    signature: true,
    source: 'center',
    damagePct: 1,
    tags: TAG.hit | TAG.chain | TAG.lightning,
    chains: true,
    rollsAilments: true,
    canCrit: true,
    coils: 3,
  };
}
