/**
 * card.ts (docs/v3 C6 design §3.9, §4.7): the preview card, 熔核 × poison as §4.7 draws it in
 * both locales, a hand fusion's, an outer the scope locks, the gate on the card's own outer, and
 * 冰光's and 雷光's hand rules at three coefs.
 */

import { describe, expect, it } from 'vitest';
import { flat } from '../../data/templates';
import { assembleWeb, DEMO_SCOPE_A, FULL_SCOPE } from '../../data/web';
import type { Content } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import { emptyProgress } from '../../meta/web';
import type { CharacterProgress } from '../../meta/web';
import { previewCard } from './card';
import { fixtureLookups } from './testing';

const lookups = fixtureLookups();

/** The fixture with poison's entry at §4.7's 「你的擊中 15% 中毒」 (the fixture's has no effect). */
function withPoisonEntry(): Content {
  const content = fixtureContent();
  const poison = content.outers.poison;
  if (poison === undefined) throw new Error('the fixture has no poison outer');
  const nodes = poison.board.nodes.map((node) =>
    node.kind === 'entry'
      ? { ...node, effects: { ...node.effects, modifiers: [flat('poisonChance', 0.15)] } }
      : node,
  );
  return {
    ...content,
    outers: { ...content.outers, poison: { ...poison, board: { ...poison.board, nodes } } },
  };
}

/** 熔核 with `ids` owned at rank 1. */
const owning = (ids: readonly string[]): CharacterProgress => ({
  ...emptyProgress('fire'),
  ranks: Object.fromEntries(ids.map((id) => [id, 1])),
});

const CENTER = [
  ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((slot) => `fire.center.main.${slot}`),
  'fire.center.alpha.r1',
  'fire.center.alpha.r2',
];

describe('previewCard (§3.9, §4.7)', () => {
  const fire = assembleWeb(withPoisonEntry(), 'fire', FULL_SCOPE);
  const progress = owning([
    ...CENTER,
    'outer.poison.main.entry',
    'outer.poison.alpha.r1',
    'outer.poison.alpha.r2',
  ]);

  it('shows 熔核 × poison as §4.7 draws it, in zh-TW', () => {
    expect(previewCard(fire, progress, 'poison', lookups['zh-TW'])).toEqual({
      outer: '毒',
      entry: ['中毒機率 +15%'],
      fusion: {
        name: '火毒',
        title: '瘟爆',
        hand: false,
        rule: [
          '每次爆炸，對範圍內最多 5 隻敵人：毒 2 層',
          '中毒的敵人受到中心傷害 +20%',
          '中毒的敵人被燃燒殺死時：把毒層以 50% 的效果傳給半徑 90 內的敵人',
        ],
      },
      covers: {
        answer: ['三角', '五角', '盾兵', '衝刺者'],
        helps: ['方塊', '射手', '召喚者', 'Boss'],
      },
      gate: { center: 8, centerNeed: 8, outer: 3, outerNeed: 6 },
    });
  });

  it('shows the same card in English', () => {
    expect(previewCard(fire, progress, 'poison', lookups.en)).toEqual({
      outer: 'Poison',
      entry: ['+15% Poison chance'],
      fusion: {
        name: 'Fire Poison',
        title: 'Plague Bomb',
        hand: false,
        rule: [
          'Each explosion: 2 poison stacks on up to 5 enemies in the blast',
          'Poisoned enemies take +20% center damage',
          'When poisoned enemies are killed by burn: spread the poison stacks at 50% strength to the enemies within 90',
        ],
      },
      covers: {
        answer: ['Triangle', 'Pentagon', 'Shielder', 'Dasher'],
        helps: ['Square', 'Shooter', 'Summoner', 'Boss'],
      },
      gate: { center: 8, centerNeed: 8, outer: 3, outerNeed: 6 },
    });
  });

  it("shows a hand fusion's description as its rule", () => {
    expect(previewCard(fire, progress, 'ice', lookups['zh-TW']).fusion).toEqual({
      name: '火冰',
      title: '霜焰',
      hand: true,
      rule: ['每第 3 發必定暴擊，暴擊倍率 ×1.5；不會隨機暴擊。'],
    });
  });

  it('counts the gate on the outer the card is for', () => {
    const ice = ['entry', 'alpha.r1', 'alpha.r2', 'alpha.r3', 'beta.r1'].map((slot) =>
      slot === 'entry' ? 'outer.ice.main.entry' : `outer.ice.${slot}`,
    );
    const both = owning([...CENTER, 'outer.poison.main.entry', 'outer.poison.alpha.r1', ...ice]);
    expect(previewCard(fire, both, 'poison', lookups.en).gate).toEqual({
      center: 8,
      centerNeed: 8,
      outer: 2,
      outerNeed: 6,
    });
    expect(previewCard(fire, both, 'ice', lookups.en).gate.outer).toBe(5);
  });

  it('shows an outer the scope locks by its name and gate only', () => {
    const demo = assembleWeb(withPoisonEntry(), 'fire', DEMO_SCOPE_A);
    const card = previewCard(demo, owning(CENTER), 'lightning', lookups['zh-TW']);
    expect(card).toMatchObject({
      outer: '雷',
      entry: [],
      fusion: null,
      covers: { answer: [], helps: [] },
    });
    expect(card.gate.center).toBe(8);
    expect(previewCard(demo, owning(CENTER), 'poison', lookups['zh-TW']).fusion?.title).toBe(
      '瘟爆',
    );
  });

  it('shows no fusion for a deferred fusion, its open outer still with entry and covers (§3.9)', () => {
    const deferred = assembleWeb(withPoisonEntry(), 'fire', {
      ...FULL_SCOPE,
      deferredFusions: ['fire.poison'],
    });
    expect(previewCard(deferred, owning(CENTER), 'poison', lookups.en)).toMatchObject({
      outer: 'Poison',
      entry: ['+15% Poison chance'],
      fusion: null,
      covers: {
        answer: ['Triangle', 'Pentagon', 'Shielder', 'Dasher'],
        helps: ['Square', 'Shooter', 'Summoner', 'Boss'],
      },
    });
  });

  it("shows 冰光's and 雷光's hand rule at the fusion's coef: the bonus, the jump's chance, 冰光's chance (D11, D12)", () => {
    const content = fixtureContent();
    const rule = (c: 'ice' | 'lightning', coef: number, locale: 'en' | 'zh-TW') =>
      previewCard(
        assembleWeb(content, c, FULL_SCOPE, { coefs: { [`${c}.aura`]: coef } }),
        emptyProgress(c),
        'aura',
        lookups[locale],
      ).fusion?.rule ?? [];
    for (const [coef, bonus] of [
      [0.45, '+9%'],
      [1, '+20%'],
      [2.3, '+46%'],
    ] as const) {
      for (const c of ['ice', 'lightning'] as const) {
        expect(rule(c, coef, 'en')[0]).toContain(`enemies in it take ${bonus} center damage.`);
        expect(rule(c, coef, 'zh-TW')[0]).toContain(`區內的敵人受到中心傷害 ${bonus}；`);
      }
    }
    expect(rule('ice', 0.45, 'zh-TW')).toEqual([
      '凍結時在目標留下 2 秒脈衝區，區內的敵人受到中心傷害 +9%；每第 3 發必定暴擊，暴擊倍率 ×1.5；不會隨機暴擊。',
      '觸發機率 45%',
    ]);
    expect(rule('ice', 0.45, 'en').at(-1)).toBe('45% chance to trigger');
    expect(rule('lightning', 0.45, 'en')).toEqual([
      'Each jump has a 13.5% chance to leave a 2 s pulse zone at the target; enemies in it take +9% center damage. Chain count ×2 and chain hits deal ×4.5 damage; chain retention −20 percentage points.',
    ]);
  });
});
