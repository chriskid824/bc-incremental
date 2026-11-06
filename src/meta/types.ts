/**
 * Progress outside runs (docs/GDD.md §4–6): currencies, talent allocation, run settlement.
 * Pure and deterministic. Prestige and ascendancies arrive in M2.
 */

import type { Num } from '../core/num';

export interface MetaState {
  shards: Num;
  cores: number;
  /** Allocated talent ids (excluding the start node, which is always allocated). */
  readonly allocated: Set<string>;
  /** Ranks bought on repeatable nodes, by node id. */
  readonly ranks: Map<string, number>;
  /** Highest wave reached in the current prestige cycle. */
  maxWave: number;
  runs: number;
  /** Totals spent on talents since the last full refund, returned by refundAll. */
  spentShards: Num;
  spentCores: number;
}

export interface Settlement {
  /** The run's own shards (RunResult.shards, SimState.shards), without its interest. */
  readonly shardsFromRun: Num;
  /**
   * The run's interest pool (利息, RunResult.interestShards, SimState.interestShards; E17), which
   * the settlement credits beside shardsFromRun; zero without an interest effect.
   */
  readonly interestFromRun: Num;
  readonly coresFromRun: number;
  /** Expected drops of the skipped waves × skipRewardRate; zero if the start wave was not cleared. */
  readonly skipShards: Num;
  readonly skipCores: number;
}

export interface EconomyConfig {
  /** Global shard price of the nth allocated node: baseShards × growth^n. */
  readonly talentBaseShards: number;
  readonly talentGrowth: number;
  /** Allowed start wave = max(1, floor(maxWave × startWaveRatio)). */
  readonly startWaveRatio: number;
  readonly skipRewardRate: number;
}

/**
 * Tuned with the balance simulator (docs/GDD.md §4.2, §9.1): the first node fits in the
 * ~200 shards of the first run; ×1.31 per node spreads a sector over the first ~15 minutes.
 */
export const DEFAULT_ECONOMY: EconomyConfig = {
  talentBaseShards: 180,
  talentGrowth: 1.31,
  startWaveRatio: 0.5,
  skipRewardRate: 1,
};
