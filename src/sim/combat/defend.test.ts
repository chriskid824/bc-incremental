/**
 * Enemy defences (docs/v3 C7 design §2.4, src/sim/combat/defend.ts): the shield and the armour
 * of a v3 run's enemy on every hit that reaches it. The design's OWN tests are named in their
 * titles; the rest pin its edge cases and the lead's rulings R1 (a full block stops the shocks
 * its hit's caller adds) and R2 (a full block needs the shield). Shielders here hold 1000 hp, so
 * their shield (blockBelowPct 0.15) blocks every hit part below 150; a square is armoured by
 * setting the bit on its record, as C7.6's 堅甲 will.
 */

import { describe, expect, it } from 'vitest';
import { add, mul, num, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { EmitterGrant, SegmentGrant, StrikeGrant } from '../../data/emitters';
import type { Modifier, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { DamageTag } from '../../data/tags';
import type { ChainBoltSpec, CoinHitSpec, ConversionSpec, TriggerSpec } from '../../data/triggers';
import { addFrost } from '../ailments/frost';
import { addShock } from '../ailments/shock';
import { BURN_TICK_INTERVAL } from '../ailments/records';
import { CENTER } from '../build/sources';
import { dispatchPendingKills, fireOne } from '../effects/dispatch';
import { runEffectQueue } from '../effects/execute';
import { HIT_EVENT, PRIMARY, SIGNATURE } from '../effects/flags';
import { EVENT, SHATTER_TRIGGER } from '../effects/types';
import { runStrike } from '../emitters/strike';
import {
  createPayload,
  IGNORE_ARMOUR,
  IGNORE_SHIELD,
  ROWS,
  SLOT_HIT,
  SLOT_HIT_CRIT,
  SLOT_JUMP,
  SLOT_JUMP_CRIT,
  slotRow,
} from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { updateAilments } from '../systems/ailments';
import { resolveContacts } from '../systems/contact';
import type { Enemy, RunContext } from '../systems/context';
import { impactAt } from '../systems/drones';
import type { EnemyV3 } from '../systems/enemyRecord';
import { stepSegments } from '../systems/segments';
import { eventsOf, makeStats, placedEnemies, rngPositions, v3TestData } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { beginAttack, chainAttack } from './chain';
import { ARMOUR_TAKEN, ARMOURED, bypassOf, SHIELDED } from './defend';
import { hitWithPayload } from './hit';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;
type BlockedEvent = Extract<SimEvent, { type: 'hitBlocked' }>;

/** The player, at the arena's centre; the enemies stand on the line to its right. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (dx: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y,
  ...more,
});
/** A shielder of `hp` (1000 by default: its shield blocks a hit part below 150). */
const shielder = (dx: number, hp = 1000): PlacedEnemy => at(dx, { type: 'shielder', hp });
/** A square of `hp`, immortal in practice by default; armour it with armour(). */
const square = (dx: number, hp?: number): PlacedEnemy =>
  at(dx, hp === undefined ? { type: 'square' } : { type: 'square', hp });

/** No crits and no ignites unless a test says so: a hit deals exactly its base. */
const NO_ROLLS = { critChance: 0, igniteChance: 0 } as const;
/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;
const HEAL: TriggerSpec['do'] = [{ kind: 'heal', lifePct: 0.01 }];

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly mods?: readonly Modifier[];
  readonly triggers?: readonly TriggerSpec[];
  readonly conversions?: readonly ConversionSpec[];
  readonly emitters?: readonly (readonly [string, EmitterGrant])[];
  readonly modules?: readonly TestModule[];
  readonly seed?: number;
}

/**
 * placedEnemies on a v3 run's data, so every enemy holds its record, with these stats over
 * NO_ROLLS, scoped modifiers, center triggers and conversions, emitter grants and modules.
 */
function defended(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, options.mods ?? [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'center', spec })),
      conversions: (options.conversions ?? []).map((spec) => ({ source: 'center', spec })),
      emitters: (options.emitters ?? []).map(([source, grant]) => ({ source, grant })),
    }),
    data: v3TestData(),
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const record = (e: Enemy): EnemyV3 => e.v3 as EnemyV3;
/** Armours `e`, as C7.6's 堅甲 will. */
const armour = (e: Enemy): void => {
  record(e).defence |= ARMOURED;
};
const hp = (e: Enemy): number => toNumber(e.hp);
const signature = (ctx: RunContext): Payload => (ctx.emitters[0] as EmitterRuntime).payload;

/**
 * A payload of the signature's tags, sources, stream and rows at base damage `damage`, rolling
 * ailments and able to crit, with these bypass bits; it chains when `chains` says so, and it is
 * a signature payload that raises chainJump, as the signature arc's is, when `raisesChainJump`
 * says so.
 */
function payload(
  ctx: RunContext,
  damage: number,
  {
    bypass = 0,
    chains = false,
    raisesChainJump = false,
  }: { bypass?: number; chains?: boolean; raisesChainJump?: boolean } = {},
): Payload {
  const p = signature(ctx);
  return createPayload({
    baseDamage: num(damage),
    tags: p.tags,
    source: p.source,
    jumpSource: p.jumpSource,
    flags: raisesChainJump ? SIGNATURE : 0,
    rng: p.rng,
    chains,
    rollsAilments: true,
    canCrit: true,
    damageMode: ROWS,
    raisesChainJump,
    bypass,
    rowsOf: p,
  });
}

/**
 * A primary emitter hit of `p` on `target` at scale 1: depth 0, no trigger, no forced crit. What
 * hitWithPayload returns: false when the defences blocked it in full.
 */
const hit = (ctx: RunContext, target: Enemy, p: Payload): boolean =>
  hitWithPayload(ctx, target, p, 0, 1, null, null, false, 0, -1);

const hits = (ctx: RunContext): HitEvent[] => eventsOf([ctx.events], 'hit');
const blocked = (ctx: RunContext): BlockedEvent[] => eventsOf([ctx.events], 'hitBlocked');
/** Each hit event's target and amount. */
const dealt = (ctx: RunContext): [number, number][] =>
  hits(ctx).map((h) => [h.targetId, toNumber(h.amount)]);

const flat = (stat: StatId, ...tags: DamageTag[]): Modifier => ({
  stat,
  kind: 'flat',
  value: 1,
  ...(tags.length === 0 ? {} : { tags }),
});

describe('the shield', () => {
  it('blocks a hit strictly below blockPct of max life, and one of exactly that lands (OWN test 1)', () => {
    const ctx = defended([shielder(300), shielder(360)]);
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    expect([SHIELDED, ARMOURED]).toEqual([1, 2]);
    expect(record(one)).toMatchObject({ defence: SHIELDED, blockPct: 0.15 });
    expect(mul(one.maxHp, 0.15)).toBe(num(150));
    // The double just below 150.
    const below = 150 - 2 ** -45;
    expect(below < 150).toBe(true);
    hit(ctx, one, payload(ctx, below));
    expect(hp(one)).toBe(1000);
    expect(hits(ctx)).toEqual([]);
    expect(blocked(ctx)).toEqual([
      { type: 'hitBlocked', targetId: 1, x: one.x, y: one.y, amount: num(below), crit: false },
    ]);
    ctx.events.length = 0;
    hit(ctx, two, payload(ctx, 150));
    expect(blocked(ctx)).toEqual([]);
    expect(dealt(ctx)).toEqual([[2, 150]]);
    expect(hp(two)).toBe(850);
  });

  it('blocks a hit of 0 of a hit kind in full, armoured or not: no part of it landed (R2)', () => {
    const ctx = defended([shielder(300), shielder(360)]);
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    armour(two);
    hit(ctx, one, payload(ctx, 0));
    hit(ctx, two, payload(ctx, 0));
    expect(ctx.events).toEqual([
      { type: 'hitBlocked', targetId: 1, x: one.x, y: one.y, amount: ZERO, crit: false },
      { type: 'hitBlocked', targetId: 2, x: two.x, y: two.y, amount: ZERO, crit: false },
    ]);
  });

  it('reads its threshold from max life and the record’s blockPct, not from hp or the def', () => {
    const ctx = defended([shielder(300), shielder(360)]);
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    // At half its hp, 100 is above 15 % of its hp and still below 15 % of its max life.
    one.hp = num(500);
    hit(ctx, one, payload(ctx, 100));
    expect([hp(one), blocked(ctx).length]).toEqual([500, 1]);
    // The record's share decides: at 5 %, 60 passes.
    record(two).blockPct = 0.05;
    hit(ctx, two, payload(ctx, 60));
    expect(dealt(ctx)).toEqual([[2, 60]]);
  });

  it('compares a crit’s amount after its multiplier', () => {
    const critOf = (critMultiplier: number): RunContext => {
      const ctx = defended([shielder(300)], { values: { critChance: 1, critMultiplier } });
      hit(ctx, enemy(ctx, 1), payload(ctx, 100));
      return ctx;
    };
    const landed = critOf(1.6);
    expect(hits(landed).map((h) => [h.crit, toNumber(h.amount)])).toEqual([[true, 160]]);
    const short = critOf(1.4);
    expect(blocked(short).map((e) => [e.crit, toNumber(e.amount)])).toEqual([[true, 140]]);
    expect(hits(short)).toEqual([]);
  });

  it('compares the hit after takenMult and the modifyDamage hooks, which hitBlocked carries', () => {
    // A shock of two stacks takes 1.2 ×: 130 passes as 156, 120 is blocked at 144.
    const shocked = (damage: number): RunContext => {
      const ctx = defended([shielder(300)]);
      const one = enemy(ctx, 1);
      one.shockStacks = 2;
      one.shockUntil = 1000;
      hit(ctx, one, payload(ctx, damage));
      return ctx;
    };
    expect(dealt(shocked(130))).toEqual([[1, toNumber(mul(num(130), 1 + 0.1 * 2))]]);
    expect(blocked(shocked(120)).map((e) => e.amount)).toEqual([mul(num(120), 1 + 0.1 * 2)]);
    // A hook that halves: 200 is blocked as 100.
    const halving: TestModule = (b) =>
      b.hook('modifyDamage', (_ctx, _hit, amount) => mul(amount, 0.5));
    const ctx = defended([shielder(300)], { modules: [halving] });
    hit(ctx, enemy(ctx, 1), payload(ctx, 200));
    expect(blocked(ctx).map((e) => toNumber(e.amount))).toEqual([100]);
  });

  it('lands half of a 20 % hit on a shielded and armoured enemy: the shield tests it before armour (OWN test 11)', () => {
    const ctx = defended([shielder(300), shielder(360)]);
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    armour(one);
    armour(two);
    expect(record(one).defence).toBe(SHIELDED | ARMOURED);
    expect(ARMOUR_TAKEN).toBe(0.5);
    hit(ctx, one, payload(ctx, 200));
    expect(dealt(ctx)).toEqual([[1, 100]]);
    expect(hp(one)).toBe(900);
    // Below the threshold the shield blocks it whole; armour has nothing left to halve.
    hit(ctx, two, payload(ctx, 149));
    expect(blocked(ctx).map((e) => [e.targetId, toNumber(e.amount)])).toEqual([[2, 149]]);
    expect(hp(two)).toBe(1000);
  });

  it('defends only a v3 run’s enemies with a defence: no record, or none in it, lets every hit land', () => {
    const m1 = placedEnemies([at(300)], { stats: makeStats(NO_ROLLS) });
    const plain = enemy(m1, 1);
    expect(plain.v3).toBeNull();
    hit(m1, plain, payload(m1, 1));
    expect(dealt(m1)).toEqual([[1, 1]]);
    const ctx = defended([square(300), at(340, { type: 'regenerator' })]);
    for (const e of ctx.enemies) {
      expect(record(e)).toMatchObject({ defence: 0, blockPct: 0 });
      hit(ctx, e, payload(ctx, 1));
    }
    expect(dealt(ctx)).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(blocked(ctx)).toEqual([]);
  });
});

describe('conversion parts', () => {
  const HALVES: ConversionSpec[] = [
    { to: 'cold', fraction: 0.5 },
    { to: 'poison', fraction: 0.5 },
  ];
  const tallies = (ctx: RunContext) => ({
    hit: toNumber(ctx.damageHit),
    poison: toNumber(ctx.damagePoison),
    source: toNumber(ctx.bySource[signature(ctx).source] as Num),
  });

  it('blocks a converted hit’s cold part below 15 % and deals its poison part, tallied per part (OWN test 2)', () => {
    const ctx = defended([shielder(300)], { conversions: HALVES });
    const one = enemy(ctx, 1);
    hit(ctx, one, payload(ctx, 200));
    // Cold 100 (a hit part, blocked) and poison 100 (damage over time, untouched).
    expect(blocked(ctx)).toEqual([]);
    expect(dealt(ctx)).toEqual([[1, 100]]);
    expect(hp(one)).toBe(900);
    expect(tallies(ctx)).toEqual({ hit: 0, poison: 100, source: 100 });
    const parts = ctx.hitParts;
    expect([parts.n, parts.amount[0], parts.amount[1], parts.total]).toEqual([
      2,
      ZERO,
      num(100),
      num(100),
    ]);
  });

  it('halves an armoured enemy’s hit parts and passes its damage-over-time parts whole', () => {
    const ctx = defended([square(300)], { conversions: HALVES });
    const one = enemy(ctx, 1);
    armour(one);
    hit(ctx, one, payload(ctx, 200));
    expect(dealt(ctx)).toEqual([[1, 150]]);
    expect(tallies(ctx)).toEqual({ hit: 50, poison: 100, source: 150 });
  });

  it('halves the hit parts that pass the shield of a shielded and armoured enemy, and no other part (L8)', () => {
    const QUARTERS: ConversionSpec[] = [
      { to: 'cold', fraction: 0.25 },
      { to: 'poison', fraction: 0.25 },
    ];
    const ctx = defended([shielder(300), shielder(360)], { conversions: QUARTERS });
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    armour(one);
    // Of 400: the share that stays a hit, 200, passes the shield and the armour halves it; the
    // cold part, 100, is below 150 and blocked; the poison part, 100, passes both whole.
    hit(ctx, one, payload(ctx, 400));
    const parts = ctx.hitParts;
    expect([parts.n, parts.amount[0], parts.amount[1], parts.amount[2], parts.total]).toEqual([
      3,
      num(100),
      ZERO,
      num(100),
      num(200),
    ]);
    expect(tallies(ctx)).toEqual({ hit: 100, poison: 100, source: 200 });
    // The same hit on a shielder without armour lands its hit part whole.
    hit(ctx, two, payload(ctx, 400));
    expect(blocked(ctx)).toEqual([]);
    expect(dealt(ctx)).toEqual([
      [1, 200],
      [2, 300],
    ]);
  });

  it('scales the parts by what takenMult and the hooks made of the hit before it tests them', () => {
    const doubling: TestModule = (b) =>
      b.hook('modifyDamage', (_ctx, _hit, amount) => mul(amount, 2));
    const ctx = defended([shielder(300)], { conversions: HALVES, modules: [doubling] });
    hit(ctx, enemy(ctx, 1), payload(ctx, 200));
    // Each part 100 × 2: the cold part passes at 200.
    expect(dealt(ctx)).toEqual([[1, 400]]);
    expect(tallies(ctx)).toEqual({ hit: 200, poison: 200, source: 400 });
  });

  it('gives a hook’s damage on a hit of 0 to the first part, as the tallies do', () => {
    const adding: TestModule = (b) =>
      b.hook('modifyDamage', (_ctx, _hit, amount) => add(amount, num(7)));
    // All of it in a cold part alone: a hit part, which the shield blocks in full.
    const whole = defended([shielder(300)], {
      conversions: [{ to: 'cold', fraction: 1 }],
      modules: [adding],
    });
    hit(whole, enemy(whole, 1), payload(whole, 0));
    expect(blocked(whole).map((e) => toNumber(e.amount))).toEqual([7]);
    // The cold part first: the shield blocks it, and the poison part of 0 is damage over time,
    // so the hit is no full block (R2): it lands 0.
    const cold = defended([shielder(300)], { conversions: HALVES, modules: [adding] });
    hit(cold, enemy(cold, 1), payload(cold, 0));
    expect(blocked(cold)).toEqual([]);
    expect(dealt(cold)).toEqual([[1, 0]]);
    expect(tallies(cold)).toEqual({ hit: 0, poison: 0, source: 0 });
    // The poison part first: damage over time, which lands.
    const poison = defended([shielder(300)], {
      conversions: [HALVES[1] as ConversionSpec, HALVES[0] as ConversionSpec],
      modules: [adding],
    });
    hit(poison, enemy(poison, 1), payload(poison, 0));
    expect(dealt(poison)).toEqual([[1, 7]]);
    expect(tallies(poison)).toEqual({ hit: 0, poison: 7, source: 7 });
  });

  it('lands a converted hit whose hit parts the shield blocks and whose poison part is 0 (R2)', () => {
    // Poison damage × 0: of 200, the cold part 100 is blocked and the poison part is 0.
    const nothing: Modifier = { stat: 'damage', kind: 'more', value: -1, tags: ['poison'] };
    const ctx = defended([shielder(300)], {
      conversions: HALVES,
      mods: [nothing],
      values: { shockChance: 1 },
      triggers: [{ on: 'hit', do: HEAL }],
    });
    const one = enemy(ctx, 1);
    expect(hit(ctx, one, payload(ctx, 200))).toBe(true);
    const parts = ctx.hitParts;
    expect([parts.n, parts.amount[0], parts.amount[1], parts.total]).toEqual([2, ZERO, ZERO, ZERO]);
    expect(blocked(ctx)).toEqual([]);
    expect(dealt(ctx)).toEqual([[1, 0]]);
    expect([one.shockStacks, ctx.effectQueue.size]).toEqual([1, 1]);
    // Without its poison part the same cold part is blocked in full.
    const cold = defended([shielder(300)], { conversions: [{ to: 'cold', fraction: 0.5 }] });
    expect(hit(cold, enemy(cold, 1), payload(cold, 200))).toBe(false);
    expect(blocked(cold).map((e) => toNumber(e.amount))).toEqual([200]);
  });

  it('applies a partly blocked hit’s ailments as any landed hit’s: it is no full block', () => {
    const ctx = defended([shielder(300)], {
      conversions: HALVES,
      values: { shockChance: 1, frostOnHit: 0.5 },
      triggers: [{ on: 'hit', do: HEAL }],
    });
    const one = enemy(ctx, 1);
    hit(ctx, one, payload(ctx, 200));
    expect(blocked(ctx)).toEqual([]);
    expect(dealt(ctx)).toEqual([[1, 100]]);
    expect([one.shockStacks, one.frost, ctx.effectQueue.size]).toEqual([1, 0.5, 1]);
  });
});

describe('armour', () => {
  it('halves hit parts only: damage-over-time parts, burn ticks and poison and bleed steps are unchanged (OWN test 3)', () => {
    const ctx = defended([square(300), square(360)], {
      values: { igniteChance: 1, poisonChance: 1, bleedChance: 1 },
    });
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    armour(one);
    for (const e of [one, two]) hit(ctx, e, payload(ctx, 100));
    expect(dealt(ctx)).toEqual([
      [1, 50],
      [2, 100],
    ]);
    // Two steps of damage over time: the armoured square takes what the other does.
    ctx.events.length = 0;
    while (ctx.now < 2 * BURN_TICK_INTERVAL) {
      ctx.now++;
      updateAilments(ctx);
    }
    const ticks = (id: number): unknown[] =>
      ctx.events.flatMap((event) =>
        event.type === 'burnTick' && event.targetId === id
          ? [['burn', event.amount]]
          : event.type === 'dotTick' && event.targetId === id
            ? [[event.ailment, event.amount]]
            : [],
      );
    expect(ticks(1)).toHaveLength(6);
    expect(ticks(1)).toEqual(ticks(2));
  });

  it('lands a hit of a damage-over-time kind on an armoured enemy whole, shielded or not', () => {
    const ctx = defended([square(300), shielder(360)]);
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    armour(one);
    armour(two);
    const p = signature(ctx);
    // A poison-kind hit of 100, below the shielder's 150: it passes both defences untouched.
    const poisonHit = createPayload({
      baseDamage: num(100),
      tags: p.tags | TAG.poison,
      source: p.source,
      flags: 0,
      rng: p.rng,
      chains: false,
      rollsAilments: true,
      canCrit: true,
      damageMode: ROWS,
    });
    expect(hit(ctx, one, poisonHit)).toBe(true);
    expect(hit(ctx, two, poisonHit)).toBe(true);
    expect(blocked(ctx)).toEqual([]);
    expect(dealt(ctx)).toEqual([
      [1, 100],
      [2, 100],
    ]);
  });
});

describe('a full block needs the shield (lead ruling R2)', () => {
  it('lands a hit of 0 on an enemy whose only defence is armour, as on one without defences', () => {
    const run = (armoured: boolean, conversions: ConversionSpec[] = []): unknown => {
      const ctx = defended([square(300)], {
        values: { shockChance: 1 },
        triggers: [{ on: 'hit', do: HEAL }],
        conversions,
      });
      const one = enemy(ctx, 1);
      if (armoured) armour(one);
      expect(record(one).defence).toBe(armoured ? ARMOURED : 0);
      return {
        returned: hit(ctx, one, payload(ctx, 0)),
        events: ctx.events.map((e) => e.type),
        dealt: dealt(ctx),
        shock: one.shockStacks,
        queued: ctx.effectQueue.size,
      };
    };
    const landed = {
      returned: true,
      events: ['hit', 'ailmentApplied'],
      dealt: [[1, 0]],
      shock: 1,
      queued: 1,
    };
    expect(run(true)).toEqual(landed);
    expect(run(false)).toEqual(landed);
    // A converted one of hit parts alone lands its parts of 0 alike.
    const cold: ConversionSpec[] = [{ to: 'cold', fraction: 0.5 }];
    expect(run(true, cold)).toEqual(landed);
    expect(run(false, cold)).toEqual(landed);
  });

  it('lands a hit of 0 that passes the shield of a shielded and armoured enemy', () => {
    const ctx = defended([shielder(300), shielder(360)], { mods: [flat('ignoreShield', 'chain')] });
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    armour(one);
    armour(two);
    // A coinHit's bit, and the row's ignoreShield on a chain jump.
    hit(ctx, one, payload(ctx, 0, { bypass: IGNORE_SHIELD }));
    hitWithPayload(ctx, two, payload(ctx, 0), 1, 1, one.x, one.y, false, 0, -1);
    expect(blocked(ctx)).toEqual([]);
    expect(dealt(ctx)).toEqual([
      [1, 0],
      [2, 0],
    ]);
    // Without either, both are blocked in full.
    ctx.events.length = 0;
    hit(ctx, one, payload(ctx, 0));
    hit(ctx, two, payload(ctx, 0));
    expect(blocked(ctx).map((e) => e.targetId)).toEqual([1, 2]);
  });

  it('lands a hit of a damage-over-time kind on a shielded enemy whole, 0 included', () => {
    const ctx = defended([shielder(300), shielder(360)]);
    const p = signature(ctx);
    const poisonHit = (damage: number): Payload =>
      createPayload({
        baseDamage: num(damage),
        tags: p.tags | TAG.poison,
        source: p.source,
        flags: 0,
        rng: p.rng,
        chains: false,
        rollsAilments: true,
        canCrit: true,
        damageMode: ROWS,
      });
    expect(hit(ctx, enemy(ctx, 1), poisonHit(0))).toBe(true);
    expect(hit(ctx, enemy(ctx, 2), poisonHit(100))).toBe(true);
    expect(blocked(ctx)).toEqual([]);
    expect(dealt(ctx)).toEqual([
      [1, 0],
      [2, 100],
    ]);
  });
});

describe('a full block', () => {
  it('raises no hit or crit trigger, onHit hook or hit event; it marks the enemy and pushes hitBlocked (OWN test 9)', () => {
    let onHits = 0;
    const counting: TestModule = (b) =>
      b.hook('onHit', () => {
        onHits++;
      });
    const make = (critMultiplier: number): RunContext =>
      defended([shielder(300)], {
        values: { critChance: 1, critMultiplier },
        triggers: [
          { on: 'hit', do: HEAL },
          { on: 'crit', do: HEAL },
        ],
        modules: [counting],
      });
    const ctx = make(1.2);
    const one = enemy(ctx, 1);
    beginAttack(ctx);
    const serial = ctx.attackSerial;
    expect(one.hitMark).not.toBe(serial);
    hit(ctx, one, payload(ctx, 100));
    expect(ctx.events).toEqual([
      {
        type: 'hitBlocked',
        targetId: 1,
        x: one.x,
        y: one.y,
        amount: mul(num(100), 1.2),
        crit: true,
      },
    ]);
    expect([ctx.effectQueue.size, onHits, one.hitMark]).toEqual([0, 0, serial]);
    // It dealt and tallied nothing.
    expect(hp(one)).toBe(1000);
    expect([ctx.maxHit, ctx.damageHit, ctx.damageCrit, ctx.kills]).toEqual([ZERO, ZERO, ZERO, 0]);
    expect(ctx.bySource.every((v) => v === ZERO)).toBe(true);
    // A crit that lands raises both triggers and calls the hook.
    const control = make(2);
    hit(control, enemy(control, 1), payload(control, 100));
    expect([control.effectQueue.size, onHits, dealt(control)]).toEqual([2, 1, [[1, 200]]]);
  });

  it('leaves the burn its ignite rolled, as a landed hit does, and fires its ailmentApplied (OWN test 4)', () => {
    const ctx = defended([shielder(300), square(360)], {
      values: { igniteChance: 1 },
      triggers: [{ on: 'ailmentApplied', when: [{ ailment: 'burn' }], do: HEAL }],
    });
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    hit(ctx, one, payload(ctx, 100));
    hit(ctx, two, payload(ctx, 100));
    expect(blocked(ctx).map((e) => e.targetId)).toEqual([1]);
    expect(dealt(ctx)).toEqual([[2, 100]]);
    // The hit's base × burnDamage 1.5 a second, from this tick for burnDuration's ticks.
    expect(one.burns.map((b) => [b.dps, b.start, b.end])).toEqual([
      [num(150), 1, 1 + ctx.burnTicks],
    ]);
    expect(one.burns).toEqual(two.burns);
    expect(eventsOf([ctx.events], 'ignite').map((e) => e.targetId)).toEqual([1, 2]);
    expect(ctx.effectQueue.size).toBe(2);
  });

  it('burns on the crit’s burn row after a blocked crit', () => {
    const ctx = defended([shielder(300)], {
      values: { igniteChance: 1, critChance: 1, critMultiplier: 1.2 },
      mods: [{ stat: 'damage', kind: 'more', value: 1, tags: ['burn', 'crit'] }],
    });
    const one = enemy(ctx, 1);
    hit(ctx, one, payload(ctx, 100));
    expect(blocked(ctx)).toHaveLength(1);
    expect(one.burns.map((b) => b.dps)).toEqual([mul(mul(num(100), 1.2), 1.5 * 2)]);
  });

  it('applies no burn in a build without burn duration', () => {
    const ctx = defended([shielder(300)], { values: { igniteChance: 1, burnDuration: 0 } });
    const one = enemy(ctx, 1);
    hit(ctx, one, payload(ctx, 100));
    expect(ctx.events.map((e) => e.type)).toEqual(['hitBlocked']);
    expect(one.burns).toEqual([]);
  });

  it('draws what a landed hit draws: every stream ends where it does', () => {
    const ROLLS = {
      critChance: 0.5,
      critMultiplier: 1.2,
      igniteChance: 0.5,
      poisonChance: 0.5,
      bleedChance: 0.5,
      shockChance: 0.5,
    };
    const after = (type: 'shielder' | 'square'): unknown => {
      const ctx = defended([at(300, { type })], { values: ROLLS, seed: 9 });
      for (let n = 0; n < 12; n++) hit(ctx, enemy(ctx, 1), payload(ctx, 100));
      return { rng: rngPositions(ctx), blocks: blocked(ctx).length, hits: hits(ctx).length };
    };
    const shielded = after('shielder') as { blocks: number };
    expect(shielded.blocks).toBe(12);
    expect({ ...shielded, blocks: 0, hits: 12 }).toEqual(after('square'));
  });
});

describe('ailmentOnBlock (OWN test 5)', () => {
  /** Every roll of a hit that applies an ailment, sure; frostOnHit 0.5. */
  const ROLLS = { poisonChance: 1, bleedChance: 1, shockChance: 1, frostOnHit: 0.5 };

  /** A hit of `damage` on a shielder with these modifiers: what it applied, froze and shocked. */
  function applied(
    mods: readonly Modifier[],
    damage = 100,
    values: Partial<Record<StatId, number>> = {},
  ) {
    const ctx = defended([shielder(300)], { values: { ...ROLLS, ...values }, mods });
    const one = enemy(ctx, 1);
    hit(ctx, one, payload(ctx, damage));
    return {
      blocked: blocked(ctx).length,
      ailments: eventsOf([ctx.events], 'ailmentApplied').map((e) => e.ailment),
      frost: one.frost,
      frostApplied: ctx.frostApplied,
      shock: one.shockStacks,
    };
  }
  const none = { frost: 0, frostApplied: false, shock: 0 };

  it.each([
    ['no modifier', [], []],
    ['[poison]', [flat('ailmentOnBlock', 'poison')], ['poison']],
    ['[bleed]', [flat('ailmentOnBlock', 'bleed')], ['bleed']],
    ['an untagged one', [flat('ailmentOnBlock')], ['poison', 'bleed']],
    ['[hit], which no ailment’s row matches', [flat('ailmentOnBlock', 'hit')], []],
  ] as const)('with %s lets through %j and never shock or frost', (_name, mods, ailments) => {
    expect(applied(mods)).toEqual({ blocked: 1, ailments, ...none });
  });

  it('reads a crit’s ailment rows on a blocked crit', () => {
    const critOnly = [flat('ailmentOnBlock', 'poison', 'crit')];
    const crit = { critChance: 1, critMultiplier: 1.2 };
    expect(applied(critOnly, 100, crit)).toEqual({ blocked: 1, ailments: ['poison'], ...none });
    expect(applied(critOnly)).toEqual({ blocked: 1, ailments: [], ...none });
  });

  it('leaves a landed hit’s ailments alone', () => {
    expect(applied([], 200)).toEqual({
      blocked: 0,
      ailments: ['poison', 'bleed', 'shock'],
      frost: 0.5,
      frostApplied: true,
      shock: 1,
    });
  });

  it('changes nothing on hits it does not block: a [poison] ailmentOnBlock (OWN test 12)', () => {
    const run = (mods: readonly Modifier[]): unknown => {
      const ctx = defended(
        [shielder(300), square(340), square(380), at(420, { type: 'triangle' })],
        {
          values: {
            critChance: 0.5,
            critMultiplier: 2,
            igniteChance: 0.5,
            poisonChance: 0.5,
            bleedChance: 0.5,
            shockChance: 0.5,
            frostOnHit: 0.3,
          },
          mods,
          seed: 5,
        },
      );
      armour(enemy(ctx, 3));
      for (let round = 0; round < 8; round++) {
        for (const e of ctx.enemies) if (e.alive) hit(ctx, e, payload(ctx, 400));
      }
      expect(blocked(ctx)).toEqual([]);
      return {
        events: ctx.events.slice(),
        enemies: ctx.enemies.map(({ def: _def, rec: _rec, ...e }) => e),
        rng: rngPositions(ctx),
        tallies: [ctx.damageHit, ctx.damageCrit, ctx.damagePoison, ctx.damageBleed, ctx.maxHit],
      };
    };
    expect(run([flat('ailmentOnBlock', 'poison')])).toEqual(run([]));
  });
});

describe('bypass', () => {
  it('passes a shield with a coinHit’s ignoreShield and armour with its ignoreArmour (OWN test 6)', () => {
    const coin = (spec: Partial<Omit<CoinHitSpec, 'kind'>>): CoinHitSpec => ({
      kind: 'coinHit',
      multiplier: 10,
      ...spec,
    });
    const taken = (spec: Partial<Omit<CoinHitSpec, 'kind'>>): number[] => {
      const ctx = defended([shielder(300), square(360)], {
        triggers: [{ on: 'hit', when: [{ hitIs: 'primary' }], do: [coin(spec)] }],
      });
      const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
      armour(two);
      // Damage 10 × multiplier 10: 100 a coin.
      for (const target of [one, two]) {
        fireOne(ctx, FIRST, 0, -1, target, target.x, target.y, HIT_EVENT | PRIMARY, ZERO, -1);
        runEffectQueue(ctx);
      }
      return [1000 - hp(one), 1e12 - hp(two)];
    };
    expect([IGNORE_SHIELD, IGNORE_ARMOUR]).toEqual([1, 2]);
    expect(taken({})).toEqual([0, 50]);
    expect(taken({ ignoreShield: true })).toEqual([100, 50]);
    expect(taken({ ignoreArmour: true })).toEqual([0, 100]);
    expect(taken({ ignoreShield: true, ignoreArmour: true })).toEqual([100, 100]);
  });

  it('passes armour on crits alone with a crit-tagged ignoreArmour (破甲; OWN test 7)', () => {
    const taken = (critChance: number): unknown => {
      const ctx = defended([square(300)], {
        values: { critChance, critMultiplier: 2 },
        mods: [flat('ignoreArmour', 'crit')],
      });
      armour(enemy(ctx, 1));
      hit(ctx, enemy(ctx, 1), payload(ctx, 100));
      return hits(ctx).map((h) => [h.crit, toNumber(h.amount)]);
    };
    expect(taken(1)).toEqual([[true, 200]]);
    expect(taken(0)).toEqual([[false, 50]]);
  });

  it('passes shields on chain jumps alone with a chain-tagged ignoreShield (破盾電弧; OWN test 8)', () => {
    const chained = (mods: readonly Modifier[]): RunContext => {
      const ctx = defended([shielder(300), shielder(350), shielder(400)], {
        values: { chainRange: 5000, chainRetention: 1 },
        mods,
      });
      chainAttack(ctx, payload(ctx, 100, { chains: true }), enemy(ctx, 1), 2, false, 0, -1);
      return ctx;
    };
    const arc = chained([flat('ignoreShield', 'chain')]);
    // The primary hit is blocked, yet marks its enemy: the jumps go on to 2 and 3.
    expect(blocked(arc).map((e) => e.targetId)).toEqual([1]);
    expect(hits(arc).map((h) => [h.targetId, h.chainIndex, toNumber(h.amount)])).toEqual([
      [2, 1, 100],
      [3, 2, 100],
    ]);
    expect(arc.enemies.map(hp)).toEqual([1000, 900, 900]);
    // Without it every hit is blocked, each marking its enemy, so no jump comes back.
    const plain = chained([]);
    expect(blocked(plain).map((e) => e.targetId)).toEqual([1, 2, 3]);
    expect(hits(plain)).toEqual([]);
  });

  it('adds the bits of the hit row’s ignoreShield and ignoreArmour to the payload’s own', () => {
    const ctx = defended([], {
      mods: [flat('ignoreArmour', 'crit'), flat('ignoreShield', 'chain')],
    });
    const p = payload(ctx, 1);
    const rows = [SLOT_HIT, SLOT_HIT_CRIT, SLOT_JUMP, SLOT_JUMP_CRIT].map((slot) =>
      slotRow(ctx.build, p, slot),
    );
    const bits = (q: Payload): number[] =>
      rows.map((row) => bypassOf(q, ctx.table, row, ctx.evalInput));
    const BOTH = IGNORE_SHIELD | IGNORE_ARMOUR;
    expect(bits(p)).toEqual([0, IGNORE_ARMOUR, IGNORE_SHIELD, BOTH]);
    expect(bits(payload(ctx, 1, { bypass: IGNORE_SHIELD }))).toEqual([
      IGNORE_SHIELD,
      BOTH,
      IGNORE_SHIELD,
      BOTH,
    ]);
  });
});

describe('every defended hit', () => {
  it('defends thorns hits at contact: a blocked one leaves its toucher to leak', () => {
    const ctx = defended(
      [at(0, { type: 'shielder', hp: 1000 }), at(0, { type: 'square', hp: 1000 })],
      {
        values: { maxLife: 1000 },
        emitters: [['outer.thorns', { kind: 'thorns' }]],
      },
    );
    armour(enemy(ctx, 2));
    resolveContacts(ctx);
    // Thorns 3 × damage 10: 30, blocked by the shielder, halved on the armoured square.
    expect(
      ctx.events.flatMap((e): unknown[] =>
        e.type === 'hitBlocked' || e.type === 'hit'
          ? [[e.type, e.targetId, toNumber(e.amount)]]
          : e.type === 'playerHit'
            ? [[e.type, e.enemyId]]
            : [],
      ),
    ).toEqual([
      ['hitBlocked', 1, 30],
      ['playerHit', 1],
      ['hit', 2, 15],
      ['playerHit', 2],
    ]);
  });

  it('defends a shatter’s hits, which take the victim’s max life', () => {
    const ctx = defended([square(0, 1000), shielder(60, 10_000), square(-60)], {
      values: { frostOnHit: 0.1 },
    });
    const [victim, guard, armoured] = [enemy(ctx, 1), enemy(ctx, 2), enemy(ctx, 3)];
    armour(armoured);
    ctx.now = 5;
    addFrost(ctx, victim, 1, CENTER);
    victim.hp = num(1e-9);
    hit(ctx, victim, payload(ctx, 10));
    expect(victim.alive).toBe(false);
    dispatchPendingKills(ctx);
    ctx.now++;
    ctx.events.length = 0;
    runEffectQueue(ctx);
    // 15 % of the victim's 1000: below 15 % of the shielder's 10,000, halved on the square.
    expect(blocked(ctx).map((e) => [e.targetId, toNumber(e.amount)])).toEqual([[guard.id, 150]]);
    expect(dealt(ctx)).toEqual([[armoured.id, 75]]);
  });

  it('defends each hit of a drone impact', () => {
    const ctx = defended([shielder(300), square(310), square(320)], {
      emitters: [['outer.summon', { kind: 'drone', drones: 1 }]],
    });
    armour(enemy(ctx, 2));
    const em = ctx.emitters[1] as EmitterRuntime;
    impactAt(ctx, 0, enemy(ctx, 1), em.payload, em, false, 0, -1);
    expect(blocked(ctx).map((e) => e.targetId)).toEqual([1]);
    const [armouredHit, plainHit] = dealt(ctx);
    expect([armouredHit?.[0], plainHit?.[0]]).toEqual([2, 3]);
    expect(armouredHit?.[1]).toBe((plainHit?.[1] as number) * ARMOUR_TAKEN);
  });
});

describe('a full block stops the shocks after its hit (lead ruling R1)', () => {
  it('hitWithPayload returns false for a hit its defences block in full and true for any other', () => {
    const ctx = defended([shielder(300), shielder(340), square(380), shielder(420)]);
    const [one, two, three, four] = [1, 2, 3, 4].map((id) => enemy(ctx, id)) as [
      Enemy,
      Enemy,
      Enemy,
      Enemy,
    ];
    four.hp = num(100);
    expect(hit(ctx, one, payload(ctx, 100))).toBe(false);
    expect(hit(ctx, two, payload(ctx, 200))).toBe(true);
    expect(hit(ctx, three, payload(ctx, 1))).toBe(true);
    // A hit that kills.
    expect(hit(ctx, four, payload(ctx, 200))).toBe(true);
    expect(four.alive).toBe(false);
    expect(blocked(ctx).map((e) => e.targetId)).toEqual([1]);
    // A converted hit the shield blocks in part: its hit part, not its poison part.
    const parted = defended([shielder(300)], { conversions: [{ to: 'poison', fraction: 0.5 }] });
    expect(hit(parted, enemy(parted, 1), payload(parted, 200))).toBe(true);
    expect(dealt(parted)).toEqual([[1, 100]]);
    // An M1 run's enemy, which has no record.
    const m1 = placedEnemies([at(300)], { stats: makeStats(NO_ROLLS) });
    expect(enemy(m1, 1).v3).toBeNull();
    expect(hit(m1, enemy(m1, 1), payload(m1, 1))).toBe(true);
  });

  it('a chainBolt shocks neither its first hit nor a jump that the shield blocks in full', () => {
    const bolt: ChainBoltSpec = { kind: 'chainBolt', jumps: 1, damagePct: 1, shockStacks: 2 };
    /** A bolt of 10 a hit on enemy 1 that jumps to enemy 2: their shock stacks. */
    const shocks = (placed: readonly PlacedEnemy[], mods: readonly Modifier[] = []): number[] => {
      const ctx = defended(placed, {
        mods,
        triggers: [{ on: 'hit', when: [{ hitIs: 'primary' }], do: [bolt] }],
      });
      const first = enemy(ctx, 1);
      fireOne(ctx, FIRST, 0, -1, first, first.x, first.y, HIT_EVENT | PRIMARY, ZERO, -1);
      runEffectQueue(ctx);
      expect(hits(ctx).length + blocked(ctx).length).toBe(2);
      return ctx.enemies.map((e) => e.shockStacks);
    };
    expect(shocks([shielder(300), square(320)])).toEqual([0, 2]);
    expect(shocks([square(300), shielder(320)])).toEqual([2, 0]);
    expect(shocks([shielder(300), shielder(320)], [flat('ignoreShield')])).toEqual([2, 2]);
  });

  it('a strike shocks neither its target nor a jump that the shield blocks in full', () => {
    const grant: StrikeGrant = {
      kind: 'strike',
      name: 'bolt',
      periodSec: 1,
      target: { pick: 'nearest' },
      damagePct: 1,
      element: 'lightning',
      chainJumps: 1,
      shockStacks: 2,
    };
    /** A strike of 10 at enemy 1, the nearest, that jumps to enemy 2: their shock stacks. */
    const shocks = (placed: readonly PlacedEnemy[], mods: readonly Modifier[] = []): number[] => {
      const ctx = defended(placed, { mods, emitters: [['outer.lightning', grant]] });
      const em = ctx.emitters[1] as EmitterRuntime;
      em.timer = em.interval - 1;
      runStrike(ctx, em);
      expect(hits(ctx).length + blocked(ctx).length).toBe(2);
      return ctx.enemies.map((e) => e.shockStacks);
    };
    expect(shocks([shielder(300), square(320)])).toEqual([0, 2]);
    expect(shocks([square(300), shielder(320)])).toEqual([2, 0]);
    expect(shocks([shielder(300), shielder(320)], [flat('ignoreShield')])).toEqual([2, 2]);
  });

  it('a strike whose target the shield blocks in full still hits the enemies around it', () => {
    const grant: StrikeGrant = {
      kind: 'strike',
      name: 'bolt',
      periodSec: 1,
      target: { pick: 'nearest' },
      damagePct: 1,
      radius: 60,
      element: 'lightning',
      chainJumps: 0,
      shockStacks: 2,
    };
    const ctx = defended([shielder(300), square(320)], { emitters: [['outer.lightning', grant]] });
    const em = ctx.emitters[1] as EmitterRuntime;
    em.timer = em.interval - 1;
    runStrike(ctx, em);
    // Its hit of 10 on the shielder is blocked and shocks nothing; its area hit lands on the
    // square, and area hits add no shock.
    expect(blocked(ctx).map((e) => e.targetId)).toEqual([1]);
    expect(dealt(ctx)).toEqual([[2, 10]]);
    expect(ctx.enemies.map((e) => e.shockStacks)).toEqual([0, 0]);
  });

  it('a segment shocks no enemy whose shield blocks its hit in full', () => {
    const grant: SegmentGrant = { kind: 'segment', endpoints: 'shocked', shockStacks: 2 };
    /** One judgement of a segment of 1 a hit between enemies 1 and 2: their shock stacks. */
    const shocks = (placed: readonly PlacedEnemy[], mods: readonly Modifier[] = []): number[] => {
      const ctx = defended(placed, { mods, emitters: [['outer.lightning', grant]] });
      for (const e of ctx.enemies) addShock(ctx, e, 1, 0);
      const em = ctx.sys.segments.emitters[0] as EmitterRuntime;
      em.timer = em.interval - 1;
      stepSegments(ctx);
      expect(eventsOf([ctx.events], 'pulse')).toHaveLength(1);
      return ctx.enemies.map((e) => e.shockStacks);
    };
    expect(shocks([shielder(300), square(340)])).toEqual([1, 3]);
    expect(shocks([shielder(300), shielder(340)], [flat('ignoreShield')])).toEqual([3, 3]);
  });

  it('raises chainJump on a jump that the shield blocks in full, and chains on from its enemy', () => {
    const seen: number[][] = [];
    const spy: TestModule = (b) =>
      b.hook('onCenterEvent', (_ctx, ev) => {
        seen.push([ev.event, ev.target?.id ?? 0, ev.fromX]);
      });
    const ctx = defended([square(300), shielder(320), shielder(340)], {
      values: { chainRange: 5000, chainRetention: 1 },
      modules: [spy],
    });
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    const p = payload(ctx, 100, { chains: true, raisesChainJump: true });
    chainAttack(ctx, p, one, 2, false, 0, -1);
    expect(dealt(ctx)).toEqual([[1, 100]]);
    expect(blocked(ctx).map((e) => e.targetId)).toEqual([2, 3]);
    expect(seen).toEqual([
      [EVENT.chainJump, 2, one.x],
      [EVENT.chainJump, 3, two.x],
    ]);
  });
});
