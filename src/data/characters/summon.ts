/**
 * 蜂巢 (summon): its select card from gd (colour and difficulty gd:33, reveal sets gd:304-305,
 * enemy row gd:738). Its center and its ascendancies are B2's; until then they are null, which the
 * select screen shows as 「製作中」 (docs/v3 C6 design D14).
 */

import { defineCharacter } from '../templates';

export const SUMMON = defineCharacter({
  id: 'summon',
  color: 0x9bf25c,
  center: null,
  ascendancies: null,
  recommendedOuter: ['fire', 'ice', 'crit'],
  revealAt15: ['poison', 'lightning', 'thorns'],
  enemyRow: {
    triangle: 'even',
    square: 'even',
    pentagon: 'even',
    shielder: 'weak',
    regenerator: 'even',
    dasher: 'weak',
    shooter: 'strong',
    summoner: 'strong',
    treasure: 'strong',
    boss: 'even',
  },
  difficulty: 2,
  construct: 'hive',
  defaultOrder: [],
});
