import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import zhTW from '../i18n/zh-TW.json';
import { mentions, modifierNumbers, quotedNumbers, triggerNumbers } from './ruleNumbers';
import { isBehaviourModifier } from './stats';
import { TALENTS } from './talents';

/** Every number a node's descKey text must quote: its rules', triggers' and behaviour modifiers'. */
function nodeNumbers(node: (typeof TALENTS)[number]): string[][] {
  return [
    ...node.rules.flatMap(quotedNumbers),
    ...node.triggers.flatMap(triggerNumbers),
    ...node.modifiers.filter(isBehaviourModifier).flatMap(modifierNumbers),
  ];
}

const LOCALES = { en, 'zh-TW': zhTW } as Record<string, Record<string, string>>;

describe('rule descriptions', () => {
  const described = TALENTS.filter(
    (node) =>
      node.rules.length > 0 || node.triggers.length > 0 || node.modifiers.some(isBehaviourModifier),
  );

  it('covers the M1 rules, and the bridge notables, Searing Crits and Pandemic as data', () => {
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

  it('reads Pandemic’s numbers from its trigger', () => {
    const pandemic = TALENTS.find((node) => node.id === 'pandemic');
    if (pandemic === undefined) throw new Error('missing pandemic');
    expect(pandemic.rules).toEqual([]);
    // The spread's strength; the hit cost is a plain modifier, shown as its own line.
    expect(nodeNumbers(pandemic)).toEqual([['40%']]);
    expect(pandemic.modifiers.filter(isBehaviourModifier)).toEqual([]);
  });

  it('reads the numbers of triggers', () => {
    expect(
      triggerNumbers({
        on: 'nthAttack',
        every: 4,
        when: [{ chance: 0.25 }, { targetHpBelow: 0.3 }, { hitIs: 'crit' }],
        do: [
          { kind: 'explode', radius: 90, damagePct: 0.5, maxTargets: 3 },
          { kind: 'applyAilment', ailment: 'burn', stacks: 2, radius: 60 },
          { kind: 'push', distance: 40, radius: 80 },
        ],
      }),
    ).toEqual([['4'], ['25%'], ['30%'], ['50%'], ['3'], ['2']]);
    expect(
      triggerNumbers({
        on: 'kill',
        when: [{ cooldownSec: 2 }, { stacksAtLeast: { ailment: 'burn', stacks: 5 } }],
        do: [{ kind: 'gainShards', fraction: 0.1 }],
      }),
    ).toEqual([['2'], ['5'], ['10%']]);
    expect(
      triggerNumbers({
        on: 'diedWithAilment',
        when: [{ victimHas: 'burn' }],
        do: [{ kind: 'spreadAilment', ailment: 'burn', radius: 250, effect: 0.4 }],
      }),
    ).toEqual([['40%']]);
    expect(
      triggerNumbers({
        on: 'periodic',
        every: 8,
        do: [
          { kind: 'nova', radius: 200, damagePct: 1.5, at: 'player' },
          { kind: 'heal', lifePct: 0.05 },
        ],
      }),
    ).toEqual([['8'], ['150%'], ['5%']]);
    // A shield's gain, then its cap when it has one.
    expect(
      triggerNumbers({
        on: 'freeze',
        do: [
          { kind: 'shield', lifePct: 0.02, capPct: 0.3 },
          { kind: 'shield', lifePct: 0.2 },
        ],
      }),
    ).toEqual([['2%'], ['30%'], ['20%']]);
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
