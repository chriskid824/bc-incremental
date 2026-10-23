/**
 * Chain lightning: jagged bolts between chain hits, redrawn into one additive Graphics each
 * frame. A bolt re-rolls its zigzag every few frames while it lives, so it flickers like an
 * electric arc; it is a wide cyan glow with a white-hot core, thinner on later jumps. Pooled
 * and capped; when full, the oldest bolt is replaced.
 */

import { Graphics } from 'pixi.js';
import { COLORS } from './palette';
import { defaultRandom } from './random';
import type { RenderRandom } from './random';
import { ageStep } from './timing';

const ARC_MS = 180;
/** The zigzag is re-rolled this often. */
const REJITTER_MS = 42;
const MAX_ARCS = 80;
/** Roughly one kink per this many arena units. */
const SEGMENT_LENGTH = 30;
const MIN_SEGMENTS = 4;
const MAX_SEGMENTS = 14;
/** Sideways jitter of a kink, as a fraction of the bolt length (capped in units). */
const JITTER = 0.16;
const MAX_JITTER = 34;
/** Width factor lost per jump after the first, down to MIN_WIDTH. */
const WIDTH_PER_JUMP = 0.14;
const MIN_WIDTH = 0.4;

interface Arc {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  width: number;
  ageMs: number;
  /** Time until the next re-roll. */
  rejitterMs: number;
  /** Per-roll brightness, for flicker. */
  flicker: number;
  /** Added since the last update (see src/render/timing.ts). */
  fresh: boolean;
  /** Polyline x0, y0, x1, y1, …, rebuilt in place on every re-roll. */
  readonly points: number[];
  /** A short side fork; empty when the bolt has none this roll. */
  readonly fork: number[];
}

export class ArcLayer {
  readonly view = new Graphics({ label: 'chain-arcs' });
  private readonly arcs: Arc[] = [];
  private readonly pool: Arc[] = [];

  constructor(private readonly random: RenderRandom = defaultRandom) {
    this.view.blendMode = 'add';
  }

  /** A bolt for the `chainIndex`-th jump (1 = first jump). */
  add(fromX: number, fromY: number, toX: number, toY: number, chainIndex: number): void {
    let arc: Arc;
    if (this.arcs.length >= MAX_ARCS) arc = this.arcs.shift() as Arc;
    else arc = this.pool.pop() ?? createArc();
    arc.fromX = fromX;
    arc.fromY = fromY;
    arc.toX = toX;
    arc.toY = toY;
    arc.width = Math.max(MIN_WIDTH, 1 - WIDTH_PER_JUMP * (chainIndex - 1));
    arc.ageMs = 0;
    arc.fresh = true;
    reroll(arc, this.random);
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
      const stepMs = ageStep(dtMs, arc.fresh);
      arc.fresh = false;
      arc.ageMs += stepMs;
      if (arc.ageMs >= ARC_MS) {
        this.pool.push(arc);
        continue;
      }
      this.arcs[kept++] = arc;
      arc.rejitterMs -= stepMs;
      if (arc.rejitterMs <= 0) reroll(arc, this.random);
      const t = arc.ageMs / ARC_MS;
      // Full strength for the first half, then a quick fade.
      const fade = (t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5) * arc.flicker;
      const w = arc.width;
      drawBolt(g, arc.points, w, fade);
      if (arc.fork.length > 0) drawBolt(g, arc.fork, w * 0.6, fade * 0.8);
    }
    this.arcs.length = kept;
  }
}

function createArc(): Arc {
  return {
    fromX: 0,
    fromY: 0,
    toX: 0,
    toY: 0,
    width: 1,
    ageMs: 0,
    rejitterMs: 0,
    flicker: 1,
    fresh: true,
    points: [],
    fork: [],
  };
}

function drawBolt(g: Graphics, points: number[], width: number, alpha: number): void {
  g.poly(points, false).stroke({ width: 30 * width, color: COLORS.chain, alpha: 0.14 * alpha });
  g.poly(points, false).stroke({ width: 14 * width, color: COLORS.chain, alpha: 0.28 * alpha });
  g.poly(points, false).stroke({ width: 7 * width, color: COLORS.chain, alpha: 0.9 * alpha });
  g.poly(points, false).stroke({ width: 3 * width, color: 0xffffff, alpha });
}

/** Rebuilds the zigzag (and maybe a fork) with fresh random kinks; the ends stay pinned. */
function reroll(arc: Arc, random: RenderRandom): void {
  arc.rejitterMs = REJITTER_MS;
  arc.flicker = 0.7 + 0.3 * random();
  const { fromX, fromY, toX, toY } = arc;
  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const jitter = Math.min(MAX_JITTER, len * JITTER);
  const segments = Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.round(len / SEGMENT_LENGTH)));
  const points = arc.points;
  points.length = 0;
  points.push(fromX, fromY);
  for (let s = 1; s < segments; s++) {
    const t = s / segments;
    // Kinks are largest mid-bolt.
    const envelope = Math.sin(Math.PI * t);
    const offset = (random() * 2 - 1) * jitter * (0.4 + 0.6 * envelope);
    points.push(fromX + dx * t + nx * offset, fromY + dy * t + ny * offset);
  }
  points.push(toX, toY);

  const fork = arc.fork;
  fork.length = 0;
  if (len < 60 || random() < 0.4) return;
  // Fork off one of the kinks, angled away from the bolt.
  const at = 1 + Math.floor(random() * (segments - 1));
  let x = points[at * 2] ?? fromX;
  let y = points[at * 2 + 1] ?? fromY;
  const side = random() < 0.5 ? -1 : 1;
  const angle = Math.atan2(dy, dx) + side * (0.5 + random() * 0.5);
  const step = len * (0.08 + random() * 0.06);
  fork.push(x, y);
  for (let k = 0; k < 3; k++) {
    const a = angle + (random() * 2 - 1) * 0.6;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    fork.push(x, y);
  }
}
