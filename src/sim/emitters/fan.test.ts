import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import { createStreams } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { Modifier, StatBlock, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TriggerSpec } from '../../data/triggers';
import { centerStat, compileBuild, keyedStat } from '../build/compile';
import { SCOPED_INDEX } from '../build/modTable';
import { rowKey } from '../build/sources';
import { PROJECTILE_CAP } from '../caps';
import { REPEAT_STEPS, runEffect } from '../effects/execute';
import { HIT_EVENT, PRIMARY, REPEAT, SIGNATURE } from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { createRunContext } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { EMITTER_STEPS } from '../systems/emitters';
import { rebuildGrid } from '../systems/grid';
import { moveProjectiles } from '../systems/projectiles';
import { MOTION_STRAIGHT, spawnShot } from '../systems/shots';
import {
  centerTriggers,
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import { fireFanRepeat, fireRound, runFan } from './fan';
import { shotsInFlight } from './types';
import type { EmitterRuntime, Payload } from './types';

const ICE_FAN: SignatureSpec = { id: 'iceFan' };
/** The tags of a cone hit, and of a chain jump from one. */
const CONE_TAGS = TAG.hit | TAG.projectile | TAG.cold;
const JUMP_TAGS = TAG.hit | TAG.chain | TAG.cold;
/** A cone's move per tick at the base projectileSpeed. */
const STEP = 1400 / TICK_RATE;
/** Half the fan's 30°, and the angle between neighbouring cones of 5. */
const HALF = Math.PI / 12;
const GAP = Math.PI / 24;

/** The player's position. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** An enemy `dist` from the player at `angle` (radians from +x). */
const polar = (dist: number, angle: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: P.x + dist * Math.cos(angle),
  y: P.y + dist * Math.sin(angle),
  ...extra,
});
/** An enemy `dx` right of the player, on the line of a round's middle cone at it. */
const ahead = (dx: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y,
  ...extra,
});

const ICICLE = (every = 4, damagePct = 4): RuleSpec => ({ id: 'icicle', every, damagePct });
const PRISM: RuleSpec = { id: 'prism', perPierce: 0.2, maxBonus: 2 };
const steadyAim = (counts: 'shot' | 'attack', everyNth: number): RuleSpec => ({
  id: 'steadyAim',
  everyNth,
  critMultiplierMore: 0,
  counts,
});

interface FanOptions {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  readonly scoped?: readonly Modifier[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
}

/** Stats without crits, ignites or chains unless `values` say so, with these center triggers. */
const plain = (
  values: Partial<Record<StatId, number>> = {},
  triggers: readonly TriggerSpec[] = [],
  scoped: readonly Modifier[] = [],
): StatBlock =>
  makeStats({ critChance: 0, igniteChance: 0, chainCount: 0, ...values }, scoped, {
    ...centerTriggers(triggers),
  });

/** placedEnemies with the iceFan signature. */
const fans = (placed: readonly PlacedEnemy[], options: FanOptions = {}): RunContext =>
  placedEnemies(placed, {
    stats: plain(options.values, options.triggers, options.scoped),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
    signature: ICE_FAN,
  });

/** The signature's emitter, the fan. */
const fanOf = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;

/** The enemy with id `id` (placedEnemies numbers them 1, 2, … in order). */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** Makes one round of the fan due and runs the fan, which fires it. */
const fire = (ctx: RunContext): void => {
  const em = fanOf(ctx);
  em.acc = em.interval - em.cadence;
  runFan(ctx, em);
};

/** Runs the projectile stage alone on `ticks` ticks after this one, the grid rebuilt for each. */
function fly(ctx: RunContext, ticks: number): void {
  for (let t = 0; t < ticks; t++) {
    ctx.now = ctx.state.tick = ctx.now + 1;
    rebuildGrid(ctx);
    moveProjectiles(ctx);
  }
}

/** The slots of the shots in flight that the round of serial `round` fired. */
const slotsOf = (ctx: RunContext, round: number): number[] => {
  const slots: number[] = [];
  for (let s = 0; s < ctx.shots.count; s++) if (ctx.shots.round[s] === round) slots.push(s);
  return slots;
};

/** The flight angle of the shot in slot `s`. */
const angleOf = (ctx: RunContext, s: number): number =>
  Math.atan2(ctx.shots.vy[s] as number, ctx.shots.vx[s] as number);

/** Advances `twin` until it stands where `rng` does; throws when it never does. */
function sync(twin: Rng, rng: Rng): void {
  for (let n = 0; n < 10_000; n++) {
    if (String(twin.snapshot()) === String(rng.snapshot())) return;
    twin.next();
  }
  throw new Error('the twin stream never meets the run’s');
}

interface SeenHit {
  readonly id: number;
  readonly k: number;
  readonly primary: boolean;
  readonly crit: boolean;
  readonly depth: number;
  readonly origin: number;
  readonly flags: number;
  readonly mask: number;
  readonly amount: number;
}

/** A hook that records every hit, in order. */
function watch(): { module: TestModule; hits: SeenHit[] } {
  const hits: SeenHit[] = [];
  const module: TestModule = (b) => {
    b.hook('onHit', (_ctx, hit) => {
      hits.push({
        id: hit.target.id,
        k: hit.chainIndex,
        primary: (hit.flags & PRIMARY) !== 0,
        crit: hit.crit,
        depth: hit.depth,
        origin: hit.origin,
        flags: hit.flags,
        mask: hit.mask,
        amount: toNumber(hit.amount),
      });
    });
  };
  return { module, hits };
}

/** The ids of `hits`' cone hits (chain index 0), in order. */
const coneHits = (hits: readonly SeenHit[]): number[] =>
  hits.filter((hit) => hit.k === 0).map((hit) => hit.id);

describe('iceFan', () => {
  it('compiles to a fan of 40% cones, hit, projectile and cold, its fan params neutral', () => {
    const build = compileBuild(makeStats(), [], ICE_FAN);
    expect(build.signature.fan).toEqual({ icicleEvery: 0, icicleDamagePct: 0, prism: null });
    expect(build.signature.lob).toBeNull();
    expect(build.emitters[0]).toEqual({
      kind: 'fan',
      signature: true,
      source: 'center',
      damagePct: 0.4,
      tags: CONE_TAGS,
      chains: true,
      rollsAilments: true,
      canCrit: true,
      baseRate: 2.5,
      spreadDeg: 30,
      pierce: 1,
      lifeTicks: 120,
    });
    const m1 = compileBuild(makeStats(), []);
    expect(m1.signature.fan).toBeNull();
    expect(compileBuild(makeStats(), [], { id: 'magmaBomb' }).signature.fan).toBeNull();
  });

  it('fires projectileCount + 3 cones: 5 at the base 2, 5.5 at 2.5 (D5)', () => {
    expect(compileBuild(makeStats(), [], ICE_FAN).values.projectileCount).toBe(5);
    expect(
      compileBuild(makeStats({ projectileCount: 2.5 }), [], ICE_FAN).values.projectileCount,
    ).toBe(5.5);
    expect(compileBuild(makeStats(), []).values.projectileCount).toBe(2);
  });

  it('adds 10% frost to the center’s cold hits, its chain jumps’ too, and to no other (D5)', () => {
    const FROST = SCOPED_INDEX.frostOnHit;
    const build = compileBuild(makeStats(), [], ICE_FAN);
    expect(build.mods.filter((mod) => mod.stat === FROST)).toMatchObject([
      { kind: 0, value: 0.1, all: TAG.cold, none: 0 },
    ]);
    expect(centerStat(build, CONE_TAGS, FROST)).toBeCloseTo(0.1, 12);
    expect(centerStat(build, JUMP_TAGS, FROST, 1)).toBeCloseTo(0.1, 12);
    expect(centerStat(build, TAG.hit | TAG.projectile, FROST)).toBe(0);
    // A cold hit of an outer board's is not the center's.
    const outer = build.sources.index('outer.ice');
    expect(keyedStat(build, rowKey(CONE_TAGS, outer), FROST)).toBe(0);
  });

  it('rounds 2.5 times a second at the base attack speed, every 24 ticks, and 7.5 at 12 (D4)', () => {
    const ctx = fans([ahead(300)]);
    const em = fanOf(ctx);
    expect(em.interval).toBe(24);
    for (let tick = 0; tick < 120; tick++) runFan(ctx, em);
    expect(em.attacks).toBe(5);
    expect(fanOf(fans([], { values: { attackSpeed: 12 } })).interval).toBe(8);
    expect(fanOf(fans([], { values: { attackSpeed: 6 } })).interval).toBe(TICK_RATE / 3.75);
  });

  it('fires nothing and banks nothing while no enemy is alive', () => {
    const ctx = fans([ahead(300)]);
    const em = fanOf(ctx);
    enemy(ctx, 1).alive = false;
    rebuildGrid(ctx);
    for (let i = 0; i < 100; i++) runFan(ctx, em);
    expect([ctx.shots.count, em.attacks, ctx.shots.roundSerial]).toEqual([0, 0, 0]);
    expect(em.acc).toBe(em.interval - em.cadence);
    enemy(ctx, 1).alive = true;
    rebuildGrid(ctx);
    runFan(ctx, em);
    expect([ctx.shots.count, em.attacks, ctx.shots.roundSerial]).toEqual([5, 1, 1]);
  });

  it('gives the fan no icicle payload without 冰柱, and M1’s volley none', () => {
    const ctx = fans([]);
    expect(fanOf(ctx).alt).toBeNull();
    expect((placedEnemies([]).emitters[0] as EmitterRuntime).alt).toBeNull();
    // Its payload is the signature's, on the combat stream.
    expect(fanOf(ctx).payload.flags).toBe(SIGNATURE);
    expect(fanOf(ctx).payload.rng).toBe(ctx.combatRng);
  });
});

describe('fan rounds (D11, §4.7)', () => {
  it('fires 5 cones from the player at projectileSpeed, spread evenly over 30° about the target', () => {
    const ctx = fans([{ x: P.x + 400, y: P.y + 300 }]);
    const em = fanOf(ctx);
    fire(ctx);
    const theta = Math.atan2(300, 400);
    const shots = ctx.shots;
    expect(shots.count).toBe(5);
    for (let s = 0; s < 5; s++) {
      expect(angleOf(ctx, s)).toBeCloseTo(theta - HALF + GAP * s, 12);
      expect(Math.hypot(shots.vx[s] as number, shots.vy[s] as number)).toBeCloseTo(STEP, 12);
      expect([shots.motion[s], shots.x[s], shots.y[s]]).toEqual([MOTION_STRAIGHT, P.x, P.y]);
      // Pierce 1: two enemies; no bounce; a point; 120 ticks; the round's serial; the fan's.
      expect([shots.pierce[s], shots.bounce[s], shots.radius[s], shots.scale[s]]).toEqual([
        2, 0, 0, 1,
      ]);
      expect([
        shots.until[s],
        shots.round[s],
        shots.owner[s],
        shots.depth[s],
        shots.origin[s],
      ]).toEqual([ctx.now + 120, 1, 0, 0, -1]);
      expect(shots.payload[s]).toBe(em.payload);
    }
    expect([em.attacks, em.shots, shots.roundSerial]).toEqual([1, 5, 1]);
  });

  it('aims at the M1 picker’s target: a tough enemy within FOCUS_RANGE before a nearer one', () => {
    // A square 200 out ahead; a boss 400 out, straight up.
    const ctx = fans([ahead(200), polar(400, -Math.PI / 2, { type: 'boss' })]);
    fire(ctx);
    expect(angleOf(ctx, 2)).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('draws one count roll a round at 2.5 on the combat stream, after countAttack and before the first cone', () => {
    const seen: { combat: readonly number[]; shots: number }[] = [];
    const spy: TestModule = (b) =>
      b.hook('onAttack', (ctx) => {
        seen.push({ combat: ctx.combatRng.snapshot(), shots: ctx.shots.count });
      });
    const ctx = fans([ahead(300)], { values: { projectileCount: 2.5 }, modules: [spy] });
    expect(ctx.projectileCount).toBe(5.5);
    const twin = createStreams(1).combat;
    sync(twin, ctx.combatRng);
    const counts: number[] = [];
    for (let r = 0; r < 24; r++) {
      const combat = ctx.combatRng.snapshot();
      const shots = ctx.shots.count;
      fire(ctx);
      expect(seen[r]).toEqual({ combat, shots });
      const expected = twin.next() < 0.5 ? 6 : 5;
      expect(ctx.combatRng.snapshot()).toEqual(twin.snapshot());
      counts.push(ctx.shots.count - shots);
      expect(counts[r]).toBe(expected);
    }
    expect(new Set(counts)).toEqual(new Set([5, 6]));
    // A whole count draws nothing.
    const whole = fans([ahead(300)], { values: { projectileCount: 3 } });
    const before = rngPositions(whole);
    fire(whole);
    expect(whole.shots.count).toBe(6);
    expect(rngPositions(whole)).toEqual(before);
  });

  it('hits the first two enemies on a cone’s line, pierce 1, and ends that cone', () => {
    const { module, hits } = watch();
    const ctx = fans([ahead(200), ahead(230), ahead(260)], { modules: [module] });
    fire(ctx);
    const middle = ctx.shots.id[2] as number;
    fly(ctx, 20);
    expect(coneHits(hits)).toEqual([1, 2]);
    expect(Array.from(ctx.shots.id.subarray(0, ctx.shots.count))).not.toContain(middle);
    expect(ctx.shots.count).toBe(4);
  });

  it('makes one primary hit and one chain a round, its first cone hit, 5 cones on 5 enemies (K6)', () => {
    const { module, hits } = watch();
    // The target on the middle cone's line, the others 340 out on the other cones' lines.
    const placed = [
      ahead(290),
      polar(340, -2 * GAP),
      polar(340, -GAP),
      polar(340, GAP),
      polar(340, 2 * GAP),
    ];
    const ctx = fans(placed, { values: { chainCount: 1 }, modules: [module] });
    for (let round = 1; round <= 2; round++) {
      const from = hits.length;
      fire(ctx);
      fly(ctx, 25);
      const seen = hits.slice(from);
      expect(seen.filter((hit) => hit.primary).map((hit) => [hit.id, hit.k])).toEqual([[1, 0]]);
      // The primary hit first; its chain's jump right after it, to a neighbour of the target.
      expect(seen[0]).toMatchObject({ id: 1, k: 0, primary: true });
      expect(seen[1]?.k).toBe(1);
      expect([3, 4]).toContain(seen[1]?.id);
      expect(seen.filter((hit) => hit.k > 0)).toHaveLength(1);
      expect(coneHits(seen).sort()).toEqual([1, 2, 3, 4, 5]);
      // The attack counted the primary and its jump; the other cone hits count nothing.
      expect(ctx.chainBudget.hits).toBe(2);
      expect(ctx.counters.chainHitsPeak).toBe(2);
    }
  });

  it('takes the primary from the cone of the lower shot id when two cones first hit on one tick', () => {
    const { module, hits } = watch();
    // Enemy 1 on the last cone's line, 2 on the first's, the same distance out; 3 far ahead.
    const ctx = fans([polar(300, HALF), polar(300, -HALF), ahead(900)], { modules: [module] });
    const em = fanOf(ctx);
    fireRound(ctx, em, enemy(ctx, 3), em.payload, true, 0, -1);
    fly(ctx, 14);
    expect(hits.map((hit) => [hit.id, hit.primary])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it('lets every cone of a round hit an enemy all their lines cross, the first one its primary (Q8 (A))', () => {
    const { module, hits } = watch();
    // A boss (radius 70) 150 out: even the outer cones, 15° off, pass 38.8 from its center.
    const ctx = fans([ahead(150, { type: 'boss' })], { modules: [module] });
    fire(ctx);
    fly(ctx, 8);
    expect(hits.map((hit) => [hit.id, hit.k, hit.primary])).toEqual([
      [1, 0, true],
      [1, 0, false],
      [1, 0, false],
      [1, 0, false],
      [1, 0, false],
    ]);
  });

  it('tags cone hits hit, projectile and cold and their jumps hit, chain and cold, all SIGNATURE, and chills both', () => {
    const { module, hits } = watch();
    const ctx = fans([ahead(290), polar(340, GAP)], {
      values: { chainCount: 1 },
      modules: [module],
    });
    fire(ctx);
    fly(ctx, 25);
    expect(hits.map((hit) => [hit.id, hit.k, hit.mask, hit.flags & (SIGNATURE | PRIMARY)])).toEqual(
      [
        [1, 0, CONE_TAGS, SIGNATURE | PRIMARY],
        [2, 1, JUMP_TAGS, SIGNATURE],
        [2, 0, CONE_TAGS, SIGNATURE],
      ],
    );
    expect(enemy(ctx, 1).frost).toBeCloseTo(0.1, 12);
    expect(enemy(ctx, 2).frost).toBeCloseTo(0.2, 12);
  });

  it('passes over an enemy its primary hit’s chain killed in the same step: no hit, no pierce (R3)', () => {
    const { module, hits } = watch();
    // One step of the middle cone reaches all three; 2 dies to the primary's jump.
    const ctx = fans([ahead(208), ahead(213, { hp: 1 }), ahead(218)], {
      values: { chainCount: 1 },
      modules: [module],
    });
    fire(ctx);
    const middle = ctx.shots.id[2] as number;
    fly(ctx, 12);
    expect(enemy(ctx, 2).alive).toBe(false);
    expect(hits.map((hit) => [hit.id, hit.k])).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
    ]);
    // Its two hits spent, the cone ended.
    expect(Array.from(ctx.shots.id.subarray(0, ctx.shots.count))).not.toContain(middle);
  });

  it('lands every cone hit of the step whose primary chain ends with 遠雷’s farthest pick (C2)', () => {
    const { module, hits } = watch();
    const farthest: TestModule = (b) => {
      b.chainPolicy().lastFarthest = true;
    };
    // One step of the cone reaches 1–4; 5 stands off its line, the farthest from 2 in range.
    const ctx = fans(
      [ahead(208), ahead(213), ahead(218), ahead(223), ahead(208, { y: P.y + 200 })],
      {
        values: { chainCount: 2 },
        rules: [PRISM],
        modules: [farthest, module],
      },
    );
    expect(fanOf(ctx).payload.general).toBe(true);
    fire(ctx);
    fly(ctx, 12);
    expect(hits.map((hit) => [hit.id, hit.k, hit.primary])).toEqual([
      [1, 0, true],
      [2, 1, false],
      [5, 2, false],
      [2, 0, false],
      [3, 0, false],
      [4, 0, false],
    ]);
  });

  it('counts a cone PROJECTILE_CAP refuses as a shot and as capped, and ends the round there', () => {
    const ctx = fans([ahead(300)]);
    const em = fanOf(ctx);
    for (let i = 0; i < PROJECTILE_CAP - 2; i++) {
      spawnShot(
        ctx,
        MOTION_STRAIGHT,
        P.x,
        P.y,
        0,
        0,
        ctx.now + 1000,
        em.payload,
        1,
        0,
        0,
        0,
        -1,
        false,
        -1,
        -1,
        null,
      );
    }
    const capped = ctx.counters.projectilesCapped;
    fire(ctx);
    expect(ctx.counters.projectilesCapped).toBe(capped + 1);
    expect(em.shots).toBe(3);
    expect(ctx.shots.count).toBe(PROJECTILE_CAP);
    expect(slotsOf(ctx, 1)).toHaveLength(2);
  });

  it('ends a cone at the arena’s edge, and at its 120th tick', () => {
    const ctx = fans([ahead(300)]);
    fire(ctx);
    const ids = Array.from(ctx.shots.id.subarray(0, 5));
    const flying = (): number[] => Array.from(ctx.shots.id.subarray(0, ctx.shots.count));
    // 960 / STEP is 41.1: on its 42nd move the middle cone leaves past the right edge, and the
    // two 7.5° off it (1931.6 out); the outer two, 15° off, are 1906.6 out.
    fly(ctx, 41);
    expect(flying()).toEqual(ids);
    fly(ctx, 1);
    expect(flying()).toEqual([ids[0], ids[4]]);
    const slow = fans([ahead(300)], { values: { projectileSpeed: 60 } });
    fire(slow);
    fly(slow, 119);
    expect(slotsOf(slow, 1)).toHaveLength(5);
    fly(slow, 1);
    expect(slotsOf(slow, 1)).toEqual([]);
  });
});

describe('fan round serials (C22)', () => {
  it('gives every round the next serial, repeats included, and each cone its round’s', () => {
    const ctx = fans([ahead(300)], { triggers: [IDLE_REPEAT] });
    const em = fanOf(ctx);
    fire(ctx);
    fireFanRepeat(ctx, em, repeatPayloadOf(ctx), 1, 9);
    fire(ctx);
    expect(ctx.shots.roundSerial).toBe(3);
    expect(Array.from(ctx.shots.round.subarray(0, ctx.shots.count))).toEqual([
      1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3,
    ]);
  });

  /**
   * Three cones, each 30 short of its enemy, all hitting on the next tick in shot id order: the
   * first and third of round `a`, the second of round `b`. Returns whether each hit is a primary.
   */
  function interleaved(a: number, b: number): boolean[] {
    const { module, hits } = watch();
    const ctx = fans([ahead(300), ahead(300, { y: P.y + 200 }), ahead(300, { y: P.y - 200 })], {
      values: { chainCount: 2 },
      modules: [module],
    });
    const p = fanOf(ctx).payload;
    for (const [id, round] of [
      [1, a],
      [2, b],
      [3, a],
    ] as const) {
      const e = enemy(ctx, id);
      spawnShot(
        ctx,
        MOTION_STRAIGHT,
        e.x - 30,
        e.y,
        STEP,
        0,
        ctx.now + 100,
        p,
        1,
        2,
        0,
        0,
        -1,
        false,
        round,
        0,
        null,
      );
    }
    fly(ctx, 1);
    return hits.filter((hit) => hit.k === 0).map((hit) => hit.primary);
  }

  it('keeps a round’s primary taken while a round 64 later takes its own (256 slots)', () => {
    expect(interleaved(1, 65)).toEqual([true, true, false]);
    expect(interleaved(7, 7 + 128)).toEqual([true, true, false]);
  });

  it('gives a round its primary though its slot holds an older round’s serial', () => {
    expect(interleaved(1, 257)).toEqual([true, true, true]);
  });

  it('never makes an effect’s straight shot (round −1) a primary or an attack, nor scales it under 稜鏡 (K15)', () => {
    const { module, hits } = watch();
    const ctx = fans([ahead(300), ahead(330), ahead(360)], {
      values: { chainCount: 2 },
      rules: [PRISM],
      modules: [module],
    });
    const p = fanOf(ctx).payload;
    const serial = ctx.attackSerial;
    spawnShot(
      ctx,
      MOTION_STRAIGHT,
      P.x + 250,
      P.y,
      STEP,
      0,
      ctx.now + 100,
      p,
      1,
      -1,
      0,
      0,
      -1,
      false,
      -1,
      -1,
      null,
    );
    fly(ctx, 8);
    expect(hits.map((hit) => [hit.id, hit.k, hit.primary])).toEqual([
      [1, 0, false],
      [2, 0, false],
      [3, 0, false],
    ]);
    expect(ctx.attackSerial).toBe(serial);
    expect(new Set(hits.map((hit) => hit.amount)).size).toBe(1);
  });
});

describe('冰柱 (icicle; C10, C21)', () => {
  it('fires one cone of the icicle payload at the target on counted rounds 4, 8 and 12', () => {
    const ctx = fans([ahead(300)], { rules: [ICICLE(4)] });
    const em = fanOf(ctx);
    const rounds = Array.from({ length: 12 }, (_, r) => {
      fire(ctx);
      const slots = slotsOf(ctx, r + 1);
      const icicle = slots.every((s) => ctx.shots.payload[s] === em.alt);
      return [slots.length, icicle];
    });
    expect(rounds).toEqual(
      Array.from({ length: 12 }, (_, r) => ((r + 1) % 4 === 0 ? [1, true] : [5, false])),
    );
    const icicle = slotsOf(ctx, 4)[0] as number;
    expect([angleOf(ctx, icicle), ctx.shots.pierce[icicle], ctx.shots.radius[icicle]]).toEqual([
      0, 2, 0,
    ]);
    // Each icicle cone counts one shot.
    expect([em.attacks, em.shots]).toEqual([12, 9 * 5 + 3]);
  });

  it('counts the round countAttack counted: the 4th attack, whoever counts it (C10)', () => {
    const ctx = fans([ahead(300)], { rules: [ICICLE(4)] });
    const em = fanOf(ctx);
    em.attacks = 3;
    fire(ctx);
    expect(slotsOf(ctx, 1).map((s) => ctx.shots.payload[s] === em.alt)).toEqual([true]);
    fire(ctx);
    expect(slotsOf(ctx, 2)).toHaveLength(5);
  });

  it('gives the icicle payload damagePct of the damage stat, the fan payload’s rows and stream', () => {
    const ctx = fans([], { rules: [ICICLE(4, 4)], values: { damage: 10 } });
    const em = fanOf(ctx);
    const alt = em.alt as Payload;
    expect(alt).not.toBeNull();
    expect(toNumber(alt.baseDamage)).toBe(40);
    expect(toNumber(em.payload.baseDamage)).toBe(4);
    const p = em.payload;
    expect([
      alt.tags,
      alt.source,
      alt.jumpSource,
      alt.flags,
      alt.rows,
      alt.rng,
      alt.policy,
    ]).toEqual([p.tags, p.source, p.jumpSource, p.flags, p.rows, p.rng, p.policy]);
    expect(alt.rows).toBe(p.rows);
    expect(alt.rng).toBe(ctx.combatRng);
    expect([alt.chains, alt.rollsAilments, alt.canCrit, alt.general]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('gives the icicle payload the fan payload’s chain policy, so its chains take the general path', () => {
    const farthest: TestModule = (b) => {
      b.chainPolicy().lastFarthest = true;
    };
    const ctx = fans([], { rules: [ICICLE(4)], modules: [farthest] });
    const em = fanOf(ctx);
    const alt = em.alt as Payload;
    expect(em.payload.policy).not.toBeNull();
    expect(alt.policy).toBe(em.payload.policy);
    expect([alt.general, em.payload.general]).toEqual([true, true]);
  });

  it('hits 10 times as hard as a cone at damagePct 4, one primary each round', () => {
    const { module, hits } = watch();
    const ctx = fans([ahead(200)], { rules: [ICICLE(2)], modules: [module] });
    fire(ctx);
    fly(ctx, 12);
    fire(ctx);
    fly(ctx, 12);
    expect(hits.map((hit) => [hit.id, hit.k, hit.primary])).toEqual([
      [1, 0, true],
      [1, 0, true],
    ]);
    expect((hits[1] as SeenHit).amount / (hits[0] as SeenHit).amount).toBeCloseTo(10, 12);
  });
});

describe('稜鏡 (prism; C6)', () => {
  /** 13 enemies 30 apart on the middle cone's line, from 200 out. */
  const LINE = Array.from({ length: 13 }, (_, j) => ahead(200 + 30 * j));

  it('fires one cone at the target through every enemy, scaled min(3, 1 + .2 × pierced), drawing nothing', () => {
    const { module, hits } = watch();
    const ctx = fans(LINE, { values: { projectileCount: 2.5 }, rules: [PRISM], modules: [module] });
    expect(ctx.projectileCount).toBe(5.5);
    const before = rngPositions(ctx);
    fire(ctx);
    expect(rngPositions(ctx)).toEqual(before);
    expect([ctx.shots.count, angleOf(ctx, 0), ctx.shots.pierce[0], fanOf(ctx).shots]).toEqual([
      1, 0, -1, 1,
    ]);
    fly(ctx, 30);
    expect(hits.map((hit) => hit.id)).toEqual(LINE.map((_, j) => j + 1));
    expect(hits.map((hit) => hit.primary)).toEqual(LINE.map((_, j) => j === 0));
    const first = (hits[0] as SeenHit).amount;
    hits.forEach((hit, j) => {
      expect(hit.amount / first, `hit ${j + 1}`).toBeCloseTo(Math.min(3, 1 + 0.2 * j), 12);
    });
    expect([ctx.shots.pierce[0], ctx.shots.pierced[0]]).toEqual([-1, 13]);
  });

  it('counts in its factor only the enemies it hit: one its primary’s chain killed adds nothing (R3)', () => {
    const { module, hits } = watch();
    // One step of the cone reaches all three; 2 dies to the primary's jump.
    const ctx = fans([ahead(208), ahead(213, { hp: 1 }), ahead(218)], {
      values: { chainCount: 1 },
      rules: [PRISM],
      modules: [module],
    });
    fire(ctx);
    fly(ctx, 12);
    expect(enemy(ctx, 2).alive).toBe(false);
    expect(hits.map((hit) => [hit.id, hit.k])).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
    ]);
    expect((hits[2] as SeenHit).amount / (hits[0] as SeenHit).amount).toBeCloseTo(1.2, 12);
    expect(ctx.shots.pierced[0]).toBe(2);
  });

  it('makes 冰柱’s cone one of 400% through every enemy, scaled as any', () => {
    const { module, hits } = watch();
    const ctx = fans(LINE.slice(0, 4), { rules: [ICICLE(2), PRISM], modules: [module] });
    const em = fanOf(ctx);
    fire(ctx);
    fly(ctx, 20);
    fire(ctx);
    expect(
      slotsOf(ctx, 2).map((s) => [ctx.shots.payload[s] === em.alt, ctx.shots.pierce[s]]),
    ).toEqual([[true, -1]]);
    fly(ctx, 20);
    const amounts = hits.map((hit) => hit.amount);
    expect(amounts).toHaveLength(8);
    for (let j = 0; j < 4; j++) {
      expect((amounts[4 + j] as number) / (amounts[0] as number)).toBeCloseTo(
        10 * (1 + 0.2 * j),
        12,
      );
    }
  });
});

describe('steady cones (§4.1a, K21)', () => {
  /** Which cones of four rounds are steady. */
  const steadiness = (options: FanOptions): boolean[][] => {
    const ctx = fans([ahead(300)], options);
    return Array.from({ length: 4 }, (_, r) => {
      fire(ctx);
      return slotsOf(ctx, r + 1).map((s) => ctx.shots.steady[s] === 1);
    });
  };
  const F = false;
  const T = true;

  it("makes every Nth cone steady across rounds with counts 'shot' (K21)", () => {
    expect(steadiness({ rules: [steadyAim('shot', 4)] })).toEqual([
      [F, F, F, T, F],
      [F, F, T, F, F],
      [F, T, F, F, F],
      [T, F, F, F, T],
    ]);
  });

  it("makes every cone of every Nth round steady with counts 'attack'", () => {
    expect(steadiness({ rules: [steadyAim('attack', 2)] })).toEqual([
      [F, F, F, F, F],
      [T, T, T, T, T],
      [F, F, F, F, F],
      [T, T, T, T, T],
    ]);
  });

  it('makes a whole round steady when an onAttack hook forces crits', () => {
    const third: TestModule = (b) =>
      b.hook('onAttack', (_ctx, em, shot) => {
        if (em.attacks === 3) shot.forceCrit = true;
      });
    expect(steadiness({ modules: [third] })).toEqual([
      [F, F, F, F, F],
      [F, F, F, F, F],
      [T, T, T, T, T],
      [F, F, F, F, F],
    ]);
  });

  it('crits every hit of a steady cone: the round’s primary, its chain jump and its later hits', () => {
    // The middle cone hits 1, the round's primary, whose jump goes to 2; the next cone hits 2.
    // Crit chance 0: only a steady cone crits.
    const crits = (rules: readonly RuleSpec[]): [number, number, boolean][] => {
      const { module, hits } = watch();
      const ctx = fans([ahead(290), polar(340, GAP)], {
        values: { chainCount: 1 },
        rules,
        modules: [module],
      });
      fire(ctx);
      fly(ctx, 25);
      return hits.map((hit) => [hit.id, hit.k, hit.crit]);
    };
    expect(crits([steadyAim('shot', 1)])).toEqual([
      [1, 0, true],
      [2, 1, true],
      [2, 0, true],
    ]);
    // Only the middle cone, the round's third shot, is steady.
    expect(crits([steadyAim('shot', 3)])).toEqual([
      [1, 0, true],
      [2, 1, true],
      [2, 0, false],
    ]);
    expect(crits([])).toEqual([
      [1, 0, false],
      [2, 1, false],
      [2, 0, false],
    ]);
  });

  it('counts 冰柱’s cone as one shot', () => {
    expect(steadiness({ rules: [steadyAim('shot', 3), ICICLE(2)] })).toEqual([
      [F, F, T, F, F],
      [T],
      [F, F, T, F, F],
      [T],
    ]);
  });
});

/** Idle triggers (never firing here) with a repeat now and a charge for the next round. */
const IDLE_REPEAT: TriggerSpec = {
  on: 'periodic',
  every: 1000,
  do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }],
};
const IDLE_CHARGE: TriggerSpec = {
  on: 'periodic',
  every: 1000,
  do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.25, timing: 'nextAttack' }],
};

/** The index of the build's n-th repeatAttack effect. */
function repeatEffectOf(ctx: RunContext, n = 0): number {
  const found = ctx.build.effects.flatMap((fx, i) => (fx.kind === 'repeatAttack' ? [i] : []));
  const effect = found[n];
  if (effect === undefined) throw new Error(`no repeatAttack effect ${n}`);
  return effect;
}

/** The repeat payload of the build's n-th repeatAttack effect (RunContext.sys.repeat). */
const repeatPayloadOf = (ctx: RunContext, n = 0): Payload =>
  ctx.sys.repeat.payloads[repeatEffectOf(ctx, n)] as Payload;

/** Runs the build's n-th repeatAttack effect at `depth` from trigger `origin`. */
function runRepeatEffect(ctx: RunContext, n = 0, depth = 1, origin = 9): void {
  const entry = createEffectEntry();
  entry.effect = repeatEffectOf(ctx, n);
  entry.depth = depth;
  entry.origin = origin;
  entry.flags = SIGNATURE | HIT_EVENT;
  runEffect(ctx, entry);
}

describe('fan repeats (fireFanRepeat; §4.15, Q5 (A))', () => {
  /** fans with IDLE_REPEAT (50%) and IDLE_CHARGE (25%) besides `options.triggers`. */
  const repeating = (placed: readonly PlacedEnemy[], options: FanOptions = {}): RunContext =>
    fans(placed, { ...options, triggers: [IDLE_REPEAT, IDLE_CHARGE, ...(options.triggers ?? [])] });
  const fanCounts = (em: EmitterRuntime) => ({
    attacks: em.attacks,
    shots: em.shots,
    volley: em.volley,
    acc: em.acc,
  });

  it('is the fan’s repeat step', () => {
    expect(REPEAT_STEPS.iceFan).toBe(fireFanRepeat);
  });

  it('fires a round of the repeat’s payload at the nearest enemy, never steady, counting no shot or attack', () => {
    const ctx = repeating([ahead(300), ahead(500)], { rules: [steadyAim('shot', 1)] });
    const em = fanOf(ctx);
    const before = fanCounts(em);
    const p = repeatPayloadOf(ctx);
    fireFanRepeat(ctx, em, p, 2, 9);
    const shots = ctx.shots;
    expect(shots.count).toBe(5);
    for (let s = 0; s < 5; s++) {
      expect(angleOf(ctx, s)).toBeCloseTo(-HALF + GAP * s, 12);
      expect([shots.payload[s] === p, shots.steady[s], shots.depth[s], shots.origin[s]]).toEqual([
        true,
        0,
        2,
        9,
      ]);
      expect([shots.pierce[s], shots.round[s]]).toEqual([2, 1]);
    }
    expect(fanCounts(em)).toEqual(before);
    fire(ctx);
    expect(slotsOf(ctx, 2).map((s) => shots.steady[s])).toEqual([1, 1, 1, 1, 1]);
  });

  it('aims at the M1 picker’s target too: a tough enemy within FOCUS_RANGE before a nearer one', () => {
    const ctx = repeating([ahead(200), polar(400, -Math.PI / 2, { type: 'boss' })]);
    fireFanRepeat(ctx, fanOf(ctx), repeatPayloadOf(ctx), 1, 9);
    expect(angleOf(ctx, 2)).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('is what repeatAttack fires now for the fan: count rounds of its cones, no volley (REPEAT_STEPS)', () => {
    const twice: TriggerSpec = {
      on: 'periodic',
      every: 1000,
      do: [{ kind: 'repeatAttack', count: 2, damagePct: 0.5 }],
    };
    const ctx = repeating([ahead(300)], { triggers: [twice] });
    const em = fanOf(ctx);
    const before = fanCounts(em);
    runRepeatEffect(ctx, 2, 3, 5);
    expect(ctx.projectiles).toEqual([]);
    const p = repeatPayloadOf(ctx, 2);
    const shots = ctx.shots;
    expect(shots.count).toBe(10);
    expect(
      Array.from({ length: 10 }, (_, s) => [
        shots.payload[s] === p,
        shots.depth[s],
        shots.origin[s],
        shots.round[s],
      ]),
    ).toEqual(Array.from({ length: 10 }, (_, s) => [true, 3, 5, s < 5 ? 1 : 2]));
    expect(fanCounts(em)).toEqual(before);
  });

  it('draws its count on the effects stream at projectileCount 2.5; nothing on combat', () => {
    const ctx = repeating([ahead(300)], { values: { projectileCount: 2.5 } });
    const em = fanOf(ctx);
    const twin = createStreams(1).effects;
    sync(twin, ctx.effectsRng);
    const combat = ctx.combatRng.snapshot();
    const fired: number[] = [];
    for (let r = 0; r < 12; r++) {
      const from = ctx.shots.count;
      fireFanRepeat(ctx, em, repeatPayloadOf(ctx), 1, 9);
      const n = ctx.shots.count - from;
      expect(n).toBe(twin.next() < 0.5 ? 6 : 5);
      expect(ctx.effectsRng.snapshot()).toEqual(twin.snapshot());
      fired.push(n);
    }
    expect(new Set(fired)).toEqual(new Set([5, 6]));
    expect(ctx.combatRng.snapshot()).toEqual(combat);
    // No enemy: no round, no serial, nothing drawn.
    const empty = repeating([], { values: { projectileCount: 2.5 } });
    const before = rngPositions(empty);
    fireFanRepeat(empty, fanOf(empty), repeatPayloadOf(empty), 1, 9);
    expect([empty.shots.count, empty.shots.roundSerial]).toEqual([0, 0]);
    expect(rngPositions(empty)).toEqual(before);
  });

  it('fires 稜鏡’s one cone through every enemy, drawing nothing (F12)', () => {
    const ctx = repeating([ahead(300)], { values: { projectileCount: 2.5 }, rules: [PRISM] });
    const before = rngPositions(ctx);
    fireFanRepeat(ctx, fanOf(ctx), repeatPayloadOf(ctx), 1, 9);
    expect([ctx.shots.count, angleOf(ctx, 0), ctx.shots.pierce[0]]).toEqual([1, 0, -1]);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('never fires 冰柱’s cone, whatever round the fan counted last (F12)', () => {
    const ctx = repeating([ahead(300)], { rules: [ICICLE(2)] });
    const em = fanOf(ctx);
    fire(ctx);
    fire(ctx);
    expect(slotsOf(ctx, 2).map((s) => ctx.shots.payload[s] === em.alt)).toEqual([true]);
    const p = repeatPayloadOf(ctx);
    fireFanRepeat(ctx, em, p, 1, 9);
    expect(slotsOf(ctx, 3).map((s) => ctx.shots.payload[s] === p)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(em.attacks).toBe(2);
    fire(ctx);
    expect(slotsOf(ctx, 4)).toHaveLength(5);
  });

  it('makes its round’s first cone hit a primary of its own, flagged REPEAT, with its own chain, all at the repeat’s depth and origin', () => {
    const { module, hits } = watch();
    const ctx = repeating([ahead(290), polar(340, GAP)], {
      values: { chainCount: 1 },
      modules: [module],
    });
    fireFanRepeat(ctx, fanOf(ctx), repeatPayloadOf(ctx), 2, 9);
    fly(ctx, 25);
    expect(
      hits.map((hit) => [
        hit.id,
        hit.k,
        hit.flags & (SIGNATURE | REPEAT | PRIMARY),
        hit.depth,
        hit.origin,
      ]),
    ).toEqual([
      [1, 0, SIGNATURE | REPEAT | PRIMARY, 2, 9],
      [2, 1, SIGNATURE | REPEAT, 2, 9],
      [2, 0, SIGNATURE | REPEAT, 2, 9],
    ]);
  });

  it('fires the waiting repeats right after a round, as rounds of their own', () => {
    const ctx = repeating([ahead(300)]);
    runRepeatEffect(ctx, 1, 2, 7);
    expect(ctx.sys.repeat.charges.count).toBe(1);
    fire(ctx);
    const shots = ctx.shots;
    const sig = fanOf(ctx).payload;
    const charge = repeatPayloadOf(ctx, 1);
    expect(
      Array.from({ length: 10 }, (_, s) => [
        shots.payload[s] === (s < 5 ? sig : charge),
        shots.depth[s],
        shots.origin[s],
        shots.round[s],
      ]),
    ).toEqual(Array.from({ length: 10 }, (_, s) => (s < 5 ? [true, 0, -1, 1] : [true, 2, 7, 2])));
    expect(fanCounts(fanOf(ctx))).toMatchObject({ attacks: 1, shots: 5 });
    expect(ctx.sys.repeat.charges.count).toBe(0);
  });
});

describe('fan estimates', () => {
  it("counts its cones in flight: projectileEstimate is the signature's non-crit cone hit", () => {
    // ×3 on projectile hits, ×5 on crits: the estimate is a non-crit hit.
    const stats = makeStats({ damage: 10 }, [
      { stat: 'damage', kind: 'more', value: 2, tags: ['projectile'] },
      { stat: 'damage', kind: 'more', value: 4, tags: ['crit'] },
    ]);
    const ctx = createRunContext(makeConfig({ stats, signature: ICE_FAN }), makeTestData());
    expect(shotsInFlight(fanOf(ctx).spec)).toBe(true);
    expect(toNumber(ctx.projectileEstimate)).toBeCloseTo(10 * 0.4 * 3, 12);
  });
});

describe('fan runs', () => {
  it('is the emitter stage’s step for the fan kind', () => {
    expect(EMITTER_STEPS.fan).toBe(runFan);
  });

  it('runs ten seconds of waves from wave 8 the same twice', () => {
    const config = makeConfig({
      stats: plain({ chainCount: 1, projectileCount: 2.5, critChance: 0.2 }),
      rules: [ICICLE(3)],
      signature: ICE_FAN,
      startWave: 8,
      maxTicks: 600,
    });
    const runOnce = (): SimEvent[] => {
      const sim = createSimulation(config, makeTestData());
      const events: SimEvent[] = [];
      while (!sim.state.finished) events.push(...sim.step(NO_INPUT));
      return events;
    };
    const first = runOnce();
    expect(eventsOf([first], 'hit').length).toBeGreaterThan(40);
    expect(eventsOf([first], 'enemyKilled').length).toBeGreaterThan(10);
    expect(runOnce()).toEqual(first);
  });
});
