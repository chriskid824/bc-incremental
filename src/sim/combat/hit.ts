/**
 * Hits (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2–3): one damage instance of a
 * payload on one enemy, shared by emitter hits and chain jumps. A hit rolls crit, then its
 * ailments, deals damage, and kills or applies the ailments it rolled. Chances, the crit
 * multiplier and the damage multiplier are the scoped stats of the hit's own ModTable row (the
 * payload's slot for its tags and source), so tagged, scoped and scaling modifiers apply per
 * hit. Every damage instance, hits and burn ticks alike, goes into the run's tallies through
 * tally.
 */

import type { Num } from '../../core/num';
import { add, assertFinite, gt, lte, mul, sub, ZERO } from '../../core/num';
import { DOT_MASK, jumpMask, TAG } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import { statAt } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import {
  PRESCALED,
  SLOT_BURN,
  SLOT_BURN_CRIT,
  SLOT_HIT,
  SLOT_JUMP,
  slotRow,
} from '../emitters/types';
import type { Payload } from '../emitters/types';
import { addBurn } from '../systems/burn';
import { clamp01 } from '../systems/context';
import type { Enemy, RunContext } from '../systems/context';
import { killEnemy } from '../systems/death';

const CRIT = TAG.crit;
const BURN = TAG.burn;
const CHAIN = TAG.chain;
const POISON = TAG.poison;

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
 * Hit `k` of an attack's chain (0 for the primary hit) of payload `p` on `enemy`: `scale` is
 * the chain retention so far, (fromX, fromY) the previous hit's position (null for the primary
 * hit), `forced` a steady shot's sure crit, `origin` the trigger the damage comes from (−1 for
 * emitter hits). A primary hit has the payload's tags and source, a jump jumpMask of the tags
 * and the payload's jumpSource; the ailments either applies are credited from the payload's
 * source.
 */
export function hitWithPayload(
  ctx: RunContext,
  enemy: Enemy,
  p: Payload,
  k: number,
  scale: number,
  fromX: number | null,
  fromY: number | null,
  forced: boolean,
  origin: number,
): void {
  const build = ctx.build;
  const table = ctx.table;
  const jump = k > 0;
  const slot = jump ? SLOT_JUMP : SLOT_HIT;
  const plain = jump ? jumpMask(p.tags) : p.tags;
  // The crit roll reads the hit's row without the crit tag, the rest the row of its outcome.
  const plainRow = slotRow(build, p, slot);
  // steadyAim turns random crits off, Static Focus's per-jump chance included; a payload that
  // cannot crit skips forced crits and critAlways too.
  const chance =
    build.flags.randomCrits && p.canCrit ? clamp01(statAt(table, plainRow, CRIT_CHANCE, k)) : 0;
  const crit =
    p.canCrit && (p.rng.chance(chance) || forced || statAt(table, plainRow, CRIT_ALWAYS, k) > 0);
  const row = crit ? slotRow(build, p, slot + 1) : plainRow;
  // An *Always stat forces the outcome after the roll is drawn (Searing Crits on crits).
  const ignites =
    p.rollsAilments &&
    (p.rng.chance(clamp01(statAt(table, row, IGNITE_CHANCE, k))) ||
      statAt(table, row, IGNITE_ALWAYS, k) > 0);
  const critMultiplier = crit ? statAt(table, row, CRIT_MULTIPLIER, k) : 1;
  const base = mul(p.baseDamage, critMultiplier * scale);
  const amount = assertFinite(
    p.damageMode === PRESCALED
      ? base
      : mul(base, statAt(table, row, DAMAGE, k) * build.legacyHitMult),
    'hit damage',
  );
  applyHitDamage(
    ctx,
    enemy,
    amount,
    crit ? plain | CRIT : plain,
    jump ? p.jumpSource : p.source,
    crit,
    k,
    origin,
    fromX,
    fromY,
  );
  if (!enemy.alive) return;
  if (ignites && ctx.burnTicks > 0) {
    // The burn's damage is the hit's before its damage row: base × burnDamage × its own row,
    // read at jump 0, since a burn is no chain instance.
    const burnRow = slotRow(build, p, crit ? SLOT_BURN_CRIT : SLOT_BURN);
    addBurn(
      ctx,
      enemy,
      mul(base, ctx.burnDamage * statAt(table, burnRow, DAMAGE, 0)),
      ctx.now + ctx.burnTicks,
    );
  }
  // Dispatch position of a surviving hit (C3.6: hit and crit triggers and the onHit hooks, with
  // p.flags), after its ailments, so their conditions see what it applied.
}

/**
 * Deals a hit's `amount` to `enemy`: hp, the chain's hit mark, tallies and the hit event; a
 * lethal hit kills it.
 */
export function applyHitDamage(
  ctx: RunContext,
  enemy: Enemy,
  amount: Num,
  tags: TagMask,
  source: number,
  crit: boolean,
  chainIndex: number,
  origin: number,
  fromX: number | null,
  fromY: number | null,
): void {
  enemy.hp = sub(enemy.hp, amount);
  enemy.hitMark = ctx.attackSerial;
  tally(ctx, tags, source, amount);
  if (gt(amount, ctx.maxHit)) ctx.maxHit = amount;
  ctx.events.push({
    type: 'hit',
    targetId: enemy.id,
    x: enemy.x,
    y: enemy.y,
    amount,
    tags,
    source,
    crit,
    chainIndex,
    fromX,
    fromY,
  });
  if (lte(enemy.hp, ZERO)) {
    // Dispatch position of a lethal hit (C3.6: hit and crit triggers and the onHit hooks, on the
    // victim as it was hit), before killEnemy releases it.
    killEnemy(ctx, enemy, origin);
  }
}
