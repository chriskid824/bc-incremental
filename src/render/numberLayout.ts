/**
 * Layout rules for floating damage numbers (docs/ARCHITECTURE.md §10), kept free of PixiJS so
 * they can be tested: how big a number is, how long it lives while the screen is busy, where it
 * may float without drifting under the DOM HUD, and how it steps aside from numbers already
 * there. Sizes and positions are in arena units.
 */

/** How a number is drawn; 'critSmall' is a crit shown at normal size once big pops run out. */
export type NumberStyle = 'hit' | 'chain' | 'burn' | 'crit' | 'critSmall';

interface SizeRule {
  /** Height at the typical hit. */
  readonly base: number;
  /** Fraction of `base` added per order of magnitude above the typical hit. */
  readonly perDecade: number;
  /** Largest height, however big the amount. */
  readonly max: number;
}

/** Height of a plain hit number at the typical hit; other sizes are set against it. */
export const NORMAL_SIZE = 22;

const SIZES: Readonly<Record<NumberStyle, SizeRule>> = {
  hit: { base: NORMAL_SIZE, perDecade: 0.3, max: NORMAL_SIZE * 1.3 },
  chain: { base: 20, perDecade: 0.3, max: NORMAL_SIZE * 1.2 },
  burn: { base: 16, perDecade: 0.25, max: NORMAL_SIZE },
  // Big crit pops grow slowly and stop at about 1.6x a normal number (1.8x at the pop's peak).
  crit: { base: 30, perDecade: 0.12, max: NORMAL_SIZE * 1.6 },
  critSmall: { base: NORMAL_SIZE * 1.1, perDecade: 0.1, max: NORMAL_SIZE * 1.25 },
};

/** Orders of magnitude below the typical hit that still shrink a number. */
const MIN_DECADES = -1;
/** Smallest height, so tiny burn ticks stay legible. */
const MIN_SIZE = 9;

/** Height in arena units of a number `decades` orders of magnitude above the typical hit. */
export function numberSize(style: NumberStyle, decades: number): number {
  const rule = SIZES[style];
  const d = Number.isFinite(decades) ? Math.max(MIN_DECADES, decades) : MIN_DECADES;
  return Math.max(MIN_SIZE, Math.min(rule.max, rule.base * (1 + rule.perDecade * d)));
}

/**
 * Every number rises at this speed (arena units per ms) for its whole life, so numbers placed
 * apart stay apart instead of catching up with each other.
 */
export const RISE_PER_MS = 0.065;

/** Share of a number's life cut when its pool is full; a half-full pool cuts half as much. */
export const LOAD_SHORTEN = 0.45;

/** Lifetime of a new number when `live` of `cap` slots are taken: busy screens clear faster. */
export function lifeUnderLoad(baseMs: number, live: number, cap: number): number {
  const load = cap > 0 ? Math.min(1, Math.max(0, live / cap)) : 1;
  return baseMs * (1 - LOAD_SHORTEN * load);
}

/** Half extents of a number's box: glyphs are about 0.56 of the height wide, plus outline. */
export function halfWidth(chars: number, size: number): number {
  return (Math.max(1, chars) * 0.56 + 0.3) * size * 0.5;
}

export function halfHeight(size: number): number {
  return size * 0.42;
}

/** An arena rectangle covered by the HUD. */
export interface Zone {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where numbers may float: the arena, minus HUD zones along its top and bottom edges. */
export interface SafeArea {
  readonly width: number;
  readonly height: number;
  /** Zones touching the top edge push numbers down; the others push them up. */
  readonly zones: readonly Zone[];
}

/** Gap kept from the arena edges. */
const EDGE = 6;

/** A mutable point, so callers can reuse one instead of allocating per number. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Moves a number spawned at (x, y) so that its whole path (it rises by `rise`) stays inside the
 * arena and out of every HUD zone. Writes the result to `out`.
 */
export function keepClear(
  out: Point,
  area: SafeArea,
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  rise: number,
): Point {
  const cx = Math.min(Math.max(x, halfW + EDGE), area.width - halfW - EDGE);
  let cy = y;
  for (let i = 0; i < area.zones.length; i++) {
    const zone = area.zones[i] as Zone;
    if (cx + halfW <= zone.left || cx - halfW >= zone.right) continue;
    const top = cy - rise - halfH;
    const bottom = cy + halfH;
    if (bottom <= zone.top || top >= zone.bottom) continue;
    if (zone.top <= 0) cy = zone.bottom + rise + halfH;
    else cy = zone.top - halfH;
  }
  cy = Math.min(Math.max(cy, rise + halfH + EDGE), area.height - halfH - EDGE);
  out.x = cx;
  out.y = cy;
  return out;
}

/** A number already on screen: its center now and its half extents. */
export interface NumberBox {
  readonly x: number;
  readonly y: number;
  readonly halfW: number;
  readonly halfH: number;
  /** False once it has mostly faded out: a new number may cover it. */
  readonly solid: boolean;
}

/**
 * Offsets tried for a new number (x, y pairs): in place, above, below, two above, then to
 * either side. y is in box heights; x is in box widths plus the side gap (GAP_X).
 */
const CANDIDATES = [0, 0, 0, -1, 0, 1, 0, -2, 1, 0, -1, 0] as const;
/** Stacked rows may overlap by this fraction of their heights (outlines may touch). */
const SLACK_Y = 0.15;
/**
 * Side by side, two numbers need a gap of this fraction of their summed half heights (about a
 * fifth of their height) on top of their outlines, or they read as one ("84.384.3").
 */
export const GAP_X = 0.25;

function overlaps(
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  groups: readonly (readonly NumberBox[])[],
): boolean {
  for (let g = 0; g < groups.length; g++) {
    const boxes = groups[g] as readonly NumberBox[];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i] as NumberBox;
      if (!b.solid) continue;
      const reachX = halfW + b.halfW + GAP_X * (halfH + b.halfH);
      const reachY = (halfH + b.halfH) * (1 - SLACK_Y);
      if (Math.abs(b.x - x) < reachX && Math.abs(b.y - y) < reachY) return true;
    }
  }
  return false;
}

/**
 * Finds a spot for a new number near (x, y) that covers no box in `groups`, trying a few
 * positions stacked above, below and beside it, each kept clear of the HUD. Writes it to `out`
 * and returns true; returns false (with `out` at the first candidate) when every spot is taken.
 */
export function findSpot(
  out: Point,
  area: SafeArea,
  groups: readonly (readonly NumberBox[])[],
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  rise: number,
): boolean {
  let firstX = x;
  let firstY = y;
  // A step to the side clears a neighbor of the same size, gap included, with a little to spare.
  const stepX = (halfW + GAP_X * halfH) * 2.2;
  for (let i = 0; i < CANDIDATES.length; i += 2) {
    const cx = x + (CANDIDATES[i] as number) * stepX;
    const cy = y + (CANDIDATES[i + 1] as number) * halfH * 2;
    keepClear(out, area, cx, cy, halfW, halfH, rise);
    if (i === 0) {
      firstX = out.x;
      firstY = out.y;
    }
    if (!overlaps(out.x, out.y, halfW, halfH, groups)) return true;
  }
  out.x = firstX;
  out.y = firstY;
  return false;
}

/**
 * HUD boxes in CSS pixels from the window edges, mirroring src/ui/style.ts with some margin:
 * the wave panel (top left), the life bar (top center), the run currencies (top right) and the
 * speed buttons (bottom right).
 */
const HUD_TOP_LEFT = { width: 280, height: 136 };
const HUD_TOP_STRIP = 84;
const HUD_BOTTOM_RIGHT = { width: 240, height: 92 };

/**
 * The safe area for numbers when an arena of `arenaW` × `arenaH` is drawn at `scale`, offset by
 * (`offsetX`, `offsetY`) inside a `screenW` × `screenH` window that the DOM HUD overlays.
 */
export function hudSafeArea(
  arenaW: number,
  arenaH: number,
  screenW: number,
  screenH: number,
  scale: number,
  offsetX: number,
  offsetY: number,
): SafeArea {
  const s = scale > 0 ? scale : 1;
  const ax = (px: number): number => (px - offsetX) / s;
  const ay = (px: number): number => (px - offsetY) / s;
  const above = -arenaH;
  const below = arenaH * 2;
  return {
    width: arenaW,
    height: arenaH,
    zones: [
      { left: -arenaW, top: above, right: ax(HUD_TOP_LEFT.width), bottom: ay(HUD_TOP_LEFT.height) },
      { left: -arenaW, top: above, right: arenaW * 2, bottom: ay(HUD_TOP_STRIP) },
      {
        left: ax(screenW - HUD_BOTTOM_RIGHT.width),
        top: ay(screenH - HUD_BOTTOM_RIGHT.height),
        right: arenaW * 2,
        bottom: below,
      },
    ],
  };
}
