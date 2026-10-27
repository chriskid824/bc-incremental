/**
 * The shooters' bullets as drawn (docs/v3 C7 design §2.9): each one's trail aimed along its last
 * tick's flight, from BulletViewState's prevX, prevY, none on its first frame and none reaching
 * behind where it was first seen, its head between its last two positions, and nothing but what
 * the pool holds.
 */

import { readFileSync } from 'node:fs';
import { Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import type { BulletViewState } from '../sim';
import { stepEnemyAi } from '../sim/systems/enemyAi';
import { moveEnemies } from '../sim/systems/movement';
import { makeStats, placedEnemies, TEST_V3_WAVES, v3TestData } from '../sim/testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../sim/types';
import { BULLET_TRAIL_LENGTH, BulletLayer } from './bullets';

interface Bullet {
  readonly prevX: number;
  readonly prevY: number;
  readonly x: number;
  readonly y: number;
}

/** A bullet pool holding `bullets` in its first slots, with one slot to spare. */
function pool(bullets: readonly Bullet[]): BulletViewState {
  const n = bullets.length + 1;
  const state = {
    id: new Int32Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    prevX: new Float64Array(n),
    prevY: new Float64Array(n),
  };
  bullets.forEach((bullet, b) => {
    state.id[b] = b + 1;
    state.x[b] = bullet.x;
    state.y[b] = bullet.y;
    state.prevX[b] = bullet.prevX;
    state.prevY[b] = bullet.prevY;
  });
  return state;
}

const glow = Texture.WHITE;
const streak = Texture.EMPTY;

/** The layer's particles as [texture, x, y, rotation], in order. */
function drawn(layer: BulletLayer): [string, number, number, number][] {
  return layer.view.particleChildren.map((particle) => [
    particle.texture === streak ? 'trail' : 'glow',
    particle.x,
    particle.y,
    particle.rotation,
  ]);
}

describe('BulletLayer', () => {
  it('trails each bullet along its flight from prevX, prevY, its head between the two', () => {
    const layer = new BulletLayer({ glow, streak });
    // First seen at (560, 240), flying left and down; this tick from (500, 300) to (480, 320).
    layer.update(pool([{ prevX: 560, prevY: 240, x: 540, y: 260 }]), 1, 0);
    layer.update(pool([{ prevX: 500, prevY: 300, x: 480, y: 320 }]), 1, 0.25);
    const at: [number, number] = [495, 305];
    expect(drawn(layer)).toEqual([
      ['trail', ...at, Math.atan2(20, -20)],
      ['glow', ...at, 0],
      ['glow', ...at, 0],
    ]);
    const trail = layer.view.particleChildren[0];
    // Anchored at its head, so the streak lies behind the bullet, BULLET_TRAIL_LENGTH long.
    expect(trail?.anchorX).toBe(1);
    expect((trail?.scaleX ?? 0) * 64).toBe(BULLET_TRAIL_LENGTH);
  });

  it('draws no trail on a bullet’s first frame, and only `count` bullets', () => {
    const layer = new BulletLayer({ glow, streak });
    const bullets = pool([
      { prevX: 700, prevY: 400, x: 690, y: 400 },
      { prevX: 100, prevY: 100, x: 110, y: 100 },
    ]);
    // Bullet 1's first frame: its head only, wherever it falls between the two ticks.
    layer.update(bullets, 1, 0.5);
    expect(drawn(layer)).toEqual([
      ['glow', 695, 400, 0],
      ['glow', 695, 400, 0],
    ]);
    // Bullet 1's second frame trails it, as far back as where it was first seen; bullet 2's first.
    layer.update(bullets, 2, 0.5);
    expect(drawn(layer).map(([texture, x, y]) => [texture, x, y])).toEqual([
      ['trail', 695, 400],
      ['glow', 695, 400],
      ['glow', 695, 400],
      ['glow', 105, 100],
      ['glow', 105, 100],
    ]);
    expect((layer.view.particleChildren[0]?.scaleX ?? 0) * 64).toBe(5);
    layer.update(bullets, 0, 0.5);
    expect(layer.view.particleChildren).toHaveLength(0);
  });

  it('grows the trail from where the bullet was first seen, up to BULLET_TRAIL_LENGTH', () => {
    const layer = new BulletLayer({ glow, streak });
    // Seen first the frame after its fire tick at (300, 200), its prev the muzzle; flying right
    // 10 a tick, one frame a tick at alpha 1.
    const lengths: number[] = [];
    for (let tick = 1; tick <= 7; tick++) {
      const x = 300 + 10 * tick;
      layer.update(pool([{ prevX: x - 10, prevY: 200, x, y: 200 }]), 1, 1);
      const first = layer.view.particleChildren[0];
      lengths.push(first?.texture === streak ? first.scaleX * 64 : 0);
    }
    expect(lengths).toEqual([
      0,
      20,
      30,
      40,
      BULLET_TRAIL_LENGTH,
      BULLET_TRAIL_LENGTH,
      BULLET_TRAIL_LENGTH,
    ]);
  });

  it('reads the arrays it is given every frame: the pool replaces them as it grows (C7.4b)', () => {
    const layer = new BulletLayer({ glow, streak });
    layer.update(pool([{ prevX: 180, prevY: 200, x: 200, y: 200 }]), 1, 1);
    // The pool grew: SimState.bullets holds new arrays, a new bullet in slot 0 and the old one,
    // still id 1, in slot 1, its trail from where it was first seen.
    const grown = pool([
      { prevX: 600, prevY: 500, x: 590, y: 500 },
      { prevX: 200, prevY: 200, x: 220, y: 200 },
    ]);
    grown.id[0] = 2;
    grown.id[1] = 1;
    layer.update(grown, 2, 1);
    expect(drawn(layer).map(([texture, x, y]) => [texture, x, y])).toEqual([
      ['glow', 590, 500],
      ['glow', 590, 500],
      ['trail', 220, 200],
      ['glow', 220, 200],
      ['glow', 220, 200],
    ]);
    expect((layer.view.particleChildren[2]?.scaleX ?? 0) * 64).toBe(40);
    // And the renderer hands it SimState's own arrays each frame, keeping none of its own.
    const renderer = readFileSync(new URL('renderer.ts', import.meta.url), 'utf8');
    expect(renderer).toMatch(
      /this\.bullets\?\.update\(state\.bullets, state\.bulletCount, alpha\);/,
    );
  });

  it('starts a run with no bullet', () => {
    const layer = new BulletLayer({ glow, streak });
    const bullets = pool([{ prevX: 0, prevY: 0, x: 10, y: 0 }]);
    layer.update(bullets, 1, 1);
    layer.update(bullets, 1, 1);
    expect(layer.view.particleChildren).toHaveLength(3);
    layer.clear();
    expect(layer.view.particleChildren).toHaveLength(0);
    // The next run's ids start at 1 again: its bullet 1 is a new bullet, its head only.
    layer.update(bullets, 1, 1);
    expect(layer.view.particleChildren).toHaveLength(2);
  });

  it('draws no trail on a bullet’s first frame as the sim leaves it (C7.4b’s hand-off)', () => {
    // A shooter at its post, the waves empty. The sim fires and steps a bullet in the same tick
    // (fireBullet, then stepBullets), so after its fire tick prev is the muzzle and x one step on:
    // a trail aimed by prev would reach back through the shooter on the bullet's first frame.
    const data = v3TestData({
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
    const ctx = placedEnemies(
      [{ x: ARENA_WIDTH / 2 + 250, y: ARENA_HEIGHT / 2, type: 'shooter' }],
      { stats: makeStats({ maxLife: 1e6 }), data },
    );
    const tick = (): boolean => {
      ctx.events.length = 0;
      stepEnemyAi(ctx);
      moveEnemies(ctx);
      ctx.now++;
      ctx.state.tick++;
      return ctx.events.some((event) => event.type === 'bulletFired');
    };
    let fired = false;
    for (let t = 0; t < 600 && !fired; t++) fired = tick();
    expect(fired).toBe(true);
    expect(ctx.state.bulletCount).toBe(1);
    const bullets = ctx.state.bullets;
    expect(bullets.prevX[0]).toBe(ARENA_WIDTH / 2 + 250);
    expect(bullets.x[0]).toBeLessThan(ARENA_WIDTH / 2 + 250);
    // Its first frame, wherever between the two ticks it falls: the head only.
    for (const alpha of [0, 0.5, 1]) {
      const layer = new BulletLayer({ glow, streak });
      layer.update(ctx.state.bullets, ctx.state.bulletCount, alpha);
      expect(
        drawn(layer).map(([texture]) => texture),
        `alpha ${alpha}`,
      ).toEqual(['glow', 'glow']);
    }
    // A tick on, in flight: its trail.
    const layer = new BulletLayer({ glow, streak });
    layer.update(ctx.state.bullets, ctx.state.bulletCount, 0);
    expect(tick()).toBe(false);
    layer.update(ctx.state.bullets, ctx.state.bulletCount, 0.5);
    expect(drawn(layer).map(([texture]) => texture)).toEqual(['trail', 'glow', 'glow']);
  });
});
