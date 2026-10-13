/**
 * Pieces shared by the character constructs (docs/v3/game-design-v3.md §11.3): the view
 * interface, the cap on render-only part offsets (§11.2), angle and easing helpers, a
 * deterministic hash so idle flicker looks random but replays the same, and the red hit flash.
 *
 * Constructs are drawn in arena units around their own origin; the sim keeps the player fixed
 * at the arena center with collision radius PLAYER_RADIUS, whatever the construct looks like.
 */

import type { Container, Graphics } from 'pixi.js';
import { COLORS, mixColor } from '../palette';

/** Render-only lean, recoil and part offsets stay within this many arena units (§11.2). */
export const MAX_PART_OFFSET = 40;

const HIT_FLASH_MS = 260;
const HIT_SWELL = 0.12;

/** A construct view: what the renderer needs to show one character at the arena center. */
export interface ConstructView {
  /** Position and scale this from outside; the construct animates a child of it. */
  readonly view: Container;
  /** Advances the idle animation and any attack pose or hit flash by `dtMs`. */
  update(dtMs: number): void;
  /** Plays the attack pose toward `angle` (radians; 0 = +x, y points down). */
  attack(angle: number): void;
  /** Red hit flash, kept from the M1 player (§11.3). */
  hit(): void;
  /** Back to the resting pose, as at the start of a run. */
  reset(): void;
}

export interface Vec {
  readonly x: number;
  readonly y: number;
}

/** (dx, dy) shortened, if needed, to at most `max` units. */
export function clampOffset(dx: number, dy: number, max = MAX_PART_OFFSET): Vec {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len <= max || len === 0) return { x: dx, y: dy };
  const k = max / len;
  return { x: dx * k, y: dy * k };
}

/** `angle` wrapped into (-π, π]. */
export function wrapAngle(angle: number): number {
  const a = angle % (2 * Math.PI);
  if (a > Math.PI) return a - 2 * Math.PI;
  if (a <= -Math.PI) return a + 2 * Math.PI;
  return a;
}

/** Unsigned angle between two directions, in [0, π]. */
export function angleDistance(a: number, b: number): number {
  return Math.abs(wrapAngle(a - b));
}

export function degrees(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function clamp01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

export function easeOutCubic(t: number): number {
  const k = 1 - clamp01(t);
  return 1 - k * k * k;
}

export function easeInOutCubic(t: number): number {
  const k = clamp01(t);
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

/** 1 for `d` up to `full`, 0 from `none` on, smooth in between (`full` < `none`). */
export function falloff(d: number, full: number, none: number): number {
  const t = clamp01((d - full) / (none - full));
  return 1 - t * t * (3 - 2 * t);
}

/** Deterministic hash of an integer-ish value (and an optional salt) to [0, 1). */
export function hash01(n: number, salt = 0): number {
  let h = Math.imul(Math.floor(n) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * A lightning zigzag from (x0, y0) to (x1, y1) as x, y pairs with pinned ends. The kinks come
 * from `seed`, so the same seed gives the same bolt; kinks are largest mid-bolt.
 */
export function zigzag(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  segments: number,
  jitter: number,
  seed: number,
): number[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const points = [x0, y0];
  for (let s = 1; s < segments; s++) {
    const t = s / segments;
    const envelope = Math.sin(Math.PI * t);
    const offset = (hash01(seed, s) * 2 - 1) * jitter * (0.4 + 0.6 * envelope);
    points.push(x0 + dx * t + nx * offset, y0 + dy * t + ny * offset);
  }
  points.push(x1, y1);
  return points;
}

/**
 * Splits a polyline (x, y pairs; closed when `closed`) into dashes of `dash` units with `gap`
 * units between them. Each dash is its own x, y list.
 */
export function dashes(
  points: readonly number[],
  closed: boolean,
  dash: number,
  gap: number,
): number[][] {
  const out: number[][] = [];
  const n = points.length / 2;
  const edges = closed ? n : n - 1;
  let current: number[] = [];
  /** Distance left in the current dash, or gap when not `drawing`. */
  let left = dash;
  let drawing = true;
  for (let e = 0; e < edges; e++) {
    const ax = points[e * 2] ?? 0;
    const ay = points[e * 2 + 1] ?? 0;
    const bx = points[((e + 1) % n) * 2] ?? 0;
    const by = points[((e + 1) % n) * 2 + 1] ?? 0;
    const len = Math.hypot(bx - ax, by - ay);
    let at = 0;
    while (at < len) {
      const step = Math.min(left, len - at);
      const t0 = at / len;
      const t1 = (at + step) / len;
      if (drawing) {
        if (current.length === 0) current.push(ax + (bx - ax) * t0, ay + (by - ay) * t0);
        current.push(ax + (bx - ax) * t1, ay + (by - ay) * t1);
      }
      at += step;
      left -= step;
      if (left <= 1e-9) {
        if (drawing && current.length >= 4) out.push(current);
        current = [];
        drawing = !drawing;
        left = drawing ? dash : gap;
      }
    }
  }
  if (drawing && current.length >= 4) out.push(current);
  return out;
}

/** Layers in a halo; enough that their steps do not show as rings. */
const HALO_LAYERS = 16;

/**
 * Soft additive halo out to `radius`: stacked circles, denser toward the middle, adding up to
 * about 1.6 × `alpha` at the center.
 */
export function drawHalo(g: Graphics, radius: number, color: number, alpha: number): Graphics {
  for (let k = HALO_LAYERS; k >= 1; k--) {
    const r = radius * Math.pow(k / HALO_LAYERS, 1.4);
    g.circle(0, 0, r).fill({ color, alpha: (alpha * 1.6) / HALO_LAYERS });
  }
  g.blendMode = 'add';
  return g;
}

/**
 * The red hit flash every construct keeps: tints the construct body toward the M1 hit red and
 * swells it a little, fading out over HIT_FLASH_MS.
 */
export class HitFlash {
  private ms = 0;

  trigger(): void {
    this.ms = HIT_FLASH_MS;
  }

  reset(): void {
    this.ms = 0;
  }

  /** Ages the flash and applies it to `body`. */
  apply(body: Container, dtMs: number): void {
    this.ms = Math.max(0, this.ms - dtMs);
    const t = this.ms / HIT_FLASH_MS;
    body.tint = mixColor(0xffffff, COLORS.playerHit, t);
    body.scale.set(1 + HIT_SWELL * t);
  }
}
