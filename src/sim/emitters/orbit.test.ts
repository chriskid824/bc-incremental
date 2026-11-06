import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import { createRng } from '../../core/rng';
import { ORBIT_DEFAULTS } from '../../data/emitters';
import type { OrbitGrant, SourcedEmitter } from '../../data/emitters';
import type { SignatureSpec } from '../../data/rules';
import { BASE_STATS } from '../../data/stats';
import type { StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { EnemyId } from '../../data/types';
import { orbitRevPerSec, compileBuild } from '../build/compile';
import { ORB_MEMORY, ORBIT_MAX_REV_PER_SEC } from '../caps';
import { CHAIN_JUMP, PRIMARY, REPEAT, SIGNATURE } from '../effects/flags';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { EMITTER_STEPS } from '../systems/emitters';
import { rebuildGrid } from '../systems/grid';
import {
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
  STRESS_START_WAVE,
  stressData,
  stressStats,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import { runOrbit } from './orbit';
import { createOrbMemory, grantEmitter, shotsInFlight } from './types';
import type { EmitterRuntime, EmitterSpec, OrbMemory } from './types';

type HitEvent = Extract<SimEvent, { type: 'hit' }>;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (dx: number, dy: number, more: Omit<PlacedEnemy, 'x' | 'y'> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y + dy,
  ...more,
});

/** The tags of an orb's hits. */
const ORBIT_TAGS = TAG.hit | TAG.orbit;
/** The rings' radii and an orb's, as granted without them. */
const [RING_0, RING_1] = ORBIT_DEFAULTS.ringRadius;
const ORB_RADIUS = ORBIT_DEFAULTS.orbRadius;

/** An orbit grant of `count` orbs. */
const orbit = (count: number, fields: Omit<OrbitGrant, 'kind' | 'count'> = {}): OrbitGrant => ({
  kind: 'orbit',
  count,
  ...fields,
});
const on = (source: string, grant: SourcedEmitter['grant']): SourcedEmitter => ({ source, grant });

/** Damage 10 and no crits or ignites unless `values` say so: a default orb hit deals 6. */
const NO_ROLLS = { damage: 10, critChance: 0, igniteChance: 0 };
/** Crits at × 2, ignites and poison at 0.5: a hit draws its crit, ignite and poison rolls. */
const HALF = { critChance: 0.5, critMultiplier: 2, igniteChance: 0.5, poisonChance: 0.5 };

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly grants?: readonly SourcedEmitter[];
  readonly modules?: readonly TestModule[];
  readonly signature?: SignatureSpec;
}

/** placedEnemies with these grants (one orb on ring 0, on outer.aura) over NO_ROLLS. */
function fixture(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...NO_ROLLS, ...options.values }, [], {
      triggers: [],
      conversions: [],
      emitters: options.grants ?? [on('outer.aura', orbit(1))],
    }),
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    ...(options.signature === undefined ? {} : { signature: options.signature }),
  });
}

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;
const emitter = (ctx: RunContext, i = 1): EmitterRuntime => ctx.emitters[i] as EmitterRuntime;
const memoryOf = (ctx: RunContext, i = 1): OrbMemory => emitter(ctx, i).orbs as OrbMemory;

/** Runs orbit emitter `i` on tick `tick`, its events alone in ctx.events. */
function orbitAt(ctx: RunContext, tick: number, i = 1): void {
  ctx.now = tick;
  ctx.events.length = 0;
  runOrbit(ctx, emitter(ctx, i));
}

const hits = (ctx: RunContext): HitEvent[] => eventsOf([ctx.events], 'hit');
const hitIds = (ctx: RunContext): number[] => hits(ctx).map((hit) => hit.targetId);

/** [tick, target id] of each hit of orbit emitter `i` on ticks `from` to `to`. */
function hitsOver(ctx: RunContext, from: number, to: number, i = 1): [number, number][] {
  const seen: [number, number][] = [];
  for (let tick = from; tick <= to; tick++) {
    orbitAt(ctx, tick, i);
    for (const id of hitIds(ctx)) seen.push([tick, id]);
  }
  return seen;
}

/**
 * Where orb `o` of `n` on a ring of radius `ring` is on tick `now`, turning `rev` times a second
 * (once at the orbitSpeed stat's base).
 */
function orbAt(
  ctx: RunContext,
  now: number,
  o: number,
  n: number,
  ring: number,
  rev: number = ORBIT_DEFAULTS.revPerSec,
) {
  const a = (2 * Math.PI * rev * now) / TICK_RATE + (2 * Math.PI * o) / n;
  return { x: ctx.player.x + ring * Math.cos(a), y: ctx.player.y + ring * Math.sin(a) };
}

/** Whether enemy `e` touches an orb of radius `orbRadius` at `orb`: their radii overlap. */
function touches(e: Enemy, orb: { x: number; y: number }, orbRadius: number): boolean {
  const r = orbRadius + e.radius;
  const dx = e.x - orb.x;
  const dy = e.y - orb.y;
  return dx * dx + dy * dy <= r * r;
}

/** The ids orb `o` of `m` remembers, oldest first. */
function remembered(m: OrbMemory, o: number): number[] {
  const out: number[] = [];
  const b = o * ORB_MEMORY;
  for (let q = 0; q < (m.count[o] as number); q++) {
    out.push(m.ids[b + (((m.head[o] as number) + q) & (ORB_MEMORY - 1))] as number);
  }
  return out;
}

/**
 * [orb, enemy id] of each entry of `m` that ends on tick `until`, orb by orb, oldest first: on
 * tick `now`, the entries written then are those that end on now + its cooldown.
 */
function written(m: OrbMemory, until: number): [number, number][] {
  const out: [number, number][] = [];
  for (let o = 0; o < m.n; o++) {
    const b = o * ORB_MEMORY;
    for (let q = 0; q < (m.count[o] as number); q++) {
      const slot = b + (((m.head[o] as number) + q) & (ORB_MEMORY - 1));
      if (m.until[slot] === until) out.push([o, m.ids[slot] as number]);
    }
  }
  return out;
}

/**
 * Reference (Hoshi's Q13 (B), docs/v3 C4 design §4.13): an orbit of `n` orbs on a ring of radius
 * `ring`, each of radius `orbRadius`, whose orbs may hit an enemy again `cd` ticks after they hit
 * it, kept as a map (orb, enemy id) → the tick from which that orb may hit it again. On each
 * tick, orb by orb, each alive enemy the orb touches, in id order, is hit when the tick has
 * reached its entry. With `limit`, an orb remembers at most that many enemies whose ticks are
 * still ahead, and one more makes it forget the one it hit longest ago (Q13/F1), counted in
 * `dropped`. Its ring turns `rev` times a second (once at the orbitSpeed stat's base).
 */
class OrbitRef {
  private readonly ready = new Map<string, number>();
  /** The ids each orb remembers, in the order it hit them. */
  private readonly order: number[][];
  dropped = 0;

  constructor(
    private readonly n: number,
    private readonly ring: number,
    private readonly cd: number,
    private readonly orbRadius = ORB_RADIUS,
    private readonly limit = Infinity,
    private readonly rev: number = ORBIT_DEFAULTS.revPerSec,
  ) {
    this.order = Array.from({ length: n }, () => []);
  }

  /** [tick, orb, enemy id] of the hits on tick `now`, the enemies where ctx has them. */
  step(ctx: RunContext, now: number): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let o = 0; o < this.n; o++) {
      const orb = orbAt(ctx, now, o, this.n, this.ring, this.rev);
      const key = (id: number): string => `${o}:${id}`;
      const order = (this.order[o] as number[]).filter(
        (id) => now < (this.ready.get(key(id)) as number),
      );
      for (const e of ctx.enemies) {
        if (!e.alive || !touches(e, orb, this.orbRadius)) continue;
        if (now < (this.ready.get(key(e.id)) ?? -Infinity)) continue;
        if (order.length === this.limit) {
          this.ready.delete(key(order.shift() as number));
          this.dropped++;
        }
        this.ready.set(key(e.id), now + this.cd);
        order.push(e.id);
        out.push([now, o, e.id]);
      }
      this.order[o] = order;
    }
    return out;
  }
}

/** The enemy types the moving fixtures draw from: small ones mostly, and the tough two. */
const TYPES: readonly EnemyId[] = [
  'triangle',
  'square',
  'pentagon',
  'shard',
  'triangle',
  'square',
  'hexagon',
  'boss',
];

/**
 * An enemy that circles the player near a ring: its angle turns `spin` radians a tick from
 * `angle`, and its distance swings `swing` around `dist` once every `period` ticks.
 */
interface Mover {
  readonly type: EnemyId;
  readonly angle: number;
  readonly spin: number;
  readonly dist: number;
  readonly swing: number;
  readonly period: number;
  readonly phase: number;
}

/** `count` movers drawn on a seeded stream of their own, about `ring` from the player. */
function movers(seed: number, count: number, ring: number): Mover[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => ({
    type: rng.pick(TYPES),
    angle: rng.range(0, 2 * Math.PI),
    spin: rng.range(-0.08, 0.08),
    dist: ring + rng.range(-60, 60),
    swing: rng.range(0, 50),
    period: rng.range(30, 240),
    phase: rng.range(0, 2 * Math.PI),
  }));
}

/** 100 standing squares 400 to 480 from the player, beyond every orb's reach. */
const DECOYS: readonly PlacedEnemy[] = Array.from({ length: 100 }, (_, k) => {
  const a = (2 * Math.PI * k) / 100;
  const d = 400 + 80 * ((k * 7) % 10) * 0.1;
  return at(d * Math.cos(a), d * Math.sin(a));
});

/** Puts the first enemies of ctx where `moving` has them on tick `tick`, and rebuilds the grid. */
function move(ctx: RunContext, moving: readonly Mover[], tick: number): void {
  moving.forEach((m, k) => {
    const e = ctx.enemies[k] as Enemy;
    const d = m.dist + m.swing * Math.sin(m.phase + (2 * Math.PI * tick) / m.period);
    const a = m.angle + m.spin * tick;
    e.x = e.prevX = ctx.player.x + d * Math.cos(a);
    e.y = e.prevY = ctx.player.y + d * Math.sin(a);
  });
  rebuildGrid(ctx);
}

/** A module that records [target id, tags, source, flags, depth, origin] of each hit. */
function recorder(): { seen: number[][]; module: TestModule } {
  const seen: number[][] = [];
  const module: TestModule = (b) =>
    b.hook('onHit', (_ctx, hit) => {
      seen.push([hit.target.id, hit.mask, hit.source, hit.flags, hit.depth, hit.origin]);
    });
  return { seen, module };
}

describe('orbit: its emitter', () => {
  it('is granted with its defaults: ring 0 at 110, orbs of 12 turning once a second, tags hit and orbit, crits and ailments', () => {
    expect(grantEmitter('outer.aura', { kind: 'orbit' })).toEqual({
      kind: 'orbit',
      signature: false,
      source: 'outer.aura',
      damagePct: 0.6,
      tags: ORBIT_TAGS,
      chains: false,
      rollsAilments: true,
      canCrit: true,
      ring: 0,
      radius: 110,
      count: 0,
      revPerSec: 1,
      cooldownSec: 0.5,
      orbRadius: 12,
    });
    expect(ORBIT_DEFAULTS.ringRadius).toEqual([110, 180]);
    const full = orbit(3, { ring: 1, damagePct: 1, cooldownSec: 0.25, orbRadius: 20 });
    expect(grantEmitter('hub', full)).toMatchObject({
      source: 'hub',
      ring: 1,
      radius: 180,
      count: 3,
      damagePct: 1,
      cooldownSec: 0.25,
      orbRadius: 20,
    });
    // It hits where it is: nothing in flight to count for targeting.
    expect(shotsInFlight(grantEmitter('outer.aura', full))).toBe(false);
  });

  it('takes round(cooldownSec × 60) as interval at any attack speed: 30 at 0.5, 6 at 0.1, 60 at 1 (D4)', () => {
    const cases: [number, number][] = [
      [0.5, 30],
      [0.1, 6],
      [1, 60],
      [1 / 60, 1],
      // 1.506 and 1.494 ticks: rounded, not floored or ceiled.
      [0.0251, 2],
      [0.0249, 1],
    ];
    for (const [cooldownSec, ticks] of cases) {
      for (const attackSpeed of [0.5, 40]) {
        const ctx = fixture([], {
          values: { attackSpeed },
          grants: [on('outer.aura', orbit(2, { cooldownSec }))],
        });
        expect(emitter(ctx).interval, `${cooldownSec} s at attackSpeed ${attackSpeed}`).toBe(ticks);
        expect([emitter(ctx).timer, emitter(ctx).acc]).toEqual([0, 0]);
      }
    }
  });

  it('builds its memory once for the run: count + floor(orbitCount) orbs of ORB_MEMORY entries', () => {
    expect(ORB_MEMORY).toBe(64);
    const ctx = fixture([], {
      values: { orbitCount: 2.9 },
      grants: [
        on('outer.aura', orbit(2)),
        on('outer.aura', orbit(0, { ring: 1 })),
        on('hub', orbit(1)),
      ],
    });
    const memories = [1, 2, 3].map((i) => memoryOf(ctx, i));
    expect(memories.map((m) => m.n)).toEqual([4, 2, 3]);
    for (const m of memories) {
      expect([m.ids.length, m.until.length, m.head.length, m.count.length]).toEqual([
        m.n * ORB_MEMORY,
        m.n * ORB_MEMORY,
        m.n,
        m.n,
      ]);
      expect([...m.head, ...m.count]).toEqual(new Array(2 * m.n).fill(0));
    }
    expect(createOrbMemory(-3)).toMatchObject({ n: 0 });
    // Without orbs it hits nothing.
    const none = fixture([at(RING_0, 0)], { grants: [on('outer.aura', orbit(0))] });
    expect(memoryOf(none).n).toBe(0);
    expect(hitsOver(none, 1, 120)).toEqual([]);
  });

  it('has the keys of every other kind, its own target buffer and memory, and orbs null on every other kind', () => {
    const ctx = fixture([], {
      grants: [
        on('outer.thorns', { kind: 'thorns' }),
        on('outer.lightning', { kind: 'segment', endpoints: 'shocked' }),
        on('outer.lightning', {
          kind: 'strike',
          name: 'bolt',
          periodSec: 1,
          target: { pick: 'nearest' },
          damagePct: 1,
        }),
        on('outer.summon', { kind: 'drone', drones: 1 }),
        on('outer.aura', { kind: 'aura' }),
        on('outer.aura', orbit(2)),
        on('outer.aura', orbit(3, { ring: 1 })),
      ],
    });
    expect(ctx.emitters.map((em) => em.spec.kind)).toEqual([
      'volley',
      'thorns',
      'segment',
      'strike',
      'drone',
      'aura',
      'orbit',
      'orbit',
    ]);
    const keys = Object.keys(ctx.emitters[0] as EmitterRuntime);
    expect(keys).toHaveLength(19);
    expect(keys.slice(-2)).toEqual(['orbs', 'barrage']);
    for (const em of ctx.emitters) {
      expect(Object.keys(em), em.spec.kind).toEqual(keys);
      expect(em.orbs === null, em.spec.kind).toBe(em.spec.kind !== 'orbit');
    }
    // The signatures' runtimes too.
    for (const id of ['magmaBomb', 'iceFan', 'triphaseArc', 'swarm'] as const) {
      const signature = fixture([], { grants: [], signature: { id } }).emitters[0];
      expect(Object.keys(signature as EmitterRuntime), id).toEqual(keys);
      expect(signature?.orbs).toBeNull();
    }
    const [first, second] = ctx.emitters.slice(6) as EmitterRuntime[];
    expect(first?.targets).toEqual([]);
    expect(first?.targets).not.toBe(second?.targets);
    expect(first?.orbs).not.toBe(second?.orbs);
    expect([first?.selector, first?.chainPayload, first?.alt]).toEqual([null, null, null]);
    // Its payload: 60% of the damage stat on the combat stream, hit by hit (no pulse tally).
    const p = (first as EmitterRuntime).payload;
    expect(toNumber(p.baseDamage)).toBe(6);
    expect(p.rng).toBe(ctx.combatRng);
    expect([p.tags, p.flags, p.aggregate, p.rollsAilments, p.canCrit, p.chains]).toEqual([
      ORBIT_TAGS,
      0,
      false,
      true,
      true,
      false,
    ]);
  });

  it('is one emitter per source and ring, the first grant of it, ring 0 when it names none', () => {
    const ctx = fixture([], {
      grants: [
        on('outer.aura', orbit(2)),
        on('outer.aura', orbit(5, { ring: 0 })),
        on('outer.aura', orbit(3, { ring: 1 })),
        on('hub', orbit(1)),
        on('outer.aura', orbit(6, { ring: 1, cooldownSec: 1 })),
      ],
    });
    expect(
      ctx.emitters.map((em) => [em.spec.kind, em.spec.source, em.orbs?.n ?? null, em.interval]),
    ).toEqual([
      ['volley', 'center', null, ctx.emitters[0]?.interval],
      ['orbit', 'outer.aura', 2, 30],
      ['orbit', 'outer.aura', 3, 30],
      ['orbit', 'hub', 1, 30],
    ]);
  });

  it('adds no member to the enemy: addEnemy’s literal keeps its 58, none for an orbit', () => {
    const ctx = fixture([at(RING_0, 0)]);
    const keys = Object.keys(enemy(ctx, 1));
    expect(keys).toHaveLength(58);
    expect(keys.filter((key) => /orb/i.test(key))).toEqual([]);
  });
});

describe('orbit: its orbs', () => {
  it('places orb o of n at 2π × (revPerSec × now / 60 + o / n) on its ring, 110 from the player or 180 (雙軌)', () => {
    // On tick 15 the ring has turned a quarter: 4 orbs sit at π/2, π, 3π/2 and 2π, and hit in
    // orb order.
    const square = [at(RING_0, 0), at(0, -RING_0), at(-RING_0, 0), at(0, RING_0)].map((p) => ({
      ...p,
      type: 'shard' as const,
    }));
    const ctx = fixture(square, { grants: [on('outer.aura', orbit(4))] });
    orbitAt(ctx, 15);
    expect(hitIds(ctx)).toEqual([4, 3, 2, 1]);
    // One orb on tick 15, at (0, 110) on ring 0 and at (0, 180) on ring 1: it touches the
    // shards within 12 + 10 of it.
    const line = [110, 180, 131.9, 87.5, 158.1].map((dy) => at(0, dy, { type: 'shard' }));
    const ringHits = (ring: number): number[] => {
      const c = fixture(line, { grants: [on('outer.aura', orbit(1, { ring }))] });
      orbitAt(c, 15);
      return hitIds(c);
    };
    expect([RING_0, RING_1]).toEqual([110, 180]);
    expect(ringHits(0)).toEqual([1, 3]);
    expect(ringHits(1)).toEqual([2, 5]);
  });

  it('touches an enemy whose edge just meets the orb’s: distance ≤ orbRadius + its radius (§4.13)', () => {
    // On tick 15 the one orb of ring 0 sits exactly 110 below the player (cos(π/2) × 110 is far
    // below half an ulp of x), so a shard of radius 10 placed 22 beside that point meets it edge
    // to edge, a hexagon of radius 34 placed 46 beside it too (found by the tough pass), and one
    // more shard a hair farther below it does not.
    const placed = [
      at(22, RING_0, { type: 'shard' }),
      at(-46, RING_0, { type: 'hexagon' }),
      at(0, RING_0 + 22.000001, { type: 'shard' }),
    ];
    const ctx = fixture(placed);
    const orb = orbAt(ctx, 15, 0, 1, RING_0);
    const [shard, hexagon] = [enemy(ctx, 1), enemy(ctx, 2)];
    expect([shard.x - orb.x, shard.y - orb.y, shard.radius + ORB_RADIUS]).toEqual([22, 0, 22]);
    expect([orb.x - hexagon.x, hexagon.y - orb.y, hexagon.radius + ORB_RADIUS]).toEqual([
      46, 0, 46,
    ]);
    expect(hexagon.tough && hexagon.radius > ctx.shotPad).toBe(true);
    orbitAt(ctx, 15);
    expect(hitIds(ctx)).toEqual([1, 2]);
  });

  it('finds what each orb touches as a brute force does: its query padded by the shot pad, and the tough pass', () => {
    // A cooldown of one tick: every orb hits every enemy it touches on every tick.
    for (const count of [60, 200]) {
      const rng = createRng(count);
      const placed = Array.from({ length: count }, () => {
        const a = rng.range(0, 2 * Math.PI);
        const d = rng.range(0, 320);
        return at(d * Math.cos(a), d * Math.sin(a), { type: rng.pick(TYPES) });
      });
      const ctx = fixture(placed, {
        grants: [
          on('outer.aura', orbit(5, { cooldownSec: 1 / 60 })),
          on('outer.aura', orbit(3, { ring: 1, cooldownSec: 1 / 60, orbRadius: 30 })),
        ],
      });
      for (let id = 5; id <= count; id += 17) enemy(ctx, id).alive = false;
      rebuildGrid(ctx);
      const tough = ctx.enemies.filter((e) => e.tough && e.alive && e.radius > ctx.shotPad);
      expect(tough.length).toBeGreaterThan(5);
      let touched = 0;
      for (let tick = 1; tick <= 60; tick++) {
        for (const [i, n, ring, orbRadius] of [
          [1, 5, RING_0, ORB_RADIUS],
          [2, 3, RING_1, 30],
        ] as const) {
          orbitAt(ctx, tick, i);
          const expected: number[] = [];
          for (let o = 0; o < n; o++) {
            const orb = orbAt(ctx, tick, o, n, ring);
            for (const e of ctx.enemies)
              if (e.alive && touches(e, orb, orbRadius)) expected.push(e.id);
          }
          expect(hitIds(ctx), `${count} enemies, emitter ${i}, tick ${tick}`).toEqual(expected);
          touched += expected.length;
        }
      }
      expect(touched).toBeGreaterThan(200);
      // 60 enemies are scanned, 200 sorted into the grid's cells.
      expect(ctx.grid.sortCount > 0, `${count} enemies`).toBe(count >= 128);
    }
  });
});

describe('orbit: its cooldowns (Q13 (B))', () => {
  it('keeps each orb’s apart: an enemy parked on the ring takes a hit from each of 4 orbs a second (a shared cooldown gave 2)', () => {
    // A shard on ring 0 at π/4, where orb o passes on the ticks 7.5 − 15o + 60k, touching it
    // from 1.5 ticks before: orb 0 hits it on tick 6, orb 1 on 21, orb 2 on 36, orb 3 on 51, then
    // orb 0 again on 66, its cooldown long over. One cooldown for all four would end on tick 36
    // and let every other orb hit: 2 a second.
    const a = Math.PI / 4;
    const ctx = fixture([at(RING_0 * Math.cos(a), RING_0 * Math.sin(a), { type: 'shard' })], {
      grants: [on('outer.aura', orbit(4))],
    });
    const seen = hitsOver(ctx, 1, 600);
    expect(seen.map(([tick]) => tick)).toEqual(Array.from({ length: 40 }, (_, k) => 6 + 15 * k));
    for (let s = 0; s < 10; s++) {
      expect(seen.filter(([tick]) => tick > 60 * s && tick <= 60 * (s + 1))).toHaveLength(4);
    }
  });

  it('hits once a contact: a tough enemy of radius 40, in contact for 9 ticks a pass, takes one hit a pass', () => {
    // On ring 0 at π, where the one orb passes on the ticks 30 + 60k.
    const ctx = fixture([at(-RING_0, 0, { type: 'hexagon', radius: 40 })]);
    const e = enemy(ctx, 1);
    expect(e.tough).toBe(true);
    expect(e.radius).toBeGreaterThan(ctx.shotPad);
    const contact: number[] = [];
    for (let tick = 1; tick <= 120; tick++) {
      if (touches(e, orbAt(ctx, tick, 0, 1, RING_0), ORB_RADIUS)) contact.push(tick);
    }
    expect(contact).toEqual([
      26, 27, 28, 29, 30, 31, 32, 33, 34, 86, 87, 88, 89, 90, 91, 92, 93, 94,
    ]);
    // On tick 26 its centre is beyond the orb's padded query: the tough pass finds it.
    const orb = orbAt(ctx, 26, 0, 1, RING_0);
    expect(Math.hypot(e.x - orb.x, e.y - orb.y)).toBeGreaterThan(ORB_RADIUS + ctx.shotPad);
    expect(hitsOver(ctx, 1, 600).map(([tick]) => tick)).toEqual([
      26, 86, 146, 206, 266, 326, 386, 446, 506, 566,
    ]);
  });

  it('hits an enemy in contact again on the tick its cooldown ends', () => {
    // A hexagon of radius 130 on the player: every orb of ring 0 touches it all the time.
    const hitTicks = (cooldownSec: number, n = 1): number[] => {
      const ctx = fixture([at(0, 0, { type: 'hexagon', radius: 130 })], {
        grants: [on('outer.aura', orbit(n, { cooldownSec }))],
      });
      return hitsOver(ctx, 1, 60).map(([tick]) => tick);
    };
    expect(hitTicks(0.5)).toEqual([1, 31]);
    expect(hitTicks(0.1)).toEqual([1, 7, 13, 19, 25, 31, 37, 43, 49, 55]);
    expect(hitTicks(1)).toEqual([1]);
    expect(hitTicks(0.5, 3)).toEqual([1, 1, 1, 31, 31, 31]);
  });

  it('passes over an enemy an earlier orb killed this tick, and keeps that orb’s entry until it ends', () => {
    // A hexagon of 5 hp on the player, which both orbs touch: orb 0's hit of 6 kills it.
    const ctx = fixture([at(0, 0, { type: 'hexagon', radius: 130, hp: 5 })], {
      grants: [on('outer.aura', orbit(2))],
    });
    orbitAt(ctx, 1);
    expect(hitIds(ctx)).toEqual([1]);
    expect(enemy(ctx, 1).alive).toBe(false);
    const m = memoryOf(ctx);
    expect([remembered(m, 0), remembered(m, 1)]).toEqual([[1], []]);
    orbitAt(ctx, 30);
    expect(remembered(m, 0)).toEqual([1]);
    orbitAt(ctx, 31);
    expect([...m.count]).toEqual([0, 0]);
  });
});

describe('orbit: its memory (Q13/F1)', () => {
  it('forgets the oldest enemy when an orb remembers ORB_MEMORY, counts each in orbMemoryFull, and agrees with the reference that drops the oldest', () => {
    // 70 shards on ring 0 where its one orb passes on ticks 2 to 28: each is in contact for 3
    // ticks, so all 70 are hit before the first one's cooldown of 30 ticks ends.
    const placed = Array.from({ length: 70 }, (_, j) => {
      const a = (2 * Math.PI * (2 + (26 * j) / 69)) / TICK_RATE;
      return at(RING_0 * Math.cos(a), RING_0 * Math.sin(a), { type: 'shard' });
    });
    const ctx = fixture(placed);
    const m = memoryOf(ctx);
    const ref = new OrbitRef(1, RING_0, 30, ORB_RADIUS, ORB_MEMORY);
    const order: number[] = [];
    let total = 0;
    for (let tick = 1; tick <= 600; tick++) {
      const expected = ref.step(ctx, tick).map(([, , id]) => id);
      orbitAt(ctx, tick);
      expect(hitIds(ctx), `tick ${tick}`).toEqual(expected);
      expect(ctx.counters.orbMemoryFull, `tick ${tick}`).toBe(ref.dropped);
      total += expected.length;
      if (tick > 30) continue;
      // Nothing has ended yet: the orb remembers the last 64 it hit, oldest first, and each
      // one past 64 forgot the oldest.
      order.push(...hitIds(ctx));
      expect(remembered(m, 0), `tick ${tick}`).toEqual(order.slice(-ORB_MEMORY));
      expect(ctx.counters.orbMemoryFull).toBe(Math.max(0, order.length - ORB_MEMORY));
    }
    expect(order).toEqual(Array.from({ length: 70 }, (_, k) => k + 1));
    // Ten passes, each hitting the 70 and dropping 6.
    expect([total, ctx.counters.orbMemoryFull]).toEqual([700, 60]);
  });

  it('allocates its memory once: em.orbs and its four arrays are the same objects after 600 ticks', () => {
    const moving = movers(7, 40, RING_0);
    const ctx = fixture(
      moving.map((m) => at(m.dist, 0, { type: m.type })),
      { grants: [on('outer.aura', orbit(8)), on('outer.aura', orbit(4, { ring: 1 }))] },
    );
    const before = [1, 2].map((i) => {
      const em = emitter(ctx, i);
      const m = em.orbs as OrbMemory;
      return [em.orbs, m.ids, m.until, m.head, m.count, em.targets];
    });
    let count = 0;
    for (let tick = 1; tick <= 600; tick++) {
      move(ctx, moving, tick);
      for (const i of [1, 2]) {
        orbitAt(ctx, tick, i);
        count += hits(ctx).length;
      }
    }
    expect(count).toBeGreaterThan(100);
    [1, 2].forEach((i, k) => {
      const em = emitter(ctx, i);
      const m = em.orbs as OrbMemory;
      const after = [em.orbs, m.ids, m.until, m.head, m.count, em.targets];
      after.forEach((object, j) =>
        expect(object, `emitter ${i}, member ${j}`).toBe(before[k]?.[j]),
      );
    });
  });
});

describe('orbit: the reference (Q13 (B))', () => {
  const cases = [1, 3, 8].flatMap((n) =>
    [0, 1].flatMap((ring) => [0.1, 0.5, 1].map((cooldownSec) => [n, ring, cooldownSec] as const)),
  );

  it.each(cases)(
    '%i orbs on ring %i, cooldown %s s: the hits (tick, orb, id) and the combat stream equal the reference’s over 600 ticks of moving enemies',
    (n, ring, cooldownSec) => {
      const radius = ORBIT_DEFAULTS.ringRadius[ring] as number;
      const moving = movers(1000 + 100 * n + 10 * ring + 10 * cooldownSec, 40, radius);
      // Half the cases also stand 100 squares far away, so the grid sorts its cells.
      const decoys = cooldownSec === 0.5 ? DECOYS : [];
      const placed = [...moving.map((m) => at(m.dist, 0, { type: m.type })), ...decoys];
      const grants = [on('outer.aura', orbit(n, { ring, cooldownSec }))];
      const ctx = fixture(placed, { values: HALF, grants });
      const twin = fixture(placed, { values: HALF, grants });
      expect(ctx.rollsDots).toBe(true);
      const cd = Math.round(cooldownSec * TICK_RATE);
      expect(emitter(ctx).interval).toBe(cd);
      const ref = new OrbitRef(n, radius, cd);
      const expected: [number, number, number][] = [];
      const actual: [number, number, number][] = [];
      const crits: boolean[] = [];
      for (let tick = 1; tick <= 600; tick++) {
        // Two of them die half way.
        if (tick === 300) for (const id of [3, 7]) enemy(ctx, id).alive = false;
        move(ctx, moving, tick);
        expected.push(...ref.step(ctx, tick));
        orbitAt(ctx, tick);
        const events = hits(ctx);
        // The entries written on this tick give each hit's orb, in hit order.
        const entries = written(memoryOf(ctx), tick + cd);
        expect(
          entries.map(([, id]) => id),
          `tick ${tick}`,
        ).toEqual(events.map((hit) => hit.targetId));
        for (const [o, id] of entries) actual.push([tick, o, id]);
        for (const hit of events) crits.push(hit.crit);
      }
      expect(actual).toEqual(expected);
      expect(expected.length).toBeGreaterThan(30);
      expect(new Set(expected.map(([, o]) => o)).size).toBe(n);
      expect(ctx.counters.orbMemoryFull).toBe(0);
      // Each hit draws its crit, ignite and poison rolls on the combat stream, in hit order.
      const rolls = expected.map(() => {
        const crit = twin.combatRng.chance(0.5);
        twin.combatRng.chance(0.5);
        twin.combatRng.chance(0.5);
        return crit;
      });
      expect(crits).toEqual(rolls);
      expect(new Set(rolls)).toEqual(new Set([true, false]));
      expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    },
  );
});

describe('orbit: its hits', () => {
  it('hits for damagePct of the damage stat, tagged hit and orbit, at depth 0 from origin −1, as no attack, and draws nothing without rolls', () => {
    const { seen, module } = recorder();
    const ctx = fixture([at(0, 0, { type: 'hexagon', radius: 130 }), at(RING_0, 0)], {
      grants: [on('outer.aura', orbit(1, { damagePct: 0.8 }))],
      modules: [module],
    });
    const source = ctx.sources.index('outer.aura');
    const serial = ctx.attackSerial;
    const budget = ctx.chainBudget.hits;
    const before = rngPositions(ctx);
    orbitAt(ctx, 1);
    expect(ctx.events.map((event) => event.type)).toEqual(['hit', 'hit']);
    expect(
      hits(ctx).map((hit) => [
        hit.targetId,
        hit.tags,
        hit.source,
        hit.crit,
        hit.chainIndex,
        hit.fromX,
        hit.fromY,
        toNumber(hit.amount),
      ]),
    ).toEqual([
      [1, ORBIT_TAGS, source, false, 0, null, null, 8],
      [2, ORBIT_TAGS, source, false, 0, null, null, 8],
    ]);
    const bits = SIGNATURE | PRIMARY | REPEAT | CHAIN_JUMP;
    expect(
      seen.map(([id, mask, src, flags, depth, origin]) => [
        id,
        mask,
        src,
        (flags as number) & bits,
        depth,
        origin,
      ]),
    ).toEqual([
      [1, ORBIT_TAGS, source, 0, 0, -1],
      [2, ORBIT_TAGS, source, 0, 0, -1],
    ]);
    expect([ctx.attackSerial, ctx.chainBudget.hits]).toEqual([serial, budget]);
    // Its places draw nothing, nor do hits without rolls.
    hitsOver(ctx, 2, 120);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('rolls crits and ailments on the combat stream, hit by hit in orb order, and draws on no other stream', () => {
    // The four orbs' places on tick 15, hit in orb order: 4, 3, 2, 1.
    const placed = [at(RING_0, 0), at(0, -RING_0), at(-RING_0, 0), at(0, RING_0)].map((p) => ({
      ...p,
      type: 'shard' as const,
    }));
    const grants = [on('outer.aura', orbit(4))];
    const ctx = fixture(placed, { values: HALF, grants });
    const twin = fixture(placed, { values: HALF, grants });
    const before = rngPositions(ctx);
    orbitAt(ctx, 15);
    expect(hitIds(ctx)).toEqual([4, 3, 2, 1]);
    const rolls = [4, 3, 2, 1].map(() => [0, 1, 2].map(() => twin.combatRng.chance(0.5)));
    expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    expect({ ...rngPositions(ctx), combat: before.combat }).toEqual(before);
    hits(ctx).forEach((hit, k) => {
      const [crit, ignite, poison] = rolls[k] as boolean[];
      const e = enemy(ctx, hit.targetId);
      expect(hit.crit, `enemy ${e.id}`).toBe(crit);
      expect(toNumber(hit.amount)).toBe(crit ? 12 : 6);
      expect([e.burnStacks, e.poisonStacks]).toEqual([ignite ? 1 : 0, poison ? 1 : 0]);
    });
  });
});

describe('orbit: the emitter stage', () => {
  it('is stepped by the emitter stage and hits the enemies that come to the player in a run', () => {
    expect(EMITTER_STEPS.orbit).toBe(runOrbit);
    const stats = makeStats({ damage: 0.01, maxLife: 1e12, critChance: 0 }, [], {
      triggers: [],
      conversions: [],
      emitters: [on('outer.aura', orbit(3))],
    });
    const sim = createSimulation(makeConfig({ stats, maxTicks: 600 }), makeTestData());
    const source = sim.state.sources.indexOf('outer.aura');
    const tags = new Set<number>();
    let count = 0;
    while (!sim.state.finished) {
      for (const event of sim.step(NO_INPUT)) {
        if (event.type !== 'hit' || event.source !== source) continue;
        tags.add(event.tags);
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(tags).toEqual(new Set([ORBIT_TAGS]));
  });
});

describe('orbit: its speed (環繞球轉速, the orbitSpeed stat; E15, lead ruling 17)', () => {
  /** Two orbits on outer.aura (ring 0 of 2, ring 1 of 1 with cooldown 0.25) and one on hub. */
  const SPEED_GRANTS: readonly SourcedEmitter[] = [
    on('outer.aura', { kind: 'aura' }),
    on('outer.aura', orbit(2)),
    on('outer.aura', orbit(1, { ring: 1, cooldownSec: 0.25 })),
    on('hub', orbit(3, { damagePct: 0.4, orbRadius: 20 })),
  ];
  /** The emitters a build of these values compiles with SPEED_GRANTS and orbitCount 1.5. */
  const compiled = (
    values: Partial<Record<StatId, number>> = {},
    modules: readonly TestModule[] = [],
  ): EmitterSpec[] => [
    ...compileBuild(
      makeStats({ orbitCount: 1.5, ...values }, [], {
        triggers: [],
        conversions: [],
        emitters: SPEED_GRANTS,
      }),
      [],
      undefined,
      modules,
    ).emitters,
  ];
  const revs = (emitters: readonly EmitterSpec[]): number[] =>
    emitters.flatMap((em) => (em.kind === 'orbit' ? [em.revPerSec] : []));
  /** Four shards at the quarter points of ring 0. */
  const QUARTERS = [at(RING_0, 0), at(0, -RING_0), at(-RING_0, 0), at(0, RING_0)].map((p) => ({
    ...p,
    type: 'shard' as const,
  }));

  /**
   * SPEED_GRANTS' emitters as b60fc31 (E14, before orbitSpeed) compiled them, recorded by running
   * that tree's compileBuild on the same build (S/b4/e15b-bench/scripts/baseEmitters.mts).
   */
  const PARENT_EMITTERS = [
    {
      kind: 'volley',
      signature: true,
      source: 'center',
      damagePct: 1,
      tags: 17,
      chains: true,
      rollsAilments: true,
      canCrit: true,
    },
    {
      kind: 'aura',
      signature: false,
      source: 'outer.aura',
      damagePct: 0.25,
      tags: 129,
      chains: false,
      rollsAilments: true,
      canCrit: true,
      everyNth: null,
      corona: null,
    },
    {
      kind: 'orbit',
      signature: false,
      source: 'outer.aura',
      damagePct: 0.6,
      tags: 257,
      chains: false,
      rollsAilments: true,
      canCrit: true,
      ring: 0,
      radius: 110,
      count: 2,
      revPerSec: 1,
      cooldownSec: 0.5,
      orbRadius: 12,
    },
    {
      kind: 'orbit',
      signature: false,
      source: 'outer.aura',
      damagePct: 0.6,
      tags: 257,
      chains: false,
      rollsAilments: true,
      canCrit: true,
      ring: 1,
      radius: 180,
      count: 1,
      revPerSec: 1,
      cooldownSec: 0.25,
      orbRadius: 12,
    },
    {
      kind: 'orbit',
      signature: false,
      source: 'hub',
      damagePct: 0.4,
      tags: 257,
      chains: false,
      rollsAilments: true,
      canCrit: true,
      ring: 0,
      radius: 110,
      count: 3,
      revPerSec: 1,
      cooldownSec: 0.5,
      orbRadius: 20,
    },
  ];

  it('compiles a build at the base orbitSpeed exactly as before it: every emitter toEqual the parent’s own compile', () => {
    // Planted bug: the base folded to anything but ORBIT_DEFAULTS.revPerSec × 1.
    expect(BASE_STATS.orbitSpeed).toBe(1);
    expect(compiled()).toEqual(PARENT_EMITTERS);
    expect(compiled({ orbitSpeed: 1 })).toEqual(PARENT_EMITTERS);
    expect(revs(compiled())).toEqual([1, 1, 1]);
  });

  it('sets every orbit emitter’s revPerSec to ORBIT_DEFAULTS.revPerSec × orbitSpeed: 1.5 at 1.5, all else as at the base', () => {
    // Planted bug: the stat not folded at all, or folded into one emitter or one source only.
    const base = compiled();
    const fast = compiled({ orbitSpeed: 1.5 });
    expect(revs(fast)).toEqual([1.5, 1.5, 1.5]);
    expect(fast).toEqual(base.map((em) => (em.kind === 'orbit' ? { ...em, revPerSec: 1.5 } : em)));
    expect(revs(compiled({ orbitSpeed: 1.25 }))).toEqual([1.25, 1.25, 1.25]);
  });

  it('turns the orbs at 2π × (1.5 × now / 60 + o / n) at orbitSpeed 1.5: a quarter turn by tick 10, and hits as the reference turning 1.5 times a second', () => {
    // On tick 10 a ring at 1.5 turns a second has turned a quarter (at 1, by tick 15): its 4
    // orbs sit at π/2, π, 3π/2 and 2π and hit in orb order; at 1 they sit 30° short, out of
    // reach.
    const grants = [on('outer.aura', orbit(4))];
    const fast = fixture(QUARTERS, { grants, values: { orbitSpeed: 1.5 } });
    orbitAt(fast, 10);
    expect(hitIds(fast)).toEqual([4, 3, 2, 1]);
    const base = fixture(QUARTERS, { grants });
    orbitAt(base, 10);
    expect(hitIds(base)).toEqual([]);
    // Moving enemies over 600 ticks: every hit (tick, orb, id) is the reference's at 1.5 turns
    // a second, and not the one at 1.
    const n = 3;
    const moving = movers(4242, 40, RING_0);
    const placed = moving.map((m) => at(m.dist, 0, { type: m.type }));
    const ctx = fixture(placed, {
      grants: [on('outer.aura', orbit(n))],
      values: { orbitSpeed: 1.5 },
    });
    const twin = fixture(placed, { grants: [on('outer.aura', orbit(n))] });
    const ref = new OrbitRef(n, RING_0, 30, ORB_RADIUS, Infinity, 1.5);
    const slow = new OrbitRef(n, RING_0, 30, ORB_RADIUS, Infinity, 1);
    const expected: [number, number, number][] = [];
    const atOne: [number, number, number][] = [];
    const actual: [number, number, number][] = [];
    for (let tick = 1; tick <= 600; tick++) {
      move(ctx, moving, tick);
      move(twin, moving, tick);
      expected.push(...ref.step(ctx, tick));
      atOne.push(...slow.step(twin, tick));
      orbitAt(ctx, tick);
      for (const [o, id] of written(memoryOf(ctx), tick + 30)) actual.push([tick, o, id]);
    }
    expect(actual).toEqual(expected);
    expect(expected.length).toBeGreaterThan(30);
    expect(atOne).not.toEqual(expected);
  });

  it.each([
    [3, 2],
    [2.5, 2],
    [2, 2],
    [1.75, 1.75],
    [Infinity, 2],
  ])(
    'clamps revPerSec at ORBIT_MAX_REV_PER_SEC: orbitSpeed %s turns the rings %s times a second',
    (speed, rev) => {
      // Planted bug: no clamp, or a clamp anywhere but 2.
      expect(ORBIT_MAX_REV_PER_SEC).toBe(2);
      expect(revs(compiled({ orbitSpeed: speed }))).toEqual([rev, rev, rev]);
      expect(orbitRevPerSec(speed)).toBe(rev);
    },
  );

  it('turns the orbs at 2 a second at orbitSpeed 3: on tick 8 they reach the shards at the quarters, which at 3 they would have passed', () => {
    const grants = [on('outer.aura', orbit(4))];
    const capped = fixture(QUARTERS, { grants, values: { orbitSpeed: 3 } });
    expect(emitter(capped).spec).toMatchObject({ revPerSec: 2 });
    // At 2 a second the ring has turned 0.2667 of a turn on tick 8, 6° past the quarter; at 3
    // it would have turned 0.4, 36° past it and out of reach.
    orbitAt(capped, 8);
    expect(hitIds(capped)).toEqual([4, 3, 2, 1]);
  });

  it.each([0, -1, -0.5, NaN])(
    'stands the rings still at orbitSpeed %s: revPerSec 0, an orb at angle 0 hits a shard there once each cooldown',
    (speed) => {
      // Planted bug: a clamp below 0 missing (a ring turning backwards) or wrong.
      expect(revs(compiled({ orbitSpeed: speed }))).toEqual([0, 0, 0]);
      expect(orbitRevPerSec(speed)).toBe(0);
      const ctx = fixture([at(RING_0, 0, { type: 'shard' })], { values: { orbitSpeed: speed } });
      expect(hitsOver(ctx, 1, 61)).toEqual([
        [1, 1],
        [31, 1],
        [61, 1],
      ]);
    },
  );

  it('orbitRevPerSec: 1 gives ORBIT_DEFAULTS.revPerSec exactly, and the speed scales it linearly up to the cap', () => {
    expect(ORBIT_DEFAULTS.revPerSec).toBe(1);
    expect(orbitRevPerSec(1)).toBe(ORBIT_DEFAULTS.revPerSec);
    expect([0.15, 0.5, 1.3, 1.45, 1.999].map(orbitRevPerSec)).toEqual([
      0.15, 0.5, 1.3, 1.45, 1.999,
    ]);
    expect([Number.MIN_VALUE, 2 + 1e-12, 1e300].map(orbitRevPerSec)).toEqual([
      Number.MIN_VALUE,
      2,
      2,
    ]);
  });

  it('reads the stat once a compile, after every module: a module’s offsetStat and scaleStat reach it, and a change to values afterwards turns nothing', () => {
    // Planted bug: the stat read before the modules, or each tick from the run's values.
    const offset: TestModule = (b) => b.offsetStat('orbitSpeed', 0.5);
    const scale: TestModule = (b) => b.scaleStat('orbitSpeed', 3);
    expect(revs(compiled({}, [offset]))).toEqual([1.5, 1.5, 1.5]);
    expect(revs(compiled({ orbitSpeed: 0.5 }, [scale]))).toEqual([1.5, 1.5, 1.5]);
    expect(revs(compiled({}, [scale]))).toEqual([2, 2, 2]);
    // The run's orbs turn at what the compile set, whatever the values say later.
    const grants = [on('outer.aura', orbit(4))];
    const ctx = fixture(QUARTERS, { grants, values: { orbitSpeed: 1.5 } });
    (ctx.build.values as Record<StatId, number>).orbitSpeed = 1;
    orbitAt(ctx, 10);
    expect(hitIds(ctx)).toEqual([4, 3, 2, 1]);
    const still = fixture(QUARTERS, { grants });
    (still.build.values as Record<StatId, number>).orbitSpeed = 1.5;
    orbitAt(still, 10);
    expect(hitIds(still)).toEqual([]);
  });

  it('turns a module’s own addEmitter orbit at the run’s orbitSpeed, under the same clamp (D2)', () => {
    // Planted bug: a module's orbit grant left at ORBIT_DEFAULTS.revPerSec, or given the
    // unclamped speed while the build's own grants are clamped.
    const grant: TestModule = (b) => b.addEmitter('outer.thorns', orbit(1, { ring: 1 }));
    const moduleRevs = (speed: number): number[] =>
      compiled({ orbitSpeed: speed }, [grant]).flatMap((em) =>
        em.kind === 'orbit' && em.source === 'outer.thorns' ? [em.revPerSec] : [],
      );
    expect([1, 1.5, 3, -1, Number.NaN].map(moduleRevs)).toEqual([[1], [1.5], [2], [0], [0]]);
    expect(revs(compiled({ orbitSpeed: 3 }, [grant]))).toEqual([2, 2, 2, 2]);
  });

  it('leaves the cooldown alone: an orb’s interval is round(cooldownSec × 60) at any orbitSpeed', () => {
    for (const speed of [0, 1, 1.5, 3]) {
      const ctx = fixture([], {
        values: { orbitSpeed: speed },
        grants: [
          on('outer.aura', orbit(1)),
          on('outer.aura', orbit(1, { ring: 1, cooldownSec: 0.25 })),
        ],
      });
      expect([emitter(ctx, 1).interval, emitter(ctx, 2).interval], `orbitSpeed ${speed}`).toEqual([
        30, 15,
      ]);
    }
    expect(ORBIT_DEFAULTS.cooldownSec).toBe(0.5);
  });

  it('keeps ORB_MEMORY enough at the clamp: in the grants crowd an orb remembers at most 25–27 enemies at 1 turn a second and 39–41 at 2, below 64, and none is forgotten', () => {
    // The bench's grants scenario (tools/balance/bench.ts): the stress crowd around an aura and
    // two rings of 4 orbs, for its 30 s; orbitSpeed 4 is held at 2 turns a second.
    expect([ORB_MEMORY, ORBIT_MAX_REV_PER_SEC]).toEqual([64, 2]);
    const grants: readonly SourcedEmitter[] = [
      on('outer.aura', { kind: 'aura', everyNth: { n: 4, mult: 4 } }),
      on('outer.aura', orbit(4)),
      on('outer.aura', orbit(4, { ring: 1 })),
      on('outer.thorns', { kind: 'thorns' }),
    ];
    const peakOf = (speed: number, seed: number): [number[], number, number] => {
      let peak = 0;
      let rev: number[] = [];
      const watch: TestModule = (b) =>
        b.hook('tick', (ctx) => {
          rev = revs(ctx.emitters.map((em) => em.spec));
          for (const em of ctx.emitters) {
            if (em.orbs === null) continue;
            for (let o = 0; o < em.orbs.n; o++) peak = Math.max(peak, em.orbs.count[o] as number);
          }
        });
      const stats = stressStats(
        { auraRadius: 160, orbitSpeed: speed },
        { triggers: [], conversions: [], emitters: grants },
      );
      const sim = createSimulation(
        makeConfig({ stats, seed, startWave: STRESS_START_WAVE, maxTicks: 30 * TICK_RATE }),
        stressData(),
        [watch],
      );
      while (!sim.state.finished) sim.step(NO_INPUT);
      return [rev, peak, sim.result().counters.orbMemoryFull];
    };
    expect([1, 2].map((seed) => peakOf(1, seed))).toEqual([
      [[1, 1], 25, 0],
      [[1, 1], 27, 0],
    ]);
    expect([1, 2].map((seed) => peakOf(4, seed))).toEqual([
      [[2, 2], 39, 0],
      [[2, 2], 41, 0],
    ]);
  });
});
