import { describe, expect, it } from 'vitest';
import { mul, num, toNumber } from '../../core/num';
import type { Num } from '../../core/num';
import type { StatBlock, StatExtras } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { compileCondition, compileScaling, conditionsMet, heldFlags } from '../build/eval';
import type { EvalInput } from '../build/eval';
import { ailmentCredit, CENTER, createAttribution } from '../build/sources';
import type { AttributionPolicy } from '../build/sources';
import { hitWithPayload } from '../combat/hit';
import { runEffectQueue } from '../effects/execute';
import { heldFlag } from '../effects/flags';
import { EVENT } from '../effects/types';
import type { EmitterRuntime } from '../emitters/types';
import type { HitScratch, TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { updateAilments } from '../systems/ailments';
import { createRunContext } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { moveEnemies } from '../systems/movement';
import { releaseEnemies } from '../systems/spawn';
import { startDueWave } from '../systems/waves';
import { makeConfig, makeStats, makeTestData, stationarySquares } from '../testing';
import { DT, NO_INPUT } from '../types';
import type { RunConfig, SimEvent } from '../types';
import { applyBurn, applyPoison, doomed, spreadBurn, spreadPoison } from './apply';
import { addBleed } from './bleed';
import { addBurn } from './records';
import { holdsPoison, livePoisonStacks, RING_POISON } from './rings';
import { activeShockStacks, addShock, holdsShock, takenMult } from './shock';

const W = 15;

/** Center-sourced triggers, as collectExtras gives them. */
const center = (...specs: TriggerSpec[]): StatExtras => ({
  triggers: specs.map((spec) => ({ source: 'center', spec })),
  conversions: [],
  emitters: [],
});

/** Squares that walk at `speed` px/s, immortal, all released on the first tick. */
const walkingSquares = (count: number, speed: number): GameData =>
  makeTestData({
    enemies: { square: { hpMult: 1e12, speed } },
    waves: {
      rules: [{ enemy: 'square', fromWave: 1, base: count, perWave: 0, maxCount: count }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
    },
  });

/** A run context on the first wave of `data`, spawned and gridded for tick 1. */
function spawned(
  stats: StatBlock,
  data: GameData = stationarySquares(3),
  modules: readonly TestModule[] = [],
): RunContext {
  const ctx = createRunContext(makeConfig({ stats }), data, modules);
  ctx.now = 1;
  startDueWave(ctx);
  releaseEnemies(ctx);
  rebuildGrid(ctx);
  ctx.events.length = 0;
  return ctx;
}

/**
 * Runs the ailments system (after movement, when `move`) on every tick up to `to`, keeping the
 * events each tick raised by tick.
 */
function advance(ctx: RunContext, to: number, move = false): Map<number, SimEvent[]> {
  const byTick = new Map<number, SimEvent[]>();
  while (ctx.now < to) {
    ctx.now++;
    ctx.events.length = 0;
    if (move) moveEnemies(ctx);
    updateAilments(ctx);
    if (ctx.events.length !== 0) byTick.set(ctx.now, ctx.events.slice());
  }
  return byTick;
}

type DotTick = Extract<SimEvent, { type: 'dotTick' }>;

/** The amount of each `ailment` dotTick on `enemy`, by tick. */
const dotTicks = (
  byTick: Map<number, SimEvent[]>,
  ailment: 'poison' | 'bleed',
  enemy: Enemy,
): Map<number, number> =>
  new Map(
    [...byTick].flatMap(([tick, events]) =>
      events
        .filter((e): e is DotTick => e.type === 'dotTick' && e.ailment === ailment)
        .filter((e) => e.targetId === enemy.id)
        .map((e): [number, number] => [tick, toNumber(e.amount)]),
    ),
  );

const enemyAt = (ctx: RunContext, i: number): Enemy => ctx.enemies[i] as Enemy;

/** Ticks of (lo, hi] inside (from, to]. */
const overlap = (lo: number, hi: number, from: number, to: number): number =>
  Math.max(0, Math.min(hi, to) - Math.max(lo, from));

describe('bleed', () => {
  interface Segment {
    readonly dps: number;
    readonly from: number;
    readonly to: number;
  }

  /** Step k of bleed segments weighted `weight` per tick. */
  const bleedStep = (segments: readonly Segment[], k: number, weight: number): number =>
    segments.reduce(
      (sum, s) => sum + s.dps * DT * weight * overlap(W * (k - 1), W * k, s.from, s.to),
      0,
    );

  it('keeps the strongest bleed, exact for mid-step application and replacement', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 7;
    expect(addBleed(ctx, enemy, num(8), 107.5, 0, CENTER)).toBe(true);
    const events = advance(ctx, 40);
    // 1 × 60 left is less than 8 × 67.5: the weaker bleed is refused.
    expect(addBleed(ctx, enemy, num(1), 100, 0, CENTER)).toBe(false);
    for (const [tick, more] of advance(ctx, 50)) events.set(tick, more);
    // 20 × 60 is more than 8 × 57.5: it takes the slot; the old one's ticks 45–50 stay due.
    expect(addBleed(ctx, enemy, num(20), 110, 0, CENTER)).toBe(true);
    for (const [tick, more] of advance(ctx, 150)) events.set(tick, more);
    const segments = [
      { dps: 8, from: 7, to: 50 },
      { dps: 20, from: 50, to: 110 },
    ];
    const dealt = dotTicks(events, 'bleed', enemy);
    expect([...dealt.keys()]).toEqual([15, 30, 45, 60, 75, 90, 105, 120]);
    for (const [tick, amount] of dealt) {
      expect(amount, `tick ${tick}`).toBeCloseTo(bleedStep(segments, tick / W, 1), 12);
    }
    expect(enemy.bleedUntil).toBe(0);
    // A new bleed takes an empty slot whatever its size.
    expect(addBleed(ctx, enemy, num(0.1), 200, 0, CENTER)).toBe(true);
  });

  it.each([
    ['moving', 30, 1, 3],
    ['standing still', 0, 1, 1],
    ['standing still with 傷口撕裂', 0, 2, 2],
  ])('weighs each tick %s ×%s', (_label, speed, stationaryMult, weight) => {
    const ctx = spawned(
      makeStats({ bleedStationaryMult: stationaryMult }),
      walkingSquares(2, speed as number),
    );
    const enemy = enemyAt(ctx, 0);
    ctx.now = 3;
    moveEnemies(ctx);
    // Movement counts moves only once some bleed has taken a slot.
    expect(ctx.bleedApplied).toBe(false);
    addBleed(ctx, enemy, num(6), 3 + 100.25, 0, CENTER);
    expect(ctx.bleedApplied).toBe(true);
    const dealt = dotTicks(advance(ctx, 130, true), 'bleed', enemy);
    expect(dealt.size).toBe(7);
    for (const [tick, amount] of dealt) {
      const k = tick / W;
      expect(amount, `tick ${tick}`).toBeCloseTo(
        bleedStep([{ dps: 6, from: 3, to: 103.25 }], k, weight as number),
        12,
      );
    }
  });
});

describe('shock', () => {
  const stats = makeStats({ shockMaxStacks: 3, shockDuration: 2, shockEffect: 0.1 });
  const stacksAtLeast3 = [compileCondition({ stacksAtLeast: { ailment: 'shock', stacks: 3 } })];
  const shocked = [compileCondition({ targetHas: 'shock' })];
  const shockScaling = compileScaling({ per: 'targetShockStacks' });
  const evAt = (enemy: Enemy, now: number): EvalInput => ({
    now,
    target: enemy,
    chainJump: 0,
    playerLifeFrac: 1,
  });

  it('stacks to its cap on a shared timer; once it wears off every reader sees none', () => {
    const ctx = spawned(stats);
    const enemy = enemyAt(ctx, 0);
    // Poison of 4 dps over whole steps: 1 per step unshocked.
    ctx.now = 15;
    applyPoison(ctx, enemy, num(4), 255, 0, CENTER, 1);
    ctx.now = 20;
    expect(addShock(ctx, enemy, 1, 0)).toBe(true);
    ctx.now = 25;
    addShock(ctx, enemy, 1, 0);
    expect(activeShockStacks(enemy, 25)).toBe(2);
    ctx.now = 26;
    addShock(ctx, enemy, 5, 0);
    expect(activeShockStacks(enemy, 26)).toBe(3);
    expect(enemy.shockUntil).toBe(26 + 120);
    const dealt = dotTicks(advance(ctx, 255), 'poison', enemy);
    for (const [tick, amount] of dealt) {
      // Shocked through tick 145: × (1 + 0.1 × 3); then the plain step, untouched.
      if (tick <= 145) expect(amount, `tick ${tick}`).toBe(toNumber(mul(num(1), 1.3)));
      else expect(amount, `tick ${tick}`).toBe(1);
    }
    expect(dealt.size).toBe(16);
    for (const [now, active] of [
      [145, 3],
      [146, 0],
    ] as const) {
      ctx.now = now;
      const on = active > 0;
      expect(activeShockStacks(enemy, now)).toBe(active);
      expect(holdsShock(enemy, now)).toBe(on);
      expect(takenMult(ctx, enemy)).toBe(on ? 1 + 0.1 * 3 : 1);
      expect((heldFlags(enemy, now) & heldFlag('shock')) !== 0).toBe(on);
      expect(conditionsMet(shocked, enemy, now, 0)).toBe(on);
      expect(conditionsMet(stacksAtLeast3, enemy, now, 0)).toBe(on);
      expect(shockScaling.read(evAt(enemy, now))).toBe(active);
    }
    // The stale count stays, but a new stack starts from none.
    expect(enemy.shockStacks).toBe(3);
    ctx.now = 200;
    addShock(ctx, enemy, 1, 0);
    expect(activeShockStacks(enemy, 200)).toBe(1);
  });

  it('multiplies the hits a shocked enemy takes', () => {
    const ctx = spawned(
      makeStats({ ...stats.values, critChance: 0, igniteChance: 0, projectileCount: 1 }),
    );
    const [a, b] = [enemyAt(ctx, 0), enemyAt(ctx, 1)];
    const payload = (ctx.emitters[0] as EmitterRuntime).payload;
    addShock(ctx, a, 2, 0);
    hitWithPayload(ctx, a, payload, 0, 1, null, null, false, 0, -1);
    hitWithPayload(ctx, b, payload, 0, 1, null, null, false, 0, -1);
    const hits = ctx.events.filter((e) => e.type === 'hit');
    expect(hits).toHaveLength(2);
    const [onA, onB] = hits.map((e) => toNumber((e as { amount: Num }).amount));
    expect(onA).toBe(toNumber(mul(num(onB as number), 1.2)));
  });

  it('cannot shock without a stack cap or a duration', () => {
    for (const values of [{ shockMaxStacks: 0 }, { shockDuration: 0 }]) {
      const ctx = spawned(makeStats(values));
      expect(addShock(ctx, enemyAt(ctx, 0), 1, 0)).toBe(false);
      expect(activeShockStacks(enemyAt(ctx, 0), ctx.now)).toBe(0);
    }
  });
});

describe('poison', () => {
  it('holds while a stack lasts; its ring goes back at its last step', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 10;
    applyPoison(ctx, enemy, num(4), 70.5, 0, CENTER, 3);
    const events = advance(ctx, 20);
    applyPoison(ctx, enemy, num(2), 50, 0, CENTER, 2);
    expect(enemy.poisonStacks).toBe(5);
    expect(ctx.rings.live).toBe(1);
    const scaling = compileScaling({ per: 'targetPoisonStacks' });
    const ev: EvalInput = { now: 20, target: enemy, chainJump: 0, playerLifeFrac: 1 };
    expect(scaling.read(ev)).toBe(5);
    expect(scaling.read({ ...ev, target: null })).toBe(0);
    for (const [tick, more] of advance(ctx, 90)) events.set(tick, more);
    const dealt = dotTicks(events, 'poison', enemy);
    const expected = (k: number): number =>
      12 * DT * overlap(W * (k - 1), W * k, 10, 70.5) +
      4 * DT * overlap(W * (k - 1), W * k, 20, 50);
    expect([...dealt.keys()]).toEqual([15, 30, 45, 60, 75]);
    for (const [tick, amount] of dealt) expect(amount).toBeCloseTo(expected(tick / W), 12);
    expect(ctx.rings.live).toBe(0);
    expect(enemy.rings[RING_POISON]).toBe(-1);
  });

  it('stops holding when its last stack ends, before the step that deals its tail', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 16;
    applyPoison(ctx, enemy, num(6), 40, 0, CENTER, 2);
    const held = [compileCondition({ targetHas: 'poison' })];
    for (const [now, holds] of [
      [39, true],
      [40, false],
      [44, false],
    ] as const) {
      advance(ctx, now);
      expect(holdsPoison(enemy, now), `tick ${now}`).toBe(holds);
      expect(conditionsMet(held, enemy, now, 0)).toBe(holds);
      expect(livePoisonStacks(enemy, now)).toBe(holds ? 2 : 0);
      // The ring keeps the tail of step 3 until tick 45.
      expect(enemy.rings[RING_POISON]).toBeGreaterThanOrEqual(0);
    }
    advance(ctx, 45);
    expect(enemy.rings[RING_POISON]).toBe(-1);
  });
});

describe('doomed', () => {
  it('counts the rings and the bleed on the enemy', () => {
    const ctx = spawned(makeStats());
    const enemy = enemyAt(ctx, 0);
    ctx.now = 15;
    applyPoison(ctx, enemy, num(4), 255, 0, CENTER, 1); // 16 left
    enemy.hp = num(16);
    expect(doomed(ctx, enemy)).toBe(true);
    enemy.hp = num(16.5);
    expect(doomed(ctx, enemy)).toBe(false);
    addBleed(ctx, enemy, num(2), 15 + 120, 0, CENTER); // 4 left standing still
    enemy.hp = num(20);
    expect(doomed(ctx, enemy)).toBe(true);
    enemy.hp = num(20.5);
    expect(doomed(ctx, enemy)).toBe(false);
  });

  it('ignores damage still due once no stack lasts, for records (A2) and rings alike', () => {
    const ctx = spawned(makeStats({ burnMaxStacks: 5 }));
    const [records, ring] = [enemyAt(ctx, 0), enemyAt(ctx, 1)];
    ctx.now = 31;
    addBurn(ctx, records, num(60), 44, 0, CENTER); // 13 due over ticks 31–44
    applyPoison(ctx, ring, num(60), 44, 0, CENTER, 1);
    records.hp = num(5);
    ring.hp = num(5);
    // Targeting runs before the ailments step: in tick 44 both still count their last stack.
    advance(ctx, 43);
    ctx.now = 44;
    expect([doomed(ctx, records), doomed(ctx, ring)]).toEqual([true, true]);
    updateAilments(ctx);
    expect(records.burns).toHaveLength(0);
    expect(toNumber(records.burnPending)).toBeCloseTo(13, 12);
    ctx.now = 45;
    expect(ctx.rings.remaining[ring.rings[RING_POISON] as number]).toBeCloseTo(13, 12);
    // burnPending ≥ hp, no record stacks: not doomed (M1's early return), and the ring alike.
    expect([doomed(ctx, records), doomed(ctx, ring)]).toEqual([false, false]);
  });
});

describe('attribution at unit level', () => {
  /** A context whose sources and policy are built by hand: 熔核's, burn only (C6 sets it). */
  function handBuilt(): { ctx: RunContext; policy: AttributionPolicy; fusions: number[] } {
    const ctx = spawned(makeStats({ burnMaxStacks: 5 }));
    const policy = createAttribution(['burn']);
    (ctx as { attribution: AttributionPolicy }).attribution = policy;
    const fusions = [ctx.sources.index('fusion.fire.poison'), ctx.sources.index('fusion.fire.ice')];
    return { ctx, policy, fusions };
  }

  it('credits by policy and keeps each ring’s class and credit through a spread', () => {
    const { ctx, policy, fusions } = handBuilt();
    const [f1, f2] = fusions as [number, number];
    const sources = ctx.sources;
    expect(ailmentCredit(sources, policy, 'burn', CENTER)).toBe(CENTER);
    const outer = ailmentCredit(sources, policy, 'poison', CENTER);
    expect(sources.names[outer]).toBe('outer.poison');
    expect(ailmentCredit(sources, policy, 'poison', f1)).toBe(f1);
    expect(ailmentCredit(sources, policy, 'burn', f2)).toBe(f2);

    const [a, b] = [enemyAt(ctx, 0), enemyAt(ctx, 1)];
    ctx.now = 15;
    // One ring per class; the fusion ring credits the first fusion that poisoned the enemy.
    applyPoison(ctx, a, num(1), 75, 0, CENTER, 1);
    applyPoison(ctx, a, num(2), 75, 0, outer, 1);
    applyPoison(ctx, a, num(4), 75, 0, f1, 1);
    applyPoison(ctx, a, num(8), 75, 0, f2, 1);
    const pool = ctx.rings;
    const ringsOf = (enemy: Enemy) =>
      [0, 1, 2].map((c) => {
        const r = enemy.rings[RING_POISON + c] as number;
        return r < 0 ? null : [pool.cls[r], pool.credit[r]];
      });
    expect(ringsOf(a)).toEqual([
      [0, CENTER],
      [1, outer],
      [2, f1],
    ]);
    expect(a.poisonStacks).toBe(4);
    expect(a.dotRings).toBe(3);
    ctx.now = 20;
    spreadPoison(ctx, a, { radius: 5000, radiusSq: 5000 ** 2, effect: 1 }, 1, 1, 0);
    expect(ringsOf(b)).toEqual(ringsOf(a));
    expect(b.poisonStacks).toBe(4);

    // Steps credit each ring's share to its credit.
    const before = [CENTER, outer, f1].map((s) => toNumber(ctx.bySource[s] as Num));
    advance(ctx, 30);
    const gained = [CENTER, outer, f1].map(
      (s, i) => toNumber(ctx.bySource[s] as Num) - (before[i] as number),
    );
    // Ticks 16–30 on a, 21–30 on b at full strength.
    expect(gained[0]).toBeCloseTo(1 * DT * (15 + 10), 12);
    expect(gained[1]).toBeCloseTo(2 * DT * (15 + 10), 12);
    expect(gained[2]).toBeCloseTo(12 * DT * (15 + 10), 12);
  });

  it('gives a burn record the class and source of its credit', () => {
    const { ctx, fusions } = handBuilt();
    const f1 = fusions[0] as number;
    const enemy = enemyAt(ctx, 0);
    addBurn(ctx, enemy, num(1), 100, 0, CENTER);
    addBurn(ctx, enemy, num(1), 100, 0, f1);
    expect(enemy.burns.map((s) => [s.cls, s.source])).toEqual([
      [0, CENTER],
      [2, f1],
    ]);
  });
});

describe('records with two burn classes', () => {
  /** Hits ignite (credited to the center); a trigger of `source` also burns what is hit. */
  const config = (source: string): RunConfig =>
    makeConfig({
      stats: makeStats(
        { damage: 2, igniteChance: 0.5, burnDamage: 1, burnMaxStacks: 3, projectileCount: 1 },
        [],
        {
          triggers: [
            {
              source,
              spec: {
                on: 'hit',
                when: [{ chance: 0.5 }],
                do: [{ kind: 'applyAilment', ailment: 'burn', damagePct: 2 }],
              },
            },
          ],
          conversions: [],
          emitters: [],
        },
      ),
      maxTicks: 1800,
    });

  it('tallies each class its share while the hp loss keeps M1’s order', () => {
    const data = stationarySquares(4, 1);
    const run = (source: string) => {
      const sim = createSimulation(config(source), data);
      const ticks: SimEvent[][] = [];
      while (!sim.state.finished) ticks.push(sim.step(NO_INPUT).slice());
      return { ticks: ticks.flat(), result: sim.result() };
    };
    const single = run('center');
    const mixed = run('fusion.fire.poison');
    const burnTicks = (events: SimEvent[]) =>
      events.filter((e) => e.type === 'burnTick' || e.type === 'enemyKilled');
    expect(burnTicks(single.ticks).length).toBeGreaterThan(20);
    expect(single.result.kills).toBeGreaterThan(0);
    // The same burn ticks and kills, to the bit.
    expect(burnTicks(mixed.ticks)).toEqual(burnTicks(single.ticks));
    const bySource = mixed.result.damageBySource;
    const fusion = toNumber(bySource['fusion.fire.poison'] as Num);
    expect(fusion).toBeGreaterThan(0);
    const centerShare = toNumber(single.result.damageBySource.center as Num) - fusion;
    expect(toNumber(bySource.center as Num)).toBeCloseTo(centerShare, 6);
    // The tallies add each class's part on its own, so their total may differ by rounding.
    expect(toNumber(mixed.result.damage.burn)).toBeCloseTo(toNumber(single.result.damage.burn), 9);
  });
});

describe('ailmentTick', () => {
  const tickTrigger = (every: number): TriggerSpec => ({
    on: 'ailmentTick',
    every,
    when: [{ ailment: 'poison' }],
    do: [{ kind: 'heal', lifePct: 0.01 }],
  });

  it('fires on the steps of its interval, the same steps for every poisoned enemy', () => {
    const ctx = spawned(makeStats({}, [], center(tickTrigger(1), tickTrigger(0.25))));
    const [every4, every1] = ctx.build.triggersOn[EVENT.ailmentTick] as Int32Array;
    const triggers = ctx.build.triggers;
    expect([every4, every1].map((i) => triggers[i as number]?.stepEvery)).toEqual([4, 1]);
    const [a, b, c] = [enemyAt(ctx, 0), enemyAt(ctx, 1), enemyAt(ctx, 2)];
    ctx.now = 20;
    applyPoison(ctx, a, num(1), 260, 0, CENTER, 1);
    // c burns but holds no poison: neither trigger fires on it.
    addBurn(ctx, c, num(1), 300, 0, CENTER);
    const fired: [number, number, number][] = [];
    const q = ctx.effectQueue;
    while (ctx.now < 330) {
      if (ctx.now === 50) applyPoison(ctx, b, num(1), 290, 0, CENTER, 1);
      advance(ctx, ctx.now + 1);
      for (let n = 0; n < q.size; n++) {
        const at = (q.head + n) & q.capMask;
        fired.push([ctx.now / W, q.origin[at] as number, (q.target[at] as Enemy).id]);
      }
      q.size = 0;
    }
    const stepsOf = (trigger: number, enemy: Enemy) =>
      fired.filter(([, t, id]) => t === trigger && id === enemy.id).map(([k]) => k);
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => from + i);
    // a holds poison over steps 2–17 (ticks 30–255), b over 4–19 (ticks 60–285).
    expect(stepsOf(every4 as number, a)).toEqual([4, 8, 12, 16]);
    expect(stepsOf(every4 as number, b)).toEqual([4, 8, 12, 16]);
    expect(stepsOf(every1 as number, a)).toEqual(range(2, 17));
    expect(stepsOf(every1 as number, b)).toEqual(range(4, 19));
    expect(fired.filter(([, , id]) => id === c.id)).toEqual([]);
  });
});

describe('ailmentApplied', () => {
  const heal = { kind: 'heal', lifePct: 0.01 } as const;
  const triggers = center(
    { on: 'ailmentApplied', when: [{ ailment: 'burn' }], do: [heal] },
    { on: 'ailmentApplied', when: [{ ailment: 'poison' }], do: [heal] },
    { on: 'hit', do: [{ kind: 'applyAilment', ailment: 'poison' }] },
  );

  /** The triggers of the queued effects, oldest first, emptying the queue. */
  const drain = (ctx: RunContext): number[] => {
    const q = ctx.effectQueue;
    const origins = Array.from(
      { length: q.size },
      (_, n) => q.origin[(q.head + n) & q.capMask] as number,
    );
    return origins;
  };

  it('fires on burn ignition and on poison applications by hits and effects, never on spreads', () => {
    const ctx = spawned(
      makeStats(
        { damage: 1, critChance: 0, igniteChance: 1, poisonChance: 0, projectileCount: 1 },
        [],
        triggers,
      ),
    );
    expect(ctx.appliedListeners).toBe(true);
    const [onBurn] = ctx.build.triggersOn[EVENT.ailmentApplied] as Int32Array;
    const [onHit] = ctx.build.triggersOn[EVENT.hit] as Int32Array;
    const [a] = [enemyAt(ctx, 0)];
    const payload = (ctx.emitters[0] as EmitterRuntime).payload;
    hitWithPayload(ctx, a, payload, 0, 1, null, null, false, 0, -1);
    // The ignition fires the burn trigger; the hit trigger queues its poison.
    expect(drain(ctx)).toEqual([onBurn, onHit]);
    // Running the queue applies the poison, which fires the poison trigger, whose heal joins
    // the same tick's run: three effects.
    runEffectQueue(ctx);
    expect(ctx.counters.effectsRun).toBe(3);
    expect(a.poisonStacks).toBe(1);
    expect(drain(ctx)).toEqual([]);
    // Spreads move what is there and fire nothing.
    spreadBurn(ctx, a, { radius: 5000, radiusSq: 5000 ** 2, effect: 1 }, 0);
    spreadPoison(ctx, a, { radius: 5000, radiusSq: 5000 ** 2, effect: 1 }, 1, Infinity, 0);
    expect(enemyAt(ctx, 1).burns.length + enemyAt(ctx, 1).poisonStacks).toBe(2);
    expect(drain(ctx)).toEqual([]);
  });

  it('fires the poison trigger only on poison, with the kind in its flags', () => {
    const ctx = spawned(
      makeStats(
        {
          damage: 1,
          critChance: 0,
          igniteChance: 0,
          poisonChance: 0.99,
          bleedChance: 0.99,
          shockChance: 0.99,
          projectileCount: 1,
        },
        [],
        center(
          { on: 'ailmentApplied', when: [{ ailment: 'burn' }], do: [heal] },
          { on: 'ailmentApplied', when: [{ ailment: 'poison' }], do: [heal] },
          { on: 'ailmentApplied', when: [{ ailment: 'bleed' }], do: [heal] },
          { on: 'ailmentApplied', when: [{ ailment: 'shock' }], do: [heal] },
        ),
      ),
    );
    const payload = (ctx.emitters[0] as EmitterRuntime).payload;
    const a = enemyAt(ctx, 0);
    hitWithPayload(ctx, a, payload, 0, 1, null, null, false, 0, -1);
    const applied = [...(ctx.build.triggersOn[EVENT.ailmentApplied] as Int32Array)];
    expect(applied).toHaveLength(4);
    // Every trigger but the first (burn's).
    expect(drain(ctx)).toEqual(applied.slice(1));
    const events = ctx.events.filter((e) => e.type === 'ailmentApplied');
    expect(events.map((e) => (e as { ailment: string }).ailment)).toEqual([
      'poison',
      'bleed',
      'shock',
    ]);
  });
});

describe('the DoT modifyDamage hook (A22)', () => {
  it('doubles poison steps on shocked enemies and nothing else', () => {
    const seen: Pick<HitScratch, 'mask' | 'source' | 'depth' | 'origin' | 'crit'>[] = [];
    const doublePoisonOnShock: TestModule = (b) =>
      b.hook('modifyDamage', (ctx, hit, amount) => {
        seen.push({
          mask: hit.mask,
          source: hit.source,
          depth: hit.depth,
          origin: hit.origin,
          crit: hit.crit,
        });
        return (hit.mask & TAG.poison) !== 0 && activeShockStacks(hit.target, ctx.now) > 0
          ? mul(amount, 2)
          : amount;
      });
    // shockEffect 0: the shock itself multiplies nothing.
    const ctx = spawned(makeStats({ shockEffect: 0, burnMaxStacks: 5 }), stationarySquares(2), [
      doublePoisonOnShock,
    ]);
    const [a, b] = [enemyAt(ctx, 0), enemyAt(ctx, 1)];
    ctx.now = 15;
    for (const enemy of [a, b]) {
      applyPoison(ctx, enemy, num(4), 75, 1, CENTER, 1);
      applyBurn(ctx, enemy, num(2), 75, 1, CENTER, 1);
      addBleed(ctx, enemy, num(3), 75, 1, CENTER);
    }
    addShock(ctx, a, 1, 1);
    const events = advance(ctx, 75);
    const amounts = (type: 'burnTick' | 'dotTick', ailment: string | null, enemy: Enemy) =>
      [...events.values()]
        .flat()
        .filter((e) => e.type === type && e.targetId === enemy.id)
        .filter((e) => ailment === null || (e as { ailment: string }).ailment === ailment)
        .map((e) => toNumber((e as { amount: Num }).amount));
    const shockedPoison = amounts('dotTick', 'poison', a);
    expect(shockedPoison).toHaveLength(4);
    // Shocked until tick 135: every poison step of a is doubled, the rest untouched.
    expect(shockedPoison).toEqual(amounts('dotTick', 'poison', b).map((x) => x * 2));
    expect(amounts('burnTick', null, a)).toEqual(amounts('burnTick', null, b));
    expect(amounts('dotTick', 'bleed', a)).toEqual(amounts('dotTick', 'bleed', b));
    expect(new Set(seen.map((s) => s.mask))).toEqual(new Set([TAG.burn, TAG.poison, TAG.bleed]));
    expect(
      seen.every((s) => s.source === CENTER && s.depth === 1 && s.origin === -1 && !s.crit),
    ).toBe(true);
  });
});

describe('determinism with rings', () => {
  const config = (seed: number): RunConfig =>
    makeConfig({
      seed,
      stats: makeStats(
        {
          damage: 12,
          igniteChance: 0.5,
          poisonChance: 0.4,
          bleedChance: 0.3,
          shockChance: 0.3,
          projectileCount: 2,
        },
        [],
        center(
          {
            on: 'diedWithAilment',
            when: [{ victimHas: 'burn' }],
            do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 250, effect: 0.4 }],
          },
          {
            on: 'kill',
            when: [{ victimHas: 'poison' }],
            do: [
              { kind: 'spreadAilment', ailment: 'poison', radius: 200, stacks: 0.5, maxTargets: 3 },
            ],
          },
        ),
      ),
      rules: [{ id: 'eternalFlame', durationMore: 1 }],
      startWave: 8,
      maxTicks: 3600,
    });

  /** Events of a run, checking each tick that the pool holds exactly the enemies' rings. */
  function run(seed: number) {
    const mismatches: number[] = [];
    const poolCheck: TestModule = (b) =>
      b.hook('tick', (ctx) => {
        let rings = 0;
        for (const enemy of ctx.enemies) rings += enemy.dotRings;
        if (rings !== ctx.rings.live) mismatches.push(ctx.now);
      });
    const sim = createSimulation(config(seed), makeTestData(), [poolCheck]);
    const events: SimEvent[] = [];
    while (!sim.state.finished) events.push(...sim.step(NO_INPUT));
    return { events, result: sim.result(), mismatches };
  }

  it('gives the same events for the same seed and other ones for another seed', () => {
    const first = run(1);
    const types = new Set(first.events.map((e) => e.type));
    for (const type of ['burnSpread', 'ailmentSpread', 'dotTick', 'ailmentApplied', 'playerHit']) {
      expect(types.has(type as SimEvent['type']), type).toBe(true);
    }
    expect(first.result.damage.poison).toBeGreaterThan(0);
    expect(first.result.damage.bleed).toBeGreaterThan(0);
    // Deaths and leaks give every ring back.
    expect(first.mismatches).toEqual([]);
    expect(run(1).events).toEqual(first.events);
    expect(run(2).events).not.toEqual(first.events);
  });
});
