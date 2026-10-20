import { describe, expect, it } from 'vitest';
import { toNumber, ZERO } from '../../core/num';
import { createStreams } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { StatBlock, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { EffectSpec, SlashLineSpec, TriggerSpec } from '../../data/triggers';
import { centerStat, compileBuild, keyedStat } from '../build/compile';
import { SCOPED_INDEX } from '../build/modTable';
import { rowKey } from '../build/sources';
import { CHAIN_HIT_CAP, CHAIN_JUMP_EVENT_CAP } from '../caps';
import { emitCenterEvent } from '../effects/centerEvents';
import { REPEAT_STEPS, runEffect, runEffectQueue } from '../effects/execute';
import { CHAIN_JUMP, HIT_EVENT, PRIMARY, REPEAT, SIGNATURE } from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import { CHAIN_JUMP_CHANCE, EVENT, SHATTER_TRIGGER } from '../effects/types';
import type { CompiledTrigger } from '../effects/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { EMITTER_STEPS } from '../systems/emitters';
import { rebuildGrid } from '../systems/grid';
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
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import { fireArcRepeat, fireDischarge, runArc } from './arc';
import { shotsInFlight } from './types';
import type { EmitterRuntime, Payload } from './types';

const TRIPHASE_ARC: SignatureSpec = { id: 'triphaseArc' };
const SIX_COILS: RuleSpec = { id: 'sixCoils', coils: 6, targets: 2, damageMult: 0.55 };
/** The tags of every arc hit, its primary hits and their chain jumps alike (A32). */
const ARC_TAGS = TAG.hit | TAG.chain | TAG.lightning;
/** An effect that touches no enemy and draws nothing. */
const HEAL: EffectSpec = { kind: 'heal', lifePct: 0.01 };

/** The player's position. */
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** An enemy (dx, dy) from the player. */
const at = (dx: number, dy: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: P.x + dx,
  y: P.y + dy,
  ...extra,
});
/** 40 enemies 30 apart in 8 columns from 250 right of the player: every two within 260. */
const CLUSTER: readonly PlacedEnemy[] = Array.from({ length: 40 }, (_, j) =>
  at(250 + 30 * (j % 8), -60 + 30 * Math.floor(j / 8)),
);

const steadyAim = (counts: 'shot' | 'attack', everyNth: number): RuleSpec => ({
  id: 'steadyAim',
  everyNth,
  critMultiplierMore: 0,
  counts,
});

interface ArcOptions {
  readonly values?: Partial<Record<StatId, number>>;
  readonly triggers?: readonly TriggerSpec[];
  readonly rules?: readonly RuleSpec[];
  readonly modules?: readonly TestModule[];
}

/** Stats without crits or ignites unless `values` say so, with these center triggers. */
const plain = (
  values: Partial<Record<StatId, number>> = {},
  triggers: readonly TriggerSpec[] = [],
): StatBlock =>
  makeStats({ critChance: 0, igniteChance: 0, ...values }, [], centerTriggers(triggers));

/** placedEnemies with the triphaseArc signature. */
const arcs = (placed: readonly PlacedEnemy[], options: ArcOptions = {}): RunContext =>
  placedEnemies(placed, {
    stats: plain(options.values, options.triggers),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
    signature: TRIPHASE_ARC,
  });

/** The signature's emitter, the arc. */
const arcOf = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;

/** The enemy with id `id` (placedEnemies numbers them 1, 2, … in order). */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies[id - 1] as Enemy;

/** Makes a discharge of the arc due and runs the arc, which fires it. */
const fire = (ctx: RunContext): void => {
  const em = arcOf(ctx);
  em.acc = em.interval - em.cadence;
  runArc(ctx, em);
};

/** [coil, target id] of each discharge event in ctx.events. */
const discharges = (ctx: RunContext): [number, number][] =>
  eventsOf([ctx.events], 'discharge').map((e) => [e.coil, e.targetId]);

/** Advances `twin` until it stands where `rng` does; throws when it never does. */
function sync(twin: Rng, rng: Rng): number {
  for (let n = 0; n < 100_000; n++) {
    if (String(twin.snapshot()) === String(rng.snapshot())) return n;
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
      });
    });
  };
  return { module, hits };
}

interface SeenJump {
  readonly id: number | null;
  readonly x: number;
  readonly y: number;
  readonly fromX: number;
  readonly fromY: number;
  readonly value: number;
  readonly listCount: number;
  readonly flags: number;
  readonly depth: number;
  readonly origin: number;
}

/** A hook that records every chainJump event as its hooks see it, and how many it saw at all. */
function jumpSpy(): { module: TestModule; jumps: SeenJump[]; events: number[] } {
  const jumps: SeenJump[] = [];
  const events: number[] = [];
  const module: TestModule = (b) => {
    b.hook('onCenterEvent', (_ctx, ev) => {
      events.push(ev.event);
      if (ev.event !== EVENT.chainJump) return;
      jumps.push({
        id: ev.target?.id ?? null,
        x: ev.x,
        y: ev.y,
        fromX: ev.fromX,
        fromY: ev.fromY,
        value: toNumber(ev.value),
        listCount: ev.listCount,
        flags: ev.flags,
        depth: ev.depth,
        origin: ev.origin,
      });
    });
  };
  return { module, jumps, events };
}

/** A chainJump trigger of `effect` on 'fusion.lightning.fire' at coefficient `coef`. */
const chainJumpAt =
  (coef: number, effect: EffectSpec = HEAL): TestModule =>
  (b) =>
    b.addTrigger('fusion.lightning.fire', { on: 'chainJump', do: [effect] }, coef);

/** The index of the build's first trigger on chainJump. */
function chainJumpTrigger(ctx: RunContext, n = 0): number {
  const found = ctx.build.triggers.flatMap((t, i) => (t.on === EVENT.chainJump ? [i] : []));
  const index = found[n];
  if (index === undefined) throw new Error(`no chainJump trigger ${n}`);
  return index;
}

/** Idle triggers (never firing here) with a repeat now and a charge for the next discharge. */
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

/** arcs with IDLE_REPEAT (50%) and IDLE_CHARGE (25%) besides `options.triggers`. */
const repeating = (placed: readonly PlacedEnemy[], options: ArcOptions = {}): RunContext =>
  arcs(placed, { ...options, triggers: [IDLE_REPEAT, IDLE_CHARGE, ...(options.triggers ?? [])] });

describe('triphaseArc', () => {
  it('compiles to an arc of 100% discharges, hit, chain and lightning, of 3 coils, its arc params neutral', () => {
    const build = compileBuild(makeStats(), [], TRIPHASE_ARC);
    expect(build.signature.arc).toEqual({ coils: 3, targets: 1, damageMult: 1 });
    expect([build.signature.lob, build.signature.fan]).toEqual([null, null]);
    expect(build.emitters[0]).toEqual({
      kind: 'arc',
      signature: true,
      source: 'center',
      damagePct: 1,
      tags: ARC_TAGS,
      chains: true,
      rollsAilments: true,
      canCrit: true,
      coils: 3,
    });
    for (const signature of [undefined, { id: 'magmaBomb' }, { id: 'iceFan' }] as const) {
      expect(compileBuild(makeStats(), [], signature).signature.arc).toBeNull();
    }
  });

  it('chains 2 jumps more than the chain count says (D5)', () => {
    expect(compileBuild(makeStats({ chainCount: 1.5 }), [], TRIPHASE_ARC).values.chainCount).toBe(
      3.5,
    );
    expect(compileBuild(makeStats({ chainCount: 1.5 }), []).values.chainCount).toBe(1.5);
    expect(arcs([]).chainCount).toBe(2);
  });

  it('shocks the center’s lightning hits, its chain jumps’ too, and no other (D5)', () => {
    const SHOCK = SCOPED_INDEX.shockAlways;
    const build = compileBuild(makeStats(), [], TRIPHASE_ARC);
    expect(build.mods.filter((mod) => mod.stat === SHOCK)).toMatchObject([
      { kind: 0, value: 1, all: TAG.lightning, none: 0 },
    ]);
    expect(centerStat(build, ARC_TAGS, SHOCK)).toBe(1);
    expect(centerStat(build, ARC_TAGS, SHOCK, 3)).toBe(1);
    expect(centerStat(build, TAG.hit | TAG.chain, SHOCK, 1)).toBe(0);
    // A lightning hit of an outer board's is not the center's.
    const outer = build.sources.index('outer.lightning');
    expect(keyedStat(build, rowKey(ARC_TAGS, outer), SHOCK)).toBe(0);
  });

  it('rolls ailments with its shockAlways row alone (ctx.rollsDots), and shocks what it hits', () => {
    const ctx = arcs([at(300, 0)]);
    const values = ctx.build.values;
    expect([values.poisonChance, values.bleedChance, values.shockChance]).toEqual([0, 0, 0]);
    expect([values.poisonAlways, values.bleedAlways, values.shockAlways]).toEqual([0, 0, 0]);
    expect(ctx.rollsDots).toBe(true);
    expect(placedEnemies([], { stats: plain() }).rollsDots).toBe(false);
    fire(ctx);
    const target = enemy(ctx, 1);
    expect([target.shockStacks, target.shockUntil > ctx.now]).toEqual([1, true]);
  });

  it('deals the damage stat on the combat stream, × damageMult under 六線圈, its repeats a share of that, raising no chainJump', () => {
    const ctx = repeating([], { values: { damage: 10 } });
    const p = arcOf(ctx).payload;
    expect([toNumber(p.baseDamage), p.tags, p.flags, p.rng]).toEqual([
      10,
      ARC_TAGS,
      SIGNATURE,
      ctx.combatRng,
    ]);
    // Its jumps raise chainJump, so it takes the general chain path without a policy.
    expect([p.raisesChainJump, p.general, p.policy]).toEqual([true, true, null]);
    const repeat = repeatPayloadOf(ctx);
    expect([toNumber(repeat.baseDamage), repeat.flags, repeat.rng]).toEqual([
      5,
      SIGNATURE | REPEAT,
      ctx.effectsRng,
    ]);
    expect([repeat.raisesChainJump, repeat.general]).toEqual([false, false]);
    const six = repeating([], { values: { damage: 10 }, rules: [SIX_COILS] });
    expect(toNumber(arcOf(six).payload.baseDamage)).toBeCloseTo(5.5, 12);
    expect(toNumber(repeatPayloadOf(six).baseDamage)).toBeCloseTo(2.75, 12);
    // No other signature's payload raises it.
    for (const signature of [undefined, { id: 'magmaBomb' }, { id: 'iceFan' }] as const) {
      const other = placedEnemies([], { ...(signature === undefined ? {} : { signature }) });
      expect(arcOf(other).payload.raisesChainJump).toBe(false);
    }
  });

  it('is the emitter stage’s step for the arc kind, which has no shots in flight', () => {
    expect(EMITTER_STEPS.arc).toBe(runArc);
    const ctx = arcs([]);
    expect(shotsInFlight(arcOf(ctx).spec)).toBe(false);
    // So the picker counts no damage in flight: nothing is ever covered.
    expect(ctx.projectileEstimate).toBe(ZERO);
    expect(arcOf(ctx).coil).toBe(0);
  });
});

describe('arc discharges (§4.8)', () => {
  it('discharges 3 times a second at the base attack speed, every 20 ticks, and 6 under 六線圈 (D4, K28)', () => {
    const count = (options: ArcOptions): [number, number] => {
      const ctx = arcs([at(300, 0)], options);
      const em = arcOf(ctx);
      for (let tick = 0; tick < 120; tick++) runArc(ctx, em);
      return [em.interval, em.attacks];
    };
    expect(count({})).toEqual([20, 6]);
    expect(count({ rules: [SIX_COILS] })).toEqual([10, 12]);
    expect(count({ values: { attackSpeed: 8 } })).toEqual([10, 12]);
    expect(count({ values: { attackSpeed: 8 }, rules: [SIX_COILS] })).toEqual([5, 24]);
    // The run's coil count is the form's, whatever its targets.
    expect(count({ rules: [{ id: 'sixCoils', coils: 4, targets: 1, damageMult: 1 }] })).toEqual([
      15, 8,
    ]);
  });

  it('fires nothing and banks nothing while no enemy is alive', () => {
    const ctx = arcs([at(300, 0)]);
    const em = arcOf(ctx);
    enemy(ctx, 1).alive = false;
    rebuildGrid(ctx);
    for (let i = 0; i < 100; i++) runArc(ctx, em);
    expect([em.attacks, em.shots, em.coil, ctx.events.length]).toEqual([0, 0, 0, 0]);
    expect(em.acc).toBe(em.interval - em.cadence);
    enemy(ctx, 1).alive = true;
    rebuildGrid(ctx);
    runArc(ctx, em);
    expect([em.attacks, em.shots, em.coil]).toEqual([1, 1, 1]);
    expect(discharges(ctx)).toEqual([[0, 1]]);
  });

  it('strikes the M1 picker’s target at any range: a focus target before a nearer enemy', () => {
    // A square 1,006 out, beyond FOCUS_RANGE and every chain range, alone.
    const far = arcs([at(900, 450)]);
    fire(far);
    expect(eventsOf([far.events], 'hit').map((hit) => hit.targetId)).toEqual([1]);
    // A boss 400 out before a square 200 out.
    const focus = arcs([at(200, 0), at(0, -400, { type: 'boss' })]);
    fire(focus);
    expect(discharges(focus)).toEqual([[0, 2]]);
  });

  it('hits its target and chains from it at once, every hit hit, chain and lightning, SIGNATURE, the first PRIMARY (A32)', () => {
    for (const critChance of [0, 1]) {
      const { module, hits } = watch();
      const ctx = arcs([at(300, 0), at(400, 0), at(500, 0)], {
        values: { critChance },
        modules: [module],
      });
      fire(ctx);
      const crit = critChance === 1 ? TAG.crit : 0;
      expect(
        hits.map((hit) => [
          hit.id,
          hit.k,
          hit.mask,
          hit.flags & (SIGNATURE | PRIMARY | REPEAT | CHAIN_JUMP),
        ]),
      ).toEqual([
        [1, 0, ARC_TAGS | crit, SIGNATURE | PRIMARY],
        [2, 1, ARC_TAGS | crit, SIGNATURE | CHAIN_JUMP],
        [3, 2, ARC_TAGS | crit, SIGNATURE | CHAIN_JUMP],
      ]);
      // Nothing flies: every hit lands on the tick of its discharge.
      expect([ctx.projectiles.length, ctx.shots.count]).toEqual([0, 0]);
      expect(eventsOf([ctx.events], 'hit').map((hit) => hit.targetId)).toEqual([1, 2, 3]);
      expect([ctx.chainBudget.hits, ctx.counters.chainHitsPeak]).toEqual([3, 3]);
      expect([1, 2, 3].map((id) => enemy(ctx, id).shockStacks)).toEqual([1, 1, 1]);
      expect(hits.every((hit) => hit.depth === 0 && hit.origin === -1)).toBe(true);
    }
  });

  it('raises a discharge event at its target before its hit, its coils taking turns', () => {
    const ctx = arcs([at(300, 0), at(400, 0)]);
    const seen = Array.from({ length: 4 }, () => {
      ctx.events.length = 0;
      fire(ctx);
      return ctx.events.flatMap((event: SimEvent) =>
        event.type === 'discharge'
          ? [['discharge', event.coil, event.targetId]]
          : event.type === 'hit'
            ? [['hit', event.targetId]]
            : [],
      );
    });
    expect(seen).toEqual(
      [0, 1, 2, 0].map((coil) => [
        ['discharge', coil, 1],
        ['hit', 1],
        ['hit', 2],
      ]),
    );
    expect(arcOf(ctx).coil).toBe(1);
  });

  it('rolls its jumps once a discharge on the combat stream, after its primary hit and before its first jump', () => {
    const seen: { k: number; combat: readonly number[] }[] = [];
    const spy: TestModule = (b) =>
      b.hook('onHit', (ctx, hit) => {
        seen.push({ k: hit.chainIndex, combat: ctx.combatRng.snapshot() });
      });
    const line = Array.from({ length: 6 }, (_, j) => at(300 + 60 * j, 0));
    const ctx = arcs(line, { values: { chainCount: 0.5 }, modules: [spy] });
    expect(ctx.chainCount).toBe(2.5);
    const twin = createStreams(1).combat;
    sync(twin, ctx.combatRng);
    const counts: number[] = [];
    for (let d = 0; d < 24; d++) {
      seen.length = 0;
      const before = ctx.combatRng.snapshot();
      fire(ctx);
      const jumps = twin.next() < 0.5 ? 3 : 2;
      expect(ctx.combatRng.snapshot()).toEqual(twin.snapshot());
      expect(seen.map((hit) => hit.k)).toEqual(Array.from({ length: jumps + 1 }, (_, k) => k));
      expect(seen[0]?.combat).toEqual(before);
      expect(seen[1]?.combat).toEqual(twin.snapshot());
      counts.push(jumps);
    }
    expect(new Set(counts)).toEqual(new Set([2, 3]));
    // A whole chain count draws nothing.
    const whole = arcs(line, { values: { chainCount: 1 } });
    const positions = rngPositions(whole);
    fire(whole);
    expect(eventsOf([whole.events], 'hit')).toHaveLength(4);
    expect(rngPositions(whole)).toEqual(positions);
  });

  it('stops its chain at CHAIN_HIT_CAP, counting the jumps refused', () => {
    const { module, hits } = watch();
    const ctx = arcs(CLUSTER, { values: { chainCount: 38 }, modules: [module] });
    fire(ctx);
    expect(hits).toHaveLength(CHAIN_HIT_CAP);
    expect(ctx.counters.chainHitCapped).toBe(40 - (CHAIN_HIT_CAP - 1));
  });

  /** Which hits of four discharges at two enemies crit, crit chance 0: only steady ones. */
  const steadiness = (options: ArcOptions, placed = [at(300, 0), at(400, 0)]): boolean[][] => {
    const { module, hits } = watch();
    const ctx = arcs(placed, { ...options, modules: [...(options.modules ?? []), module] });
    return Array.from({ length: 4 }, () => {
      const from = hits.length;
      fire(ctx);
      return hits.slice(from).map((hit) => hit.crit);
    });
  };
  const F = false;
  const T = true;

  it('is one attack and one shot: every hit of every Nth discharge is steady (§4.1a)', () => {
    expect(steadiness({ rules: [steadyAim('shot', 2)] })).toEqual([
      [F, F],
      [T, T],
      [F, F],
      [T, T],
    ]);
    expect(steadiness({ rules: [steadyAim('attack', 3)] })).toEqual([
      [F, F],
      [F, F],
      [T, T],
      [F, F],
    ]);
    const third: TestModule = (b) =>
      b.hook('onAttack', (_ctx, em, shot) => {
        if (em.attacks === 3) shot.forceCrit = true;
      });
    expect(steadiness({ modules: [third] })).toEqual([
      [F, F],
      [F, F],
      [T, T],
      [F, F],
    ]);
  });

  it('counts a discharge at two targets as one shot, both steady together under 六線圈', () => {
    // 600 apart: two primaries, no jump.
    const placed = [at(300, 0), at(-300, 0)];
    expect(steadiness({ rules: [SIX_COILS, steadyAim('shot', 2)] }, placed)).toEqual([
      [F, F],
      [T, T],
      [F, F],
      [T, T],
    ]);
    const ctx = arcs(placed, { rules: [SIX_COILS] });
    for (let d = 0; d < 3; d++) fire(ctx);
    expect([arcOf(ctx).attacks, arcOf(ctx).shots, arcOf(ctx).volley]).toEqual([3, 3, 3]);
  });

  it('fires one nthAttack event a discharge, at its first target', () => {
    const ctx = arcs([at(300, 0), at(-300, 0)], {
      rules: [SIX_COILS],
      triggers: [{ on: 'nthAttack', every: 2, do: [HEAL] }],
    });
    for (let d = 0; d < 4; d++) fire(ctx);
    expect(ctx.triggerState.count[SHATTER_TRIGGER + 1]).toBe(4);
  });
});

describe('六線圈 (sixCoils; C13)', () => {
  it('strikes two distinct targets, both picked before either is hit, each from the next coil', () => {
    const { module, hits } = watch();
    // On the first hit, enemy 2 takes the mark of the arc's volley: a pick after a hit would
    // pass it over for enemy 3.
    let marked = false;
    const late: TestModule = (b) =>
      b.hook('onHit', (ctx) => {
        if (marked) return;
        marked = true;
        enemy(ctx, 2).volleyMark = arcOf(ctx).volley;
      });
    const ctx = arcs([at(200, 0), at(0, 250), at(-300, 0)], {
      rules: [SIX_COILS],
      modules: [late, module],
    });
    fire(ctx);
    expect(
      ctx.events.flatMap((event: SimEvent) =>
        event.type === 'discharge'
          ? [['discharge', event.coil, event.targetId]]
          : event.type === 'hit'
            ? [['hit', event.targetId, event.chainIndex]]
            : [],
      ),
    ).toEqual([
      ['discharge', 0, 1],
      ['hit', 1, 0],
      ['discharge', 1, 2],
      ['hit', 2, 0],
    ]);
    expect(hits.map((hit) => [hit.id, hit.primary])).toEqual([
      [1, true],
      [2, true],
    ]);
    // Both primaries count in the attack's budget.
    expect(ctx.chainBudget.hits).toBe(2);
    fire(ctx);
    fire(ctx);
    expect(discharges(ctx).slice(-4)).toEqual([
      [2, 1],
      [3, 2],
      [4, 1],
      [5, 2],
    ]);
    expect(arcOf(ctx).coil).toBe(0);
  });

  it('takes as its second target the enemy a volley would aim its next projectile at, never its first again', () => {
    // A boss 400 out is the focus target, and the square 200 out the second, not the boss again.
    const focus = arcs([at(200, 0), at(0, -400, { type: 'boss' })], { rules: [SIX_COILS] });
    fire(focus);
    expect(discharges(focus)).toEqual([
      [0, 2],
      [1, 1],
    ]);
    // Two elites: both focus targets, so the farther elite before the nearer square.
    const elites = arcs(
      [at(150, 0), at(0, -300, { type: 'hexagon' }), at(0, 350, { type: 'hexagon' })],
      {
        rules: [SIX_COILS],
      },
    );
    fire(elites);
    expect(discharges(elites)).toEqual([
      [0, 2],
      [1, 3],
    ]);
    // A lone enemy is struck once.
    const lone = arcs([at(300, 0)], { rules: [SIX_COILS] });
    fire(lone);
    expect(discharges(lone)).toEqual([[0, 1]]);
    expect([lone.chainBudget.hits, arcOf(lone).coil, enemy(lone, 1).alive]).toEqual([1, 1, true]);
  });

  it('rolls the jumps once for both targets, and chains from both in one breadth-first chain', () => {
    const { module, hits } = watch();
    // Two lines of 4, 60 apart, from 200 right and 200 left of the player.
    const right = Array.from({ length: 4 }, (_, j) => at(200 + 60 * j, 0));
    const left = Array.from({ length: 4 }, (_, j) => at(-200 - 60 * j, 0));
    const ctx = arcs([...right, ...left], {
      values: { chainCount: 0.5 },
      rules: [SIX_COILS],
      modules: [module],
    });
    const twin = createStreams(1).combat;
    sync(twin, ctx.combatRng);
    const counts: number[] = [];
    for (let d = 0; d < 16; d++) {
      const from = hits.length;
      fire(ctx);
      const jumps = twin.next() < 0.5 ? 3 : 2;
      expect(ctx.combatRng.snapshot()).toEqual(twin.snapshot());
      // Both primaries, then each level: its jump from the right line, then the left's.
      const expected: [number, number][] = [
        [1, 0],
        [5, 0],
      ];
      for (let k = 1; k <= jumps; k++) expected.push([1 + k, k], [5 + k, k]);
      expect(hits.slice(from).map((hit) => [hit.id, hit.k])).toEqual(expected);
      counts.push(jumps);
    }
    expect(new Set(counts)).toEqual(new Set([2, 3]));
  });

  it('shares one CHAIN_HIT_CAP of 32 hits between its two chains, both as deep (C13)', () => {
    const { module, hits } = watch();
    // Two lines of 20, 30 apart, from 200 right and 200 left of the player.
    const right = Array.from({ length: 20 }, (_, j) => at(200 + 30 * j, 0));
    const left = Array.from({ length: 20 }, (_, j) => at(-200 - 30 * j, 0));
    const ctx = arcs([...right, ...left], {
      values: { chainCount: 40 },
      rules: [SIX_COILS],
      modules: [module],
    });
    fire(ctx);
    expect(hits).toHaveLength(CHAIN_HIT_CAP);
    expect(hits.map((hit) => hit.k)).toEqual([
      0,
      0,
      ...Array.from({ length: 30 }, (_, j) => 1 + (j >> 1)),
    ]);
    expect(hits.filter((hit) => hit.id <= 20)).toHaveLength(16);
    // Level 16 refused both its jumps, and the 26 levels under it theirs.
    expect(ctx.counters.chainHitCapped).toBe(2 + 2 * 26);
  });
});

describe('chainJump (§4.3, §4.9)', () => {
  /** Enemy 1 300 right of the player; 2 is 100 from it, and 3 is 130 from 2. */
  const PATH = [at(300, 0), at(360, 80), at(480, 130)];

  it('is raised at each jump hit, after it, never at a primary hit: at its enemy, from the enemy it jumped from, its angle the value', () => {
    const order: string[] = [];
    const spy = jumpSpy();
    const log: TestModule = (b) => {
      b.hook('onHit', (_ctx, hit) => {
        order.push(`hit ${hit.target.id}`);
      });
      b.hook('onCenterEvent', (_ctx, ev) => {
        order.push(`jump ${ev.target?.id}`);
      });
    };
    const ctx = arcs(PATH, { modules: [log, spy.module] });
    fire(ctx);
    expect(order).toEqual(['hit 1', 'hit 2', 'jump 2', 'hit 3', 'jump 3']);
    const [e1, e2, e3] = [enemy(ctx, 1), enemy(ctx, 2), enemy(ctx, 3)];
    const jump = (to: Enemy, from: Enemy): SeenJump => ({
      id: to.id,
      x: to.x,
      y: to.y,
      fromX: from.x,
      fromY: from.y,
      value: Math.atan2(to.y - from.y, to.x - from.x),
      listCount: 0,
      flags: SIGNATURE | CHAIN_JUMP,
      depth: 0,
      origin: -1,
    });
    expect(spy.jumps).toEqual([jump(e2, e1), jump(e3, e2)]);
    expect(spy.jumps.map((j) => j.value)).toEqual([Math.atan2(80, 60), Math.atan2(50, 120)]);
    expect(ctx.chainBudget.centerEvents).toBe(2);
    expect(ctx.centerScratch.value).toBe(Math.atan2(50, 120));
  });

  it('is raised by the jumps the rules add, extra jumps and bounces, a bounce at its own enemy at angle 0', () => {
    const spy = jumpSpy();
    const policy: TestModule = (b) => {
      const spec = b.chainPolicy();
      spec.extraJumpChance = 1;
      spec.bounces = 1;
    };
    // One jump (the chain count -1, and 2 more), then the extra jump it rolled.
    const ctx = arcs([at(300, 0), at(400, 0), at(500, 0)], {
      values: { chainCount: -1 },
      modules: [policy, spy.module],
    });
    fire(ctx);
    expect(spy.jumps.map((j) => [j.id, j.fromX - P.x, j.value])).toEqual([
      [2, 300, 0],
      [3, 400, 0],
    ]);
    const lone = arcs([at(300, -300)], { modules: [policy, spy.module] });
    spy.jumps.length = 0;
    fire(lone);
    expect(eventsOf([lone.events], 'hit').map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
      [1, 0],
      [1, 1],
    ]);
    expect(spy.jumps.map((j) => [j.id, j.fromX - P.x, j.fromY - P.y, j.value])).toEqual([
      [1, 300, -300, 0],
    ]);
  });

  it('reaches a hook-only listener on every jump (F9), and without a listener raises, draws and writes nothing', () => {
    const { module, hits } = watch();
    const spy = jumpSpy();
    const heard = arcs(CLUSTER, { values: { chainCount: 6 }, modules: [module, spy.module] });
    expect([heard.centerEvents.listeners[EVENT.chainJump], heard.centerEvents.hooks]).toEqual([
      0, 1,
    ]);
    fire(heard);
    const jumpIds = hits.filter((hit) => hit.k > 0).map((hit) => hit.id);
    expect(jumpIds).toHaveLength(8);
    expect(spy.jumps.map((j) => j.id)).toEqual(jumpIds);
    expect(heard.chainBudget.centerEvents).toBe(8);

    const quiet = arcs(CLUSTER, { values: { chainCount: 6 } });
    const scratch = quiet.centerScratch;
    Object.assign(scratch, { event: 9, target: enemy(quiet, 3), x: 1, y: 2, fromX: 4, fromY: 6 });
    Object.assign(scratch, { listCount: 2, value: 7, depth: 2, origin: 5, flags: 3 });
    const before = { ...scratch };
    const positions = rngPositions(quiet);
    fire(quiet);
    expect(eventsOf([quiet.events], 'hit')).toHaveLength(9);
    expect({ ...scratch }).toEqual(before);
    expect(rngPositions(quiet)).toEqual(positions);
    expect(quiet.chainBudget.centerEvents).toBe(0);
  });

  it('carries no list: a hook never reads the last explode’s or freeze’s (N5)', () => {
    const counts: number[] = [];
    const spy: TestModule = (b) =>
      b.hook('onCenterEvent', (_ctx, ev) => {
        counts.push(ev.listCount);
      });
    const ctx = arcs(PATH, { modules: [spy] });
    // A list as a freeze leaves it.
    const scratch = ctx.centerScratch;
    scratch.list[0] = enemy(ctx, 3);
    scratch.listCount = 1;
    fire(ctx);
    expect(counts).toEqual([0, 0]);
  });

  it('fires its triggers at 30% × their coefficient: at coef 0.5 a rate of 0.15 ± 0.01, successes ÷ chance draws made (C9, K17)', () => {
    const ctx = arcs(CLUSTER, { values: { chainCount: 29 }, modules: [chainJumpAt(0.5)] });
    const t = ctx.build.triggers[chainJumpTrigger(ctx)] as CompiledTrigger;
    expect([t.chance, t.coef, t.perAttackCap]).toEqual([0.15, 0.5, CHAIN_JUMP_EVENT_CAP]);
    expect(CHAIN_JUMP_CHANCE * 0.5).toBe(0.15);
    const twin = createStreams(1).trigger;
    sync(twin, ctx.triggerRng);
    let successes = 0;
    for (let d = 0; d < 1000; d++) {
      fire(ctx);
      const fired = ctx.effectQueue.size;
      expect(fired).toBeLessThanOrEqual(CHAIN_JUMP_EVENT_CAP);
      successes += fired;
      runEffectQueue(ctx);
    }
    const draws = sync(twin, ctx.triggerRng);
    expect(draws).toBeGreaterThan(15_000);
    expect(Math.abs(successes / draws - 0.15)).toBeLessThan(0.01);
  });

  it('fires a trigger at most 3 times an attack, then passes the attack’s later jumps over, drawing nothing, each counted', () => {
    const log: [boolean, number][] = [];
    let last: readonly number[] = [];
    const FIRST = SHATTER_TRIGGER + 1;
    const spy: TestModule = (b) =>
      b.hook('onCenterEvent', (ctx) => {
        const now = ctx.triggerRng.snapshot();
        log.push([String(now) !== String(last), ctx.triggerState.capCount[FIRST] as number]);
        last = now;
      });
    // Data's chance: 30% (coefficient 1).
    const ctx = arcs(CLUSTER, {
      values: { chainCount: 29 },
      triggers: [{ on: 'chainJump', do: [HEAL] }],
      modules: [spy],
    });
    expect(chainJumpTrigger(ctx)).toBe(FIRST);
    expect((ctx.build.triggers[FIRST] as CompiledTrigger).chance).toBe(0.3);
    let full = 0;
    for (let d = 0; d < 40; d++) {
      log.length = 0;
      last = ctx.triggerRng.snapshot();
      const capped = ctx.counters.centerEventsCapped;
      fire(ctx);
      expect(log).toHaveLength(31);
      const fired = ctx.effectQueue.size;
      runEffectQueue(ctx);
      const third = log.findIndex(([, count]) => count === CHAIN_JUMP_EVENT_CAP);
      if (third < 0) {
        expect(log.every(([drew]) => drew)).toBe(true);
        expect(ctx.counters.centerEventsCapped).toBe(capped);
        continue;
      }
      full++;
      expect(fired).toBe(CHAIN_JUMP_EVENT_CAP);
      expect(log.slice(0, third + 1).every(([drew]) => drew)).toBe(true);
      expect(log.slice(third + 1)).toEqual(Array(30 - third).fill([false, CHAIN_JUMP_EVENT_CAP]));
      expect(ctx.counters.centerEventsCapped).toBe(capped + 30 - third);
    }
    expect(full).toBeGreaterThan(30);
  });

  it('caps each listener on its own, and each attack anew', () => {
    // Coefficient 4: chance 1, nothing drawn.
    const ctx = arcs(CLUSTER, {
      values: { chainCount: 29 },
      modules: [chainJumpAt(4), chainJumpAt(4, { kind: 'heal', lifePct: 0.02 })],
    });
    const [a, b] = [chainJumpTrigger(ctx), chainJumpTrigger(ctx, 1)];
    expect([a, b].map((i) => (ctx.build.triggers[i] as CompiledTrigger).chance)).toEqual([1, 1]);
    const positions = rngPositions(ctx);
    for (let d = 1; d <= 3; d++) {
      fire(ctx);
      const q = ctx.effectQueue;
      const queued = Array.from({ length: q.size }, (_, n) => q.origin[(q.head + n) & q.capMask]);
      expect(queued).toEqual([a, b, a, b, a, b]);
      runEffectQueue(ctx);
      expect(ctx.counters.centerEventsCapped).toBe(d * 2 * (31 - CHAIN_JUMP_EVENT_CAP));
      expect([ctx.triggerState.capSerial[a], ctx.triggerState.capSerial[b]]).toEqual([
        ctx.attackSerial,
        ctx.attackSerial,
      ]);
    }
    expect(rngPositions(ctx)).toEqual(positions);
  });

  it('draws nothing on the combat stream: a run hits and rolls the same with a listener or without', () => {
    const run = (modules: readonly TestModule[]) => {
      const { module, hits } = watch();
      const ctx = arcs(CLUSTER, {
        values: { chainCount: 6.5, critChance: 0.3, igniteChance: 0.3 },
        modules: [...modules, module],
      });
      for (let d = 0; d < 30; d++) {
        fire(ctx);
        runEffectQueue(ctx);
      }
      return { ctx, hits: hits.map((hit) => [hit.id, hit.k, hit.crit]) };
    };
    const quiet = run([]);
    const heard = run([chainJumpAt(1), jumpSpy().module]);
    expect(heard.hits).toEqual(quiet.hits);
    expect(heard.ctx.combatRng.snapshot()).toEqual(quiet.ctx.combatRng.snapshot());
    // The listener drew on the trigger stream alone.
    expect(heard.ctx.triggerRng.snapshot()).not.toEqual(quiet.ctx.triggerRng.snapshot());
    expect(heard.ctx.effectsRng.snapshot()).toEqual(quiet.ctx.effectsRng.snapshot());
  });

  it('is raised by no repeat’s discharge (R25)', () => {
    const spy = jumpSpy();
    const { module, hits } = watch();
    const ctx = repeating(PATH, { modules: [chainJumpAt(4), spy.module, module] });
    fireArcRepeat(ctx, arcOf(ctx), repeatPayloadOf(ctx), 1, 9);
    expect(hits.map((hit) => [hit.id, hit.k])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect([spy.jumps.length, ctx.effectQueue.size, ctx.chainBudget.centerEvents]).toEqual([
      0, 0, 0,
    ]);
    // The arc's own discharge raises one at each jump.
    fire(ctx);
    expect(spy.jumps.map((j) => j.id)).toEqual([2, 3]);
    expect(ctx.effectQueue.size).toBe(2);
  });

  it('cuts a slashLine toward along on along the jump, from the enemy jumped to (F11)', () => {
    // A jump from 1 to 2 at 60°; 3 is on along it, 280 past 2, out of chain range; 4 is behind
    // 1 on the jump's line, 350 back.
    const u = { x: Math.cos(Math.PI / 3), y: Math.sin(Math.PI / 3) };
    const placed = [
      at(300, 0),
      at(300 + 100 * u.x, 100 * u.y),
      at(300 + 380 * u.x, 380 * u.y),
      at(300 - 350 * u.x, -350 * u.y),
    ];
    for (const from of [undefined, 'target'] as const) {
      const slash: SlashLineSpec = {
        kind: 'slashLine',
        length: 300,
        width: 20,
        damagePct: 0.5,
        toward: 'along',
        ...(from === undefined ? {} : { from }),
      };
      const ctx = arcs(placed, { modules: [chainJumpAt(4, slash)] });
      fire(ctx);
      expect(eventsOf([ctx.events], 'hit').map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
        [1, 0],
        [2, 1],
      ]);
      ctx.events.length = 0;
      runEffectQueue(ctx);
      const [cut] = eventsOf([ctx.events], 'slash');
      const start = enemy(ctx, 2);
      expect(cut).toMatchObject({ x1: start.x, y1: start.y, width: 20 });
      expect(cut?.x2).toBeCloseTo(start.x + 300 * u.x, 9);
      expect(cut?.y2).toBeCloseTo(start.y + 300 * u.y, 9);
      // Its own start and 3 on along the jump; not 1 or 4, behind it.
      expect(eventsOf([ctx.events], 'hit').map((hit) => hit.targetId)).toEqual([2, 3]);
    }
  });

  it('is raised at a jump hit that kills its enemy too, at the dead enemy (D14: every jump hit)', () => {
    const spy = jumpSpy();
    // Enemy 2 dies to its jump hit; the chain goes on from it to 3.
    const ctx = arcs([at(300, 0), at(360, 80, { hp: 1 }), at(480, 130)], {
      values: { damage: 10 },
      modules: [spy.module],
    });
    fire(ctx);
    expect(enemy(ctx, 2).alive).toBe(false);
    expect(eventsOf([ctx.events], 'hit').map((hit) => hit.targetId)).toEqual([1, 2, 3]);
    expect(spy.jumps.map((j) => j.id)).toEqual([2, 3]);
    expect(ctx.chainBudget.centerEvents).toBe(2);
  });

  it('caps a listener only on the jumps past its cooldown and conditions (§4.9 order)', () => {
    // Nine squares 60 apart from 300 right of the player, then three hexagons past FOCUS_RANGE
    // (so the first target is enemy 1): 8 jumps to squares, then 3 to hexagons.
    const placed = [
      ...Array.from({ length: 9 }, (_, j) => at(300 + 60 * j, 0)),
      ...Array.from({ length: 3 }, (_, j) => at(840 + 60 * j, 0, { type: 'hexagon' })),
    ];
    const normalOnly: TestModule = (b) =>
      b.addTrigger(
        'fusion.lightning.fire',
        { on: 'chainJump', when: [{ targetKind: 'normal' }], do: [HEAL] },
        4,
      );
    const { module, hits } = watch();
    const ctx = arcs(placed, { values: { chainCount: 10 }, modules: [normalOnly, module] });
    fire(ctx);
    expect(hits.filter((hit) => hit.k > 0).map((hit) => hit.id)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    // Fired at 2, 3 and 4; capped at the five squares after; the hexagons fail the condition.
    expect(ctx.effectQueue.size).toBe(CHAIN_JUMP_EVENT_CAP);
    expect(ctx.counters.centerEventsCapped).toBe(5);
  });

  it('caps a listener before its selector: a capped jump counts whether or not it would pick (§4.9 order)', () => {
    // Six enemies 30 apart from 300 right (each with another within 40), then four 100 apart.
    const placed = [
      ...Array.from({ length: 6 }, (_, j) => at(300 + 30 * j, 0)),
      ...Array.from({ length: 4 }, (_, j) => at(550 + 100 * j, 0)),
    ];
    const near: TestModule = (b) =>
      b.addTrigger(
        'fusion.lightning.fire',
        {
          on: 'chainJump',
          target: { pick: 'nearest', range: 40, excludeEventTarget: true },
          do: [HEAL],
        },
        4,
      );
    const { module, hits } = watch();
    const ctx = arcs(placed, { values: { chainCount: 7 }, modules: [near, module] });
    fire(ctx);
    expect(hits.filter((hit) => hit.k > 0).map((hit) => hit.id)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    // Fired at 2, 3 and 4; capped at the other six jumps, the four whose pick would fail too.
    expect(ctx.effectQueue.size).toBe(CHAIN_JUMP_EVENT_CAP);
    expect(ctx.counters.centerEventsCapped).toBe(6);
  });

  it('leaves no jump angle in the scratch: a center event without a value carries ZERO', () => {
    const values: [number, number][] = [];
    const spy: TestModule = (b) =>
      b.hook('onCenterEvent', (_ctx, ev) => {
        values.push([ev.event, toNumber(ev.value)]);
      });
    const ctx = arcs(PATH, { modules: [spy] });
    fire(ctx);
    const target = enemy(ctx, 3);
    emitCenterEvent(ctx, EVENT.explode, 0, -1, target, target.x, target.y, SIGNATURE);
    expect(values).toEqual([
      [EVENT.chainJump, Math.atan2(80, 60)],
      [EVENT.chainJump, Math.atan2(50, 120)],
      [EVENT.explode, 0],
    ]);
    expect(ctx.centerScratch.value).toBe(ZERO);
  });
});

describe('chainJump triggers at compile (§4.9, N24)', () => {
  const build = (triggers: readonly TriggerSpec[], frost = 0) =>
    compileBuild(plain({ frostOnHit: frost }, triggers), [], TRIPHASE_ARC);

  it('fire chainJump triggers at CHAIN_JUMP_CHANCE × coef, at most 1, CHAIN_JUMP_EVENT_CAP an attack; every other trigger without a cap', () => {
    const compiled = build(
      [
        { on: 'chainJump', do: [HEAL] },
        { on: 'hit', when: [{ chance: 0.5 }], do: [HEAL] },
        { on: 'explode', do: [HEAL] },
      ],
      0.1,
    );
    // The shatter's (the build can freeze) listens to kills.
    expect(compiled.triggers.map((t) => [t.on, t.chance, t.perAttackCap])).toEqual([
      [EVENT.kill, 1, 0],
      [EVENT.chainJump, 0.3, CHAIN_JUMP_EVENT_CAP],
      [EVENT.hit, 0.5, 0],
      [EVENT.explode, 1, 0],
    ]);
    const coefs = compileBuild(plain(), [], TRIPHASE_ARC, [
      chainJumpAt(2),
      chainJumpAt(4),
      (b) => b.hook('tick', () => undefined),
    ]);
    expect(coefs.triggers.map((t) => [t.on, t.chance, t.perAttackCap])).toEqual([
      [-1, 1, 0],
      [EVENT.chainJump, 0.6, CHAIN_JUMP_EVENT_CAP],
      [EVENT.chainJump, 1, CHAIN_JUMP_EVENT_CAP],
      [-1, 1, 0],
    ]);
  });

  it('refuses a chance condition on a chainJump trigger', () => {
    expect(() => build([{ on: 'chainJump', when: [{ chance: 0.5 }], do: [HEAL] }])).toThrow(
      'A chainJump trigger fires at CHAIN_JUMP_CHANCE: it takes no chance condition',
    );
  });

  it('give every trigger state of the run a cap count and serial, 0 at the start', () => {
    const ctx = arcs([], { triggers: [{ on: 'chainJump', do: [HEAL] }] });
    expect(Array.from(ctx.triggerState.capCount)).toEqual([0, 0]);
    expect(Array.from(ctx.triggerState.capSerial)).toEqual([0, 0]);
    expect(ctx.counters.centerEventsCapped).toBe(0);
  });
});

/** Runs the build's n-th repeatAttack effect at `depth` from trigger `origin`. */
function runRepeatEffect(ctx: RunContext, n = 0, depth = 1, origin = 9): void {
  const entry = createEffectEntry();
  entry.effect = repeatEffectOf(ctx, n);
  entry.depth = depth;
  entry.origin = origin;
  entry.flags = SIGNATURE | HIT_EVENT;
  runEffect(ctx, entry);
}

describe('arc repeats (fireArcRepeat; §4.15, Q5 (A))', () => {
  const arcCounts = (em: EmitterRuntime) => ({
    attacks: em.attacks,
    shots: em.shots,
    volley: em.volley,
    acc: em.acc,
  });

  it('is the arc’s repeat step', () => {
    expect(REPEAT_STEPS.triphaseArc).toBe(fireArcRepeat);
  });

  it('discharges the repeat’s payload at the M1 picker’s target, never steady, as no attack or shot, at its depth and origin', () => {
    const { module, hits } = watch();
    // The boss 400 out is the focus target; the square 200 out is not in its chain range.
    const ctx = repeating([at(200, 0), at(0, -400, { type: 'boss' })], {
      rules: [steadyAim('shot', 1)],
      modules: [module],
    });
    const em = arcOf(ctx);
    const before = arcCounts(em);
    fireArcRepeat(ctx, em, repeatPayloadOf(ctx), 2, 9);
    expect(
      hits.map((hit) => [
        hit.id,
        hit.k,
        hit.crit,
        hit.depth,
        hit.origin,
        hit.flags & (SIGNATURE | REPEAT | PRIMARY),
      ]),
    ).toEqual([[2, 0, false, 2, 9, SIGNATURE | REPEAT | PRIMARY]]);
    expect(arcCounts(em)).toEqual(before);
    expect([discharges(ctx), em.coil]).toEqual([[[0, 2]], 1]);
    // The arc's own next discharge is steady.
    fire(ctx);
    expect(hits.slice(1).map((hit) => hit.crit)).toEqual([true]);
  });

  it('rolls its jumps on the repeat payload’s stream, the effects stream; nothing on combat', () => {
    const line = Array.from({ length: 6 }, (_, j) => at(300 + 60 * j, 0));
    const ctx = repeating(line, { values: { chainCount: 0.5 } });
    const twin = createStreams(1).effects;
    sync(twin, ctx.effectsRng);
    const combat = ctx.combatRng.snapshot();
    const counts: number[] = [];
    for (let r = 0; r < 16; r++) {
      ctx.events.length = 0;
      fireArcRepeat(ctx, arcOf(ctx), repeatPayloadOf(ctx), 1, 9);
      const jumps = twin.next() < 0.5 ? 3 : 2;
      expect(ctx.effectsRng.snapshot()).toEqual(twin.snapshot());
      expect(eventsOf([ctx.events], 'hit')).toHaveLength(jumps + 1);
      counts.push(jumps);
    }
    expect(new Set(counts)).toEqual(new Set([2, 3]));
    expect(ctx.combatRng.snapshot()).toEqual(combat);
    // No enemy: no discharge, nothing drawn.
    const empty = repeating([], { values: { chainCount: 0.5 } });
    const before = rngPositions(empty);
    fireArcRepeat(empty, arcOf(empty), repeatPayloadOf(empty), 1, 9);
    expect([empty.events.length, arcOf(empty).coil]).toEqual([0, 0]);
    expect(rngPositions(empty)).toEqual(before);
  });

  it('strikes two targets under 六線圈 (F12)', () => {
    const { module, hits } = watch();
    const ctx = repeating([at(300, 0), at(-300, 0)], { rules: [SIX_COILS], modules: [module] });
    fireArcRepeat(ctx, arcOf(ctx), repeatPayloadOf(ctx), 1, 9);
    expect(discharges(ctx)).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(hits.map((hit) => [hit.id, hit.flags & (REPEAT | PRIMARY)])).toEqual([
      [1, REPEAT | PRIMARY],
      [2, REPEAT | PRIMARY],
    ]);
  });

  it('is what repeatAttack fires now for the arc: count discharges, no volley', () => {
    const twice: TriggerSpec = {
      on: 'periodic',
      every: 1000,
      do: [{ kind: 'repeatAttack', count: 2, damagePct: 0.5 }],
    };
    const ctx = repeating([at(300, 0)], { triggers: [twice] });
    const before = arcCounts(arcOf(ctx));
    runRepeatEffect(ctx, 2, 3, 5);
    expect([ctx.projectiles.length, ctx.shots.count]).toEqual([0, 0]);
    expect(discharges(ctx)).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(arcCounts(arcOf(ctx))).toEqual(before);
  });

  it('fires the waiting repeats right after a discharge, as discharges of their own', () => {
    const { module, hits } = watch();
    const ctx = repeating([at(300, 0)], { modules: [module] });
    runRepeatEffect(ctx, 1, 2, 7);
    expect(ctx.sys.repeat.charges.count).toBe(1);
    fire(ctx);
    expect(hits.map((hit) => [hit.id, hit.depth, hit.origin, hit.flags & REPEAT])).toEqual([
      [1, 0, -1, 0],
      [1, 2, 7, REPEAT],
    ]);
    expect(discharges(ctx)).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(arcCounts(arcOf(ctx))).toMatchObject({ attacks: 1, shots: 1 });
    expect(ctx.sys.repeat.charges.count).toBe(0);
  });

  it('picks afresh, as the discharge picks its first target: a waiting repeat under 六線圈 strikes the discharge’s first again first', () => {
    // Three squares, each out of the others' chain range: 200, 300 and 400 from the player.
    const ctx = repeating([at(200, 0), at(-300, 0), at(0, 400)], { rules: [SIX_COILS] });
    runRepeatEffect(ctx, 1, 2, 7);
    fire(ctx);
    // The discharge at 1 and 2; its repeat at 1 and 2 again, not at 2 and 3.
    expect(discharges(ctx)).toEqual([
      [0, 1],
      [1, 2],
      [2, 1],
      [3, 2],
    ]);
  });

  it('discharges a given payload from fireDischarge, which picks nothing for one target', () => {
    const ctx = arcs([at(300, 0), at(-300, 0)]);
    const em = arcOf(ctx);
    fireDischarge(ctx, em, enemy(ctx, 2), em.payload, false, 0, -1);
    expect(discharges(ctx)).toEqual([[0, 2]]);
  });
});

describe('arc runs', () => {
  it('runs ten seconds of waves from wave 8 the same twice, its chainJump slashes along', () => {
    const config = makeConfig({
      stats: plain({ chainCount: 1.5, critChance: 0.2, igniteChance: 0.2 }, [
        {
          on: 'chainJump',
          do: [{ kind: 'slashLine', length: 200, width: 20, damagePct: 0.3, toward: 'along' }],
        },
      ]),
      rules: [SIX_COILS],
      signature: TRIPHASE_ARC,
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
    expect(eventsOf([first], 'discharge').length).toBeGreaterThan(50);
    expect(eventsOf([first], 'slash').length).toBeGreaterThan(10);
    expect(eventsOf([first], 'enemyKilled').length).toBeGreaterThan(10);
    expect(runOnce()).toEqual(first);
  });
});
