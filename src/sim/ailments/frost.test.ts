import { describe, expect, it } from 'vitest';
import { mul, num, toNumber } from '../../core/num';
import type { Num } from '../../core/num';
import type { RuleSpec } from '../../data/rules';
import type { Modifier, StatBlock, StatExtras } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { compileBuild } from '../build/compile';
import { compileCondition, compileScaling, conditionsMet, heldFlags } from '../build/eval';
import type { EvalInput } from '../build/eval';
import { CENTER } from '../build/sources';
import { hitWithPayload } from '../combat/hit';
import { raiseFreeze } from '../effects/centerEvents';
import { dispatchPendingKills } from '../effects/dispatch';
import { runEffectQueue } from '../effects/execute';
import { heldFlag } from '../effects/flags';
import { EVENT, SHATTER_TRIGGER } from '../effects/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { updateAilments } from '../systems/ailments';
import { createRunContext } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { moveEnemies } from '../systems/movement';
import { releaseEnemies } from '../systems/spawn';
import { startDueWave } from '../systems/waves';
import { makeConfig, makeStats, makeTestData } from '../testing';
import { DT, NO_INPUT } from '../types';
import type { RunConfig, SimEvent } from '../types';
import { addBleed } from './bleed';
import { applyPoison } from './apply';
import { addFrost, enemySlow, frostMeter, holdsFrost, holdsFrozen } from './frost';
import { addShock, takenMult } from './shock';

const W = 15;
const NO_ROLLS = { critChance: 0, igniteChance: 0, projectileCount: 1 } as const;
const heal = { kind: 'heal', lifePct: 0.01 } as const;

/** Triggers credited to `source`, as collectExtras gives them. */
const sourced = (source: string, ...specs: TriggerSpec[]): StatExtras => ({
  triggers: specs.map((spec) => ({ source, spec })),
  conversions: [],
});

/**
 * One wave of `squares` squares and `bosses` bosses, immortal, walking at `speed` px/s (0:
 * standing still), all released on the first tick.
 */
const field = (squares: number, bosses = 0, speed = 0): GameData =>
  makeTestData({
    enemies: { square: { hpMult: 1e12, speed }, boss: { hpMult: 1e12, speed } },
    waves: {
      rules: [
        { enemy: 'square', fromWave: 1, base: squares, perWave: 0, maxCount: squares },
        ...(bosses > 0
          ? [{ enemy: 'boss' as const, fromWave: 1, base: bosses, perWave: 0, maxCount: bosses }]
          : []),
      ],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    },
  });

/** A run context on the first wave of `data`, spawned and gridded for tick 1. */
function spawned(
  stats: StatBlock,
  data: GameData,
  modules: readonly TestModule[] = [],
  rules: readonly RuleSpec[] = [],
): RunContext {
  const ctx = createRunContext(makeConfig({ stats, rules }), data, modules);
  ctx.now = 1;
  startDueWave(ctx);
  releaseEnemies(ctx);
  rebuildGrid(ctx);
  ctx.events.length = 0;
  return ctx;
}

const normals = (ctx: RunContext): Enemy[] => ctx.enemies.filter((e) => !e.boss);
const bossOf = (ctx: RunContext): Enemy => ctx.enemies.find((e) => e.boss) as Enemy;
const signature = (ctx: RunContext): Payload => (ctx.emitters[0] as EmitterRuntime).payload;

/** An emitter hit (depth 0, no origin) of the signature attack on `enemy`. */
const emitterHit = (ctx: RunContext, enemy: Enemy): void =>
  hitWithPayload(ctx, enemy, signature(ctx), 0, 1, null, null, false, 0, -1);

type HitEvent = Extract<SimEvent, { type: 'hit' }>;
const hitsOn = (ctx: RunContext, enemy: Enemy): HitEvent[] =>
  ctx.events.filter((e): e is HitEvent => e.type === 'hit' && e.targetId === enemy.id);

/** The triggers of the queued effects, oldest first, emptying the queue. */
function drain(ctx: RunContext): number[] {
  const q = ctx.effectQueue;
  const origins = Array.from(
    { length: q.size },
    (_, n) => q.origin[(q.head + n) & q.capMask] as number,
  );
  q.size = 0;
  return origins;
}

describe('the chill meter', () => {
  it('freezes a normal enemy for 72 ticks, then keeps its meter empty for 180 (A4)', () => {
    const ctx = spawned(makeStats(), field(1));
    const [enemy] = normals(ctx) as [Enemy];
    ctx.now = 10;
    expect(addFrost(ctx, enemy, 0.6, CENTER)).toBe(false);
    expect(frostMeter(enemy, 10)).toBe(0.6);
    expect(addFrost(ctx, enemy, 0.5, CENTER)).toBe(true);
    expect([enemy.frozenUntil, enemy.frostLockUntil, enemy.frost]).toEqual([82, 262, 0]);
    // Frozen from its freeze tick through tick 71 of the freeze; the meter reads full.
    for (const now of [10, 50, 81]) {
      expect(holdsFrozen(enemy, now)).toBe(true);
      expect(frostMeter(enemy, now)).toBe(1);
    }
    // Thawed at tick 72 with an empty meter that frost cannot fill for 180 ticks.
    for (const now of [82, 200, 261]) {
      ctx.now = now;
      expect(holdsFrozen(enemy, now)).toBe(false);
      expect(addFrost(ctx, enemy, 0.9, CENTER)).toBe(false);
      expect(frostMeter(enemy, now)).toBe(0);
    }
    ctx.now = 262;
    expect(addFrost(ctx, enemy, 0.3, CENTER)).toBe(false);
    expect(frostMeter(enemy, 262)).toBe(0.3);
  });

  it('never freezes a boss: its event, an empty meter and a 252-tick lock', () => {
    const ctx = spawned(makeStats({ ...NO_ROLLS, frostOnHit: 0.5 }), field(0, 1));
    const boss = bossOf(ctx);
    ctx.now = 30;
    emitterHit(ctx, boss);
    expect(ctx.events.filter((e) => e.type === 'freeze')).toEqual([]);
    emitterHit(ctx, boss);
    expect(ctx.events.filter((e) => e.type === 'freeze')).toEqual([
      { type: 'freeze', targetId: boss.id, boss: true },
    ]);
    expect([boss.frozenUntil, boss.frostLockUntil, frostMeter(boss, 30)]).toEqual([0, 282, 0]);
    expect(holdsFrozen(boss, 30)).toBe(false);
    ctx.now = 281;
    expect(addFrost(ctx, boss, 1, CENTER)).toBe(false);
    ctx.now = 282;
    expect(addFrost(ctx, boss, 0.4, CENTER)).toBe(false);
    expect(frostMeter(boss, 282)).toBe(0.4);
  });

  it("takes Absolute Zero's flags: no immunity after a freeze, a boss lock of at least 60", () => {
    const absoluteZero: TestModule = (b) => {
      b.flags.frostImmuneTicks = 0;
      b.flags.bossLockTicks = 0;
      b.flags.bossMinGapTicks = 60;
      b.flags.globalSlow = 0.3;
    };
    const ctx = spawned(makeStats(), field(2, 1, 60), [absoluteZero]);
    const [enemy, other] = normals(ctx) as [Enemy, Enemy];
    const boss = bossOf(ctx);
    ctx.now = 10;
    expect(addFrost(ctx, enemy, 1, CENTER)).toBe(true);
    expect(addFrost(ctx, boss, 1, CENTER)).toBe(true);
    expect([enemy.frozenUntil, enemy.frostLockUntil, boss.frostLockUntil]).toEqual([82, 82, 70]);
    ctx.now = 82;
    expect(addFrost(ctx, enemy, 1, CENTER)).toBe(true);
    ctx.now = 69;
    expect(addFrost(ctx, boss, 0.5, CENTER)).toBe(false);
    ctx.now = 70;
    expect(addFrost(ctx, boss, 0.5, CENTER)).toBe(false);
    expect(boss.frost).toBe(0.5);
    // Every enemy is slowed 30%, a boss included: the boss's frost cap stays lower.
    ctx.now = 200;
    for (const e of [other, boss]) {
      const before = e.dist;
      moveEnemies(ctx);
      expect(before - e.dist).toBeCloseTo(e.stepDist * 0.7, 12);
    }
  });
});

describe('the freeze payload limit (A28)', () => {
  it('runs the fusions’ payloads for 8 freezes in any 60 ticks; the rest freeze all the same', () => {
    const hooked: number[] = [];
    const fusionHook = Object.assign(
      (b: Parameters<TestModule>[0]) => {
        b.hook('onCenterEvent', (ctx) => {
          hooked.push(ctx.now);
        });
      },
      { source: 'fusion.ice.fire' },
    );
    const stats = makeStats({ ...NO_ROLLS, frostOnHit: 1 }, [], {
      triggers: [
        ...sourced('center', { on: 'freeze', do: [heal] }).triggers,
        ...sourced('fusion.ice.fire', { on: 'freeze', do: [heal] }).triggers,
      ],
      conversions: [],
    });
    const ctx = spawned(stats, field(12), [fusionHook]);
    const [own, fusion] = ctx.build.triggersOn[EVENT.freeze] as Int32Array;
    expect(ctx.freezeLimiter).not.toBeNull();
    const enemies = normals(ctx);
    const freezeAt = (now: number, enemy: Enemy): number[] => {
      ctx.now = now;
      emitterHit(ctx, enemy);
      expect(holdsFrozen(enemy, now)).toBe(true);
      return drain(ctx);
    };
    // Eight freezes in one tick run both triggers and the hook.
    for (let i = 0; i < 8; i++) expect(freezeAt(10, enemies[i] as Enemy)).toEqual([own, fusion]);
    // The ninth, and any until 60 ticks after the oldest, run only the center's trigger.
    expect(freezeAt(10, enemies[8] as Enemy)).toEqual([own]);
    expect(freezeAt(69, enemies[9] as Enemy)).toEqual([own]);
    expect(ctx.counters.freezePayloadsLimited).toBe(2);
    expect(hooked).toEqual(Array<number>(8).fill(10));
    expect(freezeAt(70, enemies[10] as Enemy)).toEqual([own, fusion]);
    expect(hooked).toHaveLength(9);
    expect(ctx.events.filter((e) => e.type === 'freeze')).toHaveLength(11);
  });

  it('is off without a fusion listening to freezes', () => {
    const ctx = spawned(
      makeStats({ frostOnHit: 1 }, [], sourced('center', { on: 'freeze', do: [heal] })),
      field(1),
    );
    expect(ctx.freezeLimiter).toBeNull();
    const enemy = normals(ctx)[0] as Enemy;
    for (let i = 0; i < 20; i++) raiseFreeze(ctx, enemy, 0, -1, 0);
    expect(drain(ctx)).toHaveLength(20);
    expect(ctx.counters.freezePayloadsLimited).toBe(0);
  });
});

describe('slow (A5, A17)', () => {
  it('slows 30% at a full meter, a boss 15%; frostSlowCap +0.2 makes it 50% and 35%', () => {
    for (const [cap, normal, boss] of [
      [0.3, 0.3, 0.15],
      [0.3 + 0.2, 0.5, 0.35],
    ] as const) {
      const ctx = spawned(makeStats({ frostSlowCap: cap }), field(1, 1, 60));
      const [enemy] = normals(ctx) as [Enemy];
      const big = bossOf(ctx);
      enemy.frost = 1;
      big.frost = 1;
      expect(enemySlow(ctx, enemy, 5)).toBeCloseTo(normal, 12);
      expect(enemySlow(ctx, big, 5)).toBeCloseTo(boss, 12);
      enemy.frost = 0.5;
      expect(enemySlow(ctx, enemy, 5)).toBeCloseTo(normal / 2, 12);
    }
  });

  it('shortens the step of chilled enemies only, and stops frozen ones', () => {
    const ctx = spawned(makeStats(), field(3, 1, 60));
    const [chilled, plain, frozen] = normals(ctx) as [Enemy, Enemy, Enemy];
    const boss = bossOf(ctx);
    expect(ctx.frostApplied).toBe(false);
    ctx.now = 2;
    addFrost(ctx, chilled, 0.5, CENTER);
    addFrost(ctx, boss, 0.5, CENTER);
    addFrost(ctx, frozen, 1, CENTER);
    expect(ctx.frostApplied).toBe(true);
    const before = [chilled, plain, frozen, boss].map((e) => e.dist);
    ctx.now = 3;
    moveEnemies(ctx);
    const moved = [chilled, plain, frozen, boss].map((e, i) => (before[i] as number) - e.dist);
    expect(moved[0]).toBeCloseTo(chilled.stepDist * (1 - 0.15), 12);
    // No slow term at all: the whole step, as M1's movement takes it, bit for bit.
    expect(plain.dist).toBe((before[1] as number) - plain.stepDist);
    expect(moved[2]).toBe(0);
    expect(moved[3]).toBeCloseTo(boss.stepDist * (1 - 0.075), 12);
  });
});

describe('damage taken (A28)', () => {
  it('takes ×1.3 while frozen, hits and damage over time alike; shock adds to it', () => {
    const ctx = spawned(makeStats({ ...NO_ROLLS, shockEffect: 0.1, shockMaxStacks: 3 }), field(2));
    const [a, b] = normals(ctx) as [Enemy, Enemy];
    ctx.now = 15;
    addFrost(ctx, a, 1, CENTER);
    expect(takenMult(ctx, a)).toBe(1.3);
    emitterHit(ctx, a);
    emitterHit(ctx, b);
    const [onA, onB] = [hitsOn(ctx, a), hitsOn(ctx, b)].map((h) => (h[0] as HitEvent).amount);
    expect(onA).toEqual(mul(onB as Num, 1.3));
    addShock(ctx, a, 2, 0);
    expect(takenMult(ctx, a)).toBe(1 + 0.3 + 0.1 * 2);
    // A poison step on the frozen and shocked enemy, against one on the other.
    for (const enemy of [a, b]) applyPoison(ctx, enemy, num(4), 75, 0, CENTER, 1);
    ctx.events.length = 0;
    ctx.now = 30;
    updateAilments(ctx);
    const steps = (enemy: Enemy) =>
      ctx.events
        .filter((e) => e.type === 'dotTick' && e.targetId === enemy.id)
        .map((e) => toNumber((e as { amount: Num }).amount));
    expect(steps(a)).toEqual(steps(b).map((x) => toNumber(mul(num(x), 1.5))));
    // Thawed and unshocked: nothing more.
    ctx.now = 400;
    expect(takenMult(ctx, a)).toBe(1);
  });
});

describe('bleed while frozen (A11)', () => {
  /** Step k of bleed segments, each weighted per tick. */
  const bleedStep = (
    dps: number,
    segments: readonly { from: number; to: number; weight: number }[],
    k: number,
  ): number =>
    segments.reduce(
      (sum, s) =>
        sum +
        dps * DT * s.weight * Math.max(0, Math.min(W * k, s.to) - Math.max(W * (k - 1), s.from)),
      0,
    );

  it('bleeds ×1 while frozen and ×3 once thawed; a chilled enemy that moves bleeds ×3', () => {
    const ctx = spawned(makeStats(), field(2, 0, 30));
    const [frozen, chilled] = normals(ctx) as [Enemy, Enemy];
    ctx.now = 3;
    moveEnemies(ctx);
    for (const enemy of [frozen, chilled]) addBleed(ctx, enemy, num(6), 3 + 100.25, 0, CENTER);
    addFrost(ctx, chilled, 0.5, CENTER);
    const dealt = new Map<number, number[]>();
    while (ctx.now < 130) {
      ctx.now++;
      ctx.events.length = 0;
      moveEnemies(ctx);
      // Frozen from tick 20 through 91; it moves again at tick 92 (step 7 spans the thaw).
      if (ctx.now === 20) addFrost(ctx, frozen, 1, CENTER);
      if (ctx.now === 59) expect(frozen.bleedMovedTicks).toBe(0);
      updateAilments(ctx);
      for (const e of ctx.events) {
        if (e.type === 'dotTick' && e.ailment === 'bleed') {
          dealt.set(e.targetId, [...(dealt.get(e.targetId) ?? []), toNumber(e.amount)]);
        }
      }
    }
    const frozenSegments = [
      { from: 3, to: 20, weight: 3 },
      { from: 20, to: 91, weight: 1 },
      { from: 91, to: 103.25, weight: 3 },
    ];
    const frozenSteps = dealt.get(frozen.id) as number[];
    const chilledSteps = dealt.get(chilled.id) as number[];
    expect(frozenSteps).toHaveLength(7);
    expect(chilledSteps).toHaveLength(7);
    // Steps 2 to 6 (ticks 30 to 90) land while it is frozen: frozenDamageTaken applies.
    frozenSteps.forEach((amount, i) => {
      const taken = i >= 1 && i <= 5 ? 1.3 : 1;
      expect(amount, `step ${i + 1}`).toBeCloseTo(bleedStep(6, frozenSegments, i + 1) * taken, 12);
    });
    chilledSteps.forEach((amount, i) => {
      const moving = [{ from: 3, to: 103.25, weight: 3 }];
      expect(amount, `step ${i + 1}`).toBeCloseTo(bleedStep(6, moving, i + 1), 12);
    });
  });
});

describe('frost readers', () => {
  it('reads the meter through frostMeter for targetFrost, targetHas and the kill flags', () => {
    const ctx = spawned(makeStats(), field(2, 1));
    const [chilled, frozen] = normals(ctx) as [Enemy, Enemy];
    const boss = bossOf(ctx);
    ctx.now = 5;
    addFrost(ctx, chilled, 0.4, CENTER);
    addFrost(ctx, frozen, 1, CENTER);
    addFrost(ctx, boss, 1, CENTER);
    const scaling = compileScaling({ per: 'targetFrost' });
    const evOn = (target: Enemy | null): EvalInput => ({
      now: 5,
      target,
      chainJump: 0,
      playerLifeFrac: 1,
    });
    expect([chilled, frozen, boss, null].map((e) => scaling.read(evOn(e)))).toEqual([0.4, 1, 0, 0]);
    const hasFrost = [compileCondition({ targetHas: 'frost' })];
    const isFrozen = [compileCondition({ targetHas: 'frozen' })];
    expect([chilled, frozen, boss].map((e) => conditionsMet(hasFrost, e, 5, 0))).toEqual([
      true,
      true,
      false,
    ]);
    expect([chilled, frozen, boss].map((e) => conditionsMet(isFrozen, e, 5, 0))).toEqual([
      false,
      true,
      false,
    ]);
    const both = heldFlag('frost') | heldFlag('frozen');
    expect([chilled, frozen, boss].map((e) => heldFlags(e, 5) & both)).toEqual([
      heldFlag('frost'),
      both,
      0,
    ]);
    // Frozen at tick 5 through 76: thawed with an empty meter at tick 77.
    expect([holdsFrost(frozen, 76), holdsFrost(frozen, 77)]).toEqual([true, false]);
  });
});

describe('shatter (D10)', () => {
  const near = 60;
  const far = 120;

  /**
   * A context with `victim`, the normal enemy at the player's position, and two immortal
   * squares at `near` and `far` from it; `victim` dies to any hit.
   */
  function arena(
    stats: StatBlock,
    rules: readonly RuleSpec[] = [],
    modules: readonly TestModule[] = [],
  ): { ctx: RunContext; victim: Enemy; inside: Enemy; outside: Enemy } {
    const ctx = spawned(stats, field(3), modules, rules);
    const [victim, inside, outside] = normals(ctx) as [Enemy, Enemy, Enemy];
    const { x, y } = ctx.player;
    victim.x = x;
    victim.y = y;
    inside.x = x + near;
    inside.y = y;
    outside.x = x;
    outside.y = y + far;
    victim.hp = num(1e-9);
    rebuildGrid(ctx);
    return { ctx, victim, inside, outside };
  }

  /** Kills `victim` with an emitter hit, then dispatches and runs its pending kills. */
  function killAndRun(ctx: RunContext, victim: Enemy): number[] {
    emitterHit(ctx, victim);
    expect(victim.alive).toBe(false);
    const recorded = ctx.pendingKills.slice(0, ctx.pendingCount).map((p) => p.trigger);
    dispatchPendingKills(ctx);
    ctx.now++;
    runEffectQueue(ctx);
    return recorded;
  }

  const frostStats = (modifiers: readonly Modifier[] = [], values = {}, extras?: StatExtras) =>
    makeStats({ ...NO_ROLLS, frostOnHit: 0.1, ...values }, modifiers, extras);

  /**
   * Credits no ailment kind to the center, as a character of another archetype does frost (M1
   * credits every kind to it): a shatter then goes to the ice board.
   */
  const noOwnAilments = (ctx: RunContext): void => {
    (ctx.attribution as { centerAilments: number }).centerAilments = 0;
  };

  it('shatters only a frozen victim, for its max life × shatterDamage around it', () => {
    // An unfrozen kill records nothing and computes no credit.
    const unfrozen = arena(frostStats());
    noOwnAilments(unfrozen.ctx);
    expect(killAndRun(unfrozen.ctx, unfrozen.victim)).toEqual([]);
    expect(unfrozen.ctx.sources.names).toEqual(['center']);
    expect(unfrozen.ctx.events.filter((e) => e.type === 'shatter')).toEqual([]);

    const { ctx, victim, inside, outside } = arena(frostStats());
    noOwnAilments(ctx);
    ctx.now = 5;
    addFrost(ctx, victim, 1, CENTER);
    const maxHp = victim.maxHp;
    expect(killAndRun(ctx, victim)).toEqual([SHATTER_TRIGGER]);
    // Frost is not the character's own here: the shatter goes to the ice board.
    const ice = ctx.sources.names.indexOf('outer.ice');
    expect(ice).toBeGreaterThan(0);
    expect(ctx.events.filter((e) => e.type === 'shatter')).toEqual([
      { type: 'shatter', x: victim.x, y: victim.y, radius: 90 },
    ]);
    const [hit] = hitsOn(ctx, inside);
    expect(hitsOn(ctx, inside)).toHaveLength(1);
    expect(hitsOn(ctx, outside)).toEqual([]);
    expect(hit).toMatchObject({
      tags: TAG.hit | TAG.area | TAG.cold,
      source: ice,
      crit: false,
      amount: mul(maxHp, 0.15),
    });
  });

  it('credits a fusion’s freeze to the fusion, which takes its fusion-scoped when bonus', () => {
    const bonus: Modifier = {
      stat: 'damage',
      kind: 'more',
      value: 1,
      scope: 'fusion',
      when: [{ targetKind: 'normal' }],
    };
    const shattered = (applier: string): HitEvent => {
      const { ctx, victim, inside } = arena(frostStats([bonus]));
      ctx.now = 5;
      addFrost(ctx, victim, 1, ctx.sources.index(applier));
      killAndRun(ctx, victim);
      return hitsOn(ctx, inside)[0] as HitEvent;
    };
    const own = shattered('center');
    const fusion = shattered('fusion.ice.fire');
    expect(own.source).toBe(CENTER);
    expect(fusion.source).toBeGreaterThan(CENTER);
    expect(fusion.amount).toEqual(mul(own.amount, 2));
  });

  it('takes center-scoped when bonuses and glassCannon’s ×2, nothing unbounded, never crits', () => {
    const scaledStats = frostStats(
      [
        // Taken: a bounded bonus of the center.
        {
          stat: 'damage',
          kind: 'more',
          value: 0.5,
          scope: 'center',
          when: [{ targetKind: 'normal' }],
        },
        // Left out: an untagged more (強化∞), a static fusion more (mastery), the outer boards'.
        { stat: 'damage', kind: 'more', value: 3 },
        { stat: 'damage', kind: 'more', value: 0.04, scope: 'fusion.ice.fire' },
        {
          stat: 'damage',
          kind: 'more',
          value: 9,
          scope: 'outer',
          when: [{ targetKind: 'normal' }],
        },
      ],
      { critAlways: 1 },
    );
    const glassCannon: RuleSpec[] = [{ id: 'glassCannon', damageMore: 1 }];
    const plain = arena(frostStats());
    const scaled = arena(scaledStats, glassCannon);
    // The same build, its frost credited to the ice board: only shatterMult applies.
    const outer = arena(scaledStats, glassCannon);
    noOwnAilments(outer.ctx);
    expect(scaled.ctx.build.flags.shatterMult).toBe(2);
    for (const { ctx, victim } of [plain, scaled, outer]) {
      ctx.now = 5;
      addFrost(ctx, victim, 1, CENTER);
      killAndRun(ctx, victim);
    }
    const [base] = hitsOn(plain.ctx, plain.inside) as [HitEvent];
    const [hit] = hitsOn(scaled.ctx, scaled.inside) as [HitEvent];
    const [iceHit] = hitsOn(outer.ctx, outer.inside) as [HitEvent];
    expect(hit.amount).toEqual(mul(base.amount, 2 * 1.5));
    expect(hit.crit).toBe(false);
    expect(iceHit.source).toBe(outer.ctx.sources.names.indexOf('outer.ice'));
    expect(iceHit.amount).toEqual(mul(base.amount, 2));
  });

  it('fires shatter triggers on a shatter only; a shatter kill shatters nothing', () => {
    const { ctx, victim, inside } = arena(
      frostStats([], {}, sourced('center', { on: 'shatter', do: [heal] })),
    );
    const [onShatter] = ctx.build.triggersOn[EVENT.shatter] as Int32Array;
    // A frozen neighbour that the shatter kills.
    ctx.now = 5;
    addFrost(ctx, victim, 1, CENTER);
    addFrost(ctx, inside, 1, CENTER);
    inside.hp = num(1);
    expect(killAndRun(ctx, victim)).toEqual([SHATTER_TRIGGER, onShatter]);
    expect(inside.alive).toBe(false);
    expect(ctx.pendingCount).toBe(0);
    // The heal ran with the shatter; nothing else was queued.
    expect(ctx.counters.effectsRun).toBe(2);
    expect(drain(ctx)).toEqual([]);
  });

  it('is listed on kill only when the build can freeze, a module’s addFrost included', () => {
    const killers = (stats: StatBlock, modules: readonly TestModule[] = []) => [
      ...(compileBuild(stats, [], undefined, modules).triggersOn[EVENT.kill] as Int32Array),
    ];
    const explodeOnKill = sourced('center', {
      on: 'kill',
      do: [{ kind: 'explode', radius: 50, damagePct: 1 }],
    });
    const [explode, ...rest] = killers(makeStats({}, [], explodeOnKill));
    expect([explode === SHATTER_TRIGGER, rest]).toEqual([false, []]);
    expect(killers(makeStats({ frostOnHit: 0.1 }))).toEqual([SHATTER_TRIGGER]);
    expect(
      killers(makeStats({}, [{ stat: 'frostOnHit', kind: 'flat', value: 0.1, tags: ['hit'] }])),
    ).toEqual([SHATTER_TRIGGER]);
    const blizzard: TestModule = (b) => {
      b.addEffect('center', { kind: 'addFrost', amount: 0.1, radius: 200 });
    };
    const build = compileBuild(makeStats(), [], undefined, [blizzard]);
    expect([...(build.triggersOn[EVENT.kill] as Int32Array)]).toEqual([SHATTER_TRIGGER]);
    // The shatter's effect comes after every other.
    expect(build.effects.map((fx) => fx.kind)).toEqual(['addFrost', 'shatter']);
    const shatter = build.triggers[SHATTER_TRIGGER];
    expect([shatter?.effectStart, shatter?.effectEnd]).toEqual([1, 2]);
  });
});

describe('frost effects', () => {
  it('chills the event’s enemy or those around it, and freezes as hits do', () => {
    const chill = (radius?: number): TriggerSpec => ({
      on: 'hit',
      do: [{ kind: 'addFrost', amount: 0.6, ...(radius === undefined ? {} : { radius }) }],
    });
    const ctx = spawned(
      makeStats(NO_ROLLS, [], sourced('center', chill(), { on: 'freeze', do: [heal] })),
      field(2),
    );
    const [a, b] = normals(ctx) as [Enemy, Enemy];
    ctx.now = 3;
    emitterHit(ctx, a);
    runEffectQueue(ctx);
    expect([a.frost, b.frost]).toEqual([0.6, 0]);
    emitterHit(ctx, a);
    runEffectQueue(ctx);
    expect(holdsFrozen(a, 3)).toBe(true);
    expect(ctx.events.filter((e) => e.type === 'freeze')).toEqual([
      { type: 'freeze', targetId: a.id, boss: false },
    ]);
    // The freeze trigger's heal ran too.
    expect(ctx.counters.effectsRun).toBe(3);
  });
});

describe('determinism with frost', () => {
  const config = (seed: number): RunConfig =>
    makeConfig({
      seed,
      stats: makeStats(
        { damage: 6, attackSpeed: 4, critChance: 0.2, frostOnHit: 0.5, maxLife: 1e6 },
        [],
        sourced(
          'center',
          {
            on: 'freeze',
            when: [{ chance: 0.5 }],
            do: [{ kind: 'nova', radius: 120, damagePct: 0.2, at: 'event' }],
          },
          { on: 'shatter', do: [{ kind: 'addFrost', amount: 0.3, radius: 100 }] },
        ),
      ),
      startWave: 6,
      maxTicks: 1500,
    });

  const run = (seed: number) => {
    const sim = createSimulation(config(seed), makeTestData());
    const ticks: SimEvent[][] = [];
    while (!sim.state.finished) ticks.push(sim.step(NO_INPUT).slice());
    return { ticks, result: sim.result() };
  };

  it('gives the same events for the same seed and other ones for another seed', () => {
    const a = run(1);
    const b = run(1);
    const c = run(2);
    const count = (type: SimEvent['type']) => a.ticks.flat().filter((e) => e.type === type).length;
    expect(count('freeze')).toBeGreaterThan(20);
    expect(count('shatter')).toBeGreaterThan(20);
    expect(b.ticks).toEqual(a.ticks);
    expect(b.result).toEqual(a.result);
    expect(c.ticks).not.toEqual(a.ticks);
  });
});
