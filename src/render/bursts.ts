/**
 * Composite effects built from FX particles and rings: kill explosions, hit sparks, crit
 * flares, chain sparks, flames and the pandemic fire nova. Sizes are in arena units; every
 * spawn goes through the capped pools, so these can be called for every event. Flames licking
 * off burning enemies and the puffs of landed embers go to a separate layer under the crowd,
 * so each burning enemy's own outline stays on top of its fire.
 */

import type { FxGroup, FxParticles } from './fx';
import { FX_DEBRIS, FX_EMBER, FX_FLAME, FX_FLASH, FX_SPARK, THEN_FLAME_PUFF } from './fx';
import type { FxTextures } from './fxTextures';
import { COLORS, mixColor } from './palette';
import { defaultRandom } from './random';
import type { RenderRandom } from './random';
import type { RingLayer } from './rings';

/** Enemy tier for kill explosions. */
export const TIER_NORMAL = 0;
export const TIER_ELITE = 1;
export const TIER_BOSS = 2;

/** Texture sizes in pixels (src/render/fxTextures.ts): scale = arena size / texture size. */
const GLOW_SIZE = 64;
const FLAME_HEIGHT = 60;
/** Drag on nova flames; their launch speed is solved from it to land on the spread radius. */
const NOVA_DRAG = 3;
const TAU = Math.PI * 2;

/** Root color of enemy flames: orange with a little yellow, so stacked flames stay orange. */
const FLAME_ROOT = mixColor(COLORS.burn, COLORS.burnHot, 0.35);

/** Crit flares stop growing at this many orders of magnitude above the typical hit. */
const CRIT_FLARE_DECADES = 1.5;

export class Bursts {
  /** `fx` draws above the crowd; `under` (enemy flames and ember puffs) draws below it. */
  constructor(
    private readonly fx: FxParticles,
    private readonly under: FxParticles,
    private readonly tex: FxTextures,
    private readonly rings: RingLayer,
    private readonly random: RenderRandom = defaultRandom,
  ) {}

  /**
   * An enemy dies: a flash, a shockwave and debris in its color. `crowd` in (0, 1] thins the
   * debris when many enemies die in the same frame.
   */
  kill(x: number, y: number, color: number, radius: number, tier: number, crowd: number): void {
    const big = tier === TIER_BOSS ? 2.2 : tier === TIER_ELITE ? 1.5 : 1;
    const light = mixColor(color, 0xffffff, 0.45);
    // Hot white core inside a wider flash in the enemy's color. Cores of a crowd dying in the
    // same frame are dimmer, so they do not add up to a white blob over the survivors.
    const core = tier === TIER_NORMAL ? 0.4 + 0.5 * crowd : 1;
    this.glow(FX_FLASH, x, y, radius * 3.2 * big, 0xffffff, light, core, 150 * big);
    this.glow(FX_FLASH, x, y, radius * 6 * big, light, color, 0.7, 240 * big);
    this.rings.shock(x, y, radius * 5.5 * big, light, 9 * big, 320 * big, tier !== TIER_NORMAL);
    if (tier !== TIER_NORMAL) {
      this.star(x, y, (radius * 0.07 * big) ** 0.8, COLORS.critHot, color, 360 * big);
      this.glow(FX_FLASH, x, y, radius * 9 * big, color, color, 0.4, 600 * big);
      this.rings.shock(x, y, radius * 3 * big, 0xffffff, 6 * big, 240 * big, true);
    }

    const debris = Math.max(2, Math.round((6 + radius / 2.2) * big * big * crowd));
    const speedScale = Math.sqrt(big);
    for (let i = 0; i < debris; i++) {
      const p = this.fx.spawn(FX_DEBRIS, this.tex.shard, x, y, this.rand(420, 760) * speedScale);
      if (p === null) break;
      const angle = this.random() * TAU;
      const speed = this.rand(240, 640) * speedScale;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.drag = 3.4;
      p.spin = this.rand(-14, 14);
      p.sprite.rotation = angle;
      const s = this.rand(0.5, 1) * Math.sqrt(radius / 18);
      p.scale0 = s;
      p.scale1 = s * 0.5;
      p.color0 = light;
      p.color1 = color;
      p.fadeFrom = 0.4;
    }
    const sparks = Math.round((5 + 8 * (big - 1)) * crowd) + 1;
    this.sparks(x, y, 0, 0, sparks, 0xffffff, color, 1.2 * speedScale);
  }

  /** A projectile hit: a puff and a few sparks thrown along (dirX, dirY). */
  hit(x: number, y: number, dirX: number, dirY: number): void {
    // Puffs share the spark budget so a hail of hits never starves kill and crit flashes.
    this.glow(FX_SPARK, x, y, 26, COLORS.spark, COLORS.spark, 0.8, 90);
    this.sparks(x, y, dirX, dirY, 3, 0xffffff, COLORS.spark, 0.8);
  }

  /**
   * A crit: a star flare and crit-colored sparks, a little bigger for bigger crits (decades
   * above the typical hit, with a low ceiling). `big` is the full flare with a shockwave, for
   * crits shown as a big number pop; the others get a small flare so a volley of crits does not
   * bury the crowd under stars.
   */
  crit(x: number, y: number, decades: number, big: boolean): void {
    const d = Math.min(CRIT_FLARE_DECADES, Math.max(0, decades));
    if (!big) {
      this.star(x, y, 0.55 + 0.15 * d, COLORS.critHot, COLORS.crit, 150);
      this.glow(FX_FLASH, x, y, 40 + 10 * d, COLORS.critHot, COLORS.crit, 0.7, 110);
      this.sparks(x, y, 0, 0, 3, COLORS.critHot, COLORS.crit, 1);
      return;
    }
    this.star(x, y, 0.9 + 0.4 * d, COLORS.critHot, COLORS.crit, 200 + 40 * d);
    this.glow(FX_FLASH, x, y, 56 + 22 * d, COLORS.critHot, COLORS.crit, 0.85, 150);
    this.rings.shock(x, y, 40 + 18 * d, COLORS.crit, 4 + 2 * d, 220 + 40 * d);
    this.sparks(x, y, 0, 0, Math.round(5 + 3 * d), COLORS.critHot, COLORS.crit, 1.1 + 0.2 * d);
  }

  /** A chain jump landed: an electric pop at the target. */
  chain(x: number, y: number): void {
    this.glow(FX_FLASH, x, y, 72, 0xffffff, COLORS.chain, 1, 150);
    this.sparks(x, y, 0, 0, 5, 0xffffff, COLORS.chain, 1.1);
  }

  /**
   * One flame licking up from behind a burning enemy of `radius` (on the layer under the
   * crowd); `heat` in [0, 1] grows it with the stack count.
   */
  flame(x: number, y: number, radius: number, heat: number): void {
    const p = this.under.spawn(FX_FLAME, this.tex.flame, x, y, this.rand(300, 440));
    if (p === null) return;
    // Rooted on the upper half, so the tongues rise out from behind the body.
    p.sprite.x += this.rand(-0.65, 0.65) * radius;
    p.sprite.y += this.rand(-0.55, 0.05) * radius;
    p.sprite.rotation = this.rand(-0.25, 0.25);
    p.spin = this.rand(-0.6, 0.6);
    p.vx = this.rand(-15, 15);
    p.vy = -this.rand(30, 70) * (1 + 0.4 * heat);
    p.gravity = -100;
    p.drag = 1.5;
    const height = radius * 2.5 * (0.8 + 0.35 * heat) * this.rand(0.75, 1.2);
    const s = height / FLAME_HEIGHT;
    p.scale0 = s;
    p.scale1 = s * 0.35;
    p.color0 = FLAME_ROOT;
    p.color1 = COLORS.burnDeep;
    // Overlapping flames add up, so each stays well short of white.
    p.alpha0 = 0.34 + 0.18 * heat;
    p.fadeFrom = 0.35;
  }

  /**
   * pandemic: the nova ring, a fire flash and flames racing out to `radius`. While a few full
   * novas already burn, a new one is a rim with fewer flames.
   */
  nova(x: number, y: number, radius: number): void {
    const full = this.rings.nova(x, y, radius);
    if (full) this.glow(FX_FLASH, x, y, radius * 1.2, COLORS.burnHot, COLORS.burnDeep, 0.45, 300);
    this.glow(FX_FLASH, x, y, 84, COLORS.burnHot, COLORS.burn, 0.7, 180);
    const count = full ? 26 : 10;
    for (let i = 0; i < count; i++) {
      const lifeMs = this.rand(380, 480);
      const p = this.fx.spawn(FX_FLAME, this.tex.flame, x, y, lifeMs);
      if (p === null) break;
      const angle = (i / count) * TAU + this.rand(-0.1, 0.1);
      // Launch speed that coasts (under drag) to about the spread radius by the end of life.
      const travel = radius * this.rand(0.85, 1);
      const speed = (travel * NOVA_DRAG) / (1 - Math.exp((-NOVA_DRAG * lifeMs) / 1000));
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.drag = NOVA_DRAG;
      // Tongues point outward.
      p.sprite.rotation = angle + Math.PI / 2;
      const s = this.rand(44, 60) / FLAME_HEIGHT;
      p.scale0 = s;
      p.scale1 = s * 0.6;
      // The tongues all start on the same spot and add up: orange and part-transparent, so
      // the nova's heart is hot but not a white disc over the enemies around it.
      p.color0 = FLAME_ROOT;
      p.color1 = COLORS.burnDeep;
      p.alpha0 = 0.65;
      p.fadeFrom = 0.5;
    }
  }

  /** pandemic: a burning ember flying from a dying enemy to one it sets alight. */
  ember(fromX: number, fromY: number, toX: number, toY: number): void {
    const lifeMs = this.rand(200, 260);
    const vx = ((toX - fromX) * 1000) / lifeMs;
    const vy = ((toY - fromY) * 1000) / lifeMs;
    const head = this.fx.spawn(FX_EMBER, this.tex.streak, fromX, fromY, lifeMs);
    if (head === null) return;
    head.vx = vx;
    head.vy = vy;
    head.orient = true;
    head.scale0 = 0.8;
    head.scale1 = 0.6;
    head.stretch = 0.0005;
    head.color0 = 0xffffff;
    head.color1 = COLORS.burnHot;
    head.then = THEN_FLAME_PUFF;
    const halo = this.fx.spawn(FX_EMBER, this.tex.glow, fromX, fromY, lifeMs);
    if (halo === null) return;
    halo.vx = vx;
    halo.vy = vy;
    halo.scale0 = 0.9;
    halo.scale1 = 0.7;
    halo.color0 = COLORS.burnHot;
    halo.color1 = COLORS.burn;
    halo.alpha0 = 0.8;
  }

  /** An ember landed: a burst of flame, under the crowd like the flames of burning enemies. */
  flamePuff(x: number, y: number): void {
    this.glow(FX_FLASH, x, y, 70, COLORS.burnHot, COLORS.burn, 0.75, 190, this.under);
    for (let i = 0; i < 4; i++) this.flame(x, y, 20, 1);
  }

  private glow(
    group: FxGroup,
    x: number,
    y: number,
    diameter: number,
    color0: number,
    color1: number,
    alpha: number,
    lifeMs: number,
    layer: FxParticles = this.fx,
  ): void {
    const p = layer.spawn(group, this.tex.glow, x, y, lifeMs);
    if (p === null) return;
    const s = diameter / GLOW_SIZE;
    p.scale0 = s * 0.7;
    p.scale1 = s * 1.25;
    p.color0 = color0;
    p.color1 = color1;
    p.alpha0 = alpha;
  }

  private star(
    x: number,
    y: number,
    scale: number,
    color0: number,
    color1: number,
    lifeMs: number,
  ): void {
    const p = this.fx.spawn(FX_FLASH, this.tex.star, x, y, lifeMs);
    if (p === null) return;
    p.sprite.rotation = this.rand(-0.4, 0.4);
    p.spin = this.rand(-1.5, 1.5);
    p.scale0 = scale;
    p.scale1 = scale * 1.35;
    p.color0 = color0;
    p.color1 = color1;
    p.fadeFrom = 0.25;
  }

  /**
   * `count` streak sparks. With a direction (dirX, dirY) they spray in a cone along it;
   * with (0, 0) they fly out in every direction.
   */
  private sparks(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    count: number,
    color0: number,
    color1: number,
    power: number,
  ): void {
    const aimed = dirX !== 0 || dirY !== 0;
    const base = aimed ? Math.atan2(dirY, dirX) : 0;
    for (let i = 0; i < count; i++) {
      const p = this.fx.spawn(FX_SPARK, this.tex.streak, x, y, this.rand(130, 240) * power);
      if (p === null) return;
      const angle = aimed ? base + this.rand(-0.9, 0.9) : this.random() * TAU;
      const speed = this.rand(380, 820) * power;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.drag = 6;
      p.orient = true;
      p.scale0 = 0.32 * Math.sqrt(power);
      p.scale1 = 0.12;
      p.stretch = 0.0012;
      p.color0 = color0;
      p.color1 = color1;
    }
  }

  /** A uniform number in [min, max). */
  private rand(min: number, max: number): number {
    return min + this.random() * (max - min);
  }
}
