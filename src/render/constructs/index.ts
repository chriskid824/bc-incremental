/**
 * Character constructs (docs/v3/game-design-v3.md §11.3): what stands at the arena center in
 * place of the M1 hexagon, one per character. The ids are CharacterDef.construct values
 * (docs/v3/implementation-plan-v3.md §2.13); the sim never sees them.
 */

import { FrostCrystalView } from './frostCrystal';
import { HiveView } from './hive';
import { MagmaCoreView } from './magmaCore';
import type { ConstructView } from './shared';
import { TeslaTowerView } from './teslaTower';

export type { ConstructView } from './shared';
export { MAX_PART_OFFSET } from './shared';

export type ConstructId = 'magmaCore' | 'frostCrystal' | 'teslaTower' | 'hive';

/** In character order: 熔核, 霜晶, 雷塔, 蜂巢. */
export const CONSTRUCT_IDS: readonly ConstructId[] = [
  'magmaCore',
  'frostCrystal',
  'teslaTower',
  'hive',
];

export function createConstructView(id: ConstructId): ConstructView {
  switch (id) {
    case 'magmaCore':
      return new MagmaCoreView();
    case 'frostCrystal':
      return new FrostCrystalView();
    case 'teslaTower':
      return new TeslaTowerView();
    case 'hive':
      return new HiveView();
  }
}
