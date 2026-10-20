/**
 * The fan's forms: rules that tune iceFan's parameters (FanParams, src/sim/build/compile.ts; the
 * fan itself is src/sim/emitters/fan.ts). Each writes its member of the signature's fan
 * parameters, so in a run of another signature, whose fan parameters are null, it is a compile
 * error naming that signature.
 * - icicle (冰柱): every Nth round counted fires one cone of damagePct of the damage stat at its
 *   target instead; of several instances, the smallest N and the first instance's damagePct.
 * - prism (稜鏡): every round fires one cone at its target that passes through every enemy on
 *   its line, its hits scaled up by the enemies it passed; the first instance's.
 */

import type { RuleSpec } from '../../data/rules';
import type { FanParams } from '../build/compile';
import type { BuildCompiler, RuleModule } from './module';

/** The signature's fan parameters, or the error a form in a run of another signature is. */
function fanParams(b: BuildCompiler, rule: RuleSpec['id']): FanParams {
  const signature = b.signature();
  if (signature.fan === null) {
    throw new Error(
      `rule '${rule}' tunes the iceFan signature, but this run's signature is '${signature.id}'`,
    );
  }
  return signature.fan;
}

export const icicle: RuleModule<Extract<RuleSpec, { id: 'icicle' }>> = {
  id: 'icicle',
  compile(b, specs) {
    const fan = fanParams(b, 'icicle');
    const [first] = specs;
    if (first === undefined) return;
    fan.icicleDamagePct = first.damagePct;
    for (const spec of specs) {
      if (fan.icicleEvery === 0 || spec.every < fan.icicleEvery) fan.icicleEvery = spec.every;
    }
  },
};

export const prism: RuleModule<Extract<RuleSpec, { id: 'prism' }>> = {
  id: 'prism',
  compile(b, specs) {
    const fan = fanParams(b, 'prism');
    const [spec] = specs;
    if (spec === undefined) return;
    fan.prism = { perPierce: spec.perPierce, maxBonus: spec.maxBonus };
  },
};
