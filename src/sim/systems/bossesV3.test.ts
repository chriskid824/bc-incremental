/**
 * 母巢 and 稜鏡, the v3 bosses after the onion (docs/v3/game-design-v3.md §6.3): 母巢's walking
 * summons (a summon behaviour with keepWalking, src/sim/systems/enemyAi.ts) and 稜鏡's reflect
 * windows (stepReflect) and bounded reflections (src/sim/systems/prism.ts). Both stand on the line
 * to the player's right; tick() runs one tick's enemy AI and movement stages, as step does. The
 * player has 100 life, so 1 % of it is 1.
 */

import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { V3_ENEMIES } from '../../data/enemiesV3';
import type { EnemyId, GameData, V3WaveRules } from '../../data/types';
import { applyBleed, applyBurn, applyPoison } from '../ailments/apply';
import { CENTER } from '../build/sources';
import { hitWithPayload } from '../combat/hit';
import { createPayload, ROWS } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import {
  eventsOf,
  makeStats,
  placedEnemies,
  TEST_ENEMIES,
  TEST_V3_WAVES,
  v3TestData,
} from '../testing';
import type { PlacedEnemy, TestDataOverrides } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DT } from '../types';
import type { SimEvent } from '../types';
import { updateAilments } from './ailments';
import type { Enemy, RunContext } from './context';
import { REFLECTING, STOPPED, stepEnemyAi } from './enemyAi';
import type { EnemyV3 } from './enemyRecord';
import { moveEnemies } from './movement';
import { checkRunEnd } from './runEnd';

const PLAYER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

const at = (
  type: EnemyId,
  dx: number,
  more: Omit<PlacedEnemy, 'x' | 'y' | 'type'> = {},
): PlacedEnemy => ({ x: PLAYER.x + dx, y: PLAYER.y, type, ...more });

/** A v3 table whose waves bring nothing (as enemyAi.test.ts' quietV3), with these overrides. */
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
      v3: {
        ...TEST_V3_WAVES.v3,
        affixes: [],
        treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
        ...v3,
      },
    },
  });
}

/** No crits or ignites, 100 life. */
const STATS = { damage: 10, critChance: 0, igniteChance: 0, maxLife: 100 } as const;

function placed(enemies: readonly PlacedEnemy[], data: GameData = quietV3()): RunContext {
  return placedEnemies(enemies, { stats: makeStats(STATS), data });
}

const record = (e: Enemy): EnemyV3 => e.v3 as EnemyV3;

function tick(ctx: RunContext): SimEvent[] {
  ctx.events.length = 0;
  stepEnemyAi(ctx);
  moveEnemies(ctx);
  const events = [...ctx.events];
  ctx.now++;
  ctx.state.tick++;
  return events;
}

/** A payload of the signature's rows at base damage `damage`, which rolls no ailment. */
function payload(ctx: RunContext, damage: number): Payload {
  const p = (ctx.emitters[0] as EmitterRuntime).payload;
  return createPayload({
    baseDamage: num(damage),
    tags: p.tags,
    source: p.source,
    jumpSource: p.jumpSource,
    flags: 0,
    rng: p.rng,
    chains: false,
    rollsAilments: false,
    canCrit: false,
    damageMode: ROWS,
    rowsOf: p,
  });
}

const hit = (ctx: RunContext, target: Enemy, p: Payload): boolean =>
  hitWithPayload(ctx, target, p, 0, 1, null, null, false, 0, -1);

const reflected = (events: readonly SimEvent[]) => eventsOf([events], 'reflectHit');

describe('母巢 (game-design-v3 §6.3: 每 3 秒生 4 隻三角，本體慢慢前進)', () => {
  const BROOD = V3_ENEMIES.brood;
  const STEP = BROOD.speed * DT;

  it('is a slow boss that summons 4 triangles every 3 s and keeps walking', () => {
    expect(BROOD).toMatchObject({ tough: true, boss: true, speed: 40 });
    expect(BROOD.behaviour).toEqual({
      kind: 'summon',
      stopDist: 520,
      periodSec: 3,
      enemy: 'triangle',
      count: 4,
      keepWalking: true,
    });
  });

  it('arms its timer at its stopDist, then summons 4 triangles on its rim every 180 ticks while it walks on, never standing', () => {
    // Planted bug: the summoner's post, which stops it at 520.
    const ctx = placed(
      [at('brood', 560, { speed: BROOD.speed })],
      quietV3({ triangle: { speed: 0 } }),
    );
    const brood = ctx.enemies[0] as Enemy;
    let armed = -1;
    const summons: [number, number, number][] = [];
    let last = brood.dist;
    while (ctx.now <= 700) {
      const now = ctx.now;
      const events = tick(ctx);
      if (armed < 0 && record(brood).nextAct !== Infinity) {
        // The AI step saw it at 520 or closer, a step after it was still beyond.
        armed = now;
        expect(last).toBeLessThanOrEqual(520);
        expect(last + STEP).toBeGreaterThan(520);
        expect(record(brood).nextAct).toBe(now + 180);
      }
      for (const e of events) if (e.type === 'summoned') summons.push([now, e.count, brood.dist]);
      expect(record(brood).state & STOPPED, `tick ${now}`).toBe(0);
      expect(brood.stepDist).toBe(STEP);
      expect(brood.dist).toBeCloseTo(last - STEP, 9);
      last = brood.dist;
    }
    // It reaches 520 after about (560 − 520) / STEP = 60 steps.
    expect(armed).toBeGreaterThanOrEqual(61);
    expect(armed).toBeLessThanOrEqual(62);
    expect(summons.map(([now, count]) => [now, count])).toEqual([
      [armed + 180, 4],
      [armed + 360, 4],
      [armed + 540, 4],
    ]);
    // Each round further in than the last: it kept walking.
    expect(summons[1]?.[2]).toBeLessThan(summons[0]?.[2] as number);
    const children = ctx.enemies.slice(1);
    expect(children).toHaveLength(12);
    expect(children.every((child) => child.type === 'triangle' && record(child).extra)).toBe(true);
    expect(children.every((child) => !child.tough && !child.boss)).toBe(true);
  });

  it('summons through the v3 enemyCap: past it its triangles are skipped and counted', () => {
    // A cap of 6 holds the brood and 5 triangles.
    const ctx = placed(
      [at('brood', 400, { speed: 0 })],
      quietV3({ triangle: { speed: 0 } }, { enemyCap: 6 }),
    );
    const counts: number[] = [];
    while (ctx.now <= 600) {
      for (const e of tick(ctx)) if (e.type === 'summoned') counts.push(e.count);
    }
    expect(counts).toEqual([4, 1, 0]);
    expect(ctx.counters.enemySpawnsSkipped).toBe(7);
    expect(ctx.enemies.filter((e) => e.alive)).toHaveLength(6);
  });

  it('never summons from beyond its stopDist', () => {
    const ctx = placed([at('brood', 521, { speed: 0 })]);
    for (let k = 0; k < 600; k++) {
      expect(tick(ctx).some((e) => e.type === 'summoned')).toBe(false);
    }
    expect(record(ctx.enemies[0] as Enemy).nextAct).toBe(Infinity);
  });
});

describe('稜鏡 (game-design-v3 §6.3: 每 5 秒切換 2 秒「反射」，異常狀態不反彈)', () => {
  it('reflects for 2 s every 5 s, 1 % of max life a hit and at most 10 % a second (初始值)', () => {
    expect(V3_ENEMIES.prism).toMatchObject({ tough: true, boss: true });
    expect(V3_ENEMIES.prism.behaviour).toEqual({
      kind: 'reflect',
      periodSec: 5,
      activeSec: 2,
      lifePctPerHit: 0.01,
      maxLifePctPerSec: 0.1,
    });
    expect(TEST_ENEMIES.prism).toEqual(V3_ENEMIES.prism);
  });

  it('reflects from 300 ticks after its first step for 120 ticks, every 300, walking in throughout', () => {
    // Planted bug: the window measured from the period's end, or left open.
    const ctx = placed([at('prism', 900, { speed: 45 })]);
    const prism = ctx.enemies[0] as Enemy;
    const on: number[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    while (ctx.now <= 1100) {
      const now = ctx.now;
      const before = prism.dist;
      const events = tick(ctx);
      if ((record(prism).state & REFLECTING) !== 0) on.push(now);
      for (const e of events) {
        if (e.type === 'reflectStarted') starts.push(now);
        if (e.type === 'reflectEnded') ends.push(now);
      }
      expect(prism.dist).toBeLessThan(before);
    }
    const windows = [301, 601, 901].flatMap((s) => Array.from({ length: 120 }, (_, k) => s + k));
    expect(on).toEqual(windows.filter((t) => t <= 1100));
    expect(starts).toEqual([301, 601, 901]);
    expect(ends).toEqual([421, 721, 1021]);
  });

  it('pauses its windows while frozen and stays reflecting meanwhile', () => {
    const ctx = placed([at('prism', 600, { speed: 0 })]);
    const prism = ctx.enemies[0] as Enemy;
    while (ctx.now < 350) tick(ctx);
    expect(record(prism).state & REFLECTING).toBe(REFLECTING);
    ctx.frostApplied = true;
    prism.frozenUntil = ctx.now + 30;
    const starts: number[] = [];
    const ends: number[] = [];
    while (ctx.now <= 700) {
      const now = ctx.now;
      for (const e of tick(ctx)) {
        if (e.type === 'reflectStarted') starts.push(now);
        if (e.type === 'reflectEnded') ends.push(now);
      }
      if (now < 380) expect(record(prism).state & REFLECTING, `tick ${now}`).toBe(REFLECTING);
    }
    // Both the window's end (421) and the next start (601) move 30 ticks on.
    expect(ends).toEqual([451]);
    expect(starts).toEqual([631]);
  });

  it('turns each hit into 1 of the 100 life, whatever its raw damage, at most 10 a second, and none outside a window', () => {
    // Planted bug: the raw damage reflected, or no cap.
    const ctx = placed([at('prism', 600, { speed: 0, hp: 1e30 })]);
    const prism = ctx.enemies[0] as Enemy;
    const big = payload(ctx, 1e15);
    // Outside a window: nothing comes back.
    hit(ctx, prism, big);
    expect(reflected(ctx.events)).toEqual([]);
    while (ctx.now < 301) tick(ctx);
    tick(ctx);
    expect(record(prism).state & REFLECTING).toBe(REFLECTING);
    ctx.events.length = 0;
    for (let k = 0; k < 15; k++) hit(ctx, prism, big);
    const first = reflected(ctx.events);
    expect(first.map((e) => [e.enemy, e.enemyId, e.damage])).toEqual(
      Array.from({ length: 10 }, () => ['prism', prism.id, 1]),
    );
    expect(ctx.player.life).toBe(90);
    // Each right after its hit's own event.
    const types = ctx.events.map((e) => e.type);
    expect(types.slice(0, 4)).toEqual(['hit', 'reflectHit', 'hit', 'reflectHit']);
    // The window's next second: its budget starts again.
    while (ctx.now < 362) tick(ctx);
    ctx.events.length = 0;
    for (let k = 0; k < 3; k++) hit(ctx, prism, payload(ctx, 1));
    expect(reflected(ctx.events)).toHaveLength(3);
    expect(ctx.player.life).toBeCloseTo(87, 9);
    // After the window: none.
    while (ctx.now < 425) tick(ctx);
    ctx.events.length = 0;
    hit(ctx, prism, big);
    expect(reflected(ctx.events)).toEqual([]);
    expect(ctx.sys.enemyAi.reflectTakenBy.prism.hits).toBe(13);
    expect(ctx.sys.enemyAi.reflectTakenBy.prism.damage).toBeCloseTo(13, 9);
    // No contact, no leak, no bullet.
    expect(ctx.taken.prism).toEqual({ hits: 0, damage: 0 });
    expect(ctx.sys.bullets.takenBy.prism).toEqual({ hits: 0, damage: 0 });
  });

  it('never reflects an ailment tick: burn, poison and bleed hurt it in a window and cost the player nothing', () => {
    // Planted bug: the reflection hooked into the damage-over-time step.
    const ctx = placed([at('prism', 600, { speed: 0 })]);
    const prism = ctx.enemies[0] as Enemy;
    while (ctx.now < 302) tick(ctx);
    expect(record(prism).state & REFLECTING).toBe(REFLECTING);
    applyBurn(ctx, prism, num(1e9), ctx.now + 60, 0, CENTER, 1);
    applyPoison(ctx, prism, num(1e9), ctx.now + 60, 0, CENTER, 1);
    applyBleed(ctx, prism, num(1e9), ctx.now + 60, 0, CENTER, 1);
    const hpBefore = toNumber(prism.hp);
    const seen: SimEvent[] = [];
    for (let k = 0; k < 60; k++) {
      ctx.events.length = 0;
      ctx.now++;
      updateAilments(ctx);
      seen.push(...ctx.events);
    }
    expect(toNumber(prism.hp)).toBeLessThan(hpBefore);
    expect(seen.some((e) => e.type === 'burnTick' || e.type === 'dotTick')).toBe(true);
    expect(reflected(seen)).toEqual([]);
    expect(ctx.player.life).toBe(100);
    expect(ctx.sys.enemyAi.reflectTakenBy.prism).toEqual({ hits: 0, damage: 0 });
  });

  it('kills as the prism: killedBy, reflectTakenBy and no leak in the result, nothing reflected onto a dead player', () => {
    const ctx = placed([at('prism', 600, { speed: 0 })]);
    const prism = ctx.enemies[0] as Enemy;
    while (ctx.now < 302) tick(ctx);
    ctx.player.life = 1.5;
    ctx.events.length = 0;
    const p = payload(ctx, 5);
    for (let k = 0; k < 3; k++) hit(ctx, prism, p);
    expect(reflected(ctx.events).map((e) => [e.damage, e.lifeLeft])).toEqual([
      [1, 0.5],
      [1, 0],
    ]);
    expect(ctx.killedBy).toBe('prism');
    checkRunEnd(ctx);
    const result = ctx.runResult;
    expect(result?.endReason).toBe('death');
    expect(result?.killedBy).toBe('prism');
    expect(result?.reflectTakenBy.prism).toEqual({ hits: 2, damage: 2 });
    expect(result?.leaks).toBe(0);
    expect(result?.damageTaken).toBe(0);
    expect(result?.bulletTakenBy.prism).toEqual({ hits: 0, damage: 0 });
  });
});
