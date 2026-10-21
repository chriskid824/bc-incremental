/**
 * 熔核 (fire): its select card from gd (colour and difficulty gd:30, reveal sets gd:304-305, enemy
 * row gd:735). Its center is B1's and its ascendancies are B2's; until then they are null, which
 * the select screen shows as 「製作中」 (docs/v3 C6 design D14). Under the 10/28 fallback B1 also
 * rewrites the two reveal sets (impl:282; D29).
 */

import { defineCharacter } from '../templates';

export const FIRE = defineCharacter({
  id: 'fire',
  color: 0xff7a2f,
  center: null,
  ascendancies: null,
  recommendedOuter: ['ice', 'crit', 'summon'],
  revealAt15: ['poison', 'lightning', 'thorns'],
  enemyRow: {
    triangle: 'even',
    square: 'strong',
    pentagon: 'even',
    shielder: 'strong',
    regenerator: 'strong',
    dasher: 'weak',
    shooter: 'even',
    summoner: 'weak',
    treasure: 'weak',
    boss: 'strong',
  },
  difficulty: 1,
  construct: 'magmaCore',
  defaultOrder: [],
});
