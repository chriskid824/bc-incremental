/**
 * Hits (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2–3): one damage instance of a
 * payload on one enemy, shared by emitter hits, chain jumps and effect hits. A hit rolls crit,
 * then its ailments (burn, poison, bleed, shock), deals damage, and kills or applies the
 * ailments it rolled, each raising ailmentApplied, then its frost (frostOnHit), which may
 * freeze. Chances, the crit multiplier, the damage multiplier and frost are the scoped stats of
 * the hit's own ModTable row (the payload's slot for its tags and source), so tagged, scoped and
 * scaling modifiers apply per hit. A shocked or frozen enemy takes more (takenMult). Every
 * damage instance, hits and damage-over-time steps alike, goes into the run's tallies through
 * tally.
 *
 * A hit raises the hit and crit trigger events and calls the onHit hooks (src/sim/effects/): a
 * surviving hit once its ailments are applied, so their conditions see them; a lethal one right
 * before the kill, on the victim as it was hit. Dispatch only queues effects, so nothing
 * re-enters a hit.
 */

import type { Num } from '../../core/num';
import { add, assertFinite, gt, lte, mul, sub, ZERO } from '../../core/num';
import { DOT_MASK, jumpMask, TAG } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import { ailmentDps, applyBurn, applyPoison, creditOf } from '../ailments/apply';
import { addBleed } from '../ailments/bleed';
import { addFrost } from '../ailments/frost';
import { addShock, takenMult } from '../ailments/shock';
import { pctMaxHpFactor, statAt } from '../build/eval';
import type { EvalInput } from '../build/eval';
import { SCOPED_INDEX } from '../build/modTable';
import type { ModTable } from '../build/modTable';
import { raiseFreeze } from '../effects/centerEvents';
import { fire, fireApplied } from '../effects/dispatch';
import { CHAIN_JUMP, CRIT_HIT, HIT_EVENT, KILL_BY_HIT, KILLED } from '../effects/flags';
import { EVENT } from '../effects/types';
import {
  PRESCALED,
  ROWS,
  SLOT_BLEED,
  SLOT_BLEED_CRIT,
  SLOT_BURN,
  SLOT_BURN_CRIT,
  SLOT_HIT,
  SLOT_JUMP,
  SLOT_POISON,
  SLOT_POISON_CRIT,
  slotRow,
} from '../emitters/types';
import type { Payload } from '../emitters/types';
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
const POISON_CHANCE = SCOPED_INDEX.poisonChance;
const BLEED_CHANCE = SCOPED_INDEX.bleedChance;
const SHOCK_CHANCE = SCOPED_INDEX.shockChance;
const POISON_ALWAYS = SCOPED_INDEX.poisonAlways;
const BLEED_ALWAYS = SCOPED_INDEX.bleedAlways;
const SHOCK_ALWAYS = SCOPED_INDEX.shockAlways;
const FROST_ON_HIT = SCOPED_INDEX.frostOnHit;

/** Bits of rollDots' result: the ailments a hit applies besides burn. */
const POISONS = 1;
const BLEEDS = 2;
const SHOCKS = 4;

const EV_HIT = EVENT.hit;
const EV_CRIT = EVENT.crit;

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
 * The poison, bleed and shock rolls of a hit with ModTable row `row`, in that order: each is its
 * chance's roll (drawn even when its always stat decides) or its always stat above 0.
 */
function rollDots(p: Payload, table: ModTable, row: number, ev: Readonly<EvalInput>): number {
  let rolled = 0;
  const rng = p.rng;
  if (
    rng.chance(clamp01(statAt(table, row, POISON_CHANCE, ev))) ||
    statAt(table, row, POISON_ALWAYS, ev) > 0
  ) {
    rolled |= POISONS;
  }
  if (
    rng.chance(clamp01(statAt(table, row, BLEED_CHANCE, ev))) ||
    statAt(table, row, BLEED_ALWAYS, ev) > 0
  ) {
    rolled |= BLEEDS;
  }
  if (
    rng.chance(clamp01(statAt(table, row, SHOCK_CHANCE, ev))) ||
    statAt(table, row, SHOCK_ALWAYS, ev) > 0
  ) {
    rolled |= SHOCKS;
  }
  return rolled;
}

/**
 * Applies the poison, bleed and shock a hit of `base` (crit or not) rolled (rollDots), each
 * credited from the payload's source, and raises ailmentApplied for each that landed.
 */
function applyDots(
  ctx: RunContext,
  enemy: Enemy,
  p: Payload,
  base: Num,
  crit: boolean,
  rolled: number,
  depth: number,
  origin: number,
): void {
  const now = ctx.now;
  if ((rolled & POISONS) !== 0 && ctx.poisonTicks > 0) {
    const slot = crit ? SLOT_POISON_CRIT : SLOT_POISON;
    const dps = ailmentDps(ctx, enemy, p, slot, base, ctx.poisonDamage);
    applyPoison(ctx, enemy, dps, now + ctx.poisonTicks, depth, creditOf(ctx, 'poison', p), 1);
    if (ctx.appliedListeners) fireApplied(ctx, enemy, 'poison', depth, origin, p.flags);
  }
  if ((rolled & BLEEDS) !== 0 && ctx.bleedTicks > 0) {
    const slot = crit ? SLOT_BLEED_CRIT : SLOT_BLEED;
    const dps = ailmentDps(ctx, enemy, p, slot, base, ctx.bleedDamage);
    const source = creditOf(ctx, 'bleed', p);
    if (addBleed(ctx, enemy, dps, now + ctx.bleedTicks, depth, source)) {
      ctx.events.push({ type: 'ailmentApplied', targetId: enemy.id, ailment: 'bleed', stacks: 1 });
      if (ctx.appliedListeners) fireApplied(ctx, enemy, 'bleed', depth, origin, p.flags);
    }
  }
  if ((rolled & SHOCKS) !== 0 && addShock(ctx, enemy, 1, depth)) {
    const stacks = enemy.shockStacks;
    ctx.events.push({ type: 'ailmentApplied', targetId: enemy.id, ailment: 'shock', stacks });
    if (ctx.appliedListeners) fireApplied(ctx, enemy, 'shock', depth, origin, p.flags);
  }
}

/**
 * Hit `k` of an attack's chain (0 for the primary hit) of payload `p` on `enemy`: `scale` is
 * the chain retention so far, (fromX, fromY) the previous hit's position (null for the primary
 * hit), `forced` a steady shot's sure crit, `depth` and `origin` the trigger depth of the hit
 * and the trigger its damage comes from (0 and −1 for emitter hits). A primary hit has the
 * payload's tags and source, a jump jumpMask of the tags and the payload's jumpSource; the
 * ailments either applies are credited from the payload's source.
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
  depth: number,
  origin: number,
): void {
  const build = ctx.build;
  const table = ctx.table;
  const ev = ctx.evalInput;
  ev.now = ctx.now;
  ev.target = enemy;
  ev.chainJump = k;
  const jump = k > 0;
  const slot = jump ? SLOT_JUMP : SLOT_HIT;
  const plain = jump ? jumpMask(p.tags) : p.tags;
  // The crit roll reads the hit's row without the crit tag, the rest the row of its outcome.
  const plainRow = slotRow(build, p, slot);
  // steadyAim turns random crits off, Static Focus's per-jump chance included; a payload that
  // cannot crit skips forced crits and critAlways too.
  const chance =
    build.flags.randomCrits && p.canCrit ? clamp01(statAt(table, plainRow, CRIT_CHANCE, ev)) : 0;
  const crit =
    p.canCrit && (p.rng.chance(chance) || forced || statAt(table, plainRow, CRIT_ALWAYS, ev) > 0);
  const row = crit ? slotRow(build, p, slot + 1) : plainRow;
  // An *Always stat forces the outcome after the roll is drawn (Searing Crits on crits).
  const ignites =
    p.rollsAilments &&
    (p.rng.chance(clamp01(statAt(table, row, IGNITE_CHANCE, ev))) ||
      statAt(table, row, IGNITE_ALWAYS, ev) > 0);
  // Builds that cannot poison, bleed or shock skip the rolls, which would draw nothing.
  const rolled = ctx.rollsDots && p.rollsAilments ? rollDots(p, table, row, ev) : 0;
  const critMultiplier = crit ? statAt(table, row, CRIT_MULTIPLIER, ev) : 1;
  const base = mul(p.baseDamage, critMultiplier * scale);
  const mask = crit ? plain | CRIT : plain;
  const source = jump ? p.jumpSource : p.source;
  const flags = p.flags | HIT_EVENT | (jump ? CHAIN_JUMP : 0) | (crit ? CRIT_HIT : 0);
  // A shatter (pctMaxHp) takes only the bounded part of its damage row (pctMaxHpFactor).
  let amount =
    p.damageMode === ROWS
      ? mul(base, statAt(table, row, DAMAGE, ev))
      : p.damageMode === PRESCALED
        ? base
        : mul(base, pctMaxHpFactor(table, row, ev, build.flags.shatterMult));
  if ((enemy.shockStacks !== 0 && enemy.shockUntil > ctx.now) || enemy.frozenUntil > ctx.now) {
    amount = mul(amount, takenMult(ctx, enemy));
  }
  if (build.hooks.modifyDamage.length !== 0) {
    amount = modifyDamage(ctx, enemy, amount, mask, source, crit, k, depth, origin, flags);
  }
  applyHitDamage(
    ctx,
    enemy,
    assertFinite(amount, 'hit damage'),
    mask,
    source,
    crit,
    k,
    depth,
    origin,
    flags,
    fromX,
    fromY,
  );
  if (!enemy.alive) return;
  if (ignites && ctx.burnTicks > 0) {
    // The burn's damage is the hit's before its damage row: base × burnDamage × its own row,
    // read at jump 0, since a burn is no chain instance. Poison and bleed do the same.
    ev.chainJump = 0;
    const burnRow = slotRow(build, p, crit ? SLOT_BURN_CRIT : SLOT_BURN);
    applyBurn(
      ctx,
      enemy,
      mul(base, ctx.burnDamage * statAt(table, burnRow, DAMAGE, ev)),
      ctx.now + ctx.burnTicks,
      depth,
      creditOf(ctx, 'burn', p),
      1,
    );
    if (ctx.appliedListeners) fireApplied(ctx, enemy, 'burn', depth, origin, p.flags);
  }
  if (rolled !== 0) applyDots(ctx, enemy, p, base, crit, rolled, depth, origin);
  // Builds without frost on hit skip reading it; a payload that rolls no ailments adds none.
  if (ctx.hitsFrost && p.rollsAilments) {
    ev.chainJump = k;
    const frost = statAt(table, row, FROST_ON_HIT, ev);
    if (frost > 0 && addFrost(ctx, enemy, frost, p.source)) {
      raiseFreeze(ctx, enemy, depth, origin, flags);
    }
  }
  if (ctx.hitListeners) {
    dispatchHit(ctx, enemy, amount, mask, source, crit, k, depth, origin, flags);
  }
}

/** Fills ctx.hitScratch for the hit's hooks, its amount included. */
function fillHitScratch(
  ctx: RunContext,
  enemy: Enemy,
  amount: Num,
  mask: TagMask,
  source: number,
  crit: boolean,
  chainIndex: number,
  depth: number,
  origin: number,
  flags: number,
): void {
  const hit = ctx.hitScratch;
  hit.target = enemy;
  hit.x = enemy.x;
  hit.y = enemy.y;
  hit.mask = mask;
  hit.source = source;
  hit.crit = crit;
  hit.chainIndex = chainIndex;
  hit.depth = depth;
  hit.origin = origin;
  hit.flags = flags;
  hit.amount = amount;
}

/** The hit's damage through the modifyDamage hooks, in order. */
function modifyDamage(
  ctx: RunContext,
  enemy: Enemy,
  amount: Num,
  mask: TagMask,
  source: number,
  crit: boolean,
  chainIndex: number,
  depth: number,
  origin: number,
  flags: number,
): Num {
  fillHitScratch(ctx, enemy, ZERO, mask, source, crit, chainIndex, depth, origin, flags);
  const hit = ctx.hitScratch;
  let modified = amount;
  for (const hook of ctx.build.hooks.modifyDamage) modified = hook(ctx, hit, modified);
  return modified;
}

/** The hit and crit events of a hit at its target, then the onHit hooks. */
function dispatchHit(
  ctx: RunContext,
  enemy: Enemy,
  amount: Num,
  mask: TagMask,
  source: number,
  crit: boolean,
  chainIndex: number,
  depth: number,
  origin: number,
  flags: number,
): void {
  fire(ctx, EV_HIT, depth, origin, enemy, enemy.x, enemy.y, flags, ZERO);
  if (crit) fire(ctx, EV_CRIT, depth, origin, enemy, enemy.x, enemy.y, flags, ZERO);
  const onHit = ctx.build.hooks.onHit;
  if (onHit.length === 0) return;
  fillHitScratch(ctx, enemy, amount, mask, source, crit, chainIndex, depth, origin, flags);
  for (const hook of onHit) hook(ctx, ctx.hitScratch);
}

/**
 * Deals a hit's `amount` to `enemy`: hp, the chain's hit mark, tallies and the hit event; a
 * lethal hit raises its events (with KILLED) and kills it.
 */
export function applyHitDamage(
  ctx: RunContext,
  enemy: Enemy,
  amount: Num,
  tags: TagMask,
  source: number,
  crit: boolean,
  chainIndex: number,
  depth: number,
  origin: number,
  flags: number,
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
    enemy.killDepth = depth;
    enemy.killKind = KILL_BY_HIT;
    // Its events see the victim as it was hit, before the kill releases it.
    if (ctx.hitListeners) {
      dispatchHit(
        ctx,
        enemy,
        amount,
        tags,
        source,
        crit,
        chainIndex,
        depth,
        origin,
        flags | KILLED,
      );
    }
    killEnemy(ctx, enemy, origin, flags);
  }
}
