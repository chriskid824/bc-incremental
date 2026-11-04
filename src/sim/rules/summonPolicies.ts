/**
 * The summon outer's policy rules (gd §4.10; C5.9's BuildFlags, src/sim/build/compile.ts): each
 * module only writes its flags, which the drone pool reads (src/sim/systems/drones.ts).
 * - lockBeacon (鎖定信標): summonEliteFirst.
 * - cannon (加農砲): turretRateMult × each instance's rateMult; turretSplash, the largest splash.
 * - teslaTower (特斯拉塔): turretChains + each instance's chains.
 * - bugSea (蟲海): droneCountMult, the largest countMult; dronesStay.
 */

import type { RuleSpec } from '../../data/rules';
import type { RuleModule } from './module';

export const lockBeacon: RuleModule<Extract<RuleSpec, { id: 'lockBeacon' }>> = {
  id: 'lockBeacon',
  compile(b, specs) {
    if (specs.length > 0) b.flags.summonEliteFirst = true;
  },
};

export const cannon: RuleModule<Extract<RuleSpec, { id: 'cannon' }>> = {
  id: 'cannon',
  compile(b, specs) {
    for (const spec of specs) {
      b.flags.turretRateMult *= spec.rateMult;
      b.flags.turretSplash = Math.max(b.flags.turretSplash, spec.splash);
    }
  },
};

export const teslaTower: RuleModule<Extract<RuleSpec, { id: 'teslaTower' }>> = {
  id: 'teslaTower',
  compile(b, specs) {
    for (const spec of specs) b.flags.turretChains += spec.chains;
  },
};

export const bugSea: RuleModule<Extract<RuleSpec, { id: 'bugSea' }>> = {
  id: 'bugSea',
  compile(b, specs) {
    if (specs.length === 0) return;
    b.flags.droneCountMult = Math.max(b.flags.droneCountMult, ...specs.map((s) => s.countMult));
    b.flags.dronesStay = true;
  },
};
