import { describe, expect, it } from 'vitest';
import {
  clampCamera,
  FIT_MARGIN,
  fitScale,
  homeCamera,
  LEVEL_SHOWS,
  panBy,
  scaleOf,
  toLayout,
  viewBoxOf,
  wheelLevel,
  ZOOM_LEVELS,
  zoomTo,
} from './zoom';
import type { Camera } from './zoom';

const bounds = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
const viewport = { width: 1600, height: 900 };

describe('the web panel camera (gd §3, §8 item 2)', () => {
  it('fits the bounds and their margin into the viewport', () => {
    const fit = fitScale(bounds, viewport);
    expect(fit).toBeCloseTo(900 / (4000 + 2 * FIT_MARGIN));
    const box = viewBoxOf(homeCamera(bounds), viewport, fit);
    expect(box.height).toBeCloseTo(4000 + 2 * FIT_MARGIN);
    expect(box.x + box.width / 2).toBeCloseTo(0);
    expect(fitScale(bounds, { width: 0, height: 0 })).toBe(1);
  });

  it('has three levels whose scale grows, the far one fitting the web', () => {
    const fit = fitScale(bounds, viewport);
    const scales = ZOOM_LEVELS.map((level) => scaleOf(level, fit));
    expect(scales[0]).toBe(fit);
    expect(scales[1]).toBeGreaterThan(scales[0] as number);
    expect(scales[2]).toBeGreaterThan(scales[1] as number);
    // A small web still zooms in: each level is at least its factor over the fit.
    const big = 2;
    expect(scaleOf(1, big)).toBeGreaterThan(big);
    expect(scaleOf(2, big)).toBeGreaterThan(scaleOf(1, big));
  });

  it('shows the outers and the spoke progress far, the branches mid and the nodes near', () => {
    expect(LEVEL_SHOWS[0]).toMatchObject({
      boardNames: true,
      spokeProgress: true,
      branchNames: false,
      nodeLabels: false,
    });
    expect(LEVEL_SHOWS[1]).toMatchObject({ branchNames: true, covers: true, nodeLabels: false });
    expect(LEVEL_SHOWS[2]).toMatchObject({ branchNames: true, nodeLabels: true });
  });

  it('steps one level per wheel notch, clamped', () => {
    expect(wheelLevel(0, -120)).toBe(1);
    expect(wheelLevel(1, -1)).toBe(2);
    expect(wheelLevel(2, -120)).toBe(2);
    expect(wheelLevel(2, 120)).toBe(1);
    expect(wheelLevel(0, 120)).toBe(0);
    expect(wheelLevel(1, 0)).toBe(1);
  });

  it('keeps the layout point under the pointer when zooming in', () => {
    const fit = fitScale(bounds, viewport);
    const camera = homeCamera(bounds);
    const at = { x: 1200, y: 300 };
    const before = toLayout(camera, viewport, fit, at);
    const zoomed = zoomTo(camera, 1, viewport, fit, bounds, at);
    expect(zoomed.level).toBe(1);
    const after = toLayout(zoomed, viewport, fit, at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    const near = zoomTo(zoomed, 2, viewport, fit, bounds, at);
    expect(toLayout(near, viewport, fit, at).x).toBeCloseTo(before.x);
  });

  it('returns to the whole web at the far level', () => {
    const fit = fitScale(bounds, viewport);
    const camera: Camera = { level: 2, x: 1500, y: -900 };
    expect(zoomTo(camera, 0, viewport, fit, bounds, { x: 10, y: 10 })).toEqual(homeCamera(bounds));
  });

  it('pans with the pointer and never past the bounds', () => {
    const fit = fitScale(bounds, viewport);
    const camera: Camera = { level: 1, x: 0, y: 0 };
    const scale = scaleOf(1, fit);
    const moved = panBy(camera, 100, -50, fit, bounds);
    expect(moved.x).toBeCloseTo(-100 / scale);
    expect(moved.y).toBeCloseTo(50 / scale);
    const far = panBy(camera, -1e7, 1e7, fit, bounds);
    expect(far).toMatchObject({ x: bounds.maxX, y: bounds.minY });
    expect(clampCamera(camera, bounds)).toBe(camera);
  });
});
