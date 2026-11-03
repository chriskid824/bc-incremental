/**
 * E4's 集火指令 (docs/v3/game-design-v3.md :187 「所有召喚物打生命最高的敵人」; lead ruling R2):
 * BuildFlags.summonHighestHp, which B2's rule module sets, gives every summon's pick to the alive
 * enemy with the most hp whose center is in the arena, the lowest id on ties, whatever a row's
 * cooldown memory and the chase: the drones' and outer spirits' pickOuter, the nearest spirits'
 * pickNearest, and a turret's whole firing. It is checked before 鎖定信標 (summonEliteFirst); the
 * swarm repeat's pick stays. A test module stands in for B2's. Each test names in a comment the
 * planted bug it kills.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { createRng } from '../../core/rng';
import type { DroneGrant, SourcedEmitter } from '../../data/emitters';
import type { SignatureSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import type { SpawnDroneSpec, TriggerSpec } from '../../data/triggers';
import type { EnemyId } from '../../data/types';
import type { BuildFlags } from '../build/compile';
import { DRONE_MEMORY } from '../caps';
import { runEffect, runEffectQueue } from '../effects/execute';
import { createEffectEntry } from '../effects/queue';
import type { EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { makeStats, placedEnemies } from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_DASH,
  DRONE_KIND_DRONE,
  DRONE_KIND_SPIRIT,
} from '../types';
import type { SimEvent } from '../types';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import { pickHighestHp, pickNearest, pickOuter, pickOuterFromCenter, stepDrones } from './drones';
import { rebuildGrid } from './grid';

type TurretFireEvent = Extract<SimEvent, { type: 'turretFire' }>;
type ImpactEvent = Extract<SimEvent, { type: 'impact' }>;

/** The player, at the arena's centre. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** Damage 10 and no crits or ignites unless `values` say so: the hits draw nothing. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
const SWARM: SignatureSpec = { id: 'swarm' };
const FOCUS = { summonHighestHp: true } as const;

const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...more,
});
const drone = (fields: Omit<DroneGrant, 'kind'>): SourcedEmitter => ({
  source: 'outer.summon',
  grant: { kind: 'drone', ...fields },
});
/** A test module writing `flags` over the build's: what B2's module will do. */
const policy =
  (flags: Partial<BuildFlags>): TestModule =>
  (b) =>
    void Object.assign(b.flags, flags);
/** A test module that writes the swarm's counts. */
const swarmCounts =
  (drones: number, turrets: number): TestModule =>
  (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, { drones, turrets });
  };
/** A trigger that never fires in these tests (no enemy reaches the player): it holds a spec. */
const holder = (fields: Partial<SpawnDroneSpec> = {}): TriggerSpec => ({
  on: 'heroHit',
  do: [{ kind: 'spawnDrone', lifeSec: 4, damagePct: 1, ...fields }],
});

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly grants?: readonly SourcedEmitter[];
  readonly triggers?: readonly TriggerSpec[];
  readonly flags?: Partial<BuildFlags>;
  readonly modules?: readonly TestModule[];
  readonly signature?: SignatureSpec;
}

/** placedEnemies with these grants, triggers, flags and modules over NO_ROLLS. */
function field(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'outer.summon', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    rules: [],
    modules: [policy(options.flags ?? {}), ...(options.modules ?? [])],
    ...(options.signature === undefined ? {} : { signature: options.signature }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const emitterOf = (ctx: RunContext, s: number): EmitterRuntime =>
  ctx.emitters[ctx.sys.drones.owner[s] as number] as EmitterRuntime;
const setFlags = (ctx: RunContext, flags: Partial<BuildFlags>): void =>
  void Object.assign(ctx.build.flags as BuildFlags, flags);
const fires = (events: readonly SimEvent[]): TurretFireEvent[] =>
  events.filter((e): e is TurretFireEvent => e.type === 'turretFire');
const impacts = (events: readonly SimEvent[]): ImpactEvent[] =>
  events.filter((e): e is ImpactEvent => e.type === 'impact');
/** The targets' ids of the pool's shots, in slot order. */
const shotTargets = (ctx: RunContext): (number | null)[] =>
  Array.from({ length: ctx.shots.count }, (_, s) => ctx.shots.target[s]?.id ?? null);

/** Runs the drone stage on the current tick; returns its events. */
function stage(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepDrones(ctx);
  return ctx.events.slice();
}

/** Puts slot s in DASH at `target` from where it is: what engage leaves. */
function dashing(ctx: RunContext, s: number, target: Enemy): void {
  const ds = ctx.sys.drones;
  ds.mode[s] = DRONE_DASH;
  ds.target[s] = target;
  ds.targetId[s] = target.id;
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

/** Slot s remembers enemy `id` until `until`, in memory entry `k` of its DRONE_MEMORY. */
function memorize(ctx: RunContext, s: number, k: number, id: number, until: number): void {
  const ds = ctx.sys.drones;
  ds.memId[s * DRONE_MEMORY + k] = id;
  ds.memUntil[s * DRONE_MEMORY + k] = until;
}

const inArena = (e: Enemy): boolean =>
  e.x >= 0 && e.x <= ARENA_WIDTH && e.y >= 0 && e.y <= ARENA_HEIGHT;
/** The brute-force pick: the alive enemy in the arena with the most hp, the lowest id on ties. */
const reference = (ctx: RunContext): Enemy | null =>
  ctx.enemies
    .filter((e) => e.alive && inArena(e))
    .reduce<Enemy | null>((b, e) => {
      if (b === null) return e;
      const d = toNumber(e.hp) - toNumber(b.hp);
      return d > 0 || (d === 0 && e.id < b.id) ? e : b;
    }, null);

describe('集火指令: summonHighestHp, every summon’s pick (lead ruling R2)', () => {
  const TYPES: readonly EnemyId[] = ['square', 'triangle', 'hexagon', 'boss', 'square'];
  /** Few hp values, so that the most hp often ties. */
  const HP = [50, 120, 300, 300, 800, 2000];

  /**
   * A random scene: n enemies of few hp values (some outside the arena, about a third tough,
   * some dead), slot s's memory holding some of them, live or expired, and the other rows
   * dashing at some of them. `rows` makes the rows: a grant's drones or spawned spirits.
   */
  function scene(seed: number, rows: (placed: readonly PlacedEnemy[]) => RunContext, s: number) {
    const rng = createRng(seed);
    const n = 2 + rng.int(10);
    const placed: PlacedEnemy[] = [];
    for (let i = 0; i < n; i++) {
      const type = TYPES[rng.int(TYPES.length)] as EnemyId;
      const x = rng.int(ARENA_WIDTH + 160) - 80;
      const y = rng.int(ARENA_HEIGHT + 160) - 80;
      placed.push({ x, y, type, radius: 10, hp: HP[rng.int(HP.length)] as number });
    }
    const ctx = rows(placed);
    ctx.now = ctx.state.tick = 100;
    const ds = ctx.sys.drones;
    for (const e of ctx.enemies) if (rng.int(7) === 0) removeEnemy(ctx, e);
    for (let k = 0; k < DRONE_MEMORY; k++) {
      if (rng.int(2) === 0) memorize(ctx, s, k, 1 + rng.int(n), ctx.now - 2 + rng.int(6));
    }
    for (let o = 0; o < ds.count; o++) {
      if (o !== s && rng.int(2) === 0) dashing(ctx, o, enemy(ctx, 1 + rng.int(n)));
    }
    ds.x[s] = rng.int(ARENA_WIDTH);
    ds.y[s] = rng.int(ARENA_HEIGHT);
    setFlags(ctx, { summonEliteFirst: rng.int(2) === 0 });
    rebuildGrid(ctx);
    return ctx;
  }
  const drones = (placed: readonly PlacedEnemy[]) =>
    field(placed, { grants: [drone({ drones: 4 })], flags: FOCUS });
  const spirits = (aim: 'outer' | 'nearest') => (placed: readonly PlacedEnemy[]) => {
    const ctx = field(placed, { triggers: [holder({ count: 4, aim })], flags: FOCUS });
    spawn(ctx, P);
    return ctx;
  };
  const remembered = (ctx: RunContext, s: number, id: number): boolean => {
    const ds = ctx.sys.drones;
    for (let k = s * DRONE_MEMORY; k < (s + 1) * DRONE_MEMORY; k++) {
      if (ds.memId[k] === id && (ds.memUntil[k] as number) > ctx.now) return true;
    }
    return false;
  };
  const chased = (ctx: RunContext, e: Enemy, s: number): boolean => {
    const ds = ctx.sys.drones;
    for (let o = 0; o < ds.count; o++) {
      if (o !== s && ds.mode[o] === DRONE_DASH && ds.target[o] === e) return true;
    }
    return false;
  };

  it.each([
    ['a drone', 'outer', drones, DRONE_KIND_DRONE],
    ['an outer spirit', 'outer', spirits('outer'), DRONE_KIND_SPIRIT],
    ['a nearest spirit', 'nearest', spirits('nearest'), DRONE_KIND_SPIRIT],
  ] as const)(
    'picks for %s as a brute-force reference does: the most hp in the arena, the lowest id on ties, its memory, the chase and 鎖定信標 aside',
    (_name, aim, rows, kind) => {
      // Planted bugs: the pick keeping the memory or the chase; an enemy outside the arena taken;
      // a tie kept for the higher id; summonEliteFirst checked first (a tough enemy of less hp).
      const pick = aim === 'outer' ? pickOuter : pickNearest;
      const seen = {
        differs: 0,
        ties: 0,
        outside: 0,
        remembered: 0,
        chased: 0,
        overTough: 0,
        none: 0,
      };
      for (let round = 0; round < 600; round++) {
        const ctx = scene(7000 + round, rows, 1);
        expect(ctx.sys.drones.kind[1]).toBe(kind);
        const want = reference(ctx);
        expect(pick(ctx, 1), `round ${round}`).toBe(want);
        expect(pickHighestHp(ctx), `round ${round}`).toBe(want);
        const eliteFirst = ctx.build.flags.summonEliteFirst;
        setFlags(ctx, { summonHighestHp: false });
        if (pick(ctx, 1) !== want) seen.differs++;
        if (want === null) {
          seen.none++;
          continue;
        }
        const alive = ctx.enemies.filter((e) => e.alive);
        const hp = toNumber(want.hp);
        if (alive.some((e) => e !== want && inArena(e) && toNumber(e.hp) === hp)) seen.ties++;
        if (alive.some((e) => !inArena(e) && toNumber(e.hp) > hp)) seen.outside++;
        if (remembered(ctx, 1, want.id)) seen.remembered++;
        if (chased(ctx, want, 1)) seen.chased++;
        if (eliteFirst && !want.tough && alive.some((e) => e.tough && inArena(e))) seen.overTough++;
      }
      // Coverage: the flag changes many picks; ties, a higher hp outside the arena, the pick in
      // the slot's memory or chased, and an ordinary enemy over a tough one under 鎖定信標 all
      // happen, and so do empty picks.
      expect(seen.differs).toBeGreaterThan(200);
      expect(seen.ties).toBeGreaterThan(30);
      expect(seen.outside).toBeGreaterThan(30);
      expect(seen.remembered).toBeGreaterThan(20);
      expect(seen.chased).toBeGreaterThan(30);
      expect(seen.overTough).toBeGreaterThan(30);
      expect(seen.none).toBeGreaterThan(5);
    },
  );

  it('launches every drone at the one enemy of the most hp, chased or not, a granted one’s and the swarm’s alike', () => {
    // Planted bug: the chase kept (the second and third drones would take the next enemies).
    const placed = [at(600, 0, { hp: 100 }), at(200, 0, { hp: 900 }), at(-300, 0, { hp: 500 })];
    for (const signature of [undefined, SWARM]) {
      const run = (flags: Partial<BuildFlags>) => {
        const ctx = field(placed, {
          ...(signature === undefined
            ? { grants: [drone({ drones: 3 })] }
            : { signature, modules: [swarmCounts(3, 0)] }),
          flags,
        });
        ctx.sys.drones.nextPick.fill(0);
        stage(ctx);
        return Array.from(ctx.sys.drones.targetId.subarray(0, 3));
      };
      expect(run(FOCUS)).toEqual([2, 2, 2]);
      // Without it: the farthest unchased each.
      expect(run({})).toEqual([1, 3, 2]);
    }
  });

  it('picks by the hp at the pick: an impact earlier in the stage that takes its enemy below another turns a later drone’s pick', () => {
    // Planted bug: the pick read off the tick's EvalInput.highestHpId (written before the drone
    // stage, it names the enemy the first impact took below the other).
    const placed = [at(300, 0, { hp: 100 }), at(-300, 0, { hp: 90 })];
    const ctx = field(placed, { signature: SWARM, modules: [swarmCounts(2, 0)], flags: FOCUS });
    const ds = ctx.sys.drones;
    // Slot 0 on the first square's center, its impact a hit of 20; slot 1 docked, its pick due.
    dashing(ctx, 0, enemy(ctx, 1));
    ds.x[0] = enemy(ctx, 1).x;
    ds.y[0] = enemy(ctx, 1).y;
    ds.nextPick[1] = 0;
    expect(pickHighestHp(ctx)?.id).toBe(1);
    const events = stage(ctx);
    expect(impacts(events).map((e) => [e.droneId, e.targetId])).toEqual([[1, 1]]);
    expect(toNumber(enemy(ctx, 1).hp)).toBe(80);
    expect(ds.targetId[1]).toBe(2);
  });

  it('sends a spent drone under 蟲海 on at the most-hp enemy it just impacted, its memory aside, where it would take the next one', () => {
    // Planted bug: the dronesStay repick past the flag (pickOuter skips the remembered enemy).
    const placed = [at(200, 0, { hp: 900 }), at(500, 0, { hp: 100 })];
    const run = (flags: Partial<BuildFlags>) => {
      const ctx = field(placed, {
        grants: [drone({ drones: 1 })],
        flags: { dronesStay: true, ...flags },
      });
      const ds = ctx.sys.drones;
      dashing(ctx, 0, enemy(ctx, 1));
      ds.x[0] = enemy(ctx, 1).x;
      ds.y[0] = enemy(ctx, 1).y;
      ds.impactsLeft[0] = 1;
      ds.nextPick[0] = 0;
      expect(impacts(stage(ctx))).toHaveLength(1);
      return [ds.mode[0], ds.targetId[0]];
    };
    expect(run(FOCUS)).toEqual([DRONE_DASH, 1]);
    expect(run({})).toEqual([DRONE_DASH, 2]);
  });

  it.each(['outer', 'nearest'] as const)(
    'sends a %s spirit at the most-hp enemy through the stage, over the tough one 鎖定信標 would take',
    (aim) => {
      // Planted bug: the flag tested after summonEliteFirst (the spirit takes the elite).
      const R = { x: P.x + 200, y: P.y };
      const placed = [
        at(260, 0, { hp: 300 }),
        at(700, 0, { hp: 200 }),
        at(-200, 0, { hp: 900 }),
        at(400, 0, { type: 'hexagon', hp: 500 }),
      ];
      const run = (flags: Partial<BuildFlags>) => {
        const ctx = field(placed, { triggers: [holder({ aim })], flags });
        spawn(ctx, R);
        stage(ctx);
        return ctx.sys.drones.targetId[0];
      };
      expect(run({ ...FOCUS, summonEliteFirst: true })).toBe(3);
      expect(run(FOCUS)).toBe(3);
      expect(run({ summonEliteFirst: true })).toBe(4);
      expect(run({})).toBe(aim === 'outer' ? 2 : 1);
    },
  );

  it('fires a turret’s first shot and every later one at the most-hp enemy, the focus targets aside', () => {
    // Planted bugs: the later shots spread to the next nearest (turretAccept); the focus targets
    // first (an elite near the player); 鎖定信標 first.
    const placed = [
      at(150, 0, { hp: 100 }),
      at(120, 30, { type: 'hexagon', hp: 400 }),
      at(-500, 200, { hp: 900 }),
      at(140, -20, { hp: 200 }),
    ];
    const run = (flags: Partial<BuildFlags>) => {
      const ctx = field(placed, {
        values: { projectileCount: 3 },
        grants: [drone({ turrets: 1 })],
        flags,
      });
      ctx.sys.drones.acc[0] = emitterOf(ctx, 0).interval;
      const fired = fires(stage(ctx));
      return [fired.map((f) => [f.targetId, f.count]), shotTargets(ctx)];
    };
    expect(run(FOCUS)).toEqual([[[3, 3]], [3, 3, 3]]);
    expect(run({ ...FOCUS, summonEliteFirst: true })).toEqual([[[3, 3]], [3, 3, 3]]);
    // Without it: the elite first (a focus target), then the nearest others.
    expect(run({})).toEqual([[[2, 3]], [2, 4, 1]]);
  });

  it('fires at no enemy outside the arena, and holds its firing ready while only those are left', () => {
    // Planted bug: the turret's pick taking an enemy outside the arena (pickTargetInGrid's last
    // resort, which reaches one anywhere).
    const placed = [at(1400, 0, { hp: 5000 }), at(100, 0, { hp: 100 })];
    const ctx = field(placed, {
      values: { projectileCount: 1 },
      grants: [drone({ turrets: 1 })],
      flags: FOCUS,
    });
    const ds = ctx.sys.drones;
    expect(enemy(ctx, 1).x).toBeGreaterThan(ARENA_WIDTH);
    ds.acc[0] = emitterOf(ctx, 0).interval;
    expect(fires(stage(ctx)).map((f) => f.targetId)).toEqual([2]);
    removeEnemy(ctx, enemy(ctx, 2));
    rebuildGrid(ctx);
    ctx.shots.count = 0;
    ds.acc[0] = emitterOf(ctx, 0).interval;
    expect(fires(stage(ctx))).toEqual([]);
    // Ready at the next stage, with no firing banked (turretStep).
    const em = emitterOf(ctx, 0);
    expect([ctx.shots.count, ds.acc[0]]).toEqual([0, em.interval - em.cadence]);
    // Without the flag it fires at the one outside the arena.
    setFlags(ctx, { summonHighestHp: false });
    expect(fires(stage(ctx)).map((f) => f.targetId)).toEqual([1]);
  });

  it('leaves the swarm repeat’s pick (pickOuterFromCenter) alone: the farthest enemy, whatever its hp', () => {
    // Planted bug: the repeat taking the most-hp enemy (pickOuterFromCenter through the flag).
    const placed = [at(600, 0, { hp: 100 }), at(300, 0, { hp: 900 })];
    const repeat: TriggerSpec = {
      on: 'droneImpact',
      do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }],
    };
    for (const flags of [FOCUS, {}]) {
      const ctx = field(placed, {
        values: { chainCount: 0 },
        triggers: [repeat],
        modules: [swarmCounts(1, 0)],
        signature: SWARM,
        flags,
      });
      dashing(ctx, 0, enemy(ctx, 2));
      ctx.sys.drones.x[0] = enemy(ctx, 2).x;
      ctx.sys.drones.y[0] = enemy(ctx, 2).y;
      stage(ctx);
      runEffectQueue(ctx);
      expect(impacts(ctx.events).map((e) => [e.droneId, e.targetId])).toEqual([
        [1, 2],
        [-1, 1],
      ]);
      expect(pickOuterFromCenter(ctx)?.id).toBe(1);
    }
  });

  it('reads the hp through core/num, a tie the lower id’s, a dead enemy none', () => {
    const ctx = field([at(100, 0), at(200, 0), at(300, 0)], {
      grants: [drone({ drones: 1 })],
      flags: FOCUS,
    });
    for (const [id, hp] of [
      [1, 1e200],
      [2, 3e250],
      [3, 3e250],
    ] as const) {
      enemy(ctx, id).hp = num(hp);
    }
    expect(pickOuter(ctx, 0)?.id).toBe(2);
    removeEnemy(ctx, enemy(ctx, 2));
    expect(pickOuter(ctx, 0)?.id).toBe(3);
    removeEnemy(ctx, enemy(ctx, 3));
    removeEnemy(ctx, enemy(ctx, 1));
    expect(pickOuter(ctx, 0)).toBeNull();
    expect(pickNearest(ctx, 0)).toBeNull();
  });
});
