/**
 * Projectile target selection (docs/GDD.md §2.3, §2.4). Projectiles home on one enemy;
 * choosing targets that projectiles already in flight will not kill spreads the attacks, so
 * attack speed is not wasted on overkill. Focus targets (elites and bosses close to the
 * player) come first: in a swarm the nearest enemy is nearly always a small one, and the
 * tough target would walk in untouched.
 * pickTarget scans every target and is the reference; the simulation uses pickTargetInGrid,
 * which picks the same target through the spatial grid (src/sim/grid.ts).
 */

import type { Num } from '../core/num';
import { lte, mul } from '../core/num';
import type { SpatialGrid } from './grid';

/** What target selection needs to know about an enemy. */
export interface Targetable {
  readonly x: number;
  readonly y: number;
  readonly hp: Num;
  readonly alive: boolean;
  /** Projectiles in flight towards this enemy. */
  readonly inbound: number;
}

/**
 * True when the projectiles in flight towards the target, each expected to deal `estimate`,
 * add up to at least its current hp.
 */
export const isCovered = (target: Targetable, estimate: Num): boolean =>
  target.inbound > 0 && lte(target.hp, mul(estimate, target.inbound));

/**
 * Elites and bosses at most this far from the player are focus targets
 * (docs/GDD.md §2.4): shots go to them before any other enemy.
 */
export const FOCUS_RANGE = 800;

/**
 * Alive target closest to (x, y) that is not covered, preferring targets for which `focus`
 * returns true; when every alive target is covered, the closest alive one. Targets for which
 * `avoid` returns true count as covered (used to spread one volley over different enemies).
 * Earlier entries win ties, so arrays ordered by id prefer the lower id. Null when no target
 * is alive. Allocation-free.
 */
export function pickTarget<T extends Targetable>(
  targets: readonly T[],
  x: number,
  y: number,
  estimate: Num,
  avoid?: (target: T) => boolean,
  focus?: (target: T) => boolean,
): T | null {
  let focused: T | null = null;
  let focusedDistSq = Infinity;
  let uncovered: T | null = null;
  let uncoveredDistSq = Infinity;
  let closest: T | null = null;
  let closestDistSq = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i] as T;
    if (!target.alive) continue;
    const dx = target.x - x;
    const dy = target.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq < closestDistSq) {
      closest = target;
      closestDistSq = distSq;
    }
    const isFocus = focus !== undefined && focus(target);
    if (
      (distSq < uncoveredDistSq || (isFocus && distSq < focusedDistSq)) &&
      !isCovered(target, estimate) &&
      (avoid === undefined || !avoid(target))
    ) {
      if (distSq < uncoveredDistSq) {
        uncovered = target;
        uncoveredDistSq = distSq;
      }
      if (isFocus && distSq < focusedDistSq) {
        focused = target;
        focusedDistSq = distSq;
      }
    }
  }
  return focused ?? uncovered ?? closest;
}

/**
 * pickTarget over a spatial grid (src/sim/grid.ts) instead of every target: returns exactly
 * what pickTarget(the grid's source, x, y, estimate, avoid, focus) returns, provided that
 * - `shootable(target)` is `!isCovered(target, estimate) && !avoid(target)`, and
 * - `focus` returns true only for targets that the grid's `mark` accepts (SpatialGrid.rebuild).
 *   Focus targets are few, so only the marked targets are scanned for them.
 * The predicates must be pure: they are asked in another order and another number of times
 * than pickTarget asks them. A source too small for the grid's cells gets pickTarget's single
 * pass instead. Allocation-free.
 */
export function pickTargetInGrid<T extends Targetable>(
  grid: SpatialGrid<T>,
  x: number,
  y: number,
  shootable: (target: T) => boolean,
  focus?: (target: T) => boolean,
): T | null {
  const targets = grid.linearSource();
  if (targets !== null) return scanForTarget(targets, x, y, shootable, focus);
  if (focus !== undefined) {
    // Marked targets come in source order, so strict < keeps the earlier one on ties.
    let focused: T | null = null;
    let focusedDistSq = Infinity;
    for (let k = 0, count = grid.markedCount(); k < count; k++) {
      const target = grid.marked(k);
      if (!target.alive) continue;
      const dx = target.x - x;
      const dy = target.y - y;
      const distSq = dx * dx + dy * dy;
      if (distSq < focusedDistSq && focus(target) && shootable(target)) {
        focused = target;
        focusedDistSq = distSq;
      }
    }
    if (focused !== null) return focused;
  }
  // pickTarget only counts finite distances, i.e. at most Number.MAX_VALUE.
  return grid.nearest(x, y, Number.MAX_VALUE, shootable) ?? grid.nearest(x, y, Number.MAX_VALUE);
}

/** pickTarget's scan with `shootable` in place of `!isCovered(target, estimate) && !avoid`. */
function scanForTarget<T extends Targetable>(
  targets: readonly T[],
  x: number,
  y: number,
  shootable: (target: T) => boolean,
  focus: ((target: T) => boolean) | undefined,
): T | null {
  let focused: T | null = null;
  let focusedDistSq = Infinity;
  let uncovered: T | null = null;
  let uncoveredDistSq = Infinity;
  let closest: T | null = null;
  let closestDistSq = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i] as T;
    if (!target.alive) continue;
    const dx = target.x - x;
    const dy = target.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq < closestDistSq) {
      closest = target;
      closestDistSq = distSq;
    }
    const isFocus = focus !== undefined && focus(target);
    if ((distSq < uncoveredDistSq || (isFocus && distSq < focusedDistSq)) && shootable(target)) {
      if (distSq < uncoveredDistSq) {
        uncovered = target;
        uncoveredDistSq = distSq;
      }
      if (isFocus && distSq < focusedDistSq) {
        focused = target;
        focusedDistSq = distSq;
      }
    }
  }
  return focused ?? uncovered ?? closest;
}
