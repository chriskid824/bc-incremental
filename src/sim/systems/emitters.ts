/**
 * Emitters system (docs/v3/implementation-plan-v3.md §2.15): every emitter of the build that
 * attacks in this stage does, in emitter order, the signature attack first (src/sim/emitters/);
 * then the rule modules' tick hooks run. Emitters of the kinds another stage runs (contact,
 * segments) are not in this stage's list (RunContext.stepEmitters).
 */

import type { EmitterRuntime, EmitterSpec } from '../emitters/types';
import { runVolley } from '../emitters/volley';
import type { RunContext } from './context';

/** What an emitter does in the emitter stage each tick. */
export type EmitterStep = (ctx: RunContext, em: EmitterRuntime) => void;

/**
 * The step of each emitter kind; null for a kind another stage runs. Typed over the kinds, so a
 * new kind needs its entry here.
 */
export const EMITTER_STEPS: { readonly [K in EmitterSpec['kind']]: EmitterStep | null } = {
  volley: runVolley,
};

/** Fires every due attack of the emitter stage's emitters, in emitter order. */
export function runEmitters(ctx: RunContext): void {
  const emitters = ctx.stepEmitters;
  for (let i = 0; i < emitters.length; i++) {
    const em = emitters[i] as EmitterRuntime;
    (EMITTER_STEPS[em.spec.kind] as EmitterStep)(ctx, em);
  }
}

/** The rule modules' tick hooks, after this tick's attacks (src/sim/rules/module.ts). */
export function runTickHooks(ctx: RunContext): void {
  for (const hook of ctx.build.hooks.tick) hook(ctx);
}
