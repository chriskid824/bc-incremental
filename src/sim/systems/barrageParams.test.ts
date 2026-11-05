/**
 * The barrage rider's ◆ params (E10b, src/sim/systems/barrage.ts; lead rulings X1-X9): their
 * checks and compile (BuildFlags.barrage, compileBarrage, barrageSplit), 扇形's one pick and
 * spread, 環射's own count of counted attacks and its ring, 子母彈's splits of generation-0 kills
 * and their children after the projectile stage, 聚焦's target and bonus, 彈雨's window, and what
 * a build with a grant but none of them pays. Most tests run fireBarrage, an emitter or the drone
 * stage on placed enemies, then the projectile stage a tick at a time with the run's split step
 * after it (fly); the determinism tests run whole simulations. Each test names in a comment the
 * planted bug it kills.
 */

import { describe, expect, it } from 'vitest';
import { toNumber, ZERO } from '../../core/num';
import { createStreams } from '../../core/rng';
import type { SourcedEmitter } from '../../data/emitters';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import type { EffectSpec, SpawnDroneSpec, TriggerSpec } from '../../data/triggers';
import { compileBuild, DEFAULT_BARRAGE_PARAMS, DEFAULT_SPLIT_COUNT } from '../build/compile';
import type { BarrageParams, CompiledBarrage } from '../build/compile';
import { SHOT_MEMORY, SMALL_PROJECTILE_TICKS, SMALL_SHOT_CAP } from '../caps';
import { hitWithPayload } from '../combat/hit';
import { runEffect, runEffectQueue } from '../effects/execute';
import { HIT_EVENT, SIGNATURE } from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import { runVolley } from '../emitters/volley';
import type { BarrageRider, BarrageSplits, EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  createRunHash,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
  v3TestData,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_KIND_DRONE,
  DRONE_KIND_SENTRY,
  DRONE_KIND_TURRET,
  NO_INPUT,
  TICK_RATE,
} from '../types';
import type { SimEvent } from '../types';
import { fireBarrage, spawnSplits, splitOnKill } from './barrage';
import type { Enemy, RunContext } from './context';
import { impactAt, stepDrones } from './drones';
import type { EnemyV3 } from './enemyRecord';
import { rebuildGrid } from './grid';
import { moveProjectiles } from './projectiles';
import { liveProjectiles, MOTION_STRAIGHT, spawnShot, SPLIT_ROUND } from './shots';

/** The player's position. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** An enemy (dx, dy) from the player. */
const at = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...extra,
});
/** A small shot's move per tick at the base projectileSpeed. */
const STEP = 1400 / TICK_RATE;

const VOLLEY: SignatureSpec = { id: 'm1Volley' };
const SWARM: SignatureSpec = { id: 'swarm' };

/** The 副彈 grant on outer.barrage, at its default share. */
const GRANT: SourcedEmitter = { source: 'outer.barrage', grant: { kind: 'barrage' } };

/** A test module writing `params` over BuildFlags.barrage, as B3's ◆ modules do. */
const barrage =
  (params: Partial<BarrageParams>): TestModule =>
  (b) =>
    void Object.assign(b.flags.barrage, params);

/** B3's modules: ◆扇形 (spreadDeg 30), ◆環射, ◆子母彈, ◆聚焦 both ways, 彈雨 and ★子彈地獄. */
const FAN = barrage({ aim: 'fan' });
const RING = barrage({ ring: { every: 6, directions: 12 } });
const SPLIT = barrage({ split: { count: 3, chance: 1 } });
const FOCUS_BOSS = barrage({ focus: { bonus: 0.2, when: 'boss' } });
const FOCUS_LAST = barrage({ focus: { bonus: 0.2, when: 'lastAlive' } });
const RAIN = barrage({ rain: { periodSec: 10, activeSec: 2, countMult: 3 } });
const STAR = barrage({ countMult: 2, bounce: 2 });

/** A test module writing the swarm's counts. */
const swarmCounts =
  (drones: number, turrets: number): TestModule =>
  (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, { drones, turrets });
  };

const GIGANTISM: RuleSpec = { id: 'gigantism', sizeMult: 2 };

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  /** The build's grants; [GRANT] by default. */
  readonly grants?: readonly SourcedEmitter[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
  readonly signature?: SignatureSpec;
  readonly seed?: number;
}

/** The stats of a test build: damage 10, no crit, ignite or chain, barrageCount 2 by default. */
const statsOf = (options: Options) =>
  makeStats(
    {
      damage: 10,
      critChance: 0,
      igniteChance: 0,
      chainCount: 0,
      barrageCount: 2,
      ...options.values,
    },
    [],
    {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: options.grants ?? [GRANT],
    },
  );

/** placedEnemies with a test build (statsOf), M1's volley unless `signature` says otherwise. */
const arena = (placed: readonly PlacedEnemy[], options: Options = {}): RunContext =>
  placedEnemies(placed, {
    stats: statsOf(options),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
    signature: options.signature ?? VOLLEY,
    seed: options.seed ?? 1,
  });

/** The compiled build of a test build. */
const compiled = (options: Options = {}) =>
  compileBuild(
    statsOf(options),
    options.rules ?? [],
    options.signature ?? VOLLEY,
    options.modules ?? [],
  );
const barrageOf = (options: Options = {}): CompiledBarrage =>
  compiled(options).barrage as CompiledBarrage;

const sig = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;
const riderOf = (ctx: RunContext): BarrageRider => sig(ctx).barrage as BarrageRider;
const splitsOf = (ctx: RunContext): BarrageSplits => riderOf(ctx).split as BarrageSplits;
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** The slots of the rider's shots in flight, in id order. */
function riderSlots(ctx: RunContext): number[] {
  const p = sig(ctx).barrage?.payload ?? null;
  const slots: number[] = [];
  for (let s = 0; s < ctx.shots.count; s++)
    if (p !== null && ctx.shots.payload[s] === p) slots.push(s);
  return slots;
}

/** The rider's shots with an id from `from` on, in id order. */
const freshSlots = (ctx: RunContext, from: number): number[] =>
  riderSlots(ctx).filter((s) => (ctx.shots.id[s] as number) >= from);

/** The shot in slot `s`: where it is, its life, motion, pierce, bounce, round and scale. */
const shotOf = (ctx: RunContext, s: number) => ({
  x: ctx.shots.x[s] as number,
  y: ctx.shots.y[s] as number,
  launched: ctx.shots.launched[s] as number,
  until: ctx.shots.until[s] as number,
  motion: ctx.shots.motion[s] as number,
  pierce: ctx.shots.pierce[s] as number,
  bounce: ctx.shots.bounce[s] as number,
  round: ctx.shots.round[s] as number,
  scale: ctx.shots.scale[s] as number,
  owner: ctx.shots.owner[s] as number,
});

/** `v` rounded to 9 decimals, −0 as 0. */
const r9 = (v: number): number => Math.round(v * 1e9) / 1e9 + 0;

/** The heading of the shot in slot `s` in degrees, turned from `base` radians, in (−180, 180]. */
function turned(ctx: RunContext, s: number, base: number): number {
  let d = Math.atan2(ctx.shots.vy[s] as number, ctx.shots.vx[s] as number) - base;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d > Math.PI) d -= 2 * Math.PI;
  return r9((d * 180) / Math.PI);
}

/** The shot in slot `s`'s speed a tick. */
const speedOf = (ctx: RunContext, s: number): number =>
  Math.hypot(ctx.shots.vx[s] as number, ctx.shots.vy[s] as number);

/** The angle from the player to placed offset (dx, dy). */
const angleTo = (dx: number, dy: number): number => Math.atan2(dy, dx);

/** The non-zero ids of the shot in slot `s`'s memory block, in block order. */
function remembered(ctx: RunContext, s: number): number[] {
  const base = ctx.shots.memBase[s] as number;
  return Array.from(ctx.shots.memory.subarray(base, base + SHOT_MEMORY)).filter((id) => id !== 0);
}

/** Makes one volley attack due and runs it. */
function attack(ctx: RunContext): void {
  const em = sig(ctx);
  em.acc = em.interval - em.cadence;
  runVolley(ctx, em);
}

/**
 * One tick of the projectile stage alone, then the run's split step (spawnSplits) as the tick
 * order runs it; returns the rider's shots right after the stage and the tick's events.
 */
function tick(ctx: RunContext): { staged: number[]; events: SimEvent[] } {
  ctx.now = ctx.state.tick = ctx.now + 1;
  rebuildGrid(ctx);
  ctx.events.length = 0;
  moveProjectiles(ctx);
  const staged = riderSlots(ctx);
  const rider = sig(ctx).barrage;
  if (rider !== null && rider.split !== null) spawnSplits(ctx, rider);
  return { staged, events: ctx.events.slice() };
}

/** `ticks` ticks of tick(); returns their events. */
function fly(ctx: RunContext, ticks: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) events.push(...tick(ctx).events);
  return events;
}

/** The drone stage on the current tick; returns its events. */
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

/** A counted impact of the swarm's drone in slot `s` on enemy `id`, from that enemy's point. */
function impactOn(ctx: RunContext, id: number, s = 0): Enemy {
  const ds = ctx.sys.drones;
  const target = enemy(ctx, id);
  ds.x[s] = target.x;
  ds.y[s] = target.y;
  const em = sig(ctx);
  impactAt(ctx, s, target, em.payload, em, true, 0, -1);
  return target;
}

/** A turret firing of the swarm's turret in drone slot `s`, the drone stage due once. */
function turretFiring(ctx: RunContext, s: number): SimEvent[] {
  ctx.sys.drones.acc[s] = sig(ctx).interval;
  return stage(ctx).filter((e) => e.type === 'turretFire');
}

interface SeenHit {
  readonly id: number;
  readonly source: string;
  readonly amount: number;
}

/** A hook that records every hit, in order. */
function watch(): { module: TestModule; hits: SeenHit[] } {
  const hits: SeenHit[] = [];
  const module: TestModule = (b) => {
    b.hook('onHit', (ctx, hit) => {
      hits.push({
        id: hit.target.id,
        source: ctx.build.sources.names[hit.source] as string,
        amount: toNumber(hit.amount),
      });
    });
  };
  return { module, hits };
}

const smallHits = (hits: readonly SeenHit[]): SeenHit[] =>
  hits.filter((hit) => hit.source === 'outer.barrage');

/** Fills the shot pool with idle shots until `n` projectiles are in flight. */
function fill(ctx: RunContext, n: number): void {
  const p = sig(ctx).payload;
  while (liveProjectiles(ctx) < n) {
    spawnShot(ctx, MOTION_STRAIGHT, -500, -500, 0, 0, 1e9, p, 1, 1, 0, 0, -1, false, -1, -1, null);
  }
}

/** Runs the build's first effect of `kind` as a signature hit's trigger 0's, at depth 1. */
function runFirst(ctx: RunContext, kind: EffectSpec['kind'], x = P.x, y = P.y): void {
  const entry = createEffectEntry();
  entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === kind);
  entry.depth = 1;
  entry.origin = 0;
  entry.flags = SIGNATURE | HIT_EVENT;
  entry.x = x;
  entry.y = y;
  runEffect(ctx, entry);
}

/** Effects on a kill, which none of these tests makes: they run only through runFirst. */
const onKill = (...effects: EffectSpec[]): TriggerSpec => ({ on: 'kill', do: effects });

/** A template payload (A25): a projectiles effect whose count links barrageCount (C6b.1). */
const TEMPLATE: EffectSpec = {
  kind: 'projectiles',
  count: 4,
  aim: 'radial',
  damagePct: 0.5,
  countStat: 'barrageCount',
};

/** Three enemies far apart, 1 nearest the player (300 away, up and right). */
const THREE: readonly PlacedEnemy[] = [at(240, 180), at(0, -400), at(-450, 0)];

describe('the ◆ params compile (lead rulings X1, X2)', () => {
  it('starts every compile from a fresh copy of the defaults, which a module’s writes never reach', () => {
    const first = compiled();
    expect(first.flags.barrage).toEqual(DEFAULT_BARRAGE_PARAMS);
    expect(first.flags.barrage).not.toBe(DEFAULT_BARRAGE_PARAMS);
    expect(compiled().flags.barrage).not.toBe(first.flags.barrage);
    // A module's ring and split land on its own compile's copy alone.
    const ringed = compiled({ modules: [RING, SPLIT] });
    expect(ringed.flags.barrage).toMatchObject({ ring: { every: 6, directions: 12 } });
    expect(compiled().flags.barrage).toEqual(DEFAULT_BARRAGE_PARAMS);
    expect(DEFAULT_BARRAGE_PARAMS).toEqual({
      countMult: 1,
      bounce: 0,
      aim: 'distinct',
      spreadDeg: 30,
      ring: null,
      split: null,
      focus: null,
      rain: null,
    });
  });

  // Each refused value with its message's start; each accepted one at the bound with null.
  const RING_OK = { every: 6, directions: 12 };
  const SPLIT_OK = { count: 3, chance: 1 };
  const RAIN_OK = { periodSec: 10, activeSec: 2, countMult: 3 };
  const rainMsg = 'barrage.rain: periodSec';
  const cases: [string, Partial<BarrageParams>, string | null][] = [
    ['spreadDeg 0', { spreadDeg: 0 }, 'barrage.spreadDeg: 0 must be finite and in (0, 360)'],
    ['spreadDeg 1e-9', { spreadDeg: 1e-9 }, null],
    ['spreadDeg 359.9', { spreadDeg: 359.9 }, null],
    ['spreadDeg 360', { spreadDeg: 360 }, 'barrage.spreadDeg: 360 must'],
    ['spreadDeg −5', { spreadDeg: -5 }, 'barrage.spreadDeg: -5 must'],
    ['spreadDeg NaN', { spreadDeg: NaN }, 'barrage.spreadDeg: NaN must'],
    ['spreadDeg Infinity', { spreadDeg: Infinity }, 'barrage.spreadDeg: Infinity must'],
    ['ring.every 0', { ring: { ...RING_OK, every: 0 } }, 'barrage.ring.every: 0 must be a whole'],
    ['ring.every 1', { ring: { ...RING_OK, every: 1 } }, null],
    ['ring.every 60', { ring: { ...RING_OK, every: 60 } }, null],
    ['ring.every 61', { ring: { ...RING_OK, every: 61 } }, 'barrage.ring.every: 61 must'],
    ['ring.every 2.5', { ring: { ...RING_OK, every: 2.5 } }, 'barrage.ring.every: 2.5 must'],
    ['ring.every NaN', { ring: { ...RING_OK, every: NaN } }, 'barrage.ring.every: NaN must'],
    [
      'ring.directions 0',
      { ring: { ...RING_OK, directions: 0 } },
      'barrage.ring.directions: 0 must be a whole number in [1, 64]',
    ],
    ['ring.directions 1', { ring: { ...RING_OK, directions: 1 } }, null],
    ['ring.directions 64', { ring: { ...RING_OK, directions: 64 } }, null],
    ['ring.directions 65', { ring: { ...RING_OK, directions: 65 } }, 'directions: 65 must'],
    ['ring.directions 1.5', { ring: { ...RING_OK, directions: 1.5 } }, 'directions: 1.5 must'],
    [
      'split.count 0',
      { split: { ...SPLIT_OK, count: 0 } },
      'barrage.split.count: 0 must be a whole number in [1, 8]',
    ],
    ['split.count 1', { split: { ...SPLIT_OK, count: 1 } }, null],
    ['split.count 8', { split: { ...SPLIT_OK, count: 8 } }, null],
    ['split.count 9', { split: { ...SPLIT_OK, count: 9 } }, 'barrage.split.count: 9 must'],
    ['split.count 2.5', { split: { ...SPLIT_OK, count: 2.5 } }, 'barrage.split.count: 2.5'],
    [
      'split.chance −0.01',
      { split: { ...SPLIT_OK, chance: -0.01 } },
      'barrage.split.chance: -0.01 must be finite and in [0, 1]',
    ],
    ['split.chance 0', { split: { ...SPLIT_OK, chance: 0 } }, null],
    ['split.chance 1', { split: { ...SPLIT_OK, chance: 1 } }, null],
    ['split.chance 1.01', { split: { ...SPLIT_OK, chance: 1.01 } }, 'split.chance: 1.01 must'],
    ['split.chance NaN', { split: { ...SPLIT_OK, chance: NaN } }, 'split.chance: NaN must'],
    [
      'split.chance Infinity',
      { split: { ...SPLIT_OK, chance: Infinity } },
      'split.chance: Infinity must',
    ],
    [
      'focus.bonus −0.01',
      { focus: { bonus: -0.01, when: 'boss' } },
      'barrage.focus.bonus: -0.01 must be finite and in [0, 4]',
    ],
    ['focus.bonus 0', { focus: { bonus: 0, when: 'boss' } }, null],
    ['focus.bonus 4', { focus: { bonus: 4, when: 'lastAlive' } }, null],
    ['focus.bonus 4.01', { focus: { bonus: 4.01, when: 'boss' } }, 'focus.bonus: 4.01 must'],
    ['focus.bonus NaN', { focus: { bonus: NaN, when: 'boss' } }, 'focus.bonus: NaN must'],
    [
      'rain.countMult 1',
      { rain: { ...RAIN_OK, countMult: 1 } },
      'barrage.rain.countMult: 1 must be a whole number in [2, 4]',
    ],
    ['rain.countMult 2', { rain: { ...RAIN_OK, countMult: 2 } }, null],
    ['rain.countMult 4', { rain: { ...RAIN_OK, countMult: 4 } }, null],
    ['rain.countMult 5', { rain: { ...RAIN_OK, countMult: 5 } }, 'rain.countMult: 5 must'],
    ['rain.countMult 2.5', { rain: { ...RAIN_OK, countMult: 2.5 } }, 'rain.countMult: 2.5 must'],
    // round(0.008 × 60) = 0, round(0.009 × 60) = 1.
    ['rain.activeSec 0.008', { rain: { ...RAIN_OK, activeSec: 0.008 } }, rainMsg],
    ['rain.activeSec 0.009', { rain: { ...RAIN_OK, activeSec: 0.009 } }, null],
    ['rain.activeSec 0', { rain: { ...RAIN_OK, activeSec: 0 } }, rainMsg],
    // round(0.99 × 60) = 59 < 60; round(0.992 × 60) = 60 and round(1 × 60) = 60 are not.
    ['rain 1 s, 0.99 s', { rain: { ...RAIN_OK, periodSec: 1, activeSec: 0.99 } }, null],
    ['rain 1 s, 0.992 s', { rain: { ...RAIN_OK, periodSec: 1, activeSec: 0.992 } }, rainMsg],
    ['rain 1 s, 1 s', { rain: { ...RAIN_OK, periodSec: 1, activeSec: 1 } }, rainMsg],
    ['rain 10 s, 12 s', { rain: { ...RAIN_OK, periodSec: 10, activeSec: 12 } }, rainMsg],
    ['rain.periodSec NaN', { rain: { ...RAIN_OK, periodSec: NaN } }, rainMsg],
    ['rain.periodSec Infinity', { rain: { ...RAIN_OK, periodSec: Infinity } }, rainMsg],
    ['rain.activeSec NaN', { rain: { ...RAIN_OK, activeSec: NaN } }, rainMsg],
    ['rain.activeSec −Infinity', { rain: { ...RAIN_OK, activeSec: -Infinity } }, rainMsg],
  ];
  it.each(cases)('checks %s after the modules: %j → %s', (_name, params, message) => {
    // Killed: each bound off by one, or a check dropped.
    const build = () => compiled({ modules: [barrage(params)] });
    if (message === null) expect(build).not.toThrow();
    else expect(build).toThrow(message);
  });

  it('checks them without a grant too, where they do nothing', () => {
    expect(() => compiled({ grants: [], modules: [barrage({ spreadDeg: 0 })] })).toThrow(
      /spreadDeg: 0/,
    );
    expect(() =>
      compiled({ grants: [], modules: [barrage({ split: { count: 9, chance: 1 } })] }),
    ).toThrow(/split.count: 9/);
    const inert = compiled({ grants: [], modules: [RING, SPLIT, FOCUS_BOSS, RAIN, FAN] });
    expect(inert.barrage).toBeNull();
  });

  it('compiles the ring’s count as countOf(directions) × countMult: 12, 24, and 6 and 12 under 巨大化', () => {
    // Killed: the directions not × countMult, or not halved.
    const ring = (modules: readonly TestModule[], rules: readonly RuleSpec[] = []) =>
      barrageOf({ modules: [RING, ...modules], rules }).ring;
    expect(ring([])).toEqual({ every: 6, count: 12 });
    expect(ring([STAR])).toEqual({ every: 6, count: 24 });
    expect(ring([], [GIGANTISM])).toEqual({ every: 6, count: 6 });
    expect(ring([STAR], [GIGANTISM])).toEqual({ every: 6, count: 12 });
    const one = barrage({ ring: { every: 1, directions: 1 } });
    expect(barrageOf({ modules: [one], rules: [GIGANTISM] }).ring).toEqual({ every: 1, count: 1 });
  });

  it('compiles the split’s chance as min(1, chance + max(0, barrageSplit)) and its count × countMult', () => {
    // Killed: barrageSplit left out, the sum not clamped at 1, or a negative stat taken.
    const split = (chance: number, barrageSplit: number, modules: readonly TestModule[] = []) =>
      barrageOf({
        values: { barrageSplit },
        modules: [barrage({ split: { count: 3, chance } }), ...modules],
      }).split;
    expect(split(1, 0)).toEqual({ count: 3, chance: 1 });
    expect(split(0, 0.15)).toEqual({ count: 3, chance: 0.15 });
    expect(split(0.5, 0.25)).toEqual({ count: 3, chance: 0.75 });
    expect(split(0.5, 0.7)).toEqual({ count: 3, chance: 1 });
    expect(split(0, 3)).toEqual({ count: 3, chance: 1 });
    expect(split(0.5, -0.3)).toEqual({ count: 3, chance: 0.5 });
    expect(split(1, 0, [STAR])).toEqual({ count: 6, chance: 1 });
    // 巨大化 leaves the split's count whole.
    expect(
      barrageOf({ modules: [SPLIT], rules: [GIGANTISM], values: { barrageCount: 4 } }).split,
    ).toEqual({ count: 3, chance: 1 });
    // At chance 0 nothing splits.
    expect(split(0, 0)).toBeNull();
    expect(split(0, -1)).toBeNull();
  });

  it('compiles the 分裂 rank alone, without the param, as DEFAULT_SPLIT_COUNT × countMult children at min(1, max(0, barrageSplit))', () => {
    // Killed: the rank inert without the param, its chance unclamped or a negative stat taken,
    // the count not DEFAULT_SPLIT_COUNT, not × countMult, or halved by 巨大化.
    const alone = (
      barrageSplit: number,
      modules: readonly TestModule[] = [],
      rules: readonly RuleSpec[] = [],
    ) => barrageOf({ values: { barrageSplit }, modules, rules }).split;
    expect(DEFAULT_SPLIT_COUNT).toBe(3);
    expect(alone(0.15)).toEqual({ count: 3, chance: 0.15 });
    expect(alone(0.45)).toEqual({ count: 3, chance: 0.45 });
    expect(alone(1)).toEqual({ count: 3, chance: 1 });
    expect(alone(3)).toEqual({ count: 3, chance: 1 });
    expect(alone(0.15, [STAR])).toEqual({ count: 6, chance: 0.15 });
    expect(alone(0.15, [], [GIGANTISM])).toEqual({ count: 3, chance: 0.15 });
    // No rank, or a negative one, splits nothing.
    expect(alone(0)).toBeNull();
    expect(alone(-0.5)).toBeNull();
    expect(barrageOf({}).split).toBeNull();
    // A stat a module made NaN is not above 0 either.
    const nan: TestModule = (b) => b.offsetStat('barrageSplit', NaN);
    expect(barrageOf({ modules: [nan] }).split).toBeNull();
    // A param's own count wins over the default.
    const one = barrage({ split: { count: 1, chance: 0 } });
    expect(alone(0.15, [one])).toEqual({ count: 1, chance: 0.15 });
  });

  it('compiles the aim’s spread in radians, the focus as written and the rain’s seconds as ticks', () => {
    expect(barrageOf({ modules: [FAN] })).toMatchObject({ aim: 'fan', spread: Math.PI / 6 });
    expect(barrageOf({ modules: [barrage({ aim: 'fan', spreadDeg: 90 })] }).spread).toBe(
      Math.PI / 2,
    );
    expect(barrageOf({ modules: [FOCUS_BOSS] }).focus).toEqual({ bonus: 0.2, when: 'boss' });
    expect(barrageOf({ modules: [RAIN] }).rain).toEqual({ period: 600, active: 120, mult: 3 });
    const odd = barrage({ rain: { periodSec: 1.5, activeSec: 0.255, countMult: 2 } });
    expect(barrageOf({ modules: [odd] }).rain).toEqual({ period: 90, active: 15, mult: 2 });
  });

  it('gives the run’s rider its params, its ring count at 0 and room for SMALL_SHOT_CAP splits', () => {
    const ctx = arena([], { modules: [FAN, RING, SPLIT, FOCUS_LAST, RAIN] });
    const rider = riderOf(ctx);
    expect([rider.fan, rider.spread, rider.attacks]).toEqual([true, Math.PI / 6, 0]);
    expect(rider.ring).toEqual({ every: 6, count: 12 });
    expect(rider.focus).toEqual({ bonus: 0.2, boss: false });
    expect(rider.rain).toEqual({ period: 600, active: 120, mult: 3 });
    const split = splitsOf(ctx);
    expect([split.count, split.chance, split.pending]).toEqual([3, 1, 0]);
    for (const list of [split.victim, split.x, split.y, split.vx, split.vy]) {
      expect(list).toHaveLength(SMALL_SHOT_CAP);
    }
    const plain = riderOf(arena([]));
    expect([plain.fan, plain.ring, plain.split, plain.focus, plain.rain]).toEqual([
      false,
      null,
      null,
      null,
      null,
    ]);
    expect(riderOf(arena([], { modules: [FOCUS_BOSS] })).focus).toEqual({
      bonus: 0.2,
      boss: true,
    });
  });
});

describe('扇形: every shot at the first pick, over the spread (X3)', () => {
  it.each([
    [1, [0]],
    [2, [-15, 15]],
    [3, [-15, 0, 15]],
    [5, [-15, -7.5, 0, 7.5, 15]],
  ])('fires N = %i shots turned from the pick by 30° × (i / (N − 1) − 0.5): %j', (n, degrees) => {
    // Killed: i / N in place of i / (N − 1), or a spread not centred on the pick.
    const ctx = arena(THREE, { values: { barrageCount: n }, modules: [FAN] });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    const slots = riderSlots(ctx);
    expect(slots.map((s) => turned(ctx, s, angleTo(240, 180)))).toEqual(degrees);
    for (const s of slots) {
      expect(r9(speedOf(ctx, s))).toBe(r9(STEP));
      expect(shotOf(ctx, s)).toMatchObject({
        x: P.x,
        y: P.y,
        until: ctx.now + SMALL_PROJECTILE_TICKS,
        motion: MOTION_STRAIGHT,
        pierce: 1,
        bounce: 0,
        round: -1,
        scale: 1,
      });
    }
  });

  it('spreads over spreadDeg as written: 90° gives −45°, 0° and 45°; ★’s count, pierce and bounce', () => {
    const wide = barrage({ aim: 'fan', spreadDeg: 90 });
    const ctx = arena(THREE, { values: { barrageCount: 3 }, modules: [wide] });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(riderSlots(ctx).map((s) => turned(ctx, s, angleTo(240, 180)))).toEqual([-45, 0, 45]);
    const star = arena(THREE, {
      values: { barrageCount: 2, barragePierce: 1 },
      modules: [FAN, STAR],
    });
    fireBarrage(star, riderOf(star), P.x, P.y);
    const slots = riderSlots(star);
    expect(slots.map((s) => turned(star, s, angleTo(240, 180)))).toEqual([-15, -5, 5, 15]);
    for (const s of slots) expect(shotOf(star, s)).toMatchObject({ pierce: 2, bounce: 2 });
  });

  it('picks one enemy alone, the nearest, though N picks more were there: every shot near it', () => {
    // Killed: the fan over N distinct picks.
    const placed = [at(0, -400), at(240, 180), at(-450, 0), at(400, 300)];
    const ctx = arena(placed, { values: { barrageCount: 4 }, modules: [FAN] });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(riderSlots(ctx).map((s) => turned(ctx, s, angleTo(240, 180)))).toEqual([-15, -5, 5, 15]);
    // The nearest one at a tie of distance is the lower id.
    const tie = arena([at(0, 300), at(300, 0)], { values: { barrageCount: 1 }, modules: [FAN] });
    fireBarrage(tie, riderOf(tie), P.x, P.y);
    expect(turned(tie, 0, angleTo(0, 300))).toBe(0);
  });

  it('skips an impact’s target as its pick, the shots seeded with it and never hitting it', () => {
    // From 1's point: 2 is 60 away, 3 100, 4 600.
    const placed = [at(300, 0), at(300, 60), at(300, -100), at(-300, 0)];
    const seen = watch();
    const ctx = arena(placed, {
      signature: SWARM,
      values: { barrageCount: 3 },
      modules: [swarmCounts(1, 0), FAN, seen.module],
    });
    const target = impactOn(ctx, 1);
    expect(target.alive).toBe(true);
    const slots = riderSlots(ctx);
    expect(slots.map((s) => turned(ctx, s, Math.PI / 2))).toEqual([-15, 0, 15]);
    for (const s of slots) {
      expect(shotOf(ctx, s)).toMatchObject({ x: target.x, y: target.y });
      expect(remembered(ctx, s)).toEqual([1]);
    }
    fly(ctx, 30);
    const ids = smallHits(seen.hits).map((hit) => hit.id);
    expect(ids).not.toContain(1);
    expect(ids.filter((id) => id === 2)).toHaveLength(3);
  });

  it('fires no shot without an enemy to pick, none counted as capped', () => {
    const empty = arena([], { modules: [FAN] });
    fireBarrage(empty, riderOf(empty), P.x, P.y);
    expect(riderSlots(empty)).toEqual([]);
    // An impact on the only enemy: it is no pick.
    const alone = arena([at(300, 0)], { signature: SWARM, modules: [swarmCounts(1, 0), FAN] });
    impactOn(alone, 1);
    expect(riderSlots(alone)).toEqual([]);
    expect(alone.counters.barrageCapped + empty.counters.barrageCapped).toBe(0);
  });
});

describe('環射: a ring on every ring.every-th counted attack (X4)', () => {
  it('fires its 12 on the 6th and 12th volley attacks alone, after that attack’s own shots', () => {
    // Killed: the ring on another count, before the attack's shots, or off by one.
    const ctx = arena(THREE, { values: { barrageCount: 1 }, modules: [RING] });
    const fresh: number[] = [];
    for (let a = 1; a <= 12; a++) {
      const from = ctx.nextProjectileId;
      attack(ctx);
      const slots = freshSlots(ctx, from);
      fresh.push(slots.length);
      if (a % 6 === 0) {
        // The attack's shot first, at its pick; the ring's after it, round the player from +x.
        expect(turned(ctx, slots[0] as number, angleTo(240, 180))).toBe(0);
        expect(slots.slice(1).map((s) => turned(ctx, s, 0))).toEqual([
          0, 30, 60, 90, 120, 150, 180, -150, -120, -90, -60, -30,
        ]);
        for (const s of slots) {
          expect(shotOf(ctx, s)).toMatchObject({ x: P.x, y: P.y, pierce: 1, round: -1 });
          expect(r9(speedOf(ctx, s))).toBe(r9(STEP));
        }
      }
    }
    expect(fresh).toEqual([1, 1, 1, 1, 1, 13, 1, 1, 1, 1, 1, 13]);
    expect([riderOf(ctx).attacks, sig(ctx).attacks]).toEqual([12, 12]);
    // A fresh run counts from 0.
    expect(riderOf(arena(THREE, { modules: [RING] })).attacks).toBe(0);
  });

  it('counts its attacks only when the ring is set: the rider without one keeps 0', () => {
    const ctx = arena(THREE, { values: { barrageCount: 1 } });
    attack(ctx);
    attack(ctx);
    expect(riderOf(ctx).attacks).toBe(0);
  });

  it('fires directions × countMult, halved by 巨大化 as the rider’s count is', () => {
    // Killed: the ring's directions not × countMult, or not halved.
    const every1 = barrage({ ring: { every: 1, directions: 12 } });
    const counts = (modules: readonly TestModule[], rules: readonly RuleSpec[] = []) => {
      const ctx = arena(THREE, {
        values: { barrageCount: 2 },
        modules: [every1, ...modules],
        rules,
      });
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      return riderSlots(ctx).length;
    };
    // The rider's 2 (both picks) and the ring's 12; ★: 4 and 24; 巨大化: 1 and 6; both: 2 and 12.
    expect(counts([])).toBe(2 + 12);
    expect(counts([STAR])).toBe(3 + 24);
    expect(counts([], [GIGANTISM])).toBe(1 + 6);
    expect(counts([STAR], [GIGANTISM])).toBe(2 + 12);
  });

  it('starts the ring as a radial projectiles effect’s first shot: away from the player, +x on it', () => {
    const every1 = barrage({ ring: { every: 1, directions: 4 } });
    const ctx = arena([at(240, 180), at(-450, 0)], {
      signature: SWARM,
      values: { barrageCount: 1 },
      modules: [swarmCounts(1, 0), every1],
    });
    impactOn(ctx, 1);
    const slots = riderSlots(ctx);
    expect(slots).toHaveLength(5);
    // From 1's point the attack's shot goes at 2; the ring's first along player → 1.
    expect(turned(ctx, slots[1] as number, angleTo(240, 180))).toBe(0);
    expect(slots.slice(1).map((s) => turned(ctx, s, angleTo(240, 180)))).toEqual([0, 90, 180, -90]);
    expect(slots.slice(1).map((s) => remembered(ctx, s))).toEqual([[1], [1], [1], [1]]);
  });

  it('counts each 蜂巢 impact and each turret firing of the signature, in any mix', () => {
    // Killed: impacts or turret firings not counted.
    const placed = [at(200, 0), at(200, 40), at(-200, 0)];
    const impacts = arena(placed, {
      signature: SWARM,
      values: { barrageCount: 1 },
      modules: [swarmCounts(1, 0), RING],
    });
    const ringByImpact: number[] = [];
    for (let a = 1; a <= 6; a++) {
      const from = impacts.nextProjectileId;
      impactOn(impacts, 1);
      ringByImpact.push(freshSlots(impacts, from).length);
    }
    expect(ringByImpact).toEqual([1, 1, 1, 1, 1, 13]);
    const turrets = arena(placed, {
      signature: SWARM,
      values: { barrageCount: 1 },
      modules: [swarmCounts(0, 1), RING],
    });
    const ringByFiring: number[] = [];
    for (let a = 1; a <= 6; a++) {
      const from = turrets.nextProjectileId;
      expect(turretFiring(turrets, 0)).toHaveLength(1);
      ringByFiring.push(freshSlots(turrets, from).length);
    }
    expect(ringByFiring).toEqual([1, 1, 1, 1, 1, 13]);
    // Both in one run share the count: the drone's own impacts in the stage count too.
    const both = arena(placed, {
      signature: SWARM,
      values: { barrageCount: 1 },
      modules: [swarmCounts(1, 1), RING],
    });
    const ds = both.sys.drones;
    const droneSlot = [0, 1].findIndex((s) => ds.kind[s] === DRONE_KIND_DRONE);
    const turretSlot = [0, 1].findIndex((s) => ds.kind[s] === DRONE_KIND_TURRET);
    expect([droneSlot, turretSlot].sort()).toEqual([0, 1]);
    let rings = 0;
    for (let a = 1; a <= 8; a++) {
      const from = both.nextProjectileId;
      const before = riderOf(both).attacks;
      // An impact; or a firing, with any impact of the drone's in the same stage.
      if (a % 2 === 1) impactOn(both, 1, droneSlot);
      else expect(turretFiring(both, turretSlot)).toHaveLength(1);
      const counted = riderOf(both).attacks - before;
      expect(counted).toBeGreaterThanOrEqual(1);
      const due = Math.floor(riderOf(both).attacks / 6) - Math.floor(before / 6);
      rings += due;
      expect(freshSlots(both, from).length, `step ${a}`).toBe(counted + 12 * due);
    }
    expect(rings).toBeGreaterThan(0);
    expect(riderOf(both).attacks).toBe(sig(both).attacks);
  });

  it('never counts a repeat, a granted emitter’s attack, a spirit, a sentry or a triggered effect', () => {
    // Killed: a ring count kept in any of those paths.
    const every2 = barrage({ ring: { every: 2, directions: 12 } });
    const repeat = (timing: 'now' | 'nextAttack'): TriggerSpec =>
      onKill({ kind: 'repeatAttack', count: 2, damagePct: 0.5, timing });
    const shots: EffectSpec = { kind: 'projectiles', count: 3, aim: 'distinct', damagePct: 0.5 };
    // Repeats at once, and the next attack's: one counted attack, no ring.
    const now = arena(THREE, {
      values: { barrageCount: 1 },
      triggers: [repeat('now')],
      modules: [every2],
    });
    for (let i = 0; i < 3; i++) runFirst(now, 'repeatAttack');
    expect(riderOf(now).attacks).toBe(0);
    const later = arena(THREE, {
      values: { barrageCount: 1 },
      triggers: [repeat('nextAttack')],
      modules: [every2],
    });
    runFirst(later, 'repeatAttack');
    attack(later);
    expect(later.projectiles.length).toBeGreaterThan(2);
    expect([riderOf(later).attacks, riderSlots(later).length]).toEqual([1, 1]);
    // A granted drone's impact and a granted turret's firing.
    const granted = arena(THREE, {
      values: { barrageCount: 1 },
      grants: [GRANT, { source: 'outer.summon', grant: { kind: 'drone', drones: 1, turrets: 1 } }],
      modules: [every2],
    });
    const em = granted.emitters[1] as EmitterRuntime;
    const target = enemy(granted, 1);
    granted.sys.drones.x[0] = target.x;
    granted.sys.drones.y[0] = target.y;
    impactAt(granted, 0, target, em.payload, em, true, 0, -1);
    granted.sys.drones.acc[1] = em.interval;
    expect(stage(granted).filter((e) => e.type === 'turretFire')).toHaveLength(1);
    expect(riderOf(granted).attacks).toBe(0);
    // A triggered projectiles effect, and an nthAttack trigger's.
    const triggered = arena(THREE, {
      values: { barrageCount: 1 },
      triggers: [{ on: 'nthAttack', every: 1, do: [shots] }],
      modules: [every2],
    });
    runFirst(triggered, 'projectiles');
    attack(triggered);
    runEffectQueue(triggered);
    expect(triggered.shots.count).toBeGreaterThan(4);
    expect(riderOf(triggered).attacks).toBe(1);
    // A spirit's impacts, a sentry-like row's, and a seated sentry's fires.
    const spirit: SpawnDroneSpec = {
      kind: 'spawnDrone',
      lifeSec: 3,
      damagePct: 0.5,
      impacts: 3,
      aim: 'nearest',
    };
    const runner: SpawnDroneSpec = { ...spirit, impacts: 6, speed: 30 };
    const sentry: SpawnDroneSpec = {
      kind: 'spawnDrone',
      lifeSec: 5,
      damagePct: 0,
      seat: true,
      fires: { everySec: 1, do: { kind: 'projectiles', count: 1, aim: 'target', damagePct: 1 } },
    };
    for (const [name, spec] of [
      ['spirit', spirit],
      ['runner', runner],
      ['sentry', sentry],
    ] as const) {
      const ctx = arena([at(200, 0), at(240, 0), at(-300, 0)], {
        values: { barrageCount: 1 },
        triggers: [onKill(spec)],
        modules: [every2],
      });
      const e = enemy(ctx, 1);
      runFirst(ctx, 'spawnDrone', e.x + (name === 'spirit' ? -100 : 5), e.y);
      const ds = ctx.sys.drones;
      expect(ds.count, name).toBe(1);
      if (name === 'sentry') expect(ds.kind[0]).toBe(DRONE_KIND_SENTRY);
      let events = 0;
      for (let t = 0; t < 200; t++) {
        events += next(ctx).filter((ev) => ev.type === 'impact').length;
        runEffectQueue(ctx);
      }
      if (name === 'sentry') expect(ctx.shots.count, name).toBeGreaterThan(0);
      else expect(events, name).toBeGreaterThan(1);
      expect([riderOf(ctx).attacks, riderSlots(ctx).length], name).toEqual([0, 0]);
    }
  });

  it('fires no ring when the attack fires no rider: no rider at count 0', () => {
    const none = arena(THREE, {
      values: { barrageCount: 0 },
      modules: [barrage({ ring: { every: 1, directions: 12 } })],
    });
    expect(sig(none).barrage).toBeNull();
    attack(none);
    expect(none.shots.count).toBe(0);
  });
});

/** One enemy 30 out on +x with 1 hp, which the first small shot kills on the first step. */
const NEAR_KILL = at(30, 0, { hp: 1 });

describe('子母彈: a generation-0 kill splits after the stage (X5)', () => {
  it('splits a killing rider shot into count children at the victim, spawned after the stage', () => {
    // Killed: children spawned during the stage, at the shot's point, or not along its heading.
    // 1 lies 300 out along (0.8, 0.6), 2 and 3 off its children's lines.
    const ctx = arena([at(240, 180, { hp: 1 }), at(-300, 0), at(0, -400)], {
      values: { barrageCount: 1 },
      modules: [SPLIT],
    });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    const [gen0] = riderSlots(ctx);
    expect(shotOf(ctx, gen0 as number).round).toBe(SPLIT_ROUND);
    const victim = enemy(ctx, 1);
    let t = 0;
    let staged: number[] = [];
    while (victim.alive && t++ < 30) staged = tick(ctx).staged;
    expect(victim.alive).toBe(false);
    // The kill's tick: the killing shot ended in the stage, and nothing spawned in it.
    expect(staged).toEqual([]);
    const children = riderSlots(ctx);
    expect(children).toHaveLength(3);
    expect(children.map((s) => turned(ctx, s, angleTo(240, 180)))).toEqual([0, 120, -120]);
    for (const s of children) {
      expect(shotOf(ctx, s)).toEqual({
        x: victim.x,
        y: victim.y,
        launched: ctx.now,
        until: ctx.now + SMALL_PROJECTILE_TICKS,
        motion: MOTION_STRAIGHT,
        pierce: 1,
        bounce: 0,
        round: -1,
        scale: 1,
        owner: -1,
      });
      expect(r9(speedOf(ctx, s))).toBe(r9(STEP));
      expect(remembered(ctx, s)).toEqual([1]);
      expect(ctx.shots.payload[s]).toBe(riderOf(ctx).payload);
    }
    expect(splitsOf(ctx).pending).toBe(0);
  });

  it('never splits a child: its kill makes none', () => {
    // Killed: children splitting again.
    // 2 lies on the first child's line out of 1, 3 on the second's.
    const ctx = arena(
      [at(100, 0, { hp: 1 }), at(200, 0, { hp: 1 }), at(100 - 75, 75 * Math.sqrt(3), { hp: 1 })],
      { values: { barrageCount: 1 }, modules: [SPLIT] },
    );
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    const ids: number[] = [];
    for (let t = 0; t < 40; t++) {
      const from = ctx.nextProjectileId;
      tick(ctx);
      ids.push(freshSlots(ctx, from).length);
    }
    expect(ctx.enemies.map((e) => e.alive)).toEqual([false, false, false]);
    // One split, its three children; the children's two kills spawn nothing.
    expect(ids.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('splits ring shots, fan shots and ★’s doubled children; children carry its pierce and bounce', () => {
    // The attack's shot goes at 1, its pick; the ring's +x shot kills 2, farther off.
    const every1 = barrage({ ring: { every: 1, directions: 2 } });
    const ring = arena([at(-300, 0), at(400, 0, { hp: 1 })], {
      values: { barrageCount: 1 },
      modules: [every1, SPLIT],
    });
    fireBarrage(ring, riderOf(ring), P.x, P.y);
    expect(riderSlots(ring).map((s) => turned(ring, s, 0))).toEqual([180, 0, 180]);
    const victim = enemy(ring, 2);
    for (let t = 0; t < 30 && victim.alive; t++) tick(ring);
    expect(victim.alive).toBe(false);
    const fromRing = freshSlots(ring, ring.nextProjectileId - 3);
    expect(fromRing.map((s) => turned(ring, s, 0))).toEqual([0, 120, -120]);
    for (const s of fromRing) expect(shotOf(ring, s)).toMatchObject({ x: victim.x, y: victim.y });
    // ★: 3 × 2 children, with its bounce and the rider's pierce; the killing shot pierces on.
    const star = arena([NEAR_KILL, at(-450, 0)], {
      values: { barrageCount: 1, barragePierce: 1 },
      modules: [SPLIT, STAR],
    });
    fireBarrage(star, riderOf(star), P.x, P.y);
    expect(riderSlots(star)).toHaveLength(2);
    tick(star);
    const kids = freshSlots(star, star.nextProjectileId - 6);
    expect(riderSlots(star)).toHaveLength(2 + 6);
    for (const s of kids) expect(shotOf(star, s)).toMatchObject({ pierce: 2, bounce: 2 });
    expect(kids.map((s) => turned(star, s, 0))).toEqual([0, 60, 120, 180, -120, -60]);
    // A fan's shot kills too.
    const fan = arena([NEAR_KILL], { values: { barrageCount: 1 }, modules: [FAN, SPLIT] });
    fireBarrage(fan, riderOf(fan), P.x, P.y);
    tick(fan);
    expect(riderSlots(fan)).toHaveLength(3);
  });

  it('finds an enemy a shot before it killed in the step gone, pierce unspent: one kill, one split', () => {
    // The grid's query reads `alive`: the second shot's list leaves 1 out.
    const seen = watch();
    const ctx = arena([NEAR_KILL, at(120, 0)], {
      values: { barrageCount: 1, barragePierce: 1 },
      modules: [SPLIT, seen.module],
    });
    // Two shots on one line: the first kills 1 and the second reaches it dead in the same step.
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    const [first, second] = riderSlots(ctx) as [number, number];
    const kill = tick(ctx).events;
    expect(kill.filter((e) => e.type === 'enemyKilled')).toHaveLength(1);
    expect(smallHits(seen.hits).map((hit) => hit.id)).toEqual([1]);
    expect([ctx.shots.pierce[first], ctx.shots.pierce[second]]).toEqual([1, 2]);
    expect(riderSlots(ctx)).toHaveLength(2 + 3);
    // Both shots then hit 2, and so does the first child, along their line.
    fly(ctx, 10);
    expect(smallHits(seen.hits).map((hit) => hit.id)).toEqual([1, 2, 2, 2]);
  });

  it('passes over an enemy its own earlier hit’s kill killed, pierce unspent and no split of it', () => {
    // Killed: a splitting shot hitting the dead in its own list. 1 and 2 lie on its first
    // step; an onKill hook kills 2 with 1, as a rule module's may.
    const behind: TestModule = (b) =>
      void b.hook('onKill', (ctx, victim) => {
        const other = ctx.enemies[1] as Enemy;
        if (victim.id === 1 && other.alive) {
          hitWithPayload(ctx, other, sig(ctx).payload, 0, 1e12, null, null, false, 0, -1);
        }
      });
    const seen = watch();
    const ctx = arena([NEAR_KILL, at(40, 0), at(-450, 0)], {
      values: { barrageCount: 1, barragePierce: 1 },
      modules: [SPLIT, behind, seen.module],
    });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    const [shot] = riderSlots(ctx) as [number];
    const events = tick(ctx).events;
    expect(
      events
        .filter((e) => e.type === 'enemyKilled')
        .map((e) => e.type === 'enemyKilled' && e.enemyId),
    ).toEqual([2, 1]);
    expect(smallHits(seen.hits).map((hit) => hit.id)).toEqual([1]);
    expect(ctx.shots.pierce[shot]).toBe(1);
    expect(riderSlots(ctx)).toHaveLength(1 + 3);
  });

  it('splits nothing on a hit that does not kill, a kill by another source, or a template payload’s shot', () => {
    // Killed: a split on every hit, or on any shot's kill.
    const alive = arena([at(30, 0)], { values: { barrageCount: 1 }, modules: [SPLIT] });
    fireBarrage(alive, riderOf(alive), P.x, P.y);
    fly(alive, 3);
    expect(enemy(alive, 1).alive).toBe(true);
    expect([riderSlots(alive).length, splitsOf(alive).pending]).toEqual([0, 0]);
    // A projectiles effect's and a template payload's shots kill, and split nothing.
    for (const spec of [
      { kind: 'projectiles', count: 1, aim: 'distinct', damagePct: 1 } as EffectSpec,
      TEMPLATE,
    ]) {
      const ctx = arena([at(30, 0, { hp: 1 }), at(-30, 0, { hp: 1 }), at(0, 30, { hp: 1 })], {
        values: { barrageCount: 1 },
        triggers: [onKill(spec)],
        modules: [SPLIT],
      });
      runFirst(ctx, 'projectiles');
      expect(ctx.shots.count).toBeGreaterThan(0);
      const from = ctx.nextProjectileId;
      fly(ctx, 3);
      expect(ctx.enemies.some((e) => !e.alive)).toBe(true);
      expect([ctx.nextProjectileId - from, splitsOf(ctx).pending]).toEqual([0, 0]);
    }
    // The signature's own kill: the volley's 10 kills 1, whose 5 hp the 2.5 of a small hit
    // cannot take.
    const own = arena([at(150, 0, { hp: 5 }), at(-450, 0)], {
      values: { barrageCount: 1 },
      modules: [SPLIT],
    });
    attack(own);
    const from = own.nextProjectileId;
    fly(own, 30);
    expect(enemy(own, 1).alive).toBe(false);
    expect(freshSlots(own, from)).toEqual([]);
  });

  it('splits nothing on a hit that breaks an onion’s shell, and splits the one that breaks its last', () => {
    // Killed: a shell's break taken for a kill. A v3 run's onion, its shell holding 1 hp.
    const shell = (layersLeft: number) => {
      const ctx = placedEnemies([at(30, 0, { type: 'onion', hp: 1 })], {
        stats: statsOf({ values: { barrageCount: 1 } }),
        data: v3TestData(),
        modules: [SPLIT],
        signature: VOLLEY,
      });
      const onion = enemy(ctx, 1);
      const record = onion.v3 as EnemyV3;
      record.layersLeft = layersLeft;
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      const from = ctx.nextProjectileId;
      tick(ctx);
      return {
        alive: onion.alive,
        left: record.layersLeft,
        children: freshSlots(ctx, from).length,
      };
    };
    expect(shell(3)).toEqual({ alive: true, left: 2, children: 0 });
    expect(shell(1)).toEqual({ alive: false, left: 0, children: 3 });
  });

  it('rolls the split’s chance on the barrage stream, drawing nothing at 1 or without the param and the rank', () => {
    // Killed: the roll on the combat stream, or a draw at chance 1.
    const run = (modules: readonly TestModule[], barrageSplit = 0) => {
      const ctx = arena([NEAR_KILL, at(-450, 0)], {
        values: { barrageCount: 1, barrageSplit },
        modules,
      });
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      tick(ctx);
      expect(enemy(ctx, 1).alive).toBe(false);
      return { positions: rngPositions(ctx), children: riderSlots(ctx).length };
    };
    const plain = run([]);
    const sure = run([SPLIT]);
    const rank = run([barrage({ split: { count: 3, chance: 0 } })], 1);
    const half = run([barrage({ split: { count: 3, chance: 0.5 } })]);
    const never = run([barrage({ split: { count: 3, chance: 0 } })]);
    const alone = run([], 1);
    const stream = createStreams(1).barrage;
    const fresh = stream.snapshot();
    const drew = stream.chance(0.5);
    expect([plain.children, sure.children, rank.children, never.children]).toEqual([0, 3, 3, 0]);
    expect(alone.children).toBe(3);
    expect(half.children).toBe(drew ? 3 : 0);
    for (const r of [sure, rank, never, alone]) expect(r.positions).toEqual(plain.positions);
    expect(plain.positions.barrage).toEqual(fresh);
    const { barrage: halfBarrage, ...halfRest } = half.positions;
    const { barrage: plainBarrage, ...plainRest } = plain.positions;
    expect(halfRest).toEqual(plainRest);
    expect(halfBarrage).toEqual(stream.snapshot());
    expect(plainBarrage).not.toEqual(halfBarrage);
  });

  it('splits at chance + barrageSplit, clamped: a rank alone, and a negative stat as none', () => {
    // Killed: the chance read without barrageSplit, or a negative stat taken.
    const kills = (chance: number, barrageSplit: number, seed: number): number => {
      const ctx = arena([NEAR_KILL, at(-450, 0)], {
        values: { barrageCount: 1, barrageSplit },
        modules: [barrage({ split: { count: 1, chance } })],
        seed,
      });
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      tick(ctx);
      return riderSlots(ctx).length;
    };
    const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
    const at0 = seeds.map((seed) => kills(0, 0.5, seed));
    const sum = seeds.map((seed) => kills(0.25, 0.25, seed));
    const neg = seeds.map((seed) => kills(0.5, -0.5, seed));
    // The same roll, chance(0.5), at each seed for the three.
    expect(sum).toEqual(at0);
    expect(neg).toEqual(at0);
    expect(at0.filter((n) => n === 1).length).toBeGreaterThan(5);
    expect(at0.filter((n) => n === 0).length).toBeGreaterThan(5);
    expect(seeds.map((seed) => kills(0.5, 0.75, seed))).toEqual(seeds.map(() => 1));
  });

  it('splits the 分裂 rank alone, without the param, into DEFAULT_SPLIT_COUNT children on the same roll', () => {
    // Killed: the rank inert without the param, or its roll other than chance(barrageSplit).
    const children = (barrageSplit: number, modules: readonly TestModule[], seed: number) => {
      const ctx = arena([NEAR_KILL, at(-450, 0)], {
        values: { barrageCount: 1, barrageSplit },
        modules,
        seed,
      });
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      tick(ctx);
      return riderSlots(ctx).length;
    };
    const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
    const param = seeds.map((seed) =>
      children(0.5, [barrage({ split: { count: 3, chance: 0 } })], seed),
    );
    const alone = seeds.map((seed) => children(0.5, [], seed));
    expect(alone).toEqual(param);
    expect(alone.filter((n) => n === DEFAULT_SPLIT_COUNT).length).toBeGreaterThan(5);
    expect(alone.filter((n) => n === 0).length).toBeGreaterThan(5);
    expect(alone.every((n) => n === 0 || n === DEFAULT_SPLIT_COUNT)).toBe(true);
  });

  it('counts the children the reserve refuses in barrageCapped, the pool as it stands after the stage', () => {
    // Killed: children spawned in the stage (the killing shot not yet compacted away).
    const ctx = arena([NEAR_KILL, at(-450, 0)], { values: { barrageCount: 1 }, modules: [SPLIT] });
    fill(ctx, SMALL_SHOT_CAP - 1);
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(liveProjectiles(ctx)).toBe(SMALL_SHOT_CAP);
    tick(ctx);
    expect(enemy(ctx, 1).alive).toBe(false);
    // The killing shot ended: one child in its slot, two refused.
    expect(riderSlots(ctx)).toHaveLength(1);
    expect(liveProjectiles(ctx)).toBe(SMALL_SHOT_CAP);
    expect(ctx.counters.barrageCapped).toBe(2);
  });

  it('bounds its records at SMALL_SHOT_CAP, counting a dropped split’s children as capped', () => {
    // Killed: an unbounded list, or a dropped split not counted.
    const ctx = arena([at(300, 0), at(-450, 0)], {
      modules: [barrage({ split: { count: 1, chance: 1 } })],
    });
    const victim = enemy(ctx, 1);
    for (let i = 0; i <= SMALL_SHOT_CAP; i++) splitOnKill(ctx, victim, 1, 0);
    expect(splitsOf(ctx).pending).toBe(SMALL_SHOT_CAP);
    expect(ctx.counters.barrageCapped).toBe(1);
    // Every split kept spawns its child: none it dropped could have.
    spawnSplits(ctx, riderOf(ctx));
    expect([riderSlots(ctx).length, ctx.counters.barrageCapped]).toEqual([SMALL_SHOT_CAP, 1]);
    expect(splitsOf(ctx).pending).toBe(0);
    // Three a split, and 彈雨's ×3 on a dropped one's.
    const rain = arena([at(300, 0)], {
      modules: [barrage({ split: { count: 3, chance: 1 } }), RAIN],
    });
    rain.now = 1;
    for (let i = 0; i <= SMALL_SHOT_CAP; i++) splitOnKill(rain, enemy(rain, 1), 1, 0);
    expect(rain.counters.barrageCapped).toBe(9);
    spawnSplits(rain, riderOf(rain));
    expect(riderSlots(rain)).toHaveLength(SMALL_SHOT_CAP);
    expect(rain.counters.barrageCapped).toBe(9 + SMALL_SHOT_CAP * 9 - SMALL_SHOT_CAP);
  });
});

describe('聚焦: every shot at one target while its condition holds (X6)', () => {
  it('lastAlive: with one enemy alive every shot and the ring’s go at it, × 1.2', () => {
    // Killed: focus holding with two alive, or the bonus on unfocused hits.
    const seen = watch();
    const every1 = barrage({ ring: { every: 1, directions: 4 } });
    const ctx = arena([at(300, 0), at(-450, 0)], {
      values: { barrageCount: 3 },
      modules: [FOCUS_LAST, every1, seen.module],
    });
    enemy(ctx, 2).alive = false;
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    // Without focus the one pick takes one shot and the ring goes round: here 3 + 4 at 1.
    const slots = riderSlots(ctx);
    expect(slots.map((s) => turned(ctx, s, 0))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(slots.map((s) => shotOf(ctx, s).scale)).toEqual([1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2]);
    for (const s of slots) expect(remembered(ctx, s)).toEqual([]);
    fly(ctx, 20);
    expect(smallHits(seen.hits).map((hit) => [hit.id, hit.amount])).toEqual(
      Array.from({ length: 7 }, () => [1, 3]),
    );
  });

  it('lastAlive: with two alive, the rider is as without focus, at its plain damage', () => {
    const seen = watch();
    const ctx = arena([at(300, 0), at(-300, 0)], {
      values: { barrageCount: 2 },
      modules: [FOCUS_LAST, seen.module],
    });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(riderSlots(ctx).map((s) => turned(ctx, s, 0))).toEqual([0, 180]);
    fly(ctx, 20);
    const hits = smallHits(seen.hits).map((hit) => [hit.id, hit.amount]);
    expect(hits.sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual([
      [1, 2.5],
      [2, 2.5],
    ]);
  });

  it('boss: every shot at the nearest alive boss, ties to the lower id, the others passed by', () => {
    const seen = watch();
    // 1 is nearer than either boss; 2 and 3 tie; 4, nearest of all, is a dead boss.
    const placed = [
      at(150, 0),
      at(0, 400, { type: 'boss' }),
      at(0, -400, { type: 'boss' }),
      at(-100, 0, { type: 'boss' }),
    ];
    const ctx = arena(placed, {
      values: { barrageCount: 3 },
      modules: [FOCUS_BOSS, seen.module],
    });
    enemy(ctx, 4).alive = false;
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(riderSlots(ctx).map((s) => turned(ctx, s, Math.PI / 2))).toEqual([0, 0, 0]);
    fly(ctx, 20);
    expect(smallHits(seen.hits).map((hit) => [hit.id, hit.amount])).toEqual([
      [2, 3],
      [2, 3],
      [2, 3],
    ]);
    // With the fan: the spread round the boss.
    const fan = arena(placed, { values: { barrageCount: 3 }, modules: [FOCUS_BOSS, FAN] });
    enemy(fan, 4).alive = false;
    fireBarrage(fan, riderOf(fan), P.x, P.y);
    expect(riderSlots(fan).map((s) => turned(fan, s, Math.PI / 2))).toEqual([-15, 0, 15]);
  });

  it('boss: without a live boss the rider is as without focus, though one enemy is left', () => {
    const seen = watch();
    const ctx = arena([at(300, 0), at(-300, 0, { type: 'boss' })], {
      values: { barrageCount: 2 },
      modules: [FOCUS_BOSS, seen.module],
    });
    enemy(ctx, 2).alive = false;
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(riderSlots(ctx).map((s) => shotOf(ctx, s).scale)).toEqual([1]);
    fly(ctx, 20);
    expect(smallHits(seen.hits).map((hit) => [hit.id, hit.amount])).toEqual([[1, 2.5]]);
  });

  it('hits the impact’s target under focus: its shots start inside it, unremembered', () => {
    // Killed: the impact skip kept under focus.
    const seen = watch();
    const ctx = arena([at(300, 0, { type: 'boss' }), at(-450, 0)], {
      signature: SWARM,
      values: { barrageCount: 2 },
      modules: [swarmCounts(1, 0), FOCUS_BOSS, seen.module],
    });
    const target = impactOn(ctx, 1);
    const slots = riderSlots(ctx);
    expect(slots).toHaveLength(2);
    for (const s of slots) {
      expect(shotOf(ctx, s)).toMatchObject({ x: target.x, y: target.y, scale: 1.2 });
      expect(remembered(ctx, s)).toEqual([]);
    }
    tick(ctx);
    expect(smallHits(seen.hits).map((hit) => [hit.id, hit.amount])).toEqual([
      [1, 3],
      [1, 3],
    ]);
    // lastAlive: the impact's target the one alive; without focus no shot at all.
    const last = arena([at(300, 0)], {
      signature: SWARM,
      modules: [swarmCounts(1, 0), FOCUS_LAST],
    });
    impactOn(last, 1);
    expect(riderSlots(last)).toHaveLength(2);
    const plain = arena([at(300, 0)], { signature: SWARM, modules: [swarmCounts(1, 0)] });
    impactOn(plain, 1);
    expect(riderSlots(plain)).toEqual([]);
  });

  it('boss: the nearer of two live bosses, not the farther, whatever their ids', () => {
    // Killed: the farthest boss, or the first in id order.
    const placed = [at(0, 400, { type: 'boss' }), at(-200, 0, { type: 'boss' }), at(100, 0)];
    const ctx = arena(placed, { values: { barrageCount: 2 }, modules: [FOCUS_BOSS] });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(riderSlots(ctx).map((s) => turned(ctx, s, angleTo(-200, 0)))).toEqual([0, 0]);
  });

  it('counts the ring’s attacks while focused, and takes 彈雨’s factor on its shots and ring', () => {
    // Killed: the focused path skipping the ring's count, or 彈雨's factor on its shots or ring.
    const every2 = barrage({ ring: { every: 2, directions: 4 } });
    const ctx = arena([at(300, 0), at(-450, 0)], {
      values: { barrageCount: 1 },
      modules: [FOCUS_LAST, every2, RAIN],
    });
    enemy(ctx, 2).alive = false;
    const fired: number[] = [];
    for (const now of [60, 61, 300, 301]) {
      // Focused in the window on 60 and 61; two alive, out of it, on 300 and 301.
      if (now === 300) enemy(ctx, 2).alive = true;
      ctx.now = now;
      const from = ctx.nextProjectileId;
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      fired.push(freshSlots(ctx, from).length);
    }
    expect(fired).toEqual([3, 3 + 12, 1, 1 + 4]);
    expect(riderOf(ctx).attacks).toBe(4);
  });

  it('keeps crits as they are, and the children of a focused kill at scale 1', () => {
    const seen = watch();
    const ctx = arena([NEAR_KILL, at(-450, 0)], {
      values: { barrageCount: 1, critChance: 1, critMultiplier: 3 },
      modules: [FOCUS_LAST, SPLIT, seen.module],
    });
    enemy(ctx, 2).alive = false;
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    enemy(ctx, 2).alive = true;
    tick(ctx);
    expect(smallHits(seen.hits).map((hit) => hit.amount)).toEqual([2.5 * 3 * 1.2]);
    expect(riderSlots(ctx).map((s) => shotOf(ctx, s).scale)).toEqual([1, 1, 1]);
  });
});

describe('彈雨: × its countMult inside a stateless window of the run’s tick (X7)', () => {
  const MANY = [at(100, 0), at(0, 150), at(-200, 0), at(0, -250), at(300, 0), at(0, 350)];

  it('multiplies the shots on ticks 1–119 and 600–719, not on 120–599 and 720–1199', () => {
    // Killed: the window's `<` as `<=`, or a window off by a tick.
    const shotsAt = (now: number): number => {
      const ctx = arena(MANY, { values: { barrageCount: 1 }, modules: [RAIN] });
      ctx.now = now;
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      return riderSlots(ctx).length;
    };
    const ticks = [1, 119, 120, 599, 600, 719, 720, 1199, 1200];
    expect(ticks.map(shotsAt)).toEqual([3, 3, 1, 1, 3, 3, 1, 1, 3]);
  });

  it('multiplies the fan’s N, the ring’s directions and ★’s count in the window alone', () => {
    const every1 = barrage({ ring: { every: 1, directions: 12 } });
    const shotsAt = (now: number, modules: readonly TestModule[]): number => {
      const ctx = arena(MANY, { values: { barrageCount: 2 }, modules: [RAIN, ...modules] });
      ctx.now = now;
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      return riderSlots(ctx).length;
    };
    expect([shotsAt(60, [FAN]), shotsAt(300, [FAN])]).toEqual([6, 2]);
    expect([shotsAt(60, [FAN, every1]), shotsAt(300, [FAN, every1])]).toEqual([6 + 36, 2 + 12]);
    expect([shotsAt(60, [STAR, FAN]), shotsAt(300, [STAR, FAN])]).toEqual([12, 4]);
    // The fan's spread over its 6: 30° × (i / 5 − 0.5).
    const ctx = arena(MANY, { values: { barrageCount: 2 }, modules: [RAIN, FAN] });
    ctx.now = 60;
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(riderSlots(ctx).map((s) => turned(ctx, s, 0))).toEqual([-15, -9, -3, 3, 9, 15]);
  });

  it('multiplies the children by the window at their spawn tick', () => {
    // Fired on 118 and 119, each kills on the next tick: 9 children on 119, 3 on 120.
    const children = (fired: number): number => {
      const ctx = arena([NEAR_KILL], { values: { barrageCount: 1 }, modules: [RAIN, SPLIT] });
      ctx.now = ctx.state.tick = fired;
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      expect(riderSlots(ctx)).toHaveLength(1);
      tick(ctx);
      return riderSlots(ctx).length;
    };
    expect([children(118), children(119)]).toEqual([9, 3]);
  });

  it('never multiplies a template payload’s or a projectiles effect’s shots', () => {
    // Killed: rain on a template payload's count.
    for (const spec of [
      TEMPLATE,
      { kind: 'projectiles', count: 3, aim: 'radial', damagePct: 0.5 } as EffectSpec,
    ]) {
      const counts = [60, 300].map((now) => {
        const ctx = arena(MANY, {
          values: { barrageCount: 5 },
          triggers: [onKill(spec)],
          modules: [RAIN],
        });
        ctx.now = now;
        runFirst(ctx, 'projectiles');
        return ctx.shots.count;
      });
      expect(counts).toEqual(spec === TEMPLATE ? [7, 7] : [3, 3]);
    }
  });

  it('reads the run’s tick, which a wave change never resets: ×3 on 1–119 and 600–719 of a run', () => {
    // Stationary squares far off, a wave every 5 s; a volley run's pool holds the rider's shots
    // alone: those launched each tick, by window.
    const data = makeTestData({
      enemies: { square: { hpMult: 1e12, speed: 0 } },
      waves: {
        rules: [{ enemy: 'square', fromWave: 1, base: 6, perWave: 0, maxCount: 6 }],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
        waveTimerSec: 5,
      },
    });
    const sim = createSimulation(
      makeConfig({
        seed: 1,
        stats: statsOf({ values: { barrageCount: 1 } }),
        signature: VOLLEY,
        maxTicks: 1300,
      }),
      data,
      [RAIN],
    );
    const inside: number[] = [];
    const outside: number[] = [];
    while (!sim.state.finished) {
      sim.step(NO_INPUT);
      const { tick, shots, shotCount } = sim.state;
      let fresh = 0;
      for (let s = 0; s < shotCount; s++) if (shots.launched[s] === tick) fresh++;
      if (fresh > 0) (tick % 600 < 120 ? inside : outside).push(fresh);
    }
    // Waves 2 and 3 started on ticks 301 and 601; the windows came all the same.
    expect([sim.state.tick, sim.state.wave]).toEqual([1300, 5]);
    expect(inside.length).toBeGreaterThan(2);
    expect(outside.length).toBeGreaterThan(2);
    expect(new Set(inside)).toEqual(new Set([3]));
    expect(new Set(outside)).toEqual(new Set([1]));
  });
});

/** The hash and result of a run of `options` on the fixture data, `ticks` long from `wave`. */
function runHash(options: Options, ticks = 900, wave = 12) {
  const sim = createSimulation(
    makeConfig({
      seed: options.seed ?? 1,
      stats: statsOf(options),
      rules: options.rules ?? [],
      signature: options.signature ?? VOLLEY,
      startWave: wave,
      maxTicks: ticks,
    }),
    makeTestData(),
    options.modules ?? [],
  );
  const hash = createRunHash();
  while (!sim.state.finished) hash.update(JSON.stringify(sim.step(NO_INPUT)));
  const result = sim.result();
  hash.update(JSON.stringify([result.damageBySource, result.counters]));
  return { hash: hash.digest(), result };
}

describe('a grant without the ◆ params, and determinism (X9)', () => {
  it('plays a grant build with the params at their defaults or inert event for event as without them', () => {
    // Killed: any default that changes a run (a split round, a ring count, a focus scan).
    const defaults = barrage({ ...DEFAULT_BARRAGE_PARAMS });
    const inert = barrage({ spreadDeg: 90 });
    for (const signature of [VOLLEY, SWARM]) {
      const options: Options = {
        signature,
        values: { barrageCount: 3, barragePierce: 1, critChance: 0.3 },
      };
      const base = runHash(options);
      expect(runHash({ ...options, modules: [defaults] }).hash, signature.id).toBe(base.hash);
      expect(runHash({ ...options, modules: [inert] }).hash, signature.id).toBe(base.hash);
      expect(toNumber(base.result.damageBySource['outer.barrage'] ?? ZERO)).toBeGreaterThan(0);
    }
  });

  it('plays the 分裂 rank alone event for event as split { 3, 0 } at its chance, ★ and 巨大化 included', () => {
    // Killed: the rank alone inert, its count not DEFAULT_SPLIT_COUNT, not × countMult, or halved.
    const zero = barrage({ split: { count: 3, chance: 0 } });
    for (const signature of [VOLLEY, SWARM]) {
      for (const [modules, rules] of [
        [[], []],
        [[STAR], []],
        [[], [GIGANTISM]],
      ] as [TestModule[], RuleSpec[]][]) {
        const options: Options = {
          signature,
          rules,
          values: { damage: 60, barrageCount: 3, barragePierce: 1, barrageSplit: 0.5 },
        };
        const label = `${signature.id} ${modules.length} ${rules.length}`;
        const alone = runHash({ ...options, modules });
        const param = runHash({ ...options, modules: [zero, ...modules] });
        const none = runHash({
          ...options,
          values: { ...options.values, barrageSplit: 0 },
          modules,
        });
        expect(alone.hash, label).toBe(param.hash);
        // It splits: the rank alone is not inert.
        expect(alone.hash, label).not.toBe(none.hash);
      }
    }
  });

  it('plays E10a’s grant builds event for event as E10a’s base did: the hashes recorded there', () => {
    // Recorded at da403bb (E10a on 8a50ca8) with the same runHash.
    const recorded = { m1Volley: '0e923b5844e8d51f', swarm: '917a6f02d7b2911f' };
    for (const signature of [VOLLEY, SWARM]) {
      const options: Options = {
        signature,
        values: { barrageCount: 3, barragePierce: 1, critChance: 0.3, igniteChance: 0.3 },
      };
      expect(runHash(options).hash, signature.id).toBe(recorded[signature.id as 'swarm']);
    }
  });

  it('plays the same events twice from one seed with every param at work, and others from another', () => {
    for (const signature of [VOLLEY, SWARM]) {
      const options: Options = {
        signature,
        values: { barrageCount: 3, barragePierce: 1, critChance: 0.3, igniteChance: 0.3 },
        modules: [FAN, RING, SPLIT, FOCUS_BOSS, RAIN, STAR],
      };
      const first = runHash(options, 1200, 10);
      expect(runHash(options, 1200, 10).hash, signature.id).toBe(first.hash);
      expect(first.result.counters.barrageCapped).toBeGreaterThanOrEqual(0);
      expect(runHash({ ...options, seed: 2 }, 1200, 10).hash).not.toBe(first.hash);
    }
  });
});
