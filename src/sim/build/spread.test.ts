/**
 * E3's spread distance (擴散距離: docs/v3/game-design-v3.md §1.2's 擴散 and §4.1's 野火):
 * spreadRadius, BuildFlags.spreadFactor and spreadOf, and every site at each factor set. What
 * spreads (a spreadAilment, an applyAilment whose radius is marked) takes r × areaSize ×
 * spreadRadius, one product (lead ruling S3); a marked selector's range and a rule module's own
 * spread distance take spreadRadius alone; every other radius stays as E1 sizes it.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber, ZERO } from '../../core/num';
import type { SourcedEmitter } from '../../data/emitters';
import type { StatId } from '../../data/stats';
import { TRIGGER_EVENTS } from '../../data/triggers';
import type { TargetSelector, TriggerSpec } from '../../data/triggers';
import { applyPoison } from '../ailments/apply';
import { addBurn, holdsBurn } from '../ailments/records';
import { holdsPoison } from '../ailments/rings';
import { PULSE_TICKS } from '../caps';
import { fireOne } from '../effects/dispatch';
import { runEffectQueue } from '../effects/execute';
import { SHATTER_TRIGGER } from '../effects/types';
import type { CompiledEffect, CompiledEffectKind, CompiledTrigger } from '../effects/types';
import { lobRadius } from '../emitters/lob';
import { runStrike } from '../emitters/strike';
import type { EmitterRuntime } from '../emitters/types';
import { enqueueModuleEffect } from '../rules';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { killEnemy } from '../systems/death';
import { runTickHooks } from '../systems/emitters';
import { stepZones } from '../systems/zones';
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
import { sizeOf, spreadOf } from './size';
import { CENTER } from './sources';

const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** The event's point, 300 right of the player: the victim, enemy 1, stands on it. */
const C = { x: P.x + 300, y: P.y };
/** A boundary probe's relative step: just inside and just outside a radius. */
const EPS = 1e-9;
/** The enemies of `around`: the victim, the one just inside and the one just outside. */
const VICTIM = 1;
const INSIDE = 2;
const OUTSIDE = 3;

interface Factor {
  readonly name: string;
  readonly values: Partial<Record<StatId, number>>;
  /** areaSize, the area factor. */
  readonly area: number;
  /** spreadRadius, the spread factor. */
  readonly spread: number;
}

const FACTORS: readonly Factor[] = [
  { name: 'no factor', values: {}, area: 1, spread: 1 },
  { name: 'spreadRadius 1.5', values: { spreadRadius: 1.5 }, area: 1, spread: 1.5 },
  { name: 'areaSize 1.2', values: { areaSize: 1.2 }, area: 1.2, spread: 1 },
  {
    name: 'spreadRadius 1.5 and areaSize 1.2',
    values: { spreadRadius: 1.5, areaSize: 1.2 },
    area: 1.2,
    spread: 1.5,
  },
];

/** The victim at `c`, then one enemy just inside `d` of it (+x) and one just outside it (−x). */
const around = (c: { x: number; y: number }, d: number): PlacedEnemy[] => [
  { x: c.x, y: c.y },
  { x: c.x + d * (1 - EPS), y: c.y },
  { x: c.x - d * (1 + EPS), y: c.y },
];

/** placedEnemies at `f` with `triggers`, `emitters` and `modules`: no crits, ignites or chains. */
function runAt(
  f: Factor,
  placed: readonly PlacedEnemy[],
  triggers: readonly TriggerSpec[] = [],
  emitters: readonly SourcedEmitter[] = [],
  modules: readonly TestModule[] = [],
): RunContext {
  const values = { critChance: 0, igniteChance: 0, chainCount: 0, ...f.values };
  return placedEnemies(placed, {
    stats: makeStats(values, [], { ...centerTriggers(triggers), emitters }),
    modules,
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies.find((e) => e.id === id) as Enemy;

/** The compiled effect of the run's one data trigger, of kind `kind`. */
function effectOf(ctx: RunContext, kind: CompiledEffectKind): CompiledEffect {
  const fx = ctx.build.effects[0] as CompiledEffect;
  expect(fx.kind).toBe(kind);
  return fx;
}

/** The run's one data trigger. */
const triggerOf = (ctx: RunContext): CompiledTrigger =>
  ctx.build.triggers[SHATTER_TRIGGER + 1] as CompiledTrigger;

/** Fires the run's one data trigger at C on no enemy, then the effect phase; its events. */
function fireAtC(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  fireOne(ctx, SHATTER_TRIGGER + 1, 0, -1, null, C.x, C.y, 0, ZERO, -1);
  runEffectQueue(ctx);
  return [...ctx.events];
}

/** Kills the victim once `hold` has given it its ailment, so its kill's transfers run. */
function killVictim(ctx: RunContext, hold: (victim: Enemy) => void): SimEvent[] {
  const victim = enemy(ctx, VICTIM);
  hold(victim);
  ctx.events.length = 0;
  killEnemy(ctx, victim, -1, 0);
  return [...ctx.events];
}

/** The ids `type` events of `events` name, without repeats, in order. */
function targetsOf(events: readonly SimEvent[], type: 'ignite' | 'ailmentApplied' | 'hit') {
  const ids = events.flatMap((e) => (e.type === type ? [e.targetId] : []));
  return [...new Set(ids)];
}

/** Expects the enemy just inside to be reached and the one just outside not. */
const reachedInside = (reached: readonly number[], inside = INSIDE, outside = OUTSIDE): void => {
  expect(reached).toContain(inside);
  expect(reached).not.toContain(outside);
};

/**
 * A rule module's own spread distance, as 燎原 (gd:379) reads it: every tick it is asked, shock
 * on each enemy within spreadOf(r) of C, read at use (in a hook, once the factor is set).
 */
function reachModule(r: number, seen: { reach: number }): TestModule {
  return (b) => {
    const fx = b.addEffect('center', { kind: 'applyAilment', ailment: 'shock', stacks: 1 });
    const owner = b.instanceTrigger();
    const out: Enemy[] = [];
    b.hook('tick', (ctx) => {
      const reach = spreadOf(ctx.build, r);
      seen.reach = reach;
      const n = ctx.grid.within(C.x, C.y, reach * reach, out);
      for (let i = 0; i < n; i++) {
        const target = out[i] as Enemy;
        const ev = { depth: 0, origin: -1, target, x: target.x, y: target.y, flags: 0 };
        enqueueModuleEffect(ctx, owner, fx, ev);
      }
    });
  };
}

/** A strike of no area on the farthest enemy from the player within `target`'s range. */
const strikeOf = (target: TargetSelector): SourcedEmitter => ({
  source: 'outer.lightning',
  grant: { kind: 'strike', name: 'bolt', periodSec: 1, target, damagePct: 1 },
});

/** Strikes once at `f` with the farthest pick `target`, enemies straddling `d` from the player. */
function strikeAt(f: Factor, target: TargetSelector, d: number): number[] {
  const placed = [
    { x: P.x + d * (1 - EPS), y: P.y },
    { x: P.x - d * (1 + EPS), y: P.y },
  ];
  const ctx = runAt(f, placed, [], [strikeOf(target)]);
  const em = ctx.emitters[1] as EmitterRuntime;
  em.timer = em.interval - 1;
  ctx.events.length = 0;
  runStrike(ctx, em);
  reachedInside(targetsOf(ctx.events, 'hit'), 1, 2);
  return [Math.sqrt((em.selector as NonNullable<EmitterRuntime['selector']>).rangeSq)];
}

/** What a site's radius takes: both factors, one product; the area or spread factor; neither. */
type Takes = 'area × spread' | 'area' | 'spread' | 'neither';

interface Site {
  readonly name: string;
  /** The radius or range as written. */
  readonly r: number;
  readonly takes: Takes;
  /**
   * The radii the run reads at the site at factor `f`, once it has checked that the enemy just
   * inside `expected` is reached and the one just outside it is not.
   */
  readonly read: (f: Factor, expected: number) => readonly number[];
}

const BURN_SPREAD: TriggerSpec = {
  on: 'kill',
  do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 45, effect: 0.4 }],
};
const POISON_SPREAD: TriggerSpec = {
  on: 'kill',
  do: [{ kind: 'spreadAilment', ailment: 'poison', radius: 55 }],
};
/** 火星's form (gd:376), its cap left out so that every enemy within the radius shows. */
const MARKED_IGNITE: TriggerSpec = {
  on: 'kill',
  do: [{ kind: 'applyAilment', ailment: 'burn', radius: 30, spread: true }],
};
const IGNITE: TriggerSpec = {
  on: 'kill',
  do: [{ kind: 'applyAilment', ailment: 'burn', radius: 30 }],
};
const SHOCK = { kind: 'applyAilment', ailment: 'shock' } as const;
const MARKED_PICK: TriggerSpec = {
  on: 'kill',
  target: { pick: 'farthest', range: 70, spread: true },
  do: [SHOCK],
};
const PICK: TriggerSpec = { on: 'kill', target: { pick: 'farthest', range: 70 }, do: [SHOCK] };
const EXPLODE: TriggerSpec = {
  on: 'kill',
  do: [{ kind: 'explode', radius: 50, damagePct: 0.1 }],
};
/** 焦痕's 火地 (gd:376): an area, which areaSize sizes and spreadRadius leaves. */
const ZONE: TriggerSpec = {
  on: 'kill',
  do: [{ kind: 'groundZone', radius: 40, durationSec: 1, damagePctPerSec: 0.2 }],
};

const SITES: readonly Site[] = [
  {
    name: "a burn spreadAilment (瘟疫's form)",
    r: 45,
    takes: 'area × spread',
    read: (f, expected) => {
      const ctx = runAt(f, around(C, expected), [BURN_SPREAD]);
      const events = killVictim(ctx, (v) => addBurn(ctx, v, num(10), ctx.now + 120, 0, CENTER));
      const reached = [INSIDE, OUTSIDE].filter((id) => holdsBurn(enemy(ctx, id), ctx.now));
      reachedInside(reached);
      const [spread] = eventsOf([events], 'burnSpread');
      expect(spread?.targets).toBe(1);
      const fx = effectOf(ctx, 'spreadAilment');
      const s = fx.spread as NonNullable<CompiledEffect['spread']>;
      return [Math.sqrt(fx.radiusSq), s.radius, Math.sqrt(s.radiusSq), spread?.radius ?? NaN];
    },
  },
  {
    name: 'a poison spreadAilment',
    r: 55,
    takes: 'area × spread',
    read: (f, expected) => {
      const ctx = runAt(f, around(C, expected), [POISON_SPREAD]);
      const events = killVictim(ctx, (v) =>
        applyPoison(ctx, v, num(4), ctx.now + 240, 0, CENTER, 2),
      );
      const reached = [INSIDE, OUTSIDE].filter((id) => holdsPoison(enemy(ctx, id), ctx.now));
      reachedInside(reached);
      const [spread] = eventsOf([events], 'ailmentSpread');
      expect(spread?.targets).toBe(1);
      const fx = effectOf(ctx, 'spreadAilment');
      const s = fx.spread as NonNullable<CompiledEffect['spread']>;
      return [Math.sqrt(fx.radiusSq), s.radius, Math.sqrt(s.radiusSq), spread?.radius ?? NaN];
    },
  },
  {
    name: "a marked applyAilment (火星's form)",
    r: 30,
    takes: 'area × spread',
    read: (f, expected) => {
      const ctx = runAt(f, around(C, expected), [MARKED_IGNITE]);
      reachedInside(targetsOf(fireAtC(ctx), 'ignite'));
      return [Math.sqrt(effectOf(ctx, 'applyAilment').radiusSq)];
    },
  },
  {
    name: 'an unmarked applyAilment, an area alone',
    r: 30,
    takes: 'area',
    read: (f, expected) => {
      const ctx = runAt(f, around(C, expected), [IGNITE]);
      reachedInside(targetsOf(fireAtC(ctx), 'ignite'));
      return [Math.sqrt(effectOf(ctx, 'applyAilment').radiusSq)];
    },
  },
  {
    name: "a marked selector's range, a reach",
    r: 70,
    takes: 'spread',
    read: (f, expected) => {
      const ctx = runAt(f, around(C, expected), [MARKED_PICK]);
      expect(targetsOf(fireAtC(ctx), 'ailmentApplied')).toEqual([INSIDE]);
      return [Math.sqrt((triggerOf(ctx).selector as { rangeSq: number }).rangeSq)];
    },
  },
  {
    name: "an unmarked selector's range",
    r: 70,
    takes: 'neither',
    read: (f, expected) => {
      const ctx = runAt(f, around(C, expected), [PICK]);
      expect(targetsOf(fireAtC(ctx), 'ailmentApplied')).toEqual([INSIDE]);
      return [Math.sqrt((triggerOf(ctx).selector as { rangeSq: number }).rangeSq)];
    },
  },
  {
    name: 'explode (its radiusSq, its burst and its hits), an area alone',
    r: 50,
    takes: 'area',
    read: (f, expected) => {
      const ctx = runAt(f, around(C, expected), [EXPLODE]);
      const events = fireAtC(ctx);
      reachedInside(targetsOf(events, 'hit'));
      const [burst] = eventsOf([events], 'burst');
      return [Math.sqrt(effectOf(ctx, 'explode').radiusSq), burst?.radius ?? NaN];
    },
  },
  {
    name: "groundZone (焦痕's 火地: its zone and a pulse's hits), an area alone",
    r: 40,
    takes: 'area',
    read: (f, expected) => {
      const ctx = runAt(f, around(C, expected), [ZONE]);
      const [zone] = eventsOf([fireAtC(ctx)], 'zone');
      const start = ctx.now;
      for (let t = 1; t <= PULSE_TICKS; t++) {
        ctx.now = ctx.state.tick = start + t;
        stepZones(ctx);
      }
      const hurt = [INSIDE, OUTSIDE].filter((id) => toNumber(enemy(ctx, id).hp) < 1e12);
      reachedInside(hurt);
      return [zone?.radius ?? NaN];
    },
  },
  {
    name: "a rule module's own spread distance (spreadOf), a reach",
    r: 60,
    takes: 'spread',
    read: (f, expected) => {
      const seen = { reach: NaN };
      const ctx = runAt(f, around(C, expected), [], [], [reachModule(60, seen)]);
      ctx.events.length = 0;
      runTickHooks(ctx);
      runEffectQueue(ctx);
      expect(targetsOf(ctx.events, 'ailmentApplied').sort((a, b) => a - b)).toEqual([
        VICTIM,
        INSIDE,
      ]);
      return [seen.reach, spreadOf(ctx.build, 60)];
    },
  },
  {
    name: "a strike's marked target range, a reach",
    r: 200,
    takes: 'spread',
    read: (f, expected) => strikeAt(f, { pick: 'farthest', range: 200, spread: true }, expected),
  },
  {
    name: "a strike's unmarked target range",
    r: 200,
    takes: 'neither',
    read: (f, expected) => strikeAt(f, { pick: 'farthest', range: 200 }, expected),
  },
];

/**
 * A site's radius at `f` as the rulings write it: what spreads r × (areaSize × spreadRadius),
 * the product compileBuild's pass forms once (sizedEffect); a reach r × spreadRadius; an area
 * r × areaSize (sizeOf); and r as written.
 */
function expectedAt(site: Site, f: Factor): number {
  switch (site.takes) {
    case 'area × spread':
      return site.r * (f.area * f.spread);
    case 'area':
      return site.r * f.area;
    case 'spread':
      return site.r * f.spread;
    case 'neither':
      return site.r;
  }
}

describe('spreadRadius and BuildFlags.spreadFactor (E3, lead ruling S1)', () => {
  it('reads spreadRadius once, at compile, after the modules, into spreadFactor and never into areaFactor', () => {
    const at = (values: Partial<Record<StatId, number>>, modules: readonly TestModule[] = []) =>
      compileBuild(makeStats(values), [], undefined, modules);
    expect(at({}).flags.spreadFactor).toBe(1);
    expect(at({ spreadRadius: 1.5 }).flags.spreadFactor).toBe(1.5);
    expect(at({ spreadRadius: 1.5 }).flags.areaFactor).toBe(1);
    expect(at({ areaSize: 1.2 }).flags.spreadFactor).toBe(1);
    expect(at({ spreadRadius: 1.5, areaSize: 1.2 }).flags).toMatchObject({
      areaFactor: 1.2,
      spreadFactor: 1.5,
    });
    // A module that scales the stat comes first, and what a module adds is sized as the data's.
    const doubling: TestModule = (b) => {
      b.scaleStat('spreadRadius', 2);
      b.addEffect('center', { kind: 'spreadAilment', ailment: 'burn', radius: 40 });
      b.addTrigger('center', { ...MARKED_PICK });
    };
    const build = at({ spreadRadius: 1.5 }, [doubling]);
    expect(build.flags.spreadFactor).toBe(3);
    expect((build.effects[0] as CompiledEffect).spread?.radius).toBe(120);
    const added = build.triggers.at(-1) as CompiledTrigger;
    expect(Math.sqrt((added.selector as { rangeSq: number }).rangeSq)).toBe(210);
  });

  it('reads the factor, not the stat, at use: a value changed later moves no spread, the flag does', () => {
    const build = compileBuild(makeStats({ spreadRadius: 1.5 }), []);
    (build.values as Record<StatId, number>).spreadRadius = 4;
    expect(spreadOf(build, 60)).toBe(90);
    (build.flags as BuildFlags).spreadFactor = 2;
    expect(spreadOf(build, 60)).toBe(120);
    expect(sizeOf(build, 60)).toBe(60);
  });

  it('takes a negative spreadRadius as no spread at all, never a negative radius whose square is positive', () => {
    const f: Factor = { name: '−0.5', values: { spreadRadius: -0.5 }, area: 1, spread: 0 };
    const near = (d: number): PlacedEnemy[] => [C, { x: C.x + d, y: C.y }];
    expect(compileBuild(makeStats(f.values), []).flags.spreadFactor).toBe(0);
    expect(spreadOf(compileBuild(makeStats(f.values), []), 60)).toBe(0);
    // The burn spread reaches no one 10 away, nor 0.25 × 45: its radius is 0.
    for (const d of [10, 45 * 0.25]) {
      const ctx = runAt(f, near(d), [BURN_SPREAD]);
      killVictim(ctx, (v) => addBurn(ctx, v, num(10), ctx.now + 120, 0, CENTER));
      expect(holdsBurn(enemy(ctx, 2), ctx.now), `${d}`).toBe(false);
      expect(effectOf(ctx, 'spreadAilment').spread).toMatchObject({ radius: 0, radiusSq: 0 });
    }
    // The marked selector picks no one 10 from C either, and the marked applyAilment burns no one.
    const alone = [{ x: C.x + 10, y: C.y }];
    const picked = runAt(f, alone, [MARKED_PICK]);
    expect(targetsOf(fireAtC(picked), 'ailmentApplied')).toEqual([]);
    expect((triggerOf(picked).selector as { rangeSq: number }).rangeSq).toBe(0);
    const burnt = runAt(f, alone, [MARKED_IGNITE]);
    expect(targetsOf(fireAtC(burnt), 'ignite')).toEqual([]);
    expect(effectOf(burnt, 'applyAilment').radiusSq).toBe(0);
    // With areaSize too, and an unmarked radius is still the area's.
    const both = runAt({ ...f, values: { spreadRadius: -2, areaSize: 1.2 } }, [], [IGNITE]);
    expect(both.build.flags).toMatchObject({ areaFactor: 1.2, spreadFactor: 0 });
    expect(Math.sqrt(effectOf(both, 'applyAilment').radiusSq)).toBe(30 * 1.2);
  });

  it('rejects a run whose spreadRadius is not finite', () => {
    const config = makeConfig({ stats: makeStats({ spreadRadius: Number.NaN }) });
    expect(() => createSimulation(config, makeTestData())).toThrow(
      'Stat spreadRadius is not finite',
    );
  });
});

describe('every spread distance, once (E3, lead rulings S2 and S3)', () => {
  const cases = SITES.flatMap((site) =>
    FACTORS.map((f) => ({ id: `${site.name} at ${f.name}`, site, f })),
  );

  // One it() per case rather than it.each, whose titles cut an interpolated id at 40 characters.
  for (const { id, site, f } of cases) {
    it(id, () => {
      const expected = expectedAt(site, f);
      const radii = site.read(f, expected);
      expect(radii.length).toBeGreaterThan(0);
      for (const radius of radii) expect(radius).toBe(expected);
      // r exactly without a factor: r × 1 is r, bit for bit.
      if (f.area === 1 && f.spread === 1) for (const radius of radii) expect(radius).toBe(site.r);
    });
  }

  it('lists what spreads, what reaches and what is an area', () => {
    const by = (takes: Takes): string[] =>
      SITES.filter((site) => site.takes === takes).map((site) => site.name);
    expect(SITES).toHaveLength(11);
    expect(by('area × spread')).toEqual([
      "a burn spreadAilment (瘟疫's form)",
      'a poison spreadAilment',
      "a marked applyAilment (火星's form)",
    ]);
    expect(by('spread')).toEqual([
      "a marked selector's range, a reach",
      "a rule module's own spread distance (spreadOf), a reach",
      "a strike's marked target range, a reach",
    ]);
  });

  it('forms one product: a spread at spreadRadius 1.5 and areaSize 1.2 is r × 1.8, neither factor twice', () => {
    const f = FACTORS.at(-1) as Factor;
    const ctx = runAt(f, [], [BURN_SPREAD]);
    const radius = (effectOf(ctx, 'spreadAilment').spread as { radius: number }).radius;
    expect(radius).toBe(45 * (1.2 * 1.5));
    expect(radius).toBeCloseTo(81, 9);
    expect(Math.sqrt(effectOf(runAt(f, [], [MARKED_IGNITE]), 'applyAilment').radiusSq)).toBeCloseTo(
      54,
      9,
    );
  });

  it('takes 巨大化 as part of the area: a spread is r × 2 × 1.5 under it, a reach r × 1.5', () => {
    const at = (spec: TriggerSpec): ReturnType<typeof compileBuild> =>
      compileBuild(makeStats({ spreadRadius: 1.5 }, [], centerTriggers([spec])), [
        { id: 'gigantism', sizeMult: 2 },
      ]);
    const burn = at(BURN_SPREAD);
    expect(burn.flags).toMatchObject({ sizeFactor: 2, areaFactor: 2, spreadFactor: 1.5 });
    expect((burn.effects[0] as CompiledEffect).spread?.radius).toBe(45 * 3);
    expect(Math.sqrt((at(MARKED_IGNITE).effects[0] as CompiledEffect).radiusSq)).toBe(30 * 3);
    expect(Math.sqrt((at(IGNITE).effects[0] as CompiledEffect).radiusSq)).toBe(30 * 2);
    const picked = at(MARKED_PICK).triggers[SHATTER_TRIGGER + 1] as CompiledTrigger;
    expect(Math.sqrt((picked.selector as { rangeSq: number }).rangeSq)).toBe(70 * 1.5);
    expect(spreadOf(burn, 60)).toBe(60 * 1.5);
  });

  it('spreads whatever the source: an outer board’s, a fusion’s, the hub’s and a module’s other source as the center’s', () => {
    const f = FACTORS.at(-1) as Factor;
    const sources = ['outer.fire', 'fusion.fire.poison', 'hub'];
    const fromModule: TestModule = (b) => void b.addTrigger('outer.poison', { ...MARKED_PICK });
    const build = compileBuild(
      makeStats(f.values, [], {
        triggers: sources.flatMap((source) => [
          { source, spec: BURN_SPREAD },
          { source, spec: MARKED_PICK },
        ]),
        conversions: [],
        emitters: [],
      }),
      [],
      undefined,
      [fromModule],
    );
    const picks = build.triggers.filter((t) => t.selector !== null);
    expect(new Set(picks.map((t) => t.source)).size).toBe(4);
    expect(picks.some((t) => t.source === CENTER)).toBe(false);
    for (const t of picks) expect(Math.sqrt((t.selector as { rangeSq: number }).rangeSq)).toBe(105);
    const spreads = build.effects.filter((fx) => fx.kind === 'spreadAilment');
    expect(spreads).toHaveLength(3);
    for (const fx of spreads) expect(fx.spread?.radius).toBe(45 * (1.2 * 1.5));
  });

  it('spreads a marked selector whatever the event: C5.7’s droneExpire and E2’s targetIs trigger among them', () => {
    const f = FACTORS.at(-1) as Factor;
    const target = { pick: 'farthest', range: 70, spread: true } as const;
    const marked: readonly TriggerSpec[] = [
      { on: 'droneExpire', target, do: [SHOCK] },
      {
        on: 'hit',
        when: [{ targetIs: 'highestHp' }],
        target: { ...target, pick: 'nearest' },
        do: [SHOCK],
      },
      { on: 'crit', target: { ...target, pick: 'nearest' }, do: [SHOCK] },
      { on: 'nthAttack', every: 3, target, do: [SHOCK] },
      { on: 'periodic', every: 1, target, do: [SHOCK] },
      { on: 'heroHit', target, do: [SHOCK] },
      { on: 'contact', target, do: [SHOCK] },
      { on: 'diedWithAilment', when: [{ victimHas: 'burn' }], target, do: [SHOCK] },
      { on: 'shatter', target, do: [SHOCK] },
      { on: 'explode', target, do: [SHOCK] },
      { on: 'chainJump', target: { ...target, pick: 'nearest' }, do: [SHOCK] },
      { on: 'droneImpact', target: { ...target, pick: 'nearest' }, do: [SHOCK] },
      { on: 'freeze', target, do: [SHOCK] },
    ];
    const build = compileBuild(makeStats(f.values, [], centerTriggers(marked)), []);
    const picks = build.triggers.filter((t) => t.selector !== null);
    expect(picks.map((t) => TRIGGER_EVENTS[t.on])).toEqual(marked.map((t) => t.on));
    for (const t of picks) {
      const range = Math.sqrt((t.selector as { rangeSq: number }).rangeSq);
      expect(range, TRIGGER_EVENTS[t.on]).toBe(70 * 1.5);
    }
    // E2's condition stays on its trigger as the pass replaces the selector.
    expect(build.flags.highestHp).toBe(true);
  });

  it('takes `spread: false` as no mark: the radius an area, the range as written', () => {
    const f = FACTORS.at(-1) as Factor;
    const unmarkedIgnite: TriggerSpec = {
      on: 'kill',
      do: [{ kind: 'applyAilment', ailment: 'burn', radius: 30, spread: false }],
    };
    const unmarkedPick: TriggerSpec = {
      on: 'kill',
      target: { pick: 'farthest', range: 70, spread: false },
      do: [SHOCK],
    };
    expect(Math.sqrt(effectOf(runAt(f, [], [unmarkedIgnite]), 'applyAilment').radiusSq)).toBe(
      30 * 1.2,
    );
    expect((triggerOf(runAt(f, [], [unmarkedPick])).selector as { rangeSq: number }).rangeSq).toBe(
      70 ** 2,
    );
    const ctx = runAt(f, [], [], [strikeOf({ pick: 'farthest', range: 200, spread: false })]);
    expect((ctx.emitters[1] as EmitterRuntime).selector?.rangeSq).toBe(200 ** 2);
  });

  it('moves no other radius: at spreadRadius 1.5 every effect but a spread keeps its radius, and the shatter, the aura and the bomb theirs', () => {
    const f = FACTORS[1] as Factor;
    const others: readonly TriggerSpec[] = [
      { on: 'hit', do: [{ kind: 'explode', radius: 50, damagePct: 0.1 }] },
      { on: 'hit', do: [{ kind: 'nova', radius: 70, damagePct: 0.1, at: 'event' }] },
      { on: 'hit', do: [{ kind: 'push', distance: 10, radius: 80 }] },
      { on: 'hit', do: [{ kind: 'applyAilment', ailment: 'poison', radius: 30 }] },
      { on: 'hit', do: [{ kind: 'addFrost', amount: 0.1, radius: 35 }] },
      { on: 'hit', do: [{ kind: 'detonate', ailment: 'burn', radius: 25 }] },
      { on: 'hit', do: [{ kind: 'groundZone', radius: 65, durationSec: 1, damagePctPerSec: 0.1 }] },
      { on: 'kill', target: { pick: 'nearest', range: 90 }, do: [SHOCK] },
    ];
    const ctx = placedEnemies([], {
      stats: makeStats({ ...f.values, frostOnHit: 0.1, shatterRadius: 75 }, [], {
        ...centerTriggers(others),
        emitters: [{ source: 'outer.aura', grant: { kind: 'aura' } }],
      }),
    });
    const radii = ctx.build.effects.map((fx) => Math.sqrt(fx.radiusSq));
    expect(radii).toEqual([50, 70, 80, 30, 35, 25, 65, 0, 75]);
    const selector = (ctx.build.triggers[8] as CompiledTrigger).selector as { rangeSq: number };
    expect(selector.rangeSq).toBe(90 ** 2);
    expect([ctx.build.flags.areaFactor, ctx.shatterRadius, sizeOf(ctx.build, 160)]).toEqual([
      1, 75, 160,
    ]);
    const bomb = compileBuild(makeStats(f.values), [], { id: 'magmaBomb' });
    expect(lobRadius(bomb, 60, 1)).toBe(60);
  });
});
