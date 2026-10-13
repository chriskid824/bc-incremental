import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import zhTW from '../i18n/zh-TW.json';
import type { RuleSpec } from './rules';
import { ALWAYS_STATS, isBehaviourModifier } from './stats';
import type { Modifier, StatId } from './stats';
import { TALENTS } from './talents';

const percent = (value: number): string => `${Math.round(Math.abs(value) * 100)}%`;
const signedPercent = (value: number): string => `${value < 0 ? '−' : '+'}${percent(value)}`;

/**
 * The numbers a rule's description must quote, each as a list of accepted spellings. Rules and
 * behaviour modifiers are shown only through their talent.<id>.desc text (src/ui/talentWeb.ts),
 * so a parameter change that the text does not follow misleads the player.
 */
function quotedNumbers(rule: RuleSpec): string[][] {
  switch (rule.id) {
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
  }
}

/**
 * The number a behaviour modifier's node text must quote: its value as a signed percentage
 * (chances, damage more/increased). An *Always stat has none: "always" is the whole message.
 */
function modifierNumbers(mod: Modifier): string[][] {
  if ((ALWAYS_STATS as readonly StatId[]).includes(mod.stat)) return [];
  return [[signedPercent(mod.value)]];
}

/** Every number a node's descKey text must quote: its rules' and its behaviour modifiers'. */
function nodeNumbers(node: (typeof TALENTS)[number]): string[][] {
  return [
    ...node.rules.flatMap(quotedNumbers),
    ...node.modifiers.filter(isBehaviourModifier).flatMap(modifierNumbers),
  ];
}

/** `token` in `text`, not as part of a longer number ("−20" does not match "−200"). */
function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.]*\\d)`).test(text);
}

const LOCALES = { en, 'zh-TW': zhTW } as Record<string, Record<string, string>>;

describe('rule descriptions', () => {
  const described = TALENTS.filter(
    (node) => node.rules.length > 0 || node.modifiers.some(isBehaviourModifier),
  );

  it('covers the M1 rules and the bridge notables and Searing Crits as data', () => {
    expect(described.map((node) => node.id).sort()).toEqual(
      [
        'conduction',
        'flashpoint',
        'glassCannon',
        'overload',
        'pandemic',
        'searingCrits',
        'staticFocus',
        'steadyAim',
      ].sort(),
    );
  });

  it.each(described.map((node) => [node.id, node] as const))(
    '%s quotes its rule and behaviour numbers in every locale',
    (_, node) => {
      for (const [locale, messages] of Object.entries(LOCALES)) {
        const text = messages[node.descKey ?? ''];
        expect(text, `${locale} ${node.descKey}`).toBeDefined();
        for (const spellings of nodeNumbers(node)) {
          expect(
            spellings.some((token) => mentions(text as string, token)),
            `${locale} ${node.descKey}: "${text}" should mention ${spellings.join(' or ')}`,
          ).toBe(true);
        }
      }
    },
  );

  it('reads the numbers of behaviour modifiers', () => {
    const numbersOf = (id: string): string[][] => {
      const node = TALENTS.find((n) => n.id === id);
      if (node === undefined) throw new Error(`missing ${id}`);
      return nodeNumbers(node);
    };
    expect(numbersOf('flashpoint')).toEqual([['+30%']]);
    expect(numbersOf('conduction')).toEqual([['+25%']]);
    expect(numbersOf('staticFocus')).toEqual([['+10%']]);
    expect(numbersOf('searingCrits')).toEqual([['−50%']]);
  });

  it('matches whole numbers only', () => {
    expect(mentions('retention −20 points', '−20')).toBe(true);
    expect(mentions('retention −200 points', '−20')).toBe(false);
    expect(mentions('crit multiplier ×1.5.', '×1.5')).toBe(true);
    expect(mentions('crit multiplier ×1.55', '×1.5')).toBe(false);
    expect(mentions('every 3rd shot', '3')).toBe(true);
    expect(mentions('every 13th shot', '3')).toBe(false);
  });
});
