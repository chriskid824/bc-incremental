/**
 * Emitters system (docs/v3/implementation-plan-v3.md §2.15): every emitter of the build that
 * attacks in this stage does, in emitter order, the signature attack first (src/sim/emitters/),
 * then the grants' strikes; then the rule modules' tick hooks run. runEmitters skips the kinds
 * whose EMITTER_STEPS entry is null, which another stage runs (thorns in the contact stage,
 * segments in their own).
 */

import { runFan } from '../emitters/fan';
import { runLob } from '../emitters/lob';
import { runStrike } from '../emitters/strike';
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
  lob: runLob,
  fan: runFan,
  // Its hits come with the contacts (src/sim/systems/contact.ts).
  thorns: null,
  // Its judgements come in the segment stage (src/sim/systems/segments.ts).
  segment: null,
  strike: runStrike,
};

/**
 * Fires every due attack of the emitter stage's emitters, in emitter order (RunContext.emitters),
 * skipping those of a kind whose step is null.
 */
export function runEmitters(ctx: RunContext): void {
  const emitters = ctx.emitters;
  for (let i = 0; i < emitters.length; i++) {
    const em = emitters[i] as EmitterRuntime;
    const step = EMITTER_STEPS[em.spec.kind];
    if (step !== null) step(ctx, em);
  }
}

/** The rule modules' tick hooks, after this tick's attacks (src/sim/rules/module.ts). */
export function runTickHooks(ctx: RunContext): void {
  for (const hook of ctx.build.hooks.tick) hook(ctx);
}
