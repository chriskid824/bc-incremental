/**
 * The characters, all four registered from C6.3 with their select cards (docs/v3 C6 design D14,
 * F44); a character whose center is null is 「製作中」 until its batch writes the center.
 */

import type { CharacterDef, Content } from '../web/types';
import { FIRE } from './fire';
import { ICE } from './ice';
import { LIGHTNING } from './lightning';
import { SUMMON } from './summon';

export const CHARACTERS: Content['characters'] = {
  fire: FIRE,
  ice: ICE,
  lightning: LIGHTNING,
  summon: SUMMON,
};

/** The select card's 「第一次玩推薦」 (gd §1.1; AMB7). */
export const FIRST_PICK: CharacterDef['id'] = 'fire';
