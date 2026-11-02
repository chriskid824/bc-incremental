/**
 * The targetIs 'highestHp' condition (C4 design §11's B1 row, F16; lead rulings H1, H2;
 * src/sim/build/eval.ts, src/sim/systems/globals.ts): it holds for the instance's or event's
 * target when that is the alive enemy with the most hp at this tick's globals step, the first of
 * equals in ctx.enemies, bosses included; never without a target or outside a run. One scan a
 * tick, only in a run whose build names targetIs (BuildFlags.highestHp). Each test names in a
 * comment the planted bug it kills.
 */

import { describe, expect, it, vi } from 'vitest';
import { num } from '../../core/num';
import type { Modifier } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import { targetDamage } from '../../data/curve';
import { compileBuild } from '../build/compile';
import { compileCondition, conditionsMet, staticInput, statAt } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { rowKey } from '../build/sources';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData, placedEnemies, v3TestData } from '../testing';
import type { PlacedEnemy } from '../testing';
import { NO_INPUT } from '../types';
import type { RunConfig, SimEvent } from '../types';
import type * as Contact from './contact';
import type { Enemy, RunContext, WaveRecord } from './context';
import type * as EnemyAi from './enemyAi';
import type * as Globals from './globals';
import { highestHpId, stepGlobals } from './globals';
import { addEnemy } from './spawn';

// Stage 2b (the enemy AI step, before the globals step) and the contact step (right after it),
// wrapped to record the highest-hp id each starts with, and the globals step, wrapped to count
// its calls that compute the id; all call through.
const seen = vi.hoisted(() => ({
  twoB: [] as number[],
  contact: [] as number[],
  /** At the contact step: the id a fresh scan finds then. */
  scanned: [] as number[],
  topCalls: 0,
  calls: 0,
}));
vi.mock('./enemyAi', async (importOriginal) => {
  const actual = await importOriginal<typeof EnemyAi>();
  return {
    ...actual,
    stepEnemyAi: (ctx: RunContext): void => {
      seen.twoB.push(ctx.evalInput.highestHpId);
      actual.stepEnemyAi(ctx);
    },
  };
});
vi.mock('./contact', async (importOriginal) => {
  const actual = await importOriginal<typeof Contact>();
  return {
    ...actual,
    resolveContacts: (ctx: RunContext): void => {
      seen.contact.push(ctx.evalInput.highestHpId);
      seen.scanned.push(highestHpId(ctx));
      actual.resolveContacts(ctx);
    },
  };
});
vi.mock('./globals', async (importOriginal) => {
  const actual = await importOriginal<typeof Globals>();
  return {
    ...actual,
    stepGlobals: (...args: Parameters<typeof Globals.stepGlobals>): void => {
      seen.calls++;
      if (args[4] === true) seen.topCalls++;
      actual.stepGlobals(...args);
    },
  };
});

const reset = (): void => {
  seen.twoB.length = 0;
  seen.contact.length = 0;
  seen.scanned.length = 0;
  seen.topCalls = 0;
  seen.calls = 0;
};

const TOP = [compileCondition({ targetIs: 'highestHp' })];
/** ◆鎖定's shape: crit chance on the highest-life enemy, here +100 % so that every hit on it crits. */
const LOCK: Modifier = {
  stat: 'critChance',
  kind: 'flat',
  value: 1,
  when: [{ targetIs: 'highestHp' }],
};
/** A shock on every hit of the highest-life enemy. */
const SHOCK_TOP: TriggerSpec = {
  on: 'hit',
  when: [{ targetIs: 'highestHp' }],
  do: [{ kind: 'applyAilment', ailment: 'shock' }],
};

/**
 * A build of `scoped` and `triggers` without random crits or ignites: in a run, a volley of four
 * projectiles chaining twice at six attacks a second, damage half of wave 8's target, enough to
 * wear its waves down so that the highest-hp enemy (the onion boss among them) changes.
 */
const statsWith = (
  scoped: readonly Modifier[],
  triggers: readonly TriggerSpec[] = [],
  values: Parameters<typeof makeStats>[0] = {},
) =>
  makeStats(
    {
      critChance: 0,
      igniteChance: 0,
      damage: targetDamage(8) / 2,
      maxLife: 1e6,
      attackSpeed: 6,
      projectileCount: 4,
      chainCount: 2,
      ...values,
    },
    scoped,
    {
      triggers: triggers.map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: [],
    },
  );

/** Enemies at `hps` (max hp `maxHps`, the hp when omitted) in a run of the LOCK build. */
function field(hps: readonly number[], placed: Partial<PlacedEnemy>[] = []): RunContext {
  const ctx = placedEnemies(
    hps.map((hp, i) => ({ x: 600 + 30 * i, y: 300, hp, ...placed[i] })),
    { stats: statsWith([LOCK]) },
  );
  return ctx;
}
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies.find((e) => e.id === id) as Enemy;
/** The ids the condition holds for, at the context's tick. */
const matching = (ctx: RunContext): number[] =>
  ctx.enemies.filter((e) => e.alive && conditionsMet(TOP, e, ctx.now, 0, ctx)).map((e) => e.id);

describe('BuildFlags.highestHp (lead ruling H2)', () => {
  const flagOf = (stats = statsWith([]), modules: TestModule[] = []): boolean =>
    compileBuild(stats, [], undefined, modules).flags.highestHp;

  it('is set by a targetIs after another condition, in a modifier’s when or a trigger’s', () => {
    // Planted bug: readsTargetIs reading a list's first condition alone, so that the condition
    // would never hold.
    const later: Modifier = { ...LOCK, when: [{ targetHpBelow: 0.5 }, { targetIs: 'highestHp' }] };
    expect(flagOf(statsWith([later]))).toBe(true);
    const trigger: TriggerSpec = {
      ...SHOCK_TOP,
      when: [{ targetKind: 'boss' }, { targetIs: 'highestHp' }],
    };
    expect(flagOf(statsWith([], [trigger]))).toBe(true);
  });

  it('is set by a targetIs in a modifier’s when or a trigger’s conditions, a module’s too, and false otherwise', () => {
    // Planted bugs: the flag read from the modifiers alone, from the build's data alone (a
    // module's addModifier or addTrigger missed), or from another condition.
    expect(flagOf(statsWith([LOCK]))).toBe(true);
    expect(flagOf(statsWith([], [SHOCK_TOP]))).toBe(true);
    expect(flagOf()).toBe(false);
    const other: Modifier = { ...LOCK, when: [{ targetHpBelow: 0.5 }] };
    expect(flagOf(statsWith([other], [{ ...SHOCK_TOP, when: [{ targetKind: 'boss' }] }]))).toBe(
      false,
    );
    const addsMod: TestModule = (b) => b.addModifier({ ...LOCK, scope: 'center' });
    const addsTrigger: TestModule = (b) => b.addTrigger('center', SHOCK_TOP);
    expect(flagOf(statsWith([]), [addsMod])).toBe(true);
    expect(flagOf(statsWith([]), [addsTrigger])).toBe(true);
    // A module's own setting stays (||=).
    const sets: TestModule = (b) => {
      b.flags.highestHp = true;
    };
    expect(flagOf(statsWith([]), [sets])).toBe(true);
  });
});

describe('the highest-hp enemy of the globals step', () => {
  it('holds for the alive enemy with the most hp alone, by id, the first of equals in ctx.enemies', () => {
    // Planted bugs: the last of equals (>=); the enemy's index in ctx.enemies taken for its id;
    // max hp compared instead of hp; the condition holding for every target.
    const ctx = field([100, 300, 300, 200], [{}, {}, {}, { hp: 200 }]);
    // Enemy 4's max hp is the largest; its hp is not.
    Object.assign(enemy(ctx, 4), { maxHp: num(1e6) });
    Object.assign(enemy(ctx, 1), { maxHp: num(1e5) });
    stepGlobals(ctx, num(0), false, false, true);
    expect(ctx.evalInput.highestHpId).toBe(2);
    expect(matching(ctx)).toEqual([2]);
  });

  it('counts a boss, and leaves a dead enemy out', () => {
    // Planted bugs: bosses skipped; a dead enemy kept.
    const ctx = field([100, 500, 300], [{}, { type: 'boss' }]);
    expect(enemy(ctx, 2).boss).toBe(true);
    stepGlobals(ctx, num(0), false, false, true);
    expect(matching(ctx)).toEqual([2]);
    enemy(ctx, 2).alive = false;
    stepGlobals(ctx, num(0), false, false, true);
    expect(ctx.evalInput.highestHpId).toBe(3);
    for (const e of ctx.enemies) e.alive = false;
    stepGlobals(ctx, num(0), false, false, true);
    expect(ctx.evalInput.highestHpId).toBe(0);
    expect(highestHpId(placedEnemies([]))).toBe(0);
  });

  it('never holds without a target or outside a run, nor before the first step', () => {
    // Planted bug: ctx null taken as met.
    const ctx = field([100, 300]);
    const top = enemy(ctx, 2);
    // Before any step the id is 0, which no enemy has.
    expect(matching(ctx)).toEqual([]);
    stepGlobals(ctx, num(0), false, false, true);
    expect(conditionsMet(TOP, top, ctx.now, 0, ctx)).toBe(true);
    expect(conditionsMet(TOP, top, ctx.now, 0, null)).toBe(false);
    expect(conditionsMet(TOP, top, ctx.now, 0)).toBe(false);
    expect(conditionsMet(TOP, null, ctx.now, 0, ctx)).toBe(false);
    // An estimate outside a run leaves the modifier out; the run's read on the top enemy has it.
    const row = ctx.table.row(rowKey(0, 0));
    const crit = SCOPED_INDEX.critChance;
    expect(statAt(ctx.table, row, crit, staticInput())).toBe(0);
    expect(statAt(ctx.table, row, crit, { ...ctx.evalInput, target: top })).toBe(1);
    expect(statAt(ctx.table, row, crit, { ...ctx.evalInput, target: enemy(ctx, 1) })).toBe(0);
    expect(statAt(ctx.table, row, crit, { ...ctx.evalInput, target: top, ctx: null })).toBe(0);
  });

  it('judges by the step’s snapshot until the next step: an hp change, a death and a spawn', () => {
    // Planted bug: the highest enemy scanned at each check rather than once a tick.
    const ctx = field([100, 300, 200]);
    stepGlobals(ctx, num(0), false, false, true);
    expect(matching(ctx)).toEqual([2]);
    // Enemy 2 falls below 3 during the tick: still 2 until the next step.
    enemy(ctx, 2).hp = num(50);
    expect(matching(ctx)).toEqual([2]);
    // Enemy 2 dies after the step: no enemy matches until the next step, which finds 3.
    enemy(ctx, 2).alive = false;
    expect(matching(ctx)).toEqual([]);
    expect(conditionsMet(TOP, enemy(ctx, 3), ctx.now, 0, ctx)).toBe(false);
    stepGlobals(ctx, num(0), false, false, true);
    expect(matching(ctx)).toEqual([3]);
    // An enemy spawned after the step, with the most hp, waits for the next step; ids are never
    // reused (ctx.nextEnemyId), so a new enemy never takes a dead one's.
    const before = ctx.nextEnemyId;
    addEnemy(ctx, ctx.data.enemies.square, ctx.current as WaveRecord, 1, 0, 400);
    const spawned = ctx.enemies.at(-1) as Enemy;
    Object.assign(spawned, { hp: num(1e15), maxHp: num(1e15) });
    expect(spawned.id).toBe(before);
    expect(ctx.enemies.filter((e) => e.id === spawned.id)).toHaveLength(1);
    expect(matching(ctx)).toEqual([3]);
    stepGlobals(ctx, num(0), false, false, true);
    expect(matching(ctx)).toEqual([spawned.id]);
  });
});

describe('the highest-hp enemy in a run', () => {
  /** A 600-tick v3 run of `stats`, its per-tick ids and events; `watch` hooks onto it. */
  function runOf(stats: ReturnType<typeof statsWith>, config: Partial<RunConfig> = {}) {
    const ids: number[] = [];
    const watch: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        ids.push(ctx.evalInput.highestHpId);
      });
    const sim = createSimulation(
      makeConfig({ stats, startWave: 8, maxTicks: 600, ...config }),
      v3TestData(),
      [watch],
    );
    reset();
    const events: SimEvent[][] = [];
    while (!sim.state.finished) events.push([...sim.step(NO_INPUT)]);
    return { ids, events };
  }

  it('is written once a tick right after the grid; stage 2b reads the previous tick’s (0 on tick 1)', () => {
    // Planted bugs: the step moved before the enemy AI (stage 2b reading this tick's); the step
    // left out of the run's globals gate.
    const { events } = runOf(statsWith([LOCK]));
    const ticks = events.length;
    expect(seen.topCalls).toBe(ticks);
    expect(seen.contact).toHaveLength(ticks);
    // The contact step starts with what a fresh scan finds then.
    expect(seen.contact).toEqual(seen.scanned);
    expect(seen.twoB).toHaveLength(ticks);
    expect(seen.twoB[0]).toBe(0);
    expect(seen.twoB.slice(1)).toEqual(seen.contact.slice(0, -1));
    // The id moves during the run, so the two readings differ on some ticks.
    const moved = seen.contact.filter((id, t) => t > 0 && id !== seen.contact[t - 1]).length;
    expect(moved).toBeGreaterThan(5);
    expect(new Set(seen.contact).size).toBeGreaterThan(5);
  });

  it('runs the step in a build with targetIs only in a trigger condition', () => {
    // Planted bug: the flag read from the modifiers alone.
    runOf(statsWith([], [SHOCK_TOP]));
    expect(seen.topCalls).toBe(seen.contact.length);
    expect(seen.contact.filter((id) => id !== 0).length).toBeGreaterThan(300);
    expect(seen.contact).toEqual(seen.scanned);
  });

  it('never runs it in a build without targetIs: the id stays 0', () => {
    // Planted bug: the step computing the id in every run (a counter of its calls).
    runOf(statsWith([{ ...LOCK, when: [{ targetHpBelow: 0.99 }] }]));
    expect([seen.calls, seen.topCalls]).toEqual([0, 0]);
    expect(seen.contact.every((id) => id === 0)).toBe(true);
    // A build that reads the shards held calls the step, without the id.
    const greed: Modifier = {
      stat: 'damage',
      kind: 'more',
      value: 1,
      scaling: { per: 'shardsHeld', curve: 'powFactor', exponent: 0.1 },
    };
    runOf(statsWith([greed]));
    expect(seen.calls).toBe(seen.contact.length);
    expect(seen.topCalls).toBe(0);
    expect(seen.contact.every((id) => id === 0)).toBe(true);
  });

  it('raises crits on the highest-life enemy alone, and fires its trigger there alone', () => {
    // Planted bugs: the condition read against another enemy (the last of equals, a stale id, a
    // fresh scan at the hit); the trigger's targetIs not compiled.
    const { ids, events } = runOf(statsWith([LOCK], [SHOCK_TOP]));
    let onTop = 0;
    let onTopBoss = 0;
    let elsewhere = 0;
    let shocks = 0;
    const bosses = new Set<number>();
    events.forEach((tick, t) => {
      const id = ids[t] as number;
      for (const event of tick) {
        if (event.type === 'enemySpawned' && event.enemy === 'onion') bosses.add(event.enemyId);
        if (event.type === 'hit') {
          expect(event.crit, `tick ${t + 1} hit on ${event.targetId}, top ${id}`).toBe(
            event.targetId === id,
          );
          if (event.targetId === id) onTop++;
          else elsewhere++;
          if (event.targetId === id && bosses.has(id)) onTopBoss++;
        } else if (event.type === 'ailmentApplied' && event.ailment === 'shock') {
          expect(event.targetId, `tick ${t + 1}`).toBe(id);
          shocks++;
        }
      }
    });
    expect(onTop).toBeGreaterThan(80);
    // The onion boss is the highest for a while, and its hits crit then.
    expect(onTopBoss).toBeGreaterThan(20);
    expect(elsewhere).toBeGreaterThan(200);
    expect(shocks).toBeGreaterThan(80);
    // The same run without the condition crits nowhere (crit chance 0).
    const plain = runOf(statsWith([]));
    const crits = plain.events.flat().filter((e) => e.type === 'hit' && e.crit).length;
    expect(crits).toBe(0);
  });

  it('runs in an M1 run too, where every hit of a tick reads that tick’s step', () => {
    // Planted bug: the step gated on the v3 enemy AI.
    const tickIds: number[] = [];
    const hits: { tick: number; id: number; crit: boolean; on: number }[] = [];
    const watch: TestModule = (b) => {
      b.hook('tick', (ctx) => {
        tickIds[ctx.now] = ctx.evalInput.highestHpId;
      });
      b.hook('onHit', (ctx, hit) => {
        hits.push({
          tick: ctx.now,
          id: ctx.evalInput.highestHpId,
          crit: hit.crit,
          on: hit.target.id,
        });
      });
    };
    const sim = createSimulation(
      makeConfig({ stats: statsWith([LOCK]), startWave: 8, maxTicks: 300 }),
      makeTestData(),
      [watch],
    );
    reset();
    while (!sim.state.finished) sim.step(NO_INPUT);
    expect(seen.topCalls).toBe(300);
    expect(hits.length).toBeGreaterThan(50);
    for (const hit of hits) {
      expect(hit.id).toBeGreaterThan(0);
      expect(hit.id).toBe(tickIds[hit.tick]);
      expect(hit.crit).toBe(hit.on === hit.id);
    }
    expect(hits.some((hit) => hit.crit)).toBe(true);
  });
});
