/**
 * Hits (docs/v3/implementation-plan-v3.md §2.15, docs/GDD.md §2–3): one damage instance of a
 * payload on one enemy, shared by emitter hits, chain jumps and effect hits. A hit rolls crit,
 * then its ailments (burn, poison, bleed, shock), deals damage, and kills or applies the
 * ailments it rolled, each raising ailmentApplied, then its frost (frostOnHit), which may
 * freeze. Chances, the crit multiplier, the damage multiplier and frost are the scoped stats of
 * the hit's own ModTable row (the payload's slot for its tags and source), so tagged, scoped and
 * scaling modifiers apply per hit. Conversions split a hit's damage into parts with rows of
 * their own (src/sim/combat/convert.ts). A shocked or frozen enemy takes more (takenMult). A v3
 * run's enemy with a shield or armour then defends (src/sim/combat/defend.ts): a hit it blocks
 * in full deals nothing (blockedHit). A lethal hit on a v3 onion with a shell left breaks the
 * shell and the onion lives on (src/sim/systems/onion.ts). Every damage instance, hits and
 * damage-over-time steps alike, goes into the run's tallies through tally.
 *
 * A hit raises the hit and crit trigger events and calls the onHit hooks (src/sim/effects/): a
 * surviving hit once its ailments are applied, so their conditions see them; a lethal one right
 * before the kill, on the victim as it was hit. Dispatch only queues effects, so nothing
 * re-enters a hit. The hits of a pulse's payload (Payload.aggregate, a zone's) add to the
 * pulse's tally rather than each raising a hit event (src/sim/systems/zones.ts).
 */

import type { Num } from '../../core/num';
import { add, assertFinite, gt, lte, mul, sub, toNumber, ZERO } from '../../core/num';
import { DOT_MASK, jumpMask, TAG } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import { ailmentDps, applyBurn, applyPoison, applyPulseBurn, creditOf } from '../ailments/apply';
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
import { onionBreak } from '../systems/onion';
import type { PulseAcc } from '../systems/systemState';
import { convertHit } from './convert';
import { blockedHit, bypassOf, defend } from './defend';

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
export const POISONS = 1;
export const BLEEDS = 2;
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
 * Tallies a converted hit's `amount` part by part (RunContext.hitParts, convertHit): each part's
 * share of what was dealt, with its own tags, credited to the hit's `source`.
 */
function tallyParts(ctx: RunContext, source: number, amount: Num): void {
  const parts = ctx.hitParts;
  // A hook can turn a hit of 0 into damage, which no share can scale: it goes to the first part.
  if (toNumber(parts.total) === 0) {
    tally(ctx, parts.mask[0] as number, source, amount);
    return;
  }
  // takenMult and the modifyDamage hooks scale every part alike.
  const scale = amount === parts.total ? 1 : toNumber(amount) / toNumber(parts.total);
  for (let i = 0; i < parts.n; i++) {
    const part = parts.amount[i] as Num;
    tally(ctx, parts.mask[i] as number, source, scale === 1 ? part : mul(part, scale));
  }
}

/**
 * The poison, bleed and shock rolls of a hit with ModTable row `row`, in that order: each is its
 * chance's roll (drawn even when its always stat decides) or its always stat above 0.
 */
export function rollDots(
  p: Payload,
  table: ModTable,
  row: number,
  ev: Readonly<EvalInput>,
): number {
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
export function applyDots(
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
 * and the trigger its damage comes from (0 and −1 for emitter hits), `bits` flags the caller
 * adds to the hit's: PRIMARY on a signature attack's primary hit, which primaryHit passes
 * (src/sim/combat/chain.ts: chainAttack at a volley projectile's or a signature turret shot's
 * arrival, a discharge's targets, a fan round's first cone hit), and land
 * (src/sim/emitters/lob.ts) and impactAt (src/sim/systems/drones.ts) pass themselves. A primary
 * hit has the payload's tags and source, a jump jumpMask of the tags and the payload's
 * jumpSource; the ailments either applies are credited from the payload's source. It returns
 * false when the enemy's defences block the hit in full (blockedHit, src/sim/combat/defend.ts)
 * and true otherwise, a hit that kills included: a caller that shocks the enemy after the hit
 * skips a blocked one (lead ruling R1), and the callers that add nothing ignore it.
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
  bits = 0,
): boolean {
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
  const flags = p.flags | HIT_EVENT | (jump ? CHAIN_JUMP : 0) | (crit ? CRIT_HIT : 0) | bits;
  // A hit whose row converts deals its parts (convertHit); a shatter (pctMaxHp) takes only the
  // bounded part of its damage row (pctMaxHpFactor).
  const converted = ctx.converts && p.damageMode === ROWS && table.convCount[row] !== 0;
  let amount = converted
    ? convertHit(ctx, row, base, ev)
    : p.damageMode === ROWS
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
  // Only a v3 run's enemies have a record: an M1 hit pays this one test. A live guardian lends
  // its block to an enemy with no defence of its own (守護, C7.6).
  if (enemy.v3 !== null && (enemy.v3.defence !== 0 || ctx.sys.affixes.guardians.length !== 0)) {
    const landed = defend(
      ctx,
      enemy,
      enemy.v3,
      amount,
      mask,
      converted,
      bypassOf(p, table, row, ev),
    );
    if (landed === null) {
      blockedHit(ctx, enemy, p, amount, base, crit, ignites, rolled, depth, origin, p.aggregate);
      return false;
    }
    amount = landed;
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
    converted,
    p.aggregate ? ctx.sys.pulse : null,
  );
  if (!enemy.alive) return true;
  if (ignites && ctx.burnTicks > 0) applyHitBurn(ctx, enemy, p, base, crit, depth, origin, false);
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
  return true;
}

/**
 * The burn of a hit of `base` (crit or not) that ignited `enemy`, then its ailmentApplied
 * trigger. Its damage is the hit's before its damage row: base × burnDamage × its own row, read
 * at jump 0, since a burn is no chain instance; poison and bleed do the same (ailmentDps). A
 * pulse's hit (`pulse`) burns through applyPulseBurn: at the records cap it replaces only a
 * weaker stack, and a refused one changes and fires nothing (Q4/F4). A hit an enemy's defences
 * block in full burns as it would have landed (blockedHit, src/sim/combat/defend.ts).
 */
export function applyHitBurn(
  ctx: RunContext,
  enemy: Enemy,
  p: Payload,
  base: Num,
  crit: boolean,
  depth: number,
  origin: number,
  pulse: boolean,
): void {
  const ev = ctx.evalInput;
  ev.chainJump = 0;
  const burnRow = slotRow(ctx.build, p, crit ? SLOT_BURN_CRIT : SLOT_BURN);
  const dps = mul(base, ctx.burnDamage * statAt(ctx.table, burnRow, DAMAGE, ev));
  const end = ctx.now + ctx.burnTicks;
  const credit = creditOf(ctx, 'burn', p);
  if (pulse) {
    const applied = applyPulseBurn(ctx, enemy, dps, end, depth, credit, 1);
    if (applied && ctx.appliedListeners) fireApplied(ctx, enemy, 'burn', depth, origin, p.flags);
    return;
  }
  applyBurn(ctx, enemy, dps, end, depth, credit, 1);
  if (ctx.appliedListeners) fireApplied(ctx, enemy, 'burn', depth, origin, p.flags);
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
export function modifyDamage(
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
export function dispatchHit(
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
 * Deals a hit's `amount` to `enemy`: hp, the chain's hit mark, tallies (part by part for a
 * `converted` hit) and the hit event, or with `acc` (a pulse's hit) the pulse's tally instead;
 * a lethal hit raises its events (with KILLED) and kills it. It is one of the two lethal tests
 * (the other is the damage-over-time step's, src/sim/systems/ailments.ts): a lethal hit on a v3
 * onion with a shell left breaks that shell instead (onionBreak), with no KILLED events and no
 * kill, and its caller goes on as after a surviving hit, the hit event and tallies keeping the
 * full amount.
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
  converted: boolean,
  acc: PulseAcc | null = null,
): void {
  enemy.hp = sub(enemy.hp, amount);
  enemy.hitMark = ctx.attackSerial;
  if (converted) tallyParts(ctx, source, amount);
  else tally(ctx, tags, source, amount);
  if (gt(amount, ctx.maxHit)) ctx.maxHit = amount;
  if (acc === null) {
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
  } else {
    acc.hits++;
    acc.total = add(acc.total, amount);
    if (crit) acc.crits[acc.critCount++] = enemy.id;
  }
  if (lte(enemy.hp, ZERO)) {
    // A v3 onion with a shell left loses it here and lives on (src/sim/systems/onion.ts): the
    // hit goes on as a surviving one. An M1 kill pays this one test.
    const v3 = enemy.v3;
    if (v3 !== null && v3.layersLeft > 0 && onionBreak(ctx, enemy)) return;
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
