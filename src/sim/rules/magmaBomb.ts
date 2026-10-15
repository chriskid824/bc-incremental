/**
 * magmaBomb: 熔核's attack as a signature emitter (src/sim/emitters/lob.ts). It fires 1.5 times a
 * second at the base attack speed, each firing projectileCount − 1 bombs (one at the base 2; the
 * fraction the chance of one more), each its own attack. A bomb lands 24 ticks later by a
 * crowded spot and explodes: a center hit of 150% of the damage stat, tagged hit, area and
 * projectile, on every enemy within 60, the one nearest the landing point its primary hit, whose
 * chain follows. Then it leaves a fire zone (火地) of 60 that deals 30% of the damage stat a
 * second for 1.5 s. Its explosion hits always ignite (the igniteAlways row), and so do its fire
 * zone's hits (ALWAYS_IGNITES on their payload), their rolls still drawn; its chain jumps, which
 * keep no area tag, roll the normal chance.
 */

import type { SignatureSpec } from '../../data/rules';
import { TAG } from '../../data/tags';
import type { SignatureModule } from './module';

export const magmaBomb: SignatureModule<Extract<SignatureSpec, { id: 'magmaBomb' }>> = {
  id: 'magmaBomb',
  emitter: () => ({
    kind: 'lob',
    signature: true,
    source: 'center',
    damagePct: 1.5,
    tags: TAG.hit | TAG.area | TAG.projectile,
    chains: true,
    rollsAilments: true,
    canCrit: true,
    baseRate: 1.5,
    radius: 60,
    flightTicks: 24,
    zone: { radius: 60, durationSec: 1.5, damagePctPerSec: 0.3 },
  }),
  compile(b) {
    // A firing throws projectileCount − 1 bombs: one at the base projectileCount of 2.
    b.offsetStat('projectileCount', -1);
    // The center's area hits but triggered ones: the explosions, not a trigger's explode.
    b.addModifier({
      stat: 'igniteAlways',
      kind: 'flat',
      value: 1,
      scope: 'center',
      tags: ['area'],
      notTags: ['trigger'],
    });
    b.signature().lob = { farThrowEvery: 0, volcano: null, chainBlast: null, zone: { slow: 0 } };
  },
};
