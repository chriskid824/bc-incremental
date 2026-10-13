/**
 * Trigger vocabulary (docs/v3/implementation-plan-v3.md §2.6). So far only the ailment kinds,
 * which damage attribution reads (src/data/sources.ts).
 */

/** Ailments an enemy can carry. The order is fixed: simulation bitsets index it. */
export const AILMENT_KINDS = ['burn', 'poison', 'bleed', 'shock', 'frost'] as const;
export type AilmentKind = (typeof AILMENT_KINDS)[number];
