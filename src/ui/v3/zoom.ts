/**
 * The web panel's camera (docs/v3/game-design-v3.md §3, §8 item 2): three discrete zoom levels and
 * a pan, as pure functions of the layout's bounds and the viewport. A camera is the layout point at
 * the viewport's centre and a level; the scale (screen pixels per layout unit) follows from the
 * level and the scale that fits the whole web. The wheel steps a level at a time, keeping the
 * layout point under the pointer where it was.
 */

import type { Point, WebLayout } from '../../data/web/types';

/** 0 遠景 (overview), 1 中景 (branches), 2 近景 (nodes). */
export type ZoomLevel = 0 | 1 | 2;
export const ZOOM_LEVELS: readonly ZoomLevel[] = [0, 1, 2];

export type Bounds = WebLayout['bounds'];

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface Camera {
  readonly level: ZoomLevel;
  /** The layout point at the viewport's centre. */
  readonly x: number;
  readonly y: number;
}

export interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Layout units kept around the bounds when the web is fitted: an outer's collapsed circle and its label. */
export const FIT_MARGIN = 120;

/**
 * Each level's scale over the fitting scale, and the least scale it takes (screen pixels per
 * layout unit, nodes being 100 units apart): mid shows nodes ~40 px apart, near ~85 px, enough for
 * a name under a node.
 */
const LEVEL_FACTOR: Readonly<Record<ZoomLevel, number>> = { 0: 1, 1: 1.9, 2: 4 };
const LEVEL_FLOOR: Readonly<Record<ZoomLevel, number>> = { 0: 0, 1: 0.32, 2: 0.75 };

/** What each level draws (gd §3): far the center, the outers' names and the spoke progress; mid the branches; near the nodes. */
export interface LevelShows {
  /** Board names: the outers' (or 「？」) and the fusions'. */
  readonly boardNames: boolean;
  /** 「中心 8/8・毒 3/6」 on each spoke. */
  readonly spokeProgress: boolean;
  /** The branch names of the center and the outers. */
  readonly branchNames: boolean;
  /** A collapsed outer's covered enemies. */
  readonly covers: boolean;
  /** Each named node's name and each ranked node's 「2/5」. */
  readonly nodeLabels: boolean;
}

export const LEVEL_SHOWS: Readonly<Record<ZoomLevel, LevelShows>> = {
  0: {
    boardNames: true,
    spokeProgress: true,
    branchNames: false,
    covers: false,
    nodeLabels: false,
  },
  1: { boardNames: true, spokeProgress: true, branchNames: true, covers: true, nodeLabels: false },
  2: { boardNames: true, spokeProgress: true, branchNames: true, covers: true, nodeLabels: true },
};

/** The scale at which the bounds, with FIT_MARGIN, fill the viewport. */
export function fitScale(bounds: Bounds, viewport: Viewport): number {
  const width = bounds.maxX - bounds.minX + 2 * FIT_MARGIN;
  const height = bounds.maxY - bounds.minY + 2 * FIT_MARGIN;
  const scale = Math.min(viewport.width / width, viewport.height / height);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** The scale of `level` given the fitting scale; never below the fit, increasing with the level. */
export function scaleOf(level: ZoomLevel, fit: number): number {
  let scale = fit;
  for (const step of ZOOM_LEVELS) {
    if (step > level) break;
    scale = Math.max(scale, fit * LEVEL_FACTOR[step], LEVEL_FLOOR[step]);
  }
  return scale;
}

/** The camera that shows the whole web: far, centred on the bounds. */
export function homeCamera(bounds: Bounds): Camera {
  return { level: 0, x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

/** The SVG viewBox of `camera`. */
export function viewBoxOf(camera: Camera, viewport: Viewport, fit: number): ViewBox {
  const scale = scaleOf(camera.level, fit);
  const width = viewport.width / scale;
  const height = viewport.height / scale;
  return { x: camera.x - width / 2, y: camera.y - height / 2, width, height };
}

/** The layout point under the screen point `at` (pixels from the viewport's top left). */
export function toLayout(camera: Camera, viewport: Viewport, fit: number, at: Point): Point {
  const scale = scaleOf(camera.level, fit);
  return {
    x: camera.x + (at.x - viewport.width / 2) / scale,
    y: camera.y + (at.y - viewport.height / 2) / scale,
  };
}

/** The camera centre kept inside the bounds, so the web never leaves the screen. */
export function clampCamera(camera: Camera, bounds: Bounds): Camera {
  const x = Math.min(Math.max(camera.x, bounds.minX), bounds.maxX);
  const y = Math.min(Math.max(camera.y, bounds.minY), bounds.maxY);
  return x === camera.x && y === camera.y ? camera : { ...camera, x, y };
}

/**
 * The camera at `level`, the layout point under the screen point `at` staying under it (the
 * viewport's centre when `at` is omitted); at level 0 the whole web, centred.
 */
export function zoomTo(
  camera: Camera,
  level: ZoomLevel,
  viewport: Viewport,
  fit: number,
  bounds: Bounds,
  at?: Point,
): Camera {
  if (level === 0) return homeCamera(bounds);
  const anchor = at ?? { x: viewport.width / 2, y: viewport.height / 2 };
  const fixed = toLayout(camera, viewport, fit, anchor);
  const scale = scaleOf(level, fit);
  return clampCamera(
    {
      level,
      x: fixed.x - (anchor.x - viewport.width / 2) / scale,
      y: fixed.y - (anchor.y - viewport.height / 2) / scale,
    },
    bounds,
  );
}

/** The level one wheel notch reaches: up (deltaY < 0) zooms in, down zooms out, clamped. */
export function wheelLevel(level: ZoomLevel, deltaY: number): ZoomLevel {
  if (deltaY === 0) return level;
  const next = level + (deltaY < 0 ? 1 : -1);
  return Math.min(2, Math.max(0, next)) as ZoomLevel;
}

/** The camera after the pointer dragged the web by (dx, dy) screen pixels. */
export function panBy(camera: Camera, dx: number, dy: number, fit: number, bounds: Bounds): Camera {
  const scale = scaleOf(camera.level, fit);
  return clampCamera({ ...camera, x: camera.x - dx / scale, y: camera.y - dy / scale }, bounds);
}
