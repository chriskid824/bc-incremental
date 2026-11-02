/**
 * 大出血's bleedRings (docs/v3 C7 design §2.10, C3D:1760-1767, lead ruling W2): bleed in DoT rings
 * RING_BLEED .. RING_BLEED + 2 under BuildFlags.bleedRings, at most bleedMaxStacks live stacks
 * an enemy, each step weighed by the ticks the enemy moved in it. §2.10's tests are named in
 * their titles with a comment naming the planted bug each kills; the rest pin W2's readers and
 * writers. BLEED_RINGS is the module 大出血 (B3) will be: bleedRings and bleedMoveMult 1.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber, ZERO } from '../../core/num';
import type { StatBlock } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { compileCondition, conditionsMet, heldFlags } from '../build/eval';
import { CENTER } from '../build/sources';
import { hitWithPayload } from '../combat/hit';
import { applyStacks } from '../effects/execute';
import { heldFlag, KILL_BY_BURN } from '../effects/flags';
import type { EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { updateAilments } from '../systems/ailments';
import { resolveContacts } from '../systems/contact';
import { createRunContext } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { ORBITING, stepEnemyAi } from '../systems/enemyAi';
import { WARDED } from '../systems/enemyRecord';
import type { EnemyV3 } from '../systems/enemyRecord';
import { rebuildGrid } from '../systems/grid';
import { moveEnemies } from '../systems/movement';
import { releaseEnemies } from '../systems/spawn';
import { startDueWave } from '../systems/waves';
import {
  centerTriggers,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  stationarySquares,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DT } from '../types';
import type { SimEvent } from '../types';
import { applyBleed, applyBurn, applyPoison, doomed } from './apply';
import { remainingOf, consumeAilment } from './remaining';
import {
  BLEED_RING_MAX_STACKS,
  bleedRingEnd,
  liveBleedStacks,
  livePoisonStacks,
  RING_BLEED,
  RING_SLOTS,
  RING_SLOTS_BLEED,
} from './rings';

const W = 15;

/** 大出血 (B3): bleed in rings, at the 8-stack cap, × 1 while moving. */
const BLEED_RINGS: TestModule = (b) => {
  b.flags.bleedRings = true;
  b.flags.bleedMoveMult = 1;
};

/** Squares that walk at `speed` px/s, immortal, all released on the first tick. */
const walkingSquares = (count: number, speed: number): GameData =>
  makeTestData({
    enemies: { square: { hpMult: 1e12, speed } },
    waves: {
      rules: [{ enemy: 'square', fromWave: 1, base: count, perWave: 0, maxCount: count }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    },
  });

/** A run context on the first wave of `data`, spawned and gridded for tick 1. */
function spawned(
  stats: StatBlock,
  data: GameData = stationarySquares(3),
  modules: readonly TestModule[] = [BLEED_RINGS],
): RunContext {
  const ctx = createRunContext(makeConfig({ stats }), data, modules);
  ctx.now = 1;
  startDueWave(ctx);
  releaseEnemies(ctx);
  rebuildGrid(ctx);
  ctx.events.length = 0;
  return ctx;
}

/** Runs movement (when `move`) and the ailments system on every tick up to `to`, by tick. */
function advance(ctx: RunContext, to: number, move = false): Map<number, SimEvent[]> {
  const byTick = new Map<number, SimEvent[]>();
  while (ctx.now < to) {
    ctx.now++;
    ctx.events.length = 0;
    if (move) moveEnemies(ctx);
    updateAilments(ctx);
    if (ctx.events.length !== 0) byTick.set(ctx.now, ctx.events.slice());
  }
  return byTick;
}

type DotTick = Extract<SimEvent, { type: 'dotTick' }>;

/** The amount of each bleed dotTick on `enemy`, by tick. */
const bleedTicks = (byTick: Map<number, SimEvent[]>, enemy: Enemy): Map<number, number> =>
  new Map(
    [...byTick].flatMap(([tick, events]) =>
      events
        .filter((e): e is DotTick => e.type === 'dotTick' && e.ailment === 'bleed')
        .filter((e) => e.targetId === enemy.id)
        .map((e): [number, number] => [tick, toNumber(e.amount)]),
    ),
  );

const enemyAt = (ctx: RunContext, i: number): Enemy => ctx.enemies[i] as Enemy;

/** Ticks of (lo, hi] inside (from, to]. */
const overlap = (lo: number, hi: number, from: number, to: number): number =>
  Math.max(0, Math.min(hi, to) - Math.max(lo, from));

/** `n` bleed stacks of `dps` each over ticks (from, to]. */
interface Stacks {
  readonly n: number;
  readonly dps: number;
  readonly from: number;
  readonly to: number;
}

/** The reference: step k of `stacks`, tick by tick, each tick × weight(tick). */
const refStep = (stacks: readonly Stacks[], k: number, weight: (t: number) => number): number => {
  let sum = 0;
  for (let t = W * (k - 1) + 1; t <= W * k; t++) {
    for (const s of stacks) sum += s.n * s.dps * DT * overlap(t - 1, t, s.from, s.to) * weight(t);
  }
  return sum;
};

/** The enemy's bleed ring of source class `cls` (0 center), or −1. */
const bleedRing = (e: Enemy, cls = 0): number => e.rings[RING_BLEED + cls] as number;

describe('bleedRings against the per-tick reference (C3D:1766)', () => {
  it('deals each step what a per-tick reference of its stacks deals, with the 8-stack cap and × 1 moving (§2.10 test 1)', () => {
    // Planted bug: the weight applied per tick to the whole sum (the next test weighs it).
    const ctx = spawned(makeStats(), walkingSquares(1, 30));
    const enemy = enemyAt(ctx, 0);
    const start = enemy.dist;
    const events = new Map<number, SimEvent[]>();
    const held: number[] = [];
    const at = (now: number, dps: number, to: number, n: number): void => {
      for (const [tick, more] of advance(ctx, now, true)) events.set(tick, more);
      held.push(applyBleed(ctx, enemy, num(dps), to, 0, CENTER, n));
    };
    at(7, 4, 107.5, 3);
    at(20, 2, 80, 2);
    at(33, 6, 123.25, 4);
    at(40, 9, 140, 1);
    // The two stacks that ended at 80 left at their last step, 90.
    at(95, 5, 170, 3);
    // Those that ended at 107.5 and 123.25 left at 120 and 135.
    at(136, 3, 200, 7);
    for (const [tick, more] of advance(ctx, 230, true)) events.set(tick, more);
    // The stacks the enemy holds after each: the third and the last cut at 8, the fourth
    // refused.
    expect(held).toEqual([3, 5, 8, 0, 8, 8]);
    const taken: Stacks[] = [
      { n: 3, dps: 4, from: 7, to: 107.5 },
      { n: 2, dps: 2, from: 20, to: 80 },
      { n: 3, dps: 6, from: 33, to: 123.25 },
      { n: 2, dps: 5, from: 95, to: 170 },
      { n: 6, dps: 3, from: 136, to: 200 },
    ];
    const dealt = bleedTicks(events, enemy);
    expect([...dealt.keys()]).toEqual(Array.from({ length: 14 }, (_, i) => W * (i + 1)));
    for (const [tick, amount] of dealt) {
      expect(amount, `tick ${tick}`).toBeCloseTo(
        refStep(taken, tick / W, () => 1),
        10,
      );
    }
    // It walked every tick (2 to 230); the strongest-only slot was never touched; the ring went
    // back.
    expect(start - enemy.dist).toBeCloseTo(229 * 0.5, 9);
    expect([enemy.bleedUntil, toNumber(enemy.bleedDps), toNumber(enemy.bleedPending)]).toEqual([
      0, 0, 0,
    ]);
    expect([bleedRing(enemy), enemy.dotRings, ctx.rings.live]).toEqual([-1, 0, 0]);
  });

  it('weighs each step’s sum by the ticks the enemy moved in it, exact where the rate holds through the step', () => {
    // Planted bug: the weight of one tick (the step's) applied to the whole sum.
    const ctx = spawned(makeStats({ bleedStationaryMult: 2 }), stationarySquares(1));
    const enemy = enemyAt(ctx, 0);
    // Moving on ticks 16–22 (7 of step 2), 31–45 (all of step 3) and 61–65 (5 of step 5).
    const moving = (t: number): boolean =>
      (t >= 16 && t <= 22) || (t >= 31 && t <= 45) || (t >= 61 && t <= 65);
    const events = new Map<number, SimEvent[]>();
    const left: number[] = [];
    const run = (to: number): void => {
      while (ctx.now < to) {
        ctx.now++;
        ctx.events.length = 0;
        enemy.stepDist = moving(ctx.now) ? 0.5 : 0;
        moveEnemies(ctx);
        updateAilments(ctx);
        if (ctx.events.length !== 0) events.set(ctx.now, ctx.events.slice());
      }
    };
    run(15);
    applyBleed(ctx, enemy, num(4), 75, 0, CENTER, 2);
    run(30);
    applyBleed(ctx, enemy, num(3), 60, 0, CENTER, 1);
    run(50);
    // Standing still at 50, moving at 62: what is left at the rate of now (bleedStationaryMult 2,
    // bleedMoveMult 1).
    left.push(toNumber(remainingOf(ctx, enemy, 'bleed')));
    run(62);
    left.push(toNumber(remainingOf(ctx, enemy, 'bleed')));
    run(90);
    const stacks: Stacks[] = [
      { n: 2, dps: 4, from: 15, to: 75 },
      { n: 1, dps: 3, from: 30, to: 60 },
    ];
    const weight = (t: number): number => (moving(t) ? 1 : 2);
    const dealt = bleedTicks(events, enemy);
    expect([...dealt.keys()]).toEqual([30, 45, 60, 75]);
    for (const [tick, amount] of dealt) {
      expect(amount, `tick ${tick}`).toBeCloseTo(refStep(stacks, tick / W, weight), 10);
    }
    // Step 2: 8 × (8 × 2 + 7 × 1) / 15 a tick's worth over 15 ticks.
    expect(dealt.get(30)).toBeCloseTo(8 * DT * 23, 10);
    // At 50, ticks 46–60 and 61–75 to come at × 2; at 62, the step after 60's at × 1.
    expect(left[0]).toBeCloseTo((11 + 8) * 15 * DT * 2, 10);
    expect(left[1]).toBeCloseTo(8 * 15 * DT * 1, 10);
  });

  it('counts a move on its last stack’s last tick, and none once the stack has ended', () => {
    // Planted bug: a move counted only while a stack outlives the tick (an end after now).
    const ctx = spawned(makeStats({ bleedStationaryMult: 2 }), stationarySquares(1));
    const enemy = enemyAt(ctx, 0);
    const events = new Map<number, SimEvent[]>();
    const run = (to: number, moving: (t: number) => boolean): void => {
      while (ctx.now < to) {
        ctx.now++;
        ctx.events.length = 0;
        enemy.stepDist = moving(ctx.now) ? 0.5 : 0;
        moveEnemies(ctx);
        updateAilments(ctx);
        if (ctx.events.length !== 0) events.set(ctx.now, ctx.events.slice());
      }
    };
    run(15, () => false);
    // A stack over (15, 45], the enemy moving from 40 on: the last 6 ticks of step 3, then all
    // of step 4 with no bleed left, which counts for nothing.
    applyBleed(ctx, enemy, num(4), 45, 0, CENTER, 1);
    run(60, (t) => t >= 40);
    applyBleed(ctx, enemy, num(4), 75, 0, CENTER, 1);
    run(90, () => false);
    const dealt = bleedTicks(events, enemy);
    expect([...dealt.keys()]).toEqual([30, 45, 75]);
    expect(dealt.get(30)).toBeCloseTo(4 * DT * 30, 10);
    // Step 3: (2 × 9 + 1 × 6) / 15 a tick's worth over 15 ticks.
    expect(dealt.get(45)).toBeCloseTo(4 * DT * 24, 10);
    expect(dealt.get(75)).toBeCloseTo(4 * DT * 30, 10);
  });
});

describe('the cap (W2)', () => {
  it('takes the 8th stack and refuses the 9th (§2.10 test 2)', () => {
    // Planted bug: `>` (the cap refuses only above bleedMaxStacks).
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 10;
    expect(BLEED_RING_MAX_STACKS).toBe(8);
    expect(ctx.build.flags.bleedMaxStacks).toBe(8);
    const held = Array.from({ length: 8 }, () => applyBleed(ctx, enemy, num(2), 300, 0, CENTER, 1));
    expect(held).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const r = bleedRing(enemy);
    const remaining = ctx.rings.remaining[r];
    expect(applyBleed(ctx, enemy, num(2), 300, 0, CENTER, 1)).toBe(0);
    expect(applyBleed(ctx, enemy, num(50), 400, 0, CENTER, 3)).toBe(0);
    expect([ctx.rings.stacks[r], ctx.rings.remaining[r]]).toEqual([8, remaining]);
    expect(liveBleedStacks(ctx.rings, enemy, ctx.now)).toBe(8);
  });

  it('takes as many of a batch as there is room for, across the three source classes', () => {
    const ctx = spawned(makeStats());
    const [one, two] = [enemyAt(ctx, 0), enemyAt(ctx, 1)];
    ctx.now = 10;
    expect(applyBleed(ctx, one, num(1), 300, 0, CENTER, 5)).toBe(5);
    expect(applyBleed(ctx, one, num(1), 300, 0, CENTER, 5)).toBe(8);
    expect(ctx.rings.stacks[bleedRing(one)]).toBe(8);
    // Center and outer rings share the cap.
    const outer = ctx.sources.index('outer.bleed');
    expect(applyBleed(ctx, two, num(1), 300, 0, CENTER, 5)).toBe(5);
    expect(applyBleed(ctx, two, num(1), 300, 0, outer, 4)).toBe(8);
    expect([ctx.rings.stacks[bleedRing(two, 0)], ctx.rings.stacks[bleedRing(two, 1)]]).toEqual([
      5, 3,
    ]);
    expect(applyBleed(ctx, two, num(1), 300, 0, outer, 1)).toBe(0);
  });

  it('reads the cap from BuildFlags.bleedMaxStacks, which a module sets', () => {
    const three: TestModule = (b) => {
      b.flags.bleedMaxStacks = 3;
    };
    const ctx = spawned(makeStats(), stationarySquares(1), [BLEED_RINGS, three]);
    const enemy = enemyAt(ctx, 0);
    ctx.now = 10;
    expect(applyBleed(ctx, enemy, num(1), 300, 0, CENTER, 5)).toBe(3);
    expect(applyBleed(ctx, enemy, num(1), 300, 0, CENTER, 1)).toBe(0);
  });

  it('frees a place once the stacks have ended, before the step that deals their tail', () => {
    // Planted bug: ended stacks counted against the cap (the rings' stacks read without their
    // end).
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 10;
    expect(applyBleed(ctx, enemy, num(2), 100, 0, CENTER, 8)).toBe(8);
    advance(ctx, 99);
    expect(liveBleedStacks(ctx.rings, enemy, 99)).toBe(8);
    expect(applyBleed(ctx, enemy, num(2), 200, 0, CENTER, 1)).toBe(0);
    advance(ctx, 101);
    // All ended at 100; their ring keeps their tail until the step at 105.
    expect(ctx.rings.stacks[bleedRing(enemy)]).toBe(8);
    expect(liveBleedStacks(ctx.rings, enemy, 101)).toBe(0);
    expect(applyBleed(ctx, enemy, num(2), 200, 0, CENTER, 3)).toBe(3);
  });

  it('counts an ended stack until its last step while its ring holds a live one, as poison counts', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 10;
    applyBleed(ctx, enemy, num(2), 100, 0, CENTER, 4);
    applyBleed(ctx, enemy, num(2), 200, 0, CENTER, 4);
    advance(ctx, 101);
    expect(liveBleedStacks(ctx.rings, enemy, 101)).toBe(8);
    expect(applyBleed(ctx, enemy, num(2), 300, 0, CENTER, 1)).toBe(0);
    advance(ctx, 105);
    expect(liveBleedStacks(ctx.rings, enemy, 105)).toBe(4);
    expect(applyBleed(ctx, enemy, num(2), 300, 0, CENTER, 6)).toBe(8);
  });

  it('pushes ailmentApplied with the stacks held, from a hit and from the applyAilment path, and none at the cap', () => {
    const ctx = placedEnemies([{ x: ARENA_WIDTH / 2 + 300, y: ARENA_HEIGHT / 2 }], {
      stats: makeStats({ bleedChance: 1, critChance: 0, igniteChance: 0 }),
      modules: [BLEED_RINGS],
    });
    const enemy = enemyAt(ctx, 0);
    const p = (ctx.emitters[0] as EmitterRuntime).payload;
    const applied = (): number[] =>
      ctx.events.flatMap((e) =>
        e.type === 'ailmentApplied' && e.ailment === 'bleed' ? [e.stacks] : [],
      );
    for (let i = 0; i < 6; i++) hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, 0, -1);
    expect(applied()).toEqual([1, 2, 3, 4, 5, 6]);
    ctx.events.length = 0;
    applyStacks(ctx, 'bleed', enemy, p, p.baseDamage, 5, 0, -1);
    hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, 0, -1);
    applyStacks(ctx, 'bleed', enemy, p, p.baseDamage, 1, 0, -1);
    expect(applied()).toEqual([8]);
    expect(liveBleedStacks(ctx.rings, enemy, ctx.now)).toBe(8);
  });
});

describe('the ring array (W2)', () => {
  it('keeps M1’s ring length of 6 in an M1 run and a plain v3 run, and 9 under bleedRings (§2.10 test 3)', () => {
    // Planted bug: RING_SLOTS raised for every run.
    expect([RING_SLOTS, RING_SLOTS_BLEED, RING_BLEED]).toEqual([6, 9, 6]);
    const lengths = (data: GameData, modules: readonly TestModule[]): number[] =>
      spawned(makeStats(), data, modules).enemies.map((e) => e.rings.length);
    const v3 = v3TestData({
      waves: {
        rules: [{ enemy: 'shielder', fromWave: 1, base: 2, perWave: 0, maxCount: 2 }],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
        v3: { ...TEST_V3_WAVES.v3, affixes: [] },
      },
    });
    expect(lengths(stationarySquares(2), [])).toEqual([6, 6]);
    expect(lengths(v3, [])).toEqual([6, 6]);
    expect(lengths(stationarySquares(2), [BLEED_RINGS])).toEqual([9, 9]);
    expect(lengths(v3, [BLEED_RINGS])).toEqual([9, 9]);
  });

  it('keeps a bleed in the strongest-only slot without bleedRings, whatever the cap flag says', () => {
    const ctx = spawned(makeStats(), stationarySquares(1), []);
    const enemy = enemyAt(ctx, 0);
    ctx.now = 10;
    expect(ctx.build.flags.bleedRings).toBe(false);
    expect(applyBleed(ctx, enemy, num(2), 100, 0, CENTER, 5)).toBe(1);
    expect(applyBleed(ctx, enemy, num(1), 100, 0, CENTER, 5)).toBe(0);
    expect([enemy.bleedUntil, toNumber(enemy.bleedDps), enemy.dotRings]).toEqual([100, 2, 0]);
  });
});

describe('every bleed reader and writer reads the rings (W2)', () => {
  it('detonates and consumes the rings’ bleed: what is left, a share of it, then all of it', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 15;
    applyBleed(ctx, enemy, num(4), 255, 0, CENTER, 2);
    applyBleed(ctx, enemy, num(2), 135, 0, ctx.sources.index('outer.bleed'), 1);
    // 8 × 4 s + 2 × 2 s, standing still (× 1).
    expect(toNumber(remainingOf(ctx, enemy, 'bleed'))).toBeCloseTo(36, 10);
    expect(toNumber(consumeAilment(ctx, enemy, 'bleed', 0.25))).toBeCloseTo(9, 10);
    expect(toNumber(remainingOf(ctx, enemy, 'bleed'))).toBeCloseTo(27, 10);
    // The stacks stay; each deals 0.75 of what it did.
    expect(liveBleedStacks(ctx.rings, enemy, ctx.now)).toBe(3);
    const step = bleedTicks(advance(ctx, 30), enemy).get(30) as number;
    expect(step).toBeCloseTo(0.75 * 10 * W * DT, 10);
    expect(toNumber(consumeAilment(ctx, enemy, 'bleed', 1))).toBeCloseTo(27 - step, 10);
    expect([bleedRing(enemy, 0), bleedRing(enemy, 1), enemy.dotRings, ctx.rings.live]).toEqual([
      -1, -1, 0, 0,
    ]);
    expect([toNumber(remainingOf(ctx, enemy, 'bleed')), enemy.bleedMovedTicks]).toEqual([0, 0]);
    expect(liveBleedStacks(ctx.rings, enemy, ctx.now)).toBe(0);
  });

  it('counts the rings’ bleed in doomed while a stack lasts', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 15;
    applyBleed(ctx, enemy, num(4), 255, 0, CENTER, 1); // 16 left
    enemy.hp = num(16);
    expect(doomed(ctx, enemy)).toBe(true);
    enemy.hp = num(16.5);
    expect(doomed(ctx, enemy)).toBe(false);
    // Targeting runs before the ailments step: in tick 255 its last stack still counts.
    advance(ctx, 254);
    ctx.now = 255;
    enemy.hp = num(1e-3);
    expect(doomed(ctx, enemy)).toBe(true);
    ctx.now = 256;
    expect(doomed(ctx, enemy)).toBe(false);
  });

  it('holds bleed for targetHas and a kill’s flags while a ring’s stack lasts, in a run only', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    const has = [compileCondition({ targetHas: 'bleed' })];
    ctx.now = 16;
    expect(conditionsMet(has, enemy, 16, 0, ctx)).toBe(false);
    applyBleed(ctx, enemy, num(6), 40, 0, CENTER, 2);
    expect(bleedRingEnd(ctx.rings, enemy)).toBe(40);
    for (const [now, holds] of [
      [16, true],
      [39, true],
      [40, false],
    ] as const) {
      expect(conditionsMet(has, enemy, now, 0, ctx), `tick ${now}`).toBe(holds);
      expect((heldFlags(enemy, now, ctx) & heldFlag('bleed')) !== 0, `tick ${now}`).toBe(holds);
    }
    // Outside a run, no enemy holds a ring.
    expect(conditionsMet(has, enemy, 20, 0, null)).toBe(false);
    expect(heldFlags(enemy, 20) & heldFlag('bleed')).toBe(0);
  });

  it('detonates a victim’s ring bleed at its kill, through victimHas, and its death gives the rings back', () => {
    const corpse: TriggerSpec = {
      on: 'kill',
      when: [{ victimHas: 'bleed' }],
      do: [{ kind: 'detonate', ailment: 'bleed', radius: 100 }],
    };
    const ctx = spawned(makeStats({}, [], centerTriggers([corpse])), walkingSquares(1, 30));
    const enemy = enemyAt(ctx, 0);
    advance(ctx, 7, true);
    applyBleed(ctx, enemy, num(8), 107.5, 0, CENTER, 2);
    applyBurn(ctx, enemy, num(1), 100, 0, CENTER, 1);
    advance(ctx, 44, true);
    enemy.hp = num(1e-6);
    advance(ctx, 45, true);
    expect([enemy.alive, enemy.killKind]).toEqual([false, KILL_BY_BURN]);
    // Its burn killed it before its bleed's step at 45: ticks 31–107.5 of 2 × 8, dead (× 1).
    const [entry] = ctx.pendingKills.slice(0, ctx.pendingCount);
    expect(toNumber(entry?.value ?? ZERO)).toBeCloseTo(16 * DT * (107.5 - 30), 10);
    // The kill's flags, which victimHas reads at the dispatch, hold its ring bleed (killEnemy's
    // heldFlags with the run).
    expect(((entry?.flags ?? 0) & heldFlag('bleed')) !== 0).toBe(true);
    expect([bleedRing(enemy), enemy.dotRings, ctx.rings.live]).toEqual([-1, 0, 0]);
  });

  it('gives the bleed rings back when their enemy leaks', () => {
    // Planted bug: releaseAilments looping over RING_SLOTS, M1's 6.
    const ctx = placedEnemies([{ x: ARENA_WIDTH / 2 + 30, y: ARENA_HEIGHT / 2 }], {
      stats: makeStats({ maxLife: 1e6 }),
      modules: [BLEED_RINGS],
    });
    const enemy = enemyAt(ctx, 0);
    applyBleed(ctx, enemy, num(2), 300, 0, CENTER, 3);
    applyBleed(ctx, enemy, num(2), 300, 0, ctx.sources.index('outer.bleed'), 3);
    expect([enemy.dotRings, ctx.rings.live]).toEqual([2, 2]);
    resolveContacts(ctx);
    expect([enemy.alive, enemy.rec.leaked]).toEqual([false, true]);
    expect([bleedRing(enemy, 0), bleedRing(enemy, 1), enemy.dotRings, ctx.rings.live]).toEqual([
      -1, -1, 0, 0,
    ]);
  });

  it('counts an orbiting treasure’s turns as moves for its bleed rings, as for the strongest-only slot', () => {
    const data = v3TestData({
      enemies: { treasure: { hpMult: 1e12 } },
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
    const ctx = placedEnemies(
      [
        { x: ARENA_WIDTH / 2 + 480, y: ARENA_HEIGHT / 2, type: 'treasure', speed: 150 },
        { x: ARENA_WIDTH / 2 + 700, y: ARENA_HEIGHT / 2, type: 'square', speed: 60 },
      ],
      { data, modules: [BLEED_RINGS] },
    );
    const [treasure, square] = [enemyAt(ctx, 0), enemyAt(ctx, 1)];
    for (const e of [treasure, square]) applyBleed(ctx, e, num(8), ctx.now + 600, 0, CENTER, 1);
    for (let k = 0; k < 20; k++) {
      stepEnemyAi(ctx);
      moveEnemies(ctx);
      ctx.now++;
    }
    // Each counts every tick its ring runs through, tick 1's included: the stacks were applied
    // before its movement (in a run, hits come after it).
    expect((treasure.v3 ?? { state: -1 }).state).toBe(ORBITING);
    expect([treasure.bleedMovedTicks, square.bleedMovedTicks]).toEqual([20, 20]);
  });
});

describe('bleed rings beside poison rings, the ward, the depth and a consume (second review)', () => {
  it('steps poison before bleed, and never writes poison’s stack count or end from the bleed rings', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 10;
    applyPoison(ctx, enemy, num(1), 100, 0, CENTER, 2);
    applyBleed(ctx, enemy, num(2), 200, 0, CENTER, 5);
    const poison = (): number[] => [
      enemy.poisonStacks,
      enemy.poisonRingEnd,
      livePoisonStacks(enemy, ctx.now),
    ];
    expect([...poison(), liveBleedStacks(ctx.rings, enemy, ctx.now)]).toEqual([2, 100, 2, 5]);
    const step = advance(ctx, 15).get(15) ?? [];
    expect(
      step.flatMap((e) => (e.type === 'dotTick' && e.targetId === enemy.id ? [e.ailment] : [])),
    ).toEqual(['poison', 'bleed']);
    expect(poison()).toEqual([2, 100, 2]);
    consumeAilment(ctx, enemy, 'bleed', 0.5);
    expect(poison()).toEqual([2, 100, 2]);
    consumeAilment(ctx, enemy, 'bleed', 1);
    expect([...poison(), liveBleedStacks(ctx.rings, enemy, ctx.now)]).toEqual([2, 100, 2, 0]);
  });

  it('takes the ward’s × 0.25 on a ring bleed, as on every ailment a warded enemy takes', () => {
    const ctx = placedEnemies(
      [
        { x: ARENA_WIDTH / 2 + 300, y: ARENA_HEIGHT / 2 },
        { x: ARENA_WIDTH / 2 + 360, y: ARENA_HEIGHT / 2 },
      ],
      { data: v3TestData(), modules: [BLEED_RINGS] },
    );
    const [plain, warded] = [enemyAt(ctx, 0), enemyAt(ctx, 1)];
    (warded.v3 as EnemyV3).defence |= WARDED;
    for (const e of [plain, warded]) applyBleed(ctx, e, num(4), ctx.now + 120, 0, CENTER, 1);
    const left = (e: Enemy): number => toNumber(remainingOf(ctx, e, 'bleed'));
    expect(left(plain)).toBeCloseTo(4 * 120 * DT, 10);
    expect(left(warded)).toBeCloseTo(0.25 * left(plain), 10);
  });

  it('lowers the enemy’s ailment depth to the shallowest bleed it holds, as poison does', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 10;
    const start = enemy.ailDepth;
    expect(start).toBeGreaterThan(2);
    applyBleed(ctx, enemy, num(1), 100, 2, CENTER, 1);
    expect(enemy.ailDepth).toBe(2);
    applyBleed(ctx, enemy, num(1), 100, 1, CENTER, 1);
    applyBleed(ctx, enemy, num(1), 100, 2, CENTER, 1);
    expect(enemy.ailDepth).toBe(1);
  });

  it('refuses a bleed that would end by now, as the strongest-only slot does', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 10;
    expect(applyBleed(ctx, enemy, num(2), 10, 0, CENTER, 1)).toBe(0);
    expect([bleedRing(enemy), enemy.dotRings, ctx.rings.live]).toEqual([-1, 0, 0]);
  });

  it('forgets the moves it counted for a bleed that a consume emptied', () => {
    // Standing still at × 2, moving at × 1.
    const ctx = spawned(makeStats({ bleedStationaryMult: 2 }), stationarySquares(1));
    const enemy = enemyAt(ctx, 0);
    const run = (to: number, moving: boolean): Map<number, SimEvent[]> => {
      const events = new Map<number, SimEvent[]>();
      while (ctx.now < to) {
        ctx.now++;
        ctx.events.length = 0;
        enemy.stepDist = moving ? 0.5 : 0;
        moveEnemies(ctx);
        updateAilments(ctx);
        if (ctx.events.length !== 0) events.set(ctx.now, ctx.events.slice());
      }
      return events;
    };
    ctx.now = 15;
    applyBleed(ctx, enemy, num(4), 200, 0, CENTER, 1);
    run(20, true);
    expect(enemy.bleedMovedTicks).toBe(5);
    consumeAilment(ctx, enemy, 'bleed', 1);
    expect(enemy.bleedMovedTicks).toBe(0);
    // A new bleed from 20, standing still: its step at 30 deals ticks 21–30 at × 2.
    applyBleed(ctx, enemy, num(4), 200, 0, CENTER, 1);
    const dealt = bleedTicks(run(30, false), enemy);
    expect(dealt.get(30)).toBeCloseTo(4 * DT * 10 * 2, 10);
  });
});

describe('bleed rings: the fusion ring’s stacks (verification)', () => {
  it('counts the fusion ring’s stacks against the cap with the center’s', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 10;
    const fusion = ctx.sources.index('fusion.fire.poison');
    expect(applyBleed(ctx, enemy, num(1), 300, 0, fusion, 6)).toBe(6);
    expect(bleedRing(enemy, 2)).toBeGreaterThanOrEqual(0);
    expect(liveBleedStacks(ctx.rings, enemy, ctx.now)).toBe(6);
    expect(applyBleed(ctx, enemy, num(1), 300, 0, CENTER, 5)).toBe(8);
    expect(applyBleed(ctx, enemy, num(1), 300, 0, CENTER, 1)).toBe(0);
  });
});
