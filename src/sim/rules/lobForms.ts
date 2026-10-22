/**
 * The lob's forms: rules that tune magmaBomb's parameters (LobParams, src/sim/build/compile.ts;
 * the lob itself is src/sim/emitters/lob.ts). Each writes its member of the signature's lob
 * parameters, so in a run of another signature, whose lob parameters are null, it is a compile
 * error naming that signature.
 * - farThrow (遠投): every Nth bomb counted is thrown at the farthest enemy in the arena; of
 *   several instances, the smallest N.
 * - volcano (火山): the lob fires on a period of its own, and its bombs are giant ones; the first
 *   instance's.
 * - chainBlast (連環爆): an enemy a bomb's explosion kills explodes too, at most perBomb of them a
 *   bomb; the first instance's. Its explosion is an explode effect (hit, trigger and area, no
 *   projectile) credited to the center, which the landing queues for the instance's trigger
 *   (instanceTrigger), so it is that trigger's damage.
 */

import type { RuleSpec } from '../../data/rules';
import type { LobParams } from '../build/compile';
import type { BuildCompiler, RuleModule } from './module';

/** The signature's lob parameters, or the error a form in a run of another signature is. */
function lobParams(b: BuildCompiler, rule: RuleSpec['id']): LobParams {
  const signature = b.signature();
  if (signature.lob === null) {
    throw new Error(
      `rule '${rule}' tunes the magmaBomb signature, but this run's signature is '${signature.id}'`,
    );
  }
  return signature.lob;
}

export const farThrow: RuleModule<Extract<RuleSpec, { id: 'farThrow' }>> = {
  id: 'farThrow',
  compile(b, specs) {
    const lob = lobParams(b, 'farThrow');
    for (const spec of specs) {
      if (lob.farThrowEvery === 0 || spec.every < lob.farThrowEvery) lob.farThrowEvery = spec.every;
    }
  },
};

export const volcano: RuleModule<Extract<RuleSpec, { id: 'volcano' }>> = {
  id: 'volcano',
  compile(b, specs) {
    const lob = lobParams(b, 'volcano');
    const [spec] = specs;
    if (spec === undefined) return;
    lob.volcano = {
      periodSec: spec.periodSec,
      radiusMult: spec.radiusMult,
      damageMult: spec.damageMult,
    };
  },
};

export const chainBlast: RuleModule<Extract<RuleSpec, { id: 'chainBlast' }>> = {
  id: 'chainBlast',
  compile(b, specs) {
    const lob = lobParams(b, 'chainBlast');
    const [spec] = specs;
    if (spec === undefined) return;
    lob.chainBlast = {
      radius: spec.radius,
      damagePct: spec.damagePct,
      perBomb: spec.perBomb,
      trigger: b.instanceTrigger(),
      // Credited to the center: a form sits on a center node (V5), so the center is its source.
      effect: b.addEffect('center', {
        kind: 'explode',
        radius: spec.radius,
        damagePct: spec.damagePct,
      }),
    };
  },
};
