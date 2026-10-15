import { describe, expect, it, vi } from 'vitest';
import { toNumber } from '../../core/num';
import { createStreams } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { Modifier, StatBlock, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import { STACK_AILMENTS } from '../../data/triggers';
import type { GroundZoneSpec, TriggerSpec } from '../../data/triggers';
import { enemySlow } from '../ailments/frost';
import { compileBuild } from '../build/compile';
import { liveStacks } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { PROJECTILE_CAP, SIGNATURE_ZONE_CAP } from '../caps';
import { runEffect, runEffectQueue } from '../effects/execute';
import { HIT_EVENT, PRIMARY, SIGNATURE } from '../effects/flags';
import { createEffectEntry, dequeue } from '../effects/queue';
import { EVENT, SHATTER_TRIGGER } from '../effects/types';
import type { CompiledTrigger } from '../effects/types';
import type { TestModule } from '../rules';
import { magmaBomb } from '../rules/magmaBomb';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
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
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import { aimDense, beginAim, launch, LOB_NORMAL, runLob } from './lob';
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
 * trigger `origin` (0 and −1, the emitter's own, by default).
 */
const launchAt = (ctx: RunContext, at: { x: number; y: number }, depth = 0, origin = -1): void => {
  const em = lobOf(ctx);
  const ls = ctx.sys.lob;
  ls.x = at.x;
  ls.y = at.y;
  launch(ctx, em, em.payload, LOB_NORMAL, false, depth, origin);
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
  it('compiles to a lob of 150% that always ignites its area hits, its lob params neutral', () => {
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
      { kind: 0, value: 1, all: TAG.area, none: TAG.trigger },
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
