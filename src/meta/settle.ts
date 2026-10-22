/**
 * Start-wave choice and run settlement with skip compensation (docs/GDD.md §2.2).
 */

import { add, assertFinite, mul, num, ZERO } from '../core/num';
import type { Num } from '../core/num';
import { composeWave } from '../data/compose';
import { shardsPerStdEnemy } from '../data/curve';
import type { StatBlock } from '../data/stats';
import type { EnemyId, GameData } from '../data/types';
import type { RunResult, SimState } from '../sim/types';
import type { EconomyConfig, MetaState, Settlement } from './types';

/**
 * What a settlement credits: M1's MetaState, or the copy settleWebRun makes of a v3 character's
 * progress (docs/v3 C6 design D21).
 */
export type SettleTarget = Pick<MetaState, 'shards' | 'cores' | 'maxWave' | 'runs'>;

/** Highest start wave the player may pick: max(1, floor(maxWave × startWaveRatio)). */
export function allowedStartWave(
  meta: Readonly<Pick<MetaState, 'maxWave'>>,
  economy: Pick<EconomyConfig, 'startWaveRatio'>,
): number {
  return Math.max(1, Math.floor(meta.maxWave * economy.startWaveRatio));
}

interface DropUnits {
  /** Σ dropMult over the enemy and everything it splits into. */
  readonly shardMult: number;
  /** Σ cores over the enemy and everything it splits into, before coreGain. */
  readonly cores: number;
}

function dropUnits(enemy: EnemyId, data: GameData, visiting: Set<EnemyId>): DropUnits {
  if (visiting.has(enemy)) throw new Error(`Cyclic splitInto through enemy ${enemy}`);
  const def = data.enemies[enemy];
  let shardMult = def.dropMult;
  let cores = def.cores;
  if (def.splitInto) {
    visiting.add(enemy);
    const child = dropUnits(def.splitInto.enemy, data, visiting);
    visiting.delete(enemy);
    shardMult += def.splitInto.count * child.shardMult;
    cores += def.splitInto.count * child.cores;
  }
  return { shardMult, cores };
}

/**
 * Expected drops for killing every enemy of a wave, including split children (which belong
 * to the same wave). Cores are an expected value and may be fractional.
 */
export function expectedWaveDrops(
  wave: number,
  data: GameData,
  stats: StatBlock,
): { shards: Num; cores: number } {
  let shardMult = 0;
  let cores = 0;
  for (const entry of composeWave(wave, data.waves)) {
    const units = dropUnits(entry.enemy, data, new Set());
    shardMult += entry.count * units.shardMult;
    cores += entry.count * units.cores;
  }
  return {
    shards: mul(num(shardsPerStdEnemy(wave)), shardMult * stats.values.shardGain),
    cores: cores * stats.values.coreGain,
  };
}

/** Absorbs float error so an expected 2.9999999999999996 cores still pays 3. */
const CORE_FLOOR_EPSILON = 1e-9;

/**
 * Credits a finished run to the profile. Run drops are added as reported (the simulation
 * already applied shardGain/coreGain). If the run started past wave 1 and cleared its start
 * wave, the expected drops of waves 1..startWave−1 × skipRewardRate are added too, with
 * skip cores floored. Also updates maxWave and the run counter.
 */
export function settleRun(
  meta: SettleTarget,
  result: RunResult,
  data: GameData,
  stats: StatBlock,
  economy: Pick<EconomyConfig, 'skipRewardRate'>,
): Settlement {
  let skipShards = ZERO;
  let skipCores = 0;
  if (result.clearedStartWave && result.startWave > 1) {
    let expectedCores = 0;
    for (let wave = 1; wave < result.startWave; wave++) {
      const drops = expectedWaveDrops(wave, data, stats);
      skipShards = add(skipShards, drops.shards);
      expectedCores += drops.cores;
    }
    skipShards = mul(skipShards, economy.skipRewardRate);
    skipCores = Math.floor(expectedCores * economy.skipRewardRate + CORE_FLOOR_EPSILON);
  }

  meta.shards = assertFinite(add(meta.shards, add(result.shards, skipShards)), 'settleRun shards');
  meta.cores += result.cores + skipCores;
  meta.maxWave = Math.max(meta.maxWave, result.highestWaveReached);
  meta.runs += 1;

  return {
    shardsFromRun: result.shards,
    coresFromRun: result.cores,
    skipShards,
    skipCores,
  };
}

/**
 * Credits a run that stopped before it finished, because the page was closed or reloaded
 * mid-run: the drops collected so far, the highest wave reached and the run counter. No skip
 * compensation, since the run never finished clearing its start wave on record.
 */
export function settleUnfinishedRun(
  meta: SettleTarget,
  progress: Pick<SimState, 'shards' | 'cores' | 'highestWaveReached'>,
): Settlement {
  meta.shards = assertFinite(add(meta.shards, progress.shards), 'settleUnfinishedRun shards');
  meta.cores += progress.cores;
  meta.maxWave = Math.max(meta.maxWave, progress.highestWaveReached);
  meta.runs += 1;
  return {
    shardsFromRun: progress.shards,
    coresFromRun: progress.cores,
    skipShards: ZERO,
    skipCores: 0,
  };
}
