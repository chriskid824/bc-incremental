/**
 * E4's hive roles, seat and size (docs/v3/game-design-v3.md :184-192; lead rulings R1, R3, R4):
 * the SwarmParams members B2's rule modules write. The roles of single swarm drones (◆蜂后's
 * damage ×2 and its followers' +20 % on its target, ◆重錘's damage ×5 and speed ×0.4), ◆前哨's
 * turret seat radius, ★巨像's drawn size (DroneViewState.size, which the sim never reads), and
 * compileBuild's checks on them. Test modules stand in for B2's. Each test names in a comment the
 * planted bug it kills.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import type { DroneGrant, SourcedEmitter } from '../../data/emitters';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import type { SpawnDroneSpec, TriggerSpec } from '../../data/triggers';
import { compileBuild } from '../build/compile';
import type { BuildFlags, DroneRole, SwarmParams } from '../build/compile';
import { DRONE_MEMORY } from '../caps';
import { runEffect, runEffectQueue } from '../effects/execute';
import { createEffectEntry } from '../effects/queue';
import type { EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData, placedEnemies } from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_DASH,
  DRONE_DOCKED,
  DRONE_HOVER,
  DRONE_KIND_DRONE,
  DRONE_KIND_SPIRIT,
  DRONE_KIND_TURRET,
  DRONE_RETURN,
  NO_INPUT,
} from '../types';
import type { SimEvent } from '../types';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import { impactAt, stepDrones } from './drones';
import { rebuildGrid } from './grid';
import { moveProjectiles } from './projectiles';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;
type ImpactEvent = Extract<SimEvent, { type: 'impact' }>;

/** The player, at the arena's centre. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** A drone's step a tick at m = 1 (SwarmParams.speed 600 / 60). */
const STEP = 10;
/** The drones' dock radius and the turrets' seat radius (DRONE_DEFAULTS), written out. */
const DOCK_RADIUS = 43;
const SEAT_RADIUS = 90;
/** Damage 10 and no crits or ignites unless `values` say so: the hits draw nothing. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
const SWARM: SignatureSpec = { id: 'swarm' };
const GIANT: RuleSpec = { id: 'gigantism', sizeMult: 2 };
const D = DRONE_KIND_DRONE;
const T = DRONE_KIND_TURRET;
const S = DRONE_KIND_SPIRIT;

const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...more,
});
const drone = (fields: Omit<DroneGrant, 'kind'>): SourcedEmitter => ({
  source: 'outer.summon',
  grant: { kind: 'drone', ...fields },
});
/** A test module writing `flags` over the build's. */
const policy =
  (flags: Partial<BuildFlags>): TestModule =>
  (b) =>
    void Object.assign(b.flags, flags);
/** A test module writing `fields` over the swarm's SwarmParams: what B2's modules will do. */
const hive =
  (fields: Partial<SwarmParams>): TestModule =>
  (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, fields);
  };
/** The role of dock index `slot`, each factor 1 and no follow bonus but for `fields`. */
const role = (slot: number, fields: Partial<Omit<DroneRole, 'slot'>> = {}): DroneRole => ({
  slot,
  damageMult: 1,
  speedMult: 1,
  sizeMult: 1,
  followBonus: 0,
  ...fields,
});
/** ◆蜂后 (gd:184) and ◆重錘 (gd:189), on the first two dock indexes. */
const QUEEN = role(0, { damageMult: 2, sizeMult: 1.5, followBonus: 0.2 });
const HAMMER = role(1, { damageMult: 5, speedMult: 0.4 });

/** A spawnDrone of lifeSec 4 and damagePct 1, the rest its defaults, with `fields`. */
const spawnSpec = (fields: Partial<SpawnDroneSpec> = {}): SpawnDroneSpec => ({
  kind: 'spawnDrone',
  lifeSec: 4,
  damagePct: 1,
  ...fields,
});
/** A trigger that never fires in these tests (no enemy reaches the player): it holds a spec. */
const holder = (fields: Partial<SpawnDroneSpec> = {}): TriggerSpec => ({
  on: 'heroHit',
  do: [spawnSpec(fields)],
});
/** A repeat of the swarm at half its damage on each of its drones' impacts. */
const REPEAT_ON_IMPACT: TriggerSpec = {
  on: 'droneImpact',
  do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }],
};

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly grants?: readonly SourcedEmitter[];
  readonly triggers?: readonly TriggerSpec[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
}

/**
 * placedEnemies with the swarm of `drones` drones and `turrets` turrets, `fields` over its
 * SwarmParams, and these grants, triggers, rules and modules over NO_ROLLS.
 */
function swarmOf(
  placed: readonly PlacedEnemy[],
  drones: number,
  turrets: number,
  fields: Partial<SwarmParams> = {},
  options: Options = {},
): RunContext {
  const counts: TestModule = (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, { drones, turrets });
  };
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'outer.summon', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    rules: options.rules ?? [],
    modules: [counts, hive(fields), ...(options.modules ?? [])],
    signature: SWARM,
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const emitterOf = (ctx: RunContext, s: number): EmitterRuntime =>
  ctx.emitters[ctx.sys.drones.owner[s] as number] as EmitterRuntime;
const hits = (events: readonly SimEvent[]): HitEvent[] =>
  events.filter((e): e is HitEvent => e.type === 'hit');
const impacts = (events: readonly SimEvent[]): ImpactEvent[] =>
  events.filter((e): e is ImpactEvent => e.type === 'impact');
/** [target id, chain index, amount] of each hit, in order. */
const amounts = (events: readonly SimEvent[]): [number, number, number][] =>
  hits(events).map((h) => [h.targetId, h.chainIndex, toNumber(h.amount)]);
/** The first `n` entries of one of the pool's columns. */
const column = (ctx: RunContext, name: 'roleDamage' | 'roleSpeed' | 'size', n: number) =>
  Array.from(ctx.sys.drones[name].subarray(0, n));
const kinds = (ctx: RunContext): number[] =>
  Array.from(ctx.sys.drones.kind.subarray(0, ctx.sys.drones.count));

/** Runs the drone stage on the current tick; returns its events. */
function stage(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepDrones(ctx);
  return ctx.events.slice();
}

/** The next tick's drone stage, the enemies standing where they are. */
function next(ctx: RunContext): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  rebuildGrid(ctx);
  return stage(ctx);
}

/** Puts slot s in DASH at `target` from where it is: what engage leaves. */
function dashing(ctx: RunContext, s: number, target: Enemy): void {
  const ds = ctx.sys.drones;
  ds.mode[s] = DRONE_DASH;
  ds.target[s] = target;
  ds.targetId[s] = target.id;
}

/** Puts slot s dashing at `target` on its center: it impacts `target` at its next step. */
function onTarget(ctx: RunContext, s: number, target: Enemy): void {
  dashing(ctx, s, target);
  ctx.sys.drones.x[s] = target.x;
  ctx.sys.drones.y[s] = target.y;
}

/** Runs the build's first spawnDrone effect through its executor on the current tick at `point`. */
function spawn(ctx: RunContext, point: { readonly x: number; readonly y: number }): void {
  const entry = createEffectEntry();
  entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === 'spawnDrone');
  entry.depth = 1;
  entry.origin = -1;
  entry.x = point.x;
  entry.y = point.y;
  runEffect(ctx, entry);
}

/** The next ticks' projectile stages until the pool's shots are gone; returns their events. */
function land(ctx: RunContext): SimEvent[] {
  const events: SimEvent[] = [];
  for (let n = 0; ctx.shots.count > 0; n++) {
    if (n > 600) throw new Error('the shots never land');
    ctx.now = ++ctx.state.tick;
    rebuildGrid(ctx);
    ctx.events.length = 0;
    moveProjectiles(ctx);
    events.push(...ctx.events);
  }
  return events;
}

describe('the roles at the fill (lead ruling R1)', () => {
  /** Roles on dock indexes 0 and 2, and on 3 and 5, which three drones do not reach. */
  const ROLES = [
    role(0, { damageMult: 2, speedMult: 1.5 }),
    role(2, { damageMult: 5, speedMult: 0.4 }),
    role(3, { damageMult: 7, speedMult: 3 }),
    role(5, { damageMult: 9, speedMult: 2 }),
  ];

  it('gives each role to the swarm’s drone of its dock index, a slot past the drones to none, and no role to a turret, a granted drone or a spirit', () => {
    // Planted bug: the role keyed by row index (the swarm's second turret, row 3, and the
    // grant's first drone, row 5, would take slots 3 and 5).
    const ctx = swarmOf(
      [],
      3,
      2,
      { roles: ROLES },
      {
        grants: [drone({ drones: 2, turrets: 1 })],
        triggers: [holder()],
      },
    );
    spawn(ctx, P);
    expect(kinds(ctx)).toEqual([D, D, D, T, T, D, D, T, S]);
    expect(Array.from(ctx.sys.drones.owner.subarray(0, 9))).toEqual([0, 0, 0, 0, 0, 1, 1, 1, -1]);
    expect(column(ctx, 'roleDamage', 9)).toEqual([2, 1, 5, 1, 1, 1, 1, 1, 1]);
    expect(column(ctx, 'roleSpeed', 9)).toEqual([1.5, 1, 0.4, 1, 1, 1, 1, 1, 1]);
    // None of them leads.
    expect([ctx.sys.drones.leader, ctx.sys.drones.followMult]).toEqual([-1, 1]);
  });

  it('places the roles after the count: 蟲海’s ×2 makes slots 3 and 5 drones, 巨大化’s halving leaves slot 0 alone', () => {
    // Planted bug: the roles placed by the module's drones (3) before droneCountMult and countOf.
    const doubled = swarmOf(
      [],
      3,
      2,
      { roles: ROLES },
      { modules: [policy({ droneCountMult: 2 })] },
    );
    expect(kinds(doubled)).toEqual([D, D, D, D, D, D, T, T]);
    expect(column(doubled, 'roleDamage', 8)).toEqual([2, 1, 5, 7, 1, 9, 1, 1]);
    expect(column(doubled, 'roleSpeed', 8)).toEqual([1.5, 1, 0.4, 3, 1, 2, 1, 1]);
    const halved = swarmOf([], 3, 2, { roles: ROLES }, { rules: [GIANT] });
    expect(kinds(halved)).toEqual([D, T, T]);
    expect(column(halved, 'roleDamage', 3)).toEqual([2, 1, 1]);
  });

  it('makes the drone of the role that has a follow bonus the leader, × (1 + the bonus), and a leading slot past the drones or the cap none', () => {
    // Planted bug: the leader taken from a role that placed no row (its slot past the count).
    const ctx = swarmOf([], 3, 1, { roles: [HAMMER, role(2, { followBonus: 0.25 })] });
    expect([ctx.sys.drones.leader, ctx.sys.drones.followMult]).toEqual([2, 1.25]);
    const past = swarmOf([], 2, 1, { roles: [role(2, { followBonus: 0.25 })] });
    expect([past.sys.drones.leader, past.sys.drones.followMult]).toEqual([-1, 1]);
    // 26 drones: the summon cap of 24 refuses dock indexes 24 and 25, a leader among them.
    const capped = swarmOf([], 26, 0, { roles: [role(25, { followBonus: 0.25 })] });
    expect([capped.sys.drones.count, capped.counters.summonCapped]).toEqual([24, 2]);
    expect([capped.sys.drones.leader, capped.sys.drones.followMult]).toEqual([-1, 1]);
    // A role of follow bonus 0 leads nothing.
    const none = swarmOf([], 2, 0, { roles: [role(0, { followBonus: 0 })] });
    expect(none.sys.drones.leader).toBe(-1);
  });
});

describe('a role’s damage and speed (lead ruling R1)', () => {
  it('scales every hit of its drone’s impact by its damageMult, on every enemy the impact lists, and none of the chain’s jumps', () => {
    // Planted bugs: the factor on the target's hit alone; the factor carried into the chain.
    // A target, two enemies in its splash (40) and one for the chain to jump to.
    const placed = [at(200, 0), at(225, 0), at(200, 30), at(320, 0)];
    const run = (fields: Partial<SwarmParams>) => {
      const ctx = swarmOf(placed, 1, 0, fields, { values: { chainCount: 1 } });
      onTarget(ctx, 0, enemy(ctx, 1));
      return amounts(stage(ctx));
    };
    const plain = run({});
    const scaled = run({ roles: [role(0, { damageMult: 5 })] });
    expect(plain.map(([id, jump]) => [id, jump])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 1],
    ]);
    expect(scaled.map(([id, jump]) => [id, jump])).toEqual(plain.map(([id, jump]) => [id, jump]));
    plain.forEach(([id, jump, amount], i) => {
      expect(scaled[i]?.[2], `hit on ${id}`).toBe(jump === 0 ? 5 * amount : amount);
    });
  });

  it('gives a repeat of the swarm (no drone’s) neither a role’s factor nor the follow bonus, on the leader’s live target too', () => {
    // Planted bugs: a repeat taking the role's damageMult of the drone whose impact it repeats;
    // a repeat taking the follow bonus on the leader's target. The square 600 out, the farthest,
    // is the leader's target and the repeat's; the hammer impacts the one 300 out.
    const placed = [at(600, 0), at(300, 0)];
    const run = (fields: Partial<SwarmParams>) => {
      const ctx = swarmOf(placed, 2, 0, fields, {
        values: { chainCount: 0 },
        triggers: [REPEAT_ON_IMPACT],
      });
      dashing(ctx, 0, enemy(ctx, 1));
      onTarget(ctx, 1, enemy(ctx, 2));
      stage(ctx);
      runEffectQueue(ctx);
      expect(ctx.sys.drones.mode[0]).toBe(DRONE_DASH);
      return ctx.events.slice();
    };
    const plain = run({});
    const roled = run({ roles: [QUEEN, HAMMER] });
    // The hammer's impact (drone 2) on the square 300 out, then the repeat's on the farthest.
    const order = (events: readonly SimEvent[]) =>
      impacts(events).map((e) => [e.droneId, e.targetId]);
    expect(order(plain)).toEqual([
      [2, 2],
      [-1, 1],
    ]);
    expect(order(roled)).toEqual(order(plain));
    const [hammer, repeat] = amounts(plain);
    expect(amounts(roled)).toEqual([
      [2, 0, 5 * (hammer?.[2] as number)],
      [1, 0, repeat?.[2]],
    ]);
  });

  it('steps its drone by its speedMult dashing and flying home, droneSpeed’s × included, and leaves its dock time and cooldown', () => {
    // Planted bugs: speedMult missing on the way home; speedMult on the dock time's countdown.
    const ctx = swarmOf([at(400, 0), at(-400, 0)], 2, 0, { roles: [HAMMER] });
    const ds = ctx.sys.drones;
    /** How far slots 0 and 1 move in the next tick's stage, to 9 decimals. */
    const steps = (c: RunContext): number[] => {
      const d = c.sys.drones;
      const from = [0, 1].map((s) => [d.x[s] as number, d.y[s] as number] as const);
      next(c);
      return from.map(([x, y], s) => {
        const moved = Math.hypot((d.x[s] as number) - x, (d.y[s] as number) - y);
        return Math.round(moved * 1e9) / 1e9;
      });
    };
    dashing(ctx, 0, enemy(ctx, 1));
    dashing(ctx, 1, enemy(ctx, 2));
    expect(steps(ctx)).toEqual([STEP, 0.4 * STEP]);
    // Flying home from 200 below the player: as fast as each dashes.
    for (const s of [0, 1]) {
      ds.mode[s] = DRONE_RETURN;
      ds.x[s] = P.x;
      ds.y[s] = P.y + 200;
    }
    expect(steps(ctx)).toEqual([STEP, 0.4 * STEP]);
    expect([ds.mode[0], ds.mode[1]]).toEqual([DRONE_RETURN, DRONE_RETURN]);
    // At droneSpeed 1.5, × 1.5 on both.
    const fast = swarmOf(
      [at(400, 0), at(-400, 0)],
      2,
      0,
      { roles: [HAMMER] },
      {
        values: { droneSpeed: 1.5 },
      },
    );
    dashing(fast, 0, enemy(fast, 1));
    dashing(fast, 1, enemy(fast, 2));
    expect(steps(fast)).toEqual([1.5 * STEP, 0.6 * STEP]);
    // Docked with the dock time to run down, both launch on the same tick, and each impact holds
    // its square in the drone's memory as long, the hammer's arriving later.
    const dock = swarmOf([at(100, 0), at(-100, 0)], 2, 0, { roles: [HAMMER] });
    const dd = dock.sys.drones;
    dd.dockLeft[0] = dd.dockLeft[1] = dd.dockTicks[0] as number;
    dd.nextPick.fill(0);
    const launched = [-1, -1];
    const struck = [-1, -1];
    const held = [-1, -1];
    for (let n = 0; n < 120; n++) {
      const events = next(dock);
      for (const s of [0, 1]) {
        if (launched[s] === -1 && dd.mode[s] === DRONE_DASH) launched[s] = dock.now;
      }
      for (const e of impacts(events)) {
        const s = e.droneId - 1;
        if (struck[s] !== -1) continue;
        struck[s] = dock.now;
        const k = Array.from(dd.memId.subarray(DRONE_MEMORY * s, DRONE_MEMORY * (s + 1))).indexOf(
          e.targetId,
        );
        held[s] = (dd.memUntil[DRONE_MEMORY * s + k] as number) - dock.now;
      }
    }
    expect(launched[0]).toBeGreaterThan(30);
    expect(launched[1]).toBe(launched[0]);
    expect(struck[1]).toBeGreaterThan(struck[0] as number);
    expect(held).toEqual([30, 30]);
  });

  it('arrives by its own step: the hammer 6 short of its target’s edge impacts on its second step, and 6 from its dock docks on its second', () => {
    // Planted bugs: the arrival tested with the step before the role's factor, dashing (the
    // hammer, its step 4, would snap onto its target from 6 out at once) or flying home (it would
    // dock from 6 out at once).
    const ctx = swarmOf(
      [at(400, 0), at(-400, 0)],
      2,
      0,
      { roles: [HAMMER] },
      {
        values: { chainCount: 0 },
      },
    );
    const ds = ctx.sys.drones;
    // Slot 0, no role (step 10), 15 short of enemy 1's edge; the hammer, slot 1, 6 short of 2's.
    const gaps = [15, 6];
    for (const s of [0, 1]) {
      const t = enemy(ctx, s + 1);
      dashing(ctx, s, t);
      ds.x[s] = t.x - (t.radius + (gaps[s] as number));
      ds.y[s] = t.y;
    }
    const struck = [-1, -1];
    for (let n = 1; n <= 3; n++) {
      for (const e of impacts(next(ctx))) {
        if (struck[e.droneId - 1] === -1) struck[e.droneId - 1] = n;
      }
    }
    expect(struck).toEqual([2, 2]);
    // Flying home: slot 0 from 15 below its dock, the hammer from 6.
    const docked = [-1, -1];
    for (const s of [0, 1]) {
      ds.mode[s] = DRONE_RETURN;
      ds.x[s] = ds.dockX[s] as number;
      ds.y[s] = (ds.dockY[s] as number) + (gaps[s] as number);
    }
    for (let n = 1; n <= 3; n++) {
      next(ctx);
      for (const s of [0, 1]) {
        if (docked[s] === -1 && ds.mode[s] === DRONE_DOCKED) docked[s] = n;
      }
    }
    expect(docked).toEqual([2, 2]);
  });
});

describe('蜂后’s follow bonus (lead ruling R1)', () => {
  // The leader dashes at the square 400 out from its dock, too far to impact it this tick.
  const placed = [at(400, 0), at(400, 300)];
  /** The hits of slots 1 and 2's impacts, each on its center: slot 2 on enemy `second`. */
  function follow(fields: Partial<SwarmParams>, second: number, leaderMode = DRONE_DASH) {
    const ctx = swarmOf(placed, 3, 0, fields, { values: { chainCount: 0 } });
    const ds = ctx.sys.drones;
    const target = enemy(ctx, 1);
    dashing(ctx, 0, target);
    if (leaderMode !== DRONE_DASH) {
      // It keeps its target through its own step: 100 short of the square, away from its dock,
      // its pick and its dock time far off.
      ds.mode[0] = leaderMode;
      ds.x[0] = target.x - 100;
      ds.nextPick[0] = 1e9;
      ds.dockLeft[0] = 1e9;
    }
    onTarget(ctx, 1, target);
    onTarget(ctx, 2, enemy(ctx, second));
    const events = stage(ctx);
    expect(impacts(events).map((e) => e.droneId)).toEqual([2, 3]);
    expect(ds.mode[0]).toBe(leaderMode);
    expect(ds.target[0]).toBe(target);
    return amounts(events).map(([id, , amount]) => [id, amount]);
  }

  it('takes another swarm drone’s impact on the leader’s live target × (1 + the bonus), on top of its own damageMult, and leaves an impact on another enemy', () => {
    // Planted bug: × b in place of × (1 + b) (the hammer's hit 5 × 0.2 = 1 times its base).
    const base = follow({}, 2);
    const unit = (base[0] as [number, number])[1];
    expect(base).toEqual([
      [1, unit],
      [2, unit],
    ]);
    // The hammer (slot 1) on the queen's target: × 5 × 1.2; slot 2, no role, on another enemy.
    const led = follow({ roles: [QUEEN, HAMMER] }, 2);
    expect(led[0]?.[1]).toBeCloseTo(unit * 5 * 1.2, 9);
    expect(led[1]).toEqual([2, unit]);
    // Slot 2 on the queen's target too: × 1.2.
    const both = follow({ roles: [QUEEN, HAMMER] }, 1);
    expect(both[1]?.[1]).toBeCloseTo(unit * 1.2, 9);
  });

  it('never takes the leader’s own impact: the queen on its target is × its damageMult alone', () => {
    // Planted bug: the bonus on the leader's own impact (s === leader not excluded).
    const run = (fields: Partial<SwarmParams>) => {
      const ctx = swarmOf(placed, 1, 0, fields, { values: { chainCount: 0 } });
      onTarget(ctx, 0, enemy(ctx, 1));
      return amounts(stage(ctx));
    };
    const [[, , unit]] = run({}) as [[number, number, number]];
    expect(run({ roles: [QUEEN] })).toEqual([[1, 0, 2 * unit]]);
  });

  it('gives none while the leader flies home, hovers or docks, its target kept', () => {
    // Planted bug: the bonus on the leader's target whatever its mode (a leader flying home
    // keeps its target until it docks; one hovering, until it picks).
    const unit = (follow({}, 2)[0] as [number, number])[1];
    for (const mode of [DRONE_RETURN, DRONE_HOVER, DRONE_DOCKED]) {
      const led = follow({ roles: [QUEEN, HAMMER] }, 1, mode);
      expect(led, String(mode)).toEqual([
        [1, 5 * unit],
        [1, unit],
      ]);
    }
  });

  it('gives it while the leader rides its target through its cooldown memory, still DASH, on its center', () => {
    // Planted bug: the bonus only while the leader is on its way (a leader that impacted its
    // target and waits on it, snapped to its center, giving none).
    const run = (fields: Partial<SwarmParams>) => {
      const ctx = swarmOf(placed, 2, 0, fields, { values: { chainCount: 0 } });
      const ds = ctx.sys.drones;
      const target = enemy(ctx, 1);
      // The leader impacts the square this tick; slot 1 stays docked, its dock time far off.
      onTarget(ctx, 0, target);
      ds.dockLeft[1] = 1e9;
      expect(impacts(stage(ctx)).map((e) => e.droneId)).toEqual([1]);
      expect([target.alive, ds.mode[0], ds.impactsLeft[0]]).toEqual([true, DRONE_DASH, 2]);
      // Next tick it rides the square in its memory while slot 1 impacts it.
      onTarget(ctx, 1, target);
      const events = next(ctx);
      expect(impacts(events).map((e) => e.droneId)).toEqual([2]);
      expect([ds.mode[0], ds.target[0], ds.x[0], ds.y[0]]).toEqual([
        DRONE_DASH,
        target,
        target.x,
        target.y,
      ]);
      return amounts(events).map(([id, , amount]) => [id, amount]);
    };
    const [[, unit]] = run({}) as [[number, number]];
    const led = run({ roles: [QUEEN, HAMMER] });
    expect(led).toHaveLength(1);
    expect(led[0]?.[0]).toBe(1);
    expect(led[0]?.[1]).toBeCloseTo(unit * 5 * 1.2, 9);
  });

  it('gives none on a dead target: an impact listing the enemies around the leader’s target after it died', () => {
    // Planted bug: the live test dropped (the drone stage never impacts a dead target; impactAt
    // called with one lists the enemies around it).
    const run = (dead: boolean) => {
      const ctx = swarmOf(
        [at(400, 0), at(420, 0)],
        2,
        0,
        { roles: [QUEEN] },
        {
          values: { chainCount: 0 },
        },
      );
      const target = enemy(ctx, 1);
      dashing(ctx, 0, target);
      if (dead) removeEnemy(ctx, target);
      rebuildGrid(ctx);
      ctx.events.length = 0;
      const em = ctx.emitters[0] as EmitterRuntime;
      impactAt(ctx, 1, target, em.payload, em, false, 0, -1);
      return amounts(ctx.events).map(([id, , amount]) => [id, amount]);
    };
    const live = run(false);
    const unit = (live[0] as [number, number])[1] / 1.2;
    expect(live.map(([id]) => id)).toEqual([1, 2]);
    expect(live[1]?.[1]).toBeCloseTo(unit * 1.2, 9);
    expect(run(true)).toEqual([[2, unit]]);
  });

  it('never reaches a turret shot, a granted drone or a spirit on the leader’s target', () => {
    // Planted bugs: the bonus on a turret shot's arrival (turretArrival: the granted turret's,
    // whose payload is not the signature's, takes the shot's scale); the owner test dropped, so
    // a granted drone takes it.
    const run = (fields: Partial<SwarmParams>) => {
      const ctx = swarmOf([at(400, 0)], 1, 1, fields, {
        values: { chainCount: 0, projectileCount: 2 },
        grants: [drone({ drones: 1, turrets: 1 })],
        triggers: [holder({ aim: 'nearest' })],
      });
      const ds = ctx.sys.drones;
      const target = enemy(ctx, 1);
      // The leader, slot 0, dashes at the square from its dock; the granted drone, slot 2, is on
      // it; a spirit spawns on it; the swarm's turret, slot 1, and the grant's, slot 3, fire at it.
      expect(kinds(ctx)).toEqual([D, T, D, T]);
      dashing(ctx, 0, target);
      onTarget(ctx, 2, target);
      spawn(ctx, target);
      ds.acc[1] = emitterOf(ctx, 1).interval;
      ds.acc[3] = emitterOf(ctx, 3).interval;
      const events = [...stage(ctx), ...land(ctx)];
      expect(ds.mode[0]).toBe(DRONE_DASH);
      return amounts(events).map(([id, , amount]) => [id, amount]);
    };
    const plain = run({});
    expect(plain).toHaveLength(4);
    expect(run({ roles: [QUEEN] })).toEqual(plain);
  });
});

describe('前哨’s seat: SwarmParams.turretRadius (lead ruling R3)', () => {
  /** Distance and angle of slot s from the player. */
  const polar = (ctx: RunContext, s: number): [number, number] => {
    const dx = (ctx.sys.drones.x[s] as number) - P.x;
    const dy = (ctx.sys.drones.y[s] as number) - P.y;
    return [Math.round(Math.hypot(dx, dy) * 1e9) / 1e9, Math.round(Math.atan2(dy, dx) * 1e9) / 1e9];
  };

  it('seats the swarm’s turrets at its radius, at the angles they had, and the granted turrets at 90', () => {
    // Planted bugs: the swarm's turrets left at 90 under 220; a granted turret seated at 220.
    const run = (fields: Partial<SwarmParams>) =>
      swarmOf([], 2, 2, fields, { grants: [drone({ drones: 1, turrets: 2 })] });
    const plain = run({});
    const far = run({ turretRadius: 220 });
    expect(kinds(far)).toEqual([D, D, T, T, D, T, T]);
    const radii = (ctx: RunContext) => [0, 1, 2, 3, 4, 5, 6].map((s) => polar(ctx, s)[0]);
    expect(radii(plain)).toEqual([43, 43, 90, 90, 43, 90, 90].map((r) => r));
    expect(radii(far)).toEqual([
      DOCK_RADIUS,
      DOCK_RADIUS,
      220,
      220,
      DOCK_RADIUS,
      SEAT_RADIUS,
      SEAT_RADIUS,
    ]);
    const angles = (ctx: RunContext) => [0, 1, 2, 3, 4, 5, 6].map((s) => polar(ctx, s)[1]);
    expect(angles(far)).toEqual(angles(plain));
    // At 0, on the player.
    const on = run({ turretRadius: 0 });
    expect([on.sys.drones.x[2], on.sys.drones.y[2]]).toEqual([P.x, P.y]);
  });

  it('fires the swarm’s shots from its seat at 220, at the enemy nearest to it there', () => {
    // The seat of the swarm's only turret with no drone is at angle 0, right of the player. The
    // square 100 below the seat at 90 is the nearer from there; the one 120 above the seat at
    // 220 from there.
    const placed = [at(90, 100), at(220, -120)];
    const run = (fields: Partial<SwarmParams>) => {
      const ctx = swarmOf(placed, 0, 1, fields, { values: { projectileCount: 2 } });
      ctx.sys.drones.acc[0] = emitterOf(ctx, 0).interval;
      const fired = stage(ctx).filter((e) => e.type === 'turretFire');
      return { fired, shot: [ctx.shots.x[0], ctx.shots.y[0], ctx.shots.target[0]?.id] };
    };
    const far = run({ turretRadius: 220 });
    expect(far.fired).toEqual([
      { type: 'turretFire', droneId: 1, x: P.x + 220, y: P.y, targetId: 2, count: 1 },
    ]);
    expect(far.shot).toEqual([P.x + 220, P.y, 2]);
    expect(run({}).shot).toEqual([P.x + SEAT_RADIUS, P.y, 1]);
  });
});

describe('巨像’s size: DroneViewState.size (lead ruling R4)', () => {
  it('writes the swarm’s sizeMult × its role’s on each swarm drone, and 1 on its turrets, granted rows and spirits', () => {
    // Planted bug: the swarm's sizeMult written on its turrets too.
    const ctx = swarmOf(
      [],
      3,
      2,
      { sizeMult: 1.2, roles: [QUEEN, HAMMER] },
      {
        grants: [drone({ drones: 2, turrets: 1 })],
        triggers: [holder()],
      },
    );
    spawn(ctx, P);
    expect(kinds(ctx)).toEqual([D, D, D, T, T, D, D, T, S]);
    expect(column(ctx, 'size', 9)).toEqual([1.2 * 1.5, 1.2, 1.2, 1, 1, 1, 1, 1, 1]);
    expect(ctx.state.drones.size).toBe(ctx.sys.drones.size);
    const plain = swarmOf([], 3, 2, {}, { grants: [drone({ drones: 2, turrets: 1 })] });
    expect(column(plain, 'size', 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('is never read by the sim: a swarm drawn at 3 and 0.75 plays as at 1, event for event and row for row', () => {
    // Planted bug: the sim reading the size (an impact's splash × its row's size).
    const MEMBERS = [
      'id',
      'kind',
      'mode',
      'x',
      'y',
      'prevX',
      'prevY',
      'targetId',
      'owner',
      'seat',
    ] as const;
    const run = (fields: Partial<SwarmParams>) => {
      const stats = makeStats(
        {
          damage: 1,
          maxLife: 1e9,
          critChance: 0.2,
          igniteChance: 0.2,
          chainCount: 1,
          attackSpeed: 8,
        },
        [],
        {
          triggers: [
            {
              source: 'outer.summon',
              spec: {
                on: 'nthAttack',
                every: 3,
                target: { pick: 'player' },
                do: [spawnSpec({ lifeSec: 2, damagePct: 0.5 })],
              },
            },
          ],
          conversions: [],
          emitters: [drone({ drones: 2, turrets: 1 })],
        },
      );
      const config = makeConfig({ stats, signature: SWARM, startWave: 12, maxTicks: 900 });
      const sim = createSimulation(config, makeTestData(), [hive(fields)]);
      const hash = createHash('sha256');
      let impactsSeen = 0;
      while (!sim.state.finished) {
        const events = sim.step(NO_INPUT);
        impactsSeen += impacts(events).length;
        const ds = sim.state.drones;
        const n = sim.state.droneCount;
        hash.update(JSON.stringify([events, MEMBERS.map((m) => Array.from(ds[m].subarray(0, n)))]));
      }
      hash.update(JSON.stringify(sim.result()));
      return {
        hash: hash.digest('hex'),
        impactsSeen,
        size: Array.from(sim.state.drones.size.subarray(0, 6)),
      };
    };
    const plain = run({});
    const drawn = run({ sizeMult: 3, roles: [role(0, { sizeMult: 0.25 })] });
    expect(drawn.hash).toBe(plain.hash);
    expect(plain.impactsSeen).toBeGreaterThan(50);
    expect(drawn.size).toEqual([0.75, 3, 3, 1, 1, 1]);
  });
});

describe('compileBuild’s checks on the hive’s SwarmParams (lead rulings R1, R3, R4)', () => {
  const compileWith = (fields: Partial<SwarmParams>) => () =>
    compileBuild(makeStats(), [], SWARM, [hive(fields)]);
  const swarmOfBuild = (fields: Partial<SwarmParams>) =>
    compileWith(fields)().signature.swarm as SwarmParams;

  it('throws, naming the field and its value, on a slot that is not a whole number ≥ 0', () => {
    for (const v of [-1, 0.5, Number.NaN, Infinity]) {
      expect(compileWith({ roles: [role(v)] }), String(v)).toThrow(
        `swarm.roles[0].slot: ${v} must be a whole number >= 0`,
      );
    }
    expect(compileWith({ roles: [role(1), role(-2)] })).toThrow(
      'swarm.roles[1].slot: -2 must be a whole number >= 0',
    );
    for (const v of [0, 2, 30]) expect(swarmOfBuild({ roles: [role(v)] }).roles).toEqual([role(v)]);
  });

  it('throws on two roles of one slot', () => {
    // Planted bug: a duplicate slot accepted (the fill's find would take the first).
    expect(compileWith({ roles: [role(1), role(0), role(1, { damageMult: 5 })] })).toThrow(
      "swarm.roles[2].slot: 1 is swarm.roles[0]'s too",
    );
  });

  it('throws on a damageMult, speedMult or sizeMult that is not finite and above 0', () => {
    for (const field of ['damageMult', 'speedMult', 'sizeMult'] as const) {
      for (const v of [0, -2, Number.NaN, Infinity, -Infinity]) {
        expect(compileWith({ roles: [role(0, { [field]: v })] }), `${field} ${v}`).toThrow(
          `swarm.roles[0].${field}: ${v} must be finite and above 0`,
        );
      }
      for (const v of [0.4, 1, 5]) {
        expect(swarmOfBuild({ roles: [role(0, { [field]: v })] }).roles[0]?.[field]).toBe(v);
      }
    }
  });

  it('throws on a followBonus that is not finite and ≥ 0, and on a second role that leads', () => {
    // Planted bug: two leaders accepted (the fill would keep the last).
    for (const v of [-0.2, Number.NaN, Infinity]) {
      expect(compileWith({ roles: [role(0, { followBonus: v })] }), String(v)).toThrow(
        `swarm.roles[0].followBonus: ${v} must be finite and >= 0`,
      );
    }
    expect(
      compileWith({
        roles: [role(0, { followBonus: 0.2 }), role(1), role(2, { followBonus: 0.1 })],
      }),
    ).toThrow('swarm.roles[2].followBonus: 0.1, but swarm.roles[0] leads; at most one role may');
    // Any number of roles of bonus 0 beside one leader.
    const roles = [role(0, { followBonus: 0.2 }), role(1), role(2, { followBonus: 0 })];
    expect(swarmOfBuild({ roles }).roles).toEqual(roles);
  });

  it('throws on a turretRadius that is not finite and ≥ 0, and on a sizeMult that is not finite and above 0', () => {
    for (const v of [-1, Number.NaN, Infinity]) {
      expect(compileWith({ turretRadius: v }), String(v)).toThrow(
        `swarm.turretRadius: ${v} must be finite and >= 0`,
      );
    }
    for (const v of [0, 90, 220]) expect(swarmOfBuild({ turretRadius: v }).turretRadius).toBe(v);
    for (const v of [0, -1, Number.NaN, Infinity]) {
      expect(compileWith({ sizeMult: v }), String(v)).toThrow(
        `swarm.sizeMult: ${v} must be finite and above 0`,
      );
    }
    for (const v of [0.5, 1, 1.2]) expect(swarmOfBuild({ sizeMult: v }).sizeMult).toBe(v);
  });

  it('compiles the swarm with no role, its turrets at 90 and its drones at size 1', () => {
    expect(swarmOfBuild({})).toMatchObject({ roles: [], turretRadius: 90, sizeMult: 1 });
  });
});
