import { describe, expect, it } from 'vitest';
import { CONSTRUCT_COLORS } from './palette';
import { RingLayer } from './rings';

describe('RingLayer', () => {
  it('burns at most three full pandemic novas at once; the rest draw only a rim', () => {
    const rings = new RingLayer();
    const full = [];
    for (let i = 0; i < 6; i++) full.push(rings.nova(i * 10, 0, 250));
    expect(full).toEqual([true, true, true, false, false, false]);
    // A cascade of spreads replaces the oldest rims instead of piling them up: 3 full novas
    // (a fill and three strokes each) plus at most 10 rims (two strokes each).
    for (let i = 0; i < 40; i++) rings.nova(0, 0, 250);
    rings.update(16);
    expect(rings.view.context.instructions).toHaveLength(3 * 4 + 10 * 2);
  });

  it('frees nova slots once they burn out', () => {
    const rings = new RingLayer();
    for (let i = 0; i < 3; i++) rings.nova(0, 0, 250);
    expect(rings.nova(0, 0, 250)).toBe(false);
    rings.update(16);
    rings.update(1000);
    expect(rings.nova(0, 0, 250)).toBe(true);
    rings.clear();
    expect([rings.nova(0, 0, 250), rings.nova(0, 0, 250), rings.nova(0, 0, 250)]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('caps drone impacts on their own: a new one replaces the oldest, never a nova', () => {
    const rings = new RingLayer();
    for (let i = 0; i < 3; i++) expect(rings.nova(0, 0, 250)).toBe(true);
    for (let i = 0; i < 10; i++) rings.nova(0, 0, 250);
    // A storm of impacts (a disc and a ring each), far more than their cap of 24.
    for (let i = 0; i < 100; i++) rings.impact(i, 0, 40);
    rings.update(16);
    expect(rings.view.context.instructions).toHaveLength(3 * 4 + 10 * 2 + 24 * 2);
    // The novas still hold their slots; impacts burn out on their own.
    expect(rings.nova(0, 0, 250)).toBe(false);
    rings.update(400);
    expect(rings.view.context.instructions).toHaveLength(3 * 4 + 10 * 2);
  });

  it('draws the newest impacts, in hive green, growing to the splash radius', () => {
    const rings = new RingLayer();
    for (let i = 0; i < 30; i++) rings.impact(i * 100, 0, 40);
    rings.update(16);
    const shapes = rings.view.context.instructions.map((instruction) => {
      const { path, style } = instruction.data as unknown as {
        path: { shapePath: { shapePrimitives: { shape: { x: number; radius: number } }[] } };
        style: { color: number };
      };
      const circle = path.shapePath.shapePrimitives[0]?.shape;
      return { x: circle?.x, radius: circle?.radius, color: style.color };
    });
    expect(shapes).toHaveLength(24 * 2);
    expect(new Set(shapes.map((shape) => shape.x))).toEqual(
      new Set(Array.from({ length: 24 }, (_, i) => (i + 6) * 100)),
    );
    for (const shape of shapes) {
      expect(shape.color).toBe(CONSTRUCT_COLORS.hive.main);
      expect(shape.radius).toBeGreaterThan(0);
      expect(shape.radius).toBeLessThan(40);
    }
    rings.update(120);
    for (const instruction of rings.view.context.instructions) {
      const { path } = instruction.data as unknown as {
        path: { shapePath: { shapePrimitives: { shape: { radius: number } }[] } };
      };
      expect(path.shapePath.shapePrimitives[0]?.shape.radius).toBeCloseTo(40, 6);
    }
  });
});
