/**
 * Hits (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2–3): a shared function, not a
 * phase. A projectile that arrives resolves its attack at once: the primary hit, then
 * instant chain jumps; each hit rolls crit and ignite, deals damage, and kills or ignites.
 * Chances, the crit multiplier and the damage multiplier are the scoped stats of the hit's own
 * ModTable row (its tags and source), so tagged and scaling modifiers such as the bridge
 * notables' apply per hit. Every damage instance, hits and burn ticks alike, goes into the run's
 * tallies through tally.
 */

import type { Num } from '../../core/num';
import { add, assertFinite, gt, lte, mul, sub, ZERO } from '../../core/num';
import { DAMAGE_TAG_BIT } from '../../data/stats';
import { DOT_MASK } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import { statAt } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import { rowKey } from '../build/sources';
import { addBurn } from './burn';
import { ATTACK_SOURCE, clamp01, rollCount } from './context';
import type { Enemy, RunContext } from './context';
import { killEnemy } from './death';

const HIT = DAMAGE_TAG_BIT.hit;
const CRIT = DAMAGE_TAG_BIT.crit;
const BURN = DAMAGE_TAG_BIT.burn;
const CHAIN = DAMAGE_TAG_BIT.chain;
const POISON = DAMAGE_TAG_BIT.poison;

const DAMAGE = SCOPED_INDEX.damage;
const CRIT_CHANCE = SCOPED_INDEX.critChance;
const CRIT_MULTIPLIER = SCOPED_INDEX.critMultiplier;
const IGNITE_CHANCE = SCOPED_INDEX.igniteChance;
const CRIT_ALWAYS = SCOPED_INDEX.critAlways;
const IGNITE_ALWAYS = SCOPED_INDEX.igniteAlways;

/**
 * Adds a damage instance with these tags, credited to `source`, to the run's tallies: the
 * damage breakdown (burn, poison or bleed by kind; otherwise crit, then chain, then hit) and
 * the source's total.
 */
export function tally(ctx: RunContext, tags: TagMask, source: number, amount: Num): void {
  if ((tags & DOT_MASK) !== 0) {
    if ((tags & BURN) !== 0) ctx.damageBurn = add(ctx.damageBurn, amount);
    else if ((tags & POISON) !== 0) ctx.damagePoison = add(ctx.damagePoison, amount);
    else ctx.damageBleed = add(ctx.damageBleed, amount);
  } else if ((tags & CRIT) !== 0) ctx.damageCrit = add(ctx.damageCrit, amount);
  else if ((tags & CHAIN) !== 0) ctx.damageChain = add(ctx.damageChain, amount);
  else ctx.damageHit = add(ctx.damageHit, amount);
  ctx.bySource[source] = add(ctx.bySource[source] as Num, amount);
}

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
 * Primary hit, then instant chain jumps from the last hit position. A steady shot
 * (steadyAim) crits on every hit, chain jumps included.
 */
export function resolveAttack(ctx: RunContext, primary: Enemy, steady: boolean): void {
  ctx.attackSerial++;
  hitEnemy(ctx, primary, 0, 1, null, null, steady);
  const jumps = rollCount(ctx.chainCount, (p) => ctx.combatRng.chance(p));
  let fromX = primary.x;
  let fromY = primary.y;
  let retention = 1;
  for (let k = 1; k <= jumps; k++) {
    const next = nearestChainTarget(ctx, fromX, fromY);
    if (next === null) break;
    retention *= ctx.chainRetention;
    hitEnemy(ctx, next, k, retention, fromX, fromY, steady);
    fromX = next.x;
    fromY = next.y;
  }
}

/** The attack's ModTable row for hits with these tags, cached in `slot` of ctx.hitRows. */
function hitRow(ctx: RunContext, slot: number, mask: TagMask): number {
  const cached = ctx.hitRows[slot] as number;
  if (cached >= 0) return cached;
  const row = ctx.table.row(rowKey(mask, ATTACK_SOURCE));
  ctx.hitRows[slot] = row;
  return row;
}

function hitEnemy(
  ctx: RunContext,
  enemy: Enemy,
  chainIndex: number,
  retention: number,
  fromX: number | null,
  fromY: number | null,
  steady: boolean,
): void {
  const build = ctx.build;
  const table = ctx.table;
  // The crit roll reads the hit's row without the crit tag, the rest the row of its outcome.
  const plain = chainIndex > 0 ? HIT | CHAIN : HIT;
  const slot = chainIndex > 0 ? 2 : 0;
  const plainRow = hitRow(ctx, slot, plain);
  // steadyAim turns random crits off, Static Focus's per-jump chance included.
  const chance = build.flags.randomCrits
    ? clamp01(statAt(table, plainRow, CRIT_CHANCE, chainIndex))
    : 0;
  const crit =
    ctx.combatRng.chance(chance) || steady || statAt(table, plainRow, CRIT_ALWAYS, chainIndex) > 0;
  const mask = crit ? plain | CRIT : plain;
  const row = crit ? hitRow(ctx, slot + 1, mask) : plainRow;
  // An *Always stat forces the outcome after the roll is drawn (Searing Crits on crits).
  const ignites =
    ctx.combatRng.chance(clamp01(statAt(table, row, IGNITE_CHANCE, chainIndex))) ||
    statAt(table, row, IGNITE_ALWAYS, chainIndex) > 0;
  const critMultiplier = crit ? statAt(table, row, CRIT_MULTIPLIER, chainIndex) : 1;
  const baseHit = mul(ctx.damage, critMultiplier * retention);
  const amount = assertFinite(
    mul(baseHit, statAt(table, row, DAMAGE, chainIndex) * build.legacyHitMult),
    'hit damage',
  );
  enemy.hp = sub(enemy.hp, amount);
  enemy.hitMark = ctx.attackSerial;
  tally(ctx, mask, ATTACK_SOURCE, amount);
  if (gt(amount, ctx.maxHit)) ctx.maxHit = amount;
  ctx.events.push({
    type: 'hit',
    targetId: enemy.id,
    x: enemy.x,
    y: enemy.y,
    amount,
    tags: mask,
    source: ATTACK_SOURCE,
    crit,
    chainIndex,
    fromX,
    fromY,
  });
  if (lte(enemy.hp, ZERO)) {
    killEnemy(ctx, enemy, -1);
  } else if (ignites && ctx.burnTicks > 0) {
    addBurn(
      ctx,
      enemy,
      mul(baseHit, ctx.burnDamage * (crit ? ctx.burnCritMult : ctx.burnMult)),
      ctx.now + ctx.burnTicks,
    );
  }
}
