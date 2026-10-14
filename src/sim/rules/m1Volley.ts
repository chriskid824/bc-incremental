/**
 * m1Volley: M1's attack as a signature emitter. Volleys of homing projectiles, each a center hit
 * of the full damage stat tagged hit and projectile, that chain, roll crits and ignite
 * (src/sim/emitters/volley.ts).
 */

import type { SignatureSpec } from '../../data/rules';
import { TAG } from '../../data/tags';
import type { SignatureModule } from './module';

export const m1Volley: SignatureModule<Extract<SignatureSpec, { id: 'm1Volley' }>> = {
  id: 'm1Volley',
  emitter: () => ({
    kind: 'volley',
    signature: true,
    source: 'center',
    damagePct: 1,
    tags: TAG.hit | TAG.projectile,
    chains: true,
    rollsAilments: true,
    canCrit: true,
  }),
};
