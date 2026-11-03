/**
 * 蜂巢's floor lattice (docs/v3/game-design-v3.md §11.5 「六角格線」): pure geometry, no Pixi and
 * no DOM, so the tests reach it; the arena backdrop draws it (src/render/backdrop.ts).
 */

/** Pointy-top hexagons of this circumradius, one centered on the player. */
export const COMB_CELL = 44;
/** Every this many rings of cells around the center, a ring is drawn a little brighter. */
export const COMB_HOT_EVERY = 4;

export interface CombCell {
  readonly x: number;
  readonly y: number;
  /** Hex distance from the center cell (0). */
  readonly ring: number;
}

/**
 * The comb's cells whose hexagon of circumradius `size` overlaps the `width` × `height` arena,
 * on a lattice with a cell centered on (cx, cy): axial (q, r) at x = √3·size·(q + r/2),
 * y = 1.5·size·r, each with its hex distance from the center.
 */
export function combCells(
  width: number,
  height: number,
  cx: number,
  cy: number,
  size: number,
): CombCell[] {
  const cells: CombCell[] = [];
  const w = Math.sqrt(3) * size;
  const rows = Math.ceil((Math.max(cy, height - cy) + size) / (1.5 * size));
  for (let r = -rows; r <= rows; r++) {
    const y = cy + 1.5 * size * r;
    const qFrom = Math.floor((-size - cx) / w - r / 2);
    const qTo = Math.ceil((width + size - cx) / w - r / 2);
    for (let q = qFrom; q <= qTo; q++) {
      const x = cx + w * (q + r / 2);
      if (x < -size || x > width + size || y < -size || y > height + size) continue;
      cells.push({ x, y, ring: (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2 });
    }
  }
  return cells;
}
