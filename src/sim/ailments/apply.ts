/**
 * Applying and moving ailments (docs/v3/implementation-plan-v3.md §2.5): the one place that
 * knows where each ailment lives. Burn goes to capped records (records.ts), or to DoT rings
 * under eternalFlame (BuildFlags.burnRings); poison always to rings (rings.ts); bleed to its
 * strongest-only slot (bleed.ts); shock to its stacks (shock.ts). Each ailment's damage is
 * credited through ailmentCredit, from the source of what applied it, and a ring of each source
 * class holds it (a fusion ring credits the first fusion that applied to it).
 *
 * Hits (src/sim/combat/hit.ts) and the applyAilment and spreadAilment effects
 * (src/sim/effects/execute.ts) call these and raise ailmentApplied themselves. A dead or leaked
 * enemy gives its rings back (releaseAilments), and targeting asks whether the damage over time
 * on an enemy will kill it (doomed).
 */

import type { Num } from '../../core/num';
import { add, lte, mul, num, ZERO } from '../../core/num';
import type { AilmentKind } from '../../data/triggers';
import { statAt } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { ailmentCredit } from '../build/sources';
import { orderNearest } from '../effects/select';
import { slotRow } from '../emitters/types';
import type { Payload } from '../emitters/types';
import type { Enemy, RunContext } from '../systems/context';
import { bleedLeft } from './bleed';
import { addBurn, addBurnIfStronger, recordsLeft, spreadBurns } from './records';
import type { BurnSpread } from './records';
import { RING_BURN, RING_POISON, RING_SLOTS } from './rings';

const DAMAGE = SCOPED_INDEX.damage;

/** The credit of a `kind` ailment applied by payload `p` (its source is the applier). */
export const creditOf = (ctx: RunContext, kind: AilmentKind, p: Payload): number =>
  ailmentCredit(ctx.sources, ctx.attribution, kind, p.source);

/**
 * Damage per second of an ailment with damage stat `perHit` (burnDamage, poisonDamage,
 * bleedDamage) that a hit of `base` applies through payload slot `slot`: base × perHit × the
 * slot row's damage, read at chain jump 0 on `enemy` (the row's `when` bonuses are a snapshot).
 */
export function ailmentDps(
  ctx: RunContext,
  enemy: Enemy,
  p: Payload,
  slot: number,
  base: Num,
  perHit: number,
): Num {
  const ev = ctx.evalInput;
  ev.now = ctx.now;
  ev.target = enemy;
  ev.chainJump = 0;
  return mul(base, perHit * statAt(ctx.table, slotRow(ctx.build, p, slot), DAMAGE, ev));
}

/** The enemy's ring of Enemy.rings slot `slot` crediting `credit`, taken from the pool if new. */
function ringFor(ctx: RunContext, enemy: Enemy, slot: number, credit: number): number {
  const r = enemy.rings[slot] as number;
  if (r >= 0) return r;
  const ring = ctx.rings.alloc(slot % 3, credit);
  enemy.rings[slot] = ring;
  enemy.dotRings++;
  return ring;
}

/** Recounts the live stacks of the enemy's rings of one ailment (Enemy.burnStacks, poisonStacks). */
export function syncRingStacks(ctx: RunContext, enemy: Enemy, first: number): void {
  const rings = enemy.rings;
  const stacks = ctx.rings.stacks;
  let live = 0;
  for (let c = first; c < first + 3; c++) {
    const r = rings[c] as number;
    if (r >= 0) live += stacks[r] as number;
  }
  if (first === RING_BURN) enemy.burnStacks = live;
  else enemy.poisonStacks = live;
}

/** The latest end of the enemy's stacks of one ailment in rings (Enemy.burnRingEnd, poisonRingEnd). */
const ringEnd = (enemy: Enemy, first: number): number =>
  first === RING_BURN ? enemy.burnRingEnd : enemy.poisonRingEnd;

/** Ring `r` of the enemy's rings of one ailment now has stacks until its end. */
function extendRingEnd(ctx: RunContext, enemy: Enemy, first: number, r: number): void {
  const end = ctx.rings.end[r] as number;
  if (end <= ringEnd(enemy, first)) return;
  if (first === RING_BURN) enemy.burnRingEnd = end;
  else enemy.poisonRingEnd = end;
}

/** `n` stacks of `dps` until tick `end` in the enemy's ring for `credit`'s class. */
function addToRing(
  ctx: RunContext,
  enemy: Enemy,
  first: number,
  credit: number,
  dps: Num,
  end: number,
  n: number,
  depth: number,
): void {
  const slot = first + (ctx.sources.cls[credit] as number);
  const r = ringFor(ctx, enemy, slot, credit);
  ctx.rings.apply(r, dps, ctx.now, end, n);
  extendRingEnd(ctx, enemy, first, r);
  syncRingStacks(ctx, enemy, first);
  if (depth < enemy.ailDepth) enemy.ailDepth = depth;
}

/** `n` burn stacks of `dps` until tick `end`, credited to `credit`, at trigger depth `depth`. */
export function applyBurn(
  ctx: RunContext,
  enemy: Enemy,
  dps: Num,
  end: number,
  depth: number,
  credit: number,
  n: number,
): void {
  if (!ctx.burnRings) {
    for (let s = 0; s < n; s++) addBurn(ctx, enemy, dps, end, depth, credit);
    return;
  }
  addToRing(ctx, enemy, RING_BURN, credit, dps, end, n, depth);
  ctx.events.push({ type: 'ignite', targetId: enemy.id, stacks: enemy.burnStacks });
}

/**
 * `n` burn stacks a zone causes (src/sim/systems/zones.ts: a zone or aura pulse hit's one, or a
 * zone's own burn term's): applyBurn's, except that at the records cap each stack replaces the
 * weakest of the stacks then held, the term's earlier ones included, only when stronger
 * (addBurnIfStronger, Hoshi's Q4/F4). Rings have no cap, so under burnRings they always join
 * one. Returns whether any stack was applied.
 */
export function applyPulseBurn(
  ctx: RunContext,
  enemy: Enemy,
  dps: Num,
  end: number,
  depth: number,
  credit: number,
  n: number,
): boolean {
  if (!ctx.burnRings) {
    let applied = false;
    for (let s = 0; s < n; s++) {
      if (addBurnIfStronger(ctx, enemy, dps, end, depth, credit)) applied = true;
    }
    return applied;
  }
  applyBurn(ctx, enemy, dps, end, depth, credit, n);
  return true;
}

/** `n` poison stacks of `dps` until tick `end`, credited to `credit`, at trigger depth `depth`. */
export function applyPoison(
  ctx: RunContext,
  enemy: Enemy,
  dps: Num,
  end: number,
  depth: number,
  credit: number,
  n: number,
): void {
  addToRing(ctx, enemy, RING_POISON, credit, dps, end, n, depth);
  ctx.events.push({
    type: 'ailmentApplied',
    targetId: enemy.id,
    ailment: 'poison',
    stacks: enemy.poisonStacks,
  });
}

/**
 * Moves the burn or poison of `source`'s rings (first: RING_BURN or RING_POISON) to every
 * other alive enemy within `radiusSq` of it, `maxTargets` of them at most: the first in id order,
 * or with `nearest` the nearest to `source`, nearest first (ties by id), each as moveRings gives
 * it. Returns the enemies reached, or −1 when `source` holds no such stack.
 */
function spreadRings(
  ctx: RunContext,
  source: Enemy,
  first: number,
  radiusSq: number,
  f: number,
  sf: number,
  maxTargets: number,
  depth: number,
  nearest: boolean,
): number {
  // As spreadBurns: only stacks that have not ended move, and none means no spread.
  if (ringEnd(source, first) <= ctx.now) return -1;
  // In id order, or nearest first; moving stacks kills nothing, so collecting the targets first
  // changes nothing.
  const targets = ctx.spreadTargets;
  let count = ctx.grid.within(source.x, source.y, radiusSq, targets);
  if (nearest && maxTargets < count) {
    count = orderNearest(targets, count, maxTargets, source.x, source.y, source);
  }
  let spreadTo = 0;
  for (let i = 0; i < count && spreadTo < maxTargets; i++) {
    const enemy = targets[i] as Enemy;
    if (enemy === source) continue;
    moveRings(ctx, source, enemy, first, f, sf, depth);
    spreadTo++;
  }
  return spreadTo;
}

/**
 * Gives `enemy` the burn or poison of `source`'s rings (first: RING_BURN or RING_POISON): `f`
 * of their damage left and floor(sf × their live stacks) stack counts, keeping each ring's
 * class and credit, at trigger depth `depth`. A ring whose stacks have all ended moves nothing.
 */
function moveRings(
  ctx: RunContext,
  source: Enemy,
  enemy: Enemy,
  first: number,
  f: number,
  sf: number,
  depth: number,
): void {
  const pool = ctx.rings;
  const now = ctx.now;
  const from = source.rings;
  for (let slot = first; slot < first + 3; slot++) {
    const r = from[slot] as number;
    if (r < 0 || (pool.end[r] as number) <= now) continue;
    // A new ring may grow the pool: take it before reading the pool's arrays.
    const d = ringFor(ctx, enemy, slot, pool.credit[r] as number);
    pool.spread(r, d, f, sf, now);
    extendRingEnd(ctx, enemy, first, d);
  }
  syncRingStacks(ctx, enemy, first);
  if (depth < enemy.ailDepth) enemy.ailDepth = depth;
}

/**
 * toSplitChildren (kill step 2b, src/sim/systems/death.ts): each of the children `source` split
 * into, ctx.enemies[first .. end), takes `f` of its poison's damage left and of its live stacks
 * (moveRings), at trigger depth `depth`; no grid query, no target cap, no event. Nothing moves
 * once its poison stacks have all ended.
 */
export function spreadPoisonToChildren(
  ctx: RunContext,
  source: Enemy,
  first: number,
  end: number,
  f: number,
  depth: number,
): void {
  if (source.poisonRingEnd <= ctx.now) return;
  const enemies = ctx.enemies;
  for (let i = first; i < end; i++) {
    moveRings(ctx, source, enemies[i] as Enemy, RING_POISON, f, f, depth);
  }
}

/**
 * spreadAilment's burn: records as M1's Pandemic copies them (spreadBurns), or under
 * eternalFlame the rings, each stack at `effect` of its damage. Both raise 'burnSpread'.
 */
export function spreadBurn(
  ctx: RunContext,
  source: Enemy,
  spread: BurnSpread,
  depth: number,
): void {
  if (!ctx.burnRings) {
    spreadBurns(ctx, source, spread, depth);
    return;
  }
  const targets = spreadRings(
    ctx,
    source,
    RING_BURN,
    spread.radiusSq,
    spread.effect,
    1,
    Infinity,
    depth,
    false,
  );
  if (targets < 0) return;
  ctx.events.push({
    type: 'burnSpread',
    enemyId: source.id,
    x: source.x,
    y: source.y,
    radius: spread.radius,
    targets,
  });
}

/**
 * spreadAilment's poison: `stacks` (sf) of the source's poison stacks, the longest-lasting
 * first, with that share × `effect` of their damage left, to at most `maxTargets` enemies: the
 * first in id order, or with `nearest` the nearest to the source, nearest first.
 */
export function spreadPoison(
  ctx: RunContext,
  source: Enemy,
  spread: BurnSpread,
  sf: number,
  maxTargets: number,
  depth: number,
  nearest = false,
): void {
  const targets = spreadRings(
    ctx,
    source,
    RING_POISON,
    spread.radiusSq,
    spread.effect * sf,
    sf,
    maxTargets,
    depth,
    nearest,
  );
  if (targets < 0) return;
  ctx.events.push({
    type: 'ailmentSpread',
    ailment: 'poison',
    enemyId: source.id,
    x: source.x,
    y: source.y,
    radius: spread.radius,
    targets,
  });
}

/** A dead or leaked enemy gives its DoT rings back to the pool. */
export function releaseAilments(ctx: RunContext, enemy: Enemy): void {
  if (enemy.dotRings === 0) return;
  const rings = enemy.rings;
  for (let slot = 0; slot < RING_SLOTS; slot++) {
    const r = rings[slot] as number;
    if (r < 0) continue;
    ctx.rings.release(r);
    rings[slot] = -1;
  }
  enemy.dotRings = 0;
  enemy.poisonStacks = 0;
  enemy.burnRingEnd = 0;
  enemy.poisonRingEnd = 0;
  if (ctx.burnRings) enemy.burnStacks = 0;
}

/**
 * Damage the enemy's rings of one ailment have yet to deal, as A2's records term counts it:
 * nothing once all their stacks have ended. Burn records leave the enemy when the ailments step
 * of the tick they end in expires them, so targeting earlier in that tick still counts them;
 * a ring's stacks count until the same point (ending after the previous tick).
 */
function ringsLeft(ctx: RunContext, enemy: Enemy, first: number): number {
  if (!(ringEnd(enemy, first) > ctx.now - 1)) return 0;
  const rings = enemy.rings;
  const remaining = ctx.rings.remaining;
  let left = 0;
  for (let slot = first; slot < first + 3; slot++) {
    const r = rings[slot] as number;
    if (r >= 0) left += remaining[r] as number;
  }
  return left;
}

/**
 * The damage over time already on the enemy will kill it: shots should go elsewhere. Its burn
 * records with what they have pending (nothing without a live record; A2), its rings (likewise
 * nothing without a live stack) and its bleed; with only records this is M1's sum.
 */
export function doomed(ctx: RunContext, enemy: Enemy): boolean {
  const records = enemy.burns.length !== 0;
  if (!records && enemy.dotRings === 0 && enemy.bleedUntil === 0) return false;
  let left = records ? recordsLeft(ctx, enemy) : ZERO;
  if (enemy.dotRings !== 0) {
    left = add(left, num(ringsLeft(ctx, enemy, RING_BURN) + ringsLeft(ctx, enemy, RING_POISON)));
  }
  if (enemy.bleedUntil !== 0) left = add(left, bleedLeft(ctx, enemy));
  return lte(enemy.hp, left);
}
