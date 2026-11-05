/**
 * E13: the onChainEnd hook (lead rulings Y1–Y7 of the B4 engine brief; gd:529 雷火「引信」, lead
 * ruling 8 of B4): the enemy of the last jump hit of each signature discharge's chain, once a
 * discharge, nothing for a chain without a jump hit, a repeat's discharge or any other chain.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { StrikeGrant } from '../../data/emitters';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import type { EffectSpec, GroundZoneSpec, TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { applyBurn } from '../ailments/apply';
import { burnLeft, remainingOf } from '../ailments/remaining';
import { takenMult } from '../ailments/shock';
import { CHAIN_HIT_CAP, EXTRA_JUMP_CAP } from '../caps';
import { beginAttack, chainAttack, endAttack, primaryHit } from '../combat/chain';
import { chainGeneral } from '../combat/policy';
import { runEffect } from '../effects/execute';
import { CHAIN_JUMP, HIT_EVENT, REPEAT, SIGNATURE } from '../effects/flags';
import { createEffectEntry, dequeue } from '../effects/queue';
import type { EffectEntry } from '../effects/queue';
import { EVENT } from '../effects/types';
import { enqueueModuleEffect } from '../rules';
import type { BuildCompiler, ChainEndScratch, TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { stepZones } from '../systems/zones';
import {
  centerTriggers,
  createRunHash,
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  maskProbeMods,
  placedEnemies,
  v3TestData,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import { fireArcRepeat, fireDischarge, runArc } from './arc';
import { runStrike } from './strike';
import type { EmitterRuntime, Payload } from './types';

const TRIPHASE_ARC: SignatureSpec = { id: 'triphaseArc' };
const SIX_COILS: RuleSpec = { id: 'sixCoils', coils: 6, targets: 2, damageMult: 0.55 };
const FUSION = 'fusion.lightning.fire';

/** The player's position. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** An enemy (dx, dy) from the player. */
const at = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...extra,
});
/** `n` enemies 100 apart on the line from 300 right of the player: each one's nearest the next. */
const line = (n: number): PlacedEnemy[] =>
  Array.from({ length: n }, (_, j) => at(300 + 100 * j, 0));
/** 40 enemies 30 apart in 8 columns from 250 right of the player: every two within 260. */
const CLUSTER: readonly PlacedEnemy[] = Array.from({ length: 40 }, (_, j) =>
  at(250 + 30 * (j % 8), -60 + 30 * Math.floor(j / 8)),
);

interface ArcOptions {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
  readonly data?: GameData;
}

/** placedEnemies with the triphaseArc signature, without crits or ignites unless `values` say. */
const arcs = (placed: readonly PlacedEnemy[], options: ArcOptions = {}): RunContext =>
  placedEnemies(placed, {
    stats: makeStats(
      { critChance: 0, igniteChance: 0, ...options.values },
      [],
      centerTriggers(options.triggers ?? []),
    ),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
    signature: TRIPHASE_ARC,
    ...(options.data === undefined ? {} : { data: options.data }),
  });

const arcOf = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;
/** The enemy with id `id` (placedEnemies numbers them 1, 2, … in order). */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** Makes a discharge of the arc due and runs the arc, which fires it, on a fresh event list. */
const fire = (ctx: RunContext): void => {
  ctx.events.length = 0;
  const em = arcOf(ctx);
  em.acc = em.interval - em.cadence;
  runArc(ctx, em);
};

/** A module that writes the build's chain policy. */
const policy =
  (edit: Partial<{ branchFirst: number; extraJumpChance: number; bounces: number }>): TestModule =>
  (b) =>
    void Object.assign(b.chainPolicy(), edit);

interface SeenEnd {
  readonly id: number;
  readonly alive: boolean;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly origin: number;
  readonly flags: number;
  /** The tick's hit and hitBlocked events so far. */
  readonly hits: number;
  /** The attack's chain budget, and the chainHitsPeak gauge, which endAttack raises. */
  readonly budget: number;
  readonly peak: number;
  /** What the target's burn has left, by remainingOf. */
  readonly burn: number;
}

/** An onChainEnd hook recording what it sees at each call, and each call's scratch object. */
function endSpy(): { module: TestModule; ends: SeenEnd[]; scratches: ChainEndScratch[] } {
  const ends: SeenEnd[] = [];
  const scratches: ChainEndScratch[] = [];
  const module: TestModule = (b) =>
    void b.hook('onChainEnd', (ctx, ev) => {
      scratches.push(ev);
      ends.push({
        id: ev.target.id,
        alive: ev.target.alive,
        x: ev.x,
        y: ev.y,
        depth: ev.depth,
        origin: ev.origin,
        flags: ev.flags,
        hits: ctx.events.filter((e) => e.type === 'hit' || e.type === 'hitBlocked').length,
        budget: ctx.chainBudget.hits,
        peak: ctx.counters.chainHitsPeak,
        burn: toNumber(remainingOf(ctx, ev.target, 'burn')),
      });
    });
  return { module, ends, scratches };
}

/** The ids of the chainJump events (one at each jump hit, blocked or not), in order: the oracle. */
function jumpSpy(): { module: TestModule; ids: number[] } {
  const ids: number[] = [];
  const module: TestModule = (b) =>
    void b.hook('onCenterEvent', (_ctx, ev) => {
      if (ev.event === EVENT.chainJump) ids.push(ev.target?.id ?? 0);
    });
  return { module, ids };
}

/** 引信's per-jump part (gd:529 「每跳讓目標燃燒 +1 層」), lead ruling Y7's pair. */
const FUSE_BURN: TriggerSpec = {
  on: 'hit',
  when: [{ hitIs: 'signature' }, { hitIs: 'chainJump' }],
  do: [{ kind: 'applyAilment', ailment: 'burn', stacks: 1 }],
};

interface Fuse {
  readonly module: TestModule;
  /** Filled at compile: the instance's trigger, its detonate effect and its burn trigger. */
  trigger: number;
  detonate: number;
  burn: number;
}

/**
 * 雷火 引信 as a test module credited to fusion.lightning.fire, B4's to write (E13): FUSE_BURN,
 * then an onChainEnd hook that queues `fraction` (0.5) of the burn left on the last jump's enemy
 * as a detonate at it, with the entry value `value` gives (ZERO without), and `radius` when set.
 */
function fuse(
  options: {
    readonly fraction?: number;
    readonly radius?: number;
    readonly value?: (ctx: RunContext, ev: Readonly<ChainEndScratch>) => Num;
  } = {},
): Fuse {
  const detonate: EffectSpec = {
    kind: 'detonate',
    ailment: 'burn',
    fraction: options.fraction ?? 0.5,
    ...(options.radius === undefined ? {} : { radius: options.radius }),
  };
  const compile = (b: BuildCompiler): void => {
    const { name } = b.credit();
    b.addTrigger(name, FUSE_BURN);
    const effect = b.addEffect(name, detonate);
    const trigger = b.hook('onChainEnd', (ctx, ev) => {
      enqueueModuleEffect(ctx, trigger, effect, ev, options.value?.(ctx, ev) ?? ZERO);
    });
    f.trigger = trigger;
    f.detonate = effect;
    f.burn = trigger - 1;
  };
  const f: Fuse = {
    module: Object.assign(compile, { source: FUSION }),
    trigger: -1,
    detonate: -1,
    burn: -1,
  };
  return f;
}

/** The burn trigger's effect index of `f` in ctx's build. */
const burnEffectOf = (ctx: RunContext, f: Fuse): number =>
  (ctx.build.triggers[f.burn] as { effectStart: number }).effectStart;

/** Every queued entry, oldest first, as [effect, target id, depth, origin]; empties the queue. */
function drain(ctx: RunContext, each?: (entry: EffectEntry) => void): number[][] {
  const out: number[][] = [];
  const entry = createEffectEntry();
  while (ctx.effectQueue.size > 0) {
    dequeue(ctx.effectQueue, entry);
    out.push([entry.effect, entry.target?.id ?? 0, entry.depth, entry.origin]);
    each?.(entry);
  }
  return out;
}

describe('onChainEnd: the target, the last jump hit (Y2)', () => {
  it('is the last level’s enemy on a linear chain, after every hit of the chain and before the attack ends', () => {
    const spy = endSpy();
    const jumps = jumpSpy();
    // Kills calling the hooks before chainGeneral or before the primary hit (bug 4).
    const ctx = arcs(line(4), { modules: [spy.module, jumps.module] });
    fire(ctx);
    expect(jumps.ids).toEqual([2, 3]);
    const three = enemy(ctx, 3);
    expect(spy.ends).toEqual([
      {
        id: 3,
        alive: true,
        x: three.x,
        y: three.y,
        depth: 0,
        origin: -1,
        flags: SIGNATURE,
        hits: 3,
        budget: 3,
        peak: 0,
        burn: 0,
      },
    ]);
    // endAttack ran after the hooks.
    expect(ctx.counters.chainHitsPeak).toBe(3);
  });

  it('is the last jump hit in hit order on a forked chain: the later enemy’s jump of the last level, or the earlier’s when the later finds none', () => {
    const fork = policy({ branchFirst: 2 });
    // 1 forks to 2 (60 from it) and 3 (100); then 2 jumps to 4 (100 from it), 3 to 5 (120).
    const placed = [at(300, 0), at(360, 0), at(300, 100), at(460, 0), at(300, 220)];
    const spy = endSpy();
    const jumps = jumpSpy();
    const ctx = arcs(placed, { modules: [fork, spy.module, jumps.module] });
    fire(ctx);
    expect(jumps.ids).toEqual([2, 3, 4, 5]);
    expect(spy.ends.map((e) => e.id)).toEqual([5]);
    // Without 5, 3 finds no enemy left at level 2: the last jump hit is 2's, at 4, not 3.
    const four = endSpy();
    const fourJumps = jumpSpy();
    fire(arcs(placed.slice(0, 4), { modules: [fork, four.module, fourJumps.module] }));
    expect(fourJumps.ids).toEqual([2, 3, 4]);
    expect(four.ends.map((e) => e.id)).toEqual([4]);
    // With a bounce, 3 re-hits itself after 2's jump to 4: the bounce is the last jump hit.
    const bounced = endSpy();
    const bouncedJumps = jumpSpy();
    const withBounce = [fork, policy({ bounces: 1 }), bounced.module, bouncedJumps.module];
    fire(arcs(placed.slice(0, 4), { modules: withBounce }));
    expect(bouncedJumps.ids).toEqual([2, 3, 4, 3]);
    expect(bounced.ends.map((e) => e.id)).toEqual([3]);
  });

  it('is the bounced enemy when a 回彈 bounce is the last jump hit, the extra jumps still starting from the last level jump', () => {
    const bounce = policy({ bounces: 1 });
    // 六線圈's roots 1 and 2; 1 jumps to 3, then 2, with none in range, re-hits itself (bug 1).
    const placed = [at(300, 0), at(-350, 0), at(420, 0)];
    const spy = endSpy();
    const jumps = jumpSpy();
    const ctx = arcs(placed, {
      values: { chainCount: -1 },
      rules: [SIX_COILS],
      modules: [bounce, spy.module, jumps.module],
    });
    fire(ctx);
    expect(eventsOf([ctx.events], 'discharge').map((e) => e.targetId)).toEqual([1, 2]);
    expect(jumps.ids).toEqual([3, 2]);
    expect(spy.ends.map((e) => [e.id, e.alive])).toEqual([[2, true]]);
    // An extra jump rolled at 3's hit goes from 3, where the levels left off, to 4, not from 2.
    const extra = endSpy();
    const extraJumps = jumpSpy();
    fire(
      arcs([...placed, at(540, 0)], {
        values: { chainCount: -1 },
        rules: [SIX_COILS],
        modules: [bounce, policy({ extraJumpChance: 1 }), extra.module, extraJumps.module],
      }),
    );
    expect(extraJumps.ids).toEqual([3, 2, 4]);
    expect(extra.ends.map((e) => e.id)).toEqual([4]);
    // A lone enemy bounces on itself, and is the target.
    const lone = endSpy();
    fire(arcs([at(300, -300)], { modules: [bounce, lone.module] }));
    expect(lone.ends.map((e) => [e.id, e.hits])).toEqual([[1, 2]]);
  });

  it('is the last 跳電 extra jump’s enemy, at its position, after the levels', () => {
    const spy = endSpy();
    const jumps = jumpSpy();
    // Two levels (2 and 3), each rolling an extra jump at chance 1: 4 and 5; 6 is never hit.
    const ctx = arcs(line(6), {
      modules: [policy({ extraJumpChance: 1 }), spy.module, jumps.module],
    });
    fire(ctx);
    expect(jumps.ids).toEqual([2, 3, 4, 5]);
    expect(ctx.chainBudget.extraJumps).toBe(EXTRA_JUMP_CAP);
    // At 5's own position, not at the last level's (3, where the level buffers end).
    const five = enemy(ctx, 5);
    expect(spy.ends.map((e) => [e.id, e.hits, e.x, e.y])).toEqual([[5, 5, five.x, five.y]]);
    expect(five.x).not.toBe(enemy(ctx, 3).x);
  });

  it('is the enemy of a last jump its shield blocks in full, as R1 makes it a hit', () => {
    const spy = endSpy();
    // A shielder of 1000 blocks every hit below 150; the arc's jumps deal some 5.
    const placed = [at(300, 0), at(360, 0), at(420, 0, { type: 'shielder', hp: 1000 })];
    const ctx = arcs(placed, { data: v3TestData(), modules: [spy.module] });
    fire(ctx);
    const outcome = ctx.events.flatMap((e) =>
      e.type === 'hit' || e.type === 'hitBlocked' ? [[e.type, e.targetId]] : [],
    );
    expect(outcome).toEqual([
      ['hit', 1],
      ['hit', 2],
      ['hitBlocked', 3],
    ]);
    expect(spy.ends.map((e) => [e.id, e.alive])).toEqual([[3, true]]);
  });

  it('is the last enemy the chain hit when CHAIN_HIT_CAP refuses its later jumps, level jumps and extra jumps alike', () => {
    const spy = endSpy();
    const jumps = jumpSpy();
    // 40 levels rolled, two extra jumps rolled at the first two jump hits; the cap leaves 31.
    const ctx = arcs(CLUSTER, {
      values: { chainCount: 38 },
      modules: [policy({ extraJumpChance: 1 }), spy.module, jumps.module],
    });
    fire(ctx);
    expect(jumps.ids).toHaveLength(CHAIN_HIT_CAP - 1);
    expect(ctx.counters.chainHitCapped).toBe(40 - (CHAIN_HIT_CAP - 1) + 2);
    expect(spy.ends.map((e) => [e.id, e.budget])).toEqual([[jumps.ids.at(-1), CHAIN_HIT_CAP]]);
    // Enemies remain that the refused jumps would have reached.
    expect(ctx.enemies.filter((e) => e.hitMark !== ctx.attackSerial)).toHaveLength(8);
  });

  it('is never a bounce EXTRA_JUMP_CAP refuses', () => {
    const spy = endSpy();
    const jumps = jumpSpy();
    // 六線圈's roots 1 and 2; 1 forks to 3 and 4, each rolling an extra jump, which fills the
    // cap; 2 finds none and its bounce is refused. The extra jumps find none from 4.
    const placed = [at(300, 0), at(-350, 0), at(420, 0), at(540, 0)];
    const ctx = arcs(placed, {
      values: { chainCount: -1 },
      rules: [SIX_COILS],
      modules: [
        policy({ branchFirst: 2, extraJumpChance: 1, bounces: 1 }),
        spy.module,
        jumps.module,
      ],
    });
    fire(ctx);
    expect(jumps.ids).toEqual([3, 4]);
    expect(ctx.counters.extraJumpsCapped).toBe(1);
    expect(spy.ends.map((e) => e.id)).toEqual([4]);
  });

  it('is called once a discharge under 六線圈, after both roots’ chains, at the last jump hit of the two', () => {
    const spy = endSpy();
    const jumps = jumpSpy();
    // Two lines of 4, 60 apart, from 200 right and 200 left of the player (bug 9).
    const right = Array.from({ length: 4 }, (_, j) => at(200 + 60 * j, 0));
    const left = Array.from({ length: 4 }, (_, j) => at(-200 - 60 * j, 0));
    const ctx = arcs([...right, ...left], {
      rules: [SIX_COILS],
      modules: [spy.module, jumps.module],
    });
    for (let d = 0; d < 3; d++) fire(ctx);
    expect(jumps.ids).toEqual([2, 6, 3, 7, 2, 6, 3, 7, 2, 6, 3, 7]);
    expect(spy.ends.map((e) => [e.id, e.hits, e.budget])).toEqual([
      [7, 6, 6],
      [7, 6, 6],
      [7, 6, 6],
    ]);
  });

  it('is the dead enemy when the last jump killed it: alive false, at its position', () => {
    const spy = endSpy();
    const placed = [at(300, 0), at(400, 0), at(500, 40, { hp: 1 })];
    const ctx = arcs(placed, { modules: [spy.module] });
    fire(ctx);
    const three = enemy(ctx, 3);
    expect(three.alive).toBe(false);
    expect(eventsOf([ctx.events], 'enemyKilled').map((e) => e.enemyId)).toEqual([3]);
    expect(spy.ends.map((e) => [e.id, e.alive, e.x, e.y])).toEqual([[3, false, three.x, three.y]]);
    expect([three.x, three.y]).toEqual([P.x + 500, P.y + 40]);
  });
});

describe('onChainEnd: no call (Y3)', () => {
  it('is not called for a chain that rolled no jump, and is called once for each discharge whose chain rolled one', () => {
    const none = endSpy();
    const ctx = arcs(line(3), { values: { chainCount: -2 }, modules: [none.module] });
    for (let d = 0; d < 4; d++) fire(ctx);
    expect(none.ends).toEqual([]);
    // chainCount 0.5 after 三相雷's 2: a jump half the time, and a call with each.
    const some = endSpy();
    const half = arcs(line(3), { values: { chainCount: -1.5 }, modules: [some.module] });
    let jumped = 0;
    for (let d = 0; d < 24; d++) {
      fire(half);
      if (eventsOf([half.events], 'hit').some((e) => e.chainIndex > 0)) jumped++;
    }
    expect(jumped).toBeGreaterThan(4);
    expect(jumped).toBeLessThan(20);
    expect(some.ends.map((e) => e.id)).toEqual(Array<number>(jumped).fill(2));
  });

  it('is not called for a chain that finds no enemy to jump to, the primary never the target (bug 3)', () => {
    const spy = endSpy();
    const ctx = arcs([at(300, 0), at(-300, 0)], { modules: [spy.module] });
    fire(ctx);
    expect(eventsOf([ctx.events], 'hit').map((e) => [e.targetId, e.chainIndex])).toEqual([[1, 0]]);
    expect(spy.ends).toEqual([]);
  });

  it('is not called for a chain whose every jump CHAIN_HIT_CAP refuses', () => {
    const spy = endSpy();
    // The attack's budget is spent at its primary hit: both jumps are refused.
    const spend: TestModule = (b) =>
      void b.hook('onHit', (ctx) => {
        ctx.chainBudget.hits = CHAIN_HIT_CAP;
      });
    const ctx = arcs(line(3), { modules: [spend, spy.module] });
    fire(ctx);
    expect(ctx.counters.chainHitCapped).toBe(2);
    expect(eventsOf([ctx.events], 'hit')).toHaveLength(1);
    expect(spy.ends).toEqual([]);
  });

  it('is not called without a target: no discharge', () => {
    const spy = endSpy();
    const ctx = arcs([], { modules: [spy.module] });
    fire(ctx);
    expect([ctx.events.length, arcOf(ctx).attacks, spy.ends.length]).toEqual([0, 0, 0]);
  });

  it('is not called for a repeat’s discharge, now or waiting for the next one, whose chain jumps all the same (bug 2)', () => {
    const now: TriggerSpec = {
      on: 'periodic',
      every: 1000,
      do: [{ kind: 'repeatAttack', count: 2, damagePct: 0.5 }],
    };
    const next: TriggerSpec = {
      on: 'periodic',
      every: 1000,
      do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5, timing: 'nextAttack' }],
    };
    const spy = endSpy();
    const ctx = arcs(line(4), { triggers: [now, next], modules: [spy.module] });
    const repeats = ctx.build.effects.flatMap((fx, i) => (fx.kind === 'repeatAttack' ? [i] : []));
    const run = (effect: number): void => {
      const entry = createEffectEntry();
      Object.assign(entry, { effect, depth: 1, origin: 5, flags: SIGNATURE | HIT_EVENT });
      runEffect(ctx, entry);
    };
    ctx.events.length = 0;
    run(repeats[0] as number);
    // Two repeat discharges of 2 jumps each, at the repeat payload's REPEAT.
    const hits = eventsOf([ctx.events], 'hit');
    expect(hits.map((e) => [e.targetId, e.chainIndex])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(spy.ends).toEqual([]);
    // The one waiting fires right after the next discharge: the discharge's call alone.
    run(repeats[1] as number);
    fire(ctx);
    expect(eventsOf([ctx.events], 'discharge')).toHaveLength(2);
    expect(eventsOf([ctx.events], 'hit').filter((e) => e.chainIndex > 0)).toHaveLength(4);
    expect(spy.ends.map((e) => [e.id, e.flags])).toEqual([[3, SIGNATURE]]);
    // fireArcRepeat and fireDischarge with a repeat payload: no call.
    const payload = ctx.sys.repeat.payloads[repeats[0] as number] as Payload;
    expect(payload.flags).toBe(SIGNATURE | REPEAT);
    fireArcRepeat(ctx, arcOf(ctx), payload, 1, 5);
    fireDischarge(ctx, arcOf(ctx), enemy(ctx, 1), payload, false, 1, 5);
    expect(spy.ends).toHaveLength(1);
  });

  it('is not called for a chainBolt’s chain (bug 5)', () => {
    const bolt: TriggerSpec = {
      on: 'periodic',
      every: 1000,
      do: [{ kind: 'chainBolt', jumps: 2, damagePct: 1 }],
    };
    const spy = endSpy();
    const ctx = arcs(line(4), { triggers: [bolt], modules: [spy.module] });
    const effect = ctx.build.effects.findIndex((fx) => fx.kind === 'chainBolt');
    const entry = createEffectEntry();
    const first = enemy(ctx, 1);
    Object.assign(entry, { effect, depth: 1, origin: 2, target: first, x: first.x, y: first.y });
    runEffect(ctx, entry);
    expect(eventsOf([ctx.events], 'hit').map((e) => [e.targetId, e.chainIndex])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(spy.ends).toEqual([]);
  });

  it('is not called for a strike’s chain', () => {
    const strike: StrikeGrant = {
      kind: 'strike',
      name: 'bolt',
      periodSec: 1,
      target: { pick: 'nearest' },
      damagePct: 1,
      element: 'lightning',
      chainJumps: 2,
    };
    const spy = endSpy();
    const ctx = placedEnemies(line(4), {
      stats: makeStats({ critChance: 0, igniteChance: 0 }, [], {
        triggers: [],
        conversions: [],
        emitters: [{ source: 'outer.lightning', grant: strike }],
      }),
      signature: TRIPHASE_ARC,
      modules: [spy.module],
    });
    const em = ctx.emitters[1] as EmitterRuntime;
    em.timer = em.interval - 1;
    runStrike(ctx, em);
    expect(eventsOf([ctx.events], 'hit').map((e) => [e.targetId, e.chainIndex])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(spy.ends).toEqual([]);
  });

  it('is not called for chainAttack’s chains, a signature volley’s on the general path among them', () => {
    const spy = endSpy();
    const modules = [policy({ branchFirst: 2, extraJumpChance: 0.5, bounces: 1 }), spy.module];
    const ctx = placedEnemies(line(6), {
      stats: makeStats({ critChance: 0, igniteChance: 0 }),
      modules,
    });
    const p = arcOf(ctx).payload;
    expect([p.flags, p.general]).toEqual([SIGNATURE, true]);
    chainAttack(ctx, p, enemy(ctx, 1), 2, false, 0, -1);
    expect(eventsOf([ctx.events], 'hit').filter((e) => e.chainIndex > 0).length).toBeGreaterThan(1);
    // Ten seconds of M1's volley with the policy, from wave 8: chains, and no call.
    const sim = createSimulation(
      makeConfig({ stats: makeStats({ chainCount: 2 }), startWave: 8, maxTicks: 600 }),
      makeTestData(),
      modules,
    );
    let jumpHits = 0;
    while (!sim.state.finished) {
      for (const e of sim.step(NO_INPUT)) if (e.type === 'hit' && e.chainIndex > 0) jumpHits++;
    }
    expect(jumpHits).toBeGreaterThan(100);
    expect(spy.ends).toEqual([]);
  });

  it('costs a build without an onChainEnd hook nothing it can see: an arc run plays as the base did, and with a hook that queues nothing too', () => {
    // Recorded at 8ac24f4 (E13's base as built; unchanged on EB) with the same runHash: forks,
    // extra jumps, bounces, 六線圈, crits and ignites, and repeats now and with the next discharge.
    const RECORDED = 'e29bdba39bf9558d';
    let calls = 0;
    const counting: TestModule = (b) =>
      void b.hook('onChainEnd', () => {
        calls++;
      });
    expect(arcRunHash([])).toBe(RECORDED);
    expect(arcRunHash([counting])).toBe(RECORDED);
    expect(calls).toBeGreaterThan(60);
  });

  it('never fills the scratch in a build without an onChainEnd hook, whatever other hooks it has', () => {
    // The hook list's length is tested first (Y3): an onHit hook does not open the call.
    const onHit: TestModule = (b) => void b.hook('onHit', () => undefined);
    const ctx = arcs(line(4), { modules: [onHit] });
    for (let d = 0; d < 3; d++) fire(ctx);
    expect(eventsOf([ctx.events], 'hit').filter((e) => e.chainIndex > 0)).toHaveLength(2);
    expect(ctx.sys.chain.end).toEqual({ target: null, x: 0, y: 0, depth: 0, origin: -1, flags: 0 });
  });
});

/**
 * A run of an arc build on the fixture waves from wave 12 for 900 ticks: the hash of its events
 * and result, as barrageParams.test.ts' runHash makes it, with `modules` beside its policy.
 */
function arcRunHash(modules: readonly TestModule[]): string {
  const repeats: TriggerSpec[] = [
    { on: 'nthAttack', every: 5, do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }] },
    {
      on: 'nthAttack',
      every: 7,
      do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5, timing: 'nextAttack' }],
    },
  ];
  const sim = createSimulation(
    makeConfig({
      seed: 3,
      stats: makeStats(
        {
          damage: 6,
          critChance: 0.2,
          critMultiplier: 2,
          igniteChance: 0.2,
          chainCount: 1.5,
          maxLife: 1e6,
        },
        maskProbeMods(),
        centerTriggers(repeats),
      ),
      rules: [SIX_COILS],
      signature: TRIPHASE_ARC,
      startWave: 12,
      maxTicks: 900,
    }),
    makeTestData(),
    [policy({ branchFirst: 2, extraJumpChance: 0.3, bounces: 1 }), ...modules],
  );
  const hash = createRunHash();
  while (!sim.state.finished) hash.update(JSON.stringify(sim.step(NO_INPUT)));
  const result = sim.result();
  hash.update(JSON.stringify([result.damageBySource, result.counters]));
  return hash.digest();
}

describe('onChainEnd: the scratch (Y1)', () => {
  it('carries the discharge’s depth and origin and its payload’s flags, the target’s position at the call, in one object a run (bug 10)', () => {
    const spy = endSpy();
    // A hook that moves each enemy a jump hits as it is hit: the call sees where it is now.
    const shove: TestModule = (b) =>
      void b.hook('onHit', (_ctx, hit) => {
        if ((hit.flags & CHAIN_JUMP) === 0) return;
        hit.target.x += 7;
        hit.target.y -= 5;
      });
    const ctx = arcs(line(4), { modules: [shove, spy.module] });
    const em = arcOf(ctx);
    fire(ctx);
    ctx.events.length = 0;
    fireDischarge(ctx, em, enemy(ctx, 1), em.payload, false, 2, 9);
    const three = enemy(ctx, 3);
    expect(spy.ends.map((e) => [e.id, e.x, e.y, e.depth, e.origin, e.flags])).toEqual([
      [3, P.x + 507, P.y - 5, 0, -1, SIGNATURE],
      [3, P.x + 514, P.y - 10, 2, 9, SIGNATURE],
    ]);
    expect([three.x, three.y]).toEqual([P.x + 514, P.y - 10]);
    const [first, second] = spy.scratches;
    expect(first).toBe(second);
    expect(first).toBe(ctx.sys.chain.end);
    expect(first?.target).toBe(three);
  });

  it('is a ModuleEvent: what a hook queues on it carries its target, point, depth + 1, flags and the instance as origin', () => {
    const f = fuse();
    const ctx = arcs(line(3), { modules: [f.module] });
    fire(ctx);
    const entries: unknown[] = [];
    drain(ctx, (entry) => {
      if (entry.effect !== f.detonate) return;
      entries.push([entry.target?.id, entry.x, entry.y, entry.depth, entry.origin, entry.flags]);
      entries.push(entry.value);
    });
    const three = enemy(ctx, 3);
    expect(entries).toEqual([[3, three.x, three.y, 1, f.trigger, SIGNATURE], 0]);
  });
});

describe('onChainEnd: order (Y3)', () => {
  it('queues its effects after those of the chain’s hits, first in first out', () => {
    const f = fuse();
    const ctx = arcs(line(4), { modules: [f.module] });
    fire(ctx);
    const burn = burnEffectOf(ctx, f);
    // The burn trigger fires on each jump hit, 2 and 3, before the detonate at 3; none on 1.
    expect(drain(ctx)).toEqual([
      [burn, 2, 1, f.burn],
      [burn, 3, 1, f.burn],
      [f.detonate, 3, 1, f.trigger],
    ]);
  });

  it('runs the hooks in the order the modules added them', () => {
    const seen: string[] = [];
    const named =
      (name: string): TestModule =>
      (b) =>
        void b.hook('onChainEnd', (_ctx, ev) => void seen.push(`${name}${ev.target.id}`));
    fire(arcs(line(4), { modules: [named('a'), named('b')] }));
    fire(arcs(line(4), { modules: [named('b'), named('a')] }));
    expect(seen).toEqual(['a3', 'b3', 'b3', 'a3']);
  });

  it('runs what it queued in the tick’s effect stage, before the next discharge', () => {
    const f = fuse();
    // A for each attack, C for each call, D for each detonation hit, with the tick of each.
    const log: string[] = [];
    const watch: TestModule = (b) => {
      b.hook('onAttack', (ctx) => void log.push(`A${ctx.now}`));
      b.hook('onChainEnd', (ctx) => void log.push(`C${ctx.now}`));
      b.hook('onHit', (ctx, hit) => {
        if (hit.origin === f.trigger) log.push(`D${ctx.now}`);
      });
    };
    const sim = createSimulation(
      makeConfig({
        stats: makeStats({ igniteChance: 0, critChance: 0, maxLife: 1e6 }),
        signature: TRIPHASE_ARC,
        startWave: 12,
        maxTicks: 400,
      }),
      makeTestData(),
      [f.module, watch],
    );
    while (!sim.state.finished) sim.step(NO_INPUT);
    const kinds = log.map((entry) => entry[0]).join('');
    expect(kinds.match(/C/g)?.length).toBeGreaterThan(10);
    expect(kinds.match(/D/g)?.length).toBeGreaterThan(5);
    // Each attack, then its call when its chain jumped, then that call's detonation if it hit.
    expect(kinds).toMatch(/^(AC?D?)*$/);
    expect(kinds).not.toMatch(/AD/);
    // On the call's tick.
    log.forEach((entry, i) => {
      if (entry[0] === 'D') expect(entry.slice(1)).toBe(log[i - 1]?.slice(1));
    });
  });
});

describe('引信 as a test module (gd:529; Y6)', () => {
  /**
   * One discharge down line(3), the last enemy burning one stack of 6 a second to tick 300 (and
   * `hp` if given), with `f`: the queue run entry by entry, recording around the detonate what
   * its target's burn had left before and after, its takenMult, and the hits it dealt.
   */
  function detonated(f: Fuse, hp?: number, burnRings = false) {
    const rings: TestModule = (b) => void (b.flags.burnRings = burnRings);
    const spy = endSpy();
    const placed = line(3).map((p, i) => (i === 2 && hp !== undefined ? { ...p, hp } : p));
    const ctx = arcs(placed, { modules: [rings, f.module, spy.module] });
    const three = enemy(ctx, 3);
    applyBurn(ctx, three, num(6), 300, 0, 0, 1);
    fire(ctx);
    const out = {
      atCall: spy.ends[0],
      before: 0,
      after: 0,
      mult: 0,
      added: 0,
      hits: [] as [number, number][],
    };
    const runEntry = (entry: EffectEntry): void => {
      const target = entry.target as Enemy;
      const isDetonate = entry.effect === f.detonate;
      const left = toNumber(remainingOf(ctx, three, 'burn'));
      if (isDetonate) {
        out.before = left;
        out.mult = takenMult(ctx, target);
      }
      const from = ctx.events.length;
      runEffect(ctx, entry);
      if (isDetonate) {
        out.after = toNumber(remainingOf(ctx, three, 'burn'));
        out.hits = ctx.events
          .slice(from)
          .flatMap((e) => (e.type === 'hit' ? [[e.targetId, toNumber(e.amount)]] : []));
      } else if (target === three) {
        out.added = toNumber(remainingOf(ctx, three, 'burn')) - left;
      }
    };
    const order = drain(ctx, runEntry).map(([effect]) => effect === f.detonate);
    return { ctx, out, order };
  }

  it('detonates 50% of the burn left on a live last enemy, its own jump’s stack included: what the burn had at the call plus that stack', () => {
    const f = fuse();
    const { ctx, out, order } = detonated(f);
    expect(order).toEqual([false, false, true]);
    const atCall = out.atCall as SeenEnd;
    expect([atCall.id, atCall.alive]).toEqual([3, true]);
    // The stack of 6 a second from tick 1 to 300 has 299 ticks left: no step has dealt it.
    expect(atCall.burn).toBeCloseTo((6 * 299) / 60, 9);
    expect(out.added).toBeGreaterThan(0);
    expect(out.before).toBeCloseTo(atCall.burn + out.added, 9);
    expect(out.hits).toHaveLength(1);
    const [[id, amount]] = out.hits as [[number, number]];
    expect(id).toBe(3);
    expect(out.mult).toBeGreaterThan(1);
    expect(amount).toBeCloseTo(0.5 * out.before * out.mult, 9);
    // Half of it stays, every stack going on at half its damage.
    expect(out.after).toBeCloseTo(0.5 * out.before, 9);
    // Credited to the fusion, as the burn it detonates.
    expect(toNumber(ctx.bySource[ctx.sources.index(FUSION)] as Num)).toBeCloseTo(amount, 9);
  });

  it('reads a dead last enemy’s burn records whole at the hook’s call, and its rings as nothing under burnRings', () => {
    const records = detonated(fuse(), 1);
    const atCall = records.out.atCall as SeenEnd;
    expect([atCall.id, atCall.alive]).toEqual([3, false]);
    expect(atCall.burn).toBeCloseTo((6 * 299) / 60, 9);
    expect(toNumber(burnLeft(records.ctx, enemy(records.ctx, 3)))).toBeCloseTo(atCall.burn, 9);
    // The rings go back to the pool at the kill (killEnemy's releaseAilments), before the call.
    const rings = detonated(fuse(), 1, true);
    const inRings = rings.out.atCall as SeenEnd;
    expect([inRings.id, inRings.alive, inRings.burn]).toEqual([3, false, 0]);
    // A live one's rings read whole.
    const live = detonated(fuse(), undefined, true);
    expect((live.out.atCall as SeenEnd).burn).toBeCloseTo((6 * 299) / 60, 9);
  });

  it('deals nothing to a dead last enemy: with value ZERO nothing at all, with the value it had left nothing without a radius, and that share to the live enemies within one', () => {
    const zero = detonated(fuse(), 1);
    expect(zero.order).toEqual([false, false, true]);
    expect([zero.out.hits, zero.out.after]).toEqual([[], zero.out.before]);
    // With value ZERO a radius changes nothing: there is nothing left to deal round it.
    const zeroArea = detonated(fuse({ radius: 150 }), 1);
    expect([zeroArea.out.hits, zeroArea.out.after]).toEqual([[], zeroArea.out.before]);
    // The burn read at the call as the entry's value: no live target, so no hit without a radius.
    const left = (ctx: RunContext, ev: Readonly<ChainEndScratch>): Num =>
      remainingOf(ctx, ev.target, 'burn');
    const valued = detonated(fuse({ value: left }), 1);
    expect(valued.out.hits).toEqual([]);
    expect(valued.out.after).toBe(valued.out.before);
    // With a radius of 150 round its point, 2 (100 away) takes 50% of it; 1 (200 away) nothing.
    const area = detonated(fuse({ value: left, radius: 150 }), 1);
    const share = 0.5 * (area.out.atCall as SeenEnd).burn;
    const two = enemy(area.ctx, 2);
    expect(area.out.hits.map(([id]) => id)).toEqual([2]);
    expect(area.out.hits[0]?.[1]).toBeCloseTo(share * takenMult(area.ctx, two), 9);
  });
});

describe('the per-jump pair { hitIs: signature } beside { hitIs: chainJump } (Y7)', () => {
  /** A zone of radius 50 for 1 s at enemy 1, of 100% damage a second, from an idle trigger. */
  const ZONE: GroundZoneSpec = {
    kind: 'groundZone',
    radius: 50,
    durationSec: 1,
    damagePctPerSec: 1,
  };
  const IDLE_ZONE: TriggerSpec = { on: 'periodic', every: 1000, do: [ZONE] };

  /** The zone laid at enemy 1, then ticks to its first pulse: the pulse's quiet and the queue. */
  function pulse(when: NonNullable<TriggerSpec['when']>): {
    quiet: boolean;
    queued: number;
    hits: number;
  } {
    const burn: TriggerSpec = { ...FUSE_BURN, when };
    const ctx = arcs(line(3), { triggers: [IDLE_ZONE, burn] });
    const entry = createEffectEntry();
    const one = enemy(ctx, 1);
    const effect = ctx.build.effects.findIndex((fx) => fx.kind === 'groundZone');
    Object.assign(entry, { effect, x: one.x, y: one.y });
    runEffect(ctx, entry);
    for (let n = 0; n < 120; n++) {
      ctx.now = ++ctx.state.tick;
      ctx.events.length = 0;
      stepZones(ctx);
      const event = ctx.events.find(
        (e): e is Extract<SimEvent, { type: 'pulse' }> => e.type === 'pulse',
      );
      if (event !== undefined) {
        return { quiet: ctx.sys.pulse.quiet, queued: ctx.effectQueue.size, hits: event.hits };
      }
    }
    throw new Error('no pulse');
  }

  it('keeps a zone’s pulses quiet, which chainJump alone does not, and queues nothing for them', () => {
    expect(pulse([{ hitIs: 'signature' }, { hitIs: 'chainJump' }])).toEqual({
      quiet: true,
      queued: 0,
      hits: 1,
    });
    expect(pulse([{ hitIs: 'chainJump' }])).toEqual({ quiet: false, queued: 0, hits: 1 });
  });

  it('fires on each of the arc’s jump hits, and on no primary hit', () => {
    const ctx = arcs(line(4), { triggers: [FUSE_BURN] });
    const t = ctx.build.triggers.findIndex((tr) => tr.on === EVENT.hit);
    expect(ctx.build.triggers[t]?.signatureOnly).toBe(true);
    fire(ctx);
    expect(drain(ctx).map(([, id]) => id)).toEqual([2, 3]);
  });
});

describe('chainGeneral’s return (Y2)', () => {
  /** One attack of the arc's payload from enemy 1, `jumps` deep: what chainGeneral returns. */
  function chainFromOne(ctx: RunContext, jumps: number, spend = false): Enemy | null {
    const p = arcOf(ctx).payload;
    const roots = ctx.sys.chain.frontier;
    beginAttack(ctx);
    primaryHit(ctx, p, enemy(ctx, 1), 1, false, 0, -1);
    if (spend) ctx.chainBudget.hits = CHAIN_HIT_CAP;
    roots[0] = enemy(ctx, 1);
    const last = chainGeneral(ctx, p, roots, 1, jumps, false, 0, -1);
    endAttack(ctx);
    return last;
  }

  it('is the last jump hit’s enemy, or null without one: 0 levels, none in range or every jump refused', () => {
    const ctx = arcs(line(4));
    expect(chainFromOne(ctx, 3)).toBe(enemy(ctx, 4));
    expect(chainFromOne(ctx, 1)).toBe(enemy(ctx, 2));
    expect(chainFromOne(ctx, 0)).toBeNull();
    expect(chainFromOne(ctx, 3, true)).toBeNull();
    expect(chainFromOne(arcs([at(300, 0)]), 3)).toBeNull();
  });
});
