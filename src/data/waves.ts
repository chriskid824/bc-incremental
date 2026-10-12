/** Wave composition (docs/GDD.md §2.1, §2.4). Expand with src/data/compose.ts. */

import type { WaveTable } from './types';

export const WAVES = {
  rules: [
    { enemy: 'triangle', fromWave: 1, base: 6, perWave: 0.6, maxCount: 40 },
    { enemy: 'square', fromWave: 3, base: 2, perWave: 0.3, maxCount: 20 },
    { enemy: 'pentagon', fromWave: 8, base: 1, perWave: 0.2, maxCount: 12 },
  ],
  eliteEvery: 5,
  bossEvery: 10,
  spawnDurationSec: 1,
  waveTimerSec: 8,
} satisfies WaveTable;
