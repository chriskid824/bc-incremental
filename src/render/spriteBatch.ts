/**
 * A ParticleContainer whose sprites are handed out in order each frame and reused (begin, add,
 * end): the attack-language layers' pools (src/render/magma.ts, src/render/hive.ts), allocated
 * up to their cap and uploaded only when a sprite's texture or the count changes.
 */

import { Particle, ParticleContainer } from 'pixi.js';
import type { Texture } from 'pixi.js';

/** Sprites of one ParticleContainer, handed out in order each frame and reused. */
export class SpriteBatch {
  readonly view: ParticleContainer;
  private readonly sprites: Particle[] = [];
  private n = 0;
  private drawn = 0;
  private dirty = false;

  constructor(
    label: string,
    texture: Texture,
    blend: 'add' | 'normal',
    private readonly cap: number,
  ) {
    this.view = new ParticleContainer({
      label,
      texture,
      dynamicProperties: { position: true, rotation: true, color: true, vertex: true },
    });
    this.view.blendMode = blend;
  }

  /** Sprites drawn this frame so far. */
  get size(): number {
    return this.n;
  }

  begin(): void {
    this.n = 0;
  }

  /**
   * The next sprite this frame, at (x, y), `texture` anchored at (anchorX, 0.5), turned and
   * scaled as given, of color `color` (packColor); null once the batch is full.
   */
  add(
    texture: Texture,
    anchorX: number,
    x: number,
    y: number,
    rotation: number,
    scaleX: number,
    scaleY: number,
    color: number,
  ): Particle | null {
    if (this.n >= this.cap) return null;
    let sprite = this.sprites[this.n];
    if (sprite === undefined) {
      sprite = new Particle({ texture, anchorX, anchorY: 0.5 });
      this.sprites.push(sprite);
      this.dirty = true;
    }
    if (sprite.texture !== texture || sprite.anchorX !== anchorX) {
      sprite.texture = texture;
      sprite.anchorX = anchorX;
      // UVs are static: a texture change needs a full upload.
      this.dirty = true;
    }
    sprite.x = x;
    sprite.y = y;
    sprite.rotation = rotation;
    sprite.scaleX = scaleX;
    sprite.scaleY = scaleY;
    sprite.color = color;
    const children = this.view.particleChildren;
    if (children[this.n] !== sprite) {
      children[this.n] = sprite;
      this.dirty = true;
    }
    this.n++;
    return sprite;
  }

  end(): void {
    const children = this.view.particleChildren;
    if (this.n !== this.drawn) {
      children.length = this.n;
      this.drawn = this.n;
      this.dirty = true;
    }
    if (this.dirty) {
      this.view.update();
      this.dirty = false;
    }
  }

  clear(): void {
    this.begin();
    this.end();
  }
}
