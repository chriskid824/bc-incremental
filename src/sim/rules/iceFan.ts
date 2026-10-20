/**
 * iceFan: 霜晶's attack as a signature emitter (src/sim/emitters/fan.ts). It fires 2.5 rounds a
 * second at the base attack speed, each round projectileCount + 3 cones (five at the base 2; the
 * fraction the chance of one more), spread evenly over 30° about the round's target: straight
 * shots of 40% of the damage stat, tagged hit, projectile and cold, that fly at projectileSpeed
 * for 2 s and each hit the first two enemies on their line. A round is one attack: its first cone
 * hit is the primary hit, whose chain follows. Its hits add 10% frost (the frostOnHit row, which
 * takes the center's cold hits, its chain jumps' too, as a jump keeps its element). Its forms,
 * 冰柱 and 稜鏡, are rules of their own that change its fan params (src/sim/rules/fanForms.ts).
 */

import type { SignatureSpec } from '../../data/rules';
import { TAG } from '../../data/tags';
import type { SignatureModule } from './module';

export const iceFan: SignatureModule<Extract<SignatureSpec, { id: 'iceFan' }>> = {
  id: 'iceFan',
  emitter: () => ({
    kind: 'fan',
    signature: true,
    source: 'center',
    damagePct: 0.4,
    tags: TAG.hit | TAG.projectile | TAG.cold,
    chains: true,
    rollsAilments: true,
    canCrit: true,
    baseRate: 2.5,
    spreadDeg: 30,
    pierce: 1,
    lifeTicks: 120,
  }),
  compile(b) {
    // A round fires projectileCount + 3 cones: five at the base projectileCount of 2.
    b.offsetStat('projectileCount', 3);
    // The center's cold hits: the cones' and their chains' (jumpMask keeps the element).
    b.addModifier({
      stat: 'frostOnHit',
      kind: 'flat',
      value: 0.1,
      scope: 'center',
      tags: ['cold'],
    });
    b.signature().fan = { icicleEvery: 0, icicleDamagePct: 0, prism: null };
  },
};
