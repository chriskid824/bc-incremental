import { describe, expect, it } from 'vitest';
import { toNumber, ZERO } from '../../core/num';
import type { StatId } from '../../data/stats';
import { jumpMask, TAG } from '../../data/tags';
import type { ChainBoltSpec, TriggerSpec } from '../../data/triggers';
import { liveBurnStacks } from '../ailments/records';
import { activeShockStacks } from '../ailments/shock';
import { compileBuild } from '../build/compile';
import { CHAIN_HIT_CAP } from '../caps';
import { beginAttack } from '../combat/chain';
import { ROWS } from '../emitters/types';
import type { Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import type { Enemy, RunContext } from '../systems/context';
import { removeEnemy } from '../systems/death';
import { eventsOf, makeStats, placedEnemies, rngPositions } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { fireOne } from './dispatch';
import { runEffect, runEffectQueue } from './execute';
import { CHAIN_JUMP, HIT_EVENT, PRIMARY } from './flags';
import { createEffectEntry, dequeue } from './queue';
import { compileEffect, SHATTER_TRIGGER } from './types';
import type { CompiledTrigger } from './types';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y + dy,
  ...more,
});

/** `count` immortal squares on one line, 20 apart from 100 right of the player. */
const line = (count: number): PlacedEnemy[] =>
  Array.from({ length: count }, (_, i) => at(100 + 20 * i, 0));

/** `count` immortal squares on a grid of 20 per row, 20 apart: all within a long chain range. */
const rows = (count: number): PlacedEnemy[] =>
  Array.from({ length: count }, (_, i) => ({
    x: 100 + 20 * (i % 20),
    y: 100 + 20 * Math.floor(i / 20),
  }));

/** The build's first data trigger, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

const NO_ROLLS = { critChance: 0, igniteChance: 0 };

/** Fired by fire() as a primary hit; the bolts' own hits never are, so they fire it no more. */
const PRIMARY_HIT = [{ hitIs: 'primary' }] as const;

/** The tags of every hit of a bolt, its first one's and its jumps'. */
const BOLT = TAG.hit | TAG.trigger | TAG.chain | TAG.lightning;

const bolt = (spec: Partial<Omit<ChainBoltSpec, 'kind'>> = {}): ChainBoltSpec => ({
  kind: 'chainBolt',
  jumps: 2,
  damagePct: 1,
  ...spec,
});

/** A hit trigger of `spec` that its primary hits fire (fire()). */
const onPrimary = (spec: ChainBoltSpec): TriggerSpec => ({
  on: 'hit',
  when: PRIMARY_HIT,
  do: [spec],
});

/** `placed` with these triggers of outer.lightning; `values` over NO_ROLLS. */
function fixture(
  placed: readonly PlacedEnemy[],
  triggers: readonly TriggerSpec[],
  values: Partial<Record<StatId, number>> = {},
  modules?: readonly TestModule[],
): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...values }, [], {
      triggers: triggers.map((spec) => ({ source: 'outer.lightning', spec })),
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
const shocks = (ctx: RunContext): number[] => ctx.enemies.map((e) => activeShockStacks(e, ctx.now));

/** The payloads of the effects of trigger `i`. */
const payloadsOf = (ctx: RunContext, i = FIRST): Payload[] => {
  const t = ctx.build.triggers[i] as CompiledTrigger;
  return ctx.effectPayloads.slice(t.effectStart, t.effectEnd) as Payload[];
};

describe('chainBolt: its hits', () => {
  it('jumps 2 hits exactly 3 enemies, nearest first, and shocks each exactly once, after its hit (C4)', () => {
    // The target's shock stacks as each hit lands, before its own shock.
    const before: number[] = [];
    const module: TestModule = (b) =>
      b.hook('onHit', (c, hit) => {
        before.push(activeShockStacks(hit.target, c.now));
      });
    const ctx = fixture(
      line(6),
      [onPrimary(bolt({ jumps: 2, damagePct: 0.5, shockStacks: 1 }))],
      { damage: 10, chainRetention: 0.5 },
      [module],
    );
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    fire(ctx, one);
    expect(ctx.events.map((event) => event.type)).toEqual(['hit', 'hit', 'hit']);
    expect(hits(ctx).map((hit) => [hit.targetId, hit.chainIndex, hit.fromX, hit.fromY])).toEqual([
      [1, 0, null, null],
      [2, 1, one.x, one.y],
      [3, 2, two.x, two.y],
    ]);
    expect(before).toEqual([0, 0, 0]);
    expect(shocks(ctx)).toEqual([1, 1, 1, 0, 0, 0]);
    // No hit is amplified by the shock it then adds: × chainRetention per jump, and no more.
    expect(hits(ctx).map((hit) => toNumber(hit.amount))).toEqual([5, 2.5, 1.25]);
  });

  it('adds shockStacks to each enemy it hits, none without them, and up to shockMaxStacks', () => {
    const shocked = (spec: ChainBoltSpec, values: Partial<Record<StatId, number>> = {}) => {
      const ctx = fixture(line(4), [onPrimary(spec)], values);
      fire(ctx, enemy(ctx, 1));
      return shocks(ctx);
    };
    expect(shocked(bolt())).toEqual([0, 0, 0, 0]);
    expect(shocked(bolt({ shockStacks: 2 }))).toEqual([2, 2, 2, 0]);
    expect(shocked(bolt({ shockStacks: 2 }), { shockMaxStacks: 5 })).toEqual([2, 2, 2, 0]);
    expect(shocked(bolt({ shockStacks: 4 }))).toEqual([3, 3, 3, 0]);
    // A build that cannot shock adds none.
    expect(shocked(bolt({ shockStacks: 2 }), { shockMaxStacks: 0 })).toEqual([0, 0, 0, 0]);
  });

  it('hits its first enemy alone with jumps 0, and stops when no enemy is left in range', () => {
    const idsOf = (placed: PlacedEnemy[], jumps: number, chainRange = 260): number[] => {
      const ctx = fixture(placed, [onPrimary(bolt({ jumps, shockStacks: 1 }))], { chainRange });
      fire(ctx, enemy(ctx, 1));
      return hitIds(ctx);
    };
    expect(idsOf(line(4), 0)).toEqual([1]);
    expect(idsOf(line(4), 1)).toEqual([1, 2]);
    expect(idsOf(line(3), 5)).toEqual([1, 2, 3]);
    // The third enemy is 280 from the second, past a chain range of 100.
    expect(idsOf([at(100, 0), at(120, 0), at(400, 0)], 2, 100)).toEqual([1, 2]);
    // With jumps 0 its one hit still shocks its enemy.
    const alone = fixture(line(4), [onPrimary(bolt({ jumps: 0, shockStacks: 2 }))]);
    fire(alone, enemy(alone, 1));
    expect(shocks(alone)).toEqual([2, 0, 0, 0]);
  });

  it('is tagged hit, trigger, chain and lightning: its jumps carry CHAIN_JUMP, and no hit PRIMARY', () => {
    const seen: [number, number, number, number][] = [];
    const module: TestModule = (b) =>
      b.hook('onHit', (_ctx, hit) => {
        seen.push([hit.target.id, hit.chainIndex, hit.mask, hit.flags & (PRIMARY | CHAIN_JUMP)]);
      });
    const ctx = fixture(line(4), [onPrimary(bolt({ shockStacks: 1 }))], {}, [module]);
    fire(ctx, enemy(ctx, 1));
    expect(jumpMask(BOLT)).toBe(BOLT);
    expect(seen).toEqual([
      [1, 0, BOLT, 0],
      [2, 1, BOLT, CHAIN_JUMP],
      [3, 2, BOLT, CHAIN_JUMP],
    ]);
    expect(hits(ctx).map((hit) => hit.tags)).toEqual([BOLT, BOLT, BOLT]);
  });

  it("deals damage × damagePct, × chainRetention per jump, credited to the trigger's source", () => {
    const ctx = fixture(line(4), [onPrimary(bolt({ jumps: 3, damagePct: 0.4 }))], {
      damage: 50,
      chainRetention: 0.5,
    });
    const lightning = ctx.sources.index('outer.lightning');
    fire(ctx, enemy(ctx, 1));
    expect(hits(ctx).map((hit) => [hit.source, toNumber(hit.amount)])).toEqual([
      [lightning, 20],
      [lightning, 10],
      [lightning, 5],
      [lightning, 2.5],
    ]);
    expect(ctx.bySource[lightning]).toBe(37.5);
  });

  it('shocks no enemy its hit kills, and jumps on from it', () => {
    const ctx = fixture(
      [at(100, 0, { hp: 1 }), at(120, 0), at(140, 0, { hp: 1 }), at(160, 0)],
      [onPrimary(bolt({ jumps: 3, shockStacks: 1 }))],
      { damage: 10 },
    );
    fire(ctx, enemy(ctx, 1));
    expect(hitIds(ctx)).toEqual([1, 2, 3, 4]);
    expect(ctx.enemies.map((e) => [e.alive, e.shockStacks, e.shockUntil > 0])).toEqual([
      [false, 0, false],
      [true, 1, true],
      [false, 0, false],
      [true, 1, true],
    ]);
  });

  it('adds its shock as no application: no ailmentApplied event, and no ailmentApplied trigger fires', () => {
    const ctx = fixture(line(4), [
      onPrimary(bolt({ shockStacks: 2 })),
      { on: 'ailmentApplied', when: [{ ailment: 'shock' }], do: [{ kind: 'heal', lifePct: 0.1 }] },
    ]);
    expect(ctx.appliedListeners).toBe(true);
    fire(ctx, enemy(ctx, 1));
    expect(ctx.events.map((event) => event.type)).toEqual(['hit', 'hit', 'hit']);
    expect(ctx.effectQueue.size).toBe(0);
    expect(shocks(ctx)).toEqual([2, 2, 2, 0]);
  });

  it('rolls crits and ailments on the effects stream, and draws nothing on the others', () => {
    const ctx = fixture(line(4), [onPrimary(bolt({ shockStacks: 1 }))], {
      critChance: 0.5,
      igniteChance: 1,
    });
    const before = rngPositions(ctx);
    fire(ctx, enemy(ctx, 1));
    expect(hitIds(ctx)).toEqual([1, 2, 3]);
    const after = rngPositions(ctx);
    expect(after.effects).not.toEqual(before.effects);
    expect({ ...after, effects: before.effects }).toEqual(before);
    expect(ctx.enemies.map((e) => liveBurnStacks(e, ctx.now))).toEqual([1, 1, 1, 0]);
  });

  it("carries the entry's depth and origin to its hits and their triggers, and its shocks' depth", () => {
    const queued = (depth: number): { seen: number[][]; capped: number } => {
      const onHits: number[][] = [];
      const module: TestModule = (b) =>
        b.hook('onHit', (_ctx, hit) => {
          onHits.push([hit.depth, hit.origin]);
        });
      const ctx = fixture(
        line(3),
        [onPrimary(bolt({ shockStacks: 1 })), { on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] }],
        {},
        [module],
      );
      const one = enemy(ctx, 1);
      fireOne(ctx, FIRST, depth, -1, one, one.x, one.y, HIT_EVENT | PRIMARY, ZERO, -1);
      const entry = createEffectEntry();
      dequeue(ctx.effectQueue, entry);
      expect([entry.depth, entry.origin, ctx.effectQueue.size]).toEqual([depth + 1, FIRST, 0]);
      ctx.events.length = 0;
      runEffect(ctx, entry);
      expect(hitIds(ctx)).toEqual([1, 2, 3]);
      expect(onHits).toEqual([
        [depth + 1, FIRST],
        [depth + 1, FIRST],
        [depth + 1, FIRST],
      ]);
      // Its shocks are applied at its depth (an enemy starts at MAX_DEPTH, 3).
      expect(ctx.enemies.map((e) => e.ailDepth)).toEqual([depth + 1, depth + 1, depth + 1]);
      const seen: number[][] = [];
      while (ctx.effectQueue.size > 0) {
        dequeue(ctx.effectQueue, entry);
        seen.push([entry.depth, entry.origin]);
      }
      return { seen, capped: ctx.counters.triggerDepthCapped };
    };
    const three = (depth: number): number[][] => [
      [depth, FIRST + 1],
      [depth, FIRST + 1],
      [depth, FIRST + 1],
    ];
    expect(queued(0)).toEqual({ seen: three(2), capped: 0 });
    expect(queued(1)).toEqual({ seen: three(3), capped: 0 });
    // At MAX_DEPTH (3) its hits fire nothing: each event is counted once at the cap.
    expect(queued(2)).toEqual({ seen: [], capped: 3 });
  });
});

describe('chainBolt: its first enemy', () => {
  it("starts on the event's live enemy, or the one a selector picked, wherever the event's point is", () => {
    const ctx = fixture(line(4), [onPrimary(bolt({ jumps: 1 }))]);
    // The event's point is on enemy 4, its enemy 2.
    fire(ctx, enemy(ctx, 2), { x: enemy(ctx, 4).x, y: enemy(ctx, 4).y });
    expect(hitIds(ctx)).toEqual([2, 1]);
    const picked = fixture(line(4), [
      { on: 'periodic', every: 1, target: { pick: 'outermost' }, do: [bolt({ jumps: 1 })] },
    ]);
    fire(picked, null);
    expect(hitIds(picked)).toEqual([4, 3]);
  });

  it('does nothing once its enemy is dead: no attack begins and nothing is drawn', () => {
    const ctx = fixture(line(4), [onPrimary(bolt({ shockStacks: 1 }))], { critChance: 0.5 });
    const one = enemy(ctx, 1);
    fireOne(ctx, FIRST, 0, -1, one, one.x, one.y, HIT_EVENT | PRIMARY, ZERO, -1);
    removeEnemy(ctx, one);
    ctx.chainBudget.hits = 5;
    const serial = ctx.attackSerial;
    const before = rngPositions(ctx);
    ctx.events.length = 0;
    runEffectQueue(ctx);
    expect(ctx.events).toEqual([]);
    expect([ctx.attackSerial, ctx.chainBudget.hits]).toEqual([serial, 5]);
    expect(rngPositions(ctx)).toEqual(before);
    expect(ctx.counters.chainHitsPeak).toBe(0);
    expect(shocks(ctx)).toEqual([0, 0, 0, 0]);
  });

  it("from 'nearestToPoint' starts on the alive enemy nearest the event's point within the chain range, ties to the lower id", () => {
    const near = bolt({ jumps: 0, from: 'nearestToPoint' });
    const firstOf = (placed: PlacedEnemy[], chainRange: number): number[] => {
      const ctx = fixture(placed, [{ on: 'periodic', every: 1, do: [near] }], { chainRange });
      fire(ctx, null);
      return hitIds(ctx);
    };
    // A periodic event's point is the player's.
    expect(firstOf([at(200, 0), at(0, 120), at(-120, 0), at(0, -100)], 150)).toEqual([4]);
    expect(firstOf([at(200, 0), at(0, 120), at(-120, 0)], 150)).toEqual([2]);
    // The range is inclusive.
    expect(firstOf([at(0, 150)], 150)).toEqual([1]);
    expect(firstOf([at(0, 151), at(200, 0)], 150)).toEqual([]);
  });

  it("from 'nearestToPoint' takes the event's point, not its enemy or the player, and passes over the dead", () => {
    const ctx = fixture(
      [at(50, 0), at(300, 0), at(330, 0), at(600, 0)],
      [onPrimary(bolt({ jumps: 1, from: 'nearestToPoint' }))],
      { chainRange: 100 },
    );
    // The event's enemy is 4, its point next to 3; the player is nearest 1.
    fire(ctx, enemy(ctx, 4), { x: PLAYER.x + 320, y: PLAYER.y });
    expect(hitIds(ctx)).toEqual([3, 2]);
    removeEnemy(ctx, enemy(ctx, 3));
    fire(ctx, enemy(ctx, 4), { x: PLAYER.x + 320, y: PLAYER.y });
    expect(hitIds(ctx)).toEqual([2]);
  });

  it("from 'nearestToPoint' may start on the event's own enemy, and with none in range of the point does nothing, though its enemy lives", () => {
    const ctx = fixture(
      [at(50, 0), at(300, 0), at(330, 0), at(600, 0)],
      [onPrimary(bolt({ jumps: 1, from: 'nearestToPoint', shockStacks: 1 }))],
      { chainRange: 100, critChance: 0.5 },
    );
    // The event's point is its enemy's: that enemy is the nearest, and the bolt starts on it.
    fire(ctx, enemy(ctx, 3));
    expect(hitIds(ctx)).toEqual([3, 2]);
    // 120 and 150 from the point, past a chain range of 100: the live event enemy 4 is not
    // taken instead, no attack begins and nothing is drawn.
    const serial = ctx.attackSerial;
    const before = rngPositions(ctx);
    fire(ctx, enemy(ctx, 4), { x: PLAYER.x + 450, y: PLAYER.y });
    expect(ctx.events).toEqual([]);
    expect(ctx.attackSerial).toBe(serial);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it("from 'nearestToPoint' measures from the event's point under a selector too: the pick only lets it fire", () => {
    const ctx = fixture(
      [at(50, 0), at(300, 0), at(330, 0), at(600, 0)],
      [
        {
          on: 'periodic',
          every: 1,
          target: { pick: 'outermost' },
          do: [bolt({ jumps: 0, from: 'nearestToPoint' })],
        },
        {
          on: 'hit',
          when: PRIMARY_HIT,
          target: { pick: 'player' },
          do: [bolt({ jumps: 0, from: 'nearestToPoint' })],
        },
      ],
      { chainRange: 100 },
    );
    // A periodic event's point is the player's: enemy 1, not the outermost enemy 4 it picked.
    fire(ctx, null);
    expect(hitIds(ctx)).toEqual([1]);
    // A hit's point is next to 3: not the player's, which a 'player' pick centers area effects on.
    fire(ctx, enemy(ctx, 4), { i: FIRST + 1, x: PLAYER.x + 320, y: PLAYER.y });
    expect(hitIds(ctx)).toEqual([3]);
  });

  it("from 'nearestToPoint' takes an enemy the attack before it hit, and nothing in range draws nothing", () => {
    const ctx = fixture(
      [at(100, 0), at(120, 0)],
      [{ on: 'periodic', every: 1, do: [bolt({ jumps: 1, from: 'nearestToPoint' })] }],
      { chainRange: 110, critChance: 0.5 },
    );
    beginAttack(ctx);
    enemy(ctx, 1).hitMark = ctx.attackSerial;
    fire(ctx, null);
    expect(hitIds(ctx)).toEqual([1, 2]);
    // Out of range of the player: no attack, no draw.
    const far = fixture(
      [at(0, 300)],
      [{ on: 'periodic', every: 1, do: [bolt({ from: 'nearestToPoint', shockStacks: 1 })] }],
      { critChance: 0.5 },
    );
    const serial = far.attackSerial;
    const before = rngPositions(far);
    fire(far, null);
    expect(far.events).toEqual([]);
    expect(far.attackSerial).toBe(serial);
    expect(rngPositions(far)).toEqual(before);
  });
});

describe('chainBolt: its attack and budget (K6)', () => {
  it('is an attack of its own: it hits 1 + jumps whatever the attack before it hit or counted', () => {
    const ctx = fixture(line(5), [onPrimary(bolt({ jumps: 2 }))]);
    // An attack before it hit every enemy and nearly filled its budget.
    beginAttack(ctx);
    for (const e of ctx.enemies) e.hitMark = ctx.attackSerial;
    ctx.chainBudget.hits = CHAIN_HIT_CAP - 1;
    const serial = ctx.attackSerial;
    fire(ctx, enemy(ctx, 1));
    expect(hitIds(ctx)).toEqual([1, 2, 3]);
    expect(ctx.attackSerial).toBe(serial + 1);
    // Its first hit counts 1, each jump 1.
    expect([ctx.chainBudget.hits, ctx.counters.chainHitsPeak]).toEqual([3, 3]);
    expect(ctx.counters.chainHitCapped).toBe(0);
  });

  it('makes each firing its own attack: two bolts hit the same enemies, each shocking them', () => {
    const ctx = fixture(line(5), [
      { on: 'hit', when: PRIMARY_HIT, do: [bolt({ shockStacks: 1 }), bolt({ shockStacks: 1 })] },
    ]);
    const serial = ctx.attackSerial;
    fire(ctx, enemy(ctx, 1));
    expect(hitIds(ctx)).toEqual([1, 2, 3, 1, 2, 3]);
    expect(ctx.attackSerial).toBe(serial + 2);
    expect(shocks(ctx)).toEqual([2, 2, 2, 0, 0]);
  });

  it('counts its first hit toward CHAIN_HIT_CAP: jumps 31 hits 32 enemies, and jumps past it are refused, counted', () => {
    const run = (jumps: number): number[] => {
      const ctx = fixture(rows(50), [onPrimary(bolt({ jumps }))], { chainRange: 5000 });
      fire(ctx, enemy(ctx, 1));
      const counters = ctx.counters;
      return [
        hits(ctx).length,
        new Set(hitIds(ctx)).size,
        counters.chainHitCapped,
        counters.chainHitsPeak,
      ];
    };
    expect(run(30)).toEqual([31, 31, 0, 31]);
    expect(run(31)).toEqual([32, 32, 0, 32]);
    // Unvalidated: 40 jumps, 31 dealt and 9 refused.
    expect(run(40)).toEqual([32, 32, 9, 32]);
  });
});

describe('chainBolt: compile and payload', () => {
  it('tags its hits hit, trigger, chain and lightning, at damage × damagePct × coef; jumps and shockStacks take no coef', () => {
    const fx = compileEffect(
      bolt({ jumps: 3, damagePct: 0.4, shockStacks: 2, from: 'nearestToPoint' }),
      3,
      0.5,
      100,
    );
    expect(fx.tags).toBe(BOLT);
    expect(toNumber(fx.baseDamage)).toBeCloseTo(20, 12);
    expect(fx.spec).toEqual({
      kind: 'chainBolt',
      jumps: 3,
      damagePct: 0.2,
      shockStacks: 2,
      from: 'nearestToPoint',
    });
    expect([fx.source, fx.radiusSq, fx.fanout, fx.atTarget, fx.atPlayer]).toEqual([
      3,
      0,
      false,
      false,
      false,
    ]);
  });

  it('gets an effect payload that shocks on hit, with no flags, no policy and no chainJump', () => {
    const ctx = fixture([], [{ on: 'hit', do: [bolt({ shockStacks: 2 }), bolt()] }]);
    const [shocking, plain] = payloadsOf(ctx) as [Payload, Payload];
    const common = {
      tags: BOLT,
      source: ctx.sources.index('outer.lightning'),
      flags: 0,
      chains: false,
      canCrit: true,
      rollsAilments: true,
      damageMode: ROWS,
      aggregate: false,
      bypass: 0,
      policy: null,
      raisesChainJump: false,
    };
    expect(shocking).toMatchObject({ ...common, shockOnHit: 2, general: true });
    expect(plain).toMatchObject({ ...common, shockOnHit: 0, general: false });
    for (const p of [shocking, plain]) {
      expect(p.rng).toBe(ctx.effectsRng);
      expect(p.extraJumpPayload).toBe(p);
    }
  });

  it('raises no center event: an onCenterEvent hook sees none of its hits', () => {
    let events = 0;
    const module: TestModule = (b) =>
      b.hook('onCenterEvent', () => {
        events++;
      });
    const ctx = fixture(line(5), [onPrimary(bolt({ jumps: 4, shockStacks: 1 }))], {}, [module]);
    fire(ctx, enemy(ctx, 1));
    expect(hitIds(ctx)).toEqual([1, 2, 3, 4, 5]);
    expect([events, ctx.chainBudget.centerEvents]).toEqual([0, 0]);
  });
});

/** [target, chainIndex, fromX, fromY] of each hit of the last fire(). */
const fromOf = (ctx: RunContext): (number | null)[][] =>
  hits(ctx).map((hit) => [hit.targetId, hit.chainIndex, hit.fromX, hit.fromY]);

/**
 * Three enemies 50, 60 and 70 from the player (1, 2, 3), each with a partner 40 farther out on
 * its own side (4, 5, 6), which its jump takes: every partner is nearer its own enemy than any
 * other enemy is, and farther from the player than the three are.
 */
const PAIRS: PlacedEnemy[] = [at(50, 0), at(-60, 0), at(0, 70), at(90, 0), at(-100, 0), at(0, 110)];

describe("chainBolt: from 'nearestOther' (E7, lead ruling B1)", () => {
  it("never starts on the event's own enemy, where 'nearestToPoint' does when it is the nearest alive", () => {
    const ctx = fixture(
      [at(100, 0), at(130, 0), at(170, 0)],
      [
        onPrimary(bolt({ jumps: 0, from: 'nearestOther' })),
        onPrimary(bolt({ jumps: 0, from: 'nearestToPoint' })),
      ],
    );
    // The event's point is its enemy's.
    fire(ctx, enemy(ctx, 1));
    expect(hitIds(ctx)).toEqual([2]);
    fire(ctx, enemy(ctx, 1), { i: FIRST + 1 });
    expect(hitIds(ctx)).toEqual([1]);
    fire(ctx, enemy(ctx, 2));
    expect(hitIds(ctx)).toEqual([1]);
    // The event's point next to 3, its enemy 3: the next nearest, 2, 35 away, not 1.
    fire(ctx, enemy(ctx, 3), { x: PLAYER.x + 165, y: PLAYER.y });
    expect(hitIds(ctx)).toEqual([2]);
    fire(ctx, enemy(ctx, 3), { i: FIRST + 1, x: PLAYER.x + 165, y: PLAYER.y });
    expect(hitIds(ctx)).toEqual([3]);
  });

  it("leaves out the event's enemy dead too, and the selector's pick in its place", () => {
    const ctx = fixture(
      [at(100, 0), at(130, 0), at(170, 0)],
      [onPrimary(bolt({ jumps: 0, from: 'nearestOther', bolts: 3 }))],
    );
    const one = enemy(ctx, 1);
    fireOne(ctx, FIRST, 0, -1, one, one.x, one.y, HIT_EVENT | PRIMARY, ZERO, -1);
    removeEnemy(ctx, one);
    ctx.events.length = 0;
    runEffectQueue(ctx);
    expect(hitIds(ctx)).toEqual([2, 3]);
    // A periodic event's enemy is its selector's: the outermost, 3, is left out.
    const picked = fixture(
      [at(50, 0), at(80, 0), at(200, 0)],
      [
        {
          on: 'periodic',
          every: 1,
          target: { pick: 'outermost' },
          do: [bolt({ jumps: 0, from: 'nearestOther', bolts: 3 })],
        },
        {
          on: 'periodic',
          every: 1,
          target: { pick: 'outermost' },
          do: [bolt({ jumps: 0, from: 'nearestToPoint', bolts: 3 })],
        },
      ],
    );
    fire(picked, null);
    expect(hitIds(picked)).toEqual([1, 2]);
    fire(picked, null, { i: FIRST + 1 });
    expect(hitIds(picked)).toEqual([1, 2, 3]);
  });

  it('takes only enemies within the chain range of the point, inclusive; none in range does nothing', () => {
    const ctx = fixture(
      [at(100, 0), at(200, 0), at(300, 0)],
      [onPrimary(bolt({ jumps: 0, from: 'nearestOther', bolts: 3, shockStacks: 1 }))],
      { chainRange: 100, critChance: 0.5 },
    );
    fire(ctx, enemy(ctx, 1));
    expect(hitIds(ctx)).toEqual([2]);
    const short = fixture(
      [at(100, 0), at(200, 0), at(300, 0)],
      [onPrimary(bolt({ jumps: 0, from: 'nearestOther', bolts: 3, shockStacks: 1 }))],
      { chainRange: 99.9, critChance: 0.5 },
    );
    const serial = short.attackSerial;
    const before = rngPositions(short);
    fire(short, enemy(short, 1));
    expect(short.events).toEqual([]);
    expect(short.attackSerial).toBe(serial);
    expect(rngPositions(short)).toEqual(before);
    expect(shocks(short)).toEqual([0, 0, 0]);
  });

  it("on an event without an enemy takes what 'nearestToPoint' takes", () => {
    const placed = [at(0, 120), at(-90, 0), at(200, 0), at(0, -100)];
    const picks = (from: 'nearestOther' | 'nearestToPoint', bolts: number): number[] => {
      const ctx = fixture(placed, [
        { on: 'periodic', every: 1, do: [bolt({ jumps: 0, from, bolts })] },
      ]);
      fire(ctx, null);
      return hitIds(ctx);
    };
    expect(picks('nearestOther', 1)).toEqual([2]);
    expect(picks('nearestToPoint', 1)).toEqual([2]);
    expect(picks('nearestOther', 3)).toEqual([2, 4, 1]);
    expect(picks('nearestToPoint', 3)).toEqual([2, 4, 1]);
  });
});

describe('chainBolt: several bolts (E7, lead ruling B2)', () => {
  it('sends one bolt to each of the `bolts` nearest that pass its from, nearest first, each an attack', () => {
    const placed = [at(0, 70), at(50, 0), at(-90, 0), at(0, -30), at(200, 0)];
    const ctx = fixture(placed, [
      { on: 'periodic', every: 1, do: [bolt({ jumps: 0, from: 'nearestToPoint', bolts: 3 })] },
      onPrimary(bolt({ jumps: 0, from: 'nearestOther', bolts: 3 })),
      onPrimary(bolt({ jumps: 0, from: 'nearestToPoint', bolts: 2 })),
    ]);
    const serial = ctx.attackSerial;
    fire(ctx, null);
    expect(hitIds(ctx)).toEqual([4, 2, 1]);
    expect(ctx.attackSerial).toBe(serial + 3);
    expect(ctx.counters.chainHitsPeak).toBe(1);
    // The event's enemy 4 at the player's point: left out, the next three in order.
    fire(ctx, enemy(ctx, 4), { i: FIRST + 1, x: PLAYER.x, y: PLAYER.y });
    expect(hitIds(ctx)).toEqual([2, 1, 3]);
    fire(ctx, enemy(ctx, 4), { i: FIRST + 2, x: PLAYER.x, y: PLAYER.y });
    expect(hitIds(ctx)).toEqual([4, 2]);
  });

  it('breaks ties to the lower id, as grid.nearest does', () => {
    // Four enemies exactly 60 from the player, and a fifth 10 from it, placed last.
    const placed = [at(0, 60), at(-60, 0), at(60, 0), at(0, -60), at(10, 0)];
    const picks = (bolts: number, event: number | null): number[] => {
      const ctx = fixture(placed, [
        onPrimary(bolt({ jumps: 0, from: 'nearestOther', bolts })),
        { on: 'periodic', every: 1, do: [bolt({ jumps: 0, from: 'nearestToPoint', bolts })] },
      ]);
      if (event === null) fire(ctx, null, { i: FIRST + 1 });
      else fire(ctx, enemy(ctx, event), { x: PLAYER.x, y: PLAYER.y });
      return hitIds(ctx);
    };
    expect(picks(3, null)).toEqual([5, 1, 2]);
    expect(picks(3, 5)).toEqual([1, 2, 3]);
    expect(picks(2, 1)).toEqual([5, 2]);
    expect(picks(3, 2)).toEqual([5, 1, 3]);
    // The grid's own pick for one bolt agrees.
    const ctx = fixture(placed.slice(0, 4), []);
    expect(ctx.grid.nearest(PLAYER.x, PLAYER.y, Infinity)?.id).toBe(1);
  });

  it('sends fewer bolts to fewer enemies, and none to none', () => {
    const placed = [at(40, 0), at(-80, 0)];
    const run = (from: 'nearestOther' | 'nearestToPoint', event: number | null): number[] => {
      const spec = bolt({ jumps: 0, from, bolts: 3 });
      const ctx = fixture(placed, [onPrimary(spec), { on: 'periodic', every: 1, do: [spec] }]);
      const serial = ctx.attackSerial;
      if (event === null) fire(ctx, null, { i: FIRST + 1 });
      else fire(ctx, enemy(ctx, event), { x: PLAYER.x, y: PLAYER.y });
      expect(ctx.attackSerial - serial).toBe(hits(ctx).length);
      return hitIds(ctx);
    };
    expect(run('nearestToPoint', null)).toEqual([1, 2]);
    expect(run('nearestOther', 1)).toEqual([2]);
    expect(run('nearestOther', 2)).toEqual([1]);
    const alone = fixture(
      [at(40, 0)],
      [onPrimary(bolt({ jumps: 2, from: 'nearestOther', bolts: 3 }))],
      { critChance: 0.5 },
    );
    const serial = alone.attackSerial;
    const before = rngPositions(alone);
    fire(alone, enemy(alone, 1));
    expect(alone.events).toEqual([]);
    expect(alone.attackSerial).toBe(serial);
    expect(rngPositions(alone)).toEqual(before);
  });

  it('picks every enemy before the first bolt fires: a pick an earlier bolt killed gets none, and none is picked in its place', () => {
    // 1 at 100, 2 at 120 with 1 hp, and on the other side 3 at 130 and 4 at 200, 70 from 3.
    const ctx = fixture(
      [at(100, 0), at(120, 0, { hp: 1 }), at(-130, 0), at(-200, 0)],
      [{ on: 'periodic', every: 1, do: [bolt({ jumps: 1, from: 'nearestToPoint', bolts: 3 })] }],
      { damage: 10 },
    );
    const serial = ctx.attackSerial;
    fire(ctx, null);
    // The first bolt's jump kills 2; the second bolt, 2's, is passed over; the third starts on 3
    // and jumps to 4, which no bolt was picked for.
    expect(hits(ctx).map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
      [4, 1],
    ]);
    expect(enemy(ctx, 2).alive).toBe(false);
    expect(ctx.attackSerial).toBe(serial + 2);
  });

  it('gives each bolt its own budget: 32 hits each, and the jumps past it refused, counted', () => {
    const run = (jumps: number): number[] => {
      const ctx = fixture(
        rows(100),
        [{ on: 'periodic', every: 1, do: [bolt({ jumps, from: 'nearestToPoint', bolts: 3 })] }],
        { chainRange: 5000 },
      );
      const serial = ctx.attackSerial;
      fire(ctx, null);
      const firsts = hits(ctx).filter((hit) => hit.chainIndex === 0).length;
      const counters = ctx.counters;
      return [
        hits(ctx).length,
        firsts,
        ctx.attackSerial - serial,
        counters.chainHitCapped,
        counters.chainHitsPeak,
      ];
    };
    expect(run(31)).toEqual([96, 3, 3, 0, 32]);
    // Unvalidated: 40 jumps, 31 dealt and 9 refused a bolt.
    expect(run(40)).toEqual([96, 3, 3, 27, 32]);
  });

  it('lets each bolt hit what another hit: its jumps skip only its own attack’s enemies', () => {
    const ctx = fixture(
      [at(50, 0), at(70, 0), at(90, 0)],
      [{ on: 'periodic', every: 1, do: [bolt({ jumps: 2, from: 'nearestToPoint', bolts: 2 })] }],
    );
    fire(ctx, null);
    expect(hitIds(ctx)).toEqual([1, 2, 3, 2, 1, 3]);
  });

  it('makes every bolt its first hit, its shockStacks and exactly `jumps` jumps', () => {
    const ctx = fixture(
      PAIRS,
      [
        {
          on: 'periodic',
          every: 1,
          do: [bolt({ jumps: 1, from: 'nearestToPoint', bolts: 3, shockStacks: 2 })],
        },
      ],
      { damage: 10, chainRetention: 0.5, chainRange: 200 },
    );
    fire(ctx, null);
    expect(hits(ctx).map((hit) => [hit.targetId, hit.chainIndex, toNumber(hit.amount)])).toEqual([
      [1, 0, 10],
      [4, 1, 5],
      [2, 0, 10],
      [5, 1, 5],
      [3, 0, 10],
      [6, 1, 5],
    ]);
    expect(shocks(ctx)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(ctx.counters.chainHitsPeak).toBe(2);
  });

  it('keeps its picks through what a bolt’s hit does at once: a freeze’s list, a kill’s spread', () => {
    // 1, 2 and 3 are the three nearest the player; 3 and 4 are within 90 of 1, 2 is not. A
    // freeze's list (FREEZE_LIST_RADIUS 90) and a burn spread of 90 at 1 list 1, 3 and 4, in
    // buffers of their own, while the bolts' picks stay 1, 2 and 3.
    const placed = [at(50, 0, { hp: 15 }), at(-60, 0), at(0, 70), at(100, 0)];
    const three = bolt({ jumps: 0, from: 'nearestToPoint', bolts: 3 });
    // A freeze inside the first bolt's hit, while an onCenterEvent hook needs the freeze's list.
    const hook: TestModule = (b) => void b.hook('onCenterEvent', () => undefined);
    const cold = fixture(
      placed,
      [{ on: 'periodic', every: 1, do: [three] }],
      { damage: 1, frostOnHit: 1 },
      [hook],
    );
    fire(cold, null);
    const order = cold.events.flatMap((e) =>
      e.type === 'hit' || e.type === 'freeze' ? [`${e.type} ${e.targetId}`] : [],
    );
    expect(order).toEqual(['hit 1', 'freeze 1', 'hit 2', 'freeze 2', 'hit 3', 'freeze 3']);
    // A kill inside the first bolt's hit, whose burn spreads at once (an inline transfer).
    const hot = fixture(
      placed,
      [
        { on: 'periodic', every: 1, do: [{ kind: 'applyAilment', ailment: 'burn', radius: 300 }] },
        { on: 'periodic', every: 1, do: [three] },
        { on: 'kill', do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 90 }] },
      ],
      { damage: 20 },
    );
    fire(hot, null);
    fire(hot, null, { i: FIRST + 1 });
    expect(enemy(hot, 1).alive).toBe(false);
    expect(hot.events.some((e) => e.type === 'burnSpread' && e.enemyId === 1)).toBe(true);
    expect(hitIds(hot)).toEqual([1, 2, 3]);
  });
});

describe('chainBolt: its arc (E7, lead ruling B3)', () => {
  it("with arc, starts each bolt's first hit at the event's point, its jumps from the enemy before", () => {
    const ctx = fixture(
      PAIRS,
      [
        {
          on: 'periodic',
          every: 1,
          do: [bolt({ jumps: 1, from: 'nearestToPoint', bolts: 3, arc: true })],
        },
        onPrimary(bolt({ jumps: 1, arc: true })),
        onPrimary(bolt({ jumps: 0, from: 'nearestOther', arc: true })),
      ],
      { chainRange: 200 },
    );
    const [p1, p2, p3] = [enemy(ctx, 1), enemy(ctx, 2), enemy(ctx, 3)];
    fire(ctx, null);
    expect(fromOf(ctx)).toEqual([
      [1, 0, PLAYER.x, PLAYER.y],
      [4, 1, p1.x, p1.y],
      [2, 0, PLAYER.x, PLAYER.y],
      [5, 1, p2.x, p2.y],
      [3, 0, PLAYER.x, PLAYER.y],
      [6, 1, p3.x, p3.y],
    ]);
    // From 'eventTarget' at a point away from its enemy, and from 'nearestOther' on its own.
    const x = PLAYER.x + 10;
    const y = PLAYER.y - 20;
    fire(ctx, p1, { i: FIRST + 1, x, y });
    expect(fromOf(ctx)).toEqual([
      [1, 0, x, y],
      [4, 1, p1.x, p1.y],
    ]);
    fire(ctx, p1, { i: FIRST + 2, x, y });
    expect(fromOf(ctx)).toEqual([[2, 0, x, y]]);
  });

  it('without arc (or arc false) starts every first hit from nowhere, as before', () => {
    const run = (more: Partial<ChainBoltSpec>): (number | null)[][] => {
      const ctx = fixture(
        PAIRS,
        [{ on: 'periodic', every: 1, do: [bolt({ jumps: 1, bolts: 3, ...more })] }],
        { chainRange: 200 },
      );
      fire(ctx, null);
      return fromOf(ctx);
    };
    const [p1, p2, p3] = PAIRS as [PlacedEnemy, PlacedEnemy, PlacedEnemy];
    const expected = [
      [1, 0, null, null],
      [4, 1, p1.x, p1.y],
      [2, 0, null, null],
      [5, 1, p2.x, p2.y],
      [3, 0, null, null],
      [6, 1, p3.x, p3.y],
    ];
    expect(run({ from: 'nearestToPoint' })).toEqual(expected);
    expect(run({ from: 'nearestOther', arc: false })).toEqual(expected);
    const one = fixture(line(3), [onPrimary(bolt({ jumps: 1, from: 'nearestOther' }))]);
    fire(one, enemy(one, 1));
    expect(fromOf(one)).toEqual([
      [2, 0, null, null],
      [1, 1, enemy(one, 2).x, enemy(one, 2).y],
    ]);
  });

  it('changes nothing but those two fields: the same hits, damage, shocks, kills and draws', () => {
    const run = (arc: boolean): { events: SimEvent[]; rest: unknown } => {
      const ctx = fixture(
        [...PAIRS, at(30, 30, { hp: 1 }), at(-30, -30, { hp: 15 })],
        [
          {
            on: 'periodic',
            every: 1,
            do: [bolt({ jumps: 2, from: 'nearestOther', bolts: 3, shockStacks: 1, arc })],
          },
        ],
        { damage: 10, critChance: 0.5, igniteChance: 0.5, chainRange: 200 },
      );
      fire(ctx, null);
      const events = ctx.events.map((event) =>
        event.type === 'hit' && event.chainIndex === 0
          ? { ...event, fromX: null, fromY: null }
          : event,
      );
      const rest = {
        rng: rngPositions(ctx),
        hp: ctx.enemies.map((e) => [e.alive, toNumber(e.hp), e.shockStacks]),
        counters: ctx.counters,
      };
      return { events, rest };
    };
    const on = run(true);
    const off = run(false);
    expect(on.events.filter((e) => e.type === 'hit').length).toBeGreaterThan(6);
    expect(on.events.some((e) => e.type === 'hit' && !e.crit)).toBe(true);
    expect(on.events.some((e) => e.type === 'hit' && e.crit)).toBe(true);
    expect(on).toEqual(off);
  });

  it('keeps bolts and arc out of the coef, in the compiled spec as written', () => {
    const fx = compileEffect(
      bolt({ jumps: 0, damagePct: 0.4, from: 'nearestOther', bolts: 3, arc: true }),
      3,
      0.5,
      100,
    );
    expect(fx.spec).toEqual({
      kind: 'chainBolt',
      jumps: 0,
      damagePct: 0.2,
      from: 'nearestOther',
      bolts: 3,
      arc: true,
    });
    expect(toNumber(fx.baseDamage)).toBeCloseTo(20, 12);
    expect(compileEffect(bolt(), 0, 1, 10).spec).toEqual({
      kind: 'chainBolt',
      jumps: 2,
      damagePct: 1,
    });
  });
});

describe('chainBolt: a rule module’s bolts (E7, lead ruling R8)', () => {
  // A module's triggers and effects are not validated, so compileEffect checks every chainBolt's
  // bolts, in data validation's words (chainBoltBoltsIssues).
  const viaTrigger = (spec: ChainBoltSpec) => () =>
    compileBuild(makeStats(), [], undefined, [
      (b) => b.addTrigger('outer.lightning', { on: 'hit', do: [spec] }),
    ]);
  const viaEffect = (spec: ChainBoltSpec) => () =>
    compileBuild(makeStats(), [], undefined, [(b) => void b.addEffect('outer.lightning', spec)]);
  const range = (bolts: number): string => `bolts must be an integer in [1, 3] (got ${bolts})`;
  const one = (bolts: number): string =>
    `chainBolt from 'eventTarget' starts on one enemy; bolts ${bolts} needs from 'nearestToPoint' or 'nearestOther'`;

  it("refuses bolts that are not a whole number in [1, 3], or above 1 from 'eventTarget', naming the effect", () => {
    // Planted bugs: no guard, and its maximum off by one.
    const cases: [ChainBoltSpec, string][] = [
      ...[0, Number.NaN, -1, 1.5, 4].flatMap((bolts): [ChainBoltSpec, string][] => [
        [bolt({ from: 'nearestOther', bolts }), range(bolts)],
        [bolt({ from: 'nearestToPoint', bolts }), range(bolts)],
      ]),
      [bolt({ from: 'eventTarget', bolts: 2 }), one(2)],
      [bolt({ bolts: 2 }), one(2)],
      [bolt({ bolts: 4 }), `${range(4)}; ${one(4)}`],
    ];
    for (const [spec, issue] of cases) {
      const message = `A chainBolt effect ${JSON.stringify(spec)}: ${issue}`;
      expect(viaTrigger(spec), message).toThrow(message);
      expect(viaEffect(spec), message).toThrow(message);
    }
  });

  it('accepts bolts 1 to 3 from a nearest start, bolts 1 from any, and none, as written', () => {
    const specs: ChainBoltSpec[] = [
      ...(['nearestToPoint', 'nearestOther'] as const).flatMap((from) =>
        [1, 2, 3].map((bolts) => bolt({ from, bolts })),
      ),
      bolt({ bolts: 1 }),
      bolt({ from: 'eventTarget', bolts: 1, arc: true }),
      bolt(),
    ];
    for (const spec of specs) {
      const label = JSON.stringify(spec);
      expect(viaTrigger(spec)().effects[0]?.spec, label).toEqual(spec);
      expect(viaEffect(spec)().effects[0]?.spec, label).toEqual(spec);
    }
    // A module's bolts fire as data's do: three from 'nearestOther'.
    const ctx = fixture([at(100, 0), at(130, 0), at(170, 0), at(200, 0)], [], {}, [
      (b) =>
        b.addTrigger(
          'outer.lightning',
          onPrimary(bolt({ jumps: 0, from: 'nearestOther', bolts: 3 })),
        ),
    ]);
    fire(ctx, enemy(ctx, 1));
    expect(hitIds(ctx)).toEqual([2, 3, 4]);
  });
});
