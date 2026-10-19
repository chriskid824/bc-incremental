/**
 * Trigger dispatch (docs/v3/implementation-plan-v3.md §2.6, §2.15): an event happens, and each
 * trigger listening to it that passes its gates queues its effects (queue.ts). The gates, in
 * order: the depth (MAX_DEPTH), the trigger's own damage (rule 3), the signature (rule 8,
 * hitIs 'signature'), the nthAttack count, the cooldown, the conditions, the target selector
 * (select.ts), then the chance, rolled on the trigger stream. A trigger stopped by its selector,
 * which found no enemy to pick, rolls nothing and keeps its cooldown, but its nthAttack count
 * has counted the event, as with a failed condition. fire() and fireOne() only queue, pick and
 * roll, so a hit can dispatch mid-resolution without re-entering anything. A trigger without a
 * selector on a center event with a list (explode, freeze) queues each effect that applies a
 * status to its target alone once per alive enemy of the list (src/sim/effects/centerEvents.ts).
 *
 * Kills dispatch in two parts (killEnemy in src/sim/systems/death.ts): transfer triggers
 * (CompiledTrigger.inline) run their effects at once, while the victim still holds its
 * ailments; the others are recorded as pending kills and dispatched at the tick's death step,
 * sorted by victim id and trigger index, so their effects run in the next tick's effect phase.
 * A frozen victim's shatter (SHATTER_TRIGGER) and the shatter triggers are pending kills too.
 *
 * Transfer triggers skip the depth gate and fire at any kill depth, as M1's Pandemic spread did
 * (Hoshi's call, 2026-10-14): they deal no damage, and the stacks they move keep their end and
 * lose strength with each spread, which bounds their chains. The moved stacks take one depth more
 * than the kill, at most MAX_DEPTH, and a kill by them carries that depth to the other triggers,
 * which keep the gate.
 */

import type { Num } from '../../core/num';
import { ZERO } from '../../core/num';
import { DETONATE_AILMENTS } from '../../data/triggers';
import type { AppliedAilment, DetonateAilment } from '../../data/triggers';
import { remainingOf } from '../ailments/remaining';
import { conditionsMet } from '../build/eval';
import { ailmentCredit } from '../build/sources';
import type { Enemy, RunContext } from '../systems/context';
import { runEffect } from './execute';
import { appliedFlag, HELD_MASK, SIGNATURE } from './flags';
import { enqueue } from './queue';
import type { PendingKill } from './queue';
import { select } from './select';
import { EVENT, MAX_DEPTH, SHATTER_TRIGGER } from './types';
import type { CompiledEffect, CompiledTrigger } from './types';

const EXPLODE = EVENT.explode;
const FREEZE = EVENT.freeze;

/**
 * Event `event` (TRIGGER_EVENTS ordinal) at depth `depth`, from damage of trigger `origin` (−1
 * for none), on `target` (null for none) at (x, y), carrying `flags` and `value`: every trigger
 * listening to it, in trigger order.
 */
export function fire(
  ctx: RunContext,
  event: number,
  depth: number,
  origin: number,
  target: Enemy | null,
  x: number,
  y: number,
  flags: number,
  value: Num,
): void {
  const list = ctx.build.triggersOn[event] as Int32Array;
  if (list.length === 0) return;
  if (depth >= MAX_DEPTH) {
    ctx.counters.triggerDepthCapped++;
    return;
  }
  for (let n = 0; n < list.length; n++) {
    fireOne(ctx, list[n] as number, depth, origin, target, x, y, flags, value, -1);
  }
}

/**
 * fire, leaving out the triggers marked 1 in `skip` (by trigger index): a freeze over the
 * payload limit (src/sim/effects/centerEvents.ts).
 */
export function fireExcept(
  ctx: RunContext,
  event: number,
  skip: Uint8Array,
  depth: number,
  origin: number,
  target: Enemy | null,
  x: number,
  y: number,
  flags: number,
  value: Num,
): void {
  const list = ctx.build.triggersOn[event] as Int32Array;
  if (list.length === 0) return;
  if (depth >= MAX_DEPTH) {
    ctx.counters.triggerDepthCapped++;
    return;
  }
  for (let n = 0; n < list.length; n++) {
    const i = list[n] as number;
    if (skip[i] !== 1) fireOne(ctx, i, depth, origin, target, x, y, flags, value, -1);
  }
}

/**
 * The ailmentApplied event of `ailment` landing on `target` at depth `depth`, from damage of
 * trigger `origin`: a hit's (with its payload's `flags`) or an applyAilment effect's. Moving
 * stacks (spreadAilment) raises none.
 */
export function fireApplied(
  ctx: RunContext,
  target: Enemy,
  ailment: AppliedAilment,
  depth: number,
  origin: number,
  flags: number,
): void {
  fire(
    ctx,
    EVENT.ailmentApplied,
    depth,
    origin,
    target,
    target.x,
    target.y,
    flags | appliedFlag(ailment),
    ZERO,
  );
}

/**
 * Trigger `i` on an event: if it passes its gates, queues its effects at depth + 1 with origin
 * `i`, credited to `source` (−1: the trigger's own source), on the enemy its selector picked or
 * else on the event's; on a center event with a list, without a selector, fanned out (fanOut).
 */
export function fireOne(
  ctx: RunContext,
  i: number,
  depth: number,
  origin: number,
  target: Enemy | null,
  x: number,
  y: number,
  flags: number,
  value: Num,
  source: number,
): void {
  if (depth >= MAX_DEPTH) {
    ctx.counters.triggerDepthCapped++;
    return;
  }
  const t = passes(ctx, i, origin, target, flags, x, y);
  if (t === null) return;
  const credit = source >= 0 ? source : t.source;
  const listEvent = t.on === EXPLODE || t.on === FREEZE;
  if (listEvent && t.selector === null && ctx.centerScratch.listCount > 0) {
    fanOut(ctx, t, depth + 1, credit, target, x, y, value, flags);
    return;
  }
  const on = t.selector !== null ? ctx.selected : target;
  for (let e = t.effectStart; e < t.effectEnd; e++) {
    enqueue(ctx, e, depth + 1, i, credit, on, x, y, value, flags);
  }
}

/**
 * The effects of trigger `t`, fired on a center event whose list the scratch holds, queued at
 * `depth` in effect order: each that applies a status to its target alone
 * (CompiledEffect.fanout) once per alive enemy of the list, at that enemy, and each other once,
 * on the event's enemy at its point.
 */
function fanOut(
  ctx: RunContext,
  t: CompiledTrigger,
  depth: number,
  credit: number,
  target: Enemy | null,
  x: number,
  y: number,
  value: Num,
  flags: number,
): void {
  const scratch = ctx.centerScratch;
  const list = scratch.list;
  const count = scratch.listCount;
  const effects = ctx.build.effects;
  const i = t.index;
  for (let e = t.effectStart; e < t.effectEnd; e++) {
    if (!(effects[e] as CompiledEffect).fanout) {
      enqueue(ctx, e, depth, i, credit, target, x, y, value, flags);
      continue;
    }
    for (let j = 0; j < count; j++) {
      const enemy = list[j] as Enemy;
      if (enemy.alive) enqueue(ctx, e, depth, i, credit, enemy, enemy.x, enemy.y, value, flags);
    }
  }
}

/**
 * Trigger `i` if it fires on this event on `target` at (x, y) (its cooldown restarts, and its
 * selector's pick is in ctx.selected), else null.
 */
function passes(
  ctx: RunContext,
  i: number,
  origin: number,
  target: Enemy | null,
  flags: number,
  x: number,
  y: number,
): CompiledTrigger | null {
  const t = ctx.build.triggers[i] as CompiledTrigger;
  if (i === origin || (t.signatureOnly && (flags & SIGNATURE) === 0)) return null;
  const state = ctx.triggerState;
  if (t.every > 1) {
    const count = (state.count[i] as number) + 1;
    state.count[i] = count;
    if (count % t.every !== 0) return null;
  }
  const now = ctx.now;
  if (now < (state.readyAt[i] as number) || !conditionsMet(t.conds, target, now, flags, ctx)) {
    return null;
  }
  if (t.selector !== null && !select(ctx, t.selector, target, x, y)) return null;
  if (t.chance < 1 && !ctx.triggerRng.chance(t.chance)) return null;
  state.readyAt[i] = now + t.cooldownTicks;
  return t;
}

/**
 * The transfer triggers of a kill (RunContext.killInline), at the kill: `victim` is still
 * alive and holds its ailments, `flags` is the kill's snapshot (killEnemy). No depth gate: they
 * fire at any kill depth, and their effects run one deeper, at most MAX_DEPTH. Their gates see
 * the victim's point; their effects always act on the victim (validation keeps selectors off
 * them).
 */
export function fireInlineKill(
  ctx: RunContext,
  victim: Enemy,
  origin: number,
  flags: number,
): void {
  const list = ctx.killInline;
  const triggers = ctx.build.triggers;
  const depth = Math.min(victim.killDepth + 1, MAX_DEPTH);
  for (let n = 0; n < list.length; n++) {
    const i = list[n] as number;
    const t = triggers[i] as CompiledTrigger;
    if (t.on === EVENT.diedWithAilment && (flags & HELD_MASK) === 0) continue;
    if (passes(ctx, i, origin, null, flags, victim.x, victim.y) === null) continue;
    const entry = ctx.inlineEntry;
    for (let e = t.effectStart; e < t.effectEnd; e++) {
      entry.effect = e;
      entry.depth = depth;
      entry.origin = i;
      entry.source = t.source;
      entry.flags = flags;
      entry.x = victim.x;
      entry.y = victim.y;
      entry.value = 0;
      entry.target = victim;
      runEffect(ctx, entry);
    }
  }
}

/**
 * Records the kill's pending triggers (RunContext.killPending), except the one whose damage
 * killed (rule 3) and, for a victim that held no ailment, diedWithAilment's. `drop` is the
 * victim's shard drop, the value of triggers with gainShards; a trigger with a detonate carries
 * the damage its ailment had left on the victim instead (killValue). SHATTER_TRIGGER is recorded
 * only for a frozen victim, with its max life as the value and the credit of the frost that
 * froze it as the source, and the shatter triggers with it; a kill by a shatter records neither.
 * Called before the kill releases the victim's ailments (killEnemy, src/sim/systems/death.ts).
 */
export function recordPendingKills(
  ctx: RunContext,
  victim: Enemy,
  origin: number,
  flags: number,
  drop: Num,
): void {
  const list = ctx.killPending;
  const triggers = ctx.build.triggers;
  for (let n = 0; n < list.length; n++) {
    const i = list[n] as number;
    if (i === origin) continue;
    const t = triggers[i] as CompiledTrigger;
    if (i === SHATTER_TRIGGER) {
      if (victim.frozenUntil > ctx.now) recordShatter(ctx, victim, origin, flags, drop);
      continue;
    }
    if (t.on === EVENT.diedWithAilment && (flags & HELD_MASK) === 0) continue;
    record(ctx, i, victim, origin, flags, killValue(ctx, t, victim, drop), -1);
  }
}

/**
 * The value of trigger `t`'s pending kill of `victim`: with a detonate, the damage its ailment
 * had left on the victim (remainingOf); with gainShards, the victim's drop; else 0. Validation
 * keeps the two apart.
 */
function killValue(ctx: RunContext, t: CompiledTrigger, victim: Enemy, drop: Num): Num {
  if (t.detonateAilment >= 0) {
    return remainingOf(ctx, victim, DETONATE_AILMENTS[t.detonateAilment] as DetonateAilment);
  }
  return t.takesDrop ? drop : ZERO;
}

/** The shatter of a frozen victim: SHATTER_TRIGGER's pending kill, then the shatter triggers'. */
function recordShatter(
  ctx: RunContext,
  victim: Enemy,
  origin: number,
  flags: number,
  drop: Num,
): void {
  const credit = ailmentCredit(ctx.sources, ctx.attribution, 'frost', victim.frostApplier);
  record(ctx, SHATTER_TRIGGER, victim, origin, flags, victim.maxHp, credit);
  const list = ctx.shatterTriggers;
  const triggers = ctx.build.triggers;
  for (let n = 0; n < list.length; n++) {
    const i = list[n] as number;
    if (i === origin) continue;
    const t = triggers[i] as CompiledTrigger;
    record(ctx, i, victim, origin, flags, killValue(ctx, t, victim, drop), -1);
  }
}

/**
 * Adds a pending kill of trigger `i`, reusing an entry, with its value and its source (−1: the
 * trigger's own).
 */
function record(
  ctx: RunContext,
  i: number,
  victim: Enemy,
  origin: number,
  flags: number,
  value: Num,
  source: number,
): void {
  const pending = ctx.pendingKills;
  let entry = pending[ctx.pendingCount];
  if (entry === undefined) {
    entry = { trigger: 0, victim, depth: 0, origin: -1, flags: 0, value: ZERO, source: -1 };
    pending.push(entry);
  }
  ctx.pendingCount++;
  entry.trigger = i;
  entry.victim = victim;
  entry.depth = victim.killDepth;
  entry.origin = origin;
  entry.flags = flags;
  entry.value = value;
  entry.source = source;
}

const before = (a: PendingKill, b: PendingKill): boolean =>
  a.victim.id < b.victim.id || (a.victim.id === b.victim.id && a.trigger < b.trigger);

/**
 * The death step's dispatch of this tick's pending kills, sorted by victim id, then trigger
 * index, each at the victim's position without a target.
 */
export function dispatchPendingKills(ctx: RunContext): void {
  const count = ctx.pendingCount;
  if (count === 0) return;
  const pending = ctx.pendingKills;
  for (let a = 1; a < count; a++) {
    const entry = pending[a] as PendingKill;
    let b = a - 1;
    while (b >= 0 && before(entry, pending[b] as PendingKill)) {
      pending[b + 1] = pending[b] as PendingKill;
      b--;
    }
    pending[b + 1] = entry;
  }
  ctx.pendingCount = 0;
  for (let a = 0; a < count; a++) {
    const e = pending[a] as PendingKill;
    const victim = e.victim;
    fireOne(
      ctx,
      e.trigger,
      e.depth,
      e.origin,
      null,
      victim.x,
      victim.y,
      e.flags,
      e.value,
      e.source,
    );
  }
}
