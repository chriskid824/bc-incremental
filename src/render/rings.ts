/**
 * Expanding rings, redrawn into one additive Graphics each frame: kill shockwaves (a bright
 * ring that thins as it grows), pandemic fire novas (a translucent disc with a hot edge) and
 * drone impacts (a hive-green ring over the splash, docs/v3 C5 design §13.2). Pooled and capped
 * per style: past the cap new shockwaves are dropped, once a few full novas burn at once further
 * ones draw only their rim, so a cascade of spreading burns reads as a ripple of fire rings
 * instead of flooding the screen orange, and a new impact replaces the oldest one.
 */

import { Graphics } from 'pixi.js';
import { COLORS, CONSTRUCT_COLORS } from './palette';
import { ageStep } from './timing';

const STYLE_SHOCK = 0;
const STYLE_NOVA = 1;
/** A nova drawn as its rim only. */
const STYLE_RIM = 2;
const STYLE_IMPACT = 3;

/** Live rings allowed per style. */
const CAPS = [40, 3, 10, 24];
const NOVA_MS = 520;
const IMPACT_MS = 300;

interface Ring {
  style: number;
  x: number;
  y: number;
  radius: number;
  color: number;
  width: number;
  ageMs: number;
  lifeMs: number;
  /** Added since the last update (see src/render/timing.ts). */
  fresh: boolean;
}

export class RingLayer {
  readonly view = new Graphics({ label: 'rings' });
  private readonly rings: Ring[] = [];
  private readonly pool: Ring[] = [];
  private readonly counts = [0, 0, 0, 0];

  constructor() {
    this.view.blendMode = 'add';
  }

  /**
   * A shockwave growing to `radius` over `lifeMs`. `force` replaces the oldest shockwave when
   * full (elites and bosses); otherwise it is dropped.
   */
  shock(
    x: number,
    y: number,
    radius: number,
    color: number,
    width: number,
    lifeMs: number,
    force = false,
  ): void {
    if (this.isFull(STYLE_SHOCK) && !(force && this.evictOldest(STYLE_SHOCK))) return;
    this.push(STYLE_SHOCK, x, y, radius, color, width, lifeMs);
  }

  /**
   * pandemic: a fire nova filling `radius`, the area the burn spreads over. Returns false when
   * enough full novas are burning that this one only draws its rim.
   */
  nova(x: number, y: number, radius: number): boolean {
    const full = !this.isFull(STYLE_NOVA);
    const style = full ? STYLE_NOVA : STYLE_RIM;
    if (this.isFull(style)) this.evictOldest(style);
    this.push(style, x, y, radius, COLORS.burn, 0, NOVA_MS);
    return full;
  }

  /**
   * A drone's impact over its splash `radius`. Impacts have a cap of their own, and a new one
   * past it replaces the oldest impact, so they never take a shockwave's or a nova's place.
   */
  impact(x: number, y: number, radius: number): void {
    if (this.isFull(STYLE_IMPACT)) this.evictOldest(STYLE_IMPACT);
    this.push(STYLE_IMPACT, x, y, radius, CONSTRUCT_COLORS.hive.main, 0, IMPACT_MS);
  }

  clear(): void {
    for (const ring of this.rings) this.pool.push(ring);
    this.rings.length = 0;
    this.counts.fill(0);
    this.view.clear();
  }

  update(dtMs: number): void {
    const g = this.view;
    g.clear();
    let kept = 0;
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i] as Ring;
      ring.ageMs += ageStep(dtMs, ring.fresh);
      ring.fresh = false;
      if (ring.ageMs >= ring.lifeMs) {
        this.release(ring);
        continue;
      }
      this.rings[kept++] = ring;
      const t = ring.ageMs / ring.lifeMs;
      if (ring.style === STYLE_SHOCK) drawShock(g, ring, t);
      else if (ring.style === STYLE_IMPACT) drawImpact(g, ring, t);
      else drawNova(g, ring, t, ring.style === STYLE_NOVA);
    }
    this.rings.length = kept;
  }

  private push(
    style: number,
    x: number,
    y: number,
    radius: number,
    color: number,
    width: number,
    lifeMs: number,
  ): void {
    const ring = this.pool.pop() ?? {
      style,
      x,
      y,
      radius,
      color,
      width,
      ageMs: 0,
      lifeMs,
      fresh: true,
    };
    ring.style = style;
    ring.x = x;
    ring.y = y;
    ring.radius = radius;
    ring.color = color;
    ring.width = width;
    ring.ageMs = 0;
    ring.lifeMs = lifeMs;
    ring.fresh = true;
    this.rings.push(ring);
    this.counts[style] = (this.counts[style] ?? 0) + 1;
  }

  private isFull(style: number): boolean {
    return (this.counts[style] ?? 0) >= (CAPS[style] ?? 0);
  }

  /** Ages out the oldest ring of a style; false if there is none. */
  private evictOldest(style: number): boolean {
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i] as Ring;
      if (ring.style === style) {
        ring.ageMs = ring.lifeMs;
        this.counts[style] = (this.counts[style] ?? 1) - 1;
        // Uncounted already: the sweep only pools it.
        ring.style = -1;
        return true;
      }
    }
    return false;
  }

  private release(ring: Ring): void {
    if (ring.style >= 0) this.counts[ring.style] = (this.counts[ring.style] ?? 1) - 1;
    this.pool.push(ring);
  }
}

/** Fast out, slow settle. */
function easeOut(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

function drawShock(g: Graphics, ring: Ring, t: number): void {
  const r = ring.radius * easeOut(t);
  const fade = (1 - t) * (1 - t);
  g.circle(ring.x, ring.y, r).stroke({
    width: ring.width * (1 - t) + 1,
    color: ring.color,
    alpha: 0.85 * fade,
  });
}

function drawNova(g: Graphics, ring: Ring, t: number, full: boolean): void {
  // Races out to the spread radius in the first ~40% of its life, then burns off in place.
  const grow = Math.min(1, t / 0.4);
  const r = ring.radius * easeOut(grow);
  const fade = 1 - t;
  if (full) {
    const band = Math.min(r, 40);
    g.circle(ring.x, ring.y, r).fill({ color: COLORS.burnDeep, alpha: 0.18 * fade });
    // A wall of fire just inside the edge, then the hot rim.
    g.circle(ring.x, ring.y, r - band / 2).stroke({
      width: band,
      color: COLORS.burn,
      alpha: 0.32 * fade,
    });
  }
  g.circle(ring.x, ring.y, r).stroke({
    width: 5 + 10 * (1 - grow),
    color: COLORS.burnHot,
    alpha: (full ? 1 : 0.7) * fade,
  });
  g.circle(ring.x, ring.y, r).stroke({ width: 2.5, color: 0xffffff, alpha: 0.55 * fade * fade });
}

function drawImpact(g: Graphics, ring: Ring, t: number): void {
  // Snaps out to the splash radius in the first third of its life, then fades in place.
  const grow = Math.min(1, t / 0.35);
  const r = ring.radius * easeOut(grow);
  const fade = 1 - t;
  g.circle(ring.x, ring.y, r).fill({ color: ring.color, alpha: 0.12 * fade });
  g.circle(ring.x, ring.y, r).stroke({
    width: 1.5 + 3 * (1 - grow),
    color: ring.color,
    alpha: 0.9 * fade,
  });
}
