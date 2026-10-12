import { ZERO } from '../core/num';
import type { MetaState } from './types';

/** A fresh profile: no currencies, no talents, no runs. */
export function createMetaState(): MetaState {
  return {
    shards: ZERO,
    cores: 0,
    allocated: new Set(),
    ranks: new Map(),
    maxWave: 0,
    runs: 0,
    spentShards: ZERO,
    spentCores: 0,
  };
}
