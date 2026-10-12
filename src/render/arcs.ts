/** Chain lightning: jagged cyan lines between chain hits, fading out quickly. */

import { Graphics } from 'pixi.js';
import { COLORS } from './palette';

const ARC_MS = 150;
const MAX_ARCS = 64;
const SEGMENTS = 6;
/** Sideways jitter of the bolt, as a fraction of its length (capped in units). */
const JITTER = 0.12;
const MAX_JITTER = 26;

interface Arc {
  /** Polyline x0, y0, x1, y1, …; fixed when the arc is created. */
  readonly points: number[];
  ageMs: number;
}

export class ArcLayer {
  readonly view = new Graphics({ label: 'chain-arcs' });
  private readonly arcs: Arc[] = [];
  private readonly pool: Arc[] = [];

  constructor() {
    this.view.blendMode = 'add';
  }

  add(fromX: number, fromY: number, toX: number, toY: number): void {
    let arc: Arc;
    if (this.arcs.length >= MAX_ARCS) arc = this.arcs.shift() as Arc;
    else arc = this.pool.pop() ?? { points: [], ageMs: 0 };
    arc.ageMs = 0;
    const points = arc.points;
    points.length = 0;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const jitter = Math.min(MAX_JITTER, len * JITTER);
    points.push(fromX, fromY);
    for (let s = 1; s < SEGMENTS; s++) {
      const t = s / SEGMENTS;
      const offset = (Math.random() * 2 - 1) * jitter;
      points.push(fromX + dx * t + nx * offset, fromY + dy * t + ny * offset);
    }
    points.push(toX, toY);
    this.arcs.push(arc);
  }

  clear(): void {
    for (const arc of this.arcs) this.pool.push(arc);
    this.arcs.length = 0;
    this.view.clear();
  }

  update(dtMs: number): void {
    const g = this.view;
    g.clear();
    let kept = 0;
    for (let i = 0; i < this.arcs.length; i++) {
      const arc = this.arcs[i] as Arc;
      arc.ageMs += dtMs;
      if (arc.ageMs >= ARC_MS) {
        this.pool.push(arc);
        continue;
      }
      this.arcs[kept++] = arc;
      const fade = 1 - arc.ageMs / ARC_MS;
      g.poly(arc.points, false).stroke({ width: 9, color: COLORS.chain, alpha: 0.18 * fade });
      g.poly(arc.points, false).stroke({ width: 3, color: COLORS.chain, alpha: fade });
      g.poly(arc.points, false).stroke({ width: 1.2, color: 0xffffff, alpha: fade });
    }
    this.arcs.length = kept;
  }
}
