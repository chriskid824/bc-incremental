/**
 * Static arena backdrop, drawn once: dark fill, faint grid, a soft light pool with range rings
 * around the player so the floor is not a black void, and a vignette. A v3 character run draws
 * its character's arena instead (createArenaBackdrop, docs/v3/game-design-v3.md §11.5), which
 * drops M1's light pool and range rings.
 */

import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../sim';
import { ARENA_COLORS, COLORS } from './palette';

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

/** 熔核's forge grate: rings this far apart, and this many spokes around the center. */
export const GRATE_RING_STEP = 110;
export const GRATE_SPOKES = 24;
/** The spokes start this far out, clear of the construct (its plates reach 39 + 40). */
const GRATE_HUB = 90;
/** Ring arcs are drawn in pieces this many radians long, kept to those inside the arena. */
const ARC_PIECE = Math.PI / 90;
const HEAT_RADIUS = 520;

/**
 * The arena of a v3 character run (CharacterDef.arena): 熔核's ('fire') is charcoal with a forge
 * grate, concentric rings and spokes around the player, and a faint heat at its center; the
 * scorch marks are a layer of their own (src/render/magma.ts). Any other arena is M1's backdrop
 * until its batch draws it.
 */
export function createArenaBackdrop(arena: string): Container {
  if (arena !== 'fire') return createBackdrop();
  const A = ARENA_COLORS.fire;
  const root = new Container({ label: 'backdrop-fire' });
  const cx = ARENA_WIDTH / 2;
  const cy = ARENA_HEIGHT / 2;

  const floor = new Graphics().rect(0, 0, ARENA_WIDTH, ARENA_HEIGHT).fill(A.floor);
  root.addChild(floor);

  const heat = new Sprite(createGlowTexture());
  heat.anchor.set(0.5);
  heat.position.set(cx, cy);
  heat.width = HEAT_RADIUS * 2;
  heat.height = HEAT_RADIUS * 2;
  heat.tint = A.heat;
  heat.alpha = 0.55;
  heat.blendMode = 'add';
  root.addChild(heat);

  const grate = new Graphics();
  const hot = new Graphics();
  const reach = Math.hypot(cx, cy);
  for (let ring = 1; ring * GRATE_RING_STEP < reach; ring++) {
    arcInside(ring % 3 === 0 ? hot : grate, cx, cy, ring * GRATE_RING_STEP);
  }
  for (let k = 0; k < GRATE_SPOKES; k++) {
    const angle = (k / GRATE_SPOKES) * Math.PI * 2;
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    const toEdge = Math.min(
      Math.abs(c) < 1e-9 ? Infinity : (c > 0 ? ARENA_WIDTH - cx : cx) / Math.abs(c),
      Math.abs(sn) < 1e-9 ? Infinity : (sn > 0 ? ARENA_HEIGHT - cy : cy) / Math.abs(sn),
    );
    grate.moveTo(cx + c * GRATE_HUB, cy + sn * GRATE_HUB).lineTo(cx + c * toEdge, cy + sn * toEdge);
  }
  grate.stroke({ width: 1.5, color: A.grate, alpha: 0.9 });
  hot.stroke({ width: 2.5, color: A.grateHot, alpha: 0.8 });
  grate.rect(0, 0, ARENA_WIDTH, ARENA_HEIGHT).stroke({
    width: 2,
    color: A.edge,
    alpha: 0.9,
    alignment: 1,
  });
  root.addChild(grate, hot);

  const vignette = new Sprite(createVignetteTexture());
  vignette.width = ARENA_WIDTH;
  vignette.height = ARENA_HEIGHT;
  root.addChild(vignette);
  return root;
}

/** The parts of the circle of `radius` around (cx, cy) inside the arena, as open paths on `g`. */
function arcInside(g: Graphics, cx: number, cy: number, radius: number): void {
  const inside = (a: number): boolean => {
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    return x >= 0 && x <= ARENA_WIDTH && y >= 0 && y <= ARENA_HEIGHT;
  };
  const pieces = Math.ceil((Math.PI * 2) / ARC_PIECE);
  let drawing = false;
  for (let i = 0; i <= pieces; i++) {
    const a = i * ARC_PIECE;
    if (!inside(a)) {
      drawing = false;
      continue;
    }
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    if (drawing) g.lineTo(x, y);
    else g.moveTo(x, y);
    drawing = true;
  }
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
