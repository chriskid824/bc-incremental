/**
 * C5.9's summon policies (docs/v3/game-design-v3.md :193, :476-481; lead rulings P1–P6): the
 * BuildFlags B1's rule modules set, 鎖定信標 (summonEliteFirst: the tough enemies first in every
 * summon's pick), 蟲海 (droneCountMult at the fill, dronesStay in the dash), 加農砲 (turretRateMult
 * on the turrets' period, turretSplash around a turret shot's target) and 特斯拉塔 (turretChains
 * on a turret shot's arrival), compileBuild's checks on them, and the droneSpeed stat at the
 * fill. Test modules stand in for B1's. Each flag at its default plays exactly as the base did;
 * each test names in a comment the planted bug it kills.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import { createRng } from '../../core/rng';
import type { DroneGrant, SourcedEmitter } from '../../data/emitters';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { Modifier, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { SpawnDroneSpec, TriggerSpec } from '../../data/triggers';
import type { EnemyId } from '../../data/types';
import { compileBuild } from '../build/compile';
import type { BuildFlags, SwarmParams } from '../build/compile';
import { countOf, sizeOf } from '../build/size';
import { DRONE_MEMORY, PICK_TICKS, SUMMON_CAP } from '../caps';
import { runEffect } from '../effects/execute';
import { PRIMARY } from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import { BASE_ATTACK_SPEED, TURRET_RATE, periodTicks } from '../emitters/types';
import type { EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { FOCUS_RANGE } from '../targeting';
import {
  eventsOf,
  makeConfig,
  makeStats,
  placedEnemies,
  projectResult,
  v3TestData,
} from '../testing';
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
  TICK_RATE,
} from '../types';
import type { SimEvent } from '../types';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import { pickNearest, pickOuter, stepDrones } from './drones';
import { rebuildGrid } from './grid';
import { moveEnemies } from './movement';
import { moveProjectiles } from './projectiles';

type ImpactEvent = Extract<SimEvent, { type: 'impact' }>;
type HitEvent = Extract<SimEvent, { type: 'hit' }>;

/** The player, at the arena's centre. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** The turrets' distance from the player (DRONE_DEFAULTS.turretRadius), written out. */
const SEAT_RADIUS = 90;
/** The seat of an emitter's only turret when it has no drone: angle 0, right of the player. */
const SEAT = { x: P.x + SEAT_RADIUS, y: P.y };
/** A drone's and a spirit's step a tick at m = 1 (DRONE_DEFAULTS.speed 600 / 60). */
const STEP = 10;
/** Damage 10 and no crits or ignites unless `values` say so: the hits draw nothing. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
/** A turret shot's hits' tags (F6), and its chain jumps' (jumpMask keeps the owner tag). */
const SHOT_TAGS = TAG.hit | TAG.minion | TAG.projectile;
const JUMP_TAGS = TAG.hit | TAG.chain | TAG.minion;
const SWARM: SignatureSpec = { id: 'swarm' };
const GIANT: RuleSpec = { id: 'gigantism', sizeMult: 2 };

const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...more,
});
const drone = (fields: Omit<DroneGrant, 'kind'>): SourcedEmitter => ({
  source: 'outer.summon',
  grant: { kind: 'drone', ...fields },
});
/** A test module writing `flags` over the build's: what B1's modules will do. */
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
/** A test module that only raises the run's summon cap to `summonCap`. */
const raiseCap = (summonCap: number): TestModule => Object.assign(() => undefined, { summonCap });

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

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly scoped?: readonly Modifier[];
  readonly grants?: readonly SourcedEmitter[];
  readonly triggers?: readonly TriggerSpec[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
  readonly signature?: SignatureSpec;
}

/** placedEnemies with these grants (none by default), triggers and modules over NO_ROLLS. */
function field(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, options.scoped ?? [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'outer.summon', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
    ...(options.signature === undefined ? {} : { signature: options.signature }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const emitterOf = (ctx: RunContext, s: number): EmitterRuntime =>
  ctx.emitters[ctx.sys.drones.owner[s] as number] as EmitterRuntime;
const impacts = (events: readonly SimEvent[]): ImpactEvent[] => eventsOf([events], 'impact');
const hits = (events: readonly SimEvent[]): HitEvent[] => eventsOf([events], 'hit');
const hitIds = (events: readonly SimEvent[]): number[] => hits(events).map((h) => h.targetId);

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

/** The drone stage on the current tick with turret slot `s` due: its one firing's events. */
function fire(ctx: RunContext, s = 0): SimEvent[] {
  ctx.sys.drones.acc[s] = emitterOf(ctx, s).interval;
  return stage(ctx);
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

/** The targets' ids of the pool's shots, in slot order. */
const shotTargets = (ctx: RunContext): (number | null)[] =>
  Array.from({ length: ctx.shots.count }, (_, s) => ctx.shots.target[s]?.id ?? null);

/** Puts slot s in DASH at `target` from where it is: what engage leaves. */
function dashing(ctx: RunContext, s: number, target: Enemy): void {
  const ds = ctx.sys.drones;
  ds.mode[s] = DRONE_DASH;
  ds.target[s] = target;
  ds.targetId[s] = target.id;
}

/** Runs the build's n-th spawnDrone effect through its executor on the current tick at `point`. */
function spawn(ctx: RunContext, n: number, point: { readonly x: number; readonly y: number }) {
  const found = ctx.build.effects.flatMap((fx, i) => (fx.kind === 'spawnDrone' ? [i] : []));
  const entry = createEffectEntry();
  entry.effect = found[n] as number;
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

/** The kind of every row of the pool, in slot order. */
const kinds = (ctx: RunContext): number[] =>
  Array.from(ctx.sys.drones.kind.subarray(0, ctx.sys.drones.count));

describe('the summon policies at their defaults (lead ruling P8)', () => {
  // Every flag at its default, the stat at its base: each build plays as the base 9cdd887 did,
  // event for event, its result and its pool's rows at the end alike. The hashes were recorded
  // on the base by the same runs (c59-bench/scripts/defaults-digest.mts); each case shows its
  // drones, turrets and spirits at work, so a leak on any path moves its hash.
  const VALUES = {
    damage: 1,
    maxLife: 1e9,
    critChance: 0.2,
    critMultiplier: 2,
    igniteChance: 0.2,
    chainCount: 1,
    attackSpeed: 8,
  };
  const CASES: Record<
    string,
    {
      readonly emitters: readonly SourcedEmitter[];
      readonly triggers: readonly TriggerSpec[];
      readonly signature?: SignatureSpec;
      readonly base: string;
    }
  > = {
    droneGrant: {
      emitters: [drone({ drones: 3, turrets: 2 })],
      triggers: [],
      base: 'ed0d876d543b047e',
    },
    swarm: { emitters: [], triggers: [], signature: SWARM, base: '6ee72af629aa0ab8' },
    spirits: {
      emitters: [drone({ turrets: 1 })],
      triggers: [
        {
          on: 'nthAttack',
          every: 3,
          target: { pick: 'player' },
          do: [spawnSpec({ lifeSec: 3, damagePct: 0.5, impacts: 2, aim: 'nearest' })],
        },
        {
          on: 'nthAttack',
          every: 5,
          target: { pick: 'player' },
          do: [spawnSpec({ lifeSec: 2, damagePct: 0.5, count: 2, aim: 'outer', maxLive: 6 })],
        },
      ],
      base: '984fa12e4303f0e8',
    },
  };
  /** [impacts, turret firings, spirit row-ticks] of each case. */
  const SEEN: Record<string, [number, number, number]> = {
    droneGrant: [110, 160, 0],
    swarm: [111, 80, 0],
    spirits: [166, 80, 3490],
  };
  const PER_SLOT = [
    'id',
    'kind',
    'mode',
    'x',
    'y',
    'targetId',
    'impactsLeft',
    'dockLeft',
    'acc',
    'nextPick',
    'until',
  ] as const;
  const DEFAULTS: Partial<BuildFlags> = {
    summonEliteFirst: false,
    droneCountMult: 1,
    dronesStay: false,
    turretRateMult: 1,
    turretSplash: 0,
    turretChains: 0,
    minionCount: false,
  };

  /** The case's hash and how many impacts, turret firings and spirit spawns it played. */
  function digest(name: string, modules: readonly TestModule[], values = {}) {
    const c = CASES[name] as (typeof CASES)[string];
    const stats = makeStats({ ...VALUES, ...values }, [], {
      triggers: c.triggers.map((spec) => ({ source: 'outer.summon', spec })),
      conversions: [],
      emitters: c.emitters,
    });
    const config = makeConfig({
      stats,
      startWave: 12,
      maxTicks: 1200,
      ...(c.signature === undefined ? {} : { signature: c.signature }),
    });
    const watched: { ctx: RunContext | null } = { ctx: null };
    const grab: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        watched.ctx = ctx;
      });
    const sim = createSimulation(config, v3TestData(), [grab, ...modules]);
    const hash = createHash('sha256');
    const seen = { impacts: 0, fires: 0, spirits: 0 };
    while (!sim.state.finished) {
      const events = sim.step(NO_INPUT);
      hash.update(JSON.stringify(events));
      seen.impacts += impacts(events).length;
      seen.fires += eventsOf([events], 'turretFire').length;
      const ds = (watched.ctx as RunContext).sys.drones;
      for (let s = 0; s < ds.count; s++) if (ds.kind[s] === DRONE_KIND_SPIRIT) seen.spirits++;
    }
    const result = sim.result();
    hash.update(JSON.stringify([projectResult(result), result.damageBySource, result.counters]));
    const ds = (watched.ctx as RunContext).sys.drones;
    hash.update(JSON.stringify(PER_SLOT.map((k) => Array.from(ds[k].subarray(0, ds.count)))));
    return { hash: hash.digest('hex').slice(0, 16), ...seen };
  }

  it.each(Object.keys(CASES))(
    'plays %s as the base did, with no module, a module writing every default and droneSpeed 1',
    (name) => {
      // Planted bugs: any of the fill's, the stage's or the arrival's new terms read at its
      // default as something else (droneCountMult as 0, a splash of 0 listing, a jump added).
      const base = (CASES[name] as (typeof CASES)[string]).base;
      const plain = digest(name, []);
      expect(plain.hash).toBe(base);
      expect(digest(name, [policy(DEFAULTS)], { droneSpeed: 1 }).hash).toBe(base);
      // Coverage: the drones impact, the turrets fire and the spirits fly.
      expect([plain.impacts, plain.fires, plain.spirits]).toEqual(SEEN[name]);
    },
  );

  it.each(Object.keys(CASES))(
    'plays %s as the base did under a module writing E4’s defaults, summonDuration 1, and a role of factors 1 on every swarm drone (lead ruling R6)',
    (name) => {
      // Planted bugs: E4's terms read at their defaults as something else (a slot past the
      // roles at factor 0, the swarm's turrets seated off 90, a life × summonDuration after its
      // rounding, focus fire on at false).
      const base = (CASES[name] as (typeof CASES)[string]).base;
      const e4 =
        (roles: SwarmParams['roles']): TestModule =>
        (b) => {
          b.flags.summonHighestHp = false;
          const swarm = b.signature().swarm;
          if (swarm !== null) Object.assign(swarm, { roles, turretRadius: 90, sizeMult: 1 });
        };
      expect(digest(name, [e4([])], { summonDuration: 1 }).hash).toBe(base);
      const plainRole = { damageMult: 1, speedMult: 1, sizeMult: 1, followBonus: 0 };
      const roles = [0, 1, 2].map((slot) => ({ slot, ...plainRole }));
      expect(digest(name, [e4(roles)]).hash).toBe(base);
    },
  );
});

/** Writes `flags` over the run's build flags, as a module would have. */
const setFlags = (ctx: RunContext, flags: Partial<BuildFlags>): void =>
  void Object.assign(ctx.build.flags as BuildFlags, flags);

describe('鎖定信標: summonEliteFirst (lead ruling P2)', () => {
  const ELITE_FIRST = policy({ summonEliteFirst: true });
  const inArena = (e: Enemy): boolean =>
    e.x >= 0 && e.x <= ARENA_WIDTH && e.y >= 0 && e.y <= ARENA_HEIGHT;
  const inMemory = (ctx: RunContext, s: number, id: number): boolean => {
    const ds = ctx.sys.drones;
    for (let k = s * DRONE_MEMORY; k < (s + 1) * DRONE_MEMORY; k++) {
      if (ds.memId[k] === id && (ds.memUntil[k] as number) > ctx.now) return true;
    }
    return false;
  };
  const chasedBy = (ctx: RunContext, e: Enemy, s: number): boolean => {
    const ds = ctx.sys.drones;
    for (let o = 0; o < ds.count; o++) {
      if (o !== s && ds.mode[o] === DRONE_DASH && ds.target[o] === e) return true;
    }
    return false;
  };
  /** The lowest key, then the lowest id: the best of `list` by `key`, or null. */
  const best = (list: readonly Enemy[], key: (e: Enemy) => number): Enemy | null =>
    list.reduce<Enemy | null>((b, e) => {
      if (b === null) return e;
      const d = key(e) - key(b);
      return d < 0 || (d === 0 && e.id < b.id) ? e : b;
    }, null);
  /** The pick's tiers over `cands`: the best unchased one, then the best chased one, or null. */
  const tiers = (ctx: RunContext, s: number, cands: readonly Enemy[], key: (e: Enemy) => number) =>
    best(
      cands.filter((e) => !chasedBy(ctx, e, s)),
      key,
    ) ??
    best(
      cands.filter((e) => chasedBy(ctx, e, s)),
      key,
    );
  /**
   * The brute-force pick of slot s: the alive enemies in the arena out of its memory, by
   * `key` (the farthest from the player for pickOuter, the nearest to the row for pickNearest),
   * through the tiers, the tough ones' first under 鎖定信標.
   */
  function reference(ctx: RunContext, s: number, aim: 'outer' | 'nearest', eliteFirst: boolean) {
    const key = keyOf(ctx, s, aim);
    const cands = ctx.enemies.filter((e) => e.alive && inArena(e) && !inMemory(ctx, s, e.id));
    const tough = eliteFirst
      ? tiers(
          ctx,
          s,
          cands.filter((e) => e.tough),
          key,
        )
      : null;
    return tough ?? tiers(ctx, s, cands, key);
  }
  /** The pick's key for slot s: lower ranks first. */
  function keyOf(ctx: RunContext, s: number, aim: 'outer' | 'nearest'): (e: Enemy) => number {
    const x = ctx.sys.drones.x[s] as number;
    const y = ctx.sys.drones.y[s] as number;
    return aim === 'outer' ? (e) => -e.dist : (e) => (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
  }
  /** Points exactly 250 and 500 from the player, so that some enemies tie on their distance. */
  const TIES: readonly [number, number][] = [
    [150, 200],
    [-200, 150],
    [0, -250],
    [250, 0],
    [300, 400],
    [-400, 300],
    [0, 500],
    [-500, 0],
    [300, -400],
  ];
  const TYPES: readonly EnemyId[] = ['square', 'triangle', 'hexagon', 'boss', 'square'];

  /**
   * A random scene: n enemies (a third at the tied points, some outside the arena, about a
   * third tough, some dead), slot s's memory holding some of them, live or expired, and the
   * other rows dashing at some of them. `rows` makes the rows: a grant's drones or spawned
   * spirits.
   */
  function scene(seed: number, rows: (placed: readonly PlacedEnemy[]) => RunContext, s: number) {
    const rng = createRng(seed);
    const n = 2 + rng.int(10);
    const placed: PlacedEnemy[] = [];
    for (let i = 0; i < n; i++) {
      const type = TYPES[rng.int(TYPES.length)] as EnemyId;
      const tie = TIES[rng.int(TIES.length)] as [number, number];
      const [dx, dy] =
        rng.int(3) === 0
          ? tie
          : [rng.int(ARENA_WIDTH + 120) - 60 - P.x, rng.int(ARENA_HEIGHT + 120) - 60 - P.y];
      placed.push(at(dx, dy, { type, radius: 10 }));
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
    // At the player half the time, where the nearest pick's distances tie too.
    if (rng.int(2) === 0) {
      ds.x[s] = rng.int(ARENA_WIDTH);
      ds.y[s] = rng.int(ARENA_HEIGHT);
    } else {
      ds.x[s] = P.x;
      ds.y[s] = P.y;
    }
    rebuildGrid(ctx);
    return ctx;
  }
  const drones = (placed: readonly PlacedEnemy[]) =>
    field(placed, { grants: [drone({ drones: 4 })], modules: [ELITE_FIRST] });
  const spirits = (aim: 'outer' | 'nearest') => (placed: readonly PlacedEnemy[]) => {
    const ctx = field(placed, { triggers: [holder({ count: 4, aim })], modules: [ELITE_FIRST] });
    spawn(ctx, 0, P);
    return ctx;
  };

  it.each([
    ['a drone', 'outer', drones, DRONE_KIND_DRONE],
    ['an outer spirit', 'outer', spirits('outer'), DRONE_KIND_SPIRIT],
    ['a nearest spirit', 'nearest', spirits('nearest'), DRONE_KIND_SPIRIT],
  ] as const)(
    'picks for %s as a brute-force reference does: the tough tiers, then every enemy',
    (_name, aim, rows, kind) => {
      // Planted bugs: the tough tier skipped for spirits; the tiers in the wrong order (an
      // unchased ordinary enemy before a chased tough one); a tough tier that ignores the
      // memory, the arena or the dead; a tie kept for the higher id.
      const pick = aim === 'outer' ? pickOuter : pickNearest;
      const seen = { differs: 0, chasedTough: 0, fallback: 0, ties: 0, none: 0 };
      for (let round = 0; round < 600; round++) {
        const ctx = scene(9000 + round, rows, 1);
        expect(ctx.sys.drones.kind[1]).toBe(kind);
        const key = keyOf(ctx, 1, aim);
        const want = reference(ctx, 1, aim, true);
        expect(pick(ctx, 1), `round ${round}`).toBe(want);
        // The run without the flag picks as today, and the reference agrees.
        setFlags(ctx, { summonEliteFirst: false });
        const plain = reference(ctx, 1, aim, false);
        expect(pick(ctx, 1), `round ${round}, no flag`).toBe(plain);
        if (want !== plain) seen.differs++;
        if (want === null) seen.none++;
        else if (want.tough && chasedBy(ctx, want, 1)) seen.chasedTough++;
        else if (!want.tough && ctx.enemies.some((e) => e.tough && e.alive && inArena(e))) {
          seen.fallback++;
        }
        if (
          want !== null &&
          ctx.enemies.some((e) => e !== want && e.alive && key(e) === key(want))
        ) {
          seen.ties++;
        }
      }
      // Coverage: the flag changes many picks, the chased tough tier and the fall back to every
      // enemy (each tough one remembered) both happen, and so do ties and empty picks.
      expect(seen.differs).toBeGreaterThan(100);
      expect(seen.chasedTough).toBeGreaterThan(10);
      expect(seen.fallback).toBeGreaterThan(5);
      expect(seen.ties).toBeGreaterThan(20);
      expect(seen.none).toBeGreaterThan(5);
    },
  );

  it('launches a drone at the farthest unchased tough enemy, then a chased tough one before an unchased ordinary one, then as today', () => {
    // Planted bug (wrong tier order): the tough tier kept only for unchased enemies, so a drone
    // whose every tough enemy is chased takes the farthest ordinary one.
    const placed = [at(600, 0), at(300, 0, { type: 'hexagon' }), at(200, 0, { type: 'boss' })];
    const ctx = field(placed, { grants: [drone({ drones: 3 })], modules: [ELITE_FIRST] });
    const ds = ctx.sys.drones;
    // Every slot's pick clock due now (the fill staggers their first picks), in slot order.
    const due = (c: RunContext) => c.sys.drones.nextPick.fill(0);
    due(ctx);
    stage(ctx);
    // Slot 0 takes the elite (300 from the player, the farthest tough one), slot 1 the boss
    // (the farthest unchased tough one), slot 2 the elite again (both tough ones are chased,
    // the elite the farther), never the square 600 away.
    expect(Array.from(ds.targetId.subarray(0, 3))).toEqual([2, 3, 2]);
    // Without it: the farthest unchased each, the square first.
    const plain = field(placed, { grants: [drone({ drones: 3 })] });
    due(plain);
    stage(plain);
    expect(Array.from(plain.sys.drones.targetId.subarray(0, 3))).toEqual([1, 2, 3]);
    // Every tough one dead: today's pick.
    const none = field(placed, { grants: [drone({ drones: 1 })], modules: [ELITE_FIRST] });
    removeEnemy(none, enemy(none, 2));
    removeEnemy(none, enemy(none, 3));
    rebuildGrid(none);
    due(none);
    stage(none);
    expect(none.sys.drones.targetId[0]).toBe(1);
  });

  it.each(['outer', 'nearest'] as const)(
    'sends a %s spirit at the tough enemy first, through the stage',
    (aim) => {
      // Planted bug: the tough tier skipped for spirits (spiritPick past the flag).
      // The row at R, 200 right of the player: a square 60 from it, a square 700 from the
      // player (the farthest), an elite 200 from the row and 400 from the player, and a boss
      // 350 from the row and 150 from the player. None is within a step of the row.
      const R = { x: P.x + 200, y: P.y };
      const placed = [
        at(260, 0),
        at(700, 0),
        at(400, 0, { type: 'hexagon' }),
        at(-150, 0, { type: 'boss' }),
      ];
      const run = (modules: readonly TestModule[]) => {
        const ctx = field(placed, { triggers: [holder({ aim })], modules });
        spawn(ctx, 0, R);
        stage(ctx);
        return ctx.sys.drones.targetId[0];
      };
      // The elite either way under 鎖定信標: the farthest tough one, and the nearest to the row.
      expect(run([ELITE_FIRST])).toBe(3);
      expect(run([])).toBe(aim === 'outer' ? 2 : 1);
    },
  );

  it('fires a turret at the tough enemy nearest to it at any distance, else the nearest, as a brute-force reference does, a crowded grid too', () => {
    // Planted bugs: eliteFirst ignored by turrets; eliteFirst limited to FOCUS_RANGE (the tough
    // enemies far from the player left to the nearest ordinary one).
    const seen = { tough: 0, farTough: 0, plain: 0, grid: 0 };
    for (let round = 0; round < 300; round++) {
      const rng = createRng(4000 + round);
      // Every tenth round past GRID_LINEAR_BELOW (128), so the grid's marked scan picks.
      const n = round % 10 === 0 ? 140 : 1 + rng.int(12);
      const placed: PlacedEnemy[] = [];
      for (let i = 0; i < n; i++) {
        const tough = rng.int(n > 100 ? 40 : 4) === 0;
        placed.push({
          x: 1 + rng.int(ARENA_WIDTH - 2) + rng.next(),
          y: 1 + rng.int(ARENA_HEIGHT - 2) + rng.next(),
          type: tough ? (rng.int(2) === 0 ? 'hexagon' : 'boss') : 'square',
          radius: 10,
        });
      }
      const ctx = field(placed, { grants: [drone({ turrets: 1 })], modules: [ELITE_FIRST] });
      for (const e of ctx.enemies) if (rng.int(6) === 0) removeEnemy(ctx, e);
      rebuildGrid(ctx);
      const alive = ctx.enemies.filter((e) => e.alive);
      const d2 = (e: Enemy) => (e.x - SEAT.x) ** 2 + (e.y - SEAT.y) ** 2;
      const nearest = (list: readonly Enemy[]) =>
        list.reduce<Enemy | null>((b, e) => (b === null || d2(e) < d2(b) ? e : b), null);
      const want = nearest(alive.filter((e) => e.tough)) ?? nearest(alive);
      const fired = eventsOf([fire(ctx)], 'turretFire');
      expect(
        fired.map((f) => f.targetId),
        `round ${round}`,
      ).toEqual(want === null ? [] : [want.id]);
      if (want === null) continue;
      if (want.tough) seen.tough++;
      else seen.plain++;
      if (want.tough && want.dist > FOCUS_RANGE) seen.farTough++;
      if (n > 128) seen.grid++;
    }
    expect(seen.tough).toBeGreaterThan(100);
    expect(seen.farTough).toBeGreaterThan(5);
    expect(seen.plain).toBeGreaterThan(30);
    expect(seen.grid).toBe(30);
  });

  it('takes the tough enemies at any distance for a firing’s later shots too, then the nearest ordinary ones', () => {
    // Planted bugs: eliteFirst on the first shot alone (the later ones on `focused`); limited
    // to FOCUS_RANGE. Two elites past FOCUS_RANGE of the player (850 and 860 right of it) and
    // two squares near the turret.
    const placed = [
      at(150, 0),
      at(850, 100, { type: 'hexagon' }),
      at(140, 30),
      at(860, -100, { type: 'hexagon' }),
    ];
    for (const e of [850, 860]) expect(Math.hypot(e, 100)).toBeGreaterThan(FOCUS_RANGE);
    const values = { projectileCount: 3 };
    const ctx = field(placed, { values, grants: [drone({ turrets: 1 })], modules: [ELITE_FIRST] });
    fire(ctx);
    // The elites, the nearer to the turret first, then the square nearest to it (58 away).
    expect(shotTargets(ctx)).toEqual([2, 4, 3]);
    const plain = field(placed, { values, grants: [drone({ turrets: 1 })] });
    fire(plain);
    expect(shotTargets(plain)).toEqual([3, 1, 2]);
    // Within FOCUS_RANGE a tough enemy is a focus target either way.
    const near = [at(150, 0), at(500, 0, { type: 'boss' })];
    for (const modules of [[ELITE_FIRST], []]) {
      const c = field(near, {
        values: { projectileCount: 1 },
        grants: [drone({ turrets: 1 })],
        modules,
      });
      fire(c);
      expect(shotTargets(c)).toEqual([2]);
    }
  });

  it('fires at a tough enemy outside the arena, past its corners from the player: any distance', () => {
    // Planted bug: the turrets' focus limited to a range, even one past the arena's corners
    // (1,101 from the player). A boss 1,400 right of the player, outside the arena, and a square
    // 100 right of it.
    const placed = [at(100, 0), at(1400, 0, { type: 'boss' })];
    expect(P.x + 1400).toBeGreaterThan(ARENA_WIDTH);
    for (const modules of [[ELITE_FIRST], []]) {
      const ctx = field(placed, {
        values: { projectileCount: 1 },
        grants: [drone({ turrets: 1 })],
        modules,
      });
      fire(ctx);
      expect(shotTargets(ctx)).toEqual([modules.length === 0 ? 1 : 2]);
    }
    // A drone's pick leaves it while its center is outside the arena.
    const drones = field(placed, { grants: [drone({ drones: 1 })], modules: [ELITE_FIRST] });
    expect(pickOuter(drones, 0)?.id).toBe(1);
  });

  it('breaks a tie in the chased tough tier to the lower id, for the outer and the nearest pick alike', () => {
    // Planted bug: the chased tough tier keeping the higher id on a tie (pickOuterTough's or
    // pickNearestTough's second scan). A boss (id 1) and an elite (id 2), both 300 from the
    // player, each chased by another row, the elite by the lower slot; a square 100 from the
    // player that no row chases.
    const placed = [at(-300, 0, { type: 'boss' }), at(300, 0, { type: 'hexagon' }), at(0, 100)];
    const chase = (ctx: RunContext): RunContext => {
      dashing(ctx, 1, enemy(ctx, 2));
      dashing(ctx, 2, enemy(ctx, 1));
      return ctx;
    };
    const outer = (modules: readonly TestModule[]) =>
      chase(field(placed, { grants: [drone({ drones: 3 })], modules }));
    expect(pickOuter(outer([ELITE_FIRST]), 0)?.id).toBe(1);
    expect(pickOuter(outer([]), 0)?.id).toBe(3);
    const nearest = (modules: readonly TestModule[]) => {
      const ctx = field(placed, { triggers: [holder({ count: 3, aim: 'nearest' })], modules });
      spawn(ctx, 0, P);
      return chase(ctx);
    };
    const tied = nearest([ELITE_FIRST]);
    const d2 = (e: Enemy) => (e.x - P.x) ** 2 + (e.y - P.y) ** 2;
    expect(d2(enemy(tied, 1))).toBe(d2(enemy(tied, 2)));
    expect(pickNearest(tied, 0)?.id).toBe(1);
    expect(pickNearest(nearest([]), 0)?.id).toBe(3);
  });

  it('leaves the swarm repeat’s pick (pickOuterFromCenter) alone: the farthest enemy, tough or not', () => {
    const placed = [at(600, 0), at(300, 0, { type: 'hexagon' })];
    const run = (modules: readonly TestModule[]) => {
      const ctx = field(placed, {
        values: { chainCount: 0 },
        triggers: [{ on: 'droneImpact', do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }] }],
        modules: [swarmCounts(1, 0), ...modules],
        signature: SWARM,
      });
      dashing(ctx, 0, enemy(ctx, 2));
      ctx.sys.drones.x[0] = enemy(ctx, 2).x;
      ctx.sys.drones.y[0] = enemy(ctx, 2).y;
      const events = stage(ctx);
      return impacts(events).map((e) => e.targetId);
    };
    expect(run([])).toEqual([2]);
    expect(run([ELITE_FIRST])).toEqual([2]);
  });

  it('scales an impact on an elite and a boss, and not on an ordinary enemy, with a minion-tagged targetKind modifier: its +30 % is data', () => {
    // 鎖定信標's 「對牠們傷害 +30%」: two modifiers, targetKind elite and boss, on the minion tag.
    const scoped: Modifier[] = (['elite', 'boss'] as const).map((kind) => ({
      stat: 'damage',
      kind: 'increased',
      value: 0.3,
      tags: ['minion'],
      when: [{ targetKind: kind }],
    }));
    // A square target, an elite and a boss in its splash (40).
    const placed = [at(200, 0), at(220, 0, { type: 'hexagon' }), at(200, 25, { type: 'boss' })];
    const ctx = field(placed, { scoped, grants: [drone({ drones: 1 })], modules: [ELITE_FIRST] });
    ctx.sys.drones.x[0] = enemy(ctx, 1).x;
    ctx.sys.drones.y[0] = enemy(ctx, 1).y;
    dashing(ctx, 0, enemy(ctx, 1));
    const byId = new Map(hits(stage(ctx)).map((h) => [h.targetId, toNumber(h.amount)]));
    expect([...byId.keys()].sort()).toEqual([1, 2, 3]);
    const plain = byId.get(1) as number;
    expect(plain).toBe(10 * 0.8);
    expect(byId.get(2)).toBeCloseTo(plain * 1.3, 9);
    expect(byId.get(3)).toBeCloseTo(plain * 1.3, 9);
  });
});

describe('蟲海: droneCountMult and dronesStay (lead ruling P3)', () => {
  const DRONE = DRONE_KIND_DRONE;
  const TURRET = DRONE_KIND_TURRET;
  /** [drones, turrets] of the pool's rows, and the summonCapped counter. */
  const counts = (ctx: RunContext): [number, number, number] => {
    const k = kinds(ctx);
    return [
      k.filter((x) => x === DRONE).length,
      k.filter((x) => x === TURRET).length,
      ctx.counters.summonCapped,
    ];
  };

  it('multiplies a grant’s drones and the swarm’s at the fill, and never their turrets', () => {
    // Planted bug: droneCountMult applied to the turrets too.
    const grant = [drone({ drones: 3, turrets: 2 })];
    expect(counts(field([], { grants: grant }))).toEqual([3, 2, 0]);
    expect(counts(field([], { grants: grant, modules: [policy({ droneCountMult: 2 })] }))).toEqual([
      6, 2, 0,
    ]);
    const hive = (modules: readonly TestModule[]) =>
      field([], { modules: [swarmCounts(3, 1), ...modules], signature: SWARM });
    expect(counts(hive([]))).toEqual([3, 1, 0]);
    expect(counts(hive([policy({ droneCountMult: 2 })]))).toEqual([6, 1, 0]);
    expect(counts(hive([policy({ droneCountMult: 3 })]))).toEqual([9, 1, 0]);
    // The docks spread over the multiplied count: six drones 60° apart.
    const ctx = field([], {
      grants: [drone({ drones: 3 })],
      modules: [policy({ droneCountMult: 2 })],
    });
    const ds = ctx.sys.drones;
    for (let s = 0; s < 6; s++) {
      expect((ds.dockX[s] as number) - P.x, `seat ${s}`).toBeCloseTo(
        43 * Math.cos((s * Math.PI) / 3),
        9,
      );
      expect((ds.dockY[s] as number) - P.y, `seat ${s}`).toBeCloseTo(
        43 * Math.sin((s * Math.PI) / 3),
        9,
      );
    }
  });

  it('multiplies before 巨大化 halves: 3 × 2 = 6, halved to 3, and leaves the turrets whole', () => {
    // Planted bug: droneCountMult applied after countOf (3 halved to 1, × 2 = 2).
    const grant = [drone({ drones: 3, turrets: 3 })];
    const giant = field([], {
      grants: grant,
      rules: [GIANT],
      modules: [policy({ droneCountMult: 2 })],
    });
    expect(countOf(giant.build, 6)).toBe(3);
    expect(counts(giant)).toEqual([3, 3, 0]);
    const swarm = field([], {
      rules: [GIANT],
      modules: [swarmCounts(5, 1), policy({ droneCountMult: 3 })],
      signature: SWARM,
    });
    // 5 × 3 = 15, halved to 7 (5 halved to 2, × 3, would be 6).
    expect(counts(swarm)).toEqual([7, 1, 0]);
  });

  it('refuses and counts the rows past the summon cap, as ever: 15 × 2 drones and 2 turrets are 24 rows and 8 refused', () => {
    // gd:193's 「仍受全場上限 24 限制」.
    const grant = [drone({ drones: 15, turrets: 2 })];
    const capped = field([], { grants: grant, modules: [policy({ droneCountMult: 2 })] });
    expect(counts(capped)).toEqual([24, 0, 8]);
    expect(capped.sys.drones.count).toBe(SUMMON_CAP);
    const raised = field([], {
      grants: grant,
      modules: [policy({ droneCountMult: 2 }), raiseCap(40)],
    });
    expect(counts(raised)).toEqual([30, 2, 0]);
  });

  it('never multiplies the timed rows: a spawnDrone of 3 spawns 3', () => {
    // Planted bug: droneCountMult applied to spawnDrone's count.
    for (const modules of [[], [policy({ droneCountMult: 2 })]]) {
      const ctx = field([], {
        grants: [drone({ drones: 1 })],
        triggers: [holder({ count: 3 })],
        modules,
      });
      spawn(ctx, 0, P);
      const k = kinds(ctx);
      expect(k.filter((x) => x === DRONE_KIND_SPIRIT)).toHaveLength(3);
      expect(k.filter((x) => x === DRONE)).toHaveLength(modules.length === 0 ? 1 : 2);
    }
  });

  /**
   * One drone at E1, 200 right of the player (placed with `first`), on its sortie's last impact;
   * E2 and E3 farther.
   */
  function lastImpact(
    modules: readonly TestModule[],
    others = true,
    nextPick = 0,
    first: Omit<PlacedEnemy, 'x' | 'y'> = {},
  ) {
    const placed = [at(200, 0, first), ...(others ? [at(-400, 0), at(0, 300)] : [])];
    const ctx = field(placed, { grants: [drone({ drones: 1 })], modules });
    const ds = ctx.sys.drones;
    const t = enemy(ctx, 1);
    ds.x[0] = t.x;
    ds.y[0] = t.y;
    dashing(ctx, 0, t);
    ds.impactsLeft[0] = 1;
    ds.nextPick[0] = nextPick;
    return ctx;
  }
  const STAY = policy({ dronesStay: true });

  it('sends a drone whose sortie is spent at the next target with a full sortie, not home', () => {
    // Planted bug: dronesStay leaving impactsLeft at 0 (the drone then never spends a sortie).
    const ctx = lastImpact([STAY]);
    const ds = ctx.sys.drones;
    const events = stage(ctx);
    expect(impacts(events).map((e) => e.targetId)).toEqual([1]);
    expect([ds.mode[0], ds.targetId[0], ds.impactsLeft[0]]).toEqual([DRONE_DASH, 2, 3]);
    // Its pick clock restarted with the pick.
    expect(ds.nextPick[0]).toBe(ctx.now + PICK_TICKS);
    // Without it: home, its target kept until it docks, no sortie left.
    const plain = lastImpact([]);
    stage(plain);
    expect([plain.sys.drones.mode[0], plain.sys.drones.impactsLeft[0]]).toEqual([DRONE_RETURN, 0]);
  });

  it('sends a drone whose last impact kills its target at the next target too, not home', () => {
    // Planted bug: dronesStay only for a target the last impact leaves alive (a kill sends the
    // drone home).
    const run = (modules: readonly TestModule[]) => {
      const ctx = field([at(200, 0, { hp: 1 }), at(-400, 0), at(0, 300)], {
        grants: [drone({ drones: 1 })],
        modules,
      });
      const ds = ctx.sys.drones;
      const t = enemy(ctx, 1);
      ds.x[0] = t.x;
      ds.y[0] = t.y;
      dashing(ctx, 0, t);
      ds.impactsLeft[0] = 1;
      ds.nextPick[0] = 0;
      expect(impacts(stage(ctx)).map((e) => e.targetId)).toEqual([1]);
      expect(t.alive).toBe(false);
      return [ds.mode[0], ds.targetId[0], ds.impactsLeft[0]];
    };
    expect(run([STAY])).toEqual([DRONE_DASH, 2, 3]);
    expect(run([])).toEqual([DRONE_RETURN, 1, 0]);
  });

  it('picks on the tick its last impact kills its target, as a drone that lost its target: never on the dead one', () => {
    // Verifier's mutant: the stayed drone kept on its dead target until the next tick.
    const ctx = field([at(200, 0, { hp: 1 }), at(-400, 0), at(0, 300)], {
      grants: [drone({ drones: 1 })],
      modules: [STAY],
    });
    const ds = ctx.sys.drones;
    const t = enemy(ctx, 1);
    ds.x[0] = t.x;
    ds.y[0] = t.y;
    dashing(ctx, 0, t);
    ds.impactsLeft[0] = 1;
    ds.nextPick[0] = 0;
    const events = stage(ctx);
    expect([impacts(events).map((e) => e.targetId), t.alive]).toEqual([[1], false]);
    expect([ds.mode[0], ds.targetId[0], ds.impactsLeft[0]]).toEqual([DRONE_DASH, 2, 3]);
    expect(ds.nextPick[0]).toBe(ctx.now + PICK_TICKS);
  });

  it('hovers until its pick clock allows, as a drone that lost its target, then dashes on: never home', () => {
    const ctx = lastImpact([STAY], true, 6);
    const ds = ctx.sys.drones;
    stage(ctx);
    // It keeps the target its sortie ended on while it hovers, for a pick that finds nothing.
    expect([ds.mode[0], ds.targetId[0], ds.impactsLeft[0]]).toEqual([DRONE_HOVER, 1, 3]);
    const modes: number[] = [];
    while (ctx.now < 6) {
      next(ctx);
      modes.push(ds.mode[0] as number);
    }
    expect(modes).toEqual([DRONE_HOVER, DRONE_HOVER, DRONE_HOVER, DRONE_HOVER, DRONE_DASH]);
    expect(ds.targetId[0]).toBe(2);
  });

  it('flies home only when its pick finds nothing and its target is dead or out of the arena, and docks with a full sortie', () => {
    // Planted bugs: a stayed drone never going home (hovering on when nothing is left); one
    // staying on a target its last impact killed, or on one pushed out of the arena while it
    // hovered (lead ruling on gd:193: home only with no live target left).
    const dock = (ctx: RunContext) => {
      const ds = ctx.sys.drones;
      for (let n = 0; n < 40 && ds.mode[0] !== DRONE_DOCKED; n++) next(ctx);
      return [ds.mode[0], ds.x[0], ds.y[0], ds.impactsLeft[0]];
    };
    // Its last impact kills the one enemy: nothing to pick, nothing to stay on.
    const killed = lastImpact([STAY], false, 0, { hp: 1 });
    const ds = killed.sys.drones;
    stage(killed);
    expect(enemy(killed, 1).alive).toBe(false);
    expect([ds.mode[0], ds.impactsLeft[0]]).toEqual([DRONE_RETURN, 3]);
    expect(dock(killed)).toEqual([DRONE_DOCKED, ds.dockX[0], ds.dockY[0], 3]);
    // The one enemy alive, pushed out of the arena while the drone hovers for its pick clock.
    const pushed = lastImpact([STAY], false, 6);
    const dp = pushed.sys.drones;
    stage(pushed);
    expect([dp.mode[0], dp.targetId[0], dp.impactsLeft[0]]).toEqual([DRONE_HOVER, 1, 3]);
    enemy(pushed, 1).x = -50;
    while (pushed.now < 6) next(pushed);
    expect(dp.mode[0]).toBe(DRONE_RETURN);
    expect(dock(pushed)).toEqual([DRONE_DOCKED, dp.dockX[0], dp.dockY[0], 3]);
  });

  it('stays on its living target when every live enemy is in its memory, up to DRONE_MEMORY of them, picking at once or after hovering', () => {
    // Planted bug: the old rule, home whenever the pick finds nothing (here each live enemy is
    // in the drone's cooldown memory: E1 just impacted, the others impacted lately).
    const placed = [at(200, 0), at(-400, 0), at(0, 300), at(0, -300)];
    expect(placed).toHaveLength(DRONE_MEMORY);
    for (let n = 1; n <= DRONE_MEMORY; n++) {
      for (const nextPick of [0, 6]) {
        const ctx = field(placed.slice(0, n), { grants: [drone({ drones: 1 })], modules: [STAY] });
        const ds = ctx.sys.drones;
        const t = enemy(ctx, 1);
        ds.x[0] = t.x;
        ds.y[0] = t.y;
        dashing(ctx, 0, t);
        ds.impactsLeft[0] = 1;
        ds.nextPick[0] = nextPick;
        for (let id = 2; id <= n; id++) memorize(ctx, 0, id - 1, id, 1000);
        expect(impacts(stage(ctx)).map((e) => e.targetId)).toEqual([1]);
        while (ctx.now < nextPick) next(ctx);
        expect(pickOuter(ctx, 0), `${n} enemies, clock ${nextPick}`).toBe(null);
        expect([ds.mode[0], ds.targetId[0], ds.impactsLeft[0]], `${n}, ${nextPick}`).toEqual([
          DRONE_DASH,
          1,
          3,
        ]);
      }
    }
  });

  it('restarts its pick clock when it stays on its target, as every pick does: a loss before the clock allows then hovers', () => {
    // Verifier's mutant: the fallback on the kept target leaving the pick clock as it was.
    const ctx = field([at(200, 0), at(-400, 0)], {
      grants: [drone({ drones: 1 })],
      modules: [STAY],
    });
    const ds = ctx.sys.drones;
    const t = enemy(ctx, 1);
    ds.x[0] = t.x;
    ds.y[0] = t.y;
    dashing(ctx, 0, t);
    ds.impactsLeft[0] = 1;
    ds.nextPick[0] = 0;
    memorize(ctx, 0, 1, 2, 1000);
    expect(impacts(stage(ctx)).map((e) => e.targetId)).toEqual([1]);
    expect(pickOuter(ctx, 0)).toBe(null);
    expect([ds.mode[0], ds.targetId[0], ds.nextPick[0]]).toEqual([
      DRONE_DASH,
      1,
      ctx.now + PICK_TICKS,
    ]);
    // Its kept target dies on the next tick, before the clock allows: it hovers, not home.
    removeEnemy(ctx, t);
    next(ctx);
    expect([t.alive, ds.mode[0], ds.targetId[0]]).toEqual([false, DRONE_HOVER, -1]);
  });

  it('stays on a lone boss across its sorties, impacting it each time its memory lets it, never home while it lives, and home once it dies', () => {
    // Planted bug: the old rule, a stayed drone flying home after every sortie on a lone target
    // (in its memory after each impact, so the pick finds nothing): gd:193's 「撞完不回巢」.
    const run = (modules: readonly TestModule[]) => {
      const ctx = field([at(300, 0, { type: 'boss', hp: 1e15 })], {
        grants: [drone({ drones: 1 })],
        modules,
      });
      const ds = ctx.sys.drones;
      const boss = enemy(ctx, 1);
      expect(boss.tough).toBe(true);
      const ticks: number[] = [];
      const ids = new Set<number>();
      const modes = new Set<number>();
      for (let n = 0; n < 600; n++) {
        for (const e of impacts(next(ctx))) {
          ticks.push(ctx.now);
          ids.add(e.targetId);
        }
        // Its modes from its first impact on.
        if (ticks.length > 0) modes.add(ds.mode[0] as number);
      }
      const gaps = ticks.slice(1).map((tick, i) => tick - (ticks[i] as number));
      return { ctx, ticks, ids, gaps, modes: [...modes].sort((a, b) => a - b) };
    };
    const stay = run([STAY]);
    const ds = stay.ctx.sys.drones;
    // The emitter's cooldown at m = 1 (attack speed at its base, cadence 1): the memory's span.
    const em = emitterOf(stay.ctx, 0);
    const cool = ds.coolTicks[em.index] as number;
    expect([stay.ctx.build.values.attackSpeed, em.cadence, cool]).toEqual([
      BASE_ATTACK_SPEED,
      1,
      30,
    ]);
    // More than five sorties of 3, every impact at the boss and one cooldown after the last.
    expect(stay.ticks.length).toBeGreaterThan(15);
    expect(stay.ids).toEqual(new Set([1]));
    expect(new Set(stay.gaps)).toEqual(new Set([cool]));
    expect(stay.modes).toEqual([DRONE_DASH]);
    // Without 蟲海: home after each sortie, docked between.
    const plain = run([]);
    expect(plain.modes).toEqual([DRONE_DOCKED, DRONE_DASH, DRONE_RETURN]);
    expect(Math.max(...plain.gaps)).toBeGreaterThan(cool);
    // The boss dies: the stayed drone loses it, finds nothing and flies home.
    removeEnemy(stay.ctx, enemy(stay.ctx, 1));
    for (let n = 0; n < 60 && ds.mode[0] !== DRONE_DOCKED; n++) next(stay.ctx);
    expect(ds.mode[0]).toBe(DRONE_DOCKED);
  });

  it('never flies home in a field it always finds a target in, and spends its sorties: a long run of the stage', () => {
    // Five far, immortal squares: more than a drone's memory holds, so a pick always finds one.
    const placed = [at(600, 0), at(-600, 0), at(0, 400), at(0, -400), at(500, 300)];
    const run = (modules: readonly TestModule[]) => {
      const ctx = field(placed, { grants: [drone({ drones: 2 })], modules });
      const ds = ctx.sys.drones;
      let returns = 0;
      let impactsSeen = 0;
      for (let n = 0; n < 900; n++) {
        impactsSeen += impacts(next(ctx)).length;
        for (let s = 0; s < 2; s++) {
          if (ds.mode[s] === DRONE_RETURN) returns++;
          // Under 蟲海 a sortie is never spent at a stage's end.
          if (modules.length > 0) expect(ds.impactsLeft[s], `tick ${ctx.now}`).toBeGreaterThan(0);
        }
      }
      return [returns, impactsSeen];
    };
    // No tick of 900 in RETURN, and more impacts than the drones that fly home (448 ticks of
    // RETURN between them).
    expect(run([STAY])).toEqual([0, 36]);
    expect(run([])).toEqual([448, 28]);
  });

  it('leaves the spirits alone: a spirit’s last impact makes it leave spent', () => {
    // Planted bug: dronesStay on the spirits (their impacts refilled, so they never leave spent).
    for (const impactsOf of [1, 2]) {
      const ctx = field([at(205, 0), at(-300, 0), at(0, 300)], {
        triggers: [holder({ impacts: impactsOf })],
        modules: [STAY],
      });
      spawn(ctx, 0, { x: P.x + 200, y: P.y });
      const expired: string[] = [];
      let impactsSeen = 0;
      for (let n = 0; n < 200 && ctx.sys.drones.count > 0; n++) {
        const events = n === 0 ? stage(ctx) : next(ctx);
        impactsSeen += impacts(events).length;
        expired.push(...eventsOf([events], 'droneExpire').map((e) => e.cause));
      }
      expect([impactsSeen, expired]).toEqual([impactsOf, ['spent']]);
    }
  });
});

/** An enemy (dx, dy) from SEAT. */
const fromSeat = (
  dx: number,
  dy: number,
  more: Omit<PlacedEnemy, 'x' | 'y'> = {},
): PlacedEnemy => ({
  x: SEAT.x + dx,
  y: SEAT.y + dy,
  ...more,
});
/** One shot a firing: the splash and chain tests read one arrival. */
const ONE_SHOT = { projectileCount: 1 };
const TURRET = [drone({ turrets: 1 })];
/** The turret's one shot fired and landed: the arrival's events. */
function shoot(ctx: RunContext): SimEvent[] {
  fire(ctx);
  expect(ctx.shots.count).toBe(1);
  return land(ctx);
}

describe('加農砲: turretRateMult and turretSplash (lead ruling P4)', () => {
  it('multiplies the turrets’ rate: 1/3 gives three times the period, the grant’s and the swarm’s, and leaves the cadence', () => {
    // Planted bug: turretRateMult dividing the rate (a third of the period).
    for (const attackSpeed of [4, 8, 6.5]) {
      const base = periodTicks((TURRET_RATE * attackSpeed) / BASE_ATTACK_SPEED);
      const runs = [
        [field([], { values: { attackSpeed }, grants: TURRET }), 1],
        [
          field([], {
            values: { attackSpeed },
            grants: TURRET,
            modules: [policy({ turretRateMult: 1 / 3 })],
          }),
          0,
        ],
        [
          field([], {
            values: { attackSpeed },
            modules: [swarmCounts(0, 1), policy({ turretRateMult: 1 / 3 })],
            signature: SWARM,
          }),
          0,
        ],
      ] as const;
      const [plain, slow, swarm] = runs.map(
        ([ctx, i]) => ctx.emitters[i === 1 ? 1 : ctx.emitters.length - 1] as EmitterRuntime,
      );
      expect((plain as EmitterRuntime).interval).toBe(base);
      expect((slow as EmitterRuntime).interval).toBeCloseTo(3 * base, 9);
      expect((swarm as EmitterRuntime).interval).toBeCloseTo(3 * base, 9);
      expect((slow as EmitterRuntime).cadence).toBe((plain as EmitterRuntime).cadence);
    }
    // 2 a second at the base attack speed, so every 30 ticks; ÷3, every 90.
    const at4 = field([], { grants: TURRET, modules: [policy({ turretRateMult: 1 / 3 })] });
    expect((at4.emitters[1] as EmitterRuntime).interval).toBe(90);
  });

  it('fires every 90 ticks at 1/3 where it fired every 30, the accumulator banking as ever', () => {
    const run = (modules: readonly TestModule[]) => {
      const ctx = field([at(300, 0)], { values: ONE_SHOT, grants: TURRET, modules });
      const ticks: number[] = [];
      for (let n = 0; n < 400; n++)
        if (eventsOf([next(ctx)], 'turretFire').length > 0) ticks.push(ctx.now);
      return ticks.slice(1).map((t, i) => t - (ticks[i] as number));
    };
    expect(new Set(run([]))).toEqual(new Set([30]));
    const slow = run([policy({ turretRateMult: 1 / 3 })]);
    expect(slow.length).toBeGreaterThan(2);
    expect(new Set(slow)).toEqual(new Set([90]));
  });

  const CANNON = policy({ turretSplash: 60 });

  it('hits every enemy within the radius of the target’s center, the edge in and just past it out, at areaSize 1.2 too', () => {
    // Planted bug: the splash's radius not sized (sizeOf) at the fill.
    for (const areaSize of [1, 1.2, 1.25]) {
      const probe = field([], { values: { areaSize }, grants: TURRET, modules: [CANNON] });
      const r = sizeOf(probe.build, 60);
      expect(r).toBeCloseTo(60 * areaSize, 9);
      // The target 200 from the turret, the others farther from it: at r below (in), r + 0.001
      // above (out), on a 3-4-5 diagonal at r where that is exact, else just inside it (in), and
      // r + 0.01 right (out).
      const diag = areaSize === 1.2 ? r - 0.001 : r;
      const placed = [
        fromSeat(200, 0),
        fromSeat(200, r),
        fromSeat(200, -(r + 0.001)),
        fromSeat(200 + 0.6 * diag, 0.8 * diag),
        fromSeat(200 + r + 0.01, 0),
      ];
      const ctx = field(placed, {
        values: { ...ONE_SHOT, areaSize },
        grants: TURRET,
        modules: [CANNON],
      });
      // The diagonal's squared distance is r² or just under: in.
      const d = enemy(ctx, 4);
      expect((d.x - enemy(ctx, 1).x) ** 2 + (d.y - enemy(ctx, 1).y) ** 2).toBeLessThanOrEqual(
        r * r,
      );
      const events = shoot(ctx);
      expect(hitIds(events), `areaSize ${areaSize}`).toEqual([1, 2, 4]);
      expect(impacts(events)).toEqual([
        {
          type: 'impact',
          droneId: -1,
          x: enemy(ctx, 1).x,
          y: enemy(ctx, 1).y,
          radius: r,
          targetId: 1,
          count: 3,
        },
      ]);
      expect(events.at(-1)?.type).toBe('impact');
    }
  });

  it('lists the splash before any hit: the children of a target it kills take none of its hits', () => {
    // Planted bug: the splash listed after the target's hit.
    const placed = [fromSeat(200, 0, { type: 'pentagon', hp: 5 }), fromSeat(210, 40)];
    const ctx = field(placed, {
      values: { ...ONE_SHOT, damage: 20 },
      grants: TURRET,
      modules: [CANNON],
    });
    const target = enemy(ctx, 1);
    const events = shoot(ctx);
    expect(target.alive).toBe(false);
    const children = ctx.enemies.slice(2);
    expect(children.map((e) => [e.type, e.alive])).toEqual(Array(3).fill(['shard', true]));
    for (const child of children) {
      expect(Math.hypot(child.x - target.x, child.y - target.y)).toBeLessThan(60);
      expect(toNumber(child.hp)).toBe(toNumber(child.maxHp));
    }
    expect(hitIds(events)).toEqual([1, 2]);
    expect(impacts(events).map((e) => [e.targetId, e.count])).toEqual([[1, 2]]);
  });

  it('hits the target once, then the others in id order, each once, every hit tagged area too; no center event', () => {
    // Planted bugs: the target hit twice by its own splash; the hits out of id order.
    let centerEvents = 0;
    const hooks: TestModule = (b) => void b.hook('onCenterEvent', () => void centerEvents++);
    // Ids 1 and 3 in the splash of the target, id 2, nearest to the turret.
    const placed = [fromSeat(150, 50), fromSeat(150, 0), fromSeat(180, -40), fromSeat(150, -30)];
    const ctx = field(placed, { values: ONE_SHOT, grants: TURRET, modules: [CANNON, hooks] });
    const events = shoot(ctx);
    expect(hitIds(events)).toEqual([2, 1, 3, 4]);
    for (const hit of hits(events)) {
      expect([hit.tags, hit.chainIndex, toNumber(hit.amount)]).toEqual([
        SHOT_TAGS | TAG.area,
        0,
        4,
      ]);
    }
    expect(centerEvents).toBe(0);
    expect(eventsOf([events], 'impact').map((e) => [e.targetId, e.count])).toEqual([[2, 4]]);
    // Without the splash: the target alone, no area tag, no impact event.
    const plain = field(placed, { values: ONE_SHOT, grants: TURRET });
    const alone = shoot(plain);
    expect(hits(alone).map((h) => [h.targetId, h.tags])).toEqual([[2, SHOT_TAGS]]);
    expect(impacts(alone)).toEqual([]);
    // The payloads carry the area tag from the fill on, the swarm's turret's too.
    const swarm = field([], { modules: [swarmCounts(0, 1), CANNON], signature: SWARM });
    expect((swarm.sys.drones.turretPayload[0] as { tags: number }).tags & TAG.area).toBe(TAG.area);
    expect((ctx.sys.drones.turretPayload[1] as { tags: number }).tags).toBe(SHOT_TAGS | TAG.area);
  });

  it('crits every splash hit of a steady turret shot, as the shot’s own hit', () => {
    // Planted bug: the splash's other hits dealt unsteady, so a steady shot (steadyAim, or an
    // onAttack hook's forceCrit) crits its target alone.
    const forceCrit: TestModule = (b) =>
      b.hook('onAttack', (_ctx, _em, shot) => {
        shot.forceCrit = true;
      });
    const placed = [fromSeat(150, 0), fromSeat(150, 40), fromSeat(180, -30)];
    const ctx = field(placed, {
      values: { ...ONE_SHOT, chainCount: 0 },
      modules: [swarmCounts(0, 1), CANNON, forceCrit],
      signature: SWARM,
    });
    expect(hits(shoot(ctx)).map((h) => [h.targetId, h.crit])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
  });

  it('skips a listed enemy that dies before its turn, and hits the signature turret’s splash after its primary hit and chain', () => {
    // The swarm's turret: its primary hit, its chain (chainCount 1), then the splash.
    const placed = [fromSeat(150, 0), fromSeat(150, 50), fromSeat(180, -40)];
    const ctx = field(placed, {
      values: { ...ONE_SHOT, chainCount: 1 },
      modules: [swarmCounts(0, 1), CANNON],
      signature: SWARM,
    });
    const events = shoot(ctx);
    const list = hits(events).map((h) => [h.targetId, h.chainIndex]);
    // The chain jumps to the nearest enemy not hit (id 2, 50 away); the splash hits 2 and 3.
    expect(list).toEqual([
      [1, 0],
      [2, 1],
      [2, 0],
      [3, 0],
    ]);
    expect(impacts(events).map((e) => [e.droneId, e.targetId, e.count])).toEqual([[-1, 1, 3]]);
    // A hook kills id 3 on the target's hit, after the list was taken: no hit for it, though the
    // impact counts it.
    const killer: TestModule = (b) =>
      void b.hook('onHit', (c, hit) => {
        const third = enemy(c, 3);
        if (hit.target.id === 1 && third.alive) removeEnemy(c, third);
      });
    const granted = field(placed, { values: ONE_SHOT, grants: TURRET, modules: [CANNON, killer] });
    const skipped = shoot(granted);
    expect(hitIds(skipped)).toEqual([1, 2]);
    expect(impacts(skipped).map((e) => e.count)).toEqual([3]);
  });

  it('gives PRIMARY to the signature turret’s primary hit alone: its chain jump and its splash hits are plain', () => {
    // Verifier's mutants: the signature turret's splash hits carrying PRIMARY, or the target's
    // position as their source.
    const seen: [number, number, boolean][] = [];
    const watch: TestModule = (b) =>
      void b.hook(
        'onHit',
        (_c, hit) => void seen.push([hit.target.id, hit.chainIndex, (hit.flags & PRIMARY) !== 0]),
      );
    const placed = [fromSeat(150, 0), fromSeat(150, 50), fromSeat(180, -40)];
    const ctx = field(placed, {
      values: { ...ONE_SHOT, chainCount: 1 },
      modules: [swarmCounts(0, 1), CANNON, watch],
      signature: SWARM,
    });
    const events = shoot(ctx);
    expect(seen).toEqual([
      [1, 0, true],
      [2, 1, false],
      [2, 0, false],
      [3, 0, false],
    ]);
    // Only the jump comes from a point (its arc); the splash hits, as the primary hit, from none.
    expect(hits(events).map((h) => h.fromX === null && h.fromY === null)).toEqual([
      true,
      false,
      true,
      true,
    ]);
    // A granted turret's: no PRIMARY on any of its hits.
    seen.length = 0;
    shoot(field(placed, { values: ONE_SHOT, grants: TURRET, modules: [CANNON, watch] }));
    expect(seen).toEqual([
      [1, 0, false],
      [2, 0, false],
      [3, 0, false],
    ]);
  });

  it('sizes the splash by the area alone: E3’s spreadRadius leaves it, as every radius but a spread', () => {
    // Verifier's port mutant: the splash × the spread factor too.
    const ctx = field([], {
      values: { spreadRadius: 1.5, areaSize: 1.2 },
      grants: TURRET,
      modules: [CANNON],
    });
    expect([ctx.build.flags.spreadFactor, ctx.build.flags.areaFactor]).toEqual([1.5, 1.2]);
    const r = sizeOf(ctx.build, 60);
    expect(r).toBeCloseTo(72, 9);
    expect(ctx.sys.drones.turretSplashSq).toBe(r * r);
  });
});

describe('特斯拉塔: turretChains (lead ruling P5)', () => {
  /** A target 150 from the turret and five enemies 40 apart beyond it, in chain range. */
  const CHAIN_FIELD = [
    fromSeat(150, 0),
    fromSeat(190, 0),
    fromSeat(230, 0),
    fromSeat(270, 0),
    fromSeat(310, 0),
    fromSeat(350, 0),
  ];
  const jumps = (events: readonly SimEvent[]): number[] =>
    hits(events)
      .filter((h) => h.chainIndex > 0)
      .map((h) => h.chainIndex);
  const granted = (
    chains: number,
    rules: readonly RuleSpec[] = [],
    more: readonly TestModule[] = [],
  ) =>
    field(CHAIN_FIELD, {
      values: ONE_SHOT,
      grants: TURRET,
      rules,
      modules: [policy({ turretChains: chains }), ...more],
    });
  const swarm = (chains: number, chainCount: number, rules: readonly RuleSpec[] = []) =>
    field(CHAIN_FIELD, {
      values: { ...ONE_SHOT, chainCount },
      rules,
      modules: [swarmCounts(0, 1), policy({ turretChains: chains })],
      signature: SWARM,
    });

  it('chains a granted turret’s hit 2 jumps as an attack of its own, whatever its payload’s chains', () => {
    const ctx = granted(2);
    expect((ctx.sys.drones.turretPayload[1] as { chains: boolean }).chains).toBe(false);
    const serial = ctx.attackSerial;
    const events = shoot(ctx);
    expect(hits(events).map((h) => [h.targetId, h.chainIndex])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    for (const h of hits(events).slice(1)) expect(h.tags).toBe(JUMP_TAGS);
    expect(ctx.attackSerial).toBe(serial + 1);
    // Without: its plain hit alone, no attack.
    const plain = granted(0);
    const alone = shoot(plain);
    expect(jumps(alone)).toEqual([]);
    expect(plain.attackSerial).toBe(serial);
  });

  it('counts a granted turret’s chained hit as one attack in chainHitsPeak: its hit and its jumps, as the signature turret’s', () => {
    // Verifier's mutants: the attack ended before its chain; its hit counted twice, or not at all.
    const peak = (ctx: RunContext): number => {
      expect(ctx.counters.chainHitsPeak).toBe(0);
      shoot(ctx);
      return ctx.counters.chainHitsPeak;
    };
    expect(peak(granted(2))).toBe(3);
    expect(peak(granted(0))).toBe(0);
    expect(peak(swarm(2, 0))).toBe(3);
  });

  it('adds the jumps to the signature turret’s chain: chainCount 1 + 2', () => {
    // Planted bug: turretChains lost on the signature turret.
    expect(jumps(shoot(swarm(2, 1)))).toEqual([1, 2, 3]);
    expect(jumps(shoot(swarm(0, 1)))).toEqual([1]);
    expect(jumps(shoot(swarm(2, 0)))).toEqual([1, 2]);
  });

  it('halves the jumps under 巨大化, as every chain count: 2 to 1, 3 to 1, 5 to 2', () => {
    // Planted bug: turretChains not halved (countOf) under 巨大化.
    expect(jumps(shoot(granted(2, [GIANT])))).toEqual([1]);
    expect(jumps(shoot(granted(3, [GIANT])))).toEqual([1]);
    expect(jumps(shoot(granted(5, [GIANT])))).toEqual([1, 2]);
    // The swarm's chainCount 2 halved to 1, plus the jumps 2 halved to 1.
    const giant = swarm(2, 2, [GIANT]);
    expect([giant.chainCount, giant.sys.drones.turretJumps]).toEqual([1, 1]);
    expect(jumps(shoot(giant))).toEqual([1, 2]);
  });

  it('counts a granted turret’s chained hit and its jumps in its attack’s chain budget, none of them primary', () => {
    // Planted bugs: the hit left out of the chain budget, or the attack never ended (its hits
    // missing from chainHitsPeak); the hit dealt as a primary hit, as a signature attack's is.
    const primary: number[] = [];
    const watch: TestModule = (b) =>
      b.hook('onHit', (_ctx, hit) => {
        primary.push(hit.flags & PRIMARY);
      });
    const ctx = granted(2, [], [watch]);
    expect(ctx.counters.chainHitsPeak).toBe(0);
    expect(hits(shoot(ctx)).map((h) => h.chainIndex)).toEqual([0, 1, 2]);
    expect(ctx.counters.chainHitsPeak).toBe(3);
    expect(primary).toEqual([0, 0, 0]);
  });

  it('never chains from a splash hit: the jumps are the target’s alone', () => {
    // Planted bug: splash hits chaining.
    const cannon = policy({ turretSplash: 60 });
    const ctx = granted(2, [], [cannon]);
    const events = shoot(ctx);
    // The target, its two jumps (ids 2 and 3), then its splash: id 2, 40 away (3 is 80 away).
    expect(hits(events).map((h) => [h.targetId, h.chainIndex])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [2, 0],
    ]);
  });
});

describe('the droneSpeed stat (lead ruling P6)', () => {
  /** The pool's per-emitter tables of emitter `i` and its spawn specs' steps. */
  const tables = (ctx: RunContext, i: number) => {
    const ds = ctx.sys.drones;
    return {
      step: ds.stepBase[i],
      dock: ds.dockTicks[i],
      cool: ds.coolTicks[i],
      impacts: ds.impacts[i],
      splashSq: ds.splashSq[i],
      interval: (ctx.emitters[i] as EmitterRuntime).interval,
      specSteps: ds.specs === null ? [] : Array.from(ds.specs.stepBase),
      specCool: ds.specs === null ? [] : Array.from(ds.specs.coolTicks),
    };
  };
  const SPAWNS = [holder(), holder({ speed: 200 })];
  const ctxAt = (droneSpeed: number, swarm = false) =>
    swarm
      ? field([], {
          values: { droneSpeed },
          triggers: SPAWNS,
          modules: [swarmCounts(2, 1)],
          signature: SWARM,
        })
      : field([], {
          values: { droneSpeed },
          grants: [drone({ drones: 2, turrets: 1 })],
          triggers: SPAWNS,
        });

  it('multiplies the step of every drone emitter and every spawnDrone spec, and nothing else: 1.5', () => {
    // Planted bugs: droneSpeed applied to the dock time; droneSpeed missing on the spawnDrone
    // specs.
    for (const swarm of [false, true]) {
      const i = swarm ? 0 : 1;
      const plain = tables(ctxAt(1, swarm), i);
      const fast = tables(ctxAt(1.5, swarm), i);
      expect(plain.step).toBe(STEP);
      expect(fast.step).toBe(1.5 * STEP);
      expect(plain.specSteps.filter((x) => x > 0)).toEqual([STEP, 200 / TICK_RATE]);
      expect(fast.specSteps.filter((x) => x > 0)).toEqual([1.5 * STEP, (1.5 * 200) / TICK_RATE]);
      expect({ ...fast, step: 0, specSteps: [] }).toEqual({ ...plain, step: 0, specSteps: [] });
    }
  });

  it('flies a drone 15 a tick at 1.5, its turret’s shots at their own speed', () => {
    const run = (droneSpeed: number) => {
      const ctx = field([at(400, 0)], {
        values: { droneSpeed, projectileCount: 1 },
        grants: [drone({ drones: 1, turrets: 1 })],
      });
      const ds = ctx.sys.drones;
      ds.nextPick[0] = 0;
      ds.acc[1] = emitterOf(ctx, 1).interval;
      const x0 = ds.x[0] as number;
      stage(ctx);
      const dashed = (ds.x[0] as number) - x0;
      const sx = ctx.shots.x[0] as number;
      ctx.now = ++ctx.state.tick;
      rebuildGrid(ctx);
      moveProjectiles(ctx);
      return [dashed, (ctx.shots.x[0] as number) - sx];
    };
    const [plainDash, plainShot] = run(1);
    const [fastDash, fastShot] = run(1.5);
    expect([plainDash, fastDash]).toEqual([STEP, 1.5 * STEP]);
    expect(fastShot).toBe(plainShot);
  });

  it('clamps a negative droneSpeed to 0, on the drones and the spawn specs alike', () => {
    // Planted bug: the clamp missing (a negative step flies the rows away from their targets).
    for (const swarm of [false, true]) {
      const t = tables(ctxAt(-0.5, swarm), swarm ? 0 : 1);
      expect(t.step).toBe(0);
      expect(t.specSteps).toEqual(t.specSteps.map(() => 0));
    }
  });

  it('at 0 a drone launches and never moves: it impacts only an enemy whose edge reaches it, then snaps to it', () => {
    const still = field([at(400, 0)], {
      values: { droneSpeed: 0 },
      grants: [drone({ drones: 1 })],
    });
    const ds = still.sys.drones;
    ds.nextPick[0] = 0;
    const home = [ds.x[0], ds.y[0]];
    let seen = 0;
    for (let n = 0; n < 200; n++) seen += impacts(n === 0 ? stage(still) : next(still)).length;
    expect([seen, ds.mode[0], ds.x[0], ds.y[0]]).toEqual([0, DRONE_DASH, ...home]);
    // An enemy walking in from 150 at 120 a second (2 a tick): its edge (radius 20) reaches the
    // drone at its dock, 43 from the player, and the drone impacts it there.
    const walk = field([at(150, 0, { speed: 120 })], {
      values: { droneSpeed: 0 },
      grants: [drone({ drones: 1 })],
    });
    const wd = walk.sys.drones;
    wd.nextPick[0] = 0;
    const dock = wd.x[0] as number;
    let tick = -1;
    for (let n = 0; n < 120 && tick < 0; n++) {
      walk.now = ++walk.state.tick;
      moveEnemies(walk);
      rebuildGrid(walk);
      const events = stage(walk);
      if (impacts(events).length > 0) tick = walk.now;
      else expect(wd.x[0]).toBe(dock);
    }
    const e = enemy(walk, 1);
    expect(tick).toBeGreaterThan(0);
    expect(e.x - dock).toBeLessThanOrEqual(20);
    expect([wd.x[0], wd.y[0]]).toEqual([e.x, e.y]);
  });

  it('at 0 a spirit hovers where it spawned, impacts only an enemy that walks onto it, and leaves on time', () => {
    const ctx = field([at(500, 0)], {
      values: { droneSpeed: 0 },
      triggers: [holder({ lifeSec: 2 })],
    });
    const R = { x: P.x + 200, y: P.y };
    spawn(ctx, 0, R);
    const ds = ctx.sys.drones;
    const causes: string[] = [];
    let seen = 0;
    for (let n = 0; n < 200 && ds.count > 0; n++) {
      const events = n === 0 ? stage(ctx) : next(ctx);
      seen += impacts(events).length;
      causes.push(...eventsOf([events], 'droneExpire').map((e) => e.cause));
      if (ds.count > 0) expect([ds.x[0], ds.y[0]]).toEqual([R.x, R.y]);
    }
    expect([seen, causes]).toEqual([0, ['time']]);
    // An enemy walking onto it from 100 beyond it.
    const walk = field([at(300, 0, { speed: 120 })], {
      values: { droneSpeed: 0 },
      triggers: [holder()],
    });
    spawn(walk, 0, R);
    let hit = 0;
    for (let n = 0; n < 120 && hit === 0; n++) {
      walk.now = ++walk.state.tick;
      moveEnemies(walk);
      rebuildGrid(walk);
      hit += impacts(stage(walk)).length;
    }
    expect(hit).toBe(1);
  });
});

describe('compileBuild’s checks on the summon policies (lead rulings P3–P5)', () => {
  const compileWith = (flags: Partial<BuildFlags>) => () =>
    compileBuild(makeStats(), [], undefined, [policy(flags)]);

  it('throws, naming the flag, on a droneCountMult that is not a whole number ≥ 1', () => {
    // Planted bug: compileBuild accepting droneCountMult 1.5.
    for (const v of [1.5, 0, -1, Number.NaN, Infinity]) {
      expect(compileWith({ droneCountMult: v }), String(v)).toThrow(
        `droneCountMult: ${v} must be a whole number >= 1`,
      );
    }
    for (const v of [1, 2, 3])
      expect(compileWith({ droneCountMult: v })().flags.droneCountMult).toBe(v);
  });

  it('throws on a turretRateMult that is not finite and above 0', () => {
    for (const v of [0, -1 / 3, Number.NaN, Infinity]) {
      expect(compileWith({ turretRateMult: v }), String(v)).toThrow(
        `turretRateMult: ${v} must be finite and above 0`,
      );
    }
    for (const v of [1 / 3, 1, 2.5])
      expect(compileWith({ turretRateMult: v })().flags.turretRateMult).toBe(v);
  });

  it('throws on a turretSplash below 0 or not finite', () => {
    for (const v of [-1, -0.001, Number.NaN, Infinity]) {
      expect(compileWith({ turretSplash: v }), String(v)).toThrow(
        `turretSplash: ${v} must be finite and >= 0`,
      );
    }
    for (const v of [0, 60, 12.5])
      expect(compileWith({ turretSplash: v })().flags.turretSplash).toBe(v);
  });

  it('throws on a turretChains that is not a whole number ≥ 0', () => {
    for (const v of [1.5, -1, Number.NaN, Infinity]) {
      expect(compileWith({ turretChains: v }), String(v)).toThrow(
        `turretChains: ${v} must be a whole number >= 0`,
      );
    }
    for (const v of [0, 2, 7])
      expect(compileWith({ turretChains: v })().flags.turretChains).toBe(v);
  });
});

describe('蟲海’s −45 % on the fixed drones alone, as data (For B1, not expressible (1); verifier)', () => {
  // The spirits' own tag (spawnDrone's `tags`) in the modifier's notTags keeps them out of it,
  // and projectile keeps the turrets out.
  const CUT: Modifier = {
    stat: 'damage',
    kind: 'more',
    value: -0.45,
    tags: ['minion'],
    notTags: ['projectile', 'trigger'],
  };
  const IMPACT = TAG.hit | TAG.minion | TAG.area;
  /** A fixed drone's impact on E1, 200 right of the player: its hits' tags and amounts. */
  const droneHits = (scoped: readonly Modifier[]) => {
    const ctx = field([at(200, 0)], { scoped, grants: [drone({ drones: 1 })] });
    const t = enemy(ctx, 1);
    ctx.sys.drones.x[0] = t.x;
    ctx.sys.drones.y[0] = t.y;
    dashing(ctx, 0, t);
    return hits(stage(ctx)).map((h) => [h.tags, toNumber(h.amount)]);
  };
  /** The first impact's hits of a spirit of a spawnDrone with `fields`, spawned beside E1. */
  const spiritHits = (scoped: readonly Modifier[], fields: Partial<SpawnDroneSpec> = {}) => {
    const ctx = field([at(205, 0)], { scoped, triggers: [holder(fields)] });
    spawn(ctx, 0, { x: P.x + 200, y: P.y });
    for (let n = 0; n < 200; n++) {
      const found = hits(n === 0 ? stage(ctx) : next(ctx));
      if (found.length > 0) return found.map((h) => [h.tags, toNumber(h.amount)]);
    }
    throw new Error('the spirit never hits');
  };
  const shotHits = (scoped: readonly Modifier[]) =>
    hits(shoot(field([fromSeat(150, 0)], { scoped, values: ONE_SHOT, grants: TURRET }))).map(
      (h) => [h.tags, toNumber(h.amount)],
    );

  it('cuts the fixed drones’ impacts, and neither the tagged spirits’ hits nor the turrets’ shots', () => {
    // Verifier's check: spawnDrone's tags dropped from a spirit's hits.
    expect(droneHits([])).toEqual([[IMPACT, 8]]);
    expect(droneHits([CUT])).toEqual([[IMPACT, expect.closeTo(8 * 0.55, 9)]]);
    const tagged = { tags: ['trigger'] } as const;
    expect(spiritHits([], tagged)).toEqual([[IMPACT | TAG.trigger, 10]]);
    expect(spiritHits([CUT], tagged)).toEqual([[IMPACT | TAG.trigger, 10]]);
    // Untagged, a spirit's hit has the drones' tags and takes the cut: item (1) as the report says.
    expect(spiritHits([CUT])).toEqual([[IMPACT, expect.closeTo(10 * 0.55, 9)]]);
    expect(shotHits([CUT])).toEqual(shotHits([]));
    expect(shotHits([])).toEqual([[SHOT_TAGS, 4]]);
  });
});
