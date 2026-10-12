/** Expanding shock rings, e.g. pandemic spreading a burn from a dying enemy. */

import { Graphics } from 'pixi.js';

const RING_MS = 380;
const MAX_RINGS = 48;

interface Ring {
  x: number;
  y: number;
  radius: number;
  color: number;
  ageMs: number;
}

export class RingLayer {
  readonly view = new Graphics({ label: 'rings' });
  private readonly rings: Ring[] = [];

  constructor() {
    this.view.blendMode = 'add';
  }

  add(x: number, y: number, radius: number, color: number): void {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({ x, y, radius, color, ageMs: 0 });
  }

  clear(): void {
    this.rings.length = 0;
    this.view.clear();
  }

  update(dtMs: number): void {
    const g = this.view;
    g.clear();
    let kept = 0;
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i] as Ring;
      ring.ageMs += dtMs;
      if (ring.ageMs >= RING_MS) continue;
      this.rings[kept++] = ring;
      const t = ring.ageMs / RING_MS;
      // Ease out: fast at first, settling at the full radius.
      const r = ring.radius * (1 - (1 - t) * (1 - t));
      const fade = 1 - t;
      g.circle(ring.x, ring.y, r).fill({ color: ring.color, alpha: 0.08 * fade });
      g.circle(ring.x, ring.y, r).stroke({ width: 6, color: ring.color, alpha: 0.7 * fade });
    }
    this.rings.length = kept;
  }
}
