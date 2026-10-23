/**
 * The enemy AI step (docs/v3 C7 design §2.5, src/sim/systems/enemyAi.ts): regeneration, the
 * dasher and the treasure of a v3 run, the treasure schedule, the kill drops and the two
 * conditions. The design's OWN tests are named in their titles, each with a comment naming the
 * planted bug it kills; the rest pin the edge cases and the lead's rulings W4 (a frozen enemy
 * regenerates), W5 (the regeneration row), W6 (the treasure) and W7 (the drops). Placed enemies
 * stand on the line to the player's right, bearing (1, 0), and walk at their def's speed unless
 * a test says; tick() runs one tick's enemy AI and movement stages, as step does.
 */

import { describe, expect, it } from 'vitest';
import { mul, num, toNumber } from '../../core/num';
import { composeWave } from '../../data/compose';
import type { Modifier, StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { EnemyBehaviour, EnemyId, GameData, V3WaveRules } from '../../data/types';
import { applyBurn, applyPoison } from '../ailments/apply';
import { addBleed } from '../ailments/bleed';
import { statAt } from '../build/eval';
import type { EvalInput } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { CENTER, rowKey } from '../build/sources';
import type { RuleSpec } from '../../data/rules';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import {
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  recordRun,
  rngPositions,
  TEST_ENEMIES,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import type { PlacedEnemy, TestDataOverrides } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, NO_INPUT } from '../types';
import type { SimEvent } from '../types';
import { resolveContacts } from './contact';
import { createRunContext } from './context';
import type { Enemy, RunContext, WaveRecord } from './context';
import { killEnemy, removeEnemy } from './death';
import {
  CHARGING,
  DASHING,
  FLEEING,
  ORBITING,
  STOP_SLACK,
  STOPPED,
  stepEnemyAi,
  treasuresDue,
} from './enemyAi';
import type { EnemyV3 } from './enemyRecord';
import { moveEnemies } from './movement';
import { addEnemy, releaseEnemies } from './spawn';
import { startWave, updateClears } from './waves';

const { damage: DAMAGE, critMultiplier: CRIT_MULTIPLIER, enemyRegen: ENEMY_REGEN } = SCOPED_INDEX;

/** The player, at the arena's centre. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/**
 * An enemy of `type` `dx` to the player's right, walking at its def's speed unless `more` gives
 * one (placedEnemies' default is to stand), immortal in practice unless `more` gives its hp.
 */
const at = (
  type: EnemyId,
  dx: number,
  more: Omit<PlacedEnemy, 'x' | 'y' | 'type'> = {},
): PlacedEnemy => ({
  x: PLAYER.x + dx,
  y: PLAYER.y,
  type,
  speed: TEST_ENEMIES[type].speed,
  ...more,
});

/** The treasure schedule of TEST_V3_WAVES moved past every wave a test reaches. */
const NO_TREASURE = { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 };

/**
 * A v3 table whose waves hold no enemy, elite, boss, affix or treasure (docs/v3 C7 design §1.9),
 * so that only placed enemies exist, with the enemies of `enemies` and the v3 block of `v3`
 * (TEST_V3_WAVES.v3 spread, as v3TestData's merge is shallow).
 */
function quietV3(
  enemies: TestDataOverrides['enemies'] = {},
  v3: Partial<V3WaveRules> = {},
): GameData {
  return v3TestData({
    enemies,
    waves: {
      rules: [{ enemy: 'triangle', fromWave: 1, base: 0, perWave: 0, maxCount: 0 }],
      eliteEvery: 1000,
      bossEvery: 1000,
      spawnDurationSec: 0,
      waveTimerSec: 1000,
      v3: { ...TEST_V3_WAVES.v3, affixes: [], treasure: NO_TREASURE, ...v3 },
    },
  });
}

/** quietV3 with the treasure's behaviour over its def's (orbitDist 480, orbitSec 8, fleeMult 2). */
const treasureData = (behaviour: Partial<Extract<EnemyBehaviour, { kind: 'treasure' }>>) =>
  quietV3({
    treasure: {
      behaviour: { kind: 'treasure', orbitDist: 480, orbitSec: 8, fleeMult: 2, ...behaviour },
    },
  });

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly mods?: readonly Modifier[];
  readonly rules?: readonly RuleSpec[];
  readonly data?: GameData;
  readonly seed?: number;
}

/** placedEnemies on quietV3's data unless `options.data`, with these stats and rules. */
function placed(enemies: readonly PlacedEnemy[], options: Options = {}): RunContext {
  return placedEnemies(enemies, {
    stats: makeStats(options.values ?? {}, options.mods ?? []),
    rules: options.rules ?? [],
    data: options.data ?? quietV3(),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
}

/** The placed enemy of id `id`. */
const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies.find((e) => e.id === id) as Enemy;
const record = (e: Enemy): EnemyV3 => e.v3 as EnemyV3;
const hp = (e: Enemy): number => toNumber(e.hp);
const ids = (enemies: readonly Enemy[]): number[] => enemies.map((e) => e.id);

/**
 * Runs tick ctx.now's enemy AI and movement stages, as step runs them (no contact, hits or
 * deaths), and moves on to the next tick: the tick's events.
 */
function tick(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepEnemyAi(ctx);
  moveEnemies(ctx);
  const events = [...ctx.events];
  ctx.now++;
  ctx.state.tick++;
  return events;
}

/** `n` ticks; the ticks that pushed an event of `type`. */
function ticksWith(ctx: RunContext, n: number, type: SimEvent['type']): number[] {
  const seen: number[] = [];
  for (let k = 0; k < n; k++) {
    const now = ctx.now;
    if (tick(ctx).some((event) => event.type === type)) seen.push(now);
  }
  return seen;
}

/** Pushes `e` out by `distance`, as the push effect does (src/sim/effects/execute.ts). */
function push(ctx: RunContext, e: Enemy, distance: number): void {
  e.dist += distance;
  e.x = ctx.player.x + e.ux * e.dist;
  e.y = ctx.player.y + e.uy * e.dist;
}

/** Freezes `e` for the `ticks` ticks from ctx.now, as a freeze would. */
function freeze(ctx: RunContext, e: Enemy, ticks: number): void {
  ctx.frostApplied = true;
  e.frozenUntil = ctx.now + ticks;
}

/** A damage instance's input on `target` at ctx.now, in the run. */
const on = (ctx: RunContext, target: Enemy): EvalInput => ({
  now: ctx.now,
  target,
  chainJump: 0,
  playerLifeFrac: 1,
  ctx,
});

/** The bearing of `e`, in radians from the +x axis. */
const bearing = (e: Enemy): number => Math.atan2(e.uy, e.ux);

/** The treasure's walk step (speed 150) and its escape distance along (1, 0). */
const TREASURE_STEP = 150 * DT;
const RIGHT_ESCAPE = ARENA_WIDTH / 2 + TEST_ENEMIES.treasure.radius;

describe('the enemy AI list and step (docs/v3 C7 design §2.5)', () => {
  it('lists the v3 enemies with work, an AI behaviour or regeneration, in id order as they join; an M1 run lists none', () => {
    const ctx = placed([
      at('triangle', 600),
      at('regenerator', 600),
      at('dasher', 600),
      at('shielder', 600),
      at('treasure', 600),
      at('onion', 600),
      at('shooter', 600),
      at('summoner', 600),
    ]);
    // The shooter and summoner have AI kinds, though C7.4b gives them their work.
    expect(ids(ctx.sys.enemyAi.list)).toEqual([2, 3, 5, 7, 8]);
    addEnemy(ctx, ctx.data.enemies.square, ctx.current as WaveRecord, 1, 0, 700);
    addEnemy(ctx, ctx.data.enemies.regenerator, ctx.current as WaveRecord, 1, 0, 700);
    expect(ids(ctx.sys.enemyAi.list)).toEqual([2, 3, 5, 7, 8, 10]);
    const m1 = placedEnemies([at('square', 600), at('hexagon', 600)]);
    expect(m1.sys.enemyAi.enabled).toBe(false);
    expect(m1.sys.enemyAi.list).toEqual([]);
  });

  it('drops a dead entry from the list in place, so that it never acts, and keeps the rest in id order', () => {
    const ctx = placed([
      at('dasher', 420, { speed: 60 }),
      at('regenerator', 600, { hp: 1000 }),
      at('dasher', 420, { speed: 60 }),
      at('treasure', 600),
    ]);
    removeEnemy(ctx, enemy(ctx, 1));
    expect(tick(ctx)).toEqual([{ type: 'dasherCharge', enemyId: 3 }]);
    expect(record(enemy(ctx, 1)).state).toBe(0);
    expect(ids(ctx.sys.enemyAi.list)).toEqual([2, 3, 4]);
    removeEnemy(ctx, enemy(ctx, 3));
    removeEnemy(ctx, enemy(ctx, 4));
    tick(ctx);
    expect(ids(ctx.sys.enemyAi.list)).toEqual([2]);
  });

  it('runs after the tick’s releases: a dasher released within its chargeDist charges on its release tick, before it moves (lead ruling W2)', () => {
    // Planted bug: the step before releaseEnemies, so that a release waits a tick to act.
    const data = v3TestData({
      enemies: {
        dasher: {
          hpMult: 1e12,
          behaviour: { kind: 'dash', chargeDist: 5000, chargeSec: 0.6, dashMult: 4 },
        },
      },
      waves: {
        rules: [{ enemy: 'dasher', fromWave: 1, base: 1, perWave: 0, maxCount: 1 }],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
        waveTimerSec: 1000,
        v3: { ...TEST_V3_WAVES.v3, affixes: [], treasure: NO_TREASURE },
      },
    });
    // The tick hooks run after movement, right before the drones' stage (src/sim/simulation.ts
    // step); the release placed the dasher at spawn.ts's distance along its bearing.
    const first: { dist: number; placed: number; state: number }[] = [];
    const watch: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        const dasher = ctx.enemies[0];
        if (dasher === undefined || first.length > 0) return;
        first.push({
          dist: dasher.dist,
          placed: Math.min(
            (ARENA_WIDTH / 2 + dasher.radius) / Math.abs(dasher.ux),
            (ARENA_HEIGHT / 2 + dasher.radius) / Math.abs(dasher.uy),
          ),
          state: record(dasher).state,
        });
      });
    const sim = createSimulation(makeConfig({ maxTicks: 60 }), data, [watch]);
    const spawns: number[] = [];
    const charges: number[] = [];
    while (!sim.state.finished) {
      for (const event of sim.step(NO_INPUT)) {
        if (event.type === 'enemySpawned') spawns.push(sim.state.tick);
        if (event.type === 'dasherCharge') charges.push(sim.state.tick);
      }
    }
    expect(spawns).toHaveLength(1);
    expect(charges).toEqual(spawns);
    // On its release tick it stands, charging, where the release placed it.
    expect(first).toHaveLength(1);
    const [release] = first as [(typeof first)[number]];
    expect(release.state).toBe(CHARGING | STOPPED);
    expect(release.dist).toBe(release.placed);
  });

  it('draws nothing: every random stream ends where it started', () => {
    const ctx = placed([
      at('regenerator', 600, { hp: 1000 }),
      at('dasher', 430),
      at('treasure', 500),
      at('square', 700),
    ]);
    enemy(ctx, 1).hp = num(100);
    const before = rngPositions(ctx);
    const types = new Set<string>();
    for (let k = 0; k < 900; k++) for (const event of tick(ctx)) types.add(event.type);
    expect([...types].sort()).toEqual(['dasherCharge', 'dasherDash', 'treasureEscaped']);
    expect(hp(enemy(ctx, 1))).toBe(1000);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('gives the same events twice from the same seed (OWN test 13)', () => {
    // Planted bug: iterating a Set.
    const data = v3TestData({
      waves: {
        rules: [
          { enemy: 'regenerator', fromWave: 1, base: 2, perWave: 0.2, maxCount: 8 },
          { enemy: 'dasher', fromWave: 1, base: 2, perWave: 0.2, maxCount: 8 },
        ],
        eliteEvery: 1000,
        bossEvery: 1000,
        v3: {
          ...TEST_V3_WAVES.v3,
          affixes: [],
          treasure: { enemy: 'treasure', fromWave: 1, every: 1 },
        },
      },
    });
    const config = makeConfig({
      stats: makeStats({ frostOnHit: 0.2, bleedChance: 0.3, damage: 6 }),
      seed: 3,
      startWave: 12,
      maxTicks: 1200,
    });
    const first = recordRun(config, data).ticks;
    for (const type of ['dasherCharge', 'dasherDash', 'treasureEscaped'] as const) {
      expect(eventsOf(first, type).length, type).toBeGreaterThan(0);
    }
    expect(recordRun(config, data).ticks).toEqual(first);
  });
});

describe('regeneration (docs/v3 C7 design §2.5)', () => {
  it('regains 8 % of its max life a second, a sixtieth of that a tick, up to its max life (OWN test 1)', () => {
    // Planted bug: 8 % a tick.
    const ctx = placed([at('regenerator', 600, { hp: 1000 })]);
    const one = enemy(ctx, 1);
    one.hp = num(500);
    tick(ctx);
    expect(hp(one)).toBeCloseTo(500 + (1000 * 0.08) / 60, 9);
    for (let k = 1; k < 60; k++) tick(ctx);
    expect(hp(one)).toBeCloseTo(580, 9);
    one.hp = num(999.5);
    tick(ctx);
    expect(hp(one)).toBe(1000);
    tick(ctx);
    expect(hp(one)).toBe(1000);
  });

  it('regains nothing while it holds burn, as records and as eternalFlame’s rings (OWN test 2)', () => {
    // Planted bug: only the records checked.
    for (const rules of [[], [{ id: 'eternalFlame', durationMore: 0 }]] as const) {
      const ctx = placed([at('regenerator', 600, { hp: 1000 })], { rules });
      expect(ctx.burnRings).toBe(rules.length > 0);
      const one = enemy(ctx, 1);
      one.hp = num(500);
      // A burn from tick 1 to tick 31: it holds burn on ticks 1 to 30.
      applyBurn(ctx, one, num(1), ctx.now + 30, 0, CENTER, 1);
      for (let k = 0; k < 30; k++) tick(ctx);
      expect(hp(one), `rings ${ctx.burnRings}`).toBe(500);
      tick(ctx);
      expect(hp(one), `rings ${ctx.burnRings}`).toBeCloseTo(500 + (1000 * 0.08) / 60, 9);
    }
  });

  it('multiplies its rate by every enemyRegen modifier that holds: 凍結生機 and 凍瘡 give 0.08 × 0.2 × 0.4 (OWN test 3)', () => {
    // Planted bug: the two summed, as increased modifiers would be (1 − 0.8 − 0.6 < 0: none).
    const mods: Modifier[] = [
      { stat: 'enemyRegen', kind: 'more', value: -0.8, when: [{ targetHas: 'frost' }] },
      { stat: 'enemyRegen', kind: 'more', value: -0.6, when: [{ targetFrostAtLeast: 0.3 }] },
    ];
    const ctx = placed(
      [
        at('regenerator', 600, { hp: 1e6 }),
        at('regenerator', 610, { hp: 1e6 }),
        at('regenerator', 620, { hp: 1e6 }),
      ],
      { mods },
    );
    const [clean, chilled, deep] = [1, 2, 3].map((id) => enemy(ctx, id)) as [Enemy, Enemy, Enemy];
    for (const e of [clean, chilled, deep]) e.hp = num(1e5);
    ctx.frostApplied = true;
    chilled.frost = 0.2;
    deep.frost = 0.3;
    tick(ctx);
    const gain = (e: Enemy): number => hp(e) - 1e5;
    expect(gain(clean)).toBeCloseTo(1e6 * 0.08 * DT, 6);
    expect(gain(chilled)).toBeCloseTo(1e6 * 0.08 * 0.2 * DT, 6);
    expect(gain(deep)).toBeCloseTo(1e6 * 0.08 * 0.2 * 0.4 * DT, 6);
  });

  it('never regains less than nothing: 抗凝 stops it, and a deeper cut does not take life (W5)', () => {
    const mods: Modifier[] = [
      { stat: 'enemyRegen', kind: 'more', value: -1, when: [{ targetHas: 'bleed' }] },
      { stat: 'enemyRegen', kind: 'increased', value: -2, when: [{ targetHas: 'poison' }] },
    ];
    const ctx = placed(
      [at('regenerator', 600, { hp: 1000 }), at('regenerator', 610, { hp: 1000 })],
      {
        mods,
      },
    );
    const [bleeding, poisoned] = [enemy(ctx, 1), enemy(ctx, 2)];
    bleeding.hp = num(500);
    poisoned.hp = num(500);
    bleeding.bleedUntil = 1000;
    applyPoison(ctx, poisoned, num(1), 1000, 0, CENTER, 1);
    expect(statAt(ctx.table, ctx.sys.enemyAi.regenRow, ENEMY_REGEN, on(ctx, poisoned))).toBe(-1);
    for (let k = 0; k < 10; k++) tick(ctx);
    expect([hp(bleeding), hp(poisoned)]).toEqual([500, 500]);
  });

  it('reads enemyRegen on the untagged center row, filled once at run creation; an M1 run has none (W5)', () => {
    // A hit-tagged enemyRegen modifier, which validation rejects, does not reach that row.
    const mods: Modifier[] = [
      { stat: 'enemyRegen', kind: 'more', value: -1, tags: ['hit'] },
      { stat: 'enemyRegen', kind: 'more', value: -0.5 },
    ];
    const ctx = placed([at('regenerator', 600, { hp: 1000 })], { mods });
    const ai = ctx.sys.enemyAi;
    expect(ai.regenRow).toBeGreaterThanOrEqual(0);
    expect(ai.regenRow).toBe(ctx.table.row(rowKey(0, CENTER)));
    expect(ai.regenRow).not.toBe(ctx.table.row(rowKey(TAG.hit, CENTER)));
    const one = enemy(ctx, 1);
    one.hp = num(500);
    tick(ctx);
    expect(hp(one)).toBeCloseTo(500 + (1000 * 0.08 * 0.5) / 60, 9);
    const m1 = createRunContext(makeConfig({ stats: makeStats({}, mods) }), makeTestData());
    expect(m1.sys.enemyAi.regenRow).toBe(-1);
  });

  it('reads its conditions at this tick against the regenerating enemy, at chain jump 0, whatever an earlier reader left', () => {
    const mods: Modifier[] = [
      { stat: 'enemyRegen', kind: 'more', value: -1, when: [{ targetHas: 'bleed' }] },
      { stat: 'enemyRegen', kind: 'increased', value: 1, scaling: { per: 'chainJump' } },
    ];
    const ctx = placed(
      [at('regenerator', 600, { hp: 1000 }), at('regenerator', 610, { hp: 1000 })],
      {
        mods,
      },
    );
    const [ended, bleeding] = [enemy(ctx, 1), enemy(ctx, 2)];
    ended.hp = num(500);
    bleeding.hp = num(500);
    // The first one's bleed ended on this tick; the second one bleeds.
    ended.bleedUntil = ctx.now;
    bleeding.bleedUntil = ctx.now + 100;
    const ev = ctx.evalInput;
    ev.now = 0;
    ev.target = bleeding;
    ev.chainJump = 3;
    tick(ctx);
    expect(hp(ended)).toBeCloseTo(500 + (1000 * 0.08) / 60, 9);
    expect(hp(bleeding)).toBe(500);
  });

  it('regenerates a frozen enemy, whose timers pause: a frozen charging dasher dashes as many ticks later (lead ruling W4)', () => {
    // §2.5's step (a) skips a frozen entry; its edge case, which W4 follows, keeps its regen.
    const ctx = placed([at('regenerator', 600, { hp: 1000 }), at('dasher', 420, { speed: 60 })]);
    const [regen, dasher] = [enemy(ctx, 1), enemy(ctx, 2)];
    regen.hp = num(500);
    expect(tick(ctx)).toEqual([{ type: 'dasherCharge', enemyId: 2 }]);
    // Ticks 2 to 11 frozen: the charge of ticks 1 to 36 ends on tick 46 instead.
    freeze(ctx, regen, 10);
    freeze(ctx, dasher, 10);
    const before = hp(regen);
    for (let k = 0; k < 10; k++) tick(ctx);
    expect(hp(regen)).toBeCloseTo(before + (10 * 1000 * 0.08) / 60, 9);
    expect(record(dasher).stateUntil).toBe(37 + 10);
    expect(ticksWith(ctx, 60, 'dasherDash')).toEqual([47]);
  });

  it('regenerates before it acts (lead ruling W4): a dasher given a regeneration regains as it walks on its charge tick, and not once it stands', () => {
    // Only a record with both shows the order (C7.6's 再生 elites); the behaviour first would
    // read the charge's STOPPED on that tick.
    const mods: Modifier[] = [
      { stat: 'enemyRegen', kind: 'more', value: -1, when: [{ targetState: 'stopped' }] },
    ];
    const ctx = placed([at('dasher', 420, { hp: 1000 })], { mods });
    const dasher = enemy(ctx, 1);
    record(dasher).regen = 0.08;
    dasher.hp = num(500);
    expect(tick(ctx)).toEqual([{ type: 'dasherCharge', enemyId: 1 }]);
    expect(hp(dasher)).toBeCloseTo(500 + (1000 * 0.08) / 60, 9);
    tick(ctx);
    expect(hp(dasher)).toBeCloseTo(500 + (1000 * 0.08) / 60, 9);
  });
});

describe('the dasher (docs/v3 C7 design §2.5)', () => {
  it('charges at chargeDist or closer, standing 36 ticks with dasherCharge, then dashes at 4 × its step with dasherDash; frozen ticks do not count (OWN test 4)', () => {
    // Planted bug: a dash at 420 with no charge.
    const ctx = placed([at('dasher', 425, { speed: 60 })]);
    const one = enemy(ctx, 1);
    const trail: [number, string[], number, number][] = [];
    for (let k = 0; k < 45; k++) {
      const now = ctx.now;
      const events = tick(ctx);
      trail.push([now, events.map((event) => event.type), one.dist, record(one).state]);
    }
    // Walking 1 a tick from 425, it reaches 420 on tick 5 and charges on tick 6.
    expect(trail.slice(0, 5)).toEqual(
      [424, 423, 422, 421, 420].map((dist, k) => [k + 1, [], dist, 0]),
    );
    expect(trail[5]).toEqual([6, ['dasherCharge'], 420, CHARGING | STOPPED]);
    const standing = trail.filter(([, , dist, state]) => dist === 420 && state !== 0);
    expect(standing.map(([now]) => now)).toEqual(Array.from({ length: 36 }, (_, k) => 6 + k));
    expect(trail.slice(41)).toEqual([
      [42, ['dasherDash'], 416, DASHING],
      [43, [], 412, DASHING],
      [44, [], 408, DASHING],
      [45, [], 404, DASHING],
    ]);
    // Frozen for 10 of its charge ticks, it dashes 10 ticks later.
    const frozen = placed([at('dasher', 425, { speed: 60 })]);
    for (let k = 0; k < 9; k++) tick(frozen);
    freeze(frozen, enemy(frozen, 1), 10);
    expect(ticksWith(frozen, 60, 'dasherDash')).toEqual([52]);
  });

  it('charges at exactly chargeDist, for chargeSec × 60 rounded to whole ticks', () => {
    for (const [chargeSec, ticks] of [
      [0.6, 36],
      [0.61, 37],
      [0.59, 35],
    ] as const) {
      const data = quietV3({
        dasher: { behaviour: { kind: 'dash', chargeDist: 420, chargeSec, dashMult: 4 } },
      });
      const ctx = placed([at('dasher', 420, { speed: 60 })], { data });
      expect(tick(ctx), `${chargeSec}`).toEqual([{ type: 'dasherCharge', enemyId: 1 }]);
      expect(ticksWith(ctx, 60, 'dasherDash'), `${chargeSec}`).toEqual([1 + ticks]);
    }
  });

  it("applies 迎擊's targetState 'dashing' only while the dasher dashes, and 'stopped' only while it charges (OWN test 5)", () => {
    // Planted bug: reading the def's kind instead of the state.
    const mods: Modifier[] = [
      { stat: 'damage', kind: 'more', value: 1, when: [{ targetState: 'dashing' }] },
      { stat: 'critMultiplier', kind: 'flat', value: 1, when: [{ targetState: 'stopped' }] },
    ];
    const ctx = placed(
      [
        at('dasher', 421, { speed: 60 }),
        at('regenerator', 600),
        at('treasure', 480),
        at('shooter', 600),
      ],
      { mods },
    );
    const row = ctx.table.row(rowKey(TAG.hit, CENTER));
    const read = (e: Enemy): [number, number] => [
      statAt(ctx.table, row, DAMAGE, on(ctx, e)),
      statAt(ctx.table, row, CRIT_MULTIPLIER, on(ctx, e)),
    ];
    const dasher = enemy(ctx, 1);
    const phases: [number, [number, number]][] = [];
    for (let k = 0; k < 40; k++) {
      phases.push([record(dasher).state, read(dasher)]);
      tick(ctx);
    }
    // Walking (ticks 1 and 2), charging (3 to 38) and dashing: [damage, critMultiplier].
    expect(new Set(phases.map((phase) => JSON.stringify(phase)))).toEqual(
      new Set([
        JSON.stringify([0, [1, 1.5]]),
        JSON.stringify([CHARGING | STOPPED, [1, 2.5]]),
        JSON.stringify([DASHING, [2, 1.5]]),
      ]),
    );
    // A regenerator, an orbiting treasure and a shooter (before C7.4b) are in neither state.
    expect(record(enemy(ctx, 3)).state).toBe(ORBITING);
    for (const id of [2, 3, 4]) expect(read(enemy(ctx, id)), `${id}`).toEqual([1, 1.5]);
    // Nor is any enemy of an M1 run, which has no record.
    const m1 = placedEnemies([at('square', 400)], { stats: makeStats({}, mods) });
    const square = m1.enemies[0] as Enemy;
    const m1Row = m1.table.row(rowKey(TAG.hit, CENTER));
    expect(statAt(m1.table, m1Row, DAMAGE, on(m1, square))).toBe(1);
    expect(statAt(m1.table, m1Row, CRIT_MULTIPLIER, on(m1, square))).toBe(1.5);
  });

  it('applies targetFrostAtLeast 0.3 at a chill of exactly 0.3, and to a frozen enemy (OWN test 6)', () => {
    // Planted bug: `>`.
    const mods: Modifier[] = [
      { stat: 'damage', kind: 'more', value: 1, when: [{ targetFrostAtLeast: 0.3 }] },
    ];
    const ctx = placed(
      [at('square', 600), at('square', 600), at('square', 600), at('square', 600)],
      { mods },
    );
    const [below, exact, above, frozen] = [1, 2, 3, 4].map((id) => enemy(ctx, id)) as [
      Enemy,
      Enemy,
      Enemy,
      Enemy,
    ];
    below.frost = 0.29;
    exact.frost = 0.3;
    above.frost = 0.31;
    freeze(ctx, frozen, 10);
    const row = ctx.table.row(rowKey(TAG.hit, CENTER));
    expect(
      [below, exact, above, frozen].map((e) => statAt(ctx.table, row, DAMAGE, on(ctx, e))),
    ).toEqual([1, 2, 2, 2]);
  });

  it('holds the dasher in chargeStarts on its charge tick only, filled before the drones’ stage (OWN test 7)', () => {
    // Planted bug: added at the dash.
    const data = v3TestData({
      enemies: { dasher: { hpMult: 1e12 } },
      waves: {
        rules: [{ enemy: 'dasher', fromWave: 1, base: 1, perWave: 0, maxCount: 1 }],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
        waveTimerSec: 1000,
        v3: { ...TEST_V3_WAVES.v3, affixes: [], treasure: NO_TREASURE },
      },
    });
    // The tick hooks run right before the drones' stage (src/sim/simulation.ts step).
    const starts: [number, number[]][] = [];
    const watch: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        const ai = ctx.sys.enemyAi;
        if (ai.chargeStartCount > 0) {
          starts.push([ctx.now, ids(ai.chargeStarts.slice(0, ai.chargeStartCount))]);
        }
      });
    const sim = createSimulation(makeConfig({ maxTicks: 600 }), data, [watch]);
    const charges: [number, number][] = [];
    const dashes: number[] = [];
    while (!sim.state.finished) {
      for (const event of sim.step(NO_INPUT)) {
        if (event.type === 'dasherCharge') charges.push([sim.state.tick, event.enemyId]);
        if (event.type === 'dasherDash') dashes.push(sim.state.tick);
      }
    }
    expect(charges.length).toBeGreaterThan(0);
    expect(starts).toEqual(charges.map(([now, id]) => [now, [id]]));
    expect(dashes).toEqual(charges.map(([now]) => now + 36).filter((now) => now <= 600));
  });

  it('holds the dashers that begin charging on one tick in chargeStarts in id order, as the walk appends them', () => {
    // Planted bug: chargeStarts filled newest first.
    const ctx = placed([
      at('dasher', 420, { speed: 60 }),
      at('dasher', 600, { speed: 60 }),
      at('dasher', 410, { speed: 60 }),
      at('dasher', 400, { speed: 60 }),
    ]);
    const ai = ctx.sys.enemyAi;
    const starts = (): number[] => ids(ai.chargeStarts.slice(0, ai.chargeStartCount));
    tick(ctx);
    expect(starts()).toEqual([1, 3, 4]);
    tick(ctx);
    expect(starts()).toEqual([]);
  });

  it('keeps its state when pushed: pushed while charging it stands and dashes on time from further out; pushed while dashing it dashes on', () => {
    const ctx = placed([at('dasher', 420, { speed: 60 })]);
    const one = enemy(ctx, 1);
    for (let k = 0; k < 10; k++) tick(ctx);
    push(ctx, one, 100);
    for (let k = 0; k < 26; k++) {
      tick(ctx);
      expect(one.dist).toBe(520);
      expect(record(one).state).toBe(CHARGING | STOPPED);
    }
    expect(tick(ctx).map((event) => event.type)).toEqual(['dasherDash']);
    expect(one.dist).toBe(516);
    push(ctx, one, 100);
    expect(tick(ctx)).toEqual([]);
    expect([one.dist, record(one).state]).toEqual([612, DASHING]);
  });

  it('dashes at its slowed step, as movement scales any step', () => {
    const ctx = placed([at('dasher', 420, { speed: 60 })]);
    const one = enemy(ctx, 1);
    for (let k = 0; k < 37; k++) tick(ctx);
    expect([one.dist, record(one).state]).toEqual([416, DASHING]);
    // A chill of 0.5 under frostSlowCap 0.3 slows it by 15 %.
    ctx.frostApplied = true;
    one.frost = 0.5;
    tick(ctx);
    expect(one.dist).toBeCloseTo(416 - 4 * (1 - 0.15), 9);
    freeze(ctx, one, 2);
    tick(ctx);
    tick(ctx);
    expect(one.dist).toBeCloseTo(416 - 4 * (1 - 0.15), 9);
  });

  it('leaks at contact while dashing, as any enemy: life lost, its wave’s leaked mark, no kill', () => {
    const ctx = placed([at('dasher', 60, { speed: 60 })]);
    const one = enemy(ctx, 1);
    const seen: SimEvent[] = [];
    for (let k = 0; k < 60 && one.alive; k++) {
      ctx.events.length = 0;
      stepEnemyAi(ctx);
      moveEnemies(ctx);
      resolveContacts(ctx);
      seen.push(...ctx.events);
      ctx.now++;
    }
    expect(one.alive).toBe(false);
    expect(seen.map((event) => event.type)).toEqual(['dasherCharge', 'dasherDash', 'playerHit']);
    expect(ctx.player.life).toBe(100 - TEST_ENEMIES.dasher.contactDamage);
    expect([one.rec.leaked, ctx.kills]).toEqual([true, 0]);
  });
});

describe('the treasure (docs/v3 C7 design §2.5)', () => {
  it('orbits 480 ticks at radius 480, then flees and escapes with treasureEscaped: no kill, no hit, no leak, its wave cleared (OWN test 8)', () => {
    // Planted bug: the escape through the leak path.
    const data = v3TestData({
      enemies: { treasure: { hpMult: 1e12 } },
      waves: {
        rules: [{ enemy: 'triangle', fromWave: 1, base: 0, perWave: 0, maxCount: 0 }],
        eliteEvery: 1000,
        bossEvery: 1000,
        spawnDurationSec: 0,
        waveTimerSec: 1000,
        v3: {
          ...TEST_V3_WAVES.v3,
          affixes: [],
          treasure: { enemy: 'treasure', fromWave: 1, every: 1000 },
        },
      },
    });
    const trail: [number, number, number][] = [];
    const watch: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        const one = ctx.enemies.find((e) => e.id === 1);
        if (one?.alive === true) trail.push([ctx.now, record(one).state, one.dist]);
      });
    const { ticks, result } = (() => {
      const sim = createSimulation(makeConfig({ maxTicks: 1000 }), data, [watch]);
      const byTick: SimEvent[][] = [];
      while (!sim.state.finished) byTick.push([...sim.step(NO_INPUT)]);
      return { ticks: byTick, result: sim.result() };
    })();
    expect(eventsOf(ticks, 'enemySpawned').map((event) => event.enemy)).toEqual(['treasure']);
    const orbit = trail.filter(([, state]) => state === ORBITING);
    expect(orbit).toHaveLength(480);
    const radius = (orbit[0] as [number, number, number])[2];
    expect(radius).toBeGreaterThan(480 - TREASURE_STEP);
    expect(radius).toBeLessThanOrEqual(480);
    expect(orbit.every(([, , dist]) => dist === radius)).toBe(true);
    // One run of ticks: in, round, out.
    const first = (orbit[0] as [number, number, number])[0];
    expect(orbit.map(([now]) => now)).toEqual(Array.from({ length: 480 }, (_, k) => first + k));
    const flight = trail.filter(([, state]) => state === FLEEING);
    expect(flight[0]?.[0]).toBe(first + 480);
    flight.forEach(([, , dist], k) =>
      expect(dist).toBeCloseTo(radius + (k + 1) * 2 * TREASURE_STEP, 9),
    );
    const escapes = eventsOf(ticks, 'treasureEscaped');
    expect(escapes).toHaveLength(1);
    const escapeTick =
      ticks.findIndex((events) => events.some((e) => e.type === 'treasureEscaped')) + 1;
    expect(escapeTick).toBe(first + 480 + flight.length);
    const { x, y } = escapes[0] as Extract<SimEvent, { type: 'treasureEscaped' }>;
    const r = TEST_ENEMIES.treasure.radius;
    expect(x <= -r || x >= ARENA_WIDTH + r || y <= -r || y >= ARENA_HEIGHT + r).toBe(true);
    expect(eventsOf(ticks, 'enemyKilled')).toEqual([]);
    expect(eventsOf(ticks, 'playerHit')).toEqual([]);
    expect([result.leaks, result.kills, toNumber(result.shards), result.cores]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(ticks[escapeTick - 1]).toContainEqual({ type: 'waveCleared', wave: 1 });
  });

  it('pays 20 × shardsPerStd × shardGain and a core when killed, fleeing too (OWN test 9)', () => {
    // Planted bug: dropMult not read.
    const data = treasureData({ orbitSec: 0.1 });
    const ctx = placed([at('treasure', 600), at('treasure', 480)], {
      values: { shardGain: 1.5 },
      data,
    });
    const [walking, fleeing] = [enemy(ctx, 1), enemy(ctx, 2)];
    // The second orbits ticks 1 to 6 and flees from tick 7.
    for (let k = 0; k < 7; k++) tick(ctx);
    expect([record(walking).state, record(fleeing).state]).toEqual([0, FLEEING]);
    ctx.events.length = 0;
    killEnemy(ctx, walking, -1, 0);
    killEnemy(ctx, fleeing, -1, 0);
    const shards = toNumber(mul(mul(num(20), walking.rec.shardsPerStd), 1.5));
    expect(
      eventsOf([ctx.events], 'enemyKilled').map((k) => [k.enemyId, toNumber(k.shards), k.cores]),
    ).toEqual([
      [1, shards, 1],
      [2, shards, 1],
    ]);
  });

  it('starts its orbit at exactly orbitDist, standing and turning by its step over orbitDist a tick', () => {
    const ctx = placed([at('treasure', 480), at('treasure', 480.5)]);
    const [inside, outside] = [enemy(ctx, 1), enemy(ctx, 2)];
    tick(ctx);
    expect([record(inside).state, inside.stepDist, inside.dist]).toEqual([ORBITING, 0, 480]);
    expect(bearing(inside)).toBeCloseTo(TREASURE_STEP / 480, 12);
    expect(inside.x).toBeCloseTo(PLAYER.x + 480 * Math.cos(TREASURE_STEP / 480), 9);
    expect(inside.y).toBeCloseTo(PLAYER.y + 480 * Math.sin(TREASURE_STEP / 480), 9);
    // From 480.5 it walks in to 478, then orbits there.
    expect([record(outside).state, outside.dist, bearing(outside)]).toEqual([0, 478, 0]);
    for (let k = 0; k < 9; k++) tick(ctx);
    expect(bearing(inside)).toBeCloseTo((10 * TREASURE_STEP) / 480, 12);
    expect([record(outside).state, outside.dist]).toEqual([ORBITING, 478]);
    expect(bearing(outside)).toBeCloseTo((9 * TREASURE_STEP) / 480, 12);
  });

  it('orbits for orbitSec × 60 rounded ticks of unfrozen time', () => {
    for (const [orbitSec, ticks] of [
      [8, 480],
      [0.61, 37],
      [0.59, 35],
    ] as const) {
      const ctx = placed([at('treasure', 480)], { data: treasureData({ orbitSec }) });
      const one = enemy(ctx, 1);
      let fled = 0;
      for (let k = 0; k < 500 && fled === 0; k++) {
        const now = ctx.now;
        tick(ctx);
        if (record(one).state === FLEEING) fled = now;
      }
      expect(fled, `${orbitSec}`).toBe(1 + ticks);
    }
    // Frozen for 10 ticks of its orbit, it flees 10 ticks later, not having turned meanwhile.
    const ctx = placed([at('treasure', 480)]);
    const one = enemy(ctx, 1);
    for (let k = 0; k < 100; k++) tick(ctx);
    freeze(ctx, one, 10);
    const turned = bearing(one);
    for (let k = 0; k < 10; k++) tick(ctx);
    expect(bearing(one)).toBe(turned);
    expect(record(one).stateUntil).toBe(481 + 10);
    for (let k = 0; k < 380; k++) tick(ctx);
    expect(record(one).state).toBe(ORBITING);
    tick(ctx);
    expect(record(one).state).toBe(FLEEING);
  });

  it('turns by its slowed step: a chill of 0.5 turns it 15 % less', () => {
    const ctx = placed([at('treasure', 480), at('treasure', 480)]);
    const [plain, chilled] = [enemy(ctx, 1), enemy(ctx, 2)];
    ctx.frostApplied = true;
    chilled.frost = 0.5;
    tick(ctx);
    expect(bearing(plain)).toBeCloseTo(TREASURE_STEP / 480, 12);
    expect(bearing(chilled)).toBeCloseTo((TREASURE_STEP * 0.85) / 480, 12);
  });

  it(`walks back in when pushed past orbitDist + STOP_SLACK (${STOP_SLACK}), turning instead at exactly that`, () => {
    const ctx = placed([at('treasure', 480), at('treasure', 480)]);
    const [kept, pushedOut] = [enemy(ctx, 1), enemy(ctx, 2)];
    tick(ctx);
    push(ctx, kept, STOP_SLACK);
    push(ctx, pushedOut, STOP_SLACK + 0.5);
    const turned = bearing(pushedOut);
    tick(ctx);
    expect([kept.dist, kept.stepDist]).toEqual([484, 0]);
    expect(bearing(kept)).toBeCloseTo((2 * TREASURE_STEP) / 480, 12);
    expect([pushedOut.dist, pushedOut.stepDist, bearing(pushedOut)]).toEqual([
      484.5 - TREASURE_STEP,
      TREASURE_STEP,
      turned,
    ]);
    tick(ctx);
    expect([pushedOut.dist, pushedOut.stepDist, record(pushedOut).state]).toEqual([
      482,
      0,
      ORBITING,
    ]);
    expect(bearing(pushedOut)).toBeCloseTo((2 * TREASURE_STEP) / 480, 12);
  });

  it('flees outward at fleeMult × its step and escapes past the arena’s edge, its escape distance from both axes', () => {
    for (const degrees of [10, 30]) {
      const theta = (degrees * Math.PI) / 180;
      // At 479, inside its orbit whatever the rounding of its position.
      const ctx = placed(
        [
          {
            x: PLAYER.x + 479 * Math.cos(theta),
            y: PLAYER.y + 479 * Math.sin(theta),
            type: 'treasure',
            speed: 150,
          },
        ],
        { data: treasureData({ orbitSec: 0.1 }) },
      );
      const one = enemy(ctx, 1);
      for (let k = 0; k < 7; k++) tick(ctx);
      expect(record(one).state).toBe(FLEEING);
      const { ux, uy } = one;
      const r = TEST_ENEMIES.treasure.radius;
      const byX = (ARENA_WIDTH / 2 + r) / Math.abs(ux);
      const byY = (ARENA_HEIGHT / 2 + r) / Math.abs(uy);
      // At 10° the arena's side is nearer; at 30° its bottom.
      expect(degrees === 10 ? byX < byY : byY < byX).toBe(true);
      expect(record(one).escapeDist).toBe(Math.min(byX, byY));
      expect(one.stepDist).toBe(-2 * TREASURE_STEP);
      const from = one.dist;
      tick(ctx);
      expect(one.dist).toBeCloseTo(from + 2 * TREASURE_STEP, 9);
      // Removed on the first tick that starts at its escape distance or past it, where it is.
      let last = { dist: 0, x: 0, y: 0 };
      let escaped: SimEvent[] = [];
      for (let k = 0; k < 400 && one.alive; k++) {
        last = { dist: one.dist, x: one.x, y: one.y };
        escaped = tick(ctx);
      }
      expect(escaped).toEqual([{ type: 'treasureEscaped', enemyId: 1, x: last.x, y: last.y }]);
      expect(last.dist).toBeGreaterThanOrEqual(record(one).escapeDist);
      expect(last.dist - 2 * TREASURE_STEP).toBeLessThan(record(one).escapeDist);
      if (degrees === 10) expect(last.x).toBeGreaterThanOrEqual(ARENA_WIDTH + r);
      else expect(last.y).toBeGreaterThanOrEqual(ARENA_HEIGHT + r);
    }
  });

  it('escapes at its own radius, as a spawn is placed: an origin’s radius scale counts', () => {
    const ctx = placed([], { data: treasureData({ orbitSec: 0.1 }) });
    const origin = { hpScale: 1, radiusScale: 0.5, dropScale: 1, extra: true, affixes: 0 };
    addEnemy(ctx, ctx.data.enemies.treasure, ctx.current as WaveRecord, 1, 0, 480, origin);
    const one = ctx.enemies[0] as Enemy;
    expect(one.radius).toBe(7);
    for (let k = 0; k < 7; k++) tick(ctx);
    expect(record(one).state).toBe(FLEEING);
    // Six ticks of its orbit turned it off the axis.
    const escapeAt = (r: number): number =>
      Math.min((ARENA_WIDTH / 2 + r) / Math.abs(one.ux), (ARENA_HEIGHT / 2 + r) / Math.abs(one.uy));
    expect(record(one).escapeDist).toBe(escapeAt(7));
    expect(escapeAt(7)).toBeLessThan(escapeAt(TEST_ENEMIES.treasure.radius));
  });

  it('is removed at its escape without a kill or a leak: no drops, kills or life lost, its rings released, its wave’s alive count down by one (W6)', () => {
    const ctx = placed([at('treasure', RIGHT_ESCAPE - 1), at('square', 700)], {
      data: treasureData({ orbitSec: 0.1 }),
    });
    const [one, other] = [enemy(ctx, 1), enemy(ctx, 2)];
    const rec = one.rec;
    applyPoison(ctx, one, num(1), 1000, 0, CENTER, 3);
    expect([ctx.rings.live, rec.alive]).toEqual([1, 2]);
    // Put it in flight one step short of its escape.
    const v = record(one);
    v.state = FLEEING;
    v.escapeDist = RIGHT_ESCAPE;
    one.stepDist = -2 * TREASURE_STEP;
    expect(tick(ctx)).toEqual([]);
    const life = ctx.player.life;
    const { x, y } = one;
    expect(x).toBe(PLAYER.x + RIGHT_ESCAPE + 4);
    expect(tick(ctx)).toEqual([{ type: 'treasureEscaped', enemyId: 1, x, y }]);
    expect(one.alive).toBe(false);
    expect([ctx.kills, toNumber(ctx.state.shards), ctx.state.cores]).toEqual([0, 0, 0]);
    expect([ctx.player.life, rec.leaked, rec.alive, ctx.enemiesDirty]).toEqual([
      life,
      false,
      1,
      true,
    ]);
    expect([ctx.rings.live, one.dotRings, one.poisonStacks]).toEqual([0, 0, 0]);
    expect(one.rings.every((slot) => slot === -1)).toBe(true);
    expect(ids(ctx.sys.enemyAi.list)).toEqual([1]);
    tick(ctx);
    expect(ids(ctx.sys.enemyAi.list)).toEqual([]);
    // Gone for its wave's clear, once the other one goes.
    updateClears(ctx);
    expect(ctx.events.filter((event) => event.type === 'waveCleared')).toEqual([]);
    removeEnemy(ctx, other);
    updateClears(ctx);
    expect(ctx.events.at(-1)).toEqual({ type: 'waveCleared', wave: 1 });
  });

  it('escapes on the tick it starts at exactly its escape distance', () => {
    const ctx = placed([at('treasure', RIGHT_ESCAPE)], { data: treasureData({}) });
    const one = enemy(ctx, 1);
    const v = record(one);
    v.state = FLEEING;
    v.escapeDist = RIGHT_ESCAPE;
    one.stepDist = -2 * TREASURE_STEP;
    expect(one.dist).toBe(RIGHT_ESCAPE);
    expect(tick(ctx)).toEqual([
      { type: 'treasureEscaped', enemyId: 1, x: PLAYER.x + RIGHT_ESCAPE, y: PLAYER.y },
    ]);
    expect(one.alive).toBe(false);
  });

  it('counts a bleeding treasure’s ticks as moving while it orbits, whose dist does not change, and while it flees (OWN test 12)', () => {
    // Planted bug: movement's `<` kept.
    const ctx = placed([at('treasure', 480), at('square', 700, { speed: 60 })], {
      data: treasureData({ orbitSec: 0.5 }),
    });
    const [treasure, square] = [enemy(ctx, 1), enemy(ctx, 2)];
    for (const e of [treasure, square]) addBleed(ctx, e, num(8), ctx.now + 600, 0, CENTER);
    // Orbiting on ticks 1 to 30 and fleeing from 31, it counts each tick as the walking square
    // does, from the tick after the bleed's start.
    for (let k = 0; k < 30; k++) tick(ctx);
    expect(record(treasure).state).toBe(ORBITING);
    expect([treasure.bleedMovedTicks, square.bleedMovedTicks]).toEqual([29, 29]);
    for (let k = 0; k < 10; k++) tick(ctx);
    expect(record(treasure).state).toBe(FLEEING);
    expect([treasure.bleedMovedTicks, square.bleedMovedTicks]).toEqual([39, 39]);
    // Frozen, neither moves.
    freeze(ctx, treasure, 5);
    freeze(ctx, square, 5);
    for (let k = 0; k < 5; k++) tick(ctx);
    expect([treasure.bleedMovedTicks, square.bleedMovedTicks]).toEqual([39, 39]);
  });
});

describe('the treasure schedule (docs/v3 C7 design §2.5, C7/F8)', () => {
  const rules = TEST_V3_WAVES.v3;
  const dueWaves = (rate: number, last = 25): number[] =>
    Array.from({ length: last }, (_, k) => k + 1).filter(
      (wave) => treasuresDue(wave, rules, rate) > 0,
    );

  it('makes waves 15, 20 and 25 due at rate 1, and 15, 19, 22 and 25 at rate 1.5 (OWN test 10)', () => {
    // Planted bug: off by one at fromWave.
    expect(rules.treasure).toEqual({ enemy: 'treasure', fromWave: 15, every: 5 });
    expect(dueWaves(1)).toEqual([15, 20, 25]);
    expect(dueWaves(1.5)).toEqual([15, 19, 22, 25]);
    for (const rate of [1, 1.5]) {
      expect(dueWaves(rate).map((wave) => treasuresDue(wave, rules, rate))).toEqual(
        dueWaves(rate).map(() => 1),
      );
    }
  });

  it('counts a whole number of treasures as whole: (65 − 15) × 2.3 / 5 is 22.999… in doubles', () => {
    expect(((65 - 15) * 2.3) / 5).toBeLessThan(23);
    expect([
      treasuresDue(64, rules, 2.3),
      treasuresDue(65, rules, 2.3),
      treasuresDue(66, rules, 2.3),
    ]).toEqual([0, 1, 0]);
  });

  it('makes several due a wave at a high rate, and none before fromWave', () => {
    expect([14, 15, 16, 17].map((wave) => treasuresDue(wave, rules, 10))).toEqual([0, 1, 2, 2]);
    expect(dueWaves(100, 14)).toEqual([]);
  });

  it('puts the treasures due into the wave’s queue before its shuffle, outside composeWave, at values.treasureRate (W6)', () => {
    // Planted bugs: the treasure after the shuffle; inside composeWave's count.
    const data = v3TestData({
      waves: { eliteEvery: 1000, bossEvery: 1000, v3: { ...TEST_V3_WAVES.v3, affixes: [] } },
    });
    const composed = composeWave(15, data.waves);
    expect(composed.map((entry) => entry.enemy)).not.toContain('treasure');
    const total = composed.reduce((sum, entry) => sum + entry.count, 0);
    const places = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const ctx = createRunContext(makeConfig({ seed }), data);
      ctx.now = 1;
      startWave(ctx, 15);
      const queue = (ctx.current as WaveRecord).queue;
      expect(queue).toHaveLength(total + 1);
      expect(queue.filter((def) => def.id === 'treasure')).toHaveLength(1);
      places.add(queue.findIndex((def) => def.id === 'treasure'));
    }
    expect(places.size).toBeGreaterThan(2);
    // A wave's released treasure is extra: outside composeWave's count (C7/F12).
    const ctx = createRunContext(makeConfig(), data);
    ctx.now = 1;
    startWave(ctx, 15);
    for (; ctx.now <= 61; ctx.now++) releaseEnemies(ctx);
    const treasure = ctx.enemies.find((e) => e.type === 'treasure') as Enemy;
    expect(record(treasure).extra).toBe(true);
    // At treasureRate 1.5 the run's waves follow the faster schedule.
    const fast = createRunContext(makeConfig({ stats: makeStats({ treasureRate: 1.5 }) }), data);
    const withTreasure: number[] = [];
    for (let wave = 12; wave <= 25; wave++) {
      startWave(fast, wave);
      const queue = (fast.current as WaveRecord).queue;
      if (queue.some((def) => def.id === 'treasure')) withTreasure.push(wave);
      expect(queue).toHaveLength(
        composeWave(wave, data.waves).reduce((sum, entry) => sum + entry.count, 0) +
          treasuresDue(wave, data.waves.v3 as V3WaveRules, 1.5),
      );
    }
    expect(withTreasure).toEqual([15, 19, 22, 25]);
  });
});

describe('kill drops (docs/v3 C7 design §2.5, lead ruling W7)', () => {
  const TYPES: readonly EnemyId[] = [
    'triangle',
    'square',
    'hexagon',
    'boss',
    'shielder',
    'regenerator',
    'dasher',
    'treasure',
    'onion',
  ];

  /** [type, shards, cores] of a kill of each type, with toughDropMult `mult`, on `data`. */
  function drops(mult: number, data: GameData, types = TYPES): [EnemyId, number, number][] {
    const ctx = placedEnemies(
      types.map((type, k) => at(type, 600 + k)),
      { stats: makeStats({ toughDropMult: mult }), data },
    );
    for (const e of [...ctx.enemies]) killEnemy(ctx, e, -1, 0);
    return eventsOf([ctx.events], 'enemyKilled').map((k) => [k.enemy, toNumber(k.shards), k.cores]);
  }

  it('doubles the drops of the tough types only at toughDropMult 2: hexagon, boss and onion, and none of an M1 run (OWN test 11)', () => {
    // Planted bug: applied to all.
    const once = drops(1, quietV3());
    const twice = drops(2, quietV3());
    expect(
      twice.map(([type, shards, cores], k) => [
        type,
        shards / (once[k] as [EnemyId, number, number])[1],
        cores,
      ]),
    ).toEqual([
      ['triangle', 1, 0],
      ['square', 1, 0],
      ['hexagon', 2, 2],
      ['boss', 2, 6],
      ['shielder', 1, 0],
      ['regenerator', 1, 0],
      ['dasher', 1, 0],
      ['treasure', 1, 1],
      ['onion', 2, 6],
    ]);
    expect(once.map(([, , cores]) => cores)).toEqual([0, 0, 1, 3, 0, 0, 0, 1, 3]);
    // An M1 run's enemies have no record: toughDropMult does not reach their drops.
    const m1Types: EnemyId[] = ['triangle', 'hexagon', 'boss'];
    expect(drops(2, makeTestData(), m1Types)).toEqual(drops(1, makeTestData(), m1Types));
  });

  it('scales the expected cores before the floor and the roll: half a core × 2 is one core, every seed', () => {
    // Planted bug: dropScale after the floor.
    for (let seed = 1; seed <= 8; seed++) {
      const ctx = placedEnemies([at('hexagon', 600)], {
        stats: makeStats({ toughDropMult: 2, coreGain: 0.5 }),
        data: quietV3(),
        seed,
      });
      const before = ctx.dropsRng.snapshot();
      killEnemy(ctx, ctx.enemies[0] as Enemy, -1, 0);
      expect(eventsOf([ctx.events], 'enemyKilled')[0]?.cores, `seed ${seed}`).toBe(1);
      // A whole number of cores rolls for nothing.
      expect(ctx.dropsRng.snapshot()).toEqual(before);
    }
  });
});
