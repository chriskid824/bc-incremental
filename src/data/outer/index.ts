/**
 * The registered outers, one line per outer (`poison: POISON`, docs/v3 C6 design §5.3); empty
 * until B1 writes the first.
 */

import type { Content } from '../web/types';

export const OUTERS: Content['outers'] = {};
