/**
 * Character constructs (docs/v3/game-design-v3.md §11.3): what stands at the arena center in
 * place of the M1 hexagon, one per character. The ids are CharacterDef.construct values
 * (docs/v3/implementation-plan-v3.md §2.13), defined with the web's content types in
 * src/data/web/types.ts and re-exported here; the sim never sees them.
 */

import type { ConstructId } from '../../data/web/types';
import { FrostCrystalView } from './frostCrystal';
import { HiveView } from './hive';
import { MagmaCoreView } from './magmaCore';
import type { ConstructView } from './shared';
import { TeslaTowerView } from './teslaTower';

export type { ConstructView } from './shared';
export { MAX_PART_OFFSET } from './shared';
export { CONSTRUCT_IDS } from '../../data/web/types';
export type { ConstructId } from '../../data/web/types';

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
