import { describe, expect, it } from 'vitest';
import { add, num, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { RuleSpec } from '../../data/rules';
import type { StatBlock } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { CENTER } from '../build/sources';
import { KILL_BY_BURN } from '../effects/flags';
import type { TestModule } from '../rules';
import { updateAilments } from '../systems/ailments';
import { createRunContext } from '../systems/context';
import type { BurnStack, Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { moveEnemies } from '../systems/movement';
import { releaseEnemies } from '../systems/spawn';
import { startDueWave } from '../systems/waves';
import { centerTriggers, makeConfig, makeStats, makeTestData, stationarySquares } from '../testing';
import { DT } from '../types';
import type { SimEvent } from '../types';
import { applyBurn, applyPoison } from './apply';
import { addBleed, holdsBleed } from './bleed';
import { accrued, addBurn, liveBurnStacks, recordsLeft } from './records';
import { bleedRemaining, burnLeft, consumeAilment, remainingOf } from './remaining';
import { livePoisonStacks, RING_BURN, RING_POISON } from './rings';

const W = 15;

/** A run context on the first wave of `data`, spawned and gridded for tick 1. */
function spawned(
  stats: StatBlock,
  data: GameData = stationarySquares(3),
  rules: readonly RuleSpec[] = [],
  modules: readonly TestModule[] = [],
): RunContext {
  const ctx = createRunContext(makeConfig({ stats, rules }), data, modules);
  ctx.now = 1;
  startDueWave(ctx);
  releaseEnemies(ctx);
  rebuildGrid(ctx);
  ctx.events.length = 0;
  return ctx;
}

/** Runs the ailments system (after movement, when `move`) on every tick up to `to`. */
function advance(ctx: RunContext, to: number, move = false): SimEvent[] {
  const events: SimEvent[] = [];
  while (ctx.now < to) {
    ctx.now++;
    ctx.events.length = 0;
    if (move) moveEnemies(ctx);
    updateAilments(ctx);
    events.push(...ctx.events);
  }
  return events;
}

/** The damage over time `enemy` took in `events`: its burn ticks, or its dotTicks of `ailment`. */
const dealt = (events: readonly SimEvent[], enemy: Enemy, ailment: 'burn' | 'poison' | 'bleed') =>
  events.reduce((sum, e) => {
    if (e.type === 'burnTick' && ailment === 'burn' && e.targetId === enemy.id) {
      return sum + toNumber(e.amount);
    }
    if (e.type === 'dotTick' && e.ailment === ailment && e.targetId === enemy.id) {
      return sum + toNumber(e.amount);
    }
    return sum;
  }, 0);

const expectRel = (actual: number, expected: number, label: string): void => {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-9 * Math.abs(expected));
};

/** A burn stack as the reference keeps it: dps from tick `start` to tick `end`. */
interface RefStack {
  readonly dps: number;
  readonly start: number;
  readonly end: number;
}

/** The damage the reference stacks deal after tick `from`. */
const refLeft = (stacks: readonly RefStack[], from: number): number =>
  stacks.reduce((sum, s) => sum + s.dps * Math.max(0, s.end - Math.max(s.start, from)) * DT, 0);

const enemyAt = (ctx: RunContext, i: number): Enemy => ctx.enemies[i] as Enemy;

describe('burn records', () => {
  // Stacks that end before, inside and after the consume's step, one ended into burnPending.
  const STACKS: readonly RefStack[] = [
    { dps: 4, start: 3, end: 50.5 },
    { dps: 7, start: 9, end: 61 },
    { dps: 2.5, start: 20, end: 140.25 },
    { dps: 11, start: 33, end: 98 },
    { dps: 1, start: 47, end: 300 },
  ];

  /** An enemy given STACKS' burns as records (burnMaxStacks 8), advanced to tick `to`. */
  function burning(to: number): { ctx: RunContext; enemy: Enemy } {
    const ctx = spawned(makeStats({ burnMaxStacks: 8 }));
    const enemy = enemyAt(ctx, 0);
    for (const s of STACKS) {
      advance(ctx, s.start);
      addBurn(ctx, enemy, num(s.dps), s.end, 0, CENTER);
    }
    advance(ctx, to);
    return { ctx, enemy };
  }

  it('counts what the records have left from their last step, pending included', () => {
    const { ctx, enemy } = burning(52);
    // The stack that ended at 50.5 is pending; its ticks after 45 are still due.
    expect(enemy.burns).toHaveLength(4);
    expect(toNumber(enemy.burnPending)).toBeCloseTo(4 * 5.5 * DT, 12);
    const left = refLeft(STACKS, 45);
    expectRel(toNumber(burnLeft(ctx, enemy)), left, 'burnLeft');
    // Not stepped this tick: as recordsLeft counts.
    expectRel(toNumber(recordsLeft(ctx, enemy)), left, 'recordsLeft');
    expectRel(toNumber(remainingOf(ctx, enemy, 'burn')), left, 'remainingOf');
  });

  it.each([0.25, 0.5, 0.8])(
    'consumes %s of it: returned, and every stack deals the rest at its count (C5)',
    (f) => {
      const { ctx, enemy } = burning(52);
      const left = refLeft(STACKS, 45);
      const live = liveBurnStacks(enemy, ctx.now);
      expect(live).toBe(4);
      expectRel(toNumber(consumeAilment(ctx, enemy, 'burn', f)), f * left, 'taken');
      expect(enemy.burns).toHaveLength(4);
      expect(liveBurnStacks(enemy, ctx.now)).toBe(live);
      expectRel(toNumber(remainingOf(ctx, enemy, 'burn')), (1 - f) * left, 'kept');
      // The stacks keep their ends: the count falls as the reference's does.
      advance(ctx, 99);
      expect(liveBurnStacks(enemy, ctx.now)).toBe(
        STACKS.filter((s) => s.end > 99 && s.start <= 99).length,
      );
      const rest = dealt(advance(ctx, 400), enemy, 'burn');
      // From the step at 90 on.
      expectRel(rest, (1 - f) * refLeft(STACKS, 90), 'dealt');
    },
  );

  it('consumes it all with f = 1: no record, nothing pending, no live stack', () => {
    const { ctx, enemy } = burning(52);
    const left = refLeft(STACKS, 45);
    expectRel(toNumber(consumeAilment(ctx, enemy, 'burn', 1)), left, 'taken');
    expect(enemy.burns).toHaveLength(0);
    expect([enemy.burnPending, enemy.burnStacks, enemy.burnNextEnd]).toEqual([ZERO, 0, Infinity]);
    expect(liveBurnStacks(enemy, ctx.now)).toBe(0);
    expect(toNumber(remainingOf(ctx, enemy, 'burn'))).toBe(0);
    expect(dealt(advance(ctx, 400), enemy, 'burn')).toBe(0);
    // A new burn takes a cleared enemy.
    addBurn(ctx, enemy, num(3), 430, 0, CENTER);
    expect(liveBurnStacks(enemy, ctx.now)).toBe(1);
  });

  it('keeps the class shares adding up to burnPending under burnMixed (C5)', () => {
    const stats = makeStats({ burnMaxStacks: 8 });
    const ctx = spawned(stats);
    (ctx as { burnMixed: boolean }).burnMixed = true;
    const enemy = enemyAt(ctx, 0);
    const outer = ctx.sources.index('outer.fire');
    const fusion = ctx.sources.index('fusion.fire.poison');
    addBurn(ctx, enemy, num(4), 20, 0, CENTER);
    addBurn(ctx, enemy, num(6), 21, 0, outer);
    addBurn(ctx, enemy, num(9), 22, 0, fusion);
    addBurn(ctx, enemy, num(1), 200, 0, CENTER);
    advance(ctx, 23);
    const shares = [enemy.burnPendC, enemy.burnPendO, enemy.burnPendF].map(toNumber);
    expect(shares.every((share) => share > 0)).toBe(true);
    consumeAilment(ctx, enemy, 'burn', 0.5);
    const after = [enemy.burnPendC, enemy.burnPendO, enemy.burnPendF].map(toNumber);
    after.forEach((share, i) => expectRel(share, 0.5 * (shares[i] as number), `share ${i}`));
    expectRel(
      after.reduce((sum, share) => sum + share, 0),
      toNumber(enemy.burnPending),
      'sum of the shares',
    );
    consumeAilment(ctx, enemy, 'burn', 1);
    expect([enemy.burnPendC, enemy.burnPendO, enemy.burnPendF]).toEqual([ZERO, ZERO, ZERO]);
  });
});

describe('burnLeft on a tick the enemy has been stepped (R8)', () => {
  it('leaves out the step just dealt, which recordsLeft still counts', () => {
    const seen: { a: Num[]; c: Num[]; victim: Num[] }[] = [];
    let a: Enemy | null = null;
    let b: Enemy | null = null;
    let c: Enemy | null = null;
    const probe: TestModule = (builder) =>
      builder.hook('onKill', (ctx, victim) => {
        if (victim !== b) return;
        const [ea, ec] = [a as Enemy, c as Enemy];
        const stepped = ea.burns.reduce(
          (sum, stack) => add(sum, accrued(ctx, stack, ctx.now)),
          ZERO,
        );
        seen.push({
          a: [burnLeft(ctx, ea), recordsLeft(ctx, ea), stepped],
          c: [burnLeft(ctx, ec), recordsLeft(ctx, ec)],
          victim: [burnLeft(ctx, victim)],
        });
      });
    const ctx = spawned(makeStats({ burnMaxStacks: 3 }), stationarySquares(3), [], [probe]);
    [a, b, c] = [enemyAt(ctx, 0), enemyAt(ctx, 1), enemyAt(ctx, 2)];
    for (const enemy of [a, b, c]) {
      addBurn(ctx, enemy, num(6), 100, 0, CENTER);
      addBurn(ctx, enemy, num(2), 80.5, 0, CENTER);
    }
    advance(ctx, 29);
    b.hp = num(1);
    advance(ctx, 30);
    expect(b.alive).toBe(false);
    expect(seen).toHaveLength(1);
    const [{ a: inA, c: inC, victim }] = seen as [(typeof seen)[number]];
    const [leftA, recordsA, steppedA] = inA.map(toNumber) as [number, number, number];
    // a was stepped at 30 before b's kill: its step 16–30 is dealt.
    expect(steppedA).toBeCloseTo(8 * W * DT, 12);
    expectRel(leftA, recordsA - steppedA, 'a');
    expectRel(leftA, (6 * 70 + 2 * 50.5) * DT, 'a from 30');
    // c is not stepped yet: both count from 15.
    const [leftC, recordsC] = inC.map(toNumber) as [number, number];
    expectRel(leftC, recordsC, 'c');
    expectRel(leftC, (6 * 85 + 2 * 65.5) * DT, 'c from 15');
    // The victim's own step killed it: it is not counted again.
    expectRel(toNumber(victim[0] as Num), (6 * 70 + 2 * 50.5) * DT, 'victim');
  });
});

describe('burn rings and records agree (R10)', () => {
  /** Burns as records (burnMaxStacks 20) or in rings (eternalFlame without a duration change). */
  function both(): RunContext[] {
    return [
      spawned(makeStats({ burnMaxStacks: 20 })),
      spawned(makeStats({ burnMaxStacks: 20 }), stationarySquares(3), [
        { id: 'eternalFlame', durationMore: 0 },
      ]),
    ];
  }

  it('gives equal live stacks and damage left before and after a consume', () => {
    const [records, rings] = both() as [RunContext, RunContext];
    expect([records.burnRings, rings.burnRings]).toEqual([false, true]);
    // Ends on step ticks, where a ring's count and a record's end at the same step.
    const schedule = [
      { at: 2, dps: 3, end: 90, n: 2 },
      { at: 17, dps: 8, end: 60, n: 1 },
      { at: 26, dps: 1.5, end: 240, n: 3 },
      { at: 41, dps: 20, end: 75, n: 1 },
    ];
    const compare = (label: string): void => {
      const [er, eg] = [enemyAt(records, 0), enemyAt(rings, 0)];
      expect(liveBurnStacks(eg, rings.now), label).toBe(liveBurnStacks(er, records.now));
      expectRel(
        toNumber(remainingOf(rings, eg, 'burn')),
        toNumber(remainingOf(records, er, 'burn')),
        label,
      );
    };
    for (const { at, dps, end, n } of schedule) {
      for (const ctx of [records, rings]) {
        advance(ctx, at);
        applyBurn(ctx, enemyAt(ctx, 0), num(dps), end, 0, CENTER, n);
      }
    }
    for (const ctx of [records, rings]) advance(ctx, 52);
    expect(liveBurnStacks(enemyAt(records, 0), 52)).toBe(7);
    compare('before');
    const taken = [records, rings].map((ctx) =>
      toNumber(consumeAilment(ctx, enemyAt(ctx, 0), 'burn', 0.5)),
    );
    expectRel(taken[1] as number, taken[0] as number, 'taken');
    compare('after');
    for (const at of [61, 76, 91, 150]) {
      for (const ctx of [records, rings]) advance(ctx, at);
      compare(`at ${at}`);
    }
  });

  it('gives the rings back with f = 1, holding no burn', () => {
    const [, rings] = both() as [RunContext, RunContext];
    const enemy = enemyAt(rings, 0);
    applyBurn(rings, enemy, num(5), 200, 0, CENTER, 3);
    applyPoison(rings, enemy, num(1), 200, 0, CENTER, 1);
    advance(rings, 20);
    expect([enemy.dotRings, rings.rings.live]).toEqual([2, 2]);
    const left = toNumber(remainingOf(rings, enemy, 'burn'));
    expectRel(toNumber(consumeAilment(rings, enemy, 'burn', 1)), left, 'taken');
    expect([enemy.dotRings, rings.rings.live, enemy.rings[RING_BURN]]).toEqual([1, 1, -1]);
    expect([enemy.burnStacks, enemy.burnRingEnd, liveBurnStacks(enemy, 20)]).toEqual([0, 0, 0]);
    // The poison ring stays as it was.
    expect(livePoisonStacks(enemy, 20)).toBe(1);
    expect(dealt(advance(rings, 300), enemy, 'burn')).toBe(0);
  });
});

describe('poison', () => {
  it('consumes its rings by f, keeping their counts, and gives them back with f = 1', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    const outer = ctx.sources.index('outer.poison');
    applyPoison(ctx, enemy, num(2), 180, 0, CENTER, 2);
    applyPoison(ctx, enemy, num(5), 120, 0, outer, 1);
    advance(ctx, 37);
    const stacks: RefStack[] = [
      { dps: 4, start: 1, end: 180 },
      { dps: 5, start: 1, end: 120 },
    ];
    const left = refLeft(stacks, 30);
    expectRel(toNumber(remainingOf(ctx, enemy, 'poison')), left, 'left');
    expectRel(toNumber(consumeAilment(ctx, enemy, 'poison', 0.3)), 0.3 * left, 'taken');
    expect(livePoisonStacks(enemy, 37)).toBe(3);
    expectRel(toNumber(remainingOf(ctx, enemy, 'poison')), 0.7 * left, 'kept');
    const rest = dealt(advance(ctx, 400), enemy, 'poison');
    expectRel(rest, 0.7 * left, 'dealt');

    const again = spawned(makeStats());
    const other = enemyAt(again, 0);
    applyPoison(again, other, num(2), 180, 0, CENTER, 2);
    advance(again, 37);
    consumeAilment(again, other, 'poison', 1);
    expect([other.dotRings, other.rings[RING_POISON], other.poisonStacks]).toEqual([0, -1, 0]);
    expect([other.poisonRingEnd, again.rings.live]).toEqual([0, 0]);
    expect(dealt(advance(again, 400), other, 'poison')).toBe(0);
  });

  it('reads and consumes a fusion’s ring with the others', () => {
    /** A center ring of 2 dps until 180 and a fusion's of 2 × 3 until 150, advanced to 37. */
    const poisoned = (): { ctx: RunContext; enemy: Enemy } => {
      const ctx = spawned(makeStats());
      const enemy = enemyAt(ctx, 0);
      applyPoison(ctx, enemy, num(2), 180, 0, CENTER, 1);
      applyPoison(ctx, enemy, num(3), 150, 0, ctx.sources.index('fusion.fire.poison'), 2);
      advance(ctx, 37);
      return { ctx, enemy };
    };
    const stacks: RefStack[] = [
      { dps: 2, start: 1, end: 180 },
      { dps: 6, start: 1, end: 150 },
    ];
    const left = refLeft(stacks, 30);
    const { ctx, enemy } = poisoned();
    // The fusion's ring is in the ailment's last slot; the outer slot is empty.
    const slots = (e: Enemy): number[] => Array.from(e.rings.slice(RING_POISON, RING_POISON + 3));
    expect(slots(enemy).map((r) => r >= 0)).toEqual([true, false, true]);
    expectRel(toNumber(remainingOf(ctx, enemy, 'poison')), left, 'left');
    expectRel(toNumber(consumeAilment(ctx, enemy, 'poison', 0.5)), 0.5 * left, 'taken');
    expectRel(toNumber(remainingOf(ctx, enemy, 'poison')), 0.5 * left, 'kept');
    expect(livePoisonStacks(enemy, 37)).toBe(3);
    expectRel(dealt(advance(ctx, 400), enemy, 'poison'), 0.5 * left, 'dealt');

    const again = poisoned();
    expectRel(toNumber(consumeAilment(again.ctx, again.enemy, 'poison', 1)), left, 'all');
    expect([again.enemy.dotRings, again.ctx.rings.live, again.enemy.poisonStacks]).toEqual([
      0, 0, 0,
    ]);
    expect(slots(again.enemy)).toEqual([-1, -1, -1]);
    expect(dealt(advance(again.ctx, 400), again.enemy, 'poison')).toBe(0);
  });
});

describe('bleed (R9)', () => {
  /** Squares that walk at `speed` px/s, immortal, all released on the first tick. */
  const walking = (speed: number): GameData =>
    makeTestData({
      enemies: { square: { hpMult: 1e12, speed } },
      waves: {
        rules: [{ enemy: 'square', fromWave: 1, base: 2, perWave: 0, maxCount: 2 }],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
        waveTimerSec: 1000,
      },
    });

  /** A bleed of 8 dps from tick 7 to 107.5 on an enemy walking at `speed`, advanced to 40. */
  function bleeding(speed: number, freezeAt = Infinity): { ctx: RunContext; enemy: Enemy } {
    const ctx = spawned(makeStats({ bleedStationaryMult: 2 }), walking(speed));
    const enemy = enemyAt(ctx, 0);
    advance(ctx, 7, true);
    addBleed(ctx, enemy, num(8), 107.5, 0, CENTER);
    advance(ctx, Math.min(freezeAt, 40) - 1, true);
    if (freezeAt <= 40) enemy.frozenUntil = 1000;
    advance(ctx, 40, true);
    return { ctx, enemy };
  }

  // Ticks 31–40 accrued since the step at 30; 67.5 still to come.
  it.each([
    ['moving', 30, Infinity, 10, 3],
    ['standing still', 0, Infinity, 0, 2],
    ['frozen at 35 after moving', 30, 35, 4, 2],
  ])('counts a bleed %s', (_label, speed, freezeAt, moved, rate) => {
    const { ctx, enemy } = bleeding(speed as number, freezeAt as number);
    expect(enemy.bleedMovedTicks).toBe(moved);
    const accrued = 8 * DT * (2 * 10 + (3 - 2) * (moved as number));
    const expected = accrued + 8 * 67.5 * DT * (rate as number);
    expectRel(toNumber(bleedRemaining(ctx, enemy)), expected, 'bleedRemaining');
    expectRel(toNumber(remainingOf(ctx, enemy, 'bleed')), expected, 'remainingOf');
  });

  it('counts a bleed fully slowed, not frozen, at the standing rate', () => {
    // A slow of 1 on every enemy (BuildFlags.globalSlow) stops it without freezing it.
    const stop: TestModule = (b) => {
      b.flags.globalSlow = 1;
    };
    const ctx = spawned(makeStats({ bleedStationaryMult: 2 }), walking(30), [], [stop]);
    const enemy = enemyAt(ctx, 0);
    expect([enemy.stepDist > 0, enemy.frozenUntil > 40]).toEqual([true, false]);
    advance(ctx, 7, true);
    addBleed(ctx, enemy, num(8), 107.5, 0, CENTER);
    advance(ctx, 40, true);
    expect(enemy.bleedMovedTicks).toBe(0);
    const expected = 8 * DT * 2 * 10 + 8 * 67.5 * DT * 2;
    expectRel(toNumber(bleedRemaining(ctx, enemy)), expected, 'bleedRemaining');
  });

  it('counts the moved ticks of the step a walking victim’s burn step killed it before (Q7/F1)', () => {
    const corpse: TriggerSpec = {
      on: 'kill',
      when: [{ victimHas: 'bleed' }],
      do: [{ kind: 'detonate', ailment: 'bleed', radius: 100 }],
    };
    const stats = makeStats({ bleedStationaryMult: 2 }, [], centerTriggers([corpse]));
    const ctx = spawned(stats, walking(30));
    const enemy = enemyAt(ctx, 0);
    advance(ctx, 7, true);
    addBleed(ctx, enemy, num(8), 107.5, 0, CENTER);
    applyBurn(ctx, enemy, num(1), 100, 0, CENTER, 1);
    advance(ctx, 44, true);
    enemy.hp = num(1e-6);
    advance(ctx, 45, true);
    expect([enemy.alive, enemy.killKind, enemy.bleedMovedTicks]).toEqual([false, KILL_BY_BURN, 15]);
    // Ticks 31–45, which its step never dealt, all moved: × 2 + (3 − 2); 46–107.5 dead, × 2.
    const [entry] = ctx.pendingKills.slice(0, ctx.pendingCount);
    expectRel(toNumber(entry?.value as Num), 8 * DT * (2 * 15 + 15 + 2 * 62.5), 'value');
  });

  it('counts a dead enemy as standing, and the pending damage of a replaced bleed', () => {
    const { ctx, enemy } = bleeding(30);
    // A stronger bleed replaces it at 40: ticks 31–40 move to pending.
    addBleed(ctx, enemy, num(20), 160, 0, CENTER);
    const pending = 8 * DT * (2 * 10 + 10);
    expectRel(toNumber(enemy.bleedPending), pending, 'pending');
    expectRel(toNumber(bleedRemaining(ctx, enemy)), pending + 20 * 120 * DT * 3, 'alive');
    enemy.alive = false;
    expectRel(toNumber(bleedRemaining(ctx, enemy)), pending + 20 * 120 * DT * 2, 'dead');
  });

  it('counts a bleed that ended since the last step by what it accrued, nothing to come', () => {
    const ctx = spawned(makeStats({ bleedStationaryMult: 2 }), walking(0));
    const enemy = enemyAt(ctx, 0);
    advance(ctx, 7);
    addBleed(ctx, enemy, num(8), 35.5, 0, CENTER);
    advance(ctx, 40);
    // Ended at 35.5, it keeps its slot until the step at 45: ticks 30–35.5 at × 2 are due.
    expect([enemy.bleedUntil, holdsBleed(enemy, ctx.now)]).toEqual([35.5, false]);
    const left = 8 * 5.5 * DT * 2;
    expectRel(toNumber(bleedRemaining(ctx, enemy)), left, 'left');
    expectRel(toNumber(remainingOf(ctx, enemy, 'bleed')), left, 'remainingOf');
    expectRel(dealt(advance(ctx, 45), enemy, 'bleed'), left, 'dealt');
  });

  it('consumes f of it, and with f = 1 leaves the slot empty', () => {
    const { ctx, enemy } = bleeding(0);
    const left = toNumber(bleedRemaining(ctx, enemy));
    expectRel(toNumber(consumeAilment(ctx, enemy, 'bleed', 0.4)), 0.4 * left, 'taken');
    expectRel(toNumber(bleedRemaining(ctx, enemy)), 0.6 * left, 'kept');
    expect(enemy.bleedUntil).toBe(107.5);
    const rest = dealt(advance(ctx, 200), enemy, 'bleed');
    expectRel(rest, 0.6 * left, 'dealt');

    const other = bleeding(30);
    const all = toNumber(bleedRemaining(other.ctx, other.enemy));
    expectRel(toNumber(consumeAilment(other.ctx, other.enemy, 'bleed', 1)), all, 'all');
    const e = other.enemy;
    expect([e.bleedDps, e.bleedPending, e.bleedUntil, e.bleedMovedTicks]).toEqual([
      ZERO,
      ZERO,
      0,
      0,
    ]);
    expect(dealt(advance(other.ctx, 200, true), e, 'bleed')).toBe(0);
    // An empty slot takes any bleed.
    expect(addBleed(other.ctx, e, num(0.1), 300, 0, CENTER)).toBe(true);
  });

  it('consumes the pending damage of a replaced bleed with the rest', () => {
    /** bleeding(0) replaced at 40 by 20 dps until 160: ticks 31–40 at × 2 are pending. */
    const replaced = (): { ctx: RunContext; enemy: Enemy; left: number; pending: number } => {
      const { ctx, enemy } = bleeding(0);
      addBleed(ctx, enemy, num(20), 160, 0, CENTER);
      const pending = 8 * DT * 2 * 10;
      expectRel(toNumber(enemy.bleedPending), pending, 'pending');
      return { ctx, enemy, left: pending + 20 * 120 * DT * 2, pending };
    };
    const { ctx, enemy, left, pending } = replaced();
    expectRel(toNumber(bleedRemaining(ctx, enemy)), left, 'left');
    expectRel(toNumber(consumeAilment(ctx, enemy, 'bleed', 0.5)), 0.5 * left, 'taken');
    expectRel(toNumber(enemy.bleedPending), 0.5 * pending, 'pending kept');
    expectRel(toNumber(bleedRemaining(ctx, enemy)), 0.5 * left, 'kept');
    expectRel(dealt(advance(ctx, 200), enemy, 'bleed'), 0.5 * left, 'dealt');

    const all = replaced();
    expectRel(toNumber(consumeAilment(all.ctx, all.enemy, 'bleed', 1)), all.left, 'all');
    expect([all.enemy.bleedPending, bleedRemaining(all.ctx, all.enemy)]).toEqual([ZERO, ZERO]);
    expect(dealt(advance(all.ctx, 200), all.enemy, 'bleed')).toBe(0);
  });
});

describe('remaining of an enemy without the ailment', () => {
  it('is 0 for each, and records are read only while burnRings is off', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    for (const ailment of ['burn', 'poison', 'bleed'] as const) {
      expect(remainingOf(ctx, enemy, ailment), ailment).toEqual(ZERO);
    }
    // Under burnRings a stray record is not the burn (a build has records or rings).
    const rings = spawned(makeStats(), stationarySquares(1), [
      { id: 'eternalFlame', durationMore: 0 },
    ]);
    const lone = enemyAt(rings, 0);
    lone.burns.push({
      dps: num(5),
      start: 1,
      end: 100,
      depth: 0,
      source: CENTER,
      cls: 0,
    } as BurnStack);
    expect(toNumber(remainingOf(rings, lone, 'burn'))).toBe(0);
    expect(toNumber(burnLeft(rings, lone))).toBeGreaterThan(0);
  });
});
