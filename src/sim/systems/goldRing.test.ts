/**
 * 金山's gold ring (docs/v3/game-design-v3.md §4.12, gd:504 「光圈內擊殺的敵人多掉 50% 碎片」; E17,
 * lead rulings G1-G4): a goldRing grant, read once a compile into BuildFlags.goldRing, makes an
 * enemy killed with its centre within the ring's radius of the player, edge included, at its
 * position at its death, drop × (1 + dropPct) shards in Num, after its record's dropScale and a
 * trigger's killShards, whatever killed it and whatever it is; its cores stay (killEnemy,
 * src/sim/systems/death.ts). The radius is as written, never sized. A build without the grant
 * drops as the base did, bit for bit. Each test names in a comment the planted bug it kills.
 */

import { describe, expect, it, vi } from 'vitest';
import { add, mul, num } from '../../core/num';
import type { Num } from '../../core/num';
import { AFFIX_MULTIPLY } from '../../data/affixes';
import type { SourcedEmitter } from '../../data/emitters';
import type { RuleSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TriggerSpec } from '../../data/triggers';
import type { GameData } from '../../data/types';
import { applyPoison, releaseAilments, spreadPoisonToChildren } from '../ailments/apply';
import { compileBuild } from '../build/compile';
import type { CompiledBuild } from '../build/compile';
import { heldFlags } from '../build/eval';
import { goldRingRadius } from '../build/size';
import { CENTER } from '../build/sources';
import { hitWithPayload } from '../combat/hit';
import { fireInlineKill, recordPendingKills } from '../effects/dispatch';
import { runEffect } from '../effects/execute';
import {
  CHAIN_JUMP,
  HIT_BITS,
  KILL_BY_HIT,
  KILL_BY_POISON,
  KILL_KIND_SHIFT,
  KILLED,
} from '../effects/flags';
import { createEffectEntry } from '../effects/queue';
import { MAX_DEPTH, SHATTER_TRIGGER } from '../effects/types';
import type { CompiledEffect, CompiledTrigger } from '../effects/types';
import type { EmitterRuntime } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, NO_INPUT } from '../types';
import type { RunResult, SimEvent } from '../types';
import { multiply } from './affixes';
import { updateAilments } from './ailments';
import type { Enemy, RunContext } from './context';
import type * as Death from './death';
import { killEnemy, removeEnemy } from './death';
import { impactAt } from './drones';
import { split } from './spawn';
import { toSplitOf } from './systemState';
import type { SplitState } from './systemState';

// The base's own code path: under `base`, every kill goes through killEnemy as it was at
// edc7023, before the gold ring (referenceKill below, a verbatim copy).
const mode = vi.hoisted(() => ({ base: false }));
vi.mock('./death', async (importOriginal) => {
  const actual = await importOriginal<typeof Death>();
  return {
    ...actual,
    killEnemy: (ctx: RunContext, enemy: Enemy, origin: number, hitFlags: number): void =>
      mode.base
        ? referenceKill(ctx, enemy, origin, hitFlags)
        : actual.killEnemy(ctx, enemy, origin, hitFlags),
  };
});

/** death.ts's killEnemy at edc7023, verbatim but for its name. */
function referenceKill(ctx: RunContext, enemy: Enemy, origin: number, hitFlags: number): void {
  // The kill's flags: the killing hit's, what the victim held, and what killed it.
  let flags = 0;
  if (ctx.killListeners) {
    flags =
      (hitFlags & HIT_BITS) |
      heldFlags(enemy, ctx.now, ctx) |
      (1 << (KILL_KIND_SHIFT + enemy.killKind));
    if (ctx.killInline.length !== 0) fireInlineKill(ctx, enemy, origin, flags);
    const onKill = ctx.build.hooks.onKill;
    if (onKill.length !== 0) {
      const kill = ctx.killScratch;
      kill.origin = origin;
      kill.depth = enemy.killDepth;
      kill.x = enemy.x;
      kill.y = enemy.y;
      kill.flags = flags;
      for (const hook of onKill) hook(ctx, enemy, kill);
    }
  }
  removeEnemy(ctx, enemy);
  ctx.kills++;
  const def = enemy.def;
  let shards = mul(mul(num(def.dropMult), enemy.rec.shardsPerStd), ctx.shardGain);
  let expectedCores = def.cores * ctx.coreGain;
  const v3 = enemy.v3;
  // The parent's bits when it holds 增殖 (never 0 then, the affix being one of them), else 0.
  let multiplies = 0;
  if (v3 !== null) {
    shards = mul(shards, v3.dropScale);
    expectedCores *= v3.dropScale;
    if ((v3.affixes & AFFIX_MULTIPLY) !== 0) multiplies = v3.affixes;
  }
  if (origin >= 0) {
    shards = mul(shards, 1 + (ctx.build.triggers[origin] as CompiledTrigger).killShards);
  }
  let cores = 0;
  if (expectedCores > 0) {
    cores = Math.floor(expectedCores);
    if (ctx.dropsRng.chance(expectedCores - cores)) cores++;
  }
  const state = ctx.state;
  state.shards = add(state.shards, shards);
  state.cores += cores;
  ctx.events.push({
    type: 'enemyKilled',
    enemyId: enemy.id,
    enemy: def.id,
    x: enemy.x,
    y: enemy.y,
    shards,
    cores,
  });
  // The children are ctx.enemies[first ..]: the split children, then 增殖's.
  const first = split(ctx, enemy);
  if (multiplies !== 0) multiply(ctx, enemy);
  const ss = ctx.sys.split;
  if (ss.passedCount > 0) splitTransfers(ctx, enemy, first, ss);
  if (ctx.killPending.length !== 0) recordPendingKills(ctx, enemy, origin, flags, shards);
  releaseAilments(ctx, enemy);
}

/** death.ts's splitTransfers at edc7023, verbatim. */
function splitTransfers(ctx: RunContext, victim: Enemy, first: number, ss: SplitState): void {
  const end = ctx.enemies.length;
  if (first < end) {
    const { triggers, effects } = ctx.build;
    const depth = Math.min(victim.killDepth + 1, MAX_DEPTH);
    for (let n = 0; n < ss.passedCount; n++) {
      const t = triggers[ss.passed[n] as number] as CompiledTrigger;
      for (let e = t.effectStart; e < t.effectEnd; e++) {
        const f = toSplitOf(effects[e] as CompiledEffect);
        if (f > 0) spreadPoisonToChildren(ctx, victim, first, end, f, depth);
      }
    }
  }
  ss.passedCount = 0;
}

/** The player's point, the arena's centre. */
const PX = ARENA_WIDTH / 2;
const PY = ARENA_HEIGHT / 2;
/** 金山's ring as B4 is to write it: radius 200, 50% more. */
const RING: SourcedEmitter = {
  source: 'outer.greed',
  grant: { kind: 'goldRing', radius: 200, dropPct: 0.5 },
};

const COIN = { kind: 'coinHit', multiplier: 1e6 } as const;
/** Trigger 1: a coin on hit; 2: greed's coin with killShards; 3: an execute; 4: a kill's gain. */
const TRIGGERS: readonly TriggerSpec[] = [
  { on: 'hit', when: [{ chance: 0 }], do: [COIN] },
  { on: 'hit', when: [{ chance: 0 }], do: [COIN], killShards: 0.01 },
  { on: 'hit', when: [{ chance: 0 }], do: [{ kind: 'execute' }] },
  { on: 'kill', do: [{ kind: 'gainShards', fraction: 1 }] },
];
const T_COIN = 1;
const T_GREED = 2;
const T_EXECUTE = 3;
const T_GAIN = 4;

/** Stats with the given values, the four triggers and the grants. */
const statsWith = (
  grants: readonly SourcedEmitter[],
  values: Partial<Record<StatId, number>> = {},
) =>
  makeStats({ critChance: 0, igniteChance: 0, ...values }, [], {
    triggers: TRIGGERS.map((spec) => ({ source: 'outer.greed', spec })),
    conversions: [],
    emitters: grants,
  });

/** v3 data with no wave enemies, for placed v3 enemies (a treasure, a record's dropScale). */
const v3NoWaves = (): GameData =>
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

/** Enemies at these offsets from the player, each of 1 hp, under the ring (or `grants`). */
const field = (
  offsets: readonly (readonly [number, number])[],
  grants: readonly SourcedEmitter[] = [RING],
  options: {
    readonly values?: Partial<Record<StatId, number>>;
    readonly data?: GameData;
    readonly type?: 'square' | 'treasure' | 'pentagon' | 'hexagon';
    readonly rules?: readonly RuleSpec[];
  } = {},
): RunContext =>
  placedEnemies(
    offsets.map(([dx, dy]) => ({
      x: PX + dx,
      y: PY + dy,
      hp: 1,
      ...(options.type === undefined ? {} : { type: options.type }),
    })),
    {
      stats: statsWith(grants, options.values),
      ...(options.data === undefined ? {} : { data: options.data }),
      ...(options.rules === undefined ? {} : { rules: options.rules }),
    },
  );

/** The drop of `enemy` before killShards and the ring, as killEnemy computes it. */
const dropOf = (ctx: RunContext, enemy: Enemy): Num => {
  const base = mul(mul(num(enemy.def.dropMult), enemy.rec.shardsPerStd), ctx.shardGain);
  return enemy.v3 === null ? base : mul(base, enemy.v3.dropScale);
};

/** The shards each kill event carried, in order. */
const killed = (ctx: RunContext): Num[] =>
  ctx.events.flatMap((e) => (e.type === 'enemyKilled' ? [e.shards] : []));

/** A kill by an emitter's hit, as the hit path makes it (origin −1, depth 0). */
const emitterKill = (ctx: RunContext, enemy: Enemy): void => {
  enemy.killKind = KILL_BY_HIT;
  killEnemy(ctx, enemy, -1, 0);
};

/** Runs trigger `t`'s effect on `enemy` at `depth`, as the effect phase does. */
const fireOn = (ctx: RunContext, t: number, enemy: Enemy, depth = 1): void => {
  const trigger = ctx.build.triggers[t] as CompiledTrigger;
  const entry = createEffectEntry();
  entry.effect = trigger.effectStart;
  entry.origin = t;
  entry.depth = depth;
  entry.source = trigger.source;
  entry.target = enemy;
  entry.x = enemy.x;
  entry.y = enemy.y;
  runEffect(ctx, entry);
};

const enemyAt = (ctx: RunContext, i: number): Enemy => ctx.enemies[i] as Enemy;

describe('the gold ring at a kill (G2)', () => {
  it('drops exactly the base’s drop × 1.5 in Num for a kill inside the ring, to its event, SimState.shards and its pending kill', () => {
    // Planted bugs: the factor missing, × dropPct alone (0.5), or applied after the event or the
    // pending kills were written.
    const ctx = field([[150, 0]]);
    const victim = enemyAt(ctx, 0);
    const drop = mul(dropOf(ctx, victim), 1.5);
    const before = ctx.state.shards;
    emitterKill(ctx, victim);
    expect(killed(ctx)).toEqual([drop]);
    expect(ctx.state.shards).toEqual(add(before, drop));
    expect(ctx.pendingKills.slice(0, ctx.pendingCount).map((k) => [k.trigger, k.value])).toEqual([
      [T_GAIN, drop],
    ]);
  });

  it('takes the ring on its edge, distance = radius, on an axis and on a diagonal (inclusive)', () => {
    // Planted bug: the edge excluded (strict <).
    const offsets = [
      [200, 0],
      [0, -200],
      [-120, 160],
      [160, 120],
    ] as const;
    const ctx = field(offsets);
    for (const [dx, dy] of offsets) expect(dx * dx + dy * dy).toBe(200 * 200);
    const drops = ctx.enemies.map((e) => mul(dropOf(ctx, e), 1.5));
    for (const enemy of [...ctx.enemies]) emitterKill(ctx, enemy);
    expect(killed(ctx)).toEqual(drops);
  });

  it('leaves a kill just outside the ring its base drop: an ulp past 200, and 200.001 on a diagonal', () => {
    // Planted bugs: the ring on every kill, or a radius sized up by any factor.
    const next = (x: number): number => x + 2 ** (Math.floor(Math.log2(x)) - 52);
    const ctx = field([
      [next(PX + 200) - PX, 0],
      [-120.0006, 160.0008],
      [300, 400],
    ]);
    expect(enemyAt(ctx, 0).x - PX).toBeGreaterThan(200);
    const drops = ctx.enemies.map((e) => dropOf(ctx, e));
    for (const enemy of [...ctx.enemies]) emitterKill(ctx, enemy);
    expect(killed(ctx)).toEqual(drops);
  });

  it('applies the factor last: after a v3 record’s dropScale and a trigger’s killShards 0.01, as drop × 1.01 × 1.5 in that order', () => {
    // Planted bugs: the factor before dropScale, before killShards, or folded into one factor
    // with killShards (1.01 × 1.5, or 1 + 0.01 + 0.5); each differs in Num here.
    const ctx = field([[100, 50]], [RING], { data: v3NoWaves() });
    const victim = enemyAt(ctx, 0);
    expect(victim.v3).not.toBeNull();
    Object.assign(victim.v3 as object, { dropScale: 0.3 });
    const base = mul(mul(num(victim.def.dropMult), victim.rec.shardsPerStd), ctx.shardGain);
    const expected = mul(mul(mul(base, 0.3), 1.01), 1.5);
    // Each wrong order gives another Num here, so the test tells them apart.
    for (const wrong of [
      mul(mul(mul(base, 1.5), 0.3), 1.01),
      mul(mul(mul(base, 0.3), 1.5), 1.01),
      mul(mul(base, 0.3), 1.01 * 1.5),
      mul(mul(base, 0.3), 1 + 0.01 + 0.5),
    ]) {
      expect(wrong).not.toBe(expected);
    }
    fireOn(ctx, T_GREED, victim);
    expect(victim.alive).toBe(false);
    expect(killed(ctx)).toEqual([expected]);
  });

  it('tests the victim’s position at its death, not where it was a tick before nor where it spawned', () => {
    // Planted bugs: the ring tested at prevX/prevY (its position before its last move), or at
    // its spawn distance or its walk distance (Enemy.dist) instead of its centre.
    const ctx = field([
      [150, 0],
      [260, 0],
    ]);
    const [walkedIn, walkedOut] = [enemyAt(ctx, 0), enemyAt(ctx, 1)];
    // One stepped into the ring this tick, one out of it: their last positions, walks and spawn
    // distances are on the other side of the edge.
    Object.assign(walkedIn, { prevX: PX + 230, dist: 230 });
    Object.assign(walkedOut, { prevX: PX + 190, dist: 190 });
    const drops = [mul(dropOf(ctx, walkedIn), 1.5), dropOf(ctx, walkedOut)];
    emitterKill(ctx, walkedIn);
    emitterKill(ctx, walkedOut);
    expect(killed(ctx)).toEqual(drops);
  });

  it('pays the ring on kills by an emitter hit, a trigger at depth 3, a DoT, a drone impact, an execute and the thorns inside it', () => {
    // Planted bugs: the factor on emitter kills alone (origin −1), on trigger kills alone, only
    // at depth 0, or not on DoT kills (origin −1, no hit).
    const ctx = field(
      [
        [100, 0],
        [0, 100],
        [-100, 0],
        [0, -100],
        [140, 140],
        [30, 0],
      ],
      [
        RING,
        { source: 'outer.summon', grant: { kind: 'drone', drones: 1 } },
        { source: 'outer.thorns', grant: { kind: 'thorns' } },
      ],
    );
    const [hit, deep, dot, drone, executed, thorny] = ctx.enemies as Enemy[] as [
      Enemy,
      Enemy,
      Enemy,
      Enemy,
      Enemy,
      Enemy,
    ];
    const expected = new Map<number, Num>();
    for (const e of ctx.enemies) expected.set(e.id, mul(dropOf(ctx, e), 1.5));
    // The signature's hit, as a projectile's arrival makes it.
    const signature = (ctx.emitters[0] as EmitterRuntime).payload;
    hitWithPayload(ctx, hit, signature, 0, 1, null, null, false, 0, -1);
    // A coin at depth 3 (MAX_DEPTH), where the data alternative's kill trigger fires no more.
    fireOn(ctx, T_COIN, deep, MAX_DEPTH);
    expect(deep.killDepth).toBe(3);
    // A poison, stepped by the ailments system until it kills.
    applyPoison(ctx, dot, num(1e6), ctx.now + 600, 0, CENTER, 1);
    for (let k = 0; k < 60 && dot.alive; k++) {
      ctx.now++;
      updateAilments(ctx);
    }
    expect([dot.alive, dot.killKind]).toEqual([false, KILL_BY_POISON]);
    // A drone's impact, its splash reaching no one else.
    const droneEm = ctx.emitters.find((em) => em.spec.kind === 'drone') as EmitterRuntime;
    impactAt(ctx, 0, drone, droneEm.payload, droneEm, false, 0, -1);
    fireOn(ctx, T_EXECUTE, executed);
    // The thorns' hit on a contact, as resolveContacts deals it.
    const thorns = ctx.thornsEmitters[0] as EmitterRuntime;
    hitWithPayload(ctx, thorny, thorns.payload, 0, 1, null, null, false, 0, -1);
    expect(ctx.enemies.map((e) => e.alive)).toEqual([false, false, false, false, false, false]);
    const events = ctx.events.flatMap((e) => (e.type === 'enemyKilled' ? [e] : []));
    expect(events.map((e) => e.enemyId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.map((e) => e.shards)).toEqual(events.map((e) => expected.get(e.enemyId)));
  });

  it('leaves the cores alone: an elite and a treasure inside the ring roll the cores they roll without it', () => {
    // Planted bug: the factor on the expected cores too.
    const kill = (grants: readonly SourcedEmitter[], type: 'hexagon' | 'treasure') => {
      const ctx = field(
        [
          [80, 0],
          [-80, 0],
          [0, 80],
        ],
        grants,
        { data: v3NoWaves(), type },
      );
      for (const enemy of [...ctx.enemies]) {
        Object.assign(enemy.v3 as object, { dropScale: 1.7 });
        emitterKill(ctx, enemy);
      }
      return ctx.events.flatMap((e) => (e.type === 'enemyKilled' ? [[e.cores, e.shards]] : []));
    };
    for (const type of ['hexagon', 'treasure'] as const) {
      const ringed = kill([RING], type);
      const plain = kill([], type);
      expect(ringed.map(([cores]) => cores)).toEqual(plain.map(([cores]) => cores));
      // 1 × 1.7 expected cores: 1 or 2, drawn as before.
      expect(ringed.every(([cores]) => cores === 1 || cores === 2)).toBe(true);
      expect(ringed.map(([, shards]) => shards)).toEqual(
        plain.map(([, shards]) => mul(shards as Num, 1.5)),
      );
    }
  });

  it('pays the ring on a treasure inside it and on a pentagon’s split child, as on any enemy', () => {
    // Planted bugs: the factor only on M1 enemies (v3 === null), only on wave enemies (not the
    // split children), or never on a tough or a treasure's 20× drop.
    const treasures = field([[60, -60]], [RING], { data: v3NoWaves(), type: 'treasure' });
    const treasure = enemyAt(treasures, 0);
    expect(treasure.type).toBe('treasure');
    const treasureDrop = mul(dropOf(treasures, treasure), 1.5);
    emitterKill(treasures, treasure);
    expect(killed(treasures)).toEqual([treasureDrop]);
    const ctx = field([[120, 0]], [RING], { type: 'pentagon' });
    const pentagon = enemyAt(ctx, 0);
    emitterKill(ctx, pentagon);
    const children = ctx.enemies.filter((e) => e.alive);
    expect(children.map((e) => e.type)).toEqual(['shard', 'shard', 'shard']);
    const childDrops = children.map((child) => {
      const dx = child.x - PX;
      const dy = child.y - PY;
      expect(dx * dx + dy * dy).toBeLessThan(200 * 200);
      return mul(dropOf(ctx, child), 1.5);
    });
    for (const child of children) emitterKill(ctx, child);
    expect(killed(ctx)).toEqual([mul(dropOf(ctx, pentagon), 1.5), ...childDrops]);
  });

  it('keeps the radius as written: areaSize 1.5, 巨大化’s × 2, thornsArea 1.3 and spreadRadius 2 leave a kill at 250 unringed', () => {
    // Planted bug: the radius × areaSize, × the area factor (巨大化), × thornsFactor or ×
    // spreadFactor.
    const values = { areaSize: 1.5, thornsArea: 1.3, spreadRadius: 2 };
    const ctx = field(
      [
        [250, 0],
        [199, 0],
      ],
      [RING],
      { values, rules: [{ id: 'gigantism', sizeMult: 2 }] },
    );
    expect(ctx.build.flags.areaFactor).toBe(3);
    expect(ctx.build.flags.goldRing).toEqual({ radiusSq: 40000, mult: 1.5 });
    const [outside, inside] = [enemyAt(ctx, 0), enemyAt(ctx, 1)];
    const drops = [dropOf(ctx, outside), mul(dropOf(ctx, inside), 1.5)];
    emitterKill(ctx, outside);
    emitterKill(ctx, inside);
    expect(killed(ctx)).toEqual(drops);
  });
});

/** A run's kills: each killed enemy's killer, in kill order. */
interface Killers {
  readonly events: SimEvent[][];
  readonly result: RunResult;
  readonly shards: Num;
  /** Each kill's killer: the lethal hit's (by its origin, depth and tags) or 'dot'. */
  readonly kills: Map<number, string>;
}

/**
 * A 1,800-tick run of the fixture's waves from wave 8 (pentagons that split), with every killer:
 * the volley, crits and ignites, three drones, the thorns, two coins on any hit (a trigger never
 * fires on its own damage, so the two take turns down to depth 3), greed's coin with killShards
 * 0.01 on the signature's hits, and an execute below 15 % life, all on outer.greed but the drones'
 * and the thorns'; and `grants`.
 */
function killersRun(grants: readonly SourcedEmitter[]): Killers {
  const chain: TriggerSpec = {
    on: 'hit',
    when: [{ chance: 0.6 }],
    do: [{ kind: 'coinHit', multiplier: 0.5 }],
  };
  const triggers: TriggerSpec[] = [
    chain,
    chain,
    {
      on: 'hit',
      when: [{ hitIs: 'signature' }, { chance: 0.2 }],
      do: [{ kind: 'coinHit', multiplier: 0.4 }],
      killShards: 0.01,
    },
    { on: 'hit', when: [{ targetHpBelow: 0.15 }, { chance: 0.1 }], do: [{ kind: 'execute' }] },
  ];
  const stats = makeStats({ damage: 3, maxLife: 1e6, critChance: 0.2, igniteChance: 0.3 }, [], {
    triggers: triggers.map((spec) => ({ source: 'outer.greed', spec })),
    conversions: [],
    emitters: [
      { source: 'outer.summon', grant: { kind: 'drone', drones: 3 } },
      { source: 'outer.thorns', grant: { kind: 'thorns' } },
      ...grants,
    ],
  });
  const kills = new Map<number, string>();
  const lethal = new Map<number, string>();
  const watch: TestModule = (b) => {
    b.hook('onHit', (_ctx, hit) => {
      if ((hit.flags & KILLED) === 0) return;
      const by =
        hit.origin === 4
          ? 'execute'
          : hit.origin >= 1
            ? `trigger depth ${hit.depth}`
            : (hit.mask & TAG.thorns) !== 0
              ? 'thorns'
              : (hit.mask & TAG.minion) !== 0
                ? 'drone'
                : 'emitter';
      lethal.set(hit.target.id, by);
    });
    b.hook('onKill', (_ctx, victim) => {
      kills.set(
        victim.id,
        victim.killKind === KILL_BY_HIT ? (lethal.get(victim.id) ?? '?') : 'dot',
      );
    });
  };
  const sim = createSimulation(
    makeConfig({ stats, startWave: 8, maxTicks: 1800, seed: 1 }),
    makeTestData(),
    [watch],
  );
  const events: SimEvent[][] = [];
  while (!sim.state.finished) events.push([...sim.step(NO_INPUT)]);
  return { events, result: sim.result(), shards: sim.state.shards, kills };
}

const within = (x: number, y: number): boolean =>
  (x - PX) * (x - PX) + (y - PY) * (y - PY) <= 200 * 200;

describe('the gold ring in a run (G2, G5)', () => {
  it('drops × 1.5 on every kill inside the ring and the same on every kill outside it, by every killer, the run’s events otherwise the same', () => {
    // Planted bugs: the factor on some killers alone (emitters, triggers, depth 0, hits), the
    // ring tested before the victim's last move, or the run's events changed by the ring.
    const ringed = killersRun([RING]);
    const plain = killersRun([]);
    expect(ringed.events.length).toBe(plain.events.length);
    const inside: Record<string, number> = {};
    const outside: Record<string, number> = {};
    let total = num(0);
    ringed.events.forEach((tick, t) => {
      const twin = plain.events[t] as SimEvent[];
      expect(tick.length, `tick ${t + 1}`).toBe(twin.length);
      tick.forEach((event, i) => {
        const other = twin[i] as SimEvent;
        if (event.type !== 'enemyKilled' || other.type !== 'enemyKilled') {
          expect(event, `tick ${t + 1}`).toEqual(other);
          return;
        }
        const by = ringed.kills.get(event.enemyId) as string;
        const tally = within(event.x, event.y) ? inside : outside;
        tally[by] = (tally[by] ?? 0) + 1;
        expect({ ...event, shards: 0 }).toEqual({ ...other, shards: 0 });
        expect(event.shards, `kill of ${event.enemyId}`).toEqual(
          within(event.x, event.y) ? mul(other.shards, 1.5) : other.shards,
        );
        total = add(total, event.shards);
      });
    });
    expect(ringed.shards).toEqual(total);
    expect(ringed.result.shards).toEqual(total);
    expect({ ...ringed.result, shards: 0 }).toEqual({ ...plain.result, shards: 0 });
    // Every killer kills inside the ring, a coin at each depth among them.
    expect(Object.keys(inside).sort()).toEqual([
      'dot',
      'drone',
      'emitter',
      'execute',
      'thorns',
      'trigger depth 1',
      'trigger depth 2',
      'trigger depth 3',
    ]);
    expect(Object.keys(outside).length).toBeGreaterThan(3);
  });

  it('pays the ring on kills by a chain jump and by a shatter inside it, as on every other kill', () => {
    // Planted bugs: the factor skipped for a kill by a chain jump (CHAIN_JUMP in the killing
    // hit's flags) or by a shatter (origin SHATTER_TRIGGER), which no other test reaches.
    const run = (grants: readonly SourcedEmitter[]) => {
      const stats = makeStats(
        {
          damage: 4,
          maxLife: 1e6,
          critChance: 0,
          igniteChance: 0,
          attackSpeed: 6,
          projectileCount: 2,
          chainCount: 2,
          frostOnHit: 1,
          shatterDamage: 1.5,
          shatterRadius: 180,
        },
        [],
        { triggers: [], conversions: [], emitters: grants },
      );
      const lethal = new Map<number, string>();
      const watch: TestModule = (b) => {
        b.hook('onHit', (_ctx, hit) => {
          if ((hit.flags & KILLED) === 0) return;
          const by =
            hit.origin === SHATTER_TRIGGER
              ? 'shatter'
              : (hit.flags & CHAIN_JUMP) !== 0
                ? 'jump'
                : 'other';
          lethal.set(hit.target.id, by);
        });
      };
      const sim = createSimulation(
        makeConfig({ stats, startWave: 12, maxTicks: 1200, seed: 1 }),
        makeTestData(),
        [watch],
      );
      const events: SimEvent[][] = [];
      while (!sim.state.finished) events.push([...sim.step(NO_INPUT)]);
      return { events, shards: sim.state.shards, lethal };
    };
    const ringed = run([RING]);
    const plain = run([]);
    expect(ringed.events.length).toBe(plain.events.length);
    const inside: Record<string, number> = {};
    let total = num(0);
    ringed.events.forEach((tick, t) => {
      const twin = plain.events[t] as SimEvent[];
      expect(tick.length, `tick ${t + 1}`).toBe(twin.length);
      tick.forEach((event, i) => {
        const other = twin[i] as SimEvent;
        if (event.type !== 'enemyKilled' || other.type !== 'enemyKilled') {
          expect(event, `tick ${t + 1}`).toEqual(other);
          return;
        }
        const ring = within(event.x, event.y);
        if (ring) {
          const by = ringed.lethal.get(event.enemyId) ?? 'dot';
          inside[by] = (inside[by] ?? 0) + 1;
        }
        expect(event.shards, `kill of ${event.enemyId}`).toEqual(
          ring ? mul(other.shards, 1.5) : other.shards,
        );
        total = add(total, event.shards);
      });
    });
    expect(ringed.shards).toEqual(total);
    // Both killers kill inside the ring: 4 chain jumps and 2 shatters, beside 6 other kills.
    expect(inside).toEqual({ jump: 4, other: 6, shatter: 2 });
  });

  it('drops without the grant exactly what the base’s own killEnemy drops, event for event (one null test a kill)', () => {
    // Planted bug: the factor applied without the grant (a mult of 1 multiplied in, a default
    // ring), or the run's path changed for a build without one.
    mode.base = true;
    const base = killersRun([]);
    mode.base = false;
    const now = killersRun([]);
    expect(now.events).toEqual(base.events);
    expect(now.result).toEqual(base.result);
    expect(now.shards).toEqual(base.shards);
    const drops = now.events.flat().filter((e) => e.type === 'enemyKilled');
    expect(drops.length).toBeGreaterThan(50);
  });
});

describe('BuildFlags.goldRing (G1, G3) and its view (G4)', () => {
  const compiled = (
    grants: readonly SourcedEmitter[],
    modules: readonly TestModule[] = [],
    values: Partial<Record<StatId, number>> = {},
  ): CompiledBuild =>
    compileBuild(
      makeStats(values, [], { triggers: [], conversions: [], emitters: grants }),
      [],
      undefined,
      modules,
    );

  it('is null without a gold ring grant, and the ring’s radius squared and 1 + dropPct with one, adding no emitter', () => {
    // Planted bugs: a default ring without the grant; mult = dropPct; radiusSq = radius; the
    // ring compiled as an emitter.
    expect(compiled([]).flags.goldRing).toBeNull();
    const ringed = compiled([RING]);
    expect(ringed.flags.goldRing).toEqual({ radiusSq: 40000, mult: 1.5 });
    expect(
      compiled([{ source: 'hub', grant: { kind: 'goldRing', radius: 87.5, dropPct: 0.125 } }]).flags
        .goldRing,
    ).toEqual({ radiusSq: 7656.25, mult: 1.125 });
    expect(ringed.emitters).toEqual(compiled([]).emitters);
  });

  it('keeps the radius as written whatever areaSize, 巨大化, thornsArea and spreadRadius say', () => {
    // Planted bug: the radius × areaSize (or any of the build's factors).
    const build = compileBuild(
      makeStats({ areaSize: 1.5, thornsArea: 1.3, spreadRadius: 2 }, [], {
        triggers: [],
        conversions: [],
        emitters: [RING],
      }),
      [{ id: 'gigantism', sizeMult: 2 }],
    );
    expect([build.flags.areaFactor, build.flags.thornsFactor]).toEqual([3, 1.3]);
    expect(build.flags.goldRing).toEqual({ radiusSq: 40000, mult: 1.5 });
    expect(goldRingRadius(build)).toBe(200);
  });

  it('dedupes identical grants, of one source or of two, into one ring', () => {
    // Planted bug: two identical rings multiplied together (× 2.25) or refused.
    const twin: SourcedEmitter = { source: 'fusion.fire.greed', grant: RING.grant };
    expect(compiled([RING, RING]).flags.goldRing).toEqual({ radiusSq: 40000, mult: 1.5 });
    expect(compiled([RING, twin]).flags.goldRing).toEqual({ radiusSq: 40000, mult: 1.5 });
    const granting: TestModule = (b) => b.addEmitter('hub', { ...RING.grant });
    expect(compiled([RING], [granting]).flags.goldRing).toEqual({ radiusSq: 40000, mult: 1.5 });
  });

  it.each([
    [
      'another dropPct',
      { source: 'fusion.fire.greed', grant: { kind: 'goldRing', radius: 200, dropPct: 0.25 } },
      "goldRing: source 'outer.greed' grants radius 200, dropPct 0.5 and source " +
        "'fusion.fire.greed' radius 200, dropPct 0.25; a build has one gold ring",
    ],
    [
      'another radius',
      { source: 'hub', grant: { kind: 'goldRing', radius: 150, dropPct: 0.5 } },
      "goldRing: source 'outer.greed' grants radius 200, dropPct 0.5 and source 'hub' " +
        'radius 150, dropPct 0.5; a build has one gold ring',
    ],
    [
      'another dropPct of the same source',
      { source: 'outer.greed', grant: { kind: 'goldRing', radius: 200, dropPct: 0.75 } },
      "goldRing: source 'outer.greed' grants radius 200, dropPct 0.5 and source 'outer.greed' " +
        'radius 200, dropPct 0.75; a build has one gold ring',
    ],
  ] as const)(
    'refuses at compile a second ring of %s, naming both sources',
    (_label, other, message) => {
      // Planted bug: two different grants silently combined (the first kept, the last, a sum or
      // a product).
      expect(() => compiled([RING, other])).toThrow(message);
    },
  );

  it('takes a rule module’s addEmitter ring after the modules, refuses one that differs from the nodes’ or is out of range, and overrides a module’s own write', () => {
    // Planted bugs: the flag read before the modules ran; a module's ring of radius 0 or
    // dropPct −1 taken unchecked; a module's write of the flag kept over the grants'.
    const granting =
      (radius: number, dropPct: number): TestModule =>
      (b) =>
        b.addEmitter('outer.greed', { kind: 'goldRing', radius, dropPct });
    expect(compiled([], [granting(120, 1)]).flags.goldRing).toEqual({ radiusSq: 14400, mult: 2 });
    expect(() => compiled([RING], [granting(120, 1)])).toThrow(
      "goldRing: source 'outer.greed' grants radius 200, dropPct 0.5 and source 'outer.greed' " +
        'radius 120, dropPct 1; a build has one gold ring',
    );
    expect(() => compiled([], [granting(0, 0.5)])).toThrow(
      "goldRing of source 'outer.greed': radius must be finite and > 0 (got 0)",
    );
    expect(() => compiled([], [granting(200, -1)])).toThrow(
      "goldRing of source 'outer.greed': dropPct must be finite and > 0 (got -1)",
    );
    expect(() => compiled([], [granting(NaN, NaN)])).toThrow(
      "goldRing of source 'outer.greed': radius must be finite and > 0 (got NaN); " +
        'dropPct must be finite and > 0 (got NaN)',
    );
    const writing: TestModule = (b) => {
      b.flags.goldRing = { radiusSq: 1e6, mult: 3 };
    };
    expect(compiled([], [writing]).flags.goldRing).toBeNull();
    expect(compiled([RING], [writing]).flags.goldRing).toEqual({ radiusSq: 40000, mult: 1.5 });
  });

  it('gives the render’s radius as one number: the radius as written with the grant, 0 without', () => {
    // Planted bugs: the view's radius squared, sized, or left at the last build's.
    expect(goldRingRadius(compiled([]))).toBe(0);
    expect(goldRingRadius(compiled([RING]))).toBe(200);
    expect(goldRingRadius(compiled([RING], [], { areaSize: 1.5 }))).toBe(200);
    // √(r × r) rounded is r for every radius a ring can have (r² neither over- nor underflows).
    let seed = 7;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const radii = [87.5, 0.1, 1e-100, 1e150, 333.3333333333333, 199.99999999999997];
    for (let i = 0; i < 2000; i++) radii.push(10 ** (random() * 8 - 2));
    for (const radius of radii) {
      const build = compiled([
        { source: 'hub', grant: { kind: 'goldRing', radius, dropPct: 0.5 } },
      ]);
      expect(goldRingRadius(build), `${radius}`).toBe(radius);
    }
  });
});
