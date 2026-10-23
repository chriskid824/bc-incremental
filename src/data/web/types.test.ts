import { describe, expect, it } from 'vitest';
import { ENEMY_IDS } from '../types';
import { ROW_ENEMIES, rowEnemyOf } from './types';

describe('rowEnemyOf (docs/v3 C7 design §1.7)', () => {
  it('puts each type in its own column, a shard in the pentagon’s, every boss in the Boss column and the elite in none', () => {
    expect(ENEMY_IDS.map((id) => [id, rowEnemyOf(id)])).toEqual([
      ['triangle', 'triangle'],
      ['square', 'square'],
      ['pentagon', 'pentagon'],
      ['shard', 'pentagon'],
      ['hexagon', null],
      ['boss', 'boss'],
      ['shielder', 'shielder'],
      ['regenerator', 'regenerator'],
      ['dasher', 'dasher'],
      ['shooter', 'shooter'],
      ['summoner', 'summoner'],
      ['treasure', 'treasure'],
      ['onion', 'boss'],
    ]);
  });

  it('gives every ROW_ENEMIES column at least one type', () => {
    for (const column of ROW_ENEMIES) {
      expect(
        ENEMY_IDS.filter((id) => rowEnemyOf(id) === column),
        column,
      ).not.toEqual([]);
    }
  });
});
