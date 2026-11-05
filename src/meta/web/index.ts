/**
 * The v3 web's progress, prices, purchase rules, paths, reveal and run builds (docs/v3 C6 design
 * §3.8), for B1's web UI and run loop, C8's loader and the tools. The modules' other exports (the
 * audits' helpers in invest.ts, counts.ts' readers) stay internal to src/meta/web.
 */

export type {
  AccountProgress,
  BoardCounts,
  BuyCheck,
  ChallengeRules,
  CharacterProgress,
  GateProgress,
  OuterView,
  Price,
  PriceCurve,
  RefundPreview,
  Wallet,
  WebEconomy,
} from './types';
export {
  canonicalCost,
  DEFAULT_WEB_ECONOMY,
  economyIssues,
  nextPrice,
  PRICE_CURVE_OF,
} from './price';
export {
  boardCounts,
  BUY_REASONS,
  buy,
  canBuy,
  CHALLENGE_RULES,
  emptyProgress,
  fusionProgress,
  fusionSlotOrder,
  fusionSlots,
  legalize,
  refundAll,
  refundNode,
  refundPreview,
  WEB_RULES,
} from './rules';
export type { BuyReason } from './rules';
export { buyPath, planPath } from './path';
export type { PathPlan } from './path';
export { outerView, revealedOuters } from './reveal';
export { suggest, SUGGESTED_NODES, threatsOf } from './suggest';
export type { SuggestedNode, SuggestedOuter, Suggestions, ThreatTallies } from './suggest';
export { settleWebRun, webBuild, webRunConfig, webStartWave } from './build';
export type { WebRun } from './build';
export { defaultProgress, progressFromOrder, unlockInvestment } from './invest';
export {
  canPrestige,
  prestige,
  PRESTIGE_RULES,
  prestigeResonance,
  resonanceDamageMore,
} from './prestige';
export { buyabilityIssues, orderIssues } from './buyable';
