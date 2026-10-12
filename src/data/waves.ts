/** Wave composition (docs/GDD.md §2.1, §2.4). Expand with src/data/compose.ts. */

import type { WaveTable } from './types';

export const WAVES = {
  rules: [
    { enemy: 'triangle', fromWave: 1, base: 20, perWave: 1.6, maxCount: 96 },
    { enemy: 'square', fromWave: 3, base: 8, perWave: 1, maxCount: 48 },
    { enemy: 'pentagon', fromWave: 8, base: 4, perWave: 0.6, maxCount: 24 },
  ],
  eliteEvery: 5,
  bossEvery: 10,
  spawnDurationSec: 2,
  waveTimerSec: 12,
} satisfies WaveTable;
