/**
 * The walletWeight stat (E17, lead ruling G1; ◆金庫's 「錢包碎片算 1.5 倍」, gd:500): the wallet
 * shardsHeld counts is RunConfig.walletShards × walletWeight when the weight is above 0, and 0
 * when it is not (NaN included), formed once a run where the simulation hoists the wallet
 * (weighWallet, src/sim/systems/globals.ts); at 1 the wallet passes as it is, so the run is the
 * base's bit for bit. The run's own shards count once, and the config's wallet stays unweighted.
 * Each test names in a comment the planted bug it kills.
 */

import { describe, expect, it, vi } from 'vitest';
import { add, mul, num, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { Modifier, StatId } from '../../data/stats';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData } from '../testing';
import { NO_INPUT } from '../types';
import type { RunConfig, RunResult, SimEvent } from '../types';
import type * as Globals from './globals';
import { weighWallet } from './globals';

// The base's own code path: under `base`, the simulation's wallet is the config's as it is
// (`config.walletShards ?? ZERO`), whatever the weight, as before E17.
const mode = vi.hoisted(() => ({ base: false }));
vi.mock('./globals', async (importOriginal) => {
  const actual = await importOriginal<typeof Globals>();
  return {
    ...actual,
    weighWallet: (wallet: Num, weight: number): Num =>
      mode.base ? wallet : actual.weighWallet(wallet, weight),
  };
});

/** A damage more of × (held shards)^0.12: greed's factor (H17), on every hit. */
const HELD: Modifier = {
  stat: 'damage',
  kind: 'more',
  value: 1,
  scaling: { per: 'shardsHeld', curve: 'powFactor', exponent: 0.12 },
};

const WALLET = num(1e4);

interface Run {
  /** The shardsHeld each tick's step wrote, by tick (read in the tick hook, after the step). */
  readonly held: Map<number, number>;
  /** The run's shards at each tick's end; ends[0] = 0, before the first tick. */
  readonly ends: number[];
  readonly events: SimEvent[][];
  readonly result: RunResult;
  readonly config: RunConfig;
}

/** A 600-tick run of the fixture's waves from wave 10, reading shardsHeld, at `values`. */
function run(
  values: Partial<Record<StatId, number>>,
  config: Partial<RunConfig> = { walletShards: WALLET },
  modules: readonly TestModule[] = [],
): Run {
  const held = new Map<number, number>();
  const watch: TestModule = (b) => {
    b.hook('tick', (ctx) => {
      held.set(ctx.now, ctx.evalInput.shardsHeld);
    });
  };
  const stats = makeStats({ damage: 12, maxLife: 1e6, critChance: 0.2, ...values }, [HELD]);
  const full = makeConfig({ stats, startWave: 10, maxTicks: 600, ...config });
  const sim = createSimulation(full, makeTestData(), [...modules, watch]);
  const ends = [0];
  const events: SimEvent[][] = [];
  while (!sim.state.finished) {
    events.push([...sim.step(NO_INPUT)]);
    ends.push(toNumber(sim.state.shards));
  }
  return { held, ends, events, result: sim.result(), config: full };
}

/** Whether every tick's step wrote `wallet` plus the run's shards at the last tick's end. */
function heldIs(r: Run, wallet: Num): void {
  expect(r.held.size).toBeGreaterThan(500);
  expect(r.ends.at(-1)).toBeGreaterThan(0);
  for (const [tick, value] of r.held) {
    expect(value, `${tick}`).toBe(toNumber(add(wallet, num(r.ends[tick - 1] as number))));
  }
}

describe('weighWallet (lead ruling G1)', () => {
  it('weighs the wallet by a weight above 0, passes it as it is at 1, and counts 0 otherwise', () => {
    // Planted bugs: a negative or NaN weight multiplied in (a negative wallet, or NaN); a weight
    // of 1 that is not the wallet itself.
    expect(weighWallet(WALLET, 1.5)).toBe(15000);
    expect(weighWallet(WALLET, 0.5)).toBe(5000);
    expect(weighWallet(num(3), 1e-9)).toBe(mul(num(3), 1e-9));
    expect(Object.is(weighWallet(WALLET, 1), WALLET)).toBe(true);
    for (const weight of [0, -0, -1, -Infinity, Number.NaN]) {
      expect(Object.is(weighWallet(WALLET, weight), 0), `${weight}`).toBe(true);
    }
    expect(Object.is(weighWallet(ZERO, 1.5), 0)).toBe(true);
  });
});

describe('the weighed wallet in a run', () => {
  it('counts shardsHeld = 1.5 × wallet + the run’s shards at walletWeight 1.5, the run’s shards once', () => {
    // Planted bugs: the weight applied to the run's shards as well; the wallet left unweighted.
    heldIs(run({ walletWeight: 1.5 }), mul(WALLET, 1.5));
  });

  it('runs at walletWeight 1 as the base’s own code path does, event for event', () => {
    // Planted bugs: a weight of 1 changing the wallet (a product, or the shards weighed).
    mode.base = true;
    let base: Run;
    try {
      base = run({});
    } finally {
      mode.base = false;
    }
    const weighed = run({ walletWeight: 1 });
    heldIs(weighed, WALLET);
    expect(weighed.events).toEqual(base.events);
    expect(weighed.result).toEqual(base.result);
    expect(weighed.held).toEqual(base.held);
    // And without a wallet.
    mode.base = true;
    try {
      base = run({}, {});
    } finally {
      mode.base = false;
    }
    expect(run({}, {}).events).toEqual(base.events);
  });

  it.each([
    ['0', { walletWeight: 0 }, []],
    ['−1', { walletWeight: -1 }, []],
    ['NaN (a module’s offset)', {}, [(b) => b.offsetStat('walletWeight', Number.NaN)]],
  ] as [string, Partial<Record<StatId, number>>, TestModule[]][])(
    'counts the wallet as 0 at walletWeight %s: shardsHeld is the run’s shards alone',
    (_label, values, modules) => {
      // Planted bug: a weight of 0 or less, or NaN, multiplied in rather than counted as 0.
      heldIs(run(values, { walletShards: WALLET }, modules), ZERO);
    },
  );

  it('takes a module’s scaleStat of the weight, and leaves the config’s wallet unweighted', () => {
    // Planted bugs: the weight read from StatBlock.values before the modules; the weighed wallet
    // written back to RunConfig.walletShards.
    const scaled = run({}, { walletShards: WALLET }, [(b) => b.scaleStat('walletWeight', 1.5)]);
    heldIs(scaled, mul(WALLET, 1.5));
    expect(scaled.config.walletShards).toBe(WALLET);
    expect(run({ walletWeight: 1.5 }).config.walletShards).toBe(WALLET);
  });
});
