/**
 * The combo stacks and the timed buffs (docs/v3/game-design-v3.md §4.5, docs/v3 C6 design §7.4
 * C6b.2, src/sim/systems/combo.ts): the stacks' gains, cap, idle decay and loss on a hit (lead
 * rulings K1–K3), the comboStacks variable (K4), and the cadence, 冰霜's factor × the combo
 * factor of attackSpeed's per-instance modifiers × the buffs' (K5–K7). Each test names in a
 * comment the planted bug it kills.
 *
 * The enemies stand still on the line to the player's right unless a test moves them; a leak is
 * an enemy whose distance a test sets to 0 before the contact step. dispatch's fire is wrapped,
 * calling through, to record the stacks as each heroHit is raised.
 */

import { describe, expect, it, vi } from 'vitest';
import { toNumber } from '../../core/num';
import { AFFIX_FROST } from '../../data/affixes';
import type { SourcedEmitter } from '../../data/emitters';
import { M1_SIGNATURE } from '../../data/rules';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import { BASE_STATS, NO_EXTRAS } from '../../data/stats';
import type { Modifier, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { DamageTag } from '../../data/tags';
import type { EffectSpec, TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { computeStatBlock } from '../../meta/stats';
import { compileBuild, DEFAULT_COMBO_CAP } from '../build/compile';
import type { BuildFlags } from '../build/compile';
import type * as Dispatch from '../effects/dispatch';
import { runEffect, runEffectQueue } from '../effects/execute';
import { HIT_EVENT, SIGNATURE } from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import { runArc } from '../emitters/arc';
import type { EmitterRuntime } from '../emitters/types';
import { runVolley } from '../emitters/volley';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  afterimageModule,
  centerTriggers,
  damageRow,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  stationarySquares,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DRONE_KIND_TURRET, NO_INPUT, TICK_RATE } from '../types';
import type { SimEvent } from '../types';
import { FROST_CADENCE, FROST_RANGE } from './affixes';
import { fireBullet, stepBullets } from './bullets';
import { addComboStacks, gainComboOnAttack, stepCombo } from './combo';
import { resolveContacts } from './contact';
import type { Enemy, RunContext, WaveRecord } from './context';
import { removeEnemy } from './death';
import { stepDrones } from './drones';
import { runEmitters } from './emitters';
import { stepEnemyAi } from './enemyAi';
import { rebuildGrid } from './grid';
import { addEnemy } from './spawn';

/** The stacks as each heroHit was raised: dispatch's fire, wrapped and otherwise unchanged. */
const heroHits = vi.hoisted(() => ({ seen: [] as number[] }));

vi.mock('../effects/dispatch', async (importOriginal) => {
  const original = await importOriginal<typeof Dispatch>();
  const { EVENT } = await import('../effects/types');
  return {
    ...original,
    fire: (...args: Parameters<typeof original.fire>): void => {
      const [ctx, event] = args;
      if (event === EVENT.heroHit) heroHits.seen.push(ctx.sys.combo.stacks);
      original.fire(...args);
    },
  };
});

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
/** An enemy `dx` to the player's right. */
const at = (dx: number, extra: Partial<PlacedEnemy> = {}): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y,
  ...extra,
});

/** One projectile an attack, no crits, ignites or chains, landing on its first step. */
const VOLLEY = {
  critChance: 0,
  igniteChance: 0,
  chainCount: 0,
  projectileCount: 1,
  projectileSpeed: 120_000,
};

/** attackSpeed × (1 + 0.03 per stack): gd §4.5's 「每層 +3% 攻速」 as a modifier. */
const SPEED_PER_STACK: Modifier = {
  stat: 'attackSpeed',
  kind: 'more',
  value: 0.03,
  scaling: { per: 'comboStacks' },
};
/** damage +2 % increased per stack: gd §4.5's 「+2% 傷害」. */
const DAMAGE_PER_STACK: Modifier = {
  stat: 'damage',
  kind: 'increased',
  value: 0.02,
  scaling: { per: 'comboStacks' },
};

/** An untagged buff effect: every cadence reader's attackSpeed × (1 + more) for durationSec. */
const buff = (more: number, durationSec: number): EffectSpec => ({
  kind: 'buff',
  stat: 'attackSpeed',
  more,
  durationSec,
});
/** 超頻 as K6 writes it: × 3 for 2 s on the minion emitters. */
const OVERCLOCK: EffectSpec = {
  kind: 'buff',
  stat: 'attackSpeed',
  more: 2,
  durationSec: 2,
  tags: ['minion'],
};

/** A trigger that never fires in these tests, so its effects run only where a test runs them. */
const idle = (...effects: EffectSpec[]): TriggerSpec => ({
  on: 'periodic',
  every: 1000,
  do: effects,
});

/** A granted drone, whose payload carries minion. */
const DRONE: SourcedEmitter = { source: 'outer.summon', grant: { kind: 'drone', drones: 1 } };

/** The emitters of fixed periods: an aura, a 0.5 s strike and an orbit of three orbs. */
const PERIODIC: readonly SourcedEmitter[] = [
  { source: 'outer.aura', grant: { kind: 'aura' } },
  {
    source: 'outer.lightning',
    grant: {
      kind: 'strike',
      name: 'bolt',
      periodSec: 0.5,
      target: { pick: 'nearest' },
      damagePct: 1,
    },
  },
  { source: 'outer.aura', grant: { kind: 'orbit', count: 3 } },
];
/** The tags of their hits, one each. */
const PERIODIC_TAGS = TAG.aura | TAG.strike | TAG.orbit;

/** A test module that writes these build flags, as a keystone's module would. */
const flagsOf =
  (flags: Partial<BuildFlags>): TestModule =>
  (b) => {
    Object.assign(b.flags, flags);
  };
/** Keeps the stacks at BuildFlags' defaults: cap 20, all gone after 60 idle ticks, half on a hit. */
const KEEP = flagsOf({ combo: true });

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly mods?: readonly Modifier[];
  readonly triggers?: readonly TriggerSpec[];
  readonly grants?: readonly SourcedEmitter[];
  readonly modules?: readonly TestModule[];
  readonly rules?: readonly RuleSpec[];
  readonly signature?: SignatureSpec;
  readonly data?: GameData;
}

/** placedEnemies over VOLLEY's stats, the triggers credited to the center. */
function run(placed: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(placed, {
    stats: makeStats({ ...VOLLEY, ...options.values }, options.mods ?? [], {
      triggers: (options.triggers ?? []).map((spec) => ({ source: 'center', spec })),
      conversions: [],
      emitters: options.grants ?? [],
    }),
    rules: options.rules ?? [],
    modules: options.modules ?? [],
    ...(options.signature === undefined ? {} : { signature: options.signature }),
    ...(options.data === undefined ? {} : { data: options.data }),
  });
}

/**
 * v3 data whose waves hold no enemy, elite, affix or treasure, so only the enemies a test places
 * or adds exist, for the shooters' bullets and 冰霜.
 */
const quietV3 = (): GameData =>
  v3TestData({
    waves: {
      rules: [{ enemy: 'triangle', fromWave: 1, base: 0, perWave: 0, maxCount: 0 }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
      },
    },
  });

const signatureOf = (ctx: RunContext): EmitterRuntime => ctx.emitters[0] as EmitterRuntime;
const stacksOf = (ctx: RunContext): number => ctx.sys.combo.stacks;
const cadences = (ctx: RunContext): number[] => ctx.emitters.map((em) => em.cadence);

/** Makes one attack of the signature volley due and runs the volley, which fires it. */
function attack(ctx: RunContext): void {
  const em = signatureOf(ctx);
  em.acc = em.interval - em.cadence;
  runVolley(ctx, em);
}

/** Runs the build's n-th effect of `kind` as its trigger queues it, at the player. */
function runKind(ctx: RunContext, kind: EffectSpec['kind'], n = 0): void {
  const found = ctx.build.effects.flatMap((fx, i) => (fx.kind === kind ? [i] : []));
  const effect = found[n];
  if (effect === undefined) throw new Error(`no ${kind} effect ${n}`);
  const trigger = ctx.build.triggers.find((t) => t.effectStart <= effect && effect < t.effectEnd);
  if (trigger === undefined) throw new Error(`no trigger of effect ${effect}`);
  const entry = createEffectEntry();
  entry.effect = effect;
  entry.depth = 1;
  entry.origin = trigger.index;
  entry.flags = SIGNATURE | HIT_EVENT;
  entry.x = PLAYER.x;
  entry.y = PLAYER.y;
  runEffect(ctx, entry);
}

/** `enemy` reaches the player on this contact step and leaks. */
function leak(ctx: RunContext, enemy: Enemy): void {
  enemy.dist = 0;
  resolveContacts(ctx);
}

/** `count` combo-step ticks from ctx.now on, ctx.now moving on with each. */
function idleTicks(ctx: RunContext, count: number): void {
  for (let i = 0; i < count; i++) {
    ctx.now++;
    stepCombo(ctx);
  }
}

/** An enemy of the fixture's square added to the open wave `dist` to the player's right. */
function addSquare(ctx: RunContext, dist: number): Enemy {
  addEnemy(ctx, ctx.data.enemies.square, ctx.current as WaveRecord, 1, 0, dist);
  rebuildGrid(ctx);
  return ctx.enemies.at(-1) as Enemy;
}

describe('the stacks (lead rulings K1, K2)', () => {
  it('gains 1 per counted signature attack: a repeat and a granted emitter gain none', () => {
    // Plants the repeats counted (fireVolleyRepeat gaining a stack) and the emitter index
    // dropped from gainComboOnAttack.
    const ctx = run([at(300), at(-300)], {
      modules: [KEEP],
      triggers: [idle({ kind: 'repeatAttack', count: 2, damagePct: 0.5 })],
      grants: [DRONE],
    });
    expect([ctx.build.flags.combo, stacksOf(ctx), ctx.evalInput.comboStacks]).toEqual([true, 0, 0]);
    attack(ctx);
    expect([stacksOf(ctx), ctx.evalInput.comboStacks]).toEqual([1, 1]);
    const fired = ctx.projectiles.length;
    runKind(ctx, 'repeatAttack');
    // The repeat fired its two projectiles, and counted nothing.
    expect(ctx.projectiles.length).toBe(fired + 2);
    expect([signatureOf(ctx).attacks, stacksOf(ctx)]).toEqual([1, 1]);
    attack(ctx);
    expect(stacksOf(ctx)).toBe(2);
    const drone = ctx.emitters[1] as EmitterRuntime;
    expect(drone.spec.kind).toBe('drone');
    gainComboOnAttack(ctx, drone);
    expect([stacksOf(ctx), ctx.evalInput.comboStacks]).toEqual([2, 2]);
  });

  it('counts every counted attack of a run, with its repeats and a granted drone, and nothing else', () => {
    // Plants the repeats counted: the stacks would pass the attacks.
    const seen: [number, number][] = [];
    const watch: TestModule = (b) => {
      Object.assign(b.flags, {
        combo: true,
        comboCap: Infinity,
        comboIdleTicks: 1e9,
        comboHitKeep: 1,
      });
      b.hook('tick', (ctx) => {
        seen.push([ctx.sys.combo.stacks, signatureOf(ctx).attacks]);
      });
    };
    const data = makeTestData({
      enemies: { square: { hpMult: 1e12, speed: 60 } },
      waves: {
        rules: [{ enemy: 'square', fromWave: 1, base: 6, perWave: 0, maxCount: 6 }],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
        waveTimerSec: 1000,
      },
    });
    const config = makeConfig({
      seed: 3,
      stats: makeStats({ ...VOLLEY, projectileSpeed: 900 }, [], {
        triggers: [
          {
            source: 'center',
            spec: {
              on: 'nthAttack',
              every: 1,
              do: [{ kind: 'repeatAttack', count: 2, damagePct: 0.5 }],
            },
          },
        ],
        conversions: [],
        emitters: [DRONE],
      }),
    });
    const sim = createSimulation(config, data, [watch]);
    const events: SimEvent[] = [];
    for (let t = 0; t < 600; t++) events.push(...sim.step(NO_INPUT));
    const [stacks, attacks] = seen.at(-1) as [number, number];
    expect(attacks).toBeGreaterThan(10);
    expect(seen.every(([s, a]) => s === a)).toBe(true);
    expect(stacks).toBe(attacks);
    // The repeats fired (two projectiles of each attack beside its own), and so did the drone.
    expect(events.filter((e) => e.type === 'attack').length).toBeGreaterThanOrEqual(2 * attacks);
    expect(events.some((e) => e.type === 'impact')).toBe(true);
  });

  it('stops at the cap, 20, and a comboStack effect clamps to it', () => {
    // Plants the cap dropped from gainComboOnAttack, then from addComboStacks.
    const ctx = run([at(300)], {
      modules: [KEEP],
      triggers: [idle({ kind: 'comboStack', stacks: 5 })],
    });
    expect(ctx.build.flags.comboCap).toBe(20);
    for (let i = 0; i < 25; i++) attack(ctx);
    expect([signatureOf(ctx).attacks, stacksOf(ctx)]).toEqual([25, 20]);
    leak(ctx, addSquare(ctx, 200));
    expect(stacksOf(ctx)).toBe(10);
    runKind(ctx, 'comboStack');
    expect(stacksOf(ctx)).toBe(15);
    runKind(ctx, 'comboStack');
    expect([stacksOf(ctx), ctx.evalInput.comboStacks]).toEqual([20, 20]);
    runKind(ctx, 'comboStack');
    expect(stacksOf(ctx)).toBe(20);
  });

  it('clamps a comboStack effect to a module’s cap, not to 20', () => {
    // Plants addComboStacks clamping at 20 rather than at BuildFlags.comboCap: ★無盡連擊's
    // effects would stop at 20, and a cap of 25 would read 20.
    const stacked = (comboCap: number): number => {
      const ctx = run([at(300)], {
        modules: [flagsOf({ combo: true, comboCap })],
        triggers: [idle({ kind: 'comboStack', stacks: 15 })],
      });
      runKind(ctx, 'comboStack');
      runKind(ctx, 'comboStack');
      expect(ctx.evalInput.comboStacks).toBe(stacksOf(ctx));
      return stacksOf(ctx);
    };
    expect([stacked(Infinity), stacked(25)]).toEqual([30, 25]);
  });

  it('★無盡連擊 (comboCap Infinity, comboHitKeep 0): 30 attacks give 30 stacks, and a hit takes them all', () => {
    // Plants a cap of 20 kept under the module's Infinity, and comboHitKeep read as 0.5.
    const ctx = run([at(300)], {
      modules: [flagsOf({ combo: true, comboCap: Infinity, comboHitKeep: 0 })],
    });
    for (let i = 0; i < 30; i++) attack(ctx);
    expect(stacksOf(ctx)).toBe(30);
    leak(ctx, addSquare(ctx, 200));
    expect([stacksOf(ctx), ctx.evalInput.comboStacks]).toEqual([0, 0]);
  });

  it('keeps no stacks without BuildFlags.combo: attacks, ticks and hits leave them at 0', () => {
    // Plants gainComboOnAttack and loseComboOnHit called without the flag: an M1 build would
    // count stacks.
    const ctx = run([at(300)], { mods: [{ ...DAMAGE_PER_STACK, scaling: { per: 'chainJump' } }] });
    expect([ctx.build.flags.combo, ctx.sys.combo.ticks]).toEqual([false, false]);
    for (let i = 0; i < 3; i++) attack(ctx);
    leak(ctx, addSquare(ctx, 200));
    expect([stacksOf(ctx), ctx.sys.combo.idle, ctx.evalInput.comboStacks]).toEqual([0, 0, 0]);
    expect(cadences(ctx)).toEqual([1]);
  });
});

describe('the idle decay (lead ruling K3)', () => {
  it('keeps the stacks through 59 ticks without a target and clears them on the 60th, at each multiple', () => {
    // Plants the clear at 59 idle ticks, then at 61.
    const ctx = run([], { modules: [KEEP] });
    addComboStacks(ctx, 7);
    idleTicks(ctx, 59);
    expect([stacksOf(ctx), ctx.sys.combo.idle]).toEqual([7, 59]);
    idleTicks(ctx, 1);
    expect([stacksOf(ctx), ctx.sys.combo.idle, ctx.evalInput.comboStacks]).toEqual([0, 60, 0]);
    addComboStacks(ctx, 5);
    idleTicks(ctx, 59);
    expect(stacksOf(ctx)).toBe(5);
    idleTicks(ctx, 1);
    expect([stacksOf(ctx), ctx.sys.combo.idle]).toEqual([0, 120]);
  });

  it('starts the count again on a tick with a target', () => {
    // Plants the count kept through a tick that has a target: the stacks would go at tick 60.
    const ctx = run([at(300)], { modules: [KEEP] });
    addComboStacks(ctx, 7);
    removeEnemy(ctx, ctx.enemies[0] as Enemy);
    idleTicks(ctx, 59);
    expect(ctx.sys.combo.idle).toBe(59);
    const enemy = addSquare(ctx, 300);
    idleTicks(ctx, 1);
    expect([stacksOf(ctx), ctx.sys.combo.idle]).toEqual([7, 0]);
    removeEnemy(ctx, enemy);
    idleTicks(ctx, 59);
    expect([stacksOf(ctx), ctx.sys.combo.idle]).toEqual([7, 59]);
    idleTicks(ctx, 1);
    expect(stacksOf(ctx)).toBe(0);
  });

  it('counts on through a wave’s start: only a tick with a target starts it again', () => {
    // Plants the count reset when a wave starts: these empty waves start one a tick, and the
    // stacks would never go.
    const seen: [number, number, number][] = [];
    const watch: TestModule = (b) => {
      Object.assign(b.flags, { combo: true });
      b.hook('tick', (ctx) => {
        if (ctx.now === 1) addComboStacks(ctx, 7);
        seen.push([ctx.now, (ctx.current as WaveRecord).wave, stacksOf(ctx)]);
      });
    };
    const data = makeTestData({
      waves: {
        rules: [{ enemy: 'square', fromWave: 1, base: 0, perWave: 0, maxCount: 0 }],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
        waveTimerSec: 1000,
      },
    });
    const sim = createSimulation(makeConfig({ stats: makeStats(VOLLEY) }), data, [watch]);
    for (let t = 0; t < 90; t++) sim.step(NO_INPUT);
    // Wave n starts on tick n. The stacks, added on tick 1 after its combo step, go on the 60th
    // idle tick, tick 60.
    expect(seen.length).toBe(90);
    expect(seen.every(([tick, wave]) => wave === tick)).toBe(true);
    expect(seen.map(([, , stacks]) => stacks)).toEqual([
      ...Array<number>(59).fill(7),
      ...Array<number>(31).fill(0),
    ]);
  });

  it('decays at each multiple of BuildFlags.comboIdleTicks', () => {
    // Plants the multiple fixed at 60: a module's 30 would keep the stacks through tick 59.
    const ctx = run([], { modules: [flagsOf({ combo: true, comboIdleTicks: 30 })] });
    addComboStacks(ctx, 7);
    idleTicks(ctx, 29);
    expect(stacksOf(ctx)).toBe(7);
    idleTicks(ctx, 1);
    expect([stacksOf(ctx), ctx.sys.combo.idle]).toEqual([0, 30]);
  });

  it('◆慣性 (comboIdleKeep 0.75): 20 → 15 → 11 at 60 and 120 idle ticks, floored, never below 1', () => {
    // Plants the floor dropped: 15 × 0.75 would leave 11.25.
    const ctx = run([], { modules: [flagsOf({ combo: true, comboIdleKeep: 0.75 })] });
    addComboStacks(ctx, 20);
    const seen: number[] = [];
    for (let k = 0; k < 11; k++) {
      idleTicks(ctx, 59);
      expect(stacksOf(ctx)).toBe(seen.at(-1) ?? 20);
      idleTicks(ctx, 1);
      seen.push(stacksOf(ctx));
    }
    // floor(1 × 0.75) is 0, but 「不會歸零」 (gd:421) keeps the last one.
    expect(seen).toEqual([15, 11, 8, 6, 4, 3, 2, 1, 1, 1, 1]);
  });

  it('keeps at least 1 only for a keep above 0, and only while any stack is left', () => {
    // Plants the floor of 1 applied at keep 0, or to a combo that has no stack.
    const clear = run([], { modules: [flagsOf({ combo: true, comboIdleKeep: 0 })] });
    addComboStacks(clear, 1);
    idleTicks(clear, 60);
    expect(stacksOf(clear)).toBe(0);
    const empty = run([], { modules: [flagsOf({ combo: true, comboIdleKeep: 0.75 })] });
    idleTicks(empty, 120);
    expect(stacksOf(empty)).toBe(0);
    const one = run([], { modules: [flagsOf({ combo: true, comboIdleKeep: 0.1 })] });
    addComboStacks(one, 9);
    idleTicks(one, 60);
    expect(stacksOf(one)).toBe(1);
  });

  it('asks a far bomb and a swarm without a turret for an enemy inside the arena, as their picks do', () => {
    // Plants signatureHasTarget reduced to aliveCount: the far bomb and the drones would have a
    // target outside the arena.
    const outside = { x: -40, y: PLAYER.y };
    const volley = run([outside], { modules: [KEEP] });
    idleTicks(volley, 3);
    expect(volley.sys.combo.idle).toBe(0);
    // 遠投 on every second bomb: the next bomb is shot em.shots + 1.
    const farEvery: TestModule = (b) => {
      const lob = b.signature().lob;
      if (lob !== null) lob.farThrowEvery = 2;
    };
    const lob = run([outside], { modules: [KEEP, farEvery], signature: { id: 'magmaBomb' } });
    idleTicks(lob, 3);
    expect(lob.sys.combo.idle).toBe(0);
    signatureOf(lob).shots = 1;
    idleTicks(lob, 3);
    expect(lob.sys.combo.idle).toBe(3);
    addSquare(lob, 300);
    idleTicks(lob, 1);
    expect(lob.sys.combo.idle).toBe(0);
    const swarm = (drones: number, turrets: number): RunContext => {
      const counts: TestModule = (b) => {
        const params = b.signature().swarm;
        if (params !== null) Object.assign(params, { drones, turrets });
      };
      return run([outside], { modules: [KEEP, counts], signature: { id: 'swarm' } });
    };
    const drones = swarm(2, 0);
    expect(drones.sys.combo.inArenaOnly).toBe(true);
    idleTicks(drones, 3);
    expect(drones.sys.combo.idle).toBe(3);
    const turrets = swarm(1, 1);
    expect(turrets.sys.combo.inArenaOnly).toBe(false);
    idleTicks(turrets, 3);
    expect(turrets.sys.combo.idle).toBe(0);
  });

  /** A swarm signature of two drones and no turret. */
  const droneSwarm: TestModule = (b) => {
    const params = b.signature().swarm;
    if (params !== null) Object.assign(params, { drones: 2, turrets: 0 });
  };

  it('takes an enemy on the arena’s edges as inside, as the drones’ and the far bomb’s picks do', () => {
    // Plants the edges left out of the arena (x < ARENA_WIDTH, y < ARENA_HEIGHT, or x > 0):
    // outOfArena (drones.ts) and aimFar (lob.ts) keep an enemy whose center is on them.
    const idleAt = (x: number, y: number): number => {
      const ctx = run([{ x, y }], { modules: [KEEP, droneSwarm], signature: { id: 'swarm' } });
      expect(ctx.sys.combo.inArenaOnly).toBe(true);
      idleTicks(ctx, 3);
      return ctx.sys.combo.idle;
    };
    expect([
      idleAt(ARENA_WIDTH, PLAYER.y),
      idleAt(PLAYER.x, ARENA_HEIGHT),
      idleAt(0, 0),
      idleAt(ARENA_WIDTH + 1, PLAYER.y),
      idleAt(PLAYER.x, ARENA_HEIGHT + 1),
      idleAt(-1, PLAYER.y),
    ]).toEqual([0, 0, 0, 3, 3, 3]);
  });

  it('asks a swarm for an enemy inside the arena when only a granted emitter has turrets', () => {
    // Plants every turret row counted for the signature: the granted drone emitter's turret
    // would let the swarm's drones count an enemy outside the arena.
    const ctx = run([{ x: -40, y: PLAYER.y }], {
      modules: [KEEP, droneSwarm],
      signature: { id: 'swarm' },
      grants: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 1, turrets: 1 } }],
    });
    const ds = ctx.sys.drones;
    const rows = Array.from({ length: ds.count }, (_, s) => [ds.owner[s], ds.kind[s]]);
    expect(rows).toContainEqual([1, DRONE_KIND_TURRET]);
    expect(rows).not.toContainEqual([0, DRONE_KIND_TURRET]);
    expect(ctx.sys.combo.inArenaOnly).toBe(true);
    idleTicks(ctx, 3);
    expect(ctx.sys.combo.idle).toBe(3);
  });
});

describe('a hit on the player (lead ruling K3)', () => {
  it('halves the stacks, floored, at a leak: 7 → 3 → 1 → 0', () => {
    // Plants comboHitKeep read as comboIdleKeep (0): the first leak would leave 0.
    // Plants the halving after the heroHit fire: heroHit would be raised at 7, 3 and 1.
    const ctx = run([], { modules: [KEEP] });
    addComboStacks(ctx, 7);
    heroHits.seen.length = 0;
    const seen = [1, 2, 3].map(() => {
      leak(ctx, addSquare(ctx, 200));
      return stacksOf(ctx);
    });
    expect(seen).toEqual([3, 1, 0]);
    expect(heroHits.seen).toEqual([3, 1, 0]);
    expect(ctx.evalInput.comboStacks).toBe(0);
  });

  it('halves them at a bullet’s hit: 7 → 3', () => {
    // Plants the halving left out of stepBullets, or after its heroHit fire (raised at 7).
    const ctx = run([at(400, { type: 'shooter' })], { modules: [KEEP], data: quietV3() });
    addComboStacks(ctx, 7);
    fireBullet(ctx, ctx.enemies[0] as Enemy);
    const pool = ctx.sys.bullets;
    pool.x[0] = PLAYER.x;
    pool.y[0] = PLAYER.y;
    ctx.events.length = 0;
    heroHits.seen.length = 0;
    stepBullets(ctx);
    expect(ctx.events.map((e) => e.type)).toEqual(['bulletHit']);
    expect(stacksOf(ctx)).toBe(3);
    expect(heroHits.seen).toEqual([3]);
  });

  it('halves them before heroHit’s triggers run, a hit the shield takes whole included', () => {
    // Plants the halving after heroHit's effects: its comboStack would be halved with the rest
    // (4, not 5). Halving right after the fire is caught above: fire only queues the effects.
    const ctx = run([], {
      modules: [KEEP],
      triggers: [
        { on: 'heroHit', do: [{ kind: 'comboStack', stacks: 2 }] },
        idle({ kind: 'shield', lifePct: 0.1 }),
      ],
    });
    addComboStacks(ctx, 7);
    ctx.player.shield = 1e9;
    ctx.events.length = 0;
    leak(ctx, addSquare(ctx, 200));
    expect(ctx.events.map((e) => e.type)).toContain('shieldAbsorbed');
    expect(ctx.player.life).toBe(ctx.player.maxLife);
    expect(stacksOf(ctx)).toBe(3);
    runEffectQueue(ctx);
    expect(stacksOf(ctx)).toBe(5);
  });

  it('halves them at a bullet the shield takes whole, which raises heroHit too', () => {
    // Plants the bullet's halving only where the player loses life: the stacks would stay at 7.
    const ctx = run([at(400, { type: 'shooter' })], {
      modules: [KEEP],
      data: quietV3(),
      triggers: [idle({ kind: 'shield', lifePct: 0.1 })],
    });
    addComboStacks(ctx, 7);
    ctx.player.shield = 1e9;
    fireBullet(ctx, ctx.enemies[0] as Enemy);
    const pool = ctx.sys.bullets;
    pool.x[0] = PLAYER.x;
    pool.y[0] = PLAYER.y;
    ctx.events.length = 0;
    heroHits.seen.length = 0;
    stepBullets(ctx);
    expect(ctx.events.map((e) => e.type)).toContain('shieldAbsorbed');
    expect(ctx.player.life).toBe(ctx.player.maxLife);
    expect([stacksOf(ctx), heroHits.seen]).toEqual([3, [3]]);
  });
});

describe('compileBuild’s combo flag (lead ruling K1)', () => {
  const flagged = (
    mods: readonly Modifier[],
    triggers: readonly TriggerSpec[] = [],
    modules: readonly TestModule[] = [],
  ): boolean =>
    compileBuild(makeStats({}, mods, centerTriggers(triggers)), [], M1_SIGNATURE, modules).flags
      .combo;

  it('sets it for a modifier scaled on comboStacks and for a comboStack effect, a module’s included', () => {
    // Plants the effects left out of the test: a build that only adds stacks would keep none.
    expect(flagged([DAMAGE_PER_STACK])).toBe(true);
    expect(flagged([SPEED_PER_STACK])).toBe(true);
    expect(flagged([], [idle({ kind: 'comboStack', stacks: 1 })])).toBe(true);
    const adds: TestModule = (b) => {
      b.addEffect('center', { kind: 'comboStack', stacks: 1 });
    };
    const reads: TestModule = (b) => {
      b.addModifier({ ...DAMAGE_PER_STACK, tags: ['hit'] });
    };
    expect([flagged([], [], [adds]), flagged([], [], [reads]), flagged([], [], [KEEP])]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('leaves it false for every other build, a buff alone included, whose run still steps the buffs', () => {
    // Plants the flag set for any scaling or any effect: a build with no reader would count.
    expect(flagged([])).toBe(false);
    expect(flagged([{ ...DAMAGE_PER_STACK, scaling: { per: 'chainJump' } }])).toBe(false);
    expect(flagged([{ stat: 'attackSpeed', kind: 'more', value: 0.5, tags: ['projectile'] }])).toBe(
      false,
    );
    expect(flagged([], [idle(OVERCLOCK), idle({ kind: 'heal', lifePct: 0.01 })])).toBe(false);
    const buffed = run([], { triggers: [idle(OVERCLOCK)] });
    expect([buffed.build.flags.combo, buffed.sys.combo.ticks]).toEqual([false, true]);
    expect(run([]).sys.combo.ticks).toBe(false);
  });
});

describe('a module’s attackSpeed modifier (lead ruling K5, D1)', () => {
  it('takes what the data takes, and refuses the rest as the data does', () => {
    // Plants addModifier without attackSpeedIssues: a module could scale cadence on a target.
    const adds =
      (mod: Modifier): TestModule =>
      (b) => {
        b.addModifier(mod);
      };
    const compile = (mod: Modifier): unknown =>
      compileBuild(makeStats(), [], M1_SIGNATURE, [adds(mod)]);
    expect(() => compile({ ...SPEED_PER_STACK, tags: ['projectile'] })).not.toThrow();
    expect(() => compile(SPEED_PER_STACK)).not.toThrow();
    expect(() => compile({ ...SPEED_PER_STACK, kind: 'increased' })).toThrow(
      /attackSpeed with tags, notTags, a scope or a scaling must be kind 'more' \(got 'increased'\)/,
    );
    expect(() => compile({ ...SPEED_PER_STACK, scaling: { per: 'targetDistance' } })).toThrow(
      /attackSpeed scales only on 'comboStacks' \(got 'targetDistance'\)/,
    );
    expect(() =>
      compile({ ...SPEED_PER_STACK, tags: ['hit'], when: [{ targetHas: 'burn' }] }),
    ).toThrow(/attackSpeed takes no conditions/);
    // A static untagged one stays scaleStat's, as for any stat but damage.
    expect(() => compile({ stat: 'attackSpeed', kind: 'more', value: 1 })).toThrow(
      /applies to every instance; use scaleStat or offsetStat/,
    );
  });
});

describe('comboStacks (lead ruling K4)', () => {
  it('scales a hit by the stacks as they are at that hit, the attack’s own stack included', () => {
    // Plants the run's EvalInput written only at the combo step: the arc's hits, in the tick of
    // its discharge, would read the stacks from before it.
    const arcs = (mods: readonly Modifier[]): RunContext =>
      run([at(200)], { mods, modules: [KEEP], signature: { id: 'triphaseArc' } });
    // A tick's combo step, then its discharge.
    const primary = (ctx: RunContext): number => {
      ctx.events.length = 0;
      stepCombo(ctx);
      const em = signatureOf(ctx);
      em.acc = em.interval - em.cadence;
      runArc(ctx, em);
      const hit = ctx.events.find((e) => e.type === 'hit' && e.chainIndex === 0);
      if (hit?.type !== 'hit') throw new Error('the discharge hit nothing');
      return toNumber(hit.amount);
    };
    const scaled = arcs([DAMAGE_PER_STACK]);
    const plain = arcs([]);
    expect(primary(scaled) / primary(plain)).toBeCloseTo(1.02, 12);
    expect(stacksOf(scaled)).toBe(1);
    addComboStacks(scaled, 9);
    addComboStacks(plain, 9);
    expect(primary(scaled) / primary(plain)).toBeCloseTo(1.22, 12);
  });

  it('reads 0 in the estimates outside a run', () => {
    // Plants the estimates' EvalInput at any other stack count.
    const mask = TAG.hit | TAG.projectile;
    expect(damageRow(makeStats({}, [DAMAGE_PER_STACK]), mask)).toBe(damageRow(makeStats(), mask));
  });

  it('starts every run at 0, whatever an earlier run in the process left', () => {
    // Plants the run's EvalInput starting from the stacks an earlier run left: the next run's
    // hits before its first stack would read them.
    const first = run([at(300)], { modules: [KEEP] });
    addComboStacks(first, 9);
    const next = run([at(300)], { mods: [DAMAGE_PER_STACK] });
    expect([stacksOf(next), next.evalInput.comboStacks]).toEqual([0, 0]);
  });
});

describe('the cadence (lead rulings K5–K7)', () => {
  it('multiplies the signature’s cadence by 1 + 0.03 × stacks: 1.6 at 20, and follows them down', () => {
    // Plants the cadence left alone when the stacks change, and the factor read from another
    // column than attackSpeed's.
    const ctx = run([at(300)], { mods: [SPEED_PER_STACK] });
    expect([ctx.build.flags.combo, Array.from(ctx.sys.combo.scaled)]).toEqual([true, [0]]);
    expect(cadences(ctx)).toEqual([1]);
    addComboStacks(ctx, 20);
    expect(signatureOf(ctx).cadence).toBeCloseTo(1.6, 12);
    leak(ctx, addSquare(ctx, 200));
    expect(signatureOf(ctx).cadence).toBeCloseTo(1.3, 12);
    // At the cap, where each attack's stack changes nothing, the volley attacks 1.6 times as
    // often as without the modifier.
    const attacksIn = (mods: readonly Modifier[]): number => {
      const c = run([at(300)], { mods, modules: [KEEP] });
      addComboStacks(c, 20);
      const em = signatureOf(c);
      for (let t = 0; t < 600; t++) runVolley(c, em);
      return em.attacks;
    };
    expect(attacksIn([SPEED_PER_STACK]) / attacksIn([])).toBeCloseTo(1.6, 1);
  });

  it('is 冰霜’s factor × the combo factor × the buffs’, in that order, and each comes back exactly', () => {
    // Plants the factors added instead of multiplied, and the frost factor dropped from the
    // product.
    const ctx = run([], {
      mods: [SPEED_PER_STACK],
      triggers: [idle(buff(2, 2))],
      data: quietV3(),
    });
    addComboStacks(ctx, 20);
    const combo = ctx.sys.combo.comboFactor[0] as number;
    expect(combo).toBeCloseTo(1.6, 12);
    expect(signatureOf(ctx).cadence).toBe(combo);
    addEnemy(ctx, ctx.data.enemies.hexagon, ctx.current as WaveRecord, 1, 0, FROST_RANGE, {
      hpScale: 1,
      radiusScale: 1,
      dropScale: 1,
      extra: false,
      affixes: AFFIX_FROST,
    });
    const elite = ctx.enemies.at(-1) as Enemy;
    rebuildGrid(ctx);
    stepEnemyAi(ctx);
    expect(ctx.sys.affixes.frostFactor).toBe(FROST_CADENCE);
    expect(signatureOf(ctx).cadence).toBe(FROST_CADENCE * combo);
    runKind(ctx, 'buff');
    expect(signatureOf(ctx).cadence).toBe(FROST_CADENCE * combo * 3);
    // The buff's window ends: frost × combo again; the elite goes: the combo factor alone.
    idleTicks(ctx, 2 * TICK_RATE + 1);
    expect(signatureOf(ctx).cadence).toBe(FROST_CADENCE * combo);
    removeEnemy(ctx, elite);
    stepEnemyAi(ctx);
    expect(signatureOf(ctx).cadence).toBe(combo);
  });

  it('multiplies by 3 for 超頻’s 2 s on the minion emitters alone, from the next emitter stage', () => {
    // Plants the tags ignored (every emitter sped up), the window never ending, and a window of
    // 119 or 121 emitter stages.
    const ctx = run([at(300)], { triggers: [idle(OVERCLOCK)], grants: [DRONE] });
    expect(ctx.emitters.map((em) => em.spec.kind)).toEqual(['volley', 'drone']);
    const fired = ctx.now;
    runKind(ctx, 'buff');
    expect(cadences(ctx)).toEqual([1, 3]);
    const sped: number[] = [];
    for (let t = 0; t < 2 * TICK_RATE + 5; t++) {
      idleTicks(ctx, 1);
      if ((ctx.emitters[1] as EmitterRuntime).cadence === 3) sped.push(ctx.now);
      expect(signatureOf(ctx).cadence).toBe(1);
    }
    expect([sped.length, sped[0], sped.at(-1)]).toEqual([120, fired + 1, fired + 120]);
    expect(cadences(ctx)).toEqual([1, 1]);
    expect(ctx.sys.combo.active).toBe(0);
  });

  it('restarts a buff’s window when it fires again, multiplying nothing more; distinct buffs multiply', () => {
    // Plants a buff stacking on its refire, and its end left where the first firing put it.
    const ctx = run([at(300)], {
      triggers: [idle(buff(2, 2)), idle(buff(1, 1))],
      grants: [DRONE],
    });
    runKind(ctx, 'buff');
    idleTicks(ctx, 60);
    runKind(ctx, 'buff');
    expect(cadences(ctx)).toEqual([3, 3]);
    const refired = ctx.now;
    runKind(ctx, 'buff', 1);
    expect(cadences(ctx)).toEqual([6, 6]);
    idleTicks(ctx, TICK_RATE + 1);
    expect(cadences(ctx)).toEqual([3, 3]);
    idleTicks(ctx, refired + 2 * TICK_RATE - ctx.now);
    expect(cadences(ctx)).toEqual([3, 3]);
    idleTicks(ctx, 1);
    expect(cadences(ctx)).toEqual([1, 1]);
  });

  it('ends a buff-only build’s windows in a run, on the run’s periodic trigger', () => {
    // Plants the combo step called only for a build that keeps stacks: the buff would never end.
    const seen: number[] = [];
    const watch: TestModule = (b) => {
      b.hook('tick', (ctx) => {
        if (signatureOf(ctx).cadence === 3) seen.push(ctx.now);
      });
    };
    const config = makeConfig({
      stats: makeStats(
        VOLLEY,
        [],
        centerTriggers([{ on: 'periodic', every: 1, do: [buff(2, 0.5)] }]),
      ),
    });
    const sim = createSimulation(config, stationarySquares(3), [watch]);
    for (let t = 0; t < 360; t++) sim.step(NO_INPUT);
    // The trigger fires every 60 ticks from tick 61: windows of 30 emitter stages each, from
    // the next one on.
    const starts = seen.filter((tick, i) => i === 0 || tick !== (seen[i - 1] as number) + 1);
    expect(starts).toEqual([62, 122, 182, 242, 302]);
    expect(seen.length).toBe(30 * starts.length);
  });

  it('takes a static attackSpeed as the interval alone, the cadence exactly 1', () => {
    // Plants the static attackSpeed modifiers kept in StatBlock.scoped too: the build would
    // count them twice, in the interval and in the cadence.
    const extras = { triggers: [], conversions: [], emitters: [] };
    const fast = computeStatBlock([{ stat: 'attackSpeed', kind: 'increased', value: 1 }], extras);
    expect(fast.scoped).toEqual([]);
    const plain = computeStatBlock([], extras);
    expect(fast.values.attackSpeed).toBe(2 * plain.values.attackSpeed);
    const quick = placedEnemies([at(300)], { stats: fast });
    const base = placedEnemies([at(300)], { stats: plain });
    expect(signatureOf(quick).interval).toBeCloseTo(signatureOf(base).interval / 2, 12);
    expect([quick.build.flags.combo, quick.sys.combo.ticks]).toEqual([false, false]);
    expect(cadences(quick)).toEqual([1]);
    // A tagged one without a scaling is a fixed factor on its emitters' cadence (D6).
    const tagged = run([at(300)], {
      mods: [{ stat: 'attackSpeed', kind: 'more', value: 0.5, tags: ['projectile'] }],
      grants: [DRONE],
    });
    expect(cadences(tagged)).toEqual([1.5, 1]);
    expect(signatureOf(tagged).interval).toBe(signatureOf(run([at(300)])).interval);
  });

  it('keeps a fixed factor once in a row the stacks also scale (D6)', () => {
    // Plants the fixed part applied again when the stacks change: 1.5 × 1.3 would read 2.925.
    const ctx = run([at(300)], {
      mods: [
        { stat: 'attackSpeed', kind: 'more', value: 0.5, tags: ['projectile'] },
        SPEED_PER_STACK,
      ],
    });
    expect(cadences(ctx)).toEqual([1.5]);
    addComboStacks(ctx, 10);
    expect(signatureOf(ctx).cadence).toBeCloseTo(1.5 * 1.3, 12);
    leak(ctx, addSquare(ctx, 200));
    expect(signatureOf(ctx).cadence).toBeCloseTo(1.5 * 1.15, 12);
  });

  it('takes only the emitters whose payload carries every one of a buff’s tags', () => {
    // Plants a buff taking an emitter that carries any one of its tags: minion + projectile
    // would take the volley (projectile) and the drone (minion), each of which carries one.
    const sped = (tags: readonly DamageTag[]): number[] => {
      const ctx = run([at(300)], {
        triggers: [idle({ kind: 'buff', stat: 'attackSpeed', more: 2, durationSec: 2, tags })],
        grants: [DRONE],
      });
      runKind(ctx, 'buff');
      return cadences(ctx);
    };
    expect([
      sped(['minion', 'projectile']),
      sped(['minion', 'area']),
      sped(['hit', 'projectile']),
    ]).toEqual([
      [1, 1],
      [1, 3],
      [3, 1],
    ]);
  });

  it('gives a buff whose window rounds to 0 ticks no emitter stage', () => {
    // Plants a 0-tick window kept through the next emitter stage: round(0.005 × 60) is 0.
    const ctx = run([at(300)], { triggers: [idle(buff(2, 0.005))] });
    expect(Array.from(ctx.sys.combo.buffTicks)).toEqual([0]);
    runKind(ctx, 'buff');
    idleTicks(ctx, 1);
    expect([cadences(ctx), ctx.sys.combo.active]).toEqual([[1], 0]);
  });

  it('leaves the aura’s, the strike’s and the orbit’s cadence and periods alone', () => {
    // Plants readsCadence true for the aura (or the strike, or the orbit): its cadence would
    // take the buff and the combo factor.
    const grants = PERIODIC;
    const KINDS = PERIODIC_TAGS;
    const runOf = (sped: boolean): { hits: string[]; cadence: number[][] } => {
      const hits: string[] = [];
      const cadence: number[][] = [];
      const watch: TestModule = (b) => {
        b.hook('onHit', (ctx, hit) => {
          if ((hit.mask & KINDS) !== 0) hits.push(`${ctx.now}:${hit.mask}:${hit.target.id}`);
        });
        b.hook('tick', (ctx) => {
          cadence.push(cadences(ctx));
        });
      };
      const triggers: TriggerSpec[] = sped
        ? [{ on: 'waveStart', do: [buff(2, 1000), { kind: 'comboStack', stacks: 20 }] }]
        : [];
      const config = makeConfig({
        seed: 5,
        stats: makeStats({ ...VOLLEY, maxLife: 1e9 }, sped ? [SPEED_PER_STACK] : [], {
          triggers: centerTriggers(triggers).triggers,
          conversions: [],
          emitters: grants,
        }),
      });
      const data = makeTestData({
        enemies: { square: { hpMult: 1e12, speed: 60 } },
        waves: {
          rules: [{ enemy: 'square', fromWave: 1, base: 12, perWave: 0, maxCount: 12 }],
          eliteEvery: 1000,
          bossEvery: 1000,
          spawnDurationSec: 2,
          waveTimerSec: 1000,
        },
      });
      const sim = createSimulation(config, data, [watch]);
      for (let t = 0; t < 900; t++) sim.step(NO_INPUT);
      return { hits, cadence };
    };
    const plain = runOf(false);
    const sped = runOf(true);
    expect(plain.hits.length).toBeGreaterThan(30);
    expect(sped.hits).toEqual(plain.hits);
    // Every tick: the signature × 3 × its combo factor, the three others exactly 1.
    expect(sped.cadence.every((c) => c.slice(1).every((x) => x === 1))).toBe(true);
    expect(sped.cadence.some((c) => (c[0] as number) > 3)).toBe(true);
    expect(plain.cadence.every((c) => c.every((x) => x === 1))).toBe(true);
  });

  it('keeps their periods under 冰霜 too, whose factor is their cadence', () => {
    // Plants the aura's phase (or the strike's timer, or the orbit's cooldown) read through its
    // cadence: 冰霜 would move its hits.
    const hitsOf = (frost: boolean): string[] => {
      const ctx = run([at(60), at(-90), at(0, { y: PLAYER.y + 120 })], {
        grants: PERIODIC,
        data: quietV3(),
      });
      addEnemy(ctx, ctx.data.enemies.hexagon, ctx.current as WaveRecord, 1, 0, FROST_RANGE, {
        hpScale: 1,
        radiusScale: 1,
        dropScale: 1,
        extra: false,
        affixes: frost ? AFFIX_FROST : 0,
      });
      rebuildGrid(ctx);
      stepEnemyAi(ctx);
      expect(ctx.sys.affixes.frostFactor).toBe(frost ? FROST_CADENCE : 1);
      expect(cadences(ctx).slice(1)).toEqual(PERIODIC.map(() => ctx.sys.affixes.frostFactor));
      const hits: string[] = [];
      for (let t = 0; t < 600; t++) {
        ctx.now++;
        ctx.state.tick++;
        ctx.events.length = 0;
        runEmitters(ctx);
        for (const e of ctx.events) {
          if (e.type === 'hit' && (e.tags & PERIODIC_TAGS) !== 0) {
            hits.push(`${ctx.now}:${e.tags}:${e.targetId}`);
          } else if (e.type === 'pulse' && e.kind === 'aura') {
            hits.push(`${ctx.now}:aura:${e.hits}`);
          }
        }
      }
      return hits;
    };
    const plain = hitsOf(false);
    // The aura's pulses raise pulse events, the strike's and the orbit's hits hit events.
    const auraPulses = plain.filter((h) => h.includes(':aura:')).length;
    expect(auraPulses).toBeGreaterThan(30);
    expect(plain.length - auraPulses).toBeGreaterThan(30);
    expect(hitsOf(true)).toEqual(plain);
  });

  it('reaches a drone’s speed and dock time, and a turret’s firing, through the cadence', () => {
    // Plants the buff's factor on the volley emitters alone: the drones and turrets would keep
    // their rate.
    const droneTick = (sped: boolean): { dock: number; dash: number; turret: number } => {
      const ctx = run([at(600)], {
        triggers: [idle(OVERCLOCK)],
        grants: [{ source: 'outer.summon', grant: { kind: 'drone', drones: 1, turrets: 1 } }],
      });
      if (sped) runKind(ctx, 'buff');
      const ds = ctx.sys.drones;
      expect(ds.count).toBe(2);
      const turret = ds.kind[0] === DRONE_KIND_TURRET ? 0 : 1;
      const drone = 1 - turret;
      expect([ds.kind[drone] !== DRONE_KIND_TURRET, ds.kind[turret]]).toEqual([
        true,
        DRONE_KIND_TURRET,
      ]);
      ds.dockLeft[drone] = 100;
      ds.acc[turret] = 0;
      stepDrones(ctx);
      const dock = 100 - (ds.dockLeft[drone] as number);
      const turretAcc = ds.acc[turret] as number;
      ds.dockLeft[drone] = 0;
      stepDrones(ctx);
      const dash = Math.hypot(
        (ds.x[drone] as number) - (ds.prevX[drone] as number),
        (ds.y[drone] as number) - (ds.prevY[drone] as number),
      );
      return { dock, dash, turret: turretAcc };
    };
    const plain = droneTick(false);
    expect([plain.dock > 0, plain.dash > 0, plain.turret]).toEqual([true, true, 1]);
    const sped = droneTick(true);
    expect(sped.dock).toBeCloseTo(plain.dock * 3, 10);
    expect(sped.dash).toBeCloseTo(plain.dash * 3, 10);
    expect(sped.turret).toBe(3);
  });
});

/**
 * The flags the base (8ac24f4, before the comboCap stat) compiled for 節拍's two per-stack
 * modifiers with 殘影 (afterimageModule), recorded there: a build at the base stat compiles to
 * them still (lead ruling Z2). E15 added hasAura, false for a build without an aura emitter, and
 * E16 thornsFactor, 1 at the thornsArea stat's base.
 */
const BASE_BEAT_FLAGS: BuildFlags = {
  randomCrits: true,
  maxLife: null,
  burnRings: false,
  bleedMoveMult: 3,
  bleedRings: false,
  bleedMaxStacks: 8,
  frostImmuneTicks: 180,
  bossLockTicks: 252,
  bossMinGapTicks: 0,
  globalSlow: 0,
  frostBurnCap: 0,
  shatterMult: 1,
  combo: true,
  comboCap: 20,
  comboIdleTicks: 60,
  comboIdleKeep: 0,
  comboHitKeep: 0.5,
  shardsHeld: false,
  enemiesInAura: false,
  comboFull: 20,
  comboEcho: { delaySec: 0.3, damagePct: 0.5 },
  sizeFactor: 1,
  halveCounts: false,
  areaFactor: 1,
  spawnsDrones: false,
  highestHp: false,
  hasAura: false,
  poisonSlowStacks: 0,
  poisonSlowPer: 0,
  poisonSlowMax: 0,
  spreadFactor: 1,
  thornsFactor: 1,
  summonEliteFirst: false,
  droneCountMult: 1,
  dronesStay: false,
  turretRateMult: 1,
  turretSplash: 0,
  turretChains: 0,
  minionCount: false,
  summonHighestHp: false,
  shatterChain: false,
  frozenNoSplit: false,
  frostGainShocked: 0,
  frostGainBoss: 0,
  barrage: {
    countMult: 1,
    bounce: 0,
    aim: 'distinct',
    spreadDeg: 30,
    ring: null,
    split: null,
    focus: null,
    rain: null,
  },
};

/** ★無盡連擊's two flags, as its module would write them. */
const ENDLESS = flagsOf({ comboCap: Infinity, comboHitKeep: 0 });

describe('the comboCap stat (E14, lead ruling Z2)', () => {
  /** The stacks after `attacks` counted attacks of a build kept by KEEP with `values`. */
  const capped = (
    values: Partial<Record<StatId, number>>,
    attacks: number,
    extra: TestModule[] = [],
  ) => {
    const ctx = run([at(300)], { values, modules: [KEEP, ...extra] });
    for (let i = 0; i < attacks; i++) attack(ctx);
    return { ctx, stacks: stacksOf(ctx), flags: ctx.build.flags };
  };

  it('has DEFAULT_COMBO_CAP, 20, as its base', () => {
    // Plants the base and the flag's literal apart: a build at the base would move.
    expect([BASE_STATS.comboCap, DEFAULT_COMBO_CAP]).toEqual([20, 20]);
  });

  it('folds a stat of 30 into the cap: 35 attacks stop at 30, a comboStack too, and 滿層 is 30', () => {
    // Plants the stat left unread: the stacks would stop at 20.
    const { ctx, stacks, flags } = capped({ comboCap: 30 }, 35);
    expect([stacks, flags.comboCap, flags.comboFull]).toEqual([30, 30, 30]);
    expect(ctx.evalInput.comboStacks).toBe(30);
    // A comboStack from 27 stops at the stat's 30, not at 20 and not at 32.
    const below = capped({ comboCap: 30 }, 27);
    addComboStacks(below.ctx, 5);
    expect(stacksOf(below.ctx)).toBe(30);
  });

  it('folds a stat of 5: the stacks stop at 5, and 滿層 is 5', () => {
    const { stacks, flags } = capped({ comboCap: 5 }, 8);
    expect([stacks, flags.comboCap, flags.comboFull]).toEqual([5, 5, 5]);
  });

  it('floors the stat and keeps it at least 1: 25.9 → 25, 0.5 → 1 and −3 → 1', () => {
    // Plants the fold without floor (25.9 stacks at most, 滿層 never reached by whole stacks)
    // and without max(1, …) (0 and −3: an attack's stack would be refused, or the stacks go
    // negative).
    expect(capped({ comboCap: 25.9 }, 30).stacks).toBe(25);
    expect(capped({ comboCap: 25.9 }, 30).flags.comboFull).toBe(25);
    for (const comboCap of [0.5, -3]) {
      const { stacks, flags } = capped({ comboCap }, 4);
      expect([stacks, flags.comboCap, flags.comboFull], `${comboCap}`).toEqual([1, 1, 1]);
    }
  });

  it('lets a module’s cap win: ★無盡連擊’s Infinity beats a stat of 30 (40 attacks, 40 stacks), and 滿層 is then 20', () => {
    // Plants the fold after the rule modules: the module's Infinity would be overwritten by 30.
    const { stacks, flags } = capped({ comboCap: 30 }, 40, [ENDLESS]);
    expect([stacks, flags.comboCap, flags.comboFull]).toEqual([40, Infinity, DEFAULT_COMBO_CAP]);
    // A module's finite cap wins too, and 滿層 follows it.
    const own = capped({ comboCap: 30 }, 40, [flagsOf({ comboCap: 12 })]);
    expect([own.stacks, own.flags.comboCap, own.flags.comboFull]).toEqual([12, 12, 12]);
  });

  it('leaves the cap to the fold: a module’s offsetStat or scaleStat on comboCap moves the stat alone (D7)', () => {
    // Plants the fold after the modules, or reading the stat once they have run: a module's
    // offsetStat or scaleStat would reach the cap. A module sets the cap by writing it.
    const offset: TestModule = (b) => {
      b.offsetStat('comboCap', 5);
    };
    const scale: TestModule = (b) => {
      b.scaleStat('comboCap', 2);
    };
    const moved = [offset, scale].map((module) => {
      const { ctx, stacks, flags } = capped({}, 30, [module]);
      return [ctx.build.values.comboCap, stacks, flags.comboCap, flags.comboFull];
    });
    expect(moved).toEqual([
      [25, 20, 20, 20],
      [40, 20, 20, 20],
    ]);
  });

  it('makes 滿層 the stat with no module: 25 → 25, which a module’s own comboFull overrides', () => {
    const at25 = compileBuild(makeStats({ comboCap: 25 }), []).flags;
    expect([at25.comboCap, at25.comboFull]).toEqual([25, 25]);
    const set = compileBuild(makeStats({ comboCap: 25 }), [], M1_SIGNATURE, [
      flagsOf({ comboFull: 20 }),
    ]).flags;
    expect([set.comboCap, set.comboFull]).toEqual([25, 20]);
  });

  it('compiles a build at the base stat, written or not, to the flags the base recorded', () => {
    // Plants a fold that moves the base: 20 must stay 20, bit for bit, with every other flag.
    const beat = (values: Partial<Record<StatId, number>>, ...modules: TestModule[]) =>
      compileBuild(makeStats(values, [SPEED_PER_STACK, DAMAGE_PER_STACK]), [], M1_SIGNATURE, [
        afterimageModule(),
        ...modules,
      ]).flags;
    expect(beat({})).toEqual(BASE_BEAT_FLAGS);
    expect(beat({ comboCap: 20 })).toEqual(BASE_BEAT_FLAGS);
    expect(beat({}, ENDLESS)).toEqual({
      ...BASE_BEAT_FLAGS,
      comboCap: Infinity,
      comboHitKeep: 0,
    });
    // Through computeStatBlock too, as the meta layer builds stats.
    const block = computeStatBlock([SPEED_PER_STACK, DAMAGE_PER_STACK], NO_EXTRAS);
    expect(compileBuild(block, [], M1_SIGNATURE, [afterimageModule()]).flags).toEqual(
      BASE_BEAT_FLAGS,
    );
  });
});

/** ◆爆發 (gd:421 「滿層時每第 5 次攻擊多打一次」) as B4 writes it: data, no module. */
const BURST: TriggerSpec = {
  on: 'nthAttack',
  every: 5,
  when: [{ comboAtLeast: 'full' }],
  do: [{ kind: 'repeatAttack', count: 1, damagePct: 1 }],
};

describe('comboAtLeast in a run (E14, lead rulings Z3, Z4)', () => {
  /** Effects the attack queued: its triggers' firings, each of one effect here. */
  const queuedBy = (ctx: RunContext): number => {
    const before = ctx.effectQueue.size;
    attack(ctx);
    return ctx.effectQueue.size - before;
  };

  it('turns BuildFlags.combo on from a trigger’s comboAtLeast alone, a module’s included, and leaves it off without one', () => {
    // Plants the condition left out of the flag, or read only as a trigger's first condition:
    // the stacks would stay 0 and it would never hold.
    const flagged = (triggers: readonly TriggerSpec[], modules: readonly TestModule[] = []) =>
      compileBuild(makeStats({}, [], centerTriggers(triggers)), [], M1_SIGNATURE, modules).flags
        .combo;
    expect(flagged([BURST])).toBe(true);
    expect(flagged([idle(buff(1, 1))].map((t) => ({ ...t, when: [{ comboAtLeast: 3 }] })))).toBe(
      true,
    );
    const adds: TestModule = (b) => {
      b.addTrigger('center', BURST);
    };
    expect(flagged([], [adds])).toBe(true);
    expect(flagged([{ ...BURST, when: [{ targetKind: 'normal' }, { comboAtLeast: 3 }] }])).toBe(
      true,
    );
    // Every other condition, and ◆爆發 without its condition, keep it off.
    expect(flagged([{ ...BURST, when: [{ targetKind: 'boss' }] }])).toBe(false);
    expect(flagged([{ ...BURST, when: [] }])).toBe(false);
    expect(flagged([{ on: 'hit', when: [{ chance: 0.5 }, { hitIs: 'crit' }], do: [] }])).toBe(
      false,
    );
    // And a run of the condition alone counts its stacks.
    const ctx = run([at(300)], { triggers: [BURST] });
    for (let i = 0; i < 3; i++) attack(ctx);
    expect([ctx.build.flags.combo, stacksOf(ctx), ctx.evalInput.comboStacks]).toEqual([true, 3, 3]);
  });

  it('fires a periodic trigger, which has no target, at its first due tick once its stacks reach n, and full under a stat of 3', () => {
    // Plants the condition checked after the target-null return, or the stacks left uncounted:
    // the periodic trigger would never fire.
    for (const comboAtLeast of [3, 'full'] as const) {
      const ctx = run([at(300)], {
        values: { comboCap: 3 },
        triggers: [{ on: 'periodic', every: 0.25, when: [{ comboAtLeast }], do: [buff(1, 0.1)] }],
      });
      const cs = ctx.sys.combo;
      const fired: string[] = [];
      // An attack every 10 ticks; the trigger is due at 16, 31, 46, 61 and 76 (15 ticks, from
      // its period plus its index, 1).
      for (let tick = 2; tick <= 80; tick++) {
        ctx.now = tick;
        if (tick % 10 === 0) attack(ctx);
        const end = cs.buffEnd[0];
        runEffectQueue(ctx);
        if (cs.buffEnd[0] !== end) fired.push(`${tick}: ${stacksOf(ctx)}`);
      }
      expect(fired, `${comboAtLeast}`).toEqual(['31: 3', '46: 3', '61: 3', '76: 3']);
    }
  });

  it('sees the attack’s own stack on nthAttack: a comboAtLeast 1 fires on the run’s first attack, and ◆爆發 on the 20th, the one that fills the combo', () => {
    // countAttack (src/sim/emitters/volley.ts) gains the stack before it raises nthAttack, and
    // dispatch checks the conditions as the event is raised: from 0, the first attack's trigger
    // reads 1 and the 20th's reads 20, full. Reordering them would read 0 and 19.
    const first = run([at(300)], {
      triggers: [{ on: 'nthAttack', every: 1, when: [{ comboAtLeast: 1 }], do: [buff(1, 1)] }],
    });
    expect([queuedBy(first), stacksOf(first)]).toEqual([1, 1]);
    const ctx = run([at(300)], { triggers: [BURST] });
    const seen = Array.from({ length: 20 }, () => queuedBy(ctx));
    expect(seen.slice(0, 19).every((n) => n === 0)).toBe(true);
    expect([seen[19], stacksOf(ctx), signatureOf(ctx).attacks]).toEqual([1, 20, 20]);
  });

  it('◆爆發 as data: no repeat below full, one on every 5th counted attack at full, none after a hit halves the stacks until they are full again', () => {
    // Plants `>` for `>=` (no repeat at exactly 20) and the stacks uncounted (none ever).
    const ctx = run([at(300)], { triggers: [BURST] });
    const fired: string[] = [];
    let repeats = 0;
    const step = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const queued = queuedBy(ctx);
        const shots = ctx.projectiles.length;
        runEffectQueue(ctx);
        // The repeat fires the attack's one projectile again, as no attack of its own.
        repeats += ctx.projectiles.length - shots;
        if (queued > 0) fired.push(`${signatureOf(ctx).attacks}: ${stacksOf(ctx)}`);
      }
    };
    step(30);
    leak(ctx, addSquare(ctx, 200));
    expect(stacksOf(ctx)).toBe(10);
    step(15);
    expect(fired).toEqual(['20: 20', '25: 20', '30: 20', '40: 20', '45: 20']);
    expect([repeats, signatureOf(ctx).attacks]).toEqual([5, 45]);
  });
});
