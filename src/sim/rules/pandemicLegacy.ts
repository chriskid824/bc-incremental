/**
 * pandemic as a rule module, until it becomes a data trigger (C3.7, which deletes this file):
 * a dying enemy's burns spread to the enemies within the largest radius of its instances, at the
 * largest effect, and hit damage gets the product of their (1 + hitMore) through
 * CompiledBuild.legacyHitMult.
 *
 * The spread must happen at the kill, before removeEnemy, as M1's did, so its onKill hook calls
 * spreadBurns itself. That is the one hook that changes the run directly rather than through
 * queued effects.
 */

import type { RuleSpec } from '../../data/rules';
import { spreadBurns } from '../systems/burn';
import type { BurnSpread } from '../systems/burn';
import type { RuleModule } from './module';

export const pandemicLegacy: RuleModule<Extract<RuleSpec, { id: 'pandemic' }>> = {
  id: 'pandemic',
  compile(b, specs) {
    let radius = 0;
    let effect = 0;
    let hitMult = 1;
    for (const spec of specs) {
      radius = Math.max(radius, spec.spreadRadius);
      effect = Math.max(effect, spec.spreadEffect);
      hitMult *= 1 + spec.hitMore;
    }
    b.legacyHitMult *= hitMult;
    const spread: BurnSpread = { radius, radiusSq: radius ** 2, effect };
    if (spread.radiusSq > 0) b.hook('onKill', (ctx, victim) => spreadBurns(ctx, victim, spread));
  },
};
