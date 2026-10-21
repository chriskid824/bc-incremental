/**
 * swarm: 蜂巢's attack as a signature emitter, a drone emitter (src/sim/systems/drones.ts). Its 3
 * drones dock around the player and fly out at the enemies farthest from it, 3 impacts a sortie:
 * each impact is a center hit of 200% of the damage stat, tagged hit, minion and area, on every
 * enemy within 40 of its target, the target its primary hit, whose chain follows; it is one
 * attack and one shot for steadyAim, and raises the droneImpact center event at its target. Its
 * turret sits between two drones and fires 2 times a second at the base attack speed, each firing
 * projectileCount − 1 homing shots of 80% of the damage stat, tagged hit, minion and projectile,
 * at the nearest enemies: a firing is one attack and each of its shots one shot for steadyAim,
 * and each shot's arrival is a primary hit, whose chain follows. The run reads its drones' and
 * turret's numbers from its SwarmParams (CompiledBuild.signature.swarm), which its rules change,
 * never from its emitter's spec.
 */

import type { SignatureSpec } from '../../data/rules';
import { TAG } from '../../data/tags';
import type { SignatureModule } from './module';

export const swarm: SignatureModule<Extract<SignatureSpec, { id: 'swarm' }>> = {
  id: 'swarm',
  emitter: () => ({
    kind: 'drone',
    signature: true,
    source: 'center',
    damagePct: 2,
    tags: TAG.hit | TAG.minion | TAG.area,
    chains: true,
    rollsAilments: true,
    canCrit: true,
    // DroneSpec's counts, which the run reads from SwarmParams instead (D17).
    drones: 3,
    turrets: 1,
    turretDamagePct: 0.8,
  }),
  compile(b) {
    // A turret's firing is projectileCount − 1 shots: one at the base projectileCount of 2 (F16).
    b.offsetStat('projectileCount', -1);
    b.signature().swarm = {
      drones: 3,
      turrets: 1,
      speed: 600,
      dockSec: 0.5,
      cooldownSec: 0.5,
      impacts: 3,
      splash: 40,
      turretDamagePct: 0.8,
    };
  },
};
