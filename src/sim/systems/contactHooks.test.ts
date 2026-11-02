/**
 * C7b's contact hooks (docs/v3 C7 design §2.10, src/sim/systems/contact.ts): 拒馬 (dashRepel,
 * lead ruling W3) pushes a dashing enemy back at its touch, and 荊棘纏繞 (bossHoldSec, W4) holds a
 * boss at the player, with thorns rounds every 15 ticks from the enemy AI step and its contact
 * damage at the hold's end. §2.10's tests are named in their titles with a comment naming the
 * planted bug each kills; the rest pin W3's and W4's edges. The build carries thorns (outer, 300 %
 * of damage 10: a hit of 30, no crit or ignite) and 拒馬's ×3 as data, a thorns `damage more 2`
 * on a dashing target, and keeps the combo stacks (10 at the start). tick() runs a tick's enemy
 * AI, movement and contact stages and its compaction, as step does; the effects its triggers
 * queue are read and dropped, never run.
 */

import { describe, expect, it } from 'vitest';
import { toNumber } from '../../core/num';
import type { Modifier, StatId } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import type { EnemyId, GameData } from '../../data/types';
import type { TestModule } from '../rules';
import { makeStats, placedEnemies, TEST_ENEMIES, TEST_V3_WAVES, v3TestData } from '../testing';
import type { PlacedEnemy, TestDataOverrides } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { SimEvent } from '../types';
import { addComboStacks } from './combo';
import { HOLD_ROUND_TICKS, resolveContacts } from './contact';
import type { Enemy, RunContext } from './context';
import { compact, removeEnemy } from './death';
import { CHARGING, DASHING, ENTANGLED, STOPPED, stepEnemyAi } from './enemyAi';
import type { EnemyV3 } from './enemyRecord';
import { rebuildGrid } from './grid';
import { moveEnemies } from './movement';

/** The player, at the arena's centre; the enemies stand on the line to its right. */
const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
const at = (
  type: EnemyId,
  dx: number,
  more: Omit<PlacedEnemy, 'x' | 'y' | 'type'> = {},
): PlacedEnemy => ({ x: PLAYER.x + dx, y: PLAYER.y, type, ...more });

/** 拒馬's ×3 (gd:468 「3 倍荊棘傷害」) as B4 writes it: thorns damage more 2 on a dashing target. */
const REPEL_MORE: Modifier = {
  stat: 'damage',
  kind: 'more',
  value: 2,
  tags: ['thorns'],
  when: [{ targetState: 'dashing' }],
};

/**
 * heroHit queues effect 0 and contact effect 1; a contact on a dashing toucher also queues
 * effect 2, whose condition is read as the touch raises it.
 */
const TRIGGERS: readonly TriggerSpec[] = [
  { on: 'heroHit', do: [{ kind: 'heal', lifePct: 0.01 }] },
  { on: 'contact', do: [{ kind: 'heal', lifePct: 0.02 }] },
  { on: 'contact', when: [{ targetState: 'dashing' }], do: [{ kind: 'heal', lifePct: 0.03 }] },
];

/** Keeps the combo stacks, as a build with a combo source does. */
const KEEP: TestModule = (b) => {
  b.flags.combo = true;
};

/** A v3 table with no wave enemy, elite, boss, affix or treasure, so only placed enemies exist. */
function quietV3(enemies: TestDataOverrides['enemies'] = {}): GameData {
  return v3TestData({
    enemies,
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
}

/**
 * The dasher with a chargeDist of 100 and a 6-tick charge: at its def's 420, a dasher pushed 80
 * back from the player is still inside it and charges at once; at 100 it walks in first.
 */
const dasherData = (): GameData =>
  quietV3({
    dasher: { behaviour: { kind: 'dash', chargeDist: 100, chargeSec: 0.1, dashMult: 4 } },
  });

interface Options {
  readonly values?: Partial<Record<StatId, number>>;
  readonly data?: GameData;
  readonly thorns?: boolean;
}

/**
 * placedEnemies on quietV3's data unless `options.data`, with thorns (unless `thorns` is false),
 * REPEL_MORE, TRIGGERS, max life 1000 and these values, keeping 10 combo stacks.
 */
function placed(enemies: readonly PlacedEnemy[], options: Options = {}): RunContext {
  const ctx = placedEnemies(enemies, {
    stats: makeStats(
      { critChance: 0, igniteChance: 0, maxLife: 1000, ...options.values },
      [REPEL_MORE],
      {
        triggers: TRIGGERS.map((spec) => ({ source: 'center', spec })),
        conversions: [],
        emitters:
          options.thorns === false ? [] : [{ source: 'outer.thorns', grant: { kind: 'thorns' } }],
      },
    ),
    data: options.data ?? quietV3(),
    modules: [KEEP],
  });
  addComboStacks(ctx, 10);
  return ctx;
}

/** Reads and drops the queued effects (CompiledBuild.effects indices), oldest first. */
function drain(ctx: RunContext): number[] {
  const q = ctx.effectQueue;
  const effects = Array.from({ length: q.size }, (_, n) => q.effect[(q.head + n) & q.capMask]);
  q.head = (q.head + q.size) & q.capMask;
  q.size = 0;
  return effects as number[];
}

interface Tick {
  readonly now: number;
  readonly events: SimEvent[];
  readonly queued: number[];
}

/** Runs tick ctx.now's enemy AI, movement and contacts and its compaction, then moves on. */
function tick(ctx: RunContext): Tick {
  const now = ctx.now;
  ctx.events.length = 0;
  stepEnemyAi(ctx);
  moveEnemies(ctx);
  rebuildGrid(ctx);
  resolveContacts(ctx);
  compact(ctx);
  const events = [...ctx.events];
  ctx.now++;
  ctx.state.tick++;
  return { now, events, queued: drain(ctx) };
}

/** `n` ticks. */
const ticks = (ctx: RunContext, n: number): Tick[] => Array.from({ length: n }, () => tick(ctx));

/** The thorns hits on `e` in `t`'s events: their amounts. */
const hitsOn = (t: Tick, e: Enemy): number[] =>
  t.events.flatMap((ev) =>
    ev.type === 'hit' && ev.targetId === e.id ? [toNumber(ev.amount)] : [],
  );

const enemy = (ctx: RunContext, id: number): Enemy => ctx.enemies.find((e) => e.id === id) as Enemy;
const record = (e: Enemy): EnemyV3 => e.v3 as EnemyV3;
const playerHits = (t: Tick): number => t.events.filter((ev) => ev.type === 'playerHit').length;

describe('拒馬 (dashRepel, lead ruling W3)', () => {
  it('pushes a dashing dasher 80 back alive after thorns ×3 at its touch, and the player loses no life or stacks (§2.10 拒馬 test)', () => {
    // Planted bugs: leaked after the push; the push halving the stacks.
    const ctx = placed([at('dasher', 160, { speed: 110 })], {
      values: { dashRepel: 80 },
      data: dasherData(),
    });
    const dasher = enemy(ctx, 1);
    const v = record(dasher);
    let before = dasher.dist;
    let touch: Tick | null = null;
    while (touch === null) {
      before = dasher.dist;
      const t = tick(ctx);
      if (hitsOn(t, dasher).length > 0) touch = t;
    }
    // It touched dashing: its last step was the dash's, and the touch's contact saw it dashing.
    const dash = v.baseStep * 4;
    expect(hitsOn(touch, dasher)).toEqual([90]);
    expect(touch.queued).toEqual([1, 2]);
    expect(playerHits(touch)).toBe(0);
    expect([dasher.alive, dasher.rec.leaked, dasher.dist]).toEqual([
      true,
      false,
      before - dash + 80,
    ]);
    expect([dasher.x, dasher.y]).toEqual([PLAYER.x + dasher.ux * dasher.dist, PLAYER.y]);
    expect([v.state, dasher.stepDist]).toEqual([0, v.baseStep]);
    expect([ctx.player.life, ctx.sys.combo.stacks]).toEqual([1000, 10]);
    expect(ctx.enemies).toContain(dasher);
  });

  it('walks the pushed dasher back in, to charge again at its chargeDist and dash at the player once more', () => {
    const ctx = placed([at('dasher', 160, { speed: 110 })], {
      values: { dashRepel: 80 },
      data: dasherData(),
    });
    const dasher = enemy(ctx, 1);
    const v = record(dasher);
    const seen: string[] = [];
    let pushedTo = -1;
    for (let k = 0; k < 160; k++) {
      const t = tick(ctx);
      for (const ev of t.events) {
        if (ev.type === 'dasherCharge' || ev.type === 'dasherDash')
          seen.push(`${t.now} ${ev.type}`);
      }
      if (hitsOn(t, dasher).length > 0) {
        seen.push(`${t.now} touch`);
        if (pushedTo < 0) pushedTo = dasher.dist;
      }
    }
    // Each charge starts on the first AI step at 100 or closer: from the push, the ticks its
    // walk step takes to get there.
    let d = pushedTo;
    let walk = 0;
    while (d > 100) {
      d -= v.baseStep;
      walk++;
    }
    const [firstTouch, secondCharge] = [seen[2], seen[3]];
    const touchTick = Number(firstTouch?.split(' ')[0]);
    expect(secondCharge).toBe(`${touchTick + walk + 1} dasherCharge`);
    // Charge, dash and touch, over and over.
    const cycles = Math.floor(seen.length / 3);
    expect(cycles).toBeGreaterThanOrEqual(3);
    expect(seen.map((s) => s.split(' ')[1])).toEqual(
      Array.from({ length: cycles }, () => ['dasherCharge', 'dasherDash', 'touch']).flat(),
    );
    expect([dasher.alive, ctx.player.life, ctx.sys.combo.stacks]).toEqual([true, 1000, 10]);
  });

  it('leaks a walker at its touch as before, its life loss and halving included', () => {
    const ctx = placed([at('square', 50), at('regenerator', 40)], {
      values: { dashRepel: 80, bossHoldSec: 1 },
    });
    const t = tick(ctx);
    expect(
      t.events.flatMap((ev) => (ev.type === 'hit' ? [[ev.targetId, toNumber(ev.amount)]] : [])),
    ).toEqual([
      [1, 30],
      [2, 30],
    ]);
    expect(playerHits(t)).toBe(2);
    expect(t.queued).toEqual([0, 1, 0, 1]);
    expect([ctx.player.life, ctx.sys.combo.stacks, ctx.enemies.length]).toEqual([
      1000 - 15 - TEST_ENEMIES.regenerator.contactDamage,
      2,
      0,
    ]);
  });

  it('leaks a dashing dasher with dashRepel 0, and a charging one whatever dashRepel is', () => {
    for (const [dashRepel, state] of [
      [0, DASHING],
      [80, CHARGING | STOPPED],
    ] as const) {
      const ctx = placed([at('dasher', 40)], { values: { dashRepel } });
      const dasher = enemy(ctx, 1);
      // A charge that does not end this tick.
      Object.assign(record(dasher), { state, stateUntil: 1000 });
      const t = tick(ctx);
      const label = `dashRepel ${dashRepel}, state ${state}`;
      expect(hitsOn(t, dasher), label).toEqual([state === DASHING ? 90 : 30]);
      expect([dasher.alive, dasher.rec.leaked], label).toEqual([false, true]);
      expect([ctx.player.life, ctx.sys.combo.stacks], label).toEqual([994, 5]);
      expect(t.queued, label).toEqual(state === DASHING ? [0, 1, 2] : [0, 1]);
    }
  });

  it('pushes nothing back that its thorns killed at the touch, and leaks an M1 run’s enemy', () => {
    const ctx = placed([at('dasher', 40, { hp: 50 })], { values: { dashRepel: 80 } });
    const dasher = enemy(ctx, 1);
    record(dasher).state = DASHING;
    const dist = dasher.dist;
    const t = tick(ctx);
    expect([dasher.alive, dasher.rec.leaked, dasher.dist, t.queued]).toEqual([
      false,
      false,
      dist,
      [1, 2],
    ]);
    expect(ctx.player.life).toBe(1000);
    // An M1 run's enemies have no record: none is dashing.
    const m1 = placedEnemies([at('square', 40)], {
      stats: makeStats({ critChance: 0, igniteChance: 0, maxLife: 1000, dashRepel: 80 }),
    });
    resolveContacts(m1);
    expect([m1.player.life, (m1.enemies[0] as Enemy).rec.leaked]).toEqual([985, true]);
  });
});

describe('荊棘纏繞 (bossHoldSec, lead ruling W4)', () => {
  /**
   * A boss walking in to its touch on tick 1 (contactDist 100; an onion unless `boss` says), a
   * dasher and a shooter far off.
   */
  const holding = (
    values: Partial<Record<StatId, number>> = {},
    boss: PlacedEnemy = at('onion', 100.5, { speed: 45 }),
  ): RunContext =>
    placed([at('dasher', 900, { speed: 0 }), boss, at('shooter', 900, { speed: 0 })], {
      values: { bossHoldSec: 1, ...values },
    });

  it('holds a boss 60 ticks: thorns rounds at t, t + 15, t + 30 and t + 45, its life loss and heroHit at t + 60 (§2.10 荊棘纏繞 test)', () => {
    // Planted bugs: life lost at the touch; a 5th round at t + 60; a second contact at the
    // release.
    const ctx = holding();
    const boss = enemy(ctx, 2);
    const v = record(boss);
    const seen = ticks(ctx, 70);
    const touch = seen[0] as Tick;
    expect(touch.now).toBe(1);
    expect([v.state, v.stateUntil, boss.stepDist, boss.alive]).toEqual([ENTANGLED, 61, 0, false]);
    const rounds = seen.filter((t) => hitsOn(t, boss).length > 0).map((t) => t.now);
    expect(rounds).toEqual([1, 16, 31, 46]);
    expect(seen.filter((t) => playerHits(t) > 0).map((t) => t.now)).toEqual([61]);
    expect(seen.filter((t) => t.queued.length > 0).map((t) => [t.now, t.queued])).toEqual([
      [1, [1]],
      [61, [0]],
    ]);
    expect([ctx.player.life, ctx.sys.combo.stacks, boss.rec.leaked]).toEqual([900, 5, true]);
    expect(HOLD_ROUND_TICKS).toBe(15);
  });

  it('stands the held boss at the player, skipped by the contact stage, on the AI step’s list in id order until it leaks', () => {
    const ctx = holding();
    const boss = enemy(ctx, 2);
    const ids = (): number[] => ctx.sys.enemyAi.list.map((e) => e.id);
    expect(ids()).toEqual([1, 3]);
    const touch = tick(ctx);
    const dist = boss.dist;
    expect([touch.now, ids()]).toEqual([1, [1, 2, 3]]);
    expect(dist).toBeLessThanOrEqual(boss.contactDist);
    for (const t of ticks(ctx, 59)) {
      expect([boss.dist, boss.alive, record(boss).state], `tick ${t.now}`).toEqual([
        dist,
        true,
        ENTANGLED,
      ]);
      expect(playerHits(t), `tick ${t.now}`).toBe(0);
    }
    expect(ids()).toEqual([1, 2, 3]);
    const release = tick(ctx);
    expect([release.now, boss.alive, playerHits(release)]).toEqual([61, false, 1]);
    tick(ctx);
    expect(ids()).toEqual([1, 3]);
  });

  it('costs no life, leak or heroHit for a boss its thorns kill while held', () => {
    // M1's boss type, which has no shells (an onion's would break instead), at 50 hp: the
    // touch's round leaves 20, the next kills it.
    const ctx = holding({}, at('boss', 100.5, { speed: 45, hp: 50 }));
    const boss = enemy(ctx, 2);
    const seen = ticks(ctx, 70);
    expect(seen.filter((t) => hitsOn(t, boss).length > 0).map((t) => t.now)).toEqual([1, 16]);
    expect([boss.alive, boss.rec.leaked, ctx.player.life, ctx.sys.combo.stacks]).toEqual([
      false,
      false,
      1000,
      10,
    ]);
    expect(seen.flatMap((t) => t.queued)).toEqual([1]);
    expect(seen.some((t) => t.events.some((ev) => ev.type === 'enemyKilled'))).toBe(true);
  });

  it('releases no held boss once an earlier release of the tick has killed the player', () => {
    // Planted bug: the release without resolveContacts' living-player test.
    const ctx = placed([at('onion', 100.5, { speed: 45 }), at('onion', 100.5, { speed: 45 })], {
      values: { bossHoldSec: 1, maxLife: 100 },
    });
    const [one, two] = [enemy(ctx, 1), enemy(ctx, 2)];
    const seen = ticks(ctx, 62);
    expect(seen.filter((t) => playerHits(t) > 0).map((t) => [t.now, playerHits(t)])).toEqual([
      [61, 1],
    ]);
    // The second stays held (its wave's record, which both share, leaked with the first).
    expect([one.alive, two.alive, record(two).state, ctx.player.life]).toEqual([
      false,
      true,
      ENTANGLED,
      0,
    ]);
  });

  it('puts the hold off by the ticks it is frozen, rounds and release alike, as every AI timer', () => {
    const ctx = holding();
    const boss = enemy(ctx, 2);
    ticks(ctx, 5);
    // Frozen on ticks 6 to 15.
    ctx.frostApplied = true;
    boss.frozenUntil = 16;
    const seen = ticks(ctx, 70);
    expect(seen.filter((t) => hitsOn(t, boss).length > 0).map((t) => t.now)).toEqual([26, 41, 56]);
    expect(seen.filter((t) => playerHits(t) > 0).map((t) => t.now)).toEqual([71]);
  });

  it('leaks a boss with bossHoldSec 0, and holds no other enemy (§2.10: a non-boss leaks as before)', () => {
    const ctx = holding({ bossHoldSec: 0 });
    const t = tick(ctx);
    expect(ctx.enemies.map((e) => e.id)).toEqual([1, 3]);
    expect([playerHits(t), t.queued, ctx.player.life]).toEqual([1, [0, 1], 900]);
    // A dashing dasher with no dashRepel leaks while a boss would be held.
    const other = placed([at('dasher', 40)], { values: { bossHoldSec: 1 } });
    record(enemy(other, 1)).state = DASHING;
    expect(playerHits(tick(other))).toBe(1);
  });

  it('holds M1’s boss type in a v3 run, which has a record, and no boss of an M1 run', () => {
    const ctx = placed([at('boss', 95)], { values: { bossHoldSec: 0.5 } });
    const boss = enemy(ctx, 1);
    const seen = ticks(ctx, 32);
    expect(seen.filter((t) => hitsOn(t, boss).length > 0).map((t) => t.now)).toEqual([1, 16]);
    expect(seen.filter((t) => playerHits(t) > 0).map((t) => t.now)).toEqual([31]);
    const m1 = placedEnemies([at('boss', 95)], {
      stats: makeStats({ critChance: 0, igniteChance: 0, maxLife: 1000, bossHoldSec: 1 }),
    });
    resolveContacts(m1);
    expect([m1.player.life, (m1.enemies[0] as Enemy).alive]).toEqual([900, false]);
  });
});

describe('the contact hooks’ grid, list and rounding (second review)', () => {
  /** 129 standing squares far off on an ellipse around the player, as bullets.test.ts' Y5. */
  const farSquares = (): PlacedEnemy[] =>
    Array.from({ length: 129 }, (_, k) => ({
      x: PLAYER.x + 500 * Math.cos((k / 129) * 2 * Math.PI),
      y: PLAYER.y + 330 * Math.sin((k / 129) * 2 * Math.PI),
      type: 'square',
    }));

  it('rebuilds the grid after a push, so the tick’s later queries find the dasher where it now stands', () => {
    // 130 enemies, so the grid sorts them into its cells.
    const ctx = placed([at('dasher', 40), ...farSquares()], { values: { dashRepel: 80 } });
    const dasher = enemy(ctx, 1);
    record(dasher).state = DASHING;
    rebuildGrid(ctx);
    // A query earlier in the tick (stage 4b's, or an earlier contact's trigger) sorts the grid.
    expect(ctx.grid.nearest(PLAYER.x, PLAYER.y, Infinity, () => true)).toBe(dasher);
    resolveContacts(ctx);
    expect([dasher.alive, dasher.dist]).toEqual([true, 120]);
    // The emitters' queries that follow the contact stage find it at its new place.
    expect(ctx.grid.nearest(dasher.x, dasher.y, 64, () => true)).toBe(dasher);
  });

  it('rebuilds the grid before a round’s and the release’s triggers query it, which a compaction left stale', () => {
    const heal = { kind: 'heal', lifePct: 0.01 } as const;
    const triggers: TriggerSpec[] = [
      { on: 'hit', target: { pick: 'nearest', excludeEventTarget: true }, do: [heal] },
      { on: 'heroHit', target: { pick: 'nearest' }, do: [heal] },
    ];
    // The boss, 129 squares far off, then one 150 from the boss and 180 from the player, the
    // nearest to both: 131 enemies, so the grid sorts them into its cells.
    const ctx = placedEnemies(
      [
        at('onion', 100.5, { speed: 45 }),
        ...farSquares(),
        { x: PLAYER.x + 100, y: PLAYER.y + 150 },
      ],
      {
        stats: makeStats({ critChance: 0, igniteChance: 0, maxLife: 1000, bossHoldSec: 1 }, [], {
          triggers: triggers.map((spec) => ({ source: 'center', spec })),
          conversions: [],
          emitters: [{ source: 'outer.thorns', grant: { kind: 'thorns' } }],
        }),
        data: quietV3(),
      },
    );
    const boss = enemy(ctx, 1);
    const near = ctx.enemies.at(-1) as Enemy;
    /** Tick ctx.now as tick() runs it, with a query that sorts the grid after its rebuild and a death the compaction moves every later enemy down for. */
    const staleTick = (): void => {
      ctx.events.length = 0;
      stepEnemyAi(ctx);
      moveEnemies(ctx);
      rebuildGrid(ctx);
      ctx.grid.nearest(PLAYER.x, PLAYER.y, Infinity, () => true);
      resolveContacts(ctx);
      removeEnemy(ctx, ctx.enemies[1] as Enemy);
      compact(ctx);
      ctx.now++;
      ctx.state.tick++;
      drain(ctx);
    };
    const touch = tick(ctx);
    expect([touch.now, record(boss).state]).toEqual([1, ENTANGLED]);
    ticks(ctx, 13);
    staleTick();
    ctx.selected = null;
    const round = tick(ctx);
    expect([round.now, hitsOn(round, boss)]).toEqual([16, [30]]);
    expect(ctx.selected).toBe(near);
    ticks(ctx, 43);
    staleTick();
    ctx.selected = null;
    const release = tick(ctx);
    expect([release.now, playerHits(release), boss.alive]).toEqual([61, 1, false]);
    expect(ctx.selected).toBe(near);
  });

  it('takes the held boss’s contactMult at its release, as a contact does', () => {
    const ctx = placed([at('onion', 100.5, { speed: 45 })], { values: { bossHoldSec: 1 } });
    const boss = enemy(ctx, 1);
    tick(ctx);
    record(boss).contactMult = 2;
    const seen = ticks(ctx, 61);
    expect(seen.filter((t) => playerHits(t) > 0).map((t) => t.now)).toEqual([61]);
    expect(ctx.player.life).toBe(1000 - 2 * 100);
  });

  it('puts a held boss that is on the AI step’s list already (a regenerating one) there once', () => {
    const ctx = placed([at('dasher', 900), at('onion', 100.5, { speed: 45 }), at('shooter', 900)], {
      values: { bossHoldSec: 1 },
    });
    const boss = enemy(ctx, 2);
    // On the list for its regeneration, as spawn puts an enemy with regen (at full life, it
    // regains nothing).
    record(boss).regen = 0.01;
    const list = ctx.sys.enemyAi.list;
    list.splice(1, 0, boss);
    expect(list.map((e) => e.id)).toEqual([1, 2, 3]);
    const seen = ticks(ctx, 70);
    expect(
      seen.filter((t) => hitsOn(t, boss).length > 0).map((t) => [t.now, hitsOn(t, boss)]),
    ).toEqual([
      [1, [30]],
      [16, [30]],
      [31, [30]],
      [46, [30]],
    ]);
    expect(seen.filter((t) => playerHits(t) > 0).map((t) => t.now)).toEqual([61]);
  });

  it('holds round(bossHoldSec × 60) ticks', () => {
    const ctx = placed([at('onion', 100.5, { speed: 45 })], { values: { bossHoldSec: 0.51 } });
    expect(ctx.sys.enemyAi.holdTicks).toBe(31);
    const seen = ticks(ctx, 40);
    expect(seen.filter((t) => playerHits(t) > 0).map((t) => t.now)).toEqual([32]);
  });
});

describe('荊棘纏繞 with two thorns emitters (verification)', () => {
  it('deals each round the touch’s thorns hits, one from each thorns emitter in emitter order', () => {
    const ctx = placedEnemies([at('boss', 95)], {
      stats: makeStats({ critChance: 0, igniteChance: 0, maxLife: 1000, bossHoldSec: 1 }, [], {
        triggers: [],
        conversions: [],
        emitters: [
          { source: 'outer.thorns', grant: { kind: 'thorns' } },
          { source: 'center', grant: { kind: 'thorns', damagePct: 1 } },
        ],
      }),
      data: quietV3(),
    });
    const boss = enemy(ctx, 1);
    const rounds = ticks(ctx, 50)
      .filter((t) => hitsOn(t, boss).length > 0)
      .map((t) => [t.now, hitsOn(t, boss)]);
    expect(rounds).toEqual([
      [1, [30, 10]],
      [16, [30, 10]],
      [31, [30, 10]],
      [46, [30, 10]],
    ]);
  });
});
