/**
 * 蜂巢's swarm signature (docs/v3 C5 design D8, D12–D14, D17, §4.1, §4.3, §4.6, §9's C5.2
 * oracles): its module and SwarmParams (src/sim/rules/swarm.ts, src/sim/build/compile.ts), the
 * signature's path through impactAt (src/sim/systems/drones.ts), the droneImpact center event
 * and the swarm's repeats (swarmRepeat). Most tests run impactAt, or the drone stage, on placed
 * enemies.
 */

import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import { createRng, createStreams } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { SourcedEmitter } from '../../data/emitters';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import { BASE_STATS } from '../../data/stats';
import type { StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import { STACK_AILMENTS } from '../../data/triggers';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { compileBuild } from '../build/compile';
import { liveStacks } from '../build/eval';
import { REPEAT_STEPS, runEffect, runEffectQueue } from '../effects/execute';
import { CHAIN_JUMP, HIT_EVENT, PRIMARY, REPEAT, SIGNATURE } from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import { EVENT, SHATTER_TRIGGER } from '../effects/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { eventsOf, makeStats, placedEnemies, rngPositions } from '../testing';
import type { PlacedEnemy } from '../testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_DASH,
  DRONE_KIND_DRONE,
  DRONE_KIND_TURRET,
} from '../types';
import type { SimEvent } from '../types';
import type { Enemy, RunContext } from './context';
import { impactAt, pickOuterFromCenter, stepDrones, swarmRepeat } from './drones';

type ImpactEvent = Extract<SimEvent, { type: 'impact' }>;

const SWARM: SignatureSpec = { id: 'swarm' };
/** An impact's hits' tags (F6), and its chain jumps' (jumpMask keeps the owner tag). */
const IMPACT_TAGS = TAG.hit | TAG.minion | TAG.area;
const JUMP_TAGS = TAG.hit | TAG.chain | TAG.minion;
/** An effect that touches no enemy and draws nothing. */
const HEAL: EffectSpec = { kind: 'heal', lifePct: 0.01 };
const POISON: EffectSpec = { kind: 'applyAilment', ailment: 'poison', stacks: 2 };
const POISON_STACKS = STACK_AILMENTS.indexOf('poison');

/** The player's position. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** An enemy (dx, dy) from the player. */
const at = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...extra,
});
/**
 * An impact's target, 1, 300 right of the player; 2 and 3 in its splash of 40 (30 right of it,
 * 30 below it); 4 and 5 out of it and in chain range, 4 the nearer to the target (90) and 5 the
 * nearer to 3 (70, against 98.5 for 4), so a chain from the target goes to 4 and one from 3 to 5.
 */
const CROWD: readonly PlacedEnemy[] = [
  at(300, 0),
  at(330, 0),
  at(300, 30),
  at(390, 0),
  at(300, 100),
];
const T = CROWD[0] as PlacedEnemy;

const steadyAim = (counts: 'shot' | 'attack', everyNth: number): RuleSpec => ({
  id: 'steadyAim',
  everyNth,
  critMultiplierMore: 0,
  counts,
});

interface SwarmOptions {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
  readonly grants?: readonly SourcedEmitter[];
}

/** placedEnemies with the swarm signature, damage 10 and no crits or ignites unless `values` say so. */
const swarms = (placed: readonly PlacedEnemy[], options: SwarmOptions = {}): RunContext =>
  placedEnemies(placed, {
    stats: makeStats({ damage: 10, critChance: 0, igniteChance: 0, ...options.values }, [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
    signature: SWARM,
  });

/** A drone grant of `drones` on outer.summon. */
const GRANT = (drones = 1): SourcedEmitter => ({
  source: 'outer.summon',
  grant: { kind: 'drone', drones },
});

/** The signature's emitter, the swarm. */
const swarmOf = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;

/** The enemy with id `id` (placedEnemies numbers them 1, 2, … in order). */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** An impact of slot 0, a signature drone, at `target`: counted, as its dash makes it. */
function impactOn(ctx: RunContext, target: Enemy): void {
  const em = swarmOf(ctx);
  impactAt(ctx, 0, target, em.payload, em, true, 0, -1);
}

/** Runs the drone stage on the current tick; returns its events. */
function stage(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepDrones(ctx);
  return ctx.events.slice();
}

const impacts = (events: readonly SimEvent[]): ImpactEvent[] => eventsOf([events], 'impact');

/** A twin of `rng` advanced until it stands where `rng` does; throws when it never does. */
function sync(twin: Rng, rng: Rng): void {
  for (let n = 0; n < 100_000; n++) {
    if (String(twin.snapshot()) === String(rng.snapshot())) return;
    twin.next();
  }
  throw new Error('the twin stream never meets the run’s');
}

interface SeenHit {
  readonly id: number;
  readonly k: number;
  readonly crit: boolean;
  readonly depth: number;
  readonly origin: number;
  readonly flags: number;
  readonly mask: number;
}

/** A hook that records every hit, in order. */
function watch(): { module: TestModule; hits: SeenHit[] } {
  const hits: SeenHit[] = [];
  const module: TestModule = (b) => {
    b.hook('onHit', (_ctx, hit) => {
      hits.push({
        id: hit.target.id,
        k: hit.chainIndex,
        crit: hit.crit,
        depth: hit.depth,
        origin: hit.origin,
        flags: hit.flags,
        mask: hit.mask,
      });
    });
  };
  return { module, hits };
}

interface SeenCenter {
  readonly event: number;
  readonly target: number | null;
  readonly x: number;
  readonly y: number;
  readonly listCount: number;
  readonly flags: number;
  readonly depth: number;
  readonly origin: number;
  /** The hits and the events of the run so far when it was raised. */
  readonly hits: number;
  readonly events: readonly string[];
}

/** A hook that records every center event as its hooks see it, and every hit before it. */
function centerSpy(): { module: TestModule; centers: SeenCenter[]; hits: number[] } {
  const centers: SeenCenter[] = [];
  const hits: number[] = [];
  const module: TestModule = (b) => {
    b.hook('onHit', (_ctx, hit) => void hits.push(hit.target.id));
    b.hook('onCenterEvent', (ctx, ev) => {
      centers.push({
        event: ev.event,
        target: ev.target?.id ?? null,
        x: ev.x,
        y: ev.y,
        listCount: ev.listCount,
        flags: ev.flags,
        depth: ev.depth,
        origin: ev.origin,
        hits: hits.length,
        events: ctx.events.map((event) => event.type),
      });
    });
  };
  return { module, centers, hits };
}

const droneImpacts = (centers: readonly SeenCenter[]): SeenCenter[] =>
  centers.filter((seen) => seen.event === EVENT.droneImpact);

interface Queued {
  readonly effect: number;
  readonly target: number | null;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly origin: number;
}

/** The effect queue's entries, oldest first. */
function queued(ctx: RunContext): Queued[] {
  const q = ctx.effectQueue;
  return Array.from({ length: q.size }, (_, j) => {
    const slot = (q.head + j) & q.capMask;
    return {
      effect: q.effect[slot] as number,
      target: q.target[slot]?.id ?? null,
      x: q.x[slot] as number,
      y: q.y[slot] as number,
      depth: q.depth[slot] as number,
      origin: q.origin[slot] as number,
    };
  });
}

/** Idle triggers (never firing here) with a repeat now and a charge for the next impact. */
const IDLE_REPEAT: TriggerSpec = {
  on: 'periodic',
  every: 1000,
  do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }],
};
const IDLE_CHARGE: TriggerSpec = {
  on: 'periodic',
  every: 1000,
  do: [{ kind: 'repeatAttack', count: 2, damagePct: 0.25, timing: 'nextAttack' }],
};

/** swarms with IDLE_REPEAT (50%) and IDLE_CHARGE (25%, two) besides `options.triggers`. */
const repeating = (placed: readonly PlacedEnemy[], options: SwarmOptions = {}): RunContext =>
  swarms(placed, { ...options, triggers: [IDLE_REPEAT, IDLE_CHARGE, ...(options.triggers ?? [])] });

/** The index of the build's n-th repeatAttack effect. */
function repeatEffectOf(ctx: RunContext, n = 0): number {
  const found = ctx.build.effects.flatMap((fx, i) => (fx.kind === 'repeatAttack' ? [i] : []));
  const effect = found[n];
  if (effect === undefined) throw new Error(`no repeatAttack effect ${n}`);
  return effect;
}

/** The repeat payload of the build's n-th repeatAttack effect (RunContext.sys.repeat). */
const repeatPayloadOf = (ctx: RunContext, n = 0): Payload =>
  ctx.sys.repeat.payloads[repeatEffectOf(ctx, n)] as Payload;

/** Runs the build's n-th repeatAttack effect as a signature hit's trigger at depth, origin. */
function runRepeatEffect(ctx: RunContext, n = 0, depth = 1, origin = 9): void {
  const entry = createEffectEntry();
  entry.effect = repeatEffectOf(ctx, n);
  entry.depth = depth;
  entry.origin = origin;
  entry.flags = SIGNATURE | HIT_EVENT;
  runEffect(ctx, entry);
}

/** A test module that writes the swarm's counts. */
const counts =
  (drones: number, turrets: number): TestModule =>
  (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, { drones, turrets });
  };

const F = false;
const R = true;

describe('swarm (§4.6, D17)', () => {
  it('compiles to a drone emitter of 80% impacts, hit, minion and area, its SwarmParams the module’s, at projectileCount − 1 (F16)', () => {
    const build = compileBuild(makeStats(), [], SWARM);
    expect(build.emitters[0]).toEqual({
      kind: 'drone',
      signature: true,
      source: 'center',
      damagePct: 0.8,
      tags: IMPACT_TAGS,
      chains: true,
      rollsAilments: true,
      canCrit: true,
      drones: 3,
      turrets: 1,
      turretDamagePct: 0.4,
    });
    expect(build.signature.swarm).toEqual({
      drones: 3,
      turrets: 1,
      speed: 600,
      dockSec: 0.5,
      cooldownSec: 0.5,
      impacts: 3,
      splash: 40,
      turretDamagePct: 0.4,
    });
    expect([build.signature.lob, build.signature.fan, build.signature.arc]).toEqual([
      null,
      null,
      null,
    ]);
    expect([BASE_STATS.projectileCount, build.values.projectileCount]).toEqual([2, 1]);
    expect(
      compileBuild(makeStats({ projectileCount: 3.5 }), [], SWARM).values.projectileCount,
    ).toBe(2.5);
    expect(compileBuild(makeStats(), []).values.projectileCount).toBe(2);
    for (const id of ['m1Volley', 'magmaBomb', 'iceFan', 'triphaseArc'] as const) {
      expect(compileBuild(makeStats(), [], { id }).signature.swarm).toBeNull();
    }
  });

  it('builds a run of 3 drones of emitter 0 from its SwarmParams, never from its spec’s counts or DRONE_DEFAULTS (§4.1)', () => {
    const ctx = swarms([]);
    const ds = ctx.sys.drones;
    // Its turret's row follows its drones' (C5.4).
    expect([ds.count, Array.from(ds.owner), Array.from(ds.seat)]).toEqual([
      4,
      [0, 0, 0, 0],
      [0, 1, 2, 0],
    ]);
    expect(Array.from(ds.id)).toEqual([1, 2, 3, 4]);
    expect(Array.from(ds.kind)).toEqual([
      DRONE_KIND_DRONE,
      DRONE_KIND_DRONE,
      DRONE_KIND_DRONE,
      DRONE_KIND_TURRET,
    ]);
    expect([
      ds.stepBase[0],
      ds.dockTicks[0],
      ds.coolTicks[0],
      ds.impacts[0],
      ds.splashSq[0],
    ]).toEqual([10, 30, 30, 3, 1600]);
    // Every number from a module's SwarmParams; a granted drone emitter keeps DRONE_DEFAULTS'.
    const tuned: TestModule = (b) => {
      const swarm = b.signature().swarm;
      if (swarm === null) return;
      Object.assign(swarm, { drones: 5, speed: 900, dockSec: 1, cooldownSec: 0.25 });
      Object.assign(swarm, { impacts: 2, splash: 60 });
    };
    const other = swarms([], { modules: [tuned], grants: [GRANT(2)] });
    const os = other.sys.drones;
    expect(other.build.emitters[0]).toMatchObject({ kind: 'drone', drones: 3 });
    expect([os.count, Array.from(os.owner)]).toEqual([8, [0, 0, 0, 0, 0, 0, 1, 1]]);
    expect([
      os.stepBase[0],
      os.dockTicks[0],
      os.coolTicks[0],
      os.impacts[0],
      os.splashSq[0],
    ]).toEqual([15, 60, 15, 2, 3600]);
    expect([
      os.stepBase[1],
      os.dockTicks[1],
      os.coolTicks[1],
      os.impacts[1],
      os.splashSq[1],
    ]).toEqual([10, 30, 30, 3, 1600]);
    // Drone k of the five docks at angle 2πk/5, 43 from the player.
    for (let k = 0; k < 5; k++) {
      const angle = (2 * Math.PI * k) / 5;
      expect(os.x[k]).toBeCloseTo(P.x + 43 * Math.cos(angle), 9);
      expect(os.y[k]).toBeCloseTo(P.y + 43 * Math.sin(angle), 9);
    }
  });

  it('throws once the modules have left the swarm without a drone or a turret; turrets 0 alone compiles (D17)', () => {
    const compile =
      (...modules: TestModule[]) =>
      () =>
        compileBuild(makeStats(), [], SWARM, modules);
    expect(compile(counts(0, 0))).toThrow(/swarm/);
    expect(compile(counts(Number.NaN, 1))).toThrow(/swarm/);
    // GOLDEN-C4's pin (IS23), and a lone drone or a lone turret.
    expect(compile(counts(3, 0))).not.toThrow();
    expect(compile(counts(1, 0))).not.toThrow();
    expect(compile(counts(0, 1))).not.toThrow();
    // Checked once every module has compiled: what an earlier one leaves a later one may mend.
    expect(compile(counts(0, 0), counts(1, 0))).not.toThrow();
    expect(compile(counts(1, 0), counts(0, 0))).toThrow(/swarm/);
    // A run with turrets 0 constructs; the M1 build never asserts.
    expect(swarms([], { modules: [counts(3, 0)] }).sys.drones.count).toBe(3);
    expect(() => placedEnemies([], { signature: SWARM, modules: [counts(0, 0)] })).toThrow(/swarm/);
    expect(() => compileBuild(makeStats(), [], undefined, [counts(0, 0)])).not.toThrow();
  });

  it('impacts with the signature’s payload on the combat stream, chained by the build’s chain policy (D14)', () => {
    const ctx = repeating([]);
    const p = swarmOf(ctx).payload;
    expect([toNumber(p.baseDamage), p.tags, p.flags, p.rng, p.chains]).toEqual([
      8,
      IMPACT_TAGS,
      SIGNATURE,
      ctx.combatRng,
      true,
    ]);
    expect([p.policy, p.general, p.raisesChainJump]).toEqual([null, false, false]);
    const repeat = repeatPayloadOf(ctx);
    expect([toNumber(repeat.baseDamage), repeat.flags, repeat.rng]).toEqual([
      4,
      SIGNATURE | REPEAT,
      ctx.effectsRng,
    ]);
    const policy: TestModule = (b) => void (b.chainPolicy().branchFirst = 2);
    const chained = repeating([], { modules: [policy] });
    const q = swarmOf(chained).payload;
    expect([q.policy !== null, q.general]).toEqual([true, true]);
    expect(repeatPayloadOf(chained).policy).toBe(q.policy);
    // A granted drone's has none.
    const granted = swarms([], { modules: [policy], grants: [GRANT()] });
    expect([
      (granted.emitters[1] as EmitterRuntime).payload.policy,
      granted.sys.drones.count,
    ]).toEqual([null, 5]);
  });
});

describe('swarm impacts (D8, D12)', () => {
  it('counts a signature drone’s impact as one attack and one shot of the signature, and a granted drone’s as none', () => {
    // The target 60 right of the player, 17 from slot 0's dock: the swarm's slot 0 and the
    // granted slot 4, after the swarm's turret, both pick on tick 1, and both impact it there.
    const ctx = swarms([at(60, 0)], { grants: [GRANT()] });
    const em = swarmOf(ctx);
    const granted = ctx.emitters[1] as EmitterRuntime;
    expect(impacts(stage(ctx)).map((e) => e.droneId)).toEqual([1, 5]);
    expect([em.attacks, em.shots, em.volley]).toEqual([1, 1, 1]);
    impactOn(ctx, enemy(ctx, 1));
    impactOn(ctx, enemy(ctx, 1));
    expect([em.attacks, em.shots, em.volley]).toEqual([3, 3, 3]);
    impactAt(ctx, 4, enemy(ctx, 1), granted.payload, granted, false, 0, -1);
    expect([em.attacks, em.shots, granted.attacks, granted.shots]).toEqual([3, 3, 0, 0]);
  });

  /** Which hits of four impacts on CROWD's target crit at crit chance 0: only steady ones. */
  const steadiness = (options: SwarmOptions): boolean[][] => {
    const { module, hits } = watch();
    const ctx = swarms(CROWD, {
      ...options,
      values: { chainCount: 1 },
      modules: [...(options.modules ?? []), module],
    });
    return Array.from({ length: 4 }, () => {
      const from = hits.length;
      impactOn(ctx, enemy(ctx, 1));
      return hits.slice(from).map((hit) => hit.crit);
    });
  };

  it('is steady on every 3rd attack under steadyAim counting attacks: its target, splash and chain all crit at crit chance 0', () => {
    expect(steadiness({ rules: [steadyAim('attack', 3)] })).toEqual([
      [F, F, F, F],
      [F, F, F, F],
      [R, R, R, R],
      [F, F, F, F],
    ]);
  });

  it('is steady on every Nth impact under steadyAim counting shots, and on an attack an onAttack hook makes steady', () => {
    expect(steadiness({ rules: [steadyAim('shot', 2)] })).toEqual([
      [F, F, F, F],
      [R, R, R, R],
      [F, F, F, F],
      [R, R, R, R],
    ]);
    const third: TestModule = (b) =>
      b.hook('onAttack', (_ctx, em, shot) => {
        if (em.attacks === 3) shot.forceCrit = true;
      });
    expect(steadiness({ modules: [third] })).toEqual([
      [F, F, F, F],
      [F, F, F, F],
      [R, R, R, R],
      [F, F, F, F],
    ]);
  });

  it('fires nthAttack once an impact, at its target, before its hits', () => {
    const order: string[] = [];
    const log: TestModule = (b) => {
      b.hook('onAttack', (_ctx, em) => void order.push(`attack ${em.attacks}`));
      b.hook('onHit', (_ctx, hit) => void order.push(`hit ${hit.target.id}`));
    };
    const ctx = swarms(CROWD, {
      triggers: [{ on: 'nthAttack', every: 2, do: [HEAL] }],
      modules: [log],
    });
    const two = enemy(ctx, 2);
    for (let i = 0; i < 4; i++) impactOn(ctx, two);
    expect(ctx.triggerState.count[SHATTER_TRIGGER + 1]).toBe(4);
    expect(queued(ctx).map((e) => [e.target, e.x, e.y])).toEqual([
      [2, two.x, two.y],
      [2, two.x, two.y],
    ]);
    expect(order.slice(0, 3)).toEqual(['attack 1', 'hit 1', 'hit 2']);
  });

  it('gives its target alone PRIMARY, every hit SIGNATURE, and chains from its target past its splash victims', () => {
    const { module, hits } = watch();
    const ctx = swarms(CROWD, { values: { chainCount: 1 }, modules: [module] });
    const flagsOf = () =>
      hits.map((hit) => [
        hit.id,
        hit.k,
        hit.mask,
        hit.flags & (SIGNATURE | PRIMARY | REPEAT | CHAIN_JUMP),
      ]);
    impactOn(ctx, enemy(ctx, 1));
    // Its splash, 2 and 3, carries its serial: the chain passes them over for 4, 90 away.
    expect(flagsOf()).toEqual([
      [1, 0, IMPACT_TAGS, SIGNATURE | PRIMARY],
      [2, 0, IMPACT_TAGS, SIGNATURE],
      [3, 0, IMPACT_TAGS, SIGNATURE],
      [4, 1, JUMP_TAGS, SIGNATURE | CHAIN_JUMP],
    ]);
    expect([ctx.chainBudget.hits, ctx.counters.chainHitsPeak]).toEqual([2, 2]);
    // At 2, its splash is 1 (3 is 42.4 away): PRIMARY on 2, the second hit; it chains from 2 to
    // 3, 42.4 away, not to 4, 60 away.
    hits.length = 0;
    impactOn(ctx, enemy(ctx, 2));
    expect(flagsOf()).toEqual([
      [1, 0, IMPACT_TAGS, SIGNATURE],
      [2, 0, IMPACT_TAGS, SIGNATURE | PRIMARY],
      [3, 1, JUMP_TAGS, SIGNATURE | CHAIN_JUMP],
    ]);
    // Without a chain count, no jump.
    const plainCtx = swarms(CROWD);
    plainCtx.events.length = 0;
    impactOn(plainCtx, enemy(plainCtx, 1));
    expect(eventsOf([plainCtx.events], 'hit').map((hit) => hit.targetId)).toEqual([1, 2, 3]);
  });

  it('chains from its target, not from the first enemy of its splash (§4.3)', () => {
    // 2 is the target and 1, 30 left of it, the first of its splash. 3 is 80 right of 2 and 110
    // from 1, 4 90 left of 2 and 60 from 1: a chain from 2 jumps to 3, one from 1 would to 4.
    const { module, hits } = watch();
    const ctx = swarms([at(270, 0), at(300, 0), at(380, 0), at(210, 0)], {
      values: { chainCount: 1 },
      modules: [module],
    });
    impactOn(ctx, enemy(ctx, 2));
    expect(hits.map((hit) => [hit.id, hit.k, hit.flags & (PRIMARY | CHAIN_JUMP)])).toEqual([
      [1, 0, 0],
      [2, 0, PRIMARY],
      [3, 1, CHAIN_JUMP],
    ]);
  });

  it('chains from a target its own hit killed, from where it died (§4.3)', () => {
    // 2, 80 right of the target, is out of its splash and in chain range.
    const ctx = swarms([at(300, 0, { hp: 1 }), at(380, 0)], { values: { chainCount: 1 } });
    ctx.events.length = 0;
    impactOn(ctx, enemy(ctx, 1));
    expect(enemy(ctx, 1).alive).toBe(false);
    expect(
      eventsOf([ctx.events], 'hit').map((hit) => [
        hit.targetId,
        hit.chainIndex,
        hit.fromX,
        hit.fromY,
      ]),
    ).toEqual([
      [1, 0, null, null],
      [2, 1, T.x, T.y],
    ]);
  });

  it('rolls its chain once an impact on the combat stream, after its hits; nothing else is drawn at no rolls', () => {
    const seen: { id: number; combat: readonly number[] }[] = [];
    const spy: TestModule = (b) =>
      b.hook(
        'onHit',
        (ctx, hit) => void seen.push({ id: hit.target.id, combat: ctx.combatRng.snapshot() }),
      );
    const ctx = swarms(CROWD, { values: { chainCount: 0.5 }, modules: [spy] });
    expect(ctx.chainCount).toBe(0.5);
    const twin = createStreams(1).combat;
    sync(twin, ctx.combatRng);
    const others = rngPositions(ctx);
    const jumps: number[] = [];
    for (let i = 0; i < 24; i++) {
      seen.length = 0;
      const before = ctx.combatRng.snapshot();
      impactOn(ctx, enemy(ctx, 1));
      const n = twin.next() < 0.5 ? 1 : 0;
      expect(ctx.combatRng.snapshot()).toEqual(twin.snapshot());
      expect(seen.map((hit) => hit.id)).toEqual(n === 1 ? [1, 2, 3, 4] : [1, 2, 3]);
      // The splash's hits draw nothing; the roll comes after them.
      expect(seen[2]?.combat).toEqual(before);
      jumps.push(n);
    }
    expect(new Set(jumps)).toEqual(new Set([0, 1]));
    const after = rngPositions(ctx);
    expect({ ...after, combat: null }).toEqual({ ...others, combat: null });
  });

  it('rolls its hits’ crits and ignites on the combat stream', () => {
    const ctx = swarms(CROWD, { values: { critChance: 0.5, igniteChance: 0.5 } });
    const others = rngPositions(ctx);
    impactOn(ctx, enemy(ctx, 1));
    const after = rngPositions(ctx);
    expect(after.combat).not.toEqual(others.combat);
    expect({ ...after, combat: null }).toEqual({ ...others, combat: null });
  });
});

describe('droneImpact (D8 step 7, §4.0)', () => {
  it('is raised once an impact, after its hits, its chain and its impact event, at its target, without a list though a freeze of its hits wrote one', () => {
    const spy = centerSpy();
    const ctx = swarms(CROWD, {
      values: { chainCount: 1, frostOnHit: 1 },
      modules: [spy.module],
    });
    ctx.events.length = 0;
    impactOn(ctx, enemy(ctx, 1));
    // Its hits froze their enemies on this tick, each freeze with its list.
    const freezes = spy.centers.filter((seen) => seen.event === EVENT.freeze);
    expect(freezes.map((seen) => seen.target)).toEqual([1, 2, 3, 4]);
    expect(freezes.every((seen) => seen.listCount > 1)).toBe(true);
    const raised = droneImpacts(spy.centers);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      target: 1,
      x: T.x,
      y: T.y,
      listCount: 0,
      flags: SIGNATURE,
      depth: 0,
      origin: -1,
      hits: 4,
    });
    expect(raised[0]?.events.at(-1)).toBe('impact');
    expect(spy.centers.at(-1)).toBe(raised[0]);
    // Each enemy of its splash took exactly one hit, though every freeze took its list during the
    // hits (the splash buffer is impactAt's alone, §4.0); 4's is the chain's.
    expect(spy.hits).toEqual([1, 2, 3, 4]);
    expect(impacts(ctx.events)).toEqual([
      { type: 'impact', droneId: 1, x: T.x, y: T.y, radius: 40, targetId: 1, count: 3 },
    ]);
  });

  it('is raised by no repeat’s impact and no granted drone’s (rule 8)', () => {
    const spy = centerSpy();
    const ctx = repeating(CROWD, {
      triggers: [{ on: 'droneImpact', do: [HEAL] }],
      modules: [spy.module],
      grants: [GRANT()],
    });
    const granted = ctx.emitters[1] as EmitterRuntime;
    swarmRepeat(ctx, swarmOf(ctx), repeatPayloadOf(ctx), 1, 9);
    impactAt(ctx, 3, enemy(ctx, 1), granted.payload, granted, false, 0, -1);
    expect(impacts(ctx.events).map((e) => e.droneId)).toEqual([-1, 4]);
    expect([droneImpacts(spy.centers).length, ctx.effectQueue.size]).toEqual([0, 0]);
    // The signature's own impact raises it, and its trigger queues.
    impactOn(ctx, enemy(ctx, 1));
    expect([droneImpacts(spy.centers).length, ctx.effectQueue.size]).toEqual([1, 1]);
  });

  it('fires its triggers at its target: a targetHas condition reads the target, and the effect starts there', () => {
    const ctx = swarms(CROWD, {
      triggers: [
        { on: 'droneImpact', do: [POISON] },
        { on: 'droneImpact', when: [{ targetHas: 'poison' }], do: [HEAL] },
      ],
    });
    const target = enemy(ctx, 2);
    impactOn(ctx, target);
    const first = queued(ctx);
    expect(first.map((e) => [e.target, e.x, e.y, e.depth, e.origin])).toEqual([
      [2, target.x, target.y, 1, SHATTER_TRIGGER + 1],
    ]);
    runEffectQueue(ctx);
    // The poison went to the target alone, not to its splash.
    expect(ctx.enemies.map((e) => liveStacks(e, POISON_STACKS, ctx.now))).toEqual([0, 2, 0, 0, 0]);
    impactOn(ctx, target);
    expect(queued(ctx).map((e) => [e.target, e.origin])).toEqual([
      [2, SHATTER_TRIGGER + 1],
      [2, SHATTER_TRIGGER + 2],
    ]);
  });

  it('draws nothing on the combat stream: an impact hits and rolls the same with a listener or without', () => {
    const run = (triggers: readonly TriggerSpec[]) => {
      const { module, hits } = watch();
      const ctx = swarms(CROWD, {
        values: { chainCount: 0.5, critChance: 0.3, igniteChance: 0.3 },
        triggers,
        modules: [module],
      });
      for (let i = 0; i < 20; i++) {
        impactOn(ctx, enemy(ctx, 1 + (i % 2)));
        runEffectQueue(ctx);
      }
      return { ctx, hits: hits.map((hit) => [hit.id, hit.k, hit.crit]) };
    };
    const quiet = run([]);
    const heard = run([{ on: 'droneImpact', when: [{ chance: 0.5 }], do: [HEAL] }]);
    expect(heard.hits).toEqual(quiet.hits);
    expect(heard.ctx.combatRng.snapshot()).toEqual(quiet.ctx.combatRng.snapshot());
    expect(heard.ctx.triggerRng.snapshot()).not.toEqual(quiet.ctx.triggerRng.snapshot());
  });
});

describe('swarm repeats (swarmRepeat; D13, C4D §4.15)', () => {
  /** The swarm's counts. */
  const swarmCounts = (em: EmitterRuntime) => ({
    attacks: em.attacks,
    shots: em.shots,
    volley: em.volley,
  });
  /**
   * 1 300 right of the player; 2, the outermost in the arena, 600 left; 3 in 2's splash; 4 1,000
   * right, the farthest of all but outside the arena (x > 1920).
   */
  const RING: readonly PlacedEnemy[] = [at(300, 0), at(-600, 0), at(-570, 0), at(1000, 0)];

  it('is the swarm’s repeat step', () => {
    expect(REPEAT_STEPS.swarm).toBe(swarmRepeat);
  });

  it('impacts the outermost enemy inside the arena with the repeat’s payload, as no attack or shot: PRIMARY | REPEAT on its target, REPEAT on its splash, an impact of drone −1', () => {
    const { module, hits } = watch();
    const ctx = repeating(RING, { rules: [steadyAim('shot', 1)], modules: [module] });
    const em = swarmOf(ctx);
    const before = swarmCounts(em);
    swarmRepeat(ctx, em, repeatPayloadOf(ctx), 2, 9);
    expect(
      hits.map((hit) => [
        hit.id,
        hit.k,
        hit.crit,
        hit.depth,
        hit.origin,
        hit.mask,
        hit.flags & (SIGNATURE | REPEAT | PRIMARY),
      ]),
    ).toEqual([
      [2, 0, false, 2, 9, IMPACT_TAGS, SIGNATURE | REPEAT | PRIMARY],
      [3, 0, false, 2, 9, IMPACT_TAGS, SIGNATURE | REPEAT],
    ]);
    expect(swarmCounts(em)).toEqual(before);
    const two = enemy(ctx, 2);
    expect(impacts(ctx.events)).toEqual([
      { type: 'impact', droneId: -1, x: two.x, y: two.y, radius: 40, targetId: 2, count: 2 },
    ]);
    // The swarm's own next impact is steady (steadyAim every shot), the repeat's never.
    impactOn(ctx, enemy(ctx, 1));
    expect(hits.slice(2).map((hit) => hit.crit)).toEqual([true]);
  });

  it('fires a hitIs primary trigger at its target’s hit, which carries REPEAT', () => {
    const ctx = repeating(RING, {
      triggers: [{ on: 'hit', when: [{ hitIs: 'primary' }], do: [HEAL] }],
    });
    swarmRepeat(ctx, swarmOf(ctx), repeatPayloadOf(ctx), 1, 9);
    expect(queued(ctx).map((e) => [e.target, e.depth])).toEqual([[2, 2]]);
    const q = ctx.effectQueue;
    expect((q.flags[q.head] as number) & (REPEAT | PRIMARY)).toBe(REPEAT | PRIMARY);
  });

  it('rolls on the repeat payload’s stream, the effects stream: its hits and its chain, nothing on combat', () => {
    // 5, 100 from 2 and 500 from the player, is the chain's only jump.
    const ctx = repeating([...RING, at(-500, 0)], { values: { chainCount: 0.5 } });
    const twin = createStreams(1).effects;
    sync(twin, ctx.effectsRng);
    const combat = ctx.combatRng.snapshot();
    const jumps: number[] = [];
    for (let r = 0; r < 16; r++) {
      ctx.events.length = 0;
      swarmRepeat(ctx, swarmOf(ctx), repeatPayloadOf(ctx), 1, 9);
      const n = twin.next() < 0.5 ? 1 : 0;
      expect(ctx.effectsRng.snapshot()).toEqual(twin.snapshot());
      expect(eventsOf([ctx.events], 'hit')).toHaveLength(2 + n);
      jumps.push(n);
    }
    expect(new Set(jumps)).toEqual(new Set([0, 1]));
    expect(ctx.combatRng.snapshot()).toEqual(combat);
    // Its crits and ignites too.
    const rolling = repeating(RING, { values: { critChance: 0.5, igniteChance: 0.5 } });
    const positions = rngPositions(rolling);
    swarmRepeat(rolling, swarmOf(rolling), repeatPayloadOf(rolling), 1, 9);
    const after = rngPositions(rolling);
    expect(after.effects).not.toEqual(positions.effects);
    expect({ ...after, effects: null }).toEqual({ ...positions, effects: null });
  });

  it('picks what a brute-force sort by (−dist, id) picks among the alive enemies inside the arena, over 200 seeded fixtures, writing and drawing nothing', () => {
    const rng = createRng(52);
    for (let f = 0; f < 200; f++) {
      const n = 1 + Math.floor(rng.next() * 12);
      // Rings of few radii, so ties are common; some past the arena's edges.
      const placed = Array.from({ length: n }, () => {
        const r = [200, 400, 600, 1100][Math.floor(rng.next() * 4)] as number;
        const angle = (Math.PI / 2) * Math.floor(rng.next() * 4);
        return at(r * Math.cos(angle), r * Math.sin(angle));
      });
      const ctx = swarms(placed);
      for (const e of ctx.enemies) if (rng.next() < 0.2) e.alive = false;
      const ds = ctx.sys.drones;
      const state = JSON.stringify([Array.from(ds.mode), ds.target.map((t) => t?.id ?? null)]);
      const positions = rngPositions(ctx);
      const expected =
        ctx.enemies
          .filter(
            (e) => e.alive && e.x >= 0 && e.x <= ARENA_WIDTH && e.y >= 0 && e.y <= ARENA_HEIGHT,
          )
          .sort((a, b) => b.dist - a.dist || a.id - b.id)[0] ?? null;
      expect(pickOuterFromCenter(ctx), `fixture ${f}`).toBe(expected);
      expect(JSON.stringify([Array.from(ds.mode), ds.target.map((t) => t?.id ?? null)])).toBe(
        state,
      );
      expect(rngPositions(ctx)).toEqual(positions);
    }
  });

  it('takes no slot’s memory or chase into account: the outermost though every drone dashes at it or has just impacted it', () => {
    const ctx = repeating(RING);
    const two = enemy(ctx, 2);
    // Slot 0 has just impacted 2, which its memory holds, as dash writes it; slots 1 and 2 dash
    // at it.
    impactOn(ctx, two);
    const ds = ctx.sys.drones;
    for (const s of [1, 2]) {
      ds.mode[s] = DRONE_DASH;
      ds.target[s] = two;
      ds.targetId[s] = two.id;
    }
    ds.memId[0] = two.id;
    ds.memUntil[0] = ctx.now + 30;
    expect(pickOuterFromCenter(ctx)).toBe(two);
  });

  it('is what repeatAttack fires now for the swarm: count impacts at the outermost, counted as no attack', () => {
    const twice: TriggerSpec = {
      on: 'periodic',
      every: 1000,
      do: [{ kind: 'repeatAttack', count: 2, damagePct: 0.5 }],
    };
    const ctx = repeating(RING, { triggers: [twice] });
    const before = swarmCounts(swarmOf(ctx));
    runRepeatEffect(ctx, 2, 3, 5);
    expect(impacts(ctx.events).map((e) => [e.droneId, e.targetId])).toEqual([
      [-1, 2],
      [-1, 2],
    ]);
    expect(swarmCounts(swarmOf(ctx))).toEqual(before);
    expect([ctx.projectiles.length, ctx.shots.count]).toEqual([0, 0]);
  });

  it('fires the waiting repeats right after a signature impact, after its droneImpact, as impacts of their own; a granted impact leaves them waiting', () => {
    const spy = centerSpy();
    const ctx = repeating(RING, { modules: [spy.module], grants: [GRANT()] });
    runRepeatEffect(ctx, 1, 2, 7);
    expect(ctx.sys.repeat.charges.count).toBe(2);
    const granted = ctx.emitters[1] as EmitterRuntime;
    impactAt(ctx, 3, enemy(ctx, 1), granted.payload, granted, false, 0, -1);
    expect(ctx.sys.repeat.charges.count).toBe(2);
    ctx.events.length = 0;
    spy.hits.length = 0;
    impactOn(ctx, enemy(ctx, 1));
    expect(ctx.sys.repeat.charges.count).toBe(0);
    expect(impacts(ctx.events).map((e) => [e.droneId, e.targetId])).toEqual([
      [1, 1],
      [-1, 2],
      [-1, 2],
    ]);
    expect(spy.hits).toEqual([1, 2, 3, 2, 3]);
    // Its droneImpact came after its own hit, before the repeats'.
    const raised = droneImpacts(spy.centers);
    expect(raised.map((seen) => seen.hits)).toEqual([1]);
    expect(swarmCounts(swarmOf(ctx))).toMatchObject({ attacks: 1, shots: 1 });
  });

  it('does nothing without an alive enemy inside the arena: no hit, no event, no count, nothing drawn', () => {
    // 1 outside the arena, 2 dead; a hit or a chain of the repeat would draw on effects.
    const ctx = repeating([at(1000, 0), at(300, 0)], {
      values: { critChance: 0.5, igniteChance: 0.5, chainCount: 1.5 },
    });
    enemy(ctx, 2).alive = false;
    const em = swarmOf(ctx);
    const before = swarmCounts(em);
    const positions = rngPositions(ctx);
    expect(pickOuterFromCenter(ctx)).toBeNull();
    swarmRepeat(ctx, em, repeatPayloadOf(ctx), 1, 9);
    runRepeatEffect(ctx, 0, 1, 9);
    expect(ctx.events).toEqual([]);
    expect(rngPositions(ctx)).toEqual(positions);
    expect(swarmCounts(em)).toEqual(before);
  });

  it('spends the waiting charges of an impact that killed the last enemy inside the arena, with nothing else', () => {
    const ctx = repeating([at(1000, 0), at(300, 0, { hp: 1 })], {
      values: { critChance: 0.5, chainCount: 1.5 },
    });
    runRepeatEffect(ctx, 1, 2, 7);
    expect(ctx.sys.repeat.charges.count).toBe(2);
    ctx.events.length = 0;
    const effects = ctx.effectsRng.snapshot();
    impactOn(ctx, enemy(ctx, 2));
    expect(enemy(ctx, 2).alive).toBe(false);
    expect(ctx.sys.repeat.charges.count).toBe(0);
    expect(impacts(ctx.events).map((e) => e.droneId)).toEqual([1]);
    expect(eventsOf([ctx.events], 'hit').map((hit) => hit.targetId)).toEqual([2]);
    expect(ctx.effectsRng.snapshot()).toEqual(effects);
  });

  it('ends its own attack before the waiting repeats fire, so chainHitsPeak keeps its hits (D8 steps 8–9)', () => {
    // 1's impact hits 1 and jumps to 2, 80 right of it: 2 hits. The repeats go to 3, the
    // outermost, 800 left of the player and alone: 1 hit each.
    const ctx = repeating([at(300, 0), at(380, 0), at(-800, 0)], { values: { chainCount: 1 } });
    runRepeatEffect(ctx, 1, 2, 7);
    expect(ctx.sys.repeat.charges.count).toBe(2);
    ctx.events.length = 0;
    impactOn(ctx, enemy(ctx, 1));
    expect(impacts(ctx.events).map((e) => [e.droneId, e.targetId])).toEqual([
      [1, 1],
      [-1, 3],
      [-1, 3],
    ]);
    expect(ctx.counters.chainHitsPeak).toBe(2);
  });

  it('takes an enemy whose center is on the arena’s edge as inside it, on either axis (D6)', () => {
    // In each fixture 1, on an edge or (last) in a corner, is the farthest enemy inside the
    // arena: 2 is just past an edge and a little farther out, or (last) on an edge and nearer.
    const fixtures: readonly (readonly PlacedEnemy[])[] = [
      [{ x: 0, y: P.y }, { x: ARENA_WIDTH + 0.5, y: P.y }, at(60, 0)],
      [{ x: ARENA_WIDTH, y: P.y }, { x: -0.5, y: P.y }, at(60, 0)],
      [{ x: P.x, y: 0 }, { x: P.x, y: ARENA_HEIGHT + 0.5 }, at(0, 60)],
      [{ x: P.x, y: ARENA_HEIGHT }, { x: P.x, y: -0.5 }, at(0, 60)],
      [{ x: ARENA_WIDTH, y: 0 }, { x: 0, y: P.y }, at(60, 0)],
    ];
    for (const placed of fixtures) {
      const ctx = repeating(placed);
      expect(pickOuterFromCenter(ctx)).toBe(enemy(ctx, 1));
      ctx.events.length = 0;
      swarmRepeat(ctx, swarmOf(ctx), repeatPayloadOf(ctx), 1, 9);
      expect(impacts(ctx.events).map((e) => e.targetId)).toEqual([1]);
    }
  });
});
