import { describe, expect, it } from 'vitest';
import { ZERO } from '../../core/num';
import { CENTER_EVENTS, STACK_AILMENTS } from '../../data/triggers';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { compileBuild } from '../build/compile';
import { liveStacks } from '../build/eval';
import { FREEZE_LIST_RADIUS, LIST_MAX } from '../caps';
import type { CenterEventScratch, TestModule } from '../rules';
import type { Enemy, RunContext } from '../systems/context';
import { centerTriggers, eventsOf, makeStats, placedEnemies, rngPositions } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import { emitCenterEvent, raiseFreeze } from './centerEvents';
import { fireOne } from './dispatch';
import { runEffectQueue } from './execute';
import { HIT_EVENT, REPEAT, SIGNATURE } from './flags';
import { EVENT, SHATTER_TRIGGER } from './types';
import type { CompiledTrigger } from './types';

/** The frozen enemy's position in the list fixture, 300 right of the player. */
const F = { x: ARENA_WIDTH / 2 + 300, y: ARENA_HEIGHT / 2 };
/** An enemy (dx, dy) from F. */
const near = (dx: number, dy: number): PlacedEnemy => ({ x: F.x + dx, y: F.y + dy });

/**
 * The freeze list's fixture (ids 1 to 8): 3 sits at F; 1, 2, 4 (exactly 90 away), 5 and 6 are
 * within FREEZE_LIST_RADIUS of it; 7 is 91 away; 8 sits within it too and is killed by
 * fixture() before anything runs.
 */
const LIST_FIXTURE: readonly PlacedEnemy[] = [
  near(30, 0),
  near(0, 89),
  near(0, 0),
  near(-90, 0),
  near(60, 60),
  near(0, -50),
  near(91, 0),
  near(10, 10),
];
const FROZEN = 3;
const DEAD = 8;

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;
const POISON = STACK_AILMENTS.indexOf('poison');

const poison2: EffectSpec = { kind: 'applyAilment', ailment: 'poison', stacks: 2 };

/** The list fixture with these center triggers and test modules, its enemy 8 dead. */
function fixture(triggers: readonly TriggerSpec[], modules: readonly TestModule[] = []) {
  const ctx = placedEnemies(LIST_FIXTURE, {
    stats: makeStats({}, [], centerTriggers(triggers)),
    modules,
  });
  enemy(ctx, DEAD).alive = false;
  return ctx;
}

/** The enemy with id `id` (placedEnemies numbers them 1, 2, … in order). */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** A hook that records each center event's kind and the ids of its list. */
function listSpy(): { module: TestModule; seen: [number, number[]][] } {
  const seen: [number, number[]][] = [];
  const module: TestModule = (b) =>
    b.hook('onCenterEvent', (_ctx, ev) => {
      seen.push([ev.event, ev.list.slice(0, ev.listCount).map((e) => e.id)]);
    });
  return { module, seen };
}

/** The queued entries, oldest first: their effect, target id (null for none) and depth. */
function queued(ctx: RunContext): [number, number | null, number][] {
  const q = ctx.effectQueue;
  return Array.from({ length: q.size }, (_, n) => {
    const at = (q.head + n) & q.capMask;
    return [q.effect[at] as number, q.target[at]?.id ?? null, q.depth[at] as number];
  });
}

/** Ids of the enemies holding live poison stacks, with their counts. */
const poisoned = (ctx: RunContext): [number, number][] =>
  ctx.enemies
    .map((e): [number, number] => [e.id, liveStacks(e, POISON, ctx.now)])
    .filter(([, stacks]) => stacks > 0);

describe('the freeze list', () => {
  it('is the frozen enemy, then up to four others within 90, in id order', () => {
    const spy = listSpy();
    const ctx = fixture([], [spy.module]);
    expect(ctx.centerEvents.listNeeded[EVENT.freeze]).toBe(1);
    raiseFreeze(ctx, enemy(ctx, FROZEN), 0, -1, 0);
    // 4 at exactly 90 is in; 6 is the fifth other, past LIST_MAX; 7 is out; 8 is dead.
    expect(spy.seen).toEqual([[EVENT.freeze, [3, 1, 2, 4, 5]]]);
    expect(ctx.centerScratch.radius).toBe(FREEZE_LIST_RADIUS);
    expect(ctx.centerScratch.listCount).toBe(LIST_MAX);

    // With fewer around, the list is shorter: 1 and 5 are within 90 of 7, and 3 (91) is not.
    raiseFreeze(ctx, enemy(ctx, 7), 0, -1, 0);
    expect(spy.seen[1]).toEqual([EVENT.freeze, [7, 1, 5]]);
    for (const id of [1, 2, 4, 5]) enemy(ctx, id).alive = false;
    raiseFreeze(ctx, enemy(ctx, FROZEN), 0, -1, 0);
    expect(spy.seen[2]).toEqual([EVENT.freeze, [3, 6]]);
  });

  it('is taken only for a trigger that fans out or for a hook', () => {
    const shock: EffectSpec = { kind: 'applyAilment', ailment: 'shock' };
    const listNeeded = (triggers: TriggerSpec[], modules: TestModule[] = []): number[] =>
      Array.from(fixture(triggers, modules).centerEvents.listNeeded);
    const none = CENTER_EVENTS.map(() => 0);
    const freezeOnly = CENTER_EVENTS.map((name) => (name === 'freeze' ? 1 : 0));
    expect(listNeeded([])).toEqual(none);
    expect(listNeeded([{ on: 'freeze', do: [{ kind: 'heal', lifePct: 0.1 }] }])).toEqual(none);
    expect(listNeeded([{ on: 'freeze', do: [{ ...shock, radius: 50 }] }])).toEqual(none);
    expect(listNeeded([{ on: 'freeze', target: { pick: 'nearest' }, do: [shock] }])).toEqual(none);
    expect(listNeeded([{ on: 'hit', do: [shock] }])).toEqual(none);
    expect(listNeeded([{ on: 'freeze', do: [shock] }])).toEqual(freezeOnly);
    expect(listNeeded([{ on: 'freeze', do: [{ kind: 'addFrost', amount: 0.2 }] }])).toEqual(
      freezeOnly,
    );
    // A hook reads every center event's list.
    expect(listNeeded([], [listSpy().module])).toEqual(CENTER_EVENTS.map(() => 1));

    // Without a reader, the freeze queries nothing and leaves the list empty.
    const ctx = fixture([{ on: 'freeze', target: { pick: 'nearest' }, do: [shock] }]);
    raiseFreeze(ctx, enemy(ctx, FROZEN), 0, -1, 0);
    expect(ctx.centerEvents.freezeTargets).toEqual([]);
    expect(ctx.centerScratch.list).toEqual([]);
    expect(ctx.centerScratch.listCount).toBe(0);
  });

  it('counts the triggers and the hooks listening to each center event', () => {
    const heal: EffectSpec = { kind: 'heal', lifePct: 0.1 };
    const ctx = fixture(
      [
        { on: 'freeze', do: [heal] },
        { on: 'hit', do: [heal] },
        { on: 'freeze', do: [heal, heal] },
      ],
      [listSpy().module, listSpy().module],
    );
    expect(Array.from(ctx.centerEvents.listeners)).toEqual(
      CENTER_EVENTS.map((name) => (name === 'freeze' ? 2 : 0)),
    );
    expect(ctx.centerEvents.hooks).toBe(2);
  });
});

describe('fan-out', () => {
  it('poisons exactly the alive list, effect by effect, on one chance roll and one cooldown', () => {
    const trigger: TriggerSpec = {
      on: 'freeze',
      when: [{ chance: 0.9 }, { cooldownSec: 1 }],
      do: [
        poison2,
        { kind: 'explode', radius: 40, damagePct: 1 },
        { kind: 'addFrost', amount: 0.1 },
      ],
    };
    const ctx = fixture([trigger]);
    const t = ctx.build.triggers[FIRST] as CompiledTrigger;
    const [ailment, explode, frost] = [t.effectStart, t.effectStart + 1, t.effectStart + 2];
    expect(ctx.build.effects.slice(t.effectStart, t.effectEnd).map((fx) => fx.fanout)).toEqual([
      true,
      false,
      true,
    ]);
    // The trigger draws once, as a twin context's stream does.
    const twin = fixture([trigger]);
    expect(twin.triggerRng.chance(0.9)).toBe(true);
    const start = rngPositions(ctx);
    raiseFreeze(ctx, enemy(ctx, FROZEN), 1, -1, 0);
    expect(rngPositions(ctx)).toEqual({ ...start, trigger: twin.triggerRng.snapshot() });
    expect(ctx.triggerState.readyAt[FIRST]).toBe(ctx.now + 60);
    const list = [3, 1, 2, 4, 5];
    // Each status effect over the list in order, then the next; the explode once, at 3. Every
    // entry is one deeper than the freeze, and its origin is the trigger.
    expect(queued(ctx)).toEqual([
      ...list.map((id) => [ailment, id, 2]),
      [explode, FROZEN, 2],
      ...list.map((id) => [frost, id, 2]),
    ]);
    const q = ctx.effectQueue;
    expect(Array.from({ length: q.size }, (_, n) => q.origin[q.head + n])).toEqual(
      Array<number>(q.size).fill(FIRST),
    );
    // Each entry starts at its own enemy.
    expect(q.x[q.head + 1]).toBe(enemy(ctx, 1).x);
    expect(q.y[q.head + 2]).toBe(enemy(ctx, 2).y);

    // A second freeze within the cooldown queues nothing and draws nothing.
    const before = rngPositions(ctx);
    raiseFreeze(ctx, enemy(ctx, 6), 1, -1, 0);
    expect(q.size).toBe(11);
    expect(rngPositions(ctx)).toEqual(before);
    // The list, and only the list, takes two stacks each.
    runEffectQueue(ctx);
    expect(poisoned(ctx)).toEqual([1, 2, 3, 4, 5].map((id) => [id, 2]));
  });

  it('skips the dead of a list, and applies the stacks to the rest', () => {
    const ctx = fixture([{ on: 'freeze', do: [poison2] }]);
    // A list as an explode leaves it, its dead kept: 3, 8 (dead), 7 (far, but listed), 1.
    const scratch = ctx.centerScratch;
    const ids = [FROZEN, DEAD, 7, 1];
    ids.forEach((id, j) => (scratch.list[j] = enemy(ctx, id)));
    scratch.listCount = ids.length;
    emitCenterEvent(ctx, EVENT.freeze, 0, -1, enemy(ctx, FROZEN), F.x, F.y, 0);
    expect(queued(ctx).map(([, id]) => id)).toEqual([FROZEN, 7, 1]);
    runEffectQueue(ctx);
    expect(poisoned(ctx)).toEqual([
      [1, 2],
      [3, 2],
      [7, 2],
    ]);
    expect(eventsOf([ctx.events], 'ailmentApplied').map((e) => e.targetId)).toEqual([3, 7, 1]);
  });

  it('does not fan out a trigger with a selector, even when a hook has the list taken', () => {
    const spy = listSpy();
    const ctx = fixture(
      [
        {
          on: 'freeze',
          target: { pick: 'nearest', excludeEventTarget: true },
          do: [{ kind: 'applyAilment', ailment: 'shock' }],
        },
      ],
      [spy.module],
    );
    raiseFreeze(ctx, enemy(ctx, FROZEN), 0, -1, 0);
    expect(spy.seen).toEqual([[EVENT.freeze, [3, 1, 2, 4, 5]]]);
    // Once, on the enemy nearest 3 but 3: 1, 30 away (8, closer, is dead).
    const t = ctx.build.triggers[FIRST] as CompiledTrigger;
    expect(queued(ctx)).toEqual([[t.effectStart, 1, 1]]);
  });

  it('queues an effect that is not a status once on any other event, as before', () => {
    const ctx = fixture([{ on: 'hit', do: [poison2] }]);
    // A list left over from a freeze changes nothing for a hit trigger.
    const scratch = ctx.centerScratch;
    scratch.list[0] = enemy(ctx, 1);
    scratch.listCount = 1;
    const target = enemy(ctx, FROZEN);
    fireOne(ctx, FIRST, 0, -1, target, target.x, target.y, HIT_EVENT, ZERO, -1);
    const t = ctx.build.triggers[FIRST] as CompiledTrigger;
    expect(queued(ctx)).toEqual([[t.effectStart, FROZEN, 1]]);
  });

  it('keeps an area frost whole while its freezes take their lists (C2)', () => {
    // The addFrost walks ctx.effectTargets; each enemy it freezes takes its list into
    // freezeTargets and fans the shock out, which only queues.
    const ctx = fixture([
      { on: 'hit', do: [{ kind: 'addFrost', amount: 1, radius: 95 }] },
      { on: 'freeze', do: [{ kind: 'applyAilment', ailment: 'shock' }] },
    ]);
    const target = enemy(ctx, FROZEN);
    fireOne(ctx, FIRST, 0, -1, target, target.x, target.y, HIT_EVENT, ZERO, -1);
    runEffectQueue(ctx);
    // Every alive enemy within 95 of 3 froze once, in id order: 7 (91 away) too, not the dead 8.
    expect(eventsOf([ctx.events], 'freeze').map((e) => e.targetId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ctx.centerEvents.freezeTargets.length).toBeGreaterThan(0);
  });
});

describe('emitCenterEvent', () => {
  it('returns before the scratch when no trigger and no hook listens', () => {
    const ctx = fixture([{ on: 'hit', do: [poison2] }]);
    const scratch = ctx.centerScratch;
    const other = enemy(ctx, 1);
    Object.assign(scratch, { event: 9, depth: 2, origin: 7, flags: 5, target: other, x: 1, y: 2 });
    Object.assign(scratch, { radius: 3, listCount: 1, fromX: 4, fromY: 6 });
    scratch.list[0] = other;
    const before: CenterEventScratch = { ...scratch, list: [...scratch.list] };
    const target = enemy(ctx, FROZEN);
    for (const event of CENTER_EVENTS) {
      emitCenterEvent(ctx, EVENT[event], 0, -1, target, F.x, F.y, SIGNATURE | HIT_EVENT);
    }
    expect({ ...scratch, list: [...scratch.list] }).toEqual(before);
    expect(ctx.effectQueue.size).toBe(0);
  });

  it('raises no explode or chainJump of a repeat (rule 8), but a freeze all the same', () => {
    const seen: [number, number][] = [];
    const module: TestModule = (b) =>
      b.hook('onCenterEvent', (_ctx, ev) => {
        seen.push([ev.event, ev.flags]);
      });
    const ctx = fixture([], [module]);
    const target = enemy(ctx, FROZEN);
    const repeat = SIGNATURE | REPEAT | HIT_EVENT;
    const raise = (event: number, flags: number): void =>
      emitCenterEvent(ctx, event, 0, -1, target, F.x, F.y, flags);
    raise(EVENT.explode, repeat);
    raise(EVENT.chainJump, repeat);
    raise(EVENT.explode, REPEAT);
    expect(seen).toEqual([]);
    raise(EVENT.explode, SIGNATURE);
    raise(EVENT.chainJump, SIGNATURE | HIT_EVENT);
    raise(EVENT.freeze, repeat);
    raise(EVENT.freeze, REPEAT);
    expect(seen).toEqual([
      [EVENT.explode, SIGNATURE],
      [EVENT.chainJump, SIGNATURE | HIT_EVENT],
      [EVENT.freeze, repeat],
      [EVENT.freeze, REPEAT],
    ]);
  });
});

describe('fanout at compile', () => {
  it('marks applyAilment, addFrost and detonate without a radius, and nothing else', () => {
    const effects: readonly EffectSpec[] = [
      { kind: 'applyAilment', ailment: 'burn' },
      { kind: 'applyAilment', ailment: 'bleed', radius: 60 },
      { kind: 'addFrost', amount: 0.3 },
      { kind: 'addFrost', amount: 0.3, radius: 60 },
      { kind: 'explode', radius: 60, damagePct: 1 },
      { kind: 'nova', radius: 60, damagePct: 1 },
      { kind: 'spreadAilment', ailment: 'burn', radius: 60 },
      { kind: 'push', distance: 10, radius: 60 },
      { kind: 'heal', lifePct: 0.1 },
      { kind: 'detonate', ailment: 'poison' },
      { kind: 'detonate', ailment: 'poison', radius: 60 },
    ];
    // frostOnHit lets the build freeze, so its shatter effect is compiled too.
    const build = compileBuild(
      makeStats({ frostOnHit: 0.1 }, [], centerTriggers([{ on: 'freeze', do: effects }])),
      [],
    );
    expect(build.effects.map((fx) => [fx.kind, fx.fanout])).toEqual([
      ['applyAilment', true],
      ['applyAilment', false],
      ['addFrost', true],
      ['addFrost', false],
      ['explode', false],
      ['nova', false],
      ['spreadAilment', false],
      ['push', false],
      ['heal', false],
      ['detonate', true],
      ['detonate', false],
      ['shatter', false],
    ]);
  });
});
