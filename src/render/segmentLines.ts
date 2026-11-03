/**
 * Segment lines (V1; the C5.8 verifier's finding that no renderer read SimState.segments, and
 * the lead's ruling (b)): the links of every segment emitter's last judgement, 雷網's between
 * shocked enemies and 雷射柵欄's or 雷網蜂's between the drone pool's rows, drawn each frame as
 * program-drawn lines in one Graphics. Each end of link i is drawn where its endpoint is drawn,
 * its position between its last two ticks at the frame's alpha, while that endpoint is still in
 * its pool, looked up by its id (SegmentLinesState.id1, id2) with a binary search, since both
 * pools hold their rows in id order; once it has gone the end stays at the link's stored
 * coordinate, where the endpoint stood at the judgement. A link whose two endpoints have gone is
 * not drawn, and nothing past an emitter's count is. Shocked links take the chain lightning's
 * cyan, links between drones or summons a cooler blue (COLORS.droneLink); both draw at normal
 * blending and modest alpha, so a dense 雷網 stays readable rather than adding up to white, with a
 * slow pulse of the alpha on the layer's own frame-time clock (no randomness). Links between the
 * drone pool's rows are drawn only on a layer made with `pools` (SegmentLineOptions): the
 * renderer sets it when it draws the drones (its DroneLayer, today the hive construct), so a
 * renderer that does not draw them draws no lines between them. The renderer makes the layer
 * once a state with a segment emitter reaches it, under the enemies (src/render/renderer.ts),
 * and destroys it with itself. Reads the simulation state and never writes it. The id lookups
 * allocate nothing per frame; Pixi rebuilds the Graphics' paths each frame.
 */

import { Graphics } from 'pixi.js';
import type { DroneViewState, EnemyState, SegmentLinesState, SimState } from '../sim';
import { COLORS, mixColor } from './palette';

/** What the segment lines read from the simulation state. */
export type LinkFrame = Pick<SimState, 'enemies' | 'drones' | 'droneCount' | 'segments'>;

/**
 * The index of enemy `id` in `enemies`, or −1 when it is not there or no longer alive. SimState's
 * enemies are in id order: a spawn appends the next id and compaction keeps the order
 * (src/sim/systems/death.ts), so a binary search finds it.
 */
export function enemyIndexOf(enemies: readonly EnemyState[], id: number): number {
  let lo = 0;
  let hi = enemies.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const enemy = enemies[mid] as EnemyState;
    const at = enemy.id;
    if (at === id) return enemy.alive ? mid : -1;
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * The slot of row `id` among the drone pool's first `count` slots, or −1 once it has left: the
 * slots are in id order (DroneViewState.id), as the sim's own slotOf reads them.
 */
export function droneSlotOf(drones: DroneViewState, count: number, id: number): number {
  const ids = drones.id;
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = ids[mid] as number;
    if (at === id) return mid;
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Writes where link i of `ln` (i < ln.count) is drawn into out[0 .. 4) as x1, y1, x2, y2, and
 * returns how many of its two endpoints are still in their pool: each such end at its endpoint's
 * position between its last two ticks by `alpha` (prev + (now − prev) × alpha, as the enemy and
 * drone layers draw them), each other end at the link's stored coordinate. 0: both have gone,
 * and the link is not drawn (out is then the stored coordinates).
 */
export function resolveLink(
  frame: Readonly<LinkFrame>,
  ln: SegmentLinesState,
  i: number,
  alpha: number,
  out: Float64Array,
): number {
  out[0] = ln.x1[i] as number;
  out[1] = ln.y1[i] as number;
  out[2] = ln.x2[i] as number;
  out[3] = ln.y2[i] as number;
  const a = ln.id1[i] as number;
  const b = ln.id2[i] as number;
  let live = 0;
  if (ln.pool === 'enemies') {
    const enemies = frame.enemies;
    const ia = enemyIndexOf(enemies, a);
    if (ia >= 0) {
      const e = enemies[ia] as EnemyState;
      out[0] = e.prevX + (e.x - e.prevX) * alpha;
      out[1] = e.prevY + (e.y - e.prevY) * alpha;
      live++;
    }
    const ib = enemyIndexOf(enemies, b);
    if (ib >= 0) {
      const e = enemies[ib] as EnemyState;
      out[2] = e.prevX + (e.x - e.prevX) * alpha;
      out[3] = e.prevY + (e.y - e.prevY) * alpha;
      live++;
    }
    return live;
  }
  const ds = frame.drones;
  const n = frame.droneCount;
  const sa = droneSlotOf(ds, n, a);
  if (sa >= 0) {
    const px = ds.prevX[sa] as number;
    const py = ds.prevY[sa] as number;
    out[0] = px + ((ds.x[sa] as number) - px) * alpha;
    out[1] = py + ((ds.y[sa] as number) - py) * alpha;
    live++;
  }
  const sb = droneSlotOf(ds, n, b);
  if (sb >= 0) {
    const px = ds.prevX[sb] as number;
    const py = ds.prevY[sb] as number;
    out[2] = px + ((ds.x[sb] as number) - px) * alpha;
    out[3] = py + ((ds.y[sb] as number) - py) * alpha;
    live++;
  }
  return live;
}

/** A link style: a wide faint glow under a thin bright core, both with flat (butt) ends. */
interface LinkStyle {
  readonly glow: number;
  readonly glowWidth: number;
  readonly glowAlpha: number;
  readonly core: number;
  readonly coreWidth: number;
  readonly coreAlpha: number;
  /** The alpha's pulse: its period in ms; the alpha swings by PULSE_DEPTH of itself. */
  readonly pulseMs: number;
}

/**
 * Shocked links: 雷網's, a glow in the chain lightning's cyan (COLORS.chain, arcs.ts) under a
 * core in the damage numbers' chain colour (COLORS.damageChain).
 */
export const SHOCK_STYLE: LinkStyle = {
  glow: COLORS.chain,
  glowWidth: 9,
  glowAlpha: 0.16,
  core: COLORS.damageChain,
  coreWidth: 2,
  coreAlpha: 0.7,
  // A fast hum, apart from the pool links' slower breath.
  pulseMs: 260,
};

/** Links between drones or summons: a cooler blue, its core mixed halfway to white. */
export const POOL_STYLE: LinkStyle = {
  glow: COLORS.droneLink,
  glowWidth: 8,
  glowAlpha: 0.14,
  core: mixColor(COLORS.droneLink, 0xffffff, 0.5),
  coreWidth: 1.8,
  coreAlpha: 0.65,
  pulseMs: 900,
};

/** How far a style's alpha swings with its pulse, as a share of it: a shimmer, not a blink. */
const PULSE_DEPTH = 0.15;
/** Links the scratch holds at first, per style; it doubles past them. */
const FIRST_LINKS = 64;

/** How a SegmentLineLayer is made. */
export interface SegmentLineOptions {
  /**
   * Whether it draws the links between the drone pool's rows ('drones' and 'summons' emitters).
   * Off, it skips those emitters whole and draws only the shocked links. The renderer sets it
   * when it draws the drones, so no line floats between drones that are not drawn.
   */
  readonly pools: boolean;
}

export class SegmentLineLayer {
  readonly view = new Graphics({ label: 'segment-lines' });
  /** Links the last update drew: shocked ones, and ones between the drone pool's rows. */
  drawnShocked = 0;
  drawnPool = 0;
  /** The drawn ends of this frame's links, 4 numbers a link, per style; grown, never shrunk. */
  private shocked: Float64Array = new Float64Array(4 * FIRST_LINKS);
  private pooled: Float64Array = new Float64Array(4 * FIRST_LINKS);
  private readonly ends = new Float64Array(4);
  /** Frame time since the last clear, which the pulses read. */
  private clockMs = 0;
  /** SegmentLineOptions.pools. */
  private readonly pools: boolean;

  constructor(options: SegmentLineOptions = { pools: true }) {
    this.pools = options.pools;
  }

  /**
   * Draws every segment emitter's links of `frame` for i < count, each end on its endpoint
   * interpolated by `alpha` while it lives, else at the stored coordinate; `dtMs` on the pulse.
   * Without `pools`, the emitters whose links join the drone pool's rows are skipped.
   */
  update(frame: Readonly<LinkFrame>, alpha: number, dtMs: number): void {
    this.clockMs += dtMs;
    const g = this.view;
    g.clear();
    const lines = frame.segments.lines;
    const ends = this.ends;
    let shocked = 0;
    let pooled = 0;
    for (let e = 0; e < lines.length; e++) {
      const ln = lines[e] as SegmentLinesState;
      const pool = ln.pool === 'drones';
      if (pool && !this.pools) continue;
      for (let i = 0; i < ln.count; i++) {
        if (resolveLink(frame, ln, i, alpha, ends) === 0) continue;
        let out: Float64Array;
        let at: number;
        if (pool) {
          if (this.pooled.length < 4 * (pooled + 1)) this.pooled = grown(this.pooled);
          out = this.pooled;
          at = 4 * pooled++;
        } else {
          if (this.shocked.length < 4 * (shocked + 1)) this.shocked = grown(this.shocked);
          out = this.shocked;
          at = 4 * shocked++;
        }
        out[at] = ends[0] as number;
        out[at + 1] = ends[1] as number;
        out[at + 2] = ends[2] as number;
        out[at + 3] = ends[3] as number;
      }
    }
    this.drawnShocked = shocked;
    this.drawnPool = pooled;
    if (shocked > 0) this.stroke(this.shocked, shocked, SHOCK_STYLE);
    if (pooled > 0) this.stroke(this.pooled, pooled, POOL_STYLE);
  }

  /** Forgets the last frame's lines and puts the pulse clock back at zero, as at a run's start. */
  clear(): void {
    this.view.clear();
    this.drawnShocked = 0;
    this.drawnPool = 0;
    this.clockMs = 0;
  }

  /** Destroys the layer's Graphics, taking it out of its parent. */
  destroy(): void {
    this.view.destroy();
  }

  /**
   * The first `n` links of `ends` in `style`: its glow, then its core over it. Flat (butt) ends,
   * the lead's ruling L1: round caps cost about +5.6 ms a frame at ~208 links and +10.7 ms at
   * ~413 in headless Chromium (Pixi's tessellation, not rasterisation), flat ones about +0.5 and
   * +0.7 ms. The ends sit at the enemies' and drones' centres, under their shapes, so flat ends
   * read the same.
   */
  private stroke(ends: Float64Array, n: number, style: LinkStyle): void {
    const g = this.view;
    const pulse =
      1 - PULSE_DEPTH * (0.5 + 0.5 * Math.sin((2 * Math.PI * this.clockMs) / style.pulseMs));
    path(g, ends, n);
    g.stroke({
      width: style.glowWidth,
      color: style.glow,
      alpha: style.glowAlpha * pulse,
      cap: 'butt',
    });
    path(g, ends, n);
    g.stroke({
      width: style.coreWidth,
      color: style.core,
      alpha: style.coreAlpha * pulse,
      cap: 'butt',
    });
  }
}

/** One sub-path per link of the first `n` in `ends`. */
function path(g: Graphics, ends: Float64Array, n: number): void {
  for (let k = 0; k < n; k++) {
    const at = 4 * k;
    g.moveTo(ends[at] as number, ends[at + 1] as number).lineTo(
      ends[at + 2] as number,
      ends[at + 3] as number,
    );
  }
}

/** `ends` copied into an array twice its length. */
function grown(ends: Float64Array): Float64Array {
  const next = new Float64Array(2 * ends.length);
  next.set(ends);
  return next;
}
