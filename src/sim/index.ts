/** Run simulation: public contract and the deterministic implementation. */

export * from './types';
export { BURN_TICK_INTERVAL, createSimulation } from './simulation';
export { compileRules, NO_RULES } from './rules';
export { damageRow } from './build/modTable';
export type { RuleEffects } from './rules';
