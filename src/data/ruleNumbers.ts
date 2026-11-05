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
    case 'frostflame':
      return [[percent(rule.frostPct)], [`+${rule.burnCapBonus}`], [percent(rule.zoneSlow)]];
    case 'absoluteZero':
      return [
        [percent(rule.globalSlow)],
        [String(rule.bossGapSec)],
        [signedPercent(rule.attackSpeedMore)],
      ];
    case 'gigantism':
      // gd:268's 「大小 ×2」; the halving is words.
      return [[`×${rule.sizeMult}`]];
    case 'blastSpirit':
      // gd:525's 「每第 4 發…1 隻 4 秒的火靈…點燃 3 層（最多 6 隻）」.
      return [
        [String(rule.every)],
        [String(rule.lifeSec)],
        [String(rule.burnStacks)],
        [String(rule.maxLive)],
      ];
    case 'poisonSlow':
      // gd:389 words it as 每 5 層毒減速 2%，最多 40%.
      return [[String(rule.stacksPer)], [percent(rule.slowPer)], [percent(rule.max)]];
    case 'lockBeacon':
      return [];
    case 'cannon':
      // gd's 「攻擊頻率 ÷3」; the splash radius is words.
      return [[`÷${Math.round(1 / rule.rateMult)}`, percent(rule.rateMult)]];
    case 'teslaTower':
      return [[String(rule.chains)]];
    case 'bugSea':
      return [[`×${rule.countMult}`]];
    case 'hiveSplit':
      // gd §1.5's 「每 5 次擊殺生出 1 架臨時無人機，存在 6 秒」.
      return [[String(rule.every)], [String(rule.lifeSec)]];
    case 'swarmTune':
      // 量產's 「砲台 +2」; 回收 is words.
      return rule.turrets > 0 ? [[`+${rule.turrets}`]] : [];
    case 'colossus':
      return [[signedPercent(rule.damagePerMissing)]];
    case 'hiveExpand':
      return [[`+${rule.drones}`]];
    case 'hiveBuild':
      return [[`+${rule.turrets}`]];
    case 'queenRole':
      return [[`×${rule.sizeMult}`], [`×${rule.damageMult}`], [signedPercent(rule.followBonus)]];
    case 'hammerRole':
      return [[`×${rule.damageMult}`], [`×${rule.speedMult}`]];
    case 'focusFire':
      return [];
    case 'outpost':
      return [[String(rule.turretRadius)]];
    case 'selfDestruct':
      return [[String(rule.radius)], [percent(rule.damagePct)]];
    case 'interceptors':
      return [[String(rule.count)], [String(rule.radius)]];
    case 'swarmSurge':
      return [[String(rule.periodSec)], [`×${rule.damageMult}`]];
    case 'royalJelly':
      return [[signedPercent(rule.lifeMult - 1)]];
    case 'breed':
      return [[percent(rule.chance)], [String(rule.lifeSec)]];
    case 'motherFactory':
      return [[String(rule.periodSec)], [String(rule.lifeSec)]];
    case 'pyreChain':
      return [[String(rule.depth)]];
    case 'zoneTune':
      // Each ◆ quotes its own factor; 1 is no change and quotes nothing.
      return [rule.durationMult, rule.damageMult, rule.radiusMult]
        .filter((factor) => factor !== 1)
        .map((factor) => [`×${factor}`, signedPercent(factor - 1)]);
    case 'flameBee':
      return [[String(rule.burnStacks)], [String(rule.blastRadius)]];
    case 'frostBee':
      return [[percent(rule.frostPct), signedPercent(rule.frostPct)]];
  }
}

/**
 * The number a behaviour modifier's node text must quote: its value as a signed percentage
 * (chances, damage more/increased), and an unscaled more modifier's also as the factor it
 * multiplies by, as the rules' factors are quoted (more 3 is +300% or ×4: 加農砲's ×4, which its
 * notTags makes a behaviour modifier, A12), to 12 significant digits (more −0.7 is ×0.3). A scaled
 * more adds its value per step (1 + value × steps), so ×(1 + value) is not its factor. An *Always
 * stat has none: "always" is the whole message.
 */
export function modifierNumbers(mod: Modifier): string[][] {
  if ((ALWAYS_STATS as readonly StatId[]).includes(mod.stat)) return [];
  if (mod.kind === 'more' && mod.scaling === undefined) {
    return [[signedPercent(mod.value), `×${Number((1 + mod.value).toPrecision(12))}`]];
  }
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
  // So is comboAtLeast's 'full' (滿層, whatever the cap); a count of stacks is a number (E14).
  if ('comboAtLeast' in condition) {
    const stacks = condition.comboAtLeast;
    return stacks === 'full' ? [] : [[String(stacks)]];
  }
  return [];
}

/**
 * The numbers an effect must quote: its damage, amounts and target counts. Radii and push
 * distances are arena units, which the text describes in words ("nearby").
 */
export function effectNumbers(effect: EffectSpec): string[][] {
  switch (effect.kind) {
    case 'execute':
    case 'thaw':
      return [];
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
    case 'shield':
      return [
        [percent(effect.lifePct)],
        ...(effect.capPct === undefined ? [] : [[percent(effect.capPct)]]),
      ];
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
    case 'spawnDrone':
      return [
        ...(effect.count === undefined ? [] : [[String(effect.count)]]),
        [String(effect.lifeSec)],
        ...(effect.damagePct === 0 ? [] : [[percent(effect.damagePct)]]),
        ...(effect.impacts === undefined ? [] : [[String(effect.impacts)]]),
        ...(effect.maxLive === undefined ? [] : [[String(effect.maxLive)]]),
        ...(effect.ailmentStacks === undefined ? [] : [[String(effect.ailmentStacks)]]),
        ...(effect.ailmentDamagePct === undefined ? [] : [[percent(effect.ailmentDamagePct)]]),
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
        ...((effect.bolts ?? 1) > 1 ? [[String(effect.bolts ?? 1)]] : []),
        ...(effect.jumps === 0 ? [] : [[String(effect.jumps)]]),
        [percent(effect.damagePct)],
        ...(effect.shockStacks === undefined ? [] : [[String(effect.shockStacks)]]),
      ];
    case 'comboStack':
      return [[String(effect.stacks)]];
    case 'buff':
      return [[`×${1 + effect.more}`, signedPercent(effect.more)], [String(effect.durationSec)]];
  }
}

/**
 * The numbers a trigger's node text must quote: its interval, conditions, effects and kill shards.
 */
export function triggerNumbers(trigger: TriggerSpec): string[][] {
  return [
    ...(trigger.every === undefined ? [] : [[String(trigger.every)]]),
    ...(trigger.when ?? []).flatMap(conditionNumbers),
    ...trigger.do.flatMap(effectNumbers),
    ...(trigger.killShards === undefined ? [] : [[percent(trigger.killShards)]]),
  ];
}

/** `token` in `text`, not as part of a longer number ("−20" does not match "−200"). */
export function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.]*\\d)`).test(text);
}
