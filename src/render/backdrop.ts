/** Static arena backdrop: dark fill, faint grid and a vignette, drawn once. */

import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../sim';
import { COLORS } from './palette';

const GRID_STEP = 80;

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

  const vignette = new Sprite(createVignetteTexture());
  vignette.width = ARENA_WIDTH;
  vignette.height = ARENA_HEIGHT;
  root.addChild(vignette);

  return root;
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
