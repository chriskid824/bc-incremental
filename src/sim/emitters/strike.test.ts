import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import type { SourcedEmitter, StrikeGrant } from '../../data/emitters';
import type { Modifier, StatId } from '../../data/stats';
import { jumpMask, TAG } from '../../data/tags';
import type { TargetSelector } from '../../data/triggers';
import { liveBurnStacks } from '../ailments/records';
import { activeShockStacks, addShock } from '../ailments/shock';
import { CHAIN_HIT_CAP } from '../caps';
import { beginAttack } from '../combat/chain';
import { compileSelector } from '../effects/select';
import { CHAIN_JUMP, PRIMARY, REPEAT, SIGNATURE } from '../effects/flags';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { removeEnemy } from '../systems/death';
import { EMITTER_STEPS, runEmitters } from '../systems/emitters';
import { rebuildGrid } from '../systems/grid';
import {
  eventsOf,
  makeConfig,
  makeStats,
  placedEnemies,
  rngPositions,
  stationarySquares,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import { runStrike } from './strike';
import { grantEmitter, periodTicks } from './types';
import type { EmitterRuntime } from './types';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y + dy,
  ...more,
});

/** `count` immortal squares on one line, 20 apart from 100 right of the player. */
const line = (count: number): PlacedEnemy[] =>
  Array.from({ length: count }, (_, i) => at(100 + 20 * i, 0));

/** The tags of a strike's hits without an element, and of its chain's jumps. */
const STRIKE_TAGS = TAG.hit | TAG.strike | TAG.area;
const JUMP_TAGS = jumpMask(STRIKE_TAGS | TAG.lightning);

/** A 1 s strike at the enemy nearest the player, 100% of the damage stat, lightning. */
const strike = (fields: Partial<Omit<StrikeGrant, 'kind'>> = {}): StrikeGrant => ({
  kind: 'strike',
  name: 'bolt',
  periodSec: 1,
  target: { pick: 'nearest' },
  damagePct: 1,
  element: 'lightning',
  ...fields,
});
const on = (source: string, grant: SourcedEmitter['grant']): SourcedEmitter => ({ source, grant });

/** Damage 10 and no crits or ignites unless `values` say so. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly mods?: readonly Modifier[];
  readonly grants?: readonly SourcedEmitter[];
  readonly modules?: readonly TestModule[];
}

/** placedEnemies with these grants (one strike on outer.lightning by default) over NO_ROLLS. */
function fixture(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, options.mods ?? [], {
      triggers: [],
      conversions: [],
      emitters: options.grants ?? [on('outer.lightning', strike())],
    }),
    ...(options.modules === undefined ? {} : { modules: options.modules }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const emitter = (ctx: RunContext, i = 1): EmitterRuntime => ctx.emitters[i] as EmitterRuntime;

/** Runs strike emitter `i` on a tick it is due, its events alone in ctx.events. */
function strikeNow(ctx: RunContext, i = 1): void {
  const em = emitter(ctx, i);
  em.timer = em.interval - 1;
  ctx.events.length = 0;
  runStrike(ctx, em);
}

const hits = (ctx: RunContext): HitEvent[] => eventsOf([ctx.events], 'hit');
const hitIds = (ctx: RunContext): number[] => hits(ctx).map((hit) => hit.targetId);
const shocks = (ctx: RunContext): number[] => ctx.enemies.map((e) => activeShockStacks(e, ctx.now));

/** A module that records [target id, chain index, tags, flags, depth, origin] of each hit. */
function recorder(): { seen: number[][]; module: TestModule } {
  const seen: number[][] = [];
  const module: TestModule = (b) =>
    b.hook('onHit', (_ctx, hit) => {
      seen.push([hit.target.id, hit.chainIndex, hit.mask, hit.flags, hit.depth, hit.origin]);
    });
  return { seen, module };
}

describe('strike: its emitter', () => {
  it('is granted with its defaults: tags hit, strike and area plus its element, crits and ailments', () => {
    const bare: StrikeGrant = {
      kind: 'strike',
      name: 'bolt',
      periodSec: 2,
      target: { pick: 'farthest' },
      damagePct: 3,
    };
    expect(grantEmitter('outer.lightning', bare)).toEqual({
      kind: 'strike',
      signature: false,
      source: 'outer.lightning',
      damagePct: 3,
      tags: STRIKE_TAGS,
      chains: false,
      rollsAilments: true,
      canCrit: true,
      name: 'bolt',
      periodSec: 2,
      target: { pick: 'farthest' },
      radius: 0,
      chainJumps: 0,
      shockStacks: 0,
    });
    const full = { ...bare, radius: 60, chainJumps: 3, shockStacks: 2 };
    for (const element of ['cold', 'lightning'] as const) {
      expect(grantEmitter('center', { ...full, element })).toMatchObject({
        source: 'center',
        tags: STRIKE_TAGS | TAG[element],
        radius: 60,
        chainJumps: 3,
        shockStacks: 2,
      });
    }
  });

  it('takes its period as interval, a timer from 0, its selector from the player and its own area buffer', () => {
    const target: TargetSelector = { pick: 'highestHp', range: 300, excludeBoss: true };
    const ctx = fixture([], {
      grants: [
        on('outer.thorns', { kind: 'thorns' }),
        on('outer.lightning', strike({ periodSec: 0.7, target, shockStacks: 2, chainJumps: 3 })),
        on('outer.lightning', { kind: 'segment', endpoints: 'shocked' }),
        on('outer.lightning', strike({ name: 'clap', periodSec: 2 })),
      ],
    });
    const [volley, thorns, bolt, web, clap] = ctx.emitters as EmitterRuntime[];
    expect(ctx.emitters.map((em) => em.spec.kind)).toEqual([
      'volley',
      'thorns',
      'strike',
      'segment',
      'strike',
    ]);
    for (const em of [bolt, clap] as EmitterRuntime[]) {
      expect(em.timer).toBe(0);
      expect(em.targets).toEqual([]);
      expect(em.payload.rng).toBe(ctx.combatRng);
      expect(em.payload.flags).toBe(0);
      expect(em.payload.policy).toBeNull();
    }
    expect([bolt?.interval, clap?.interval]).toEqual([42, 120]);
    expect(bolt?.targets).not.toBe(clap?.targets);
    // Compiled as a periodic trigger's: from the player, whatever its `from`.
    expect(bolt?.selector).toEqual(compileSelector(target, 'periodic'));
    expect(bolt?.selector?.fromPlayer).toBe(true);
    expect(clap?.selector).toEqual(compileSelector({ pick: 'nearest' }, 'periodic'));
    // Its chain payload: its payload's, rows shared, whose jumps shock; no policy.
    const p = bolt?.payload;
    const q = bolt?.chainPayload;
    expect(q).not.toBe(p);
    expect(q?.rows).toBe(p?.rows);
    expect([q?.baseDamage, q?.tags, q?.source, q?.jumpSource, q?.flags, q?.rng]).toEqual([
      p?.baseDamage,
      p?.tags,
      p?.source,
      p?.jumpSource,
      p?.flags,
      p?.rng,
    ]);
    expect([q?.shockOnHit, q?.policy, q?.general, q?.rollsAilments, q?.canCrit]).toEqual([
      2,
      null,
      true,
      true,
      true,
    ]);
    expect([clap?.chainPayload?.shockOnHit, clap?.chainPayload?.general]).toEqual([0, false]);
    // The other kinds have none of the three.
    for (const em of [volley, thorns, web] as EmitterRuntime[]) {
      expect([em.chainPayload, em.selector, em.targets]).toEqual([null, null, null]);
    }
    // One shape for every kind.
    const keys = Object.keys(volley as EmitterRuntime);
    for (const em of ctx.emitters) expect(Object.keys(em)).toEqual(keys);
  });
});

describe('strike: its period', () => {
  it('strikes every periodSec × 60 ticks from its first tick, whatever the attack speed', () => {
    for (const periodSec of [1, 0.25, 0.7, 1 / 60]) {
      for (const attackSpeed of [0.5, 4, 40]) {
        const ctx = fixture(line(2), {
          values: { attackSpeed },
          grants: [on('outer.lightning', strike({ periodSec }))],
        });
        const em = emitter(ctx);
        expect(em.interval).toBe(periodTicks(1 / periodSec));
        const struck: number[] = [];
        for (let tick = 1; tick <= 240; tick++) {
          ctx.now = tick;
          ctx.events.length = 0;
          runStrike(ctx, em);
          if (hits(ctx).length > 0) struck.push(tick);
        }
        const every = Math.round(TICK_RATE * periodSec);
        const expected = Array.from({ length: 240 / every }, (_, i) => every * (i + 1));
        expect(struck, `${periodSec} s at attackSpeed ${attackSpeed}`).toEqual(expected);
      }
    }
  });

  it('carries the part of a tick its period leaves over: 0.71 s strikes 14 times in 600 ticks', () => {
    // periodTicks(1 / 0.71) is 42.6 ticks: the timer keeps what is left after each strike, so
    // the strikes come 43 or 42 ticks apart, n × 42.6 rounded up, not every 43 ticks.
    const ctx = fixture(line(2), { grants: [on('outer.lightning', strike({ periodSec: 0.71 }))] });
    const em = emitter(ctx);
    expect(em.interval).toBe(periodTicks(1 / 0.71));
    expect(em.interval).toBeCloseTo(42.6, 9);
    const struck: number[] = [];
    for (let tick = 1; tick <= 600; tick++) {
      ctx.now = tick;
      ctx.events.length = 0;
      runStrike(ctx, em);
      if (hits(ctx).length > 0) struck.push(tick);
    }
    expect(struck).toEqual([43, 86, 128, 171, 213, 256, 299, 341, 384, 426, 469, 512, 554, 597]);
  });

  it('strikes on the same ticks in a run at any attack speed, from the emitter stage', () => {
    const struckAt = (attackSpeed: number): number[] => {
      const stats = makeStats({ ...NO_ROLLS, attackSpeed }, [], {
        triggers: [],
        conversions: [],
        emitters: [on('outer.lightning', strike({ periodSec: 0.5 }))],
      });
      const sim = createSimulation(makeConfig({ stats, maxTicks: 200 }), stationarySquares(3));
      const lightning = sim.state.sources.indexOf('outer.lightning');
      const ticks: number[] = [];
      while (!sim.state.finished) {
        const events = sim.step(NO_INPUT);
        for (const event of events) {
          if (event.type === 'hit' && event.source === lightning) ticks.push(sim.state.tick);
        }
      }
      return ticks;
    };
    expect(struckAt(1)).toEqual([30, 60, 90, 120, 150, 180]);
    expect(struckAt(20)).toEqual([30, 60, 90, 120, 150, 180]);
  });

  it('loses a strike with nothing to pick: nothing is drawn, no attack begins, nothing is banked', () => {
    const ctx = fixture([at(300, 0)], {
      values: { critChance: 0.5 },
      grants: [on('outer.lightning', strike({ target: { pick: 'nearest', range: 200 } }))],
    });
    const em = emitter(ctx);
    const serial = ctx.attackSerial;
    const before = rngPositions(ctx);
    for (let tick = 1; tick <= 60; tick++) {
      ctx.now = tick;
      runStrike(ctx, em);
    }
    expect(em.timer).toBe(0);
    expect(hits(ctx)).toEqual([]);
    expect([ctx.attackSerial, ctx.counters.chainHitsPeak]).toEqual([serial, 0]);
    expect(rngPositions(ctx)).toEqual(before);
    // In range from tick 61: the next strike comes a whole period after the lost one.
    enemy(ctx, 1).x = PLAYER.x + 150;
    rebuildGrid(ctx);
    const struck: number[] = [];
    for (let tick = 61; tick <= 180; tick++) {
      ctx.now = tick;
      ctx.events.length = 0;
      runStrike(ctx, em);
      if (hits(ctx).length > 0) struck.push(tick);
    }
    expect(struck).toEqual([120, 180]);
  });
});

describe('strike: its target and area', () => {
  it('hits the enemy its selector picks from the player, first, tagged hit, strike and area plus its element', () => {
    const placed = [at(100, 0), at(-300, 0), at(0, 200, { hp: 1e15 }), at(0, -150)];
    const picked = (target: TargetSelector): number => {
      const ctx = fixture(placed, { grants: [on('outer.lightning', strike({ target }))] });
      strikeNow(ctx);
      return hitIds(ctx)[0] as number;
    };
    expect(picked({ pick: 'nearest' })).toBe(1);
    expect(picked({ pick: 'farthest' })).toBe(2);
    expect(picked({ pick: 'highestHp' })).toBe(3);
    expect(picked({ pick: 'farthest', range: 250 })).toBe(3);
    expect(picked({ pick: 'nearest', range: 99 })).toBeUndefined();

    const { seen, module } = recorder();
    const ctx = fixture(placed, { modules: [module] });
    const lightning = ctx.sources.index('outer.lightning');
    strikeNow(ctx);
    expect(
      hits(ctx).map((hit) => [
        hit.targetId,
        hit.chainIndex,
        hit.tags,
        hit.source,
        toNumber(hit.amount),
      ]),
    ).toEqual([[1, 0, STRIKE_TAGS | TAG.lightning, lightning, 10]]);
    // Not the signature attack: no SIGNATURE, PRIMARY or REPEAT on its hit.
    const bits = SIGNATURE | PRIMARY | REPEAT | CHAIN_JUMP;
    expect(seen.map(([id, k, mask, flags]) => [id, k, mask, (flags as number) & bits])).toEqual([
      [1, 0, STRIKE_TAGS | TAG.lightning, 0],
    ]);
  });

  it('gives its target shockStacks after its hit (K12): the hit is not amplified by them', () => {
    const { module } = recorder();
    const before: number[] = [];
    const spy: TestModule = (b) =>
      b.hook('onHit', (c, hit) => {
        before.push(activeShockStacks(hit.target, c.now));
      });
    const shockedBy = (shockStacks: number, values: Partial<Record<StatId, number>> = {}) => {
      before.length = 0;
      const ctx = fixture(line(3), {
        values,
        grants: [on('outer.lightning', strike({ shockStacks }))],
        modules: [module, spy],
      });
      strikeNow(ctx);
      return { shocks: shocks(ctx), amounts: hits(ctx).map((hit) => toNumber(hit.amount)) };
    };
    expect(shockedBy(1)).toEqual({ shocks: [1, 0, 0], amounts: [10] });
    expect(before).toEqual([0]);
    expect(shockedBy(2).shocks).toEqual([2, 0, 0]);
    expect(shockedBy(5).shocks).toEqual([3, 0, 0]);
    expect(shockedBy(0).shocks).toEqual([0, 0, 0]);
    // A build that cannot shock adds none.
    expect(shockedBy(2, { shockMaxStacks: 0 }).shocks).toEqual([0, 0, 0]);
    // A shocked target's next strike is amplified by the stacks the last one left.
    const ctx = fixture(line(1), { grants: [on('outer.lightning', strike({ shockStacks: 2 }))] });
    strikeNow(ctx);
    strikeNow(ctx);
    expect(hits(ctx).map((hit) => toNumber(hit.amount))).toEqual([12]);
  });

  it('shocks no target its hit kills, and still hits its area and chains from its point', () => {
    const ctx = fixture([at(100, 0, { hp: 5 }), at(130, 0), at(250, 0)], {
      grants: [on('outer.lightning', strike({ radius: 40, chainJumps: 1, shockStacks: 1 }))],
    });
    const first = enemy(ctx, 1);
    strikeNow(ctx);
    expect(hits(ctx).map((hit) => [hit.targetId, hit.chainIndex, hit.fromX])).toEqual([
      [1, 0, null],
      [2, 0, null],
      [3, 1, first.x],
    ]);
    expect(ctx.enemies.map((e) => [e.alive, e.shockStacks])).toEqual([
      [false, 0],
      [true, 0],
      [true, 1],
    ]);
  });

  it('hits every other alive enemy within radius of its target once, in id order, after the target', () => {
    // The target is 1, of the highest hp; 3, 4 and 5 lie within 60 of it (5 on the edge), 2
    // and 6 beyond, 6 by 0.5; 7 is dead, and 8 next to the player but far from the target.
    const ctx = fixture(
      [
        at(200, 0, { hp: 1e15 }),
        at(270, 0),
        at(250, 0),
        at(200, -30),
        at(200, 60),
        at(260.5, 0),
        at(210, 0),
        at(-30, 0),
      ],
      {
        grants: [on('outer.lightning', strike({ radius: 60, target: { pick: 'highestHp' } }))],
      },
    );
    enemy(ctx, 7).alive = false;
    rebuildGrid(ctx);
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([1, 3, 4, 5]);
    // Area hits are the strike's own: chain index 0, its tags and source, no shock.
    expect(new Set(hits(ctx).map((hit) => [hit.chainIndex, hit.tags, hit.fromX].join()))).toEqual(
      new Set([[0, STRIKE_TAGS | TAG.lightning, null].join()]),
    );
    expect(hits(ctx).map((hit) => toNumber(hit.amount))).toEqual([10, 10, 10, 10]);
    // Its within() output is the emitter's own buffer.
    expect(
      emitter(ctx)
        .targets?.slice(0, 4)
        .map((e) => e.id),
    ).toEqual([1, 3, 4, 5]);
  });

  it("passes over an area enemy that died earlier in the strike, and never reaches the children its area hits' kills split into", () => {
    // 2's area hit, a pentagon of 1 hp, kills it and 3 (an onHit hook); its shards land in the
    // area after it was found. (The children of the target's kill are another matter: below.)
    let killed = false;
    const module: TestModule = (b) =>
      b.hook('onHit', (c, hit) => {
        if (hit.target.id === 2 && !killed) {
          killed = true;
          removeEnemy(c, c.enemies[2] as Enemy);
        }
      });
    const ctx = fixture(
      [at(100, 0), at(130, 0, { type: 'pentagon', hp: 1 }), at(100, 30), at(100, -30)],
      { grants: [on('outer.lightning', strike({ radius: 60 }))], modules: [module] },
    );
    const before = ctx.enemies.length;
    strikeNow(ctx);
    expect(killed).toBe(true);
    expect(ctx.enemies.length).toBeGreaterThan(before);
    expect(hitIds(ctx)).toEqual([1, 2, 4]);
  });

  it('adds no shock with shockStacks 0: a shocked target keeps its stacks, their timer and its depth', () => {
    const ctx = fixture(line(1), { grants: [on('outer.lightning', strike({ shockStacks: 0 }))] });
    const first = enemy(ctx, 1);
    addShock(ctx, first, 2, 2);
    const until = first.shockUntil;
    expect([first.shockStacks, first.ailDepth]).toEqual([2, 2]);
    ctx.now = 30;
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([1]);
    expect([first.shockStacks, first.shockUntil, first.ailDepth]).toEqual([2, until, 2]);
  });

  it('shocks its target before its area hits land, after the target hit', () => {
    const during: number[] = [];
    const spy: TestModule = (b) =>
      b.hook('onHit', (c) => {
        during.push(activeShockStacks(c.enemies[0] as Enemy, c.now));
      });
    const ctx = fixture(line(3), {
      grants: [on('outer.lightning', strike({ radius: 40, shockStacks: 2 }))],
      modules: [spy],
    });
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([1, 2, 3]);
    // The target's own hit sees no shock; the area hits after it see its 2 stacks.
    expect(during).toEqual([0, 2, 2]);
  });

  it("hits with its area the children its target's kill splits into, around its point", () => {
    // 1, a pentagon of 1 hp, dies to the strike's hit and splits (death.ts, kill step 2); its
    // shards, appended within its radius of its point, are alive when the area is found.
    const ctx = fixture([at(100, 0, { type: 'pentagon', hp: 1 })], {
      grants: [on('outer.lightning', strike({ radius: 60 }))],
    });
    strikeNow(ctx);
    const children = ctx.enemies.slice(1).map((e) => e.id);
    expect(children.length).toBeGreaterThan(0);
    expect(hitIds(ctx)).toEqual([1, ...children]);
  });

  it('with radius 0 hits its target alone, the enemies next to it untouched', () => {
    const ctx = fixture([at(100, 0), at(100, 0), at(101, 0)]);
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([1]);
  });
});

describe('strike: its attack and budget (K6)', () => {
  /** 40 squares in a 4 × 10 block, 10 apart, 100 right of the player, and 4 more 200 on. */
  const crowd = (): PlacedEnemy[] => [
    ...Array.from({ length: 40 }, (_, i) => at(100 + 10 * (i % 10), 10 * Math.floor(i / 10))),
    ...Array.from({ length: 4 }, (_, i) => at(400 + 20 * i, 0)),
  ];

  it('counts its target 1 and its area hits 0: an area past CHAIN_HIT_CAP is hit whole', () => {
    const run = (chainJumps: number): number[] => {
      const ctx = fixture(crowd(), {
        values: { chainRange: 1000 },
        grants: [on('outer.lightning', strike({ radius: 200, chainJumps }))],
      });
      strikeNow(ctx);
      const counters = ctx.counters;
      return [
        hits(ctx).length,
        new Set(hitIds(ctx)).size,
        ctx.chainBudget.hits,
        counters.chainHitsPeak,
        counters.chainHitCapped,
      ];
    };
    expect(CHAIN_HIT_CAP).toBeLessThan(40);
    expect(run(0)).toEqual([40, 40, 1, 1, 0]);
    // The chain jumps only to the 4 enemies the area missed.
    expect(run(3)).toEqual([43, 43, 4, 4, 0]);
    expect(run(8)).toEqual([44, 44, 5, 5, 0]);
  });

  it('is an attack of its own: a new serial and budget, whatever the attack before it hit or counted', () => {
    const ctx = fixture(line(5), {
      grants: [on('outer.lightning', strike({ chainJumps: 2 }))],
    });
    beginAttack(ctx);
    for (const e of ctx.enemies) e.hitMark = ctx.attackSerial;
    ctx.chainBudget.hits = CHAIN_HIT_CAP - 1;
    const serial = ctx.attackSerial;
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([1, 2, 3]);
    expect(ctx.attackSerial).toBe(serial + 1);
    expect([ctx.chainBudget.hits, ctx.counters.chainHitsPeak]).toEqual([3, 3]);
    expect(ctx.counters.chainHitCapped).toBe(0);
    // Each strike is its own attack.
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([1, 2, 3]);
    expect(ctx.attackSerial).toBe(serial + 2);
  });
});

describe('strike: its chain', () => {
  it('jumps chainJumps times from its target, nearest first, each jump shocking its enemy after its hit', () => {
    const { seen, module } = recorder();
    const before: number[] = [];
    const spy: TestModule = (b) =>
      b.hook('onHit', (c, hit) => {
        before.push(activeShockStacks(hit.target, c.now));
      });
    const ctx = fixture(line(5), {
      values: { chainRetention: 0.5 },
      grants: [on('outer.lightning', strike({ chainJumps: 2, shockStacks: 1 }))],
      modules: [module, spy],
    });
    const lightning = ctx.sources.index('outer.lightning');
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    strikeNow(ctx);
    expect(hits(ctx).map((hit) => [hit.targetId, hit.chainIndex, hit.fromX, hit.source])).toEqual([
      [1, 0, null, lightning],
      [2, 1, one.x, lightning],
      [3, 2, two.x, lightning],
    ]);
    expect(hits(ctx).map((hit) => toNumber(hit.amount))).toEqual([10, 5, 2.5]);
    expect(before).toEqual([0, 0, 0]);
    expect(shocks(ctx)).toEqual([1, 1, 1, 0, 0]);
    // Its jumps keep the strike tag and the element, drop the area tag, and carry CHAIN_JUMP.
    expect(JUMP_TAGS).toBe(TAG.hit | TAG.chain | TAG.strike | TAG.lightning);
    expect(
      seen.map(([id, k, mask, flags]) => [id, k, mask, (flags as number) & CHAIN_JUMP]),
    ).toEqual([
      [1, 0, STRIKE_TAGS | TAG.lightning, 0],
      [2, 1, JUMP_TAGS, CHAIN_JUMP],
      [3, 2, JUMP_TAGS, CHAIN_JUMP],
    ]);
  });

  it('reads its damage rows: its target and area hits are tagged area, its jumps chain, all strike', () => {
    // more ×2 on strike hits, ×3 on area hits and ×4 on chain hits: the target and its area
    // take 10 × 2 × 3; the jumps, whose rows drop area and add chain, 10 × 2 × 4.
    const ctx = fixture(line(4), {
      values: { chainRetention: 1 },
      mods: [
        { stat: 'damage', kind: 'more', value: 1, tags: ['strike'] },
        { stat: 'damage', kind: 'more', value: 2, tags: ['area'] },
        { stat: 'damage', kind: 'more', value: 3, tags: ['chain'] },
      ],
      grants: [on('outer.lightning', strike({ radius: 30, chainJumps: 2 }))],
    });
    strikeNow(ctx);
    expect(hits(ctx).map((hit) => [hit.targetId, hit.chainIndex, toNumber(hit.amount)])).toEqual([
      [1, 0, 60],
      [2, 0, 60],
      [3, 1, 80],
      [4, 2, 80],
    ]);
  });

  it('shocks nothing on its jumps without shockStacks, and makes no chain with chainJumps 0', () => {
    const run = (chainJumps: number, shockStacks: number) => {
      const ctx = fixture(line(4), {
        grants: [on('outer.lightning', strike({ chainJumps, shockStacks }))],
      });
      strikeNow(ctx);
      return [hitIds(ctx), shocks(ctx)];
    };
    expect(run(3, 0)).toEqual([
      [1, 2, 3, 4],
      [0, 0, 0, 0],
    ]);
    expect(run(0, 2)).toEqual([[1], [2, 0, 0, 0]]);
    expect(run(8, 1)).toEqual([
      [1, 2, 3, 4],
      [1, 1, 1, 1],
    ]);
  });

  it('jumps past the enemies its area hit, and stops with none left in chain range', () => {
    // Area: 1 (the target), 2 and 3; the chain goes on to 4 and 5, then finds none in 100.
    const ctx = fixture([at(100, 0), at(130, 0), at(100, 30), at(200, 0), at(280, 0), at(500, 0)], {
      values: { chainRange: 100 },
      grants: [on('outer.lightning', strike({ radius: 40, chainJumps: 5, shockStacks: 1 }))],
    });
    strikeNow(ctx);
    expect(hits(ctx).map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 1],
      [5, 2],
    ]);
    expect(shocks(ctx)).toEqual([1, 0, 0, 1, 1, 0]);
  });
});

describe('strike: its rolls and depth', () => {
  it('rolls crits and ailments on the combat stream and draws nothing on the others', () => {
    const ctx = fixture([at(100, 0), at(120, 0), at(200, 0)], {
      values: { critChance: 0.5, igniteChance: 1 },
      grants: [on('outer.lightning', strike({ radius: 30, chainJumps: 1 }))],
    });
    const before = rngPositions(ctx);
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([1, 2, 3]);
    const after = rngPositions(ctx);
    expect(after.combat).not.toEqual(before.combat);
    expect({ ...after, combat: before.combat }).toEqual(before);
    expect(ctx.enemies.map((e) => liveBurnStacks(e, ctx.now))).toEqual([1, 1, 1]);
    // critChance 0: no hit crits.
    const plain = fixture(line(3), {
      grants: [on('outer.lightning', strike({ radius: 30, chainJumps: 1 }))],
    });
    strikeNow(plain);
    expect(hits(plain).map((hit) => hit.crit)).toEqual([false, false, false]);
  });

  it('deals its hits at depth 0 from origin −1, and adds its shocks at depth 0', () => {
    const { seen, module } = recorder();
    const ctx = fixture([at(100, 0), at(120, 0), at(200, 0)], {
      grants: [on('outer.lightning', strike({ radius: 30, chainJumps: 1, shockStacks: 1 }))],
      modules: [module],
    });
    strikeNow(ctx);
    expect(seen.map(([id, , , , depth, origin]) => [id, depth, origin])).toEqual([
      [1, 0, -1],
      [2, 0, -1],
      [3, 0, -1],
    ]);
    // An enemy starts at MAX_DEPTH (3); 2, hit by the area only, is not shocked.
    expect(ctx.enemies.map((e) => e.ailDepth)).toEqual([0, 3, 0]);
  });
});

describe('strike: the emitter stage (F5-29)', () => {
  it('steps the signature, then the strike, in emitter index order, and never the thorns emitter', () => {
    for (const order of ['thorns first', 'strike first'] as const) {
      const thorns = on('center', { kind: 'thorns' });
      const bolt = on('outer.lightning', strike({ chainJumps: 1 }));
      const ctx = fixture(line(3), {
        values: { projectileCount: 1 },
        grants: order === 'thorns first' ? [thorns, bolt] : [bolt, thorns],
      });
      const [signature] = ctx.emitters as EmitterRuntime[];
      const em = ctx.emitters.find((e) => e.spec.kind === 'strike') as EmitterRuntime;
      const th = ctx.emitters.find((e) => e.spec.kind === 'thorns') as EmitterRuntime;
      expect(ctx.emitters.filter((e) => EMITTER_STEPS[e.spec.kind] !== null)).toEqual([
        signature,
        em,
      ]);
      expect(ctx.thornsEmitters).toEqual([th]);
      // Both due on this tick.
      (signature as EmitterRuntime).acc = (signature as EmitterRuntime).interval - 1;
      em.timer = em.interval - 1;
      const thornsBefore = { ...th };
      ctx.events.length = 0;
      runEmitters(ctx);
      expect(
        ctx.events.map((event) => event.type),
        order,
      ).toEqual(['attack', 'hit', 'hit']);
      expect(hits(ctx).map((hit) => hit.tags & TAG.thorns)).toEqual([0, 0]);
      expect({ ...th }).toEqual(thornsBefore);
      expect(em.timer).toBe(0);
    }
  });

  it('steps two strikes of one source with different names as two emitters, and one of a name once', () => {
    const ctx = fixture(line(4), {
      grants: [
        on('outer.lightning', strike({ name: 'bolt', periodSec: 0.5 })),
        on('outer.lightning', strike({ name: 'clap', target: { pick: 'farthest' } })),
        on('outer.lightning', strike({ name: 'bolt', periodSec: 0.5 })),
      ],
    });
    expect(ctx.emitters.map((em) => (em.spec.kind === 'strike' ? em.spec.name : 'volley'))).toEqual(
      ['volley', 'bolt', 'clap'],
    );
    const struck: number[][] = [];
    for (let tick = 1; tick <= 60; tick++) {
      ctx.now = tick;
      ctx.events.length = 0;
      (ctx.emitters[0] as EmitterRuntime).acc = -Infinity;
      runEmitters(ctx);
      if (hits(ctx).length > 0) struck.push([tick, ...hitIds(ctx)]);
    }
    // bolt every 30 ticks at the nearest, clap every 60 at the farthest, bolt first.
    expect(struck).toEqual([
      [30, 1],
      [60, 1, 4],
    ]);
  });
});
