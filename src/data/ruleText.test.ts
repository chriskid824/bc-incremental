import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import zhTW from '../i18n/zh-TW.json';
import type { RuleSpec } from './rules';
import { TALENTS } from './talents';

const percent = (value: number): string => `${Math.round(Math.abs(value) * 100)}%`;
const signedPercent = (value: number): string => `${value < 0 ? '−' : '+'}${percent(value)}`;

/**
 * The numbers a rule's description must quote, each as a list of accepted spellings. Rules are
 * shown only through their talent.<id>.desc text (src/ui/talentWeb.ts), so a parameter change
 * that the text does not follow misleads the player.
 */
function quotedNumbers(rule: RuleSpec): string[][] {
  switch (rule.id) {
    case 'critsAlwaysIgnite':
      return [[signedPercent(rule.nonCritHitMore)]];
    case 'steadyAim':
      return [[String(rule.everyNth)], [`×${1 + rule.critMultiplierMore}`]];
    case 'pandemic':
      return [[percent(rule.spreadEffect)], [signedPercent(rule.hitMore)]];
    case 'eternalFlame':
      return [[signedPercent(rule.durationMore)]];
    case 'overload':
      return [
        [`×${rule.chainCountMultiplier}`, ...(rule.chainCountMultiplier === 2 ? ['twice'] : [])],
        [`−${Math.round(rule.retentionPenalty * 100)}`],
      ];
    case 'glassCannon':
      return [[`×${1 + rule.damageMore}`]];
    case 'critIgniteChance':
    case 'chainIgniteChance':
      return [[signedPercent(rule.chance)]];
    case 'chainCritChance':
      return [[signedPercent(rule.perJump)]];
  }
}

/** `token` in `text`, not as part of a longer number ("−20" does not match "−200"). */
function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.]*\\d)`).test(text);
}

const LOCALES = { en, 'zh-TW': zhTW } as Record<string, Record<string, string>>;

describe('rule descriptions', () => {
  const withRules = TALENTS.filter((node) => node.rules.length > 0);

  it.each(withRules.map((node) => [node.id, node] as const))(
    '%s quotes its rule numbers in every locale',
    (_, node) => {
      for (const [locale, messages] of Object.entries(LOCALES)) {
        const text = messages[node.descKey ?? ''];
        expect(text, `${locale} ${node.descKey}`).toBeDefined();
        for (const rule of node.rules) {
          for (const spellings of quotedNumbers(rule)) {
            expect(
              spellings.some((token) => mentions(text as string, token)),
              `${locale} ${node.descKey}: "${text}" should mention ${spellings.join(' or ')}`,
            ).toBe(true);
          }
        }
      }
    },
  );

  it('matches whole numbers only', () => {
    expect(mentions('retention −20 points', '−20')).toBe(true);
    expect(mentions('retention −200 points', '−20')).toBe(false);
    expect(mentions('crit multiplier ×1.5.', '×1.5')).toBe(true);
    expect(mentions('crit multiplier ×1.55', '×1.5')).toBe(false);
    expect(mentions('every 3rd shot', '3')).toBe(true);
    expect(mentions('every 13th shot', '3')).toBe(false);
  });
});
