/**
 * The text of the engine vocabulary 熔核's batch B1 asked for (C4 design §11's B1 row; lead
 * rulings H1, H3): the targetIs condition on a modifier and a trigger, and the poisonSlow rule's
 * line, in both locales through the fixture's lookups.
 */

import { describe, expect, it } from 'vitest';
import type { RuleSpec } from '../../data/rules';
import type { Modifier } from '../../data/stats';
import type { TriggerSpec } from '../../data/triggers';
import { assembleWeb, FULL_SCOPE } from '../../data/web';
import type { NodeEffects, WebNode } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import type { Locale } from '../../i18n';
import { fixtureLookups } from './testing';
import { describeNode } from './text';

const fire = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
const lookups = fixtureLookups();
/** A fixture notable with no effects, which the tests fill. */
const NOTABLE = 'fire.center.alpha.alpha-two';

/** The notable's lines in `locale` with its effects replaced by `part`. */
function linesOf(part: Partial<NodeEffects>, locale: Locale): readonly string[] {
  const effects: NodeEffects = {
    modifiers: [],
    triggers: [],
    conversions: [],
    emitters: [],
    rules: [],
    ...part,
  };
  const nodes = fire.nodes.map((node): WebNode =>
    node.id === NOTABLE ? { ...node, effects } : node,
  );
  const web = { ...fire, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
  return describeNode(web, NOTABLE, 1, lookups[locale]).lines;
}

describe('targetIs text (lead ruling H1)', () => {
  // ◆鎖定 (gd:432 「對生命最高的敵人暴擊率 +25%」).
  const LOCK: Modifier = {
    stat: 'critChance',
    kind: 'flat',
    value: 0.25,
    when: [{ targetIs: 'highestHp' }],
  };
  const heal = { kind: 'heal', lifePct: 0.01 } as const;
  const triggers: TriggerSpec[] = [
    { on: 'hit', when: [{ targetIs: 'highestHp' }], do: [heal] },
    { on: 'crit', when: [{ targetIs: 'highestHp' }, { targetHpBelow: 0.5 }], do: [heal] },
  ];

  it.each([
    [
      'en',
      [
        '+25% Crit chance (against enemies with the most life)',
        'On hitting enemies with the most life: heal 1% of max life',
        'On critting enemies with the most life and below 50% life: heal 1% of max life',
      ],
    ],
    [
      'zh-TW',
      [
        '暴擊率 +25%（對生命最高的敵人）',
        '擊中生命最高的敵人時：回復 1% 生命',
        '暴擊生命最高、生命低於 50% 的敵人時：回復 1% 生命',
      ],
    ],
  ] as const)('writes the condition on a modifier and a trigger in %s', (locale, expected) => {
    // Planted bugs: the key or the pick's word missing in a locale (the line would hold its key).
    expect(linesOf({ modifiers: [LOCK], triggers }, locale)).toEqual(expected);
  });
});

describe('poisonSlow text (lead ruling H3)', () => {
  const NEURO: RuleSpec = { id: 'poisonSlow', stacksPer: 5, slowPer: 0.02, max: 0.4 };

  it.each([
    ['en', ['Enemies are slowed 2% for every 5 poison stacks they carry, at most 40%']],
    ['zh-TW', ['每 5 層毒減速 2%，最多 40%']],
  ] as const)('writes the rule from its numbers in %s (gd:389)', (locale, expected) => {
    // Planted bug: a swapped placeholder or the fallback line.
    expect(linesOf({ rules: [NEURO] }, locale)).toEqual(expected);
  });

  it('writes other numbers as given', () => {
    const rules: RuleSpec[] = [{ id: 'poisonSlow', stacksPer: 4, slowPer: 0.03, max: 0.5 }];
    expect(linesOf({ rules }, 'en')).toEqual([
      'Enemies are slowed 3% for every 4 poison stacks they carry, at most 50%',
    ]);
    expect(linesOf({ rules }, 'zh-TW')).toEqual(['每 4 層毒減速 3%，最多 50%']);
  });
});
