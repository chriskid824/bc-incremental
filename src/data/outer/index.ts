/** The registered outers, one line per outer (docs/v3 C6 design §5.3). */

import type { Content } from '../web/types';
import { CRIT } from './crit';
import { FIRE } from './fire';
import { ICE } from './ice';
import { POISON } from './poison';
import { SUMMON } from './summon';

export const OUTERS: Content['outers'] = {
  fire: FIRE,
  poison: POISON,
  crit: CRIT,
  ice: ICE,
  summon: SUMMON,
};
