/** The registered outers, one line per outer (docs/v3 C6 design §5.3). */

import type { Content } from '../web/types';
import { BARRAGE } from './barrage';
import { BLEED } from './bleed';
import { CRIT } from './crit';
import { FIRE } from './fire';
import { ICE } from './ice';
import { LIGHTNING } from './lightning';
import { POISON } from './poison';
import { SUMMON } from './summon';

export const OUTERS: Content['outers'] = {
  fire: FIRE,
  poison: POISON,
  bleed: BLEED,
  lightning: LIGHTNING,
  crit: CRIT,
  ice: ICE,
  summon: SUMMON,
  barrage: BARRAGE,
};
