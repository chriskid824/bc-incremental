/**
 * The v3 wave table (docs/v3/game-design-v3.md §6, docs/v3 C7 design §1.2): M1's table plus the
 * new types' rules and the `v3` block, which makes a run that receives it a v3 run. Only
 * characterGameData (src/data/index.ts) hands it out. First waves are the game design's; counts
 * are initial values (初始值): a new type starts at about a third of the square's base and grows
 * at 0.3 of its rate, with fewer of the ranged ones, and no max above the pentagon's 24.
 */

import type { WaveTable } from './types';
import { WAVES } from './waves';

export const V3_WAVES = {
  ...WAVES,
  rules: [
    ...WAVES.rules,
    { enemy: 'shielder', fromWave: 12, base: 3, perWave: 0.3, maxCount: 18 },
    { enemy: 'regenerator', fromWave: 16, base: 3, perWave: 0.3, maxCount: 18 },
    { enemy: 'dasher', fromWave: 22, base: 3, perWave: 0.3, maxCount: 18 },
    { enemy: 'shooter', fromWave: 32, base: 2, perWave: 0.2, maxCount: 10 },
    { enemy: 'summoner', fromWave: 42, base: 1, perWave: 0.1, maxCount: 4 },
  ],
  v3: {
    /** game-design-v3 §6.1's 400 at once. */
    enemyCap: 400,
    /**
     * game-design-v3 §6.3: with bossEvery 10, the onion at 10, 40, 70, 母巢 at 20, 50, 80 and 稜鏡
     * at 30, 60, 90 (bossOf, src/data/compose.ts). Wave 100 takes the rotation's onion until 奇點
     * (B5) has its own boss.
     */
    bossRotation: ['onion', 'brood', 'prism'],
    /** game-design-v3 §6.2: one affix from wave 5, two from 25, three from 60. */
    affixes: [
      { fromWave: 5, count: 1 },
      { fromWave: 25, count: 2 },
      { fromWave: 60, count: 3 },
    ],
    /** From wave 15 (game-design-v3 §6.1), then one per elite cadence: about one a minute. */
    treasure: { enemy: 'treasure', fromWave: 15, every: 5 },
  },
} satisfies WaveTable;
