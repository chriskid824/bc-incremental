/**
 * Ailments system (docs/v3/implementation-plan-v3.md §2.5, §2.15): burn records expire every
 * tick, and every BURN_TICK_INTERVAL ticks (step k = tick / 15) each alive enemy, in id order,
 * takes its damage over time: burn (its records and, under eternalFlame, its burn rings), then
 * poison (its rings), then bleed, each while it is still alive. Each kind's step is one damage
 * instance: × takenMult when shocked or frozen, through the modifyDamage hooks, then hp, the
 * tallies of the sources it is credited to and its event (burnTick, dotTick). Then the enemy's
 * ailmentTick triggers fire. The ailments themselves live in src/sim/ailments/.
 *
 * A kill by damage over time carries the enemy's ailment depth (Enemy.ailDepth) and no origin:
 * rule 3 is about direct damage only.
 */

import type { Num } from '../../core/num';
import { add, assertFinite, gt, lte, mul, sub, toNumber, ZERO } from '../../core/num';
import { TAG } from '../../data/tags';
import type { TagMask } from '../../data/tags';
import { syncRingStacks } from '../ailments/apply';
import { stepBleed } from '../ailments/bleed';
import { accrued, BURN_TICK_INTERVAL, expireBurns } from '../ailments/records';
import { RING_BURN, RING_POISON } from '../ailments/rings';
import { takenMult } from '../ailments/shock';
import { AILMENT_ORDINAL, CENTER, SOURCE_CLASS_ORDINAL } from '../build/sources';
import { tally } from '../combat/hit';
import { fireOne } from '../effects/dispatch';
import { KILL_BY_BLEED, KILL_BY_BURN, KILL_BY_POISON } from '../effects/flags';
import { EVENT } from '../effects/types';
import type { CompiledTrigger } from '../effects/types';
import type { BurnStack, Enemy, RunContext } from './context';
import { killEnemy } from './death';

const BURN = TAG.burn;
const POISON = TAG.poison;
const BLEED = TAG.bleed;
const OUTER = SOURCE_CLASS_ORDINAL.outer;
const FUSION = SOURCE_CLASS_ORDINAL.fusion;
const BURN_ORDINAL = AILMENT_ORDINAL.burn;

/** Expires burn records every tick; deals damage over time every BURN_TICK_INTERVAL ticks. */
export function updateAilments(ctx: RunContext): void {
  const enemies = ctx.enemies;
  const now = ctx.now;
  const dotStep = now % BURN_TICK_INTERVAL === 0;
  const k = now / BURN_TICK_INTERVAL;
  const ticking = ctx.build.triggersOn[EVENT.ailmentTick] as Int32Array;
  // Children spawned by kills here are appended past `count`; their first step is the next.
  for (let i = 0, count = enemies.length; i < count; i++) {
    const enemy = enemies[i] as Enemy;
    if (!enemy.alive) continue;
    if (now >= enemy.burnNextEnd) expireBurns(ctx, enemy);
    if (!dotStep) continue;
    // Paid up to now: a burn kill later in this loop may still spread a stack onto it (addBurn).
    enemy.burnSteppedAt = now;
    let amount = enemy.burnPending;
    const burns = enemy.burns;
    for (let s = 0; s < burns.length; s++) {
      amount = add(amount, accrued(ctx, burns[s] as BurnStack, now));
    }
    enemy.burnPending = ZERO;
    if (enemy.dotRings === 0 && enemy.bleedUntil === 0 && !ctx.burnMixed) {
      // Burn records only, all credited to one source: M1's burn tick.
      if (gt(amount, ZERO) && dealDot(ctx, enemy, BURN, amount, ctx.burnCredit)) continue;
    } else if (stepDots(ctx, enemy, k, amount)) continue;
    if (ticking.length !== 0) fireTicks(ctx, enemy, k, ticking);
  }
  if (dotStep) ctx.lastBurnTick = now;
}

/** Adds a credited part of this step's damage of one ailment (RunContext.dotParts). */
function addPart(ctx: RunContext, source: number, amount: Num): void {
  const parts = ctx.dotParts;
  parts.source[parts.n] = source;
  parts.amount[parts.n] = amount;
  parts.n++;
}

/**
 * The records' share of this step's burn per source class, for a build whose burns can have
 * more than one credit (RunContext.burnMixed): what each class has pending, plus what its
 * records accrued. The hp loss keeps M1's sum; these only split its credit.
 */
function recordParts(ctx: RunContext, enemy: Enemy): void {
  let center = enemy.burnPendC;
  let outer = enemy.burnPendO;
  let fusion = enemy.burnPendF;
  enemy.burnPendC = ZERO;
  enemy.burnPendO = ZERO;
  enemy.burnPendF = ZERO;
  const burns = enemy.burns;
  for (let s = 0; s < burns.length; s++) {
    const stack = burns[s] as BurnStack;
    const amount = accrued(ctx, stack, ctx.now);
    if (stack.cls === FUSION) fusion = add(fusion, amount);
    else if (stack.cls === OUTER) outer = add(outer, amount);
    else center = add(center, amount);
  }
  if (gt(center, ZERO)) addPart(ctx, CENTER, center);
  if (gt(outer, ZERO)) addPart(ctx, ctx.attribution.outerSource[BURN_ORDINAL] as number, outer);
  if (gt(fusion, ZERO)) addPart(ctx, enemy.burnFusionCredit, fusion);
}

/**
 * Step k of the enemy's rings of one ailment (`first`: RING_BURN or RING_POISON): their damage,
 * each ring's share added to the step's parts. A ring past its last step goes back to the pool.
 */
function stepRings(ctx: RunContext, enemy: Enemy, first: number, k: number): Num {
  const pool = ctx.rings;
  const rings = enemy.rings;
  let sum = ZERO;
  for (let slot = first; slot < first + 3; slot++) {
    const r = rings[slot] as number;
    if (r < 0) continue;
    const dealt = pool.step(r, k);
    if (gt(dealt, ZERO)) {
      sum = add(sum, dealt);
      addPart(ctx, pool.credit[r] as number, dealt);
    }
    if (pool.ended(r, k)) {
      pool.release(r);
      rings[slot] = -1;
      enemy.dotRings--;
    }
  }
  syncRingStacks(ctx, enemy, first);
  return sum;
}

/**
 * The step of an enemy with rings, a bleed or mixed burn credits: burn, poison, bleed, each
 * while it lives. `records` is its burn records' damage this step. True when it died.
 */
function stepDots(ctx: RunContext, enemy: Enemy, k: number, records: Num): boolean {
  const parts = ctx.dotParts;
  parts.n = 0;
  if (ctx.burnMixed) recordParts(ctx, enemy);
  else if (gt(records, ZERO)) addPart(ctx, ctx.burnCredit, records);
  let burn = records;
  if (enemy.dotRings !== 0) burn = add(burn, stepRings(ctx, enemy, RING_BURN, k));
  if (gt(burn, ZERO) && dealDot(ctx, enemy, BURN, burn, -1)) return true;
  if (enemy.dotRings !== 0) {
    parts.n = 0;
    const poison = stepRings(ctx, enemy, RING_POISON, k);
    if (gt(poison, ZERO) && dealDot(ctx, enemy, POISON, poison, -1)) return true;
  }
  if (enemy.bleedUntil !== 0) {
    const source = enemy.bleedSource;
    const bleed = stepBleed(ctx, enemy);
    if (gt(bleed, ZERO) && dealDot(ctx, enemy, BLEED, bleed, source)) return true;
  }
  return false;
}

/**
 * Deals one ailment's step, `raw` > 0, tagged `tag` (burn, poison or bleed), credited to
 * `credit`, or to RunContext.dotParts for −1. True when it killed the enemy.
 */
function dealDot(ctx: RunContext, enemy: Enemy, tag: TagMask, raw: Num, credit: number): boolean {
  let amount = raw;
  if ((enemy.shockStacks !== 0 && enemy.shockUntil > ctx.now) || enemy.frozenUntil > ctx.now) {
    amount = mul(amount, takenMult(ctx, enemy));
  }
  const parts = ctx.dotParts;
  if (ctx.build.hooks.modifyDamage.length !== 0) {
    amount = modifyDot(ctx, enemy, amount, tag, credit >= 0 ? credit : (parts.source[0] as number));
  }
  assertFinite(amount, tag === BURN ? 'burn damage' : 'damage over time');
  enemy.hp = sub(enemy.hp, amount);
  if (credit >= 0) tally(ctx, tag, credit, amount);
  else {
    // Each source's share of what was dealt.
    const scale = amount === raw ? 1 : toNumber(amount) / toNumber(raw);
    for (let j = 0; j < parts.n; j++) {
      const part = parts.amount[j] as Num;
      tally(ctx, tag, parts.source[j] as number, scale === 1 ? part : mul(part, scale));
    }
  }
  if (gt(amount, ctx.maxHit)) ctx.maxHit = amount;
  const { id: targetId, x, y } = enemy;
  if (tag === BURN) ctx.events.push({ type: 'burnTick', targetId, x, y, amount });
  else {
    const ailment = tag === POISON ? 'poison' : 'bleed';
    ctx.events.push({ type: 'dotTick', ailment, targetId, x, y, amount });
  }
  if (!lte(enemy.hp, ZERO)) return false;
  enemy.killDepth = enemy.ailDepth;
  enemy.killKind = tag === BURN ? KILL_BY_BURN : tag === POISON ? KILL_BY_POISON : KILL_BY_BLEED;
  killEnemy(ctx, enemy, -1, 0);
  return true;
}

/**
 * A step's damage through the modifyDamage hooks, in order, with RunContext.hitScratch as the
 * step's scratch: its ailment's tag, the enemy, the credited source, no crit, jump 0, the
 * enemy's ailment depth, no origin, no flags.
 */
function modifyDot(ctx: RunContext, enemy: Enemy, amount: Num, tag: TagMask, source: number): Num {
  const hit = ctx.hitScratch;
  hit.target = enemy;
  hit.x = enemy.x;
  hit.y = enemy.y;
  hit.mask = tag;
  hit.source = source;
  hit.crit = false;
  hit.chainIndex = 0;
  hit.depth = enemy.ailDepth;
  hit.origin = -1;
  hit.flags = 0;
  hit.amount = ZERO;
  let modified = amount;
  for (const hook of ctx.build.hooks.modifyDamage) modified = hook(ctx, hit, modified);
  return modified;
}

/**
 * The enemy's ailmentTick triggers due at step k (k % stepEvery === 0), in trigger order, at
 * the enemy with its ailment depth; each one's ailment condition asks whether it holds the
 * ailment. An enemy holding no damage over time is skipped.
 */
function fireTicks(ctx: RunContext, enemy: Enemy, k: number, list: Int32Array): void {
  if (enemy.burns.length === 0 && enemy.dotRings === 0 && !(enemy.bleedUntil > ctx.now)) return;
  const triggers = ctx.build.triggers;
  for (let n = 0; n < list.length; n++) {
    const i = list[n] as number;
    if (k % (triggers[i] as CompiledTrigger).stepEvery !== 0) continue;
    fireOne(ctx, i, enemy.ailDepth, -1, enemy, enemy.x, enemy.y, 0, ZERO, -1);
  }
}
