/**
 * E16's thornsArea stat (荊棘範圍, gd:466; lead ruling 21 of B4): BuildFlags.thornsFactor, read
 * once a compile after the modules, and every radius and reach it sizes: the radius of an effect
 * whose tags hold thorns (◆尖刺新星's nova, the thorns fusion payload's, a module's) in the area
 * pass, and a thorns-tagged strike's selector range and area radius (刺蝟's). Nothing else.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ZERO } from '../../core/num';
import type { SourcedEmitter, StrikeGrant } from '../../data/emitters';
import { generate } from '../../data/fusion/generate';
import type { SourcedTrigger, StatId } from '../../data/stats';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { fixtureContent } from '../../data/web/testing';
import type { OuterDef, WebNode } from '../../data/web/types';
import { fireOne } from '../effects/dispatch';
import { runEffectQueue } from '../effects/execute';
import type { CompiledSelector } from '../effects/select';
import { SHATTER_TRIGGER } from '../effects/types';
import type { CompiledEffect } from '../effects/types';
import { runStrike } from '../emitters/strike';
import type { EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { RunContext } from '../systems/context';
import { eventsOf, makeConfig, makeStats, makeTestData, placedEnemies } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import { compileBuild } from './compile';
import type { CompiledBuild } from './compile';
import { sizeOf } from './size';

const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (dx: number, dy = 0): PlacedEnemy => ({ x: P.x + dx, y: P.y + dy });

/** ◆尖刺新星 (gd:467): a thorns nova of 150 around the player on contact, 1 s cooldown. */
const SPIKE_NOVA: TriggerSpec = {
  on: 'contact',
  when: [{ cooldownSec: 1 }],
  do: [{ kind: 'nova', at: 'player', radius: 150, damagePct: 3, tags: ['thorns'] }],
};
/** The same nova untagged. */
const PLAIN_NOVA: TriggerSpec = {
  on: 'contact',
  do: [{ kind: 'nova', at: 'player', radius: 150, damagePct: 3 }],
};

/** A 1 s strike at the nearest enemy within 200, untagged, with the given fields. */
const strikeOf = (fields: Partial<Omit<StrikeGrant, 'kind'>> = {}): StrikeGrant => ({
  kind: 'strike',
  name: 'plain',
  periodSec: 1,
  target: { pick: 'nearest', range: 200 },
  damagePct: 0.75,
  ...fields,
});
/** 刺蝟's strike (gd:470): strikeOf tagged thorns. */
const hedgehog = (fields: Partial<Omit<StrikeGrant, 'kind'>> = {}): StrikeGrant =>
  strikeOf({ name: 'hedgehog', tags: ['thorns'], ...fields });
const on = (source: string, grant: SourcedEmitter['grant']): SourcedEmitter => ({ source, grant });
const center = (spec: TriggerSpec): SourcedTrigger => ({ source: 'center', spec });

interface Build {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  readonly emitters?: readonly SourcedEmitter[];
  readonly modules?: readonly TestModule[];
}

const statsOf = ({ values = {}, triggers = [], emitters = [] }: Build) =>
  makeStats({ damage: 10, critChance: 0, igniteChance: 0, ...values }, [], {
    triggers: triggers.map(center),
    conversions: [],
    emitters,
  });
const compiled = (build: Build): CompiledBuild =>
  compileBuild(statsOf(build), [], undefined, build.modules ?? []);
const contextOf = (placed: readonly PlacedEnemy[], build: Build): RunContext =>
  placedEnemies(placed, {
    stats: statsOf(build),
    ...(build.modules === undefined ? {} : { modules: build.modules }),
  });

/** The radius of each compiled effect of kind `kind`, from its radiusSq. */
const radii = (build: CompiledBuild, kind = 'nova'): number[] =>
  build.effects.filter((fx) => fx.kind === kind).map((fx) => Math.sqrt(fx.radiusSq));
/** The selector range of strike emitter `i` of a run context, from its rangeSq. */
const rangeSqOf = (ctx: RunContext, i = 1): number =>
  ((ctx.emitters[i] as EmitterRuntime).selector as CompiledSelector).rangeSq;

/** The ids a strike of emitter `i` hits on a tick it is due. */
function strikeIds(ctx: RunContext, i = 1): number[] {
  const em = ctx.emitters[i] as EmitterRuntime;
  em.timer = em.interval - 1;
  ctx.events.length = 0;
  runStrike(ctx, em);
  return eventsOf([ctx.events], 'hit').map((hit) => hit.targetId);
}

/** The ids the first data trigger's effects hit when it fires at the player. */
function fireIds(ctx: RunContext): number[] {
  fireOne(ctx, SHATTER_TRIGGER + 1, 0, -1, null, P.x, P.y, 0, ZERO, -1);
  ctx.events.length = 0;
  runEffectQueue(ctx);
  return eventsOf([ctx.events], 'hit').map((hit) => hit.targetId);
}

describe('thornsArea and BuildFlags.thornsFactor (E16, lead ruling 21)', () => {
  it('reads thornsArea once, at compile, after the modules, into thornsFactor and never into areaFactor or spreadFactor', () => {
    expect(compiled({}).flags.thornsFactor).toBe(1);
    expect(compiled({ values: { thornsArea: 1.3 } }).flags).toMatchObject({
      areaFactor: 1,
      spreadFactor: 1,
      thornsFactor: 1.3,
    });
    expect(compiled({ values: { areaSize: 1.2, spreadRadius: 1.5 } }).flags.thornsFactor).toBe(1);
    // A module that scales the stat comes first.
    const doubling: TestModule = (b) => {
      b.scaleStat('thornsArea', 2);
    };
    expect(compiled({ values: { thornsArea: 1.3 }, modules: [doubling] }).flags.thornsFactor).toBe(
      2.6,
    );
  });

  it.each([
    ['0', 0],
    ['−1', -1],
    ['NaN', Number.NaN],
  ])(
    'takes thornsArea %s as no thorns area: factor 0, the tagged nova’s radius 0, the strike’s range and radius 0',
    (_, thornsArea) => {
      const build: Build = {
        values: { thornsArea },
        triggers: [SPIKE_NOVA, PLAIN_NOVA],
        emitters: [on('outer.thorns', hedgehog({ radius: 40, targets: 2 }))],
      };
      const b = compiled(build);
      expect(b.flags.thornsFactor).toBe(0);
      expect(radii(b)).toEqual([0, 150]);
      // The strike reaches only an enemy on the player's point, and its area is none.
      const ctx = contextOf([at(0), at(1), at(0, 0.5)], build);
      expect(rangeSqOf(ctx)).toBe(0);
      expect(strikeIds(ctx)).toEqual([1]);
      // Nor does the nova reach one 0.5 away.
      expect(fireIds(contextOf([at(0.5)], build))).toEqual([]);
    },
  );

  it('rejects a run whose thornsArea is not finite, as every stat', () => {
    const config = makeConfig({ stats: makeStats({ thornsArea: Number.NaN }) });
    expect(() => createSimulation(config, makeTestData())).toThrow('Stat thornsArea is not finite');
  });
});

describe('thornsArea on the thorns-tagged effects (E16, lead ruling 21)', () => {
  it('sizes a thorns-tagged nova 150 to 195 at thornsArea 1.3, and to 150 × (1.2 × 1.3) with areaSize 1.2, and leaves an untagged nova at 150 (× 1.2 alone)', () => {
    const triggers = [SPIKE_NOVA, PLAIN_NOVA];
    expect(radii(compiled({ triggers }))).toEqual([150, 150]);
    expect(radii(compiled({ triggers, values: { thornsArea: 1.3 } }))).toEqual([195, 150]);
    const both = compiled({ triggers, values: { thornsArea: 1.3, areaSize: 1.2 } });
    // One product: areaFactor × thornsFactor, then the radius.
    expect(both.effects.map((fx) => fx.radiusSq).slice(0, 2)).toEqual([
      (150 * (1.2 * 1.3)) ** 2,
      (150 * 1.2) ** 2,
    ]);
    // The spec keeps its radius as written; the hits read the sized radiusSq.
    expect((both.effects[0] as CompiledEffect).spec).toEqual(SPIKE_NOVA.do[0]);
    const near = [at(194.9), at(195.1), at(-149.9, 0), at(0, -150.1)];
    expect(
      fireIds(contextOf(near, { triggers: [SPIKE_NOVA], values: { thornsArea: 1.3 } })),
    ).toEqual([1, 3, 4]);
    expect(
      fireIds(contextOf(near, { triggers: [PLAIN_NOVA], values: { thornsArea: 1.3 } })),
    ).toEqual([3]);
  });

  it('sizes a thorns radius in one product, r × (areaFactor × thornsFactor), never (r × areaFactor) × thornsFactor', () => {
    // At areaSize 1.1 and thornsArea 1.3 the two orders differ in the last place.
    expect(150 * (1.1 * 1.3)).not.toBe(150 * 1.1 * 1.3);
    const b = compiled({ triggers: [SPIKE_NOVA], values: { areaSize: 1.1, thornsArea: 1.3 } });
    expect(b.effects.find((fx) => fx.kind === 'nova')?.radiusSq).toBe((150 * (1.1 * 1.3)) ** 2);
  });

  it('sizes every thorns-tagged radius the pass sizes, an explode’s and a module’s addEffect’s among them, whatever other tags it holds', () => {
    const doubling: TestModule = (b) => {
      b.addEffect('center', { kind: 'nova', radius: 50, damagePct: 1, tags: ['thorns'] });
      b.addEffect('center', { kind: 'nova', radius: 50, damagePct: 1, tags: ['aura'] });
    };
    const triggers: TriggerSpec[] = [
      {
        on: 'kill',
        do: [
          { kind: 'explode', radius: 60, damagePct: 1, tags: ['area', 'thorns'] },
          { kind: 'explode', radius: 60, damagePct: 1, tags: ['area'] },
        ],
      },
    ];
    const b = compiled({ triggers, values: { thornsArea: 1.3 }, modules: [doubling] });
    expect(radii(b, 'explode')).toEqual([60 * 1.3, 60]);
    expect(radii(b, 'nova')).toEqual([65, 50]);
  });

  it('sizes the thorns fusion payload’s nova (gd:573, 90) to 117 at thornsArea 1.3: the template core keeps its thorns tag', () => {
    const content = fixtureContent();
    const def = generate(
      content.characters.lightning,
      content.outers.thorns as OuterDef,
      content.overrides['lightning.thorns'],
      1,
    );
    const core = def.board.nodes.find((node) => node.id.endsWith('.core')) as WebNode;
    const triggers = core.effects.triggers;
    expect(triggers.map((t) => t.do)).toEqual([
      [{ kind: 'nova', radius: 90, damagePct: 3, tags: ['thorns'], at: 'event' }],
    ]);
    const source = `fusion.${def.key}`;
    const stats = (thornsArea: number) =>
      makeStats({ thornsArea }, [], {
        triggers: triggers.map((spec) => ({ source, spec })),
        conversions: [],
        emitters: [],
      });
    expect(radii(compileBuild(stats(1), []))).toEqual([90]);
    expect(radii(compileBuild(stats(1.3), []))).toEqual([117]);
  });

  it('leaves alone a trigger’s selector range, the contact thorns, 拒馬’s dashRepel and 荊棘纏繞’s hold at thornsArea 1.3', () => {
    const picked: TriggerSpec = {
      on: 'hit',
      target: { pick: 'nearest', range: 200 },
      do: [{ kind: 'nova', at: 'event', radius: 40, damagePct: 1, tags: ['thorns'] }],
    };
    const build = (thornsArea: number): Build => ({
      triggers: [picked],
      emitters: [on('outer.thorns', { kind: 'thorns' })],
      values: { thornsArea, dashRepel: 80, bossHoldSec: 1 },
    });
    const base = compiled(build(1));
    const wide = compiled(build(1.3));
    expect(radii(wide)).toEqual([52]);
    expect(wide.triggers.map((t) => t.selector)).toEqual(base.triggers.map((t) => t.selector));
    expect((wide.triggers[SHATTER_TRIGGER + 1]?.selector as CompiledSelector).rangeSq).toBe(40000);
    expect(wide.emitters).toEqual(base.emitters);
    const ai = (thornsArea: number) => {
      const { dashRepel, holdTicks } = contextOf([], build(thornsArea)).sys.enemyAi;
      return { dashRepel, holdTicks };
    };
    expect(ai(1.3)).toEqual({ dashRepel: 80, holdTicks: 60 });
    expect(ai(1.3)).toEqual(ai(1));
  });

  it('sizes a thorns-tagged explode’s and nova’s burst event and groundZone’s zone as their hits, 150 to 195 at thornsArea 1.3, and an untagged one’s at 150', () => {
    const fired = (effect: EffectSpec): RunContext => {
      const ctx = contextOf([at(100)], {
        triggers: [{ on: 'contact', do: [effect] }],
        values: { thornsArea: 1.3 },
      });
      fireIds(ctx);
      return ctx;
    };
    const burst = (effect: EffectSpec): number[] =>
      eventsOf([fired(effect).events], 'burst').map((event) => event.radius);
    const thorns = ['thorns'] as const;
    expect(burst({ kind: 'nova', radius: 150, damagePct: 1, tags: thorns })).toEqual([195]);
    expect(burst({ kind: 'nova', radius: 150, damagePct: 1 })).toEqual([150]);
    expect(burst({ kind: 'explode', radius: 150, damagePct: 1, tags: thorns })).toEqual([195]);
    expect(burst({ kind: 'explode', radius: 150, damagePct: 1 })).toEqual([150]);
    const zone = (tags?: readonly ['thorns']): number => {
      const spec = { kind: 'groundZone', radius: 150, durationSec: 1, damagePctPerSec: 1 } as const;
      return fired(tags === undefined ? spec : { ...spec, tags }).sys.zones.radiusSq[0] as number;
    };
    expect(zone(thorns)).toBe(195 ** 2);
    expect(zone()).toBe(150 ** 2);
  });
});

describe('thornsArea on a thorns-tagged strike (E16, lead ruling 21)', () => {
  it('reaches a thorns strike’s range 200 to 260 (rangeSq 67600) at thornsArea 1.3, never × areaSize, and an untagged strike’s not at all', () => {
    const grants = [on('outer.thorns', hedgehog()), on('outer.thorns', strikeOf())];
    const sq = (values: Partial<Record<StatId, number>>): number[] => {
      const ctx = contextOf([], { emitters: grants, values });
      return [rangeSqOf(ctx, 1), rangeSqOf(ctx, 2)];
    };
    expect(sq({})).toEqual([40000, 40000]);
    expect(sq({ thornsArea: 1.3 })).toEqual([67600, 40000]);
    expect(sq({ thornsArea: 1.3, areaSize: 1.2 })).toEqual([67600, 40000]);
    expect(sq({ areaSize: 1.2 })).toEqual([40000, 40000]);
    // It strikes an enemy 259.9 out, not one 260.1 out.
    const reach = contextOf([at(259.9), at(-260.1)], {
      emitters: [on('outer.thorns', hedgehog({ targets: 6 }))],
      values: { thornsArea: 1.3 },
    });
    expect(strikeIds(reach)).toEqual([1]);
  });

  it('forms one product with a spread mark: range × spreadFactor × thornsFactor, from the range as written', () => {
    const marked = hedgehog({ target: { pick: 'nearest', range: 200, spread: true } });
    const sq = (values: Partial<Record<StatId, number>>): number =>
      rangeSqOf(contextOf([], { emitters: [on('outer.thorns', marked)], values }));
    expect(sq({ spreadRadius: 1.5 })).toBe(300 ** 2);
    expect(sq({ spreadRadius: 1.5, thornsArea: 1.3 })).toBe((200 * 1.5 * 1.3) ** 2);
    expect(sq({ thornsArea: 1.3 })).toBe((200 * 1 * 1.3) ** 2);
    // range × spreadFactor first, then × thornsFactor: at 1.1 and 1.3 the other order differs.
    expect(200 * 1.1 * 1.3).not.toBe(200 * 1.3 * 1.1);
    expect(sq({ spreadRadius: 1.1, thornsArea: 1.3 })).toBe((200 * 1.1 * 1.3) ** 2);
    // An untagged strike's marked range takes the spread factor alone.
    const plain = strikeOf({ target: { pick: 'nearest', range: 200, spread: true } });
    expect(
      rangeSqOf(
        contextOf([], {
          emitters: [on('outer.thorns', plain)],
          values: { spreadRadius: 1.5, thornsArea: 1.3 },
        }),
      ),
    ).toBe(300 ** 2);
    // Without a range it reaches every enemy, at any factor.
    const anywhere = hedgehog({ target: { pick: 'nearest' } });
    expect(
      rangeSqOf(
        contextOf([], { emitters: [on('outer.thorns', anywhere)], values: { thornsArea: 1.3 } }),
      ),
    ).toBe(Infinity);
    // At thornsArea 0 too: Infinity × 0 would be NaN, which reaches no enemy.
    const far = contextOf([at(900)], {
      emitters: [on('outer.thorns', hedgehog({ target: { pick: 'nearest' }, targets: 2 }))],
      values: { thornsArea: 0 },
    });
    expect(rangeSqOf(far)).toBe(Infinity);
    expect(strikeIds(far)).toEqual([1]);
  });

  it.each([
    ['one target', 1],
    ['two targets', 2],
  ])(
    'sizes a thorns strike’s radius sizeOf(r) × thornsFactor with %s, and an untagged strike’s sizeOf(r) alone',
    (_, targets) => {
      const values = { thornsArea: 1.3, areaSize: 1.2 };
      // The target 1, 100 out, and 5 alone on the other side; around 1, 40 × 1.2 × 1.3 = 62.4
      // reaches 2 (62.3) and not 3 (62.5), 40 × 1.2 = 48 reaches 4 (47.9) alone.
      const placed = [at(100), at(100, 62.3), at(100, -62.5), at(100, 47.9), at(-105)];
      const thorny = contextOf(placed, {
        emitters: [on('outer.thorns', hedgehog({ radius: 40, targets }))],
        values,
      });
      expect(sizeOf(thorny.build, 40) * thorny.build.flags.thornsFactor).toBe(40 * 1.2 * 1.3);
      expect(strikeIds(thorny)).toEqual(targets === 1 ? [1, 2, 4] : [1, 2, 4, 5]);
      const untagged = strikeOf({ radius: 40, targets });
      const plain = contextOf(placed, { emitters: [on('outer.thorns', untagged)], values });
      expect(strikeIds(plain)).toEqual(targets === 1 ? [1, 4] : [1, 4, 5]);
    },
  );
});

describe('thornsArea 1 compiles as the base (E16, lead ruling 21)', () => {
  /**
   * Every thorns-tagged effect kind with a radius, an untagged nova, a spread and a marked
   * selector, the contact thorns and two untagged strikes (one with a spread-marked range): the
   * build S/b4/e16-bench/scripts/baseCompile.mts compiles with d45dd0b's own code.
   */
  const TRIGGERS: readonly TriggerSpec[] = [
    SPIKE_NOVA,
    { on: 'hit', do: [{ kind: 'nova', at: 'event', radius: 150, damagePct: 1 }] },
    {
      on: 'kill',
      target: { pick: 'nearest', range: 200 },
      do: [
        { kind: 'explode', radius: 60, damagePct: 1, tags: ['thorns', 'area'] },
        { kind: 'groundZone', radius: 80, durationSec: 2, damagePctPerSec: 1, tags: ['thorns'] },
      ],
    },
    { on: 'kill', do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 40 }] },
    {
      on: 'hit',
      target: { pick: 'nearest', range: 140, spread: true },
      do: [{ kind: 'applyAilment', ailment: 'burn', damagePct: 1 }],
    },
  ];
  const EMITTERS: readonly SourcedEmitter[] = [
    on('outer.thorns', { kind: 'thorns' }),
    on('outer.thorns', {
      kind: 'strike',
      name: 'plain',
      periodSec: 1,
      target: { pick: 'nearest', range: 200 },
      damagePct: 0.75,
      radius: 40,
      chainJumps: 2,
    }),
    on('outer.lightning', {
      kind: 'strike',
      name: 'marked',
      periodSec: 0.5,
      target: { pick: 'farthest', range: 300, spread: true },
      damagePct: 1,
      element: 'lightning',
      shockStacks: 1,
    }),
  ];
  /**
   * sha256 of JSON.stringify (Infinity as "Infinity") of the compile's effects, triggers,
   * emitters, flags and the strikes' run selectors, by d45dd0b at each value set, recorded with
   * that script (S/b4/e16-bench/base-compile-hash.json); this tree's with its new fields
   * (BuildFlags.thornsFactor and E17's interestHeld, a strike spec's targets) left out.
   */
  const BASE: readonly [Partial<Record<StatId, number>>, string][] = [
    [{}, 'dced280e1f6d67166696f087c0e62c7bf654fe126ede45b7c64a4c95b61e2485'],
    [{ areaSize: 1.2 }, '37724c6e34c4c5f8274a2530484b817072153a1c19a5bc1ecb9a50267a660a34'],
    [{ spreadRadius: 1.5 }, '2f5c3ef2fec51d0360e951a73c0a379b9fd0fed0d8731117abda0d270ac2020a'],
    [
      { areaSize: 1.2, spreadRadius: 1.5 },
      '750ff1f8ef123e7b026c077644361b25fb0c3b82573d12e68c2e1422b1e474cd',
    ],
  ];
  const replacer = (_: string, v: unknown): unknown =>
    v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : v;
  const hashOf = (values: Partial<Record<StatId, number>>): string => {
    const stats = makeStats(values, [], {
      triggers: TRIGGERS.map(center),
      conversions: [],
      emitters: EMITTERS,
    });
    const build = compileBuild(stats, []);
    const ctx = placedEnemies([], { stats });
    const { thornsFactor, interestHeld, ...flags } = build.flags;
    expect(thornsFactor).toBe(1);
    expect(interestHeld).toBe(false);
    const view = {
      effects: build.effects,
      triggers: build.triggers,
      emitters: build.emitters.map((em) => {
        if (em.kind !== 'strike') return em;
        const { targets, ...rest } = em;
        expect(targets).toBe(1);
        return rest;
      }),
      flags,
      selectors: ctx.emitters.map((em) => em.selector),
    };
    return createHash('sha256').update(JSON.stringify(view, replacer)).digest('hex');
  };

  it.each(BASE)(
    'compiles the build at %o exactly as d45dd0b did: effects, triggers, emitters, flags and strike selectors',
    (values, hash) => {
      expect(hashOf(values)).toBe(hash);
      // thornsArea written 1 is the base itself.
      expect(hashOf({ ...values, thornsArea: 1 })).toBe(hash);
    },
  );

  it('sizes those radii as d45dd0b did, and its strike selectors', () => {
    const view = (values: Partial<Record<StatId, number>>) => {
      const stats = makeStats(values, [], {
        triggers: TRIGGERS.map(center),
        conversions: [],
        emitters: EMITTERS,
      });
      const build = compileBuild(stats, []);
      return {
        radiusSq: build.effects.map((fx) => fx.radiusSq),
        spread: build.effects.flatMap((fx) => (fx.spread === null ? [] : [fx.spread.radius])),
        selectors: placedEnemies([], { stats }).emitters.map((em) => em.selector?.rangeSq ?? null),
      };
    };
    expect(view({})).toEqual({
      radiusSq: [22500, 22500, 3600, 6400, 1600, 0],
      spread: [40],
      selectors: [null, null, 40000, 90000],
    });
    expect(view({ areaSize: 1.2, spreadRadius: 1.5 })).toEqual({
      radiusSq: [32400, 32400, 5184, 9216, 5184, 0],
      spread: [72],
      selectors: [null, null, 40000, 202500],
    });
  });
});
