/**
 * The shot pool's homing shots (docs/v3 C5 design D25, §13.2): the turrets' shots, and an
 * effect's, as small hive-green bolts, a streak behind a glowing head, drawn between their last
 * two ticks' positions as additive particles on the effect sprite sheet, three per shot (no
 * streak for a shot new since the last tick), rebuilt each frame. The pool keeps no previous
 * position, so the layer keeps its own by shot id (ShotTrails), in arrays allocated once for
 * PROJECTILE_CAP shots. Reads the simulation state and never writes it (IS22).
 */

import { Particle, ParticleContainer } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { ShotPoolState } from '../sim';
import { packColor } from './fx';
import { CONSTRUCT_COLORS } from './palette';

const C = CONSTRUCT_COLORS.hive;

/** ShotPoolState.motion of a homing shot (MOTION_HOMING, src/sim/systems/shots.ts). */
export const HOMING = 1;
/** Shots the pool holds at most (PROJECTILE_CAP, src/sim/caps.ts). */
export const SHOT_SLOTS = 512;

const TRAIL_LENGTH = 34;
const TRAIL_WIDTH = 7;
const HEAD_RADIUS = 3.5;
/** Texture sizes in pixels (src/render/fxTextures.ts). */
const GLOW_SIZE = 64;
const STREAK_LENGTH = 64;
const STREAK_HEIGHT = 16;

/** The effect sheet's glow and spark streak (FxTextures, src/render/fxTextures.ts). */
export interface ShotTextures {
  readonly glow: Texture;
  readonly streak: Texture;
}

/**
 * The homing shots of the last sim tick seen, by slot of that tick (in id order, as the pool
 * holds them), with each one's position a tick before: the position the last tick before held
 * for it, or for a frame that skipped ticks (2× and 4× run several a frame), the point along the
 * line from the last position seen, one tick back; a shot new since then is drawn where it is.
 * It samples when the sim tick advances, not per frame, and allocates nothing after
 * construction. No Pixi, so the tests reach it.
 */
export class ShotTrails {
  private ids = new Int32Array(SHOT_SLOTS);
  private xs = new Float64Array(SHOT_SLOTS);
  private ys = new Float64Array(SHOT_SLOTS);
  /** The other buffers: the sample before, swapped in at each new tick. */
  private lastIds = new Int32Array(SHOT_SLOTS);
  private lastXs = new Float64Array(SHOT_SLOTS);
  private lastYs = new Float64Array(SHOT_SLOTS);
  private readonly prevXs = new Float64Array(SHOT_SLOTS);
  private readonly prevYs = new Float64Array(SHOT_SLOTS);
  private n = 0;
  /** Sim tick of the sample; −1 while empty. */
  private tick = -1;

  /** Homing shots in the sample. */
  get size(): number {
    return this.n;
  }

  /** The id of the kth homing shot of the sample, for k < size. */
  id(k: number): number {
    return this.ids[k] as number;
  }

  /** Its position at the sampled tick. */
  x(k: number): number {
    return this.xs[k] as number;
  }

  y(k: number): number {
    return this.ys[k] as number;
  }

  /** Its position a tick before. */
  prevX(k: number): number {
    return this.prevXs[k] as number;
  }

  prevY(k: number): number {
    return this.prevYs[k] as number;
  }

  /**
   * Records the homing shots of the first `count` slots of `shots` as of sim tick `tick`; a tick
   * already recorded adds nothing, and a tick back in time starts over.
   */
  sample(shots: Readonly<ShotPoolState>, count: number, tick: number): void {
    if (tick === this.tick) return;
    const steps = this.tick >= 0 && tick > this.tick ? tick - this.tick : 0;
    // The current sample becomes the last; both stay allocated.
    const lastIds = this.ids;
    const lastXs = this.xs;
    const lastYs = this.ys;
    const lastN = this.n;
    this.ids = this.lastIds;
    this.xs = this.lastXs;
    this.ys = this.lastYs;
    this.lastIds = lastIds;
    this.lastXs = lastXs;
    this.lastYs = lastYs;
    let j = 0;
    let n = 0;
    for (let s = 0; s < count && n < SHOT_SLOTS; s++) {
      if (shots.motion[s] !== HOMING) continue;
      const id = shots.id[s] as number;
      const x = shots.x[s] as number;
      const y = shots.y[s] as number;
      // Both samples are in id order: one walk finds each shot's last position.
      while (j < lastN && (lastIds[j] as number) < id) j++;
      if (steps > 0 && j < lastN && lastIds[j] === id) {
        this.prevXs[n] = x + ((lastXs[j] as number) - x) / steps;
        this.prevYs[n] = y + ((lastYs[j] as number) - y) / steps;
      } else {
        this.prevXs[n] = x;
        this.prevYs[n] = y;
      }
      this.ids[n] = id;
      this.xs[n] = x;
      this.ys[n] = y;
      n++;
    }
    this.n = n;
    this.tick = tick;
  }

  /** Forgets every shot, as at the start of a run. */
  clear(): void {
    this.n = 0;
    this.tick = -1;
  }
}

export class PoolShotLayer {
  readonly view: ParticleContainer;
  private readonly sprites: Particle[] = [];
  private readonly trails = new ShotTrails();

  constructor(private readonly textures: ShotTextures) {
    this.view = new ParticleContainer({
      label: 'pool-shots',
      texture: textures.glow,
      dynamicProperties: { position: true, rotation: true, color: true, vertex: true },
    });
    this.view.blendMode = 'add';
  }

  /** Forgets every shot, as at the start of a run. */
  reset(): void {
    this.trails.clear();
    this.view.particleChildren.length = 0;
    this.view.update();
  }

  /**
   * Draws the homing shots of the first `count` slots of `shots` at sim tick `tick`, each
   * interpolated by `alpha` between its last two ticks' positions.
   */
  update(shots: Readonly<ShotPoolState>, count: number, tick: number, alpha: number): void {
    const trails = this.trails;
    trails.sample(shots, count, tick);
    const children = this.view.particleChildren;
    const previous = children.length;
    let n = 0;
    for (let k = 0; k < trails.size; k++) {
      const px = trails.prevX(k);
      const py = trails.prevY(k);
      const dx = trails.x(k) - px;
      const dy = trails.y(k) - py;
      const x = px + dx * alpha;
      const y = py + dy * alpha;
      if (dx !== 0 || dy !== 0) {
        const trail = this.sprite(n++, this.textures.streak, 1);
        trail.x = x;
        trail.y = y;
        trail.rotation = Math.atan2(dy, dx);
        trail.scaleX = TRAIL_LENGTH / STREAK_LENGTH;
        trail.scaleY = TRAIL_WIDTH / STREAK_HEIGHT;
        trail.color = packColor(C.main, 0.75);
      }
      const halo = this.sprite(n++, this.textures.glow, 0.5);
      halo.x = x;
      halo.y = y;
      halo.scaleX = halo.scaleY = (HEAD_RADIUS * 5) / GLOW_SIZE;
      halo.color = packColor(C.main, 0.55);
      const head = this.sprite(n++, this.textures.glow, 0.5);
      head.x = x;
      head.y = y;
      head.scaleX = head.scaleY = (HEAD_RADIUS * 2.4) / GLOW_SIZE;
      head.color = packColor(C.cellCenter, 1);
    }
    children.length = n;
    if (n !== previous) this.view.update();
  }

  /** The nth particle this frame, set to `texture` anchored at (anchorX, 0.5). */
  private sprite(n: number, texture: Texture, anchorX: number): Particle {
    let sprite = this.sprites[n];
    if (sprite === undefined) {
      sprite = new Particle({ texture, anchorX, anchorY: 0.5 });
      this.sprites.push(sprite);
    }
    if (sprite.texture !== texture) {
      sprite.texture = texture;
      // UVs are static: a texture change needs a full upload.
      this.view.update();
    }
    sprite.anchorX = anchorX;
    this.view.particleChildren[n] = sprite;
    return sprite;
  }
}
