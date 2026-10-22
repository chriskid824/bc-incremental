/**
 * A fusion's coef in a hand description (docs/v3 C6 design D10, §4.7, V17): describeNode fills
 * each field the coef scales from its placeholder (pct as 45%, mult as ×2.3), and V17 fails a
 * description that writes such a field as a literal, or leaves its placeholder out.
 * RULE_COEF_FIELDS is empty until the hand modules land (C-1), so this copy fills two entries.
 */

import { describe, expect, it, vi } from 'vitest';
import { assembleWeb, FULL_SCOPE } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import type * as RulesModule from '../../data/rules';
import { textIssues } from './check';
import { fixtureLookups, fixtureMessages } from './testing';
import { describeNode } from './text';

vi.mock('../../data/rules', async (importOriginal) => {
  const actual = await importOriginal<typeof RulesModule>();
  return {
    ...actual,
    RULE_COEF_FIELDS: {
      glassCannon: { damageMore: 'pct' },
      overload: { chainCountMultiplier: 'mult' },
    },
  };
});

const web = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE, {
  coefs: { 'fire.summon': 0.45, 'fire.lightning': 1.15 },
});
const SUMMON = 'web.node.fusion.fire.summon.core.desc';
const LIGHTNING = 'web.node.fusion.fire.lightning.core.desc';

/** The fixture's lookups with the two cores' descriptions replaced. */
function withDescs(summon: readonly [string, string], lightning: readonly [string, string]) {
  const messages = fixtureMessages();
  [messages.en[SUMMON], messages['zh-TW'][SUMMON]] = summon;
  [messages.en[LIGHTNING], messages['zh-TW'][LIGHTNING]] = lightning;
  return fixtureLookups(messages);
}

const PLACEHOLDERS = withDescs(
  ['All damage {damageMore} more; your life becomes 1.', '所有傷害總增 {damageMore}；生命變成 1。'],
  [
    'Chain count {chainCountMultiplier} and chain hits deal ×4.5 damage; chain retention −20 percentage points.',
    '連鎖次數 {chainCountMultiplier}，連鎖擊中的傷害 ×4.5；保留率 −20 個百分點。',
  ],
);

const issuesOf = (key: string, lookups: ReturnType<typeof withDescs>): string[] =>
  textIssues([web], lookups).filter((issue) => issue.startsWith(`key '${key}'`));

describe('a coef-scaled field in a hand description (D10, §4.7)', () => {
  it('fills a pct field as 45% and a mult field as ×2.3', () => {
    expect(describeNode(web, 'fusion.fire.summon.core', 1, PLACEHOLDERS.en).lines).toEqual([
      'All damage 45% more; your life becomes 1.',
    ]);
    expect(describeNode(web, 'fusion.fire.summon.core', 1, PLACEHOLDERS['zh-TW']).lines).toEqual([
      '所有傷害總增 45%；生命變成 1。',
    ]);
    expect(describeNode(web, 'fusion.fire.lightning.core', 1, PLACEHOLDERS['zh-TW']).lines).toEqual(
      ['連鎖次數 ×2.3，連鎖擊中的傷害 ×4.5；保留率 −20 個百分點。'],
    );
  });

  it('passes V17, V19 and V20 with the placeholders', () => {
    expect(textIssues([web], PLACEHOLDERS)).toEqual([]);
  });

  it('fails V17 on the field written as a literal, at its data value or at the run value', () => {
    const literal = withDescs(
      ['All damage ×2; your life becomes 1.', '所有傷害 ×1.45；生命變成 1。'],
      [
        'Chain count ×2 and chain hits deal ×4.5 damage; chain retention −20 percentage points.',
        '連鎖次數 {chainCountMultiplier}，連鎖擊中的傷害 ×4.5；保留率 −20 個百分點。',
      ],
    );
    expect(issuesOf(SUMMON, literal)).toEqual([
      `key '${SUMMON}' (src/i18n/web.en.json): quotes ×2, which the fusion's coef scales; write {damageMore} in its place`,
      `key '${SUMMON}' (src/i18n/web.zh-TW.json): quotes ×1.45, which the fusion's coef scales; write {damageMore} in its place`,
    ]);
    expect(issuesOf(LIGHTNING, literal)).toEqual([
      `key '${LIGHTNING}' (src/i18n/web.zh-TW.json): placeholders {chainCountMultiplier} differ from en's none; use the same placeholders in both locales`,
      `key '${LIGHTNING}' (src/i18n/web.en.json): quotes ×2, which the fusion's coef scales; write {chainCountMultiplier} in its place`,
    ]);
  });

  it('fails V17 on a description that leaves the placeholder out', () => {
    const lacking = withDescs(
      ['All damage is higher; your life becomes 1.', '所有傷害總增 45%；生命變成 1。'],
      [
        'Chain count {chainCountMultiplier} and chain hits deal ×4.5 damage; chain retention −20 percentage points.',
        '連鎖次數 {chainCountMultiplier}，連鎖擊中的傷害 ×4.5；保留率 −20 個百分點。',
      ],
    );
    expect(issuesOf(SUMMON, lacking)).toEqual([
      `key '${SUMMON}' (src/i18n/web.en.json): lacks {damageMore}, which the fusion's coef scales; write it where the number goes`,
      `key '${SUMMON}' (src/i18n/web.zh-TW.json): lacks {damageMore}, which the fusion's coef scales; write it where the number goes`,
    ]);
  });
});
