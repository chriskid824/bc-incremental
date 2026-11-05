/**
 * What rule module hooks may call (src/sim/rules/module.ts). Hooks deal damage and apply
 * ailments only by queueing effects they compiled (BuildCompiler.addEffect), so the depth
 * limit, rule 3 and the per-tick effect budget hold for them as for data triggers.
 */

import { ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import { enqueue } from '../effects/queue';
import { MAX_DEPTH } from '../effects/types';
import type { CompiledEffect } from '../effects/types';
import type { Enemy, RunContext } from '../systems/context';

/**
 * The event a hook queues an effect on. Hooks pass their scratch: HitScratch, KillScratch (no
 * target: the victim is dead by the time the effect runs), CenterEventScratch or ChainEndScratch
 * (its target the chain's last enemy, which may be dead). A tick hook passes depth 0, origin −1,
 * no target and the player's position.
 */
export interface ModuleEvent {
  readonly depth: number;
  /** The trigger whose damage raised the event; −1 for none. */
  readonly origin: number;
  readonly target?: Enemy | null;
  readonly x: number;
  readonly y: number;
  readonly flags: number;
}

/**
 * Queues effect `effectIndex` (from addEffect) for the module instance `triggerIndex` (from
 * hook() or instanceTrigger(), which share it) on event `ev`, at one depth more, with the
 * instance as its origin. Nothing is queued for an event the instance's own effects raised
 * (rule 3) or at the maximum depth. `value` is the entry's value (ZERO by default): a detonate
 * on a dead enemy deals it as what the victim had left (src/sim/effects/execute.ts).
 */
export function enqueueModuleEffect(
  ctx: RunContext,
  triggerIndex: number,
  effectIndex: number,
  ev: ModuleEvent,
  value: Num = ZERO,
): void {
  if (ev.origin === triggerIndex) return;
  if (ev.depth >= MAX_DEPTH) {
    ctx.counters.triggerDepthCapped++;
    return;
  }
  const fx = ctx.build.effects[effectIndex] as CompiledEffect;
  enqueue(
    ctx,
    effectIndex,
    ev.depth + 1,
    triggerIndex,
    fx.source,
    ev.target ?? null,
    ev.x,
    ev.y,
    value,
    ev.flags,
  );
}
