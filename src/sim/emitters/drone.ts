/**
 * The drone pool's layout (docs/v3 C5 design D1, D15, D16, §4.1): where a run's summons go,
 * placed once by createRunContext (src/sim/systems/context.ts) before the pool is built
 * (createDronePool, src/sim/systems/systemState.ts). Every drone emitter's drones, then its
 * turrets, become rows, in emitter order, up to the run's summon cap (SUMMON_CAP,
 * src/sim/caps.ts); the rows past it are refused and counted. Drone k of an emitter's D docks at
 * angle 2πk/D around the player, at the dock radius, and picks first on tick 1 + (10k mod
 * PICK_TICKS), so the launches stagger. Turret j of its T sits in a seat at the turret radius, at
 * angle π/D + 2πj/T, between the drones, or 2πj/T when the emitter has no drone; a turret never
 * picks, so its row's first pick, by the same rule from j, is never read. An emitter's turrets
 * fire its turret payload (turretPayload, src/sim/emitters/types.ts). Draws nothing.
 */

import type { Rng } from '../../core/rng';
import { DRONE_DEFAULTS } from '../../data/emitters';
import type { CompiledBuild } from '../build/compile';
import { sizeOf } from '../build/size';
import { PICK_TICKS } from '../caps';
import type { ChainPolicy, DroneLayout } from '../systems/systemState';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_KIND_DRONE,
  DRONE_KIND_TURRET,
  TICK_RATE,
} from '../types';
import { turretPayload } from './types';
import type { EmitterRuntime, Payload } from './types';

/** The player's position, which the docks are around (createRunContext). */
const CENTER_X = ARENA_WIDTH / 2;
const CENTER_Y = ARENA_HEIGHT / 2;

/**
 * The layout of `emitters`' drones and turrets in `build` under `summonCap`. A granted drone
 * emitter's numbers are DRONE_DEFAULTS' but for its spec's counts and turret share; the
 * signature's, the swarm's at index 0, are its SwarmParams (CompiledBuild.signature.swarm), its
 * turret share included, its spec's counts and share unread. `rng` is the combat stream, which
 * the turret payloads roll on, and `policy` the signature's compiled chain policy, which only the
 * signature's turret payload takes, as only its emitter payload does.
 */
export function droneLayout(
  build: CompiledBuild,
  emitters: readonly EmitterRuntime[],
  summonCap: number,
  rng: Rng,
  policy: ChainPolicy | null,
): DroneLayout {
  const kind: number[] = [];
  const owner: number[] = [];
  const seat: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const firstPick: number[] = [];
  // Sized for every emitter once one is a drone emitter, so any emitter index reads an entry.
  const size = emitters.some((em) => em.spec.kind === 'drone') ? emitters.length : 0;
  const stepBase = new Array<number>(size).fill(0);
  const dockTicks = new Array<number>(size).fill(0);
  const coolTicks = new Array<number>(size).fill(0);
  const impacts = new Array<number>(size).fill(0);
  const splashSq = new Array<number>(size).fill(0);
  const turretPayloads = new Array<Payload | null>(size).fill(null);
  let refused = 0;
  /** Emitter `i`'s row of `rowKind`, seat `at`, at `angle` and `radius` around the player. */
  const place = (rowKind: number, i: number, at: number, angle: number, radius: number): void => {
    if (kind.length >= summonCap) {
      refused++;
      return;
    }
    kind.push(rowKind);
    owner.push(i);
    seat.push(at);
    x.push(CENTER_X + radius * Math.cos(angle));
    y.push(CENTER_Y + radius * Math.sin(angle));
    firstPick.push(1 + ((10 * at) % PICK_TICKS));
  };
  for (const em of emitters) {
    const spec = em.spec;
    if (spec.kind !== 'drone') continue;
    const i = em.index;
    // Emitter 0, a drone emitter, is the swarm: its rules change its SwarmParams in place.
    const swarm = i === 0 ? build.signature.swarm : null;
    const params = swarm ?? DRONE_DEFAULTS;
    const drones = swarm === null ? spec.drones : swarm.drones;
    const turrets = swarm === null ? spec.turrets : swarm.turrets;
    for (let k = 0; k < drones; k++) {
      place(DRONE_KIND_DRONE, i, k, (2 * Math.PI * k) / drones, DRONE_DEFAULTS.dockRadius);
    }
    // Between the drones; evenly from angle 0 without one, where π/D would be Infinity.
    const between = drones >= 1 ? Math.PI / drones : 0;
    for (let j = 0; j < turrets; j++) {
      const angle = between + (2 * Math.PI * j) / turrets;
      place(DRONE_KIND_TURRET, i, j, angle, DRONE_DEFAULTS.turretRadius);
    }
    stepBase[i] = params.speed / TICK_RATE;
    dockTicks[i] = params.dockSec * TICK_RATE;
    coolTicks[i] = params.cooldownSec * TICK_RATE;
    impacts[i] = params.impacts;
    const splash = sizeOf(build, params.splash);
    splashSq[i] = splash * splash;
    const share = swarm === null ? spec.turretDamagePct : swarm.turretDamagePct;
    turretPayloads[i] = turretPayload(build, spec, share, rng, i === 0 ? policy : null);
  }
  return {
    rows: kind.length,
    refused,
    summonCap,
    kind,
    owner,
    seat,
    x,
    y,
    firstPick,
    stepBase,
    dockTicks,
    coolTicks,
    impacts,
    splashSq,
    turretPayload: turretPayloads,
  };
}
