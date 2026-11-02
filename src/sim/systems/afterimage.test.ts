/**
 * 殘影 as an engine switch (docs/v3/game-design-v3.md §4.5, docs/v3 C6 design §7.4 C6b.4, lead
 * rulings E2 and E3): BuildFlags.comboFull, the stacks at which the combo is full, which
 * compileBuild resolves after the modules, and BuildFlags.comboEcho, under which a counted
 * attack of the signature that leaves the stacks full schedules one echo of itself on the
 * delayed repeats (src/sim/effects/delayed.test.ts tests the list). No rule module writes
 * comboEcho yet (B4 does): the tests set it through afterimageModule (src/sim/testing.ts). Each
 * test names in a comment the planted bug it kills.
 */

import { describe, expect, it, vi } from 'vitest';
import { toNumber } from '../../core/num';
import type { SourcedEmitter } from '../../data/emitters';
import type { SignatureId, SignatureSpec } from '../../data/rules';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { compileBuild, DEFAULT_COMBO_CAP } from '../build/compile';
import type { BuildFlags } from '../build/compile';
import { drainDelayedRepeats, REPEAT_STEPS, runEffect, runEffectQueue } from '../effects/execute';
import { HIT_EVENT, REPEAT, SIGNATURE } from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import { EVENT } from '../effects/types';
import { runArc } from '../emitters/arc';
import { runFan } from '../emitters/fan';
import { runLob } from '../emitters/lob';
import { ALWAYS_IGNITES } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import { runVolley } from '../emitters/volley';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  AFTERIMAGE,
  afterimageModule,
  centerTriggers,
  eventsOf,
  makeConfig,
  makeStats,
  placedEnemies,
  stationarySquares,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import { gainComboOnAttack, loseComboOnHit } from './combo';
import type { Enemy, RunContext } from './context';
import { compact, removeEnemy } from './death';
import { impactAt } from './drones';
import { rebuildGrid } from './grid';
import { moveProjectiles } from './projectiles';

const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/** `n` standing enemies on a ring of `r` around the player, ids 1 .. n. */
const ring = (n: number, r = 300): PlacedEnemy[] =>
  Array.from({ length: n }, (_, i) => ({
    x: P.x + r * Math.cos((2 * Math.PI * i) / n),
    y: P.y + r * Math.sin((2 * Math.PI * i) / n),
  }));

/** A test module that writes these build flags, as a keystone's module would. */
const flagsOf =
  (flags: Partial<BuildFlags>): TestModule =>
  (b) => {
    Object.assign(b.flags, flags);
  };

/** An effect that touches no enemy and draws nothing. */
const HEAL: EffectSpec = { kind: 'heal', lifePct: 0.01 };
/** A trigger that never fires in these tests, so its effects run only where a test runs them. */
const idle = (...effects: EffectSpec[]): TriggerSpec => ({
  on: 'periodic',
  every: 1000,
  do: effects,
});

interface Options {
  readonly values?: Parameters<typeof makeStats>[0];
  readonly triggers?: readonly TriggerSpec[];
  readonly grants?: readonly SourcedEmitter[];
  readonly modules?: readonly TestModule[];
  readonly signature?: SignatureSpec;
}

/**
 * placedEnemies with one projectile, bomb or cone an attack, no crits, ignites or chains,
 * projectiles fast enough to land on their first step, these center triggers, granted emitters
 * and modules.
 */
const run = (placed: readonly PlacedEnemy[], options: Options = {}): RunContext =>
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
      { ...centerTriggers(options.triggers ?? []), emitters: options.grants ?? [] },
    ),
    modules: options.modules ?? [],
    ...(options.signature === undefined ? {} : { signature: options.signature }),
  });

const signatureOf = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;
const stacksOf = (ctx: RunContext): number => ctx.sys.combo.stacks;
const echoOf = (ctx: RunContext): { readonly payload: Payload; readonly ticks: number } => {
  const echo = ctx.sys.repeat.echo;
  if (echo === null) throw new Error('no echo');
  return echo;
};

/** The entries waiting on the list, in its order: [due, payload, depth, origin]. */
function waiting(ctx: RunContext): [number, Payload | null, number, number][] {
  const list = ctx.sys.repeat.delayed;
  return Array.from({ length: list.count }, (_, n) => {
    const at = (list.head + n) & list.capMask;
    return [
      list.due[at] as number,
      list.payload[at] as Payload | null,
      list.depth[at] as number,
      list.origin[at] as number,
    ];
  });
}

/** Moves the run to tick `tick` and drains the list there, as step() does. */
function drainAt(ctx: RunContext, tick: number): void {
  ctx.now = tick;
  if (ctx.sys.repeat.delayed.count !== 0) drainDelayedRepeats(ctx);
}

/** Makes one attack of a signature that fires on its cadence due, and runs it. */
const due =
  (step: (ctx: RunContext, em: EmitterRuntime) => void) =>
  (ctx: RunContext): void => {
    const em = signatureOf(ctx);
    em.acc = em.interval - em.cadence;
    step(ctx, em);
  };

/** The shots in flight whose payload is `p`. */
const shotsOf = (ctx: RunContext, p: Payload): number => {
  let n = 0;
  for (let s = 0; s < ctx.shots.count; s++) if (ctx.shots.payload[s] === p) n++;
  return n;
};

interface Kind {
  readonly id: SignatureId;
  /** One counted attack of the signature emitter. */
  readonly attack: (ctx: RunContext) => void;
  /**
   * What a repeat of payload `p` leaves for the tick's events and pools: its projectiles, bombs
   * or cones, its discharges, its impacts of no drone.
   */
  readonly fired: (ctx: RunContext, p: Payload) => number;
}

const KINDS: readonly Kind[] = [
  {
    id: 'm1Volley',
    attack: due(runVolley),
    fired: (ctx, p) => ctx.projectiles.filter((f) => f.payload === p).length,
  },
  { id: 'magmaBomb', attack: due(runLob), fired: shotsOf },
  { id: 'iceFan', attack: due(runFan), fired: shotsOf },
  {
    id: 'triphaseArc',
    attack: due(runArc),
    fired: (ctx) => eventsOf([ctx.events], 'discharge').length,
  },
  {
    id: 'swarm',
    // A drone's counted impact (impactAt's path for the signature's drones).
    attack: (ctx) => {
      const em = signatureOf(ctx);
      impactAt(ctx, 0, ctx.enemies[0] as Enemy, em.payload, em, true, 0, -1);
    },
    fired: (ctx) => eventsOf([ctx.events], 'impact').filter((e) => e.droneId === -1).length,
  },
];

const VOLLEY = KINDS[0] as Kind;

/** `count` counted attacks of the signature. */
function attacks(ctx: RunContext, kind: Kind, count: number): void {
  for (let i = 0; i < count; i++) kind.attack(ctx);
}

/** Lands every projectile in flight (they arrive on their first step) and clears them. */
function land(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  moveProjectiles(ctx);
  compact(ctx);
  return [...ctx.events];
}

describe('BuildFlags.comboFull (lead ruling E2)', () => {
  const full = (...modules: TestModule[]): number | null =>
    compileBuild(makeStats(), [], undefined, modules).flags.comboFull;

  it('is the cap, 20, by default, a module’s finite cap, and 20 under a cap a module lifted', () => {
    // Plants comboFull left Infinity under ★無盡連擊 (the cap copied whatever it is), comboFull
    // resolved before the modules (a cap of 25 would read 20), and a 20 written in place of
    // DEFAULT_COMBO_CAP's.
    expect(DEFAULT_COMBO_CAP).toBe(20);
    expect(full()).toBe(20);
    expect(full(flagsOf({ comboCap: 25 }))).toBe(25);
    expect(full(flagsOf({ comboCap: 12 }))).toBe(12);
    expect(full(flagsOf({ combo: true, comboCap: Infinity, comboHitKeep: 0 }))).toBe(20);
  });

  it('keeps a module’s own value, under the default cap and under a lifted one', () => {
    // Plants comboFull overwriting a module's value (= in place of ??=).
    expect(full(flagsOf({ comboFull: 5 }))).toBe(5);
    expect(full(flagsOf({ comboCap: Infinity, comboFull: 30 }))).toBe(30);
    expect(full(flagsOf({ comboFull: 5 }), flagsOf({ comboCap: 25 }))).toBe(5);
  });

  it('decides the echoes: a module’s 5 echoes from the 5th attack, ★’s 20 from the 20th of 25', () => {
    // Plants the echo's test reading comboCap, not comboFull: ★ would never echo, and a module's
    // comboFull of 5 would wait for 20.
    const scheduled = (module: TestModule, count: number): number => {
      const ctx = run(ring(8), { modules: [afterimageModule(), module] });
      attacks(ctx, VOLLEY, count);
      return ctx.sys.repeat.delayed.scheduled;
    };
    expect(scheduled(flagsOf({ comboFull: 5 }), 4)).toBe(0);
    expect(scheduled(flagsOf({ comboFull: 5 }), 8)).toBe(4);
    expect(scheduled(flagsOf({ comboCap: Infinity }), 19)).toBe(0);
    expect(scheduled(flagsOf({ comboCap: Infinity }), 25)).toBe(6);
  });
});

describe('BuildFlags.comboEcho (lead ruling E3)', () => {
  const compiled = (echo: BuildFlags['comboEcho']) => (): unknown =>
    compileBuild(makeStats(), [], undefined, [afterimageModule(echo)]);

  it('takes a positive, finite delay and a share in (0, 1], and throws on anything else', () => {
    // Plants the check dropped, or loosened to delaySec ≥ 0 or damagePct ≤ 1 alone.
    for (const [delaySec, damagePct] of [
      [0, 0.5],
      [-0.3, 0.5],
      [Infinity, 0.5],
      [NaN, 0.5],
      [0.3, 0],
      [0.3, -0.5],
      [0.3, 1.01],
      [0.3, NaN],
    ] as const) {
      expect(compiled({ delaySec, damagePct }), `${delaySec} ${damagePct}`).toThrow(/comboEcho/);
    }
    expect(compiled({ delaySec: 0.3, damagePct: 1 })).not.toThrow();
    expect(compiled({ delaySec: 1e-3, damagePct: 1e-9 })).not.toThrow();
    expect(compiled(null)).not.toThrow();
  });

  it('sets BuildFlags.combo for an echo alone, so a module that sets only comboEcho counts and echoes', () => {
    // Plants comboEcho left out of compileBuild's combo test: such a module's run would count no
    // stacks and never echo.
    const combo = (...modules: TestModule[]): boolean =>
      compileBuild(makeStats(), [], undefined, modules).flags.combo;
    expect(combo(afterimageModule())).toBe(true);
    expect(combo(afterimageModule(null))).toBe(false);
    expect(combo()).toBe(false);
    const ctx = run(ring(8), { modules: [afterimageModule()] });
    attacks(ctx, VOLLEY, 25);
    expect([stacksOf(ctx), ctx.sys.repeat.delayed.scheduled]).toEqual([20, 6]);
  });

  it('builds the echo payload only under comboEcho: the signature’s at damagePct, effects stream, SIGNATURE | REPEAT, its rows', () => {
    // Plants the echo payload built for every build, damagePct not applied or applied twice,
    // and the echo given a repeatAttack effect's payload.
    const repeatNow: EffectSpec = { kind: 'repeatAttack', count: 1, damagePct: 0.5 };
    const ctx = run([], { triggers: [idle(HEAL, repeatNow)], modules: [afterimageModule()] });
    const quarter = run([], { modules: [afterimageModule({ delaySec: 0.3, damagePct: 0.25 })] });
    const echo = echoOf(ctx);
    for (const [share, c] of [
      [0.5, ctx],
      [0.25, quarter],
    ] as const) {
      const sig = signatureOf(c).payload;
      const p = echoOf(c).payload;
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
      expect(p.rng).toBe(c.effectsRng);
      expect(p.rows).toBe(sig.rows);
      expect(p.extraJumpPayload).toBe(p);
    }
    // The repeatAttack effect keeps its own payload, one per effect.
    expect(ctx.sys.repeat.payloads).toHaveLength(2);
    expect(ctx.sys.repeat.payloads[1]).not.toBe(echo.payload);
    // Neither a plain build nor one that keeps the stacks without 殘影 has one.
    expect(run([]).sys.repeat.echo).toBeNull();
    expect(run([], { modules: [flagsOf({ combo: true })] }).sys.repeat.echo).toBeNull();
  });

  it('gives a lob’s echo its fire zone at the same share, always igniting, flagged REPEAT', () => {
    // Plants the echo's zone payload left at the full share.
    const ctx = run([], { signature: { id: 'magmaBomb' }, modules: [afterimageModule()] });
    const zone = signatureOf(ctx).payload.zoneVariant as Payload;
    const echoZone = echoOf(ctx).payload.zoneVariant as Payload;
    expect(echoZone).not.toBeNull();
    expect(toNumber(echoZone.baseDamage)).toBe(toNumber(zone.baseDamage) * 0.5);
    expect(echoZone.flags).toBe(ALWAYS_IGNITES | REPEAT);
    expect(echoZone.rng).toBe(ctx.effectsRng);
  });

  it('waits round(delaySec × 60) ticks, at least 1: 0.3 s is 18, 0.31 s 19, 0.305 s 18, 0.001 s 1', () => {
    // Plants the delay off by one either way (floor of 18.6, ceil of 18.3), and a delay below
    // half a tick scheduled for the attack's own tick.
    expect(AFTERIMAGE).toEqual({ delaySec: 0.3, damagePct: 0.5 });
    const ticks = (delaySec: number): number =>
      echoOf(run([], { modules: [afterimageModule({ delaySec, damagePct: 0.5 })] })).ticks;
    expect([ticks(0.3), ticks(0.31), ticks(0.305), ticks(1), ticks(0.001)]).toEqual([
      18, 19, 18, 60, 1,
    ]);
    const ctx = run(ring(8), { modules: [afterimageModule({ delaySec: 0.001, damagePct: 0.5 })] });
    attacks(ctx, VOLLEY, 20);
    expect(waiting(ctx).map(([d]) => d)).toEqual([ctx.now + 1]);
  });
});

describe('殘影’s echoes (lead ruling E3)', () => {
  it.each(KINDS)(
    '$id: below the full stacks no echo; the attack that fills them and each after it one, 18 ticks later, at half damage through REPEAT_STEPS',
    (kind) => {
      // Plants an echo below comboFull (> for ≥, or stacks + 1), none for the attack reaching
      // comboFull, the delay off by one either way, the drain firing early, a repeat step other
      // than the signature's, the echo's depth or origin not the attack's, and damagePct not
      // applied or applied twice.
      const ctx = run(ring(8), { signature: { id: kind.id }, modules: [afterimageModule()] });
      const em = signatureOf(ctx);
      const echo = echoOf(ctx);
      const list = ctx.sys.repeat.delayed;
      expect([ctx.build.flags.comboFull, echo.ticks]).toEqual([20, 18]);
      expect(toNumber(echo.payload.baseDamage)).toBe(toNumber(em.payload.baseDamage) * 0.5);
      attacks(ctx, kind, 19);
      expect([stacksOf(ctx), em.attacks, list.scheduled]).toEqual([19, 19, 0]);
      kind.attack(ctx);
      expect([stacksOf(ctx), list.scheduled]).toEqual([20, 1]);
      const start = ctx.now;
      expect(waiting(ctx)).toEqual([[start + 18, echo.payload, 0, -1]]);
      ctx.now = start + 1;
      kind.attack(ctx);
      expect(waiting(ctx).map(([d]) => d)).toEqual([start + 18, start + 19]);
      const step = vi.spyOn(REPEAT_STEPS, kind.id);
      try {
        ctx.events.length = 0;
        drainAt(ctx, start + 17);
        expect(step).not.toHaveBeenCalled();
        expect(kind.fired(ctx, echo.payload)).toBe(0);
        drainAt(ctx, start + 18);
        expect(step.mock.calls).toEqual([[ctx, em, echo.payload, 0, -1]]);
        expect(kind.fired(ctx, echo.payload)).toBeGreaterThan(0);
        expect(list.count).toBe(1);
        drainAt(ctx, start + 19);
        expect(step).toHaveBeenCalledTimes(2);
        expect(list.count).toBe(0);
      } finally {
        step.mockRestore();
      }
    },
  );

  it('is no attack: it gains no stack, schedules no echo, counts no nthAttack, runs no onAttack hook and fires no waiting charge', () => {
    // Plants an echo counted as an attack: countAttack on its step (the stacks and the nthAttack
    // count would rise and, at full stacks, another echo be scheduled), the onAttack hooks run
    // for it, and drainRepeatCharges after it.
    let hooks = 0;
    const onAttack: TestModule = (b) => void b.hook('onAttack', () => void hooks++);
    const ctx = run(ring(8), {
      triggers: [
        { on: 'nthAttack', every: 1000, do: [HEAL] },
        idle({ kind: 'repeatAttack', count: 1, damagePct: 0.5, timing: 'nextAttack' }),
      ],
      modules: [afterimageModule(), flagsOf({ comboCap: Infinity }), onAttack],
    });
    const em = signatureOf(ctx);
    const nth = ctx.build.triggers.findIndex((t) => t.on === EVENT.nthAttack);
    expect(nth).toBeGreaterThanOrEqual(0);
    attacks(ctx, VOLLEY, 20);
    // A charge waiting for the next attack (多重施法), queued after the 20th.
    const entry = createEffectEntry();
    entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === 'repeatAttack');
    entry.depth = 1;
    entry.origin = 1;
    entry.flags = SIGNATURE | HIT_EVENT;
    runEffect(ctx, entry);
    const counts = () => [
      stacksOf(ctx),
      ctx.evalInput.comboStacks,
      ctx.sys.repeat.delayed.scheduled,
      ctx.triggerState.count[nth],
      ctx.sys.repeat.charges.count,
      em.attacks,
      em.volley,
      em.shots,
      hooks,
    ];
    expect(counts()).toEqual([20, 20, 1, 20, 1, 20, 20, 20, 20]);
    const fired = ctx.projectiles.length;
    drainAt(ctx, ctx.now + 18);
    expect(ctx.projectiles.length).toBe(fired + 1);
    expect(counts()).toEqual([20, 20, 1, 20, 1, 20, 20, 20, 20]);
    expect(ctx.sys.repeat.delayed.count).toBe(0);
  });

  it('fires after the stacks fell below full, and the next attack below full schedules none', () => {
    // Plants the echo dropped when the stacks are no longer full at its tick.
    const ctx = run(ring(8), { modules: [afterimageModule()] });
    const echo = echoOf(ctx);
    attacks(ctx, VOLLEY, 20);
    loseComboOnHit(ctx);
    expect(stacksOf(ctx)).toBe(10);
    const fired = ctx.projectiles.length;
    drainAt(ctx, ctx.now + 18);
    expect(ctx.projectiles.slice(fired).map((f) => f.payload)).toEqual([echo.payload]);
    VOLLEY.attack(ctx);
    expect([stacksOf(ctx), ctx.sys.repeat.delayed.scheduled]).toEqual([11, 1]);
  });

  it('schedules nothing without comboEcho, at full stacks', () => {
    // Plants the echo's test dropping comboEcho's null (a payload of none scheduled).
    const ctx = run(ring(8), { modules: [flagsOf({ combo: true })] });
    attacks(ctx, VOLLEY, 25);
    expect(stacksOf(ctx)).toBe(20);
    expect(ctx.sys.repeat.delayed).toMatchObject({ count: 0, scheduled: 0, capMask: -1 });
  });

  it('schedules nothing for a granted emitter’s attack at full stacks', () => {
    // Plants the emitter index test moved after the echo's.
    const drone: SourcedEmitter = { source: 'outer.summon', grant: { kind: 'drone', drones: 1 } };
    const ctx = run(ring(8), { grants: [drone], modules: [afterimageModule()] });
    attacks(ctx, VOLLEY, 20);
    const granted = ctx.emitters[1] as EmitterRuntime;
    expect(granted.spec.kind).toBe('drone');
    gainComboOnAttack(ctx, granted);
    expect([stacksOf(ctx), ctx.sys.repeat.delayed.scheduled]).toEqual([20, 1]);
  });

  it('deals half the attack’s damage: hits of 10 and of 5', () => {
    // Plants damagePct not applied (10) or applied twice (2.5).
    const ctx = run([{ x: P.x + 200, y: P.y }], {
      values: { damage: 10 },
      modules: [afterimageModule()],
    });
    attacks(ctx, VOLLEY, 20);
    const own = eventsOf([land(ctx)], 'hit').map((e) => toNumber(e.amount));
    expect(own).toEqual(Array<number>(20).fill(10));
    drainAt(ctx, ctx.now + 18);
    const echoed = eventsOf([land(ctx)], 'hit');
    expect(echoed.map((e) => [toNumber(e.amount), e.crit])).toEqual([[5, false]]);
  });

  it('aims when it fires: at the nearest enemy then, its attack’s target gone', () => {
    // Plants the echo aimed at the attack's target, kept from its scheduling.
    const ctx = run(
      [
        { x: P.x + 200, y: P.y },
        { x: P.x - 400, y: P.y },
      ],
      { modules: [afterimageModule()] },
    );
    const echo = echoOf(ctx);
    attacks(ctx, VOLLEY, 20);
    expect(new Set(eventsOf([land(ctx)], 'hit').map((e) => e.targetId))).toEqual(new Set([1]));
    removeEnemy(ctx, ctx.enemies[0] as Enemy);
    compact(ctx);
    rebuildGrid(ctx);
    drainAt(ctx, ctx.now + 18);
    expect(ctx.projectiles.map((f) => f.payload === echo.payload)).toEqual([true]);
    expect(eventsOf([land(ctx)], 'hit').map((e) => e.targetId)).toEqual([2]);
  });

  it('repeats nothing from an echo’s hit (rule 7): the hit trigger’s entry carries REPEAT', () => {
    // Plants the echo payload without REPEAT.
    const onHit: TriggerSpec = {
      on: 'hit',
      do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }],
    };
    const ctx = run([{ x: P.x + 200, y: P.y }], {
      triggers: [onHit],
      modules: [afterimageModule()],
    });
    attacks(ctx, VOLLEY, 20);
    land(ctx);
    // The attacks' own hits queued 20 repeats; they fire and land, and their hits fire no
    // entry of the trigger they came from (rule 3).
    runEffectQueue(ctx);
    expect(ctx.projectiles).toHaveLength(20);
    land(ctx);
    expect([ctx.effectQueue.size, ctx.projectiles.length]).toEqual([0, 0]);
    // The echo comes from no trigger: its hit fires the trigger, flagged REPEAT.
    drainAt(ctx, ctx.now + 18);
    expect(ctx.projectiles.map((f) => f.payload)).toEqual([echoOf(ctx).payload]);
    land(ctx);
    const q = ctx.effectQueue;
    expect(q.size).toBe(1);
    expect((q.flags[q.head] as number) & REPEAT).toBe(REPEAT);
    const before = ctx.projectiles.length;
    runEffectQueue(ctx);
    expect(ctx.projectiles.length).toBe(before);
  });
});

describe('殘影 in a run', () => {
  /**
   * A volley attacking every 6 ticks from tick 6 under 殘影 at comboFull 3, every hit on the
   * player taking all the stacks; a tick hook takes them at tick 24, after the emitters. Per
   * tick, the projectiles fired by the end of the emitter stage, in firing order: 'e' for an
   * echo, 'a' for an attack.
   */
  function fired(maxTicks: number): Map<number, string> {
    const byTick = new Map<number, string>();
    let next = 1;
    const watch: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        const echo = ctx.sys.repeat.echo?.payload;
        const fresh = ctx.projectiles.filter((f) => f.id >= next);
        if (fresh.length > 0) {
          byTick.set(ctx.now, fresh.map((f) => (f.payload === echo ? 'e' : 'a')).join(''));
        }
        next = ctx.nextProjectileId;
        if (ctx.now === 24) loseComboOnHit(ctx);
      });
    const config = makeConfig({
      seed: 4,
      maxTicks,
      stats: makeStats({
        critChance: 0,
        igniteChance: 0,
        attackSpeed: 10,
        projectileCount: 1,
        projectileSpeed: 120_000,
      }),
    });
    const sim = createSimulation(config, stationarySquares(6), [
      afterimageModule(),
      flagsOf({ comboFull: 3, comboHitKeep: 0 }),
      watch,
    ]);
    while (!sim.state.finished) sim.step(NO_INPUT);
    return byTick;
  }

  it('fires each echo 18 ticks after its attack, the stacks full or not by then', () => {
    // Plants the list drained only while the stacks are full: the echoes of ticks 18 and 24
    // would wait for the stacks to fill again at tick 42, and fire at 48.
    expect([...fired(66)]).toEqual([
      [6, 'a'],
      [12, 'a'],
      [18, 'a'],
      [24, 'a'],
      [30, 'a'],
      [36, 'ea'],
      [42, 'ea'],
      [48, 'a'],
      [54, 'a'],
      [60, 'ea'],
      [66, 'ea'],
    ]);
  });
});
