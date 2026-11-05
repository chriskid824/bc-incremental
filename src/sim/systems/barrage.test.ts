/**
 * The barrage rider (E10a, src/sim/systems/barrage.ts; lead rulings W1–W10, W15): its compile
 * (compileBarrage, BuildFlags.barrage), when it fires (after each counted attack of the
 * signature, from that attack's origin), its picks and straight shots (an impact's passing
 * through its target), its hits on the barrage stream, SMALL_SHOT_CAP's reserve and what a
 * build without it pays. Most tests run an emitter, the drone stage or fireBarrage itself on
 * placed enemies, then the projectile stage a tick at a time; the determinism tests run whole
 * simulations.
 */

import { describe, expect, it } from 'vitest';
import { toNumber, ZERO } from '../../core/num';
import { createStreams } from '../../core/rng';
import { BARRAGE_DAMAGE_PCT } from '../../data/emitters';
import type { SourcedEmitter } from '../../data/emitters';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { Modifier, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import { compileBuild } from '../build/compile';
import type { CompiledBarrage } from '../build/compile';
import { PROJECTILE_CAP, SHOT_MEMORY, SMALL_PROJECTILE_TICKS, SMALL_SHOT_CAP } from '../caps';
import { runEffect } from '../effects/execute';
import { HIT_EVENT, PRIMARY, REPEAT, SIGNATURE } from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import { runArc } from '../emitters/arc';
import { runFan } from '../emitters/fan';
import { runLob } from '../emitters/lob';
import type { BarrageRider, EmitterRuntime } from '../emitters/types';
import { runVolley } from '../emitters/volley';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  createRunHash,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DRONE_KIND_SPIRIT, NO_INPUT, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import { fireBarrage } from './barrage';
import type { Enemy, RunContext } from './context';
import { impactAt, stepDrones } from './drones';
import { rebuildGrid } from './grid';
import { moveProjectiles } from './projectiles';
import { liveProjectiles, MOTION_HOMING, MOTION_LOB, MOTION_STRAIGHT, spawnShot } from './shots';

/** The player's position. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** An enemy (dx, dy) from the player. */
const at = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...extra,
});
/** A small shot's move per tick at the base projectileSpeed. */
const STEP = 1400 / TICK_RATE;

const VOLLEY: SignatureSpec = { id: 'm1Volley' };
const FAN: SignatureSpec = { id: 'iceFan' };
const LOB: SignatureSpec = { id: 'magmaBomb' };
const ARC: SignatureSpec = { id: 'triphaseArc' };
const SWARM: SignatureSpec = { id: 'swarm' };

/** The 副彈 grant on outer.barrage, at its default share. */
const GRANT: SourcedEmitter = { source: 'outer.barrage', grant: { kind: 'barrage' } };
/** A small hit's tags. */
const SMALL_TAGS = TAG.hit | TAG.projectile;

/** A test module writing ★子彈地獄's params. */
const params =
  (countMult: number, bounce: number): TestModule =>
  (b) => {
    b.flags.barrage.countMult = countMult;
    b.flags.barrage.bounce = bounce;
  };

/** A test module writing the swarm's counts. */
const swarmCounts =
  (drones: number, turrets: number): TestModule =>
  (b) => {
    const swarm = b.signature().swarm;
    if (swarm !== null) Object.assign(swarm, { drones, turrets });
  };

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly scoped?: readonly Modifier[];
  readonly triggers?: readonly TriggerSpec[];
  /** The build's grants; [GRANT] by default. */
  readonly grants?: readonly SourcedEmitter[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
  readonly signature?: SignatureSpec;
  readonly seed?: number;
}

/** The stats of a test build: damage 10, no crit, ignite or chain, barrageCount 2 by default. */
const statsOf = (options: Options) =>
  makeStats(
    {
      damage: 10,
      critChance: 0,
      igniteChance: 0,
      chainCount: 0,
      barrageCount: 2,
      ...options.values,
    },
    options.scoped ?? [],
    {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: options.grants ?? [GRANT],
    },
  );

/** placedEnemies with a test build (statsOf), M1's volley unless `signature` says otherwise. */
const arena = (placed: readonly PlacedEnemy[], options: Options = {}): RunContext =>
  placedEnemies(placed, {
    stats: statsOf(options),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
    signature: options.signature ?? VOLLEY,
    seed: options.seed ?? 1,
  });

/** The compiled build of a test build. */
const compiled = (options: Options = {}) =>
  compileBuild(
    statsOf(options),
    options.rules ?? [],
    options.signature ?? VOLLEY,
    options.modules ?? [],
  );

const sig = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;
const riderOf = (ctx: RunContext): BarrageRider => sig(ctx).barrage as BarrageRider;
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** The slots of the rider's shots in flight, in id order. */
function riderSlots(ctx: RunContext): number[] {
  const p = sig(ctx).barrage?.payload ?? null;
  const slots: number[] = [];
  for (let s = 0; s < ctx.shots.count; s++)
    if (p !== null && ctx.shots.payload[s] === p) slots.push(s);
  return slots;
}

/** What the rider's shot in slot `s` is as spawned: its id, origin, launch and life, motion. */
const shotOf = (ctx: RunContext, s: number) => ({
  id: ctx.shots.id[s] as number,
  x: ctx.shots.x[s] as number,
  y: ctx.shots.y[s] as number,
  launched: ctx.shots.launched[s] as number,
  until: ctx.shots.until[s] as number,
  motion: ctx.shots.motion[s] as number,
  pierce: ctx.shots.pierce[s] as number,
  bounce: ctx.shots.bounce[s] as number,
  owner: ctx.shots.owner[s] as number,
  depth: ctx.shots.depth[s] as number,
  origin: ctx.shots.origin[s] as number,
});

/** The direction of the shot in slot `s`, as a unit vector. */
function heading(ctx: RunContext, s: number): [number, number] {
  const vx = ctx.shots.vx[s] as number;
  const vy = ctx.shots.vy[s] as number;
  const len = Math.sqrt(vx * vx + vy * vy);
  return [vx / len, vy / len];
}

/** The unit vector from (x, y) to enemy `e`. */
function toward(x: number, y: number, e: Enemy): [number, number] {
  const dx = e.x - x;
  const dy = e.y - y;
  const len = Math.sqrt(dx * dx + dy * dy);
  return [dx / len, dy / len];
}

/** The id of the enemy each rider shot aims at: the one along its heading from its origin. */
function aims(ctx: RunContext): number[] {
  return riderSlots(ctx).map((s) => {
    const [hx, hy] = heading(ctx, s);
    const { x, y } = shotOf(ctx, s);
    const hit = ctx.enemies.find((e) => {
      const [ex, ey] = toward(x, y, e);
      return Math.abs(ex - hx) < 1e-9 && Math.abs(ey - hy) < 1e-9;
    });
    return hit?.id ?? -1;
  });
}

/** Makes one attack of the signature due and runs its emitter. */
function attack(ctx: RunContext, due = 1): void {
  const em = sig(ctx);
  em.acc = em.interval * due - em.cadence;
  const kind = em.spec.kind;
  if (kind === 'volley') runVolley(ctx, em);
  else if (kind === 'fan') runFan(ctx, em);
  else if (kind === 'lob') runLob(ctx, em);
  else if (kind === 'arc') runArc(ctx, em);
  else throw new Error(`no attack for ${kind}`);
}

/** Runs the projectile stage alone on `ticks` ticks after this one, the grid rebuilt for each. */
function fly(ctx: RunContext, ticks: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    ctx.now = ctx.state.tick = ctx.now + 1;
    rebuildGrid(ctx);
    ctx.events.length = 0;
    moveProjectiles(ctx);
    events.push(...ctx.events);
  }
  return events;
}

/** The drone stage on the current tick; returns its events. */
function stage(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepDrones(ctx);
  return ctx.events.slice();
}

/** The next tick's drone stage, the enemies standing where they are. */
function next(ctx: RunContext): SimEvent[] {
  ctx.now = ++ctx.state.tick;
  rebuildGrid(ctx);
  return stage(ctx);
}

interface SeenHit {
  readonly id: number;
  readonly k: number;
  readonly source: string;
  readonly mask: number;
  readonly crit: boolean;
  readonly flags: number;
  readonly depth: number;
  readonly origin: number;
  readonly amount: number;
}

/** A hook that records every hit, in order. */
function watch(): { module: TestModule; hits: SeenHit[] } {
  const hits: SeenHit[] = [];
  const module: TestModule = (b) => {
    b.hook('onHit', (ctx, hit) => {
      hits.push({
        id: hit.target.id,
        k: hit.chainIndex,
        source: ctx.build.sources.names[hit.source] as string,
        mask: hit.mask & ~TAG.crit,
        crit: hit.crit,
        flags: hit.flags,
        depth: hit.depth,
        origin: hit.origin,
        amount: toNumber(hit.amount),
      });
    });
  };
  return { module, hits };
}

const smallHits = (hits: readonly SeenHit[]): SeenHit[] =>
  hits.filter((hit) => hit.source === 'outer.barrage');

/** Fills the shot pool with idle shots until `n` projectiles are in flight. */
function fill(ctx: RunContext, n: number): void {
  const p = sig(ctx).payload;
  while (liveProjectiles(ctx) < n) {
    spawnShot(ctx, MOTION_STRAIGHT, -500, -500, 0, 0, 1e9, p, 1, 1, 0, 0, -1, false, -1, -1, null);
  }
}

/** Runs the build's first effect of `kind` as a signature hit's trigger at depth 1, origin 9. */
function runFirst(ctx: RunContext, kind: EffectSpec['kind'], x = P.x, y = P.y): void {
  const entry = createEffectEntry();
  entry.effect = ctx.build.effects.findIndex((fx) => fx.kind === kind);
  entry.depth = 1;
  entry.origin = 9;
  entry.flags = SIGNATURE | HIT_EVENT;
  entry.x = x;
  entry.y = y;
  runEffect(ctx, entry);
}

/** Effects on a kill, which none of these tests makes: they run only through runFirst. */
const onKill = (...effects: EffectSpec[]): TriggerSpec => ({ on: 'kill', do: effects });

/** Four enemies 300 out on the axes, far apart: the rider's picks from the player in id order. */
const CROSS: readonly PlacedEnemy[] = [at(300, 0), at(0, 300), at(-300, 0), at(0, -300)];

describe('compileBarrage (lead rulings W1, W3, W4)', () => {
  it('compiles no rider without a barrage grant, its params at their defaults, a fresh object each compile', () => {
    const plain = compiled({ grants: [] });
    expect(plain.barrage).toBeNull();
    expect(plain.flags.barrage).toEqual({ countMult: 1, bounce: 0 });
    expect(compiled({ grants: [] }).flags.barrage).not.toBe(plain.flags.barrage);
    // A grant is no emitter: the signature alone.
    const build = compiled();
    expect(build.emitters).toHaveLength(1);
    expect(build.barrage).toEqual<CompiledBarrage>({
      source: 'outer.barrage',
      damagePct: BARRAGE_DAMAGE_PCT,
      count: 2,
      hits: 1,
      bounce: 0,
    });
    expect(BARRAGE_DAMAGE_PCT).toBe(0.25);
    expect(
      compiled({ grants: [{ source: 'hub', grant: { kind: 'barrage', damagePct: 0.6 } }] }).barrage,
    ).toMatchObject({ source: 'hub', damagePct: 0.6 });
  });

  it('counts the whole barrage count: 2 → 2, 2.9 → 2, 0 → none, and a count below 0 as none', () => {
    const count = (barrageCount: number): number =>
      (compiled({ values: { barrageCount } }).barrage as CompiledBarrage).count;
    expect([count(2), count(2.9), count(1), count(0), count(0.9), count(-3)]).toEqual([
      2, 2, 1, 0, 0, 0,
    ]);
    // A count of 0 makes no rider in a run.
    expect(arena([], { values: { barrageCount: 0 } }).emitters[0]?.barrage).toBeNull();
    expect(arena([], { values: { barrageCount: 0.5 } }).emitters[0]?.barrage).toBeNull();
  });

  it('halves the count under 巨大化 (halveCounts), at least 1, then multiplies it by countMult', () => {
    const gigantism: RuleSpec = { id: 'gigantism', sizeMult: 2 };
    const count = (barrageCount: number, modules: readonly TestModule[] = []): number =>
      (
        compiled({ values: { barrageCount }, rules: [gigantism], modules })
          .barrage as CompiledBarrage
      ).count;
    expect(compiled({ rules: [gigantism] }).flags.halveCounts).toBe(true);
    expect([count(2), count(3), count(1), count(5)]).toEqual([1, 1, 1, 2]);
    expect(count(2, [params(2, 0)])).toBe(2);
    expect(count(5, [params(3, 0)])).toBe(6);
  });

  it('multiplies the count by countMult: 2 × 2 → 4, 3 × 4 → 12, and 0 × 4 → none', () => {
    const count = (barrageCount: number, countMult: number): number =>
      (
        compiled({ values: { barrageCount }, modules: [params(countMult, 0)] })
          .barrage as CompiledBarrage
      ).count;
    expect([count(2, 2), count(3, 4), count(2.5, 2), count(0, 4)]).toEqual([4, 12, 4, 0]);
  });

  it('reads the compiled barrageCount, as a module offsets it, never the StatBlock value', () => {
    const offset: TestModule = (b) => b.offsetStat('barrageCount', 3);
    expect((compiled({ modules: [offset] }).barrage as CompiledBarrage).count).toBe(5);
  });

  it('leaves the template payload’s linked count (C6b.1) as it was under countMult 2', () => {
    const linked: TriggerSpec = onKill({
      kind: 'projectiles',
      count: 4,
      aim: 'radial',
      damagePct: 0.5,
      countStat: 'barrageCount',
    });
    const countOf = (modules: readonly TestModule[], barrageCount: number): number => {
      const build = compiled({ triggers: [linked], modules, values: { barrageCount } });
      const fx = build.effects.find((e) => e.kind === 'projectiles');
      return fx?.spec.kind === 'projectiles' ? fx.spec.count : -1;
    };
    // 4 + (5 − 2) at barrageCount 5, with or without the params; the rider's count doubles.
    expect(countOf([], 5)).toBe(7);
    expect(countOf([params(2, 2)], 5)).toBe(7);
    expect(countOf([params(4, 0)], 2)).toBe(4);
    expect(
      (
        compiled({ triggers: [linked], modules: [params(2, 2)], values: { barrageCount: 5 } })
          .barrage as CompiledBarrage
      ).count,
    ).toBe(10);
  });

  it('keeps the first barrage grant in grant order, credited to its source, the nodes’ before a module’s', () => {
    const two = compiled({
      grants: [
        { source: 'fusion.fire.barrage', grant: { kind: 'barrage', damagePct: 0.5 } },
        GRANT,
      ],
    });
    expect(two.barrage).toMatchObject({ source: 'fusion.fire.barrage', damagePct: 0.5 });
    expect(two.emitters).toHaveLength(1);
    const added: TestModule = (b) => b.addEmitter('hub', { kind: 'barrage', damagePct: 2 });
    expect(compiled({ modules: [added] }).barrage).toMatchObject({
      source: 'outer.barrage',
      damagePct: 0.25,
    });
    expect(compiled({ grants: [], modules: [added] }).barrage).toMatchObject({
      source: 'hub',
      damagePct: 2,
    });
  });

  it('refuses countMult outside whole numbers in [1, 4] and bounce outside whole numbers in [0, 4], naming each', () => {
    for (const countMult of [0.5, 5, -1, NaN, 0, 1.5, Infinity]) {
      expect(() => compiled({ modules: [params(countMult, 0)] }), String(countMult)).toThrow(
        `barrage.countMult: ${countMult} must be a whole number in [1, 4]`,
      );
    }
    for (const bounce of [0.5, 5, -1, NaN, 2.5, Infinity]) {
      expect(() => compiled({ modules: [params(1, bounce)] }), String(bounce)).toThrow(
        `barrage.bounce: ${bounce} must be a whole number in [0, 4]`,
      );
    }
    // Without a grant too: a module's slip shows on every build.
    expect(() => compiled({ grants: [], modules: [params(5, 0)] })).toThrow(/countMult: 5/);
    for (const [countMult, bounce] of [
      [1, 0],
      [4, 4],
      [2, 2],
      [3, 1],
    ] as const) {
      expect(compiled({ modules: [params(countMult, bounce)] }).barrage).toMatchObject({
        count: 2 * countMult,
        bounce,
      });
    }
  });

  it('reads the pierce’s whole part: barragePierce 0, 1, 2.5 and −1 → 1, 2, 3 and 1 hits a shot', () => {
    const hits = (barragePierce: number): number =>
      (compiled({ values: { barragePierce } }).barrage as CompiledBarrage).hits;
    expect([hits(0), hits(1), hits(2.5), hits(0.9), hits(-1)]).toEqual([1, 2, 3, 1, 1]);
  });

  it('gives the signature alone the rider, on the barrage stream: a plain hit’s payload', () => {
    const ctx = arena([], {
      grants: [GRANT, { source: 'outer.summon', grant: { kind: 'drone', turrets: 1 } }],
    });
    const rider = riderOf(ctx);
    expect([rider.count, rider.hits, rider.bounce]).toEqual([2, 1, 0]);
    expect(ctx.emitters.map((em) => em.barrage === null)).toEqual([false, true]);
    const p = rider.payload;
    expect(toNumber(p.baseDamage)).toBe(2.5);
    expect([p.tags, p.flags, p.chains, p.rollsAilments, p.canCrit, p.policy]).toEqual([
      SMALL_TAGS,
      0,
      false,
      true,
      true,
      null,
    ]);
    expect(ctx.build.sources.names[p.source]).toBe('outer.barrage');
    expect(p.jumpSource).toBe(p.source);
    expect(p.rng).not.toBe(ctx.combatRng);
    expect(p.rng.snapshot()).toEqual(createStreams(1).barrage.snapshot());
  });
});

describe('the rider fires after each counted attack of the signature (W5, W6)', () => {
  it('after each volley attack, from the player, in the same tick, its ids after the attack’s projectiles', () => {
    const ctx = arena(CROSS);
    attack(ctx);
    const slots = riderSlots(ctx);
    expect(slots).toHaveLength(2);
    const volleyIds = ctx.projectiles.map((p) => p.id);
    expect(volleyIds).toHaveLength(2);
    for (const s of slots) {
      expect(shotOf(ctx, s)).toMatchObject({
        x: P.x,
        y: P.y,
        launched: 1,
        until: 1 + SMALL_PROJECTILE_TICKS,
        motion: MOTION_STRAIGHT,
        owner: -1,
        depth: 0,
        origin: -1,
      });
      expect(shotOf(ctx, s).id).toBeGreaterThan(Math.max(...volleyIds));
    }
    // Two attacks due in one tick: a rider after each.
    attack(ctx, 2);
    expect(riderSlots(ctx)).toHaveLength(6);
    expect(sig(ctx).attacks).toBe(3);
  });

  it('after each fan round, from the player, its ids after the round’s cones', () => {
    const ctx = arena(CROSS, { signature: FAN });
    attack(ctx);
    const cones = Array.from({ length: ctx.shots.count }, (_, s) => s).filter(
      (s) => (ctx.shots.round[s] as number) >= 0,
    );
    expect(cones.length).toBeGreaterThan(0);
    const slots = riderSlots(ctx);
    expect(slots).toHaveLength(2);
    const lastCone = Math.max(...cones.map((s) => ctx.shots.id[s] as number));
    for (const s of slots) {
      expect(shotOf(ctx, s)).toMatchObject({ x: P.x, y: P.y, launched: 1 });
      expect(shotOf(ctx, s).id).toBeGreaterThan(lastCone);
      expect(ctx.shots.round[s]).toBe(-1);
    }
  });

  it('after each lob firing, from the player at the throw, its ids after the bombs, none at the landing', () => {
    const ctx = arena(CROSS, { signature: LOB });
    attack(ctx);
    const bombs = Array.from({ length: ctx.shots.count }, (_, s) => s).filter(
      (s) => ctx.shots.motion[s] === MOTION_LOB,
    );
    expect(bombs.length).toBeGreaterThan(0);
    const slots = riderSlots(ctx);
    expect(slots).toHaveLength(2);
    const lastBomb = Math.max(...bombs.map((s) => ctx.shots.id[s] as number));
    for (const s of slots) {
      expect(shotOf(ctx, s)).toMatchObject({ x: P.x, y: P.y, launched: 1 });
      expect(shotOf(ctx, s).id).toBeGreaterThan(lastBomb);
    }
    // The bombs land and explode; the rider fires no more.
    const before = ctx.nextProjectileId;
    fly(ctx, 90);
    expect(ctx.shots.count === 0 || riderSlots(ctx).every((s) => shotOf(ctx, s).id < before)).toBe(
      true,
    );
    expect(ctx.nextProjectileId).toBe(before);
  });

  it('after each discharge, from the player, once its hits are dealt: a target it killed is no pick', () => {
    // Enemy 1, the nearest, dies to the discharge; the rider picks 2 and 3.
    const ctx = arena([at(100, 0, { hp: 1 }), at(0, 300), at(-300, 0), at(0, -400)], {
      signature: ARC,
    });
    attack(ctx);
    expect(enemy(ctx, 1).alive).toBe(false);
    const slots = riderSlots(ctx);
    expect(slots.map((s) => [shotOf(ctx, s).x, shotOf(ctx, s).y, shotOf(ctx, s).launched])).toEqual(
      [
        [P.x, P.y, 1],
        [P.x, P.y, 1],
      ],
    );
    expect(aims(ctx)).toEqual([2, 3]);
  });

  it('after each drone impact, from the drone’s position at the impact, once its hits are dealt', () => {
    // Enemy 1 dies to the impact; from its point the nearest alive are 2 (60 away), then 3.
    const ctx = arena([at(300, 0, { hp: 1 }), at(360, 0), at(300, -100), at(-300, 0)], {
      signature: SWARM,
      modules: [swarmCounts(1, 0)],
    });
    const em = sig(ctx);
    const ds = ctx.sys.drones;
    const target = enemy(ctx, 1);
    ds.x[0] = target.x;
    ds.y[0] = target.y;
    impactAt(ctx, 0, target, em.payload, em, true, 0, -1);
    expect(target.alive).toBe(false);
    const slots = riderSlots(ctx);
    expect(slots.map((s) => [shotOf(ctx, s).x, shotOf(ctx, s).y])).toEqual([
      [target.x, target.y],
      [target.x, target.y],
    ]);
    expect(aims(ctx)).toEqual([2, 3]);
    expect(em.attacks).toBe(1);
  });

  it('after each drone impact of the drone stage, from the impact point, the same tick', () => {
    const ctx = arena([at(400, 0), at(420, 40), at(-500, 0)], {
      signature: SWARM,
      modules: [swarmCounts(1, 0)],
    });
    let impacts = 0;
    for (let t = 0; t < 240 && impacts < 3; t++) {
      const before = ctx.nextProjectileId;
      const events = next(ctx);
      const impact = events.filter((e) => e.type === 'impact');
      const fresh = riderSlots(ctx).filter((s) => shotOf(ctx, s).id >= before);
      // One rider an impact, from the drone where it hit; none on the other ticks.
      expect(fresh.length, `tick ${ctx.now}`).toBe(impact.length * 2);
      for (const ev of impact) {
        if (ev.type !== 'impact') continue;
        for (const s of fresh) {
          expect([shotOf(ctx, s).x, shotOf(ctx, s).y, shotOf(ctx, s).launched]).toEqual([
            ev.x,
            ev.y,
            ctx.now,
          ]);
        }
      }
      impacts += impact.length;
      // The shots stay where they spawned: no projectile stage runs here.
      ctx.shots.count = 0;
      ctx.shots.straight = 0;
    }
    expect(impacts).toBe(3);
  });

  it('after each turret firing of the signature, from its seat, its ids after the firing’s shots', () => {
    const ctx = arena([at(200, 0), at(200, 40), at(-200, 0)], {
      signature: SWARM,
      modules: [swarmCounts(0, 1)],
    });
    const ds = ctx.sys.drones;
    const seat = { x: ds.x[0] as number, y: ds.y[0] as number };
    expect(seat).toEqual({ x: P.x + 90, y: P.y });
    ds.acc[0] = sig(ctx).interval;
    const events = stage(ctx);
    expect(events.filter((e) => e.type === 'turretFire')).toHaveLength(1);
    const homing = Array.from({ length: ctx.shots.count }, (_, s) => s).filter(
      (s) => ctx.shots.motion[s] === MOTION_HOMING,
    );
    expect(homing).toHaveLength(1);
    const slots = riderSlots(ctx);
    expect(slots).toHaveLength(2);
    for (const s of slots) {
      expect(shotOf(ctx, s)).toMatchObject({ x: seat.x, y: seat.y, launched: 1 });
      expect(shotOf(ctx, s).id).toBeGreaterThan(ctx.shots.id[homing[0] as number] as number);
    }
    // From the seat, 1 (110 away) and 2 (114.0) are nearest; 3 is 290.
    expect(aims(ctx)).toEqual([1, 2]);
    // Two firings due in one tick: a rider after each.
    ds.acc[0] = 2 * sig(ctx).interval;
    expect(stage(ctx).filter((e) => e.type === 'turretFire')).toHaveLength(2);
    expect(riderSlots(ctx)).toHaveLength(6);
  });

  it('never on a repeat: repeatAttack at once and at the next attack, on every signature', () => {
    const repeat = (timing: 'now' | 'nextAttack'): TriggerSpec =>
      onKill({ kind: 'repeatAttack', count: 2, damagePct: 0.5, timing });
    for (const signature of [VOLLEY, FAN, LOB, ARC, SWARM]) {
      const ctx = arena(CROSS, {
        signature,
        triggers: [repeat('now')],
        modules: signature === SWARM ? [swarmCounts(1, 0)] : [],
      });
      const shots = ctx.shots.count + ctx.projectiles.length;
      runFirst(ctx, 'repeatAttack');
      // The repeats fired, and no rider with them.
      expect(
        ctx.shots.count + ctx.projectiles.length + ctx.events.length,
        signature.id,
      ).toBeGreaterThan(shots);
      expect(riderSlots(ctx), signature.id).toEqual([]);
    }
    // Waiting for the next attack: that attack's rider alone, before its two repeats.
    const ctx = arena(CROSS, { triggers: [repeat('nextAttack')] });
    runFirst(ctx, 'repeatAttack');
    attack(ctx);
    expect(ctx.projectiles.length).toBe(6);
    expect(riderSlots(ctx)).toHaveLength(2);
    const lastRider = Math.max(...riderSlots(ctx).map((s) => shotOf(ctx, s).id));
    const repeats = ctx.projectiles.filter((p) => (p.payload.flags & REPEAT) !== 0);
    expect(repeats).toHaveLength(4);
    for (const p of repeats) expect(p.id).toBeGreaterThan(lastRider);
  });

  it('never for a granted emitter: a granted drone’s impact or a granted turret’s firing', () => {
    const ctx = arena(CROSS, {
      grants: [GRANT, { source: 'outer.summon', grant: { kind: 'drone', drones: 1, turrets: 1 } }],
    });
    const granted = ctx.emitters[1] as EmitterRuntime;
    expect(granted.spec.kind).toBe('drone');
    const ds = ctx.sys.drones;
    // Counted or not, a granted emitter's impact carries no rider.
    const target = enemy(ctx, 1);
    ds.x[0] = target.x;
    ds.y[0] = target.y;
    impactAt(ctx, 0, target, granted.payload, granted, true, 0, -1);
    impactAt(ctx, 0, target, granted.payload, granted, false, 0, -1);
    ds.acc[1] = granted.interval;
    expect(stage(ctx).filter((e) => e.type === 'turretFire')).toHaveLength(1);
    expect(ctx.shots.count).toBeGreaterThan(0);
    expect(riderSlots(ctx)).toEqual([]);
  });

  it('never on a timed row’s impact: a spirit’s, or a sentry-like row’s spawned on its enemy', () => {
    const spirit: EffectSpec = {
      kind: 'spawnDrone',
      lifeSec: 3,
      damagePct: 0.5,
      impacts: 3,
      aim: 'nearest',
    };
    const sentry: EffectSpec = {
      kind: 'spawnDrone',
      lifeSec: 3,
      damagePct: 0.5,
      impacts: 6,
      aim: 'nearest',
      speed: 30,
    };
    for (const [name, spec] of [
      ['spirit', spirit],
      ['sentry', sentry],
    ] as const) {
      const ctx = arena([at(200, 0), at(240, 0), at(-300, 0)], { triggers: [onKill(spec)] });
      const e = enemy(ctx, 1);
      runFirst(ctx, 'spawnDrone', e.x + (name === 'sentry' ? 5 : -100), e.y);
      const ds = ctx.sys.drones;
      expect(Array.from(ds.kind.subarray(0, ds.count)), name).toContain(DRONE_KIND_SPIRIT);
      let impacts = 0;
      for (let t = 0; t < 170; t++) {
        const events = next(ctx);
        impacts += events.filter((ev) => ev.type === 'impact').length;
      }
      expect(impacts, name).toBeGreaterThan(1);
      expect(riderSlots(ctx), name).toEqual([]);
    }
  });

  it('never from a triggered projectiles effect, nor an nthAttack trigger’s: only its attack’s rider', () => {
    const shots: EffectSpec = { kind: 'projectiles', count: 3, aim: 'distinct', damagePct: 0.5 };
    const ctx = arena(CROSS, { triggers: [{ on: 'nthAttack', every: 1, do: [shots] }] });
    runFirst(ctx, 'projectiles');
    expect(ctx.shots.count).toBe(3);
    expect(riderSlots(ctx)).toEqual([]);
    attack(ctx);
    // The nthAttack trigger's effect is queued; the attack's rider fired.
    expect(riderSlots(ctx)).toHaveLength(2);
    ctx.events.length = 0;
    for (let i = 0; i < 4; i++) runFirst(ctx, 'projectiles');
    expect(riderSlots(ctx)).toHaveLength(2);
  });
});

describe('the picks and the shots (W7)', () => {
  it('picks the N nearest distinct alive enemies to the origin, ties to the lower id, at any distance', () => {
    // 5 nearest; 1–4 tie at 300 (the same squared distance); 6 is far off, 7 dead.
    const ctx = arena([...CROSS, at(100, 50), at(900, 500), at(50, 0)], {
      values: { barrageCount: 4 },
    });
    enemy(ctx, 7).alive = false;
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(aims(ctx)).toEqual([5, 1, 2, 3]);
    // At any distance: from a corner, the far one first.
    const far = arena([at(900, 500), at(-900, -500), at(0, 0)], { values: { barrageCount: 3 } });
    fireBarrage(far, riderOf(far), P.x + 950, P.y + 530);
    expect(aims(far)).toEqual([1, 3, 2]);
    // Ties listed in reverse id order still go to the lower id.
    const reverse = arena([at(0, -300), at(-300, 0), at(0, 300), at(300, 0)], {
      values: { barrageCount: 2 },
    });
    fireBarrage(reverse, riderOf(reverse), P.x, P.y);
    expect(aims(reverse)).toEqual([1, 2]);
  });

  it('loses the shots past the enemies there are, none of them counted as capped', () => {
    const ctx = arena([at(200, 0), at(0, 200)], { values: { barrageCount: 5 } });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(aims(ctx)).toEqual([1, 2]);
    expect(ctx.counters.barrageCapped).toBe(0);
    const none = arena([], { values: { barrageCount: 5 } });
    fireBarrage(none, riderOf(none), P.x, P.y);
    expect(none.shots.count).toBe(0);
  });

  it('flies straight at the pick’s position at the firing, at the effects’ speed: a pick that moves off its line is missed', () => {
    const ctx = arena([at(300, 0), at(600, 0)], { values: { barrageCount: 1 } });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    const [s] = riderSlots(ctx);
    expect([ctx.shots.vx[s as number], ctx.shots.vy[s as number]]).toEqual([STEP, 0]);
    expect(ctx.projectileStep).toBe(STEP);
    // Its pick steps aside; the shot keeps its line and hits 2 behind it instead.
    enemy(ctx, 1).y = P.y + 200;
    enemy(ctx, 1).prevY = P.y + 200;
    const events = fly(ctx, 30);
    const hits = events.filter((e) => e.type === 'hit');
    expect(hits.map((e) => (e.type === 'hit' ? e.targetId : 0))).toEqual([2]);
    // A homing shot would have turned: this one never did.
    const moved = arena([at(300, 0), at(600, 0)], { values: { barrageCount: 1 } });
    fireBarrage(moved, riderOf(moved), P.x, P.y);
    enemy(moved, 1).x = P.x + 450;
    enemy(moved, 1).prevX = P.x + 450;
    const along = fly(moved, 30).filter((e) => e.type === 'hit');
    // A pick that moves along the line is still on its path.
    expect(along.map((e) => (e.type === 'hit' ? e.targetId : 0))).toEqual([1]);
  });

  it('hits floor(barragePierce) + 1 enemies on a line: pierce 0, 1 and 2.5 → 1, 2 and 3', () => {
    const line = [at(100, 0), at(160, 0), at(220, 0), at(280, 0), at(340, 0)];
    const hitsOf = (barragePierce: number): number[] => {
      const ctx = arena(line, { values: { barrageCount: 1, barragePierce } });
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      return fly(ctx, 40).flatMap((e) => (e.type === 'hit' ? [e.targetId] : []));
    };
    expect(hitsOf(0)).toEqual([1]);
    expect(hitsOf(1)).toEqual([1, 2]);
    expect(hitsOf(2.5)).toEqual([1, 2, 3]);
    expect(hitsOf(9)).toEqual([1, 2, 3, 4, 5]);
  });

  it('bounces off the arena’s edge `bounce` times: 2 → exactly two bounces, then it ends at the next edge', () => {
    // Straight down at its pick, which steps aside; at 2800 a second it crosses the arena in
    // about 23 ticks, within its 120.
    const bounces = (bounce: number): { flips: number; ended: number } => {
      const ctx = arena([at(0, 200)], {
        values: { barrageCount: 1, projectileSpeed: 2800 },
        modules: [params(1, bounce)],
      });
      fireBarrage(ctx, riderOf(ctx), P.x, P.y);
      const e = enemy(ctx, 1);
      e.x = e.prevX = P.x + 600;
      let flips = 0;
      let vy = ctx.shots.vy[0] as number;
      for (let t = 1; t <= SMALL_PROJECTILE_TICKS; t++) {
        fly(ctx, 1);
        if (ctx.shots.count === 0) return { flips, ended: t };
        const now = ctx.shots.vy[0] as number;
        if (Math.sign(now) !== Math.sign(vy)) flips++;
        vy = now;
        expect(ctx.shots.vx[0]).toBe(0);
      }
      return { flips, ended: -1 };
    };
    expect(bounces(0)).toEqual({ flips: 0, ended: 12 });
    expect(bounces(1)).toEqual({ flips: 1, ended: 36 });
    expect(bounces(2)).toEqual({ flips: 2, ended: 60 });
  });

  it('aims a pick on the origin away from the player, +x when the origin is the player too', () => {
    const ctx = arena([at(300, 100), at(0, 0)], { values: { barrageCount: 1 } });
    fireBarrage(ctx, riderOf(ctx), P.x + 300, P.y + 100);
    const [s] = riderSlots(ctx);
    const [hx, hy] = heading(ctx, s as number);
    expect(hx).toBeCloseTo(3 / Math.sqrt(10), 12);
    expect(hy).toBeCloseTo(1 / Math.sqrt(10), 12);
    const centre = arena([at(0, 0)], { values: { barrageCount: 1 } });
    fireBarrage(centre, riderOf(centre), P.x, P.y);
    expect(heading(centre, 0)).toEqual([1, 0]);
    // Its first step hits the enemy it started on.
    const hit = fly(ctx, 1).filter((e) => e.type === 'hit');
    expect(hit.map((e) => (e.type === 'hit' ? e.targetId : 0))).toEqual([1]);
  });
});

/** The non-zero ids of the shot in slot `s`'s memory block, in block order. */
function remembered(ctx: RunContext, s: number): number[] {
  const base = ctx.shots.memBase[s] as number;
  return Array.from(ctx.shots.memory.subarray(base, base + SHOT_MEMORY)).filter((id) => id !== 0);
}

/** A drone impact of the swarm on enemy `id`, from that enemy's point, counted. */
function impactOn(ctx: RunContext, id: number): Enemy {
  const ds = ctx.sys.drones;
  const target = enemy(ctx, id);
  ds.x[0] = target.x;
  ds.y[0] = target.y;
  const em = sig(ctx);
  impactAt(ctx, 0, target, em.payload, em, true, 0, -1);
  return target;
}

describe('an impact’s rider skips its target (W15)', () => {
  it('skips the impact’s target in its picks, though it is nearest: the N nearest others', () => {
    // From 1's point: 2 is 60 away, 3 100, 4 600. Nothing lies on the +x line out of 1, the
    // way a pick on the origin would fly.
    const placed = [at(300, 0), at(300, 60), at(300, -100), at(-300, 0)];
    const ctx = arena(placed, { signature: SWARM, modules: [swarmCounts(1, 0)] });
    const target = impactOn(ctx, 1);
    expect(target.alive).toBe(true);
    expect(aims(ctx)).toEqual([2, 3]);
    // Each shot starts out remembering the target, its next hit written after it.
    for (const s of riderSlots(ctx)) {
      expect(remembered(ctx, s)).toEqual([1]);
      expect(ctx.shots.memHead[s]).toBe(1);
    }
    // Four shots: the three others, the fourth lost, none of them capped.
    const four = arena(placed, {
      signature: SWARM,
      values: { barrageCount: 4 },
      modules: [swarmCounts(1, 0)],
    });
    impactOn(four, 1);
    expect(aims(four)).toEqual([2, 3, 4]);
    expect(four.counters.barrageCapped).toBe(0);
  });

  it('its shots never hit the impact’s target, with pierce 0 and pierce 1', () => {
    // 2 and 4 lie down the +y line out of 1, 3 up the −y line; 5 is far off.
    const placed = [at(300, 0), at(300, 80), at(300, -120), at(300, 160), at(-300, 0)];
    const smallIds = (barragePierce: number): number[] => {
      const seen = watch();
      const ctx = arena(placed, {
        signature: SWARM,
        values: { barragePierce },
        modules: [swarmCounts(1, 0), seen.module],
      });
      impactOn(ctx, 1);
      expect(aims(ctx)).toEqual([2, 3]);
      fly(ctx, 40);
      return smallHits(seen.hits).map((hit) => hit.id);
    };
    // Each shot passes through the enemy it starts in and hits its pick, then the one behind
    // it while its pierce lasts.
    expect(smallIds(0)).toEqual([2, 3]);
    expect(smallIds(1)).toEqual([2, 3, 4]);
  });

  it('the impact’s target dead before the rider fires: no pick anyway, each shot still seeded with its id', () => {
    const placed = [at(300, 0, { hp: 1 }), at(360, 0), at(300, -100), at(-300, 0)];
    const seen = watch();
    const ctx = arena(placed, { signature: SWARM, modules: [swarmCounts(1, 0), seen.module] });
    const target = impactOn(ctx, 1);
    expect(target.alive).toBe(false);
    // The picks of a rider from the same point without a skip: the dead are no pick.
    const plain = arena(placed, { signature: SWARM, modules: [swarmCounts(1, 0)] });
    enemy(plain, 1).alive = false;
    fireBarrage(plain, riderOf(plain), target.x, target.y);
    expect(aims(ctx)).toEqual([2, 3]);
    expect(aims(plain)).toEqual([2, 3]);
    // Its id is remembered all the same; a dead enemy is no hit either way.
    for (const s of riderSlots(ctx)) expect(remembered(ctx, s)).toEqual([1]);
    for (const s of riderSlots(plain)) expect(remembered(plain, s)).toEqual([]);
    fly(ctx, 40);
    expect(smallHits(seen.hits).map((hit) => hit.id)).toEqual([2, 3]);
  });

  it('leaves the volley’s and a turret’s riders as they were: their own target is a pick, no shot seeded', () => {
    // The volley's target is 1, the nearest, its second projectile's 2; its rider picks both.
    const volley = arena([at(200, 0), at(0, 300), at(-400, 0)]);
    attack(volley);
    expect(volley.projectiles.map((p) => p.target?.id)).toEqual([1, 2]);
    expect(aims(volley)).toEqual([1, 2]);
    for (const s of riderSlots(volley)) expect(remembered(volley, s)).toEqual([]);
    // A turret's first target from its seat is 1 (110 away); its rider picks it too.
    const turret = arena([at(200, 0), at(200, 40), at(-200, 0)], {
      signature: SWARM,
      modules: [swarmCounts(0, 1)],
    });
    turret.sys.drones.acc[0] = sig(turret).interval;
    const fire = stage(turret).find((e) => e.type === 'turretFire');
    expect(fire?.type === 'turretFire' ? fire.targetId : -1).toBe(1);
    expect(aims(turret)).toEqual([1, 2]);
    for (const s of riderSlots(turret)) expect(remembered(turret, s)).toEqual([]);
  });
});

describe('the small hits (W8)', () => {
  it('are plain hits credited to the grant’s source, at damage × 25%, its scoped damage applied, tagged hit and projectile', () => {
    const seen = watch();
    const ctx = arena([at(200, 0), at(240, 30), at(260, -30)], {
      values: { barrageCount: 1, chainCount: 3 },
      scoped: [{ stat: 'damage', kind: 'more', value: -0.4, scope: 'outer.barrage' }],
      modules: [seen.module],
    });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    fly(ctx, 20);
    expect(seen.hits).toEqual([
      {
        id: 1,
        k: 0,
        source: 'outer.barrage',
        mask: SMALL_TAGS,
        crit: false,
        flags: seen.hits[0]?.flags,
        depth: 0,
        origin: -1,
        amount: 1.5,
      },
    ]);
    // No PRIMARY, no SIGNATURE, and no chain jump though chainCount is 3 and others are near.
    const flags = seen.hits[0]?.flags ?? -1;
    expect(flags & (PRIMARY | SIGNATURE | REPEAT)).toBe(0);
    expect(toNumber(ctx.bySource[ctx.build.sources.index('outer.barrage')] ?? ZERO)).toBe(1.5);
  });

  it('are credited to the kept grant’s source whatever it is: its scope reaches them, outer.barrage’s does not', () => {
    const seen = watch();
    const ctx = arena([at(200, 0)], {
      grants: [{ source: 'fusion.fire.barrage', grant: { kind: 'barrage' } }, GRANT],
      values: { barrageCount: 1 },
      scoped: [
        { stat: 'damage', kind: 'more', value: -0.4, scope: 'fusion.fire.barrage' },
        { stat: 'damage', kind: 'more', value: 1, scope: 'outer.barrage' },
      ],
      modules: [seen.module],
    });
    const fusion = ctx.build.sources.index('fusion.fire.barrage');
    expect(riderOf(ctx).payload.source).toBe(fusion);
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    fly(ctx, 20);
    expect(seen.hits.map((hit) => [hit.id, hit.source, hit.amount])).toEqual([
      [1, 'fusion.fire.barrage', 1.5],
    ]);
    expect(toNumber(ctx.bySource[fusion] ?? ZERO)).toBe(1.5);
    expect(toNumber(ctx.bySource[ctx.build.sources.index('outer.barrage')] ?? ZERO)).toBe(0);
  });

  it('crit and roll ailments as a thorns hit does', () => {
    const seen = watch();
    const ctx = arena([at(200, 0)], {
      values: { barrageCount: 1, critChance: 1, critMultiplier: 3, igniteChance: 1 },
      modules: [seen.module],
    });
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    const events = fly(ctx, 20);
    expect(smallHits(seen.hits).map((hit) => [hit.crit, hit.amount])).toEqual([[true, 7.5]]);
    expect(events.some((e) => e.type === 'ignite' && e.targetId === 1)).toBe(true);
  });

  it('roll on the barrage stream: the other streams draw what the same build without the grant draws', () => {
    const run = (grants: readonly SourcedEmitter[]) => {
      const ctx = arena(CROSS, {
        grants,
        values: { critChance: 0.4, igniteChance: 0.4, barrageCount: 4 },
      });
      attack(ctx);
      attack(ctx);
      fly(ctx, 30);
      return ctx;
    };
    const ridden = run([GRANT]);
    const plain = run([]);
    // Nothing died; the small hits rolled crits and ignites.
    expect(ridden.enemies.every((e) => e.alive)).toBe(true);
    expect(
      toNumber(ridden.bySource[ridden.build.sources.index('outer.barrage')] ?? ZERO),
    ).toBeGreaterThan(0);
    const { barrage, ...rest } = rngPositions(ridden);
    const { barrage: none, ...restPlain } = rngPositions(plain);
    expect(rest).toEqual(restPlain);
    expect(none).toBeNull();
    expect(barrage).not.toEqual(createStreams(1).barrage.snapshot());
  });
});

describe('the reserve (W9)', () => {
  it('refuses a rider shot at SMALL_SHOT_CAP projectiles in flight and counts it, while a fan cone and a projectiles effect still spawn up to PROJECTILE_CAP', () => {
    expect([SMALL_SHOT_CAP, PROJECTILE_CAP]).toEqual([384, 512]);
    const ctx = arena(CROSS, {
      signature: FAN,
      values: { barrageCount: 3 },
      triggers: [onKill({ kind: 'projectiles', count: 4, aim: 'distinct', damagePct: 0.5 })],
    });
    fill(ctx, SMALL_SHOT_CAP);
    attack(ctx);
    // The round's cones spawned past the reserve; the rider's 3 were refused.
    expect(liveProjectiles(ctx)).toBeGreaterThan(SMALL_SHOT_CAP);
    expect(riderSlots(ctx)).toEqual([]);
    expect(ctx.counters.barrageCapped).toBe(3);
    expect(ctx.counters.projectilesCapped).toBe(0);
    const live = liveProjectiles(ctx);
    runFirst(ctx, 'projectiles');
    expect(liveProjectiles(ctx)).toBe(live + 4);
    fill(ctx, PROJECTILE_CAP - 1);
    runFirst(ctx, 'projectiles');
    expect(liveProjectiles(ctx)).toBe(PROJECTILE_CAP);
    expect(ctx.counters.projectilesCapped).toBe(3);
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect(ctx.counters.barrageCapped).toBe(6);
    expect(ctx.counters.projectilesCapped).toBe(3);
  });

  it('refuses no rider shot below SMALL_SHOT_CAP: each shot tests the pool as it stands', () => {
    const ctx = arena(CROSS, { values: { barrageCount: 3 } });
    fill(ctx, SMALL_SHOT_CAP - 3);
    fireBarrage(ctx, riderOf(ctx), P.x, P.y);
    expect([riderSlots(ctx).length, ctx.counters.barrageCapped]).toEqual([3, 0]);
    expect(liveProjectiles(ctx)).toBe(SMALL_SHOT_CAP);
    const edge = arena(CROSS, { values: { barrageCount: 3 } });
    fill(edge, SMALL_SHOT_CAP - 2);
    fireBarrage(edge, riderOf(edge), P.x, P.y);
    expect([riderSlots(edge).length, edge.counters.barrageCapped]).toEqual([2, 1]);
    // The volley's homing projectiles count against it too.
    const volley = arena(CROSS, { values: { barrageCount: 3 } });
    fill(volley, SMALL_SHOT_CAP - 4);
    attack(volley);
    expect(volley.projectiles).toHaveLength(2);
    expect([riderSlots(volley).length, volley.counters.barrageCapped]).toEqual([2, 1]);
  });

  it('counts the refused shots alone: the shots past the enemies there are stay lost, the pool full or not', () => {
    // 2 enemies for 5 shots: 3 are lost whatever the pool holds, and only picks are refused.
    const full = arena([at(200, 0), at(0, 200)], { values: { barrageCount: 5 } });
    fill(full, SMALL_SHOT_CAP);
    fireBarrage(full, riderOf(full), P.x, P.y);
    expect([riderSlots(full).length, full.counters.barrageCapped]).toEqual([0, 2]);
    const edge = arena([at(200, 0), at(0, 200)], { values: { barrageCount: 5 } });
    fill(edge, SMALL_SHOT_CAP - 1);
    fireBarrage(edge, riderOf(edge), P.x, P.y);
    expect(aims(edge)).toEqual([1]);
    expect(edge.counters.barrageCapped).toBe(1);
  });
});

/** The hash and result of a run of `options` on the fixture data, `ticks` long from wave 12. */
function runHash(options: Options, ticks = 900) {
  const sim = createSimulation(
    makeConfig({
      seed: options.seed ?? 1,
      stats: statsOf(options),
      rules: options.rules ?? [],
      signature: options.signature ?? VOLLEY,
      startWave: 12,
      maxTicks: ticks,
    }),
    makeTestData(),
    options.modules ?? [],
  );
  const hash = createRunHash();
  while (!sim.state.finished) hash.update(JSON.stringify(sim.step(NO_INPUT)));
  const result = sim.result();
  hash.update(JSON.stringify([result.damageBySource, result.counters]));
  return { hash: hash.digest(), result };
}

describe('a build without the rider, and determinism (W10)', () => {
  it('gives no emitter a rider without a grant, and its params alone change nothing', () => {
    for (const signature of [VOLLEY, FAN, LOB, ARC, SWARM]) {
      const ctx = arena(CROSS, { signature, grants: [] });
      expect(
        ctx.emitters.every((em) => em.barrage === null),
        signature.id,
      ).toBe(true);
      expect(rngPositions(ctx).barrage).toBeNull();
    }
    const plain = runHash({ grants: [] });
    expect(
      runHash({ grants: [], modules: [params(4, 4)], values: { barragePierce: 3 } }).hash,
    ).toBe(plain.hash);
    expect(runHash({ grants: [], values: { barrageCount: 6 } }).hash).toBe(plain.hash);
    expect(plain.result.counters.barrageCapped).toBe(0);
  });

  it('plays the same events twice from one seed, the rider at work, and other events from another', () => {
    for (const signature of [VOLLEY, SWARM]) {
      const options: Options = {
        signature,
        values: { barrageCount: 3, barragePierce: 1, critChance: 0.3, igniteChance: 0.3 },
        modules: [params(2, 2)],
      };
      const first = runHash(options);
      expect(runHash(options).hash, signature.id).toBe(first.hash);
      expect(toNumber(first.result.damageBySource['outer.barrage'] ?? ZERO)).toBeGreaterThan(0);
      expect(runHash({ ...options, seed: 2 }).hash).not.toBe(first.hash);
    }
  });
});
