/**
 * The drone pool's layout (docs/v3 C5 design D1, D15, D16, §4.1): where a run's summons go,
 * placed once by createRunContext (src/sim/systems/context.ts) before the pool is built
 * (createDronePool, src/sim/systems/systemState.ts). Every drone emitter's drones, then its
 * turrets, become rows, in emitter order, up to the run's summon cap (SUMMON_CAP,
 * src/sim/caps.ts); the rows past it are refused and counted. Drone k of an emitter's D docks at
 * angle 2πk/D around the player, at the dock radius, and picks first on tick 1 + (10k mod
 * PICK_TICKS), so the launches stagger. Turret j of its T sits in a seat at the turret radius
 * (DRONE_DEFAULTS', or the swarm's SwarmParams.turretRadius: 前哨, E4), at angle π/D + 2πj/T,
 * between the drones, or 2πj/T when the emitter has no drone; a turret never picks, so its row's
 * first pick, by the same rule from j, is never read. An emitter's turrets fire its turret
 * payload (turretPayload, src/sim/emitters/types.ts). An emitter's drones are counted here, once
 * for the run: × 蟲海's droneCountMult, then through countOf (halved under 巨大化); its turrets
 * are neither. Its splash is sized (sizeOf) and its drones' step takes the droneSpeed stat, read
 * once as max(0, droneSpeed), as every timed row's does; their dock time and cooldown do not.
 * The turret shots' 加農砲 splash (sizeOf) and 特斯拉塔 jumps (countOf) are read here too, once
 * for every turret of the run (C5.9). The swarm's roles (E4, SwarmParams.roles) go to its counted
 * drones by dock index, a role's slot past them to none: each such row's damage and speed
 * factors, its size (SwarmParams.sizeMult × the role's) and the leader (蜂后); every other row's
 * factors and size are 1. A build with a spawnDrone effect also gets the tables of its timed rows
 * (C5.7, spawnSpecs), which the effects append at run time, their lives × summonDuration (E4).
 * Every row starts with no heading (hx, hy 0), which only a drone's dash writes (FL). Draws
 * nothing.
 */

import type { Rng } from '../../core/rng';
import { DRONE_DEFAULTS } from '../../data/emitters';
import { APPLIED_AILMENTS } from '../../data/triggers';
import type { CompiledBuild, DroneRole } from '../build/compile';
import { countOf, sizeOf } from '../build/size';
import { PICK_TICKS, SUMMON_CAP } from '../caps';
import { AIM_NEAREST, AIM_OUTER } from '../systems/systemState';
import type { ChainPolicy, DroneLayout, SpawnSpecs } from '../systems/systemState';
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
  const hx: number[] = [];
  const hy: number[] = [];
  const roleDamage: number[] = [];
  const roleSpeed: number[] = [];
  const rowSize: number[] = [];
  let leader = -1;
  let followMult = 1;
  // Sized for every emitter once one is a drone emitter, so any emitter index reads an entry.
  const size = emitters.some((em) => em.spec.kind === 'drone') ? emitters.length : 0;
  const stepBase = new Array<number>(size).fill(0);
  const dockTicks = new Array<number>(size).fill(0);
  const coolTicks = new Array<number>(size).fill(0);
  const impacts = new Array<number>(size).fill(0);
  const splashSq = new Array<number>(size).fill(0);
  const turretPayloads = new Array<Payload | null>(size).fill(null);
  // 蟲海's factor and the droneSpeed stat, once for the run; a negative speed is none.
  const countMult = build.flags.droneCountMult;
  const speed = Math.max(0, build.values.droneSpeed);
  let refused = 0;
  /**
   * Emitter `i`'s row of `rowKind`, seat `at`, at `angle` and `radius` around the player, with
   * its role's factors and its size (1 without a role); its row, or −1 when it is refused.
   */
  const place = (
    rowKind: number,
    i: number,
    at: number,
    angle: number,
    radius: number,
    role: DroneRole | null = null,
    sizeMult = 1,
  ): number => {
    if (kind.length >= summonCap) {
      refused++;
      return -1;
    }
    kind.push(rowKind);
    owner.push(i);
    seat.push(at);
    x.push(CENTER_X + radius * Math.cos(angle));
    y.push(CENTER_Y + radius * Math.sin(angle));
    firstPick.push(1 + ((10 * at) % PICK_TICKS));
    // No heading until it flies (FL).
    hx.push(0);
    hy.push(0);
    roleDamage.push(role === null ? 1 : role.damageMult);
    roleSpeed.push(role === null ? 1 : role.speedMult);
    rowSize.push(role === null ? sizeMult : sizeMult * role.sizeMult);
    return kind.length - 1;
  };
  for (const em of emitters) {
    const spec = em.spec;
    if (spec.kind !== 'drone') continue;
    const i = em.index;
    // Emitter 0, a drone emitter, is the swarm: its rules change its SwarmParams in place.
    const swarm = i === 0 ? build.signature.swarm : null;
    const params = swarm ?? DRONE_DEFAULTS;
    // 蟲海 multiplies the drones and 巨大化 then halves them (countOf), here at the fill, and
    // neither touches the turrets.
    const drones = countOf(build, (swarm === null ? spec.drones : swarm.drones) * countMult);
    const turrets = swarm === null ? spec.turrets : swarm.turrets;
    for (let k = 0; k < drones; k++) {
      // The swarm's drone of dock index k takes the role of slot k (E4), and its size.
      const role = swarm === null ? null : (swarm.roles.find((r) => r.slot === k) ?? null);
      const angle = (2 * Math.PI * k) / drones;
      const sizeMult = swarm === null ? 1 : swarm.sizeMult;
      const row = place(DRONE_KIND_DRONE, i, k, angle, DRONE_DEFAULTS.dockRadius, role, sizeMult);
      if (role !== null && role.followBonus > 0 && row >= 0) {
        leader = row;
        followMult = 1 + role.followBonus;
      }
    }
    // Between the drones; evenly from angle 0 without one, where π/D would be Infinity.
    const between = drones >= 1 ? Math.PI / drones : 0;
    for (let j = 0; j < turrets; j++) {
      const angle = between + (2 * Math.PI * j) / turrets;
      place(DRONE_KIND_TURRET, i, j, angle, params.turretRadius);
    }
    stepBase[i] = (params.speed * speed) / TICK_RATE;
    dockTicks[i] = params.dockSec * TICK_RATE;
    coolTicks[i] = params.cooldownSec * TICK_RATE;
    impacts[i] = params.impacts;
    const splash = sizeOf(build, params.splash);
    splashSq[i] = splash * splash;
    const share = swarm === null ? spec.turretDamagePct : swarm.turretDamagePct;
    turretPayloads[i] = turretPayload(build, spec, share, rng, i === 0 ? policy : null);
  }
  const turretSplash = sizeOf(build, build.flags.turretSplash);
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
    hx,
    hy,
    stepBase,
    dockTicks,
    coolTicks,
    impacts,
    splashSq,
    turretPayload: turretPayloads,
    spawnSpecs: build.flags.spawnsDrones ? spawnSpecs(build, speed) : null,
    turretSplashSq: turretSplash * turretSplash,
    turretJumps: countOf(build, build.flags.turretChains),
    roleDamage,
    roleSpeed,
    size: rowSize,
    leader,
    followMult,
  };
}

/**
 * The tables of `build`'s timed rows, one entry per compiled effect (SpawnSpecs): a spawnDrone's
 * fields with their defaults (maxLive SUMMON_CAP, speed and splash DRONE_DEFAULTS', impacts 1,
 * aim nearest), its speed × `speed` (the droneSpeed stat, as the drones') and its splash through
 * sizeOf as a drone's is, its cooldown DRONE_DEFAULTS', its life in ticks max(1, round(lifeSec ×
 * 60 × the summonDuration stat)), the stat read once here as max(0, summonDuration) (蜂王漿, E4);
 * its COEF fields are the compiled spec's, × the coefficient.
 */
function spawnSpecs(build: CompiledBuild, speed: number): SpawnSpecs {
  const n = build.effects.length;
  // A negative duration is none: every row then lives its one tick.
  const duration = Math.max(0, build.values.summonDuration);
  const specs: SpawnSpecs = {
    live: new Int32Array(n),
    maxLive: new Int32Array(n),
    stepBase: new Float64Array(n),
    coolTicks: new Float64Array(n),
    splashSq: new Float64Array(n),
    impacts: new Int16Array(n),
    aim: new Uint8Array(n),
    scale: new Float64Array(n),
    ailment: new Int8Array(n).fill(-1),
    stacks: new Int32Array(n),
    ailmentPct: new Float64Array(n),
    lifeTicks: new Float64Array(n),
  };
  build.effects.forEach((fx, f) => {
    const spec = fx.spec;
    if (spec.kind !== 'spawnDrone') return;
    specs.maxLive[f] = spec.maxLive ?? SUMMON_CAP;
    specs.stepBase[f] = ((spec.speed ?? DRONE_DEFAULTS.speed) * speed) / TICK_RATE;
    specs.coolTicks[f] = DRONE_DEFAULTS.cooldownSec * TICK_RATE;
    const splash = sizeOf(build, spec.splash ?? DRONE_DEFAULTS.splash);
    specs.splashSq[f] = splash * splash;
    specs.impacts[f] = spec.impacts ?? 1;
    specs.aim[f] = spec.aim === 'outer' ? AIM_OUTER : AIM_NEAREST;
    specs.scale[f] = spec.damagePct;
    if (spec.ailment !== undefined) specs.ailment[f] = APPLIED_AILMENTS.indexOf(spec.ailment);
    specs.stacks[f] = spec.ailmentStacks ?? 1;
    specs.ailmentPct[f] = spec.ailmentDamagePct ?? 1;
    // × the stat before the rounding: at 1 the life is lifeSec × 60's, bit for bit.
    specs.lifeTicks[f] = Math.max(1, Math.round(spec.lifeSec * TICK_RATE * duration));
  });
  return specs;
}
