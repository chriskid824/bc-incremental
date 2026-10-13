import { describe, expect, it } from 'vitest';
import {
  findSpot,
  GAP_X,
  halfHeight,
  halfWidth,
  hudSafeArea,
  keepClear,
  LOAD_SHORTEN,
  lifeUnderLoad,
  NORMAL_SIZE,
  numberSize,
} from './numberLayout';
import type { NumberBox, NumberStyle, Point, SafeArea } from './numberLayout';

const STYLES: readonly NumberStyle[] = ['hit', 'chain', 'burn', 'crit', 'critSmall'];
const DECADES = [-3, -1, -0.5, 0, 0.3, 0.7, 1, 1.4, 2, 3, 4, 10];
const W = 1920;
const H = 1080;

describe('numberSize', () => {
  it('never grows past its ceiling and never shrinks as the amount grows', () => {
    for (const style of STYLES) {
      let last = 0;
      for (const d of DECADES) {
        const size = numberSize(style, d);
        expect(size).toBeGreaterThanOrEqual(last);
        last = size;
      }
    }
  });

  it('keeps big crit pops within about 1.6x a normal number however big the crit', () => {
    for (const d of DECADES) {
      const crit = numberSize('crit', d);
      expect(crit).toBeLessThanOrEqual(NORMAL_SIZE * 1.65);
      // Crits still read bigger than any plain hit, and small crits sit between the two.
      expect(crit).toBeGreaterThan(numberSize('hit', d));
      expect(numberSize('critSmall', d)).toBeLessThanOrEqual(crit);
    }
    expect(numberSize('crit', 0)).toBeGreaterThan(NORMAL_SIZE * 1.2);
  });

  it('keeps burn numbers no bigger than hits and every number legible', () => {
    for (const d of DECADES) {
      expect(numberSize('burn', d)).toBeLessThanOrEqual(numberSize('hit', d));
      for (const style of STYLES) expect(numberSize(style, d)).toBeGreaterThan(8);
    }
    expect(numberSize('hit', Number.NaN)).toBe(numberSize('hit', -1));
  });
});

describe('lifeUnderLoad', () => {
  it('shortens lifetimes as the pool fills', () => {
    expect(lifeUnderLoad(600, 0, 80)).toBe(600);
    expect(lifeUnderLoad(600, 40, 80)).toBeCloseTo(600 * (1 - LOAD_SHORTEN / 2));
    expect(lifeUnderLoad(600, 80, 80)).toBeCloseTo(600 * (1 - LOAD_SHORTEN));
    expect(lifeUnderLoad(600, 500, 80)).toBeCloseTo(600 * (1 - LOAD_SHORTEN));
  });
});

describe('hudSafeArea and keepClear', () => {
  // A 1600×900 window shows the 1920×1080 arena at 5/6 scale with no letterbox.
  const scale = 1600 / W;
  const area = hudSafeArea(W, H, 1600, 900, scale, 0, 0);
  const out: Point = { x: 0, y: 0 };
  const halfW = halfWidth(3, 36);
  const halfH = halfHeight(36);
  const rise = 40;

  /** Whether the number's path covers a zone by more than rounding. */
  function overlapsZones(x: number, y: number): boolean {
    const e = 1e-6;
    return area.zones.some(
      (z) =>
        x + halfW > z.left + e &&
        x - halfW < z.right - e &&
        y + halfH > z.top + e &&
        y - rise - halfH < z.bottom - e,
    );
  }

  it('pushes numbers near the top edge below the HUD for their whole rise', () => {
    for (const x of [40, 300, 960, 1700, 1900]) {
      keepClear(out, area, x, 20, halfW, halfH, rise);
      expect(overlapsZones(out.x, out.y)).toBe(false);
      expect(out.y - rise - halfH).toBeGreaterThan(0);
    }
  });

  it('lifts numbers out of the speed buttons in the bottom-right corner', () => {
    keepClear(out, area, W - 60, H - 30, halfW, halfH, rise);
    expect(overlapsZones(out.x, out.y)).toBe(false);
    expect(out.y).toBeLessThan(H - 30);
    // The bottom-left corner has no HUD: only the arena edge applies.
    keepClear(out, area, 300, H - 60, halfW, halfH, rise);
    expect(out.y).toBe(H - 60);
  });

  it('keeps numbers inside the arena and leaves the open middle alone', () => {
    keepClear(out, area, -50, 540, halfW, halfH, rise);
    expect(out.x - halfW).toBeGreaterThanOrEqual(0);
    keepClear(out, area, W + 50, 540, halfW, halfH, rise);
    expect(out.x + halfW).toBeLessThanOrEqual(W);
    keepClear(out, area, 960, 540, halfW, halfH, rise);
    expect(out).toEqual({ x: 960, y: 540 });
  });

  it('measures HUD zones in screen pixels, so smaller windows guard more arena', () => {
    const small = hudSafeArea(W, H, 960, 540, 0.5, 0, 0);
    const bottom = (a: SafeArea): number =>
      Math.max(...a.zones.map((z) => (z.top <= 0 ? z.bottom : 0)));
    expect(bottom(small)).toBeGreaterThan(bottom(area));
    // A letterboxed window shifts the zones by the bar.
    const boxed = hudSafeArea(W, H, 1600, 1000, scale, 0, 50);
    expect(bottom(boxed)).toBeCloseTo(bottom(area) - 50 / scale);
  });
});

describe('findSpot', () => {
  const area: SafeArea = { width: W, height: H, zones: [] };
  const out: Point = { x: 0, y: 0 };
  const halfW = halfWidth(4, 22);
  const halfH = halfHeight(22);

  it('keeps a number in place when nothing is there', () => {
    expect(findSpot(out, area, [[]], 500, 500, halfW, halfH, 40)).toBe(true);
    expect(out).toEqual({ x: 500, y: 500 });
  });

  it('steps a number aside instead of covering one already on screen', () => {
    const shown: NumberBox[] = [{ x: 500, y: 500, halfW, halfH, solid: true }];
    expect(findSpot(out, area, [shown], 504, 502, halfW, halfH, 40)).toBe(true);
    const b = shown[0] as NumberBox;
    const apart =
      Math.abs(out.x - b.x) >= halfW + b.halfW || Math.abs(out.y - b.y) >= (halfH + b.halfH) * 0.95;
    expect(apart).toBe(true);
  });

  it('never sets two numbers flush side by side, where they would read as one', () => {
    // A number right against another one's side counts as covering it: this one moves up.
    const flush: NumberBox[] = [{ x: 500 + halfW * 2, y: 500, halfW, halfH, solid: true }];
    expect(findSpot(out, area, [flush], 500, 500, halfW, halfH, 40)).toBe(true);
    expect(out.x).toBe(500);
    expect(out.y).toBeLessThan(500);
    // With the rows above and below taken, the side step leaves a visible gap.
    const column: NumberBox[] = [-2, -1, 0, 1].map((row) => ({
      x: 500,
      y: 500 + row * halfH * 2,
      halfW,
      halfH,
      solid: true,
    }));
    expect(findSpot(out, area, [column], 500, 500, halfW, halfH, 40)).toBe(true);
    expect(out.y).toBe(500);
    expect(Math.abs(out.x - 500) - halfW * 2).toBeGreaterThanOrEqual(GAP_X * halfH * 2);
  });

  it('may cover a number that has mostly faded out', () => {
    const fading: NumberBox[] = [{ x: 500, y: 500, halfW, halfH, solid: false }];
    expect(findSpot(out, area, [fading], 500, 500, halfW, halfH, 40)).toBe(true);
    expect(out).toEqual({ x: 500, y: 500 });
  });

  it('reports a crowded spot so the caller can drop the number', () => {
    const crowd: NumberBox[] = [];
    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        crowd.push({ x: 500 + dx * halfW * 2, y: 500 + dy * halfH * 2, halfW, halfH, solid: true });
      }
    }
    expect(findSpot(out, area, [[], crowd], 500, 500, halfW, halfH, 40)).toBe(false);
    expect(out).toEqual({ x: 500, y: 500 });
  });
});
