/**
 * C5.9's minionCount scaling variable (docs/v3/game-design-v3.md:572 「場上每有 1 架小無人機，中心
 * 傷害 +4%（最多 +20%）」; lead ruling P7): the live timed rows of the drone pool (spawnDrone's
 * spirits; never the fixed drones and turrets), counted by the globals step
 * (src/sim/systems/globals.ts) into EvalInput.minionCount once a tick, only in a run whose
 * BuildFlags.minionCount compileBuild set from a modifier scaled on it; and :572's line as data.
 * Each test names in a comment the planted bug it kills.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { bonusModifiers } from '../../data/fusion/generate';
import { ModifierSchema, ScalingSpecSchema } from '../../data/schema';
import type { Modifier } from '../../data/stats';
import { SCALING_VARS } from '../../data/triggers';
import type { SpawnDroneSpec, TriggerSpec } from '../../data/triggers';
import { nodeEffectIssues } from '../../data/validate';
import { BonusSpecSchema } from '../../data/web/schema';
import type { BonusSpec } from '../../data/web/types';
import { compileBuild } from '../build/compile';
import { runEffect } from '../effects/execute';
import { createEffectEntry } from '../effects/queue';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { makeConfig, makeStats, placedEnemies, stationarySquares } from '../testing';
import { DRONE_KIND_SPIRIT, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import type { RunContext } from './context';
import { minionCount, stepGlobals } from './globals';

/** :572's line: center damage +4 % per temporary summon on the field, at most +20 %. */
const PER_MINION: Modifier = {
  stat: 'damage',
  kind: 'increased',
  value: 0.04,
  scope: 'center',
  scaling: { per: 'minionCount', cap: 0.2 },
};
/** +1 % crit chance per 1,000 shards held: a build whose globals step runs for shardsHeld alone. */
const HELD: Modifier = {
  stat: 'critChance',
  kind: 'flat',
  value: 0.01,
  scaling: { per: 'shardsHeld', every: 1000 },
};
const spawnSpec = (fields: Partial<SpawnDroneSpec> = {}): SpawnDroneSpec => ({
  kind: 'spawnDrone',
  lifeSec: 4,
  damagePct: 1,
  ...fields,
});
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
const NO_EFFECTS = { rules: [], modifiers: [], triggers: [], conversions: [], emitters: [] };

const flagOf = (scoped: readonly Modifier[], modules: readonly TestModule[] = []): boolean =>
  compileBuild(makeStats({}, scoped), [], undefined, modules).flags.minionCount;

/** A run context with these spawnDrone specs on never-firing heroHit triggers and a drone grant. */
function field(specs: readonly Partial<SpawnDroneSpec>[], scoped: readonly Modifier[] = []) {
  return placedEnemies([{ x: 100, y: 100 }], {
    stats: makeStats(NO_ROLLS, scoped, {
      triggers: specs.map((s) => ({
        source: 'outer.summon',
        spec: { on: 'heroHit', do: [spawnSpec(s)] } as TriggerSpec,
      })),
      conversions: [],
      emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 2, turrets: 1 } }],
    }),
  });
}
/** Runs the build's n-th spawnDrone effect at the player. */
function spawn(ctx: RunContext, n = 0): void {
  const found = ctx.build.effects.flatMap((fx, i) => (fx.kind === 'spawnDrone' ? [i] : []));
  const entry = createEffectEntry();
  entry.effect = found[n] as number;
  entry.depth = 1;
  entry.origin = -1;
  entry.x = ctx.player.x;
  entry.y = ctx.player.y;
  runEffect(ctx, entry);
}

describe('BuildFlags.minionCount (lead ruling P7)', () => {
  it('is appended to SCALING_VARS after enemiesInAura, and a modifier may scale on it', () => {
    expect(SCALING_VARS.slice(-2)).toEqual(['enemiesInAura', 'minionCount']);
    expect(SCALING_VARS).toHaveLength(11);
    expect(ModifierSchema.safeParse(PER_MINION).success).toBe(true);
    expect(nodeEffectIssues('node', { ...NO_EFFECTS, modifiers: [PER_MINION] })).toEqual([]);
    expect(ScalingSpecSchema.safeParse({ per: 'minionCount', every: 2, cap: 0.5 }).success).toBe(
      true,
    );
  });

  it('is set from a modifier of any stat scaled on it, a module’s included, and false otherwise', () => {
    // Planted bug: the gate set from a modifier on another variable, or never.
    expect(flagOf([PER_MINION])).toBe(true);
    const crit: Modifier = {
      stat: 'critChance',
      kind: 'flat',
      value: 0.01,
      scaling: { per: 'minionCount', cap: 0.1 },
    };
    expect(flagOf([crit])).toBe(true);
    expect(flagOf([])).toBe(false);
    expect(flagOf([HELD])).toBe(false);
    const adds: TestModule = (b) => b.addModifier(PER_MINION);
    expect(flagOf([], [adds])).toBe(true);
    // A module's own setting is kept (||=, not =).
    const sets: TestModule = (b) => {
      b.flags.minionCount = true;
    };
    expect(flagOf([], [sets])).toBe(true);
  });
});

describe('the minionCount count (src/sim/systems/globals.ts)', () => {
  it('counts the live timed rows alone: never the fixed drones and turrets, nor a row whose time is up', () => {
    // Planted bug: minionCount counting the fixed rows.
    const ctx = field([{ count: 3 }, { count: 2, lifeSec: 1 }]);
    const ds = ctx.sys.drones;
    expect(ds.count).toBe(3);
    expect(minionCount(ctx)).toBe(0);
    spawn(ctx, 0);
    spawn(ctx, 1);
    expect(ds.count).toBe(8);
    expect(minionCount(ctx)).toBe(5);
    // The 1-second rows' time is up on tick 61 (until 1 + 60): the drone stage drops them then,
    // and the count, taken before it, no longer counts them.
    expect(Array.from(ds.until.subarray(3, 8))).toEqual([241, 241, 241, 61, 61]);
    ctx.now = 60;
    expect(minionCount(ctx)).toBe(5);
    ctx.now = 61;
    expect(minionCount(ctx)).toBe(3);
    ctx.now = 241;
    expect(minionCount(ctx)).toBe(0);
    for (let s = 0; s < ds.count; s++) expect(ds.kind[s] === DRONE_KIND_SPIRIT).toBe(s >= 3);
  });

  it('is written by the globals step only when asked', () => {
    // Planted bug: minionCount written without its gate (another variable's step writing it).
    const ctx = field([{ count: 4 }]);
    spawn(ctx);
    stepGlobals(ctx, num(0), true, false, true, false);
    expect(ctx.evalInput.minionCount).toBe(0);
    stepGlobals(ctx, num(0), false, false, false, true);
    expect(ctx.evalInput.minionCount).toBe(4);
    // And left as it is when not.
    spawn(ctx);
    stepGlobals(ctx, num(0), true, true, true);
    expect(ctx.evalInput.minionCount).toBe(4);
  });
});

describe('minionCount through a run', () => {
  /** Every second attack spawns one 2.5 s spirit, at most 7 live, beside a drone grant. */
  const SPAWNER: TriggerSpec = {
    on: 'nthAttack',
    every: 2,
    target: { pick: 'player' },
    do: [spawnSpec({ lifeSec: 2.5, damagePct: 0.2, impacts: 4, maxLive: 7 })],
  };
  const config = (scoped: readonly Modifier[]) =>
    makeConfig({
      stats: makeStats({ ...NO_ROLLS, maxLife: 1e12, attackSpeed: 6 }, scoped, {
        triggers: [{ source: 'outer.summon', spec: SPAWNER }],
        conversions: [],
        emitters: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 2, turrets: 1 } }],
      }),
      maxTicks: 900,
    });
  /** Each tick's events, the count its globals step wrote and the live spirits it started with. */
  function run(scoped: readonly Modifier[]) {
    const watched: { ctx: RunContext | null } = { ctx: null };
    const grab: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        watched.ctx = ctx;
      });
    const sim = createSimulation(config(scoped), stationarySquares(12), [grab]);
    const ticks: { events: readonly SimEvent[]; written: number; before: number }[] = [];
    let before = 0;
    while (!sim.state.finished) {
      // The step's array is reused next tick: a copy.
      const events = sim.step(NO_INPUT).slice();
      const ctx = watched.ctx as RunContext;
      ticks.push({ events, written: ctx.evalInput.minionCount, before });
      // The live rows the next tick's globals step will find: nothing touches the pool between
      // this tick's end and that step.
      const ds = ctx.sys.drones;
      before = 0;
      for (let s = 0; s < ds.count; s++) {
        if (ds.kind[s] === DRONE_KIND_SPIRIT && (ds.until[s] as number) > ctx.now + 1) before++;
      }
    }
    return ticks;
  }

  it('snapshots the live spirits at each tick’s globals step, the rows spawned later that tick counting from the next', () => {
    // Planted bug: the count taken after the tick's spawns (stage 11), or at the drone stage.
    const ticks = run([PER_MINION]);
    const values = new Set<number>();
    let grew = 0;
    for (const [i, t] of ticks.entries()) {
      expect(t.written, `tick ${i + 1}`).toBe(t.before);
      values.add(t.written);
      // The pool grew after this tick's step: a row its effects spawned, which it did not count.
      const after = ticks[i + 1]?.before ?? t.before;
      if (after > t.written) grew++;
    }
    // Coverage: every count from 0 to the cap of 7, and many ticks that spawn after the step.
    expect([...values].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(grew).toBeGreaterThan(30);
  });

  it('stays 0 in a run without the gate, even one whose globals step runs for another variable', () => {
    // Planted bug: minionCount written without its gate.
    for (const scoped of [[], [HELD]]) {
      const ticks = run(scoped);
      expect(ticks.every((t) => t.written === 0)).toBe(true);
      expect(Math.max(...ticks.map((t) => t.before))).toBe(7);
    }
  });

  it('scales the center hits by 1 + min(0.2, 0.04 × count) and nothing else: :572 as data', () => {
    // Planted bugs: the reader on another variable; the cap missing.
    const scaled = run([PER_MINION]);
    const plain = run([]);
    const factors = new Set<number>();
    const counts = new Set<number>();
    let center = 0;
    let other = 0;
    for (const [i, t] of scaled.entries()) {
      const p = plain[i] as (typeof plain)[number];
      expect(p.before, `tick ${i + 1}`).toBe(t.before);
      const a = t.events.filter((e): e is Extract<SimEvent, { type: 'hit' }> => e.type === 'hit');
      const b = p.events.filter((e): e is Extract<SimEvent, { type: 'hit' }> => e.type === 'hit');
      expect(a.map((h) => [h.targetId, h.source, h.tags])).toEqual(
        b.map((h) => [h.targetId, h.source, h.tags]),
      );
      const factor = 1 + Math.min(0.2, 0.04 * t.written);
      for (const [k, h] of a.entries()) {
        const want = toNumber((b[k] as typeof h).amount);
        if (h.source === 0) {
          expect(toNumber(h.amount), `tick ${i + 1}`).toBeCloseTo(want * factor, 9);
          factors.add(Math.round(factor * 100));
          counts.add(t.written);
          center++;
        } else {
          expect(toNumber(h.amount), `tick ${i + 1}`).toBe(want);
          other++;
        }
      }
    }
    // From × 1.04 at one spirit to the cap × 1.2, reached at 5 and held at 6 and 7 (no center hit
    // lands while none is live: the first attack spawns the first row before its hits land).
    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([...factors].sort((a, b) => a - b)).toEqual([104, 108, 112, 116, 120]);
    expect(center).toBeGreaterThan(150);
    expect(other).toBeGreaterThan(80);
  });

  it('writes :572 as a summon payload’s fusion bonus with the scaling vocabulary as it is', () => {
    const bonus: BonusSpec = {
      form: 'scaling',
      kind: 'increased',
      value: 0.04,
      scaling: { per: 'minionCount', cap: 0.2 },
    };
    expect(BonusSpecSchema.safeParse(bonus).success).toBe(true);
    // At the fusion's coefficient 1 it is PER_MINION itself.
    expect(bonusModifiers(bonus, 'fusion.fire.summon', 1)).toEqual([PER_MINION]);
  });
});
