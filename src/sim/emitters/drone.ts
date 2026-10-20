/**
 * The drone pool's layout (docs/v3 C5 design D1, D15, D16, §4.1): where a run's summons go,
 * placed once by createRunContext (src/sim/systems/context.ts) before the pool is built
 * (createDronePool, src/sim/systems/systemState.ts). Every drone emitter's drones become rows,
 * in emitter order, up to the run's summon cap (SUMMON_CAP, src/sim/caps.ts); the rows past it
 * are refused and counted. Drone k of an emitter's D docks at angle 2πk/D around the player, at
 * the dock radius, and picks first on tick 1 + (10k mod PICK_TICKS), so the launches stagger.
 * Draws nothing.
 */

import type { Rng } from '../../core/rng';
import { DRONE_DEFAULTS } from '../../data/emitters';
import type { CompiledBuild, SwarmParams } from '../build/compile';
import { sizeOf } from '../build/size';
import { PICK_TICKS } from '../caps';
import type { ChainPolicy, DroneLayout } from '../systems/systemState';
import { ARENA_HEIGHT, ARENA_WIDTH, DRONE_KIND_DRONE, TICK_RATE } from '../types';
import type { EmitterRuntime, Payload } from './types';

/** The player's position, which the docks are around (createRunContext). */
const CENTER_X = ARENA_WIDTH / 2;
const CENTER_Y = ARENA_HEIGHT / 2;

/**
 * The layout of `emitters`' drones in `build` under `summonCap`. A granted drone emitter's numbers
 * are DRONE_DEFAULTS' but for its spec's drones; the signature's, the swarm's at index 0, are its
 * SwarmParams (CompiledBuild.signature.swarm), its spec's counts unread. `rng` and `policy` are the
 * combat stream and the signature's compiled chain policy, which the turrets' payloads take from
 * C5.4 on.
 */
export function droneLayout(
  build: CompiledBuild,
  emitters: readonly EmitterRuntime[],
  summonCap: number,
  _rng: Rng,
  _policy: ChainPolicy | null,
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
  const turretPayload = new Array<Payload | null>(size).fill(null);
  let refused = 0;
  for (const em of emitters) {
    const spec = em.spec;
    if (spec.kind !== 'drone') continue;
    const i = em.index;
    // Emitter 0, a drone emitter, is the swarm: its rules change its SwarmParams in place.
    const swarm = i === 0 ? (build.signature.swarm as SwarmParams) : null;
    const params = swarm ?? DRONE_DEFAULTS;
    const drones = swarm === null ? spec.drones : swarm.drones;
    for (let k = 0; k < drones; k++) {
      if (kind.length >= summonCap) {
        refused++;
        continue;
      }
      const angle = (2 * Math.PI * k) / drones;
      kind.push(DRONE_KIND_DRONE);
      owner.push(i);
      seat.push(k);
      x.push(CENTER_X + DRONE_DEFAULTS.dockRadius * Math.cos(angle));
      y.push(CENTER_Y + DRONE_DEFAULTS.dockRadius * Math.sin(angle));
      firstPick.push(1 + ((10 * k) % PICK_TICKS));
    }
    stepBase[i] = params.speed / TICK_RATE;
    dockTicks[i] = params.dockSec * TICK_RATE;
    coolTicks[i] = params.cooldownSec * TICK_RATE;
    impacts[i] = params.impacts;
    const splash = sizeOf(build, params.splash);
    splashSq[i] = splash * splash;
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
    turretPayload,
  };
}
