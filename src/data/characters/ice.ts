/**
 * 霜晶 (ice): its select card from gd (colour and difficulty gd:31, reveal sets gd:304-305, enemy
 * row gd:736). Its center is B3's and its ascendancies are B5's; until then they are null, which
 * the select screen shows as 「製作中」 (docs/v3 C6 design D14).
 */

import { defineCharacter } from '../templates';

export const ICE = defineCharacter({
  id: 'ice',
  color: 0x8fe3ff,
  center: null,
  ascendancies: null,
  recommendedOuter: ['fire', 'poison', 'crit'],
  revealAt15: ['lightning', 'bleed', 'summon'],
  enemyRow: {
    triangle: 'strong',
    square: 'even',
    pentagon: 'strong',
    shielder: 'weak',
    regenerator: 'weak',
    dasher: 'strong',
    shooter: 'even',
    summoner: 'even',
    treasure: 'strong',
    boss: 'weak',
  },
  difficulty: 2,
  construct: 'frostCrystal',
  defaultOrder: [],
});
