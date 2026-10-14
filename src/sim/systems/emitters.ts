/**
 * Emitters system (docs/v3/implementation-plan-v3.md §2.15): every emitter of the build attacks,
 * the signature attack first (src/sim/emitters/); then the rule modules' tick hooks run.
 */

import type { EmitterRuntime, EmitterSpec } from '../emitters/types';
import { runVolley } from '../emitters/volley';
import type { RunContext } from './context';

/** The step of each emitter kind. Typed over the kinds, so a new kind needs its step here. */
const EMITTER_STEPS: {
  readonly [K in EmitterSpec['kind']]: (ctx: RunContext, em: EmitterRuntime) => void;
} = {
  volley: runVolley,
};

/** Fires every emitter's due attacks, in emitter order. */
export function runEmitters(ctx: RunContext): void {
  const emitters = ctx.emitters;
  for (let i = 0; i < emitters.length; i++) {
    const em = emitters[i] as EmitterRuntime;
    EMITTER_STEPS[em.spec.kind](ctx, em);
  }
}

/** The rule modules' tick hooks, after this tick's attacks (src/sim/rules/module.ts). */
export function runTickHooks(ctx: RunContext): void {
  for (const hook of ctx.build.hooks.tick) hook(ctx);
}
