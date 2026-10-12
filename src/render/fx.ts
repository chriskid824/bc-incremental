/**
 * Pooled additive particles for every short-lived effect: kill debris, sparks, flashes, flames
 * and embers. One ParticleContainer on one sprite sheet (src/render/fxTextures.ts), so the whole
 * layer is a single draw call. Each group has a hard cap; spawns past it are dropped, so a
 * screen full of kills degrades to fewer particles instead of slower frames.
 * Nothing is allocated per frame: particles come from a pool and callers set their fields.
 */

import { Particle, ParticleContainer } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { mixColor } from './palette';
import { ageStep } from './timing';

/** Budget groups; each has its own cap (FX_CAPS). */
export const FX_DEBRIS = 0;
export const FX_SPARK = 1;
export const FX_FLASH = 2;
export const FX_FLAME = 3;
export const FX_EMBER = 4;
export type FxGroup = 0 | 1 | 2 | 3 | 4;

export const FX_CAPS: readonly number[] = [420, 320, 90, 520, 64];

/** What happens when a particle expires. */
export const THEN_NONE = 0;
/** An ember landed: a small puff of flame where it ends. */
export const THEN_FLAME_PUFF = 1;

export interface FxParticle {
  readonly sprite: Particle;
  group: FxGroup;
  vx: number;
  vy: number;
  /** Velocity kept per second is e^-drag. */
  drag: number;
  /** Added to vy per second (negative rises). */
  gravity: number;
  spin: number;
  ageMs: number;
  lifeMs: number;
  /** Scale at birth and at death, linear in between. */
  scale0: number;
  scale1: number;
  /** Streaks stretch along their velocity: scaleX × (1 + speed × stretch). */
  stretch: number;
  /** 0xRRGGBB at birth and death; skipped when equal. */
  color0: number;
  color1: number;
  alpha0: number;
  /** Fraction of the life after which alpha falls linearly to 0. */
  fadeFrom: number;
  /** Rotation follows the velocity. */
  orient: boolean;
  then: number;
  /** Spawned since the last update (see src/render/timing.ts). */
  fresh: boolean;
}

/** Particle.color for an 0xRRGGBB color: BGR plus alpha in the top byte, as Pixi packs it. */
export function packColor(rgb: number, alpha: number): number {
  const bgr = ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
  return bgr + (((alpha * 255) | 0) << 24);
}

const MAX_FOLLOW_UPS = 64;

export class FxParticles {
  readonly view: ParticleContainer;
  private readonly live: FxParticle[] = [];
  private readonly pool: FxParticle[] = [];
  private readonly counts = [0, 0, 0, 0, 0];
  /** Expiry follow-ups queued during update (x, y pairs), run after the sweep. */
  private readonly followUps = new Float64Array(MAX_FOLLOW_UPS * 2);
  private followUpCount = 0;
  private dirty = false;

  constructor(textures: { readonly glow: Texture }) {
    this.view = new ParticleContainer({
      label: 'fx',
      texture: textures.glow,
      dynamicProperties: { position: true, rotation: true, color: true, vertex: true },
    });
    this.view.blendMode = 'add';
  }

  /** Live particles in a group. */
  count(group: FxGroup): number {
    return this.counts[group] ?? 0;
  }

  /** Room left in a group before spawns are dropped. */
  room(group: FxGroup): number {
    return (FX_CAPS[group] ?? 0) - (this.counts[group] ?? 0);
  }

  /**
   * A fresh particle at (x, y) with neutral settings (still, white, full alpha, scale 1), or
   * null when its group is full. Callers set the fields they need on the returned particle.
   */
  spawn(group: FxGroup, texture: Texture, x: number, y: number, lifeMs: number): FxParticle | null {
    if ((this.counts[group] ?? 0) >= (FX_CAPS[group] ?? 0)) return null;
    const p = this.pool.pop() ?? this.create(texture);
    p.group = group;
    p.vx = 0;
    p.vy = 0;
    p.drag = 0;
    p.gravity = 0;
    p.spin = 0;
    p.ageMs = 0;
    p.lifeMs = Math.max(1, lifeMs);
    p.scale0 = 1;
    p.scale1 = 1;
    p.stretch = 0;
    p.color0 = 0xffffff;
    p.color1 = 0xffffff;
    p.alpha0 = 1;
    p.fadeFrom = 0;
    p.orient = false;
    p.then = THEN_NONE;
    p.fresh = true;
    const sprite = p.sprite;
    sprite.texture = texture;
    sprite.x = x;
    sprite.y = y;
    sprite.rotation = 0;
    sprite.scaleX = 0;
    sprite.scaleY = 0;
    sprite.color = 0;
    this.counts[group] = (this.counts[group] ?? 0) + 1;
    this.live.push(p);
    this.view.particleChildren.push(sprite);
    this.dirty = true;
    return p;
  }

  clear(): void {
    for (const p of this.live) this.pool.push(p);
    this.live.length = 0;
    this.counts.fill(0);
    this.view.particleChildren.length = 0;
    this.followUpCount = 0;
    this.view.update();
  }

  update(dtMs: number): void {
    const children = this.view.particleChildren;
    let kept = 0;
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i] as FxParticle;
      const sprite = p.sprite;
      const stepMs = ageStep(dtMs, p.fresh);
      const dt = stepMs / 1000;
      p.fresh = false;
      p.ageMs += stepMs;
      if (p.ageMs >= p.lifeMs) {
        if (p.then !== THEN_NONE && this.followUpCount < MAX_FOLLOW_UPS) {
          this.followUps[this.followUpCount * 2] = sprite.x;
          this.followUps[this.followUpCount * 2 + 1] = sprite.y;
          this.followUpCount++;
        }
        this.counts[p.group] = (this.counts[p.group] ?? 1) - 1;
        this.pool.push(p);
        continue;
      }
      if (p.drag > 0) {
        const keep = Math.exp(-p.drag * dt);
        p.vx *= keep;
        p.vy *= keep;
      }
      p.vy += p.gravity * dt;
      sprite.x += p.vx * dt;
      sprite.y += p.vy * dt;
      const t = p.ageMs / p.lifeMs;
      const scale = p.scale0 + (p.scale1 - p.scale0) * t;
      if (p.stretch > 0) {
        const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        sprite.scaleX = scale * (1 + speed * p.stretch);
      } else {
        sprite.scaleX = scale;
      }
      sprite.scaleY = scale;
      if (p.orient) sprite.rotation = Math.atan2(p.vy, p.vx);
      else if (p.spin !== 0) sprite.rotation += p.spin * dt;
      const alpha = t <= p.fadeFrom ? p.alpha0 : (p.alpha0 * (1 - t)) / (1 - p.fadeFrom);
      const color = p.color0 === p.color1 ? p.color0 : mixColor(p.color0, p.color1, t);
      sprite.color = packColor(color, alpha);
      this.live[kept] = p;
      children[kept] = sprite;
      kept++;
    }
    if (kept !== this.live.length) {
      this.live.length = kept;
      children.length = kept;
      this.dirty = true;
    }
    if (this.dirty) {
      this.view.update();
      this.dirty = false;
    }
  }

  /**
   * Hands the positions of particles that expired with THEN_FLAME_PUFF to `run` and clears the
   * queue. Called after update, so follow-ups can spawn particles of their own.
   */
  drainFollowUps(run: (x: number, y: number) => void): void {
    const n = this.followUpCount;
    this.followUpCount = 0;
    for (let i = 0; i < n; i++) run(this.followUps[i * 2] ?? 0, this.followUps[i * 2 + 1] ?? 0);
  }

  private create(texture: Texture): FxParticle {
    const sprite = new Particle({ texture, anchorX: 0.5, anchorY: 0.5 });
    return {
      sprite,
      group: FX_DEBRIS,
      vx: 0,
      vy: 0,
      drag: 0,
      gravity: 0,
      spin: 0,
      ageMs: 0,
      lifeMs: 1,
      scale0: 1,
      scale1: 1,
      stretch: 0,
      color0: 0xffffff,
      color1: 0xffffff,
      alpha0: 1,
      fadeFrom: 0,
      orient: false,
      then: THEN_NONE,
      fresh: true,
    };
  }
}
