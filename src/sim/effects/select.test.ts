import { describe, expect, it } from 'vitest';
import { num, ZERO } from '../../core/num';
import { createRng } from '../../core/rng';
import { TAG } from '../../data/tags';
import { STACK_AILMENTS, TARGET_PICKS, TARGETLESS_EVENTS } from '../../data/triggers';
import type {
  EffectSpec,
  StackAilment,
  TargetSelector,
  TriggerEventId,
  TriggerSpec,
} from '../../data/triggers';
import { applyPoison } from '../ailments/apply';
import { addBurn } from '../ailments/records';
import { liveStacks } from '../build/eval';
import { CENTER } from '../build/sources';
import type { Enemy, RunContext } from '../systems/context';
import { killEnemy } from '../systems/death';
import { centerTriggers, eventsOf, makeStats, placedEnemies, rngPositions } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import { dispatchPendingKills, fireInlineKill, fireOne } from './dispatch';
import { runEffectQueue } from './execute';
import { compileSelector, orderNearest, select } from './select';
import { SHATTER_TRIGGER } from './types';

/** The player's position (createRunContext puts it at the arena's center). */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** An enemy (dx, dy) from the player. */
const at = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...extra,
});

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

/** placedEnemies with these center triggers. */
const withTriggers = (placed: readonly PlacedEnemy[], ...triggers: TriggerSpec[]): RunContext =>
  placedEnemies(placed, { stats: makeStats({}, [], centerTriggers(triggers)) });

/** The enemy with id `id` (placedEnemies numbers them 1, 2, … in order). */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** The id select() picks for an event of `on` on `eventTarget` at (x, y); null for none. */
function pickId(
  ctx: RunContext,
  target: TargetSelector,
  on: TriggerEventId = 'hit',
  eventTarget: Enemy | null = null,
  x = P.x,
  y = P.y,
): number | null {
  const picked = select(ctx, compileSelector(target, on), eventTarget, x, y);
  expect(picked).toBe(ctx.selected !== null || target.pick === 'player');
  return ctx.selected?.id ?? null;
}

/** Target ids of the effect hits (tagged trigger) among the events, in order. */
const effectHitIds = (ctx: RunContext): number[] =>
  eventsOf([ctx.events], 'hit')
    .filter((event) => (event.tags & TAG.trigger) !== 0)
    .map((event) => event.targetId);

/** Fires trigger FIRST on `target`'s hit event at its point, then runs the effect phase. */
function hitAndRun(ctx: RunContext, target: Enemy): void {
  fireOne(ctx, FIRST, 0, -1, target, target.x, target.y, 0, ZERO, -1);
  ctx.events.length = 0;
  runEffectQueue(ctx);
}

/**
 * The picks' fixture, from the player: 1 and 2 at 200 on either side, 3 and 4 at 400 above and
 * below, 5 close by, 6 and 7 next to 1 (with 5, the most crowded spot).
 */
const PICKS_FIXTURE: readonly PlacedEnemy[] = [
  at(200, 0),
  at(-200, 0),
  at(0, 400),
  at(0, -400),
  at(50, 50),
  at(210, 10),
  at(190, -10),
];

describe('target selector picks', () => {
  it('picks the nearest and the farthest from its point, ties to the lower id', () => {
    const ctx = placedEnemies(PICKS_FIXTURE);
    expect(pickId(ctx, { pick: 'nearest' }, 'periodic')).toBe(5);
    expect(pickId(ctx, { pick: 'farthest' }, 'periodic')).toBe(3);
    // 1 and 2 are equally far from the player, as are 3 and 4.
    enemy(ctx, 5).alive = false;
    enemy(ctx, 6).alive = false;
    enemy(ctx, 7).alive = false;
    expect(pickId(ctx, { pick: 'nearest' }, 'periodic')).toBe(1);
    expect(pickId(ctx, { pick: 'farthest' }, 'periodic', null)).toBe(3);
    expect(pickId(ctx, { pick: 'nearest', range: 199 }, 'periodic')).toBeNull();
    expect(pickId(ctx, { pick: 'farthest', range: 200 }, 'periodic')).toBe(1);
  });

  it('picks the outermost by its distance from the player, wherever the event is', () => {
    const ctx = placedEnemies(PICKS_FIXTURE);
    expect(pickId(ctx, { pick: 'outermost' }, 'hit', null, P.x, P.y + 400)).toBe(3);
    enemy(ctx, 3).dist = 399;
    expect(pickId(ctx, { pick: 'outermost' }, 'hit', null, P.x, P.y - 400)).toBe(4);
    // Farthest measures from the event's point instead: 3, 800 below 4.
    expect(pickId(ctx, { pick: 'farthest' }, 'hit', null, P.x, P.y - 400)).toBe(3);
  });

  it('picks the most hp left, ties to the lower id', () => {
    const ctx = placedEnemies(PICKS_FIXTURE);
    for (const id of [2, 4, 6]) enemy(ctx, id).hp = num(5e12);
    expect(pickId(ctx, { pick: 'highestHp' }, 'periodic')).toBe(2);
    expect(pickId(ctx, { pick: 'highestHp', range: 300 }, 'periodic')).toBe(2);
    expect(pickId(ctx, { pick: 'highestHp', range: 150 }, 'periodic')).toBe(5);
    enemy(ctx, 2).hp = num(4e12);
    expect(pickId(ctx, { pick: 'highestHp' }, 'periodic')).toBe(4);
  });

  it('picks the most live stacks of its ailment, at least one', () => {
    expect(() => compileSelector({ pick: 'mostStacks' }, 'periodic')).toThrow(/ailment/);
    const ctx = placedEnemies(PICKS_FIXTURE);
    expect(pickId(ctx, { pick: 'mostStacks', ailment: 'shock' }, 'periodic')).toBeNull();
    const shock = (id: number, stacks: number, until: number): void => {
      Object.assign(enemy(ctx, id), { shockStacks: stacks, shockUntil: until });
    };
    shock(1, 1, 100);
    shock(4, 3, 100);
    shock(5, 3, 100);
    shock(6, 5, ctx.now); // worn off
    expect(pickId(ctx, { pick: 'mostStacks', ailment: 'shock' }, 'periodic')).toBe(4);
    expect(pickId(ctx, { pick: 'mostStacks', ailment: 'shock', range: 250 }, 'periodic')).toBe(5);
    expect(pickId(ctx, { pick: 'mostStacks', ailment: 'burn' }, 'periodic')).toBeNull();
    addBurn(ctx, enemy(ctx, 7), num(1), ctx.now + 60, 0, CENTER);
    expect(pickId(ctx, { pick: 'mostStacks', ailment: 'burn' }, 'periodic')).toBe(7);
  });

  it('picks the accepted enemy nearest the center of the most crowded cell', () => {
    // 1, 5, 6 and 7 crowd several 3 × 3 blocks of 128-unit cells; the first in row-major order
    // is around the cell (1024, 384)–(1152, 512), whose center (1088, 448) is closest to 7,
    // then 1.
    const ctx = placedEnemies(PICKS_FIXTURE);
    const point = { x: 0, y: 0 };
    expect(ctx.grid.densest(point)).toBe(4);
    expect(point).toEqual({ x: 1088, y: 448 });
    expect(pickId(ctx, { pick: 'densest' }, 'periodic')).toBe(7);
    expect(pickId(ctx, { pick: 'densest', excludeEventTarget: true }, 'hit', enemy(ctx, 7))).toBe(
      1,
    );
    expect(pickId(ctx, { pick: 'densest', range: 100 }, 'periodic')).toBe(5);
    // Its range still counts from its own point: only 2 is within 50 of (-200, 0).
    expect(pickId(ctx, { pick: 'densest', range: 50 }, 'hit', null, P.x - 200, P.y)).toBe(2);
    for (const e of ctx.enemies) e.alive = false;
    expect(pickId(ctx, { pick: 'densest' }, 'periodic')).toBeNull();
  });

  it("picks no enemy for 'player', and always passes", () => {
    const ctx = placedEnemies([]);
    ctx.selected = ctx.enemies[0] ?? null;
    expect(select(ctx, compileSelector({ pick: 'player' }, 'hit'), null, 0, 0)).toBe(true);
    expect(ctx.selected).toBeNull();
  });

  it('leaves out the event’s enemy and bosses when asked to', () => {
    const ctx = placedEnemies([at(100, 0), at(110, 0, { type: 'boss' }), at(130, 0)]);
    const first = enemy(ctx, 1);
    const nearest = (target: Partial<TargetSelector>): number | null =>
      pickId(ctx, { pick: 'nearest', ...target }, 'hit', first, first.x, first.y);
    expect(nearest({})).toBe(1);
    expect(nearest({ excludeEventTarget: true })).toBe(2);
    expect(nearest({ excludeEventTarget: true, excludeBoss: true })).toBe(3);
    expect(nearest({ excludeEventTarget: true, excludeBoss: true, range: 29 })).toBeNull();
    expect(nearest({ excludeEventTarget: true, excludeBoss: true, range: 30 })).toBe(3);
  });

  it('measures from the player on events without a point, or with from player', () => {
    expect(compileSelector({ pick: 'nearest' }, 'hit').fromPlayer).toBe(false);
    expect(compileSelector({ pick: 'nearest', from: 'event' }, 'kill').fromPlayer).toBe(false);
    expect(compileSelector({ pick: 'nearest', from: 'player' }, 'hit').fromPlayer).toBe(true);
    for (const on of TARGETLESS_EVENTS) {
      expect(compileSelector({ pick: 'nearest' }, on).fromPlayer, on).toBe(true);
    }
    const ctx = placedEnemies(PICKS_FIXTURE);
    const third = enemy(ctx, 3);
    expect(pickId(ctx, { pick: 'nearest' }, 'hit', null, third.x, third.y)).toBe(3);
    expect(pickId(ctx, { pick: 'nearest' }, 'periodic', null, third.x, third.y)).toBe(5);
    const fromPlayer = { pick: 'nearest', from: 'player' } as const;
    expect(pickId(ctx, fromPlayer, 'hit', null, third.x, third.y)).toBe(5);
  });

  it('matches a brute-force pick over random fixtures, sorted and linear', () => {
    const rng = createRng(4404);
    const events: readonly TriggerEventId[] = ['hit', 'kill', 'periodic', 'contact'];
    let picked = 0;
    for (let round = 0; round < 300; round++) {
      const n = rng.int(40);
      const placed: PlacedEnemy[] = [];
      for (let i = 0; i < n; i++) {
        // Coarse positions and values, so equal distances and ties come up.
        const x = rng.int(25) * 80 - 40;
        const y = rng.int(15) * 80 - 40;
        placed.push({
          x,
          y,
          hp: (1 + rng.int(4)) * 1e11,
          ...(rng.chance(0.1) ? { type: 'boss' } : {}),
        });
      }
      const ctx = placedEnemies(placed, { seed: round + 1 });
      for (const e of ctx.enemies) {
        if (rng.chance(0.15)) e.alive = false;
        if (rng.chance(0.4)) Object.assign(e, { shockStacks: 1 + rng.int(3), shockUntil: 99 });
        if (rng.chance(0.3)) applyPoison(ctx, e, num(1), 80, 0, CENTER, 1 + rng.int(3));
      }
      if (rng.chance(0.5)) ctx.grid.sortNow();
      const pick = rng.pick(TARGET_PICKS);
      const target: TargetSelector = {
        pick,
        ...(pick === 'mostStacks' ? { ailment: rng.pick(STACK_AILMENTS) } : {}),
        ...(rng.chance(0.3) ? { from: rng.pick(['event', 'player'] as const) } : {}),
        ...(rng.chance(0.4) ? { range: 50 + rng.int(600) } : {}),
        ...(rng.chance(0.4) ? { excludeEventTarget: true } : {}),
        ...(rng.chance(0.4) ? { excludeBoss: true } : {}),
      };
      const on = rng.pick(events);
      const eventTarget = n > 0 && rng.chance(0.7) ? enemy(ctx, 1 + rng.int(n)) : null;
      const x = rng.range(0, ARENA_WIDTH);
      const y = rng.range(0, ARENA_HEIGHT);
      const expected = brutePick(ctx, target, on, eventTarget, x, y);
      const label = JSON.stringify({ round, target, on });
      expect(pickId(ctx, target, on, eventTarget, x, y), label).toBe(expected?.id ?? null);
      if (expected !== null) picked++;
    }
    expect(picked).toBeGreaterThan(150);
  });
});

/** Reference: the pick by sorting every accepted enemy, as TargetSelector documents it. */
function brutePick(
  ctx: RunContext,
  target: TargetSelector,
  on: TriggerEventId,
  eventTarget: Enemy | null,
  x: number,
  y: number,
): Enemy | null {
  if (target.pick === 'player') return null;
  const fromPlayer = target.from === 'player' || TARGETLESS_EVENTS.has(on);
  const fx = fromPlayer ? ctx.player.x : x;
  const fy = fromPlayer ? ctx.player.y : y;
  const distSq = (e: Enemy, px: number, py: number): number =>
    (e.x - px) * (e.x - px) + (e.y - py) * (e.y - py);
  const accepted = ctx.enemies.filter(
    (e) =>
      e.alive &&
      !(target.excludeEventTarget === true && e === eventTarget) &&
      !(target.excludeBoss === true && e.boss) &&
      distSq(e, fx, fy) <= (target.range ?? Infinity) ** 2,
  );
  // Highest score first, then the lower id.
  const best = (score: (e: Enemy) => number): Enemy | null =>
    [...accepted].sort((a, b) => score(b) - score(a) || a.id - b.id)[0] ?? null;
  switch (target.pick) {
    case 'nearest':
      return best((e) => -distSq(e, fx, fy));
    case 'farthest':
      return best((e) => distSq(e, fx, fy));
    case 'outermost':
      return best((e) => e.dist);
    case 'highestHp':
      return best((e) => e.hp);
    case 'mostStacks': {
      const a = STACK_AILMENTS.indexOf(target.ailment as StackAilment);
      const most = best((e) => liveStacks(e, a, ctx.now));
      return most !== null && liveStacks(most, a, ctx.now) > 0 ? most : null;
    }
    case 'densest': {
      const point = { x: 0, y: 0 };
      if (ctx.grid.densest(point) === 0) return null;
      return best((e) => -distSq(e, point.x, point.y));
    }
  }
}

describe('the selector in the dispatch gates', () => {
  const explode: EffectSpec = { kind: 'explode', radius: 40, damagePct: 1 };

  it('stops a trigger without a pick: nothing queued, nothing drawn, no cooldown (K30)', () => {
    const selector: TargetSelector = { pick: 'nearest', range: 100, excludeEventTarget: true };
    const ctx = withTriggers(
      [at(300, 0), at(-300, 0)],
      { on: 'nthAttack', every: 2, when: [{ cooldownSec: 1 }], target: selector, do: [explode] },
      { on: 'hit', when: [{ chance: 0.5 }], target: selector, do: [explode] },
    );
    const [a, b] = [enemy(ctx, 1), enemy(ctx, 2)];
    const state = ctx.triggerState;
    const start = rngPositions(ctx);
    // At a's point, a is excluded and b is 600 away: no pick.
    const onA = (i: number): void => fireOne(ctx, i, 0, -1, a, a.x, a.y, 0, ZERO, -1);
    for (let n = 0; n < 3; n++) onA(FIRST);
    onA(FIRST + 1);
    expect(ctx.effectQueue.size).toBe(0);
    expect(rngPositions(ctx)).toEqual(start);
    expect(state.readyAt[FIRST]).toBe(0);
    expect(state.readyAt[FIRST + 1]).toBe(0);
    // Every counted all three events, the second of which failed only for want of a pick.
    expect(state.count[FIRST]).toBe(3);

    // At b's point b is in range: the fourth event fires, and the cooldown starts.
    fireOne(ctx, FIRST, 0, -1, a, b.x, b.y, 0, ZERO, -1);
    expect(ctx.effectQueue.size).toBe(1);
    expect(ctx.effectQueue.target[ctx.effectQueue.head]).toBe(b);
    expect(state.readyAt[FIRST]).toBe(ctx.now + 60);
    expect(rngPositions(ctx)).toEqual(start);

    // The chance trigger draws once it has a pick, as a twin context's stream does.
    const twin = withTriggers([at(300, 0), at(-300, 0)]);
    const fired = twin.triggerRng.chance(0.5);
    fireOne(ctx, FIRST + 1, 0, -1, a, b.x, b.y, 0, ZERO, -1);
    expect(rngPositions(ctx)).toEqual({ ...start, trigger: twin.triggerRng.snapshot() });
    expect(ctx.effectQueue.size).toBe(fired ? 2 : 1);
  });

  it('checks the conditions on the event’s enemy and acts on the picked one', () => {
    const ctx = withTriggers([at(100, 0), at(-300, 0), at(-320, 0), at(0, 500)], {
      on: 'hit',
      when: [{ targetHpBelow: 0.5 }],
      target: { pick: 'farthest', range: 450 },
      do: [{ kind: 'applyAilment', ailment: 'shock', stacks: 2 }],
    });
    const [a, b, c] = [enemy(ctx, 1), enemy(ctx, 2), enemy(ctx, 3)];
    hitAndRun(ctx, b);
    expect(ctx.effectQueue.size).toBe(0);
    expect(ctx.enemies.map((e) => e.shockStacks)).toEqual([0, 0, 0, 0]);
    a.hp = num(1e11);
    // From a's point (100, 0), c is 420 away and 4 (at 500 below the player) is farther than
    // the 450 range.
    hitAndRun(ctx, a);
    expect(ctx.enemies.map((e) => e.shockStacks)).toEqual([0, 0, 2, 0]);
    expect(eventsOf([ctx.events], 'ailmentApplied').map((e) => e.targetId)).toEqual([c.id]);
  });

  it('measures a pending kill’s pick from the victim', () => {
    const ctx = withTriggers([at(300, 0, { hp: 1 }), at(340, 0), at(-100, 0)], {
      on: 'kill',
      target: { pick: 'nearest' },
      do: [{ kind: 'applyAilment', ailment: 'shock' }],
    });
    const [victim, near] = [enemy(ctx, 1), enemy(ctx, 2)];
    victim.hp = ZERO;
    killEnemy(ctx, victim, -1, 0);
    dispatchPendingKills(ctx);
    expect(ctx.effectQueue.target[ctx.effectQueue.head]).toBe(near);
    runEffectQueue(ctx);
    expect(ctx.enemies.map((e) => e.shockStacks)).toEqual([0, 1, 0]);
  });

  it('measures from the victim on the inline kill path, and acts on the victim', () => {
    // Validation keeps selectors off kill transfers (they always act on the victim); compiled
    // anyway, the gate measures from the victim's point.
    const ctx = withTriggers([at(300, 0), at(360, 0), at(-300, 0)], {
      on: 'kill',
      target: { pick: 'farthest', range: 100 },
      do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 100 }],
    });
    const [victim, near] = [enemy(ctx, 1), enemy(ctx, 2)];
    addBurn(ctx, victim, num(10), ctx.now + 120, 0, CENTER);
    fireInlineKill(ctx, victim, -1, 0);
    expect(ctx.selected).toBe(near);
    // The victim's burn spread to its neighbour: the victim was the effect's enemy.
    expect(eventsOf([ctx.events], 'burnSpread').map((e) => e.enemyId)).toEqual([victim.id]);
    expect(near.burns).toHaveLength(1);

    // No enemy within 100 of the player: from the player, nothing would have fired.
    const far = withTriggers([at(300, 0), at(360, 0)], {
      on: 'kill',
      target: { pick: 'farthest', range: 100, from: 'player' },
      do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 100 }],
    });
    addBurn(far, enemy(far, 1), num(10), far.now + 120, 0, CENTER);
    fireInlineKill(far, enemy(far, 1), -1, 0);
    expect(eventsOf([far.events], 'burnSpread')).toEqual([]);
  });

  it('compiles no selector for a trigger without one, and atTarget or atPlayer with one', () => {
    const ctx = withTriggers(
      [],
      { on: 'hit', do: [explode] },
      { on: 'hit', target: { pick: 'densest' }, do: [explode] },
      { on: 'hit', target: { pick: 'player' }, do: [explode] },
    );
    const triggers = ctx.build.triggers;
    expect(triggers.map((t) => t.selector === null)).toEqual([true, true, false, false]);
    expect(ctx.build.effects.map((fx) => [fx.atTarget, fx.atPlayer])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
  });
});

describe('effects of a trigger with a selector', () => {
  /**
   * 1 by the player; 2, 3 and 4 in a clump about 400 to its left, of which 2 is the farthest
   * within 510 of 1 (500 away; 3 is 530 away, 4 482); 5 far below.
   */
  const CLUMP: readonly PlacedEnemy[] = [
    at(100, 0),
    at(-400, 0),
    at(-430, 0),
    at(-380, 45),
    at(0, 520),
  ];

  it('centers an area on the picked enemy, or on the player for a player pick', () => {
    const fire = (target: TargetSelector, effect: EffectSpec): number[] => {
      const ctx = withTriggers(CLUMP, { on: 'hit', target, do: [effect] });
      hitAndRun(ctx, enemy(ctx, 1));
      return effectHitIds(ctx);
    };
    const explode: EffectSpec = { kind: 'explode', radius: 40, damagePct: 1 };
    const nova: EffectSpec = { kind: 'nova', radius: 40, damagePct: 1, at: 'event' };
    const farthest: TargetSelector = { pick: 'farthest', range: 510 };
    expect(fire(farthest, explode)).toEqual([2, 3]);
    expect(fire(farthest, nova)).toEqual([2, 3]);
    // A nova at the player stays there.
    expect(fire(farthest, { ...nova, at: 'player' })).toEqual([]);
    expect(fire({ pick: 'player' }, { ...explode, radius: 110 })).toEqual([1]);
    expect(fire({ pick: 'nearest', from: 'player' }, explode)).toEqual([1]);
  });

  it('centers on where a picked enemy died before its effect ran', () => {
    const ctx = withTriggers(CLUMP, {
      on: 'hit',
      target: { pick: 'farthest', range: 510 },
      do: [{ kind: 'explode', radius: 40, damagePct: 1 }],
    });
    const first = enemy(ctx, 1);
    fireOne(ctx, FIRST, 0, -1, first, first.x, first.y, 0, ZERO, -1);
    enemy(ctx, 2).alive = false;
    runEffectQueue(ctx);
    expect(effectHitIds(ctx)).toEqual([3]);
  });

  it('pushes and frosts around the picked enemy', () => {
    const ctx = withTriggers(CLUMP, {
      on: 'hit',
      target: { pick: 'farthest', range: 510 },
      do: [
        { kind: 'addFrost', amount: 0.25, radius: 50 },
        { kind: 'push', distance: 30, radius: 50 },
      ],
    });
    const dists = ctx.enemies.map((e) => e.dist);
    hitAndRun(ctx, enemy(ctx, 1));
    expect(ctx.enemies.map((e) => e.frost)).toEqual([0, 0.25, 0.25, 0.25, 0]);
    expect(ctx.enemies.map((e, i) => e.dist - (dists[i] as number))).toEqual([0, 30, 30, 30, 0]);
  });
});

describe("order 'nearest'", () => {
  /** From the player: 1 at 250, 2 at 100, 3 at 50, 4 at 100 (2's tie), 5 at 200. */
  const RING: readonly PlacedEnemy[] = [
    at(250, 0),
    at(0, 100),
    at(-50, 0),
    at(0, -100),
    at(200, 0),
  ];
  type ExplodeSpec = Extract<EffectSpec, { kind: 'explode' }>;
  /** The effect hits of an explode at the player's point, from a hit trigger's queue entry. */
  const explodeOn = (extra: Partial<ExplodeSpec>): number[] => {
    const ctx = withTriggers(RING, {
      on: 'hit',
      do: [{ kind: 'explode', radius: 300, damagePct: 1, ...extra }],
    });
    fireOne(ctx, FIRST, 0, -1, null, P.x, P.y, 0, ZERO, -1);
    runEffectQueue(ctx);
    return effectHitIds(ctx);
  };

  it('hits the nearest maxTargets, nearest first, ties to the lower id', () => {
    expect(explodeOn({ maxTargets: 2, order: 'nearest' })).toEqual([3, 2]);
    expect(explodeOn({ maxTargets: 3, order: 'nearest' })).toEqual([3, 2, 4]);
    expect(explodeOn({ maxTargets: 4, order: 'nearest' })).toEqual([3, 2, 4, 5]);
    // Without a cap below the count, nothing is sorted: id order, as without an order.
    expect(explodeOn({ maxTargets: 5, order: 'nearest' })).toEqual([1, 2, 3, 4, 5]);
    expect(explodeOn({ order: 'nearest' })).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps 'id' exactly as no order", () => {
    const run = (extra: Partial<ExplodeSpec>) => {
      const ctx = withTriggers(RING, {
        on: 'hit',
        do: [{ kind: 'explode', radius: 300, damagePct: 1, maxTargets: 2, ...extra }],
      });
      fireOne(ctx, FIRST, 0, -1, null, P.x, P.y, 0, ZERO, -1);
      runEffectQueue(ctx);
      return { events: JSON.stringify(ctx.events), rng: rngPositions(ctx) };
    };
    expect(run({ order: 'id' })).toEqual(run({}));
    expect(explodeOn({ maxTargets: 2, order: 'id' })).toEqual([1, 2]);
  });

  it('applies ailments and frost to the nearest maxTargets', () => {
    const ctx = withTriggers(RING, {
      on: 'hit',
      do: [
        { kind: 'applyAilment', ailment: 'shock', radius: 300, maxTargets: 2, order: 'nearest' },
        { kind: 'addFrost', amount: 0.25, radius: 300, maxTargets: 1, order: 'nearest' },
        { kind: 'addFrost', amount: 0.5, radius: 300, maxTargets: 1 },
      ],
    });
    fireOne(ctx, FIRST, 0, -1, null, P.x, P.y, 0, ZERO, -1);
    runEffectQueue(ctx);
    expect(ctx.enemies.map((e) => e.shockStacks)).toEqual([0, 1, 1, 0, 0]);
    expect(ctx.enemies.map((e) => e.frost)).toEqual([0.5, 0, 0.25, 0, 0]);
  });

  it('spreads poison to the nearest maxTargets other than the source', () => {
    const spreadTo = (order: 'id' | 'nearest' | undefined): number[] => {
      // The source at the player's left, 3; poison spreads from it.
      const ctx = withTriggers(RING, {
        on: 'kill',
        do: [
          {
            kind: 'spreadAilment',
            ailment: 'poison',
            radius: 400,
            maxTargets: 2,
            ...(order === undefined ? {} : { order }),
          },
        ],
      });
      const source = enemy(ctx, 3);
      applyPoison(ctx, source, num(5), ctx.now + 120, 0, CENTER, 3);
      fireInlineKill(ctx, source, -1, 0);
      return ctx.enemies.filter((e) => e !== source && e.poisonStacks > 0).map((e) => e.id);
    };
    // From 3 at (-50, 0): 2 and 4 at 111.8, 5 at 250, 1 at 300.
    expect(spreadTo('nearest')).toEqual([2, 4]);
    expect(spreadTo('id')).toEqual([1, 2]);
    expect(spreadTo(undefined)).toEqual([1, 2]);
  });

  it('matches sorting by (distance, id) over random lists', () => {
    const rng = createRng(4405);
    for (let round = 0; round < 500; round++) {
      const n = rng.int(30);
      const list = Array.from(
        { length: n },
        (_, i) => ({ id: i + 1, x: rng.int(9) * 10, y: rng.int(9) * 10 }) as Enemy,
      );
      // A query's list is in id order, maybe with holes.
      const query = list.filter(() => rng.chance(0.8));
      const skip = query.length > 0 && rng.chance(0.5) ? rng.pick(query) : null;
      const m = 1 + rng.int(12);
      const x = rng.int(9) * 10;
      const y = rng.int(9) * 10;
      const d = (e: Enemy) => (e.x - x) ** 2 + (e.y - y) ** 2;
      const expected = query
        .filter((e) => e !== skip)
        .sort((a, b) => d(a) - d(b) || a.id - b.id)
        .slice(0, m)
        .map((e) => e.id);
      const out = [...query];
      const kept = orderNearest(out, out.length, m, x, y, skip);
      expect(out.slice(0, kept).map((e) => e.id)).toEqual(expected);
    }
  });
});
