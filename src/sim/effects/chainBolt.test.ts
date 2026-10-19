import { describe, expect, it } from 'vitest';
import { toNumber, ZERO } from '../../core/num';
import type { StatId } from '../../data/stats';
import { jumpMask, TAG } from '../../data/tags';
import type { ChainBoltSpec, TriggerSpec } from '../../data/triggers';
import { liveBurnStacks } from '../ailments/records';
import { activeShockStacks } from '../ailments/shock';
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
