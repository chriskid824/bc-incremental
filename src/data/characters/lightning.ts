/**
 * 雷塔 (lightning): its select card from gd (colour and difficulty gd:32, reveal sets gd:304-305,
 * enemy row gd:737). Its center is B4's and its ascendancies are B5's; until then they are null,
 * which the select screen shows as 「製作中」 (docs/v3 C6 design D14).
 */

import { defineCharacter } from '../templates';

export const LIGHTNING = defineCharacter({
  id: 'lightning',
  color: 0xb48cff,
  center: null,
  ascendancies: null,
  recommendedOuter: ['fire', 'crit', 'poison'],
  revealAt15: ['ice', 'bleed', 'barrage'],
  enemyRow: {
    triangle: 'strong',
    square: 'even',
    pentagon: 'strong',
    shielder: 'weak',
    regenerator: 'even',
    dasher: 'strong',
    shooter: 'strong',
    summoner: 'strong',
    treasure: 'even',
    boss: 'weak',
  },
  difficulty: 1,
  construct: 'teslaTower',
  defaultOrder: [],
});
