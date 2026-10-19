import { describe, expect, it } from 'vitest';
import { toNumber, ZERO } from '../../core/num';
import type { StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { ProjectilesSpec, TriggerSpec } from '../../data/triggers';
import { liveBurnStacks } from '../ailments/records';
import { PROJECTILE_CAP, SMALL_PROJECTILE_TICKS } from '../caps';
import type { Payload } from '../emitters/types';
import type { Enemy, RunContext } from '../systems/context';
import { removeEnemy } from '../systems/death';
import { moveProjectiles } from '../systems/projectiles';
import { liveProjectiles, MOTION_HOMING, MOTION_STRAIGHT, spawnShot } from '../systems/shots';
import { eventsOf, makeStats, placedEnemies, rngPositions } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { fireOne } from './dispatch';
import { runEffectQueue } from './execute';
import { HIT_EVENT } from './flags';
import { createEffectEntry, dequeue } from './queue';
import { compileEffect, SHATTER_TRIGGER } from './types';
import type { CompiledTrigger } from './types';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (dx: number, dy: number, hp?: number): PlacedEnemy =>
  hp === undefined
    ? { x: PLAYER.x + dx, y: PLAYER.y + dy }
    : { x: PLAYER.x + dx, y: PLAYER.y + dy, hp };

/** The build's first data trigger, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

const NO_ROLLS = { critChance: 0, igniteChance: 0 };

const projectiles = (
  spec: Omit<ProjectilesSpec, 'kind' | 'damagePct'> & { readonly damagePct?: number },
): ProjectilesSpec => ({ kind: 'projectiles', damagePct: 0.5, ...spec });

/** `placed` with these triggers of outer.barrage; `values` over NO_ROLLS. */
function fixture(
  placed: readonly PlacedEnemy[],
  triggers: readonly TriggerSpec[],
  values: Partial<Record<StatId, number>> = {},
): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...values }, [], {
      triggers: triggers.map((spec) => ({ source: 'outer.barrage', spec })),
      conversions: [],
      emitters: [],
    }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/**
 * Fires trigger `i` (FIRST by default) as a hit on `target` at its position, or at the player
 * without a target, at `depth` from `origin`; then runs the effect phase.
 */
function fire(
  ctx: RunContext,
  target: Enemy | null,
  { i = FIRST, depth = 0, origin = -1 }: { i?: number; depth?: number; origin?: number } = {},
): void {
  const x = target === null ? ctx.player.x : target.x;
  const y = target === null ? ctx.player.y : target.y;
  fireOne(ctx, i, depth, origin, target, x, y, target === null ? 0 : HIT_EVENT, ZERO, -1);
  runEffectQueue(ctx);
}

/** Runs the projectile stage of the next tick, its events alone in ctx.events. */
function nextTick(ctx: RunContext): void {
  ctx.now++;
  ctx.events.length = 0;
  ctx.grid.rebuild(ctx.enemies, (e) => e.tough);
  moveProjectiles(ctx);
}

/** Steps up to `ticks` ticks while shots fly; returns the hit events, in order. */
function fly(ctx: RunContext, ticks = SMALL_PROJECTILE_TICKS + 1): HitEvent[] {
  const hits: HitEvent[] = [];
  for (let t = 0; t < ticks && ctx.shots.count > 0; t++) {
    nextTick(ctx);
    hits.push(...eventsOf([ctx.events], 'hit'));
  }
  return hits;
}

interface ShotRow {
  readonly motion: number;
  readonly x: number;
  readonly y: number;
  readonly until: number;
  readonly pierce: number;
  readonly bounce: number;
  readonly depth: number;
  readonly origin: number;
  readonly steady: number;
  readonly round: number;
  readonly owner: number;
  readonly scale: number;
  readonly target: number;
}

/** Every shot in flight, in slot order, but its velocity; target is its target's id or 0. */
const rows = (ctx: RunContext): ShotRow[] => {
  const s = ctx.shots;
  return Array.from({ length: s.count }, (_, i) => ({
    motion: s.motion[i] as number,
    x: s.x[i] as number,
    y: s.y[i] as number,
    until: s.until[i] as number,
    pierce: s.pierce[i] as number,
    bounce: s.bounce[i] as number,
    depth: s.depth[i] as number,
    origin: s.origin[i] as number,
    steady: s.steady[i] as number,
    round: s.round[i] as number,
    owner: s.owner[i] as number,
    scale: s.scale[i] as number,
    target: s.target[i]?.id ?? 0,
  }));
};

/** The shots' headings in degrees, and their speeds. */
const headings = (ctx: RunContext): number[] =>
  Array.from({ length: ctx.shots.count }, (_, i) => {
    const deg = (Math.atan2(ctx.shots.vy[i] as number, ctx.shots.vx[i] as number) * 180) / Math.PI;
    return Math.round(deg * 1e6) / 1e6;
  });
const speeds = (ctx: RunContext): number[] =>
  Array.from({ length: ctx.shots.count }, (_, i) =>
    Math.hypot(ctx.shots.vx[i] as number, ctx.shots.vy[i] as number),
  );

/** A shot of the effect as `rows` reads it: homing at `target`, one hit, from (x, y). */
const homing = (ctx: RunContext, x: number, y: number, target: number): ShotRow => ({
  motion: MOTION_HOMING,
  x,
  y,
  until: ctx.now + SMALL_PROJECTILE_TICKS,
  pierce: 1,
  bounce: 0,
  depth: 1,
  origin: FIRST,
  steady: 0,
  round: -1,
  owner: -1,
  scale: 1,
  target,
});

describe('projectiles: aims', () => {
  it("'target' fires count homing shots at the live target, from the event's point or the player", () => {
    const ctx = fixture(
      [at(300, 0), at(0, 200)],
      [
        { on: 'hit', do: [projectiles({ count: 3, aim: 'target' })] },
        { on: 'hit', do: [projectiles({ count: 2, aim: 'target', from: 'player' })] },
      ],
    );
    const target = enemy(ctx, 1);
    fire(ctx, target);
    expect(rows(ctx)).toEqual(Array(3).fill(homing(ctx, target.x, target.y, 1)));
    expect(speeds(ctx)).toEqual([0, 0, 0]);
    fire(ctx, enemy(ctx, 2), { i: FIRST + 1 });
    expect(rows(ctx).slice(3)).toEqual(
      Array(2).fill({ ...homing(ctx, PLAYER.x, PLAYER.y, 2), origin: FIRST + 1 }),
    );
    // In id order, one after the other.
    const ids = Array.from(ctx.shots.id.subarray(0, 5));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(5);
  });

  it("'target' homes at the enemy a selector picks, and fires nothing without a live one", () => {
    const ctx = fixture(
      [at(300, 0), at(-200, 0, 1e13), at(0, 150)],
      [
        {
          on: 'periodic',
          every: 1,
          target: { pick: 'highestHp' },
          do: [projectiles({ count: 2, aim: 'target' })],
        },
        { on: 'hit', do: [projectiles({ count: 2, aim: 'target' })] },
        {
          on: 'periodic',
          every: 1,
          target: { pick: 'player' },
          do: [projectiles({ count: 2, aim: 'target' })],
        },
      ],
    );
    // A periodic trigger fires at the player.
    fire(ctx, null);
    expect(rows(ctx)).toEqual(Array(2).fill(homing(ctx, PLAYER.x, PLAYER.y, 2)));
    // The event's enemy dies before its effect runs.
    const target = enemy(ctx, 3);
    fireOne(ctx, FIRST + 1, 0, -1, target, target.x, target.y, HIT_EVENT, ZERO, -1);
    removeEnemy(ctx, target);
    runEffectQueue(ctx);
    expect(ctx.shots.count).toBe(2);
    // A 'player' pick gives no enemy.
    fire(ctx, null, { i: FIRST + 2 });
    expect(ctx.shots.count).toBe(2);
  });

  it("'distinct' fires one homing shot at each of the count nearest alive enemies, nearest first, ties to the lower id", () => {
    // From the player: 2 at 50, 1 and 3 at 100, 4 at 300; 5, at 10, is dead.
    const placed = [at(100, 0), at(0, 50), at(0, -100), at(-300, 0), at(10, 0)];
    const triggers: TriggerSpec[] = [
      { on: 'hit', do: [projectiles({ count: 3, aim: 'distinct', from: 'player' })] },
      { on: 'hit', do: [projectiles({ count: 10, aim: 'distinct', from: 'player' })] },
      { on: 'hit', do: [projectiles({ count: 2, aim: 'distinct' })] },
    ];
    const ctx = fixture(placed, triggers);
    removeEnemy(ctx, enemy(ctx, 5));
    fire(ctx, enemy(ctx, 4));
    expect(rows(ctx)).toEqual([2, 1, 3].map((id) => homing(ctx, PLAYER.x, PLAYER.y, id)));
    // Fewer alive than count: every one of them.
    const all = fixture(placed, triggers);
    removeEnemy(all, enemy(all, 5));
    fire(all, enemy(all, 4), { i: FIRST + 1 });
    expect(rows(all).map((row) => row.target)).toEqual([2, 1, 3, 4]);
    // From the event's point, enemy 4's: itself first, then 2 (304 away), not 1 (400).
    const near = fixture(placed, triggers);
    removeEnemy(near, enemy(near, 5));
    const four = enemy(near, 4);
    fire(near, four, { i: FIRST + 2 });
    expect(rows(near)).toEqual(
      [4, 2].map((id) => ({ ...homing(near, four.x, four.y, id), origin: FIRST + 2 })),
    );
  });

  it("'radial' fires count straight shots evenly spaced from the outward angle, player to start", () => {
    const ctx = fixture(
      [at(0, 200), at(-150, -150)],
      [
        { on: 'hit', do: [projectiles({ count: 4, aim: 'radial', from: 'player' })] },
        { on: 'hit', do: [projectiles({ count: 3, aim: 'radial' })] },
      ],
    );
    // From the player, which is the start: +x first.
    fire(ctx, enemy(ctx, 1));
    expect(headings(ctx)).toEqual([0, 90, 180, -90]);
    for (const speed of speeds(ctx)) expect(speed).toBeCloseTo(ctx.projectileStep, 12);
    expect(rows(ctx)).toEqual(
      Array(4).fill({ ...homing(ctx, PLAYER.x, PLAYER.y, 0), motion: MOTION_STRAIGHT }),
    );
    // From enemy 2, up and left of the player: its first heads on away from the player.
    const two = enemy(ctx, 2);
    fire(ctx, two, { i: FIRST + 1 });
    expect(headings(ctx).slice(4)).toEqual([-135, -15, 105]);
    expect(
      rows(ctx)
        .slice(4)
        .map((row) => [row.x, row.y]),
    ).toEqual(Array(3).fill([two.x, two.y]));
  });

  it("'radial' needs no target: it fires on a periodic trigger and for a dead event enemy", () => {
    const ctx = fixture(
      [at(0, 200)],
      [
        {
          on: 'periodic',
          every: 1,
          do: [projectiles({ count: 2, aim: 'radial', from: 'player' })],
        },
        { on: 'hit', do: [projectiles({ count: 2, aim: 'radial' })] },
      ],
    );
    fire(ctx, null);
    expect(headings(ctx)).toEqual([0, 180]);
    const one = enemy(ctx, 1);
    fireOne(ctx, FIRST + 1, 0, -1, one, one.x, one.y, HIT_EVENT, ZERO, -1);
    removeEnemy(ctx, one);
    runEffectQueue(ctx);
    // Where it died, outward from the player (+y), then the opposite way.
    expect(headings(ctx).slice(2)).toEqual([90, -90]);
  });

  it("'fan' fires count straight shots over spreadDeg (30 by default) at the live target", () => {
    const ctx = fixture(
      [at(300, 0), at(300, 300)],
      [
        { on: 'hit', do: [projectiles({ count: 3, aim: 'fan', from: 'player' })] },
        {
          on: 'hit',
          do: [projectiles({ count: 5, aim: 'fan', from: 'player', spreadDeg: 60 })],
        },
        { on: 'hit', do: [projectiles({ count: 1, aim: 'fan', from: 'player', spreadDeg: 60 })] },
      ],
    );
    fire(ctx, enemy(ctx, 1));
    expect(headings(ctx)).toEqual([-15, 0, 15]);
    fire(ctx, enemy(ctx, 1), { i: FIRST + 1 });
    expect(headings(ctx).slice(3)).toEqual([-30, -15, 0, 15, 30]);
    // One shot flies straight at the target.
    fire(ctx, enemy(ctx, 2), { i: FIRST + 2 });
    expect(headings(ctx).slice(8)).toEqual([45]);
    for (const speed of speeds(ctx)) expect(speed).toBeCloseTo(ctx.projectileStep, 12);
    expect(rows(ctx).every((row) => row.motion === MOTION_STRAIGHT && row.target === 0)).toBe(true);
  });

  it("'fan' starts at the event's point and aims at the enemy a selector picks", () => {
    // 1 is hit; 2, 300 below it, is the nearest other enemy to the hit.
    const ctx = fixture(
      [at(300, 0), at(300, 300)],
      [
        {
          on: 'hit',
          target: { pick: 'nearest', excludeEventTarget: true },
          do: [projectiles({ count: 3, aim: 'fan' })],
        },
      ],
    );
    const one = enemy(ctx, 1);
    fire(ctx, one);
    // From 1 straight down at 2 (+y is 90°), not from the player and not at 1 itself.
    expect(headings(ctx)).toEqual([75, 90, 105]);
    expect(rows(ctx).map((row) => [row.x, row.y, row.target])).toEqual(
      Array(3).fill([one.x, one.y, 0]),
    );
  });

  it("'fan' fires nothing without a live target", () => {
    const ctx = fixture([at(300, 0)], [{ on: 'hit', do: [projectiles({ count: 3, aim: 'fan' })] }]);
    const one = enemy(ctx, 1);
    fireOne(ctx, FIRST, 0, -1, one, one.x, one.y, HIT_EVENT, ZERO, -1);
    removeEnemy(ctx, one);
    runEffectQueue(ctx);
    expect(ctx.shots.count).toBe(0);
  });
});

describe('projectiles: shots', () => {
  it(`spawns through the cap: past ${PROJECTILE_CAP} in flight each refused shot is counted`, () => {
    const ctx = fixture(
      [at(300, 0)],
      [{ on: 'hit', do: [projectiles({ count: 5, aim: 'radial', from: 'player' })] }],
    );
    const t = ctx.build.triggers[FIRST] as CompiledTrigger;
    const p = ctx.effectPayloads[t.effectStart] as Payload;
    while (liveProjectiles(ctx) < PROJECTILE_CAP - 2) {
      spawnShot(ctx, MOTION_STRAIGHT, 10, 10, 0, 0, 1000, p, 1, 1, 0, 0, -1, false, -1, -1, null);
    }
    const capped = ctx.counters.projectilesCapped;
    fire(ctx, enemy(ctx, 1));
    expect(liveProjectiles(ctx)).toBe(PROJECTILE_CAP);
    expect(ctx.counters.projectilesCapped - capped).toBe(3);
    expect(headings(ctx).slice(PROJECTILE_CAP - 2)).toEqual([0, 72]);
  });

  it('pierce 0 hits one enemy, n hits n + 1, and −1 every enemy on the line (K16)', () => {
    const line = [at(100, 0), at(200, 0), at(300, 0), at(400, 0), at(500, 0)];
    const hitsWith = (pierce?: number): [number, number[]] => {
      const shot = projectiles({
        count: 1,
        aim: 'radial',
        from: 'player',
        ...(pierce === undefined ? {} : { pierce }),
      });
      const ctx = fixture(line, [{ on: 'periodic', every: 1, do: [shot] }]);
      fire(ctx, null);
      const spawned = ctx.shots.pierce[0] as number;
      return [spawned, fly(ctx).map((hit) => hit.targetId)];
    };
    expect(hitsWith()).toEqual([1, [1]]);
    expect(hitsWith(0)).toEqual([1, [1]]);
    expect(hitsWith(2)).toEqual([3, [1, 2, 3]]);
    expect(hitsWith(-1)).toEqual([-1, [1, 2, 3, 4, 5]]);
  });

  it('bounces off the edges `bounce` times', () => {
    const ctx = fixture(
      [],
      [
        {
          on: 'periodic',
          every: 1,
          do: [projectiles({ count: 1, aim: 'radial', from: 'player', bounce: 2 })],
        },
      ],
      { projectileSpeed: 60 * 240 },
    );
    fire(ctx, null);
    expect(ctx.shots.bounce[0]).toBe(2);
    // 240 a tick from x 960: out at 2 ticks past 1920, back past 0, out again past 1920.
    const xs: number[] = [];
    while (ctx.shots.count > 0) {
      nextTick(ctx);
      if (ctx.shots.count > 0) xs.push(ctx.shots.x[0] as number);
    }
    expect(xs).toEqual([
      1200, 1440, 1680, 1920, 2160, 1920, 1680, 1440, 1200, 960, 720, 480, 240, 0, -240, 0, 240,
      480, 720, 960, 1200, 1440, 1680, 1920,
    ]);
  });

  it(`lasts ${SMALL_PROJECTILE_TICKS} ticks, homing or straight`, () => {
    const ctx = fixture(
      [at(600, 0)],
      [
        {
          on: 'hit',
          do: [
            projectiles({ count: 1, aim: 'target', from: 'player' }),
            projectiles({ count: 1, aim: 'radial', from: 'player' }),
          ],
        },
      ],
      { projectileSpeed: 60 },
    );
    fire(ctx, enemy(ctx, 1));
    const spawned = ctx.now;
    expect(ctx.shots.count).toBe(2);
    const counts: number[] = [];
    for (let t = 0; t < SMALL_PROJECTILE_TICKS; t++) {
      nextTick(ctx);
      counts.push(ctx.shots.count);
    }
    expect(ctx.now).toBe(spawned + SMALL_PROJECTILE_TICKS);
    expect(counts.slice(0, -1)).toEqual(Array(SMALL_PROJECTILE_TICKS - 1).fill(2));
    expect(counts.at(-1)).toBe(0);
    expect(eventsOf([ctx.events], 'hit')).toEqual([]);
  });

  it("'target' homes in and, its enemy dead, turns to the enemy nearest to it, not to its start; else fizzles (C14)", () => {
    // 1 far right; 2 by the shot's path, 10 ticks out; 3 by the player, where the shot started.
    const ctx = fixture(
      [at(800, 0), at(240, 60), at(-60, 0)],
      [{ on: 'hit', do: [projectiles({ count: 1, aim: 'target', from: 'player' })] }],
    );
    fire(ctx, enemy(ctx, 1));
    const inbound = (): number[] => ctx.enemies.map((e) => e.inbound);
    for (let t = 0; t < 10; t++) {
      nextTick(ctx);
      expect(inbound()).toEqual([0, 0, 0]);
    }
    expect(ctx.shots.x[0]).toBeCloseTo(PLAYER.x + 10 * ctx.projectileStep, 9);
    expect(ctx.shots.y[0]).toBe(PLAYER.y);
    removeEnemy(ctx, enemy(ctx, 1));
    nextTick(ctx);
    expect(ctx.shots.target[0]).toBe(enemy(ctx, 2));
    expect(inbound()).toEqual([0, 0, 0]);
    removeEnemy(ctx, enemy(ctx, 2));
    removeEnemy(ctx, enemy(ctx, 3));
    nextTick(ctx);
    expect(ctx.shots.count).toBe(0);
    expect(eventsOf([ctx.events], 'hit')).toEqual([]);
  });

  it("'target' hits its enemy once on arrival, never an enemy in its way, and leaves inbound alone", () => {
    const ctx = fixture(
      [at(300, 0), at(150, 0)],
      [{ on: 'hit', do: [projectiles({ count: 2, aim: 'target', from: 'player' })] }],
    );
    fire(ctx, enemy(ctx, 1));
    const hits = fly(ctx);
    expect(hits.map((hit) => hit.targetId)).toEqual([1, 1]);
    expect(ctx.enemies.map((e) => e.inbound)).toEqual([0, 0]);
  });
});

describe('projectiles: hits', () => {
  it('are tagged hit, trigger and projectile with its tags and element, and credited to the trigger’s source', () => {
    const ctx = fixture(
      [at(300, 0)],
      [
        {
          on: 'hit',
          do: [
            projectiles({
              count: 1,
              aim: 'target',
              from: 'player',
              damagePct: 0.25,
              tags: ['chain'],
              element: 'cold',
            }),
          ],
        },
      ],
      { damage: 40 },
    );
    const barrage = ctx.sources.index('outer.barrage');
    fire(ctx, enemy(ctx, 1));
    const [hit, ...more] = fly(ctx);
    expect(more).toEqual([]);
    expect(hit?.tags).toBe(TAG.hit | TAG.trigger | TAG.projectile | TAG.chain | TAG.cold);
    expect(hit?.source).toBe(barrage);
    expect(toNumber(hit?.amount ?? ZERO)).toBeCloseTo(10, 9);
    expect(ctx.bySource[barrage]).toBe(hit?.amount);
  });

  it('carry the entry’s depth and origin: their hit triggers queue one deeper, and never the shot’s own (rules 3 and 6)', () => {
    /**
     * [depth, origin] of each entry queued once the shot of a trigger fired at `depth` lands,
     * and the triggers the depth cap stopped.
     */
    const queued = (depth: number): { seen: number[][]; capped: number } => {
      const ctx = fixture(
        [at(300, 0)],
        [
          { on: 'hit', do: [projectiles({ count: 1, aim: 'target', from: 'player' })] },
          { on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] },
        ],
      );
      fire(ctx, enemy(ctx, 1), { depth });
      expect([ctx.shots.depth[0], ctx.shots.origin[0]]).toEqual([depth + 1, FIRST]);
      expect(fly(ctx)).toHaveLength(1);
      const entry = createEffectEntry();
      const seen: number[][] = [];
      while (ctx.effectQueue.size > 0) {
        dequeue(ctx.effectQueue, entry);
        seen.push([entry.depth, entry.origin]);
      }
      return { seen, capped: ctx.counters.triggerDepthCapped };
    };
    expect(queued(0)).toEqual({ seen: [[2, FIRST + 1]], capped: 0 });
    expect(queued(1)).toEqual({ seen: [[3, FIRST + 1]], capped: 0 });
    // At MAX_DEPTH (3) its hit fires nothing: its event is counted once at the cap.
    expect(queued(2)).toEqual({ seen: [], capped: 1 });
  });

  it('are no attack and never a fan round’s primary (K15): round −1, no PRIMARY, no chain', () => {
    const ctx = fixture(
      [at(300, 0), at(340, 0)],
      [
        {
          on: 'hit',
          do: [
            projectiles({ count: 2, aim: 'target', from: 'player' }),
            projectiles({ count: 2, aim: 'radial', from: 'player', pierce: -1 }),
          ],
        },
        { on: 'hit', when: [{ hitIs: 'primary' }], do: [{ kind: 'heal', lifePct: 0.01 }] },
        { on: 'hit', when: [{ hitIs: 'signature' }], do: [{ kind: 'heal', lifePct: 0.01 }] },
      ],
      { chainCount: 3, chainRange: 500 },
    );
    const serial = ctx.attackSerial;
    fire(ctx, enemy(ctx, 1));
    expect(rows(ctx).map((row) => [row.round, row.owner])).toEqual(Array(4).fill([-1, -1]));
    const hits = fly(ctx);
    // Two homing hits on 1; the +x shot pierces 1 and 2.
    expect(hits.map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(ctx.effectQueue.size).toBe(0);
    expect(ctx.attackSerial).toBe(serial);
    expect(ctx.chainBudget.hits).toBe(0);
  });

  it('roll crits and ailments on the effects stream: spawning draws nothing, and the combat stream nothing', () => {
    const ring = [at(200, 0), at(0, 200), at(-200, 0), at(0, -200)];
    const ctx = fixture(
      ring,
      [
        {
          on: 'periodic',
          every: 1,
          do: [projectiles({ count: 4, aim: 'radial', from: 'player' })],
        },
      ],
      { critChance: 0.5, igniteChance: 1 },
    );
    const before = rngPositions(ctx);
    fire(ctx, null);
    expect(rngPositions(ctx)).toEqual(before);
    expect(fly(ctx)).toHaveLength(4);
    const after = rngPositions(ctx);
    expect(after.effects).not.toEqual(before.effects);
    expect({ ...after, effects: before.effects }).toEqual(before);
    for (const e of ctx.enemies) expect(liveBurnStacks(e, ctx.now)).toBe(1);
  });
});

describe('projectiles: compile', () => {
  it('tags its hits hit, trigger and projectile plus its tags and element, at damage × damagePct × coef', () => {
    const fx = compileEffect(
      projectiles({ count: 2, aim: 'fan', damagePct: 0.4, tags: ['area'], element: 'lightning' }),
      3,
      0.5,
      100,
    );
    expect(fx.tags).toBe(TAG.hit | TAG.trigger | TAG.projectile | TAG.area | TAG.lightning);
    expect(toNumber(fx.baseDamage)).toBeCloseTo(20, 12);
    expect(fx.spec).toMatchObject({ kind: 'projectiles', count: 2, damagePct: 0.2 });
    expect([fx.source, fx.radiusSq, fx.fanout, fx.atTarget, fx.atPlayer]).toEqual([
      3,
      0,
      false,
      false,
      false,
    ]);
  });

  it('gets an effect payload that crits and rolls ailments on the effects stream, with no flags or chain', () => {
    const ctx = fixture([], [{ on: 'hit', do: [projectiles({ count: 1, aim: 'radial' })] }]);
    const t = ctx.build.triggers[FIRST] as CompiledTrigger;
    const p = ctx.effectPayloads[t.effectStart] as Payload;
    expect(p).toMatchObject({
      source: ctx.sources.index('outer.barrage'),
      flags: 0,
      chains: false,
      canCrit: true,
      rollsAilments: true,
    });
    expect(p.rng).toBe(ctx.effectsRng);
  });
});
