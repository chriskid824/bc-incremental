/**
 * Content checks that a schema cannot express: cross-references, graph shape and value
 * ranges (docs/ARCHITECTURE.md §6). Runs on load and in tests; the talent viewer can show
 * the same messages.
 */

import { grantKey } from './emitters';
import type { EmitterGrant } from './emitters';
import type { RuleSpec } from './rules';
import { ARCHETYPE_TAGS, SOURCE_CLASSES, sourceOfNode } from './sources';
import { isBehaviourModifier } from './stats';
import type { Modifier } from './stats';
import { DELIVERY_MASK, DOT_MASK, TAG } from './tags';
import {
  CONDITION_CONTEXTS,
  conditionKey,
  DOT_AILMENTS,
  TARGETLESS_EVENTS,
  TRANSFER_EFFECTS,
  WIRED_EVENTS,
} from './triggers';
import type {
  Condition,
  ConversionSpec,
  EffectSpec,
  TargetPick,
  TargetSelector,
  TriggerEventId,
  TriggerSpec,
} from './triggers';
import { ENEMY_IDS } from './types';
import type { EnemyDef, EnemyId, GameData, TalentNode, WaveTable } from './types';

/** Upper bound on keystones in the web (docs/GDD.md §4.1: 4–6 in the MVP). */
export const MAX_KEYSTONES = 6;

/** Enemies added by eliteEvery/bossEvery; spawn rules must not use them. */
const SPECIAL_ENEMIES: readonly EnemyId[] = ['hexagon', 'boss'];

const isPositiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;
const isNonNegativeInt = (n: number): boolean => Number.isInteger(n) && n >= 0;

/**
 * A node whose descKey text the talent screen shows: it has rules, triggers, conversions,
 * emitters or behaviour modifiers, which the screen cannot describe from numbers alone.
 */
export function needsDescKey(
  node: Pick<TalentNode, 'modifiers' | 'rules' | 'triggers' | 'conversions' | 'emitters'>,
): boolean {
  return (
    node.rules.length > 0 ||
    node.triggers.length > 0 ||
    node.conversions.length > 0 ||
    node.emitters.length > 0 ||
    node.modifiers.some(isBehaviourModifier)
  );
}

/** Returns human-readable issues; an empty list means the data is valid. */
export function validateGameData(data: GameData): string[] {
  return [...validateEnemies(data), ...validateWaves(data), ...validateTalents(data.talents)];
}

function validateEnemies(data: GameData): string[] {
  const issues: string[] = [];
  const enemies: Readonly<Record<string, EnemyDef | undefined>> = data.enemies;
  const known = new Set<string>(ENEMY_IDS);

  for (const id of ENEMY_IDS) {
    if (enemies[id] === undefined) issues.push(`enemies: missing definition for '${id}'`);
  }

  for (const [key, def] of Object.entries(enemies)) {
    if (def === undefined) continue;
    const at = `enemies.${key}`;
    if (!known.has(key)) issues.push(`${at}: unknown enemy id`);
    if (def.id !== key) issues.push(`${at}: id is '${def.id}', expected '${key}'`);
    if (!(def.hpMult > 0)) issues.push(`${at}: hpMult must be > 0 (got ${def.hpMult})`);
    if (!(def.speed >= 0)) issues.push(`${at}: speed must be >= 0 (got ${def.speed})`);
    if (!(def.radius > 0)) issues.push(`${at}: radius must be > 0 (got ${def.radius})`);
    if (!(def.contactDamage >= 0)) {
      issues.push(`${at}: contactDamage must be >= 0 (got ${def.contactDamage})`);
    }
    if (!(def.dropMult >= 0)) issues.push(`${at}: dropMult must be >= 0 (got ${def.dropMult})`);
    if (!isNonNegativeInt(def.cores)) {
      issues.push(`${at}: cores must be a non-negative integer (got ${def.cores})`);
    }
    if (!isNonNegativeInt(def.color) || def.color > 0xffffff) {
      issues.push(`${at}: color must be an integer 0xRRGGBB (got ${def.color})`);
    }
    if (def.splitInto !== undefined) {
      const { enemy, count } = def.splitInto;
      if (enemy === key) issues.push(`${at}: splitInto references itself`);
      else if (enemies[enemy] === undefined) {
        issues.push(`${at}: splitInto references unknown enemy '${enemy}'`);
      }
      if (!isPositiveInt(count)) {
        issues.push(`${at}: splitInto.count must be a positive integer (got ${count})`);
      }
    }
  }

  // A split chain that loops back (a → b → a) would spawn forever. Every enemy on the loop
  // gets its own issue; self-splits are reported above.
  for (const [key, def] of Object.entries(enemies)) {
    if (def?.splitInto === undefined || def.splitInto.enemy === key) continue;
    const seen = new Set<string>();
    let current: string | undefined = key;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      current = enemies[current]?.splitInto?.enemy;
    }
    if (current === key) issues.push(`enemies.${key}: splitInto chain loops back to itself`);
  }

  return issues;
}

function validateWaves(data: GameData): string[] {
  const issues: string[] = [];
  const waves: WaveTable = data.waves;
  const enemies: Readonly<Record<string, unknown>> = data.enemies;

  waves.rules.forEach((rule, i) => {
    const at = `waves.rules[${i}] (${rule.enemy})`;
    if (enemies[rule.enemy] === undefined) issues.push(`${at}: unknown enemy`);
    if (SPECIAL_ENEMIES.includes(rule.enemy)) {
      issues.push(`${at}: '${rule.enemy}' is added by eliteEvery/bossEvery, not spawn rules`);
    }
    if (!isPositiveInt(rule.fromWave)) {
      issues.push(`${at}: fromWave must be a positive integer (got ${rule.fromWave})`);
    }
    if (!(rule.base >= 0)) issues.push(`${at}: base must be >= 0 (got ${rule.base})`);
    if (!(rule.perWave >= 0)) issues.push(`${at}: perWave must be >= 0 (got ${rule.perWave})`);
    if (!isNonNegativeInt(rule.maxCount)) {
      issues.push(`${at}: maxCount must be a non-negative integer (got ${rule.maxCount})`);
    }
    const minCount = rule.minCount ?? 0;
    if (!isNonNegativeInt(minCount) || minCount > rule.maxCount) {
      issues.push(`${at}: minCount must be an integer in 0..maxCount (got ${rule.minCount})`);
    }
  });

  for (const key of ['eliteEvery', 'bossEvery'] as const) {
    if (!isPositiveInt(waves[key])) {
      issues.push(`waves: ${key} must be a positive integer (got ${waves[key]})`);
    }
  }
  for (const key of ['spawnDurationSec', 'waveTimerSec'] as const) {
    if (!(waves[key] > 0)) issues.push(`waves: ${key} must be > 0 (got ${waves[key]})`);
  }

  return issues;
}

function validateTalents(talents: readonly TalentNode[]): string[] {
  const issues: string[] = [];
  const byId = new Map<string, TalentNode>();

  for (const node of talents) {
    if (node.id === '') issues.push('talents: node with an empty id');
    else if (byId.has(node.id)) issues.push(`talents: duplicate id '${node.id}'`);
    else byId.set(node.id, node);
  }

  const starts = talents.filter((node) => node.kind === 'start');
  if (starts.length !== 1) {
    issues.push(`talents: expected exactly one 'start' node, found ${starts.length}`);
  }
  for (const start of starts) {
    if (start.pos.x !== 0 || start.pos.y !== 0) {
      issues.push(`talent '${start.id}': start node must be at (0, 0)`);
    }
  }

  const keystones = talents.filter((node) => node.kind === 'keystone').length;
  if (keystones > MAX_KEYSTONES) {
    issues.push(`talents: ${keystones} keystones, at most ${MAX_KEYSTONES} allowed`);
  }

  for (const node of talents) {
    const at = `talent '${node.id}'`;

    const seenLinks = new Set<string>();
    for (const link of node.links) {
      if (seenLinks.has(link)) {
        issues.push(`${at}: duplicate link to '${link}'`);
        continue;
      }
      seenLinks.add(link);
      if (link === node.id) {
        issues.push(`${at}: links to itself`);
        continue;
      }
      const other = byId.get(link);
      if (other === undefined) issues.push(`${at}: links to unknown node '${link}'`);
      else if (!other.links.includes(node.id)) {
        issues.push(`${at}: links to '${link}' but '${link}' does not link back`);
      }
    }

    if (node.kind === 'repeatable' && node.repeat === undefined) {
      issues.push(`${at}: repeatable node needs 'repeat'`);
    }
    if (node.kind !== 'repeatable' && node.repeat !== undefined) {
      issues.push(`${at}: only repeatable nodes may have 'repeat'`);
    }
    if (node.repeat !== undefined) {
      if (!(node.repeat.baseShards > 0)) {
        issues.push(`${at}: repeat.baseShards must be > 0 (got ${node.repeat.baseShards})`);
      }
      if (!(node.repeat.growth >= 1)) {
        issues.push(`${at}: repeat.growth must be >= 1 (got ${node.repeat.growth})`);
      }
    }

    // Triggers, conversions, emitter grants and behaviour modifiers change how a run plays, as
    // rules do (Searing Crits is data).
    const behaviour = node.modifiers.some(isBehaviourModifier);
    if (
      node.kind === 'keystone' &&
      node.rules.length === 0 &&
      node.triggers.length === 0 &&
      node.conversions.length === 0 &&
      node.emitters.length === 0 &&
      !behaviour
    ) {
      issues.push(
        `${at}: keystone needs a rule, a trigger, a conversion, an emitter or a behaviour modifier`,
      );
    }
    if (node.kind !== 'keystone' && node.kind !== 'notable' && node.rules.length > 0) {
      issues.push(`${at}: only keystones and notables may have rules`);
    }
    const ruleIds = new Set<string>();
    for (const rule of node.rules) {
      if (ruleIds.has(rule.id)) issues.push(`${at}: duplicate rule '${rule.id}'`);
      ruleIds.add(rule.id);
      for (const problem of ruleIssues(rule)) issues.push(`${at}: rule '${rule.id}' ${problem}`);
    }
    node.modifiers.forEach((mod, i) => {
      for (const problem of modifierIssues(mod)) issues.push(`${at}: modifiers[${i}] ${problem}`);
    });
    node.triggers.forEach((trigger, i) => {
      for (const problem of triggerIssues(trigger)) issues.push(`${at}: triggers[${i}] ${problem}`);
    });
    node.conversions.forEach((conversion, i) => {
      for (const problem of conversionIssues(conversion)) {
        issues.push(`${at}: conversions[${i}] ${problem}`);
      }
    });
    // More than the whole hit cannot convert; the simulation scales a sum over 1 from several
    // nodes down, but one node's sum is its own mistake. The slack lets shares that add up to
    // 1 in decimal (0.34 + 0.56 + 0.1) pass.
    const converted = node.conversions.reduce((sum, conversion) => sum + conversion.fraction, 0);
    if (converted > 1 + 1e-9) issues.push(`${at}: conversions add up to ${converted}, more than 1`);
    node.emitters.forEach((grant, i) => {
      for (const problem of grantIssues(grant)) issues.push(`${at}: emitters[${i}] ${problem}`);
    });

    if (node.shardCostFactor !== undefined && !(node.shardCostFactor >= 0)) {
      issues.push(`${at}: shardCostFactor must be >= 0 (got ${node.shardCostFactor})`);
    }
    if (node.coreCost !== undefined && !isNonNegativeInt(node.coreCost)) {
      issues.push(`${at}: coreCost must be a non-negative integer (got ${node.coreCost})`);
    }
    if (node.nameKey === '') issues.push(`${at}: empty nameKey`);
    if (node.descKey === '') issues.push(`${at}: empty descKey`);
    // The talent screen lists plain modifiers itself; descKey covers everything else.
    const described = needsDescKey(node);
    if (described && node.descKey === undefined) {
      issues.push(
        `${at}: a node with rules, triggers, conversions, emitters or behaviour modifiers ` +
          'needs a descKey',
      );
    }
    if (!described && node.descKey !== undefined) {
      issues.push(
        `${at}: descKey describes rules, triggers, conversions, emitters and behaviour ` +
          'modifiers; this node has none',
      );
    }
  }

  issues.push(...grantConflicts(talents));

  // Reachability over the links as listed; asymmetric links are reported above.
  if (starts.length > 0) {
    const reached = new Set<string>(starts.map((node) => node.id));
    const queue = [...reached];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      for (const link of byId.get(id)?.links ?? []) {
        if (byId.has(link) && !reached.has(link)) {
          reached.add(link);
          queue.push(link);
        }
      }
    }
    for (const id of byId.keys()) {
      if (!reached.has(id)) issues.push(`talent '${id}': not reachable from the start node`);
    }
  }

  return issues;
}

/**
 * A build has one emitter per grant kind, source and key (grantKey): compileBuild keeps the
 * first grant. Grants of a source that share them must therefore agree field for field, or the
 * emitter a build gets would depend on which of its nodes comes first.
 */
function grantConflicts(talents: readonly TalentNode[]): string[] {
  const issues: string[] = [];
  const first = new Map<string, EmitterGrant>();
  const reported = new Set<string>();
  for (const node of talents) {
    const source = sourceOfNode(node.id);
    for (const grant of node.emitters) {
      const key = grantKey(grant);
      const id = `${grant.kind}|${source}|${key}`;
      const kept = first.get(id);
      if (kept === undefined) first.set(id, grant);
      else if (canonical(kept) !== canonical(grant) && !reported.has(id)) {
        reported.add(id);
        issues.push(
          `talents: emitter ${grant.kind} '${key}' is granted twice by source '${source}' ` +
            'with different fields; keep it on one node',
        );
      }
    }
  }
  return issues;
}

/** JSON of a data value with every object's keys sorted, so equal values give equal text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Parameter ranges of one emitter grant; the simulation relies on them (src/sim/emitters/). */
function grantIssues(grant: EmitterGrant): string[] {
  const issues: string[] = [];
  switch (grant.kind) {
    case 'thorns':
      if (grant.damagePct !== undefined && !(grant.damagePct > 0)) {
        issues.push(`damagePct must be > 0 (got ${grant.damagePct})`);
      }
      break;
  }
  return issues;
}

/** Parameter ranges of one rule; the simulation relies on them (src/sim/rules/). */
function ruleIssues(rule: RuleSpec): string[] {
  const issues: string[] = [];
  const more = (name: string, value: number): void => {
    if (!(value > -1)) issues.push(`${name} must be > -1 (got ${value})`);
  };
  const chance = (name: string, value: number): void => {
    if (!(value >= 0 && value <= 1)) issues.push(`${name} must be in [0, 1] (got ${value})`);
  };
  switch (rule.id) {
    case 'steadyAim':
      if (!isPositiveInt(rule.everyNth)) {
        issues.push(`everyNth must be a positive integer (got ${rule.everyNth})`);
      }
      more('critMultiplierMore', rule.critMultiplierMore);
      break;
    case 'eternalFlame':
      more('durationMore', rule.durationMore);
      break;
    case 'overload':
      if (!(rule.chainCountMultiplier >= 0)) {
        issues.push(`chainCountMultiplier must be >= 0 (got ${rule.chainCountMultiplier})`);
      }
      chance('retentionPenalty', rule.retentionPenalty);
      if (rule.chainMore !== undefined) more('chainMore', rule.chainMore);
      break;
    case 'glassCannon':
      more('damageMore', rule.damageMore);
      break;
  }
  return issues;
}

/**
 * Ranges of a modifier's conditions and scaling (src/data/triggers.ts); the simulation relies on
 * them.
 */
function modifierIssues(mod: Modifier): string[] {
  const issues: string[] = [];
  (mod.when ?? []).forEach((condition, i) => {
    for (const problem of conditionIssues(condition)) issues.push(`when[${i}] ${problem}`);
  });
  const scaling = mod.scaling;
  if (scaling === undefined) return issues;
  if (scaling.every !== undefined && !(scaling.every > 0)) {
    issues.push(`scaling.every must be > 0 (got ${scaling.every})`);
  }
  // A positive exponent keeps g(0) = 0, so the primary hit gets no contribution.
  if (scaling.exponent !== undefined && !(scaling.exponent > 0)) {
    issues.push(`scaling.exponent must be > 0 (got ${scaling.exponent})`);
  }
  return issues;
}

/** Value ranges of one condition. */
function conditionIssues(condition: Condition): string[] {
  const issues: string[] = [];
  if ('chance' in condition && !(condition.chance > 0 && condition.chance <= 1)) {
    issues.push(`chance must be in (0, 1] (got ${condition.chance})`);
  }
  if ('cooldownSec' in condition && !(condition.cooldownSec > 0)) {
    issues.push(`cooldownSec must be > 0 (got ${condition.cooldownSec})`);
  }
  if (
    'targetHpBelow' in condition &&
    !(condition.targetHpBelow > 0 && condition.targetHpBelow <= 1)
  ) {
    issues.push(`targetHpBelow must be in (0, 1] (got ${condition.targetHpBelow})`);
  }
  if ('stacksAtLeast' in condition && !isPositiveInt(condition.stacksAtLeast.stacks)) {
    issues.push(
      `stacksAtLeast.stacks must be a positive integer (got ${condition.stacksAtLeast.stacks})`,
    );
  }
  // Sources are numbered as a run first meets them, so a class has no fixed set to expand to;
  // 'center' is both a class and its one id.
  if ('inZone' in condition && isZoneClass(condition.inZone)) {
    issues.push(
      'inZone takes one source id (center, outer.<id>, fusion.<char>.<outer>), ' +
        `not '${condition.inZone}'`,
    );
  }
  return issues;
}

/** A source class that is not also a single source id: every class but 'center'. */
const isZoneClass = (selector: string): boolean =>
  selector !== 'center' && (SOURCE_CLASSES as readonly string[]).includes(selector);

/** An order (TARGET_ORDERS) ranks what a radius finds, so it needs one. */
const orderIssue = (order: string): string =>
  `order '${order}' sorts the enemies a radius finds; add a radius or drop order`;

const KILL_EVENTS: readonly TriggerEventId[] = ['kill', 'diedWithAilment'];
/** Events whose enemy is dead when their triggers run. */
const DEAD_EVENTS: readonly TriggerEventId[] = [...KILL_EVENTS, 'shatter'];

/**
 * Selector picks that look at every enemy (or, densest, at every grid cell), and the events that
 * come once per hit, application or damage-over-time step, too often to pay for such a scan.
 */
const SCANNING_PICKS: ReadonlySet<TargetPick> = new Set<TargetPick>([
  'farthest',
  'highestHp',
  'densest',
  'outermost',
  'mostStacks',
]);
const FREQUENT_EVENTS: readonly TriggerEventId[] = ['hit', 'crit', 'ailmentApplied', 'ailmentTick'];

/** A kill trigger made only of transfers, which runs at the kill (CompiledTrigger.inline). */
const runsAtKill = (trigger: TriggerSpec): boolean =>
  KILL_EVENTS.includes(trigger.on) &&
  trigger.do.length > 0 &&
  trigger.do.every((effect) => TRANSFER_EFFECTS.has(effect.kind));

/** Events whose `every` is required or allowed, and what it must be. */
function everyIssues(trigger: TriggerSpec): string[] {
  const { on, every } = trigger;
  if (on === 'nthAttack') {
    return every === undefined || isPositiveInt(every)
      ? []
      : [`every must be a positive integer on nthAttack (got ${every})`];
  }
  if (on === 'periodic') {
    return every !== undefined && every > 0
      ? []
      : [`every must be > 0 seconds on periodic (got ${every})`];
  }
  if (on === 'ailmentTick') {
    // Damage over time steps every 0.25 s; the interval counts whole steps.
    return every === undefined || (every > 0 && Number.isInteger(every * 4))
      ? []
      : [`every must be a positive multiple of 0.25 seconds on ailmentTick (got ${every})`];
  }
  return every === undefined
    ? []
    : [`every is only allowed on nthAttack, periodic and ailmentTick (on ${on})`];
}

/**
 * ailmentApplied and ailmentTick triggers name exactly one ailment, a damage-over-time one on
 * ailmentTick, so that none fires for every ailment applied or every enemy stepped.
 */
function ailmentIssues(trigger: TriggerSpec): string[] {
  const on = trigger.on;
  if (on !== 'ailmentApplied' && on !== 'ailmentTick') return [];
  const named = (trigger.when ?? []).flatMap((condition) =>
    'ailment' in condition ? [condition.ailment] : [],
  );
  if (named.length !== 1) return [`needs exactly one ailment condition on '${on}' events`];
  const ailment = named[0] as (typeof named)[number];
  return on === 'ailmentTick' && !DOT_AILMENTS.includes(ailment)
    ? [`ailment '${ailment}' deals no damage over time, so it never ticks`]
    : [];
}

/**
 * Event, conditions and effects of one trigger: the simulation raises the event, each condition
 * fits it (CONDITION_CONTEXTS), and each effect can run there.
 */
function triggerIssues(trigger: TriggerSpec): string[] {
  const issues: string[] = [];
  const on = trigger.on;
  if (!WIRED_EVENTS.has(on)) issues.push(`event '${on}' is not raised by the simulation yet`);
  issues.push(...everyIssues(trigger), ...ailmentIssues(trigger));
  const counts = new Map<string, number>();
  (trigger.when ?? []).forEach((condition, i) => {
    const key = conditionKey(condition);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!CONDITION_CONTEXTS[key].includes(on)) {
      issues.push(`when[${i}] ${key} does not apply to '${on}' events`);
    }
    for (const problem of conditionIssues(condition)) issues.push(`when[${i}] ${problem}`);
  });
  for (const key of ['chance', 'cooldownSec']) {
    if ((counts.get(key) ?? 0) > 1) issues.push(`at most one ${key} condition`);
  }
  const target = trigger.target;
  if (target !== undefined) issues.push(...selectorIssues(trigger, target));

  if (trigger.do.length === 0) issues.push('needs at least one effect');
  const kill = KILL_EVENTS.includes(on);
  const transfers = trigger.do.filter((effect) => TRANSFER_EFFECTS.has(effect.kind)).length;
  // A kill trigger runs at the kill only when all of its effects are transfers.
  if (kill && transfers > 0 && transfers < trigger.do.length) {
    issues.push('mixes transfer and other effects on a kill event; split it into two triggers');
  }
  trigger.do.forEach((effect, i) => {
    for (const problem of effectIssues(effect, on, target)) issues.push(`do[${i}] ${problem}`);
  });
  return issues;
}

/**
 * Where a trigger's target selector can run and what it needs: no waveStart (nothing has
 * spawned to pick when it fires), no kill trigger that runs at the kill (its transfers act on
 * the victim), no pick that scans every enemy on events that come per hit, mostStacks with
 * exactly its ailment, a range above 0, and the event's enemy to exclude.
 */
function selectorIssues(trigger: TriggerSpec, target: TargetSelector): string[] {
  const on = trigger.on;
  if (on === 'waveStart') {
    return ["target is not allowed on 'waveStart' events; use a periodic trigger with a selector"];
  }
  if (runsAtKill(trigger)) {
    return [
      'target is not allowed on a kill trigger that runs at the kill; it always acts on the victim',
    ];
  }
  const issues: string[] = [];
  const pick = target.pick;
  if (SCANNING_PICKS.has(pick) && FREQUENT_EVENTS.includes(on)) {
    issues.push(
      `target.pick '${pick}' scans every enemy on each '${on}' event; use 'nearest' here, ` +
        'or move the effect to a periodic trigger',
    );
  }
  if (pick === 'mostStacks' && target.ailment === undefined) {
    issues.push("target.pick 'mostStacks' needs target.ailment (burn, poison or shock)");
  }
  if (pick !== 'mostStacks' && target.ailment !== undefined) {
    issues.push("target.ailment only applies to pick 'mostStacks'");
  }
  if (target.range !== undefined && !(target.range > 0)) {
    issues.push(`target.range must be > 0 (got ${target.range})`);
  }
  if (target.excludeEventTarget === true && TARGETLESS_EVENTS.has(on)) {
    issues.push(`target.excludeEventTarget needs the event's enemy, which '${on}' events have not`);
  }
  return issues;
}

/**
 * Ranges of one conversion: a share of the hit above 0, and tags a hit can carry, so no kind
 * besides hit (only hits convert; src/sim/combat/convert.ts).
 */
function conversionIssues(conversion: ConversionSpec): string[] {
  const issues: string[] = [];
  if (!(conversion.fraction > 0)) issues.push(`fraction must be > 0 (got ${conversion.fraction})`);
  const tags = conversion.tags;
  if (tags === undefined) return issues;
  if (tags.length === 0 || new Set(tags).size !== tags.length) {
    issues.push('tags must be unique and not empty; omit the field instead');
  }
  for (const tag of tags) {
    if ((TAG[tag] & DOT_MASK) !== 0) {
      issues.push(`tag '${tag}' is a damage-over-time kind, and only hits convert`);
    }
  }
  return issues;
}

/**
 * Parameter ranges of one effect, and whether it can run on events `on` for a trigger with the
 * target selector `target`, if any.
 */
function effectIssues(
  effect: EffectSpec,
  on: TriggerEventId,
  target: TargetSelector | undefined,
): string[] {
  const issues: string[] = [];
  const positive = (name: string, value: number | undefined): void => {
    if (value !== undefined && !(value > 0)) issues.push(`${name} must be > 0 (got ${value})`);
  };
  const nonNegative = (name: string, value: number | undefined): void => {
    if (value !== undefined && !(value >= 0)) issues.push(`${name} must be >= 0 (got ${value})`);
  };
  const count = (name: string, value: number | undefined): void => {
    if (value !== undefined && !isPositiveInt(value)) {
      issues.push(`${name} must be a positive integer (got ${value})`);
    }
  };
  const delivery = (tags: readonly string[] | undefined): void => {
    if (tags === undefined) return;
    if (tags.length === 0 || new Set(tags).size !== tags.length) {
      issues.push('tags must be unique and not empty; omit the field instead');
    }
    for (const tag of tags) {
      if ((TAG[tag as keyof typeof TAG] & DELIVERY_MASK) === 0) {
        issues.push(`tag '${tag}' is not an owner or geometry tag`);
      }
    }
  };
  // The event's enemy: none on targetless events, gone once a kill or shatter trigger's
  // effects run (a kill's transfers run at the kill, before it is gone; a shatter's never do),
  // and gone by the time a contact trigger's effects run, since a touching enemy leaks or dies
  // at its touch. A selector's enemy takes its place, alive when it is picked; a 'player' pick
  // gives none.
  const needsTarget =
    ((effect.kind === 'applyAilment' || effect.kind === 'addFrost') &&
      effect.radius === undefined) ||
    effect.kind === 'spreadAilment';
  if (needsTarget && target !== undefined) {
    if (target.pick === 'player') {
      issues.push(`${effect.kind} needs an enemy, which target.pick 'player' does not give`);
    }
  } else if (needsTarget && TARGETLESS_EVENTS.has(on)) {
    issues.push(`${effect.kind} needs the event's enemy, which '${on}' events have not`);
  } else if (needsTarget && on === 'contact') {
    issues.push(`${effect.kind} needs the event's enemy, which has left by the time it runs`);
  } else if (needsTarget && effect.kind !== 'spreadAilment' && DEAD_EVENTS.includes(on)) {
    issues.push(`${effect.kind} needs a radius on '${on}' events, whose enemy is dead`);
  } else if (needsTarget && on === 'shatter') {
    issues.push(`${effect.kind} needs the event's enemy, which is gone when '${on}' triggers run`);
  }
  switch (effect.kind) {
    case 'applyAilment':
      count('stacks', effect.stacks);
      nonNegative('damagePct', effect.damagePct);
      positive('radius', effect.radius);
      count('maxTargets', effect.maxTargets);
      if (effect.maxTargets !== undefined && effect.radius === undefined) {
        issues.push('maxTargets needs a radius');
      }
      if (effect.order !== undefined && effect.radius === undefined) {
        issues.push(orderIssue(effect.order));
      }
      break;
    case 'spreadAilment':
      positive('radius', effect.radius);
      if (effect.effect !== undefined && !(effect.effect >= 0 && effect.effect <= 1)) {
        issues.push(`effect must be in [0, 1] (got ${effect.effect})`);
      }
      if (effect.ailment === 'poison') {
        if (effect.stacks !== undefined && !(effect.stacks > 0 && effect.stacks <= 1)) {
          issues.push(`stacks must be in (0, 1] (got ${effect.stacks})`);
        }
        count('maxTargets', effect.maxTargets);
      }
      break;
    case 'explode':
      positive('radius', effect.radius);
      nonNegative('damagePct', effect.damagePct);
      count('maxTargets', effect.maxTargets);
      delivery(effect.tags);
      break;
    case 'nova':
      positive('radius', effect.radius);
      nonNegative('damagePct', effect.damagePct);
      delivery(effect.tags);
      break;
    case 'push':
      positive('distance', effect.distance);
      positive('radius', effect.radius);
      break;
    case 'addFrost':
      positive('amount', effect.amount);
      positive('radius', effect.radius);
      count('maxTargets', effect.maxTargets);
      if (effect.maxTargets !== undefined && effect.radius === undefined) {
        issues.push('maxTargets needs a radius');
      }
      if (effect.order !== undefined && effect.radius === undefined) {
        issues.push(orderIssue(effect.order));
      }
      break;
    case 'heal':
      positive('lifePct', effect.lifePct);
      break;
    case 'gainShards':
      positive('fraction', effect.fraction);
      // It reads the dying enemy's drop.
      if (!KILL_EVENTS.includes(on)) issues.push(`gainShards only runs on kill events (on ${on})`);
      break;
    case 'groundZone':
      issues.push(...groundZoneIssues(effect));
      delivery(effect.tags);
      break;
  }
  return issues;
}

/** Zone radii a groundZone accepts, in arena units. */
const ZONE_RADIUS_MIN = 1;
const ZONE_RADIUS_MAX = 400;
/** The strongest slow a groundZone may apply. */
const ZONE_SLOW_MAX = 0.9;

/**
 * Ranges of a groundZone: a radius in [1, 400], at least one pulse (0.25 s), a hit of 0 or more,
 * ailment terms only with an ailment, a slow in (0, 0.9], and something to do.
 */
function groundZoneIssues(effect: Extract<EffectSpec, { kind: 'groundZone' }>): string[] {
  const issues: string[] = [];
  const { radius, durationSec, damagePctPerSec, slow } = effect;
  if (!(radius >= ZONE_RADIUS_MIN && radius <= ZONE_RADIUS_MAX)) {
    issues.push(`radius must be in [${ZONE_RADIUS_MIN}, ${ZONE_RADIUS_MAX}] (got ${radius})`);
  }
  if (!(durationSec >= 0.25)) {
    issues.push(`durationSec must be >= 0.25, one pulse (got ${durationSec})`);
  }
  // The schema requires it too; data checked without the schema can still omit it.
  if ((damagePctPerSec as number | undefined) === undefined) {
    issues.push('damagePctPerSec is required; use 0 for a zone that only applies its status terms');
  } else if (!(damagePctPerSec >= 0)) {
    issues.push(`damagePctPerSec must be >= 0 (got ${damagePctPerSec})`);
  }
  if (effect.ailmentStacks !== undefined && !isPositiveInt(effect.ailmentStacks)) {
    issues.push(`ailmentStacks must be a positive integer (got ${effect.ailmentStacks})`);
  }
  if (effect.ailmentDamagePct !== undefined && !(effect.ailmentDamagePct > 0)) {
    issues.push(`ailmentDamagePct must be > 0 (got ${effect.ailmentDamagePct})`);
  }
  if (
    effect.ailment === undefined &&
    (effect.ailmentStacks !== undefined || effect.ailmentDamagePct !== undefined)
  ) {
    issues.push('ailmentStacks and ailmentDamagePct need ailment');
  }
  if (effect.addFrostPerSec !== undefined && !(effect.addFrostPerSec > 0)) {
    issues.push(`addFrostPerSec must be > 0 (got ${effect.addFrostPerSec})`);
  }
  if (slow !== undefined && !(slow > 0 && slow <= ZONE_SLOW_MAX)) {
    issues.push(`slow must be in (0, ${ZONE_SLOW_MAX}] (got ${slow})`);
  }
  if (
    damagePctPerSec === 0 &&
    effect.ailment === undefined &&
    effect.addFrostPerSec === undefined &&
    slow === undefined
  ) {
    issues.push(
      'groundZone does nothing: give it damagePctPerSec > 0, ailment, addFrostPerSec or slow',
    );
  }
  return issues;
}

/** The damage modifiers a rule's module adds (src/sim/rules/), for the ★ check below. */
function ruleDamageModifiers(rule: RuleSpec): Modifier[] {
  switch (rule.id) {
    case 'overload':
      return rule.chainMore === undefined
        ? []
        : [{ stat: 'damage', kind: 'more', value: rule.chainMore, tags: ['chain', 'hit'] }];
    case 'glassCannon':
      return [{ stat: 'damage', kind: 'more', value: rule.damageMore }];
    case 'steadyAim':
    case 'eternalFlame':
      return [];
  }
}

/**
 * The archetype rule of an outer board's ★ (docs/v3/game-design-v3.md §2.2): on a keystone of
 * board 'outer.<o>', every damage modifier that adds damage (value > 0), those its rules add
 * included, carries one of the board's archetype tags (ARCHETYPE_TAGS) or is scoped to
 * 'outer.<o>'. Costs (value < 0) and every other node are exempt. Content validation runs it
 * from the fusion generator step on; until then it is checked on fixtures only.
 */
export function starArchetypeIssues(node: TalentNode): string[] {
  const source = sourceOfNode(node.id);
  if (node.kind !== 'keystone' || !source.startsWith('outer.')) return [];
  const board = source.slice('outer.'.length) as keyof typeof ARCHETYPE_TAGS;
  const tags = ARCHETYPE_TAGS[board] ?? [];
  const damage = [...node.modifiers, ...node.rules.flatMap(ruleDamageModifiers)];
  return damage
    .filter((mod) => mod.stat === 'damage' && mod.value > 0)
    .filter((mod) => mod.scope !== source && !tags.some((tag) => mod.tags?.includes(tag)))
    .map(
      (mod) =>
        `talent '${node.id}': ★ damage modifier ${JSON.stringify(mod)} needs a tag of ` +
        `${source} (${tags.join(', ') || 'none'}) or scope '${source}'`,
    );
}
