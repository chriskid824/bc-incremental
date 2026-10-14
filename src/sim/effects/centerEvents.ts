/**
 * Center events (docs/v3/implementation-plan-v3.md §2.11): events of a character's signature
 * attack (CENTER_EVENTS: explode, freeze, chainJump, droneImpact). Only the signature attack
 * raises them (rule 8): an event without SIGNATURE in its flags raises nothing, and neither does
 * one with REPEAT, a repeat of the signature attack. Freeze is the exception: a chill meter fills
 * from any frost, and its freeze is raised all the same. The producers: freeze (raiseFreeze,
 * once src/sim/ailments/frost.ts's addFrost fills a meter); explode and chainJump come later in
 * C4. Each calls emitCenterEvent, which returns at once when no trigger and no onCenterEvent
 * hook listens to the event (RunContext.centerEvents).
 *
 * An event can carry a list of enemies (CenterEventScratch.list), which its producer fills right
 * before raising it: a freeze's is the frozen enemy and up to LIST_MAX − 1 others within
 * FREEZE_LIST_RADIUS of it, in id order, taken only when a trigger or a hook reads it
 * (CenterEventState.listNeeded). A trigger without a selector on explode or freeze queues each of
 * its effects that applies a status to its target alone (CompiledEffect.fanout) once per alive
 * enemy of the list, and its other effects once (fireOne in dispatch.ts): one chance roll and
 * one cooldown per firing all the same.
 *
 * A freeze's fusion payloads are rate-limited (docs/v3/game-design-v3.md §5.3): the fusion-class
 * listeners of a freeze (triggers and onCenterEvent hooks credited to a fusion) run for at most
 * FREEZE_PAYLOADS freezes in any FREEZE_PAYLOAD_WINDOW ticks. Past that the enemy still freezes
 * and every other listener still runs; the freeze counts in freezePayloadsLimited.
 */

import { ZERO } from '../../core/num';
import { CENTER_EVENTS } from '../../data/triggers';
import type { CompiledBuild } from '../build/compile';
import { FREEZE_LIST_RADIUS, LIST_MAX } from '../caps';
import type { Enemy, FreezeLimiter, RunContext } from '../systems/context';
import { fire, fireExcept } from './dispatch';
import { REPEAT, SIGNATURE } from './flags';
import { EVENT } from './types';
import type { CompiledTrigger } from './types';

const FREEZE = EVENT.freeze;
const FREEZE_LIST_RADIUS_SQ = FREEZE_LIST_RADIUS ** 2;

/** Freezes whose fusion payloads run, at most, in any FREEZE_PAYLOAD_WINDOW ticks. */
export const FREEZE_PAYLOADS = 8;
export const FREEZE_PAYLOAD_WINDOW = 60;

/**
 * Who listens to each center event, by its CENTER_EVENTS ordinal, and the freeze list's query
 * scratch (RunContext.centerEvents). One object rather than RunContext fields, which stay below
 * 128 (RunContext.selection).
 */
export interface CenterEventState {
  /** Triggers on the event, at most 255. */
  readonly listeners: Uint8Array;
  /** onCenterEvent hooks. */
  readonly hooks: number;
  /**
   * 1 when the event's list is read: a trigger on it without a selector has an effect that fans
   * out (CompiledEffect.fanout), or an onCenterEvent hook listens.
   */
  readonly listNeeded: Uint8Array;
  /** The enemies within FREEZE_LIST_RADIUS of a freeze, which only raiseFreeze writes. */
  readonly freezeTargets: Enemy[];
}

/** The center-event listeners of `build`, for createRunContext. */
export function createCenterEventState(build: CompiledBuild): CenterEventState {
  const { triggers, triggersOn, effects } = build;
  const hooks = build.hooks.onCenterEvent.length;
  const listeners = new Uint8Array(CENTER_EVENTS.length);
  const listNeeded = new Uint8Array(CENTER_EVENTS.length);
  for (const name of CENTER_EVENTS) {
    const event = EVENT[name];
    const on = triggersOn[event] as Int32Array;
    const fansOut = Array.from(on).some((i) => {
      const t = triggers[i] as CompiledTrigger;
      return (
        t.selector === null && effects.slice(t.effectStart, t.effectEnd).some((fx) => fx.fanout)
      );
    });
    listeners[event] = Math.min(255, on.length);
    listNeeded[event] = fansOut || hooks !== 0 ? 1 : 0;
  }
  return { listeners, hooks, listNeeded, freezeTargets: [] };
}

/**
 * Center event `event` (its CENTER_EVENTS ordinal, which is its TRIGGER_EVENTS ordinal) at depth
 * `depth`, from damage of trigger `origin`, on `target` at (x, y) with `flags`: the triggers
 * listening to it, then the onCenterEvent hooks. Its producer has filled the scratch's list and
 * radius (listCount 0 for none); the rest of the scratch is written once something listens.
 */
export function emitCenterEvent(
  ctx: RunContext,
  event: number,
  depth: number,
  origin: number,
  target: Enemy | null,
  x: number,
  y: number,
  flags: number,
): void {
  // Rule 8: the signature attack's own events, not its repeats'; a freeze from any frost.
  if (event !== FREEZE && (flags & (SIGNATURE | REPEAT)) !== SIGNATURE) return;
  const limiter = event === FREEZE ? ctx.freezeLimiter : null;
  const limited = limiter !== null && !takePayload(ctx, limiter);
  // Nothing listens. A limiter exists only when a fusion's trigger or hook does, so this never
  // skips a limited freeze's count.
  const center = ctx.centerEvents;
  if (center.listeners[event] === 0 && center.hooks === 0) return;
  const scratch = ctx.centerScratch;
  scratch.event = event;
  scratch.depth = depth;
  scratch.origin = origin;
  scratch.flags = flags;
  scratch.target = target;
  scratch.x = x;
  scratch.y = y;
  if (limited) {
    ctx.counters.freezePayloadsLimited++;
    fireExcept(ctx, event, limiter.fusionTrigger, depth, origin, target, x, y, flags, ZERO);
  } else {
    fire(ctx, event, depth, origin, target, x, y, flags, ZERO);
  }
  const hooks = ctx.build.hooks.onCenterEvent;
  for (let h = 0; h < hooks.length; h++) {
    if (limited && limiter.fusionHook[h] === 1) continue;
    (hooks[h] as (typeof hooks)[number])(ctx, scratch);
  }
}

/**
 * The freeze of `enemy`, whose chill meter just filled (a normal enemy froze, a boss's meter
 * emptied), raised at depth `depth` by damage of trigger `origin` carrying `flags`: its event,
 * then the freeze center event at the enemy, with its list when something reads it: the enemy,
 * then up to LIST_MAX − 1 other alive enemies within FREEZE_LIST_RADIUS of it, in id order.
 */
export function raiseFreeze(
  ctx: RunContext,
  enemy: Enemy,
  depth: number,
  origin: number,
  flags: number,
): void {
  ctx.events.push({ type: 'freeze', targetId: enemy.id, boss: enemy.boss });
  const scratch = ctx.centerScratch;
  scratch.listCount = 0;
  const center = ctx.centerEvents;
  if (center.listNeeded[FREEZE] === 1) {
    // A hit or an effect can freeze while its caller walks a list of its own: the query takes
    // freezeTargets, which nothing else writes, and the triggers only queue.
    const near = center.freezeTargets;
    const count = ctx.grid.within(enemy.x, enemy.y, FREEZE_LIST_RADIUS_SQ, near);
    const list = scratch.list;
    list[0] = enemy;
    let n = 1;
    for (let j = 0; j < count && n < LIST_MAX; j++) {
      const other = near[j] as Enemy;
      if (other !== enemy && other.alive) list[n++] = other;
    }
    scratch.listCount = n;
    scratch.radius = FREEZE_LIST_RADIUS;
  }
  emitCenterEvent(ctx, FREEZE, depth, origin, enemy, enemy.x, enemy.y, flags);
}

/**
 * Whether this freeze's fusion payloads may run: fewer than FREEZE_PAYLOADS freezes ran theirs,
 * or the oldest of the last FREEZE_PAYLOADS did so FREEZE_PAYLOAD_WINDOW ticks ago or more. If
 * so, this one takes its place.
 */
function takePayload(ctx: RunContext, limiter: FreezeLimiter): boolean {
  const now = ctx.now;
  const ticks = limiter.ticks;
  if (limiter.count === FREEZE_PAYLOADS) {
    if (now - (ticks[limiter.next] as number) < FREEZE_PAYLOAD_WINDOW) return false;
  } else {
    limiter.count++;
  }
  ticks[limiter.next] = now;
  limiter.next = (limiter.next + 1) % FREEZE_PAYLOADS;
  return true;
}
