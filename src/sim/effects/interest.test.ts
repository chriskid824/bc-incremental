/**
 * The waveCleared event and the interest effect (E17, lead rulings G1, G2 and G4; 利息's 「每波結束
 * 拿本局碎片的一部分當利息，每次觸發利率提高 0.5 個百分點，最多 10%」, ◆複利's 「利息也算進持有碎片加成」
 * and ◆獎勵波's 「每 10 波的利息 ×3」, gd:501): the waveControl step raises waveCleared once per
 * cleared record, in record order, at the player with no target, its value the wave's number; a
 * waveCleared trigger of interest effects alone pays at the clear, before the tick's end checks,
 * base × rate into SimState.interestShards, rate = min(rateMax, interestRate + n × rateStep) for
 * the n payouts before it, base the run's shards (plus the pool under BuildFlags.interestHeld),
 * × bonusWaveInterest on waves 10, 20, 30 …; never into SimState.shards, never negative, never
 * rounded, with no RNG, no event and no coefficient. Each test's comment names the planted bug
 * it kills.
 */

import { describe, expect, it, vi } from 'vitest';
import { add, mul, num, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { GameData } from '../../data/types';
import type { Modifier, SourcedTrigger, StatId } from '../../data/stats';
import {
  BONUS_WAVE_EVERY,
  COEF_FIELDS,
  INTEREST_RATE_MAX,
  INTEREST_RATE_STEP,
} from '../../data/triggers';
import type { EffectSpec, InterestSpec, TriggerSpec } from '../../data/triggers';
import { compileBuild } from '../build/compile';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { RunContext, WaveRecord } from '../systems/context';
import type * as Globals from '../systems/globals';
import { updateClears } from '../systems/waves';
import { makeConfig, makeStats, makeTestData, placedEnemies, rngPositions } from '../testing';
import { NO_INPUT } from '../types';
import type { RunConfig, RunResult, SimEvent } from '../types';
import type * as Dispatch from './dispatch';
import { fire, fireWaveCleared } from './dispatch';
import { runEffectQueue } from './execute';
import { EVENT } from './types';

// The base's own code paths: under `base.held`, the globals step counts shardsHeld as the base
// did (the wallet plus the run's shards, its pool argument left out); under `base.clear`, the
// waveControl step raises no waveCleared trigger event, as before E17.
const base = vi.hoisted(() => ({ held: false, clear: false }));
vi.mock('../systems/globals', async (importOriginal) => {
  const actual = await importOriginal<typeof Globals>();
  return {
    ...actual,
    stepGlobals: (...args: Parameters<typeof actual.stepGlobals>): void => {
      const [ctx, wallet, held, inAura, top, minions] = args;
      if (base.held) actual.stepGlobals(ctx, wallet, held, inAura, top, minions);
      else actual.stepGlobals(...args);
    },
  };
});
vi.mock('./dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof Dispatch>();
  return {
    ...actual,
    fireWaveCleared: (ctx: RunContext, wave: number): void => {
      if (!base.clear) actual.fireWaveCleared(ctx, wave);
    },
  };
});

const INTEREST: InterestSpec = { kind: 'interest' };
const PAY: TriggerSpec = { on: 'waveCleared', do: [INTEREST] };
const HEAL: EffectSpec = { kind: 'heal', lifePct: 0.01 };

/** ◆複利 as a test module: the pool counts in shardsHeld and in the interest's base. */
const compound: TestModule = (b) => {
  b.flags.interestHeld = true;
};

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly modules?: readonly TestModule[];
  readonly coef?: number;
}

/** A run context on tick 1 with no enemies under `triggers` (default: one interest trigger). */
function field(o: Options = {}, triggers: readonly TriggerSpec[] = [PAY]): RunContext {
  const sourced = triggers.map((spec): SourcedTrigger => ({
    source: 'outer.greed',
    spec,
    ...(o.coef === undefined ? {} : { coef: o.coef }),
  }));
  return placedEnemies([], {
    stats: makeStats({ ...o.values }, [], { triggers: sourced, conversions: [], emitters: [] }),
    ...(o.modules === undefined ? {} : { modules: o.modules }),
  });
}

/**
 * Wave `wave`'s payout alone, into an emptied pool, which the payout reads only under
 * interestHeld (never set here).
 */
function payout(ctx: RunContext, wave: number): Num {
  expect(ctx.build.flags.interestHeld).toBe(false);
  ctx.state.interestShards = ZERO;
  fireWaveCleared(ctx, wave);
  return ctx.state.interestShards;
}

/** A cleared record of wave `wave` with no enemies left, or one still holding `alive`. */
const record = (wave: number, alive = 0): WaveRecord => ({
  wave,
  queue: [],
  released: 0,
  delayed: 0,
  startTick: 1,
  alive,
  cleared: false,
  leaked: false,
  stdHp: 1,
  shardsPerStd: 1,
});

/** The queued effects' values, in queue order. */
function queuedValues(ctx: RunContext): number[] {
  const q = ctx.effectQueue;
  const values: number[] = [];
  for (let n = 0; n < q.size; n++) values.push(q.value[(q.head + n) & q.capMask] as number);
  return values;
}

describe('the interest constants', () => {
  it('are 0.5 percentage points a payout, at most 10%, ×bonus every 10th wave (gd:501)', () => {
    expect([INTEREST_RATE_STEP, INTEREST_RATE_MAX, BONUS_WAVE_EVERY]).toEqual([0.005, 0.1, 10]);
    expect(COEF_FIELDS.interest).toEqual([]);
  });
});

describe('the interest executor (lead ruling G2)', () => {
  it('pays SimState.shards × interestRate exactly in Num into interestShards, never into shards', () => {
    // Planted bugs: interest paid into SimState.shards rather than the pool; the payout rounded;
    // it read from shardsHeld (which holds the wallet).
    const ctx = field({ values: { interestRate: 0.01 } });
    const shards = num(12345.678);
    ctx.state.shards = shards;
    ctx.evalInput.shardsHeld = 1e9;
    fireWaveCleared(ctx, 3);
    const paid = mul(shards, 0.01);
    expect(ctx.state.interestShards).toEqual(paid);
    expect(paid).not.toBe(Math.round(paid));
    expect(ctx.state.shards).toBe(shards);
    expect(ctx.state.interestPayouts).toBe(1);
    expect(ctx.evalInput.shardsHeld).toBe(1e9);
    // A second payout adds to the pool, on the same shards, at the next rate.
    fireWaveCleared(ctx, 4);
    expect(ctx.state.interestShards).toEqual(add(paid, mul(shards, 0.01 + 1 * 0.005)));
    expect(ctx.state.shards).toBe(shards);
  });

  it.each([
    ['at the defaults', INTEREST, 0.005, 0.1],
    [
      'at rateStep 0.02 and rateMax 0.05',
      { kind: 'interest', rateStep: 0.02, rateMax: 0.05 },
      0.02,
      0.05,
    ],
    ['at rateStep 0', { kind: 'interest', rateStep: 0 }, 0, 0.1],
  ] as [string, InterestSpec, number, number][])(
    'pays at interestRate first, then rateStep higher each payout up to rateMax, then stays, %s',
    (_label, spec, step, max) => {
      // Planted bugs: the rate raised before the payout rather than after it; the rate not
      // capped at rateMax; the step counted per wave number rather than per payout.
      const ctx = field({ values: { interestRate: 0.01 } }, [{ on: 'waveCleared', do: [spec] }]);
      ctx.state.shards = num(1000);
      const rates: number[] = [];
      for (let n = 0; n < 25; n++) {
        const wave = 2 * n + 1;
        const paid = payout(ctx, wave);
        const rate = Math.min(max, 0.01 + n * step);
        expect(paid, `${n}`).toEqual(mul(num(1000), rate));
        rates.push(rate);
        expect(ctx.state.interestPayouts).toBe(n + 1);
      }
      expect(rates[0]).toBe(0.01);
      expect(rates.at(-1)).toBe(step === 0 ? 0.01 : max);
      expect(ctx.state.shards).toBe(num(1000));
    },
  );

  it('pays 0 at 0 shards and still raises the rate', () => {
    // Planted bug: a payout of 0 not counted, so the next one starts again at interestRate.
    const ctx = field({ values: { interestRate: 0.01 } });
    fireWaveCleared(ctx, 1);
    expect(Object.is(ctx.state.interestShards, 0)).toBe(true);
    expect(Object.is(ctx.state.shards, 0)).toBe(true);
    expect(ctx.state.interestPayouts).toBe(1);
    ctx.state.shards = num(1000);
    expect(payout(ctx, 2)).toEqual(mul(num(1000), 0.015));
  });

  it('pays waves 10 and 20 × bonusWaveInterest, and waves 9, 11, 19 and 21 at the rate', () => {
    // Planted bugs: the bonus on wave 11, on every wave, or not on wave 20; the bonus added to
    // the rate rather than multiplying it.
    const ctx = field({ values: { interestRate: 0.01, bonusWaveInterest: 3 } }, [
      { on: 'waveCleared', do: [{ kind: 'interest', rateStep: 0 }] },
    ]);
    ctx.state.shards = num(1000);
    const paid = [9, 10, 11, 19, 20, 21, 30, 100].map((wave) => payout(ctx, wave));
    const plain = mul(num(1000), 0.01);
    const bonus = mul(num(1000), 0.01 * 3);
    expect(paid).toEqual([plain, bonus, plain, plain, bonus, plain, bonus, bonus]);
    // At the stat's base, 1, a bonus wave pays as any other.
    const flat = field({ values: { interestRate: 0.01 } }, [
      { on: 'waveCleared', do: [{ kind: 'interest', rateStep: 0 }] },
    ]);
    flat.state.shards = num(1000);
    expect([payout(flat, 10), payout(flat, 11)]).toEqual([plain, plain]);
  });

  it.each([
    ['interestRate −0.05', { interestRate: -0.05 }, [], 1],
    [
      'interestRate NaN (a module’s offset)',
      {},
      [(b) => b.offsetStat('interestRate', Number.NaN)],
      1,
    ],
    ['bonusWaveInterest −2', { interestRate: 0.01, bonusWaveInterest: -2 }, [], 10],
    [
      'bonusWaveInterest NaN (a module’s offset)',
      { interestRate: 0.01 },
      [(b) => b.offsetStat('bonusWaveInterest', Number.NaN)],
      10,
    ],
  ] as [string, Partial<Record<StatId, number>>, TestModule[], number][])(
    'counts %s as 0: that payout is 0, never negative, and the rate still rises',
    (_label, values, modules, wave) => {
      // Planted bug: a negative or NaN interestRate or bonusWaveInterest multiplied in, paying a
      // negative amount or NaN.
      const ctx = field({ values, modules });
      ctx.state.shards = num(1000);
      const first = payout(ctx, wave);
      expect(Object.is(toNumber(first), 0), `${toNumber(first)}`).toBe(true);
      expect(Object.is(ctx.state.interestShards, 0)).toBe(true);
      expect(ctx.state.interestPayouts).toBe(1);
      // The next payout, on a wave that is no bonus wave, at the rate's next step.
      const start = wave === 10 ? 0.01 : 0;
      expect(payout(ctx, wave + 1)).toEqual(mul(num(1000), start + 0.005));
      expect(toNumber(ctx.state.interestShards)).toBeGreaterThan(0);
    },
  );

  it('adds the pool to the base under interestHeld, and leaves it out without it', () => {
    // Planted bugs: the pool in the base without interestHeld, or missing from it with it.
    const plain = field({ values: { interestRate: 0.01 } });
    const held = field({ values: { interestRate: 0.01 }, modules: [compound] });
    expect(held.build.flags.interestHeld).toBe(true);
    expect(plain.build.flags.interestHeld).toBe(false);
    for (const ctx of [plain, held]) {
      ctx.state.shards = num(1000);
      fireWaveCleared(ctx, 1);
      expect(ctx.state.interestShards).toEqual(mul(num(1000), 0.01));
      fireWaveCleared(ctx, 2);
    }
    const first = mul(num(1000), 0.01);
    expect(plain.state.interestShards).toEqual(add(first, mul(num(1000), 0.015)));
    expect(held.state.interestShards).toEqual(add(first, mul(add(num(1000), first), 0.015)));
    expect(held.state.shards).toBe(num(1000));
  });

  it('is scaled by no fusion coefficient, draws no RNG and raises no event', () => {
    // Planted bugs: interest scaled by the trigger's coefficient (its rateStep or rateMax a
    // COEF_FIELD, or the payout × coef); a payout that draws from a stream or pushes an event.
    // A coefficient of 2, as spendShards' test takes: the trigger's chance stays 1.
    const specs: InterestSpec[] = [INTEREST, { kind: 'interest', rateStep: 0.01, rateMax: 0.02 }];
    for (const spec of specs) {
      const trigger = { on: 'waveCleared', do: [spec] } as const;
      const one = field({ values: { interestRate: 0.01 } }, [trigger]);
      const fused = field({ values: { interestRate: 0.01 }, coef: 2 }, [trigger]);
      expect(fused.build.triggers.at(-1)?.coef).toBe(2);
      expect(fused.build.effects.at(-1)?.spec).toEqual(spec);
      for (const ctx of [one, fused]) ctx.state.shards = num(1000);
      const before = rngPositions(fused);
      fused.events.length = 0;
      const paid = [1, 2, 3, 10].map((wave) => [payout(one, wave), payout(fused, wave)]);
      for (const [a, b] of paid) expect(b).toBe(a);
      expect(fused.state.interestPayouts).toBe(4);
      expect(rngPositions(fused)).toEqual(before);
      expect(fused.events).toEqual([]);
    }
  });
});

describe('the waveCleared event (lead ruling G1)', () => {
  it('raises it once per cleared record, in record order, carrying the wave number, and once only', () => {
    // Planted bugs: waveCleared fired once per tick rather than once per cleared record, or
    // carrying the last wave's number, or fired again for a record cleared before.
    const ctx = field({ values: { interestRate: 0.01 } }, [{ on: 'waveCleared', do: [HEAL] }, PAY]);
    ctx.state.shards = num(1000);
    // The start wave's record (no enemies), then waves 2, 3 (one enemy left) and 4.
    ctx.open.push(record(2), record(3, 1), record(4));
    ctx.events.length = 0;
    updateClears(ctx);
    const cleared = (events: readonly SimEvent[]): number[] =>
      events.flatMap((e) => (e.type === 'waveCleared' ? [e.wave] : []));
    expect(cleared(ctx.events)).toEqual([1, 2, 4]);
    expect(queuedValues(ctx)).toEqual([1, 2, 4]);
    expect(ctx.state.interestPayouts).toBe(3);
    expect(ctx.open.map((rec) => rec.wave)).toEqual([3]);
    // Wave 3 clears on a later call, once; a call with nothing to clear raises nothing.
    (ctx.open[0] as WaveRecord).alive = 0;
    updateClears(ctx);
    updateClears(ctx);
    expect(cleared(ctx.events)).toEqual([1, 2, 4, 3]);
    expect(queuedValues(ctx)).toEqual([1, 2, 4, 3]);
    expect(ctx.state.interestPayouts).toBe(4);
    expect(ctx.state.interestShards).toEqual(
      [0.01, 0.015, 0.02, 0.025].reduce((sum: Num, rate) => add(sum, mul(num(1000), rate)), ZERO),
    );
  });

  it('pays an interest trigger at the clear, not from the queue, and queues any other trigger', () => {
    // Planted bug: the interest queued for the next tick's effect phase (past the run's end
    // check), or paid a second time when the queue runs.
    const ctx = field({ values: { interestRate: 0.01 } }, [PAY, { on: 'waveCleared', do: [HEAL] }]);
    ctx.state.shards = num(1000);
    fireWaveCleared(ctx, 7);
    expect(ctx.state.interestShards).toEqual(num(10));
    expect(queuedValues(ctx)).toEqual([7]);
    expect(ctx.build.triggers.map((t) => t.inline)).toEqual([false, true, false]);
    runEffectQueue(ctx);
    expect(ctx.state.interestShards).toEqual(num(10));
    expect(ctx.state.interestPayouts).toBe(1);
  });

  it('refuses an interest effect elsewhere at compile, and in a module’s addEffect', () => {
    // Planted bug: a module's trigger, which validation never sees, running interest from the
    // queue on another event (where its value is no wave's number).
    const compile = (spec: TriggerSpec) => () =>
      compileBuild(
        makeStats({}, [], {
          triggers: [{ source: 'outer.greed', spec }],
          conversions: [],
          emitters: [],
        }),
        [],
      );
    expect(compile({ on: 'hit', do: [INTEREST] })).toThrow(
      "A trigger on 'hit' with an interest effect: interest runs only on a waveCleared trigger " +
        'of interest effects alone',
    );
    expect(compile({ on: 'waveCleared', do: [INTEREST, HEAL] })).toThrow(
      "A trigger on 'waveCleared' with an interest effect",
    );
    expect(compile({ on: 'waveCleared', do: [{ kind: 'interest', rateStep: -0.1 }] })).toThrow(
      'An interest effect {"kind":"interest","rateStep":-0.1}: rateStep must be finite and >= 0 ' +
        '(got -0.1)',
    );
    expect(compile({ on: 'waveCleared', do: [{ kind: 'interest', rateMax: 1.5 }] })).toThrow(
      'rateMax must be finite and in (0, 1] (got 1.5)',
    );
    expect(() =>
      compileBuild(makeStats(), [], undefined, [
        (b) => {
          b.addEffect('outer.greed', INTEREST);
        },
      ]),
    ).toThrow('addEffect: an interest effect runs only from a waveCleared trigger');
    expect(compile(PAY)).not.toThrow();
  });
});

/** Waves of `count` triangles from wave 1, the next once the field clears or after `timerSec`. */
const wavesOf = (count: number, timerSec: number): GameData =>
  makeTestData({
    waves: {
      rules: [{ enemy: 'triangle', fromWave: 1, base: count, perWave: 0, maxCount: count }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: timerSec,
    },
  });

/** A damage more of × (held shards)^0.06: 錢包's factor (H17), on every hit. */
const HELD: Modifier = {
  stat: 'damage',
  kind: 'more',
  value: 1,
  scaling: { per: 'shardsHeld', curve: 'powFactor', exponent: 0.06 },
};

interface Run {
  readonly events: SimEvent[][];
  /** The run's shards and pool at each tick's end; [0] = 0, before the first tick. */
  readonly ends: Num[];
  readonly pools: Num[];
  /** The shardsHeld each tick's step wrote, by tick (read in the tick hook, after the step). */
  readonly held: Map<number, number>;
  readonly result: RunResult;
}

function run(
  values: Partial<Record<StatId, number>>,
  config: Partial<RunConfig>,
  data: GameData,
  modules: readonly TestModule[] = [],
  triggers: readonly TriggerSpec[] = [PAY],
): Run {
  const held = new Map<number, number>();
  const watch: TestModule = (b) => {
    b.hook('tick', (ctx) => {
      held.set(ctx.now, ctx.evalInput.shardsHeld);
    });
  };
  const sourced = triggers.map((spec): SourcedTrigger => ({ source: 'outer.greed', spec }));
  const stats = makeStats({ maxLife: 1e6, critChance: 0, ...values }, [HELD], {
    triggers: sourced,
    conversions: [],
    emitters: [],
  });
  const sim = createSimulation(makeConfig({ stats, ...config }), data, [...modules, watch]);
  const events: SimEvent[][] = [];
  const ends = [ZERO];
  const pools = [ZERO];
  while (!sim.state.finished) {
    events.push([...sim.step(NO_INPUT)]);
    ends.push(sim.state.shards);
    pools.push(sim.state.interestShards);
  }
  return { events, ends, pools, held, result: sim.result() };
}

/**
 * The pool each tick's end should hold, replayed from its waveCleared events in order: each
 * pays (shards at the tick's end, + the pool under interestHeld) × min(rateMax, interestRate +
 * n × rateStep), × bonus on a 10th wave. The run's shards change in no stage after the clears.
 */
function replay(r: Run, rate0: number, bonus: number, pooled: boolean): Num[] {
  let pool = ZERO;
  let n = 0;
  const pools = [ZERO];
  r.events.forEach((events, i) => {
    const shards = r.ends[i + 1] as Num;
    for (const event of events) {
      if (event.type !== 'waveCleared') continue;
      const rate = Math.min(INTEREST_RATE_MAX, rate0 + n * INTEREST_RATE_STEP);
      const on = pooled ? add(shards, pool) : shards;
      pool = add(pool, event.wave % 10 === 0 ? mul(on, rate * bonus) : mul(on, rate));
      n++;
    }
    pools.push(pool);
  });
  return pools;
}

const waves = (r: Run): number[] =>
  r.events.flat().flatMap((e) => (e.type === 'waveCleared' ? [e.wave] : []));

describe('interest in a run', () => {
  it('pays once per cleared wave, the cap wave’s before the run ends, into RunResult.interestShards', () => {
    // Planted bugs: waveCleared not raised on the cap wave; the run's last wave's interest lost
    // (queued past the end check); RunResult.interestShards left out or the shards'.
    const r = run(
      { damage: 1e3, interestRate: 0.01, bonusWaveInterest: 3 },
      { waveCap: 12, maxTicks: 6000 },
      wavesOf(2, 0.5),
    );
    expect(r.result.endReason).toBe('waveCap');
    expect(r.result.highestWaveCleared).toBe(12);
    expect(waves(r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const last = (r.events.at(-1) as SimEvent[]).map((e) => e.type);
    expect(last.slice(-2)).toEqual(['waveCleared', 'runEnded']);
    const pools = replay(r, 0.01, 3, false);
    expect(r.pools).toEqual(pools);
    expect(r.result.interestShards).toEqual(pools.at(-1));
    expect(toNumber(r.result.interestShards)).toBeGreaterThan(0);
    expect(r.result.shards).toBe(r.ends.at(-1));
    // The last payout, the cap wave's, is in the result.
    expect(r.result.interestShards).not.toEqual(r.pools.at(-2));
  });

  it('pays the wave cleared on the tick the player dies before the run ends', () => {
    // Planted bug: the death tick's interest queued past the end check, so lost.
    // Each wave's one triangle leaks into the player (damage 0), clearing its wave at the
    // touch, which starts the next; the third touch kills. The run holds 1000 shards from its
    // first tick.
    const shards: TestModule = (b) => {
      b.hook('tick', (ctx) => {
        ctx.state.shards = num(1000);
      });
    };
    const r = run(
      { damage: 0, maxLife: 20, interestRate: 0.01 },
      { maxTicks: 6000 },
      wavesOf(1, 1000),
      [shards],
    );
    expect(r.result.endReason).toBe('death');
    expect(waves(r)).toEqual([1, 2, 3]);
    const last = (r.events.at(-1) as SimEvent[]).map((e) => e.type);
    expect(last).toContain('waveCleared');
    expect(last.at(-1)).toBe('runEnded');
    expect(r.result.interestShards).toEqual(
      add(add(mul(num(1000), 0.01), mul(num(1000), 0.015)), mul(num(1000), 0.02)),
    );
  });

  it('counts shardsHeld = wallet + shards + pool under interestHeld, and the pool in its base', () => {
    // Planted bug: the pool missing from shardsHeld, or from the interest's base, with
    // interestHeld.
    const wallet = num(1e4);
    const r = run(
      { damage: 50, interestRate: 0.01, bonusWaveInterest: 3 },
      { walletShards: wallet, maxTicks: 1500 },
      wavesOf(2, 0.5),
      [compound],
    );
    expect(waves(r).length).toBeGreaterThanOrEqual(10);
    expect(r.pools).toEqual(replay(r, 0.01, 3, true));
    expect(toNumber(r.pools.at(-1) as Num)).toBeGreaterThan(0);
    expect(r.held.size).toBeGreaterThan(1000);
    // Each tick's step: the wallet, plus the shards and the pool at the last tick's end.
    let pooled = 0;
    for (const [tick, value] of r.held) {
      const pool = r.pools[tick - 1] as Num;
      if (toNumber(pool) > 0) pooled++;
      expect(value, `${tick}`).toBe(toNumber(add(add(wallet, r.ends[tick - 1] as Num), pool)));
    }
    expect(pooled).toBeGreaterThan(r.held.size / 2);
  });

  it('counts shardsHeld without the pool when interestHeld is not set, as the base’s own code path does', () => {
    // Planted bug: the pool in shardsHeld (or the interest's base) without interestHeld.
    const wallet = num(1e4);
    const go = (): Run =>
      run(
        { damage: 50, interestRate: 0.01, bonusWaveInterest: 3 },
        { walletShards: wallet, maxTicks: 1500 },
        wavesOf(2, 0.5),
      );
    const plain = go();
    expect(toNumber(plain.pools.at(-1) as Num)).toBeGreaterThan(0);
    expect(plain.pools).toEqual(replay(plain, 0.01, 3, false));
    for (const [tick, value] of plain.held) {
      expect(value, `${tick}`).toBe(toNumber(add(wallet, plain.ends[tick - 1] as Num)));
    }
    base.held = true;
    let own: Run;
    try {
      own = go();
    } finally {
      base.held = false;
    }
    expect(plain.held).toEqual(own.held);
    expect(plain.events).toEqual(own.events);
    expect(plain.result).toEqual(own.result);
  });

  it('pays nothing new in a run without a waveCleared trigger, event for event', () => {
    // Planted bug: a payout or a change to the run without an interest effect.
    const go = (): Run =>
      run({ damage: 50, interestRate: 0.01 }, { maxTicks: 900 }, wavesOf(2, 0.5), [], []);
    const plain = go();
    base.clear = true;
    let own: Run;
    try {
      own = go();
    } finally {
      base.clear = false;
    }
    expect(waves(plain).length).toBeGreaterThan(5);
    expect(plain.events).toEqual(own.events);
    expect(plain.result).toEqual(own.result);
    expect(Object.is(plain.result.interestShards, 0)).toBe(true);
    expect(plain.pools.every((pool) => Object.is(pool, 0))).toBe(true);
  });
});

describe('the interest base and gates at the clear', () => {
  it('pays on the shards a spend earlier in the tick left, not on the shards before it', () => {
    // Planted bug: the base read before the run's spends (SimState.shards + shardsSpent).
    const spend: TriggerSpec = { on: 'waveStart', do: [{ kind: 'spendShards', fraction: 0.5 }] };
    const ctx = field({ values: { interestRate: 0.01 } }, [PAY, spend]);
    ctx.state.shards = num(1000);
    fire(ctx, EVENT.waveStart, 0, -1, null, ctx.player.x, ctx.player.y, 0, ZERO);
    runEffectQueue(ctx);
    const left = ctx.state.shards;
    expect(toNumber(ctx.state.shardsSpent)).toBeGreaterThan(0);
    expect(add(left, ctx.state.shardsSpent)).toEqual(num(1000));
    fireWaveCleared(ctx, 1);
    expect(ctx.state.interestShards).toEqual(mul(left, 0.01));
  });

  it('holds an interest trigger to its gates at the clear (a combo condition, a cooldown, a chance), n counting payouts alone', () => {
    // Planted bug: the inline payout skipping passes (its conditions, cooldown and chance).
    const gated = (when: NonNullable<TriggerSpec['when']>): RunContext => {
      const ctx = field({ values: { interestRate: 0.01 } }, [
        { on: 'waveCleared', when, do: [INTEREST] },
      ]);
      ctx.state.shards = num(1000);
      return ctx;
    };
    const combo = gated([{ comboAtLeast: 3 }]);
    fireWaveCleared(combo, 1);
    expect(combo.state.interestPayouts).toBe(0);
    expect(Object.is(combo.state.interestShards, 0)).toBe(true);
    combo.sys.combo.stacks = 3;
    fireWaveCleared(combo, 2);
    expect(combo.state.interestShards).toEqual(mul(num(1000), 0.01));
    const cool = gated([{ cooldownSec: 10 }]);
    fireWaveCleared(cool, 1);
    fireWaveCleared(cool, 2);
    expect(cool.state.interestPayouts).toBe(1);
    cool.now += 600;
    fireWaveCleared(cool, 3);
    expect(cool.state.interestPayouts).toBe(2);
    const chance = gated([{ chance: 0.5 }]);
    const before = rngPositions(chance);
    for (let wave = 1; wave <= 40; wave++) fireWaveCleared(chance, wave);
    expect(chance.state.interestPayouts).toBeGreaterThan(0);
    expect(chance.state.interestPayouts).toBeLessThan(40);
    expect(rngPositions(chance)).not.toEqual(before);
  });
});
