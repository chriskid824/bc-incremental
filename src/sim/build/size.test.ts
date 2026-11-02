/**
 * E1's size factor (docs/v3 C4 design D29; Hoshi's Q2 (A)): sizeOf and countOf, and every area
 * radius the run reads through sizeOf at each factor, areaSize's, 巨大化's and bombRadius'.
 */

import { describe, expect, it } from 'vitest';
import { ZERO } from '../../core/num';
import type { SourcedEmitter } from '../../data/emitters';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import { FREEZE_LIST_RADIUS } from '../caps';
import { raiseFreeze } from '../effects/centerEvents';
import { fireOne } from '../effects/dispatch';
import { runEffectQueue } from '../effects/execute';
import { SHATTER_TRIGGER } from '../effects/types';
import type { CompiledEffect, CompiledEffectKind } from '../effects/types';
import { enemiesInAura } from '../emitters/aura';
import { aimDense, beginAim, launch, LOB_NORMAL, LOB_VOLCANO, lobRadius } from '../emitters/lob';
import { runStrike } from '../emitters/strike';
import type { EmitterRuntime } from '../emitters/types';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { moveProjectiles } from '../systems/projectiles';
import {
  centerTriggers,
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { compileBuild } from './compile';
import type { BuildFlags } from './compile';
import { countOf, sizeOf } from './size';

const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const GIANT: RuleSpec = { id: 'gigantism', sizeMult: 2 };
const MAGMA: SignatureSpec = { id: 'magmaBomb' };
const SWARM: SignatureSpec = { id: 'swarm' };
const CHAIN_BLAST: RuleSpec = { id: 'chainBlast', radius: 40, damagePct: 0.5, perBomb: 2 };
const VOLCANO: RuleSpec = { id: 'volcano', periodSec: 3, radiusMult: 3, damageMult: 5 };
/** magmaBomb's flight, in ticks, and its spec's radius and its fire zone's. */
const FLIGHT = 24;
const BOMB_RADIUS = 60;
const ZONE_RADIUS = 60;
/** A boundary probe's relative step: just inside and just outside a radius. */
const EPS = 1e-9;

interface Factor {
  readonly name: string;
  readonly values: Partial<Record<StatId, number>>;
  readonly rules: readonly RuleSpec[];
  /** The area factor: areaSize × 巨大化's sizeMult. */
  readonly area: number;
  /** bombRadius, which the bomb's radii alone take. */
  readonly bomb: number;
}

const FACTORS: readonly Factor[] = [
  { name: 'no factor', values: {}, rules: [], area: 1, bomb: 1 },
  {
    name: 'areaSize 1 and bombRadius 1',
    values: { areaSize: 1, bombRadius: 1 },
    rules: [],
    area: 1,
    bomb: 1,
  },
  { name: 'areaSize 1.5', values: { areaSize: 1.5 }, rules: [], area: 1.5, bomb: 1 },
  { name: 'bombRadius 1.2', values: { bombRadius: 1.2 }, rules: [], area: 1, bomb: 1.2 },
  { name: '巨大化', values: {}, rules: [GIANT], area: 2, bomb: 1 },
  {
    name: 'areaSize 1.5 under 巨大化',
    values: { areaSize: 1.5 },
    rules: [GIANT],
    area: 3,
    bomb: 1,
  },
  {
    name: 'areaSize 1.5 and bombRadius 1.2 under 巨大化',
    values: { areaSize: 1.5, bombRadius: 1.2 },
    rules: [GIANT],
    area: 3,
    bomb: 1.2,
  },
];

/** One effect a trigger, each at the event's point; their radii are this file's r. */
const AREA_TRIGGERS: readonly TriggerSpec[] = [
  { on: 'hit', do: [{ kind: 'explode', radius: 50, damagePct: 0.1 }] },
  { on: 'hit', do: [{ kind: 'nova', radius: 70, damagePct: 0.1, at: 'event' }] },
  { on: 'hit', do: [{ kind: 'push', distance: 10, radius: 80 }] },
  { on: 'hit', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 1, radius: 30 }] },
  { on: 'hit', do: [{ kind: 'addFrost', amount: 0.1, radius: 35 }] },
  { on: 'kill', do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 45 }] },
  { on: 'kill', do: [{ kind: 'spreadAilment', ailment: 'poison', radius: 55 }] },
  { on: 'hit', do: [{ kind: 'detonate', ailment: 'burn', radius: 25 }] },
  { on: 'hit', do: [{ kind: 'groundZone', radius: 65, durationSec: 1, damagePctPerSec: 0.1 }] },
  // A fan-out on freeze, so a freeze takes its list (raiseFreeze).
  { on: 'freeze', do: [{ kind: 'applyAilment', ailment: 'poison', stacks: 1 }] },
];
const AURA: SourcedEmitter = { source: 'outer.aura', grant: { kind: 'aura' } };
const STRIKE: SourcedEmitter = {
  source: 'outer.lightning',
  grant: {
    kind: 'strike',
    name: 'bolt',
    periodSec: 1,
    target: { pick: 'nearest' },
    damagePct: 1,
    radius: 30,
  },
};
const DRONES: SourcedEmitter = { source: 'outer.summon', grant: { kind: 'drone', drones: 2 } };

/** The run's values at `f`: no crits or ignites, a shatter of 75 and an aura of 100. */
const valuesAt = (f: Factor): Partial<Record<StatId, number>> => ({
  critChance: 0,
  igniteChance: 0,
  chainCount: 0,
  shatterRadius: 75,
  auraRadius: 100,
  ...f.values,
});

/** placedEnemies at `f` with AREA_TRIGGERS and `emitters`. */
function areaRun(
  f: Factor,
  placed: readonly PlacedEnemy[] = [],
  emitters: readonly SourcedEmitter[] = [],
  signature?: SignatureSpec,
  rules: readonly RuleSpec[] = [],
): RunContext {
  return placedEnemies(placed, {
    stats: makeStats(valuesAt(f), [], { ...centerTriggers(AREA_TRIGGERS), emitters }),
    rules: [...f.rules, ...rules],
    ...(signature === undefined ? {} : { signature }),
  });
}

/** The compiled effect of AREA_TRIGGERS' trigger `i`, of kind `kind`. */
function effectOf(ctx: RunContext, i: number, kind: CompiledEffectKind): CompiledEffect {
  const fx = ctx.build.effects[i] as CompiledEffect;
  expect(fx.kind).toBe(kind);
  return fx;
}

/** Fires AREA_TRIGGERS' trigger `i` at (x, y) and runs the effect phase; its events. */
function fireAt(ctx: RunContext, i: number, x = P.x, y = P.y): SimEvent[] {
  ctx.events.length = 0;
  fireOne(ctx, SHATTER_TRIGGER + 1 + i, 0, -1, null, x, y, 0, ZERO, -1);
  runEffectQueue(ctx);
  return [...ctx.events];
}

/**
 * The ids of the enemies `placed` that AREA_TRIGGERS' effect `i` hits at the player's point, its
 * trigger alone and on kills, so that its own hits on these immortal enemies fire nothing more.
 */
function hitsAt(f: Factor, i: number, placed: readonly PlacedEnemy[]): number[] {
  const effect = (AREA_TRIGGERS[i] as TriggerSpec).do;
  const ctx = placedEnemies(placed, {
    stats: makeStats(valuesAt(f), [], centerTriggers([{ on: 'kill', do: effect }])),
    rules: f.rules,
  });
  return [...new Set(eventsOf([fireAt(ctx, 0)], 'hit').map((hit) => hit.targetId))];
}

/** Two enemies about `c`: one just inside `d` (+x), one just outside it (−x). */
const straddle = (c: { x: number; y: number }, d: number): PlacedEnemy[] => [
  { x: c.x + d * (1 - EPS), y: c.y },
  { x: c.x - d * (1 + EPS), y: c.y },
];

/** The lob of a magmaBomb run. */
const lobOf = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;

/** Lobs a bomb of form `form` at `at` and lands it on cleared events; the landing's events. */
function bombAt(ctx: RunContext, at: { x: number; y: number }, form = LOB_NORMAL): SimEvent[] {
  const em = lobOf(ctx);
  ctx.sys.lob.x = at.x;
  ctx.sys.lob.y = at.y;
  launch(ctx, em, em.payload, form, false, 0, -1);
  ctx.now = ctx.state.tick = ctx.now + FLIGHT;
  rebuildGrid(ctx);
  ctx.events.length = 0;
  moveProjectiles(ctx);
  return [...ctx.events];
}

interface Site {
  readonly name: string;
  /** The radius as written. */
  readonly r: number;
  /** Whether bombRadius reaches it: the bomb's and its fire zone's alone. */
  readonly bomb?: boolean;
  /** 火山's radiusMult on it: a giant bomb's radii. */
  readonly grow?: number;
  /** The radii the run reads at the site at factor `f`, each asserting its own boundary. */
  readonly read: (f: Factor, expected: number) => readonly number[];
}

/** Where the bomb lands in the lob sites: 440 right of the player. */
const L = { x: P.x + 440, y: P.y };

const SITES: readonly Site[] = [
  {
    name: 'explode (its radiusSq, its burst and its hits)',
    r: 50,
    read: (f, expected) => {
      const ctx = areaRun(f);
      const [burst] = eventsOf([fireAt(ctx, 0)], 'burst');
      expect(hitsAt(f, 0, straddle(P, expected))).toEqual([1]);
      return [Math.sqrt(effectOf(ctx, 0, 'explode').radiusSq), burst?.radius ?? NaN];
    },
  },
  {
    name: 'nova (its radiusSq, its burst and its hits)',
    r: 70,
    read: (f, expected) => {
      const ctx = areaRun(f);
      const [burst] = eventsOf([fireAt(ctx, 1)], 'burst');
      expect(hitsAt(f, 1, straddle(P, expected))).toEqual([1]);
      return [Math.sqrt(effectOf(ctx, 1, 'nova').radiusSq), burst?.radius ?? NaN];
    },
  },
  {
    name: 'push',
    r: 80,
    read: (f) => [Math.sqrt(effectOf(areaRun(f), 2, 'push').radiusSq)],
  },
  {
    name: "applyAilment's radius",
    r: 30,
    read: (f) => [Math.sqrt(effectOf(areaRun(f), 3, 'applyAilment').radiusSq)],
  },
  {
    name: "addFrost's radius",
    r: 35,
    read: (f) => [Math.sqrt(effectOf(areaRun(f), 4, 'addFrost').radiusSq)],
  },
  {
    name: "spreadAilment's burn spread",
    r: 45,
    read: (f) => {
      const fx = effectOf(areaRun(f), 5, 'spreadAilment');
      const spread = fx.spread as NonNullable<CompiledEffect['spread']>;
      return [Math.sqrt(fx.radiusSq), spread.radius, Math.sqrt(spread.radiusSq)];
    },
  },
  {
    name: "spreadAilment's poison spread",
    r: 55,
    read: (f) => {
      const fx = effectOf(areaRun(f), 6, 'spreadAilment');
      const spread = fx.spread as NonNullable<CompiledEffect['spread']>;
      return [Math.sqrt(fx.radiusSq), spread.radius, Math.sqrt(spread.radiusSq)];
    },
  },
  {
    name: "detonate's radius",
    r: 25,
    read: (f) => [Math.sqrt(effectOf(areaRun(f), 7, 'detonate').radiusSq)],
  },
  {
    name: "groundZone's zone",
    r: 65,
    read: (f) => {
      const ctx = areaRun(f);
      const [zone] = eventsOf([fireAt(ctx, 8)], 'zone');
      return [zone?.radius ?? NaN];
    },
  },
  {
    name: 'the shatter (its effect and ctx.shatterRadius)',
    r: 75,
    read: (f) => {
      const ctx = areaRun(f);
      const fx = ctx.build.effects.at(-1) as CompiledEffect;
      expect(fx.kind).toBe('shatter');
      return [Math.sqrt(fx.radiusSq), ctx.shatterRadius];
    },
  },
  {
    name: "a freeze's list",
    r: FREEZE_LIST_RADIUS,
    read: (f, expected) => {
      const E = { x: P.x + 300, y: P.y };
      const ctx = areaRun(f, [E, ...straddle(E, expected)]);
      raiseFreeze(ctx, ctx.enemies[0] as Enemy, 0, -1, 0);
      const scratch = ctx.centerScratch;
      expect(scratch.list.slice(0, scratch.listCount).map((e) => e.id)).toEqual([1, 2]);
      return [scratch.radius];
    },
  },
  {
    name: "the aura's reach",
    r: 100,
    read: (f, expected) => {
      const ctx = areaRun(f, straddle(P, expected), [AURA]);
      expect(enemiesInAura(ctx)).toBe(1);
      return [];
    },
  },
  {
    name: "a strike's area",
    r: 30,
    read: (f, expected) => {
      const T = { x: P.x + 100, y: P.y };
      // Across the target from the player's line, so the target stays the nearest.
      const pair = [
        { x: T.x, y: T.y + expected * (1 - EPS) },
        { x: T.x, y: T.y - expected * (1 + EPS) },
      ];
      const ctx = areaRun(f, [T, ...pair], [STRIKE]);
      const em = ctx.emitters[1] as EmitterRuntime;
      em.timer = em.interval - 1;
      ctx.events.length = 0;
      runStrike(ctx, em);
      const hit = eventsOf([ctx.events], 'hit').map((h) => h.targetId);
      expect(hit).toContain(2);
      expect(hit).not.toContain(3);
      return [];
    },
  },
  {
    name: "the drones' splash (the swarm's and a grant's)",
    r: 40,
    read: (f) => {
      const ds = areaRun(f, [], [DRONES], SWARM).sys.drones;
      return [Math.sqrt(ds.splashSq[0] as number), Math.sqrt(ds.splashSq[1] as number)];
    },
  },
  {
    name: "chainBlast's explosion, an explode effect",
    r: 40,
    read: (f) => {
      const ctx = areaRun(f, [], [], MAGMA, [CHAIN_BLAST]);
      const blast = ctx.build.signature.lob?.chainBlast;
      const fx = ctx.build.effects[blast?.effect ?? -1] as CompiledEffect;
      expect([fx.kind, blast?.radius]).toEqual(['explode', 40]);
      return [Math.sqrt(fx.radiusSq)];
    },
  },
  {
    name: "the bomb's R: its aim and its separation 2R",
    r: BOMB_RADIUS,
    bomb: true,
    read: (f) => {
      const ctx = areaRun(f, [], [], MAGMA);
      beginAim(ctx, lobOf(ctx));
      return [Math.sqrt(ctx.sys.lob.radiusSq), Math.sqrt(ctx.sys.lob.sepSq) / 2];
    },
  },
  {
    name: "the bomb's R: its landing's explosion",
    r: BOMB_RADIUS,
    bomb: true,
    read: (f, expected) => {
      const ctx = areaRun(f, straddle(L, expected), [], MAGMA);
      const [blast] = eventsOf([bombAt(ctx, L)], 'explosion');
      expect(blast?.count).toBe(1);
      return [blast?.radius ?? NaN, ctx.centerScratch.radius];
    },
  },
  {
    name: "the bomb's 火地",
    r: ZONE_RADIUS,
    bomb: true,
    read: (f) => {
      const ctx = areaRun(f, [], [], MAGMA);
      const [zone] = eventsOf([bombAt(ctx, L)], 'zone');
      return [zone?.radius ?? NaN];
    },
  },
  {
    name: "a giant bomb's R under 火山: its aim, its separation and its landing",
    r: BOMB_RADIUS,
    bomb: true,
    grow: 3,
    read: (f, expected) => {
      const ctx = areaRun(f, straddle(L, expected), [], MAGMA, [VOLCANO]);
      beginAim(ctx, lobOf(ctx));
      const aimed = [Math.sqrt(ctx.sys.lob.radiusSq), Math.sqrt(ctx.sys.lob.sepSq) / 2];
      const [blast] = eventsOf([bombAt(ctx, L, LOB_VOLCANO)], 'explosion');
      expect(blast?.count).toBe(1);
      return [...aimed, blast?.radius ?? NaN];
    },
  },
  {
    name: "a giant bomb's 火地 under 火山",
    r: ZONE_RADIUS,
    bomb: true,
    grow: 3,
    read: (f) => {
      const ctx = areaRun(f, [], [], MAGMA, [VOLCANO]);
      const [zone] = eventsOf([bombAt(ctx, L, LOB_VOLCANO)], 'zone');
      return [zone?.radius ?? NaN];
    },
  },
];

/** A site's radius at `f` as D29 writes it: r × the area factor, × bombRadius × grow for a bomb. */
const expectedAt = (site: Site, f: Factor): number =>
  site.bomb === true ? site.r * f.area * f.bomb * (site.grow ?? 1) : site.r * f.area;

describe('sizeOf and countOf (D29)', () => {
  it('return their input for a build without areaSize or 巨大化', () => {
    const build = compileBuild(makeStats(), []);
    for (const r of [0, 4, 22.5, 70, 300]) expect(sizeOf(build, r)).toBe(r);
    for (const n of [0, 1, 3, 16]) expect(countOf(build, n)).toBe(n);
  });

  it('sizes r by the area factor, areaSize × 巨大化’s sizeMult, which compile puts in BuildFlags once', () => {
    const at = (values: Partial<Record<StatId, number>>, rules: readonly RuleSpec[] = []) =>
      compileBuild(makeStats(values), rules);
    expect(at({ areaSize: 1.5 }).flags.areaFactor).toBe(1.5);
    expect(at({}, [GIANT]).flags.areaFactor).toBe(2);
    expect(at({ areaSize: 1.5 }, [GIANT]).flags.areaFactor).toBe(3);
    // bombRadius is not an area factor: it reaches the bomb alone (lobRadius).
    expect(at({ bombRadius: 1.2 }).flags.areaFactor).toBe(1);
    for (const r of [0, 4, 22.5, 70, 300]) {
      expect(sizeOf(at({ areaSize: 1.5 }), r)).toBe(r * 1.5);
      expect(sizeOf(at({ areaSize: 1.5 }, [GIANT]), r)).toBe(r * 3);
    }
  });

  it('reads areaSize once, at compile: a value changed later moves no radius, the flag does', () => {
    const build = compileBuild(makeStats({ areaSize: 1.5 }), [GIANT]);
    (build.values as Record<StatId, number>).areaSize = 4;
    expect(sizeOf(build, 10)).toBe(30);
    (build.flags as BuildFlags).areaFactor = 5;
    expect(sizeOf(build, 10)).toBe(50);
  });

  it('takes a negative areaSize as no area at all, and a negative bombRadius as no bomb', () => {
    expect(compileBuild(makeStats({ areaSize: -0.5 }), []).flags.areaFactor).toBe(0);
    expect(sizeOf(compileBuild(makeStats({ areaSize: -0.5 }), [GIANT]), 50)).toBe(0);
    const bomb = compileBuild(makeStats({ bombRadius: -1 }), [], { id: 'magmaBomb' });
    expect(lobRadius(bomb, BOMB_RADIUS, 1)).toBe(0);
    expect(lobRadius(compileBuild(makeStats({ bombRadius: 1.2 }), []), 50, 3)).toBe(50 * 1.2 * 3);
  });

  it('halves a count under 巨大化 alone: floor(n / 2), at least 1, and none from below 1', () => {
    const plain = compileBuild(makeStats(), []);
    const giant = compileBuild(makeStats(), [GIANT]);
    const cases: readonly (readonly [number, number])[] = [
      [0, 0],
      [0.4, 0],
      [0.99, 0],
      [1, 1],
      [1.5, 1],
      [2, 1],
      [2.9, 1],
      [3, 1],
      [3.6, 1],
      [4, 2],
      [5, 2],
      [5.5, 2],
      [7, 3],
      [16, 8],
    ];
    for (const [n, halved] of cases) {
      expect(countOf(giant, n), `${n}`).toBe(halved);
      expect(Number.isInteger(countOf(giant, n)), `${n}`).toBe(true);
      expect(countOf(plain, n), `${n}`).toBe(n);
    }
  });

  it('rejects a run whose areaSize or bombRadius is not finite', () => {
    for (const stat of ['areaSize', 'bombRadius'] as const) {
      const config = makeConfig({ stats: makeStats({ [stat]: Number.NaN }) });
      expect(() => createSimulation(config, makeTestData()), stat).toThrow(
        `Stat ${stat} is not finite`,
      );
    }
  });
});

describe('every area radius through sizeOf, once (D29, lead rulings G2 and G3)', () => {
  const cases = SITES.flatMap((site) =>
    FACTORS.map((f) => ({ id: `${site.name} at ${f.name}`, site, f })),
  );

  it.each(cases)('$id', ({ site, f }) => {
    const expected = expectedAt(site, f);
    const radii = site.read(f, expected);
    for (const radius of radii) expect(radius).toBe(expected);
    // r exactly without a factor (× 火山's radiusMult on a giant bomb): r × 1 is r, bit for bit.
    if (f.area === 1 && f.bomb === 1) {
      for (const radius of radii) expect(radius).toBe(site.r * (site.grow ?? 1));
    }
  });

  it('lists every routed site: the effect radii, the shatter, the freeze list, the emitters and the bomb', () => {
    expect(SITES.map((site) => site.name)).toHaveLength(20);
    expect(SITES.filter((site) => site.bomb === true).map((site) => site.name)).toEqual([
      "the bomb's R: its aim and its separation 2R",
      "the bomb's R: its landing's explosion",
      "the bomb's 火地",
      "a giant bomb's R under 火山: its aim, its separation and its landing",
      "a giant bomb's 火地 under 火山",
    ]);
  });

  it('reads the bomb’s R once: under 巨大化 and areaSize 1.5 it is r × 1.5 × 2 × bombRadius, not doubled twice', () => {
    const f = FACTORS.at(-1) as Factor;
    const ctx = areaRun(f, [], [], MAGMA);
    beginAim(ctx, lobOf(ctx));
    const R = Math.sqrt(ctx.sys.lob.radiusSq);
    expect(R).toBe(BOMB_RADIUS * 1.5 * 2 * 1.2);
    expect(R).toBeCloseTo(216, 9);
    expect(Math.sqrt(ctx.sys.lob.sepSq)).toBe(2 * R);
    const [blast] = eventsOf([bombAt(ctx, L)], 'explosion');
    expect(blast?.radius).toBe(R);
  });

  it('keeps a firing’s bombs 2R apart at the scaled R: 150 is past 2R at areaSize 1, short of it at 1.5', () => {
    // Within R of each: 1 and 2 have both, 3 stands alone, 150 from 1 and 105 from 2. At R 60 it
    // stands past 2R (120) from 1 and takes the second bomb; at R 90 none stands 2R (180) from 1,
    // so the second goes to the best not aimed, 2.
    const order = (f: Factor): (number | null)[] => {
      const ctx = placedEnemies(
        [
          { x: 1300, y: 500 },
          { x: 1345, y: 500 },
          { x: 1450, y: 500 },
        ],
        { stats: makeStats(valuesAt(f)), rules: f.rules, signature: MAGMA },
      );
      const em = lobOf(ctx);
      beginAim(ctx, em);
      const picks = Array.from({ length: 3 }, () => aimDense(ctx, em)?.id ?? null);
      expect(ctx.sys.lob.counts.slice(0, 3)).toEqual([2, 2, 1]);
      return picks;
    };
    expect(order(FACTORS[0] as Factor)).toEqual([1, 3, 2]);
    expect(order(FACTORS[2] as Factor)).toEqual([1, 2, 3]);
  });
});
