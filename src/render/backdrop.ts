/**
 * Static arena backdrop, drawn once: dark fill, faint grid, a soft light pool with range rings
 * around the player so the floor is not a black void, and a vignette.
 */

import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../sim';
import { COLORS } from './palette';

const GRID_STEP = 80;
/** Radius of the light pool around the player, and the spacing of its range rings. */
const POOL_RADIUS = 620;
const RING_STEP = 200;

export function createBackdrop(): Container {
  const root = new Container({ label: 'backdrop' });

  const grid = new Graphics();
  grid.rect(0, 0, ARENA_WIDTH, ARENA_HEIGHT).fill(COLORS.arena);
  // Lines run out from the center so the player sits on a grid crossing.
  const cx = ARENA_WIDTH / 2;
  const cy = ARENA_HEIGHT / 2;
  for (let x = cx % GRID_STEP; x <= ARENA_WIDTH; x += GRID_STEP) {
    grid.moveTo(x, 0).lineTo(x, ARENA_HEIGHT);
  }
  for (let y = cy % GRID_STEP; y <= ARENA_HEIGHT; y += GRID_STEP) {
    grid.moveTo(0, y).lineTo(ARENA_WIDTH, y);
  }
  grid.stroke({ width: 1, color: COLORS.grid, alpha: 0.55 });
  grid.rect(0, 0, ARENA_WIDTH, ARENA_HEIGHT).stroke({
    width: 2,
    color: COLORS.arenaEdge,
    alpha: 0.8,
    alignment: 1,
  });
  root.addChild(grid);

  const pool = new Sprite(createGlowTexture());
  pool.anchor.set(0.5);
  pool.position.set(cx, cy);
  pool.width = POOL_RADIUS * 2;
  pool.height = POOL_RADIUS * 2;
  pool.tint = COLORS.floorGlow;
  pool.blendMode = 'add';
  root.addChild(pool);

  const rings = new Graphics();
  for (let r = RING_STEP; r < POOL_RADIUS; r += RING_STEP) {
    rings
      .circle(cx, cy, r)
      .stroke({ width: 2, color: COLORS.floorGlow, alpha: 0.22 * (1 - r / POOL_RADIUS) });
  }
  root.addChild(rings);

  const vignette = new Sprite(createVignetteTexture());
  vignette.width = ARENA_WIDTH;
  vignette.height = ARENA_HEIGHT;
  root.addChild(vignette);

  return root;
}

/** White radial falloff for the light pool; tinted by the sprite. */
function createGlowTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return Texture.EMPTY;
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.34)');
  gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.14)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  return Texture.from(canvas);
}

/** Radial gradient from transparent at the center to dark at the corners. */
function createVignetteTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 270;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return Texture.EMPTY;
  const { width: w, height: h } = canvas;
  const gradient = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, w * 0.62);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  return Texture.from(canvas);
}
