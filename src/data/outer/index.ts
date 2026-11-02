/** The registered outers, one line per outer (docs/v3 C6 design §5.3). */

import type { Content } from '../web/types';
import { CRIT } from './crit';
import { POISON } from './poison';

export const OUTERS: Content['outers'] = {
  poison: POISON,
  crit: CRIT,
};
