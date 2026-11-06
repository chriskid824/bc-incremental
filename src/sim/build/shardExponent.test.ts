/**
 * The shardExponent stat (E17, lead ruling G2; ★守財奴's 「持有碎片加成的指數 ×1.5」, gd:503): read
 * once a compile, before any rule module runs, as comboCap is, into the factor e (heldExponent:
 * the stat when finite and above 0, else 1); every scaling whose `per` is shardsHeld on the pow
 * and powFactor curves, the build's and a module's addModifier ones, compiles with its exponent
 * × e (compileScaling through compileMods), and at e = 1 with its spec's own exponent, so the run
 * is the base's bit for bit. Other variables, the linear and log10 curves and a scaling's cap
 * take nothing from it. Each test names in a comment the planted bug it kills.
 */

import { describe, expect, it, vi } from 'vitest';
import { num, toNumber } from '../../core/num';
import type { Modifier, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import { SCALING_VARS } from '../../data/triggers';
import type { ScalingSpec, ScalingVar } from '../../data/triggers';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, makeTestData } from '../testing';
import { NO_INPUT } from '../types';
import type { RunResult, SimEvent } from '../types';
import { compileBuild } from './compile';
import type { CompiledBuild } from './compile';
import type * as Eval from './eval';
import { compileScaling, heldExponent, statAt, staticInput } from './eval';
import type { CompiledScaling } from './eval';
import { SCOPED_INDEX } from './modTable';
import { CENTER, rowKey } from './sources';

// The base's own code path: under `base`, every scaling compiles as edc7023's compileScaling
// compiled it, line for line (its reader from the registry, which this tree keeps), whatever
// the factor.
const mode = vi.hoisted(() => ({ base: false }));
vi.mock('./eval', async (importOriginal) => {
  const actual = await importOriginal<typeof Eval>();
  const curves = { linear: 0, log10: 1, pow: 2, powFactor: 3 } as const;
  const base = (spec: ScalingSpec): CompiledScaling => ({
    read: actual.compileScaling({ per: spec.per }).read,
    every: spec.every ?? 0,
    curve: curves[spec.curve ?? 'linear'],
    exponent: spec.exponent ?? 1,
    cap: spec.curve === 'powFactor' ? (spec.cap ?? Infinity) - 1 : (spec.cap ?? Infinity),
  });
  return {
    ...actual,
    compileScaling: (spec: ScalingSpec, shardExponent?: number): CompiledScaling =>
      mode.base ? base(spec) : actual.compileScaling(spec, shardExponent),
  };
});

/** A damage more of × (held shards)^exponent: 錢包's 0.06 (gd:498), one rank of 存款 another. */
const held = (exponent: number, cap?: number): Modifier => ({
  stat: 'damage',
  kind: 'more',
  value: 1,
  scaling: {
    per: 'shardsHeld',
    curve: 'powFactor',
    exponent,
    ...(cap === undefined ? {} : { cap }),
  },
});
/** A damage more of × (x)^0.06 on another variable. */
const factorOn = (per: ScalingVar): Modifier => ({
  stat: 'damage',
  kind: 'more',
  value: 1,
  scaling: { per, curve: 'powFactor', exponent: 0.06 },
});
/** A damage increased of 0.1 × x^0.5 (pow) on `per`. */
const powOn = (per: ScalingVar): Modifier => ({
  stat: 'damage',
  kind: 'increased',
  value: 0.1,
  scaling: { per, curve: 'pow', exponent: 0.5 },
});

const compiled = (
  values: Partial<Record<StatId, number>>,
  mods: readonly Modifier[],
  modules: readonly TestModule[] = [],
): CompiledBuild => compileBuild(makeStats(values, mods), [], undefined, modules);
const exponents = (build: CompiledBuild): number[] =>
  build.mods.map((mod) => mod.scale?.exponent ?? Number.NaN);
/** The damage factor of a center hit when `x` shards are held (statAt, as a hit reads it). */
const factorAt = (build: CompiledBuild, x: number): number =>
  statAt(build.table, build.table.row(rowKey(TAG.hit, CENTER)), SCOPED_INDEX.damage, {
    ...staticInput(),
    shardsHeld: x,
  });

const H = [0, 0.5, 1, 2, 1e4, 1.5e4, 1e6, 1e8];

describe('heldExponent (lead ruling G2)', () => {
  it('takes a finite factor above 0 as it is and counts 0, −0, −1, NaN and ±Infinity as 1', () => {
    // Planted bugs: a bad value used as it is (0 turns the bonus off, −1 makes it a penalty,
    // NaN poisons every hit); `>= 0`; no finiteness test.
    expect([1.5, 1, 0.5, 1e-9, 3].map(heldExponent)).toEqual([1.5, 1, 0.5, 1e-9, 3]);
    for (const value of [0, -0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(heldExponent(value), `${value}`).toBe(1);
    }
  });
});

describe('the factor on a shardsHeld exponent (E17, lead ruling G2)', () => {
  it('compiles 錢包’s powFactor at 0.06 under shardExponent 1.5 to exactly 0.09, and a hit’s factor to max(1, H) ** 0.09', () => {
    // Planted bugs: the factor left out, or read after the scalings compile (0.06); applied to
    // the value or to the cap instead of the exponent.
    expect(0.06 * 1.5).toBe(0.09);
    const build = compiled({ shardExponent: 1.5 }, [held(0.06)]);
    expect(build.mods[0]?.scale).toEqual({
      read: compileScaling({ per: 'shardsHeld' }).read,
      every: 0,
      curve: 3,
      exponent: 0.09,
      cap: Infinity,
    });
    expect(build.mods[0]?.value).toBe(1);
    for (const x of H) expect(factorAt(build, x), `${x}`).toBe(Math.max(1, x) ** 0.09);
    // 1e4 held: ×1.7378 at 0.06, ×2.2909 at 0.09.
    expect(factorAt(compiled({}, [held(0.06)]), 1e4)).toBe(1e4 ** 0.06);
    expect(factorAt(build, 1e4).toFixed(4)).toBe('2.2909');
  });

  it('scales each of two copies (錢包 and 存款, 0.06 each) once: 0.09 and 0.09, and the factor H^0.09 × H^0.09', () => {
    // Planted bugs: the factor applied to the first copy only, or twice to the second (a running
    // product over the row's copies).
    const build = compiled({ shardExponent: 1.5 }, [held(0.06), held(0.06)]);
    expect(exponents(build)).toEqual([0.09, 0.09]);
    for (const x of H) {
      const p = Math.max(1, x) ** 0.09;
      expect(factorAt(build, x), `${x}`).toBe(p * p);
    }
    // Three copies, as many ranks as data writes, each the same.
    expect(
      exponents(compiled({ shardExponent: 1.5 }, [held(0.06), held(0.06), held(0.06)])),
    ).toEqual([0.09, 0.09, 0.09]);
  });

  it('scales a pow-curve shardsHeld scaling too: 0.1 × H^0.5 becomes 0.1 × H^0.75, on any scoped stat', () => {
    // Planted bugs: the factor on the powFactor curve alone; on damage's scalings alone.
    const build = compiled({ shardExponent: 1.5 }, [powOn('shardsHeld')]);
    expect(exponents(build)).toEqual([0.75]);
    for (const x of H) expect(factorAt(build, x), `${x}`).toBe(1 + 0.1 * x ** 0.75);
    const crit: Modifier = { ...powOn('shardsHeld'), stat: 'critChance', kind: 'flat' };
    expect(exponents(compiled({ shardExponent: 1.5 }, [crit, held(0.06)]))).toEqual([0.75, 0.09]);
  });

  it('leaves a pow or powFactor scaling on every other variable, enemiesInAura and minionCount among them, as the spec writes it', () => {
    // Planted bugs: the factor on every scaling, or on every powFactor whatever its `per`.
    const others = SCALING_VARS.filter((per) => per !== 'shardsHeld');
    expect(others).toHaveLength(10);
    expect(others).toEqual(expect.arrayContaining(['enemiesInAura', 'minionCount']));
    const mods = others.flatMap((per) => [factorOn(per), powOn(per)]);
    const build = compiled({ shardExponent: 1.5 }, mods);
    expect(exponents(build)).toEqual(others.flatMap(() => [0.06, 0.5]));
    expect(build.mods).toEqual(compiled({}, mods).mods);
  });

  it('leaves a linear and a log10 shardsHeld scaling, and a step size, as the spec writes them', () => {
    // Planted bugs: the factor on every curve's stored exponent; on `every`.
    const mods: Modifier[] = [
      { stat: 'damage', kind: 'increased', value: 1e-4, scaling: { per: 'shardsHeld' } },
      {
        stat: 'damage',
        kind: 'increased',
        value: 0.1,
        scaling: { per: 'shardsHeld', curve: 'log10', every: 100, cap: 2 },
      },
      {
        stat: 'damage',
        kind: 'more',
        value: 1,
        scaling: { per: 'shardsHeld', curve: 'powFactor', exponent: 0.06, every: 100 },
      },
    ];
    const build = compiled({ shardExponent: 1.5 }, mods);
    const base = compiled({}, mods);
    expect(build.mods.slice(0, 2)).toEqual(base.mods.slice(0, 2));
    expect(
      build.mods.map((mod) => [mod.scale?.curve, mod.scale?.exponent, mod.scale?.every]),
    ).toEqual([
      [0, 1, 0],
      [1, 1, 100],
      [3, 0.09, 100],
    ]);
  });

  it('leaves a powFactor’s cap alone: cap 4 stores 3 under 1.5, and the factor stops at ×4 sooner', () => {
    // Planted bugs: the factor on the cap ((4 − 1) × 1.5, or 4 × 1.5 − 1).
    const build = compiled({ shardExponent: 1.5 }, [held(0.06, 4)]);
    expect(build.mods[0]?.scale?.cap).toBe(3);
    expect(compiled({}, [held(0.06, 4)]).mods[0]?.scale?.cap).toBe(3);
    // 4 is reached at H = 4^(1/0.09) ≈ 4.89e6 under 1.5, at 4^(1/0.06) ≈ 1.08e10 without it.
    expect([1e4, 1e6, 1e7, 1e8].map((x) => factorAt(build, x))).toEqual([
      1e4 ** 0.09,
      1e6 ** 0.09,
      4,
      4,
    ]);
    expect(factorAt(compiled({}, [held(0.06, 4)]), 1e8)).toBe(1e8 ** 0.06);
  });

  it('takes a factor below 1 as it is: 0.5 halves 0.12 to 0.06 and a pow’s 0.5 to 0.25', () => {
    // Planted bug: the factor kept at 1 or above (the higher of the two exponents).
    const build = compiled({ shardExponent: 0.5 }, [held(0.12), powOn('shardsHeld')]);
    expect(exponents(build)).toEqual([0.06, 0.25]);
    expect(factorAt(build, 1e4)).toBe(1e4 ** 0.06 * (1 + 0.1 * 1e4 ** 0.25));
    expect(exponents(compiled({ shardExponent: 1e-9 }, [held(0.12)]))).toEqual([0.12 * 1e-9]);
  });

  it.each([
    ['0', 0],
    ['−1', -1],
    ['−0', -0],
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
  ])('counts shardExponent %s as 1: the spec’s own exponent, at compile', (_label, value) => {
    // Planted bug: a bad value used as it is (exponent 0, −0.06, NaN or Infinity).
    const build = compiled({ shardExponent: value }, [held(0.06), powOn('shardsHeld')]);
    expect(exponents(build)).toEqual([0.06, 0.5]);
    expect(build.mods).toEqual(compiled({}, [held(0.06), powOn('shardsHeld')]).mods);
  });

  it('refuses a run whose shardExponent is not finite, as every stat', () => {
    for (const value of [Number.NaN, Infinity]) {
      expect(() =>
        createSimulation(
          makeConfig({ stats: makeStats({ shardExponent: value }) }),
          makeTestData(),
        ),
      ).toThrow('Stat shardExponent is not finite');
    }
  });

  it('reads the stat before the modules, as comboCap: a module’s offsetStat or scaleStat moves the stat alone', () => {
    // Planted bug: the stat read once the modules have run (values.shardExponent at compileMods).
    const scale: TestModule = (b) => {
      b.scaleStat('shardExponent', 1.5);
    };
    const offset: TestModule = (b) => {
      b.offsetStat('shardExponent', -0.5);
    };
    const scaled = compiled({}, [held(0.06)], [scale]);
    expect([scaled.values.shardExponent, ...exponents(scaled)]).toEqual([1.5, 0.06]);
    const offsetted = compiled({ shardExponent: 1.5 }, [held(0.06)], [offset]);
    expect([offsetted.values.shardExponent, ...exponents(offsetted)]).toEqual([1, 0.09]);
  });

  it('scales a module’s addModifier shardsHeld powFactor as the build’s own', () => {
    // Planted bug: the factor on StatBlock.scoped alone, not on the modules' added modifiers.
    const adds: TestModule = (b) => {
      b.addModifier(held(0.06));
    };
    expect(exponents(compiled({ shardExponent: 1.5 }, [held(0.12)], [adds]))).toEqual([0.18, 0.09]);
    expect(exponents(compiled({}, [held(0.12)], [adds]))).toEqual([0.12, 0.06]);
  });

  it('puts the factor in the compiled scaling, compileScaling(spec, 1.5)’s, and turns on no per-tick read the base does not', () => {
    // A factor applied per hit (in scaledValue or statAt) instead of, or as well as, at compile is
    // killed by the exact hit factors above and in the run below; this pins where it lives.
    const build = compiled({ shardExponent: 1.5 }, [held(0.06)]);
    const scale = build.mods[0]?.scale as CompiledScaling;
    expect(compileScaling(held(0.06).scaling as ScalingSpec, 1.5)).toEqual(scale);
    expect(compileScaling(held(0.06).scaling as ScalingSpec)).toEqual(
      compiled({}, [held(0.06)]).mods[0]?.scale,
    );
    // The flag that turns the per-tick read on is the base's.
    expect(build.flags.shardsHeld).toBe(true);
    expect(compiled({ shardExponent: 1.5 }, []).flags.shardsHeld).toBe(false);
  });
});

/** Every variable on every curve, capped and stepped too: what a build's scalings can be. */
const EVERY_SCALING: readonly Modifier[] = SCALING_VARS.flatMap((per): Modifier[] => [
  { stat: 'damage', kind: 'increased', value: 0.01, scaling: { per } },
  { stat: 'damage', kind: 'increased', value: 0.01, scaling: { per, curve: 'log10', every: 3 } },
  { stat: 'damage', kind: 'increased', value: 0.01, scaling: { per, curve: 'pow', exponent: 0.7 } },
  {
    stat: 'damage',
    kind: 'more',
    value: 1,
    scaling: { per, curve: 'powFactor', exponent: 0.06, cap: 5, every: 2 },
  },
  { stat: 'critChance', kind: 'flat', value: 0.001, scaling: { per, cap: 0.2 } },
]);

describe('shardExponent 1 compiles and runs as the base (lead ruling G2)', () => {
  const base = <T>(f: () => T): T => {
    mode.base = true;
    try {
      return f();
    } finally {
      mode.base = false;
    }
  };

  it.each([
    ['omitted (BASE_STATS’s 1)', {}],
    ['written 1', { shardExponent: 1 }],
  ] as [string, Partial<Record<StatId, number>>][])(
    'compiles every scaling as the base’s own code path, the stat %s',
    (_label, values) => {
      // Planted bug: e = 1 multiplied in (exponent × 1), which is the same number for every
      // exponent (x × 1 = x), so this pins that equality rather than kills the product.
      const build = compiled(values, EVERY_SCALING);
      const own = base(() => compiled({}, EVERY_SCALING));
      expect(build.mods).toEqual(own.mods);
      expect(exponents(build)).toEqual(exponents(own));
      expect(build.mods.filter((mod) => mod.scale?.curve === 3)).toHaveLength(SCALING_VARS.length);
      // And the scalings the base compiles at 1.5 for every other variable.
      const others = EVERY_SCALING.filter((mod) => mod.scaling?.per !== 'shardsHeld');
      expect(compiled({ shardExponent: 1.5 }, others).mods).toEqual(
        base(() => compiled({}, others).mods),
      );
    },
  );

  interface Run {
    readonly events: SimEvent[][];
    readonly result: RunResult;
    readonly held: number[];
  }
  /** A 600-tick run from wave 10 with a wallet, 錢包 and 存款 and the scalings above, at `values`. */
  const run = (values: Partial<Record<StatId, number>>): Run => {
    const ticks: number[] = [];
    const watch: TestModule = (b) => {
      b.hook('tick', (ctx) => {
        ticks.push(ctx.evalInput.shardsHeld);
      });
    };
    const stats = makeStats({ damage: 12, maxLife: 1e6, critChance: 0.2, ...values }, [
      held(0.06),
      held(0.06),
      ...EVERY_SCALING,
    ]);
    const config = makeConfig({ stats, startWave: 10, maxTicks: 600, walletShards: num(1e4) });
    const sim = createSimulation(config, makeTestData(), [watch]);
    const events: SimEvent[][] = [];
    while (!sim.state.finished) events.push([...sim.step(NO_INPUT)]);
    return { events, result: sim.result(), held: ticks };
  };

  it('runs at shardExponent 1 as the base’s own code path does, event for event', () => {
    // Planted bug: a factor of 1 that moves any exponent, or reads the stat as anything but 1.
    const own = base(() => run({}));
    expect(own.held.length).toBeGreaterThan(500);
    expect(own.held[0]).toBe(1e4);
    for (const values of [{}, { shardExponent: 1 }]) {
      const r = run(values);
      expect(r.events).toEqual(own.events);
      expect(r.result).toEqual(own.result);
      expect(r.held).toEqual(own.held);
    }
    // And 1.5 is another run.
    expect(run({ shardExponent: 1.5 }).result.damage).not.toEqual(own.result.damage);
  });
});

describe('the factor in a run (lead ruling G2)', () => {
  it('multiplies every plain hit of a run by max(1, H)^0.09 at its tick’s held shards H', () => {
    // Planted bugs: the factor left out of a run's build; applied to the held shards (the
    // variable) instead of the exponent.
    const heldAt = new Map<number, number>();
    const watch: TestModule = (b) => {
      b.hook('tick', (ctx) => {
        heldAt.set(ctx.now, ctx.evalInput.shardsHeld);
      });
    };
    const stats = makeStats(
      { damage: 10, maxLife: 1e6, critChance: 0, igniteChance: 0, shardExponent: 1.5 },
      [held(0.06)],
    );
    const config = makeConfig({ stats, startWave: 10, maxTicks: 600, walletShards: num(1e4) });
    const sim = createSimulation(config, makeTestData(), [watch]);
    let hits = 0;
    let tick = 0;
    while (!sim.state.finished) {
      tick++;
      for (const event of sim.step(NO_INPUT)) {
        if (event.type !== 'hit') continue;
        const x = heldAt.get(tick) as number;
        expect(toNumber(event.amount), `${tick}`).toBe(10 * Math.max(1, x) ** 0.09);
        hits++;
      }
    }
    expect(hits).toBeGreaterThan(50);
    // The run's shards add to the wallet's 1e4 as it goes.
    expect(heldAt.get(1)).toBe(1e4);
    expect(Math.max(...heldAt.values())).toBeGreaterThan(1e4);
  });
});
