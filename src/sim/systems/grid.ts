/**
 * Grid system (docs/v3/implementation-plan-v3.md §2.3, §2.15): right after movement, hands
 * the enemies to the uniform spatial grid (src/sim/grid.ts) for the target queries of the
 * rest of the tick: projectile targets, shot paths, chain jumps and pandemic spread. The grid
 * sorts them into its cells at the tick's first query, with the positions of this tick; ticks
 * without queries skip the sort, and so do ticks with fewer than GRID_LINEAR_BELOW enemies,
 * whose queries scan them linearly, unless many straight shots fly (projectiles.ts). Enemies
 * that die later in the tick stay in their cells and are skipped; enemies added later in the
 * tick (split children) are scanned linearly by every query. A push effect that moves enemies
 * later in the tick rebuilds again (effects/execute.ts), so the queries after it in the same tick
 * see the new positions. The sort waits for the next query: only the first query after a push's
 * move sorts, the queries after it share that sort, and a push that moved nothing does not rebuild.
 */

import { SpatialGrid } from '../grid';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';
import type { Enemy, RunContext } from './context';

/** Cell size of the enemy grid in arena units: 15 × 9 cells, plus the outer ring. */
export const GRID_CELL_SIZE = 128;

/**
 * Fewer enemies than this are not sorted into the cells: the queries scan them linearly,
 * which measured faster up to about this many (`npm run bench` has about 70 alive).
 */
export const GRID_LINEAR_BELOW = 128;

export const createEnemyGrid = (): SpatialGrid<Enemy> =>
  new SpatialGrid<Enemy>(ARENA_WIDTH, ARENA_HEIGHT, GRID_CELL_SIZE, GRID_LINEAR_BELOW);

/** Elites and bosses, the only enemies that can be focus targets (`focused`), are marked. */
const isTough = (enemy: Enemy): boolean => enemy.tough;

export function rebuildGrid(ctx: RunContext): void {
  ctx.grid.rebuild(ctx.enemies, isTough);
}
