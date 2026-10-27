/**
 * The shooters' bullets (docs/v3 C7 design §2.9; gd A.5 「射出的子彈在畫面上留下彈道」): hostile red
 * bolts, a streak trailing along each one's flight, aimed by its last tick's position
 * (BulletViewState's prevX, prevY), and a glowing head the sim's BULLET_RADIUS across, drawn between
 * its last two ticks' positions as additive particles on the effect sprite sheet, three per bullet,
 * rebuilt each frame. The sim fires and steps a bullet in one tick (fireBullet, then stepBullets),
 * so on the frame after its fire tick its prev is the muzzle: the layer keeps, by id, where it
 * first saw each bullet, draws no streak on that first frame, and never lets a streak reach behind
 * that point, so none pokes back out through the shooter. It takes the arrays from SimState.bullets
 * every frame, since the pool replaces them as it grows, and never writes them. An M1 run has no
 * bullet: the renderer makes the layer for v3 data only.
 */

import { Particle, ParticleContainer } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { BulletViewState } from '../sim';
import { BULLET_RADIUS } from '../sim/systems/bullets';
import { packColor } from './fx';
import { COLORS } from './palette';

/** The trail behind a bullet: shorter and thinner than a projectile's, a slow shot's wake. */
export const BULLET_TRAIL_LENGTH = 44;
const BULLET_TRAIL_WIDTH = 9;
const BULLET_TRAIL_ALPHA = 0.75;
/** The head: a halo and a near-white core, as multiples of the bullet's radius. */
const BULLET_HALO = 4;
const BULLET_HALO_ALPHA = 0.5;
const BULLET_CORE = 2.2;
/** Texture sizes in pixels (src/render/fxTextures.ts). */
const GLOW_SIZE = 64;
const STREAK_LENGTH = 64;
const STREAK_HEIGHT = 16;

/** Where the layer first saw a bullet: its prev on that frame, the muzzle after its fire tick. */
interface Origin {
  readonly x: number;
  readonly y: number;
}

export class BulletLayer {
  readonly view: ParticleContainer;
  private readonly sprites: Particle[] = [];
  /** Each bullet drawn last frame, by id, and where it was first seen; swapped with `drawing`. */
  private origins = new Map<number, Origin>();
  private drawing = new Map<number, Origin>();

  constructor(private readonly textures: { readonly glow: Texture; readonly streak: Texture }) {
    this.view = new ParticleContainer({
      label: 'bullets',
      texture: textures.glow,
      dynamicProperties: { position: true, rotation: true, color: true, vertex: true },
    });
    this.view.blendMode = 'add';
  }

  /** Draws the first `count` bullets of `bullets`, interpolated by `alpha`. */
  update(bullets: BulletViewState, count: number, alpha: number): void {
    const children = this.view.particleChildren;
    const previous = children.length;
    const drawing = this.drawing;
    drawing.clear();
    let n = 0;
    for (let b = 0; b < count; b++) {
      const id = bullets.id[b] ?? 0;
      const prevX = bullets.prevX[b] ?? 0;
      const prevY = bullets.prevY[b] ?? 0;
      const dx = (bullets.x[b] ?? 0) - prevX;
      const dy = (bullets.y[b] ?? 0) - prevY;
      const x = prevX + dx * alpha;
      const y = prevY + dy * alpha;
      const origin = this.origins.get(id);
      if (origin === undefined) {
        // Its first frame: the head only.
        drawing.set(id, { x: prevX, y: prevY });
      } else {
        drawing.set(id, origin);
        const length = Math.min(BULLET_TRAIL_LENGTH, Math.hypot(x - origin.x, y - origin.y));
        if ((dx !== 0 || dy !== 0) && length > 0) {
          const trail = this.sprite(n++, this.textures.streak, 1);
          trail.x = x;
          trail.y = y;
          trail.rotation = Math.atan2(dy, dx);
          trail.scaleX = length / STREAK_LENGTH;
          trail.scaleY = BULLET_TRAIL_WIDTH / STREAK_HEIGHT;
          trail.color = packColor(COLORS.bullet, BULLET_TRAIL_ALPHA);
        }
      }
      const halo = this.sprite(n++, this.textures.glow, 0.5);
      halo.x = x;
      halo.y = y;
      halo.scaleX = halo.scaleY = (BULLET_RADIUS * BULLET_HALO) / GLOW_SIZE;
      halo.color = packColor(COLORS.bullet, BULLET_HALO_ALPHA);
      const head = this.sprite(n++, this.textures.glow, 0.5);
      head.x = x;
      head.y = y;
      head.scaleX = head.scaleY = (BULLET_RADIUS * BULLET_CORE) / GLOW_SIZE;
      head.color = packColor(COLORS.bulletCore, 1);
    }
    children.length = n;
    if (n !== previous) this.view.update();
    this.drawing = this.origins;
    this.origins = drawing;
  }

  /** Drops every particle and every bullet seen: a new run starts with no bullet. */
  clear(): void {
    this.view.particleChildren.length = 0;
    this.view.update();
    this.origins.clear();
    this.drawing.clear();
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
