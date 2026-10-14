/**
 * The simulation's spec caps (docs/v3/implementation-plan-v3.md §2.4–§2.6): fixed limits that
 * bound one attack's or one system's work. Each cap counts what it refuses in a RunResult
 * counter (COUNTER_IDS, src/sim/types.ts).
 */

/**
 * Hits of one attack, its primary hit and every chain jump together (src/sim/combat/chain.ts);
 * the jumps it refuses count in chainHitCapped.
 */
export const CHAIN_HIT_CAP = 32;
