import { describe, expect, it, vi } from 'vitest';
import { num, toNumber, ZERO } from '../../core/num';
import { createStreams } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { EnemyId } from '../../data/types';
import type { Modifier, StatBlock, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import { STACK_AILMENTS } from '../../data/triggers';
import type { GroundZoneSpec, TriggerSpec } from '../../data/triggers';
import { enemySlow } from '../ailments/frost';
import { compileBuild } from '../build/compile';
import { liveStacks } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { PROJECTILE_CAP, SIGNATURE_ZONE_CAP } from '../caps';
import { dispatchPendingKills } from '../effects/dispatch';
import { runEffect, runEffectQueue } from '../effects/execute';
import { HIT_EVENT, PRIMARY, REPEAT, SIGNATURE } from '../effects/flags';
import { createEffectEntry, dequeue } from '../effects/queue';
import { EVENT, MAX_DEPTH, SHATTER_TRIGGER } from '../effects/types';
import type { CompiledTrigger } from '../effects/types';
import type { TestModule } from '../rules';
import { magmaBomb } from '../rules/magmaBomb';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { ORBITING, stepEnemyAi } from '../systems/enemyAi';
import { rebuildGrid } from '../systems/grid';
import { moveEnemies } from '../systems/movement';
import { moveProjectiles } from '../systems/projectiles';
import { MOTION_STRAIGHT, spawnShot } from '../systems/shots';
import { stepZones } from '../systems/zones';
import {
  centerTriggers,
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
  stationarySquares,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import {
  aimDense,
  aimFar,
  beginAim,
  fireLobRepeat,
  isFar,
  launch,
  LOB_FAR,
  LOB_NORMAL,
  LOB_VOLCANO,
  runLob,
} from './lob';
import { ALWAYS_IGNITES } from './types';
import type { EmitterRuntime, EmitterSpec, LobSpec, Payload } from './types';

const MAGMA: SignatureSpec = { id: 'magmaBomb' };
const BURN = STACK_AILMENTS.indexOf('burn');
const POISON = STACK_AILMENTS.indexOf('poison');
/** magmaBomb's flight, in ticks. */
const FLIGHT = 24;
/** The tags of an explosion hit. */
const EXPLOSION_TAGS = TAG.hit | TAG.area | TAG.projectile;

/** The player's position, and the landing point of these tests' bombs, 440 right of it. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const L = { x: P.x + 440, y: P.y };
/** An enemy (dx, dy) from L. */
const near = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: L.x + dx,
  y: L.y + dy,
  ...extra,
});

/**
 * Six standing enemies of one dense block. Alive enemies within 60 of each, itself included:
 * 1 has 3 (1, 2, 3), 2 has 4 (1, 2, 3, 6), 3 has 3, 4 has 2 (4, 5), 5 has 2 and 6 has 2 (2, 6).
 * Only 4 and 5 stand 2 radii (120) from 2.
 */
const SALVO: readonly PlacedEnemy[] = [
  { x: 1300, y: 500 },
  { x: 1330, y: 500 },
  { x: 1300, y: 530 },
  { x: 1455, y: 500 },
  { x: 1485, y: 500 },
  { x: 1365, y: 500 },
];

interface BombOptions {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  readonly scoped?: readonly Modifier[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
}

/** Stats without crits, ignites or chains unless `values` say so, with these center triggers. */
const plain = (
  values: Partial<Record<StatId, number>> = {},
  triggers: readonly TriggerSpec[] = [],
  scoped: readonly Modifier[] = [],
): StatBlock =>
  makeStats({ critChance: 0, igniteChance: 0, chainCount: 0, ...values }, scoped, {
    ...centerTriggers(triggers),
  });

/** placedEnemies with the magmaBomb signature. */
const bombs = (placed: readonly PlacedEnemy[], options: BombOptions = {}): RunContext =>
  placedEnemies(placed, {
    stats: plain(options.values, options.triggers, options.scoped),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
    signature: MAGMA,
  });

/** The signature's emitter, the lob. */
const lobOf = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;

/** The enemy with id `id` (placedEnemies numbers them 1, 2, … in order). */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** Moves `e` to (x, y); the next rebuildGrid places it there. */
const moveTo = (e: Enemy, x: number, y: number): void => {
  e.x = e.prevX = x;
  e.y = e.prevY = y;
};

/** Aims the first bomb of a firing of the lob; the enemy it aims at, or null. */
const aim = (ctx: RunContext): Enemy | null => {
  const em = lobOf(ctx);
  beginAim(ctx, em);
  return aimDense(ctx, em);
};

/** Makes one firing of the lob due and runs the lob, which fires it. */
const fire = (ctx: RunContext): void => {
  const em = lobOf(ctx);
  em.acc = em.interval - em.cadence;
  runLob(ctx, em);
};

/**
 * Lobs a bomb of the signature at `at`, landing FLIGHT ticks from now, its hits at `depth` from
 * trigger `origin` (0 and −1, the emitter's own, by default), of form `form` and payload `p`
 * (a normal bomb of the emitter's payload by default).
 */
const launchAt = (
  ctx: RunContext,
  at: { x: number; y: number },
  depth = 0,
  origin = -1,
  form = LOB_NORMAL,
  p: Payload = lobOf(ctx).payload,
): void => {
  const em = lobOf(ctx);
  const ls = ctx.sys.lob;
  ls.x = at.x;
  ls.y = at.y;
  launch(ctx, em, p, form, false, depth, origin);
};

/**
 * Jumps the clock to the landing tick of the bombs lobbed this tick, rebuilds the grid and runs
 * the projectile stage on cleared events. Returns the landing tick.
 */
function landAll(ctx: RunContext): number {
  const landAt = ctx.now + FLIGHT;
  ctx.now = ctx.state.tick = landAt;
  rebuildGrid(ctx);
  ctx.events.length = 0;
  moveProjectiles(ctx);
  return landAt;
}

/**
 * Lobs a bomb of the signature at `at` and lands it: `before` runs after the launch (to move
 * enemies), then landAll. Returns the landing tick.
 */
function bombAt(ctx: RunContext, at: { x: number; y: number } = L, before?: () => void): number {
  launchAt(ctx, at);
  before?.();
  return landAll(ctx);
}

/** Steps the zone stage alone over ticks from + 1 .. to; returns their events. */
function zoneTicks(ctx: RunContext, from: number, to: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let tick = from + 1; tick <= to; tick++) {
    ctx.now = ctx.state.tick = tick;
    ctx.events.length = 0;
    stepZones(ctx);
    events.push(...ctx.events);
  }
  return events;
}

/** Advances `twin` until it stands where `rng` does; throws when it never does. */
function sync(twin: Rng, rng: Rng): void {
  for (let n = 0; n < 10_000; n++) {
    if (String(twin.snapshot()) === String(rng.snapshot())) return;
    twin.next();
  }
  throw new Error('the twin stream never meets the run’s');
}

interface SeenHit {
  readonly id: number;
  readonly k: number;
  readonly primary: boolean;
}

interface SeenCenter {
  readonly event: number;
  readonly target: number | null;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly list: number[];
  /** How many hits and which events came before it, ignites aside. */
  readonly hits: number;
  readonly events: SimEvent['type'][];
}

/** Hooks that record every hit and every center event, in order. */
function watch(): { module: TestModule; hits: SeenHit[]; centers: SeenCenter[] } {
  const hits: SeenHit[] = [];
  const centers: SeenCenter[] = [];
  const module: TestModule = (b) => {
    b.hook('onHit', (_ctx, hit) => {
      hits.push({ id: hit.target.id, k: hit.chainIndex, primary: (hit.flags & PRIMARY) !== 0 });
    });
    b.hook('onCenterEvent', (ctx, ev) => {
      centers.push({
        event: ev.event,
        target: ev.target === null ? null : ev.target.id,
        x: ev.x,
        y: ev.y,
        radius: ev.radius,
        list: ev.list.slice(0, ev.listCount).map((e) => e.id),
        hits: hits.length,
        events: ctx.events.map((event) => event.type).filter((type) => type !== 'ignite'),
      });
    });
  };
  return { module, hits, centers };
}

describe('magmaBomb', () => {
  it('compiles to a lob of 150% that always ignites its area projectile hits, its lob params neutral', () => {
    const build = compileBuild(makeStats(), [], MAGMA);
    expect(build.signature.lob).toEqual({
      farThrowEvery: 0,
      volcano: null,
      chainBlast: null,
      zone: { slow: 0 },
    });
    expect(build.emitters[0]).toMatchObject({
      kind: 'lob',
      signature: true,
      source: 'center',
      damagePct: 1.5,
      tags: EXPLOSION_TAGS,
      chains: true,
      rollsAilments: true,
      canCrit: true,
      baseRate: 1.5,
      radius: 60,
      flightTicks: FLIGHT,
      zone: { radius: 60, durationSec: 1.5, damagePctPerSec: 0.3 },
    });
    const IGNITE_ALWAYS = SCOPED_INDEX.igniteAlways;
    expect(build.mods.filter((mod) => mod.stat === IGNITE_ALWAYS)).toMatchObject([
      { kind: 0, value: 1, all: TAG.area | TAG.projectile, none: TAG.trigger },
    ]);
    // projectileCount − 1 bombs a firing: one at the base 2.
    expect(build.values.projectileCount).toBe(1);
    expect(
      compileBuild(makeStats({ projectileCount: 3.5 }), [], MAGMA).values.projectileCount,
    ).toBe(2.5);
    const m1 = compileBuild(makeStats(), []);
    expect(m1.signature.lob).toBeNull();
    expect(m1.values.projectileCount).toBe(2);
  });

  it('gives its payload a 火地 variant that rolls ailments and always ignites (Q4 (B), Q4/F1)', () => {
    const ctx = bombs([]);
    const p = lobOf(ctx).payload;
    expect(p.flags).toBe(SIGNATURE);
    expect(p.zoneVariant).toMatchObject({
      tags: TAG.hit | TAG.zone,
      source: p.source,
      flags: ALWAYS_IGNITES,
      chains: false,
      rollsAilments: true,
      canCrit: true,
      aggregate: true,
      zoneVariant: null,
    });
    expect(p.zoneVariant?.rng).toBe(ctx.combatRng);
    expect(ALWAYS_IGNITES).toBe(1 << 20);
  });

  it('fires 1.5 times a second at the base attack speed, every 40 ticks, every 10 at 16 and 80/3 at 6 (D4)', () => {
    const ctx = bombs([near(0, 0)]);
    const em = lobOf(ctx);
    expect(em.interval).toBe(40);
    for (let tick = 0; tick < 120; tick++) runLob(ctx, em);
    expect(em.attacks).toBe(3);
    expect(lobOf(bombs([], { values: { attackSpeed: 16 } })).interval).toBe(10);
    // 2.25 a second at 6: 80/3 ticks, not rounded to whole ticks.
    expect(lobOf(bombs([], { values: { attackSpeed: 6 } })).interval).toBe(TICK_RATE / 2.25);
  });

  it("fires on M1's accumulator ticks, the fraction carried: 45 firings in 1,210 ticks at 6 (D4)", () => {
    const ticks = 1210;
    /** The ticks on which the lob fires at `attackSpeed`, and those M1's accumulator gives. */
    const firings = (attackSpeed: number): { actual: number[]; expected: number[] } => {
      const ctx = bombs([near(0, 0)], { values: { attackSpeed } });
      const em = lobOf(ctx);
      // M1 (volley.test.ts): + 1 a tick; an attack each time it reaches the interval, which it
      // takes off, the rest kept.
      const expected: number[] = [];
      let acc = 0;
      for (let tick = 1; tick <= ticks; tick++) {
        acc += 1;
        while (acc >= em.interval) {
          acc -= em.interval;
          expected.push(tick);
        }
      }
      const actual: number[] = [];
      for (let tick = 1; tick <= ticks; tick++) {
        const before = em.attacks;
        runLob(ctx, em);
        for (let f = before; f < em.attacks; f++) actual.push(tick);
      }
      return { actual, expected };
    };
    // 80/3 ticks at 6: a firing every 27 ticks, its fraction dropped, would make 44.
    const at6 = firings(6);
    expect(at6.actual).toEqual(at6.expected);
    expect(at6.actual).toHaveLength(45);
    // 0.8 ticks at 200: two firings on some ticks.
    const at200 = firings(200);
    expect(at200.actual).toEqual(at200.expected);
    expect(at200.actual).toHaveLength(1512);
  });
});

describe('lob bomb count (Q3 (B))', () => {
  it('throws one bomb a firing at the base projectileCount and draws no count roll', () => {
    const ctx = bombs(SALVO);
    const em = lobOf(ctx);
    const before = rngPositions(ctx);
    for (let f = 1; f <= 3; f++) {
      fire(ctx);
      expect([em.attacks, em.shots, ctx.shots.count]).toEqual([f, f, f]);
    }
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('throws two bombs a firing at projectileCount 3', () => {
    const ctx = bombs(SALVO, { values: { projectileCount: 3 } });
    const em = lobOf(ctx);
    fire(ctx);
    fire(ctx);
    expect(eventsOf([ctx.events], 'lob')).toHaveLength(4);
    expect([em.attacks, em.shots]).toEqual([2, 4]);
  });

  it('draws one count roll a firing at 2.5, after countAttack and before the first launch', () => {
    const seen: { combat: readonly number[]; shots: number; queued: number }[] = [];
    const spy: TestModule = (b) =>
      b.hook('onAttack', (ctx) => {
        seen.push({
          combat: ctx.combatRng.snapshot(),
          shots: ctx.shots.count,
          queued: ctx.effectQueue.size,
        });
      });
    const ctx = bombs(SALVO, {
      values: { projectileCount: 2.5 },
      triggers: [{ on: 'nthAttack', every: 1, do: [{ kind: 'heal', lifePct: 0.01 }] }],
      modules: [spy],
    });
    const twin = createStreams(1).combat;
    sync(twin, ctx.combatRng);
    const counts: number[] = [];
    for (let f = 0; f < 24; f++) {
      const combat = ctx.combatRng.snapshot();
      const shots = ctx.shots.count;
      const queued = ctx.effectQueue.size;
      fire(ctx);
      // The hooks of countAttack ran before the roll and before any bomb; its trigger after them.
      expect(seen[f]).toEqual({ combat, shots, queued });
      expect(ctx.effectQueue.size).toBe(queued + 1);
      const expected = twin.next() < 0.5 ? 2 : 1;
      expect(ctx.combatRng.snapshot()).toEqual(twin.snapshot());
      counts.push(ctx.shots.count - shots);
      expect(counts[f]).toBe(expected);
    }
    expect(new Set(counts)).toEqual(new Set([1, 2]));
  });
});

describe('lob aim', () => {
  /**
   * Within 60 of each: 1 has 1, 2 and 3; 2 has all four (3 is 50 away, 4 too); 3 has 1, 2 and 3;
   * 4 has 2 and 4; 5 stands alone far off. 2 walks 1 a tick.
   */
  const AIM: readonly PlacedEnemy[] = [
    { x: 1300, y: 540 },
    { x: 1330, y: 540, speed: 60 },
    { x: 1300, y: 580 },
    { x: 1380, y: 540 },
    { x: 400, y: 300 },
  ];

  it('picks the block member with the most enemies within 60 and leads it by 24 steps', () => {
    const ctx = bombs(AIM);
    const before = rngPositions(ctx);
    expect(aim(ctx)).toBe(enemy(ctx, 2));
    // 370 from the player, 24 ticks of 1 closer.
    expect(ctx.sys.lob.x).toBeCloseTo(1306, 9);
    expect(ctx.sys.lob.y).toBeCloseTo(540, 9);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('fires each due firing at that point, its bomb landing 24 ticks later', () => {
    const ctx = bombs(AIM);
    const em = lobOf(ctx);
    fire(ctx);
    const [lob] = eventsOf([ctx.events], 'lob');
    expect(lob).toMatchObject({ fromX: P.x, fromY: P.y, landAt: 1 + FLIGHT, form: LOB_NORMAL });
    expect(lob?.x).toBeCloseTo(1306, 9);
    expect(lob?.id).toBe(ctx.shots.id[0]);
    expect(em.attacks).toBe(1);
    expect(em.shots).toBe(1);
    expect(ctx.shots.count).toBe(1);
  });

  it('aims at a frozen enemy where it stands, though it thaws before the bomb lands', () => {
    const ctx = bombs([{ x: 1300, y: 600, speed: 60 }]);
    const target = enemy(ctx, 1);
    // The lead takes its slow at aim time: frozen now, walking again 10 ticks into the flight.
    target.frozenUntil = ctx.now + 10;
    expect(aim(ctx)).toBe(target);
    expect(ctx.sys.lob.x).toBeCloseTo(1300, 9);
    expect(ctx.sys.lob.y).toBeCloseTo(600, 9);
  });

  it('leads a fast enemy no closer than its contact distance', () => {
    // A triangle 100 away at 220 a second would walk 88; its contact distance is 30 + 16.
    const ctx = bombs([{ x: P.x + 100, y: P.y, type: 'triangle', speed: 220 }]);
    expect(aim(ctx)).toBe(enemy(ctx, 1));
    expect(ctx.sys.lob.x).toBeCloseTo(P.x + 46, 9);
  });

  it('fires nothing and banks nothing while no enemy is alive', () => {
    const ctx = bombs([near(0, 0)]);
    const em = lobOf(ctx);
    enemy(ctx, 1).alive = false;
    rebuildGrid(ctx);
    expect(aim(ctx)).toBeNull();
    for (let i = 0; i < 100; i++) runLob(ctx, em);
    expect(ctx.shots.count).toBe(0);
    expect(em.attacks).toBe(0);
    expect(em.acc).toBe(em.interval - em.cadence);
    enemy(ctx, 1).alive = true;
    rebuildGrid(ctx);
    runLob(ctx, em);
    expect(eventsOf([ctx.events], 'lob')).toHaveLength(1);
    expect(em.attacks).toBe(1);
  });

  it('aims later bombs 2 radii from those aimed, else at the best not aimed, else none', () => {
    const ctx = bombs(SALVO);
    const em = lobOf(ctx);
    const ls = ctx.sys.lob;
    const before = rngPositions(ctx);
    beginAim(ctx, em);
    // 2 radii (SALVO_SEPARATION) of 60.
    expect([ls.radiusSq, ls.sepSq]).toEqual([60 * 60, 120 * 120]);
    const order = Array.from({ length: 7 }, () => aimDense(ctx, em)?.id ?? null);
    expect(ls.m).toBe(6);
    expect(ls.counts.slice(0, 6)).toEqual([3, 4, 3, 2, 2, 2]);
    // 2 has the most; 4 is the best 120 from 2 (5 ties it, later); then none is 120 from both,
    // so the best not aimed in source order: 1, 3, 5, 6; then nothing is left.
    expect(order).toEqual([2, 4, 1, 3, 5, 6, null]);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('aims a later bomb 2 radii from the first over a denser candidate 1.5–2 radii from it', () => {
    // Within 60 of each: 1 has 1, 2, 3 and 5; 4 has 4, 6 and 7; every other one has 2. 4, 6 and 7
    // stand 105–113 from 1, past 1.5 radii (90) but inside 2 (120); only 8 and 9 stand 2 radii
    // from 1. Then none is 2 radii from both 1 and 8, so the best not aimed: 4.
    const ctx = bombs([
      { x: 1335, y: 500 },
      { x: 1335, y: 540 },
      { x: 1335, y: 460 },
      { x: 1440, y: 500 },
      { x: 1285, y: 500 },
      { x: 1440, y: 540 },
      { x: 1440, y: 460 },
      { x: 1510, y: 500 },
      { x: 1510, y: 540 },
    ]);
    const em = lobOf(ctx);
    beginAim(ctx, em);
    const order = Array.from({ length: 3 }, () => aimDense(ctx, em)?.id ?? null);
    expect(ctx.sys.lob.counts.slice(0, 9)).toEqual([4, 2, 2, 3, 2, 2, 2, 2, 2]);
    expect(order).toEqual([1, 8, 4]);
  });

  it('takes a candidate exactly 2 radii from the enemies aimed at, at least SALVO_SEPARATION radii (D10)', () => {
    // Within 60 of each: 1 and 2 have 1 and 2; 3 stands alone, 120 from 1 and 90 from 2.
    const ctx = bombs([
      { x: 1300, y: 500 },
      { x: 1330, y: 500 },
      { x: 1420, y: 500 },
    ]);
    const em = lobOf(ctx);
    beginAim(ctx, em);
    const order = Array.from({ length: 3 }, () => aimDense(ctx, em)?.id ?? null);
    expect(ctx.sys.lob.counts.slice(0, 3)).toEqual([2, 2, 1]);
    // 3 stands exactly 2 radii from 1, so it goes before the denser 2, which only the best not
    // aimed then reaches.
    expect(order).toEqual([1, 3, 2]);
  });

  it('keeps later bombs 2 radii from the enemies aimed at, not from their bombs’ landing points', () => {
    // Within 60 of each: 1 has 1, 2 and 3; 2 and 3 have 1 and themselves; 4 stands alone, 125
    // from 1, past 2 radii. 1 walks 2 a tick, so its bomb lands 77 from 4.
    const ctx = bombs([
      { x: 1400, y: 540, speed: 120 },
      { x: 1400, y: 500 },
      { x: 1400, y: 580 },
      { x: 1275, y: 540 },
    ]);
    const em = lobOf(ctx);
    beginAim(ctx, em);
    expect(aimDense(ctx, em)).toBe(enemy(ctx, 1));
    expect(ctx.sys.lob.counts.slice(0, 4)).toEqual([3, 2, 2, 1]);
    // 440 from the player, 24 ticks of 2 closer.
    expect(ctx.sys.lob.x).toBeCloseTo(1352, 9);
    expect(aimDense(ctx, em)).toBe(enemy(ctx, 4));
  });

  it('measures a walking candidate where it stands, not where its bomb would land', () => {
    // As above, but 1 stands and 4, 125 from it, walks 2 a tick: its bomb lands 77 from 1.
    const ctx = bombs([
      { x: 1400, y: 540 },
      { x: 1400, y: 500 },
      { x: 1400, y: 580 },
      { x: 1525, y: 540, speed: 120 },
    ]);
    const em = lobOf(ctx);
    beginAim(ctx, em);
    expect(aimDense(ctx, em)).toBe(enemy(ctx, 1));
    expect(ctx.sys.lob.counts.slice(0, 4)).toEqual([3, 2, 2, 1]);
    expect(aimDense(ctx, em)).toBe(enemy(ctx, 4));
    // 565 from the player, 24 ticks of 2 closer.
    expect(ctx.sys.lob.x).toBeCloseTo(1477, 9);
  });

  it('aims each firing afresh: one bomb a firing goes to the same densest enemy every time', () => {
    // beginAim forgets the earlier firings' picks: kept, they would send the second firing's bomb
    // 2 radii from 2, to 4.
    const ctx = bombs(SALVO);
    fire(ctx);
    fire(ctx);
    fire(ctx);
    const target = enemy(ctx, 2);
    expect(
      eventsOf([ctx.events], 'lob').map((lob) => [Math.round(lob.x), Math.round(lob.y)]),
    ).toEqual([
      [target.x, target.y],
      [target.x, target.y],
      [target.x, target.y],
    ]);
  });

  it('lands a firing’s bombs at those enemies and loses the bombs left without one', () => {
    const ctx = bombs(SALVO, { values: { projectileCount: 8 } });
    const em = lobOf(ctx);
    fire(ctx);
    const lobs = eventsOf([ctx.events], 'lob');
    expect(lobs.map((lob) => [Math.round(lob.x), Math.round(lob.y)])).toEqual(
      [2, 4, 1, 3, 5, 6].map((id) => [enemy(ctx, id).x, enemy(ctx, id).y]),
    );
    // 7 bombs: the 7th has no candidate, so it is neither shot nor counted.
    expect([em.attacks, em.shots, ctx.shots.count]).toEqual([1, 6, 6]);
  });

  it('throws one bomb of four at a lone enemy', () => {
    const ctx = bombs([near(0, 0)], { values: { projectileCount: 5 } });
    const em = lobOf(ctx);
    fire(ctx);
    expect(eventsOf([ctx.events], 'lob')).toHaveLength(1);
    expect([em.attacks, em.shots, ctx.shots.count]).toEqual([1, 1, 1]);
  });

  it('counts the firing once, at the first bomb’s enemy, and each bomb as a shot (C28)', () => {
    const ctx = bombs(SALVO, {
      values: { projectileCount: 4 },
      triggers: [
        { on: 'nthAttack', every: 1, do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 1 }] },
      ],
    });
    const em = lobOf(ctx);
    fire(ctx);
    expect(ctx.effectQueue.size).toBe(1);
    expect(eventsOf([ctx.events], 'lob')).toHaveLength(3);
    expect([em.attacks, em.volley, em.shots]).toEqual([1, 1, 3]);
    // Its bombs aim at 2, 4 and 1; the trigger's target is 2.
    runEffectQueue(ctx);
    expect(ctx.enemies.map((e) => liveStacks(e, POISON, ctx.now))).toEqual([0, 1, 0, 0, 0, 0]);
  });

  it('keeps bomb 1’s point when an nthAttack trigger picks the densest enemy (N6)', () => {
    const densest: TestModule = (b) =>
      b.addTrigger('center', {
        on: 'nthAttack',
        every: 1,
        target: { pick: 'densest' },
        do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 1 }],
      });
    const lobs = (modules: readonly TestModule[]): SimEvent[] => {
      const ctx = bombs(SALVO, { values: { projectileCount: 3 }, modules });
      fire(ctx);
      expect(ctx.effectQueue.size).toBe(modules.length);
      return eventsOf([ctx.events], 'lob');
    };
    const plainLobs = lobs([]);
    expect(plainLobs).toHaveLength(2);
    expect(lobs([densest])).toEqual(plainLobs);
  });

  it('keeps bomb 1’s aim and its own point when a densest() in countAttack finds another block (N6)', () => {
    // Two enemies far from SALVO's block; theirs is the densest block while SALVO's are dead.
    const placed = [...SALVO, { x: 400, y: 300 }, { x: 420, y: 300 }];
    const elsewhere: TestModule = (b) =>
      b.hook('onAttack', (ctx) => {
        const salvo = ctx.enemies.slice(0, SALVO.length);
        for (const e of salvo) e.alive = false;
        ctx.grid.densest(ctx.selection.dense);
        for (const e of salvo) e.alive = true;
      });
    const run = (modules: readonly TestModule[]) => {
      const ctx = bombs(placed, { values: { projectileCount: 3 }, modules });
      fire(ctx);
      expect(ctx.sys.lob.dense).not.toBe(ctx.selection.dense);
      const block: Enemy[] = [];
      const m = ctx.grid.blockItems(block);
      return {
        lobs: eventsOf([ctx.events], 'lob'),
        dense: { ...ctx.sys.lob.dense },
        selection: { ...ctx.selection.dense },
        block: block.slice(0, m).map((e) => e.id),
      };
    };
    const still = run([]);
    const moved = run([elsewhere]);
    // The hook left the grid's last block at 7 and 8 and the selection's point there.
    expect([still.block, moved.block]).toEqual([
      [1, 2, 3, 4, 5, 6],
      [7, 8],
    ]);
    expect(moved.selection).not.toEqual(moved.dense);
    // The lob's own point: the center of SALVO's block.
    expect(still.dense).toEqual({ x: 1344, y: 448 });
    expect(moved.dense).toEqual(still.dense);
    expect(still.lobs).toHaveLength(2);
    expect(moved.lobs).toEqual(still.lobs);
  });

  it('counts the bombs PROJECTILE_CAP refuses as shots, and as capped', () => {
    const ctx = bombs(SALVO, { values: { projectileCount: 4 } });
    const em = lobOf(ctx);
    for (let i = 0; i < PROJECTILE_CAP - 1; i++) {
      spawnShot(
        ctx,
        MOTION_STRAIGHT,
        P.x,
        P.y,
        0,
        0,
        ctx.now + 1000,
        em.payload,
        1,
        0,
        0,
        0,
        -1,
        false,
        -1,
        -1,
        null,
      );
    }
    ctx.events.length = 0;
    const capped = ctx.counters.projectilesCapped;
    fire(ctx);
    expect(eventsOf([ctx.events], 'lob')).toHaveLength(1);
    expect(ctx.counters.projectilesCapped).toBe(capped + 2);
    expect(em.shots).toBe(3);
    expect(ctx.shots.count).toBe(PROJECTILE_CAP);
  });

  describe('steady bombs', () => {
    /** Which bombs of four firings of 2 bombs are steady. */
    const steadiness = (options: BombOptions): boolean[][] => {
      const ctx = bombs(SALVO, { ...options, values: { projectileCount: 3 } });
      return Array.from({ length: 4 }, () => {
        const from = ctx.shots.count;
        fire(ctx);
        const steady: boolean[] = [];
        for (let s = from; s < ctx.shots.count; s++) steady.push(ctx.shots.steady[s] === 1);
        return steady;
      });
    };
    const steadyAim = (counts: 'shot' | 'attack', everyNth: number): RuleSpec => ({
      id: 'steadyAim',
      everyNth,
      critMultiplierMore: 0,
      counts,
    });

    it("makes every Nth bomb steady across firings with counts 'shot' (K21)", () => {
      expect(steadiness({ rules: [steadyAim('shot', 3)] })).toEqual([
        [false, false],
        [true, false],
        [false, true],
        [false, false],
      ]);
    });

    it("makes every bomb of every Nth firing steady with counts 'attack'", () => {
      expect(steadiness({ rules: [steadyAim('attack', 2)] })).toEqual([
        [false, false],
        [true, true],
        [false, false],
        [true, true],
      ]);
    });

    it('makes a whole firing steady when an onAttack hook forces crits', () => {
      const third: TestModule = (b) =>
        b.hook('onAttack', (_ctx, em, shot) => {
          if (em.attacks === 3) shot.forceCrit = true;
        });
      expect(steadiness({ modules: [third] })).toEqual([
        [false, false],
        [false, false],
        [true, true],
        [false, false],
      ]);
    });

    /**
     * Whether each hit of three firings' bombs crits, at critChance 0: the primary (1), the
     * other explosion hit (2) and the chain's jump (3).
     */
    const crits = (options: BombOptions): { random: boolean; hits: string[][] } => {
      const ctx = bombs([near(0, 0), near(20, 0), near(150, 0)], {
        ...options,
        values: { chainCount: 1 },
      });
      const hits = Array.from({ length: 3 }, () => {
        fire(ctx);
        landAll(ctx);
        return eventsOf([ctx.events], 'hit').map(
          (hit) => `${hit.targetId}/${hit.chainIndex}${hit.crit ? ' crit' : ''}`,
        );
      });
      return { random: ctx.build.flags.randomCrits, hits };
    };
    const STEADY = ['1/0 crit', '2/0 crit', '3/1 crit'];
    const UNSTEADY = ['1/0', '2/0', '3/1'];

    it('crits every hit of a steady bomb, its explosion’s and its chain’s, and none of another', () => {
      expect(crits({ rules: [steadyAim('attack', 2)] })).toEqual({
        random: false,
        hits: [UNSTEADY, STEADY, UNSTEADY],
      });
      // Random crits on, at chance 0: only the forced firing crits.
      const second: TestModule = (b) =>
        b.hook('onAttack', (_ctx, em, shot) => {
          if (em.attacks === 2) shot.forceCrit = true;
        });
      expect(crits({ modules: [second] })).toEqual({
        random: true,
        hits: [UNSTEADY, STEADY, UNSTEADY],
      });
    });
  });
});

describe('lob aim at a v3 enemy (docs/v3 C7 design §2.5, §2.6; lead ruling Y12)', () => {
  /** v3 data whose waves hold no enemy (docs/v3 C7 design §1.9); the treasure orbits a second. */
  const data = v3TestData({
    enemies: {
      treasure: {
        behaviour: { kind: 'treasure', orbitDist: 480, orbitSec: 1, fleeMult: 2 },
      },
    },
    waves: {
      rules: [{ enemy: 'triangle', fromWave: 1, base: 0, perWave: 0, maxCount: 0 }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

  /**
   * One enemy of `type` `dx` right of the player at `speed`, with the magmaBomb signature, after
   * `ticks` ticks of the enemy AI step and movement: where the lob leads it, and where it is after
   * the bomb's FLIGHT ticks more.
   */
  function leadAndLanding(type: EnemyId, dx: number, speed: number, ticks: number) {
    const ctx = placedEnemies([{ x: P.x + dx, y: P.y, type, speed }], {
      stats: plain(),
      signature: MAGMA,
      data,
    });
    const target = enemy(ctx, 1);
    const tick = (): void => {
      stepEnemyAi(ctx);
      moveEnemies(ctx);
      ctx.now++;
      ctx.state.tick++;
    };
    for (let k = 0; k < ticks; k++) tick();
    const state = target.v3?.state;
    rebuildGrid(ctx);
    expect(aim(ctx)).toBe(target);
    const lead = { x: ctx.sys.lob.x, y: ctx.sys.lob.y };
    for (let k = 0; k < FLIGHT; k++) tick();
    return { state, lead, landing: { x: target.x, y: target.y }, dist: target.dist };
  }

  it('leads a treasure turning in its orbit along it: where it stands after the flight’s turns', () => {
    // Planted bug (C7.4a's gap): an orbiting treasure, its step 0, aimed where it stands.
    const { state, lead, landing, dist } = leadAndLanding('treasure', 480, 150, 1);
    expect([state, dist]).toEqual([ORBITING, 480]);
    expect(lead.x).toBeCloseTo(landing.x, 9);
    expect(lead.y).toBeCloseTo(landing.y, 9);
    // 24 turns of 2.5 / 480 from bearing (1, 0), 1 turn already taken.
    expect(Math.atan2(lead.y - P.y, lead.x - P.x)).toBeCloseTo((25 * 2.5) / 480, 12);
  });

  it.each<[string, EnemyId, number, number, number, number]>([
    // A fleeing treasure 24 steps of 5 further out, from 480 + 10 × 5 (its flight from tick 61).
    ['a fleeing treasure further out', 'treasure', 480, 150, 70, 650],
    // A charging dasher stands its 36 ticks, a shooter at its post and a treasure orbiting at
    // speed 0 stand: each where it stands.
    ['a charging dasher where it stands', 'dasher', 420, 110, 1, 420],
    ['a shooter at its post where it stands', 'shooter', 300, 120, 1, 300],
    ['a treasure orbiting at speed 0 where it stands', 'treasure', 480, 0, 1, 480],
  ])('leads %s, along its line', (_label, type, dx, speed, ticks, landsAt) => {
    const { lead, landing, dist } = leadAndLanding(type, dx, speed, ticks);
    expect(dist).toBe(landsAt);
    expect([lead.x, lead.y]).toEqual([landing.x, landing.y]);
    expect(Math.hypot(lead.x - P.x, lead.y - P.y)).toBeCloseTo(landsAt, 9);
  });
});

describe('lob landing', () => {
  it('hits the enemies within 60 of the point at landing time, in id order', () => {
    const spy = watch();
    const ctx = bombs([near(70, 0), near(0, 0), near(-60, 0), near(30, 30), near(0, -100)], {
      modules: [spy.module],
    });
    bombAt(ctx, L, () => {
      moveTo(enemy(ctx, 1), L.x + 59, L.y);
      moveTo(enemy(ctx, 2), L.x, L.y + 61);
    });
    expect(spy.hits.map((hit) => hit.id)).toEqual([1, 3, 4]);
    expect(eventsOf([ctx.events], 'explosion')).toEqual([
      { type: 'explosion', x: L.x, y: L.y, radius: 60, primaryId: 4, count: 3 },
    ]);
    expect(ctx.shots.count).toBe(0);
  });

  it('gives PRIMARY to exactly the nearest enemy, the lower id on ties', () => {
    const spy = watch();
    const ctx = bombs([near(40, 0), near(0, 20), near(-20, 0), near(0, -30)], {
      modules: [spy.module],
    });
    bombAt(ctx);
    expect(spy.hits).toEqual([
      { id: 1, k: 0, primary: false },
      { id: 2, k: 0, primary: true },
      { id: 3, k: 0, primary: false },
      { id: 4, k: 0, primary: false },
    ]);
  });

  it('chains once from the primary past the blast; the budget counts the primary and jumps (K6)', () => {
    const spy = watch();
    // 1 and 2 are in the blast; 3 is the nearest enemy outside it, 150 from the primary, and 4
    // the nearest to 3.
    const ctx = bombs([near(0, 0), near(40, 0), near(150, 0), near(300, 0)], {
      values: { chainCount: 2 },
      modules: [spy.module],
    });
    bombAt(ctx);
    expect(spy.hits).toEqual([
      { id: 1, k: 0, primary: true },
      { id: 2, k: 0, primary: false },
      { id: 3, k: 1, primary: false },
      { id: 4, k: 2, primary: false },
    ]);
    expect(ctx.chainBudget.hits).toBe(3);
    expect(ctx.counters.chainHitsPeak).toBe(3);
  });

  it('chains from a primary its explosion killed, as a volley chains from its kill (M1 parity)', () => {
    const spy = watch();
    const ctx = bombs([near(0, 0, { hp: 1 }), near(150, 0)], {
      values: { chainCount: 1 },
      modules: [spy.module],
    });
    bombAt(ctx);
    expect(enemy(ctx, 1).alive).toBe(false);
    expect(spy.hits).toEqual([
      { id: 1, k: 0, primary: true },
      { id: 2, k: 1, primary: false },
    ]);
  });

  it('tags its explosion hits hit, area and projectile, and its chain jumps neither of the last', () => {
    const ctx = bombs([near(0, 0), near(20, 0), near(150, 0)], { values: { chainCount: 1 } });
    bombAt(ctx);
    const hits = eventsOf([ctx.events], 'hit');
    expect(hits.map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
    ]);
    expect(hits.slice(0, 2).map((hit) => hit.tags)).toEqual([EXPLOSION_TAGS, EXPLOSION_TAGS]);
    expect((hits[2]?.tags ?? -1) & (TAG.area | TAG.projectile)).toBe(0);
  });

  it('lets a projectile modifier reach its explosion hits only: not its jumps, 火地 or burns', () => {
    const PROJECTILE_MORE: Modifier = {
      stat: 'damage',
      kind: 'increased',
      value: 0.5,
      tags: ['projectile'],
    };
    const run = (scoped: readonly Modifier[]) => {
      const ctx = bombs([near(0, 0), near(20, 0), near(150, 0)], {
        values: { chainCount: 1, burnMaxStacks: 50 },
        scoped,
      });
      const landAt = bombAt(ctx);
      const hits = eventsOf([ctx.events], 'hit').map((hit) => toNumber(hit.amount));
      const pulses = eventsOf([zoneTicks(ctx, landAt, landAt + 120)], 'pulse');
      return {
        explosion: hits.slice(0, 2),
        jump: hits[2],
        pulses: pulses.map((pulse) => toNumber(pulse.total)),
        burns: ctx.enemies.map((e) => e.burns.map((stack) => toNumber(stack.dps))),
      };
    };
    const base = run([]);
    const more = run([PROJECTILE_MORE]);
    expect(more.explosion).toEqual(base.explosion.map((amount) => amount * 1.5));
    expect(more.jump).toBe(base.jump);
    expect(base.pulses).toHaveLength(6);
    expect(more.pulses).toEqual(base.pulses);
    expect(base.burns.flat().length).toBeGreaterThan(2);
    expect(more.burns).toEqual(base.burns);
  });

  it('ignites on every explosion hit, its roll still drawn, while chain hits roll (R14)', () => {
    const ctx = bombs([near(0, 0), near(20, 0), near(-20, 0)], { values: { igniteChance: 0.5 } });
    const combat = createStreams(1).combat;
    sync(combat, ctx.combatRng);
    bombAt(ctx);
    expect(ctx.enemies.map((e) => liveStacks(e, BURN, ctx.now))).toEqual([1, 1, 1]);
    // One ignite roll per hit; no crit, chain or other roll.
    for (let i = 0; i < 3; i++) combat.next();
    expect(ctx.combatRng.snapshot()).toEqual(combat.snapshot());

    const chained = bombs([near(0, 0), near(20, 0), near(150, 0)], { values: { chainCount: 1 } });
    bombAt(chained);
    expect(chained.enemies.map((e) => liveStacks(e, BURN, chained.now))).toEqual([1, 1, 0]);
  });

  it('raises explode once, after the hits, the chain and the explosion, before the zone', () => {
    const spy = watch();
    const ctx = bombs([near(10, 0), near(0, 0), near(200, 0)], {
      values: { chainCount: 1 },
      modules: [spy.module],
    });
    bombAt(ctx);
    expect(spy.centers).toEqual([
      {
        event: EVENT.explode,
        target: 2,
        x: L.x,
        y: L.y,
        radius: 60,
        list: [1, 2],
        hits: 3,
        events: ['hit', 'hit', 'hit', 'explosion'],
      },
    ]);
    const types = ctx.events.map((event) => event.type).filter((type) => type !== 'ignite');
    expect(types).toEqual(['hit', 'hit', 'hit', 'explosion', 'zone']);
  });

  it('raises explode with no target and an empty list when the bomb hits nothing', () => {
    const spy = watch();
    const ctx = bombs([near(200, 0)], { modules: [spy.module] });
    // A list left by an earlier event.
    ctx.centerScratch.list[0] = enemy(ctx, 1);
    ctx.centerScratch.listCount = 1;
    bombAt(ctx);
    expect(spy.hits).toEqual([]);
    expect(spy.centers).toMatchObject([{ event: EVENT.explode, target: null, list: [] }]);
    expect(ctx.centerScratch.listCount).toBe(0);
    expect(eventsOf([ctx.events], 'explosion')).toMatchObject([{ primaryId: -1, count: 0 }]);
    expect(eventsOf([ctx.events], 'zone')).toHaveLength(1);
  });

  it('keeps the first 5 of the blast by id as its list, past the freezes of its hits (C1)', () => {
    const spy = watch();
    const ctx = bombs(
      [
        near(0, 0),
        near(10, 0, { hp: 1 }),
        near(20, 0),
        near(30, 0),
        near(40, 0),
        near(50, 0),
        near(0, 30),
      ],
      { values: { frostOnHit: 1 }, modules: [spy.module] },
    );
    bombAt(ctx);
    expect(enemy(ctx, 2).alive).toBe(false);
    // The explosion event counts all 7 it hit, past the list's 5.
    expect(eventsOf([ctx.events], 'explosion')).toMatchObject([{ primaryId: 1, count: 7 }]);
    const freezes = spy.centers.filter((seen) => seen.event === EVENT.freeze);
    expect(freezes.length).toBeGreaterThan(0);
    expect(freezes.at(-1)?.list).not.toEqual([1, 2, 3, 4, 5]);
    // The dead enemy 2 stays in it.
    expect(spy.centers.at(-1)).toMatchObject({ event: EVENT.explode, list: [1, 2, 3, 4, 5] });
  });

  it('fans an explode trigger that applies a status out over the alive enemies of its list', () => {
    const ctx = bombs([near(0, 0), near(10, 0, { hp: 1 }), near(20, 0), near(200, 0)], {
      triggers: [{ on: 'explode', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 2 }] }],
    });
    bombAt(ctx);
    runEffectQueue(ctx);
    expect(ctx.enemies.map((e) => liveStacks(e, POISON, ctx.now))).toEqual([2, 0, 2, 0]);
  });

  it('raises explode at the bomb’s depth and origin; its trigger’s effect queues one deeper, from it', () => {
    // The build's first data trigger.
    const T = SHATTER_TRIGGER + 1;
    /** [depth, origin] of each entry queued by the landing of a bomb launched at depth, origin. */
    const queued = (depth: number, origin: number): number[][] => {
      const ctx = bombs([near(0, 0)], {
        triggers: [{ on: 'explode', do: [{ kind: 'heal', lifePct: 0.01 }] }],
      });
      launchAt(ctx, L, depth, origin);
      landAll(ctx);
      const entry = createEffectEntry();
      const seen: number[][] = [];
      while (ctx.effectQueue.size > 0) {
        dequeue(ctx.effectQueue, entry);
        seen.push([entry.depth, entry.origin]);
      }
      return seen;
    };
    // The signature's own bombs: depth 0, origin −1.
    expect(queued(0, -1)).toEqual([[1, T]]);
    expect(queued(1, -1)).toEqual([[2, T]]);
    // Rule 3: not on its own trigger's damage.
    expect(queued(1, T)).toEqual([]);
  });

  it('hits at the bomb’s depth and origin, explosion and chain alike: their hit triggers queue one deeper (rule 6)', () => {
    const T = SHATTER_TRIGGER + 1;
    /**
     * [depth, origin, target id] of each entry queued by the landing of a bomb launched at depth,
     * origin.
     */
    const queued = (depth: number, origin: number): number[][] => {
      // 1 takes the primary hit and 2 another explosion hit; the chain jumps from 1 to 3.
      const ctx = bombs([near(0, 0), near(20, 0), near(150, 0)], {
        values: { chainCount: 1 },
        triggers: [{ on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] }],
      });
      launchAt(ctx, L, depth, origin);
      landAll(ctx);
      const entry = createEffectEntry();
      const seen: number[][] = [];
      while (ctx.effectQueue.size > 0) {
        dequeue(ctx.effectQueue, entry);
        seen.push([entry.depth, entry.origin, entry.target === null ? -1 : entry.target.id]);
      }
      return seen;
    };
    expect(queued(0, -1)).toEqual([
      [1, T, 1],
      [1, T, 2],
      [1, T, 3],
    ]);
    expect(queued(1, -1)).toEqual([
      [2, T, 1],
      [2, T, 2],
      [2, T, 3],
    ]);
    // Rule 3: not on its own trigger's damage.
    expect(queued(1, T)).toEqual([]);
  });

  it('lands each bomb of one tick as its own attack, explode and 火地', () => {
    const spy = watch();
    const L2 = { x: L.x, y: L.y - 200 };
    const ctx = bombs([near(0, 0), near(20, 0), near(0, -200), near(20, -200)], {
      values: { chainCount: 1 },
      modules: [spy.module],
    });
    launchAt(ctx, L);
    launchAt(ctx, L2);
    const serial = ctx.attackSerial;
    landAll(ctx);
    expect(ctx.attackSerial).toBe(serial + 2);
    // Each chain passes over its own bomb's victims only.
    expect(spy.hits).toEqual([
      { id: 1, k: 0, primary: true },
      { id: 2, k: 0, primary: false },
      { id: 3, k: 1, primary: false },
      { id: 3, k: 0, primary: true },
      { id: 4, k: 0, primary: false },
      { id: 1, k: 1, primary: false },
    ]);
    expect(eventsOf([ctx.events], 'explosion').map((e) => [e.y, e.primaryId])).toEqual([
      [L.y, 1],
      [L2.y, 3],
    ]);
    expect(spy.centers.filter((seen) => seen.event === EVENT.explode)).toMatchObject([
      { target: 1, y: L.y, list: [1, 2] },
      { target: 3, y: L2.y, list: [3, 4] },
    ]);
    expect(eventsOf([ctx.events], 'zone').map((zone) => zone.signature)).toEqual([true, true]);
    expect(ctx.sys.zones.liveSignature).toBe(2);
  });

  it('evicts the oldest 火地 for the 17th live one and counts it', () => {
    const ctx = bombs([]);
    const n = SIGNATURE_ZONE_CAP + 1;
    for (let i = 0; i < n; i++) launchAt(ctx, { x: 200 + 90 * i, y: 200 });
    landAll(ctx);
    const zones = eventsOf([ctx.events], 'zone');
    expect(zones).toHaveLength(n);
    expect(eventsOf([ctx.events], 'zoneEnd')).toEqual([
      { type: 'zoneEnd', id: zones[0]?.id, evicted: true },
    ]);
    expect(ctx.counters.zonesEvicted).toBe(1);
    expect(ctx.sys.zones.liveSignature).toBe(SIGNATURE_ZONE_CAP);
  });

  it('leaves a signature fire zone of 60 that pulses 6 times over 1.5 s', () => {
    const ctx = bombs([near(0, 0)]);
    const landAt = bombAt(ctx);
    const [zone] = eventsOf([ctx.events], 'zone');
    expect(zone).toMatchObject({
      x: L.x,
      y: L.y,
      radius: 60,
      expiresAt: landAt + 90,
      signature: true,
    });
    const events = zoneTicks(ctx, landAt, landAt + 120);
    const pulses = eventsOf([events], 'pulse').filter((pulse) => pulse.id === zone?.id);
    expect(pulses).toHaveLength(6);
    expect(pulses.every((pulse) => pulse.hits === 1)).toBe(true);
    expect(eventsOf([events], 'zoneEnd')).toEqual([
      { type: 'zoneEnd', id: zone?.id, evicted: false },
    ]);
  });

  it('aims and explodes by the bomb’s radius and sizes its 火地 by the zone’s (F27)', () => {
    const lobOnly = magmaBomb.emitter;
    // The same lob with a 火地 of 40 (the two radii are both 60 in the data).
    const spy = vi.spyOn(magmaBomb, 'emitter').mockImplementation((spec): EmitterSpec => {
      const lob = lobOnly(spec) as LobSpec;
      return { ...lob, zone: { ...lob.zone, radius: 40 } };
    });
    try {
      const ctx = bombs([near(0, 0)]);
      beginAim(ctx, lobOf(ctx));
      expect([ctx.sys.lob.radiusSq, ctx.sys.lob.sepSq]).toEqual([60 * 60, 120 * 120]);
      bombAt(ctx);
      expect(eventsOf([ctx.events], 'explosion')).toMatchObject([{ radius: 60 }]);
      expect(eventsOf([ctx.events], 'zone')).toMatchObject([{ radius: 40 }]);
    } finally {
      spy.mockRestore();
    }
    expect(magmaBomb.emitter).toBe(lobOnly);
  });

  it('leaves its 火地 at the landing point, not at its primary (D10)', () => {
    const ctx = bombs([near(30, 0)]);
    bombAt(ctx);
    expect(eventsOf([ctx.events], 'explosion')).toMatchObject([{ x: L.x, y: L.y, primaryId: 1 }]);
    expect(eventsOf([ctx.events], 'zone')).toMatchObject([{ x: L.x, y: L.y }]);
  });

  it('gives its 火地 the bomb’s depth and origin', () => {
    const ctx = bombs([]);
    launchAt(ctx, L);
    launchAt(ctx, { x: L.x, y: L.y - 200 }, 1, SHATTER_TRIGGER + 1);
    landAll(ctx);
    const zones = ctx.sys.zones;
    const records = Array.from(zones.record.subarray(0, zones.count));
    expect(records.map((r) => [zones.depth[r], zones.origin[r]])).toEqual([
      [0, -1],
      [1, SHATTER_TRIGGER + 1],
    ]);
  });

  it('slows the enemies in its fire zone by lob.zone.slow, and not at all at 0 (F2)', () => {
    const frostFire: TestModule = (b) => {
      const lob = b.signature().lob;
      if (lob !== null) lob.zone.slow = 0.3;
    };
    const slowAfterPulse = (modules: readonly TestModule[]): number => {
      const ctx = bombs([near(0, 0)], { modules });
      const landAt = bombAt(ctx);
      zoneTicks(ctx, landAt, landAt + 15);
      return enemySlow(ctx, enemy(ctx, 1), ctx.now);
    };
    expect(slowAfterPulse([frostFire])).toBe(0.3);
    expect(slowAfterPulse([])).toBe(0);
  });

  it('carries SIGNATURE on its hits and lands the shot it was', () => {
    const flags: number[] = [];
    const module: TestModule = (b) => b.hook('onHit', (_ctx, hit) => void flags.push(hit.flags));
    const ctx = bombs([near(0, 0)], { modules: [module] });
    const em = lobOf(ctx);
    expect((em.spec as LobSpec).flightTicks).toBe(FLIGHT);
    bombAt(ctx);
    expect(flags).toHaveLength(1);
    expect((flags[0] as number) & SIGNATURE).toBe(SIGNATURE);
    expect(ctx.shots.count).toBe(0);
  });
});

describe('火地 (Q4 (B), Q4/F1)', () => {
  const ignitesOf = (events: readonly SimEvent[]): number[] =>
    eventsOf([events], 'ignite').map((ignite) => ignite.targetId);

  it('ignites on every hit at igniteChance 0, as the explosion does, but not the chain', () => {
    const ctx = bombs([near(0, 0), near(20, 0), near(150, 0)], {
      values: { chainCount: 1, burnMaxStacks: 50 },
    });
    const before = rngPositions(ctx);
    const landAt = bombAt(ctx);
    // The row ignites the explosion hits; the jump to 3 keeps the chance of 0.
    expect(ignitesOf(ctx.events)).toEqual([1, 2]);
    const events = zoneTicks(ctx, landAt, landAt + 120);
    expect(eventsOf([events], 'pulse').map((pulse) => pulse.hits)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(ignitesOf(events)).toEqual([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
    expect(enemy(ctx, 3).burns).toEqual([]);
    // Every chance at 0: nothing drawn.
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('draws crit, ignite and poison per hit in pulse order, as a payload without the bit does', () => {
    const values = {
      critChance: 0.5,
      igniteChance: 0.5,
      poisonChance: 0.5,
      burnMaxStacks: 50,
    };
    const placed = [near(0, 0), near(20, 0), near(-20, 0)];
    const always = bombs(placed, { values });
    const rolled = bombs(placed, { values });
    const landAt = bombAt(always);
    bombAt(rolled);
    // The rolled run's 火地 gets a copy of its payload without ALWAYS_IGNITES.
    const zones = rolled.sys.zones;
    const record = zones.record[0] as number;
    const p = zones.payload[record] as Payload;
    expect(p).toBe(lobOf(rolled).payload.zoneVariant);
    zones.payload[record] = { ...p, flags: 0 };
    const twin = createStreams(1).combat;
    sync(twin, always.combatRng);
    expect(rolled.combatRng.snapshot()).toEqual(twin.snapshot());
    let hits = 0;
    let rolledIgnites = 0;
    for (let tick = landAt + 1; tick <= landAt + 120; tick++) {
      const a = zoneTicks(always, tick - 1, tick);
      const r = zoneTicks(rolled, tick - 1, tick);
      const pulses = eventsOf([a], 'pulse');
      expect(eventsOf([r], 'pulse')).toEqual(pulses);
      const crits: number[] = [];
      const ignites: number[] = [];
      const poisons: number[] = [];
      for (const pulse of pulses) {
        expect(pulse.hits).toBe(3);
        for (const id of [1, 2, 3]) {
          if (twin.next() < 0.5) crits.push(id);
          if (twin.next() < 0.5) ignites.push(id);
          if (twin.next() < 0.5) poisons.push(id);
        }
        hits += pulse.hits;
      }
      expect(pulses.flatMap((pulse) => pulse.crits)).toEqual(crits);
      expect(always.combatRng.snapshot()).toEqual(twin.snapshot());
      expect(rolled.combatRng.snapshot()).toEqual(twin.snapshot());
      expect(ignitesOf(a)).toEqual(pulses.length === 0 ? [] : [1, 2, 3]);
      expect(ignitesOf(r)).toEqual(ignites);
      rolledIgnites += ignites.length;
      const poisoned = (events: SimEvent[]) =>
        eventsOf([events], 'ailmentApplied').map((applied) => applied.targetId);
      expect(poisoned(a)).toEqual(poisons);
      expect(poisoned(r)).toEqual(poisons);
    }
    expect(hits).toBe(18);
    expect(rolledIgnites).toBeGreaterThan(0);
    expect(rolledIgnites).toBeLessThan(18);
  });

  it('crits on its pulse hits at the crit chance while random crits are on; under steadyAim never', () => {
    const pulseCrits = (rules: readonly RuleSpec[]): number[][] => {
      const ctx = bombs([near(0, 0), near(20, 0)], { values: { critChance: 1 }, rules });
      const landAt = bombAt(ctx);
      const pulses = eventsOf([zoneTicks(ctx, landAt, landAt + 120)], 'pulse');
      return pulses.map((pulse) => [...pulse.crits]);
    };
    expect(pulseCrits([])).toEqual(Array.from({ length: 6 }, () => [1, 2]));
    const steadyAim: RuleSpec = {
      id: 'steadyAim',
      everyNth: 4,
      critMultiplierMore: 0,
      counts: 'shot',
    };
    expect(pulseCrits([steadyAim])).toEqual(Array.from({ length: 6 }, () => []));
  });

  it('leaves a center-board groundZone in the same build to its chance of 0', () => {
    const zone: GroundZoneSpec = {
      kind: 'groundZone',
      radius: 50,
      durationSec: 1,
      damagePctPerSec: 1,
    };
    // A trigger that never fires here, so its zone appears only where the test runs it.
    const idle: TriggerSpec = { on: 'periodic', every: 1000, do: [zone] };
    const Z = { x: L.x, y: L.y - 300 };
    const ctx = bombs([near(0, 0), { x: Z.x, y: Z.y }], {
      values: { burnMaxStacks: 50 },
      triggers: [idle],
    });
    const landAt = bombAt(ctx);
    const entry = createEffectEntry();
    entry.effect = (ctx.build.triggers[SHATTER_TRIGGER + 1] as CompiledTrigger).effectStart;
    entry.depth = 0;
    entry.origin = -1;
    entry.source = ctx.build.effects[entry.effect]?.source ?? 0;
    entry.x = Z.x;
    entry.y = Z.y;
    runEffect(ctx, entry);
    const [bomb, center] = eventsOf([ctx.events], 'zone');
    const hp = enemy(ctx, 2).hp;
    const events = zoneTicks(ctx, landAt, landAt + 120);
    expect([bomb?.signature, center?.signature, center?.source]).toEqual([true, false, 0]);
    expect(
      eventsOf([events], 'pulse').filter((p) => p.id === center?.id && p.hits === 1).length,
    ).toBe(4);
    expect(toNumber(enemy(ctx, 2).hp)).toBeLessThan(toNumber(hp));
    expect(ignitesOf(events)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('keeps ALWAYS_IGNITES on its hits’ flags but not on their kills’ (HIT_BITS)', () => {
    const zoneHits: number[] = [];
    const kills: number[] = [];
    const module: TestModule = (b) => {
      b.hook('onHit', (_ctx, hit) => {
        if ((hit.mask & TAG.zone) !== 0) zoneHits.push(hit.flags);
      });
      b.hook('onKill', (_ctx, _victim, kill) => void kills.push(kill.flags));
    };
    // The explosion deals 150 of its 160; 火地's pulses deal 7.5 each, so the second kills.
    const ctx = bombs([near(0, 0, { hp: 160 })], { values: { damage: 100 }, modules: [module] });
    const landAt = bombAt(ctx);
    expect(enemy(ctx, 1).alive).toBe(true);
    zoneTicks(ctx, landAt, landAt + 60);
    expect(enemy(ctx, 1).alive).toBe(false);
    expect(zoneHits).toHaveLength(2);
    expect(zoneHits.every((flags) => (flags & ALWAYS_IGNITES) !== 0)).toBe(true);
    expect(kills).toHaveLength(1);
    expect((kills[0] as number) & (ALWAYS_IGNITES | HIT_EVENT)).toBe(HIT_EVENT);
  });

  it('gives 火地 a burn credit of its own in the burn-credit loop (zoneVariant)', () => {
    const lobOnly = magmaBomb.emitter;
    // The bomb's own hits roll nothing, so only its 火地 can credit the signature's burns.
    const spy = vi.spyOn(magmaBomb, 'emitter').mockImplementation((spec): EmitterSpec => ({
      ...(lobOnly(spec) as LobSpec),
      rollsAilments: false,
    }));
    try {
      const zone: GroundZoneSpec = {
        kind: 'groundZone',
        radius: 50,
        durationSec: 1,
        damagePctPerSec: 1,
      };
      const fusion: TriggerSpec = { on: 'periodic', every: 1000, do: [zone] };
      const sourced = (triggers: StatBlock['triggers']): StatBlock =>
        makeStats({}, [], { triggers, conversions: [], emitters: [] });
      const ctx = placedEnemies([], {
        stats: sourced([{ source: 'fusion.fire.aura', spec: fusion }]),
        signature: MAGMA,
      });
      const p = lobOf(ctx).payload;
      expect([p.rollsAilments, p.zoneVariant?.rollsAilments]).toEqual([false, true]);
      expect(ctx.burnMixed).toBe(true);
      const alone = placedEnemies([], { stats: sourced([]), signature: MAGMA });
      expect(alone.burnMixed).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(magmaBomb.emitter).toBe(lobOnly);
  });
});

describe('the explode center event', () => {
  it('comes from bombs only: not from effect explosions or the hub kill explosion (R25)', () => {
    let explodes = 0;
    const module: TestModule = (b) =>
      b.hook('onCenterEvent', (_ctx, ev) => {
        if (ev.event === EVENT.explode) explodes++;
      });
    const stats = makeStats({ critChance: 0 }, [], {
      triggers: [
        {
          source: 'center',
          spec: {
            on: 'nthAttack',
            every: 2,
            do: [{ kind: 'explode', radius: 30, damagePct: 0.1 }],
          },
        },
        {
          source: 'hub',
          spec: { on: 'kill', do: [{ kind: 'explode', radius: 120, damagePct: 1 }] },
        },
      ],
      conversions: [],
      emitters: [],
    });
    const sim = createSimulation(
      makeConfig({ stats, signature: MAGMA, maxTicks: 900 }),
      makeTestData(),
      [module],
    );
    const events: SimEvent[] = [];
    while (!sim.state.finished) events.push(...sim.step(NO_INPUT));
    const bursts = eventsOf([events], 'burst');
    expect(bursts.filter((burst) => burst.radius === 30).length).toBeGreaterThan(0);
    expect(bursts.filter((burst) => burst.radius === 120).length).toBeGreaterThan(0);
    expect(explodes).toBe(eventsOf([events], 'explosion').length);
    expect(explodes).toBeGreaterThan(0);
  });

  it('runs a whole run of stationary squares the same twice', () => {
    const config = makeConfig({
      stats: plain({ chainCount: 1, projectileCount: 3.5 }),
      signature: MAGMA,
      maxTicks: 600,
    });
    const runOnce = (): SimEvent[] => {
      const sim = createSimulation(config, stationarySquares(12, 3));
      const events: SimEvent[] = [];
      while (!sim.state.finished) events.push(...sim.step(NO_INPUT));
      return events;
    };
    const first = runOnce();
    expect(eventsOf([first], 'explosion').length).toBeGreaterThan(10);
    expect(runOnce()).toEqual(first);
  });
});

const FAR_THROW = (every = 4): RuleSpec => ({ id: 'farThrow', every });
const VOLCANO: RuleSpec = { id: 'volcano', periodSec: 3, radiusMult: 3, damageMult: 5 };
const CHAIN_BLAST = (perBomb = 2): RuleSpec => ({
  id: 'chainBlast',
  radius: 40,
  damagePct: 0.5,
  perBomb,
});

/** The form of each lob event of `ctx`'s events, firing by firing of `firings` firings. */
function formsByFiring(ctx: RunContext, firings: number): number[][] {
  return Array.from({ length: firings }, () => {
    ctx.events.length = 0;
    fire(ctx);
    return eventsOf([ctx.events], 'lob').map((lob) => lob.form);
  });
}

/** The ids of the enemies each lob event of `events` lands on, by its rounded landing point. */
function landedOn(ctx: RunContext, events: readonly SimEvent[]): number[] {
  return eventsOf([events], 'lob').map((lob) => {
    const at = ctx.enemies.find(
      (e) => Math.round(e.x) === Math.round(lob.x) && Math.round(e.y) === Math.round(lob.y),
    );
    return at === undefined ? -1 : at.id;
  });
}

/** Idle triggers (never firing here) with a repeat now and a charge for the next firing. */
const IDLE_REPEAT: TriggerSpec = {
  on: 'periodic',
  every: 1000,
  do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }],
};
const IDLE_CHARGE: TriggerSpec = {
  on: 'periodic',
  every: 1000,
  do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.25, timing: 'nextAttack' }],
};

/** The index of the build's n-th repeatAttack effect. */
function repeatEffectOf(ctx: RunContext, n = 0): number {
  const found = ctx.build.effects.flatMap((fx, i) => (fx.kind === 'repeatAttack' ? [i] : []));
  const effect = found[n];
  if (effect === undefined) throw new Error(`no repeatAttack effect ${n}`);
  return effect;
}

/** The repeat payload of the build's n-th repeatAttack effect (RunContext.sys.repeat). */
const repeatPayloadOf = (ctx: RunContext, n = 0): Payload =>
  ctx.sys.repeat.payloads[repeatEffectOf(ctx, n)] as Payload;

/** Runs the build's n-th repeatAttack effect at `depth` from trigger `origin`. */
function runRepeatEffect(ctx: RunContext, n = 0, depth = 1, origin = 9): void {
  const entry = createEffectEntry();
  entry.effect = repeatEffectOf(ctx, n);
  entry.depth = depth;
  entry.origin = origin;
  entry.flags = SIGNATURE | HIT_EVENT;
  runEffect(ctx, entry);
}

describe('遠投 (farThrow; C10, Q3 (B))', () => {
  /** SALVO, then two far enemies inside the arena (7: 966 away, 8: 888) and one outside it. */
  const FAR_FIELD: readonly PlacedEnemy[] = [
    ...SALVO,
    { x: 100, y: 100 },
    { x: 200, y: 1000 },
    { x: -50, y: 540 },
  ];
  const N = LOB_NORMAL;
  const F = LOB_FAR;

  it('counts the shot a bomb will be: every Nth, none at 0', () => {
    const lob = { farThrowEvery: 4, volcano: null, chainBlast: null, zone: { slow: 0 } };
    expect([1, 2, 3, 4, 5, 8, 12].map((s) => isFar(lob, s))).toEqual([
      false,
      false,
      false,
      true,
      false,
      true,
      true,
    ]);
    expect(isFar({ ...lob, farThrowEvery: 0 }, 4)).toBe(false);
  });

  it('throws counted bombs 4, 8 and 12 far, one bomb a firing (C10)', () => {
    const ctx = bombs(FAR_FIELD, { rules: [FAR_THROW()] });
    const before = rngPositions(ctx);
    const events: SimEvent[] = [];
    const forms = Array.from({ length: 12 }, () => {
      ctx.events.length = 0;
      fire(ctx);
      events.push(...ctx.events);
      return eventsOf([ctx.events], 'lob').map((lob) => lob.form);
    });
    expect(forms).toEqual([[N], [N], [N], [F], [N], [N], [N], [F], [N], [N], [N], [F]]);
    // At the densest enemy, 2, or the farthest inside the arena, 7; never 9, outside it.
    expect(landedOn(ctx, events)).toEqual([2, 2, 2, 7, 2, 2, 2, 7, 2, 2, 2, 7]);
    expect([lobOf(ctx).attacks, lobOf(ctx).shots]).toEqual([12, 12]);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('throws the second bombs of firings 2, 4 and 6 far at projectileCount 3, one bomb’s rhythm at 2', () => {
    const two = bombs(FAR_FIELD, { values: { projectileCount: 3 }, rules: [FAR_THROW()] });
    expect(formsByFiring(two, 6)).toEqual([
      [N, N],
      [N, F],
      [N, N],
      [N, F],
      [N, N],
      [N, F],
    ]);
    const one = bombs(FAR_FIELD, { values: { projectileCount: 2 }, rules: [FAR_THROW()] });
    expect(formsByFiring(one, 8)).toEqual([[N], [N], [N], [F], [N], [N], [N], [F]]);
  });

  it('aims two far bombs of one firing at the farthest and the second farthest (projectileCount 9)', () => {
    const ctx = bombs(FAR_FIELD, { values: { projectileCount: 9 }, rules: [FAR_THROW()] });
    fire(ctx);
    // Eight bombs: dense at SALVO's 2, 4 and 1, far at 7, dense at 3, 5 and 6, far at 8.
    expect(eventsOf([ctx.events], 'lob').map((lob) => lob.form)).toEqual([N, N, N, F, N, N, N, F]);
    expect(landedOn(ctx, ctx.events)).toEqual([2, 4, 1, 7, 3, 5, 6, 8]);
    expect([lobOf(ctx).attacks, lobOf(ctx).shots]).toEqual([1, 8]);
  });

  it('skips the enemies this firing aimed at already, dense bombs’ included', () => {
    // A dense block of the three farthest enemies; 4 stands nearer, alone.
    const ctx = bombs(
      [
        { x: 100, y: 100 },
        { x: 130, y: 100 },
        { x: 100, y: 130 },
        { x: 1500, y: 540 },
      ],
      { values: { projectileCount: 5 }, rules: [FAR_THROW()] },
    );
    fire(ctx);
    expect(eventsOf([ctx.events], 'lob').map((lob) => lob.form)).toEqual([N, N, N, F]);
    expect(landedOn(ctx, ctx.events)).toEqual([1, 2, 3, 4]);
  });

  /**
   * One dense block: a trio, 1, 2 and 3, each with 3 enemies within 60, and a pair 150 to the
   * right, 4 and 5, each with 2. 1 is the farthest from the player and the first of the densest;
   * only 4 and 5 stand 2 radii from it.
   */
  const TRIO_PAIR: readonly PlacedEnemy[] = [
    { x: 100, y: 100 },
    { x: 130, y: 100 },
    { x: 100, y: 130 },
    { x: 250, y: 100 },
    { x: 280, y: 100 },
  ];

  it('keeps the dense bombs 2 radii from a far bomb’s enemy, as from any aimed enemy (D10)', () => {
    // 4 is the best candidate 2 radii from 1. Every 3rd at 2 bombs a firing: the second
    // firing's first bomb is far.
    const ctx = bombs(TRIO_PAIR, { values: { projectileCount: 3 }, rules: [FAR_THROW(3)] });
    fire(ctx);
    expect(landedOn(ctx, ctx.events)).toEqual([1, 4]);
    ctx.events.length = 0;
    fire(ctx);
    expect(eventsOf([ctx.events], 'lob').map((lob) => lob.form)).toEqual([F, N]);
    expect(landedOn(ctx, ctx.events)).toEqual([1, 4]);
  });

  it('lets a dense bomb aim at the far bomb’s enemy again once none 2 radii apart is left (Q3/F15)', () => {
    // Three bombs a firing, every 4th far. Firing 1 is dense: 1, then 4, then (none 2 radii
    // from both) the best not aimed at, 2. Firing 2's first bomb is far, at 1, which is not
    // marked aimed: its second goes to 4 as before, and its third to the best candidate no
    // dense bomb aimed at, 1 again, not 2.
    const ctx = bombs(TRIO_PAIR, { values: { projectileCount: 4 }, rules: [FAR_THROW()] });
    fire(ctx);
    expect(eventsOf([ctx.events], 'lob').map((lob) => lob.form)).toEqual([N, N, N]);
    expect(landedOn(ctx, ctx.events)).toEqual([1, 4, 2]);
    ctx.events.length = 0;
    fire(ctx);
    expect(eventsOf([ctx.events], 'lob').map((lob) => lob.form)).toEqual([F, N, N]);
    expect(landedOn(ctx, ctx.events)).toEqual([1, 4, 1]);
    expect([lobOf(ctx).attacks, lobOf(ctx).shots]).toEqual([2, 6]);
  });

  it('lets a dense bomb aim again at the enemy of a far bomb thrown after the dense scan (Q3/F15)', () => {
    // A trio within one radius of each other, 1 the farthest from the player, then 2. Three
    // bombs a firing, every 2nd far: dense at 1, far at 2 (1 aimed at already), then, none 2
    // radii from both, dense at the best candidate no dense bomb aimed at: 2 again, not 3.
    const ctx = bombs(
      [
        { x: 100, y: 100 },
        { x: 110, y: 90 },
        { x: 120, y: 110 },
      ],
      { values: { projectileCount: 4 }, rules: [FAR_THROW(2)] },
    );
    fire(ctx);
    expect(eventsOf([ctx.events], 'lob').map((lob) => lob.form)).toEqual([N, F, N]);
    expect(landedOn(ctx, ctx.events)).toEqual([1, 2, 2]);
    expect([lobOf(ctx).attacks, lobOf(ctx).shots]).toEqual([1, 3]);
  });

  it('aims at the farthest alive enemy inside the arena, edges included, the lower id on ties', () => {
    const ctx = bombs([
      { x: 1460, y: 540 },
      { x: -1, y: 540 },
      { x: 0, y: 540 },
      { x: 960, y: 1081 },
      { x: 1921, y: 540 },
      { x: 960, y: -1 },
      { x: 460, y: 540 },
    ]);
    const em = lobOf(ctx);
    const before = rngPositions(ctx);
    beginAim(ctx, em);
    const order = Array.from({ length: 4 }, () => aimFar(ctx, em)?.id ?? null);
    // 3 at x = 0, 960 away; then 1 and 7, both 500 away, the lower id first; then none.
    expect(order).toEqual([3, 1, 7, null]);
    expect(ctx.sys.lob.picked.slice(0, ctx.sys.lob.picks).map((e) => e.id)).toEqual([3, 1, 7]);
    expect(rngPositions(ctx)).toEqual(before);
    // The dead are skipped; a new firing forgets the picks.
    enemy(ctx, 3).alive = false;
    beginAim(ctx, em);
    expect(aimFar(ctx, em)).toBe(enemy(ctx, 1));
  });

  it('counts an enemy on the arena’s right and bottom edges as inside it', () => {
    const ctx = bombs([
      { x: 1460, y: 540 },
      { x: ARENA_WIDTH, y: 540 },
      { x: 960, y: ARENA_HEIGHT },
    ]);
    const em = lobOf(ctx);
    beginAim(ctx, em);
    // 2, 960 away; then 3, 540; then 1, 500.
    expect(Array.from({ length: 3 }, () => aimFar(ctx, em)?.id ?? null)).toEqual([2, 3, 1]);
  });

  it('leads a far bomb’s enemy as a dense bomb’s', () => {
    const ctx = bombs([{ x: 160, y: 540, speed: 60 }], { rules: [FAR_THROW()] });
    const em = lobOf(ctx);
    beginAim(ctx, em);
    expect(aimFar(ctx, em)).toBe(enemy(ctx, 1));
    // 800 from the player, 24 ticks of 1 closer.
    expect(ctx.sys.lob.x).toBeCloseTo(P.x - 776, 9);
    expect(ctx.sys.lob.y).toBeCloseTo(P.y, 9);
  });

  it('holds a firing whose first bomb is far while no enemy is inside the arena, and loses a later one', () => {
    const outside = bombs([{ x: -40, y: 540 }], { rules: [FAR_THROW()] });
    const em = lobOf(outside);
    em.shots = 3;
    for (let i = 0; i < 50; i++) runLob(outside, em);
    expect([em.attacks, em.shots, outside.shots.count]).toEqual([0, 3, 0]);
    expect(em.acc).toBe(em.interval - em.cadence);
    // One enemy, two bombs, every 2nd far: the far one finds only the enemy aimed at already.
    const lone = bombs([near(0, 0)], { values: { projectileCount: 3 }, rules: [FAR_THROW(2)] });
    fire(lone);
    expect(eventsOf([lone.events], 'lob').map((lob) => lob.form)).toEqual([N]);
    expect([lobOf(lone).attacks, lobOf(lone).shots]).toEqual([1, 1]);
  });

  it('ends a firing at a later far bomb that finds no enemy, though a dense candidate is left (§4.5)', () => {
    // 1 inside the arena; 2 outside it, 140 to its left, in the same dense block and 2 radii
    // from 1. Two bombs a firing, every 2nd far: the first, dense, takes 1 (the lower id of two
    // equal counts); the second, far, finds no enemy in the arena but 1, aimed at already, and
    // is lost: not aimed dense at 2, not thrown, not counted.
    const ctx = bombs(
      [
        { x: 100, y: 540 },
        { x: -40, y: 540 },
      ],
      { values: { projectileCount: 3 }, rules: [FAR_THROW(2)] },
    );
    fire(ctx);
    expect(eventsOf([ctx.events], 'lob').map((lob) => lob.form)).toEqual([N]);
    expect(landedOn(ctx, ctx.events)).toEqual([1]);
    expect([lobOf(ctx).attacks, lobOf(ctx).shots]).toEqual([1, 1]);
  });
});

describe('火山 (volcano; K22, Q3 (B))', () => {
  /**
   * One dense block: 1, 2 and 3 have three enemies within 180 each, 4 and 5 two. 4 stands 230
   * from 1, 5 exactly 360 (2 × 3 radii).
   */
  const ERUPTION: readonly PlacedEnemy[] = [
    { x: 1170, y: 450 },
    { x: 1190, y: 450 },
    { x: 1210, y: 450 },
    { x: 1400, y: 450 },
    { x: 1530, y: 450 },
  ];

  it('fires every 180 ticks at the base attack speed, faster with attack speed, whatever projectileCount', () => {
    expect(lobOf(bombs([], { rules: [VOLCANO] })).interval).toBe(180);
    expect(lobOf(bombs([], { rules: [VOLCANO], values: { attackSpeed: 6 } })).interval).toBe(120);
    expect(lobOf(bombs([], { rules: [VOLCANO], values: { attackSpeed: 8 } })).interval).toBe(90);
    expect(lobOf(bombs([], { rules: [VOLCANO], values: { projectileCount: 5 } })).interval).toBe(
      180,
    );
    const slow: RuleSpec = { id: 'volcano', periodSec: 2, radiusMult: 3, damageMult: 5 };
    expect(lobOf(bombs([], { rules: [slow] })).interval).toBe(120);
    const ctx = bombs([near(0, 0)], { rules: [VOLCANO] });
    const em = lobOf(ctx);
    const ticks: number[] = [];
    for (let tick = 1; tick <= 400; tick++) {
      const before = em.attacks;
      runLob(ctx, em);
      if (em.attacks > before) ticks.push(tick);
    }
    expect(ticks).toEqual([180, 360]);
  });

  it('throws two giant bombs a period at projectileCount 3, aimed 2 × 3 radii apart', () => {
    const ctx = bombs(ERUPTION, { values: { projectileCount: 3 }, rules: [VOLCANO] });
    const em = lobOf(ctx);
    beginAim(ctx, em);
    expect([ctx.sys.lob.radiusSq, ctx.sys.lob.sepSq]).toEqual([180 * 180, 360 * 360]);
    fire(ctx);
    expect(eventsOf([ctx.events], 'lob').map((lob) => lob.form)).toEqual([
      LOB_VOLCANO,
      LOB_VOLCANO,
    ]);
    expect(landedOn(ctx, ctx.events)).toEqual([1, 5]);
    expect(Array.from(ctx.shots.scale.subarray(0, 2))).toEqual([5, 5]);
    // Normal bombs, 2 radii of 60 apart, take 4.
    const normal = bombs(ERUPTION, { values: { projectileCount: 3 } });
    fire(normal);
    expect(landedOn(normal, normal.events)).toEqual([1, 4]);
    expect(Array.from(normal.shots.scale.subarray(0, 2))).toEqual([1, 1]);
  });

  it('explodes 3× as wide at 5× the damage, its chain and 火地 unscaled but 火地 3× as wide', () => {
    const run = (form: number) => {
      const spy = watch();
      // 1 and 2 are in either blast, 3 only in the giant one, which chains to 4 instead.
      const ctx = bombs([near(0, 0), near(20, 0), near(150, 0), near(220, 0)], {
        values: { chainCount: 1 },
        rules: [VOLCANO],
        modules: [spy.module],
      });
      launchAt(ctx, L, 0, -1, form);
      const landAt = landAll(ctx);
      const landed = [...ctx.events];
      const hits = eventsOf([landed], 'hit');
      const pulses = eventsOf([zoneTicks(ctx, landAt, landAt + 30)], 'pulse');
      return {
        explosion: eventsOf([landed], 'explosion')[0],
        zone: eventsOf([landed], 'zone')[0],
        explode: spy.centers.find((seen) => seen.event === EVENT.explode),
        hits: hits.map((hit) => [hit.targetId, hit.chainIndex, toNumber(hit.amount)]),
        pulse: pulses.map((pulse) => toNumber(pulse.total) / pulse.hits),
        pulseHits: pulses.map((pulse) => pulse.hits),
      };
    };
    const normal = run(LOB_NORMAL);
    const giant = run(LOB_VOLCANO);
    expect(normal.explosion).toMatchObject({ radius: 60, primaryId: 1, count: 2 });
    expect(giant.explosion).toMatchObject({ radius: 180, primaryId: 1, count: 3 });
    expect([normal.zone?.radius, giant.zone?.radius]).toEqual([60, 180]);
    expect([normal.explode?.radius, giant.explode?.radius]).toEqual([60, 180]);
    const [hit] = normal.hits;
    const amount = hit?.[2] as number;
    expect(normal.hits).toEqual([
      [1, 0, amount],
      [2, 0, amount],
      [3, 1, normal.hits[2]?.[2]],
    ]);
    const jump = normal.hits[2]?.[2] as number;
    expect(giant.hits).toEqual([
      [1, 0, amount * 5],
      [2, 0, amount * 5],
      [3, 0, amount * 5],
      [4, 1, jump],
    ]);
    // Two pulses: the giant 火地 hits 1, 2 and 3, each at the normal one's damage.
    expect(normal.pulseHits).toEqual([2, 2]);
    expect(giant.pulseHits).toEqual([3, 3]);
    expect(giant.pulse).toEqual(normal.pulse);
  });

  it('aims every 4th bomb far under 遠投, a giant bomb as well', () => {
    const ctx = bombs([...ERUPTION, { x: 100, y: 100 }], {
      values: { projectileCount: 3 },
      rules: [VOLCANO, FAR_THROW()],
    });
    const events: SimEvent[] = [];
    for (let f = 0; f < 2; f++) {
      ctx.events.length = 0;
      fire(ctx);
      events.push(...ctx.events);
    }
    expect(eventsOf([events], 'lob').map((lob) => lob.form)).toEqual([
      LOB_VOLCANO,
      LOB_VOLCANO,
      LOB_VOLCANO,
      LOB_VOLCANO,
    ]);
    expect(landedOn(ctx, events)).toEqual([1, 5, 1, 6]);
    expect(Array.from(ctx.shots.scale.subarray(0, 4))).toEqual([5, 5, 5, 5]);
  });
});

describe('連環爆 (chainBlast; C12, R25)', () => {
  /** The chainBlast trigger of `ctx`'s build and its effect. */
  const blastOf = (ctx: RunContext): { trigger: number; effect: number } => {
    const chainBlast = ctx.build.signature.lob?.chainBlast;
    if (chainBlast === undefined || chainBlast === null) throw new Error('no chainBlast');
    return { trigger: chainBlast.trigger, effect: chainBlast.effect };
  };

  /** [effect, depth, origin, target id or −1, x, y, flags] of each queued entry, dequeued. */
  function drain(ctx: RunContext): number[][] {
    const entry = createEffectEntry();
    const seen: number[][] = [];
    while (ctx.effectQueue.size > 0) {
      dequeue(ctx.effectQueue, entry);
      seen.push([
        entry.effect,
        entry.depth,
        entry.origin,
        entry.target === null ? -1 : entry.target.id,
        entry.x,
        entry.y,
        entry.flags,
      ]);
    }
    return seen;
  }

  it('queues an explosion at each of the first 2 enemies its explosion kills, in hit order', () => {
    const ctx = bombs(
      [
        near(0, 0, { hp: 1 }),
        near(10, 0, { hp: 1 }),
        near(20, 0, { hp: 1 }),
        near(-10, 0, { hp: 1 }),
      ],
      { rules: [CHAIN_BLAST()] },
    );
    const { trigger, effect } = blastOf(ctx);
    const event = ctx.sys.lob.event;
    bombAt(ctx);
    expect(ctx.enemies.every((e) => !e.alive)).toBe(true);
    expect(drain(ctx)).toEqual([
      [effect, 1, trigger, -1, L.x, L.y, 0],
      [effect, 1, trigger, -1, L.x + 10, L.y, 0],
    ]);
    // One event object, rewritten per kill.
    expect(ctx.sys.lob.event).toBe(event);
    expect(event).toEqual({ target: null, x: L.x + 10, y: L.y, depth: 0, origin: -1, flags: 0 });
  });

  it('queues each explosion right after its victim’s hit, before the next hit’s effects (§4.6)', () => {
    // A hit trigger's explode beside 連環爆; the bomb hits and kills 1, then 2.
    const ctx = bombs([near(0, 0, { hp: 1 }), near(10, 0, { hp: 1 })], {
      triggers: [{ on: 'hit', do: [{ kind: 'explode', radius: 120, damagePct: 1 }] }],
      rules: [CHAIN_BLAST()],
    });
    const { effect } = blastOf(ctx);
    bombAt(ctx);
    expect(drain(ctx).map((seen) => [seen[0] === effect ? 'blast' : 'hit', seen[4]])).toEqual([
      ['hit', L.x],
      ['blast', L.x],
      ['hit', L.x + 10],
      ['blast', L.x + 10],
    ]);
  });

  it('queues up to perBomb of them a bomb', () => {
    const placed = [near(0, 0, { hp: 1 }), near(10, 0, { hp: 1 }), near(20, 0, { hp: 1 })];
    const counted = (perBomb: number): number => {
      const ctx = bombs(placed, { rules: [CHAIN_BLAST(perBomb)] });
      bombAt(ctx);
      return drain(ctx).length;
    };
    expect([counted(1), counted(2), counted(3), counted(5)]).toEqual([1, 2, 3, 3]);
  });

  it('queues up to 4 for a firing of 2 bombs, 2 a bomb (projectileCount 3)', () => {
    // Two groups of three 150 apart in one dense block.
    const ctx = bombs(
      [1300, 1310, 1320, 1450, 1460, 1470].map((x) => ({ x, y: 500, hp: 1 })),
      { values: { projectileCount: 3 }, rules: [CHAIN_BLAST()] },
    );
    fire(ctx);
    expect(landedOn(ctx, ctx.events)).toEqual([1, 4]);
    landAll(ctx);
    expect(ctx.enemies.every((e) => !e.alive)).toBe(true);
    expect(drain(ctx).map((seen) => [seen[4], seen[5]])).toEqual([
      [1300, 500],
      [1310, 500],
      [1450, 500],
      [1460, 500],
    ]);
  });

  it('counts only its explosion’s kills: not its chain’s, nor enemies dead before it lands', () => {
    // 1 survives as the primary; 2 dies in the explosion, 3 to the chain; 4 is dead already.
    const ctx = bombs(
      [near(0, 0), near(30, 0, { hp: 1 }), near(150, 0, { hp: 1 }), near(-20, 0, { hp: 1 })],
      { values: { chainCount: 1 }, rules: [CHAIN_BLAST()] },
    );
    enemy(ctx, 4).alive = false;
    bombAt(ctx);
    expect([2, 3].map((id) => enemy(ctx, id).alive)).toEqual([false, false]);
    expect(drain(ctx).map((seen) => seen[4])).toEqual([L.x + 30]);
  });

  it('explodes at 40 for 50% of the damage, hit, trigger and area, and raises no explode', () => {
    const spy = watch();
    // The bomb kills 1; its explosion kills 2, 35 from it and out of the bomb's reach, whose
    // death queues nothing more.
    const ctx = bombs([near(50, 0, { hp: 1 }), near(85, 0, { hp: 1 }), near(0, 200)], {
      values: { damage: 10 },
      rules: [CHAIN_BLAST()],
      modules: [spy.module],
    });
    bombAt(ctx);
    expect(ctx.effectQueue.size).toBe(1);
    ctx.events.length = 0;
    runEffectQueue(ctx);
    expect(enemy(ctx, 2).alive).toBe(false);
    expect(ctx.effectQueue.size).toBe(0);
    expect(eventsOf([ctx.events], 'burst')).toEqual([
      { type: 'burst', kind: 'explode', x: L.x + 50, y: L.y, radius: 40 },
    ]);
    const hits = eventsOf([ctx.events], 'hit');
    expect(hits.map((hit) => [hit.targetId, hit.tags, toNumber(hit.amount)])).toEqual([
      [2, TAG.hit | TAG.trigger | TAG.area, 5],
    ]);
    expect(spy.centers.filter((seen) => seen.event === EVENT.explode)).toHaveLength(1);
  });

  it('queues at the bomb’s depth + 1 from its own trigger, not on its own damage, and counts the depth cap', () => {
    /**
     * The depths of the entries a bomb launched at `depth` from `origin` (the form's own
     * trigger for 'own') queues, all from the form's trigger, and the depth-capped count.
     */
    const queued = (depth: number, origin: number | 'own') => {
      const ctx = bombs([near(0, 0, { hp: 1 })], { rules: [CHAIN_BLAST()] });
      const { trigger } = blastOf(ctx);
      launchAt(ctx, L, depth, origin === 'own' ? trigger : origin);
      landAll(ctx);
      const entries = drain(ctx);
      expect(entries.every((entry) => entry[2] === trigger)).toBe(true);
      return { depths: entries.map((entry) => entry[1]), capped: ctx.counters.triggerDepthCapped };
    };
    expect(queued(0, -1)).toEqual({ depths: [1], capped: 0 });
    expect(queued(2, SHATTER_TRIGGER)).toEqual({ depths: [3], capped: 0 });
    // Rule 3: not on its own explosion's damage.
    expect(queued(1, 'own')).toEqual({ depths: [], capped: 0 });
    expect(queued(MAX_DEPTH, -1)).toEqual({ depths: [], capped: 1 });
  });

  it('queues none for a repeat’s bomb (REPEAT)', () => {
    const ctx = bombs([near(0, 0, { hp: 1 }), near(10, 0, { hp: 1 })], {
      rules: [CHAIN_BLAST()],
    });
    const p = lobOf(ctx).payload;
    launchAt(ctx, L, 0, -1, LOB_NORMAL, { ...p, flags: p.flags | REPEAT });
    landAll(ctx);
    expect(ctx.enemies.every((e) => !e.alive)).toBe(true);
    expect(ctx.effectQueue.size).toBe(0);
  });

  it('queues none for real repeat bombs, thrown now or right after a firing (C4.9)', () => {
    const placed = [near(0, 0, { hp: 1 }), near(10, 0, { hp: 1 }), near(-10, 0, { hp: 1 })];
    const options: BombOptions = {
      rules: [CHAIN_BLAST()],
      triggers: [IDLE_REPEAT, IDLE_CHARGE],
    };
    const now = bombs(placed, options);
    fireLobRepeat(now, lobOf(now), repeatPayloadOf(now), 1, 9);
    expect(now.shots.count).toBe(1);
    landAll(now);
    expect(now.enemies.every((e) => !e.alive)).toBe(true);
    expect(now.effectQueue.size).toBe(0);
    // A counted bomb of the same build queues its 2; a charge drained after it, none more.
    const counted = bombs(placed, options);
    runRepeatEffect(counted, 1);
    fire(counted);
    expect(counted.shots.count).toBe(2);
    expect(counted.shots.payload[1]).toBe(repeatPayloadOf(counted, 1));
    landAll(counted);
    expect(counted.enemies.every((e) => !e.alive)).toBe(true);
    expect(counted.effectQueue.size).toBe(2);
  });
});

describe('lob repeats (fireLobRepeat; C4.9, Q3 (B), Q5 (A))', () => {
  /** bombs with IDLE_REPEAT (50%) and IDLE_CHARGE (25%) besides `options.triggers`. */
  const repeating = (placed: readonly PlacedEnemy[], options: BombOptions = {}): RunContext =>
    bombs(placed, {
      ...options,
      triggers: [IDLE_REPEAT, IDLE_CHARGE, ...(options.triggers ?? [])],
    });
  /** A repeat of 50% thrown now, its hits at `depth` from trigger `origin`. */
  const throwRepeat = (ctx: RunContext, depth = 1, origin = 9): void =>
    fireLobRepeat(ctx, lobOf(ctx), repeatPayloadOf(ctx), depth, origin);
  const formsOf = (ctx: RunContext): number[] =>
    eventsOf([ctx.events], 'lob').map((lob) => lob.form);
  const lobCounts = (em: EmitterRuntime) => ({
    attacks: em.attacks,
    shots: em.shots,
    volley: em.volley,
    acc: em.acc,
    interval: em.interval,
  });
  const ignitesOf = (events: readonly SimEvent[]): number[] =>
    eventsOf([events], 'ignite').map((ignite) => ignite.targetId);

  it('gives each repeat payload a 火地 of its own: the signature’s at its share, effects stream, always igniting, flagged REPEAT (C11, Q4/F1, Q5/F1)', () => {
    const ctx = repeating([]);
    const sig = lobOf(ctx).payload;
    const sigZone = sig.zoneVariant as Payload;
    for (const [n, share] of [
      [0, 0.5],
      [1, 0.25],
    ] as const) {
      const p = repeatPayloadOf(ctx, n);
      expect([p.flags, p.rng, p.rows, p.tags]).toEqual([
        SIGNATURE | REPEAT,
        ctx.effectsRng,
        sig.rows,
        sig.tags,
      ]);
      expect(toNumber(p.baseDamage)).toBe(toNumber(sig.baseDamage) * share);
      const zone = p.zoneVariant as Payload;
      expect(zone).not.toBe(sigZone);
      expect(zone).toMatchObject({
        tags: sigZone.tags,
        source: sigZone.source,
        jumpSource: sigZone.jumpSource,
        flags: ALWAYS_IGNITES | REPEAT,
        chains: false,
        rollsAilments: true,
        canCrit: sigZone.canCrit,
        damageMode: sigZone.damageMode,
        zoneVariant: null,
        aggregate: true,
      });
      expect(zone.rng).toBe(ctx.effectsRng);
      expect(zone.rows).toBe(sigZone.rows);
      expect(toNumber(zone.baseDamage)).toBe(toNumber(sigZone.baseDamage) * share);
    }
  });

  it('throws 2 bombs at projectileCount 3, aimed as a firing’s, never steady, counting no shot or attack', () => {
    const values = { projectileCount: 3 };
    const counted = repeating(SALVO, { values });
    fire(counted);
    const firing = landedOn(counted, counted.events);
    expect(firing).toEqual([2, 4]);
    // Every counted bomb would be steady.
    const steadyAim: RuleSpec = {
      id: 'steadyAim',
      everyNth: 1,
      critMultiplierMore: 0,
      counts: 'shot',
    };
    const ctx = repeating(SALVO, { values, rules: [steadyAim] });
    const em = lobOf(ctx);
    const before = lobCounts(em);
    ctx.events.length = 0;
    throwRepeat(ctx, 2, 9);
    expect(landedOn(ctx, ctx.events)).toEqual(firing);
    expect(formsOf(ctx)).toEqual([LOB_NORMAL, LOB_NORMAL]);
    const shots = ctx.shots;
    const p = repeatPayloadOf(ctx);
    expect(
      [0, 1].map((s) => [shots.payload[s] === p, shots.steady[s], shots.depth[s], shots.origin[s]]),
    ).toEqual([
      [true, 0, 2, 9],
      [true, 0, 2, 9],
    ]);
    expect(Array.from(shots.scale.subarray(0, 2))).toEqual([1, 1]);
    expect(lobCounts(em)).toEqual(before);
    fire(ctx);
    expect(Array.from(shots.steady.subarray(2, 4))).toEqual([1, 1]);
  });

  it('is what repeatAttack throws now for the lob: count repeats of its bombs, no volley (REPEAT_STEPS)', () => {
    const twice: TriggerSpec = {
      on: 'periodic',
      every: 1000,
      do: [{ kind: 'repeatAttack', count: 2, damagePct: 0.5 }],
    };
    const ctx = repeating(SALVO, { values: { projectileCount: 3 }, triggers: [twice] });
    const em = lobOf(ctx);
    const before = lobCounts(em);
    ctx.events.length = 0;
    runRepeatEffect(ctx, 2, 3, 5);
    expect(ctx.projectiles).toEqual([]);
    expect(formsOf(ctx)).toEqual([LOB_NORMAL, LOB_NORMAL, LOB_NORMAL, LOB_NORMAL]);
    expect(landedOn(ctx, ctx.events)).toEqual([2, 4, 2, 4]);
    const shots = ctx.shots;
    const p = repeatPayloadOf(ctx, 2);
    expect(
      [0, 1, 2, 3].map((s) => [shots.payload[s] === p, shots.depth[s], shots.origin[s]]),
    ).toEqual(Array.from({ length: 4 }, () => [true, 3, 5]));
    expect(lobCounts(em)).toEqual(before);
  });

  it('aims afresh right after a firing: a drained charge throws at the firing’s enemies again', () => {
    const ctx = repeating(SALVO, { values: { projectileCount: 3 } });
    runRepeatEffect(ctx, 1, 2, 7);
    expect(ctx.sys.repeat.charges.count).toBe(1);
    ctx.events.length = 0;
    fire(ctx);
    expect(landedOn(ctx, ctx.events)).toEqual([2, 4, 2, 4]);
    const shots = ctx.shots;
    const sig = lobOf(ctx).payload;
    const charge = repeatPayloadOf(ctx, 1);
    expect(
      [0, 1, 2, 3].map((s) => [shots.payload[s] === sig, shots.depth[s], shots.origin[s]]),
    ).toEqual([
      [true, 0, -1],
      [true, 0, -1],
      [false, 2, 7],
      [false, 2, 7],
    ]);
    expect([shots.payload[2], shots.payload[3]]).toEqual([charge, charge]);
    expect(lobCounts(lobOf(ctx))).toMatchObject({ attacks: 1, shots: 2 });
    expect(ctx.sys.repeat.charges.count).toBe(0);
  });

  it('draws its count on the effects stream at projectileCount 2.5, after its first aim; nothing on combat', () => {
    const ctx = repeating(SALVO, { values: { projectileCount: 2.5 } });
    expect(ctx.projectileCount).toBe(1.5);
    const twin = createStreams(1).effects;
    sync(twin, ctx.effectsRng);
    const combat = ctx.combatRng.snapshot();
    const thrown: number[] = [];
    for (let r = 0; r < 12; r++) {
      ctx.events.length = 0;
      throwRepeat(ctx);
      const n = formsOf(ctx).length;
      expect(n).toBe(twin.next() < 0.5 ? 2 : 1);
      expect(ctx.effectsRng.snapshot()).toEqual(twin.snapshot());
      thrown.push(n);
    }
    expect(new Set(thrown)).toEqual(new Set([1, 2]));
    expect(ctx.combatRng.snapshot()).toEqual(combat);
    // No candidate: no bomb, and the roll is not drawn.
    const empty = repeating([], { values: { projectileCount: 2.5 } });
    const before = rngPositions(empty);
    throwRepeat(empty);
    expect([empty.shots.count, empty.events.length]).toEqual([0, 0]);
    expect(rngPositions(empty)).toEqual(before);
  });

  it('never throws far under 遠投, and leaves its count to the counted bombs (K8)', () => {
    const ctx = repeating([...SALVO, { x: 100, y: 100 }], {
      values: { projectileCount: 3 },
      rules: [FAR_THROW(2)],
    });
    const em = lobOf(ctx);
    // The next counted bomb is the 2nd: far.
    em.shots = 1;
    ctx.events.length = 0;
    throwRepeat(ctx);
    expect(formsOf(ctx)).toEqual([LOB_NORMAL, LOB_NORMAL]);
    expect(landedOn(ctx, ctx.events)).toEqual([2, 4]);
    expect(em.shots).toBe(1);
    ctx.events.length = 0;
    fire(ctx);
    expect(formsOf(ctx)).toEqual([LOB_FAR, LOB_NORMAL]);
    expect(landedOn(ctx, ctx.events)[0]).toBe(7);
  });

  it('throws giant bombs under 火山 at the repeat’s share, the period left alone (F12)', () => {
    const run = (repeated: boolean) => {
      const ctx = repeating([near(0, 0), near(20, 0), near(150, 0)], { rules: [VOLCANO] });
      ctx.events.length = 0;
      if (repeated) throwRepeat(ctx);
      else launchAt(ctx, L, 0, -1, LOB_VOLCANO);
      const forms = formsOf(ctx);
      const scale = ctx.shots.scale[0];
      landAll(ctx);
      return {
        ctx,
        forms,
        scale,
        explosion: eventsOf([ctx.events], 'explosion')[0],
        hits: eventsOf([ctx.events], 'hit').map((hit) => [hit.targetId, toNumber(hit.amount)]),
      };
    };
    const giant = run(false);
    const repeat = run(true);
    expect([repeat.forms, repeat.scale]).toEqual([[LOB_VOLCANO], 5]);
    expect(repeat.explosion).toMatchObject({ radius: 180, primaryId: 1, count: 3 });
    expect(repeat.hits.map(([id]) => id)).toEqual([1, 2, 3]);
    repeat.hits.forEach(([, amount], i) =>
      expect(amount).toBeCloseTo((giant.hits[i]?.[1] as number) * 0.5, 9),
    );
    // The period: firings on ticks 180 and 360, a repeat thrown on tick 50 or not.
    const ctx = repeating([near(0, 0)], { rules: [VOLCANO] });
    const em = lobOf(ctx);
    const ticks: number[] = [];
    for (let tick = 1; tick <= 400; tick++) {
      if (tick === 50) {
        const before = lobCounts(em);
        throwRepeat(ctx);
        expect(lobCounts(em)).toEqual(before);
      }
      const attacks = em.attacks;
      runLob(ctx, em);
      if (em.attacks > attacks) ticks.push(tick);
    }
    expect(ticks).toEqual([180, 360]);
    expect(em.interval).toBe(180);
  });

  it('raises no explode at its landing, and leaves the repeat’s fire zone, at its share (C11)', () => {
    const run = (repeated: boolean) => {
      const spy = watch();
      const ctx = repeating([near(0, 0), near(20, 0)], {
        values: { burnMaxStacks: 50 },
        triggers: [{ on: 'explode', do: [{ kind: 'heal', lifePct: 0.1 }] }],
        modules: [spy.module],
      });
      const p = repeated ? repeatPayloadOf(ctx) : lobOf(ctx).payload;
      launchAt(ctx, L, 1, 9, LOB_NORMAL, p);
      const landAt = landAll(ctx);
      const landed = [...ctx.events];
      const zones = ctx.sys.zones;
      const zonePayload = zones.payload[zones.record[0] as number];
      const pulses = eventsOf([zoneTicks(ctx, landAt, landAt + 120)], 'pulse');
      const burns = (id: number) =>
        enemy(ctx, id)
          .burns.filter((b) => b.start > landAt)
          .map((b) => toNumber(b.dps));
      return { ctx, p, spy, landed, landAt, zonePayload, pulses, burns: [burns(1), burns(2)] };
    };
    const normal = run(false);
    const repeat = run(true);
    expect(normal.spy.centers.filter((c) => c.event === EVENT.explode)).toHaveLength(1);
    expect(normal.ctx.effectQueue.size).toBe(1);
    expect(repeat.spy.centers).toEqual([]);
    expect(repeat.ctx.effectQueue.size).toBe(0);
    // Its own fire zone, a signature zone at the repeat's depth and origin.
    expect(eventsOf([repeat.landed], 'zone')).toMatchObject([{ signature: true, radius: 60 }]);
    expect(repeat.zonePayload).toBe(repeat.p.zoneVariant);
    const zones = repeat.ctx.sys.zones;
    expect([zones.depth[0], zones.origin[0]]).toEqual([1, 9]);
    expect(repeat.pulses.map((pulse) => pulse.hits)).toEqual(normal.pulses.map((p) => p.hits));
    expect(repeat.pulses).toHaveLength(6);
    repeat.pulses.forEach((pulse, i) =>
      expect(toNumber(pulse.total)).toBeCloseTo(toNumber(normal.pulses[i]?.total ?? ZERO) * 0.5, 9),
    );
    // Q4 (B): its pulse hits' burns, computed from the hit's base, at the repeat's share.
    expect(repeat.burns[0]?.length).toBeGreaterThan(0);
    for (const id of [0, 1]) {
      expect(repeat.burns[id]).toHaveLength((normal.burns[id] as number[]).length);
      repeat.burns[id]?.forEach((dps, i) =>
        expect(dps).toBeCloseTo((normal.burns[id]?.[i] as number) * 0.5, 9),
      );
    }
  });

  it('ignites on every hit of its fire zone at igniteChance 0 (ALWAYS_IGNITES, Q4/F1)', () => {
    const ctx = repeating([near(0, 0), near(20, 0)], { values: { burnMaxStacks: 50 } });
    launchAt(ctx, L, 1, 9, LOB_NORMAL, repeatPayloadOf(ctx));
    const landAt = landAll(ctx);
    const before = rngPositions(ctx);
    const events = zoneTicks(ctx, landAt, landAt + 120);
    expect(eventsOf([events], 'pulse').map((pulse) => pulse.hits)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(ignitesOf(events)).toEqual([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('rolls its fire zone’s crits and ignites on the effects stream, the combat stream untouched (Q4 (B))', () => {
    const values = { critChance: 0.5, igniteChance: 0.5, burnMaxStacks: 50 };
    const ctx = repeating([near(0, 0), near(20, 0), near(-20, 0)], { values });
    launchAt(ctx, L, 1, 9, LOB_NORMAL, repeatPayloadOf(ctx));
    const landAt = landAll(ctx);
    const twin = createStreams(1).effects;
    sync(twin, ctx.effectsRng);
    const combat = ctx.combatRng.snapshot();
    let hits = 0;
    for (let tick = landAt + 1; tick <= landAt + 120; tick++) {
      const events = zoneTicks(ctx, tick - 1, tick);
      const pulses = eventsOf([events], 'pulse');
      const crits: number[] = [];
      for (const pulse of pulses) {
        expect(pulse.hits).toBe(3);
        for (const id of [1, 2, 3]) {
          if (twin.next() < 0.5) crits.push(id);
          // The ignite roll is drawn, and every hit ignites whatever it gives.
          twin.next();
        }
        hits += pulse.hits;
      }
      expect(pulses.flatMap((pulse) => pulse.crits)).toEqual(crits);
      expect(ignitesOf(events)).toEqual(pulses.length === 0 ? [] : [1, 2, 3]);
      expect(ctx.effectsRng.snapshot()).toEqual(twin.snapshot());
    }
    expect(hits).toBe(18);
    expect(ctx.combatRng.snapshot()).toEqual(combat);
  });

  it('repeats nothing on its fire zone’s hits or their kills, where a normal bomb’s 火地 does (REPEAT, Hoshi’s Q5/F1)', () => {
    // Every hit and every kill repeats the attack, signature or not.
    const again: TriggerSpec['do'] = [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }];
    const run = (repeated: boolean) => {
      const ctx = repeating([near(0, 0, { hp: 1e9 }), near(20, 0, { hp: 1e9 })], {
        triggers: [
          { on: 'hit', do: again },
          { on: 'kill', do: again },
        ],
      });
      launchAt(ctx, L, 0, -1, LOB_NORMAL, repeated ? repeatPayloadOf(ctx) : lobOf(ctx).payload);
      const landAt = landAll(ctx);
      // The explosion's entries set aside; enemy 2 dies to the fire zone's first pulse.
      const entry = createEffectEntry();
      while (ctx.effectQueue.size > 0) dequeue(ctx.effectQueue, entry);
      enemy(ctx, 2).hp = num(1e-9);
      const pulses = eventsOf([zoneTicks(ctx, landAt, landAt + 120)], 'pulse');
      dispatchPendingKills(ctx);
      // Each queued entry's effect, and whether it carries REPEAT.
      const q = ctx.effectQueue;
      const queued = Array.from({ length: q.size }, (_, n) => {
        const at = (q.head + n) & q.capMask;
        return [q.effect[at], ((q.flags[at] as number) & REPEAT) !== 0];
      });
      ctx.events.length = 0;
      runEffectQueue(ctx);
      return { ctx, pulses: pulses.map((pulse) => pulse.hits), queued, thrown: formsOf(ctx) };
    };
    const normal = run(false);
    const repeat = run(true);
    const [hit, kill] = [2, 3].map((n) => repeatEffectOf(repeat.ctx, n));
    // 火地's 7 hits fire the hit trigger and its kill the kill trigger, from either bomb.
    expect(repeat.pulses).toEqual([2, 1, 1, 1, 1, 1]);
    expect(normal.pulses).toEqual(repeat.pulses);
    const entries = (flagged: boolean) => [
      ...Array.from({ length: 7 }, () => [hit, flagged]),
      [kill, flagged],
    ];
    // A normal bomb's 火地 repeats on each, a bomb a repeat.
    expect(normal.queued).toEqual(entries(false));
    expect(normal.thrown).toEqual(Array<number>(8).fill(LOB_NORMAL));
    // The repeat bomb's carries REPEAT to its hits and their kill, so they repeat nothing (rule 7).
    expect(repeat.queued).toEqual(entries(true));
    expect(repeat.thrown).toEqual([]);
    expect(repeat.ctx.counters.effectsRun).toBe(8);
  });

  it('repeats nothing on the ignites and freezes its explosion and fire zone cause, where a normal bomb’s do (REPEAT, Q5/F1)', () => {
    // Every burn applied and every freeze repeats the attack.
    const again: TriggerSpec['do'] = [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }];
    const run = (repeated: boolean) => {
      const ctx = repeating([near(0, 0, { hp: 1e9 })], {
        values: { burnMaxStacks: 50, frostOnHit: 0.5 },
        triggers: [
          { on: 'ailmentApplied', when: [{ ailment: 'burn' }], do: again },
          { on: 'freeze', do: again },
        ],
      });
      launchAt(ctx, L, 0, -1, LOB_NORMAL, repeated ? repeatPayloadOf(ctx) : lobOf(ctx).payload);
      const landAt = landAll(ctx);
      // Each queued entry's effect, and whether it carries REPEAT.
      const q = ctx.effectQueue;
      const queued = () =>
        Array.from({ length: q.size }, (_, n) => {
          const at = (q.head + n) & q.capMask;
          return [q.effect[at], ((q.flags[at] as number) & REPEAT) !== 0];
        });
      // The explosion ignites (igniteAlways), set aside here; its 0.5 frost freezes nothing yet.
      const landed = queued();
      const entry = createEffectEntry();
      while (q.size > 0) dequeue(q, entry);
      // Each of 火地's pulses ignites (ALWAYS_IGNITES), and the first one's frost freezes.
      const pulses = eventsOf([zoneTicks(ctx, landAt, landAt + 120)], 'pulse');
      const pulsed = queued();
      ctx.events.length = 0;
      runEffectQueue(ctx);
      return { ctx, pulses: pulses.length, landed, pulsed, thrown: formsOf(ctx) };
    };
    const normal = run(false);
    const repeat = run(true);
    const [ignite, freeze] = [2, 3].map((n) => repeatEffectOf(repeat.ctx, n));
    const entries = (flagged: boolean) => ({
      landed: [[ignite, flagged]],
      pulsed: [
        [ignite, flagged],
        [freeze, flagged],
        ...Array.from({ length: 5 }, () => [ignite, flagged]),
      ],
    });
    expect([normal.pulses, repeat.pulses]).toEqual([6, 6]);
    // A normal bomb's ignites and freeze repeat, a bomb each.
    expect({ landed: normal.landed, pulsed: normal.pulsed }).toEqual(entries(false));
    expect(normal.thrown).toEqual(Array<number>(7).fill(LOB_NORMAL));
    // The repeat bomb's carry REPEAT from its payloads, so they repeat nothing (rule 7).
    expect({ landed: repeat.landed, pulsed: repeat.pulsed }).toEqual(entries(true));
    expect(repeat.thrown).toEqual([]);
    expect(repeat.ctx.counters.effectsRun).toBe(7);
  });

  it('is never steady after a steady firing (steadyAim counts attack, an onAttack forceCrit), drained or thrown now', () => {
    const everyFiring: RuleSpec = {
      id: 'steadyAim',
      everyNth: 1,
      critMultiplierMore: 0,
      counts: 'attack',
    };
    const forced: TestModule = (b) =>
      b.hook('onAttack', (_ctx, _em, shot) => {
        shot.forceCrit = true;
      });
    for (const options of [{ rules: [everyFiring] }, { modules: [forced] }] as BombOptions[]) {
      const ctx = repeating(SALVO, { ...options, values: { projectileCount: 3 } });
      runRepeatEffect(ctx, 1, 2, 7);
      fire(ctx);
      throwRepeat(ctx);
      const shots = ctx.shots;
      const charge = repeatPayloadOf(ctx, 1);
      const now = repeatPayloadOf(ctx, 0);
      const sig = lobOf(ctx).payload;
      // The firing's 2 bombs, the charge drained after it, then the repeat thrown now.
      expect(
        Array.from({ length: shots.count }, (_, s) => {
          const p = shots.payload[s];
          return [
            p === sig ? 'sig' : p === charge ? 'charge' : p === now ? 'now' : '?',
            shots.steady[s],
          ];
        }),
      ).toEqual([
        ['sig', 1],
        ['sig', 1],
        ['charge', 0],
        ['charge', 0],
        ['now', 0],
        ['now', 0],
      ]);
    }
  });

  it('throws the waiting repeats right after the first firing of a tick, before the second', () => {
    const ctx = repeating(SALVO, { values: { projectileCount: 3 } });
    runRepeatEffect(ctx, 1, 2, 7);
    const em = lobOf(ctx);
    // Two firings due on one tick.
    em.acc = 2 * em.interval - em.cadence;
    ctx.events.length = 0;
    runLob(ctx, em);
    const shots = ctx.shots;
    const sig = em.payload;
    const charge = repeatPayloadOf(ctx, 1);
    expect(
      Array.from({ length: shots.count }, (_, s) => {
        const p = shots.payload[s];
        return [p === sig ? 'sig' : p === charge ? 'charge' : '?', shots.depth[s], shots.origin[s]];
      }),
    ).toEqual([
      ['sig', 0, -1],
      ['sig', 0, -1],
      ['charge', 2, 7],
      ['charge', 2, 7],
      ['sig', 0, -1],
      ['sig', 0, -1],
    ]);
    expect(landedOn(ctx, ctx.events)).toEqual([2, 4, 2, 4, 2, 4]);
    expect(lobCounts(em)).toMatchObject({ attacks: 2, shots: 4 });
    expect(ctx.sys.repeat.charges.count).toBe(0);
  });

  it('throws the waiting repeats after a firing whose later bomb found no enemy: once per firing', () => {
    // Two bombs a firing at projectileCount 3, but one enemy: the firing's second bomb is lost,
    // and so is the repeat's.
    const ctx = repeating([near(0, 0)], { values: { projectileCount: 3 } });
    runRepeatEffect(ctx, 1, 2, 7);
    const em = lobOf(ctx);
    ctx.events.length = 0;
    fire(ctx);
    const shots = ctx.shots;
    const charge = repeatPayloadOf(ctx, 1);
    expect(
      Array.from({ length: shots.count }, (_, s) => {
        const p = shots.payload[s];
        return [
          p === em.payload ? 'sig' : p === charge ? 'charge' : '?',
          shots.depth[s],
          shots.origin[s],
        ];
      }),
    ).toEqual([
      ['sig', 0, -1],
      ['charge', 2, 7],
    ]);
    expect(landedOn(ctx, ctx.events)).toEqual([1, 1]);
    expect(lobCounts(em)).toMatchObject({ attacks: 1, shots: 1 });
    expect(ctx.sys.repeat.charges.count).toBe(0);
  });

  it('keeps its waiting repeats while no firing fires, and throws them after the next one', () => {
    // Nothing alive: no firing, no repeat.
    const empty = repeating([]);
    runRepeatEffect(empty, 1, 2, 7);
    fire(empty);
    expect([empty.shots.count, lobOf(empty).attacks, empty.sys.repeat.charges.count]).toEqual([
      0, 0, 1,
    ]);
    // One enemy, outside the arena, and the next bomb is 遠投's: the far aim finds no enemy, so
    // nothing fires, though a dense aim would find it.
    const ctx = repeating([{ x: -40, y: 500 }], { rules: [FAR_THROW(2)] });
    const em = lobOf(ctx);
    em.shots = 1;
    runRepeatEffect(ctx, 1, 2, 7);
    ctx.events.length = 0;
    fire(ctx);
    expect([ctx.shots.count, ctx.events.length, em.attacks]).toEqual([0, 0, 0]);
    expect(ctx.sys.repeat.charges.count).toBe(1);
    // Inside the arena it draws the far bomb, and the charge right after it.
    moveTo(enemy(ctx, 1), 100, 500);
    rebuildGrid(ctx);
    fire(ctx);
    expect(formsOf(ctx)).toEqual([LOB_FAR, LOB_NORMAL]);
    expect([ctx.shots.payload[0], ctx.shots.payload[1]]).toEqual([
      em.payload,
      repeatPayloadOf(ctx, 1),
    ]);
    expect([ctx.shots.depth[1], ctx.shots.origin[1]]).toEqual([2, 7]);
    expect(ctx.sys.repeat.charges.count).toBe(0);
  });
});
