/**
 * Center events (docs/v3/implementation-plan-v3.md §2.11): events of a character's signature
 * attack (CENTER_EVENTS: explode, freeze, chainJump, droneImpact). Only the signature attack
 * raises them (rule 8): an event without SIGNATURE in its flags raises nothing. Freeze is the
 * exception: a chill meter fills from any frost, and its freeze is raised all the same. The
 * producers: freeze (raiseFreeze, once src/sim/ailments/frost.ts's addFrost fills a meter);
 * explode and chainJump come in C4. Each calls emitCenterEvent.
 *
 * A freeze's fusion payloads are rate-limited (docs/v3/game-design-v3.md §5.3): the fusion-class
 * listeners of a freeze (triggers and onCenterEvent hooks credited to a fusion) run for at most
 * FREEZE_PAYLOADS freezes in any FREEZE_PAYLOAD_WINDOW ticks. Past that the enemy still freezes
 * and every other listener still runs; the freeze counts in freezePayloadsLimited.
 */

import { ZERO } from '../../core/num';
import type { Enemy, FreezeLimiter, RunContext } from '../systems/context';
import { fire, fireExcept } from './dispatch';
import { SIGNATURE } from './flags';
import { EVENT } from './types';

const FREEZE = EVENT.freeze;

/** Freezes whose fusion payloads run, at most, in any FREEZE_PAYLOAD_WINDOW ticks. */
export const FREEZE_PAYLOADS = 8;
export const FREEZE_PAYLOAD_WINDOW = 60;

/**
 * Center event `event` (its CENTER_EVENTS ordinal, which is its TRIGGER_EVENTS ordinal) at depth
 * `depth`, from damage of trigger `origin`, on `target` at (x, y) with `flags`: the triggers
 * listening to it, then the onCenterEvent hooks.
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
  if (event !== FREEZE && (flags & SIGNATURE) === 0) return;
  const limiter = event === FREEZE ? ctx.freezeLimiter : null;
  const limited = limiter !== null && !takePayload(ctx, limiter);
  if (limited) {
    ctx.counters.freezePayloadsLimited++;
    fireExcept(ctx, event, limiter.fusionTrigger, depth, origin, target, x, y, flags, ZERO);
  } else {
    fire(ctx, event, depth, origin, target, x, y, flags, ZERO);
  }
  const hooks = ctx.build.hooks.onCenterEvent;
  if (hooks.length === 0) return;
  const scratch = ctx.centerScratch;
  scratch.event = event;
  scratch.depth = depth;
  scratch.origin = origin;
  scratch.flags = flags;
  scratch.target = target;
  scratch.x = x;
  scratch.y = y;
  for (let h = 0; h < hooks.length; h++) {
    if (limited && limiter.fusionHook[h] === 1) continue;
    (hooks[h] as (typeof hooks)[number])(ctx, scratch);
  }
}

/**
 * The freeze of `enemy`, whose chill meter just filled (a normal enemy froze, a boss's meter
 * emptied), raised at depth `depth` by damage of trigger `origin` carrying `flags`: its event,
 * then the freeze center event at the enemy.
 */
export function raiseFreeze(
  ctx: RunContext,
  enemy: Enemy,
  depth: number,
  origin: number,
  flags: number,
): void {
  ctx.events.push({ type: 'freeze', targetId: enemy.id, boss: enemy.boss });
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
