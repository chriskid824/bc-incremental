import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { COLORS } from '../palette';
import {
  HitFlash,
  MAX_PART_OFFSET,
  angleDistance,
  clampOffset,
  dashes,
  degrees,
  falloff,
  hash01,
  wrapAngle,
  zigzag,
} from './shared';

describe('clampOffset', () => {
  it('keeps offsets within MAX_PART_OFFSET (40, game-design-v3 §11.2) and their direction', () => {
    expect(MAX_PART_OFFSET).toBe(40);
    expect(clampOffset(3, -4)).toEqual({ x: 3, y: -4 });
    expect(clampOffset(0, 0)).toEqual({ x: 0, y: 0 });
    const long = clampOffset(300, 400);
    expect(Math.hypot(long.x, long.y)).toBeCloseTo(40);
    expect(long.x / long.y).toBeCloseTo(0.75);
    const custom = clampOffset(-10, 0, 4);
    expect(custom.x).toBeCloseTo(-4);
    expect(custom.y).toBeCloseTo(0);
  });
});

describe('angles', () => {
  it('wraps into (-π, π] and measures unsigned distances', () => {
    for (const a of [-7, -Math.PI, -1, 0, 1, Math.PI, 4, 13]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI - 1e-9);
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a));
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a));
    }
    expect(angleDistance(degrees(170), degrees(-170))).toBeCloseTo(degrees(20));
    expect(angleDistance(degrees(-170), degrees(170))).toBeCloseTo(degrees(20));
    expect(angleDistance(0, Math.PI)).toBeCloseTo(Math.PI);
  });

  it('falls off smoothly from full to none', () => {
    expect(falloff(0, 1, 2)).toBe(1);
    expect(falloff(1, 1, 2)).toBe(1);
    expect(falloff(2, 1, 2)).toBe(0);
    expect(falloff(5, 1, 2)).toBe(0);
    let last = 1;
    for (let d = 1; d <= 2; d += 0.05) {
      const f = falloff(d, 1, 2);
      expect(f).toBeLessThanOrEqual(last);
      last = f;
    }
  });
});

describe('hash01', () => {
  it('is deterministic, in [0, 1), and spread out', () => {
    const values = Array.from({ length: 200 }, (_, i) => hash01(i, 3));
    expect(values).toEqual(Array.from({ length: 200 }, (_, i) => hash01(i, 3)));
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
    expect(hash01(5, 1)).not.toBe(hash01(5, 2));
  });
});

describe('zigzag', () => {
  it('pins both ends and replays the same bolt for the same seed', () => {
    const bolt = zigzag(0, 0, 100, 0, 8, 10, 42);
    expect(bolt).toHaveLength(18);
    expect(bolt.slice(0, 2)).toEqual([0, 0]);
    expect(bolt.slice(-2)).toEqual([100, 0]);
    expect(zigzag(0, 0, 100, 0, 8, 10, 42)).toEqual(bolt);
    expect(zigzag(0, 0, 100, 0, 8, 10, 43)).not.toEqual(bolt);
    for (let i = 3; i < bolt.length; i += 2) expect(Math.abs(bolt[i] ?? 0)).toBeLessThanOrEqual(10);
  });
});

describe('dashes', () => {
  it('cuts a closed outline into dashes and gaps of the given lengths', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    const parts = dashes(square, true, 3, 2);
    let drawn = 0;
    for (const part of parts) {
      let length = 0;
      for (let i = 2; i < part.length; i += 2) {
        length += Math.hypot(
          (part[i] ?? 0) - (part[i - 2] ?? 0),
          (part[i + 1] ?? 0) - (part[i - 1] ?? 0),
        );
      }
      expect(length).toBeLessThanOrEqual(3 + 1e-9);
      drawn += length;
    }
    // 40 units of outline: eight full 3 + 2 periods.
    expect(parts).toHaveLength(8);
    expect(drawn).toBeCloseTo(24);
  });

  it('follows corners inside a dash and leaves open outlines open', () => {
    const corner = dashes([0, 0, 2, 0, 2, 2], false, 3, 1);
    expect(corner[0]).toEqual([0, 0, 2, 0, 2, 1]);
    expect(corner).toHaveLength(1);
  });
});

describe('HitFlash', () => {
  it('tints the body hit-red and swells it, then fades back', () => {
    const body = new Container();
    const flash = new HitFlash();
    flash.trigger();
    flash.apply(body, 0);
    expect(body.tint).toBe(COLORS.playerHit);
    expect(body.scale.x).toBeGreaterThan(1);
    flash.apply(body, 1000);
    expect(body.tint).toBe(0xffffff);
    expect(body.scale.x).toBe(1);
  });
});
