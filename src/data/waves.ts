/** Wave composition (docs/GDD.md §2.1, §2.4). Expand with src/data/compose.ts. */

import type { WaveTable } from './types';

export const WAVES = {
  rules: [
    { enemy: 'triangle', fromWave: 1, base: 5, perWave: 0.4, maxCount: 24 },
    { enemy: 'square', fromWave: 3, base: 2, perWave: 0.25, maxCount: 12 },
    { enemy: 'pentagon', fromWave: 8, base: 1, perWave: 0.15, maxCount: 6 },
  ],
  eliteEvery: 5,
  bossEvery: 10,
  spawnDurationSec: 1,
  waveTimerSec: 8,
} satisfies WaveTable;
