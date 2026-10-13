import { Particle, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  FX_CAPS,
  FX_DEBRIS,
  FX_FLAME,
  FX_SPARK,
  FxParticles,
  THEN_FLAME_PUFF,
  packColor,
} from './fx';
import { FIRST_FRAME_MS } from './timing';

const tex = Texture.WHITE;

function spawnMany(fx: FxParticles, group: 0 | 1 | 2 | 3 | 4, n: number, lifeMs = 100): number {
  let spawned = 0;
  for (let i = 0; i < n; i++) if (fx.spawn(group, tex, 0, 0, lifeMs) !== null) spawned++;
  return spawned;
}

describe('FxParticles', () => {
  it('drops spawns past a group cap without touching the other groups', () => {
    const fx = new FxParticles({ glow: tex });
    const cap = FX_CAPS[FX_SPARK] ?? 0;
    expect(spawnMany(fx, FX_SPARK, cap * 3)).toBe(cap);
    expect(fx.count(FX_SPARK)).toBe(cap);
    expect(fx.room(FX_SPARK)).toBe(0);
    expect(spawnMany(fx, FX_DEBRIS, 5)).toBe(5);
    expect(fx.view.particleChildren).toHaveLength(cap + 5);
  });

  it('frees expired particles for new spawns and keeps the container in sync', () => {
    const fx = new FxParticles({ glow: tex });
    const cap = FX_CAPS[FX_FLAME] ?? 0;
    spawnMany(fx, FX_FLAME, cap, 50);
    spawnMany(fx, FX_DEBRIS, 3, 1000);
    fx.update(FIRST_FRAME_MS);
    fx.update(50);
    expect(fx.count(FX_FLAME)).toBe(0);
    expect(fx.count(FX_DEBRIS)).toBe(3);
    expect(fx.view.particleChildren).toHaveLength(3);
    expect(spawnMany(fx, FX_FLAME, cap)).toBe(cap);
    fx.clear();
    expect(fx.view.particleChildren).toHaveLength(0);
    expect(fx.count(FX_FLAME) + fx.count(FX_DEBRIS)).toBe(0);
  });

  it('ages a new particle at most one 60 Hz frame on its first update', () => {
    const fx = new FxParticles({ glow: tex });
    fx.spawn(FX_SPARK, tex, 0, 0, 40);
    // A slow frame right after the spawn still leaves the particle on screen once.
    fx.update(200);
    expect(fx.count(FX_SPARK)).toBe(1);
    fx.update(200);
    expect(fx.count(FX_SPARK)).toBe(0);
  });

  it('moves particles with drag and runs expiry follow-ups where they end', () => {
    const fx = new FxParticles({ glow: tex });
    const p = fx.spawn(FX_SPARK, tex, 10, 20, 100);
    expect(p).not.toBeNull();
    if (p === null) return;
    p.vx = 600;
    p.drag = 2;
    p.then = THEN_FLAME_PUFF;
    fx.update(FIRST_FRAME_MS);
    const x1 = p.sprite.x;
    expect(x1).toBeGreaterThan(10);
    expect(x1).toBeLessThan(10 + 600 * (FIRST_FRAME_MS / 1000));
    fx.update(100);
    const ends: number[] = [];
    fx.drainFollowUps((x, y) => ends.push(x, y));
    expect(ends).toEqual([x1, 20]);
    // The queue is cleared once drained.
    fx.drainFollowUps((x, y) => ends.push(x, y));
    expect(ends).toHaveLength(2);
  });
});

describe('packColor', () => {
  it('packs color and alpha the way Pixi particles do', () => {
    const particle = new Particle({ texture: tex });
    for (const [rgb, alpha] of [
      [0x112233, 1],
      [0xffd84a, 0.5],
      [0x5ff4ff, 0.14],
      [0xffffff, 0],
    ] as const) {
      particle.tint = rgb;
      particle.alpha = alpha;
      expect(packColor(rgb, alpha)).toBe(particle.color);
    }
  });
});
