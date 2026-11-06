import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import type { SourcedEmitter, StrikeGrant } from '../../data/emitters';
import type { Modifier, StatId } from '../../data/stats';
import { jumpMask, TAG } from '../../data/tags';
import type { TargetSelector } from '../../data/triggers';
import { activeShockStacks, addShock } from '../ailments/shock';
import { sizeOf } from '../build/size';
import { beginAttack, endAttack } from '../combat/chain';
import { hitWithPayload } from '../combat/hit';
import { chainGeneral } from '../combat/policy';
import { select } from '../effects/select';
import type { CompiledSelector } from '../effects/select';
import type { TestModule } from '../rules';
import type { Enemy, RunContext } from '../systems/context';
import { rebuildGrid } from '../systems/grid';
import { eventsOf, makeStats, placedEnemies, rngPositions } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { runStrike } from './strike';
import type { EmitterRuntime, Payload, StrikeSpec } from './types';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y + dy,
  ...more,
});
/** An enemy `d` from the player at `deg` degrees. */
const polar = (d: number, deg: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy =>
  at(d * Math.cos((deg * Math.PI) / 180), d * Math.sin((deg * Math.PI) / 180), more);

/** The tags of a strike's hits without an element. */
const STRIKE_TAGS = TAG.hit | TAG.strike | TAG.area;

/** A 1 s strike at the enemy nearest the player, 100% of the damage stat, lightning. */
const strike = (fields: Partial<Omit<StrikeGrant, 'kind'>> = {}): StrikeGrant => ({
  kind: 'strike',
  name: 'spikes',
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

/** placedEnemies with these grants (one strike on outer.thorns by default) over NO_ROLLS. */
function fixture(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, options.mods ?? [], {
      triggers: [],
      conversions: [],
      emitters: options.grants ?? [on('outer.thorns', strike())],
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
/** [target id, chain index] of each hit. */
const hitPairs = (ctx: RunContext): number[][] =>
  hits(ctx).map((hit) => [hit.targetId, hit.chainIndex]);
const shocks = (ctx: RunContext): number[] => ctx.enemies.map((e) => activeShockStacks(e, ctx.now));

/** 荊棘傷害's increased and 鐵處女's more, both on thorns-tagged damage (gd:466-469). */
const THORNS_MODS: readonly Modifier[] = [
  { stat: 'damage', kind: 'increased', value: 0.5, tags: ['thorns'] },
  { stat: 'damage', kind: 'more', value: 1, tags: ['thorns'] },
];

describe('strike: its tags (E16, T1)', () => {
  it("takes every thorns modifier on a thorns-tagged strike's hits, its area's and its chain's jumps, and none on an untagged strike's", () => {
    // 1 is the target; 2, 20 from it, is in its area; 3, 40 on, takes the one jump.
    const run = (tags: StrikeGrant['tags']): HitEvent[] => {
      const ctx = fixture([at(100, 0), at(120, 0), at(140, 0)], {
        values: { chainRetention: 1 },
        mods: THORNS_MODS,
        grants: [
          on(
            'outer.thorns',
            strike({ radius: 30, chainJumps: 1, ...(tags === undefined ? {} : { tags }) }),
          ),
        ],
      });
      strikeNow(ctx);
      return hits(ctx);
    };
    const thorny = run(['thorns']);
    const primary = STRIKE_TAGS | TAG.lightning | TAG.thorns;
    expect(thorny.map((hit) => [hit.targetId, hit.chainIndex, hit.tags])).toEqual([
      [1, 0, primary],
      [2, 0, primary],
      [3, 1, jumpMask(primary)],
    ]);
    // The jump keeps the owner tags, thorns among them, as every jump does.
    expect(jumpMask(primary)).toBe(TAG.hit | TAG.chain | TAG.strike | TAG.thorns | TAG.lightning);
    // 10 × (1 + 0.5) × 2 on each: the target, its area and its jump.
    expect(thorny.map((hit) => toNumber(hit.amount))).toEqual([30, 30, 30]);
    const plain = run(undefined);
    expect(plain.map((hit) => hit.tags & TAG.thorns)).toEqual([0, 0, 0]);
    expect(plain.map((hit) => toNumber(hit.amount))).toEqual([10, 10, 10]);
    // Another delivery tag reaches its own modifiers alike, the thorns ones not.
    expect(run(['orbit']).map((hit) => toNumber(hit.amount))).toEqual([10, 10, 10]);
  });

  it("carries its tags on its payload's and its chain payload's primary tags", () => {
    const ctx = fixture([], {
      grants: [on('outer.thorns', strike({ tags: ['thorns', 'projectile'], chainJumps: 2 }))],
    });
    const em = emitter(ctx);
    const tags = STRIKE_TAGS | TAG.lightning | TAG.thorns | TAG.projectile;
    expect([em.spec.tags, em.payload.tags, em.chainPayload?.tags]).toEqual([tags, tags, tags]);
  });
});

/**
 * Nine enemies around the player, ids out of distance order: within 200, 9 (30), 2 (50), 5 (80),
 * 4 (120), 7 (160), 1 (190) and 6 (on 200); beyond it, 3 (250) and 8 (201).
 */
const RING: readonly PlacedEnemy[] = [
  polar(190, 10),
  polar(50, 50),
  polar(250, 90),
  polar(120, 130),
  polar(80, 170),
  at(200, 0),
  polar(160, 250),
  at(0, 201),
  polar(30, 290),
];

describe('strike: its targets (E16, T2)', () => {
  it("hits six distinct enemies in one strike with targets 6 and { pick: 'nearest', range: 200 }: nearest first, each once, none beyond 200", () => {
    const target: TargetSelector = { pick: 'nearest', range: 200 };
    const ctx = fixture(RING, { grants: [on('outer.thorns', strike({ target, targets: 6 }))] });
    const serial = ctx.attackSerial;
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([9, 2, 5, 4, 7, 1]);
    expect(new Set(hitIds(ctx)).size).toBe(6);
    expect(hits(ctx).every((hit) => hit.chainIndex === 0)).toBe(true);
    // One attack.
    expect(ctx.attackSerial).toBe(serial + 1);
    // With one of the six dead, the seventh, on the edge at 200, comes in last.
    enemy(ctx, 4).alive = false;
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([9, 2, 5, 7, 1, 6]);
    // 8, at 201, is never one, whoever else is dead.
    for (const id of [1, 2, 5, 6, 7, 9]) enemy(ctx, id).alive = false;
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([]);
  });

  it('strikes as many as there are with fewer accepted enemies than its targets, and loses the strike with none: no hit, attack, budget or draw', () => {
    const target: TargetSelector = { pick: 'nearest', range: 100 };
    const grants = [on('outer.thorns', strike({ target, targets: 6, shockStacks: 1 }))];
    const ctx = fixture([at(300, 0), at(0, 60), at(-90, 0), at(0, -200), at(40, 40)], {
      values: { critChance: 0.5 },
      grants,
    });
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([5, 2, 3]);
    expect([ctx.chainBudget.hits, ctx.counters.chainHitsPeak]).toEqual([3, 3]);
    expect(shocks(ctx)).toEqual([0, 1, 1, 0, 1]);
    // None within 100: nothing drawn, no attack begun, the budget as it was.
    const none = fixture([at(300, 0), at(0, -200)], { values: { critChance: 0.5 }, grants });
    const serial = none.attackSerial;
    const budget = { ...none.chainBudget };
    const before = rngPositions(none);
    strikeNow(none);
    expect(hits(none)).toEqual([]);
    expect(none.events).toEqual([]);
    expect([none.attackSerial, { ...none.chainBudget }]).toEqual([serial, budget]);
    expect(rngPositions(none)).toEqual(before);
    expect(emitter(none).timer).toBe(0);
  });

  it("strikes first the enemy select() picks, for every pick, and the rest in that pick's order, ties to the lower id", () => {
    // Ties everywhere: 1 and 2 at 100 on either side, 3 and 4 at 300 above and below, 5 at 200;
    // 2, 4 and 5 hold the most hp, 1, 3 and 5 three shock stacks, 2 one, 4 none.
    const placed = [at(100, 0), at(-100, 0), at(0, 300), at(0, -300), at(200, 0)];
    const picks: readonly TargetSelector[] = [
      { pick: 'nearest' },
      { pick: 'farthest' },
      { pick: 'outermost' },
      { pick: 'highestHp' },
      { pick: 'mostStacks', ailment: 'shock' },
      { pick: 'densest' },
    ];
    const order = (target: TargetSelector, targets: number): number[] => {
      const ctx = fixture(placed, { grants: [on('outer.thorns', strike({ target, targets }))] });
      for (const id of [2, 4, 5]) enemy(ctx, id).hp = num(5e12);
      for (const [id, stacks] of [
        [1, 3],
        [2, 1],
        [3, 3],
        [5, 3],
      ] as const) {
        Object.assign(enemy(ctx, id), { shockStacks: stacks, shockUntil: 1e6 });
      }
      strikeNow(ctx);
      return hitIds(ctx);
    };
    const expected: Record<string, number[]> = {
      nearest: [1, 2, 5, 3, 4],
      farthest: [3, 4, 5, 1, 2],
      outermost: [3, 4, 5, 1, 2],
      highestHp: [2, 4, 5, 1, 3],
      // At least one stack: 4 has none.
      mostStacks: [1, 3, 5, 2],
      // The densest block's point, then the nearest to it.
      densest: [],
    };
    for (const target of picks) {
      const one = order(target, 1);
      const five = order(target, 5);
      expect(one, target.pick).toHaveLength(1);
      expect(five[0], target.pick).toBe(one[0]);
      if (target.pick !== 'densest') expect(five, target.pick).toEqual(expected[target.pick]);
      else expect(new Set(five), target.pick).toEqual(new Set([1, 2, 3, 4, 5]));
    }
  });

  it('strikes with each target the area around it, the other picked targets included, and passes over a picked target an earlier one killed: no hit, no shock, no area, not a chain root', () => {
    // Picks 1, 2, 3 and 4 by distance. 1's area (30) holds 2, whose 5 hp its hit takes; 3's
    // holds 4, which survives and takes its own strike after. 5 is the chain's only way on.
    const ctx = fixture(
      [at(100, 0), at(120, 0, { hp: 5 }), at(0, 200), at(0, 220), at(-300, 0), at(0, 500)],
      {
        values: { chainRange: 1000 },
        grants: [
          on('outer.thorns', strike({ targets: 4, radius: 30, chainJumps: 1, shockStacks: 1 })),
        ],
      },
    );
    const [one, , three, four] = [enemy(ctx, 1), enemy(ctx, 2), enemy(ctx, 3), enemy(ctx, 4)];
    strikeNow(ctx);
    expect(hits(ctx).map((hit) => [hit.targetId, hit.chainIndex, hit.fromX])).toEqual([
      [1, 0, null],
      // 1's area: 2, killed.
      [2, 0, null],
      // 2 is passed over; 3 and its area, 4; then 4 and its area, 3.
      [3, 0, null],
      [4, 0, null],
      [4, 0, null],
      [3, 0, null],
      // One jump a root: from 1, then from 3 and from 4; none from 2.
      [5, 1, one.x],
      [6, 1, three.x],
    ]);
    expect(four.x).toBe(three.x);
    expect(ctx.enemies.map((e) => e.alive)).toEqual([true, false, true, true, true, true]);
    // Shock on the struck alone, and on the jumps.
    expect(shocks(ctx)).toEqual([1, 0, 1, 1, 1, 1]);
    // The struck targets 1, 3 and 4 and the two jumps each count 1.
    expect(ctx.chainBudget.hits).toBe(5);
  });

  it('picks every target before it hits any: a kill shifts no later pick, so a seventh enemy is never struck', () => {
    // Targets 3: 1, 2 (5 hp, in 1's area) and 3. Picks made between hits would take 4 for 2.
    const ctx = fixture([at(100, 0), at(120, 0, { hp: 5 }), at(0, 200), at(0, -400)], {
      grants: [on('outer.thorns', strike({ targets: 3, radius: 30 }))],
    });
    strikeNow(ctx);
    expect(hitPairs(ctx)).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    expect(hitIds(ctx)).not.toContain(4);
  });

  it('chains once from every struck root, in pick order: its levels in turn, its jumps rolled once', () => {
    // Three targets far apart (100, 110 and 120 out), each with two enemies trailing it 50 and
    // 100 further out.
    const placed = [
      at(100, 0),
      at(0, 110),
      at(-120, 0),
      at(150, 0),
      at(200, 0),
      at(0, 160),
      at(0, 210),
      at(-170, 0),
      at(-220, 0),
    ];
    const ctx = fixture(placed, {
      values: { chainRange: 60, chainRetention: 0.5 },
      grants: [on('outer.thorns', strike({ targets: 3, chainJumps: 2 }))],
    });
    const xs = ctx.enemies.map((e) => e.x);
    strikeNow(ctx);
    expect(hits(ctx).map((hit) => [hit.targetId, hit.chainIndex, hit.fromX])).toEqual([
      [1, 0, null],
      [2, 0, null],
      [3, 0, null],
      [4, 1, xs[0]],
      [6, 1, xs[1]],
      [8, 1, xs[2]],
      [5, 2, xs[3]],
      [7, 2, xs[5]],
      [9, 2, xs[7]],
    ]);
    expect(hits(ctx).map((hit) => toNumber(hit.amount))).toEqual([
      10, 10, 10, 5, 5, 5, 2.5, 2.5, 2.5,
    ]);
    expect([ctx.chainBudget.hits, ctx.counters.chainHitsPeak]).toEqual([9, 9]);
  });

  it("counts each struck target 1 in the attack's budget: n hits, one attack, its area hits none", () => {
    const ctx = fixture(RING, {
      grants: [on('outer.thorns', strike({ target: { pick: 'nearest' }, targets: 8, radius: 60 }))],
    });
    const serial = ctx.attackSerial;
    strikeNow(ctx);
    expect(ctx.attackSerial).toBe(serial + 1);
    expect(hitIds(ctx).length).toBeGreaterThan(8);
    expect([ctx.chainBudget.hits, ctx.counters.chainHitsPeak]).toEqual([8, 8]);
  });

  it('draws only its hits’ rolls, on the combat stream, and raises no event but its hits', () => {
    const ctx = fixture(RING, {
      values: { critChance: 0.5, igniteChance: 1 },
      grants: [on('outer.thorns', strike({ target: { pick: 'farthest' }, targets: 6 }))],
    });
    const before = rngPositions(ctx);
    strikeNow(ctx);
    const after = rngPositions(ctx);
    expect(after.combat).not.toEqual(before.combat);
    expect({ ...after, combat: before.combat }).toEqual(before);
    expect(new Set(ctx.events.map((event) => event.type))).toEqual(new Set(['hit', 'ignite']));
    expect(hitIds(ctx)).toEqual([3, 8, 6, 1, 7, 4]);
  });

  it('strikes only the enemies this strike picks, never one an earlier strike picked and it finds no more', () => {
    const target: TargetSelector = { pick: 'nearest', range: 200 };
    const ctx = fixture(RING, { grants: [on('outer.thorns', strike({ target, targets: 6 }))] });
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([9, 2, 5, 4, 7, 1]);
    // 5, 4, 7 and 1 step out of reach, alive: the next strike finds 9, 2 and 6 alone.
    for (const id of [5, 4, 7, 1]) Object.assign(enemy(ctx, id), { x: PLAYER.x + 600 });
    rebuildGrid(ctx);
    strikeNow(ctx);
    expect(hitIds(ctx)).toEqual([9, 2, 6]);
  });

  it('chains from its struck roots in pick order, not in id order', () => {
    // Picks 3, 2 and 1 (100, 110 and 120 out), each with one enemy 50 beyond it.
    const ctx = fixture(
      [at(-120, 0), at(0, 110), at(100, 0), at(-170, 0), at(0, 160), at(150, 0)],
      {
        values: { chainRange: 60 },
        grants: [on('outer.thorns', strike({ targets: 3, chainJumps: 1 }))],
      },
    );
    strikeNow(ctx);
    expect(hitPairs(ctx)).toEqual([
      [3, 0],
      [2, 0],
      [1, 0],
      [6, 1],
      [5, 1],
      [4, 1],
    ]);
  });

  it('keeps a target its own hit killed among the chain roots, in its place', () => {
    // 1 (5 hp, 100 out) dies of its own hit, 2 (110 out) lives; each has an enemy 50 beyond it.
    const ctx = fixture([at(100, 0, { hp: 5 }), at(0, 110), at(150, 0), at(0, 160)], {
      values: { chainRange: 60 },
      grants: [on('outer.thorns', strike({ targets: 2, chainJumps: 1 }))],
    });
    strikeNow(ctx);
    expect(enemy(ctx, 1).alive).toBe(false);
    expect(hits(ctx).map((hit) => [hit.targetId, hit.chainIndex, hit.fromX])).toEqual([
      [1, 0, null],
      [2, 0, null],
      [3, 1, enemy(ctx, 1).x],
      [4, 1, enemy(ctx, 2).x],
    ]);
  });
});

/**
 * d45dd0b's runStrike (E15b), the base's own path for one target, kept here verbatim but for
 * its name: a strike of one target must run it bit for bit (T2).
 */
function baseRunStrike(ctx: RunContext, em: EmitterRuntime): void {
  em.timer += 1;
  if (em.timer < em.interval) return;
  em.timer -= em.interval;
  const player = ctx.player;
  if (!select(ctx, em.selector as CompiledSelector, null, player.x, player.y)) return;
  // Never null: validation rejects a strike's 'player' pick.
  const target = ctx.selected as Enemy;
  const spec = em.spec as StrikeSpec;
  const p = em.payload;
  beginAttack(ctx);
  ctx.chainBudget.hits++;
  const landed = hitWithPayload(ctx, target, p, 0, 1, null, null, false, 0, -1);
  const stacks = spec.shockStacks;
  if (landed && stacks > 0 && target.alive) addShock(ctx, target, stacks, 0);
  if (spec.radius > 0) {
    const targets = em.targets as Enemy[];
    const r = sizeOf(ctx.build, spec.radius);
    const n = ctx.grid.within(target.x, target.y, r * r, targets);
    for (let j = 0; j < n; j++) {
      const enemy = targets[j] as Enemy;
      // Area hits count in no budget; an enemy killed earlier in this strike is passed over.
      // They add no shock, so a blocked one changes nothing after it (R1).
      if (enemy !== target && enemy.alive) {
        hitWithPayload(ctx, enemy, p, 0, 1, null, null, false, 0, -1);
      }
    }
  }
  if (spec.chainJumps > 0) {
    // From the target's point even if it died, as an M1 chain does.
    const roots = ctx.sys.chain.frontier;
    roots[0] = target;
    chainGeneral(ctx, em.chainPayload as Payload, roots, 1, spec.chainJumps, false, 0, -1);
  }
  endAttack(ctx);
}

describe('strike: one target runs the base path (E16, T2)', () => {
  /** 30 enemies of mixed hp in a cluster and a ring, a few killable. */
  const crowd = (): PlacedEnemy[] =>
    Array.from({ length: 30 }, (_, i) =>
      polar(40 + 9 * i, 47 * i, {
        hp: i % 4 === 0 ? 40 : 1e12,
        ...(i === 7 ? { type: 'boss' } : {}),
      }),
    );
  /** Strikes of one target: written 1, omitted, a thorns one at thornsArea 1, every field. */
  const GRANTS: readonly SourcedEmitter[] = [
    on(
      'outer.lightning',
      strike({ name: 'a', periodSec: 0.25, radius: 50, shockStacks: 1, targets: 1 }),
    ),
    on(
      'outer.lightning',
      strike({
        name: 'b',
        periodSec: 0.2,
        target: { pick: 'highestHp', range: 400, excludeBoss: true },
        chainJumps: 4,
        shockStacks: 2,
      }),
    ),
    on(
      'outer.thorns',
      strike({
        name: 'c',
        periodSec: 0.25,
        target: { pick: 'mostStacks', ailment: 'shock' },
        radius: 80,
        element: 'cold',
        tags: ['thorns'],
        targets: 1,
      }),
    ),
    on('center', strike({ name: 'd', periodSec: 0.1, target: { pick: 'densest' }, radius: 40 })),
  ];

  /** Steps the strike emitters of a fresh fixture with `step` for 360 ticks; every tick's events. */
  const run = (step: (ctx: RunContext, em: EmitterRuntime) => void, values: object) => {
    const ctx = fixture(crowd(), {
      values: { critChance: 0.3, igniteChance: 0.3, chainRange: 300, ...values },
      mods: THORNS_MODS,
      grants: GRANTS,
    });
    const ticks: SimEvent[][] = [];
    for (let tick = 1; tick <= 360; tick++) {
      ctx.now = tick;
      ctx.events.length = 0;
      for (const em of ctx.emitters) if (em.spec.kind === 'strike') step(ctx, em);
      ticks.push([...ctx.events]);
      rebuildGrid(ctx);
    }
    return {
      ticks,
      enemies: ctx.enemies.map((e) => [e.id, e.alive, toNumber(e.hp), e.shockStacks]),
      rng: rngPositions(ctx),
      budget: { ...ctx.chainBudget },
      serial: ctx.attackSerial,
    };
  };

  it.each([
    ['the base stats', {}],
    ['areaSize 1.2 and spreadRadius 1.5', { areaSize: 1.2, spreadRadius: 1.5 }],
  ])('deals every hit and event of the base path, toEqual, over 360 ticks at %s', (_, values) => {
    const now = run(runStrike, values);
    const base = run(baseRunStrike, values);
    expect(now).toEqual(base);
    expect(eventsOf(now.ticks, 'hit').length).toBeGreaterThan(300);
    expect(now.enemies.filter(([, alive]) => alive === false).length).toBeGreaterThan(2);
  });
});
