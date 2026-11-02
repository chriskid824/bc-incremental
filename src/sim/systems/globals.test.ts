/**
 * The per-tick run variables (docs/v3 C6 design §7.4 C6b.3, H19, H20; lead rulings G1–G3;
 * src/sim/systems/globals.ts): shardsHeld, the wallet's shards plus the run's, and enemiesInAura,
 * the alive enemies an aura pulse would reach, written into the run's EvalInput once a tick after
 * the grid and before the contact step, and only in a run whose build reads them (BuildFlags);
 * and the held-shard factor through a run (H17). Each test names in a comment the planted bug it
 * kills.
 */

import { describe, expect, it, vi } from 'vitest';
import { num, toNumber } from '../../core/num';
import type { Num } from '../../core/num';
import type { SourcedEmitter } from '../../data/emitters';
import type { Modifier } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import { compileBuild } from '../build/compile';
import { sizeOf } from '../build/size';
import { enemiesInAura, runAura } from '../emitters/aura';
import { PHASE_TICKS } from '../emitters/types';
import type { EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  STRESS_START_WAVE,
  stressData,
  stressStats,
  withinRef,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { NO_INPUT } from '../types';
import type { RunConfig, SimEvent } from '../types';
import type * as Contact from './contact';
import type { Enemy, RunContext } from './context';
import { removeEnemy } from './death';
import { GRID_LINEAR_BELOW, rebuildGrid } from './grid';
import { stepGlobals } from './globals';

// The contact step, the first that can hit, wrapped to record the shards held it starts with
// and the run's shards then, and to run a test's probe, calling through.
const contact = vi.hoisted(() => ({
  reads: [] as [number, number][],
  probe: null as ((ctx: RunContext) => void) | null,
}));
vi.mock('./contact', async (importOriginal) => {
  const actual = await importOriginal<typeof Contact>();
  return {
    ...actual,
    resolveContacts: (ctx: RunContext): void => {
      contact.reads.push([ctx.evalInput.shardsHeld, Number(ctx.state.shards)]);
      contact.probe?.(ctx);
      actual.resolveContacts(ctx);
    },
  };
});

/** A damage more of × (held shards)^exponent: greed's factor (H17), on every hit. */
const held = (exponent = 0.12): Modifier => ({
  stat: 'damage',
  kind: 'more',
  value: 1,
  scaling: { per: 'shardsHeld', curve: 'powFactor', exponent },
});
/** +2 % damage increased per enemy in the aura, at most +20 %. */
const inAura: Modifier = {
  stat: 'damage',
  kind: 'increased',
  value: 0.02,
  scaling: { per: 'enemiesInAura', cap: 0.2 },
};
const AURA: SourcedEmitter = { source: 'outer.aura', grant: { kind: 'aura' } };
const THORNS: SourcedEmitter = { source: 'outer.thorns', grant: { kind: 'thorns', damagePct: 1 } };
const EXPLODE: TriggerSpec = {
  on: 'hit',
  when: [{ hitIs: 'signature' }, { chance: 0.3 }],
  do: [{ kind: 'explode', radius: 80, damagePct: 0.5 }],
};

/** A stat block of `values` and `scoped` with `emitters` granted and `triggers` at the center. */
const statsOf = (
  values: Parameters<typeof makeStats>[0],
  scoped: readonly Modifier[],
  emitters: readonly SourcedEmitter[] = [],
  triggers: readonly TriggerSpec[] = [],
) =>
  makeStats(values, scoped, {
    triggers: triggers.map((spec) => ({ source: 'center', spec })),
    conversions: [],
    emitters,
  });

describe('BuildFlags.shardsHeld and BuildFlags.enemiesInAura (lead ruling G2)', () => {
  const flagsOf = (scoped: readonly Modifier[], modules: TestModule[] = []) => {
    const { flags } = compileBuild(makeStats({}, scoped), [], undefined, modules);
    return [flags.shardsHeld, flags.enemiesInAura];
  };

  it('sets each from a modifier scaled on it, a module’s included, and leaves both false otherwise', () => {
    // Planted bug: a flag set from a modifier on another variable.
    expect(flagsOf([held()])).toEqual([true, false]);
    expect(flagsOf([inAura])).toEqual([false, true]);
    expect(flagsOf([held(), inAura])).toEqual([true, true]);
    expect(flagsOf([])).toEqual([false, false]);
    const combo: Modifier = {
      stat: 'damage',
      kind: 'increased',
      value: 0.02,
      scaling: { per: 'comboStacks' },
    };
    expect(flagsOf([combo, { stat: 'damage', kind: 'more', value: 0.5 }])).toEqual([false, false]);
    const adds: TestModule = (b) => b.addModifier({ ...inAura, scope: 'center' });
    expect(flagsOf([], [adds])).toEqual([false, true]);
  });

  it('sets each from a modifier of any stat scaled on it, not only damage', () => {
    // Planted bug: the flags read from damage modifiers alone, so a crit chance per enemy in the
    // aura reads 0 all run.
    const crit = (per: 'shardsHeld' | 'enemiesInAura'): Modifier => ({
      stat: 'critChance',
      kind: 'flat',
      value: 0.01,
      scaling: { per, cap: 0.5 },
    });
    expect(flagsOf([crit('shardsHeld')])).toEqual([true, false]);
    expect(flagsOf([crit('enemiesInAura')])).toEqual([false, true]);
  });

  it('keeps a module’s own setting', () => {
    // Planted bug: compileBuild overwriting the flag (= instead of ||=).
    const sets: TestModule = (b) => {
      b.flags.shardsHeld = true;
      b.flags.enemiesInAura = true;
    };
    expect(flagsOf([], [sets])).toEqual([true, true]);
  });
});

describe('the globals step (src/sim/systems/globals.ts)', () => {
  /** Squares at `placed` around the player, the build reading both variables, with an aura. */
  const field = (placed: readonly PlacedEnemy[], values: Parameters<typeof makeStats>[0] = {}) =>
    placedEnemies(placed, { stats: statsOf(values, [held(), inAura], [AURA]) });

  it('writes the wallet plus the run’s shards, and the enemies an aura pulse would reach', () => {
    // Planted bugs: the wallet or the run's shards left out of shardsHeld.
    const ctx = field([{ x: 0, y: 0 }]);
    const p = ctx.player;
    Object.assign(ctx.enemies[0] as Enemy, { x: p.x + 100, y: p.y });
    ctx.state.shards = num(250);
    stepGlobals(ctx, num(1e4), true, true);
    expect([ctx.evalInput.shardsHeld, ctx.evalInput.enemiesInAura]).toEqual([10250, 1]);
    // Each only when asked.
    ctx.state.shards = num(300);
    stepGlobals(ctx, num(0), false, true);
    expect([ctx.evalInput.shardsHeld, ctx.evalInput.enemiesInAura]).toEqual([10250, 1]);
    stepGlobals(ctx, num(0), true, false);
    expect(ctx.evalInput.shardsHeld).toBe(300);
  });

  it('counts exactly the enemies a pulse reaches: one at the edge in, one just out by its size out, a dead one out', () => {
    // Planted bugs: enemiesInAura counting dead enemies, or sizes as the pulse does not (the
    // enemy's body), or the base 160 rather than the build's auraRadius.
    const offsets: readonly { dx: number; dy: number; radius?: number }[] = [
      { dx: 160, dy: 0 }, // at the edge: in
      { dx: 0, dy: 160.5, radius: 20 }, // its body reaches in, its centre does not: out
      { dx: -50, dy: 0 }, // dead: out
      { dx: -100, dy: -100 }, // in
      { dx: 260, dy: 0 }, // out; in at auraRadius 300, as the one just out
    ];
    const reached = (auraRadius: number): [number, number] => {
      const ctx = field(
        offsets.map((o) => ({
          x: 0,
          y: 0,
          ...(o.radius === undefined ? {} : { radius: o.radius }),
        })),
        { auraRadius },
      );
      const p = ctx.player;
      offsets.forEach((o, i) => {
        Object.assign(ctx.enemies[i] as Enemy, { x: p.x + o.dx, y: p.y + o.dy });
      });
      expect((ctx.enemies[1] as Enemy).radius).toBe(20);
      removeEnemy(ctx, ctx.enemies[2] as Enemy);
      rebuildGrid(ctx);
      const count = enemiesInAura(ctx);
      // The pulse itself, on its phase: its one event counts the enemies it hit.
      const em = ctx.emitters.find((e) => e.spec.kind === 'aura') as EmitterRuntime;
      ctx.now = (3 + 4 * em.index) % PHASE_TICKS;
      ctx.events.length = 0;
      runAura(ctx, em);
      const pulse = ctx.events.find((e) => e.type === 'pulse');
      return [count, pulse?.type === 'pulse' ? pulse.hits : 0];
    };
    expect(reached(160)).toEqual([2, 2]);
    expect(reached(300)).toEqual([4, 4]);
  });

  it('refuses a walletShards that is negative, NaN or infinite, and takes 0 and 1e300', () => {
    const run = (walletShards: Num) => () =>
      createSimulation(makeConfig({ walletShards }), makeTestData());
    for (const bad of [-1, Number.NaN, Infinity]) {
      expect(run(num(bad))).toThrow(`walletShards must be finite and >= 0, got ${bad}`);
    }
    expect(run(num(0))).not.toThrow();
    expect(run(num(1e300))).not.toThrow();
  });
});

describe('the globals step in a run', () => {
  interface HitRead {
    readonly tick: number;
    readonly held: number;
    /** The run's shards at the hit. */
    readonly shards: number;
  }
  /**
   * Every hit of a 600-tick run of `scoped` with `emitters` and `config`: the shards held it read
   * and the run's shards at it, and the run's shards at each tick's end (ends[0] = 0, before the
   * first tick).
   */
  function hitsOf(
    scoped: readonly Modifier[],
    config: Partial<RunConfig>,
    emitters: readonly SourcedEmitter[] = [THORNS],
  ): { hits: HitRead[]; ends: number[]; aura: number[]; events: SimEvent[][] } {
    const hits: HitRead[] = [];
    const aura: number[] = [];
    const watch: TestModule = (b) => {
      b.hook('onHit', (ctx) => {
        hits.push({
          tick: ctx.now,
          held: ctx.evalInput.shardsHeld,
          shards: toNumber(ctx.state.shards),
        });
      });
      b.hook('tick', (ctx) => {
        aura.push(ctx.evalInput.enemiesInAura);
        hits.push({ tick: ctx.now, held: ctx.evalInput.shardsHeld, shards: -1 });
      });
    };
    const stats = statsOf({ damage: 12, maxLife: 1e6, critChance: 0.2 }, scoped, emitters, [
      EXPLODE,
    ]);
    const sim = createSimulation(
      makeConfig({ stats, startWave: 10, maxTicks: 600, ...config }),
      makeTestData(),
      [watch],
    );
    contact.reads.length = 0;
    const ends = [0];
    const events: SimEvent[][] = [];
    while (!sim.state.finished) {
      events.push([...sim.step(NO_INPUT)]);
      ends.push(toNumber(sim.state.shards));
    }
    return { hits, ends, aura, events };
  }

  it.each([
    ['a wallet of 1e4', 1e4],
    ['no wallet', null],
  ])(
    'reads, with %s, at every hit of a tick the shards at its step: a kill shows from the next tick',
    (_label, wallet) => {
      // Planted bugs: the step after the first hit stage (the contact step's thorns), or later
      // (after the emitters, the projectiles); walletShards absent read as anything but 0.
      const { hits, ends } = hitsOf([held()], wallet === null ? {} : { walletShards: num(wallet) });
      const base = wallet ?? 0;
      const wrong = hits.filter((h) => h.held !== base + (ends[h.tick - 1] as number));
      expect(wrong).toEqual([]);
      // Kills before a later hit of the same tick, which reads the tick's start; the next tick's
      // first hit reads them.
      const late = hits.filter((h) => h.shards > (ends[h.tick - 1] as number));
      expect(late.length).toBeGreaterThan(0);
      // The contact step, the first that can hit, starts with them: so the step comes before it.
      expect(contact.reads.filter(([h, shards]) => h !== base + shards)).toEqual([]);
      const kills = contact.reads.filter(
        ([, shards], i) => shards > (contact.reads[i - 1]?.[1] ?? 0),
      );
      expect(kills.length).toBeGreaterThan(5);
    },
  );

  it('counts the aura’s enemies only with an aura emitter, though auraRadius is 160 without one', () => {
    // Planted bug: enemiesInAura counted without an aura emitter.
    const without = hitsOf([inAura], {}, [THORNS]);
    expect(Math.max(...without.aura)).toBe(0);
    const withAura = hitsOf([inAura], {}, [THORNS, AURA]);
    expect(Math.max(...withAura.aura)).toBeGreaterThan(2);
  });

  it('counts no enemy in an aura it lacks in a build that reads shardsHeld too', () => {
    // Planted bug: the aura emitter checked for the step as a whole rather than for the count.
    let reach = 0;
    contact.probe = (ctx) => {
      const p = ctx.player;
      const r = sizeOf(ctx.build, ctx.build.values.auraRadius);
      reach = Math.max(reach, withinRef(ctx.enemies, p.x, p.y, r * r).length);
    };
    let without: ReturnType<typeof hitsOf>;
    try {
      // A factor of 1e4^0.001 ≈ 1.009, so that enemies still reach the player.
      without = hitsOf([held(0.001), inAura], { walletShards: num(1e4) }, [THORNS]);
    } finally {
      contact.probe = null;
    }
    expect(Math.max(...without.aura)).toBe(0);
    expect(Math.min(...without.hits.map((h) => h.held))).toBeGreaterThanOrEqual(1e4);
    // Enemies came within auraRadius all the same.
    expect(reach).toBeGreaterThan(0);
  });

  it('counts, in a crowd the grid sorts into its cells, what a linear scan finds after the move', () => {
    // Planted bug: the step before the grid's rebuild, counting from the cells of the last
    // tick's sort, which the enemies have moved out of and the compaction has shifted.
    const reads: { count: number; linear: number; alive: number }[] = [];
    contact.probe = (ctx) => {
      const p = ctx.player;
      const r = sizeOf(ctx.build, ctx.build.values.auraRadius);
      reads.push({
        count: ctx.evalInput.enemiesInAura,
        linear: withinRef(ctx.enemies, p.x, p.y, r * r).length,
        alive: ctx.enemies.filter((enemy) => enemy.alive).length,
      });
    };
    try {
      const stats = stressStats({}, { triggers: [], conversions: [], emitters: [AURA] }, [inAura]);
      const sim = createSimulation(
        makeConfig({ stats, startWave: STRESS_START_WAVE, maxTicks: 600 }),
        stressData(),
      );
      while (!sim.state.finished) sim.step(NO_INPUT);
    } finally {
      contact.probe = null;
    }
    expect(reads.filter((read) => read.count !== read.linear)).toEqual([]);
    const crowded = reads.filter((read) => read.alive >= GRID_LINEAR_BELOW && read.count > 0);
    expect(crowded.length).toBeGreaterThan(100);
  });

  it('does nothing in a run whose build reads neither: EvalInput keeps 0, and a wallet changes nothing', () => {
    // Planted bug: the step running with both flags false (M1's cost).
    const plain = hitsOf([], { walletShards: num(1e4) }, [THORNS, AURA]);
    expect(new Set(plain.hits.map((h) => h.held))).toEqual(new Set([0]));
    expect(new Set(plain.aura)).toEqual(new Set([0]));
    expect(plain.ends.at(-1)).toBeGreaterThan(0);
    expect(hitsOf([], {}, [THORNS, AURA]).events).toEqual(plain.events);
  });
});

describe('the held-shard factor through a run (H17)', () => {
  /** The first hit's amount of a run of damage 10 that never crits, with `scoped`. */
  const firstHit = (scoped: readonly Modifier[], walletShards?: number): number => {
    const stats = makeStats({ damage: 10, critChance: 0 }, scoped);
    const sim = createSimulation(
      makeConfig({
        stats,
        startWave: 3,
        ...(walletShards === undefined ? {} : { walletShards: num(walletShards) }),
      }),
      makeTestData(),
    );
    for (;;) {
      const hit = sim.step(NO_INPUT).find((e) => e.type === 'hit');
      if (hit?.type === 'hit') return toNumber(hit.amount);
    }
  };

  it('multiplies a hit by 1e4^0.12 = 3.020 and by 1e8^0.12 = 9.120, and by 1 with nothing held', () => {
    const plain = firstHit([]);
    const ratio = (wallet?: number): number => firstHit([held()], wallet) / plain;
    expect(ratio(1e4)).toBeCloseTo(1e4 ** 0.12, 12);
    expect(ratio(1e4).toFixed(3)).toBe('3.020');
    expect(ratio(1e8)).toBeCloseTo(1e8 ** 0.12, 12);
    expect(ratio(1e8).toFixed(3)).toBe('9.120');
    // Before the run's first kill, nothing held: × max(1, 0)^0.12 = 1.
    expect(firstHit([held()])).toBe(plain);
    expect(firstHit([held()], 0)).toBe(plain);
  });
});
