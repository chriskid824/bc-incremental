/**
 * poisonSlow (神經毒, docs/v3/game-design-v3.md:389; lead rulings H3, H4): its flags, the first
 * instance's; enemySlow's term min(max, slowPer × floor(live poison stacks / stacksPer)), the
 * largest of the sources, a boss's in full; movement's gates; and the term through enemySlow's
 * other callers (the lob's lead, bleedRemaining). Each test names in a comment the planted bug it
 * kills.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import type { RuleSpec } from '../../data/rules';
import { enemySlow, poisonSlowOf } from '../ailments/frost';
import { bleedRemaining } from '../ailments/remaining';
import { compileBuild } from '../build/compile';
import { aimDense, beginAim } from '../emitters/lob';
import type { EmitterRuntime } from '../emitters/types';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { moveEnemies } from '../systems/movement';
import { makeConfig, makeStats, makeTestData, placedEnemies } from '../testing';
import type { PlacedEnemy, PlacedOptions } from '../testing';
import { DT, NO_INPUT } from '../types';
import type { CharacterRun } from '../types';
import type { TestModule } from './index';

/** gd:389's numbers: 2 % every 5 stacks, at most 40 %. */
const NEURO: RuleSpec = { id: 'poisonSlow', stacksPer: 5, slowPer: 0.02, max: 0.4 };

/** Enemies at `placed` in a run with `rules` (神經毒 by default). */
const field = (
  placed: readonly PlacedEnemy[],
  rules: readonly RuleSpec[] = [NEURO],
  options: PlacedOptions = {},
): RunContext =>
  placedEnemies(placed, {
    stats: makeStats({ critChance: 0, igniteChance: 0 }),
    rules,
    ...options,
  });
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** Gives `e` `stacks` live poison stacks until `until` ticks after the context's tick. */
function poison(ctx: RunContext, e: Enemy, stacks: number, until = 60): void {
  e.poisonStacks = stacks;
  e.poisonRingEnd = ctx.now + until;
}

describe('poisonSlow’s flags (lead ruling H3)', () => {
  const flagsOf = (rules: readonly RuleSpec[]) => {
    const { flags } = compileBuild(makeStats(), rules);
    return [flags.poisonSlowStacks, flags.poisonSlowPer, flags.poisonSlowMax];
  };

  it('writes stacksPer, slowPer and max, and leaves all three 0 without the rule', () => {
    // Planted bug: a parameter written to the wrong flag.
    expect(flagsOf([NEURO])).toEqual([5, 0.02, 0.4]);
    expect(flagsOf([])).toEqual([0, 0, 0]);
    expect(flagsOf([{ id: 'glassCannon', damageMore: 1 }])).toEqual([0, 0, 0]);
  });

  it('takes the first instance’s of two, as the registry compiles every instance of an id once', () => {
    // Planted bug: the last instance's, or the two merged.
    const second: RuleSpec = { id: 'poisonSlow', stacksPer: 2, slowPer: 0.1, max: 0.9 };
    expect(flagsOf([NEURO, second])).toEqual([5, 0.02, 0.4]);
    expect(flagsOf([second, { id: 'glassCannon', damageMore: 1 }, NEURO])).toEqual([2, 0.1, 0.9]);
    // On a character run, both on one source and coef, as validateConfig requires.
    const character: CharacterRun = {
      id: 'fire',
      rules: [
        { source: 'outer.poison', spec: NEURO, coef: 1 },
        { source: 'outer.poison', spec: second, coef: 1 },
      ],
    };
    const { flags } = compileBuild(makeStats(), [], { id: 'magmaBomb' }, [], character);
    expect([flags.poisonSlowStacks, flags.poisonSlowPer, flags.poisonSlowMax]).toEqual([
      5, 0.02, 0.4,
    ]);
  });
});

describe('enemySlow’s poison term (lead ruling H4)', () => {
  it('caps after the floor, at numbers whose cap is not a whole number of steps', () => {
    // Planted bug: the cap applied before the floor, floor(min(stacks / stacksPer, max /
    // slowPer)) × slowPer, which gives 0.48 for 17 steps of 3 % under a cap of 50 %, and 0.2 for
    // 3 steps of 10 % under 30 % (0.3 / 0.1 is a hair below 3).
    const cases: readonly [RuleSpec, number, number][] = [
      [{ id: 'poisonSlow', stacksPer: 4, slowPer: 0.03, max: 0.5 }, 64, 0.48],
      [{ id: 'poisonSlow', stacksPer: 4, slowPer: 0.03, max: 0.5 }, 68, 0.5],
      [{ id: 'poisonSlow', stacksPer: 1, slowPer: 0.1, max: 0.3 }, 3, 0.3],
    ];
    for (const [rule, stacks, slow] of cases) {
      const ctx = field([{ x: 900, y: 300 }], [rule]);
      const e = enemy(ctx, 1);
      poison(ctx, e, stacks);
      expect(enemySlow(ctx, e, ctx.now), `${JSON.stringify(rule)} at ${stacks}`).toBeCloseTo(
        slow,
        12,
      );
    }
  });

  it('slows 2 % every 5 live stacks, at most 40 %: 4 → 0, 5 → 0.02, 99 → 0.38, 100 and 150 → 0.4', () => {
    // Planted bugs: floor replaced by round (4 → 0.02, 99 → 0.4) or ceil; the cap missing
    // (150 → 0.6).
    const ctx = field([{ x: 900, y: 300 }]);
    const e = enemy(ctx, 1);
    const slowAt = (stacks: number): number => {
      poison(ctx, e, stacks);
      return enemySlow(ctx, e, ctx.now);
    };
    expect(slowAt(0)).toBe(0);
    expect(slowAt(4)).toBe(0);
    expect(slowAt(5)).toBe(0.02);
    expect(slowAt(9)).toBe(0.02);
    expect(slowAt(10)).toBe(0.04);
    expect(slowAt(99)).toBeCloseTo(0.38, 12);
    expect(slowAt(100)).toBe(0.4);
    expect(slowAt(150)).toBe(0.4);
    expect(poisonSlowOf(ctx.build.flags, e, ctx.now)).toBe(0.4);
  });

  it('reads the live stacks: the slow stops on the tick the poison ends', () => {
    // Planted bug: livePoisonStacks replaced by the raw poisonStacks, which stay counted until
    // the next step.
    const ctx = field([{ x: 900, y: 300 }]);
    const e = enemy(ctx, 1);
    poison(ctx, e, 50, 3);
    expect(enemySlow(ctx, e, ctx.now + 2)).toBeCloseTo(0.2, 12);
    expect(e.poisonStacks).toBe(50);
    expect(enemySlow(ctx, e, ctx.now + 3)).toBe(0);
  });

  it('takes the largest of frost, a zone, globalSlow and the poison, never their sum', () => {
    // Planted bug: the term added to the other sources instead of maxed with them.
    const slows: TestModule = (b) => {
      b.flags.globalSlow = 0.1;
    };
    const ctx = field([{ x: 900, y: 300 }], [NEURO], { modules: [slows] });
    const e = enemy(ctx, 1);
    const now = ctx.now;
    expect(enemySlow(ctx, e, now)).toBe(0.1);
    poison(ctx, e, 25); // 0.1
    expect(enemySlow(ctx, e, now)).toBe(0.1);
    poison(ctx, e, 50); // 0.2
    expect(enemySlow(ctx, e, now)).toBeCloseTo(0.2, 12);
    // Frost at a full meter: frostSlowCap 0.3 beats the poison's 0.2.
    e.frost = 1;
    expect(enemySlow(ctx, e, now)).toBeCloseTo(0.3, 12);
    // The poison's 0.4 beats the frost's 0.3.
    poison(ctx, e, 100);
    expect(enemySlow(ctx, e, now)).toBe(0.4);
    // A zone's 0.5 beats them all; once it lapses the poison's 0.4 is back.
    Object.assign(e, { zoneSlow: 0.5, zoneSlowUntil: now + 5 });
    expect(enemySlow(ctx, e, now)).toBe(0.5);
    expect(enemySlow(ctx, e, now + 5)).toBe(0.4);
  });

  it('leaves a frozen enemy its whole slow of 1, and gives a boss the term in full', () => {
    // Planted bug: bosses capped as frost caps them (BOSS_SLOW_CAP_OFFSET, or the boss frost cap).
    const ctx = field([
      { x: 900, y: 300 },
      { x: 1000, y: 300, type: 'boss' },
    ]);
    const [e, boss] = [enemy(ctx, 1), enemy(ctx, 2)];
    expect(boss.boss).toBe(true);
    poison(ctx, e, 100);
    e.frozenUntil = ctx.now + 10;
    expect(enemySlow(ctx, e, ctx.now)).toBe(1);
    poison(ctx, boss, 150);
    expect(enemySlow(ctx, boss, ctx.now)).toBe(0.4);
    boss.frost = 1;
    expect(enemySlow(ctx, boss, ctx.now)).toBe(0.4);
    expect(ctx.bossFrostSlowCap).toBeCloseTo(0.15, 12);
  });

  it('adds nothing in a run without the rule', () => {
    const ctx = field([{ x: 900, y: 300 }], []);
    const e = enemy(ctx, 1);
    poison(ctx, e, 500);
    expect(enemySlow(ctx, e, ctx.now)).toBe(0);
  });
});

describe('movement under poisonSlow (lead ruling H4)', () => {
  /** How far each enemy walked in one movement step, in units of its step. */
  const walked = (ctx: RunContext): number[] => {
    const before = ctx.enemies.map((e) => e.dist);
    moveEnemies(ctx);
    return ctx.enemies.map((e, i) => ((before[i] as number) - e.dist) / e.stepDist);
  };
  const walkers: PlacedEnemy[] = [
    { x: 1200, y: 540, speed: 60 },
    { x: 1300, y: 540, speed: 60 },
    { x: 1400, y: 540, speed: 60 },
  ];

  it('takes the slow path in a run with the rule and the fast path without it', () => {
    // Planted bug: the fast path not routed. Enemy 1 carries a chill meter no frost applied
    // (ctx.frostApplied stays false), which only the slow path reads.
    for (const [rules, frosted] of [
      [[NEURO], 0.7],
      [[], 1],
    ] as const) {
      const ctx = field(walkers, rules);
      enemy(ctx, 1).frost = 1;
      expect(ctx.frostApplied).toBe(false);
      const [one, two] = walked(ctx);
      expect(one).toBeCloseTo(frosted, 12);
      expect(two).toBe(1);
    }
  });

  it('slows an enemy holding poison, and walks one without its whole step', () => {
    // Planted bug: the per-enemy test missing the poison case.
    const ctx = field(walkers);
    poison(ctx, enemy(ctx, 1), 100);
    poison(ctx, enemy(ctx, 2), 4);
    const steps = walked(ctx);
    expect(steps[0]).toBeCloseTo(0.6, 12);
    expect(steps[1]).toBe(1);
    expect(steps[2]).toBe(1);
    expect(enemy(ctx, 3).stepDist).toBeCloseTo(60 * DT, 12);
    // Without the rule a poisoned enemy walks its whole step.
    const plain = field(walkers, []);
    poison(plain, enemy(plain, 1), 100);
    expect(walked(plain)[0]).toBe(1);
  });

  it('slows the poisoned enemies of a run: under the rule they reach the player later', () => {
    // The rule end to end: hits too weak to kill that poison every enemy they reach.
    const stats = makeStats({
      damage: 1e-6,
      attackSpeed: 6,
      projectileCount: 4,
      poisonChance: 1,
      critChance: 0,
      igniteChance: 0,
      maxLife: 1e9,
    });
    const firstContact = (rules: readonly RuleSpec[]): number => {
      const sim = createSimulation(makeConfig({ stats, rules, maxTicks: 900 }), makeTestData());
      for (let t = 1; !sim.state.finished; t++) {
        if (sim.step(NO_INPUT).some((e) => e.type === 'playerHit')) return t;
      }
      return -1;
    };
    const plain = firstContact([]);
    const slowed = firstContact([NEURO]);
    expect(plain).toBeGreaterThan(0);
    expect(slowed).toBeGreaterThan(plain);
  });
});

describe('enemySlow’s other callers', () => {
  it('leads the lob by the poison slow', () => {
    // The lob's lead walks its target 24 flight ticks at its slow (src/sim/emitters/lob.ts).
    const leadOf = (stacks: number): number => {
      const ctx = field([{ x: 1300, y: 600, speed: 60 }], [NEURO], {
        signature: { id: 'magmaBomb' },
      });
      const target = enemy(ctx, 1);
      poison(ctx, target, stacks);
      const em = ctx.emitters[0] as EmitterRuntime;
      beginAim(ctx, em);
      expect(aimDense(ctx, em)).toBe(target);
      return target.dist - Math.hypot(ctx.sys.lob.x - ctx.player.x, ctx.sys.lob.y - ctx.player.y);
    };
    expect(leadOf(0)).toBeCloseTo(24, 9);
    expect(leadOf(100)).toBeCloseTo(24 * 0.6, 9);
  });

  it('values a bleed as standing still once the poison stops its walk (bleedRemaining)', () => {
    // A full slow (max 1) leaves the walker standing, so its bleed takes the stationary rate.
    const full: RuleSpec = { id: 'poisonSlow', stacksPer: 1, slowPer: 1, max: 1 };
    const remaining = (stacks: number): number => {
      const ctx = field([{ x: 1300, y: 600, speed: 60 }], [full]);
      const e = enemy(ctx, 1);
      Object.assign(e, { bleedDps: num(10), bleedStart: ctx.now, bleedUntil: ctx.now + 60 });
      poison(ctx, e, stacks);
      return toNumber(bleedRemaining(ctx, e));
    };
    expect(remaining(0)).toBeCloseTo(3 * remaining(1), 9);
  });
});
