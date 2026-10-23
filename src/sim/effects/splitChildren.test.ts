import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { num } from '../../core/num';
import type { RuleSpec } from '../../data/rules';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { applyBurn, applyPoison } from '../ailments/apply';
import { RING_BURN, RING_POISON } from '../ailments/rings';
import { heldFlags } from '../build/eval';
import { CENTER } from '../build/sources';
import { createSimulation } from '../simulation';
import { updateAilments } from '../systems/ailments';
import type { Enemy, RunContext } from '../systems/context';
import { killEnemy } from '../systems/death';
import { createSplitState } from '../systems/systemState';
import {
  centerTriggers,
  makeConfig,
  makeStats,
  makeTestData,
  PANDEMIC_TRIGGER,
  placedEnemies,
  rngPositions,
  stationarySquares,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import { fireInlineKill } from './dispatch';
import { KILL_KIND_SHIFT } from './flags';
import { MAX_DEPTH, SHATTER_TRIGGER } from './types';

type PoisonSpread = Extract<EffectSpec, { kind: 'spreadAilment'; ailment: 'poison' }>;

/** The pentagon's position, 300 right of the player. */
const P = { x: ARENA_WIDTH / 2 + 300, y: ARENA_HEIGHT / 2 };

/**
 * Id 1 a pentagon at P, which splits into three shards (ids 4 to 6) 22 from it; id 2 a square
 * 40 from it, id 3 one 400 from it.
 */
const PLACED: readonly PlacedEnemy[] = [
  { ...P, type: 'pentagon' },
  { x: P.x + 40, y: P.y },
  { x: P.x + 400, y: P.y },
];

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

const NO_ROLLS = { critChance: 0, igniteChance: 0, poisonChance: 0, projectileCount: 1 };

/** A poison spread to the enemies within 100, at 0.4 of its damage. */
const spread = (extra: Partial<PoisonSpread> = {}): PoisonSpread => ({
  kind: 'spreadAilment',
  ailment: 'poison',
  radius: 100,
  effect: 0.4,
  ...extra,
});

/** A kill trigger whose spread gives each split child `share` of the victim's poison. */
const toChildren = (share: number, extra: Partial<TriggerSpec> = {}): TriggerSpec => ({
  on: 'kill',
  do: [spread({ toSplitChildren: share })],
  ...extra,
});

function scene(
  triggers: readonly TriggerSpec[],
  options: { rules?: readonly RuleSpec[]; placed?: readonly PlacedEnemy[]; data?: GameData } = {},
): RunContext {
  return placedEnemies(options.placed ?? PLACED, {
    stats: makeStats(NO_ROLLS, [], centerTriggers(triggers)),
    rules: options.rules ?? [],
    ...(options.data === undefined ? {} : { data: options.data }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const children = (ctx: RunContext): Enemy[] => ctx.enemies.slice(PLACED.length);

/**
 * Poison on `victim` from tick 1: 10 center stacks of 4 dps until `end`, and 3 stacks of the
 * poison outer board of 2 dps until 151 at most, so two rings.
 */
function poison(ctx: RunContext, victim: Enemy, end = 301): void {
  applyPoison(ctx, victim, num(4), end, 0, CENTER, 10);
  applyPoison(ctx, victim, num(2), Math.min(end, 151), 0, ctx.sources.index('outer.poison'), 3);
}

/**
 * Runs the first damage-over-time step, at tick 15: a spread then moves exactly its share of a
 * ring's damage left (RingPool.spread estimates the step under way at any other tick).
 */
function toFirstStep(ctx: RunContext): void {
  ctx.now = 15;
  updateAilments(ctx);
}

interface RingView {
  readonly slot: number;
  readonly remaining: number;
  readonly stacks: number;
  readonly credit: number;
  readonly cls: number;
  readonly end: number;
}

/** The enemy's rings from slot `first` (RING_POISON or RING_BURN). */
function ringsOf(ctx: RunContext, target: Enemy, first = RING_POISON): RingView[] {
  const pool = ctx.rings;
  const views: RingView[] = [];
  for (let slot = first; slot < first + 3; slot++) {
    const r = target.rings[slot] as number;
    if (r < 0) continue;
    views.push({
      slot,
      remaining: pool.remaining[r] as number,
      stacks: pool.stacks[r] as number,
      credit: pool.credit[r] as number,
      cls: pool.cls[r] as number,
      end: pool.end[r] as number,
    });
  }
  return views;
}

/**
 * `child` holds, for each of the victim's poison rings `source` (read before the kill), the
 * sum of `shares` of its damage left and floor(share × its stacks) per share, in a ring of the
 * same slot, class and credit lasting as long.
 */
function expectShares(
  ctx: RunContext,
  child: Enemy,
  source: readonly RingView[],
  shares: readonly number[],
): void {
  const got = ringsOf(ctx, child);
  expect(got.map((ring) => [ring.slot, ring.credit, ring.cls, ring.end])).toEqual(
    source.map((ring) => [ring.slot, ring.credit, ring.cls, ring.end]),
  );
  source.forEach((ring, i) => {
    const total = shares.reduce((sum, f) => sum + f, 0);
    const actual = (got[i] as RingView).remaining;
    expect(Math.abs(actual - total * ring.remaining), `remaining ${ring.slot}`).toBeLessThanOrEqual(
      1e-12 * total * ring.remaining,
    );
    const stacks = shares.reduce((sum, f) => sum + Math.floor(f * ring.stacks + 1e-9), 0);
    expect((got[i] as RingView).stacks, `stacks ${ring.slot}`).toBe(stacks);
  });
  expect(child.poisonStacks).toBe(got.reduce((sum, ring) => sum + ring.stacks, 0));
  expect(child.poisonRingEnd).toBe(Math.max(...source.map((ring) => ring.end)));
}

/** Kills the pentagon (id 1) at kill depth `depth` and returns its poison rings before it. */
function killPentagon(ctx: RunContext, depth = 0): RingView[] {
  const pentagon = enemy(ctx, 1);
  const before = ringsOf(ctx, pentagon);
  pentagon.killDepth = depth;
  killEnemy(ctx, pentagon, -1, 0);
  return before;
}

/** The trigger list as a toSplitChildren-free twin: the same triggers, the field dropped. */
const unset = (triggers: readonly TriggerSpec[]): TriggerSpec[] =>
  triggers.map((trigger) => ({
    ...trigger,
    do: trigger.do.map((effect) => {
      if (effect.kind !== 'spreadAilment' || effect.ailment !== 'poison') return effect;
      const rest = { ...effect };
      delete rest.toSplitChildren;
      return rest;
    }),
  }));

describe('toSplitChildren', () => {
  it('gives each child of a poisoned pentagon the fraction of every poison ring, and only them', () => {
    const triggers = [toChildren(0.5)];
    const ctx = scene(triggers);
    const twin = scene(unset(triggers));
    for (const c of [ctx, twin]) {
      poison(c, enemy(c, 1));
      applyBurn(c, enemy(c, 1), num(5), 200, 0, CENTER, 1);
      toFirstStep(c);
    }
    const before = killPentagon(ctx);
    killPentagon(twin);
    expect(before.map((ring) => [ring.slot, ring.stacks])).toEqual([
      [RING_POISON, 10],
      [RING_POISON + 1, 3],
    ]);
    const kids = children(ctx);
    expect(kids.map((kid) => kid.type)).toEqual(['shard', 'shard', 'shard']);
    for (const kid of kids) {
      expectShares(ctx, kid, before, [0.5]);
      // No burn: the share is of the poison only.
      expect(kid.burns).toEqual([]);
    }
    // The twin's children get nothing; the square in range gets the spread's own share either
    // way, the square outside it nothing.
    for (const kid of children(twin)) expect(ringsOf(twin, kid)).toEqual([]);
    expect(ringsOf(ctx, enemy(ctx, 2))).toEqual(ringsOf(twin, enemy(twin, 2)));
    expect(ringsOf(ctx, enemy(ctx, 2)).map((ring) => ring.stacks)).toEqual([10, 3]);
    expect(ringsOf(ctx, enemy(ctx, 3))).toEqual([]);
    expect(ctx.sys.split.passedCount).toBe(0);
  });

  it('gives the children of a v3 run their share too, and none to a child the enemy cap skipped (C7.5)', () => {
    // A v3 table of M1's types whose waves spawn nothing (TEST_V3_WAVES.v3 spread, as
    // v3TestData's merge is shallow): the three placed enemies alone are alive.
    const v3 = (enemyCap: number): GameData =>
      v3TestData({
        waves: {
          rules: (['triangle', 'square', 'pentagon'] as const).map((type) => ({
            enemy: type,
            fromWave: 1,
            base: 0,
            perWave: 0,
            maxCount: 0,
          })),
          eliteEvery: 1000,
          bossEvery: 1000,
          spawnDurationSec: 0,
          waveTimerSec: 1000,
          v3: {
            ...TEST_V3_WAVES.v3,
            enemyCap,
            affixes: [],
            treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
          },
        },
      });
    // Under a cap of 4 the pentagon's death leaves 2 alive: two shards spawn, the third is skipped.
    for (const [enemyCap, spawned] of [
      [400, 3],
      [4, 2],
    ] as const) {
      const ctx = scene([toChildren(0.5)], { data: v3(enemyCap) });
      poison(ctx, enemy(ctx, 1));
      toFirstStep(ctx);
      const before = killPentagon(ctx);
      const kids = children(ctx);
      expect(kids.map((kid) => kid.type)).toEqual(Array(spawned).fill('shard'));
      for (const kid of kids) expectShares(ctx, kid, before, [0.5]);
      expect(ctx.counters.enemySpawnsSkipped).toBe(3 - spawned);
      expect(ctx.sys.split.passedCount).toBe(0);
    }
  });

  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 3],
  ])(
    'runs one deeper than a kill at depth %i: the children’s ailment depth is %i',
    (depth, ail) => {
      const ctx = scene([toChildren(0.5)]);
      poison(ctx, enemy(ctx, 1));
      killPentagon(ctx, depth);
      expect(children(ctx).map((kid) => kid.ailDepth)).toEqual([ail, ail, ail]);
      expect(MAX_DEPTH).toBe(3);
    },
  );

  it('draws nothing, queries no grid and emits nothing beyond the field-unset twin', () => {
    const triggers = [toChildren(0.5, { when: [{ chance: 0.9 }] })];
    const runs = [scene(triggers), scene(unset(triggers))].map((ctx) => {
      poison(ctx, enemy(ctx, 1));
      ctx.events.length = 0;
      const within = vi.spyOn(ctx.grid, 'within');
      killPentagon(ctx);
      return { ctx, within: within.mock.calls.length, events: JSON.stringify(ctx.events) };
    });
    const [set, twin] = runs as [(typeof runs)[0], (typeof runs)[0]];
    expect(rngPositions(set.ctx)).toEqual(rngPositions(twin.ctx));
    expect(set.within).toBe(twin.within);
    expect(set.events).toBe(twin.events);
    // The chance passed on this seed: the children did get their share.
    expect(children(set.ctx).every((kid) => kid.poisonStacks === 6)).toBe(true);
  });

  it('reaches every child whatever the spread’s radius and target cap', () => {
    const ctx = scene([
      { on: 'kill', do: [spread({ radius: 1, maxTargets: 1, stacks: 0.1, toSplitChildren: 1 })] },
    ]);
    poison(ctx, enemy(ctx, 1));
    toFirstStep(ctx);
    const before = killPentagon(ctx);
    for (const kid of children(ctx)) expectShares(ctx, kid, before, [1]);
    expect(ringsOf(ctx, enemy(ctx, 2))).toEqual([]);
  });

  it('adds up the shares of every passing trigger and effect, and skips a failing one', () => {
    const ctx = scene([
      // A transfer without the field before them: it passes and gives the children nothing.
      { on: 'kill', do: [spread()] },
      PANDEMIC_TRIGGER,
      toChildren(0.5),
      toChildren(1, { when: [{ victimHas: 'burn' }] }),
      { on: 'diedWithAilment', do: [spread({ effect: 0.5, toSplitChildren: 0.25 })] },
      {
        on: 'kill',
        do: [spread({ toSplitChildren: 0.125 }), spread({ radius: 50, toSplitChildren: 0.125 })],
      },
    ]);
    poison(ctx, enemy(ctx, 1));
    toFirstStep(ctx);
    const before = killPentagon(ctx);
    for (const kid of children(ctx)) expectShares(ctx, kid, before, [0.5, 0.25, 0.125, 0.125]);
    expect(ctx.sys.split.passedCount).toBe(0);
  });

  it('clears the record at a kill without children, so a later kill gives only its own', () => {
    const triggers = [toChildren(0.5, { when: [{ victimHas: 'burn' }] })];
    const placed = [...PLACED.slice(0, 3), { x: P.x, y: P.y + 200 }];
    const ctx = scene(triggers, { placed });
    // The square at id 4 is burning: the trigger passes at its kill, which has no children.
    const square = enemy(ctx, 4);
    poison(ctx, square);
    applyBurn(ctx, square, num(5), 200, 0, CENTER, 1);
    killEnemy(ctx, square, -1, 0);
    expect(ctx.sys.split.passedCount).toBe(0);
    // The pentagon is not: the trigger fails at its kill, and its children get nothing.
    poison(ctx, enemy(ctx, 1));
    killPentagon(ctx);
    const kids = ctx.enemies.slice(placed.length);
    expect(kids).toHaveLength(3);
    for (const kid of kids) {
      expect(ringsOf(ctx, kid)).toEqual([]);
      expect(kid.poisonStacks).toBe(0);
    }
  });

  it('gives a kill only the triggers that pass at it, not the rest of an earlier record', () => {
    const triggers = [toChildren(0.5, { when: [{ victimHas: 'burn' }] }), toChildren(0.25)];
    const placed = [...PLACED.slice(0, 3), { x: P.x, y: P.y + 200 }];
    const ctx = scene(triggers, { placed });
    // Both pass at the burning square's kill (id 4, no children), only the second at the
    // pentagon's: passed[1] still holds the square's second record.
    const square = enemy(ctx, 4);
    poison(ctx, square);
    applyBurn(ctx, square, num(5), 200, 0, CENTER, 1);
    poison(ctx, enemy(ctx, 1));
    toFirstStep(ctx);
    killEnemy(ctx, square, -1, 0);
    const before = killPentagon(ctx);
    const kids = ctx.enemies.slice(placed.length);
    expect(kids).toHaveLength(3);
    for (const kid of kids) expectShares(ctx, kid, before, [0.25]);
  });

  it('records a trigger whose toSplitChildren spread is not its first effect', () => {
    const ctx = scene([{ on: 'kill', do: [spread(), spread({ toSplitChildren: 0.5 })] }]);
    expect(ctx.sys.split.transfers).toEqual([FIRST]);
    poison(ctx, enemy(ctx, 1));
    toFirstStep(ctx);
    const before = killPentagon(ctx);
    for (const kid of children(ctx)) expectShares(ctx, kid, before, [0.5]);
  });

  it('takes the children’s depth from the kill, not from the poison it moves', () => {
    const ctx = scene([toChildren(0.5)]);
    const pentagon = enemy(ctx, 1);
    applyPoison(ctx, pentagon, num(4), 301, 2, CENTER, 10);
    expect(pentagon.ailDepth).toBe(2);
    killPentagon(ctx, 0);
    expect(children(ctx).map((kid) => kid.ailDepth)).toEqual([1, 1, 1]);
  });

  it('moves nothing once the victim’s poison stacks have all ended', () => {
    const ctx = scene([toChildren(1)]);
    const pentagon = enemy(ctx, 1);
    poison(ctx, pentagon, 10);
    // Tick 10: the stacks end now, the rings go back at the next step.
    ctx.now = 10;
    expect(ringsOf(ctx, pentagon)).toHaveLength(2);
    killPentagon(ctx);
    for (const kid of children(ctx)) {
      expect(ringsOf(ctx, kid)).toEqual([]);
      expect(kid.ailDepth).toBe(MAX_DEPTH);
    }
  });

  it('leaves burn rings under eternalFlame with the victim', () => {
    const ctx = scene([toChildren(1)], { rules: [{ id: 'eternalFlame', durationMore: 0 }] });
    const pentagon = enemy(ctx, 1);
    poison(ctx, pentagon);
    applyBurn(ctx, pentagon, num(5), 200, 0, CENTER, 2);
    toFirstStep(ctx);
    expect(ringsOf(ctx, pentagon, RING_BURN)).toHaveLength(1);
    const before = killPentagon(ctx);
    for (const kid of children(ctx)) {
      expectShares(ctx, kid, before, [1]);
      expect(ringsOf(ctx, kid, RING_BURN)).toEqual([]);
      expect(kid.burnStacks).toBe(0);
    }
  });

  it('gives the children of a poison step’s kill the fraction of what that step left', () => {
    const triggers = [toChildren(0.5)];
    const placed = (hp: number): PlacedEnemy[] => [{ ...P, type: 'pentagon', hp }];
    const ctx = scene(triggers, { placed: placed(10) });
    const twin = scene(triggers, { placed: placed(1e12) });
    for (const c of [ctx, twin]) {
      applyPoison(c, enemy(c, 1), num(100), 601, 0, CENTER, 4);
      toFirstStep(c);
    }
    expect(enemy(ctx, 1).alive).toBe(false);
    expect(enemy(twin, 1).alive).toBe(true);
    const kids = ctx.enemies.slice(1);
    expect(kids).toHaveLength(3);
    // The twin's pentagon holds what the step left; the kill was at its ailment depth, 0.
    for (const kid of kids) {
      expectShares(ctx, kid, ringsOf(twin, enemy(twin, 1)), [0.5]);
      expect(kid.ailDepth).toBe(1);
    }
  });
});

describe('the split record (ctx.sys.split)', () => {
  it('lists the inline kill triggers with a toSplitChildren spread, once each, in order', () => {
    const triggers: TriggerSpec[] = [
      // Not at the kill: a hit trigger, and a kill trigger with an effect that is no transfer.
      { on: 'hit', do: [spread({ toSplitChildren: 0.5 })] },
      { on: 'kill', do: [spread({ toSplitChildren: 0.5 }), { kind: 'heal', lifePct: 0.01 }] },
      { on: 'kill', do: [spread({ toSplitChildren: 0.5 }), spread({ toSplitChildren: 0.25 })] },
      PANDEMIC_TRIGGER,
      { on: 'diedWithAilment', do: [spread()] },
      { on: 'diedWithAilment', do: [spread({ toSplitChildren: 1 })] },
    ];
    const ctx = scene(triggers);
    const split = ctx.sys.split;
    expect(split.transfers).toEqual([FIRST + 2, FIRST + 5]);
    expect([split.passed.length, split.passedCount]).toEqual([2, 0]);
    expect(createSplitState(ctx.build)).toEqual(split);
    const none = scene(unset(triggers)).sys.split;
    expect([none.transfers, none.passed.length]).toEqual([[], 0]);
  });

  it('records the triggers of the list that pass at the kill, in trigger order', () => {
    const ctx = scene([
      toChildren(0.5),
      { on: 'kill', do: [spread()] },
      toChildren(0.25, { when: [{ victimHas: 'burn' }] }),
      { on: 'diedWithAilment', do: [spread({ toSplitChildren: 0.25 })] },
    ]);
    const pentagon = enemy(ctx, 1);
    poison(ctx, pentagon);
    const flags = heldFlags(pentagon, ctx.now) | (1 << (KILL_KIND_SHIFT + pentagon.killKind));
    fireInlineKill(ctx, pentagon, -1, flags);
    const split = ctx.sys.split;
    expect(Array.from(split.passed.subarray(0, split.passedCount))).toEqual([FIRST, FIRST + 3]);
  });
});

/**
 * Pentagons and triangles under a poison volley whose kills spread poison (stacks 0.5, to 2)
 * and burn (Pandemic), `toSplitChildren` on the poison spread when given; 1200 ticks on seed 3.
 * The hash of every tick's events, then the counts of each event type.
 */
function poisonRun(data: GameData, toSplitChildren?: number): [string, Record<string, number>] {
  const poisonSpread = spread({ radius: 150, stacks: 0.5, maxTargets: 2 });
  const stats = makeStats(
    {
      damage: 3,
      attackSpeed: 3,
      projectileCount: 2,
      critChance: 0,
      poisonChance: 0.8,
      poisonDamage: 2,
      poisonDuration: 3,
      igniteChance: 0.3,
      burnDamage: 1,
    },
    [],
    centerTriggers([
      {
        on: 'kill',
        when: [{ victimHas: 'poison' }],
        do: [toSplitChildren === undefined ? poisonSpread : { ...poisonSpread, toSplitChildren }],
      },
      PANDEMIC_TRIGGER,
    ]),
  );
  const sim = createSimulation(makeConfig({ seed: 3, stats, maxTicks: 1200 }), data);
  const hash = createHash('sha256');
  const counts: Record<string, number> = {};
  while (!sim.state.finished) {
    const events = sim.step(NO_INPUT);
    for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
    hash.update(JSON.stringify(events));
  }
  return [hash.digest('hex').slice(0, 16), counts];
}

const PENTAGONS = (): GameData =>
  makeTestData({
    waves: {
      rules: [
        { enemy: 'pentagon', fromWave: 1, base: 8, perWave: 1, maxCount: 14 },
        { enemy: 'triangle', fromWave: 1, base: 4, perWave: 0, maxCount: 4 },
      ],
      eliteEvery: 1000,
      bossEvery: 1000,
    },
  });

describe('toSplitChildren unset', () => {
  it('replays the run of its parent commit event for event', () => {
    // Recorded at C4.11's parent (97a4d36), where the field does not exist.
    const [hash, counts] = poisonRun(PENTAGONS());
    expect(counts.enemyKilled).toBeGreaterThan(40);
    expect(counts.ailmentSpread).toBeGreaterThan(10);
    expect(hash).toBe('e0724a8f71c37f6e');
  });

  it('changes nothing where no victim splits', () => {
    const data = stationarySquares(30, 3);
    const [set, counts] = poisonRun(data, 0.5);
    expect(counts.ailmentSpread).toBeGreaterThan(5);
    expect(set).toBe(poisonRun(data)[0]);
  });

  it('changes the run where victims split', () => {
    expect(poisonRun(PENTAGONS(), 0.5)[0]).not.toBe(poisonRun(PENTAGONS())[0]);
  });
});
