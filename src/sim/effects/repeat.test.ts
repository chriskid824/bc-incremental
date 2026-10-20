/**
 * Repeats of the signature attack (repeatAttack, rule 7; docs/v3 C4 design D23, §4.15): the
 * executor, its payloads and the charges that wait for the next attack, on M1's volley. The
 * lob's repeats are tested with the lob (src/sim/emitters/lob.test.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import { toNumber, ZERO } from '../../core/num';
import { createStreams } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { RuleSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { REPEAT_CHARGE_CAP } from '../caps';
import { fireFanRepeat } from '../emitters/fan';
import { fireLobRepeat } from '../emitters/lob';
import type { EmitterRuntime, Payload } from '../emitters/types';
import { fireVolleyRepeat, runVolley } from '../emitters/volley';
import type { TestModule } from '../rules';
import type { Projectile, RunContext } from '../systems/context';
import { compact } from '../systems/death';
import { moveProjectiles } from '../systems/projectiles';
import { centerTriggers, eventsOf, makeStats, placedEnemies, rngPositions } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { fire } from './dispatch';
import { drainRepeatCharges, REPEAT_STEPS, runEffect, runEffectQueue } from './execute';
import { HIT_EVENT, PRIMARY, REPEAT, SIGNATURE } from './flags';
import { createEffectEntry } from './queue';
import { compileEffect, EVENT } from './types';
import type { CompiledTrigger } from './types';

const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/**
 * `n` standing enemies on a ring of 300 around the player, ids 1 .. n. A repeat's extra
 * projectiles skip the enemies its volley already targets (shootableInVolley), the last counted
 * attack's included, as it takes no volley serial of its own: enough of them that no
 * projectile goes without a target.
 */
const ring = (n: number): PlacedEnemy[] =>
  Array.from({ length: n }, (_, i) => ({
    x: P.x + 300 * Math.cos((2 * Math.PI * i) / n),
    y: P.y + 300 * Math.sin((2 * Math.PI * i) / n),
  }));
const THREE: readonly PlacedEnemy[] = ring(3);
const MANY: readonly PlacedEnemy[] = ring(48);

/** A repeatAttack effect. */
const repeat = (count: number, damagePct: number, timing?: 'now' | 'nextAttack'): EffectSpec => ({
  kind: 'repeatAttack',
  count,
  damagePct,
  ...(timing === undefined ? {} : { timing }),
});

/** A trigger that never fires in these tests, so its effects run only where a test runs them. */
const idle = (...effects: EffectSpec[]): TriggerSpec => ({
  on: 'periodic',
  every: 1000,
  do: effects,
});

interface VolleyOptions {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
}

/**
 * placedEnemies with M1's volley: one projectile an attack unless `values` say so, no crits,
 * ignites or chains, and projectiles fast enough to land on their first step.
 */
const volley = (placed: readonly PlacedEnemy[], options: VolleyOptions = {}): RunContext =>
  placedEnemies(placed, {
    stats: makeStats(
      {
        critChance: 0,
        igniteChance: 0,
        chainCount: 0,
        projectileCount: 1,
        projectileSpeed: 120_000,
        ...options.values,
      },
      [],
      centerTriggers(options.triggers ?? []),
    ),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
  });

const signature = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;

/** The index of the n-th repeatAttack effect of the build (0: the first). */
function repeatEffect(ctx: RunContext, n = 0): number {
  const found = ctx.build.effects.flatMap((fx, i) => (fx.kind === 'repeatAttack' ? [i] : []));
  const effect = found[n];
  if (effect === undefined) throw new Error(`no repeatAttack effect ${n}`);
  return effect;
}

/** The trigger whose effects include effect `effect`. */
function triggerOf(ctx: RunContext, effect: number): number {
  const t = ctx.build.triggers.find((t) => t.effectStart <= effect && effect < t.effectEnd);
  if (t === undefined) throw new Error(`no trigger of effect ${effect}`);
  return t.index;
}

/** The repeat payload of the n-th repeatAttack effect. */
const repeatPayload = (ctx: RunContext, n = 0): Payload =>
  ctx.sys.repeat.payloads[repeatEffect(ctx, n)] as Payload;

/**
 * Runs the n-th repeatAttack effect as its trigger would queue it: at `depth`, from its trigger
 * (or `origin`), on an event of `flags` at the player.
 */
function runRepeat(
  ctx: RunContext,
  n = 0,
  depth = 1,
  flags = SIGNATURE | HIT_EVENT,
  origin?: number,
): void {
  const entry = createEffectEntry();
  entry.effect = repeatEffect(ctx, n);
  entry.depth = depth;
  entry.origin = origin ?? triggerOf(ctx, entry.effect);
  entry.flags = flags;
  entry.x = P.x;
  entry.y = P.y;
  runEffect(ctx, entry);
}

/** Makes one attack of the volley due and runs the volley, which fires it. */
function attack(ctx: RunContext): void {
  const em = signature(ctx);
  em.acc = em.interval - em.cadence;
  runVolley(ctx, em);
}

/** The projectiles fired since `from` (an index of ctx.projectiles). */
const firedSince = (ctx: RunContext, from: number): Projectile[] => ctx.projectiles.slice(from);

/** Lands every projectile in flight (they arrive on their first step) and clears them. */
function land(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  moveProjectiles(ctx);
  compact(ctx);
  return [...ctx.events];
}

/** Advances `twin` until it stands where `rng` does; throws when it never does. */
function sync(twin: Rng, rng: Rng): void {
  for (let n = 0; n < 10_000; n++) {
    if (String(twin.snapshot()) === String(rng.snapshot())) return;
    twin.next();
  }
  throw new Error('the twin stream never meets the run’s');
}

/** What a counted attack keeps count of on the emitter. */
const counts = (em: EmitterRuntime) => ({
  attacks: em.attacks,
  shots: em.shots,
  volley: em.volley,
  acc: em.acc,
  steadyAttack: em.steadyAttack,
});

describe('repeat payloads (D23, K7)', () => {
  it('builds one per repeatAttack effect: the signature’s at damagePct, effects stream, SIGNATURE | REPEAT, its rows', () => {
    const ctx = volley([], {
      triggers: [
        idle({ kind: 'heal', lifePct: 0.1 }, repeat(1, 0.5)),
        idle(repeat(2, 0.25, 'nextAttack')),
      ],
    });
    const sig = signature(ctx).payload;
    const payloads = ctx.sys.repeat.payloads;
    expect(payloads).toHaveLength(ctx.build.effects.length);
    const kinds = ctx.build.effects.map((fx) => fx.kind);
    payloads.forEach((p, i) => expect(p === null, kinds[i]).toBe(kinds[i] !== 'repeatAttack'));
    const half = repeatPayload(ctx, 0);
    const quarter = repeatPayload(ctx, 1);
    expect(half).not.toBe(quarter);
    for (const [p, share] of [
      [half, 0.5],
      [quarter, 0.25],
    ] as const) {
      expect(p).toMatchObject({
        tags: sig.tags,
        source: sig.source,
        jumpSource: sig.jumpSource,
        flags: SIGNATURE | REPEAT,
        chains: sig.chains,
        rollsAilments: sig.rollsAilments,
        canCrit: sig.canCrit,
        damageMode: sig.damageMode,
        zoneVariant: null,
        aggregate: false,
      });
      expect(toNumber(p.baseDamage)).toBe(toNumber(sig.baseDamage) * share);
      expect(p.rng).toBe(ctx.effectsRng);
      expect(p.rows).toBe(sig.rows);
      expect(p.extraJumpPayload).toBe(p);
    }
    // Every other effect has none, and a build without repeatAttack none at all.
    const none = volley([], { triggers: [idle({ kind: 'heal', lifePct: 0.1 })] });
    expect(none.sys.repeat.payloads).toEqual([null]);
  });

  it('starts with an empty ring of REPEAT_CHARGE_CAP (8) charges', () => {
    const charges = volley([], { triggers: [idle(repeat(1, 0.5))] }).sys.repeat.charges;
    expect(REPEAT_CHARGE_CAP).toBe(8);
    expect([charges.head, charges.count]).toEqual([0, 0]);
    expect(charges.payload).toEqual(Array<null>(8).fill(null));
    expect([charges.depth.length, charges.origin.length]).toEqual([8, 8]);
  });

  it('takes no calibration coefficient: a share of the attack (COEF_FIELDS)', () => {
    const spec = repeat(2, 0.5, 'nextAttack');
    expect(compileEffect(spec, 0, 3, 10).spec).toEqual(spec);
  });
});

describe('repeatAttack now (回聲)', () => {
  it('fires count volleys at once, of the repeat payload, at the entry’s depth and origin, never steady', () => {
    const ctx = volley(MANY, {
      values: { projectileCount: 2 },
      triggers: [idle(repeat(2, 0.5))],
    });
    const p = repeatPayload(ctx);
    const origin = triggerOf(ctx, repeatEffect(ctx));
    attack(ctx);
    ctx.events.length = 0;
    runRepeat(ctx, 0, 2);
    const fired = firedSince(ctx, 2);
    expect(eventsOf([ctx.events], 'attack').map((e) => e.projectileId)).toEqual(
      fired.map((f) => f.id),
    );
    expect(fired.map((f) => [f.payload === p, f.steady, f.depth, f.origin])).toEqual(
      Array.from({ length: 4 }, () => [true, false, 2, origin]),
    );
    // Each repeat spreads its projectiles over enemies, as an attack does.
    const targets = fired.map((f) => f.targetId);
    expect([targets[0] !== targets[1], targets[2] !== targets[3]]).toEqual([true, true]);
  });

  it('picks as the attack does: a tough enemy within FOCUS_RANGE before a nearer ordinary one', () => {
    const ctx = volley(
      [
        { x: P.x + 200, y: P.y },
        { x: P.x + 500, y: P.y, type: 'hexagon' },
      ],
      {
        triggers: [idle(repeat(2, 0.5)), idle(repeat(1, 0.5, 'nextAttack'))],
      },
    );
    runRepeat(ctx, 1);
    attack(ctx);
    runRepeat(ctx, 0);
    // The counted attack, the charge drained after it, then the two repeats thrown now.
    expect(ctx.projectiles.map((f) => f.targetId)).toEqual([2, 2, 2, 2]);
  });

  it('targets by ctx.shootable, and without a target fires nothing and draws nothing', () => {
    const ctx = volley([], { values: { projectileCount: 2.5 }, triggers: [idle(repeat(3, 0.5))] });
    const before = rngPositions(ctx);
    ctx.events.length = 0;
    runRepeat(ctx);
    expect(ctx.events).toEqual([]);
    expect(ctx.projectiles).toEqual([]);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('spreads past the enemies its volley targets, the last counted attack’s included', () => {
    // No volley serial of its own (no countAttack): the counted attack's two targets stay
    // marked, so with three enemies the first repeat's second projectile takes the third, and
    // the second repeat's, finding none left, the nearest (pickTargetInGrid).
    const ctx = volley(THREE, { values: { projectileCount: 2 }, triggers: [idle(repeat(2, 0.5))] });
    attack(ctx);
    const counted = ctx.projectiles.map((f) => f.targetId);
    const em = signature(ctx);
    runRepeat(ctx);
    const repeated = firedSince(ctx, 2).map((f) => f.targetId);
    const third = [1, 2, 3].find((id) => !counted.includes(id));
    expect(repeated).toEqual([counted[0], third, counted[0], counted[0]]);
    expect(ctx.enemies.map((e) => e.volleyMark)).toEqual([em.volley, em.volley, em.volley]);
  });

  it('counts no attack, shot or volley, runs no onAttack hook and no nthAttack count', () => {
    let hooks = 0;
    const module: TestModule = (b) => b.hook('onAttack', () => void hooks++);
    const ctx = volley(THREE, {
      values: { projectileCount: 2 },
      triggers: [
        idle(repeat(2, 0.5)),
        { on: 'nthAttack', every: 3, do: [{ kind: 'heal', lifePct: 0.1 }] },
      ],
      rules: [{ id: 'steadyAim', everyNth: 1, critMultiplierMore: 0, counts: 'attack' }],
      modules: [module],
    });
    attack(ctx);
    const em = signature(ctx);
    const nth = (ctx.build.triggersOn[EVENT.nthAttack] as Int32Array)[0] as number;
    const before = { em: counts(em), hooks, nth: ctx.triggerState.count[nth] };
    expect(before).toEqual({
      em: { attacks: 1, shots: 2, volley: 1, acc: 0, steadyAttack: true },
      hooks: 1,
      nth: 1,
    });
    const from = ctx.projectiles.length;
    runRepeat(ctx);
    expect({ em: counts(em), hooks, nth: ctx.triggerState.count[nth] }).toEqual(before);
    // The counted attack's projectiles are steady (every attack is); the repeats' are not.
    expect(ctx.projectiles.slice(0, from).map((f) => f.steady)).toEqual([true, true]);
    expect(firedSince(ctx, from).map((f) => f.steady)).toEqual([false, false, false, false]);
  });

  it('leaves the steadyAim shot rhythm to the counted attacks', () => {
    const ctx = volley(THREE, {
      triggers: [idle(repeat(2, 0.5))],
      rules: [{ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0, counts: 'shot' }],
    });
    const steady: boolean[] = [];
    for (let a = 0; a < 3; a++) {
      const from = ctx.projectiles.length;
      attack(ctx);
      steady.push(...firedSince(ctx, from).map((f) => f.steady));
      const repeats = ctx.projectiles.length;
      runRepeat(ctx);
      // Two shots that would be the 2nd and 3rd: never steady, never counted.
      expect(firedSince(ctx, repeats).map((f) => f.steady)).toEqual([false, false]);
    }
    expect(steady).toEqual([false, false, true]);
    expect(signature(ctx).shots).toBe(3);
  });

  it('is never steady after an onAttack hook made the counted attack steady (forceCrit)', () => {
    const module: TestModule = (b) =>
      b.hook('onAttack', (_ctx, _em, shot) => {
        shot.forceCrit = true;
      });
    const ctx = volley(THREE, { triggers: [idle(repeat(1, 0.5))], modules: [module] });
    attack(ctx);
    expect(ctx.shotScratch.forceCrit).toBe(true);
    expect(ctx.projectiles.map((f) => f.steady)).toEqual([true]);
    runRepeat(ctx);
    expect(firedSince(ctx, 1).map((f) => f.steady)).toEqual([false]);
  });

  it('draws its count on the effects stream at projectileCount 2.5, and nothing on combat', () => {
    const ctx = volley(THREE, {
      values: { projectileCount: 2.5, critChance: 0.5 },
      triggers: [idle(repeat(1, 0.5))],
    });
    const twin = createStreams(1).effects;
    sync(twin, ctx.effectsRng);
    const combat = ctx.combatRng.snapshot();
    let thrown = 0;
    for (let r = 0; r < 12; r++) {
      const from = ctx.projectiles.length;
      runRepeat(ctx);
      const expected = twin.next() < 0.5 ? 3 : 2;
      expect(firedSince(ctx, from)).toHaveLength(expected);
      expect(ctx.effectsRng.snapshot()).toEqual(twin.snapshot());
      thrown += expected;
      // Their hits roll crit on the repeat payload's stream too.
      const hits = eventsOf([land(ctx)], 'hit');
      expect(hits).toHaveLength(expected);
      for (const hit of hits) expect(hit.crit).toBe(twin.next() < 0.5);
      expect(ctx.effectsRng.snapshot()).toEqual(twin.snapshot());
    }
    expect(thrown).toBeGreaterThan(24);
    expect(thrown).toBeLessThan(36);
    expect(ctx.combatRng.snapshot()).toEqual(combat);
  });

  it('leaves a counted attack’s count roll on the combat stream (the default payload)', () => {
    const ctx = volley(THREE, { values: { projectileCount: 2.5 }, triggers: [idle(repeat(1, 1))] });
    const twin = createStreams(1).combat;
    sync(twin, ctx.combatRng);
    const effects = ctx.effectsRng.snapshot();
    for (let a = 0; a < 8; a++) {
      const from = ctx.projectiles.length;
      attack(ctx);
      expect(firedSince(ctx, from)).toHaveLength(twin.next() < 0.5 ? 3 : 2);
      expect(firedSince(ctx, from).every((f) => f.payload === signature(ctx).payload)).toBe(true);
    }
    expect(ctx.combatRng.snapshot()).toEqual(twin.snapshot());
    expect(ctx.effectsRng.snapshot()).toEqual(effects);
  });

  it('deals the repeat’s share of the attack’s damage, flagged SIGNATURE and REPEAT', () => {
    const ctx = volley([{ x: P.x + 200, y: P.y }], {
      values: { damage: 10 },
      triggers: [idle(repeat(1, 0.25))],
    });
    attack(ctx);
    const [counted] = eventsOf([land(ctx)], 'hit');
    runRepeat(ctx);
    const [repeated] = eventsOf([land(ctx)], 'hit');
    expect(toNumber(repeated?.amount ?? ZERO)).toBe(toNumber(counted?.amount ?? ZERO) * 0.25);
    expect(repeated?.tags).toBe(counted?.tags);
    const flags: number[] = [];
    const spy = volley([{ x: P.x + 200, y: P.y }], {
      triggers: [idle(repeat(1, 0.25))],
      modules: [(b) => b.hook('onHit', (_ctx, hit) => void flags.push(hit.flags))],
    });
    attack(spy);
    land(spy);
    runRepeat(spy);
    land(spy);
    expect(flags.map((f) => f & (SIGNATURE | REPEAT | PRIMARY))).toEqual([
      SIGNATURE | PRIMARY,
      SIGNATURE | REPEAT | PRIMARY,
    ]);
  });
});

describe('repeatAttack nextAttack (多重施法; C20)', () => {
  /** Two waiting repeat effects, A (2 at 50%) and B (1 at 25%), and their payloads. */
  const charged = (placed: readonly PlacedEnemy[] = THREE) => {
    const ctx = volley(placed, {
      triggers: [idle(repeat(2, 0.5, 'nextAttack')), idle(repeat(1, 0.25, 'nextAttack'))],
    });
    return { ctx, a: repeatPayload(ctx, 0), b: repeatPayload(ctx, 1) };
  };

  it('fires nothing at once: it queues count charges', () => {
    const { ctx, a } = charged();
    const before = rngPositions(ctx);
    ctx.events.length = 0;
    runRepeat(ctx, 0, 1);
    expect(ctx.events).toEqual([]);
    expect(ctx.projectiles).toEqual([]);
    expect(rngPositions(ctx)).toEqual(before);
    const charges = ctx.sys.repeat.charges;
    expect([charges.head, charges.count]).toEqual([0, 2]);
    expect(charges.payload.slice(0, 2)).toEqual([a, a]);
  });

  it('fires them right after the next counted attack, oldest first, each with its own payload, depth and origin', () => {
    const { ctx, a, b } = charged();
    const tA = triggerOf(ctx, repeatEffect(ctx, 0));
    runRepeat(ctx, 0, 1);
    runRepeat(ctx, 1, 2, SIGNATURE | HIT_EVENT, 41);
    const em = signature(ctx);
    // Not on a tick without a due attack.
    runVolley(ctx, em);
    expect(ctx.projectiles).toEqual([]);
    expect(ctx.sys.repeat.charges.count).toBe(3);
    ctx.events.length = 0;
    attack(ctx);
    const sig = em.payload;
    expect(ctx.projectiles.map((f) => [f.payload, f.depth, f.origin, f.steady])).toEqual([
      [sig, 0, -1, false],
      [a, 1, tA, false],
      [a, 1, tA, false],
      [b, 2, 41, false],
    ]);
    expect(eventsOf([ctx.events], 'attack').map((e) => e.projectileId)).toEqual(
      ctx.projectiles.map((f) => f.id),
    );
    expect(counts(em)).toMatchObject({ attacks: 1, shots: 1, volley: 1 });
    expect(ctx.sys.repeat.charges.count).toBe(0);
    expect(ctx.sys.repeat.charges.payload).toEqual(Array<null>(8).fill(null));
    // Spent: the next attack fires alone.
    attack(ctx);
    expect(ctx.projectiles).toHaveLength(5);
  });

  it('keeps them while no attack fires: no target, no attack', () => {
    const { ctx } = charged([]);
    runRepeat(ctx, 0, 1);
    attack(ctx);
    expect(ctx.projectiles).toEqual([]);
    expect(ctx.sys.repeat.charges.count).toBe(2);
  });

  it('fires the charges after each counted attack of a tick, the first taking them all', () => {
    const { ctx, a } = charged();
    runRepeat(ctx, 0, 1);
    const em = signature(ctx);
    // Two attacks due on one tick.
    em.acc = 2 * em.interval - em.cadence;
    runVolley(ctx, em);
    expect(ctx.projectiles.map((f) => f.payload)).toEqual([em.payload, a, a, em.payload]);
  });

  it('drops a 9th waiting charge and counts it, keeping the oldest 8', () => {
    const ctx = volley(THREE, {
      triggers: [
        idle(repeat(4, 0.5, 'nextAttack')),
        idle(repeat(4, 0.25, 'nextAttack')),
        idle(repeat(3, 0.125, 'nextAttack')),
      ],
    });
    const [a, b] = [repeatPayload(ctx, 0), repeatPayload(ctx, 1)];
    runRepeat(ctx, 0);
    runRepeat(ctx, 1);
    expect(ctx.counters.repeatChargesDropped).toBe(0);
    expect(ctx.sys.repeat.charges.count).toBe(8);
    runRepeat(ctx, 2);
    expect(ctx.counters.repeatChargesDropped).toBe(3);
    expect(ctx.sys.repeat.charges.count).toBe(8);
    attack(ctx);
    expect(ctx.projectiles.slice(1).map((f) => f.payload)).toEqual([a, a, a, a, b, b, b, b]);
    expect(ctx.projectiles).toHaveLength(9);
  });

  it('wraps around its ring: a charge queued after a drain fires in order', () => {
    const ctx = volley(THREE, {
      triggers: [idle(repeat(3, 0.5, 'nextAttack')), idle(repeat(4, 0.25, 'nextAttack'))],
    });
    const [a, b] = [repeatPayload(ctx, 0), repeatPayload(ctx, 1)];
    const charges = ctx.sys.repeat.charges;
    runRepeat(ctx, 0, 1);
    runRepeat(ctx, 1, 2);
    attack(ctx);
    expect([charges.head, charges.count]).toEqual([7, 0]);
    const from = ctx.projectiles.length;
    runRepeat(ctx, 1, 3);
    runRepeat(ctx, 0, 1);
    expect([charges.head, charges.count]).toEqual([7, 7]);
    attack(ctx);
    expect(
      firedSince(ctx, from + 1).map((f) => [
        f.payload === a ? 'a' : f.payload === b ? 'b' : '?',
        f.depth,
      ]),
    ).toEqual([
      ['b', 3],
      ['b', 3],
      ['b', 3],
      ['b', 3],
      ['a', 1],
      ['a', 1],
      ['a', 1],
    ]);
    expect([charges.head, charges.count]).toEqual([6, 0]);
  });

  it('drainRepeatCharges does nothing without charges', () => {
    const ctx = volley(THREE, { triggers: [idle(repeat(1, 0.5, 'nextAttack'))] });
    const before = rngPositions(ctx);
    drainRepeatCharges(ctx, signature(ctx));
    expect(ctx.projectiles).toEqual([]);
    expect(rngPositions(ctx)).toEqual(before);
  });
});

describe('rule 7: a repeat never repeats (K26)', () => {
  it('repeats nothing for an entry whose event came from a repeat’s hit, now or later', () => {
    const ctx = volley(THREE, {
      values: { projectileCount: 2.5 },
      triggers: [idle(repeat(2, 0.5)), idle(repeat(2, 0.5, 'nextAttack'))],
    });
    const before = rngPositions(ctx);
    ctx.events.length = 0;
    runRepeat(ctx, 0, 1, SIGNATURE | REPEAT | HIT_EVENT);
    runRepeat(ctx, 1, 1, REPEAT);
    expect(ctx.events).toEqual([]);
    expect(ctx.projectiles).toEqual([]);
    expect(ctx.sys.repeat.charges.count).toBe(0);
    expect(ctx.counters.repeatChargesDropped).toBe(0);
    expect(rngPositions(ctx)).toEqual(before);
    // The same entries without REPEAT do repeat.
    runRepeat(ctx, 0, 1, SIGNATURE | HIT_EVENT);
    runRepeat(ctx, 1, 1, 0);
    expect(ctx.projectiles.length).toBeGreaterThanOrEqual(4);
    expect(ctx.sys.repeat.charges.count).toBe(2);
  });

  it('stops a repeat whose hit fires another repeatAttack trigger', () => {
    // T and U both repeat on every signature hit: the attack's hit fires both, and each
    // repeat's hit fires the other (rule 3 keeps each off its own repeat's hits).
    const onHit: TriggerSpec = {
      on: 'hit',
      when: [{ hitIs: 'signature' }],
      do: [repeat(1, 0.5)],
    };
    const ctx = volley([{ x: P.x + 200, y: P.y }], { triggers: [onHit, onHit] });
    const [t, u] = [0, 1].map((n) => triggerOf(ctx, repeatEffect(ctx, n)));
    attack(ctx);
    land(ctx);
    expect(ctx.effectQueue.size).toBe(2);
    ctx.events.length = 0;
    runEffectQueue(ctx);
    expect(ctx.projectiles.map((f) => f.origin)).toEqual([t, u]);
    land(ctx);
    // Each repeat's hit queued the other trigger, flagged REPEAT; running them repeats nothing.
    expect(ctx.effectQueue.size).toBe(2);
    const run = ctx.counters.effectsRun;
    ctx.events.length = 0;
    runEffectQueue(ctx);
    expect(ctx.counters.effectsRun).toBe(run + 2);
    expect(eventsOf([ctx.events], 'attack')).toEqual([]);
    expect(ctx.projectiles).toEqual([]);
    expect(ctx.effectQueue.size).toBe(0);
  });

  it('a hit event with REPEAT queues the trigger’s entry with REPEAT in its flags', () => {
    const onHit: TriggerSpec = { on: 'hit', do: [repeat(1, 0.5)] };
    const ctx = volley(THREE, { triggers: [onHit] });
    const target = ctx.enemies[0] ?? null;
    fire(ctx, EVENT.hit, 1, -1, target, P.x, P.y, SIGNATURE | REPEAT | HIT_EVENT, ZERO);
    expect(ctx.effectQueue.size).toBe(1);
    expect((ctx.effectQueue.flags[ctx.effectQueue.head] as number) & REPEAT).toBe(REPEAT);
    runEffectQueue(ctx);
    expect(ctx.projectiles).toEqual([]);
  });
});

describe('REPEAT_STEPS (§0.7, F5-27)', () => {
  it('holds each signature’s repeat step', () => {
    expect(REPEAT_STEPS).toEqual({
      m1Volley: fireVolleyRepeat,
      magmaBomb: fireLobRepeat,
      iceFan: fireFanRepeat,
    });
  });

  it.each([
    '../emitters/volley',
    '../emitters/lob',
    '../emitters/fan',
    './execute',
    '../systems/context',
  ])('defines every entry when %s is imported first', async (first) => {
    vi.resetModules();
    // A computed path: @vite-ignore keeps Vite from rewriting it into a glob.
    await import(/* @vite-ignore */ first);
    const { REPEAT_STEPS: steps } = await import('./execute');
    for (const [id, step] of Object.entries(steps)) expect(step, id).toBeTypeOf('function');
  });

  it('runs the build’s signature step: m1Volley’s fires projectiles and throws no bomb', () => {
    const ctx = volley(THREE, {
      triggers: [idle(repeat(1, 0.5)), idle(repeat(1, 0.5, 'nextAttack'))],
    });
    expect(ctx.build.signature.id).toBe('m1Volley');
    const trigger = ctx.build.triggers[triggerOf(ctx, repeatEffect(ctx))] as CompiledTrigger;
    expect(trigger.effectEnd - trigger.effectStart).toBe(1);
    runRepeat(ctx, 0);
    runRepeat(ctx, 1);
    attack(ctx);
    const p = [repeatPayload(ctx, 0), signature(ctx).payload, repeatPayload(ctx, 1)];
    expect(ctx.projectiles.map((f) => f.payload)).toEqual(p);
    expect(ctx.shots.count).toBe(0);
  });
});
