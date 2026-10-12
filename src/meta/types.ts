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
  readonly shardsFromRun: Num;
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

export const DEFAULT_ECONOMY: EconomyConfig = {
  talentBaseShards: 5,
  talentGrowth: 1.6,
  startWaveRatio: 0.5,
  skipRewardRate: 1,
};
