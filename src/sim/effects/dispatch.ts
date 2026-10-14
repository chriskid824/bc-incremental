/**
 * Trigger dispatch (docs/v3/implementation-plan-v3.md §2.6, §2.15): an event happens, and each
 * trigger listening to it that passes its gates queues its effects (queue.ts). The gates, in
 * order: the depth (MAX_DEPTH), the trigger's own damage (rule 3), the signature (rule 8,
 * hitIs 'signature'), the nthAttack count, the cooldown, the conditions, then the chance, rolled
 * on the trigger stream. fire() and fireOne() only queue and roll, so a hit can dispatch
 * mid-resolution without re-entering anything.
 *
 * Kills dispatch in two parts (killEnemy in src/sim/systems/death.ts): transfer triggers
 * (CompiledTrigger.inline) run their effects at once, while the victim still holds its
 * ailments; the others are recorded as pending kills and dispatched at the tick's death step,
 * sorted by victim id and trigger index, so their effects run in the next tick's effect phase.
 */

import type { Num } from '../../core/num';
import { ZERO } from '../../core/num';
import { conditionsMet } from '../build/eval';
import type { Enemy, RunContext } from '../systems/context';
import { runEffect } from './execute';
import { HELD_MASK, SIGNATURE } from './flags';
import { enqueue } from './queue';
import type { PendingKill } from './queue';
import { EVENT, MAX_DEPTH } from './types';
import type { CompiledTrigger } from './types';

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
 * Trigger `i` on an event: if it passes its gates, queues its effects at depth + 1 with origin
 * `i`, credited to `source` (−1: the trigger's own source).
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
  const t = passes(ctx, i, origin, target, flags);
  if (t === null) return;
  const credit = source >= 0 ? source : t.source;
  for (let e = t.effectStart; e < t.effectEnd; e++) {
    enqueue(ctx, e, depth + 1, i, credit, target, x, y, value, flags);
  }
}

/** Trigger `i` if it fires on this event (its cooldown restarts), else null. */
function passes(
  ctx: RunContext,
  i: number,
  origin: number,
  target: Enemy | null,
  flags: number,
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
  if (now < (state.readyAt[i] as number) || !conditionsMet(t.conds, target, now, flags)) {
    return null;
  }
  if (t.chance < 1 && !ctx.triggerRng.chance(t.chance)) return null;
  state.readyAt[i] = now + t.cooldownTicks;
  return t;
}

/**
 * The transfer triggers of a kill (RunContext.killInline), at the kill: `victim` is still
 * alive and holds its ailments, `flags` is the kill's snapshot (killEnemy).
 */
export function fireInlineKill(
  ctx: RunContext,
  victim: Enemy,
  origin: number,
  flags: number,
): void {
  const list = ctx.killInline;
  const triggers = ctx.build.triggers;
  const depth = victim.killDepth;
  for (let n = 0; n < list.length; n++) {
    const i = list[n] as number;
    const t = triggers[i] as CompiledTrigger;
    if (t.on === EVENT.diedWithAilment && (flags & HELD_MASK) === 0) continue;
    if (depth >= MAX_DEPTH) {
      ctx.counters.triggerDepthCapped++;
      continue;
    }
    if (passes(ctx, i, origin, null, flags) === null) continue;
    const entry = ctx.inlineEntry;
    for (let e = t.effectStart; e < t.effectEnd; e++) {
      entry.effect = e;
      entry.depth = depth + 1;
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
 * victim's shard drop, the value of triggers with gainShards.
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
  const pending = ctx.pendingKills;
  for (let n = 0; n < list.length; n++) {
    const i = list[n] as number;
    if (i === origin) continue;
    const t = triggers[i] as CompiledTrigger;
    if (t.on === EVENT.diedWithAilment && (flags & HELD_MASK) === 0) continue;
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
    entry.value = t.takesDrop ? drop : ZERO;
    entry.source = -1;
  }
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
