/**
 * The enemies' geometry (docs/v3 C7 design §2.9; docs/v3/game-design-v3.md §6, A.5), drawn in code
 * (CLAUDE.md: no generated art): a hull for every EnemyShape, the parts some looks add around it
 * (盾兵's half-circle shield, 召喚者's orbiting triangles, 寶藏怪's glow, 洋蔥's shells, an elite's
 * 元素護盾 shell and 守護 ring) and a symbol for every affix. Hulls are white and take the type's
 * color by tint (src/render/enemyView.ts), M1's polygons exactly as before; the v3 types keep
 * M1's style, a dark backing, a soft halo and a white outline over a translucent fill (gd §6
 * 「中性的白灰輪廓＋半透明填色」). Affix symbols are white with no color (gd:703: color is the
 * characters'). DOM-free, so the tests reach every drawer. Sizes are in arena units, most as a
 * share of the def's radius r; every number below is an initial value (初始值), picked to read at
 * a glance at 1× and to keep each look inside its 200-unit cell of the `?enemies` grid.
 */

import { Container, Graphics } from 'pixi.js';
import type { AffixId } from '../data/affixes';
import { AFFIX_IDS } from '../data/affixes';
import type { EnemyShape } from '../data/types';
import { GUARD_RADIUS } from '../sim/systems/affixes';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** M1's polygons: sides per shape. */
const POLYGON_SIDES = { triangle: 3, square: 4, pentagon: 5, hexagon: 6, octagon: 8 } as const;

/** The inner mark of a non-boss hull: a filled copy of its outline at this share of r (M1's). */
const MARK_SCALE = 0.38;
/** 再生者's cross: each arm's half-width as a share of r, wide enough to read as a plus. */
const CROSS_ARM = 0.36;
/** 衝刺者's 「細長菱形」: its half-length and half-width as shares of r, pointing along +x. */
const RHOMBUS_LENGTH = 1.35;
const RHOMBUS_WIDTH = 0.55;
/** 射手's trapezoid: the narrow front (+x, the player's side), the wide back and its half-depth. */
const TRAPEZOID_FRONT = 0.5;
const TRAPEZOID_BACK = 0.95;
const TRAPEZOID_DEPTH = 0.75;
/** 召喚者's 「中空的大圓」: drawn this much larger than its collision radius (§1.2). */
export const RING_DRAW_SCALE = 1.35;
/** The ring's dark backing and its white line, as shares of r: a hollow ring, no fill inside. */
const RING_BACKING_WIDTH = 0.4;
const RING_LINE_WIDTH = 0.2;
/** Its three small triangles orbit outside the ring, at this share of r, this big. */
export const ORBIT_COUNT = 3;
export const ORBIT_SCALE = 1.9;
const ORBIT_TRIANGLE = 0.32;
/** The triangles' fill: lighter than a hull's, so they read as the ring's, not as enemies. */
const ORBIT_FILL_ALPHA = 0.35;
const ORBIT_LINE_WIDTH = 2;
/** 寶藏怪's small diamond: its half-height and half-width as shares of r. */
const DIAMOND_HEIGHT = 1.15;
const DIAMOND_WIDTH = 0.8;
/**
 * 寶藏怪's glow (gd A.5 「閃著金光」): two soft discs in its color, as shares of r and alphas.
 * The alphas are about twice the look's 0.08 and 0.14, since enemyView's GLOW_REST_ALPHA (0.44)
 * dims the glow at rest to leave the shimmer and the flee room under 1.
 */
const GLOW_OUTER = 2.6;
const GLOW_OUTER_ALPHA = 0.17;
const GLOW_INNER = 1.7;
const GLOW_INNER_ALPHA = 0.29;
/** 洋蔥's three shells, outermost first, as shares of r; a shell drops with each layer lost. */
export const ONION_SHELLS = [1, 0.7, 0.42] as const;
/** A shell's faint fill and its line, as a share of its own radius. */
const ONION_SHELL_FILL_ALPHA = 0.12;
const ONION_SHELL_WIDTH = 0.12;
/** The bright core left at its center when every shell is gone, as a share of r. */
export const ONION_CORE = 0.16;
const ONION_CORE_ALPHA = 0.85;
/** 盾兵's half-circle shield, facing the center: its radius as a share of r, and its line. */
export const SHIELD_ARC_SCALE = 1.4;
const SHIELD_ARC_WIDTH = 4;
/** The dark band under the shield's line, so it reads over a bright effect. */
const SHIELD_ARC_BACKING = 5;
const SHIELD_ARC_BACKING_ALPHA = 0.5;
/** 元素護盾's thin shell, around the body until wardBroken: its radius as a share of r. */
export const WARD_SHELL_SCALE = 1.3;
const WARD_SHELL_WIDTH = 2;
const WARD_SHELL_ALPHA = 0.75;
/** A breath of fill inside the shell, so it reads as a bubble and not as a second outline. */
const WARD_SHELL_FILL_ALPHA = 0.05;
/** 守護's ring at GUARD_RADIUS (the sim's own radius): faint, so a crowd of them stays legible. */
export const GUARD_RING_ALPHA = 0.14;
const GUARD_RING_WIDTH = 2;
/** The disc inside the ring, fainter still: the area the guardian covers. */
const GUARD_FILL_ALPHA = 0.03;
/** An affix symbol's half-size, its stroke, and the space a symbol takes in its row. */
export const SYMBOL_SIZE = 7;
const SYMBOL_STROKE = 2.5;
export const SYMBOL_STEP = 19;
/** 堅甲's plate fill under its outline. */
const SYMBOL_PLATE_ALPHA = 0.35;

/** Adds the shape's outline at radius `size` to the current path. */
type Outline = (g: Graphics, size: number) => void;

const polygon =
  (sides: number): Outline =>
  (g, size) =>
    g.regularPoly(0, 0, size, sides);

const circle: Outline = (g, size) => g.circle(0, 0, size);

/** A quarter turn's cosine and sine, four times round: exact, so the cross stays square. */
const QUARTERS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;

/**
 * The twelve corners of a plus sign `size` from its center to an arm's end, its arms `w` from
 * their axis to their sides: one arm's three corners (from its left side, clockwise), turned a
 * quarter at a time.
 */
function crossPoints(size: number, w: number): number[] {
  const points: number[] = [];
  for (const [c, s] of QUARTERS) {
    for (const [x, y] of [
      [-w, -size],
      [w, -size],
      [w, -w],
    ] as const) {
      points.push(x * c - y * s, x * s + y * c);
    }
  }
  return points;
}

const cross: Outline = (g, size) => g.poly(crossPoints(size, size * CROSS_ARM));

const rhombus: Outline = (g, size) =>
  g.poly([
    size * RHOMBUS_LENGTH,
    0,
    0,
    size * RHOMBUS_WIDTH,
    -size * RHOMBUS_LENGTH,
    0,
    0,
    -size * RHOMBUS_WIDTH,
  ]);

const trapezoid: Outline = (g, size) =>
  g.poly([
    size * TRAPEZOID_DEPTH,
    -size * TRAPEZOID_FRONT,
    size * TRAPEZOID_DEPTH,
    size * TRAPEZOID_FRONT,
    -size * TRAPEZOID_DEPTH,
    size * TRAPEZOID_BACK,
    -size * TRAPEZOID_DEPTH,
    -size * TRAPEZOID_BACK,
  ]);

const diamond: Outline = (g, size) =>
  g.poly([
    0,
    -size * DIAMOND_HEIGHT,
    size * DIAMOND_WIDTH,
    0,
    0,
    size * DIAMOND_HEIGHT,
    -size * DIAMOND_WIDTH,
    0,
  ]);

/**
 * A hull in M1's style around `outline`, M1's numbers as they were: a dark backing (tinting
 * leaves black black, so the shape stays solid over fire), a soft halo, then the translucent
 * fill and the white outline.
 */
function outlined(g: Graphics, outline: Outline, r: number): Graphics {
  outline(g, r);
  g.fill({ color: 0x000000, alpha: 0.6 });
  outline(g, r * 1.1);
  g.stroke({ width: 10, color: 0xffffff, alpha: 0.16 });
  outline(g, r);
  return g
    .fill({ color: 0xffffff, alpha: 0.28 })
    .stroke({ width: Math.max(3, r * 0.14), color: 0xffffff, alpha: 1 });
}

/** Draws the hull of a type of radius `r`; a boss's leaves out the inner mark (its ring is apart). */
export type HullDrawer = (r: number, boss: boolean) => Graphics;

/** A solid hull with the bright inner mark of every non-boss type (M1's alpha). */
function marked(outline: Outline): HullDrawer {
  return (r, boss) => {
    const g = outlined(new Graphics(), outline, r);
    if (!boss) {
      outline(g, r * MARK_SCALE);
      g.fill({ color: 0xffffff, alpha: 0.6 });
    }
    return g;
  };
}

/**
 * The hull of every shape. M1's five polygons as they always were; 盾兵's circle, 再生者's
 * cross, 衝刺者's long rhombus and 射手's trapezoid (both pointing along +x, which the view turns
 * toward the player), 召喚者's hollow ring drawn larger than its collision radius, 寶藏怪's small
 * diamond, and 洋蔥's dark backing, whose shells are apart (onionShells).
 */
export const HULLS: Readonly<Record<EnemyShape, HullDrawer>> = {
  triangle: marked(polygon(POLYGON_SIDES.triangle)),
  square: marked(polygon(POLYGON_SIDES.square)),
  pentagon: marked(polygon(POLYGON_SIDES.pentagon)),
  hexagon: marked(polygon(POLYGON_SIDES.hexagon)),
  octagon: marked(polygon(POLYGON_SIDES.octagon)),
  circle: marked(circle),
  cross: marked(cross),
  rhombus: marked(rhombus),
  trapezoid: marked(trapezoid),
  ring: (r) => {
    // Hollow: the backing and the outline are rings, M1's halo between them.
    const size = r * RING_DRAW_SCALE;
    return new Graphics()
      .circle(0, 0, size)
      .stroke({ width: r * RING_BACKING_WIDTH, color: 0x000000, alpha: 0.6 })
      .circle(0, 0, size * 1.1)
      .stroke({ width: 10, color: 0xffffff, alpha: 0.16 })
      .circle(0, 0, size)
      .stroke({ width: r * RING_LINE_WIDTH, color: 0xffffff, alpha: 1 });
  },
  diamond: marked(diamond),
  onion: (r) => new Graphics().circle(0, 0, r).fill({ color: 0x000000, alpha: 0.6 }),
};

/** The shapes the view turns toward the player instead of spinning: their front is +x. */
export const FACING_SHAPES: ReadonlySet<EnemyShape> = new Set<EnemyShape>(['rhombus', 'trapezoid']);

/**
 * A boss's counter-rotating inner ring (docs/GDD.md §2.4's layered polygon), M1's as it was, for
 * a polygon boss; null for 洋蔥, whose shells are its layers.
 */
export function bossRing(shape: EnemyShape, r: number): Graphics | null {
  if (!Object.hasOwn(POLYGON_SIDES, shape)) return null;
  const sides = POLYGON_SIDES[shape as keyof typeof POLYGON_SIDES];
  return new Graphics()
    .regularPoly(0, 0, r * 0.6, sides, Math.PI / sides)
    .fill({ color: 0xffffff, alpha: 0.25 })
    .stroke({ width: 4, color: 0xffffff, alpha: 0.9 })
    .regularPoly(0, 0, r * 0.25, sides)
    .fill({ color: 0xffffff, alpha: 0.85 });
}

/**
 * 洋蔥's shells, outermost first (ONION_SHELLS), then its core: one Graphics each, so the view
 * hides a shell as its layer breaks (EnemyV3View.layersLeft).
 */
export function onionShells(r: number): Graphics[] {
  const shells = ONION_SHELLS.map((scale) => {
    const size = r * scale;
    return new Graphics({ label: 'shell' })
      .circle(0, 0, size)
      .fill({ color: 0xffffff, alpha: ONION_SHELL_FILL_ALPHA })
      .stroke({ width: Math.max(3, size * ONION_SHELL_WIDTH), color: 0xffffff, alpha: 1 });
  });
  const core = new Graphics({ label: 'core' })
    .circle(0, 0, r * ONION_CORE)
    .fill({ color: 0xffffff, alpha: ONION_CORE_ALPHA });
  return [...shells, core];
}

/** 召喚者's three small triangles on a ring outside its collision radius; the view turns it. */
export function summonerOrbit(r: number): Container {
  const orbit = new Container({ label: 'orbit' });
  const size = r * ORBIT_TRIANGLE;
  for (let i = 0; i < ORBIT_COUNT; i++) {
    const angle = (i / ORBIT_COUNT) * TAU;
    const triangle = new Graphics()
      .regularPoly(0, 0, size, 3)
      .fill({ color: 0xffffff, alpha: ORBIT_FILL_ALPHA })
      .stroke({ width: ORBIT_LINE_WIDTH, color: 0xffffff, alpha: 1 });
    triangle.position.set(Math.cos(angle) * r * ORBIT_SCALE, Math.sin(angle) * r * ORBIT_SCALE);
    // Each points along its orbit, as if flying round.
    triangle.rotation = angle + HALF_PI;
    orbit.addChild(triangle);
  }
  return orbit;
}

/** 寶藏怪's gold glow: soft discs in `color` (its def's, gd:1040's exception), added up. */
export function treasureGlow(r: number, color: number): Graphics {
  const glow = new Graphics({ label: 'glow' })
    .circle(0, 0, r * GLOW_OUTER)
    .fill({ color, alpha: GLOW_OUTER_ALPHA })
    .circle(0, 0, r * GLOW_INNER)
    .fill({ color, alpha: GLOW_INNER_ALPHA });
  glow.blendMode = 'add';
  return glow;
}

/** 盾兵's half-circle shield on its +x side; the view turns it toward the player. */
export function shieldArc(r: number): Graphics {
  const size = r * SHIELD_ARC_SCALE;
  return new Graphics({ label: 'shield' })
    .arc(0, 0, size, -HALF_PI, HALF_PI)
    .stroke({
      width: SHIELD_ARC_WIDTH + SHIELD_ARC_BACKING,
      color: 0x000000,
      alpha: SHIELD_ARC_BACKING_ALPHA,
    })
    .arc(0, 0, size, -HALF_PI, HALF_PI)
    .stroke({ width: SHIELD_ARC_WIDTH, color: 0xffffff, alpha: 1 });
}

/** 元素護盾's thin shell around the body. */
export function wardShell(r: number): Graphics {
  return new Graphics({ label: 'ward' })
    .circle(0, 0, r * WARD_SHELL_SCALE)
    .fill({ color: 0xffffff, alpha: WARD_SHELL_FILL_ALPHA })
    .stroke({ width: WARD_SHELL_WIDTH, color: 0xffffff, alpha: WARD_SHELL_ALPHA });
}

/** 守護's faint ring at GUARD_RADIUS, the reach the sim gives its shield (affixes.ts). */
export function guardRing(): Graphics {
  return new Graphics({ label: 'guard' })
    .circle(0, 0, GUARD_RADIUS)
    .fill({ color: 0xffffff, alpha: GUARD_FILL_ALPHA })
    .stroke({ width: GUARD_RING_WIDTH, color: 0xffffff, alpha: GUARD_RING_ALPHA });
}

/** Draws an affix's symbol into g, centered, `s` from its center to its edge. */
export type SymbolDrawer = (g: Graphics, s: number) => void;

const LINE = {
  width: SYMBOL_STROKE,
  color: 0xffffff,
  alpha: 1,
  cap: 'round',
  join: 'round',
} as const;
const SOLID = { color: 0xffffff, alpha: 1 } as const;

/**
 * Every affix's symbol (gd:703 and the lead's ruling P3), white geometry only: 迅捷 a double
 * chevron, 堅甲 a plate, 再生 a cross, 守護 an arc, 增殖 twin squares, 狂暴 a spike, 元素護盾 a
 * diamond outline, 冰霜 six spokes. Each is drawn in a box of half-size s: the fractions of s
 * below are the glyph's outline, its shape; SYMBOL_SIZE sizes them all.
 */
export const AFFIX_SYMBOLS: Readonly<Record<AffixId, SymbolDrawer>> = {
  swift: (g, s) => {
    g.poly([-s, -s * 0.8, -s * 0.1, 0, -s, s * 0.8], false).stroke(LINE);
    g.poly([0, -s * 0.8, s * 0.9, 0, 0, s * 0.8], false).stroke(LINE);
  },
  armoured: (g, s) => {
    g.roundRect(-s * 0.85, -s, s * 1.7, s * 2, s * 0.3)
      .fill({ color: 0xffffff, alpha: SYMBOL_PLATE_ALPHA })
      .stroke(LINE);
    g.moveTo(-s * 0.85, -s * 0.2)
      .lineTo(s * 0.85, -s * 0.2)
      .stroke(LINE);
  },
  regen: (g, s) => {
    g.poly(crossPoints(s, s * 0.32)).fill(SOLID);
  },
  guardian: (g, s) => {
    g.arc(0, s * 0.45, s, Math.PI, TAU).stroke(LINE);
  },
  multiply: (g, s) => {
    g.rect(-s, -s, s * 1.15, s * 1.15).stroke(LINE);
    g.rect(-s * 0.15, -s * 0.15, s * 1.15, s * 1.15).stroke(LINE);
  },
  berserk: (g, s) => {
    g.poly([0, -s * 1.15, s * 0.45, s, -s * 0.45, s]).fill(SOLID);
  },
  ward: (g, s) => {
    g.poly([0, -s, s * 0.75, 0, 0, s, -s * 0.75, 0]).stroke(LINE);
  },
  frost: (g, s) => {
    for (let k = 0; k < 6; k++) {
      const angle = (k / 6) * TAU - HALF_PI;
      g.moveTo(0, 0).lineTo(Math.cos(angle) * s, Math.sin(angle) * s);
    }
    g.stroke(LINE);
  },
};

/**
 * The symbols of an enemy's affix bits (EnemyV3View.affixes: bit i is AFFIX_IDS[i]), one Graphics
 * each in AFFIX_IDS order, labelled by affix, side by side and centered on the row's origin.
 */
export function symbolRow(bits: number): Container {
  const row = new Container({ label: 'affixes' });
  const ids = AFFIX_IDS.filter((_, i) => (bits & (1 << i)) !== 0);
  ids.forEach((id, i) => {
    const g = new Graphics({ label: id });
    AFFIX_SYMBOLS[id](g, SYMBOL_SIZE);
    g.position.set((i - (ids.length - 1) / 2) * SYMBOL_STEP, 0);
    row.addChild(g);
  });
  return row;
}
