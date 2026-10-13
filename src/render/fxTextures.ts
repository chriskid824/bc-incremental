/**
 * Effect sprite sheet, drawn once on a 2D canvas: a soft glow, a debris shard, a spark streak,
 * a four-point star and a flame tongue. Everything is white so particles get their color from the tint, and
 * the frames share one texture source so a single ParticleContainer draws them in one batch.
 */

import { Rectangle, Texture } from 'pixi.js';

export interface FxTextures {
  /** 64×64 soft radial falloff. */
  readonly glow: Texture;
  /** 64×64 four-point flare with a bright center. */
  readonly star: Texture;
  /** 64×16 spark streak pointing +x, brightest near the head. */
  readonly streak: Texture;
  /** 16×28 diamond shard. */
  readonly shard: Texture;
  /** 40×60 flame tongue pointing up (-y), soft-edged. */
  readonly flame: Texture;
}

const CELL = 64;
const GAP = 2;

export function createFxTextures(): FxTextures {
  const canvas = document.createElement('canvas');
  canvas.width = (CELL + GAP) * 5;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    const empty = Texture.WHITE;
    return { glow: empty, star: empty, streak: empty, shard: empty, flame: empty };
  }

  // Glow: steep core, long soft tail.
  const half = CELL / 2;
  const glow = ctx.createRadialGradient(half, half, 0, half, half, half);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.2, 'rgba(255,255,255,0.75)');
  glow.addColorStop(0.5, 'rgba(255,255,255,0.22)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CELL, CELL);

  // Star: two thin rays crossing over a small glow.
  const sx = CELL + GAP;
  const core = ctx.createRadialGradient(sx + half, half, 0, sx + half, half, half * 0.45);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = core;
  ctx.fillRect(sx, 0, CELL, CELL);
  for (const vertical of [false, true]) {
    const ray = vertical
      ? ctx.createLinearGradient(0, 0, 0, CELL)
      : ctx.createLinearGradient(sx, 0, sx + CELL, 0);
    ray.addColorStop(0, 'rgba(255,255,255,0)');
    ray.addColorStop(0.5, 'rgba(255,255,255,1)');
    ray.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = ray;
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo(sx + half, 0);
      ctx.lineTo(sx + half + 3, half);
      ctx.lineTo(sx + half, CELL);
      ctx.lineTo(sx + half - 3, half);
    } else {
      ctx.moveTo(sx, half);
      ctx.lineTo(sx + half, half - 3);
      ctx.lineTo(sx + CELL, half);
      ctx.lineTo(sx + half, half + 3);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Streak: a lens from a faint tail (left) to a bright head (right).
  const tx = (CELL + GAP) * 2;
  const streak = ctx.createLinearGradient(tx, 0, tx + CELL, 0);
  streak.addColorStop(0, 'rgba(255,255,255,0)');
  streak.addColorStop(0.7, 'rgba(255,255,255,0.85)');
  streak.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = streak;
  ctx.beginPath();
  ctx.moveTo(tx, 8);
  ctx.quadraticCurveTo(tx + CELL * 0.7, 1, tx + CELL, 8);
  ctx.quadraticCurveTo(tx + CELL * 0.7, 15, tx, 8);
  ctx.closePath();
  ctx.fill();

  // Shard: a diamond like the kill shards.
  const dx = (CELL + GAP) * 3;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(dx + 8, 0);
  ctx.lineTo(dx + 16, 14);
  ctx.lineTo(dx + 8, 28);
  ctx.lineTo(dx, 14);
  ctx.closePath();
  ctx.fill();

  // Flame: a teardrop, brightest low in the bulb, blurred so it reads as a soft tongue.
  const fx = (CELL + GAP) * 4;
  const heat = ctx.createRadialGradient(fx + 20, 42, 0, fx + 20, 40, 34);
  heat.addColorStop(0, 'rgba(255,255,255,1)');
  heat.addColorStop(0.45, 'rgba(255,255,255,0.8)');
  heat.addColorStop(1, 'rgba(255,255,255,0.15)');
  ctx.save();
  ctx.filter = 'blur(2px)';
  ctx.fillStyle = heat;
  ctx.beginPath();
  ctx.moveTo(fx + 20, 4);
  ctx.bezierCurveTo(fx + 25, 18, fx + 34, 28, fx + 34, 40);
  ctx.arc(fx + 20, 40, 14, 0, Math.PI);
  ctx.bezierCurveTo(fx + 6, 28, fx + 15, 18, fx + 20, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const base = Texture.from(canvas);
  const frame = (x: number, y: number, w: number, h: number): Texture =>
    new Texture({ source: base.source, frame: new Rectangle(x, y, w, h) });
  return {
    glow: frame(0, 0, CELL, CELL),
    star: frame(sx, 0, CELL, CELL),
    streak: frame(tx, 0, CELL, 16),
    shard: frame(dx, 0, 16, 28),
    flame: frame(fx, 0, 40, 60),
  };
}
