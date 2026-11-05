/**
 * 霜晶's engine (E6; docs/v3/game-design-v3.md gd:105, gd:106, gd:526 and gd:527): ◆連鎖碎裂's
 * chained shatter (BuildFlags.shatterChain, lead ruling F1), ◆粉碎's frozen no-split
 * (frozenNoSplit, F2), 熱震's thaw effect (F3) and the frost gain of 超導 and 霜蝕
 * (frostGainShocked and frostGainBoss, F4). Test modules set the flags, as B3's rule modules
 * will. A test that kills one of the brief's planted bugs names it in a comment.
 *
 * The enemies stand on the line to the player's right (placedEnemies), immortal unless a test
 * drops their hp: one at 1e-9 dies to any damage and keeps its max life, so its shatter deals
 * its full share.
 */

import { describe, expect, it } from 'vitest';
import { mul, num, toNumber } from '../../core/num';
import { AFFIX_MULTIPLY, AFFIX_WARD } from '../../data/affixes';
import type { GroundZoneSpec, TriggerSpec } from '../../data/triggers';
import type { EnemyId, GameData } from '../../data/types';
import { compileBuild } from '../build/compile';
import { CENTER } from '../build/sources';
import { hitWithPayload } from '../combat/hit';
import { raiseFreeze } from '../effects/centerEvents';
import { dispatchPendingKills } from '../effects/dispatch';
import { runEffect, runEffectQueue } from '../effects/execute';
import { createEffectEntry } from '../effects/queue';
import { MAX_DEPTH } from '../effects/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { MULTIPLY_COUNT } from '../systems/affixes';
import { updateAilments } from '../systems/ailments';
import type { Enemy, RunContext, WaveRecord } from '../systems/context';
import { killEnemy } from '../systems/death';
import { WARD_AILMENT_MULT, WARDED } from '../systems/enemyRecord';
import { addEnemy } from '../systems/spawn';
import { stepZones } from '../systems/zones';
import {
  centerTriggers,
  makeStats,
  placedEnemies,
  rngPositions,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { applyPoison } from './apply';
import { addFrost, frostMeter, holdsFrozen, thawEnemy } from './frost';
import { remainingOf } from './remaining';
import { addShock } from './shock';

/** The player, at the arena's centre (placedEnemies). */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** No crit, ignite or shock rolls unless a test says so, one projectile. */
const NO_ROLLS = { critChance: 0, igniteChance: 0, shockChance: 0, projectileCount: 1 } as const;
const heal = { kind: 'heal', lifePct: 0.01 } as const;
const thaw = { kind: 'thaw' } as const;

/** Frost on hit, so the build can freeze and its kills list SHATTER_TRIGGER, and `triggers`. */
const frostStats = (triggers: readonly TriggerSpec[] = [], values = {}) =>
  makeStats({ ...NO_ROLLS, frostOnHit: 0.1, ...values }, [], centerTriggers(triggers));

/** The test modules standing in for B3's: ◆連鎖碎裂, ◆粉碎, and 超導's and 霜蝕's gains. */
const chain: TestModule = (b) => void (b.flags.shatterChain = true);
const noSplit: TestModule = (b) => void (b.flags.frozenNoSplit = true);
const gain =
  (shocked: number, boss: number): TestModule =>
  (b) => {
    b.flags.frostGainShocked = shocked;
    b.flags.frostGainBoss = boss;
  };

/** Enemies of `type` `dxs` right of the player, in order (ids 1, 2, …). */
const row = (dxs: readonly number[], type: EnemyId = 'square'): PlacedEnemy[] =>
  dxs.map((dx) => ({ x: P.x + dx, y: P.y, type }));

const signature = (ctx: RunContext): Payload => (ctx.emitters[0] as EmitterRuntime).payload;

/** An emitter hit (depth 0, no origin) of the signature attack on `enemy`. */
const emitterHit = (ctx: RunContext, enemy: Enemy): boolean =>
  hitWithPayload(ctx, enemy, signature(ctx), 0, 1, null, null, false, 0, -1);

type HitEvent = Extract<SimEvent, { type: 'hit' }>;
const hitsOn = (ctx: RunContext, enemy: Enemy): HitEvent[] =>
  ctx.events.filter((e): e is HitEvent => e.type === 'hit' && e.targetId === enemy.id);
const shattersOf = (ctx: RunContext): SimEvent[] => ctx.events.filter((e) => e.type === 'shatter');

/**
 * The kills' pending triggers dispatched at the death step and their effects run in the next
 * tick's effect phase, tick after tick, until nothing is pending or queued.
 */
function settle(ctx: RunContext): void {
  for (let n = 0; n < 8 && (ctx.pendingCount > 0 || ctx.effectQueue.size > 0); n++) {
    dispatchPendingKills(ctx);
    ctx.now++;
    runEffectQueue(ctx);
  }
  expect([ctx.pendingCount, ctx.effectQueue.size]).toEqual([0, 0]);
}

describe('◆連鎖碎裂: an enemy a shatter kills shatters (BuildFlags.shatterChain, F1)', () => {
  /**
   * Five squares 60 apart from 200 right of the player, each within a shatter (radius 90) of its
   * neighbours only, all dying to any damage; the first frozen at tick 1.
   */
  function line(modules: readonly TestModule[]): { ctx: RunContext; enemies: Enemy[] } {
    const ctx = placedEnemies(row([200, 260, 320, 380, 440]), { stats: frostStats(), modules });
    const enemies = ctx.enemies.slice();
    for (const e of enemies) e.hp = num(1e-9);
    addFrost(ctx, enemies[0] as Enemy, 1, CENTER);
    return { ctx, enemies };
  }

  it('shatters each enemy a shatter kills under the flag, frozen or not, and none without it', () => {
    // Plants the chain without the flag: the run without it would shatter on down the line.
    const off = line([]);
    emitterHit(off.ctx, off.enemies[0] as Enemy);
    settle(off.ctx);
    expect(shattersOf(off.ctx)).toHaveLength(1);
    expect(off.enemies.map((e) => e.alive)).toEqual([false, false, true, true, true]);

    const on = line([chain]);
    emitterHit(on.ctx, on.enemies[0] as Enemy);
    settle(on.ctx);
    expect(shattersOf(on.ctx)).toEqual(
      [200, 260, 320].map((dx) => ({ type: 'shatter', x: P.x + dx, y: P.y, radius: 90 })),
    );
    expect(on.enemies.map((e) => e.alive)).toEqual([false, false, false, false, true]);
  });

  it('ends the cascade at MAX_DEPTH: a depth-0 kill’s shatter and two chained ones deal damage', () => {
    // Plants the chain ignoring MAX_DEPTH: the fourth square's shatter would kill the fifth.
    const { ctx, enemies } = line([chain]);
    emitterHit(ctx, enemies[0] as Enemy);
    settle(ctx);
    expect(MAX_DEPTH).toBe(3);
    // Each shatter's damage one deeper than the kill that shattered.
    expect(enemies.map((e) => [e.alive, e.killDepth])).toEqual([
      [false, 0],
      [false, 1],
      [false, 2],
      [false, 3],
      [true, 0],
    ]);
    // The fourth's shatter, recorded at its kill's depth 3, is capped at dispatch.
    expect(shattersOf(ctx)).toHaveLength(3);
    expect(ctx.counters.triggerDepthCapped).toBe(1);
    expect(hitsOn(ctx, enemies[4] as Enemy)).toEqual([]);
  });

  it('credits a chained shatter to the shatter that killed its victim, at the victim’s max life, its triggers firing', () => {
    // Plants the chain credited from the victim's frostApplier, which its old freeze left.
    const ctx = placedEnemies(row([200, 260, 320]), {
      stats: frostStats([{ on: 'shatter', do: [heal] }]),
      modules: [chain],
    });
    const [first, second, third] = ctx.enemies as [Enemy, Enemy, Enemy];
    first.hp = second.hp = num(1e-9);
    // A max life of its own (read-only on Enemy; placedEnemies writes it the same way).
    Object.assign(second, { maxHp: num(4e11) });
    const fire = ctx.sources.index('fusion.ice.fire');
    const lightning = ctx.sources.index('fusion.ice.lightning');
    // The second froze to 冰雷 at tick 1 and thawed at 73; the first freezes to 冰火 at 100.
    addFrost(ctx, second, 1, lightning);
    ctx.now = 100;
    addFrost(ctx, first, 1, fire);
    expect([holdsFrozen(second, 100), second.frostApplier]).toEqual([false, lightning]);
    emitterHit(ctx, first);
    settle(ctx);
    expect(shattersOf(ctx)).toEqual([
      { type: 'shatter', x: first.x, y: first.y, radius: 90 },
      { type: 'shatter', x: second.x, y: second.y, radius: 90 },
    ]);
    // The third, 120 from the first, takes the second's shatter alone.
    expect(hitsOn(ctx, third)).toHaveLength(1);
    expect(hitsOn(ctx, third)[0]).toMatchObject({
      source: fire,
      crit: false,
      amount: mul(num(4e11), 0.15),
    });
    // Two shatters and their shatter trigger's heals.
    expect(ctx.counters.effectsRun).toBe(4);
  });

  it('never shatters an unfrozen enemy that a hit or another trigger’s damage killed', () => {
    // Plants the chain on any kill (or any trigger's kill): the hit's or the nova's victim would
    // shatter.
    const nova: TriggerSpec = {
      on: 'hit',
      do: [{ kind: 'nova', radius: 100, damagePct: 1, at: 'event' }],
    };
    const ctx = placedEnemies(row([200, 260, 600]), {
      stats: frostStats([nova]),
      modules: [chain],
    });
    const [target, beside, alone] = ctx.enemies as [Enemy, Enemy, Enemy];
    beside.hp = alone.hp = num(1e-9);
    emitterHit(ctx, alone);
    expect([alone.alive, ctx.pendingCount]).toEqual([false, 0]);
    // The target's nova kills the square beside it, by a trigger's damage.
    emitterHit(ctx, target);
    settle(ctx);
    expect([beside.alive, beside.killDepth]).toEqual([false, 1]);
    expect(shattersOf(ctx)).toEqual([]);
    // The two hits' novas, and no shatter.
    expect(ctx.counters.effectsRun).toBe(2);
  });

  it('shatters a frozen victim of a hit as before, and chains a frozen victim of a shatter from the shatter (D5)', () => {
    // A frozen victim's kill by a hit: the same events with the flag as without.
    const plain = (modules: readonly TestModule[]): SimEvent[] => {
      const ctx = placedEnemies(row([200, 260]), { stats: frostStats(), modules });
      const [victim] = ctx.enemies as [Enemy];
      victim.hp = num(1e-9);
      addFrost(ctx, victim, 1, CENTER);
      emitterHit(ctx, victim);
      settle(ctx);
      return ctx.events.slice();
    };
    expect(plain([chain])).toEqual(plain([]));
    expect(plain([chain]).filter((e) => e.type === 'shatter')).toHaveLength(1);
    // The second, frozen to 冰雷 and killed by the first's shatter, chains under the flag only,
    // credited to the first's 冰火 shatter.
    const frozen = (modules: readonly TestModule[]) => {
      const ctx = placedEnemies(row([200, 260, 320]), { stats: frostStats(), modules });
      const [first, second, third] = ctx.enemies as [Enemy, Enemy, Enemy];
      first.hp = second.hp = num(1e-9);
      const fire = ctx.sources.index('fusion.ice.fire');
      addFrost(ctx, second, 1, ctx.sources.index('fusion.ice.lightning'));
      addFrost(ctx, first, 1, fire);
      emitterHit(ctx, first);
      settle(ctx);
      return { shatters: shattersOf(ctx).length, onThird: hitsOn(ctx, third), fire };
    };
    expect(frozen([])).toMatchObject({ shatters: 1, onThird: [] });
    const chained = frozen([chain]);
    expect(chained.shatters).toBe(2);
    expect(chained.onThird.map((hit) => hit.source)).toEqual([chained.fire]);
  });
});

describe('◆粉碎: a pentagon frozen at its death does not split (BuildFlags.frozenNoSplit, F2)', () => {
  /** Two pentagons, right and left of the player, the first frozen at tick 1 (until 73). */
  function pair(modules: readonly TestModule[]): { ctx: RunContext; frozen: Enemy; other: Enemy } {
    const ctx = placedEnemies(
      [
        { x: P.x + 200, y: P.y, type: 'pentagon' },
        { x: P.x - 200, y: P.y + 50, type: 'pentagon' },
      ],
      { modules },
    );
    const [frozen, other] = ctx.enemies as [Enemy, Enemy];
    addFrost(ctx, frozen, 1, CENTER);
    return { ctx, frozen, other };
  }
  /** The type and position of each enemy from index `from` on. */
  const childrenOf = (ctx: RunContext, from: number): [string, number, number][] =>
    ctx.enemies.slice(from).map((e) => [e.type, e.x, e.y]);

  it('leaves no children of a frozen pentagon and draws nothing: the next split is as if it never died', () => {
    // Plants no-split still drawing the split stream: the other pentagon's children would move.
    const { ctx, frozen, other } = pair([noSplit]);
    const before = rngPositions(ctx);
    killEnemy(ctx, frozen, -1, 0);
    expect(ctx.events.map((e) => e.type)).toEqual(['enemyKilled']);
    expect(ctx.enemies).toHaveLength(2);
    expect(rngPositions(ctx)).toEqual(before);
    killEnemy(ctx, other, -1, 0);
    const after = childrenOf(ctx, 2);
    expect(after.map(([type]) => type)).toEqual(['shard', 'shard', 'shard']);
    const alone = pair([noSplit]);
    killEnemy(alone.ctx, alone.other, -1, 0);
    expect(childrenOf(alone.ctx, 2)).toEqual(after);
    // Without the flag the frozen one's split draws first, and the other's children move.
    const off = pair([]);
    killEnemy(off.ctx, off.frozen, -1, 0);
    killEnemy(off.ctx, off.other, -1, 0);
    expect(childrenOf(off.ctx, 5)).not.toEqual(after);
  });

  it('splits an unfrozen pentagon under the flag, one whose freeze ends at its death, and a frozen one without it', () => {
    // Plants no-split on unfrozen enemies (or through the freeze's end tick): these would leave
    // none.
    const children = (modules: readonly TestModule[], frost: boolean, now: number): string[] => {
      const ctx = placedEnemies(row([200], 'pentagon'), { modules });
      const [pentagon] = ctx.enemies as [Enemy];
      if (frost) addFrost(ctx, pentagon, 1, CENTER);
      ctx.now = now;
      killEnemy(ctx, pentagon, -1, 0);
      return ctx.enemies.slice(1).map((e) => e.type);
    };
    const three = ['shard', 'shard', 'shard'];
    expect(children([noSplit], false, 1)).toEqual(three);
    expect(children([noSplit], true, 72)).toEqual([]);
    expect(children([noSplit], true, 73)).toEqual(three);
    expect(children([], true, 1)).toEqual(three);
  });

  it('still leaves a frozen 增殖 elite’s children, which its toSplitChildren poison reaches', () => {
    // Plants no-split dropping 增殖's children: the frozen elite would leave none.
    // No wave enemy, elite, affix or treasure; the two types too hardy for the poison to kill.
    const quiet: GameData = v3TestData({
      enemies: { hexagon: { hpMult: 1e9 }, pentagon: { hpMult: 1e9 } },
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
    const spread: TriggerSpec = {
      on: 'kill',
      do: [
        {
          kind: 'spreadAilment',
          ailment: 'poison',
          radius: 100,
          effect: 0.4,
          toSplitChildren: 0.5,
        },
      ],
    };
    /** A frozen `type` with 增殖, poisoned, killed at tick 15: its children and their shares. */
    const elite = (type: EnemyId, modules: readonly TestModule[]) => {
      const ctx = placedEnemies([], {
        data: quiet,
        stats: makeStats(NO_ROLLS, [], centerTriggers([spread])),
        modules,
      });
      const origin = { hpScale: 1, radiusScale: 1, dropScale: 1, extra: false };
      const def = ctx.data.enemies[type];
      addEnemy(ctx, def, ctx.current as WaveRecord, 1, 0, 400, {
        ...origin,
        affixes: AFFIX_MULTIPLY,
      });
      const parent = ctx.enemies.at(-1) as Enemy;
      applyPoison(ctx, parent, num(100), ctx.now + 600, 0, CENTER, 4);
      ctx.now = 15;
      updateAilments(ctx);
      const poison = toNumber(remainingOf(ctx, parent, 'poison'));
      expect(poison).toBeGreaterThan(0);
      addFrost(ctx, parent, 1, CENTER);
      const start = ctx.enemies.length;
      killEnemy(ctx, parent, -1, 0);
      const children = ctx.enemies.slice(start);
      return {
        types: children.map((child) => child.type),
        shares: children.map((child) => toNumber(remainingOf(ctx, child, 'poison')) / poison),
      };
    };
    // The hexagon, the elite of every wave: its two elites, poisoned, with the flag as without.
    const hexagon = elite('hexagon', [noSplit]);
    expect(hexagon).toEqual(elite('hexagon', []));
    expect(hexagon.types).toEqual(Array(MULTIPLY_COUNT).fill('hexagon'));
    for (const share of hexagon.shares) expect(share).toBeCloseTo(0.5, 9);
    // A pentagon given 增殖: no shards under the flag, and 增殖's two all the same, poisoned.
    expect(elite('pentagon', []).types).toEqual([
      'shard',
      'shard',
      'shard',
      'pentagon',
      'pentagon',
    ]);
    const pentagon = elite('pentagon', [noSplit]);
    expect(pentagon.types).toEqual(['pentagon', 'pentagon']);
    for (const share of pentagon.shares) expect(share).toBeCloseTo(0.5, 9);
  });
});

describe('the thaw effect (熱震’s 解凍, F3)', () => {
  it('thaws a frozen enemy now and starts its frost immunity there (A10)', () => {
    // Plants the thaw leaving the immunity at frozenUntil + frostImmuneTicks: frost would still
    // fail at 210.
    const ctx = placedEnemies(row([200]));
    const [enemy] = ctx.enemies as [Enemy];
    ctx.now = 10;
    expect(addFrost(ctx, enemy, 1, CENTER)).toBe(true);
    expect([enemy.frozenUntil, enemy.frostLockUntil]).toEqual([82, 262]);
    ctx.now = 30;
    expect(thawEnemy(ctx, enemy)).toBe(true);
    // The meter the freeze emptied stays empty, and locked for 180 ticks from the thaw.
    expect([enemy.frozenUntil, enemy.frostLockUntil, enemy.frost]).toEqual([30, 210, 0]);
    expect([holdsFrozen(enemy, 30), frostMeter(enemy, 30)]).toEqual([false, 0]);
    for (const now of [30, 120, 209]) {
      ctx.now = now;
      expect(addFrost(ctx, enemy, 0.9, CENTER), `${now}`).toBe(false);
      expect(enemy.frost).toBe(0);
    }
    ctx.now = 210;
    expect(addFrost(ctx, enemy, 0.3, CENTER)).toBe(false);
    expect(enemy.frost).toBe(0.3);
    // With Absolute Zero's frostImmuneTicks 0, the meter takes frost again at the thaw's tick.
    const zero = placedEnemies(row([200]), {
      modules: [(b) => void (b.flags.frostImmuneTicks = 0)],
    });
    const [other] = zero.enemies as [Enemy];
    addFrost(zero, other, 1, CENTER);
    zero.now = 20;
    expect(thawEnemy(zero, other)).toBe(true);
    expect([other.frozenUntil, other.frostLockUntil]).toEqual([20, 20]);
    expect([addFrost(zero, other, 0.5, CENTER), other.frost]).toEqual([false, 0.5]);
  });

  it('thaws through its effect, as 熱震 does on igniting a frozen enemy, raising no event; it then dies unshattered', () => {
    const heatShock: TriggerSpec = {
      on: 'ailmentApplied',
      when: [{ ailment: 'burn' }, { targetHas: 'frozen' }],
      do: [thaw],
    };
    const ctx = placedEnemies(row([200]), { stats: frostStats([heatShock], { igniteChance: 1 }) });
    const [enemy] = ctx.enemies as [Enemy];
    addFrost(ctx, enemy, 1, CENTER);
    ctx.now = 20;
    // The hit ignites the frozen enemy: the trigger queues the thaw.
    emitterHit(ctx, enemy);
    expect([enemy.frozenUntil, ctx.effectQueue.size]).toEqual([73, 1]);
    ctx.events.length = 0;
    runEffectQueue(ctx);
    expect([enemy.frozenUntil, enemy.frostLockUntil]).toEqual([20, 200]);
    expect(ctx.events).toEqual([]);
    // Its next ignite finds it thawed and queues nothing.
    emitterHit(ctx, enemy);
    expect(ctx.effectQueue.size).toBe(0);
    // Killed before it freezes again, it records no shatter.
    enemy.hp = num(1e-9);
    emitterHit(ctx, enemy);
    expect([enemy.alive, ctx.pendingCount]).toEqual([false, 0]);
  });

  it('does nothing to an enemy that is not frozen, a dead one or a boss', () => {
    // Plants the thaw acting on a boss: the boss's 252-tick lock would end 180 after the thaw.
    const ctx = placedEnemies(
      [...row([200, 260, 320, 380]), { x: P.x - 200, y: P.y, type: 'boss' }],
      {
        stats: makeStats(NO_ROLLS, [], centerTriggers([{ on: 'hit', do: [thaw] }])),
      },
    );
    const [thawed, chilled, dead, frozen, boss] = ctx.enemies as [
      Enemy,
      Enemy,
      Enemy,
      Enemy,
      Enemy,
    ];
    /** The thaw effect run on `target`, as its trigger's entry would. */
    const runOn = (target: Enemy): void => {
      const entry = createEffectEntry();
      entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === 'thaw');
      entry.target = target;
      entry.x = target.x;
      entry.y = target.y;
      runEffect(ctx, entry);
    };
    const state = (e: Enemy): number[] => [e.frozenUntil, e.frostLockUntil, e.frost];
    ctx.now = 10;
    addFrost(ctx, thawed, 1, CENTER);
    addFrost(ctx, chilled, 0.5, CENTER);
    // The boss's meter empties and locks for 252 ticks; it never freezes.
    expect(addFrost(ctx, boss, 1, CENTER)).toBe(true);
    expect(state(boss)).toEqual([0, 262, 0]);
    // Plants the effect thawing its target dead or alive: the one that died frozen would thaw.
    ctx.now = 100;
    addFrost(ctx, frozen, 1, CENTER);
    addFrost(ctx, dead, 1, CENTER);
    killEnemy(ctx, dead, -1, 0);
    const before = ctx.enemies.map(state);
    expect(before.slice(0, 3)).toEqual([
      [82, 262, 0],
      [0, 0, 0.5],
      [172, 352, 0],
    ]);
    // Thawed at 82, chilled, dead frozen, a boss: nothing, by the effect or by thawEnemy.
    for (const e of [thawed, chilled, dead, boss]) runOn(e);
    for (const e of [thawed, chilled, boss]) expect(thawEnemy(ctx, e)).toBe(false);
    expect(ctx.enemies.map(state)).toEqual(before);
    // The live frozen one thaws.
    runOn(frozen);
    expect(state(frozen)).toEqual([100, 280, 0]);
    expect(ctx.events.filter((e) => e.type === 'freeze' || e.type === 'shatter')).toEqual([]);
  });

  it('thaws each frozen enemy of a freeze’s list, as an addFrost without a radius reaches each (D2)', () => {
    const ctx = placedEnemies(row([200, 260, 400]), {
      stats: makeStats(NO_ROLLS, [], centerTriggers([{ on: 'freeze', do: [thaw] }])),
    });
    const [near, frozen, far] = ctx.enemies as [Enemy, Enemy, Enemy];
    expect(ctx.build.effects.filter((fx) => fx.kind === 'thaw').map((fx) => fx.fanout)).toEqual([
      true,
    ]);
    addFrost(ctx, near, 1, CENTER);
    addFrost(ctx, far, 1, CENTER);
    ctx.now = 5;
    // The freeze's list: the frozen enemy, then the one 60 from it; the far one is 140 away.
    expect(addFrost(ctx, frozen, 1, CENTER)).toBe(true);
    raiseFreeze(ctx, frozen, 0, -1, 0);
    runEffectQueue(ctx);
    expect([near, frozen, far].map((e) => e.frozenUntil)).toEqual([5, 5, 73]);
    expect(ctx.counters.effectsRun).toBe(2);
  });
});

describe('the frost gain (超導 and 霜蝕, F4)', () => {
  /**
   * The chill of a square, a shocked square, a boss and a shocked boss after an addFrost of 0.25
   * each, under `modules`.
   */
  const chillOf = (modules: readonly TestModule[]): number[] => {
    const ctx = placedEnemies(
      [
        ...row([200, 260]),
        { x: P.x - 200, y: P.y, type: 'boss' },
        { x: P.x - 300, y: P.y, type: 'boss' },
      ],
      { stats: makeStats({ ...NO_ROLLS, shockMaxStacks: 3 }), modules },
    );
    const [, shockedSquare, , shockedBoss] = ctx.enemies as [Enemy, Enemy, Enemy, Enemy];
    addShock(ctx, shockedSquare, 1, 0);
    addShock(ctx, shockedBoss, 1, 0);
    for (const e of ctx.enemies) addFrost(ctx, e, 0.25, CENTER);
    return ctx.enemies.map((e) => e.frost);
  };

  it('multiplies frost by 1 + frostGainShocked on a shocked enemy, + frostGainBoss on a boss, and nothing else', () => {
    // Plants the boss factor applied to everyone: the squares would take × 1.25 more.
    expect(chillOf([])).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(chillOf([gain(0, 0)])).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(chillOf([gain(0.5, 0)])).toEqual([0.25, 0.375, 0.25, 0.375]);
    expect(chillOf([gain(0, 0.25)])).toEqual([0.25, 0.25, 0.3125, 0.3125]);
    expect(chillOf([gain(0.5, 0.25)])).toEqual([0.25, 0.375, 0.3125, 0.4375]);
  });

  it('gives the boss gain to a boss alone: an elite, tough but no boss, takes none', () => {
    // Plants the boss factor read for every tough enemy: the elite would take × 1.5.
    const ctx = placedEnemies([...row([200], 'hexagon'), { x: P.x - 200, y: P.y, type: 'boss' }], {
      modules: [gain(0, 0.5)],
    });
    const [elite, boss] = ctx.enemies as [Enemy, Enemy];
    expect([elite.tough, elite.boss, boss.boss]).toEqual([true, false, true]);
    for (const e of ctx.enemies) addFrost(ctx, e, 0.25, CENTER);
    expect([elite.frost, boss.frost]).toEqual([0.25, 0.375]);
  });

  it('applies the gain before 元素護盾’s ward, which still shrinks the gained frost', () => {
    // Plants the ward skipped once a gain is set: the warded elite would take 0.2 × 1.5 whole.
    // 0.2 × 1.5 × the ward is also what a ward of 0.3 would give in this order only, not after.
    const ctx = placedEnemies([], {
      data: v3TestData(),
      stats: makeStats({ ...NO_ROLLS, shockMaxStacks: 3 }),
      modules: [gain(0.5, 0)],
    });
    const origin = { hpScale: 1, radiusScale: 1, dropScale: 1, extra: false };
    const def = ctx.data.enemies.hexagon;
    for (const affixes of [0, AFFIX_WARD]) {
      addEnemy(ctx, def, ctx.current as WaveRecord, 1, 0, 400, { ...origin, affixes });
    }
    const [plain, warded] = ctx.enemies.slice(-2) as [Enemy, Enemy];
    expect([plain.v3?.defence ?? -1, (warded.v3?.defence ?? 0) & WARDED]).toEqual([0, WARDED]);
    for (const e of [plain, warded]) {
      addShock(ctx, e, 1, 0);
      expect(addFrost(ctx, e, 0.2, CENTER)).toBe(false);
    }
    expect([plain.frost, warded.frost]).toEqual([0.2 * 1.5, 0.2 * 1.5 * WARD_AILMENT_MULT]);
  });

  it('reads the shock at the frost’s tick, and freezes on what the gain fills', () => {
    const ctx = placedEnemies(row([200, 260]), {
      stats: makeStats({ ...NO_ROLLS, shockMaxStacks: 3 }),
      modules: [gain(0.5, 0)],
    });
    const [worn, filled] = ctx.enemies as [Enemy, Enemy];
    addShock(ctx, worn, 1, 0);
    addShock(ctx, filled, 1, 0);
    // Shocked through tick 120 (2 s): at 121 the shock has worn off.
    expect(worn.shockUntil).toBe(121);
    ctx.now = 121;
    addFrost(ctx, worn, 0.25, CENTER);
    expect(worn.frost).toBe(0.25);
    ctx.now = 120;
    expect(addFrost(ctx, filled, 0.5, CENTER)).toBe(false);
    expect(filled.frost).toBe(0.75);
    // 0.75 + 0.25 × 1.5 fills the meter: it freezes.
    expect(addFrost(ctx, filled, 0.25, CENTER)).toBe(true);
    expect(filled.frozenUntil).toBe(192);
  });

  it('gives a hit’s frost, a zone’s and an addFrost effect’s the gain alike', () => {
    // Plants the gain on zone frost missing (applied by the hit's caller only): the zone's
    // shocked square would take × 1.
    /** A shocked square and a plain one at `dxs` under the gain of 超導, with these stats. */
    const pair = (dxs: readonly number[], values = {}, triggers: readonly TriggerSpec[] = []) => {
      const ctx = placedEnemies(row(dxs), {
        stats: makeStats(
          { ...NO_ROLLS, shockMaxStacks: 3, ...values },
          [],
          centerTriggers(triggers),
        ),
        modules: [gain(0.5, 0)],
      });
      const [shocked, plain] = ctx.enemies as [Enemy, Enemy];
      addShock(ctx, shocked, 1, 0);
      return { ctx, shocked, plain };
    };
    const chill = (...enemies: Enemy[]): number[] => enemies.map((e) => e.frost);
    // A zone at 310, over both; addFrostPerSec 1 is 0.25 a pulse.
    const zone: GroundZoneSpec = {
      kind: 'groundZone',
      radius: 50,
      durationSec: 1,
      damagePctPerSec: 0,
      addFrostPerSec: 1,
    };
    const zoned = pair([300, 320], {}, [{ on: 'periodic', every: 1000, do: [zone] }]);
    const entry = createEffectEntry();
    entry.effect = zoned.ctx.build.effects.findIndex((fx) => fx.kind === 'groundZone');
    entry.x = P.x + 310;
    entry.y = P.y;
    runEffect(zoned.ctx, entry);
    for (let n = 0; n < 30 && zoned.plain.frost === 0; n++) {
      zoned.ctx.now = ++zoned.ctx.state.tick;
      stepZones(zoned.ctx);
    }
    expect(chill(zoned.shocked, zoned.plain)).toEqual([0.375, 0.25]);
    // A zone's pulse that hits, its frostOnHit 0.25 without a frost term.
    const pulsed = pair([300, 320], { frostOnHit: 0.25 }, [
      { on: 'periodic', every: 1000, do: [{ ...zone, damagePctPerSec: 1, addFrostPerSec: 0 }] },
    ]);
    entry.effect = pulsed.ctx.build.effects.findIndex((fx) => fx.kind === 'groundZone');
    runEffect(pulsed.ctx, entry);
    for (let n = 0; n < 30 && pulsed.plain.frost === 0; n++) {
      pulsed.ctx.now = ++pulsed.ctx.state.tick;
      stepZones(pulsed.ctx);
    }
    expect(chill(pulsed.shocked, pulsed.plain)).toEqual([0.375, 0.25]);
    // A hit of frostOnHit 0.25.
    const hit = pair([200, 260], { frostOnHit: 0.25 });
    emitterHit(hit.ctx, hit.shocked);
    emitterHit(hit.ctx, hit.plain);
    expect(chill(hit.shocked, hit.plain)).toEqual([0.375, 0.25]);
    // A hit trigger's addFrost of 0.25.
    const effect = pair([200, 260], {}, [{ on: 'hit', do: [{ kind: 'addFrost', amount: 0.25 }] }]);
    emitterHit(effect.ctx, effect.shocked);
    emitterHit(effect.ctx, effect.plain);
    expect(chill(effect.shocked, effect.plain)).toEqual([0, 0]);
    runEffectQueue(effect.ctx);
    expect(chill(effect.shocked, effect.plain)).toEqual([0.375, 0.25]);
  });

  it('refuses a frost gain that is not finite and ≥ 0, naming the field and its value', () => {
    const compileWith = (shocked: number, boss: number) => () =>
      compileBuild(makeStats(), [], undefined, [gain(shocked, boss)]);
    for (const bad of [-0.5, -Infinity, Infinity, Number.NaN]) {
      expect(compileWith(bad, 0), `${bad}`).toThrow(
        `frostGainShocked: ${bad} must be finite and >= 0`,
      );
      expect(compileWith(0, bad), `${bad}`).toThrow(
        `frostGainBoss: ${bad} must be finite and >= 0`,
      );
    }
    for (const ok of [0, 0.5, 3]) {
      expect(compileWith(ok, ok)().flags).toMatchObject({
        frostGainShocked: ok,
        frostGainBoss: ok,
      });
    }
    // E6's flags at their defaults: nothing changes without them.
    expect(compileBuild(makeStats(), []).flags).toMatchObject({
      shatterChain: false,
      frozenNoSplit: false,
      frostGainShocked: 0,
      frostGainBoss: 0,
    });
  });
});
