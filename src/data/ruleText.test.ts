import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import zhTW from '../i18n/zh-TW.json';
import type { RuleSpec } from './rules';
import { ALWAYS_STATS, isBehaviourModifier } from './stats';
import type { Modifier, StatId } from './stats';
import { TALENTS } from './talents';
import type { Condition, EffectSpec, TriggerSpec } from './triggers';

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
    case 'eternalFlame':
      return [[signedPercent(rule.durationMore)]];
    case 'overload':
      return [
        [`×${rule.chainCountMultiplier}`, ...(rule.chainCountMultiplier === 2 ? ['twice'] : [])],
        [`−${Math.round(rule.retentionPenalty * 100)}`],
        ...(rule.chainMore === undefined ? [] : [[`×${1 + rule.chainMore}`]]),
      ];
    case 'glassCannon':
      return [[`×${1 + rule.damageMore}`]];
    case 'farThrow':
      return [[String(rule.every)]];
    case 'volcano':
      return [[String(rule.periodSec)], [`×${rule.radiusMult}`], [`×${rule.damageMult}`]];
    case 'chainBlast':
      return [[percent(rule.damagePct)], [String(rule.perBomb)]];
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

/** The numbers a trigger condition must quote; the event and ailment names are words. */
function conditionNumbers(condition: Condition): string[][] {
  if ('chance' in condition) return [[percent(condition.chance)]];
  if ('cooldownSec' in condition) return [[String(condition.cooldownSec)]];
  if ('targetHpBelow' in condition) return [[percent(condition.targetHpBelow)]];
  // 'max' is a word too: the stack cap the text names.
  if ('stacksAtLeast' in condition) {
    const stacks = condition.stacksAtLeast.stacks;
    return stacks === 'max' ? [] : [[String(stacks)]];
  }
  return [];
}

/**
 * The numbers an effect must quote: its damage, amounts and target counts. Radii and push
 * distances are arena units, which the text describes in words ("nearby").
 */
function effectNumbers(effect: EffectSpec): string[][] {
  switch (effect.kind) {
    case 'applyAilment':
      return [
        ...(effect.stacks === undefined ? [] : [[String(effect.stacks)]]),
        ...(effect.damagePct === undefined ? [] : [[percent(effect.damagePct)]]),
        ...(effect.maxTargets === undefined ? [] : [[String(effect.maxTargets)]]),
      ];
    case 'spreadAilment':
      return [
        ...(effect.effect === undefined ? [] : [[percent(effect.effect)]]),
        ...(effect.ailment === 'poison' && effect.toSplitChildren !== undefined
          ? [[percent(effect.toSplitChildren)]]
          : []),
      ];
    case 'explode':
      return [
        [percent(effect.damagePct)],
        ...(effect.maxTargets === undefined ? [] : [[String(effect.maxTargets)]]),
      ];
    case 'nova':
      return [[percent(effect.damagePct)]];
    case 'push':
      return [];
    case 'addFrost':
      return [
        [percent(effect.amount)],
        ...(effect.maxTargets === undefined ? [] : [[String(effect.maxTargets)]]),
      ];
    case 'heal':
      return [[percent(effect.lifePct)]];
    case 'gainShards':
      return [[percent(effect.fraction)]];
    case 'groundZone':
      return [
        ...(effect.damagePctPerSec === 0 ? [] : [[percent(effect.damagePctPerSec)]]),
        [String(effect.durationSec)],
        ...(effect.ailmentStacks === undefined ? [] : [[String(effect.ailmentStacks)]]),
        ...(effect.ailmentDamagePct === undefined ? [] : [[percent(effect.ailmentDamagePct)]]),
        ...(effect.addFrostPerSec === undefined ? [] : [[percent(effect.addFrostPerSec)]]),
        ...(effect.slow === undefined ? [] : [[percent(effect.slow)]]),
      ];
    case 'repeatAttack':
      return [[String(effect.count)], [percent(effect.damagePct)]];
    case 'detonate':
      return [
        ...(effect.fraction === undefined ? [] : [[percent(effect.fraction)]]),
        ...(effect.damage === undefined ? [] : [[percent(effect.damage)]]),
        ...(effect.maxTargets === undefined ? [] : [[String(effect.maxTargets)]]),
      ];
  }
}

/** The numbers a trigger's node text must quote: its interval, conditions and effects. */
function triggerNumbers(trigger: TriggerSpec): string[][] {
  return [
    ...(trigger.every === undefined ? [] : [[String(trigger.every)]]),
    ...(trigger.when ?? []).flatMap(conditionNumbers),
    ...trigger.do.flatMap(effectNumbers),
  ];
}

/** Every number a node's descKey text must quote: its rules', triggers' and behaviour modifiers'. */
function nodeNumbers(node: (typeof TALENTS)[number]): string[][] {
  return [
    ...node.rules.flatMap(quotedNumbers),
    ...node.triggers.flatMap(triggerNumbers),
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
