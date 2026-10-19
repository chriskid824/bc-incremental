import { describe, expect, it } from 'vitest';
import { mul, num, toNumber, ZERO } from '../../core/num';
import { createRng } from '../../core/rng';
import type { StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { CoinHitSpec, SlashLineSpec, TriggerSpec } from '../../data/triggers';
import { liveBurnStacks } from '../ailments/records';
import { IGNORE_ARMOUR, IGNORE_SHIELD, ROWS } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import type { Enemy, RunContext } from '../systems/context';
import { removeEnemy } from '../systems/death';
import { eventsOf, makeStats, placedEnemies, rngPositions, segDistSqRef } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { raiseFreeze } from './centerEvents';
import { fireOne } from './dispatch';
import { runEffect, runEffectQueue } from './execute';
import { HIT_EVENT, PRIMARY } from './flags';
import { createEffectEntry, dequeue } from './queue';
import { compileEffect, SHATTER_TRIGGER } from './types';
import type { CompiledTrigger } from './types';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;
type SlashEvent = Extract<SimEvent, { type: 'slash' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y + dy,
  ...more,
});

/** The build's first data trigger, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

const NO_ROLLS = { critChance: 0, igniteChance: 0 };

/** Fired by fire() as a primary hit; the effects' own hits never are, so they fire it no more. */
const PRIMARY_HIT = [{ hitIs: 'primary' }] as const;

const slash = (
  spec: Partial<Omit<SlashLineSpec, 'kind' | 'toward'>> & Pick<SlashLineSpec, 'toward'>,
): SlashLineSpec => ({ kind: 'slashLine', length: 300, width: 20, damagePct: 0.5, ...spec });

const coin = (spec: Partial<Omit<CoinHitSpec, 'kind'>> = {}): CoinHitSpec => ({
  kind: 'coinHit',
  multiplier: 10,
  ...spec,
});

/** `placed` with these triggers of outer.barrage; `values` over NO_ROLLS. */
function fixture(
  placed: readonly PlacedEnemy[],
  triggers: readonly TriggerSpec[],
  values: Partial<Record<StatId, number>> = {},
  modules?: readonly TestModule[],
): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...values }, [], {
      triggers: triggers.map((spec) => ({ source: 'outer.barrage', spec })),
      conversions: [],
      emitters: [],
    }),
    ...(modules === undefined ? {} : { modules }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/**
 * Fires trigger `i` (FIRST by default) as a primary hit on `target` at its position, or with no
 * target at the player, or at (x, y) when given, at `depth` from `origin`; then runs the effect
 * phase, its events alone in ctx.events.
 */
function fire(
  ctx: RunContext,
  target: Enemy | null,
  {
    i = FIRST,
    depth = 0,
    origin = -1,
    x,
    y,
  }: { i?: number; depth?: number; origin?: number; x?: number; y?: number } = {},
): void {
  ctx.events.length = 0;
  const px = x ?? (target === null ? ctx.player.x : target.x);
  const py = y ?? (target === null ? ctx.player.y : target.y);
  const flags = target === null ? 0 : HIT_EVENT | PRIMARY;
  fireOne(ctx, i, depth, origin, target, px, py, flags, ZERO, -1);
  runEffectQueue(ctx);
}

const hits = (ctx: RunContext): HitEvent[] => eventsOf([ctx.events], 'hit');
const hitIds = (ctx: RunContext): number[] => hits(ctx).map((hit) => hit.targetId);
const slashes = (ctx: RunContext): SlashEvent[] => eventsOf([ctx.events], 'slash');

/** The payload of the first effect of trigger `i`. */
const payloadOf = (ctx: RunContext, i = FIRST): Payload => {
  const t = ctx.build.triggers[i] as CompiledTrigger;
  return ctx.effectPayloads[t.effectStart] as Payload;
};

/**
 * Reference: where a slash of `spec` fired on `target` (null for none) at (x, y) starts and
 * which way it runs, as SlashLineSpec documents it, by a scan of every enemy; null when it has
 * no direction.
 */
function slashRef(
  ctx: RunContext,
  spec: SlashLineSpec,
  target: Enemy | null,
  x: number,
  y: number,
): { ax: number; ay: number; ux: number; uy: number } | null {
  const live = target !== null && target.alive ? target : null;
  let ax = x;
  let ay = y;
  if (spec.from === 'target') {
    if (live === null) return null;
    ax = live.x;
    ay = live.y;
  }
  let to: { x: number; y: number } | null;
  if (spec.toward === 'outward') {
    to = { x: 2 * ax - ctx.player.x, y: 2 * ay - ctx.player.y };
  } else if (spec.toward === 'nearest') {
    const d = (e: Enemy): number => (e.x - ax) ** 2 + (e.y - ay) ** 2;
    const others = ctx.enemies.filter((e) => e.alive && d(e) > 1);
    others.sort((a, b) => d(a) - d(b) || a.id - b.id);
    to = others[0] ?? null;
  } else {
    to = live;
  }
  if (to === null) return null;
  const dx = to.x - ax;
  const dy = to.y - ay;
  if (dx === 0 && dy === 0) return null;
  const norm = Math.hypot(dx, dy);
  return { ax, ay, ux: dx / norm, uy: dy / norm };
}

/** Reference: the alive enemies within width / 2 + their radius of the slash, in id order. */
const reachedRef = (ctx: RunContext, s: SlashEvent): number[] =>
  ctx.enemies
    .filter((e) => {
      const reach = s.width / 2 + e.radius;
      return e.alive && segDistSqRef(e.x, e.y, s.x1, s.y1, s.x2, s.y2) <= reach * reach;
    })
    .map((e) => e.id);

describe('slashLine: geometry', () => {
  it('hits each enemy within width / 2 + its radius of the line once, in id order, as a brute-force reference does, tough ones outside the box included (R22)', () => {
    const rng = createRng(1313);
    const types = ['square', 'triangle', 'shard', 'hexagon', 'boss'] as const;
    let slashed = 0;
    let hitCount = 0;
    let toughOutside = 0;
    for (let round = 0; round < 400; round++) {
      const n = 1 + rng.int(60);
      const placed: PlacedEnemy[] = [];
      for (let i = 0; i < n; i++) {
        const type = rng.pick(types);
        const tough = type === 'hexagon' || type === 'boss';
        placed.push({
          // Coarse positions around the player, so enemies share points, sit on box edges and
          // on the player.
          x: PLAYER.x + (rng.int(31) - 15) * 20,
          y: PLAYER.y + (rng.int(21) - 10) * 20,
          type,
          // A tough enemy can be far larger than the pad; the others stay within ctx.shotPad.
          radius: tough ? 10 + rng.int(150) : 4 + rng.int(19),
        });
      }
      const spec = slash({
        toward: rng.pick(['outward', 'nearest', 'eventTarget'] as const),
        ...(rng.chance(0.5) ? { from: 'target' as const } : {}),
        length: 20 + rng.int(800),
        width: 2 + rng.int(80),
      });
      // A hit trigger, and the same slash on a targetless event for the draws without a target.
      const ctx = fixture(placed, [
        { on: 'hit', when: PRIMARY_HIT, do: [spec] },
        { on: 'heroHit', do: [spec] },
      ]);
      for (const e of ctx.enemies) if (rng.chance(0.15)) e.alive = false;
      if (rng.chance(0.5)) ctx.grid.sortNow();
      const target = rng.chance(0.85) ? enemy(ctx, 1 + rng.int(n)) : null;
      const onTarget = target !== null && rng.chance(0.5);
      const x = onTarget ? target.x : PLAYER.x + (rng.int(31) - 15) * 20;
      const y = onTarget ? target.y : PLAYER.y + (rng.int(21) - 10) * 20;
      const label = JSON.stringify({ round, spec, target: target?.id ?? null, x, y });
      const ref = slashRef(ctx, spec, target, x, y);
      fire(ctx, target, { x, y, i: target === null ? FIRST + 1 : FIRST });
      const events = slashes(ctx);
      if (ref === null) {
        expect(events, label).toEqual([]);
        expect(hits(ctx), label).toEqual([]);
        continue;
      }
      slashed++;
      expect(events, label).toHaveLength(1);
      const s = events[0] as SlashEvent;
      expect([s.x1, s.y1, s.width], label).toEqual([ref.ax, ref.ay, spec.width]);
      expect(s.x2, label).toBeCloseTo(ref.ax + ref.ux * spec.length, 9);
      expect(s.y2, label).toBeCloseTo(ref.ay + ref.uy * spec.length, 9);
      const expected = reachedRef(ctx, s);
      expect(hitIds(ctx), label).toEqual(expected);
      hitCount += expected.length;
      const pad = spec.width / 2 + ctx.shotPad;
      for (const id of expected) {
        const e = enemy(ctx, id);
        const outside =
          e.x < Math.min(s.x1, s.x2) - pad ||
          e.x > Math.max(s.x1, s.x2) + pad ||
          e.y < Math.min(s.y1, s.y2) - pad ||
          e.y > Math.max(s.y1, s.y2) + pad;
        if (outside) {
          expect(e.tough, label).toBe(true);
          toughOutside++;
        }
      }
    }
    // Coverage: most rounds slash, and many of their hits are tough enemies outside the box.
    expect(slashed).toBeGreaterThan(200);
    expect(hitCount).toBeGreaterThan(700);
    expect(toughOutside).toBeGreaterThan(150);
  });

  it('reaches width / 2 + the radius from the line, ends included, a tough enemy outside the padded box too, linear or sorted', () => {
    // From enemy 1, 100 right of the player, outward along +x to 400 right: half width 10, so
    // the box is padded by 10 + ctx.shotPad (22).
    const placed = [
      at(100, 0),
      // A square (20) 30 off the line is reached exactly; at 30.5 it is not.
      at(250, 30),
      at(260, -30.5),
      // 25 off: its centre is outside a box padded by the half width alone.
      at(200, -25),
      // Beyond the far end by 30 along the line, and behind the start by 31.
      at(430, 0),
      at(69, 0),
      // A boss (70) 75 off, its centre outside the padded box: reached; a hexagon (34) 45
      // off: not.
      at(300, 75, { type: 'boss' }),
      at(150, -45, { type: 'hexagon' }),
      // A tough one inside the box is listed once.
      at(350, 5, { type: 'hexagon' }),
    ];
    for (const sorted of [false, true]) {
      const ctx = fixture(placed, [
        { on: 'hit', when: PRIMARY_HIT, do: [slash({ toward: 'outward', from: 'target' })] },
      ]);
      expect(ctx.shotPad).toBe(22);
      if (sorted) ctx.grid.sortNow();
      fire(ctx, enemy(ctx, 1));
      expect(slashes(ctx)).toEqual([
        {
          type: 'slash',
          x1: PLAYER.x + 100,
          y1: PLAYER.y,
          x2: PLAYER.x + 400,
          y2: PLAYER.y,
          width: 20,
        },
      ]);
      expect(hitIds(ctx), `sorted ${sorted}`).toEqual([1, 2, 4, 5, 7, 9]);
    }
  });

  it('lists a tough enemy whose centre lies exactly on the padded box’s edge once, linear or sorted', () => {
    // From enemy 1, 100 right of the player, outward to 400 right: the box, padded by 10 + 22,
    // spans x from 68 to 432 and y from −32 to 32 off the player. A boss (70) sits on its left
    // edge, a hexagon (34) on its bottom edge and another on its right edge: each is in the box
    // (bounds inclusive), so the tough pass must not list it again.
    const placed = [
      at(100, 0),
      at(68, 0, { type: 'boss' }),
      at(300, 32, { type: 'hexagon' }),
      at(432, 0, { type: 'hexagon' }),
    ];
    for (const sorted of [false, true]) {
      const ctx = fixture(placed, [
        { on: 'hit', when: PRIMARY_HIT, do: [slash({ toward: 'outward', from: 'target' })] },
      ]);
      expect(ctx.shotPad).toBe(22);
      if (sorted) ctx.grid.sortNow();
      fire(ctx, enemy(ctx, 1));
      const [s] = slashes(ctx);
      expect([s?.x1, s?.x2, s?.y1, s?.y2]).toEqual([
        PLAYER.x + 100,
        PLAYER.x + 400,
        PLAYER.y,
        PLAYER.y,
      ]);
      expect(hitIds(ctx), `sorted ${sorted}`).toEqual([1, 2, 3, 4]);
    }
  });

  it('hits in id order: the tough ones outside the box merged with the others', () => {
    // Ids 1 (start), 2 tough far off the line, 3 on it, 4 tough off it, 5 on it.
    const placed = [
      at(100, 0),
      at(150, 80, { type: 'boss' }),
      at(200, 0),
      at(250, -70, { type: 'boss' }),
      at(300, 0),
    ];
    const ctx = fixture(placed, [
      { on: 'hit', when: PRIMARY_HIT, do: [slash({ toward: 'outward' })] },
    ]);
    ctx.grid.sortNow();
    fire(ctx, enemy(ctx, 1));
    expect(hitIds(ctx)).toEqual([1, 2, 3, 4, 5]);
  });

  it('passes over an enemy that died earlier in the slash, and never reaches the children of its kills', () => {
    // Enemy 1's hit kills 3 (an onHit hook); 2, a pentagon of 1 hp, dies and splits on the line.
    let killed = false;
    const module: TestModule = (b) =>
      b.hook('onHit', (ctx, hit) => {
        if (hit.target.id === 1 && !killed) {
          killed = true;
          removeEnemy(ctx, ctx.enemies[2] as Enemy);
        }
      });
    const ctx = fixture(
      [at(100, 0), at(200, 0, { type: 'pentagon', hp: 1 }), at(300, 0), at(350, 0)],
      [{ on: 'hit', when: PRIMARY_HIT, do: [slash({ toward: 'outward', damagePct: 1 })] }],
      { damage: 10 },
      [module],
    );
    const before = ctx.enemies.length;
    fire(ctx, enemy(ctx, 1));
    expect(killed).toBe(true);
    expect(ctx.enemies.length).toBeGreaterThan(before);
    expect(hitIds(ctx)).toEqual([1, 2, 4]);
  });
});

describe('slashLine: directions', () => {
  it("'outward' runs from the event's point straight away from the player", () => {
    const ctx = fixture(
      [at(-30, 40), at(-60, 80)],
      [{ on: 'hit', when: PRIMARY_HIT, do: [slash({ toward: 'outward', length: 100 })] }],
    );
    fire(ctx, enemy(ctx, 1));
    const [s] = slashes(ctx);
    expect([s?.x1, s?.y1]).toEqual([PLAYER.x - 30, PLAYER.y + 40]);
    expect(s?.x2).toBeCloseTo(PLAYER.x - 90, 9);
    expect(s?.y2).toBeCloseTo(PLAYER.y + 120, 9);
    expect(hitIds(ctx)).toEqual([1, 2]);
  });

  it("'outward' from the player has no direction: no slash, no hit, no draw", () => {
    const ctx = fixture(
      [at(0, 0), at(100, 0)],
      [{ on: 'periodic', every: 1, do: [slash({ toward: 'outward' })] }],
      { critChance: 0.5, igniteChance: 0.5 },
    );
    const before = rngPositions(ctx);
    fire(ctx, null);
    expect(ctx.events).toEqual([]);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it("'nearest' runs at the alive enemy nearest to its start, but those within 1 of it, ties to the lower id", () => {
    // From 1: 2 sits 0.5 off it, 3 (dead) 50 away, 4 and 5 both 100 away.
    const placed = [at(200, 0), at(200.5, 0), at(200, 50), at(200, -100), at(300, 0)];
    const ctx = fixture(placed, [
      { on: 'hit', when: PRIMARY_HIT, do: [slash({ toward: 'nearest', length: 150 })] },
    ]);
    removeEnemy(ctx, enemy(ctx, 3));
    fire(ctx, enemy(ctx, 1));
    expect(slashes(ctx)).toEqual([
      {
        type: 'slash',
        x1: PLAYER.x + 200,
        y1: PLAYER.y,
        x2: PLAYER.x + 200,
        y2: PLAYER.y - 150,
        width: 20,
      },
    ]);
    expect(hitIds(ctx)).toEqual([1, 2, 4]);
    // From a point off every enemy: the nearest is its event's enemy, 1.
    fire(ctx, enemy(ctx, 1), { x: PLAYER.x + 200, y: PLAYER.y + 300 });
    const [s] = slashes(ctx);
    expect([s?.x2, s?.y2]).toEqual([PLAYER.x + 200, PLAYER.y + 150]);
  });

  it("'nearest' with no other enemy does nothing", () => {
    const ctx = fixture(
      [at(200, 0), at(400, 0)],
      [{ on: 'hit', when: PRIMARY_HIT, do: [slash({ toward: 'nearest' })] }],
    );
    removeEnemy(ctx, enemy(ctx, 2));
    fire(ctx, enemy(ctx, 1));
    expect(ctx.events).toEqual([]);
  });

  it("'eventTarget' runs from the event's point at the enemy a selector picked; at its own point, or dead, it does nothing", () => {
    // 1 is hit; 3, 100 below it, is the nearest other enemy; 2 lies beyond it, 200 below.
    const ctx = fixture(
      [at(300, 0), at(300, 200), at(300, 100), at(500, 0)],
      [
        {
          on: 'hit',
          when: PRIMARY_HIT,
          target: { pick: 'nearest', excludeEventTarget: true },
          do: [slash({ toward: 'eventTarget', length: 50 })],
        },
        { on: 'hit', when: PRIMARY_HIT, do: [slash({ toward: 'eventTarget' })] },
      ],
    );
    fire(ctx, enemy(ctx, 1));
    // The selector picks 3 (100 below), the nearest other enemy.
    expect(slashes(ctx)).toEqual([
      {
        type: 'slash',
        x1: PLAYER.x + 300,
        y1: PLAYER.y,
        x2: PLAYER.x + 300,
        y2: PLAYER.y + 50,
        width: 20,
      },
    ]);
    expect(hitIds(ctx)).toEqual([1]);
    // Without a selector, its event's enemy is where it starts.
    fire(ctx, enemy(ctx, 1), { i: FIRST + 1 });
    expect(ctx.events).toEqual([]);
    // At a dead enemy: nothing.
    const four = enemy(ctx, 4);
    fireOne(ctx, FIRST + 1, 0, -1, four, PLAYER.x, PLAYER.y, HIT_EVENT | PRIMARY, ZERO, -1);
    removeEnemy(ctx, four);
    ctx.events.length = 0;
    runEffectQueue(ctx);
    expect(ctx.events).toEqual([]);
    // From the player at a live one: up to it.
    fire(ctx, enemy(ctx, 1), { i: FIRST + 1, x: PLAYER.x, y: PLAYER.y });
    expect(hitIds(ctx)).toEqual([1]);
    const [s] = slashes(ctx);
    expect([s?.x1, s?.y1, s?.x2, s?.y2]).toEqual([PLAYER.x, PLAYER.y, PLAYER.x + 300, PLAYER.y]);
  });

  it("from 'target' starts at the live target, not the event's point, and does nothing once it is dead", () => {
    const ctx = fixture(
      [at(100, 0), at(-200, 0), at(-350, 0)],
      [
        {
          on: 'hit',
          when: PRIMARY_HIT,
          target: { pick: 'farthest' },
          do: [slash({ toward: 'outward', from: 'target', length: 100 })],
        },
      ],
    );
    fire(ctx, enemy(ctx, 1));
    // 3 is the farthest from 1: the slash runs from 3 away from the player, hitting only 3.
    expect(slashes(ctx)).toEqual([
      {
        type: 'slash',
        x1: PLAYER.x - 350,
        y1: PLAYER.y,
        x2: PLAYER.x - 450,
        y2: PLAYER.y,
        width: 20,
      },
    ]);
    expect(hitIds(ctx)).toEqual([3]);
    const three = enemy(ctx, 3);
    ctx.events.length = 0;
    fireOne(
      ctx,
      FIRST,
      0,
      -1,
      enemy(ctx, 1),
      PLAYER.x + 100,
      PLAYER.y,
      HIT_EVENT | PRIMARY,
      ZERO,
      -1,
    );
    removeEnemy(ctx, three);
    runEffectQueue(ctx);
    expect(ctx.events).toEqual([]);
  });
});

describe('slashLine: hits', () => {
  it('are tagged hit and trigger plus its tags, at damage × damagePct, credited to the trigger’s source, after the slash event', () => {
    const ctx = fixture(
      [at(100, 0), at(200, 0)],
      [
        {
          on: 'hit',
          when: PRIMARY_HIT,
          do: [slash({ toward: 'outward', damagePct: 0.25, tags: ['chain'] })],
        },
      ],
      { damage: 40 },
    );
    const barrage = ctx.sources.index('outer.barrage');
    fire(ctx, enemy(ctx, 1));
    expect(ctx.events.map((event) => event.type)).toEqual(['slash', 'hit', 'hit']);
    for (const hit of hits(ctx)) {
      expect(hit.tags).toBe(TAG.hit | TAG.trigger | TAG.chain);
      expect(hit.source).toBe(barrage);
      expect(hit.crit).toBe(false);
      expect([hit.chainIndex, hit.fromX, hit.fromY]).toEqual([0, null, null]);
      expect(toNumber(hit.amount)).toBeCloseTo(10, 9);
    }
  });

  it('always crit with alwaysCrit, their crit roll still drawn on the effects stream', () => {
    const placed = [at(100, 0), at(200, 0), at(300, 0)];
    const run = (alwaysCrit: boolean): { crits: boolean[]; amounts: number[]; ctx: RunContext } => {
      const ctx = fixture(
        placed,
        [
          {
            on: 'hit',
            when: PRIMARY_HIT,
            do: [slash({ toward: 'outward', alwaysCrit, damagePct: 1 })],
          },
        ],
        { damage: 10, critChance: 1e-9, critMultiplier: 3 },
      );
      const before = rngPositions(ctx).effects;
      fire(ctx, enemy(ctx, 1));
      expect(rngPositions(ctx).effects).not.toEqual(before);
      return {
        crits: hits(ctx).map((hit) => hit.crit),
        amounts: hits(ctx).map((hit) => toNumber(hit.amount)),
        ctx,
      };
    };
    const forced = run(true);
    const rolled = run(false);
    expect(forced.crits).toEqual([true, true, true]);
    expect(forced.amounts).toEqual([30, 30, 30]);
    expect(rolled.crits).toEqual([false, false, false]);
    expect(rngPositions(forced.ctx)).toEqual(rngPositions(rolled.ctx));
  });

  it(`scales its base by 1 + critScale × the crit chance, read once: × 1.3 exactly at critChance .3 and critScale 1`, () => {
    const scaled = (critScale: number | undefined, critChance: number): number => {
      const ctx = fixture(
        [],
        [
          {
            on: 'hit',
            do: [
              slash({
                toward: 'outward',
                damagePct: 1,
                ...(critScale === undefined ? {} : { critScale }),
              }),
            ],
          },
        ],
        { damage: 10, critChance },
      );
      const t = ctx.build.triggers[FIRST] as CompiledTrigger;
      const fx = ctx.build.effects[t.effectStart];
      expect(toNumber(fx?.baseDamage ?? ZERO)).toBe(10);
      return toNumber(payloadOf(ctx).baseDamage);
    };
    expect(1 + 1 * 0.3).toBe(1.3);
    expect(scaled(1, 0.3)).toBe(10 * 1.3);
    expect(scaled(2, 0.3)).toBe(10 * 1.6);
    expect(scaled(0, 0.3)).toBe(10);
    expect(scaled(undefined, 0.3)).toBe(10);
    expect(scaled(1, 0)).toBe(10);
    // The crit chance as the simulation clamps it, to [0, 1].
    expect(scaled(1, 1.5)).toBe(20);
    expect(scaled(1, -0.5)).toBe(10);
  });

  it('deals the critScale share on every hit: a forced crit at critChance .3 is base × 1.3 × critMultiplier', () => {
    const ctx = fixture(
      [at(100, 0)],
      [
        {
          on: 'hit',
          when: PRIMARY_HIT,
          do: [slash({ toward: 'outward', damagePct: 1, alwaysCrit: true, critScale: 1 })],
        },
      ],
      { damage: 10, critChance: 0.3, critMultiplier: 2 },
    );
    fire(ctx, enemy(ctx, 1));
    const [hit] = hits(ctx);
    expect(hit?.amount).toEqual(mul(num(10 * 1.3), 2));
  });

  it('roll crits and ailments on the effects stream, and the combat stream nothing', () => {
    const ctx = fixture(
      [at(100, 0), at(200, 0), at(300, 0)],
      [{ on: 'hit', when: PRIMARY_HIT, do: [slash({ toward: 'outward' })] }],
      { critChance: 0.5, igniteChance: 1 },
    );
    const before = rngPositions(ctx);
    fire(ctx, enemy(ctx, 1));
    expect(hits(ctx)).toHaveLength(3);
    const after = rngPositions(ctx);
    expect(after.effects).not.toEqual(before.effects);
    expect({ ...after, effects: before.effects }).toEqual(before);
    for (const e of ctx.enemies) expect(liveBurnStacks(e, ctx.now)).toBe(1);
  });

  it('carry the entry’s depth and origin: their hit triggers queue one deeper (rules 3 and 6)', () => {
    /**
     * [depth, origin] of each entry queued once the slash of a trigger fired at `depth` runs,
     * and the triggers the depth cap stopped.
     */
    const queued = (depth: number): { seen: number[][]; capped: number } => {
      const ctx = fixture(
        [at(100, 0), at(200, 0)],
        [
          { on: 'hit', when: PRIMARY_HIT, do: [slash({ toward: 'outward' })] },
          { on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] },
        ],
      );
      const one = enemy(ctx, 1);
      fireOne(ctx, FIRST, depth, -1, one, one.x, one.y, HIT_EVENT | PRIMARY, ZERO, -1);
      const entry = createEffectEntry();
      dequeue(ctx.effectQueue, entry);
      expect([entry.depth, entry.origin, ctx.effectQueue.size]).toEqual([depth + 1, FIRST, 0]);
      ctx.events.length = 0;
      runEffect(ctx, entry);
      expect(hitIds(ctx)).toEqual([1, 2]);
      const seen: number[][] = [];
      while (ctx.effectQueue.size > 0) {
        dequeue(ctx.effectQueue, entry);
        seen.push([entry.depth, entry.origin]);
      }
      return { seen, capped: ctx.counters.triggerDepthCapped };
    };
    expect(queued(0)).toEqual({
      seen: [
        [2, FIRST + 1],
        [2, FIRST + 1],
      ],
      capped: 0,
    });
    expect(queued(1)).toEqual({
      seen: [
        [3, FIRST + 1],
        [3, FIRST + 1],
      ],
      capped: 0,
    });
    // At MAX_DEPTH (3) its hits fire nothing: each event is counted once at the cap.
    expect(queued(2)).toEqual({ seen: [], capped: 2 });
  });
});

describe('slashLine: compile and payload', () => {
  it('tags its hits hit and trigger plus its tags, at damage × damagePct × coef; critScale takes no coef', () => {
    const fx = compileEffect(
      slash({ toward: 'nearest', damagePct: 0.4, critScale: 2, tags: ['area', 'cold'] }),
      3,
      0.5,
      100,
    );
    expect(fx.tags).toBe(TAG.hit | TAG.trigger | TAG.area | TAG.cold);
    expect(toNumber(fx.baseDamage)).toBeCloseTo(20, 12);
    expect(fx.spec).toMatchObject({ kind: 'slashLine', damagePct: 0.2, critScale: 2, length: 300 });
    expect([fx.source, fx.radiusSq, fx.fanout, fx.atTarget, fx.atPlayer]).toEqual([
      3,
      0,
      false,
      false,
      false,
    ]);
  });

  it('gets an effect payload that crits and rolls ailments on the effects stream, with no flags, chain or bypass', () => {
    const ctx = fixture([], [{ on: 'hit', do: [slash({ toward: 'outward', critScale: 1 })] }]);
    const p = payloadOf(ctx);
    expect(p).toMatchObject({
      source: ctx.sources.index('outer.barrage'),
      flags: 0,
      chains: false,
      canCrit: true,
      rollsAilments: true,
      damageMode: ROWS,
      aggregate: false,
      bypass: 0,
    });
    expect(p.rng).toBe(ctx.effectsRng);
  });
});

describe('coinHit', () => {
  it('hits its live target once at damage × multiplier, tagged hit and trigger, after a coin event at it', () => {
    const ctx = fixture(
      [at(100, 0), at(140, 0)],
      [{ on: 'hit', when: PRIMARY_HIT, do: [coin()] }],
      { damage: 7 },
    );
    const barrage = ctx.sources.index('outer.barrage');
    const two = enemy(ctx, 2);
    fire(ctx, two, { x: PLAYER.x, y: PLAYER.y });
    expect(ctx.events.map((event) => event.type)).toEqual(['coin', 'hit']);
    expect(ctx.events[0]).toEqual({ type: 'coin', x: two.x, y: two.y, targetId: 2 });
    const [hit] = hits(ctx);
    expect(hit).toMatchObject({ targetId: 2, tags: TAG.hit | TAG.trigger, source: barrage });
    expect([hit?.crit, hit?.chainIndex, hit?.fromX, hit?.fromY]).toEqual([false, 0, null, null]);
    expect(hit?.amount).toEqual(mul(num(7), 10));
    expect(toNumber(two.hp)).toBe(1e12 - 70);
    expect(toNumber(enemy(ctx, 1).hp)).toBe(1e12);
  });

  it('scales its multiplier by the coefficient, and crits as any hit does', () => {
    const fx = compileEffect(coin({ multiplier: 10 }), 2, 0.5, 8);
    expect(fx.tags).toBe(TAG.hit | TAG.trigger);
    expect(toNumber(fx.baseDamage)).toBe(40);
    expect(fx.spec).toMatchObject({ kind: 'coinHit', multiplier: 5 });
    const ctx = fixture([at(100, 0)], [{ on: 'hit', when: PRIMARY_HIT, do: [coin()] }], {
      damage: 3,
      critChance: 1,
      critMultiplier: 2.5,
    });
    fire(ctx, enemy(ctx, 1));
    const [hit] = hits(ctx);
    expect(hit?.crit).toBe(true);
    expect(hit?.amount).toEqual(mul(mul(num(3), 10), 2.5));
  });

  it('hits the enemy a selector picked, and does nothing without a live one, drawing nothing', () => {
    const ctx = fixture(
      [at(100, 0), at(300, 0), at(-200, 0)],
      [
        { on: 'hit', when: PRIMARY_HIT, target: { pick: 'farthest' }, do: [coin()] },
        { on: 'heroHit', do: [coin()] },
      ],
      { critChance: 0.5, igniteChance: 0.5 },
    );
    fire(ctx, enemy(ctx, 1));
    expect(hitIds(ctx)).toEqual([3]);
    expect((ctx.events[0] as Extract<SimEvent, { type: 'coin' }>).targetId).toBe(3);
    // A targetless event without a selector: no target, no coin.
    let before = rngPositions(ctx);
    fire(ctx, null, { i: FIRST + 1 });
    expect(ctx.events).toEqual([]);
    expect(rngPositions(ctx)).toEqual(before);
    // Its target dead before it runs: nothing.
    const two = enemy(ctx, 2);
    fireOne(ctx, FIRST, 0, -1, two, two.x, two.y, HIT_EVENT | PRIMARY, ZERO, -1);
    removeEnemy(ctx, enemy(ctx, 3));
    before = rngPositions(ctx);
    ctx.events.length = 0;
    runEffectQueue(ctx);
    expect(ctx.events).toEqual([]);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('hits only the frozen enemy on a freeze, once: neither it nor a slash fans out over the list (D16; a freeze slash runs outward through it, Q12 (A))', () => {
    // 1 freezes; 2, 3 and 4 are within the freeze list's 90 of it, none within reach of the
    // slash's line.
    const ctx = fixture(
      [at(300, 0), at(330, 45), at(300, 60), at(240, -40)],
      [{ on: 'freeze', do: [coin(), slash({ toward: 'outward', length: 100 })] }],
      { damage: 7 },
    );
    const t = ctx.build.triggers[FIRST] as CompiledTrigger;
    expect(ctx.build.effects.slice(t.effectStart, t.effectEnd).map((fx) => fx.fanout)).toEqual([
      false,
      false,
    ]);
    ctx.events.length = 0;
    raiseFreeze(ctx, enemy(ctx, 1), 0, -1, 0);
    runEffectQueue(ctx);
    expect(eventsOf([ctx.events], 'coin').map((c) => c.targetId)).toEqual([1]);
    expect(slashes(ctx)).toEqual([
      {
        type: 'slash',
        x1: PLAYER.x + 300,
        y1: PLAYER.y,
        x2: PLAYER.x + 400,
        y2: PLAYER.y,
        width: 20,
      },
    ]);
    // The coin's hit on 1, then the slash's on 1 alone.
    expect(hitIds(ctx)).toEqual([1, 1]);
  });

  it('carries its bypass bits on its payload: IGNORE_SHIELD 1, IGNORE_ARMOUR 2, both 3, neither 0', () => {
    expect([IGNORE_SHIELD, IGNORE_ARMOUR]).toEqual([1, 2]);
    const bypass = (spec: Partial<Omit<CoinHitSpec, 'kind'>>): number =>
      payloadOf(fixture([], [{ on: 'hit', do: [coin(spec)] }])).bypass;
    expect(bypass({})).toBe(0);
    expect(bypass({ ignoreShield: false, ignoreArmour: false })).toBe(0);
    expect(bypass({ ignoreShield: true })).toBe(IGNORE_SHIELD);
    expect(bypass({ ignoreArmour: true })).toBe(IGNORE_ARMOUR);
    expect(bypass({ ignoreShield: true, ignoreArmour: true })).toBe(IGNORE_SHIELD | IGNORE_ARMOUR);
    // Every other payload: 0.
    const ctx = fixture(
      [],
      [
        {
          on: 'hit',
          do: [
            slash({ toward: 'outward' }),
            { kind: 'projectiles', count: 1, aim: 'radial', damagePct: 0.5 },
            { kind: 'explode', radius: 50, damagePct: 0.5 },
            coin({ ignoreShield: true, ignoreArmour: true }),
          ],
        },
      ],
    );
    const t = ctx.build.triggers[FIRST] as CompiledTrigger;
    const bits = ctx.effectPayloads
      .slice(t.effectStart, t.effectEnd)
      .map((p) => (p as Payload).bypass);
    expect(bits).toEqual([0, 0, 0, 3]);
    expect((ctx.emitters[0] as EmitterRuntime).payload.bypass).toBe(0);
  });

  it('rolls its crit and ailments on the effects stream, and the combat stream nothing', () => {
    const ctx = fixture([at(100, 0)], [{ on: 'hit', when: PRIMARY_HIT, do: [coin()] }], {
      critChance: 0.5,
      igniteChance: 1,
    });
    const before = rngPositions(ctx);
    fire(ctx, enemy(ctx, 1));
    expect(hits(ctx)).toHaveLength(1);
    const after = rngPositions(ctx);
    expect(after.effects).not.toEqual(before.effects);
    expect({ ...after, effects: before.effects }).toEqual(before);
    expect(liveBurnStacks(enemy(ctx, 1), ctx.now)).toBe(1);
  });

  it('carries the entry’s depth and origin: its hit’s triggers queue one deeper (rules 3 and 6)', () => {
    const queued = (depth: number): { seen: number[][]; capped: number } => {
      const ctx = fixture(
        [at(100, 0)],
        [
          { on: 'hit', when: PRIMARY_HIT, do: [coin()] },
          { on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] },
        ],
      );
      const one = enemy(ctx, 1);
      fireOne(ctx, FIRST, depth, -1, one, one.x, one.y, HIT_EVENT | PRIMARY, ZERO, -1);
      const entry = createEffectEntry();
      dequeue(ctx.effectQueue, entry);
      expect([entry.depth, entry.origin, ctx.effectQueue.size]).toEqual([depth + 1, FIRST, 0]);
      ctx.events.length = 0;
      runEffect(ctx, entry);
      expect(hitIds(ctx)).toEqual([1]);
      const seen: number[][] = [];
      while (ctx.effectQueue.size > 0) {
        dequeue(ctx.effectQueue, entry);
        seen.push([entry.depth, entry.origin]);
      }
      return { seen, capped: ctx.counters.triggerDepthCapped };
    };
    expect(queued(0)).toEqual({ seen: [[2, FIRST + 1]], capped: 0 });
    expect(queued(1)).toEqual({ seen: [[3, FIRST + 1]], capped: 0 });
    expect(queued(2)).toEqual({ seen: [], capped: 1 });
  });
});
