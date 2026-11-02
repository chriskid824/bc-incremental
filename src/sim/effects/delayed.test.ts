/**
 * The delayed repeats (docs/v3 C6 design §7.4 C6b.4, lead ruling E1): repeats of the signature
 * attack that wait for a tick (RunContext.sys.repeat.delayed), scheduled by scheduleRepeat in
 * queue.ts and fired by drainDelayedRepeats in execute.ts once a tick, in the emitter stage after
 * the combo step and before the emitters attack. Each test names in a comment the planted bug it
 * kills. 殘影, which feeds the list, is tested in src/sim/systems/afterimage.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { num } from '../../core/num';
import type { EmitterRuntime, Payload } from '../emitters/types';
import { createPayload, ROWS } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { RunContext } from '../systems/context';
import {
  afterimageModule,
  GOLDEN_BUILDS,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
  stationarySquares,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import { drainDelayedRepeats } from './execute';
import { REPEAT, SIGNATURE } from './flags';
import { scheduleRepeat } from './queue';

const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/** `n` standing enemies on a ring of 300 around the player, ids 1 .. n. */
const ring = (n: number): PlacedEnemy[] =>
  Array.from({ length: n }, (_, i) => ({
    x: P.x + 300 * Math.cos((2 * Math.PI * i) / n),
    y: P.y + 300 * Math.sin((2 * Math.PI * i) / n),
  }));

/** placedEnemies with M1's volley: one projectile an attack, no crits, ignites or chains. */
const volley = (placed: readonly PlacedEnemy[], modules: readonly TestModule[] = []): RunContext =>
  placedEnemies(placed, {
    stats: makeStats({
      critChance: 0,
      igniteChance: 0,
      chainCount: 0,
      projectileCount: 1,
      projectileSpeed: 120_000,
    }),
    modules,
  });

/** A repeat payload of the signature's kind, told apart from the others by `share`. */
const payloadOf = (ctx: RunContext, share: number): Payload =>
  createPayload({
    baseDamage: num(share),
    tags: (ctx.emitters[0] as EmitterRuntime).payload.tags,
    source: 0,
    flags: SIGNATURE | REPEAT,
    rng: ctx.effectsRng,
    chains: false,
    rollsAilments: false,
    canCrit: false,
    damageMode: ROWS,
  });

/** The origins of the projectiles fired since index `from`: each entry's, in firing order. */
const originsSince = (ctx: RunContext, from: number): number[] =>
  ctx.projectiles.slice(from).map((f) => f.origin);

/** Moves the run to tick `tick` and drains the list there, as step() does. */
function drainAt(ctx: RunContext, tick: number): void {
  ctx.now = tick;
  if (ctx.sys.repeat.delayed.count !== 0) drainDelayedRepeats(ctx);
}

describe('the delayed repeats (lead ruling E1)', () => {
  it('fires an entry on its due tick, not a tick early or late, with its payload, depth and origin', () => {
    // Plants the drain firing entries due on the next tick (due ≤ now + 1), and one firing only
    // past its tick (due < now).
    const ctx = volley(ring(3));
    const p = payloadOf(ctx, 3);
    scheduleRepeat(ctx, 10, p, 2, 7);
    const list = ctx.sys.repeat.delayed;
    expect([list.count, list.scheduled]).toEqual([1, 1]);
    drainAt(ctx, 9);
    expect(ctx.projectiles).toEqual([]);
    expect(list.count).toBe(1);
    drainAt(ctx, 10);
    expect(ctx.projectiles.map((f) => [f.payload === p, f.depth, f.origin, f.steady])).toEqual([
      [true, 2, 7, false],
    ]);
    expect([list.count, list.payload[0]]).toEqual([0, null]);
    drainAt(ctx, 11);
    expect(ctx.projectiles).toHaveLength(1);
  });

  it('fires two entries due on one tick in the order they were scheduled, and one scheduled later with an earlier tick first', () => {
    // Plants seq ignored: a new entry going in before the entries due on its own tick (ties
    // broken by position, after it was inserted behind a later-due one), and the list appended
    // to instead of ordered.
    const ctx = volley(ring(8));
    const p = payloadOf(ctx, 1);
    scheduleRepeat(ctx, 10, p, 0, 1);
    scheduleRepeat(ctx, 20, p, 0, 2);
    scheduleRepeat(ctx, 10, p, 0, 3);
    scheduleRepeat(ctx, 5, p, 0, 4);
    scheduleRepeat(ctx, 20, p, 0, 5);
    scheduleRepeat(ctx, 10, p, 0, 6);
    const list = ctx.sys.repeat.delayed;
    const order = Array.from({ length: list.count }, (_, n) => {
      const at = (list.head + n) & list.capMask;
      return [list.due[at], list.seq[at], list.origin[at]];
    });
    expect(order).toEqual([
      [5, 3, 4],
      [10, 0, 1],
      [10, 2, 3],
      [10, 5, 6],
      [20, 1, 2],
      [20, 4, 5],
    ]);
    drainAt(ctx, 5);
    expect(originsSince(ctx, 0)).toEqual([4]);
    drainAt(ctx, 10);
    expect(originsSince(ctx, 1)).toEqual([1, 3, 6]);
    drainAt(ctx, 20);
    expect(originsSince(ctx, 4)).toEqual([2, 5]);
    expect([list.count, list.scheduled]).toEqual([0, 6]);
  });

  it('fires every entry whose tick has come in one drain, and the late ones in order', () => {
    // Plants the drain firing one entry a call.
    const ctx = volley(ring(8));
    const p = payloadOf(ctx, 1);
    for (const [due, origin] of [
      [12, 1],
      [11, 2],
      [12, 3],
      [14, 4],
    ] as const) {
      scheduleRepeat(ctx, due, p, 0, origin);
    }
    drainAt(ctx, 13);
    expect(originsSince(ctx, 0)).toEqual([2, 1, 3]);
    expect(ctx.sys.repeat.delayed.count).toBe(1);
  });

  it('grows past its first 16 slots and wraps around its ring in order, allocating nothing once grown', () => {
    // Plants the growth losing the ring's order (copying from slot 0 instead of head).
    const ctx = volley(ring(8));
    const p = payloadOf(ctx, 1);
    const list = ctx.sys.repeat.delayed;
    expect([list.due.length, list.capMask]).toEqual([0, -1]);
    // Twelve due on ticks 2 .. 13; ten of them fire, so the head moves to slot 10.
    for (let k = 0; k < 12; k++) scheduleRepeat(ctx, 2 + k, p, 0, k);
    expect(list.due.length).toBe(16);
    drainAt(ctx, 11);
    expect([list.head, list.count]).toEqual([10, 2]);
    // Fourteen more fill the ring past its end, every other one due before the two left.
    const due = (k: number): number => (k % 2 === 0 ? 30 + k : 12);
    for (let k = 0; k < 14; k++) scheduleRepeat(ctx, due(k), p, 0, 100 + k);
    expect([list.due.length, list.count]).toEqual([16, 16]);
    const arrays = [list.due, list.seq, list.payload, list.depth, list.origin];
    scheduleRepeat(ctx, 12, p, 0, 200);
    expect([list.due.length, list.count, list.head]).toEqual([32, 17, 0]);
    const from = ctx.projectiles.length;
    drainAt(ctx, 60);
    expect(originsSince(ctx, from)).toEqual([
      10, 101, 103, 105, 107, 109, 111, 113, 200, 11, 100, 102, 104, 106, 108, 110, 112,
    ]);
    // Grown once: the same arrays take the next round.
    const grown = [list.due, list.seq, list.payload, list.depth, list.origin];
    expect(grown.every((a, i) => a !== arrays[i])).toBe(true);
    for (let k = 0; k < 32; k++) scheduleRepeat(ctx, 70, p, 0, k);
    expect(
      [list.due, list.seq, list.payload, list.depth, list.origin].every((a, i) => a === grown[i]),
    ).toBe(true);
  });

  it('has no cap: 300 entries scheduled at once all wait, and all fire in order', () => {
    // Plants a cap on the list (lead ruling E1: no cap): an entry scheduled past it dropped.
    const ctx = volley(ring(8));
    const p = payloadOf(ctx, 1);
    const list = ctx.sys.repeat.delayed;
    for (let k = 0; k < 300; k++) scheduleRepeat(ctx, 10 + (k % 3), p, 0, k);
    expect([list.count, list.scheduled, list.due.length]).toEqual([300, 300, 512]);
    drainAt(ctx, 12);
    const expected = [0, 1, 2].flatMap((r) => Array.from({ length: 100 }, (_, n) => 3 * n + r));
    expect(originsSince(ctx, 0)).toEqual(expected);
    expect(list.count).toBe(0);
  });

  it('fires nothing from an empty list, and fires an entry with no target as a repeat would: nothing', () => {
    // Plants the drain stepping the signature without an entry.
    const ctx = volley([]);
    const before = rngPositions(ctx);
    drainDelayedRepeats(ctx);
    scheduleRepeat(ctx, 1, payloadOf(ctx, 1), 0, -1);
    drainAt(ctx, 1);
    expect(ctx.events).toEqual([]);
    expect(ctx.projectiles).toEqual([]);
    expect(rngPositions(ctx)).toEqual(before);
    expect(ctx.sys.repeat.delayed.count).toBe(0);
  });

  it('is never touched by a plain build’s run: no slot, no scheduling, no echo payload', () => {
    // Plants M1's cost: the echo payload built for every build, and the list given its slots at
    // run start or scheduled into without 殘影.
    let seen: RunContext | null = null;
    const watch: TestModule = (b) => void b.hook('tick', (ctx) => void (seen ??= ctx));
    for (const build of Object.values(GOLDEN_BUILDS)) {
      seen = null;
      const sim = createSimulation(
        makeConfig({ ...build, seed: 3, startWave: 8, maxTicks: 600 }),
        makeTestData(),
        [watch],
      );
      while (!sim.state.finished) sim.step(NO_INPUT);
      const repeat = (seen as RunContext | null)?.sys.repeat;
      expect(repeat?.echo).toBeNull();
      expect(repeat?.delayed).toEqual({
        head: 0,
        count: 0,
        capMask: -1,
        scheduled: 0,
        due: new Float64Array(0),
        seq: new Float64Array(0),
        payload: [],
        depth: new Int32Array(0),
        origin: new Int32Array(0),
      });
    }
  });

  it('drops the entries still waiting when the run ends: they fire nothing', () => {
    // Plants the run's end draining what is left.
    let ctx: RunContext | null = null;
    const watch: TestModule = (b) => void b.hook('tick', (c) => void (ctx ??= c));
    const config = makeConfig({
      seed: 1,
      maxTicks: 120,
      stats: makeStats({
        critChance: 0,
        igniteChance: 0,
        attackSpeed: 10,
        projectileSpeed: 120_000,
      }),
    });
    const sim = createSimulation(config, stationarySquares(6), [
      afterimageModule(),
      (b) => void (b.flags.comboFull = 1),
      watch,
    ]);
    let last: readonly unknown[] = [];
    while (!sim.state.finished) last = sim.step(NO_INPUT);
    const run = ctx as unknown as RunContext;
    const list = run.sys.repeat.delayed;
    // Attacks every 6 ticks from tick 6: those of ticks 108 and 114 (and 120's) were due after 120.
    expect(list.count).toBe(3);
    expect(Array.from({ length: 3 }, (_, n) => list.due[(list.head + n) & list.capMask])).toEqual([
      126, 132, 138,
    ]);
    expect(last.length).toBeGreaterThan(0);
    expect(sim.step(NO_INPUT)).toEqual([]);
    expect(list.count).toBe(3);
  });
});

describe('the drain’s place in the stage order', () => {
  /**
   * A volley attacking every 6 ticks from tick 6 under 殘影 at comboFull 1, so every attack
   * echoes and each echo is due on a tick the volley attacks again; per tick, the projectiles
   * fired by the end of the emitter stage, in firing order: 'e' for an echo, 'a' for an attack.
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
      });
    const config = makeConfig({
      seed: 2,
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
      (b) => void (b.flags.comboFull = 1),
      watch,
    ]);
    while (!sim.state.finished) sim.step(NO_INPUT);
    return byTick;
  }

  it('fires an echo due on a tick before that tick’s own attack, 18 ticks after the attack it repeats', () => {
    // Plants the drain after the emitters (an echo after the attack of its tick), in the effect
    // phase (after the projectiles: its shots a tick late, the tick hook missing it), and the
    // echo's delay off by one either way.
    const byTick = fired(60);
    expect([...byTick]).toEqual([
      [6, 'a'],
      [12, 'a'],
      [18, 'a'],
      [24, 'ea'],
      [30, 'ea'],
      [36, 'ea'],
      [42, 'ea'],
      [48, 'ea'],
      [54, 'ea'],
      [60, 'ea'],
    ]);
  });

  it('runs the combo step first: an echo that kills the last enemy leaves its own tick’s idle count at 0', () => {
    // Plants the drain before the combo step (lead ruling K3: the combo step opens the emitter
    // stage): the combo step would find no target on the tick of the echo's kill.
    const seen: number[][] = [];
    const watch: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        const alive = ctx.enemies.filter((e) => e.alive).length;
        const discharges = ctx.events.filter((e) => e.type === 'discharge').length;
        if (ctx.now >= 36 && ctx.now <= 38)
          seen.push([ctx.now, ctx.sys.combo.idle, alive, discharges]);
        // The square, standing since tick 1, dies to the next discharge.
        if (ctx.now === 37) for (const e of ctx.enemies) e.hp = num(1e-9);
      });
    // The arc discharges every 20 ticks from tick 20; at comboFull 1 each one echoes 18 later.
    const config = makeConfig({
      seed: 1,
      maxTicks: 40,
      signature: { id: 'triphaseArc' },
      stats: makeStats({ critChance: 0, igniteChance: 0 }),
    });
    const sim = createSimulation(config, stationarySquares(1), [
      afterimageModule(),
      (b) => void (b.flags.comboFull = 1),
      watch,
    ]);
    while (!sim.state.finished) sim.step(NO_INPUT);
    // [tick, idle ticks, enemies alive, discharges]: the echo of tick 20's discharge at 38.
    expect(seen).toEqual([
      [36, 0, 1, 0],
      [37, 0, 1, 0],
      [38, 0, 0, 1],
    ]);
  });
});
