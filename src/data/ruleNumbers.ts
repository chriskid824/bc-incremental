/**
 * The numbers a talent's hand-written description must quote, read from its data: its rules',
 * triggers' and behaviour modifiers' parameters, each as a list of accepted spellings, and the
 * whole-number match that finds them in a text. src/data/ruleText.test.ts checks the M1 talents'
 * descriptions with them, and the v3 web's text check reuses them (docs/v3 C6 design §2.2, V17).
 */

import type { RuleSpec } from './rules';
import { ALWAYS_STATS } from './stats';
import type { Modifier, StatId } from './stats';
import type { Condition, EffectSpec, TriggerSpec } from './triggers';

export const percent = (value: number): string => `${Math.round(Math.abs(value) * 100)}%`;
export const signedPercent = (value: number): string => `${value < 0 ? '−' : '+'}${percent(value)}`;

/**
 * The numbers a rule's description must quote, each as a list of accepted spellings. Rules and
 * behaviour modifiers are shown only through their talent.<id>.desc text (src/ui/talentWeb.ts),
 * so a parameter change that the text does not follow misleads the player.
 */
export function quotedNumbers(rule: RuleSpec): string[][] {
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
    case 'icicle':
      return [[String(rule.every)], [percent(rule.damagePct)]];
    case 'prism':
      return [[signedPercent(rule.perPierce)], [signedPercent(rule.maxBonus)]];
    case 'sixCoils':
      // The GDD words it as coils +3 (6 a second), −45% a discharge and 2 targets.
      return [
        [String(rule.coils), `+${rule.coils - 3}`],
        [String(rule.targets)],
        [signedPercent(rule.damageMult - 1), percent(rule.damageMult), `×${rule.damageMult}`],
      ];
  }
}

/**
 * The number a behaviour modifier's node text must quote: its value as a signed percentage
 * (chances, damage more/increased). An *Always stat has none: "always" is the whole message.
 */
export function modifierNumbers(mod: Modifier): string[][] {
  if ((ALWAYS_STATS as readonly StatId[]).includes(mod.stat)) return [];
  return [[signedPercent(mod.value)]];
}

/** The numbers a trigger condition must quote; the event and ailment names are words. */
export function conditionNumbers(condition: Condition): string[][] {
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
export function effectNumbers(effect: EffectSpec): string[][] {
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
    case 'projectiles':
      return [
        [String(effect.count)],
        [percent(effect.damagePct)],
        ...(effect.pierce === undefined || effect.pierce <= 0 ? [] : [[String(effect.pierce)]]),
        ...(effect.bounce === undefined || effect.bounce === 0 ? [] : [[String(effect.bounce)]]),
      ];
    case 'slashLine':
      return [[percent(effect.damagePct)]];
    case 'coinHit':
      return [[`×${effect.multiplier}`, percent(effect.multiplier)]];
    case 'chainBolt':
      return [
        ...(effect.jumps === 0 ? [] : [[String(effect.jumps)]]),
        [percent(effect.damagePct)],
        ...(effect.shockStacks === undefined ? [] : [[String(effect.shockStacks)]]),
      ];
  }
}

/** The numbers a trigger's node text must quote: its interval, conditions and effects. */
export function triggerNumbers(trigger: TriggerSpec): string[][] {
  return [
    ...(trigger.every === undefined ? [] : [[String(trigger.every)]]),
    ...(trigger.when ?? []).flatMap(conditionNumbers),
    ...trigger.do.flatMap(effectNumbers),
  ];
}

/** `token` in `text`, not as part of a longer number ("−20" does not match "−200"). */
export function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.]*\\d)`).test(text);
}
