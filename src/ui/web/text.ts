/**
 * Generated text of the v3 web (docs/v3 C6 design D22, §3.9, §4.7): a template per node kind,
 * effect kind, condition, scaling variable and curve, event, grant kind, bonus form, fan-out and
 * buy reason, each registry a Record over its union, so a new member does not compile without its
 * template (H15, L9); STAT_FORMAT; the lookup the text reads through; and describeNode. Modifier
 * lines are written here, through STAT_FORMAT and M1's mod.* templates (web.mod.reduced for an
 * increased value below 0) with the stat's stat.* name, then the scope, tags, conditions and
 * scaling; nothing comes from src/ui/describe.ts, whose describeModifier gives no line for the
 * behaviour modifiers these lines exist for (F52).
 */

import {
  AURA_DEFAULTS,
  DRONE_DEFAULTS,
  ORBIT_DEFAULTS,
  SEGMENT_DEFAULTS,
  STRIKE_DEFAULTS,
  THORNS_DAMAGE_PCT,
} from '../../data/emitters';
import type { EmitterGrant, GrantKind } from '../../data/emitters';
import { RULE_COEF_FIELDS, scaleRuleSpec } from '../../data/rules';
import type { CoefFieldKind, RuleSpec } from '../../data/rules';
import { SOURCE_CLASSES, sourceClass } from '../../data/sources';
import type { OuterId, SourceClass, SourceSelector } from '../../data/sources';
import { ALWAYS_STATS } from '../../data/stats';
import type { Modifier, StatId } from '../../data/stats';
import type { DamageTag } from '../../data/tags';
import { CENTER_EVENTS, COEF_FIELDS, conditionKey } from '../../data/triggers';
import type {
  CenterEvent,
  Condition,
  ConditionKey,
  ConversionSpec,
  EffectKind,
  EffectSpec,
  ScalingCurve,
  ScalingSpec,
  ScalingVar,
  TargetSelector,
  TriggerEventId,
  TriggerSpec,
} from '../../data/triggers';
import type {
  AssembledWeb,
  BonusSpec,
  FusionDef,
  PayloadType,
  Ranks,
  WebNode,
  WebNodeKind,
} from '../../data/web/types';
import { fill } from '../../i18n';
import type { MessageKey, MessageValues } from '../../i18n';
import type { BuyCheck, BuyReason } from '../../meta/web';
import { CHAIN_JUMP_EVENT_CAP, FREEZE_LIST_RADIUS, LIST_MAX } from '../../sim/caps';
import { CHAIN_JUMP_CHANCE } from '../../sim/effects/types';
import { APP_LOOKUP, fusionKeyOf, fusionName, nodeName, say, statName } from './names';

/**
 * How text.ts reads a key: t and isMessageKey in the app (APP_LOOKUP); a map in tests (V17 and
 * V19 on the fixture, F45). `keys` lists what it holds, for V17's orphan check (R6).
 */
export interface TextLookup {
  readonly has: (key: string) => boolean;
  readonly get: (key: string, values?: MessageValues) => string;
  readonly keys: () => Iterable<string>;
}

export interface NodeText {
  readonly name: string;
  readonly kind: string;
  /**
   * The hand description when `web.node.<id>.desc` exists, with chanceLine's line under a
   * fusion's coef below 1 when a trigger is not chainJump and has no chance condition; else the
   * generated lines; then 「答案：…」.
   */
  readonly lines: readonly string[];
}

/**
 * A lookup over one locale's messages: `get` fills a template's placeholders with i18n's fill, and
 * gives a missing key back as itself, as names.ts' contentText does (V17 reports it).
 */
export function messageLookup(messages: Readonly<Record<string, string>>): TextLookup {
  return {
    has: (key) => Object.hasOwn(messages, key),
    get: (key, values) => {
      const template = Object.hasOwn(messages, key) ? (messages[key] as string) : key;
      return values === undefined ? template : fill(template, values);
    },
    keys: () => Object.keys(messages),
  };
}

// The registries (§4.7).

export const KIND_TEXT: Readonly<Record<WebNodeKind, MessageKey>> = {
  signature: 'web.kind.signature',
  ranked: 'web.kind.ranked',
  notable: 'web.kind.notable',
  threshold: 'web.kind.threshold',
  keystone: 'web.kind.keystone',
  mastery: 'web.kind.mastery',
  might: 'web.kind.might',
  entry: 'web.kind.entry',
  core: 'web.kind.core',
  asc: 'web.kind.asc',
  ascFinal: 'web.kind.ascFinal',
};

export const EFFECT_TEXT: Readonly<Record<EffectKind, MessageKey>> = {
  applyAilment: 'web.effect.applyAilment',
  spreadAilment: 'web.effect.spreadAilment',
  explode: 'web.effect.explode',
  nova: 'web.effect.nova',
  push: 'web.effect.push',
  addFrost: 'web.effect.addFrost',
  heal: 'web.effect.heal',
  shield: 'web.effect.shield',
  gainShards: 'web.effect.gainShards',
  groundZone: 'web.effect.groundZone',
  repeatAttack: 'web.effect.repeatAttack',
  detonate: 'web.effect.detonate',
  projectiles: 'web.effect.projectiles',
  slashLine: 'web.effect.slashLine',
  coinHit: 'web.effect.coinHit',
  chainBolt: 'web.effect.chainBolt',
};

export const CONDITION_TEXT: Readonly<Record<ConditionKey, MessageKey>> = {
  targetHas: 'web.cond.targetHas',
  targetKind: 'web.cond.targetKind',
  targetHpBelow: 'web.cond.targetHpBelow',
  stacksAtLeast: 'web.cond.stacksAtLeast',
  inZone: 'web.cond.inZone',
  targetState: 'web.cond.targetState',
  targetFrostAtLeast: 'web.cond.targetFrostAtLeast',
  chance: 'web.cond.chance',
  cooldownSec: 'web.cond.cooldownSec',
  hitIs: 'web.cond.hitIs',
  victimHas: 'web.cond.victimHas',
  killedBy: 'web.cond.killedBy',
  ailment: 'web.cond.ailment',
};

/**
 * A scaling variable's name, its per-unit phrase without `every` and with it (`{n}`), and how
 * `every` reads: lifeLostPct and targetFrost count fractions of 1, the others whole units.
 */
export const SCALING_TEXT: Readonly<
  Record<
    ScalingVar,
    {
      readonly name: MessageKey;
      readonly one: MessageKey;
      readonly other: MessageKey;
      readonly every: 'percent' | 'number';
    }
  >
> = {
  chainJump: {
    name: 'web.scaling.chainJump.name',
    one: 'web.scaling.chainJump.one',
    other: 'web.scaling.chainJump.other',
    every: 'number',
  },
  targetBurnStacks: {
    name: 'web.scaling.targetBurnStacks.name',
    one: 'web.scaling.targetBurnStacks.one',
    other: 'web.scaling.targetBurnStacks.other',
    every: 'number',
  },
  targetDistance: {
    name: 'web.scaling.targetDistance.name',
    one: 'web.scaling.targetDistance.one',
    other: 'web.scaling.targetDistance.other',
    every: 'number',
  },
  lifeLostPct: {
    name: 'web.scaling.lifeLostPct.name',
    one: 'web.scaling.lifeLostPct.one',
    other: 'web.scaling.lifeLostPct.other',
    every: 'percent',
  },
  targetPoisonStacks: {
    name: 'web.scaling.targetPoisonStacks.name',
    one: 'web.scaling.targetPoisonStacks.one',
    other: 'web.scaling.targetPoisonStacks.other',
    every: 'number',
  },
  targetShockStacks: {
    name: 'web.scaling.targetShockStacks.name',
    one: 'web.scaling.targetShockStacks.one',
    other: 'web.scaling.targetShockStacks.other',
    every: 'number',
  },
  targetFrost: {
    name: 'web.scaling.targetFrost.name',
    one: 'web.scaling.targetFrost.one',
    other: 'web.scaling.targetFrost.other',
    every: 'percent',
  },
};

/** powFactor: 「×（{x}的 {e} 次方），最多 ×{cap}」 (H17). */
export const CURVE_TEXT: Readonly<Record<ScalingCurve, MessageKey>> = {
  linear: 'web.curve.linear',
  log10: 'web.curve.log10',
  pow: 'web.curve.pow',
  powFactor: 'web.curve.powFactor',
};

export const EVENT_TEXT: Readonly<Record<TriggerEventId, MessageKey>> = {
  explode: 'web.event.explode',
  freeze: 'web.event.freeze',
  chainJump: 'web.event.chainJump',
  droneImpact: 'web.event.droneImpact',
  hit: 'web.event.hit',
  crit: 'web.event.crit',
  kill: 'web.event.kill',
  nthAttack: 'web.event.nthAttack',
  ailmentApplied: 'web.event.ailmentApplied',
  ailmentTick: 'web.event.ailmentTick',
  diedWithAilment: 'web.event.diedWithAilment',
  shatter: 'web.event.shatter',
  heroHit: 'web.event.heroHit',
  contact: 'web.event.contact',
  waveStart: 'web.event.waveStart',
  periodic: 'web.event.periodic',
  droneExpire: 'web.event.droneExpire',
};

/** Every grant kind, aura and orbit included (C4.21; N-1). */
export const GRANT_TEXT: Readonly<Record<GrantKind, MessageKey>> = {
  thorns: 'web.grant.thorns',
  segment: 'web.grant.segment',
  strike: 'web.grant.strike',
  drone: 'web.grant.drone',
  aura: 'web.grant.aura',
  orbit: 'web.grant.orbit',
};

export const BONUS_TEXT: Readonly<Record<BonusSpec['form'], MessageKey>> = {
  status: 'web.bonus.status',
  inZone: 'web.bonus.inZone',
  scaling: 'web.bonus.scaling',
  inPayload: 'web.bonus.inPayload',
};

/** A center event's trigger whose effects all fan out, act at its point or on the player (gd §5.3). */
export const FANOUT_TEXT: Readonly<Record<CenterEvent, Readonly<Record<PayloadType, MessageKey>>>> =
  {
    explode: {
      status: 'web.fanout.explode.status',
      placement: 'web.fanout.explode.placement',
      self: 'web.fanout.explode.self',
    },
    freeze: {
      status: 'web.fanout.freeze.status',
      placement: 'web.fanout.freeze.placement',
      self: 'web.fanout.freeze.self',
    },
    chainJump: {
      status: 'web.fanout.chainJump.status',
      placement: 'web.fanout.chainJump.placement',
      self: 'web.fanout.chainJump.self',
    },
    droneImpact: {
      status: 'web.fanout.droneImpact.status',
      placement: 'web.fanout.droneImpact.placement',
      self: 'web.fanout.droneImpact.self',
    },
  };

export const BUY_CHECK_TEXT: Readonly<Record<BuyReason, MessageKey>> = {
  unknown: 'web.buy.unknown',
  owned: 'web.buy.owned',
  maxRank: 'web.buy.maxRank',
  hidden: 'web.buy.hidden',
  locked: 'web.buy.locked',
  challengeKeystone: 'web.buy.challengeKeystone',
  challengeOuter: 'web.buy.challengeOuter',
  needsPrestige: 'web.buy.needsPrestige',
  otherAscendancy: 'web.buy.otherAscendancy',
  notAdjacent: 'web.buy.notAdjacent',
  centerGate: 'web.buy.centerGate',
  outerGate: 'web.buy.outerGate',
  fusionGate: 'web.buy.fusionGate',
  noFusionSlot: 'web.buy.noFusionSlot',
  keystoneCap: 'web.buy.keystoneCap',
  notEnoughShards: 'web.buy.notEnoughShards',
  notEnoughCores: 'web.buy.notEnoughCores',
  notEnoughResonance: 'web.buy.notEnoughResonance',
};

/**
 * How a flat value of each stat reads (§3.9; R3): 'percent' where the value is a fraction of 1
 * (a chance, a share of a hit or of the chill meter, a multiplier on 1: 0.15 → 15%), 'number'
 * where it is a count, seconds, arena units or a base; an *Always stat reads as its name alone.
 * M1's five fraction stats (src/ui/describe.ts PERCENT_STATS) are 'percent' here too. A new stat
 * does not compile without its entry (H15; F52).
 */
export const STAT_FORMAT: Readonly<Record<StatId, 'percent' | 'number'>> = {
  damage: 'number',
  attackSpeed: 'number',
  projectileCount: 'number',
  critChance: 'percent',
  critMultiplier: 'percent',
  igniteChance: 'percent',
  burnDamage: 'percent',
  burnDuration: 'number',
  burnMaxStacks: 'number',
  chainCount: 'number',
  chainRetention: 'percent',
  chainRange: 'number',
  maxLife: 'number',
  projectileSpeed: 'number',
  shardGain: 'percent',
  coreGain: 'percent',
  critAlways: 'number',
  igniteAlways: 'number',
  poisonChance: 'percent',
  poisonDamage: 'percent',
  poisonDuration: 'number',
  bleedChance: 'percent',
  bleedDamage: 'percent',
  bleedDuration: 'number',
  shockChance: 'percent',
  shockEffect: 'percent',
  shockMaxStacks: 'number',
  shockDuration: 'number',
  poisonAlways: 'number',
  bleedAlways: 'number',
  shockAlways: 'number',
  bleedStationaryMult: 'percent',
  frostOnHit: 'percent',
  frostSlowCap: 'percent',
  freezeDuration: 'number',
  shatterDamage: 'percent',
  shatterRadius: 'number',
  frozenDamageTaken: 'percent',
  auraRadius: 'number',
  orbitCount: 'number',
  contactDamageTaken: 'percent',
  lifeRegen: 'percent',
  extraLives: 'number',
  ignoreShield: 'number',
  ignoreArmour: 'number',
  ailmentOnBlock: 'number',
  enemyRegen: 'percent',
  toughDropMult: 'percent',
  treasureRate: 'percent',
};

/**
 * How each COEF field (src/data/triggers.ts COEF_FIELDS) reads where a hand description's
 * placeholder names it: 'pct' for a share of the damage stat or of an effect (45%), 'mult' for a
 * multiplier on a hit or a stack (×2.3). Its keys are COEF_FIELDS' (text.test.ts).
 */
export const COEF_FORMAT: {
  readonly [K in EffectKind]: Readonly<
    Partial<Record<keyof Extract<EffectSpec, { kind: K }> & string, 'pct' | 'mult'>>
  >;
} = {
  applyAilment: { damagePct: 'mult' },
  spreadAilment: { effect: 'pct' },
  explode: { damagePct: 'pct' },
  nova: { damagePct: 'pct' },
  push: {},
  addFrost: {},
  heal: {},
  shield: {},
  gainShards: {},
  groundZone: { damagePctPerSec: 'pct', ailmentDamagePct: 'mult' },
  repeatAttack: {},
  detonate: { damage: 'mult' },
  projectiles: { damagePct: 'pct' },
  slashLine: { damagePct: 'pct' },
  coinHit: { multiplier: 'mult' },
  chainBolt: { damagePct: 'pct' },
};

// Numbers, as M1 writes them (src/ui/describe.ts).

/** Up to two decimals, trailing zeros dropped. */
const trim = (value: number): string => String(Math.round(value * 100) / 100);
/** A fraction as an unsigned percentage: 0.15 → 15%. */
const percent = (value: number): string => `${trim(Math.abs(value) * 100)}%`;
const signed = (text: string, value: number): string => (value >= 0 ? `+${text}` : `−${text}`);
const signedPercent = (value: number): string => signed(percent(value), value);
/** A flat value of `stat` through STAT_FORMAT, signed. */
const flatValue = (stat: StatId, value: number): string =>
  signed(STAT_FORMAT[stat] === 'percent' ? percent(value) : trim(Math.abs(value)), value);
/** A coef-scaled field in a placeholder (§4.7): pct and chance as 45%, mult as ×2.3. */
const fieldText = (kind: CoefFieldKind, value: number): string =>
  kind === 'mult' ? `×${trim(value)}` : value < 0 ? `−${percent(value)}` : percent(value);

/**
 * A generated line: its first letter upper-cased, and a space between a half-width letter, digit
 * or % and a Chinese character, as gd writes 「Boss 也算」 and 「30% 的敵人」 (a template cannot
 * know whether the value it sits beside is a word or a name).
 */
const sentence = (text: string): string =>
  (text.charAt(0).toUpperCase() + text.slice(1))
    .replace(/([0-9A-Za-z%])(?=[\u3400-\u9fff])/g, '$1 ')
    .replace(/([\u3400-\u9fff])(?=[0-9A-Za-z])/g, '$1 ');

const isAlways = (stat: StatId): boolean => (ALWAYS_STATS as readonly StatId[]).includes(stat);

/** The words of a count: `web.word.<word>.one` for 1, `.other` otherwise. */
type Word = 'stack' | 'time' | 'shot' | 'jump' | 'drone' | 'turret';
const word = (lookup: TextLookup, w: Word, n: number): string =>
  say(lookup, n === 1 ? `web.word.${w}.one` : `web.word.${w}.other`);

const tagList = (lookup: TextLookup, tags: readonly DamageTag[]): string =>
  tags.map((tag) => say(lookup, `web.tag.${tag}`)).join(say(lookup, 'web.join.and'));

/** A scope's name: its class (`web.scope.<class>`), its outer's name or its fusion's name. */
function sourceName(lookup: TextLookup, selector: SourceSelector): string {
  if ((SOURCE_CLASSES as readonly string[]).includes(selector)) {
    return say(lookup, `web.scope.${selector as SourceClass}`);
  }
  const cls = sourceClass(selector);
  if (cls === 'outer') {
    return say(lookup, `web.outer.${selector.slice('outer.'.length) as OuterId}.name`);
  }
  if (cls === 'fusion') return fusionName(fusionKeyOf(selector), lookup);
  return selector;
}

// Conditions and the enemies they describe.

/** Conditions that describe the enemy an event or a modifier acts on, as words around its noun. */
const ENEMY_CONDITIONS: ReadonlySet<ConditionKey> = new Set<ConditionKey>([
  'targetHas',
  'victimHas',
  'targetKind',
  'targetHpBelow',
  'stacksAtLeast',
  'inZone',
  'targetState',
  'targetFrostAtLeast',
]);

/** One condition's text; a chance × `coef`, at most 100% (D10). */
function conditionText(lookup: TextLookup, condition: Condition, coef: number): string {
  const key = CONDITION_TEXT[conditionKey(condition)];
  if ('targetHas' in condition)
    return say(lookup, key, { held: say(lookup, `web.held.${condition.targetHas}`) });
  if ('victimHas' in condition)
    return say(lookup, key, { held: say(lookup, `web.held.${condition.victimHas}`) });
  if ('targetKind' in condition)
    return say(lookup, key, { kind: say(lookup, `web.targetKind.${condition.targetKind}`) });
  if ('targetHpBelow' in condition)
    return say(lookup, key, { pct: percent(condition.targetHpBelow) });
  if ('stacksAtLeast' in condition) {
    const { ailment, stacks } = condition.stacksAtLeast;
    const name = say(lookup, `web.ailment.${ailment}`);
    if (stacks === 'max') return say(lookup, 'web.cond.stacksAtLeast.max', { ailment: name });
    return say(lookup, key, { n: stacks, ailment: name, stack: word(lookup, 'stack', stacks) });
  }
  if ('inZone' in condition)
    return say(lookup, key, { source: sourceName(lookup, condition.inZone) });
  if ('targetState' in condition)
    return say(lookup, key, { state: say(lookup, `web.state.${condition.targetState}`) });
  if ('targetFrostAtLeast' in condition)
    return say(lookup, key, { pct: percent(condition.targetFrostAtLeast) });
  if ('chance' in condition)
    return say(lookup, key, { pct: percent(Math.min(1, condition.chance * coef)) });
  if ('cooldownSec' in condition) return say(lookup, key, { s: trim(condition.cooldownSec) });
  if ('hitIs' in condition)
    return say(lookup, key, { hit: say(lookup, `web.hit.${condition.hitIs}`) });
  if ('killedBy' in condition)
    return say(lookup, key, { kind: say(lookup, `web.killedBy.${condition.killedBy}`) });
  return say(lookup, key, { ailment: say(lookup, `web.ailment.${condition.ailment}`) });
}

/**
 * The enemies `conditions` describe: the noun (敵人, or a target kind's), what they hold or do
 * before it (中毒的敵人, 衝刺中的敵人) and the other conditions after it (敵人（生命低於 30%）);
 * `afflicted` adds 帶著異常狀態 when nothing says what they hold (diedWithAilment).
 */
function enemiesText(
  lookup: TextLookup,
  conditions: readonly Condition[],
  afflicted: boolean,
): string {
  const held: string[] = [];
  const kinds: string[] = [];
  const other: string[] = [];
  for (const condition of conditions) {
    const text = conditionText(lookup, condition, 1);
    if ('targetHas' in condition || 'victimHas' in condition || 'targetState' in condition)
      held.push(text);
    else if ('targetKind' in condition) kinds.push(text);
    else other.push(text);
  }
  if (held.length === 0 && afflicted) held.push(say(lookup, 'web.held.any'));
  const and = say(lookup, 'web.join.and');
  let noun = kinds.length > 0 ? kinds.join(and) : say(lookup, 'web.enemies');
  if (held.length > 0) noun = say(lookup, 'web.enemies.held', { adjs: held.join(and), noun });
  if (other.length > 0) noun = say(lookup, 'web.enemies.with', { noun, adjs: other.join(and) });
  return noun;
}

/** A target selector's enemy (TargetSelector), with its range and exclusions. */
function pickText(lookup: TextLookup, selector: TargetSelector): string {
  const ailment = say(lookup, `web.ailment.${selector.ailment ?? 'poison'}`);
  let text = say(lookup, `web.pick.${selector.pick}`, { ailment });
  if (selector.range !== undefined) {
    text = say(lookup, 'web.pick.within', { pick: text, range: trim(selector.range) });
  }
  const quals: string[] = [];
  if (selector.from === 'player') quals.push(say(lookup, 'web.pick.fromPlayer'));
  if (selector.excludeEventTarget === true) quals.push(say(lookup, 'web.pick.notEventTarget'));
  if (selector.excludeBoss === true) quals.push(say(lookup, 'web.pick.notBoss'));
  if (quals.length === 0) return text;
  return say(lookup, 'web.pick.quals', {
    pick: text,
    quals: quals.join(say(lookup, 'web.join.clause')),
  });
}

// Effects.

/** `effect` with its COEF fields × coef, a missing one as 1 (the compile's withCoef, D10). */
function withCoef(effect: EffectSpec, coef: number): EffectSpec {
  const fields = COEF_FIELDS[effect.kind] as readonly string[];
  if (fields.length === 0) return effect;
  const scaled: Record<string, unknown> = { ...effect };
  for (const field of fields) scaled[field] = ((scaled[field] as number | undefined) ?? 1) * coef;
  return scaled as unknown as EffectSpec;
}

/** One effect's text at `coef` (§4.7): a COEF field left at its default 1 shows once coef moves it. */
function effectText(lookup: TextLookup, effect: EffectSpec, coef: number): string {
  const spec = withCoef(effect, coef);
  const extras: string[] = [];
  const extra = (key: MessageKey, values?: MessageValues): void => {
    extras.push(say(lookup, key, values));
  };
  const text = (values: MessageValues): string =>
    say(lookup, EFFECT_TEXT[spec.kind], { ...values, extra: extras.join('') });
  const mult = (value: number | undefined): void => {
    if ((value ?? 1) !== 1) extra('web.extra.damageMult', { mult: trim(value ?? 1) });
  };
  const area = (radius?: number, maxTargets?: number, order?: string): void => {
    if (radius !== undefined) extra('web.extra.radius', { radius: trim(radius) });
    if (maxTargets !== undefined) extra('web.extra.maxTargets', { max: maxTargets });
    if (order === 'nearest') extra('web.extra.nearestFirst');
  };
  const delivery = (tags?: readonly DamageTag[], element?: 'cold' | 'lightning'): void => {
    if (tags !== undefined && tags.length > 0)
      extra('web.extra.tags', { tags: tagList(lookup, tags) });
    if (element !== undefined)
      extra('web.extra.element', { element: say(lookup, `web.tag.${element}`) });
  };
  switch (spec.kind) {
    case 'applyAilment': {
      const n = spec.stacks ?? 1;
      mult(spec.damagePct);
      area(spec.radius, spec.maxTargets, spec.order);
      return text({
        n,
        ailment: say(lookup, `web.ailment.${spec.ailment}`),
        stack: word(lookup, 'stack', n),
      });
    }
    case 'spreadAilment':
      if (spec.ailment === 'poison') {
        if (spec.stacks !== undefined) extra('web.extra.stackShare', { pct: percent(spec.stacks) });
        area(undefined, spec.maxTargets, spec.order);
        if (spec.toSplitChildren !== undefined)
          extra('web.extra.splitChildren', { pct: percent(spec.toSplitChildren) });
      }
      return text({
        ailment: say(lookup, `web.ailment.${spec.ailment}`),
        effect: percent(spec.effect ?? 1),
        radius: trim(spec.radius),
      });
    case 'explode':
      area(undefined, spec.maxTargets, spec.order);
      delivery(spec.tags, spec.element);
      return text({ radius: trim(spec.radius), damage: percent(spec.damagePct) });
    case 'nova':
      if ((spec.at ?? 'player') === 'player') extra('web.extra.atPlayer');
      delivery(spec.tags, spec.element);
      return text({ radius: trim(spec.radius), damage: percent(spec.damagePct) });
    case 'push':
      return text({ radius: trim(spec.radius), distance: trim(spec.distance) });
    case 'addFrost':
      area(spec.radius, spec.maxTargets, spec.order);
      return text({ amount: percent(spec.amount) });
    case 'heal':
      return text({ pct: percent(spec.lifePct) });
    // As gd's 波次護盾 reads: the gain alone. capPct has no template of its own (docs/v3 C7
    // design §1.7 gives the shield one key); its node's hand text quotes it (ruleNumbers.ts).
    case 'shield':
      return text({ pct: percent(spec.lifePct) });
    case 'gainShards':
      return text({ pct: percent(spec.fraction) });
    case 'groundZone': {
      if (spec.damagePctPerSec !== 0)
        extra('web.extra.zoneDamage', { damage: percent(spec.damagePctPerSec) });
      if (spec.ailment !== undefined) {
        const n = spec.ailmentStacks ?? 1;
        extra('web.extra.zoneAilment', {
          n,
          ailment: say(lookup, `web.ailment.${spec.ailment}`),
          stack: word(lookup, 'stack', n),
        });
        mult(spec.ailmentDamagePct);
      }
      if (spec.addFrostPerSec !== undefined)
        extra('web.extra.zoneFrost', { pct: percent(spec.addFrostPerSec) });
      if (spec.slow !== undefined) extra('web.extra.slow', { pct: percent(spec.slow) });
      delivery(spec.tags, spec.element);
      return text({ duration: trim(spec.durationSec), radius: trim(spec.radius) });
    }
    case 'repeatAttack':
      if (spec.timing === 'nextAttack') extra('web.extra.nextAttack');
      return text({
        n: spec.count,
        times: word(lookup, 'time', spec.count),
        damage: percent(spec.damagePct),
      });
    case 'detonate':
      mult(spec.damage);
      area(spec.radius, spec.maxTargets, spec.order);
      return text({
        ailment: say(lookup, `web.ailment.${spec.ailment}`),
        fraction: percent(spec.fraction ?? 1),
      });
    case 'projectiles':
      if (spec.from === 'player') extra('web.extra.fromPlayer');
      if (spec.pierce === -1) extra('web.extra.pierceAll');
      else if ((spec.pierce ?? 0) > 0) extra('web.extra.pierce', { n: spec.pierce ?? 0 });
      if ((spec.bounce ?? 0) > 0) {
        const n = spec.bounce ?? 0;
        extra('web.extra.bounce', { n, times: word(lookup, 'time', n) });
      }
      if (spec.spreadDeg !== undefined) extra('web.extra.spread', { deg: trim(spec.spreadDeg) });
      delivery(spec.tags, spec.element);
      return text({
        n: spec.count,
        shots: word(lookup, 'shot', spec.count),
        aim: say(lookup, `web.aim.${spec.aim}`),
        damage: percent(spec.damagePct),
      });
    case 'slashLine':
      if (spec.alwaysCrit === true) extra('web.extra.alwaysCrit');
      if ((spec.critScale ?? 0) > 0)
        extra('web.extra.critScale', { pct: percent((spec.critScale ?? 0) * 0.1) });
      delivery(spec.tags);
      return text({
        toward: say(lookup, `web.toward.${spec.toward}`),
        length: trim(spec.length),
        width: trim(spec.width),
        damage: percent(spec.damagePct),
      });
    case 'coinHit':
      if (spec.ignoreShield === true) extra('web.extra.ignoreShield');
      if (spec.ignoreArmour === true) extra('web.extra.ignoreArmour');
      return text({ mult: trim(spec.multiplier) });
    case 'chainBolt':
      if ((spec.shockStacks ?? 0) > 0) {
        const n = spec.shockStacks ?? 0;
        extra('web.extra.shock', { n, stack: word(lookup, 'stack', n) });
      }
      if (spec.from === 'nearestToPoint') extra('web.extra.nearestToPoint');
      return text({ jumps: spec.jumps, damage: percent(spec.damagePct) });
  }
}

// Triggers.

/** Events whose template names the enemy it happens to (`{enemies}`). */
const ENEMY_EVENTS: ReadonlySet<TriggerEventId> = new Set<TriggerEventId>([
  'freeze',
  'hit',
  'crit',
  'kill',
  'ailmentApplied',
  'ailmentTick',
  'diedWithAilment',
  'shatter',
  'contact',
]);
/** Events whose template says how the enemy died (`{how}`). */
const DEATH_EVENTS: ReadonlySet<TriggerEventId> = new Set<TriggerEventId>([
  'kill',
  'diedWithAilment',
]);

const isCenterEvent = (on: TriggerEventId): on is CenterEvent =>
  (CENTER_EVENTS as readonly TriggerEventId[]).includes(on);

/** An effect the engine runs once per enemy of a center event's list (CompiledEffect.fanout). */
const fansOut = (effect: EffectSpec): boolean =>
  (effect.kind === 'applyAilment' || effect.kind === 'addFrost' || effect.kind === 'detonate') &&
  effect.radius === undefined;
const onPlayer = (effect: EffectSpec): boolean =>
  effect.kind === 'repeatAttack' || effect.kind === 'heal' || effect.kind === 'shield';

/**
 * How a center event's trigger without a selector places its effects, for FANOUT_TEXT: every
 * effect fans out over the event's list (status), every one acts on the player (self), or none
 * fans out (placement); null for any other trigger, which reads as an event and its effects.
 */
function fanoutOf(trigger: TriggerSpec): PayloadType | null {
  if (!isCenterEvent(trigger.on) || trigger.target !== undefined || trigger.do.length === 0)
    return null;
  if (trigger.do.every(fansOut)) return 'status';
  if (trigger.do.every(onPlayer)) return 'self';
  return trigger.do.some(fansOut) ? null : 'placement';
}

/** A chainJump trigger's chance: CHAIN_JUMP_CHANCE × coef, at most 100% (D10). */
const jumpChance = (coef: number): string => percent(Math.min(1, CHAIN_JUMP_CHANCE * coef));

/**
 * One trigger's line at `coef`: FANOUT_TEXT[event][type] for a center event's trigger that fans
 * out, acts at its point or on the player (`type`: the payload's for a template core, else
 * fanoutOf's), else the event with its enemies, the other conditions in brackets and the
 * selector's enemy, then the effects. Its chance is the one compileTrigger rolls (D10).
 */
function triggerText(
  lookup: TextLookup,
  trigger: TriggerSpec,
  coef: number,
  type: PayloadType | null,
): string {
  const when = trigger.when ?? [];
  const consumed = new Set<Condition>();
  const values: Record<string, string | number> = {};
  if (ENEMY_EVENTS.has(trigger.on) && type === null) {
    const enemy = when.filter((c) => ENEMY_CONDITIONS.has(conditionKey(c)));
    for (const c of enemy) consumed.add(c);
    values.enemies = enemiesText(lookup, enemy, trigger.on === 'diedWithAilment');
  }
  if (DEATH_EVENTS.has(trigger.on)) {
    const killedBy = when.find((c) => 'killedBy' in c);
    if (killedBy !== undefined) consumed.add(killedBy);
    values.how =
      killedBy === undefined ? say(lookup, 'web.how.killed') : conditionText(lookup, killedBy, 1);
  }
  const named = when.find((c): c is Extract<Condition, { ailment: unknown }> => 'ailment' in c);
  if (named !== undefined) {
    consumed.add(named);
    values.ailment =
      trigger.on === 'ailmentApplied'
        ? say(lookup, `web.applied.${named.ailment}`)
        : say(lookup, `web.ailment.${named.ailment}`);
  }
  if (trigger.on === 'nthAttack') values.n = trigger.every ?? 1;
  if (trigger.on === 'periodic') values.s = trim(trigger.every ?? 0);
  if (trigger.on === 'ailmentTick') values.s = trim(trigger.every ?? 0.25);
  if (trigger.on === 'chainJump') {
    values.chance = jumpChance(coef);
    values.cap = CHAIN_JUMP_EVENT_CAP;
  }
  const list: string[] = [];
  const against = when.filter((c) => !consumed.has(c) && ENEMY_CONDITIONS.has(conditionKey(c)));
  for (const c of when) {
    if (consumed.has(c) || ENEMY_CONDITIONS.has(conditionKey(c))) continue;
    list.push(conditionText(lookup, c, coef));
  }
  // With no chance condition, compileTrigger rolls min(1, 1 × coef): below 1 at a fusion's coef
  // under 1, written as a chance condition of 1 is. chainJump's chance is in its event's text.
  if (coef < 1 && trigger.on !== 'chainJump' && !when.some((c) => 'chance' in c)) {
    list.push(conditionText(lookup, { chance: 1 }, coef));
  }
  if (against.length > 0)
    list.push(say(lookup, 'web.qual.against', { enemies: enemiesText(lookup, against, false) }));
  const conds =
    list.length === 0
      ? ''
      : say(lookup, 'web.conds', { list: list.join(say(lookup, 'web.join.clause')) });
  const effects = trigger.do
    .map((effect) => effectText(lookup, effect, coef))
    .join(say(lookup, 'web.join.effects'));
  if (type !== null && isCenterEvent(trigger.on)) {
    return say(lookup, FANOUT_TEXT[trigger.on][type], {
      ...values,
      conds,
      effects,
      max: LIST_MAX,
      radius: FREEZE_LIST_RADIUS,
    });
  }
  const eventKey =
    trigger.on === 'nthAttack' && (trigger.every ?? 1) === 1
      ? 'web.event.nthAttack.one'
      : EVENT_TEXT[trigger.on];
  const event = say(lookup, eventKey, values);
  if (trigger.target !== undefined) {
    const pick = pickText(lookup, trigger.target);
    return say(lookup, 'web.trigger.target', { event, conds, pick, effects });
  }
  return say(lookup, 'web.trigger', { event, conds, effects });
}

// Modifiers.

/** A scaling's phrase (§4.7): per unit for linear, the curve of x otherwise, and its cap. */
function curveText(
  lookup: TextLookup,
  scaling: ScalingSpec,
  cap: ((value: number) => string) | null,
): string {
  const text = SCALING_TEXT[scaling.per];
  const n =
    scaling.every === undefined
      ? undefined
      : text.every === 'percent'
        ? percent(scaling.every)
        : trim(scaling.every);
  const per = n === undefined ? say(lookup, text.one) : say(lookup, text.other, { n });
  const name = say(lookup, text.name);
  const x = n === undefined ? name : say(lookup, 'web.scaling.every', { x: name, n });
  const curve = scaling.curve ?? 'linear';
  let capText = '';
  if (cap !== null && scaling.cap !== undefined) {
    capText =
      curve === 'powFactor'
        ? say(lookup, 'web.scaling.capFactor', { cap: trim(scaling.cap) })
        : say(lookup, 'web.scaling.cap', { cap: cap(scaling.cap) });
  }
  return say(lookup, CURVE_TEXT[curve], { per, x, e: trim(scaling.exponent ?? 1), cap: capText });
}

/**
 * A modifier's value in M1's template: mod.flat through STAT_FORMAT, else a percentage; an
 * increased value below 0 reads as reduced (web.mod.reduced), as a more one below 0 reads as less.
 */
function valueText(lookup: TextLookup, mod: Modifier, stat: string): string {
  if (mod.kind === 'flat')
    return say(lookup, 'mod.flat', { value: flatValue(mod.stat, mod.value), stat });
  const value = trim(Math.abs(mod.value) * 100);
  if (mod.kind === 'increased')
    return say(lookup, mod.value < 0 ? 'web.mod.reduced' : 'mod.increased', { value, stat });
  return say(lookup, mod.value >= 0 ? 'mod.more' : 'mod.less', { value, stat });
}

/** The total of a ranked node's modifier at `rank` (webBuild's merge, F54), or null for none. */
function rankTotal(mod: Modifier, rank: number): string | null {
  if (isAlways(mod.stat) || mod.scaling?.curve === 'powFactor') return null;
  if (mod.kind === 'flat') return flatValue(mod.stat, mod.value * rank);
  if (mod.kind === 'increased') return signedPercent(mod.value * rank);
  return `×${trim(Math.pow(1 + mod.value, rank))}`;
}

/**
 * One modifier's line (§4.7): the value in M1's template with the stat's name, then in brackets
 * the scope, the tags past the stat's own, the excluded tags, the enemies it acts against and
 * its scaling; a ranked node's per rank, with its rank and the total at it (「每級 +4%（2/5：+8%）」).
 */
function modifierText(lookup: TextLookup, mod: Modifier, rank: number, ranks: Ranks): string {
  const stat = statName(mod, lookup);
  const cap = (value: number): string =>
    mod.kind === 'flat' ? flatValue(mod.stat, value).slice(1) : percent(value);
  let line = isAlways(mod.stat)
    ? stat
    : mod.scaling?.curve === 'powFactor'
      ? say(lookup, 'web.mod.factor', { stat, factor: curveText(lookup, mod.scaling, cap) })
      : valueText(lookup, mod, stat);
  const quals: string[] = [];
  if (mod.scope !== undefined)
    quals.push(say(lookup, 'web.qual.scope', { source: sourceName(lookup, mod.scope) }));
  const tags = mod.stat === 'damage' ? (mod.tags ?? []).slice(1) : (mod.tags ?? []);
  if (tags.length > 0) quals.push(say(lookup, 'web.qual.tags', { tags: tagList(lookup, tags) }));
  if ((mod.notTags ?? []).length > 0)
    quals.push(say(lookup, 'web.qual.notTags', { tags: tagList(lookup, mod.notTags ?? []) }));
  if ((mod.when ?? []).length > 0) {
    const enemies = enemiesText(lookup, mod.when ?? [], false);
    quals.push(say(lookup, 'web.qual.against', { enemies }));
  }
  if (mod.scaling !== undefined && mod.scaling.curve !== 'powFactor')
    quals.push(curveText(lookup, mod.scaling, cap));
  if (ranks !== 1) {
    line = say(lookup, 'web.rank.per', { line });
    const total = rankTotal(mod, rank);
    if (total !== null) {
      quals.push(
        ranks === 'unlimited'
          ? say(lookup, 'web.rank.progressUnlimited', { rank, total })
          : say(lookup, 'web.rank.progress', { rank, max: ranks, total }),
      );
    }
  }
  if (quals.length === 0) return line;
  return say(lookup, 'web.mod.qualified', {
    line,
    quals: quals.join(say(lookup, 'web.join.clause')),
  });
}

/**
 * A template core's bonus line (BONUS_TEXT; D13): its value read from the core's first modifier,
 * which generate scaled by the coef under coefScalesBonus (Q2 (A)).
 */
function bonusText(
  lookup: TextLookup,
  bonus: BonusSpec,
  outer: OuterId,
  mod: Modifier | undefined,
): string {
  const value = mod?.value ?? 0;
  switch (bonus.form) {
    case 'status':
      return say(lookup, BONUS_TEXT.status, {
        enemies: enemiesText(lookup, [{ targetHas: bonus.ailment }], false),
        value: signedPercent(value),
      });
    case 'inZone':
      return say(lookup, BONUS_TEXT.inZone, { value: signedPercent(value) });
    case 'scaling': {
      if (bonus.scaling.curve === 'powFactor') {
        const stat = say(lookup, 'web.centerDamage');
        return say(lookup, 'web.mod.factor', {
          stat,
          factor: curveText(lookup, bonus.scaling, percent),
        });
      }
      const cap =
        bonus.scaling.cap === undefined
          ? ''
          : say(lookup, 'web.scaling.cap', { cap: signedPercent(bonus.scaling.cap) });
      const per = curveText(lookup, bonus.scaling, null);
      return say(lookup, BONUS_TEXT.scaling, { value: signedPercent(value), per, cap });
    }
    case 'inPayload':
      return say(lookup, BONUS_TEXT.inPayload, { outer: say(lookup, `web.outer.${outer}.name`) });
  }
}

function conversionText(lookup: TextLookup, conversion: ConversionSpec): string {
  const tags = conversion.tags ?? [];
  const from =
    tags.length === 0
      ? say(lookup, 'web.conversion.all')
      : tags.map((tag) => say(lookup, `stat.damage.${tag}`)).join(say(lookup, 'web.join.and'));
  return say(lookup, 'web.conversion', {
    pct: percent(conversion.fraction),
    from,
    to: say(lookup, `web.tag.${conversion.to}`),
  });
}

/** An emitter grant's line (GRANT_TEXT), its omitted fields at their defaults. */
function grantText(lookup: TextLookup, grant: EmitterGrant): string {
  const key = GRANT_TEXT[grant.kind];
  switch (grant.kind) {
    case 'thorns':
      return say(lookup, key, { damage: percent(grant.damagePct ?? THORNS_DAMAGE_PCT) });
    case 'segment': {
      const n = grant.shockStacks ?? SEGMENT_DEFAULTS.shockStacks;
      return say(lookup, key, {
        period: trim(grant.periodSec ?? SEGMENT_DEFAULTS.periodSec),
        links: grant.links ?? SEGMENT_DEFAULTS.links,
        range: trim(grant.range ?? SEGMENT_DEFAULTS.range),
        damage: percent(grant.damagePct ?? SEGMENT_DEFAULTS.damagePct),
        n,
        stack: word(lookup, 'stack', n),
      });
    }
    case 'strike': {
      const extras: string[] = [];
      const radius = grant.radius ?? STRIKE_DEFAULTS.radius;
      if (radius > 0) extras.push(say(lookup, 'web.extra.area', { radius: trim(radius) }));
      if (grant.element !== undefined)
        extras.push(
          say(lookup, 'web.extra.element', { element: say(lookup, `web.tag.${grant.element}`) }),
        );
      const jumps = grant.chainJumps ?? STRIKE_DEFAULTS.chainJumps;
      if (jumps > 0)
        extras.push(
          say(lookup, 'web.extra.chain', { n: jumps, jumps: word(lookup, 'jump', jumps) }),
        );
      const shock = grant.shockStacks ?? STRIKE_DEFAULTS.shockStacks;
      if (shock > 0)
        extras.push(
          say(lookup, 'web.extra.shock', { n: shock, stack: word(lookup, 'stack', shock) }),
        );
      return say(lookup, key, {
        period: trim(grant.periodSec),
        pick: pickText(lookup, grant.target),
        damage: percent(grant.damagePct),
        extra: extras.join(''),
      });
    }
    case 'drone': {
      const parts: string[] = [];
      const drones = grant.drones ?? 0;
      const turrets = grant.turrets ?? 0;
      if (drones > 0) {
        parts.push(
          say(lookup, key, {
            n: drones,
            drones: word(lookup, 'drone', drones),
            damage: percent(grant.damagePct ?? DRONE_DEFAULTS.damagePct),
          }),
        );
      }
      if (turrets > 0) {
        parts.push(
          say(lookup, 'web.grant.turret', {
            n: turrets,
            turrets: word(lookup, 'turret', turrets),
            damage: percent(grant.turretDamagePct ?? DRONE_DEFAULTS.turretDamagePct),
          }),
        );
      }
      return parts.join(say(lookup, 'web.join.clause'));
    }
    case 'aura': {
      const extras: string[] = [];
      if (grant.everyNth !== undefined)
        extras.push(
          say(lookup, 'web.extra.everyNth', {
            n: grant.everyNth.n,
            mult: trim(grant.everyNth.mult),
          }),
        );
      if (grant.corona !== undefined)
        extras.push(
          say(lookup, 'web.extra.corona', {
            s: trim(grant.corona.periodSec),
            mult: trim(grant.corona.damagePct),
          }),
        );
      return say(lookup, key, {
        damage: percent(grant.damagePct ?? AURA_DEFAULTS.damagePct),
        extra: extras.join(''),
      });
    }
    case 'orbit':
      return say(lookup, key, {
        count: grant.count ?? 0,
        ring: say(lookup, (grant.ring ?? ORBIT_DEFAULTS.ring) === 1 ? 'web.ring.1' : 'web.ring.0'),
        damage: percent(grant.damagePct ?? ORBIT_DEFAULTS.damagePct),
        cooldown: trim(grant.cooldownSec ?? ORBIT_DEFAULTS.cooldownSec),
      });
  }
}

// Nodes.

/** The fusion a fusion board's node sits on, or undefined off fusion boards. */
function fusionOf(web: AssembledWeb, node: WebNode): FusionDef | undefined {
  if (!node.board.startsWith('fusion.')) return undefined;
  return web.fusions.get(fusionKeyOf(node.board).split('.')[1] as OuterId);
}

/** A template core's bonus whose line writes a value (D12). */
export interface CoreBonus {
  /** The value its template writes (the outer's payload, or the override's bonus). */
  readonly value: number;
  /**
   * The core's first modifier, which bonusText reads: generate wrote it × coef under
   * coefScalesBonus (Q2 (A)).
   */
  readonly mod: Modifier;
}

/**
 * `node`'s bonus when it is a template core on `fusion` whose bonus line writes a value (form
 * status, inZone, or scaling on a curve other than powFactor), else null; null too when the core
 * has no first modifier.
 */
export function coreBonus(fusion: FusionDef | undefined, node: WebNode): CoreBonus | null {
  const bonus = node.kind === 'core' ? fusion?.template?.bonus : undefined;
  const mod = node.effects.modifiers[0];
  if (bonus === undefined || bonus === null || bonus.form === 'inPayload' || mod === undefined)
    return null;
  if (bonus.form === 'scaling' && bonus.scaling.curve === 'powFactor') return null;
  return { value: bonus.value, mod };
}

/**
 * The values a hand description's placeholders take on `fusion`'s board (§4.7), at its coef (1
 * off fusion boards): each rule field RULE_COEF_FIELDS lists, through scaleRuleSpec; {chance}, a
 * chance condition's chance or chainJump's CHAIN_JUMP_CHANCE × coef, at most 100%; each
 * trigger's COEF fields × coef; {bonus}, a template core's bonus as the run has it (coreBonus,
 * with or without coefScalesBonus), signed as its line writes it (+46%). The first of two fields
 * of one name fills it. No placeholder writes the chance of a trigger that is not chainJump and
 * has no chance condition (min(1, coef)): describeNode adds it as a line of its own below coef 1.
 */
function coefValues(node: WebNode, fusion: FusionDef | undefined): Record<string, string> {
  const coef = fusion?.coef ?? 1;
  const values: Record<string, string> = {};
  const put = (name: string, text: string): void => {
    if (!Object.hasOwn(values, name)) values[name] = text;
  };
  for (const rule of node.effects.rules) {
    const fields = RULE_COEF_FIELDS[rule.id] as Readonly<Record<string, CoefFieldKind>> | undefined;
    if (fields === undefined) continue;
    const scaled = scaleRuleSpec(rule, coef, RULE_COEF_FIELDS) as RuleSpec &
      Record<string, unknown>;
    for (const [field, kind] of Object.entries(fields)) {
      const value = scaled[field];
      if (typeof value === 'number') put(field, fieldText(kind, value));
    }
  }
  for (const trigger of node.effects.triggers) {
    const chance = trigger.when?.find((c) => 'chance' in c);
    if (chance !== undefined && 'chance' in chance)
      put('chance', percent(Math.min(1, chance.chance * coef)));
    else if (trigger.on === 'chainJump') put('chance', jumpChance(coef));
    for (const effect of trigger.do) {
      const formats = COEF_FORMAT[effect.kind] as Readonly<Record<string, 'pct' | 'mult'>>;
      const scaled = withCoef(effect, coef) as unknown as Record<string, unknown>;
      for (const field of COEF_FIELDS[effect.kind] as readonly string[]) {
        put(field, fieldText(formats[field] ?? 'pct', scaled[field] as number));
      }
    }
  }
  const bonus = coreBonus(fusion, node);
  if (bonus !== null) put('bonus', signedPercent(bonus.mod.value));
  return values;
}

/**
 * The line after a hand description on a fusion board under coef 1 when its node has a trigger
 * that is not chainJump and has no chance condition: the chance compileTrigger rolls for it,
 * min(1, coef), the same for every such trigger, which no placeholder writes (D10); else none.
 */
function chanceLine(lookup: TextLookup, node: WebNode, fusion: FusionDef | undefined): string[] {
  const coef = fusion?.coef ?? 1;
  const rolls = node.effects.triggers.some(
    (trigger) => trigger.on !== 'chainJump' && !(trigger.when ?? []).some((c) => 'chance' in c),
  );
  if (fusion === undefined || coef >= 1 || !rolls) return [];
  return [sentence(say(lookup, 'web.desc.chance', { chance: percent(Math.min(1, coef)) }))];
}

/**
 * A node's generated lines (§4.7): a template core's fan-out and bonus first, then its other
 * modifiers, triggers, conversions, grants and rules; a ranked node's modifiers per rank, its
 * triggers and conversions once a rank.
 */
function generatedLines(
  web: AssembledWeb,
  node: WebNode,
  rank: number,
  lookup: TextLookup,
): string[] {
  const fusion = fusionOf(web, node);
  const coef = fusion?.coef ?? 1;
  const { modifiers, triggers, conversions, emitters, rules } = node.effects;
  const repeated = (line: string): string =>
    node.ranks === 1 ? line : say(lookup, 'web.rank.each', { line });
  const lines: string[] = [];
  let skip = 0;
  let own: TriggerSpec | undefined;
  const template = node.kind === 'core' ? fusion?.template : null;
  if (template !== null && template !== undefined) {
    const outer = fusionKeyOf(node.board).split('.')[1] as OuterId;
    own = triggers.find((trigger) => trigger.do === template.do);
    const type =
      web.outers.get(outer)?.payload?.type ?? fanoutOf(own ?? { on: template.on, do: [] });
    if (own !== undefined) lines.push(triggerText(lookup, own, coef, type));
    if (template.bonus !== null) {
      lines.push(bonusText(lookup, template.bonus, outer, modifiers[0]));
      if (template.bonus.form !== 'inPayload') skip = 1;
    }
  }
  for (const mod of modifiers.slice(skip)) lines.push(modifierText(lookup, mod, rank, node.ranks));
  for (const trigger of triggers) {
    if (trigger !== own)
      lines.push(repeated(triggerText(lookup, trigger, coef, fanoutOf(trigger))));
  }
  for (const conversion of conversions) lines.push(repeated(conversionText(lookup, conversion)));
  for (const grant of emitters) lines.push(grantText(lookup, grant));
  for (const rule of rules) lines.push(say(lookup, 'web.ruleFallback', { rule: rule.id }));
  return lines.map(sentence);
}

/**
 * A node's name, kind and lines at `rank` (§4.7): the hand text `web.node.<id>.desc` when the key
 * exists (F25), its placeholders filled (coefValues), then under a fusion's coef below 1 the
 * chance of its triggers that are not chainJump and have no chance condition (chanceLine); else
 * the generated lines; then 「答案：…」 for a node with answers. Numbers on a fusion board are the
 * run's: a trigger's chance and COEF fields × the fusion's coef, a rule's fields through
 * scaleRuleSpec (D10), a template core's bonus as generate wrote it. Throws on an id the web does
 * not hold.
 */
export function describeNode(
  web: AssembledWeb,
  id: string,
  rank: number,
  lookup: TextLookup = APP_LOOKUP,
): NodeText {
  const node = web.byId.get(id);
  if (node === undefined) {
    throw new Error(`node '${id}' is not on character '${web.character}''s web`);
  }
  const fusion = fusionOf(web, node);
  const desc = `web.node.${id}.desc`;
  const lines = lookup.has(desc)
    ? [lookup.get(desc, coefValues(node, fusion)), ...chanceLine(lookup, node, fusion)]
    : generatedLines(web, node, rank, lookup);
  if (node.answers.length > 0) {
    const enemies = node.answers
      .map((enemy) => say(lookup, `web.enemy.${enemy}`))
      .join(say(lookup, 'web.join.list'));
    lines.push(say(lookup, 'web.answers', { enemies }));
  }
  return { name: nodeName(web, id, lookup), kind: say(lookup, KIND_TEXT[node.kind]), lines };
}

/** A refused purchase's text (BUY_CHECK_TEXT), with its gate's counts. */
export function buyCheckText(
  check: Extract<BuyCheck, { readonly ok: false }>,
  lookup: TextLookup = APP_LOOKUP,
): string {
  const gate = check.gate;
  return say(lookup, BUY_CHECK_TEXT[check.reason], {
    center: gate?.center ?? 0,
    centerNeed: gate?.centerNeed ?? 0,
    outer: gate?.outer ?? 0,
    outerNeed: gate?.outerNeed ?? 0,
  });
}
