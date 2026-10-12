/**
 * Projectiles as bright bolts: a streak trailing behind a glowing head. Drawn as pooled
 * additive particles on the effect sprite sheet, three per projectile, rebuilt each frame.
 */

import { Particle, ParticleContainer } from 'pixi.js';
import type { ProjectileState } from '../sim';
import { packColor } from './fx';
import type { FxTextures } from './fxTextures';
import { COLORS } from './palette';

const TRAIL_LENGTH = 78;
const TRAIL_WIDTH = 13;
const HEAD_RADIUS = 6.5;
/** steadyAim shots are bigger and longer. */
const STEADY_SCALE = 1.6;
/** Texture sizes in pixels (src/render/fxTextures.ts). */
const GLOW_SIZE = 64;
const STREAK_LENGTH = 64;
const STREAK_HEIGHT = 16;

export class ProjectileLayer {
  readonly view: ParticleContainer;
  private readonly sprites: Particle[] = [];

  constructor(private readonly textures: FxTextures) {
    this.view = new ParticleContainer({
      label: 'projectiles',
      texture: textures.glow,
      dynamicProperties: { position: true, rotation: true, color: true, vertex: true },
    });
    this.view.blendMode = 'add';
  }

  update(projectiles: readonly ProjectileState[], alpha: number): void {
    const children = this.view.particleChildren;
    const previous = children.length;
    let n = 0;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i] as ProjectileState;
      if (!p.alive) continue;
      const dx = p.x - p.prevX;
      const dy = p.y - p.prevY;
      const x = p.prevX + dx * alpha;
      const y = p.prevY + dy * alpha;
      // steadyAim shots are guaranteed crits: bigger and in the crit color.
      const k = p.steady ? STEADY_SCALE : 1;
      const color = p.steady ? COLORS.crit : COLORS.projectileTrail;
      const core = p.steady ? COLORS.critHot : COLORS.projectile;

      if (dx !== 0 || dy !== 0) {
        const trail = this.sprite(n++, this.textures.streak, 1);
        trail.x = x;
        trail.y = y;
        trail.rotation = Math.atan2(dy, dx);
        trail.scaleX = (TRAIL_LENGTH * k) / STREAK_LENGTH;
        trail.scaleY = (TRAIL_WIDTH * k) / STREAK_HEIGHT;
        trail.color = packColor(color, 0.8);
      }
      const halo = this.sprite(n++, this.textures.glow, 0.5);
      halo.x = x;
      halo.y = y;
      halo.scaleX = halo.scaleY = (HEAD_RADIUS * 5 * k) / GLOW_SIZE;
      halo.color = packColor(color, 0.55);
      const head = this.sprite(n++, this.textures.glow, 0.5);
      head.x = x;
      head.y = y;
      head.scaleX = head.scaleY = (HEAD_RADIUS * 2.4 * k) / GLOW_SIZE;
      head.color = packColor(core, 1);
    }
    children.length = n;
    if (n !== previous) this.view.update();
  }

  /** The nth particle this frame, set to `texture` anchored at (anchorX, 0.5). */
  private sprite(n: number, texture: FxTextures['glow'], anchorX: number): Particle {
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
