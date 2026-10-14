/**
 * Center events (docs/v3/implementation-plan-v3.md §2.11): events of a character's signature
 * attack (CENTER_EVENTS: explode, freeze, chainJump, droneImpact). Only the signature attack
 * raises them (rule 8): an event without SIGNATURE in its flags raises nothing. The producers
 * come later (freeze in C3.9; explode and chainJump in C4); each calls emitCenterEvent.
 */

import { ZERO } from '../../core/num';
import type { Enemy, RunContext } from '../systems/context';
import { fire } from './dispatch';
import { SIGNATURE } from './flags';

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
  if ((flags & SIGNATURE) === 0) return;
  fire(ctx, event, depth, origin, target, x, y, flags, ZERO);
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
  for (const hook of hooks) hook(ctx, scratch);
}
