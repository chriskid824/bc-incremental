/**
 * Projectile target selection (docs/GDD.md §2.3). Projectiles home on one enemy; choosing
 * targets that projectiles already in flight will not kill spreads the attacks, so attack
 * speed is not wasted on overkill.
 */

import type { Num } from '../core/num';
import { lte, mul } from '../core/num';

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
 * Alive target closest to (x, y) that is not covered; when every alive target is covered,
 * the closest alive one. Earlier entries win ties, so arrays ordered by id prefer the lower
 * id. Null when no target is alive. Allocation-free.
 */
export function pickTarget<T extends Targetable>(
  targets: readonly T[],
  x: number,
  y: number,
  estimate: Num,
): T | null {
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
    if (distSq < uncoveredDistSq && !isCovered(target, estimate)) {
      uncovered = target;
      uncoveredDistSq = distSq;
    }
  }
  return uncovered ?? closest;
}
