import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../sources';
import { CharacterDefSchema } from '../web/schema';
import { CONSTRUCT_IDS, ROW_ENEMIES } from '../web/types';
import type { Mark } from '../web/types';
import { CHARACTERS, FIRST_PICK } from '.';

/** gd's select cards: colour and difficulty (gd:30-33), the two reveal sets (gd:304-305). */
const CARDS = {
  fire: {
    color: 0xff7a2f,
    difficulty: 1,
    construct: 'magmaCore',
    recommendedOuter: ['ice', 'crit', 'summon'],
    revealAt15: ['poison', 'lightning', 'thorns'],
  },
  ice: {
    color: 0x8fe3ff,
    difficulty: 2,
    construct: 'frostCrystal',
    recommendedOuter: ['fire', 'poison', 'crit'],
    revealAt15: ['lightning', 'bleed', 'summon'],
  },
  lightning: {
    color: 0xb48cff,
    difficulty: 1,
    construct: 'teslaTower',
    recommendedOuter: ['fire', 'crit', 'poison'],
    revealAt15: ['ice', 'bleed', 'barrage'],
  },
  summon: {
    color: 0x9bf25c,
    difficulty: 2,
    construct: 'hive',
    recommendedOuter: ['fire', 'ice', 'crit'],
    revealAt15: ['poison', 'lightning', 'thorns'],
  },
} as const;

/**
 * gd §6.4's rows (gd:735-738) as gd writes them, columns 三角 方塊 五角 盾兵 再生 衝刺 射手 召喚者
 * 寶藏 Boss.
 */
const ROWS = {
  fire: '△✓△✓✓✗△✗✗✓',
  ice: '✓△✓✗✗✓△△✓✗',
  lightning: '✓△✓✗△✓✓✓△✗',
  summon: '△△△✗△✗✓✓✓△',
} as const;
const GLYPH: Readonly<Record<Mark, string>> = { strong: '✓', even: '△', weak: '✗' };

describe('the characters (D14, F44)', () => {
  it('registers all four, each under its own id, in CHARACTER_IDS order', () => {
    expect(Object.keys(CHARACTERS)).toEqual([...CHARACTER_IDS]);
    for (const c of CHARACTER_IDS) expect(CHARACTERS[c].id).toBe(c);
  });

  it.each(CHARACTER_IDS)("gives %s gd's select card", (c) => {
    const def = CHARACTERS[c];
    const card = CARDS[c];
    expect(def.color).toBe(card.color);
    expect(def.difficulty).toBe(card.difficulty);
    expect(def.construct).toBe(card.construct);
    expect(def.recommendedOuter).toEqual(card.recommendedOuter);
    expect(def.revealAt15).toEqual(card.revealAt15);
  });

  it.each(CHARACTER_IDS)("gives %s gd's enemy row", (c) => {
    const row = CHARACTERS[c].enemyRow;
    expect(Object.keys(row)).toEqual([...ROW_ENEMIES]);
    expect(ROW_ENEMIES.map((enemy) => GLYPH[row[enemy]]).join('')).toBe(ROWS[c]);
  });

  it.each(CHARACTER_IDS)(
    'builds %s as 「製作中」: no center, no ascendancies, no 預設 build',
    (c) => {
      const def = CHARACTERS[c];
      expect([def.center, def.ascendancies, def.defaultOrder]).toEqual([null, null, []]);
      expect(def.archetype).toBe(c);
      expect(def.arena).toBe(c);
      expect(CharacterDefSchema.safeParse(def).success).toBe(true);
    },
  );

  it('gives each character its own construct, in CONSTRUCT_IDS order', () => {
    expect(CHARACTER_IDS.map((c) => CHARACTERS[c].construct)).toEqual([...CONSTRUCT_IDS]);
  });

  it.each(CHARACTER_IDS)(
    'keeps the reveal sets of %s distinct, disjoint and off its archetype',
    (c) => {
      const { recommendedOuter, revealAt15 } = CHARACTERS[c];
      const all = [...recommendedOuter, ...revealAt15];
      expect(new Set(all).size).toBe(6);
      expect(all).not.toContain(c);
    },
  );

  it('recommends 熔核 to a first player (gd §1.1)', () => {
    expect(FIRST_PICK).toBe('fire');
    expect(CHARACTERS[FIRST_PICK].id).toBe('fire');
  });
});
