import { describe, expect, it } from 'vitest';
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
});
