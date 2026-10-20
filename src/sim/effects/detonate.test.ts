import { describe, expect, it } from 'vitest';
import { num, ONE, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { RuleSpec } from '../../data/rules';
import type { Modifier, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import { DETONATE_AILMENTS } from '../../data/triggers';
import type { DetonateSpec, EffectSpec, TriggerSpec } from '../../data/triggers';
import { applyBurn, applyPoison } from '../ailments/apply';
import { addBleed } from '../ailments/bleed';
import { addFrost } from '../ailments/frost';
import { addBurn, liveBurnStacks } from '../ailments/records';
import { remainingOf } from '../ailments/remaining';
import { takenMult } from '../ailments/shock';
import { CENTER } from '../build/sources';
import { hitWithPayload } from '../combat/hit';
import type { EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { updateAilments } from '../systems/ailments';
import type { Enemy, RunContext } from '../systems/context';
import { centerTriggers, eventsOf, makeStats, placedEnemies, rngPositions } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DT } from '../types';
import type { SimEvent } from '../types';
import { raiseFreeze } from './centerEvents';
import { dispatchPendingKills, fireOne } from './dispatch';
import { runEffectQueue } from './execute';
import { HIT_EVENT, KILL_BY_BLEED, KILL_BY_BURN, KILL_BY_HIT, KILL_BY_POISON } from './flags';
import {
  compileEffect,
  compileTrigger,
  EVENT,
  moduleTrigger,
  SHATTER_TRIGGER,
  shatterTrigger,
} from './types';
import type { CompiledTrigger } from './types';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;

/** The target's position, 300 right of the player. */
const P = { x: ARENA_WIDTH / 2 + 300, y: ARENA_HEIGHT / 2 };
const at = (dx: number, dy: number, hp?: number): PlacedEnemy =>
  hp === undefined ? { x: P.x + dx, y: P.y + dy } : { x: P.x + dx, y: P.y + dy, hp };

/**
 * Ids 1 to 5: 1 at P; 2 (40 away), 3 (70) and 5 (90) within 100 of it; 4 (150) outside.
 */
const FIXTURE: readonly PlacedEnemy[] = [at(0, 0), at(40, 0), at(0, 70), at(150, 0), at(-90, 0)];

/** The first data trigger's index, after SHATTER_TRIGGER. */
const FIRST = SHATTER_TRIGGER + 1;

const NO_ROLLS = { critChance: 0, igniteChance: 0, projectileCount: 1, burnMaxStacks: 5 };

/** The fixture with these center triggers; `values` over NO_ROLLS. */
function fixture(
  triggers: readonly TriggerSpec[],
  options: {
    values?: Partial<Record<StatId, number>>;
    mods?: readonly Modifier[];
    rules?: readonly RuleSpec[];
    modules?: readonly TestModule[];
    placed?: readonly PlacedEnemy[];
  } = {},
): RunContext {
  return placedEnemies(options.placed ?? FIXTURE, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, options.mods, centerTriggers(triggers)),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** An emitter hit (depth 0, no origin) of the signature attack on `target`. */
const emitterHit = (ctx: RunContext, target: Enemy): void =>
  hitWithPayload(
    ctx,
    target,
    (ctx.emitters[0] as EmitterRuntime).payload,
    0,
    1,
    null,
    null,
    false,
    0,
    -1,
  );

/** The effect hits among the context's events: target, amount, tags and crit. */
const effectHits = (ctx: RunContext): [number, number, number, boolean][] =>
  eventsOf([ctx.events], 'hit')
    .filter((hit: HitEvent) => (hit.tags & TAG.trigger) !== 0)
    .map((hit) => [hit.targetId, toNumber(hit.amount), hit.tags, hit.crit]);

const detonate = (spec: Omit<DetonateSpec, 'kind'>): DetonateSpec => ({
  kind: 'detonate',
  ...spec,
});

/**
 * Two burns on `target` from tick 1, as records or under eternalFlame in a ring: 6 dps until
 * 200 and 2 dps until 100. Returns what they have left.
 */
function burn(ctx: RunContext, target: Enemy): number {
  applyBurn(ctx, target, num(6), 200, 0, CENTER, 1);
  applyBurn(ctx, target, num(2), 100, 0, CENTER, 1);
  return (6 * 199 + 2 * 99) * DT;
}

/** Fires the hit trigger FIRST on `target` and runs its effects, the events cleared before. */
function fireOn(ctx: RunContext, target: Enemy): void {
  fireOne(ctx, FIRST, 0, -1, target, target.x, target.y, HIT_EVENT, ZERO, -1);
  ctx.events.length = 0;
  runEffectQueue(ctx);
}

const expectRel = (actual: number, expected: number, label = ''): void => {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-12 * Math.abs(expected));
};

describe('detonate on a live target', () => {
  it('deals fraction × damage × what its ailment has left, consumed from it, drawing nothing', () => {
    const ctx = fixture([
      { on: 'hit', do: [detonate({ ailment: 'burn', fraction: 0.5, damage: 3 })] },
    ]);
    const target = enemy(ctx, 1);
    const left = burn(ctx, target);
    const start = rngPositions(ctx);
    fireOn(ctx, target);
    expect(rngPositions(ctx)).toEqual(start);
    const [hit, ...rest] = effectHits(ctx);
    expect(rest).toEqual([]);
    expect(hit?.[0]).toBe(1);
    expectRel(hit?.[1] as number, 3 * 0.5 * left, 'amount');
    // Its tags are the ailment's and trigger: no hit, no crit, no area.
    expect([hit?.[2], hit?.[3]]).toEqual([TAG.burn | TAG.trigger, false]);
    expectRel(toNumber(remainingOf(ctx, target, 'burn')), 0.5 * left, 'kept');
    expect(liveBurnStacks(target, ctx.now)).toBe(2);
    // Credited as burn damage, to the trigger's source.
    expectRel(toNumber(ctx.damageBurn), 3 * 0.5 * left, 'tally');
    expect(toNumber(ctx.damageHit)).toBe(0);
  });

  it('takes it all by default, dealing it once', () => {
    const ctx = fixture([{ on: 'hit', do: [detonate({ ailment: 'burn' })] }]);
    const target = enemy(ctx, 1);
    const left = burn(ctx, target);
    fireOn(ctx, target);
    const hits = effectHits(ctx);
    expect(hits).toHaveLength(1);
    expectRel(hits[0]?.[1] as number, left);
    expect(target.burns).toHaveLength(0);
    expect(liveBurnStacks(target, ctx.now)).toBe(0);
    // Nothing left: a second detonate deals nothing and raises no hit.
    fireOn(ctx, target);
    expect(effectHits(ctx)).toEqual([]);
  });

  it('skips the damage rows (PRESCALED), while takenMult still scales it', () => {
    const amountWith = (values: Partial<Record<StatId, number>>, mods: Modifier[]): number => {
      const ctx = fixture([{ on: 'hit', do: [detonate({ ailment: 'burn', damage: 2 })] }], {
        values,
        mods,
      });
      const target = enemy(ctx, 1);
      burn(ctx, target);
      fireOn(ctx, target);
      return effectHits(ctx)[0]?.[1] as number;
    };
    const plain = amountWith({}, []);
    expectRel(plain, 2 * (6 * 199 + 2 * 99) * DT);
    const rows: Modifier[] = [
      { stat: 'damage', kind: 'increased', value: 5 },
      { stat: 'damage', kind: 'more', value: 9, tags: ['burn'] },
      { stat: 'damage', kind: 'more', value: 9, tags: ['trigger'] },
    ];
    expect(amountWith({ damage: 1e6, critChance: 1, burnDamage: 7 }, rows)).toBe(plain);

    // A frozen target takes more, as from any hit.
    const ctx = fixture([{ on: 'hit', do: [detonate({ ailment: 'burn', damage: 2 })] }], {
      values: { frozenDamageTaken: 0.5 },
    });
    const target = enemy(ctx, 1);
    burn(ctx, target);
    target.frozenUntil = 1000;
    const mult = takenMult(ctx, target);
    expect(mult).toBeGreaterThan(1);
    fireOn(ctx, target);
    expectRel(effectHits(ctx)[0]?.[1] as number, plain * mult);
  });

  it('reads poison from its rings and bleed from its slot', () => {
    // One trigger: its detonates' hits do not fire it again (rule 3).
    const ctx = fixture([
      {
        on: 'hit',
        do: [
          detonate({ ailment: 'poison', fraction: 0.25 }),
          detonate({ ailment: 'bleed', damage: 4 }),
        ],
      },
    ]);
    const target = enemy(ctx, 1);
    applyPoison(ctx, target, num(3), 121, 0, CENTER, 2);
    addBleed(ctx, target, num(5), 61, 0, CENTER);
    const poison = toNumber(remainingOf(ctx, target, 'poison'));
    const bleed = toNumber(remainingOf(ctx, target, 'bleed'));
    expectRel(poison, 6 * 120 * DT, 'poison');
    expect(bleed).toBeGreaterThan(0);
    fireOn(ctx, target);
    const hits = effectHits(ctx);
    expect(hits.map(([id, , tags]) => [id, tags])).toEqual([
      [1, TAG.poison | TAG.trigger],
      [1, TAG.bleed | TAG.trigger],
    ]);
    expectRel(hits[0]?.[1] as number, 0.25 * poison, 'poison hit');
    expectRel(hits[1]?.[1] as number, 4 * bleed, 'bleed hit');
    expectRel(toNumber(remainingOf(ctx, target, 'poison')), 0.75 * poison, 'poison kept');
    expect([target.bleedUntil, toNumber(remainingOf(ctx, target, 'bleed'))]).toEqual([0, 0]);
    expectRel(toNumber(ctx.damagePoison), 0.25 * poison);
    expectRel(toNumber(ctx.damageBleed), 4 * bleed);
  });

  it('does nothing to a target without the ailment', () => {
    const ctx = fixture([{ on: 'hit', do: [detonate({ ailment: 'burn', radius: 100 })] }]);
    const target = enemy(ctx, 1);
    applyPoison(ctx, target, num(3), 121, 0, CENTER, 1);
    burn(ctx, enemy(ctx, 2));
    fireOn(ctx, target);
    expect(effectHits(ctx)).toEqual([]);
    expect(ctx.counters.effectsRun).toBe(1);
    // Its neighbour's burn is not its own: untouched.
    expectRel(toNumber(remainingOf(ctx, enemy(ctx, 2), 'burn')), (6 * 199 + 2 * 99) * DT);
  });

  it('hits every alive enemy within its radius at the whole amount, area tagged', () => {
    const ctx = fixture([
      { on: 'hit', do: [detonate({ ailment: 'burn', fraction: 0.5, radius: 100 })] },
    ]);
    const target = enemy(ctx, 1);
    const left = burn(ctx, target);
    enemy(ctx, 3).alive = false;
    const start = rngPositions(ctx);
    fireOn(ctx, target);
    expect(rngPositions(ctx)).toEqual(start);
    const hits = effectHits(ctx);
    // In id order: the target too; 3 is dead, 4 is out of range.
    expect(hits.map(([id, , tags]) => [id, tags])).toEqual(
      [1, 2, 5].map((id) => [id, TAG.burn | TAG.trigger | TAG.area]),
    );
    for (const [, amount] of hits) expectRel(amount, 0.5 * left);
    // Only the target's burn is consumed, once.
    expectRel(toNumber(remainingOf(ctx, target, 'burn')), 0.5 * left);
  });

  it('takes maxTargets of them, in id order or nearest first', () => {
    const run = (order: 'id' | 'nearest' | undefined): number[] => {
      const spec = detonate({ ailment: 'burn', radius: 100, maxTargets: 2 });
      const ctx = fixture([{ on: 'hit', do: [order === undefined ? spec : { ...spec, order }] }], {
        placed: [at(0, 0), at(95, 0), at(0, 70), at(0, 100), at(-20, 70)],
      });
      // Around its target 3: 1 (70 away), 4 (30) and 5 (20) are within 100; 2 (118) is not.
      burn(ctx, enemy(ctx, 3));
      fireOn(ctx, enemy(ctx, 3));
      return effectHits(ctx).map(([id]) => id);
    };
    expect(run(undefined)).toEqual([1, 3]);
    expect(run('id')).toEqual([1, 3]);
    expect(run('nearest')).toEqual([3, 5]);
  });

  it('centers its radius on the enemy its selector picked, not the event point', () => {
    // 1 fires; its selector picks 2, 100 away, whose radius of 50 holds 2 alone.
    const ctx = fixture(
      [
        {
          on: 'hit',
          target: { pick: 'nearest', excludeEventTarget: true },
          do: [detonate({ ailment: 'burn', radius: 50 })],
        },
      ],
      { placed: [at(0, 0), at(100, 0), at(200, 0)] },
    );
    const [fired, picked] = [enemy(ctx, 1), enemy(ctx, 2)];
    const left = burn(ctx, picked);
    burn(ctx, fired);
    fireOn(ctx, fired);
    const hits = effectHits(ctx);
    expect(hits.map(([id]) => id)).toEqual([2]);
    expectRel(hits[0]?.[1] as number, left, 'hit');
    // The picked enemy's burn is the one consumed; the event's enemy keeps its own.
    expect(toNumber(remainingOf(ctx, picked, 'burn'))).toBe(0);
    expectRel(toNumber(remainingOf(ctx, fired, 'burn')), left, 'kept');
  });

  it('hits at its entry’s depth and origin, with a radius or without', () => {
    const killed = (radius?: number): number[][] => {
      const kills: number[][] = [];
      const log: TestModule = (b) =>
        b.hook('onKill', (_ctx, victim, kill) => {
          kills.push([victim.id, kill.depth, kill.origin]);
        });
      const spec = detonate(
        radius === undefined ? { ailment: 'burn' } : { ailment: 'burn', radius },
      );
      const ctx = fixture([{ on: 'hit', do: [spec] }], {
        modules: [log],
        placed: [at(0, 0, 1), at(40, 0, 1)],
      });
      const target = enemy(ctx, 1);
      burn(ctx, target);
      // Fired at depth 1: its effects run at 2, with FIRST as their origin.
      fireOne(ctx, FIRST, 1, -1, target, target.x, target.y, HIT_EVENT, ZERO, -1);
      runEffectQueue(ctx);
      return kills;
    };
    expect(killed()).toEqual([[1, 2, FIRST]]);
    expect(killed(100)).toEqual([
      [1, 2, FIRST],
      [2, 2, FIRST],
    ]);
  });

  it('kills by hit, and never fires its own trigger on its kills (rule 3)', () => {
    const kills: [number, number, number][] = [];
    const log: TestModule = (b) =>
      b.hook('onKill', (_ctx, victim, kill) => {
        kills.push([victim.id, kill.origin, victim.killKind]);
      });
    // 2 and 3 are within 100 of 1; 4 is 120 from 1 but 80 from 2.
    const ctx = fixture(
      [
        {
          on: 'kill',
          when: [{ victimHas: 'burn' }],
          do: [detonate({ ailment: 'burn', radius: 100 })],
        },
        { on: 'hit', do: [detonate({ ailment: 'burn', radius: 100 })] },
      ],
      { modules: [log], placed: [at(0, 0), at(40, 0, 1), at(0, 70, 1), at(120, 0, 1)] },
    );
    const target = enemy(ctx, 1);
    burn(ctx, target);
    for (const id of [2, 3, 4]) addBurn(ctx, enemy(ctx, id), num(1), 100, 0, CENTER);
    fireOne(ctx, FIRST + 1, 0, -1, target, target.x, target.y, HIT_EVENT, ZERO, -1);
    runEffectQueue(ctx);
    // 2 and 3 die to the hit trigger's detonate, by hit; their kills record the kill trigger,
    // carrying what each had left.
    expect(kills).toEqual([
      [2, FIRST + 1, KILL_BY_HIT],
      [3, FIRST + 1, KILL_BY_HIT],
    ]);
    const pending = ctx.pendingKills.slice(0, ctx.pendingCount);
    expect(pending.map((p) => [p.victim.id, p.trigger, p.origin])).toEqual([
      [2, FIRST, FIRST + 1],
      [3, FIRST, FIRST + 1],
    ]);
    for (const p of pending) expectRel(toNumber(p.value), 99 * DT);
    // 2's detonate hits 1 and kills 4; 3's hits 1. 4's kill, by the kill trigger, records none
    // of it.
    dispatchPendingKills(ctx);
    ctx.events.length = 0;
    runEffectQueue(ctx);
    expect(effectHits(ctx).map(([id]) => id)).toEqual([1, 4, 1]);
    expect(kills[2]).toEqual([4, FIRST, KILL_BY_HIT]);
    expect(ctx.pendingCount).toBe(0);
  });
});

describe('detonate on a kill (焚屍)', () => {
  const corpse: TriggerSpec = {
    on: 'kill',
    when: [{ victimHas: 'burn' }],
    do: [detonate({ ailment: 'burn', fraction: 0.5, damage: 2, radius: 100 })],
  };

  it.each([
    ['records', []],
    ['rings', [{ id: 'eternalFlame', durationMore: 0 }]],
  ] as const)(
    'carries what the victim had left (%s), read before its ailments go back',
    (_label, rules) => {
      const ctx = fixture([corpse], { rules, placed: [at(0, 0, 1), at(40, 0), at(150, 0)] });
      const victim = enemy(ctx, 1);
      burn(ctx, victim);
      const left = toNumber(remainingOf(ctx, victim, 'burn'));
      expectRel(left, (6 * 199 + 2 * 99) * DT, 'left');
      expect(ctx.rings.live).toBe(ctx.burnRings ? 1 : 0);
      emitterHit(ctx, victim);
      expect(victim.alive).toBe(false);
      // The victim's ring is back in the pool; its pending kill keeps the value.
      expect(ctx.rings.live).toBe(0);
      const [entry] = ctx.pendingKills.slice(0, ctx.pendingCount);
      expect(entry?.trigger).toBe(FIRST);
      expectRel(toNumber(entry?.value as Num), left, 'value');
      dispatchPendingKills(ctx);
      ctx.now++;
      ctx.events.length = 0;
      runEffectQueue(ctx);
      // At the victim's point: 2 takes 2 × 0.5 × left; 3 is out of range.
      const hits = effectHits(ctx);
      expect(hits.map(([id, , tags]) => [id, tags])).toEqual([
        [2, TAG.burn | TAG.trigger | TAG.area],
      ]);
      expectRel(hits[0]?.[1] as number, 2 * 0.5 * left, 'hit');
    },
  );

  it('counts a burn kill’s value from the step that killed it, not twice', () => {
    const ctx = fixture([corpse], { placed: [at(0, 0), at(40, 0)] });
    const victim = enemy(ctx, 1);
    burn(ctx, victim);
    while (ctx.now < 29) {
      ctx.now++;
      updateAilments(ctx);
    }
    victim.hp = num(1);
    ctx.now = 30;
    updateAilments(ctx);
    expect([victim.alive, victim.killKind]).toEqual([false, KILL_BY_BURN]);
    const [entry] = ctx.pendingKills.slice(0, ctx.pendingCount);
    expectRel(toNumber(entry?.value as Num), (6 * 170 + 2 * 70) * DT, 'value');
  });

  it('counts a bleed kill’s value from the step that killed it, not twice', () => {
    // The victim's own bleed step kills it: that step is dealt, the rest of the bleed is not.
    const ctx = fixture(
      [
        {
          on: 'kill',
          when: [{ victimHas: 'bleed' }],
          do: [detonate({ ailment: 'bleed', radius: 100 })],
        },
      ],
      { values: { bleedStationaryMult: 2 }, placed: [at(0, 0), at(40, 0)] },
    );
    const victim = enemy(ctx, 1);
    addBleed(ctx, victim, num(4), 200, 0, CENTER);
    while (ctx.now < 29) {
      ctx.now++;
      updateAilments(ctx);
    }
    victim.hp = num(1);
    ctx.now = 30;
    updateAilments(ctx);
    expect([victim.alive, victim.killKind]).toEqual([false, KILL_BY_BLEED]);
    const [entry] = ctx.pendingKills.slice(0, ctx.pendingCount);
    expect(entry?.trigger).toBe(FIRST);
    // Ticks 31–200, standing (dead) at × 2.
    expectRel(toNumber(entry?.value as Num), 4 * 170 * DT * 2, 'value');
  });

  /** 焚屍 on bleed: all the bleed a victim had left, around it. */
  const bleedCorpse: TriggerSpec = {
    on: 'kill',
    when: [{ victimHas: 'bleed' }],
    do: [detonate({ ailment: 'bleed', radius: 100 })],
  };

  it.each([
    ['burn', KILL_BY_BURN],
    ['poison', KILL_BY_POISON],
  ] as const)(
    'counts the step’s bleed in a bleed kill’s value when its %s step kills it first (Q7/F1)',
    (ailment, kind) => {
      // A step deals burn, poison, then bleed: a victim its burn or poison step kills never takes
      // that step's bleed, which its value still counts (Hoshi's Q7/F1).
      const ctx = fixture([bleedCorpse], { placed: [at(0, 0), at(40, 0)] });
      const victim = enemy(ctx, 1);
      addBleed(ctx, victim, num(10), 200, 0, CENTER);
      if (ailment === 'burn') burn(ctx, victim);
      else applyPoison(ctx, victim, num(3), 121, 0, CENTER, 2);
      while (ctx.now < 29) {
        ctx.now++;
        updateAilments(ctx);
      }
      victim.hp = num(0.01);
      ctx.now = 30;
      updateAilments(ctx);
      expect([victim.alive, victim.killKind]).toEqual([false, kind]);
      // Dealt at 15 (ticks 2–15); left: ticks 16–30, which its step never dealt, and 31–200.
      const bled = eventsOf([ctx.events], 'dotTick')
        .filter((tick) => tick.ailment === 'bleed')
        .reduce((sum, tick) => sum + toNumber(tick.amount), 0);
      expectRel(bled, 10 * 14 * DT, 'bled');
      const [entry] = ctx.pendingKills.slice(0, ctx.pendingCount);
      expect(entry?.trigger).toBe(FIRST);
      const value = toNumber(entry?.value as Num);
      expectRel(value, 10 * 185 * DT, 'value');
      expect(value).toBeCloseTo(30.83, 2); // not 28.33, ticks 31–200 alone
      expectRel(bled + value, 10 * 199 * DT, 'bled + left');
      dispatchPendingKills(ctx);
      ctx.now++;
      ctx.events.length = 0;
      runEffectQueue(ctx);
      const hits = effectHits(ctx);
      expect(hits.map(([id, , tags]) => [id, tags])).toEqual([
        [2, TAG.bleed | TAG.trigger | TAG.area],
      ]);
      expectRel(hits[0]?.[1] as number, value, 'hit');
    },
  );

  it('counts a replaced bleed’s pending with the step’s bleed when its burn step kills it (Q7/F1)', () => {
    const ctx = fixture([bleedCorpse], { placed: [at(0, 0), at(40, 0)] });
    const victim = enemy(ctx, 1);
    addBleed(ctx, victim, num(4), 200, 0, CENTER);
    burn(ctx, victim);
    while (ctx.now < 20) {
      ctx.now++;
      updateAilments(ctx);
    }
    // A stronger bleed takes the slot at 20: the first one's ticks 16–20 wait, pending.
    expect(addBleed(ctx, victim, num(10), 200, 0, CENTER)).toBe(true);
    expectRel(toNumber(victim.bleedPending), 4 * 5 * DT, 'pending');
    while (ctx.now < 29) {
      ctx.now++;
      updateAilments(ctx);
    }
    victim.hp = num(0.01);
    ctx.now = 30;
    updateAilments(ctx);
    expect([victim.alive, victim.killKind]).toEqual([false, KILL_BY_BURN]);
    // Left: the pending ticks 16–20 at 4, then 21–30, which its step never dealt, and 31–200 at 10.
    const [entry] = ctx.pendingKills.slice(0, ctx.pendingCount);
    expectRel(toNumber(entry?.value as Num), (4 * 5 + 10 * 10 + 10 * 170) * DT, 'value');
  });

  it('reads a hit kill’s bleed from the victim’s last step, before or after its step', () => {
    // Emitter hits come before their tick's step, effects after it; Q7/F1 changes neither.
    for (const [stepped, left] of [
      [false, 185],
      [true, 170],
    ] as const) {
      const ctx = fixture([bleedCorpse], { placed: [at(0, 0), at(40, 0)] });
      const victim = enemy(ctx, 1);
      addBleed(ctx, victim, num(10), 200, 0, CENTER);
      burn(ctx, victim);
      while (ctx.now < 29) {
        ctx.now++;
        updateAilments(ctx);
      }
      ctx.now = 30;
      if (stepped) updateAilments(ctx);
      victim.hp = num(0.01);
      emitterHit(ctx, victim);
      expect([victim.alive, victim.killKind], `stepped ${stepped}`).toEqual([false, KILL_BY_HIT]);
      const [entry] = ctx.pendingKills.slice(0, ctx.pendingCount);
      expectRel(toNumber(entry?.value as Num), 10 * left * DT, `stepped ${stepped}`);
    }
  });

  it('carries the remaining of its own ailment: poison or bleed, not the burn beside it', () => {
    const ctx = fixture(
      [
        {
          on: 'kill',
          when: [{ victimHas: 'poison' }],
          do: [detonate({ ailment: 'poison', radius: 100 })],
        },
        {
          on: 'diedWithAilment',
          when: [{ victimHas: 'bleed' }],
          do: [detonate({ ailment: 'bleed', radius: 100 })],
        },
      ],
      { placed: [at(0, 0, 1), at(40, 0)] },
    );
    const victim = enemy(ctx, 1);
    const burnt = burn(ctx, victim);
    applyPoison(ctx, victim, num(3), 121, 0, CENTER, 2);
    addBleed(ctx, victim, num(5), 61, 0, CENTER);
    const poison = toNumber(remainingOf(ctx, victim, 'poison'));
    const bleed = toNumber(remainingOf(ctx, victim, 'bleed'));
    expect(new Set([burnt, poison, bleed]).size).toBe(3);
    emitterHit(ctx, victim);
    const pending = ctx.pendingKills.slice(0, ctx.pendingCount);
    const valueOf = (trigger: number): number =>
      toNumber(pending.find((p) => p.trigger === trigger)?.value as Num);
    expectRel(valueOf(FIRST), poison, 'poison');
    expectRel(valueOf(FIRST + 1), bleed, 'bleed');
  });

  it('carries 0 for a victim with none of it, whose detonate then deals nothing', () => {
    // Unvalidated: no victimHas, so a victim without burn records its pending kill.
    const ctx = fixture([{ on: 'kill', do: [detonate({ ailment: 'burn', radius: 100 })] }], {
      placed: [at(0, 0, 1), at(40, 0)],
    });
    const victim = enemy(ctx, 1);
    applyPoison(ctx, victim, num(3), 121, 0, CENTER, 1);
    emitterHit(ctx, victim);
    const [entry] = ctx.pendingKills.slice(0, ctx.pendingCount);
    expect([entry?.trigger, entry?.value]).toEqual([FIRST, ZERO]);
    dispatchPendingKills(ctx);
    ctx.now++;
    ctx.events.length = 0;
    runEffectQueue(ctx);
    expect([ctx.counters.effectsRun, effectHits(ctx)]).toEqual([1, []]);
    // A kill trigger without a detonate carries 0 too, burn or not.
    const plain = fixture([{ on: 'kill', do: [{ kind: 'heal', lifePct: 0.01 }] }], {
      placed: [at(0, 0, 1)],
    });
    burn(plain, enemy(plain, 1));
    emitterHit(plain, enemy(plain, 1));
    expect(plain.pendingKills[0]?.value).toEqual(ZERO);
  });

  it('keeps gainShards’ drop, the shatter’s max life, and a shatter trigger’s value', () => {
    const shards: EffectSpec = { kind: 'gainShards', fraction: 0.5 };
    const ctx = fixture(
      [
        { on: 'kill', do: [shards] },
        corpse,
        {
          on: 'shatter',
          when: [{ victimHas: 'burn' }],
          do: [detonate({ ailment: 'burn', radius: 100 })],
        },
      ],
      { values: { frostOnHit: 0.1 }, placed: [at(0, 0, 1), at(40, 0)] },
    );
    const victim = enemy(ctx, 1);
    burn(ctx, victim);
    ctx.now = 5;
    const left = toNumber(remainingOf(ctx, victim, 'burn'));
    addFrost(ctx, victim, 1, CENTER);
    expect(victim.frozenUntil).toBeGreaterThan(ctx.now);
    const maxHp = victim.maxHp;
    emitterHit(ctx, victim);
    const drop = eventsOf([ctx.events], 'enemyKilled')[0]?.shards ?? ZERO;
    expect(toNumber(drop)).toBeGreaterThan(0);
    const pending = ctx.pendingKills.slice(0, ctx.pendingCount);
    const [onShatter] = ctx.build.triggersOn[EVENT.shatter] as Int32Array;
    // The shatter first, with the shatter triggers, then the kill triggers.
    expect(pending.map((p) => p.trigger)).toEqual([SHATTER_TRIGGER, onShatter, FIRST, FIRST + 1]);
    expect(pending[0]?.value).toEqual(maxHp);
    expectRel(toNumber(pending[1]?.value as Num), left, 'shatter');
    expect(pending[2]?.value).toEqual(drop);
    expectRel(toNumber(pending[3]?.value as Num), left, 'kill');
    const triggers = ctx.build.triggers as readonly CompiledTrigger[];
    expect(
      [FIRST, FIRST + 1, onShatter as number].map((i) => triggers[i]?.detonateAilment),
    ).toEqual([-1, 0, 0]);
  });
});

describe('detonate fanned out', () => {
  it('detonates each alive enemy of a freeze list on its own ailment', () => {
    const ctx = fixture([{ on: 'freeze', do: [detonate({ ailment: 'poison', fraction: 0.5 })] }]);
    const t = ctx.build.triggers[FIRST] as CompiledTrigger;
    expect((ctx.build.effects[t.effectStart] as { fanout: boolean }).fanout).toBe(true);
    // 1, 2 and 5 are poisoned, with different amounts; 3 is not.
    const amounts = new Map([
      [1, 1],
      [2, 2],
      [5, 4],
    ]);
    for (const [id, dps] of amounts) applyPoison(ctx, enemy(ctx, id), num(dps), 61, 0, CENTER, 1);
    raiseFreeze(ctx, enemy(ctx, 1), 0, -1, 0);
    ctx.events.length = 0;
    runEffectQueue(ctx);
    const hits = effectHits(ctx);
    expect(hits.map(([id]) => id)).toEqual([1, 2, 5]);
    for (const [id, amount] of hits) {
      expectRel(amount, 0.5 * (amounts.get(id) as number) * 60 * DT, `enemy ${id}`);
    }
  });
});

describe("stacksAtLeast 'max'", () => {
  /** How many of `stacks` hits on a target holding `stacks` burns fire the 'max' trigger. */
  function firesAt(
    values: Partial<Record<StatId, number>>,
    rules: readonly RuleSpec[] = [],
  ): number | null {
    const ctx = fixture(
      [
        {
          on: 'hit',
          when: [{ stacksAtLeast: { ailment: 'burn', stacks: 'max' } }],
          do: [{ kind: 'heal', lifePct: 0.01 }],
        },
      ],
      { values, rules },
    );
    const target = enemy(ctx, 1);
    for (let n = 1; n <= 8; n++) {
      applyBurn(ctx, target, num(1), 500, 0, CENTER, 1);
      const before = ctx.effectQueue.size;
      fireOne(ctx, FIRST, 0, -1, target, target.x, target.y, HIT_EVENT, ZERO, -1);
      if (ctx.effectQueue.size > before) return liveBurnStacks(target, ctx.now);
    }
    return null;
  }

  it('is the records cap, max(1, floor(burnMaxStacks)), on a trigger', () => {
    expect(firesAt({ burnMaxStacks: 3.7 })).toBe(3);
    expect(firesAt({ burnMaxStacks: 5 })).toBe(5);
    expect(firesAt({ burnMaxStacks: 0 })).toBe(1);
  });

  it('is 5 under eternalFlame, whatever burnMaxStacks adds (F1)', () => {
    const flame = [{ id: 'eternalFlame', durationMore: 0 }] as const;
    expect(firesAt({ burnMaxStacks: 5 + 3 }, flame)).toBe(5);
    expect(firesAt({ burnMaxStacks: 1 }, flame)).toBe(5);
  });

  it('compares shock with max(1, shockCap)', () => {
    const fires = (shockMaxStacks: number, stacks: number): boolean => {
      const ctx = fixture(
        [
          {
            on: 'hit',
            when: [{ stacksAtLeast: { ailment: 'shock', stacks: 'max' } }],
            do: [{ kind: 'heal', lifePct: 0.01 }],
          },
        ],
        { values: { shockMaxStacks, shockDuration: 2 } },
      );
      const target = enemy(ctx, 1);
      target.shockStacks = stacks;
      target.shockUntil = stacks > 0 ? 100 : 0;
      fireOne(ctx, FIRST, 0, -1, target, target.x, target.y, HIT_EVENT, ZERO, -1);
      return ctx.effectQueue.size > 0;
    };
    expect([fires(3, 2), fires(3, 3)]).toEqual([false, true]);
    // A cap of 0 still asks for one stack.
    expect([fires(0, 0), fires(0, 1)]).toEqual([false, true]);
  });

  it('holds on a modifier’s condition in a run, read through its eval input', () => {
    const more: Modifier = {
      stat: 'damage',
      kind: 'more',
      value: 1,
      when: [{ stacksAtLeast: { ailment: 'burn', stacks: 'max' } }],
    };
    const ctx = fixture([], { values: { burnMaxStacks: 2 }, mods: [more] });
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    addBurn(ctx, one, num(1), 500, 0, CENTER);
    for (let s = 0; s < 2; s++) addBurn(ctx, two, num(1), 500, 0, CENTER);
    expect(ctx.evalInput.ctx).toBe(ctx);
    emitterHit(ctx, one);
    emitterHit(ctx, two);
    const [a, b] = eventsOf([ctx.events], 'hit').map((hit) => toNumber(hit.amount));
    expectRel(b as number, 2 * (a as number));
  });

  it('holds on a shatter’s bounded bonus too, read through its eval input', () => {
    const more: Modifier = {
      stat: 'damage',
      kind: 'more',
      value: 1,
      scope: 'center',
      when: [{ stacksAtLeast: { ailment: 'burn', stacks: 'max' } }],
    };
    /** The shatter hit on 2, 40 from the frozen victim 1, while 2 holds `stacks` burns. */
    const shatterOn = (stacks: number): number => {
      const ctx = fixture([], {
        values: { burnMaxStacks: 2, frostOnHit: 0.1 },
        mods: [more],
        placed: [at(0, 0, 1), at(40, 0)],
      });
      const [victim, inside] = [enemy(ctx, 1), enemy(ctx, 2)];
      for (let s = 0; s < stacks; s++) addBurn(ctx, inside, num(1), 500, 0, CENTER);
      ctx.now = 5;
      addFrost(ctx, victim, 1, CENTER);
      emitterHit(ctx, victim);
      expect(victim.alive).toBe(false);
      dispatchPendingKills(ctx);
      ctx.now++;
      ctx.events.length = 0;
      runEffectQueue(ctx);
      const hits = eventsOf([ctx.events], 'hit').filter((hit) => hit.targetId === 2);
      expect(hits).toHaveLength(1);
      return toNumber((hits[0] as HitEvent).amount);
    };
    expectRel(shatterOn(2), 2 * shatterOn(1));
  });
});

describe('compiling a detonate', () => {
  it('fans out without a radius, tags its ailment and trigger (+ area), deals base 1', () => {
    const compiled = [
      detonate({ ailment: 'burn' }),
      detonate({ ailment: 'poison', radius: 60 }),
      detonate({ ailment: 'bleed', damage: 3 }),
    ].map((spec) => compileEffect(spec, 0, 1, 10));
    expect(compiled.map((fx) => [fx.fanout, fx.tags, fx.radiusSq, fx.baseDamage])).toEqual([
      [true, TAG.burn | TAG.trigger, 0, ONE],
      [false, TAG.poison | TAG.trigger | TAG.area, 3600, ONE],
      [true, TAG.bleed | TAG.trigger, 0, ONE],
    ]);
    // A calibration coefficient scales its damage, 1 when left out.
    const scaled = [detonate({ ailment: 'burn' }), detonate({ ailment: 'burn', damage: 3 })].map(
      (spec) => compileEffect(spec, 0, 0.5, 10).spec as DetonateSpec,
    );
    expect(scaled.map((spec) => spec.damage)).toEqual([0.5, 1.5]);
  });

  it('gives a dead enemy’s trigger the ordinal of its detonate’s ailment, every other −1', () => {
    const ordinal = (spec: TriggerSpec): number => compileTrigger(1, spec, 0, 1, 0).detonateAilment;
    const poison = detonate({ ailment: 'poison', radius: 50 });
    const held = [{ victimHas: 'poison' }] as const;
    expect(DETONATE_AILMENTS).toEqual(['burn', 'poison', 'bleed']);
    expect(
      [
        { on: 'kill', when: held, do: [poison] },
        { on: 'diedWithAilment', when: held, do: [{ kind: 'heal', lifePct: 0.1 }, poison] },
        { on: 'shatter', when: held, do: [poison] },
        { on: 'kill', when: [{ victimHas: 'bleed' }], do: [{ ...poison, ailment: 'bleed' }] },
        // A live target's detonate reads it at its run: no value to carry.
        { on: 'hit', do: [poison] },
        { on: 'kill', do: [{ kind: 'gainShards', fraction: 1 }] },
      ].map((spec) => ordinal(spec as TriggerSpec)),
    ).toEqual([1, 1, 1, 2, -1, -1]);
    expect([moduleTrigger(3, 0), shatterTrigger(true, 4)].map((t) => t.detonateAilment)).toEqual([
      -1, -1,
    ]);
  });

  it('builds every CompiledTrigger with its members in one order (N24)', () => {
    const keys = Object.keys(
      compileTrigger(1, { on: 'kill', do: [{ kind: 'heal', lifePct: 0.1 }] }, 0, 1, 0),
    );
    // C4.20 appends perAttackCap after C4.10's detonateAilment: 18 members.
    expect([keys.length, ...keys.slice(-2)]).toEqual([18, 'detonateAilment', 'perAttackCap']);
    expect(Object.keys(moduleTrigger(3, 0))).toEqual(keys);
    expect(Object.keys(shatterTrigger(true, 4))).toEqual(keys);
    expect(Object.keys(shatterTrigger(false, 0))).toEqual(keys);
  });
});
