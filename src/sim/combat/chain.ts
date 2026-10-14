/**
 * Chains (docs/GDD.md §2–3): an attack's primary hit, then instant chain jumps from the last hit
 * position to the nearest enemy the attack has not hit yet, each keeping chainRetention of the
 * one before (src/sim/combat/hit.ts).
 */

import type { Payload } from '../emitters/types';
import { rollCount } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { hitWithPayload } from './hit';

/**
 * Alive enemy closest to (x, y) within chain range (inclusive) not hit by the current attack;
 * the lower id on ties. While the grid scans linearly (few enemies), the scan runs here with
 * the hit check inlined, which is faster than nearest() through a predicate.
 */
function nearestChainTarget(ctx: RunContext, x: number, y: number): Enemy | null {
  const enemies = ctx.grid.linearSource();
  if (enemies === null) return ctx.grid.nearest(x, y, ctx.chainRangeSq, ctx.chainable);
  const attackSerial = ctx.attackSerial;
  let best: Enemy | null = null;
  let bestDistSq = ctx.chainRangeSq;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as Enemy;
    if (!enemy.alive || enemy.hitMark === attackSerial) continue;
    const dx = enemy.x - x;
    const dy = enemy.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq || (distSq === bestDistSq && best === null)) {
      best = enemy;
      bestDistSq = distSq;
    }
  }
  return best;
}

/**
 * One attack of payload `p` on `primary`: the primary hit, then `count` chain jumps (its
 * fraction is the chance of one more, rolled on the payload's stream) when the payload chains.
 * A steady shot (steadyAim) crits on every hit, chain jumps included; `depth` and `origin` are
 * the trigger depth of its hits and the trigger the attack comes from (0 and −1 for emitters).
 */
export function chainAttack(
  ctx: RunContext,
  p: Payload,
  primary: Enemy,
  count: number,
  steady: boolean,
  depth: number,
  origin: number,
): void {
  ctx.attackSerial++;
  const budget = ctx.chainBudget;
  budget.hits = 1;
  budget.extraJumps = 0;
  budget.centerEvents = 0;
  hitWithPayload(ctx, primary, p, 0, 1, null, null, steady, depth, origin);
  if (!p.chains) return;
  const rng = p.rng;
  const jumps = rollCount(count, (c) => rng.chance(c));
  let fromX = primary.x;
  let fromY = primary.y;
  let retention = 1;
  for (let k = 1; k <= jumps; k++) {
    const next = nearestChainTarget(ctx, fromX, fromY);
    if (next === null) break;
    retention *= ctx.chainRetention;
    budget.hits++;
    hitWithPayload(ctx, next, p, k, retention, fromX, fromY, steady, depth, origin);
    fromX = next.x;
    fromY = next.y;
  }
}
