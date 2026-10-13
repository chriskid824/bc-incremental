/**
 * Trigger vocabulary (docs/v3/implementation-plan-v3.md §2.6). So far the ailment kinds, which
 * damage attribution reads (src/data/sources.ts), and the scaling of modifiers whose value
 * depends on the damage instance (Modifier.scaling).
 */

/** Ailments an enemy can carry. The order is fixed: simulation bitsets index it. */
export const AILMENT_KINDS = ['burn', 'poison', 'bleed', 'shock', 'frost'] as const;
export type AilmentKind = (typeof AILMENT_KINDS)[number];

/**
 * What a scaling modifier counts, read per damage instance. `chainJump`: the instance's chain
 * jump index, 0 for the primary hit. The simulation reads each variable through a registry
 * typed over this list (src/sim/build/eval.ts), so a new variable lands with its reader.
 */
export const SCALING_VARS = ['chainJump'] as const;
export type ScalingVar = (typeof SCALING_VARS)[number];

export const SCALING_CURVES = ['linear', 'log10', 'pow'] as const;
export type ScalingCurve = (typeof SCALING_CURVES)[number];

/**
 * How a modifier's value scales with a variable x (Modifier.scaling): its contribution is
 * c = min(cap, value × g(x)). With `every`, x first steps down to floor(x / every); then g is x
 * (linear, the default), log10(1 + x) or x^exponent (pow). A flat or increased modifier adds c,
 * a more modifier multiplies by 1 + c.
 */
export interface ScalingSpec {
  readonly per: ScalingVar;
  /** Step size: x counts whole steps of `every`. Continuous without it. */
  readonly every?: number;
  readonly curve?: ScalingCurve;
  /** Exponent of the pow curve; required exactly with curve 'pow'. */
  readonly exponent?: number;
  /** Upper bound on the contribution. Uncapped without it. */
  readonly cap?: number;
}
