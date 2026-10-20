/**
 * The arc's form: a rule that tunes triphaseArc's parameters (ArcParams, src/sim/build/compile.ts;
 * the arc itself is src/sim/emitters/arc.ts). It writes the signature's arc parameters, so in a
 * run of another signature, whose arc parameters are null, it is a compile error naming that
 * signature.
 * - sixCoils (六線圈): `coils` discharges a second at the base attack speed, each at `targets`
 *   enemies, for damageMult × the arc's damage, which the arc's payload takes into its base
 *   damage; the first instance's.
 */

import type { RuleSpec } from '../../data/rules';
import type { ArcParams } from '../build/compile';
import type { BuildCompiler, RuleModule } from './module';

/** The signature's arc parameters, or the error a form in a run of another signature is. */
function arcParams(b: BuildCompiler, rule: RuleSpec['id']): ArcParams {
  const signature = b.signature();
  if (signature.arc === null) {
    throw new Error(
      `rule '${rule}' tunes the triphaseArc signature, but this run's signature is '${signature.id}'`,
    );
  }
  return signature.arc;
}

export const sixCoils: RuleModule<Extract<RuleSpec, { id: 'sixCoils' }>> = {
  id: 'sixCoils',
  compile(b, specs) {
    const arc = arcParams(b, 'sixCoils');
    const [spec] = specs;
    if (spec === undefined) return;
    arc.coils = spec.coils;
    // Validation keeps it to 1 or 2.
    arc.targets = spec.targets as 1 | 2;
    arc.damageMult = spec.damageMult;
  },
};
