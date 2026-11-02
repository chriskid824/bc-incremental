/**
 * 集火 (docs/v3 C7 design §2.10, gd:491, lead ruling W8, src/sim/combat/defend.ts): with
 * shieldPoolSec, the hit parts that reach an enemy's shield within round(shieldPoolSec × 60)
 * ticks of its pool's start are compared with the shield's threshold together. §2.10's test is
 * named in its title with a comment naming the planted bug it kills; the rest pin W8's edges.
 * Shielders hold 1000 hp, so their shield (blockBelowPct 0.15) blocks a part below 150 alone;
 * the build's hits roll no crit or ignite, so a hit deals its base.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { TAG } from '../../data/tags';
import type { StatId } from '../../data/stats';
import type { ConversionSpec } from '../../data/triggers';
import { takenMult } from '../ailments/shock';
import { createPayload, IGNORE_ARMOUR, IGNORE_SHIELD, ROWS } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { Enemy, RunContext } from '../systems/context';
import type { EnemyV3 } from '../systems/enemyRecord';
import { eventsOf, makeStats, placedEnemies, v3TestData } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { ARMOURED } from './defend';
import { hitWithPayload } from './hit';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;

const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const shielder = (dx: number): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y,
  type: 'shielder',
  hp: 1000,
});

/** 集火 as B3 writes it: 0.2 s, a window of 12 ticks. */
const POOL = { shieldPoolSec: 0.2 } as const;

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly conversions?: readonly ConversionSpec[];
}

/** placedEnemies on a v3 run's data, so every enemy holds its record, with these values. */
function defended(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ critChance: 0, igniteChance: 0, ...options.values }, [], {
      triggers: [],
      conversions: (options.conversions ?? []).map((spec) => ({ source: 'center', spec })),
      emitters: [],
    }),
    data: v3TestData(),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const record = (e: Enemy): EnemyV3 => e.v3 as EnemyV3;

/** A payload of the signature's tags, sources and rows at base damage `damage`, with `bypass`. */
function payload(ctx: RunContext, damage: number, bypass = 0): Payload {
  const p = (ctx.emitters[0] as EmitterRuntime).payload;
  return createPayload({
    baseDamage: num(damage),
    tags: p.tags,
    source: p.source,
    jumpSource: p.jumpSource,
    flags: 0,
    rng: p.rng,
    chains: false,
    rollsAilments: true,
    canCrit: true,
    damageMode: ROWS,
    raisesChainJump: false,
    bypass,
    rowsOf: p,
  });
}

/**
 * Hits `target` once on each tick of `at` (ticks from 10) with a part of `damage` (60 by default,
 * 6 % of a shielder's life), a bypass where `bypass` gives one for that hit: what each did, its
 * landed amount or 'blocked'.
 */
function volley(
  ctx: RunContext,
  target: Enemy,
  at: readonly number[],
  damage = 60,
  bypass: readonly number[] = [],
): (number | 'blocked')[] {
  return at.map((t, i) => {
    ctx.now = t;
    ctx.events.length = 0;
    hitWithPayload(
      ctx,
      target,
      payload(ctx, damage, bypass[i] ?? 0),
      0,
      1,
      null,
      null,
      false,
      0,
      -1,
    );
    const hit = eventsOf([ctx.events], 'hit');
    if (hit.length > 0) return toNumber((hit[0] as HitEvent).amount);
    expect(eventsOf([ctx.events], 'hitBlocked'), `tick ${t}`).toHaveLength(1);
    return 'blocked';
  });
}

describe('集火 (shieldPoolSec, lead ruling W8)', () => {
  it('blocks the first two of three hits of 6 % within 0.2 s and lands the third (§2.10 集火 test)', () => {
    // Planted bug: the pool reset on every hit.
    const ctx = defended([shielder(300)], { values: POOL });
    const one = enemy(ctx, 1);
    expect(ctx.sys.enemyAi.poolTicks).toBe(12);
    expect(volley(ctx, one, [10, 15, 21])).toEqual(['blocked', 'blocked', 60]);
    expect(toNumber(one.hp)).toBe(940);
    expect([record(one).poolStart, toNumber(record(one).poolSum)]).toEqual([10, 180]);
  });

  it('lands the hits after a landing within the window, and starts a new pool after it', () => {
    // Planted bugs: the pool reset on a landing; a 4th hit after the window not restarting it.
    const ctx = defended([shielder(300)], { values: POOL });
    const one = enemy(ctx, 1);
    // 22 is the window's last tick; 23 is past it and starts a pool of its own.
    expect(volley(ctx, one, [10, 12, 14, 22, 23, 30, 35])).toEqual([
      'blocked',
      'blocked',
      60,
      60,
      'blocked',
      'blocked',
      60,
    ]);
    expect([record(one).poolStart, toNumber(record(one).poolSum)]).toEqual([23, 180]);
  });

  it('pools each enemy apart', () => {
    const ctx = defended([shielder(300), shielder(360)], { values: POOL });
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    expect(volley(ctx, one, [10, 11])).toEqual(['blocked', 'blocked']);
    expect(volley(ctx, two, [12])).toEqual(['blocked']);
    expect(volley(ctx, one, [13])).toEqual([60]);
    expect(volley(ctx, two, [14, 15])).toEqual(['blocked', 60]);
  });

  it('compares the parts before the armour, and an armoured shielder takes the half of what lands', () => {
    // Planted bug: the pool counting the amounts after the armour.
    const ctx = defended([shielder(300)], { values: POOL });
    const one = enemy(ctx, 1);
    record(one).defence |= ARMOURED;
    expect(volley(ctx, one, [10, 11, 12])).toEqual(['blocked', 'blocked', 30]);
    expect(toNumber(record(one).poolSum)).toBe(180);
  });

  it('leaves the pool alone for a hit that bypasses the shield, which lands whole', () => {
    // Planted bug: a bypassed hit added to the pool.
    const ctx = defended([shielder(300)], { values: POOL });
    const one = enemy(ctx, 1);
    expect(volley(ctx, one, [10, 11, 12], 60, [0, IGNORE_SHIELD, IGNORE_ARMOUR])).toEqual([
      'blocked',
      60,
      'blocked',
    ]);
    expect([record(one).poolStart, toNumber(record(one).poolSum)]).toEqual([10, 120]);
    // Armoured, a bypassed shield still leaves the pool alone, and the armour halves the hit.
    const armoured = defended([shielder(300)], { values: POOL });
    const two = enemy(armoured, 1);
    record(two).defence |= ARMOURED;
    expect(volley(armoured, two, [10, 11, 12], 60, [0, IGNORE_SHIELD, 0])).toEqual([
      'blocked',
      30,
      'blocked',
    ]);
    expect([record(two).poolStart, toNumber(record(two).poolSum)]).toEqual([10, 120]);
    // An enemy without a shield keeps no pool, armoured or not.
    const square = defended([{ x: PLAYER.x + 300, y: PLAYER.y, type: 'square', hp: 1000 }], {
      values: POOL,
    });
    expect(volley(square, enemy(square, 1), [10])).toEqual([60]);
    expect([
      record(enemy(square, 1)).poolStart,
      toNumber(record(enemy(square, 1)).poolSum),
    ]).toEqual([-Infinity, 0]);
    record(enemy(square, 1)).defence |= ARMOURED;
    expect(volley(square, enemy(square, 1), [11])).toEqual([30]);
    expect(record(enemy(square, 1)).poolStart).toBe(-Infinity);
  });

  it('blocks all three with shieldPoolSec 0, and keeps no pool', () => {
    const ctx = defended([shielder(300)]);
    const one = enemy(ctx, 1);
    expect(ctx.sys.enemyAi.poolTicks).toBe(-1);
    expect(volley(ctx, one, [10, 15, 21])).toEqual(['blocked', 'blocked', 'blocked']);
    expect([record(one).poolStart, toNumber(record(one).poolSum)]).toEqual([-Infinity, 0]);
  });

  it('pools a converted hit’s parts in part order, and no part of damage over time', () => {
    // Half to cold: two hit parts of 60 each.
    const cold = defended([shielder(300)], {
      values: POOL,
      conversions: [{ to: 'cold', fraction: 0.5 }],
    });
    const one = enemy(cold, 1);
    expect(volley(cold, one, [10, 11], 120)).toEqual(['blocked', 120]);
    expect(toNumber(record(one).poolSum)).toBe(240);
    // Half to poison: the hit part of 100 pools; the poison part lands, outside the pool.
    const poison = defended([shielder(300)], {
      values: POOL,
      conversions: [{ to: 'poison', fraction: 0.5 }],
    });
    const two = enemy(poison, 1);
    expect(volley(poison, two, [10, 11], 200)).toEqual([100, 200]);
    expect(toNumber(record(two).poolSum)).toBe(200);
  });
});

describe('集火 with a lent shield, a damage-over-time hit and its rounding (second review)', () => {
  const square = (dx: number): PlacedEnemy => ({
    x: PLAYER.x + dx,
    y: PLAYER.y,
    type: 'square',
    hp: 1000,
  });

  it('pools the hits against a guardian’s lent shield as against an enemy’s own (守護)', () => {
    const ctx = defended([square(300), square(360)], { values: POOL });
    const [one, guardian] = [enemy(ctx, 1), enemy(ctx, 2)];
    ctx.sys.affixes.guardians.push(guardian);
    // The shielder's block, lent: 150 of a square's 1000.
    expect(ctx.sys.affixes.guardBlockPct).toBe(0.15);
    expect(volley(ctx, one, [10, 15, 21])).toEqual(['blocked', 'blocked', 60]);
    expect([record(one).poolStart, toNumber(record(one).poolSum)]).toEqual([10, 180]);
    // Without 集火, the lent shield blocks all three.
    const plain = defended([square(300), square(360)]);
    plain.sys.affixes.guardians.push(enemy(plain, 2));
    expect(volley(plain, enemy(plain, 1), [10, 15, 21])).toEqual(['blocked', 'blocked', 'blocked']);
  });

  it('keeps a hit of a damage-over-time kind out of the pool: it lands whole and adds nothing', () => {
    const ctx = defended([shielder(300)], { values: POOL });
    const one = enemy(ctx, 1);
    const p = (ctx.emitters[0] as EmitterRuntime).payload;
    const poison = createPayload({
      baseDamage: num(60),
      tags: p.tags | TAG.poison,
      source: p.source,
      flags: 0,
      rng: p.rng,
      chains: false,
      rollsAilments: false,
      canCrit: true,
      damageMode: ROWS,
    });
    ctx.now = 10;
    ctx.events.length = 0;
    hitWithPayload(ctx, one, poison, 0, 1, null, null, false, 0, -1);
    expect(eventsOf([ctx.events], 'hitBlocked')).toEqual([]);
    expect(eventsOf([ctx.events], 'hit').map((e) => toNumber((e as HitEvent).amount))).toEqual([
      60,
    ]);
    expect([record(one).poolStart, toNumber(record(one).poolSum)]).toEqual([-Infinity, 0]);
    // The pool starts at the next hit of another kind.
    expect(volley(ctx, one, [11, 12, 13])).toEqual(['blocked', 'blocked', 60]);
    expect([record(one).poolStart, toNumber(record(one).poolSum)]).toEqual([11, 180]);
  });

  it('pools for round(shieldPoolSec × 60) ticks', () => {
    const ctx = defended([shielder(300)], { values: { shieldPoolSec: 0.21 } });
    const one = enemy(ctx, 1);
    expect(ctx.sys.enemyAi.poolTicks).toBe(13);
    // 23 is the 13-tick window's last tick.
    expect(volley(ctx, one, [10, 16, 23])).toEqual(['blocked', 'blocked', 60]);
  });
});

describe('集火 with a converted hit (verification)', () => {
  it('pools a converted part as the shield compares it, after takenMult scales the hit', () => {
    const ctx = defended([shielder(300)], {
      values: POOL,
      conversions: [{ to: 'cold', fraction: 0.5 }],
    });
    const one = enemy(ctx, 1);
    one.frozenUntil = 1000;
    ctx.now = 10;
    const m = takenMult(ctx, one);
    expect(m).toBeGreaterThan(1);
    volley(ctx, one, [10, 11], 120);
    expect(toNumber(record(one).poolSum)).toBeCloseTo(240 * m, 9);
  });
});
