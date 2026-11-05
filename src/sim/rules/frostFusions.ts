/**
 * 霜晶's hand fusion cores (docs/v3/game-design-v3.md §5.2; B3), on the freeze center event,
 * which any frost raises (rule 8's exception), and whose fusion listeners run for at most
 * FREEZE_PAYLOADS freezes a second (src/sim/effects/centerEvents.ts). Each compiles data
 * triggers credited to its fusion board, from a spec the fusion's coefficient already scaled
 * (RULE_COEF_FIELDS). A compile error in a run of another signature.
 * - thermalShock (冰火「熱震」): a freeze ignites burnStacks on the frozen enemy (a status, so it
 *   fans out over the freeze's list); a frozen enemy that is ignited takes one hit of hitPct of
 *   the damage stat, then thaws (「並解凍」, E6's thaw): the hit lands on the frozen enemy first.
 * - superconduct (冰雷「超導」): a freeze sends `arcs` bolts (1-3, E7), one each to the nearest other
 *   enemies, drawn from the frozen one (arcDamagePct each, 1 shock stack), and the `arcs` enemies nearest it gain
 *   frostPct chill; a shocked enemy gains shockFrostMore more frost (BuildFlags.frostGainShocked, E6).
 * - frostSentry (冰靈「冰晶哨」): a shatter leaves, with `chance`, a timed sentry for lifeSec that
 *   shoots cones (damagePct a shot), at most maxLive at once. TODO(engine B3): the engine has no
 *   standing summon that shoots yet; until it lands the sentry is a timed drone (spawnDrone) of
 *   `shots` impacts that dashes at the nearest enemy.
 */

import type { RuleSpec } from '../../data/rules';
import type { BuildCompiler, RuleModule } from './module';

/** A compile error for a rule of 霜晶's in a run of another signature, as fanParams' is. */
function iceOnly(b: BuildCompiler, rule: RuleSpec['id']): void {
  const signature = b.signature();
  if (signature.fan === null) {
    throw new Error(
      `rule '${rule}' needs the iceFan signature, but this run's signature is '${signature.id}'`,
    );
  }
}

export const thermalShock: RuleModule<Extract<RuleSpec, { id: 'thermalShock' }>> = {
  id: 'thermalShock',
  compile(b, specs) {
    iceOnly(b, 'thermalShock');
    const { name } = b.credit();
    for (const spec of specs) {
      b.addTrigger(name, {
        on: 'freeze',
        do: [{ kind: 'applyAilment', ailment: 'burn', stacks: spec.burnStacks }],
      });
      b.addTrigger(name, {
        on: 'ailmentApplied',
        when: [{ ailment: 'burn' }, { targetHas: 'frozen' }],
        do: [
          {
            kind: 'explode',
            radius: 1,
            maxTargets: 1,
            order: 'nearest',
            damagePct: spec.hitPct,
          },
          { kind: 'thaw' },
        ],
      });
    }
  },
};

export const superconduct: RuleModule<Extract<RuleSpec, { id: 'superconduct' }>> = {
  id: 'superconduct',
  compile(b, specs) {
    iceOnly(b, 'superconduct');
    const { name } = b.credit();
    for (const spec of specs) {
      b.addTrigger(name, {
        on: 'freeze',
        do: [
          {
            kind: 'chainBolt',
            from: 'nearestOther',
            bolts: spec.arcs,
            jumps: 0,
            arc: true,
            damagePct: spec.arcDamagePct,
            shockStacks: 1,
          },
          {
            kind: 'addFrost',
            amount: spec.frostPct,
            radius: b.values.chainRange,
            maxTargets: spec.arcs,
            order: 'nearest',
          },
        ],
      });
      b.flags.frostGainShocked = Math.max(b.flags.frostGainShocked, spec.shockFrostMore);
    }
  },
};

export const frostSentry: RuleModule<Extract<RuleSpec, { id: 'frostSentry' }>> = {
  id: 'frostSentry',
  compile(b, specs) {
    iceOnly(b, 'frostSentry');
    const { name } = b.credit();
    for (const spec of specs) {
      b.addTrigger(name, {
        on: 'shatter',
        when: [{ chance: spec.chance }],
        do: [
          {
            kind: 'spawnDrone',
            lifeSec: spec.lifeSec,
            impacts: spec.shots,
            damagePct: spec.damagePct,
            maxLive: spec.maxLive,
            element: 'cold',
            tags: ['trigger'],
          },
        ],
      });
    }
  },
};
