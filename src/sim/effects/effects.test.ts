import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { add, gt, lte, mul, num, ZERO } from '../../core/num';
import { createStreams } from '../../core/rng';
import type { StatBlock, StatExtras } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { addBurn, expireBurns } from '../ailments/records';
import { compileBuild } from '../build/compile';
import { hitWithPayload } from '../combat/hit';
import type { EmitterRuntime, Payload } from '../emitters/types';
import { enqueueModuleEffect } from '../rules';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { createRunContext } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { killEnemy } from '../systems/death';
import { rebuildGrid } from '../systems/grid';
import { releaseEnemies, split } from '../systems/spawn';
import { startDueWave } from '../systems/waves';
import { eventsOf, makeConfig, makeStats, makeTestData, stationarySquares } from '../testing';
import { NO_INPUT } from '../types';
import type { RunConfig, SimEvent } from '../types';
import { emitCenterEvent } from './centerEvents';
import { dispatchPendingKills } from './dispatch';
import { runEffectQueue } from './execute';
import { HIT_EVENT, KILL_BY_BURN, KILL_BY_HIT, KILLED, killKindFlag, SIGNATURE } from './flags';
import { enqueue } from './queue';
import { EFFECT_QUEUE_HARD_CAP, EFFECTS_PER_TICK, EVENT } from './types';
import type { CompiledTrigger } from './types';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;

/** Center-sourced triggers, as collectExtras gives them. */
const center = (...specs: TriggerSpec[]): StatExtras => ({
  triggers: specs.map((spec) => ({ source: 'center', spec })),
  conversions: [],
});

/** Runs to the end, keeping each tick's events (index i holds tick i + 1's). */
function run(config: RunConfig, data: GameData, modules: readonly TestModule[] = []) {
  const sim = createSimulation(config, data, modules);
  const ticks: SimEvent[][] = [];
  while (!sim.state.finished) ticks.push(sim.step(NO_INPUT).slice());
  return { ticks, result: sim.result() };
}

/** A run context on the first wave of `data`, spawned and gridded for tick 1. */
function spawned(
  stats: StatBlock,
  data: GameData,
  modules: readonly TestModule[] = [],
): RunContext {
  const ctx = createRunContext(makeConfig({ stats }), data, modules);
  ctx.now = 1;
  startDueWave(ctx);
  releaseEnemies(ctx);
  rebuildGrid(ctx);
  return ctx;
}

const signaturePayload = (ctx: RunContext): Payload => (ctx.emitters[0] as EmitterRuntime).payload;

/** An emitter hit (depth 0, no origin) of the signature attack on `enemy`. */
const emitterHit = (ctx: RunContext, enemy: Enemy, forcedCrit = false): void =>
  hitWithPayload(ctx, enemy, signaturePayload(ctx), 0, 1, null, null, forcedCrit, 0, -1);

const isEffectHit = (event: SimEvent): event is HitEvent =>
  event.type === 'hit' && (event.tags & TAG.trigger) !== 0;

const isEmitterHit = (event: SimEvent): event is HitEvent =>
  event.type === 'hit' && (event.tags & TAG.trigger) === 0;

/** The ticks (1-based) of the events that pass `test`, once per event. */
const ticksOf = (ticks: readonly (readonly SimEvent[])[], test: (e: SimEvent) => boolean) =>
  ticks.flatMap((events, i) => events.filter(test).map(() => i + 1));

/** The indices of the build's triggers on `event`, in order. */
const listening = (ctx: RunContext, event: number): number[] => [
  ...(ctx.build.triggersOn[event] as Int32Array),
];

/** The queued entries' effect, origin and position, oldest first. */
function queued(ctx: RunContext): { effect: number; origin: number; x: number; y: number }[] {
  const q = ctx.effectQueue;
  return Array.from({ length: q.size }, (_, n) => {
    const at = (q.head + n) & q.capMask;
    return {
      effect: q.effect[at] as number,
      origin: q.origin[at] as number,
      x: q.x[at] as number,
      y: q.y[at] as number,
    };
  });
}

/** One triangle that any hit kills and one immortal square, both standing still. */
const triangleAndSquare = (): GameData =>
  makeTestData({
    enemies: { triangle: { speed: 0, hpMult: 1e-9 }, square: { speed: 0, hpMult: 1e12 } },
    waves: {
      rules: [
        { enemy: 'triangle', fromWave: 1, base: 1, perWave: 0, maxCount: 1 },
        { enemy: 'square', fromWave: 1, base: 1, perWave: 0, maxCount: 1 },
      ],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    },
  });

const NO_ROLLS = { critChance: 0, igniteChance: 0, projectileCount: 1 } as const;

describe('hit triggers', () => {
  it('fires a crit trigger on a lethal crit of a one-hit triangle; its explode hits a neighbour (A8)', () => {
    const stats = makeStats(
      NO_ROLLS,
      [],
      center({ on: 'crit', do: [{ kind: 'explode', radius: 60, damagePct: 0.5 }] }),
    );
    const ctx = spawned(stats, triangleAndSquare());
    const triangle = ctx.enemies.find((enemy) => enemy.type === 'triangle') as Enemy;
    const square = ctx.enemies.find((enemy) => enemy.type === 'square') as Enemy;
    square.x = triangle.x + 30;
    square.y = triangle.y;
    rebuildGrid(ctx);
    emitterHit(ctx, triangle, true);
    expect(triangle.alive).toBe(false);
    expect(queued(ctx)).toEqual([
      { effect: 0, origin: listening(ctx, EVENT.crit)[0], x: triangle.x, y: triangle.y },
    ]);
    runEffectQueue(ctx);
    const hits = eventsOf([ctx.events], 'hit');
    expect(hits.map((hit) => [hit.targetId, hit.crit, hit.tags])).toEqual([
      [triangle.id, true, TAG.hit | TAG.projectile | TAG.crit],
      [square.id, false, TAG.hit | TAG.trigger | TAG.area],
    ]);
    expect(hits[1]?.amount).toBe(mul(num(stats.values.damage), 0.5));
  });

  /** Two hit triggers, A (cold) and B (lightning, outer.lightning), on one immortal square. */
  function pingPong(): { ctx: RunContext; target: Enemy } {
    const explode = (element: 'cold' | 'lightning'): TriggerSpec => ({
      on: 'hit',
      do: [{ kind: 'explode', radius: 5000, damagePct: 0.1, element }],
    });
    const stats = makeStats(NO_ROLLS, [], {
      triggers: [
        { source: 'center', spec: explode('cold') },
        { source: 'outer.lightning', spec: explode('lightning') },
      ],
      conversions: [],
    });
    const ctx = spawned(stats, stationarySquares(1));
    return { ctx, target: ctx.enemies[0] as Enemy };
  }

  const elementOf = (hit: HitEvent): string =>
    (hit.tags & TAG.cold) !== 0 ? 'cold' : (hit.tags & TAG.lightning) !== 0 ? 'lightning' : '-';

  it('runs effects first in, first out across sources; effects queued meanwhile join the tail', () => {
    const { ctx, target } = pingPong();
    emitterHit(ctx, target);
    const [a, b] = listening(ctx, EVENT.hit);
    expect(queued(ctx).map((entry) => entry.origin)).toEqual([a, b]);
    runEffectQueue(ctx);
    const hits = eventsOf([ctx.events], 'hit').filter(isEffectHit);
    // A1 B1 | B2 (A1's hit) A2 (B1's) | A3 (B2's) B3 (A2's).
    expect(hits.map(elementOf)).toEqual([
      'cold',
      'lightning',
      'lightning',
      'cold',
      'cold',
      'lightning',
    ]);
    const outer = ctx.build.sources.index('outer.lightning');
    expect(hits.map((hit) => hit.source)).toEqual([0, outer, outer, 0, 0, outer]);
    expect(ctx.counters.effectsRun).toBe(6);
    expect(ctx.effectQueue.size).toBe(0);
  });

  it('runs a depth-3 effect but raises nothing from it, counting the event (MAX_DEPTH)', () => {
    const { ctx, target } = pingPong();
    emitterHit(ctx, target);
    runEffectQueue(ctx);
    // A3 and B3 hit at depth 3: their hit events reach no trigger.
    expect(ctx.counters.triggerDepthCapped).toBe(2);
    expect(eventsOf([ctx.events], 'hit').filter(isEffectHit)).toHaveLength(6);
  });

  it('never fires a trigger on its own damage (rule 3), while A → B → A works', () => {
    const stats = makeStats(
      NO_ROLLS,
      [],
      center({ on: 'hit', do: [{ kind: 'explode', radius: 5000, damagePct: 0.1 }] }),
    );
    const ctx = spawned(stats, stationarySquares(1));
    emitterHit(ctx, ctx.enemies[0] as Enemy);
    runEffectQueue(ctx);
    expect(eventsOf([ctx.events], 'hit').filter(isEffectHit)).toHaveLength(1);
    expect(ctx.counters.effectsRun).toBe(1);
    expect(ctx.counters.triggerDepthCapped).toBe(0);
    // With a second trigger the chain alternates, A1 → B2 → A3 (the depth test above).
    const { ctx: two, target } = pingPong();
    emitterHit(two, target);
    runEffectQueue(two);
    expect(two.counters.effectsRun).toBe(6);
  });

  it('counts every Nth attack for nthAttack, at the attack target', () => {
    const stats = makeStats(
      { ...NO_ROLLS, damage: 1e-6, attackSpeed: 4 },
      [],
      center({ on: 'nthAttack', every: 3, do: [{ kind: 'explode', radius: 1, damagePct: 0.01 }] }),
    );
    const { ticks } = run(makeConfig({ stats, maxTicks: 600 }), stationarySquares(4));
    const attacks = ticksOf(ticks, (event) => event.type === 'attack');
    expect(attacks.length).toBeGreaterThan(30);
    // Each fires at its attack's first target, hit in the same tick's effect phase.
    expect(ticksOf(ticks, isEffectHit)).toEqual(attacks.filter((_, i) => i % 3 === 2));
  });

  it('waits out cooldownSec after each firing', () => {
    const stats = makeStats(
      { ...NO_ROLLS, damage: 1e-6, attackSpeed: 5 },
      [],
      center({
        on: 'hit',
        when: [{ cooldownSec: 1 }],
        do: [{ kind: 'explode', radius: 1, damagePct: 0.01 }],
      }),
    );
    const { ticks } = run(makeConfig({ stats, maxTicks: 900 }), stationarySquares(3));
    const fired: number[] = [];
    let readyAt = 0;
    for (const tick of ticksOf(ticks, isEmitterHit)) {
      if (tick < readyAt) continue;
      fired.push(tick);
      readyAt = tick + 60;
    }
    expect(fired.length).toBeGreaterThan(10);
    expect(ticksOf(ticks, isEffectHit)).toEqual(fired);
  });

  it('rolls chance on the trigger stream, leaving every combat draw unchanged', () => {
    const values = { damage: 1, critChance: 0.3, igniteChance: 0.5, projectileCount: 1 };
    const data = stationarySquares(3);
    const heal = center({
      on: 'hit',
      when: [{ chance: 0.5 }],
      do: [{ kind: 'heal', lifePct: 0.01 }],
    });
    const plain = run(makeConfig({ stats: makeStats(values), maxTicks: 600 }), data);
    const withTrigger = run(
      makeConfig({ stats: makeStats(values, [], heal), maxTicks: 600 }),
      data,
    );
    // Healing a player at full life changes nothing: the runs are the same event for event.
    expect(withTrigger.ticks).toEqual(plain.ticks);
    const hits = eventsOf(plain.ticks, 'hit');
    expect(hits.some((hit) => hit.crit)).toBe(true);
    const stream = createStreams(1).trigger;
    const expected = hits.filter(() => stream.chance(0.5)).length;
    expect(withTrigger.result.counters.effectsRun).toBe(expected);
    expect(expected).toBeGreaterThan(hits.length * 0.3);
    expect(expected).toBeLessThan(hits.length * 0.7);
  });
});

describe('kill triggers', () => {
  /** A TestModule recording each kill's origin, depth, flags and victim state. */
  function killLog() {
    const kills: {
      tick: number;
      origin: number;
      depth: number;
      flags: number;
      ailDepth: number;
      killKind: number;
    }[] = [];
    let build: RunContext['build'] | null = null;
    const module: TestModule = (b) =>
      b.hook('onKill', (ctx, victim, kill) => {
        build = ctx.build;
        kills.push({
          tick: ctx.now,
          origin: kill.origin,
          depth: kill.depth,
          flags: kill.flags,
          ailDepth: victim.ailDepth,
          killKind: victim.killKind,
        });
      });
    return { kills, module, build: () => build as unknown as RunContext['build'] };
  }

  it('never fires an explode-on-kill trigger on the kills of its own explosions', () => {
    const stats = makeStats(
      { ...NO_ROLLS, damage: 1e6, attackSpeed: 1 },
      [],
      center({ on: 'kill', do: [{ kind: 'explode', radius: 5000, damagePct: 1 }] }),
    );
    const log = killLog();
    const { result } = run(makeConfig({ stats, maxTicks: 600 }), stationarySquares(12, 1), [
      log.module,
    ]);
    const trigger = (log.build().triggersOn[EVENT.kill] as Int32Array)[0];
    const byEmitter = log.kills.filter((kill) => kill.origin === -1);
    const byExplosion = log.kills.filter((kill) => kill.origin === trigger);
    expect(byEmitter.length).toBeGreaterThan(1);
    expect(byExplosion.length).toBeGreaterThan(10);
    expect(byEmitter.length + byExplosion.length).toBe(result.kills);
    // Each explosion came from an emitter kill; none from its own kills.
    expect(result.counters.effectsRun).toBe(
      byEmitter.filter((kill) => kill.tick < result.ticks).length,
    );
  });

  it('fires a signatureOnly kill trigger on the signature attack’s kills only (A7)', () => {
    const stats = makeStats(
      { ...NO_ROLLS, damage: 1e6, attackSpeed: 2 },
      [],
      center({
        on: 'kill',
        when: [{ hitIs: 'signature' }],
        do: [{ kind: 'heal', lifePct: 0.01 }],
      }),
    );
    const log = killLog();
    let novas = 0;
    // Every 2 s a module nova, which carries no SIGNATURE, kills everything on the field.
    const nova: TestModule = (b) => {
      const fx = b.addEffect('center', { kind: 'nova', radius: 5000, damagePct: 1 });
      const index = b.hook('tick', (ctx) => {
        if (ctx.now % 120 !== 0) return;
        novas++;
        const { x, y } = ctx.player;
        enqueueModuleEffect(ctx, index, fx, { depth: 0, origin: -1, x, y, flags: 0 });
      });
    };
    const { result } = run(makeConfig({ stats, maxTicks: 600 }), stationarySquares(12, 1), [
      log.module,
      nova,
    ]);
    const signature = log.kills.filter((kill) => (kill.flags & SIGNATURE) !== 0);
    const others = log.kills.filter((kill) => (kill.flags & SIGNATURE) === 0);
    expect(signature.length).toBeGreaterThan(5);
    expect(others.length).toBeGreaterThan(5);
    expect(others.every((kill) => kill.origin >= 0 && (kill.flags & HIT_EVENT) !== 0)).toBe(true);
    const fired = signature.filter((kill) => kill.tick < result.ticks).length;
    expect(result.counters.effectsRun).toBe(novas + fired);
  });

  it('gives DoT kills origin −1, the victim’s ailDepth and killKind burn', () => {
    const burnOnly = center({
      on: 'kill',
      when: [{ killedBy: 'burn' }],
      do: [{ kind: 'heal', lifePct: 0.01 }],
    });
    // Hits deal almost nothing; burns make every kill.
    const dot = makeStats(
      {
        damage: 1e-3,
        attackSpeed: 0.5,
        critChance: 0,
        igniteChance: 1,
        burnDamage: 1e9,
        burnDuration: 4,
      },
      [],
      burnOnly,
    );
    const log = killLog();
    const { result } = run(makeConfig({ stats: dot, maxTicks: 600 }), stationarySquares(3, 1), [
      log.module,
    ]);
    expect(log.kills.length).toBeGreaterThanOrEqual(3);
    for (const kill of log.kills) {
      expect(kill).toMatchObject({ origin: -1, depth: 0, ailDepth: 0, killKind: KILL_BY_BURN });
      expect(kill.flags & (killKindFlag('burn') | HIT_EVENT)).toBe(killKindFlag('burn'));
    }
    const fired = log.kills.filter((kill) => kill.tick < result.ticks).length;
    expect(result.counters.effectsRun).toBe(fired);

    // The same trigger never fires on hit kills.
    const hits = makeStats({ ...NO_ROLLS, damage: 1e6 }, [], burnOnly);
    const hitLog = killLog();
    const hitRun = run(makeConfig({ stats: hits, maxTicks: 600 }), stationarySquares(3, 1), [
      hitLog.module,
    ]);
    expect(hitRun.result.kills).toBeGreaterThanOrEqual(3);
    expect(hitLog.kills.every((kill) => kill.killKind === KILL_BY_HIT)).toBe(true);
    expect(hitRun.result.counters.effectsRun).toBe(0);
  });

  it('carries the depth of the effect that applied a burn to its DoT kill (D5)', () => {
    // Hits never ignite; a hit trigger's applyAilment applies every burn, at depth 1.
    const stats = makeStats(
      {
        damage: 1e-3,
        attackSpeed: 0.5,
        critChance: 0,
        igniteChance: 0,
        burnDamage: 1e9,
        burnDuration: 4,
      },
      [],
      center({ on: 'hit', do: [{ kind: 'applyAilment', ailment: 'burn' }] }),
    );
    const log = killLog();
    run(makeConfig({ stats, maxTicks: 600 }), stationarySquares(3, 1), [log.module]);
    expect(log.kills.length).toBeGreaterThanOrEqual(3);
    for (const kill of log.kills) {
      expect(kill).toMatchObject({ origin: -1, depth: 1, ailDepth: 1, killKind: KILL_BY_BURN });
    }
  });

  it('reads victimHas burn from live records: a record that ended this tick does not count', () => {
    const stats = makeStats(
      {},
      [],
      center(
        { on: 'kill', when: [{ victimHas: 'burn' }], do: [{ kind: 'heal', lifePct: 0.01 }] },
        { on: 'diedWithAilment', do: [{ kind: 'heal', lifePct: 0.01 }] },
      ),
    );
    const ctx = spawned(stats, stationarySquares(3, 1));
    const [ended, burning, expired] = ctx.enemies as [Enemy, Enemy, Enemy];
    addBurn(ctx, ended, num(1), 31, 0);
    addBurn(ctx, burning, num(1), 61, 0);
    addBurn(ctx, expired, num(1), 31, 0);
    ctx.now = 31;
    // One record ended now but is still listed; the other has moved into burnPending.
    expireBurns(ctx, expired);
    expect(ended.burns).toHaveLength(1);
    expect(expired.burns).toHaveLength(0);
    expect(gt(expired.burnPending, ZERO)).toBe(true);
    for (const victim of [ended, burning, expired]) {
      victim.killKind = KILL_BY_BURN;
      killEnemy(ctx, victim, -1, 0);
    }
    const [onKill] = listening(ctx, EVENT.kill);
    const [onDied] = listening(ctx, EVENT.diedWithAilment);
    // diedWithAilment is recorded for the burning victim only; kill for all three.
    expect(
      ctx.pendingKills.slice(0, ctx.pendingCount).map((e) => [e.victim.id, e.trigger]),
    ).toEqual([
      [ended.id, onKill],
      [burning.id, onKill],
      [burning.id, onDied],
      [expired.id, onKill],
    ]);
    dispatchPendingKills(ctx);
    expect(queued(ctx).map((entry) => [entry.x, entry.origin])).toEqual([
      [burning.x, onKill],
      [burning.x, onDied],
    ]);
  });

  it('adds gainShards’ fraction of the victim’s drop, carried by its pending kill', () => {
    const stats = makeStats(
      {},
      [],
      center(
        { on: 'kill', do: [{ kind: 'gainShards', fraction: 0.5 }] },
        { on: 'kill', do: [{ kind: 'heal', lifePct: 0.01 }] },
      ),
    );
    const ctx = spawned(stats, stationarySquares(1, 1));
    const victim = ctx.enemies[0] as Enemy;
    const before = ctx.state.shards;
    killEnemy(ctx, victim, -1, 0);
    const drop = eventsOf([ctx.events], 'enemyKilled')[0]?.shards ?? ZERO;
    expect(gt(drop, ZERO)).toBe(true);
    expect(ctx.state.shards).toBe(add(before, drop));
    const [gain, heal] = listening(ctx, EVENT.kill);
    expect(ctx.pendingKills.slice(0, ctx.pendingCount).map((e) => [e.trigger, e.value])).toEqual([
      [gain, drop],
      [heal, ZERO],
    ]);
    dispatchPendingKills(ctx);
    runEffectQueue(ctx);
    expect(ctx.state.shards).toBe(add(add(before, drop), mul(drop, 0.5)));
  });

  it('dispatches pending kills sorted by victim id, then trigger index', () => {
    const explode = (element: 'cold' | 'lightning'): TriggerSpec => ({
      on: 'kill',
      do: [{ kind: 'explode', radius: 1, damagePct: 0.01, element }],
    });
    const stats = makeStats({}, [], center(explode('cold'), explode('lightning')));
    const ctx = spawned(stats, stationarySquares(3, 1));
    const [a, b, c] = ctx.enemies as [Enemy, Enemy, Enemy];
    for (const victim of [c, a, b]) killEnemy(ctx, victim, -1, 0);
    const [first, second] = listening(ctx, EVENT.kill);
    expect(ctx.pendingKills.slice(0, ctx.pendingCount).map((e) => e.victim.id)).toEqual([
      c.id,
      c.id,
      a.id,
      a.id,
      b.id,
      b.id,
    ]);
    dispatchPendingKills(ctx);
    expect(ctx.pendingCount).toBe(0);
    expect(queued(ctx).map((entry) => [entry.x, entry.y, entry.origin])).toEqual(
      [a, a, b, b, c, c].map((victim, n) => [victim.x, victim.y, n % 2 === 0 ? first : second]),
    );
  });

  it('has split return the range of the children it appended (kill step 2)', () => {
    const data = makeTestData({
      enemies: { pentagon: { speed: 0 }, square: { speed: 0 } },
      waves: {
        rules: [
          { enemy: 'pentagon', fromWave: 1, base: 1, perWave: 0, maxCount: 1 },
          { enemy: 'square', fromWave: 1, base: 1, perWave: 0, maxCount: 1 },
        ],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
      },
    });
    const ctx = spawned(makeStats(), data);
    const pentagon = ctx.enemies.find((enemy) => enemy.type === 'pentagon') as Enemy;
    const square = ctx.enemies.find((enemy) => enemy.type === 'square') as Enemy;
    const before = ctx.enemies.length;
    const start = split(ctx, pentagon);
    expect(start).toBe(before);
    expect(ctx.enemies.slice(start).map((enemy) => enemy.type)).toEqual([
      'shard',
      'shard',
      'shard',
    ]);
    expect(split(ctx, square)).toBe(ctx.enemies.length);
  });

  it('runs pending kills’ effects in the next tick', () => {
    const stats = makeStats(
      { ...NO_ROLLS, damage: 1e6, attackSpeed: 1 },
      [],
      center({ on: 'kill', do: [{ kind: 'explode', radius: 5000, damagePct: 1e-12 }] }),
    );
    const { ticks } = run(makeConfig({ stats, maxTicks: 300 }), stationarySquares(6, 1));
    const kills = ticksOf(ticks, (event) => event.type === 'enemyKilled');
    const explosions = ticksOf(ticks, isEffectHit);
    expect(kills.length).toBeGreaterThan(2);
    expect(explosions[0]).toBe((kills[0] as number) + 1);
    // Every explosion's tick follows a kill's.
    for (const tick of explosions) expect(kills).toContain(tick - 1);
  });

  it('transfers burns at the kill exactly as M1 pandemic’s spread did (inline transfer)', () => {
    // Recorded from M1 pandemic ({spreadRadius 250, spreadEffect 0.4, hitMore 0}) on this seed,
    // data and stats at C3.6's parent; the data trigger below must replay it event for event.
    const stats = makeStats(
      {
        damage: 0.01,
        attackSpeed: 2,
        projectileCount: 2,
        critChance: 0,
        igniteChance: 1,
        burnDamage: 300,
        burnDuration: 3,
        burnMaxStacks: 5,
      },
      [],
      center({
        on: 'diedWithAilment',
        when: [{ victimHas: 'burn' }],
        do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 250, effect: 0.4 }],
      }),
    );
    const sim = createSimulation(
      makeConfig({ seed: 7, stats, maxTicks: 900 }),
      stationarySquares(40, 4),
    );
    const hash = createHash('sha256');
    const counts: Record<string, number> = {};
    const spreads: [number, number, number][] = [];
    while (!sim.state.finished) {
      const events = sim.step(NO_INPUT);
      for (const event of events) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        if (event.type === 'burnSpread')
          spreads.push([sim.state.tick, event.enemyId, event.targets]);
      }
      hash.update(JSON.stringify(events));
    }
    const result = sim.result();
    expect(counts).toEqual({
      waveStarted: 1,
      enemySpawned: 40,
      attack: 60,
      hit: 56,
      ignite: 225,
      burnTick: 288,
      burnSpread: 19,
      enemyKilled: 19,
      runEnded: 1,
    });
    expect(spreads).toEqual([
      [225, 2, 3],
      [225, 4, 2],
      [315, 38, 4],
      [315, 39, 3],
      [390, 15, 1],
      [390, 19, 0],
      [495, 8, 1],
      [510, 17, 7],
      [555, 22, 6],
      [555, 29, 5],
      [630, 5, 4],
      [660, 9, 0],
      [690, 26, 3],
      [705, 20, 3],
      [750, 34, 4],
      [765, 25, 3],
      [795, 21, 2],
      [855, 16, 1],
      [885, 14, 0],
    ]);
    expect(hash.digest('hex').slice(0, 16)).toBe('1327e1c24d33ed46');
    // No spread was cut short by the depth limit; transfers never go through the queue.
    expect(result.counters.triggerDepthCapped).toBe(0);
    expect(result.counters.effectsRun).toBe(0);
  });
});

describe('the effect queue', () => {
  /** An explode of radius 1 the tests queue by hand at an enemy, hitting only that enemy. */
  function withExplode(count: number): { ctx: RunContext; fx: number } {
    let fx = -1;
    const module: TestModule = (b) => {
      fx = b.addEffect('center', { kind: 'explode', radius: 1, damagePct: 0.01 });
    };
    const ctx = spawned(makeStats(NO_ROLLS), stationarySquares(count), [module]);
    return { ctx, fx };
  }

  it('runs 5,000 entries as 2,000 + 2,000 + 1,000, in order, with counters', () => {
    const { ctx, fx } = withExplode(50);
    const enemies = ctx.enemies.slice();
    const at = (i: number): Enemy => enemies[i % enemies.length] as Enemy;
    for (let i = 0; i < 5000; i++) enqueue(ctx, fx, 1, -1, 0, null, at(i).x, at(i).y, ZERO, 0);
    expect(ctx.counters.effectQueuePeak).toBe(5000);
    const counters = ctx.counters;
    const phases = [0, 1, 2, 3].map(() => {
      ctx.events.length = 0;
      runEffectQueue(ctx);
      return {
        hits: eventsOf([ctx.events], 'hit').map((hit) => hit.targetId),
        left: ctx.effectQueue.size,
        run: counters.effectsRun,
        budgetTicks: counters.effectBudgetTicks,
        deferred: counters.effectsDeferred,
      };
    });
    const ids = (from: number, to: number): number[] =>
      Array.from({ length: to - from }, (_, n) => at(from + n).id);
    expect(EFFECTS_PER_TICK).toBe(2000);
    expect(phases).toEqual([
      { hits: ids(0, 2000), left: 3000, run: 2000, budgetTicks: 1, deferred: 3000 },
      { hits: ids(2000, 4000), left: 1000, run: 4000, budgetTicks: 2, deferred: 4000 },
      { hits: ids(4000, 5000), left: 0, run: 5000, budgetTicks: 2, deferred: 4000 },
      { hits: [], left: 0, run: 5000, budgetTicks: 2, deferred: 4000 },
    ]);
    expect(counters.effectBudgetStreakMax).toBe(2);
  });

  it('drops and counts the newest entries at the hard cap', () => {
    const { ctx, fx } = withExplode(1);
    for (let i = 0; i < EFFECT_QUEUE_HARD_CAP + 10; i++) {
      enqueue(ctx, fx, 1, -1, 0, null, i, 0, ZERO, 0);
    }
    expect(ctx.effectQueue.size).toBe(EFFECT_QUEUE_HARD_CAP);
    expect(ctx.counters.effectsDropped).toBe(10);
    expect(ctx.counters.effectQueuePeak).toBe(EFFECT_QUEUE_HARD_CAP);
    const entries = queued(ctx);
    expect(entries[0]?.x).toBe(0);
    expect(entries.at(-1)?.x).toBe(EFFECT_QUEUE_HARD_CAP - 1);
  });

  it('tells budget streaks of 1 and 2 apart at equal budget ticks (A26)', () => {
    let fx = -1;
    const module: TestModule = (b) => {
      fx = b.addEffect('center', { kind: 'heal', lifePct: 0.01 });
    };
    const queue = (ctx: RunContext, count: number): void => {
      for (let i = 0; i < count; i++) enqueue(ctx, fx, 1, -1, 0, null, 0, 0, ZERO, 0);
    };
    const ones = spawned(makeStats(), stationarySquares(1), [module]);
    for (let round = 0; round < 2; round++) {
      queue(ones, EFFECTS_PER_TICK + 1);
      runEffectQueue(ones);
      runEffectQueue(ones);
    }
    const twos = spawned(makeStats(), stationarySquares(1), [module]);
    queue(twos, 2 * EFFECTS_PER_TICK + 1);
    for (let tick = 0; tick < 3; tick++) runEffectQueue(twos);
    expect(ones.counters.effectBudgetTicks).toBe(2);
    expect(twos.counters.effectBudgetTicks).toBe(2);
    expect(ones.counters.effectBudgetStreakMax).toBe(1);
    expect(twos.counters.effectBudgetStreakMax).toBe(2);
  });
});

describe('periodic and targetless events', () => {
  it('fires an 8 s and a 5 s periodic trigger each at its own interval (A27)', () => {
    const nova = (every: number, element: 'cold' | 'lightning'): TriggerSpec => ({
      on: 'periodic',
      every,
      do: [{ kind: 'nova', radius: 5000, damagePct: 0.01, element }],
    });
    const stats = makeStats(
      { ...NO_ROLLS, damage: 1e-6 },
      [],
      center(nova(8, 'cold'), nova(5, 'lightning')),
    );
    const { ticks } = run(makeConfig({ stats, maxTicks: 1800 }), stationarySquares(1));
    const fired = (tag: number): number[] =>
      ticksOf(ticks, (event) => isEffectHit(event) && (event.tags & tag) !== 0);
    // The first firing is staggered by trigger index: period + index mod period.
    const [eight, five] = compileBuild(stats, []).triggers as [CompiledTrigger, CompiledTrigger];
    expect([eight.periodTicks, five.periodTicks]).toEqual([480, 300]);
    const expected = (t: CompiledTrigger): number[] => {
      const out: number[] = [];
      for (
        let tick = t.periodTicks + (t.index % t.periodTicks);
        tick <= 1800;
        tick += t.periodTicks
      ) {
        out.push(tick);
      }
      return out;
    };
    expect(fired(TAG.cold)).toEqual(expected(eight));
    expect(fired(TAG.lightning)).toEqual(expected(five));
    expect(fired(TAG.cold)).toHaveLength(3);
    expect(fired(TAG.lightning)).toHaveLength(5);
  });

  it('fires waveStart once per started wave, at the player after its enemies are released', () => {
    const stats = makeStats(
      { ...NO_ROLLS, damage: 1e-6, maxLife: 1e12 },
      [],
      center({ on: 'waveStart', do: [{ kind: 'nova', radius: 5000, damagePct: 0.01 }] }),
    );
    const { ticks, result } = run(
      makeConfig({ stats, maxTicks: 600 }),
      makeTestData({ waves: { waveTimerSec: 2, spawnDurationSec: 0 } }),
    );
    const waves = ticksOf(ticks, (event) => event.type === 'waveStarted');
    expect(waves.length).toBeGreaterThan(3);
    expect(result.counters.effectsRun).toBe(waves.length);
    // Every enemy the wave released is hit by its nova in the same tick.
    for (const tick of waves) {
      const events = ticks[tick - 1] as SimEvent[];
      const spawnedIds = eventsOf([events], 'enemySpawned').map((event) => event.enemyId);
      const novaTargets = events.filter(isEffectHit).map((hit) => hit.targetId);
      expect(novaTargets).toEqual(expect.arrayContaining(spawnedIds));
    }
  });

  it('fires heroHit without a target once per touch, and heals before the next one', () => {
    const values = { ...NO_ROLLS, damage: 1e-9, maxLife: 200 };
    const heal = center({ on: 'heroHit', do: [{ kind: 'heal', lifePct: 1 }] });
    const data = makeTestData();
    const plain = run(makeConfig({ stats: makeStats(values), maxTicks: 1200 }), data);
    const healed = run(makeConfig({ stats: makeStats(values, [], heal), maxTicks: 1200 }), data);
    expect(plain.result.endReason).toBe('death');
    expect(healed.result.endReason).toBe('timeout');
    const touches = eventsOf(healed.ticks, 'playerHit');
    expect(touches.length).toBeGreaterThan(10);
    expect(healed.result.counters.effectsRun).toBe(touches.length);
  });

  it('fires contact on the touching enemy, whose target conditions it checks', () => {
    const values = { ...NO_ROLLS, damage: 1e-9, maxLife: 1e12 };
    const onContact = (kind: 'normal' | 'boss') =>
      makeStats(
        values,
        [],
        center({
          on: 'contact',
          when: [{ targetKind: kind }],
          do: [{ kind: 'heal', lifePct: 0.01 }],
        }),
      );
    const data = makeTestData();
    const normal = run(makeConfig({ stats: onContact('normal'), maxTicks: 900 }), data);
    const boss = run(makeConfig({ stats: onContact('boss'), maxTicks: 900 }), data);
    const touches = eventsOf(normal.ticks, 'playerHit');
    expect(touches.length).toBeGreaterThan(10);
    expect(normal.result.counters.effectsRun).toBe(touches.length);
    expect(boss.result.counters.effectsRun).toBe(0);
  });
});

describe('calibration coefficients (A19)', () => {
  const chanceTrigger = (chance: number): TriggerSpec => ({
    on: 'hit',
    when: [{ chance }],
    do: [{ kind: 'explode', radius: 1, damagePct: 0.5 }],
  });

  it('multiplies the chance and the damage fields, clamping the chance to 1', () => {
    const build = compileBuild(makeStats(), [], undefined, [
      (b) => {
        b.addTrigger('center', chanceTrigger(0.4), 0.5);
        b.addTrigger('center', chanceTrigger(0.4), 4);
      },
    ]);
    const [half, clamped] = build.triggers as [CompiledTrigger, CompiledTrigger];
    expect([half.chance, half.coef, clamped.chance, clamped.coef]).toEqual([0.2, 0.5, 1, 4]);
    expect(build.effects[half.effectStart]?.spec).toMatchObject({ damagePct: 0.25 });
    expect(build.effects[clamped.effectStart]?.spec).toMatchObject({ damagePct: 2 });
  });

  it('halves the firings with coef 0.5, rolled on the trigger stream', () => {
    const stats = makeStats({ ...NO_ROLLS, damage: 1e-6 });
    const halved: TestModule = (b) => b.addTrigger('center', chanceTrigger(0.4), 0.5);
    const { ticks } = run(makeConfig({ stats, maxTicks: 900 }), stationarySquares(3), [halved]);
    const stream = createStreams(1).trigger;
    const expected = ticksOf(ticks, isEmitterHit).filter(() => stream.chance(0.2));
    expect(expected.length).toBeGreaterThan(5);
    expect(ticksOf(ticks, isEffectHit)).toEqual(expected);
  });

  it('draws nothing for a chance clamped to 1 by coef 4', () => {
    const stats = makeStats({ ...NO_ROLLS, damage: 1e-6 });
    const probe = chanceTrigger(0.5);
    const always: TriggerSpec = { on: 'hit', do: [{ kind: 'heal', lifePct: 0.01 }] };
    const clamped: TestModule = (b) => {
      b.addTrigger('center', { ...always, when: [{ chance: 0.4 }] }, 4);
      b.addTrigger('center', probe);
    };
    const plain: TestModule = (b) => {
      b.addTrigger('center', always);
      b.addTrigger('center', probe);
    };
    const config = makeConfig({ stats, maxTicks: 900 });
    const a = run(config, stationarySquares(3), [clamped]);
    const b = run(config, stationarySquares(3), [plain]);
    expect(a.ticks).toEqual(b.ticks);
    expect(a.result.counters.effectsRun).toBe(b.result.counters.effectsRun);
    expect(ticksOf(a.ticks, isEffectHit).length).toBeGreaterThan(5);
  });
});

describe('rule module hooks', () => {
  it('shares one trigger index across an instance’s hooks and skips its own damage (D6)', () => {
    let first = -1;
    let other = -1;
    const origins: number[] = [];
    const seenByOther: number[] = [];
    const queueing: TestModule = (b) => {
      const fx = b.addEffect('center', { kind: 'explode', radius: 1, damagePct: 0.01 });
      first = b.hook('onHit', (ctx, hit) => {
        origins.push(hit.origin);
        enqueueModuleEffect(ctx, first, fx, hit);
      });
      expect(b.hook('onKill', () => {})).toBe(first);
    };
    const watching: TestModule = (b) => {
      other = b.hook('onHit', (_ctx, hit) => {
        seenByOther.push(hit.origin);
      });
    };
    const stats = makeStats({ ...NO_ROLLS, damage: 1e-6 });
    const { ticks, result } = run(makeConfig({ stats, maxTicks: 600 }), stationarySquares(3), [
      queueing,
      watching,
    ]);
    expect(other).not.toBe(first);
    const emitterHits = eventsOf(ticks, 'hit').filter(isEmitterHit).length;
    const effectHits = eventsOf(ticks, 'hit').filter(isEffectHit).length;
    expect(emitterHits).toBeGreaterThan(10);
    // One explosion per emitter hit; none from the explosions' own hits.
    expect(effectHits).toBe(emitterHits);
    expect(result.counters.effectsRun).toBe(emitterHits);
    expect(origins.filter((origin) => origin === -1)).toHaveLength(emitterHits);
    expect(origins.filter((origin) => origin === first)).toHaveLength(effectHits);
    expect(seenByOther).toEqual(origins);
  });

  it('calls onHit on a lethal hit with KILLED, before the kill', () => {
    const calls: { killed: boolean; alive: boolean; dead: boolean; reported: boolean }[] = [];
    const module: TestModule = (b) =>
      b.hook('onHit', (ctx, hit) => {
        calls.push({
          killed: (hit.flags & KILLED) !== 0,
          alive: hit.target.alive,
          dead: lte(hit.target.hp, ZERO),
          reported: ctx.events.some(
            (event) => event.type === 'enemyKilled' && event.enemyId === hit.target.id,
          ),
        });
      });
    const stats = makeStats({ ...NO_ROLLS, damage: 1e6 });
    const { result } = run(makeConfig({ stats, maxTicks: 600 }), stationarySquares(5, 1), [module]);
    expect(result.kills).toBeGreaterThanOrEqual(5);
    expect(calls).toHaveLength(result.kills);
    for (const call of calls) {
      expect(call).toEqual({ killed: true, alive: true, dead: true, reported: false });
    }
  });

  it('calls onHit on a surviving hit after its ailments, with the dealt amount', () => {
    const calls: { killed: boolean; burns: number; amount: number }[] = [];
    const module: TestModule = (b) =>
      b.hook('onHit', (_ctx, hit) => {
        calls.push({
          killed: (hit.flags & KILLED) !== 0,
          burns: hit.target.burns.length,
          amount: hit.amount,
        });
      });
    const stats = makeStats({ critChance: 0, igniteChance: 1, projectileCount: 1 });
    const { ticks } = run(makeConfig({ stats, maxTicks: 300 }), stationarySquares(3), [module]);
    const hits = eventsOf(ticks, 'hit');
    expect(hits.length).toBeGreaterThan(10);
    expect(calls.map((call) => call.amount)).toEqual(hits.map((hit) => hit.amount));
    for (const call of calls) {
      expect(call.killed).toBe(false);
      expect(call.burns).toBeGreaterThan(0);
    }
  });

  it('lets modifyDamage double crit hits while their burns keep the damage before it', () => {
    const doubleCrits: TestModule = (b) =>
      b.hook('modifyDamage', (_ctx, hit, amount) => (hit.crit ? mul(amount, 2) : amount));
    const stats = makeStats({
      damage: 1,
      critChance: 0.5,
      igniteChance: 0.5,
      projectileCount: 1,
      burnDuration: 2,
    });
    const config = makeConfig({ stats, maxTicks: 600 });
    const plain = run(config, stationarySquares(3));
    const doubled = run(config, stationarySquares(3), [doubleCrits]);
    const before = eventsOf(plain.ticks, 'hit');
    const after = eventsOf(doubled.ticks, 'hit');
    expect(before.some((hit) => hit.crit)).toBe(true);
    expect(before.some((hit) => !hit.crit)).toBe(true);
    expect(after.map((hit) => (hit.crit ? { ...hit, amount: hit.amount / 2 } : hit))).toEqual(
      before,
    );
    expect(after.filter((hit) => hit.crit).map((hit) => hit.amount)).toEqual(
      before.filter((hit) => hit.crit).map((hit) => mul(hit.amount, 2)),
    );
    expect(eventsOf(doubled.ticks, 'ignite')).toEqual(eventsOf(plain.ticks, 'ignite'));
    expect(eventsOf(doubled.ticks, 'burnTick')).toEqual(eventsOf(plain.ticks, 'burnTick'));
  });

  it('raises center events only with SIGNATURE in their flags (rule 8)', () => {
    const seen: unknown[] = [];
    const module: TestModule = (b) =>
      b.hook('onCenterEvent', (_ctx, ev) => {
        seen.push({ ...ev });
      });
    const ctx = spawned(makeStats(), stationarySquares(1), [module]);
    const target = ctx.enemies[0] as Enemy;
    emitCenterEvent(ctx, EVENT.chainJump, 1, -1, target, 5, 6, HIT_EVENT);
    expect(seen).toEqual([]);
    emitCenterEvent(ctx, EVENT.chainJump, 1, 2, target, 5, 6, HIT_EVENT | SIGNATURE);
    expect(seen).toEqual([
      {
        event: EVENT.chainJump,
        depth: 1,
        origin: 2,
        flags: HIT_EVENT | SIGNATURE,
        target,
        x: 5,
        y: 6,
      },
    ]);
  });
});

describe('determinism with triggers', () => {
  const stats = makeStats(
    { damage: 30, attackSpeed: 3, critChance: 0.3, igniteChance: 0.4, chainCount: 1, maxLife: 1e6 },
    [],
    center(
      { on: 'hit', when: [{ chance: 0.3 }], do: [{ kind: 'applyAilment', ailment: 'burn' }] },
      { on: 'kill', do: [{ kind: 'explode', radius: 120, damagePct: 0.5 }] },
      {
        on: 'diedWithAilment',
        do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 150, effect: 0.5 }],
      },
      {
        on: 'crit',
        when: [{ cooldownSec: 0.5 }],
        do: [{ kind: 'nova', radius: 200, damagePct: 0.3, at: 'event' }],
      },
      { on: 'periodic', every: 2, do: [{ kind: 'push', distance: 40, radius: 150 }] },
      { on: 'nthAttack', every: 4, do: [{ kind: 'explode', radius: 80, damagePct: 1 }] },
      { on: 'heroHit', do: [{ kind: 'heal', lifePct: 0.05 }] },
      { on: 'kill', do: [{ kind: 'gainShards', fraction: 0.1 }] },
    ),
  );
  const config = (seed: number): RunConfig =>
    makeConfig({ seed, stats, startWave: 8, maxTicks: 1500 });

  it('gives the same events for the same seed, and different ones for another seed', () => {
    const data = makeTestData();
    const a = run(config(1), data);
    const b = run(config(1), data);
    const c = run(config(2), data);
    expect(a.result.counters.effectsRun).toBeGreaterThan(100);
    expect(b.ticks).toEqual(a.ticks);
    expect(b.result).toEqual(a.result);
    expect(c.ticks).not.toEqual(a.ticks);
  });
});
