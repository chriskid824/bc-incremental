/**
 * 熔核's ascendancy rules (docs/v3/game-design-v3.md §1.2; B2):
 * - pyreChain (連環焚燒, 焚化者's final): 焚屍 is data, a kill trigger whose effects detonate the
 *   victim's burn around it, and as any trigger it never fires on its own kills (rule 3). This
 *   hook fires its detonation for it on the burning enemies that detonation kills, with what each
 *   had left, so the chain goes 焚屍 → this → 焚屍 …: the hook's kills are no 焚屍 kills, and the
 *   data trigger takes them. It counts a link at each of its own detonations and stops once the
 *   killing damage is `depth` links deep (kill depth < 2 × depth). The trigger depth cap
 *   (MAX_DEPTH 3) ends a chain first: today a kill of depth 3 queues nothing, so the chain is
 *   焚屍, this, 焚屍 at most, whatever `depth` allows.
 * - zoneTune (熔流, 灼地, 火海; 煉獄): the bombs' fire zones' duration, damage a second and radius
 *   factors (LobParams.zone), read where a bomb lands (src/sim/emitters/lob.ts).
 */

import type { RuleSpec } from '../../data/rules';
import { TRIGGER_EVENTS } from '../../data/triggers';
import { remainingOf } from '../ailments/remaining';
import { heldFlag } from '../effects/flags';
import { enqueueModuleEffect } from './api';
import { lobParams } from './lobForms';
import type { RuleModule } from './module';

const KILL = TRIGGER_EVENTS.indexOf('kill');
const BURNING = heldFlag('burn');
const UNKNOWN = 0;
const NOT_PYRE = 1;

export const pyreChain: RuleModule<Extract<RuleSpec, { id: 'pyreChain' }>> = {
  id: 'pyreChain',
  compile(b, specs) {
    const spec = specs[0];
    if (spec === undefined) return;
    const maxDepth = 2 * spec.depth;
    // Per trigger index: UNKNOWN, NOT_PYRE, or its detonate effect's index + 2. Made at the first
    // kill of a run, then only read.
    let pyre: Int32Array | null = null;
    const trigger = b.hook('onKill', (ctx, victim, kill) => {
      const origin = kill.origin;
      if (origin < 0 || (kill.flags & BURNING) === 0 || kill.depth >= maxDepth) return;
      const triggers = ctx.build.triggers;
      pyre ??= new Int32Array(triggers.length);
      let mark = pyre[origin] as number;
      if (mark === UNKNOWN) {
        mark = NOT_PYRE;
        const t = triggers[origin];
        if (t !== undefined && t.on === KILL) {
          for (let i = t.effectStart; i < t.effectEnd; i++) {
            const fx = ctx.build.effects[i];
            const s = fx?.spec;
            if (s?.kind === 'detonate' && s.ailment === 'burn' && (fx?.radiusSq ?? 0) > 0) {
              mark = i + 2;
              break;
            }
          }
        }
        pyre[origin] = mark;
      }
      if (mark === NOT_PYRE) return;
      enqueueModuleEffect(ctx, trigger, mark - 2, kill, remainingOf(ctx, victim, 'burn'));
    });
  },
};

export const zoneTune: RuleModule<Extract<RuleSpec, { id: 'zoneTune' }>> = {
  id: 'zoneTune',
  compile(b, specs) {
    const zone = lobParams(b, 'zoneTune').zone;
    for (const spec of specs) {
      zone.durationMult *= spec.durationMult;
      zone.damageMult *= spec.damageMult;
      zone.radiusMult *= spec.radiusMult;
    }
  },
};
