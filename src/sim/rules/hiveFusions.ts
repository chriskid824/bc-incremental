/**
 * 蜂巢's hand fusion cores (docs/v3/game-design-v3.md §5.2; B2), both on the droneImpact center
 * event, which only the swarm's impacts raise. Each compiles data triggers credited to its
 * fusion board, from a spec the fusion's coefficient already scaled (RULE_COEF_FIELDS).
 * - flameBee (火召喚「焰蜂」): every impact ignites burnStacks on its target; a burning enemy a
 *   signature hit kills explodes around it (blastRadius, blastDamagePct of the damage stat). The
 *   docs' 「被無人機打死」 reads as hitIs 'signature' (the C5 design's option a): on the hive the
 *   swarm's turret shots and chain jumps count too; a burn tick's kill is no hit and does not.
 * - frostBee (冰召喚「霜蜂」): every impact adds frostPct chill to its target; an impact on a
 *   frozen enemy that is no boss executes it, and the kill while frozen is its shatter. Its
 *   conditions are read when the impact raises the event, so the impact that freezes an enemy
 *   does not shatter it too.
 */

import type { RuleSpec } from '../../data/rules';
import { swarmParams } from './hive';
import type { RuleModule } from './module';

export const flameBee: RuleModule<Extract<RuleSpec, { id: 'flameBee' }>> = {
  id: 'flameBee',
  compile(b, specs) {
    swarmParams(b, 'flameBee');
    const { name } = b.credit();
    for (const spec of specs) {
      b.addTrigger(name, {
        on: 'droneImpact',
        do: [{ kind: 'applyAilment', ailment: 'burn', stacks: spec.burnStacks }],
      });
      b.addTrigger(name, {
        on: 'kill',
        when: [{ hitIs: 'signature' }, { victimHas: 'burn' }],
        do: [{ kind: 'explode', radius: spec.blastRadius, damagePct: spec.blastDamagePct }],
      });
    }
  },
};

export const frostBee: RuleModule<Extract<RuleSpec, { id: 'frostBee' }>> = {
  id: 'frostBee',
  compile(b, specs) {
    swarmParams(b, 'frostBee');
    const { name } = b.credit();
    for (const spec of specs) {
      b.addTrigger(name, {
        on: 'droneImpact',
        do: [{ kind: 'addFrost', amount: spec.frostPct }],
      });
      for (const kind of ['normal', 'elite'] as const) {
        b.addTrigger(name, {
          on: 'droneImpact',
          when: [{ targetHas: 'frozen' }, { targetKind: kind }],
          do: [{ kind: 'execute' }],
        });
      }
    }
  },
};
