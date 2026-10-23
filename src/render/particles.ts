/**
 * Kill shards: a burst of small particles in the enemy's color that scatter, then get pulled
 * into the player like collected loot. Pooled in a ParticleContainer with a hard cap.
 */

import { Graphics, Particle, ParticleContainer } from 'pixi.js';
import type { Renderer, Texture } from 'pixi.js';
import { defaultRandom } from './random';
import type { RenderRandom } from './random';

const MAX_PARTICLES = 600;
const LIFE_MS = 1400;
/** Scatter phase before the pull toward the player starts. */
const SCATTER_MS = 160;
const PULL = 5200;
const DRAG = 3.5;

interface Shard {
  readonly sprite: Particle;
  vx: number;
  vy: number;
  spin: number;
  ageMs: number;
}

export class ShardParticles {
  readonly view: ParticleContainer;
  private readonly live: Shard[] = [];
  private readonly pool: Shard[] = [];
  private readonly texture: Texture;

  constructor(
    renderer: Renderer,
    private readonly random: RenderRandom = defaultRandom,
  ) {
    const shape = new Graphics().poly([0, -6, 3.5, 0, 0, 6, -3.5, 0]).fill(0xffffff);
    this.texture = renderer.generateTexture({ target: shape, resolution: 2, antialias: true });
    shape.destroy();
    this.view = new ParticleContainer({
      label: 'kill-shards',
      texture: this.texture,
      dynamicProperties: { position: true, rotation: true, color: true, vertex: true },
    });
    this.view.blendMode = 'add';
  }

  /** Spawns up to `count` shards at (x, y); skipped once the cap is reached. */
  burst(x: number, y: number, color: number, count: number, scale: number): void {
    for (let i = 0; i < count && this.live.length < MAX_PARTICLES; i++) {
      const shard = this.pool.pop() ?? this.createShard();
      const angle = this.random() * Math.PI * 2;
      const speed = 160 + this.random() * 280;
      shard.vx = Math.cos(angle) * speed;
      shard.vy = Math.sin(angle) * speed;
      shard.spin = (this.random() * 2 - 1) * 12;
      shard.ageMs = 0;
      const sprite = shard.sprite;
      sprite.x = x;
      sprite.y = y;
      sprite.rotation = angle;
      sprite.tint = color;
      sprite.alpha = 1;
      const s = scale * (0.7 + this.random() * 0.6);
      sprite.scaleX = s;
      sprite.scaleY = s;
      this.live.push(shard);
      this.view.particleChildren.push(sprite);
    }
    this.view.update();
  }

  clear(): void {
    for (const shard of this.live) this.pool.push(shard);
    this.live.length = 0;
    this.view.particleChildren.length = 0;
    this.view.update();
  }

  /**
   * Moves shards toward (targetX, targetY); a shard is absorbed within `catchRadius`.
   * Returns the number absorbed this frame.
   */
  update(dtMs: number, targetX: number, targetY: number, catchRadius: number): number {
    const dt = dtMs / 1000;
    const drag = Math.exp(-DRAG * dt);
    const children = this.view.particleChildren;
    let kept = 0;
    let absorbed = 0;
    for (let i = 0; i < this.live.length; i++) {
      const shard = this.live[i] as Shard;
      const sprite = shard.sprite;
      shard.ageMs += dtMs;
      const dx = targetX - sprite.x;
      const dy = targetY - sprite.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const caught = shard.ageMs > SCATTER_MS && dist < catchRadius;
      if (caught || shard.ageMs >= LIFE_MS) {
        if (caught) absorbed++;
        this.pool.push(shard);
        continue;
      }
      if (shard.ageMs > SCATTER_MS && dist > 0) {
        // Pull grows over time so slow stragglers still arrive.
        const pull = PULL * Math.min(1, (shard.ageMs - SCATTER_MS) / 400) * dt;
        shard.vx = shard.vx * drag + (dx / dist) * pull;
        shard.vy = shard.vy * drag + (dy / dist) * pull;
      } else {
        shard.vx *= drag;
        shard.vy *= drag;
      }
      sprite.x += shard.vx * dt;
      sprite.y += shard.vy * dt;
      sprite.rotation += shard.spin * dt;
      sprite.alpha = shard.ageMs > LIFE_MS * 0.7 ? (LIFE_MS - shard.ageMs) / (LIFE_MS * 0.3) : 1;
      this.live[kept] = shard;
      children[kept] = sprite;
      kept++;
    }
    if (kept !== this.live.length) {
      this.live.length = kept;
      children.length = kept;
      this.view.update();
    }
    return absorbed;
  }

  private createShard(): Shard {
    const sprite = new Particle({ texture: this.texture, anchorX: 0.5, anchorY: 0.5 });
    return { sprite, vx: 0, vy: 0, spin: 0, ageMs: 0 };
  }
}
