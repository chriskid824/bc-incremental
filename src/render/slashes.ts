/**
 * 斬擊線 (docs/v3/game-design-v3.md §4.6, §11.6): the 'slash' event's cut from (x1, y1) to
 * (x2, y2), `width` wide, as a white line of 暴擊's low-chroma light (#FFF4D6) that snaps out
 * from its start in SLASH_GROW_MS, then thins and fades. 火暴「爆斬」 draws one from each
 * explosion, the crit outer's 斬首線 one from each crit. Three additive streak sprites a slash
 * (a wide glow, the blade and its white edge), pooled and capped at SLASH_CAP: a new slash past
 * the cap takes the oldest one's place, so the newest cut always shows.
 */

import { Particle, ParticleContainer } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { packColor } from './fx';
import { MAGMA_COLORS } from './palette';
import { ageStep } from './timing';

export const SLASH_CAP = 12;
export const SLASH_MS = 300;
const SLASH_GROW_MS = 60;
/** Streak texture size in pixels (src/render/fxTextures.ts). */
const STREAK_LENGTH = 64;
const STREAK_HEIGHT = 16;
const SPRITES_PER_SLASH = 3;

/** How far along its line a slash `ageMs` old reaches, 0 to 1: out in SLASH_GROW_MS. */
export function slashReach(ageMs: number): number {
  if (ageMs <= 0) return 0;
  if (ageMs >= SLASH_GROW_MS) return 1;
  const k = 1 - ageMs / SLASH_GROW_MS;
  return 1 - k * k;
}

/** How bright a slash `ageMs` old is: full while it grows, then fading to 0 at SLASH_MS. */
export function slashAlpha(ageMs: number): number {
  if (ageMs <= SLASH_GROW_MS) return 1;
  if (ageMs >= SLASH_MS) return 0;
  const t = 1 - (ageMs - SLASH_GROW_MS) / (SLASH_MS - SLASH_GROW_MS);
  return t * t;
}

interface Slash {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  ageMs: number;
  fresh: boolean;
}

export class SlashLayer {
  readonly view: ParticleContainer;
  private readonly slashes: Slash[] = [];
  private readonly sprites: Particle[] = [];
  /** The oldest live slash: the next to be replaced once the layer is full. */
  private oldest = 0;
  private drawn = 0;

  constructor(
    private readonly streak: Texture,
    private readonly color: number = MAGMA_COLORS.slash,
  ) {
    this.view = new ParticleContainer({
      label: 'slashes',
      texture: streak,
      dynamicProperties: { position: true, rotation: true, color: true, vertex: true },
    });
    this.view.blendMode = 'add';
  }

  /** Live slashes. */
  get size(): number {
    return this.slashes.length;
  }

  add(x1: number, y1: number, x2: number, y2: number, width: number): void {
    let slash: Slash;
    if (this.slashes.length < SLASH_CAP) {
      slash = { x1, y1, x2, y2, width, ageMs: 0, fresh: true };
      this.slashes.push(slash);
    } else {
      slash = this.slashes[this.oldest] as Slash;
      this.oldest = (this.oldest + 1) % SLASH_CAP;
    }
    slash.x1 = x1;
    slash.y1 = y1;
    slash.x2 = x2;
    slash.y2 = y2;
    slash.width = width;
    slash.ageMs = 0;
    slash.fresh = true;
  }

  clear(): void {
    this.slashes.length = 0;
    this.oldest = 0;
    this.view.particleChildren.length = 0;
    this.drawn = 0;
    this.view.update();
  }

  update(dtMs: number): void {
    const children = this.view.particleChildren;
    let n = 0;
    let dirty = false;
    for (let i = 0; i < this.slashes.length; i++) {
      const slash = this.slashes[i] as Slash;
      slash.ageMs += ageStep(dtMs, slash.fresh);
      slash.fresh = false;
      const reach = slashReach(slash.ageMs);
      const alpha = slashAlpha(slash.ageMs);
      if (alpha <= 0) continue;
      const dx = slash.x2 - slash.x1;
      const dy = slash.y2 - slash.y1;
      const length = Math.sqrt(dx * dx + dy * dy) * reach;
      if (length < 1) continue;
      // The streak's head is its bright end: at the tip of the cut, pointing along it.
      const hx = slash.x1 + dx * reach;
      const hy = slash.y1 + dy * reach;
      const rotation = Math.atan2(dy, dx);
      const sx = length / STREAK_LENGTH;
      const thin = 0.4 + 0.6 * alpha;
      for (let k = 0; k < SPRITES_PER_SLASH; k++) {
        const widthShare = LAYER_WIDTH[k] as number;
        const color = LAYER_COLOR[k] as number;
        const a = LAYER_ALPHA[k] as number;
        let sprite = this.sprites[n];
        if (sprite === undefined) {
          sprite = new Particle({ texture: this.streak, anchorX: 1, anchorY: 0.5 });
          this.sprites.push(sprite);
        }
        sprite.x = hx;
        sprite.y = hy;
        sprite.rotation = rotation;
        sprite.scaleX = sx;
        sprite.scaleY = (slash.width * widthShare * thin) / STREAK_HEIGHT;
        sprite.color = packColor(color === -1 ? this.color : color, a * alpha);
        if (children[n] !== sprite) {
          children[n] = sprite;
          dirty = true;
        }
        n++;
      }
    }
    // Expired slashes leave the list; the ring of the oldest restarts at the front.
    let kept = 0;
    for (let i = 0; i < this.slashes.length; i++) {
      const slash = this.slashes[i] as Slash;
      if (slash.ageMs < SLASH_MS) this.slashes[kept++] = slash;
    }
    if (kept !== this.slashes.length) {
      this.slashes.length = kept;
      this.oldest = 0;
    }
    if (n !== this.drawn) {
      children.length = n;
      this.drawn = n;
      dirty = true;
    }
    if (dirty) this.view.update();
  }
}

/** A slash's sprites, glow to edge: share of its width, colour (−1: the layer's), alpha. */
const LAYER_WIDTH: readonly number[] = [1.6, 0.7, 0.25];
const LAYER_COLOR: readonly number[] = [-1, -1, 0xffffff];
const LAYER_ALPHA: readonly number[] = [0.35, 0.9, 1];
