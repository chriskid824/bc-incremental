/**
 * Chains (docs/GDD.md §2–3): an attack's primary hit, then instant chain jumps from the last hit
 * position to the nearest enemy the attack has not hit yet, each keeping chainRetention of the
 * one before (src/sim/combat/hit.ts). An attack runs between beginAttack and endAttack: its
 * serial marks the enemies it hits, and its budget counts its hits against CHAIN_HIT_CAP
 * (src/sim/caps.ts).
 */

import { CHAIN_HIT_CAP } from '../caps';
import { PRIMARY } from '../effects/flags';
import type { Payload } from '../emitters/types';
import { rollCount } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { hitWithPayload } from './hit';

/**
 * Alive enemy closest to (x, y) within chain range (inclusive) not hit by the current attack;
 * the lower id on ties. While the grid scans linearly (few enemies), the scan runs here with
 * the hit check inlined, which is faster than nearest() through a predicate.
 */
export function nearestChainTarget(ctx: RunContext, x: number, y: number): Enemy | null {
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
 * Starts an attack: the next attack serial, which the enemies it hits carry (hitMark), and an
 * empty chain budget.
 */
export function beginAttack(ctx: RunContext): void {
  ctx.attackSerial++;
  const budget = ctx.chainBudget;
  budget.hits = 0;
  budget.extraJumps = 0;
  budget.centerEvents = 0;
}

/** Ends the current attack: its hits update the chainHitsPeak gauge. */
export function endAttack(ctx: RunContext): void {
  const counters = ctx.counters;
  const hits = ctx.chainBudget.hits;
  if (hits > counters.chainHitsPeak) counters.chainHitsPeak = hits;
}

/**
 * The current attack's primary hit of payload `p` on `enemy` at `scale`: it counts as one of
 * the attack's hits and carries PRIMARY. `steady`, `depth` and `origin` as in chainAttack.
 */
export function primaryHit(
  ctx: RunContext,
  p: Payload,
  enemy: Enemy,
  scale: number,
  steady: boolean,
  depth: number,
  origin: number,
): void {
  ctx.chainBudget.hits++;
  hitWithPayload(ctx, enemy, p, 0, scale, null, null, steady, depth, origin, PRIMARY);
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
  beginAttack(ctx);
  primaryHit(ctx, p, primary, 1, steady, depth, origin);
  if (p.chains) chainFrom(ctx, p, primary, count, steady, depth, origin);
  endAttack(ctx);
}

/**
 * The current attack's chain from `from`: `count` jumps (its fraction is the chance of one
 * more, rolled on the payload's stream), each to the nearest enemy the attack has not hit,
 * until none is left in range. Once the attack has dealt CHAIN_HIT_CAP hits, the jumps left
 * are refused and counted in chainHitCapped.
 */
export function chainFrom(
  ctx: RunContext,
  p: Payload,
  from: Enemy,
  count: number,
  steady: boolean,
  depth: number,
  origin: number,
): void {
  const rng = p.rng;
  const jumps = rollCount(count, (c) => rng.chance(c));
  const budget = ctx.chainBudget;
  let fromX = from.x;
  let fromY = from.y;
  let retention = 1;
  for (let k = 1; k <= jumps; k++) {
    if (budget.hits >= CHAIN_HIT_CAP) {
      ctx.counters.chainHitCapped += jumps - k + 1;
      break;
    }
    const next = nearestChainTarget(ctx, fromX, fromY);
    if (next === null) break;
    retention *= ctx.chainRetention;
    budget.hits++;
    hitWithPayload(ctx, next, p, k, retention, fromX, fromY, steady, depth, origin);
    fromX = next.x;
    fromY = next.y;
  }
}
