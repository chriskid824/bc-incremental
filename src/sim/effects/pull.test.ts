/**
 * The pull effect (E15, ◆引力 「每 4 秒把場上最遠的 1 隻敵人拉到光環邊緣，Boss 除外」, gd:455; lead
 * ruling V1): its live target alone, if no boss, to dist min(dist, R) along its own direction
 * from the player, R the aura's reach as the build sizes it for 'auraEdge' or the number as it
 * is; the grid rebuilt only when it moved an enemy. Then the 引力 trigger in a run, and what the
 * enemy AI does with a pulled enemy (lead ruling 18): a summoner or shooter stands where it
 * lands, a dasher goes on as it was, and a treasure (pinned as built, nothing changed) circles
 * at R for the rest of its orbit or flees again from R. Each test's comment names the planted
 * bug it kills.
 */

import { describe, expect, it } from 'vitest';
import { ZERO } from '../../core/num';
import type { SourcedEmitter } from '../../data/emitters';
import type { StatId } from '../../data/stats';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import type { EnemyId, GameData } from '../../data/types';
import { addFrost } from '../ailments/frost';
import { auraReachSq } from '../build/size';
import { CENTER } from '../build/sources';
import { enemiesInAura } from '../emitters/aura';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { killEnemy } from '../systems/death';
import { CHARGING, DASHING, FLEEING, ORBITING, STOPPED, stepEnemyAi } from '../systems/enemyAi';
import type { EnemyV3 } from '../systems/enemyRecord';
import { GRID_LINEAR_BELOW } from '../systems/grid';
import { moveEnemies } from '../systems/movement';
import {
  centerTriggers,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  TEST_ENEMIES,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import { raiseFreeze } from './centerEvents';
import { fireOne } from './dispatch';
import { runEffectQueue } from './execute';
import { SHATTER_TRIGGER } from './types';

/** The player's position (createRunContext puts it at the arena's center). */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

/** ◆引力's trigger (gd:455), as B4's node writes it. */
const GRAVITY: TriggerSpec = {
  on: 'periodic',
  every: 4,
  target: { pick: 'outermost', excludeBoss: true },
  do: [{ kind: 'pull', to: 'auraEdge' }],
};

/** An enemy `dx`, `dy` from the player. */
const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...more,
});

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly emitters?: readonly SourcedEmitter[];
  readonly modules?: readonly TestModule[];
  readonly data?: GameData;
  /** The data triggers; one hit trigger doing `effects` when omitted. */
  readonly triggers?: readonly TriggerSpec[];
}

/** `placed` under one hit trigger whose effects are `effects` (a pull of `to` by default). */
function withPull(
  placed: readonly PlacedEnemy[],
  effects: readonly EffectSpec[],
  options: Options = {},
): RunContext {
  const triggers = options.triggers ?? [{ on: 'hit', do: effects }];
  return placedEnemies(placed, {
    stats: makeStats(options.values ?? {}, [], {
      ...centerTriggers(triggers),
      emitters: options.emitters ?? [],
    }),
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    ...(options.data === undefined ? {} : { data: options.data }),
  });
}

const pullTo = (to: 'auraEdge' | number): EffectSpec => ({ kind: 'pull', to });

/** Fires the hit trigger on `target` (its point at (x, y)), then runs the effect phase. */
function fireOn(ctx: RunContext, target: Enemy | null, x = P.x, y = P.y): void {
  fireOne(ctx, FIRST, 0, -1, target, x, y, 0, ZERO, -1);
  runEffectQueue(ctx);
}

/** [dist, x, y, ux, uy] of each enemy. */
const places = (ctx: RunContext): number[][] =>
  ctx.enemies.map((e) => [e.dist, e.x, e.y, e.ux, e.uy]);

/** Where `e` stands at `dist` along its own direction from the player. */
const along = (ctx: RunContext, e: Enemy, dist: number): number[] => [
  dist,
  ctx.player.x + e.ux * dist,
  ctx.player.y + e.uy * dist,
  e.ux,
  e.uy,
];

/** 200 enemies on a golden-angle spiral from 120 to 518 around the player: none within 100. */
const SPIRAL: readonly PlacedEnemy[] = Array.from({ length: 200 }, (_, i) => {
  const angle = i * 2.399963229728653;
  const r = 120 + 2 * i;
  return { x: P.x + r * Math.cos(angle), y: P.y + r * Math.sin(angle) };
});

const hitIds = (ctx: RunContext): number[] =>
  ctx.events.flatMap((e) => (e.type === 'hit' ? [e.targetId] : []));

describe('the pull effect (E15, lead ruling V1)', () => {
  it('pulls its live target from beyond R to exactly R along its own direction from the player, and moves no other enemy', () => {
    // Plants the pull acting on every enemy within a radius, as push does; moving the target
    // toward the event's point; and moving it by a distance rather than to R.
    const ctx = withPull(
      [at(300, 400), at(330, 400), at(-350, 0), at(0, -420, { type: 'triangle' })],
      [pullTo(100)],
    );
    const [target] = ctx.enemies as [Enemy];
    const before = places(ctx);
    expect(before[0]?.[0]).toBe(500);
    // The event's point is the other enemy's, 30 from the target.
    fireOn(ctx, target, P.x + 330, P.y + 400);
    const [x, y] = [P.x + target.ux * 100, P.y + target.uy * 100];
    expect(places(ctx)).toEqual([[100, x, y, target.ux, target.uy], ...before.slice(1)]);
    expect([target.ux, target.uy]).toEqual([before[0]?.[3], before[0]?.[4]]);
    expect(ctx.events).toEqual([]);
  });

  it('leaves its target where it is within R or at exactly R, and moves one just beyond it', () => {
    // Plants `dist = R` (an enemy within R pushed out to it) and `>=` for `>`.
    const ctx = withPull([at(80, 0), at(0, 100), at(-100.5, 0)], [pullTo(100)]);
    const [inside, onEdge, beyond] = ctx.enemies as [Enemy, Enemy, Enemy];
    const before = places(ctx);
    fireOn(ctx, inside);
    fireOn(ctx, onEdge);
    expect(places(ctx)).toEqual(before);
    fireOn(ctx, beyond);
    expect(places(ctx)).toEqual([...before.slice(0, 2), along(ctx, beyond, 100)]);
  });

  it('never moves a boss, whether the event gives it or a selector without excludeBoss picks it', () => {
    // Plants the boss test dropped: the boss, the event's or the selector's, pulled in.
    const data = makeTestData();
    const ctx = withPull([at(500, 0, { type: 'boss' }), at(-400, 0)], [pullTo(100)], { data });
    const [boss, square] = ctx.enemies as [Enemy, Enemy];
    expect([boss.boss, square.boss]).toEqual([true, false]);
    const before = places(ctx);
    fireOn(ctx, boss);
    expect(places(ctx)).toEqual(before);
    // 'outermost' picks the boss, 500 out: the pull leaves it, and pulls no one else instead.
    const picked = (excludeBoss: boolean): RunContext =>
      withPull([at(500, 0, { type: 'boss' }), at(-400, 0)], [], {
        data,
        triggers: [
          {
            on: 'periodic',
            every: 1,
            target: { pick: 'outermost', excludeBoss },
            do: [pullTo(100)],
          },
        ],
      });
    const open = picked(false);
    fireOn(open, null);
    expect(places(open)).toEqual(before);
    // With excludeBoss the square, 400 out, is the outermost it takes.
    const closed = picked(true);
    fireOn(closed, null);
    expect(places(closed)).toEqual([before[0], along(closed, closed.enemies[1] as Enemy, 100)]);
  });

  it('does nothing without a live target: a dead one, or an event without one', () => {
    // Plants liveTarget dropped (a dead target pulled) and a pull of the nearest enemy when
    // the entry has none.
    const ctx = withPull([at(300, 0), at(0, 300), at(-300, 0)], [pullTo(100)]);
    const [dead] = ctx.enemies as [Enemy];
    killEnemy(ctx, dead, -1, 0);
    expect(dead.alive).toBe(false);
    const before = places(ctx);
    fireOn(ctx, dead);
    fireOn(ctx, null);
    expect(places(ctx)).toEqual(before);
  });

  it.each([
    ['the base auraRadius, 160', {}, [], 160],
    ['auraRadius 200', { auraRadius: 200 }, [], 200],
    ['auraRadius 200 × areaSize 1.5', { auraRadius: 200, areaSize: 1.5 }, [], 300],
    ['the base × areaSize 0.5', { areaSize: 0.5 }, [], 80],
    [
      'auraRadius 200 × areaSize 1.5 beside an aura grant',
      { auraRadius: 200, areaSize: 1.5 },
      [{ source: 'outer.aura', grant: { kind: 'aura' } }],
      300,
    ],
  ] as const)("pulls to the aura's reach with to 'auraEdge': %s", (_name, values, emitters, r) => {
    // Plants 'auraEdge' read unsized (values.auraRadius alone), and as the base's 160.
    const ctx = withPull([at(0, 500), at(450, 0)], [pullTo('auraEdge')], { values, emitters });
    const [target] = ctx.enemies as [Enemy];
    const before = places(ctx);
    fireOn(ctx, target);
    expect(places(ctx)).toEqual([along(ctx, target, r), before[1]]);
  });

  it("reads 巨大化's size factor in the aura's reach as sizeOf does, and takes a number as it is", () => {
    // Plants a number sized by the area factor, and 'auraEdge' without the size factor.
    const giant: TestModule = (b) => {
      b.flags.sizeFactor = 2;
    };
    const edge = withPull([at(0, 500)], [pullTo('auraEdge')], { modules: [giant] });
    fireOn(edge, edge.enemies[0] as Enemy);
    expect(edge.enemies[0]?.dist).toBe(320);
    const ctx = withPull([at(0, 500), at(400, 0)], [pullTo(100)], {
      values: { areaSize: 1.5, auraRadius: 200 },
      modules: [giant],
    });
    const [first, second] = ctx.enemies as [Enemy, Enemy];
    fireOn(ctx, first);
    expect(first.dist).toBe(100);
    // To 0: at the player.
    const zero = withPull([at(400, 0)], [pullTo(0)]);
    fireOn(zero, zero.enemies[0] as Enemy);
    expect(places(zero)).toEqual([along(zero, zero.enemies[0] as Enemy, 0)]);
    expect(second.dist).toBe(400);
  });

  it("lands an enemy pulled to the aura's edge inside the aura's reach on every bearing, an ulp-scale below R at most", () => {
    // Plants the landing at player + u × R alone, which the pulse's and inAura's inclusive
    // squared test (auraReachSq) leaves out on 158 of these 360 bearings, so an enemy that
    // stands where it lands (a shooter, a summoner) would never take a pulse.
    const ring = Array.from({ length: 360 }, (_, i) => {
      const a = (2 * Math.PI * i) / 360 + 0.001;
      return at(500 * Math.cos(a), 500 * Math.sin(a));
    });
    const ctx = withPull(ring, [pullTo('auraEdge')], {
      emitters: [{ source: 'outer.aura', grant: { kind: 'aura' } }],
    });
    for (const e of ctx.enemies) fireOn(ctx, e);
    const reachSq = auraReachSq(ctx.build);
    const off = ctx.enemies.filter(
      (e) =>
        !(e.dist <= 160 && 160 - e.dist < 1e-9) ||
        e.x !== P.x + e.ux * e.dist ||
        e.y !== P.y + e.uy * e.dist ||
        (e.x - P.x) ** 2 + (e.y - P.y) ** 2 > reachSq,
    );
    expect(off).toEqual([]);
    expect(enemiesInAura(ctx)).toBe(360);
    // Most land at 160 itself; the rest a rounding step or a few below it.
    expect(ctx.enemies.filter((e) => e.dist === 160).length).toBeGreaterThan(180);
  });

  it('leaves an enemy at exactly R where it is, and rebuilds nothing for it', () => {
    // Plants `>=` for `>`: an enemy at R moved to where it already is, and the grid rebuilt.
    const ctx = withPull([...SPIRAL, at(0, -200)], [pullTo(200)]);
    const edge = ctx.enemies[200] as Enemy;
    expect(edge.dist).toBe(200);
    const before = places(ctx);
    ctx.grid.within(P.x, P.y, 90 * 90, []);
    const sorts = ctx.grid.sortCount;
    fireOn(ctx, edge);
    ctx.grid.within(P.x, P.y, 400 * 400, []);
    expect(ctx.grid.sortCount - sorts).toBe(0);
    expect(places(ctx)).toEqual(before);
  });

  it('rebuilds the grid once it moved its enemy, so a later effect of the tick finds it where it lands', () => {
    // Plants the rebuild dropped: the nova after it queries the cells as sorted before the pull.
    expect(SPIRAL.length).toBeGreaterThanOrEqual(GRID_LINEAR_BELOW);
    const ctx = withPull(SPIRAL, [pullTo(60), { kind: 'nova', radius: 90, damagePct: 1 }]);
    const outer = ctx.enemies[199] as Enemy;
    expect(outer.dist).toBeCloseTo(518, 9);
    // The cells sorted at a query before the pull.
    ctx.grid.within(P.x, P.y, 90 * 90, []);
    const before = ctx.grid.sortCount;
    fireOn(ctx, outer);
    expect(outer.dist).toBe(60);
    expect(hitIds(ctx)).toEqual([200]);
    // The nova's query, the first after the pull's rebuild, sorted once.
    expect(ctx.grid.sortCount - before).toBe(1);
    expect(ctx.grid.nearest(P.x, P.y, Infinity)).toBe(outer);
  });

  it('does not rebuild the grid when it moved nothing: a target within R, a boss or a dead one', () => {
    // Plants the rebuild run on every pull, moved or not.
    const data = makeTestData();
    const ctx = withPull([...SPIRAL, at(0, 600, { type: 'boss' })], [pullTo(200)], { data });
    const inside = ctx.enemies[0] as Enemy;
    const dead = ctx.enemies[150] as Enemy;
    const boss = ctx.enemies[200] as Enemy;
    killEnemy(ctx, dead, -1, 0);
    ctx.grid.within(P.x, P.y, 90 * 90, []);
    const before = ctx.grid.sortCount;
    for (const target of [inside, boss, dead]) {
      fireOn(ctx, target);
      ctx.grid.within(P.x, P.y, 400 * 400, []);
      expect(ctx.grid.sortCount - before, `target ${target.id}`).toBe(0);
    }
    expect([inside.dist, boss.dist]).toEqual([120, 600]);
    // A pull that moves its enemy does.
    fireOn(ctx, ctx.enemies[199] as Enemy);
    ctx.grid.within(P.x, P.y, 400 * 400, []);
    expect(ctx.grid.sortCount - before).toBe(1);
  });

  it('pulls each alive enemy of a freeze’s list, as an addFrost without a radius reaches each', () => {
    // Plants the pull compiled without fanout: only the frozen enemy, the event's, would move.
    const ctx = withPull([at(200, 0), at(260, 0), at(400, 0)], [], {
      values: { critChance: 0, igniteChance: 0 },
      triggers: [{ on: 'freeze', do: [pullTo(100)] }],
    });
    expect(ctx.build.effects.filter((fx) => fx.kind === 'pull').map((fx) => fx.fanout)).toEqual([
      true,
    ]);
    const [near, frozen, far] = ctx.enemies as [Enemy, Enemy, Enemy];
    ctx.now = 5;
    // The freeze's list: the frozen enemy, then the one 60 from it; the far one is 140 away.
    expect(addFrost(ctx, frozen, 1, CENTER)).toBe(true);
    raiseFreeze(ctx, frozen, 0, -1, 0);
    runEffectQueue(ctx);
    expect([near, frozen, far].map((e) => e.dist)).toEqual([100, 100, 400]);
    expect(ctx.counters.effectsRun).toBe(2);
  });
});

/**
 * Fixture waves of immortal enemies, a new wave every 3 s, and from wave 10 a boss that stands
 * where it spawns (speed 0), outside the arena's edge as every spawn is: at times the farthest
 * enemy, which ◆引力 passes over.
 */
const gravityData = (): GameData =>
  makeTestData({
    enemies: {
      triangle: { hpMult: 1e12 },
      square: { hpMult: 1e12 },
      pentagon: { hpMult: 1e12 },
      boss: { hpMult: 1e12, speed: 0 },
    },
    waves: { waveTimerSec: 3, bossEvery: 10 },
  });

describe('the 引力 trigger in a run (gd:455)', () => {
  it("pulls the outermost enemy but the boss to the aura's edge every 240 ticks from tick 241, and moves nothing else", () => {
    // Plants the selector's excludeBoss ignored (the boss pulled when farthest), the period
    // read as 4 ticks, and the pull of every enemy in a radius.
    let ctxOf: RunContext | null = null;
    // At the tick hook (the emitter stage, after movement): each enemy's place, and the one the
    // selector will pick in this tick's effect phase; nothing else moves them in between.
    let seen = new Map<number, number[]>();
    let pick = -1;
    let farthest = -1;
    const watch: TestModule = (b) =>
      b.hook('tick', (ctx) => {
        ctxOf = ctx;
        seen = new Map(ctx.enemies.map((e) => [e.id, [e.dist, e.x, e.y]]));
        let best: Enemy | null = null;
        let any: Enemy | null = null;
        for (const e of ctx.enemies) {
          if (!e.alive) continue;
          if (any === null || e.dist > any.dist) any = e;
          if (!e.boss && (best === null || e.dist > best.dist)) best = e;
        }
        pick = best?.id ?? -1;
        farthest = any?.id ?? -1;
      });
    const stats = makeStats({ maxLife: 1e9, damage: 1 }, [], centerTriggers([GRAVITY]));
    const sim = createSimulation(
      makeConfig({ stats, startWave: 10, maxTicks: 1000 }),
      gravityData(),
      [watch],
    );
    const pulls: [number, boolean, boolean, boolean][] = [];
    const bossDists = new Set<number>();
    while (!sim.state.finished) {
      sim.step(NO_INPUT);
      const ctx = ctxOf as RunContext | null;
      if (ctx === null) continue;
      const boss = ctx.enemies.find((e) => e.boss);
      if (boss !== undefined) bossDists.add(boss.dist);
      const moved = ctx.enemies.filter((e) => {
        const was = seen.get(e.id);
        return was !== undefined && was[0] !== e.dist;
      });
      if (moved.length === 0) continue;
      const [e] = moved as [Enemy];
      // [tick, one enemy moved and it the pick, landed at the edge (160 or the least below it
      // that the reach test takes) along its own direction, the boss farther still]
      pulls.push([
        ctx.now,
        moved.length === 1 && e.id === pick,
        e.dist <= 160 &&
          160 - e.dist < 1e-9 &&
          e.x === ctx.player.x + e.ux * e.dist &&
          e.y === ctx.player.y + e.uy * e.dist &&
          (e.x - ctx.player.x) ** 2 + (e.y - ctx.player.y) ** 2 <= auraReachSq(ctx.build),
        boss !== undefined && farthest === boss.id,
      ]);
    }
    expect(pulls).toEqual([
      [241, true, true, false],
      [481, true, true, false],
      [721, true, true, true],
      [961, true, true, false],
    ]);
    // The boss never moved, though it was the farthest at 721.
    expect(bossDists.size).toBe(1);
  });
});

/**
 * A v3 table whose waves hold no enemy, elite, boss, affix or treasure, so that only placed
 * enemies exist (as src/sim/systems/enemyAi.test.ts's quietV3).
 */
const quietV3 = (): GameData =>
  v3TestData({
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

/** A walking enemy of `type` `dx` to the player's right, bearing (1, 0), immortal in practice. */
const walker = (type: EnemyId, dx: number): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y,
  type,
  speed: TEST_ENEMIES[type].speed,
});

/** `placed` on quietV3's data under a hit trigger pulling to 160, the base aura's edge. */
const aiRun = (placed: readonly PlacedEnemy[]): RunContext =>
  withPull(placed, [pullTo('auraEdge')], { data: quietV3() });

/** Runs one tick's enemy AI and movement stages, as step does, then moves on: its events. */
function tick(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepEnemyAi(ctx);
  moveEnemies(ctx);
  const events = [...ctx.events];
  ctx.now++;
  ctx.state.tick++;
  return events;
}

/** The pull of `e`, in the effect phase at the end of the tick before ctx.now. */
function pull(ctx: RunContext, e: Enemy): void {
  ctx.events.length = 0;
  fireOn(ctx, e, e.x, e.y);
}

const record = (e: Enemy): EnemyV3 => e.v3 as EnemyV3;
const typesOf = (events: readonly SimEvent[]): string[] => events.map((e) => e.type);

describe('a pulled enemy goes on from where it lands (lead ruling 18)', () => {
  it('a summoner stands where it lands, at its post or walking in, and summons there on its timer', () => {
    // Plants stepPost leaving STOPPED for a pulled summoner (inside stopDist + STOP_SLACK, not
    // beyond), and the pull re-arming its timer.
    const ctx = aiRun([walker('summoner', 484), walker('summoner', 700)]);
    const [posted, walking] = ctx.enemies as [Enemy, Enemy];
    // The first walks 1.5 a tick to its post at 480 and stands from tick 4, its timer 180 on.
    for (let k = 0; k < 10; k++) tick(ctx);
    expect([posted.dist, record(posted).state, record(posted).nextAct]).toEqual([
      479.5,
      STOPPED,
      184,
    ]);
    expect(record(walking).state).toBe(0);
    pull(ctx, posted);
    pull(ctx, walking);
    expect([posted.dist, walking.dist]).toEqual([160, 160]);
    // The walking one stands on the next tick, its timer armed then, a period ahead.
    tick(ctx);
    expect([record(walking).state, record(walking).nextAct]).toEqual([STOPPED, 191]);
    const summons: [number, number, number][] = [];
    for (let now = ctx.now; now <= 400; now++) {
      const before = ctx.enemies.length;
      for (const event of tick(ctx)) {
        if (event.type !== 'summoned') continue;
        // Its children, spawned on its rim (their place before this tick's walk): 160 ± its
        // radius from the player.
        const children = ctx.enemies.slice(before);
        const rim = children.map((e) => Math.hypot(e.prevX - P.x, e.prevY - P.y) - 160);
        const onRim = rim.every((d) => Math.abs(d) <= TEST_ENEMIES.summoner.radius + 1e-9);
        summons.push([now, event.enemyId, children.length === 2 && onRim ? 1 : 0]);
      }
      expect([posted.dist, walking.dist]).toEqual([160, 160]);
      expect([record(posted).state, record(walking).state]).toEqual([STOPPED, STOPPED]);
    }
    expect(summons).toEqual([
      [184, 1, 1],
      [191, 2, 1],
      [364, 1, 1],
      [371, 2, 1],
    ]);
  });

  it('a shooter stands where it lands and fires from there on its timer', () => {
    // Plants the pulled shooter walking back out to its post at 300.
    const ctx = aiRun([walker('shooter', 302)]);
    const shooter = ctx.enemies[0] as Enemy;
    for (let k = 0; k < 10; k++) tick(ctx);
    expect([shooter.dist, record(shooter).state, record(shooter).nextAct]).toEqual([
      300,
      STOPPED,
      122,
    ]);
    pull(ctx, shooter);
    const shots: [number, number, number][] = [];
    for (let now = ctx.now; now <= 250; now++) {
      for (const event of tick(ctx)) {
        if (event.type === 'bulletFired') shots.push([now, event.x - P.x, event.y - P.y]);
      }
      expect([shooter.dist, record(shooter).state]).toEqual([160, STOPPED]);
    }
    expect(shots).toEqual([
      [122, 160, 0],
      [242, 160, 0],
    ]);
  });

  it('a dasher goes on as it was: charging it dashes on time, dashing it dashes on, walking in it starts to charge', () => {
    // Plants the pull resetting the dasher's state, or its charge timer.
    const ctx = aiRun([walker('dasher', 420), walker('dasher', 470), walker('dasher', 700)]);
    const [dashing, charging, walking] = ctx.enemies as [Enemy, Enemy, Enemy];
    // The first charges from tick 1 and dashes from 37; the second walks in and charges from 29.
    const dash = TEST_ENEMIES.dasher.speed * DT * 4;
    for (let k = 0; k < 40; k++) tick(ctx);
    expect(record(dashing).state).toBe(DASHING);
    expect(dashing.dist).toBeCloseTo(420 - 4 * dash, 9);
    expect([record(charging).state, record(charging).stateUntil]).toEqual([CHARGING | STOPPED, 65]);
    expect(record(walking).state).toBe(0);
    for (const e of [dashing, charging, walking]) pull(ctx, e);
    // Tick 41: the dashing one dashes on from 160, the charging one stands there charging, and
    // the walking one, within its chargeDist 420 now, starts to charge there.
    expect(typesOf(tick(ctx))).toEqual(['dasherCharge']);
    expect(dashing.dist).toBeCloseTo(160 - dash, 9);
    expect([charging.dist, walking.dist]).toEqual([160, 160]);
    expect([record(charging).stateUntil, record(walking).stateUntil]).toEqual([65, 77]);
    const dashes: [number, number, number][] = [];
    while (ctx.now <= 80) {
      const now = ctx.now;
      const before = new Map(ctx.enemies.map((e) => [e.id, e.dist]));
      for (const event of tick(ctx)) {
        if (event.type === 'dasherDash') {
          dashes.push([now, event.enemyId, before.get(event.enemyId) as number]);
        }
      }
    }
    // Each dashes on time, from where it was pulled to.
    expect(dashes).toEqual([
      [65, 2, 160],
      [77, 3, 160],
    ]);
  });

  it('a treasure (as built, nothing changed): orbiting it circles at R, walking in it orbits from R, fleeing it flees again from R', () => {
    // Pins what the AI does with a pulled 寶藏怪, which ◆引力 counts as farthest (Hoshi's item
    // 18, its default): stepTreasure is not changed by E15.
    const ctx = aiRun([walker('treasure', 482), walker('treasure', 800)]);
    const [orbiting, walking] = ctx.enemies as [Enemy, Enemy];
    for (let k = 0; k < 10; k++) tick(ctx);
    const v = record(orbiting);
    expect([v.state, v.stateUntil]).toEqual([ORBITING, 482]);
    pull(ctx, orbiting);
    pull(ctx, walking);
    const turn = (e: Enemy): number => Math.atan2(e.uy, e.ux);
    const a0 = turn(orbiting);
    tick(ctx);
    // It turns its bearing as before (its walk step over orbitDist 480), at 160 from the player.
    expect(orbiting.dist).toBe(160);
    expect(turn(orbiting) - a0).toBeCloseTo((150 * DT) / 480, 12);
    // The walking one orbits from 160 for 8 s from the tick after the pull.
    expect([record(walking).state, record(walking).stateUntil, walking.dist]).toEqual([
      ORBITING,
      491,
      160,
    ]);
    while (ctx.now < 482) tick(ctx);
    expect([orbiting.dist, record(orbiting).state]).toEqual([160, ORBITING]);
    tick(ctx);
    expect(record(orbiting).state).toBe(FLEEING);
    // It fled 5 that tick (2 × its walk step, 2.5), and 300 more in the next 60.
    expect(orbiting.dist).toBe(165);
    for (let k = 0; k < 60; k++) tick(ctx);
    expect(orbiting.dist).toBe(465);
    // Pulled again, it flees on from 160.
    pull(ctx, orbiting);
    expect(orbiting.dist).toBe(160);
    tick(ctx);
    expect([orbiting.dist, record(orbiting).state]).toEqual([165, FLEEING]);
    // And it escapes at its escape distance, as an unpulled one does.
    let escaped = 0;
    for (let k = 0; k < 400 && orbiting.alive; k++) {
      if (tick(ctx).some((e) => e.type === 'treasureEscaped')) escaped = ctx.now - 1;
    }
    expect(orbiting.alive).toBe(false);
    expect(escaped).toBeGreaterThan(0);
  });
});
