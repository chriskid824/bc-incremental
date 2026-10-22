/**
 * The text checks of the v3 web as one function (docs/v3 C6 design §4.8, S-3), for the tests,
 * the viewer and `npm run content`: V17 (every key the content needs in both locales, no orphan
 * or TODO key, the same placeholders, a hand description's numbers), V19 (every node's text and
 * every outer's preview card filled in both locales) and V20 (gd §5.4's 44 fusion names, the
 * titles' lengths and uniqueness). Each message takes D23's form.
 */

import {
  mentions,
  modifierNumbers,
  percent,
  quotedNumbers,
  triggerNumbers,
} from '../../data/ruleNumbers';
import { RULE_COEF_FIELDS, scaleRuleSpec } from '../../data/rules';
import type { RuleSpec } from '../../data/rules';
import { CHARACTER_IDS, OUTER_IDS } from '../../data/sources';
import type { CharacterId, OuterId } from '../../data/sources';
import { isBehaviourModifier } from '../../data/stats';
import type { Modifier } from '../../data/stats';
import { COEF_FIELDS } from '../../data/triggers';
import type { Condition, EffectSpec, TriggerSpec } from '../../data/triggers';
import { MAIN_BRANCH, nearestName, parseNodeId } from '../../data/web/ids';
import { NAMED_KINDS } from '../../data/web/types';
import type { AssembledWeb, BoardStatus, FusionKey, WebNode } from '../../data/web/types';
import { LOCALES, MESSAGES } from '../../i18n';
import type { Locale } from '../../i18n';
import { emptyProgress } from '../../meta/web';
import { CHAIN_JUMP_CHANCE } from '../../sim/effects/types';
import { previewCard } from './card';
import type { PreviewCard } from './card';
import { fusionKeyOf, fusionName } from './names';
import { coreBonus, describeNode, messageLookup } from './text';
import type { CoreBonus, TextLookup } from './text';

/** The file of each locale's web keys, as the messages name it. */
const FILE: Readonly<Record<Locale, string>> = {
  en: 'src/i18n/web.en.json',
  'zh-TW': 'src/i18n/web.zh-TW.json',
};

/** gd §5.4's 44 zh-TW fusion names (V20), by character and outer. */
export const GD_FUSION_NAMES: {
  readonly [C in CharacterId]: Readonly<Record<Exclude<OuterId, C>, string>>;
} = {
  fire: {
    poison: '火毒',
    bleed: '火血',
    lightning: '火雷',
    combo: '火連',
    crit: '火暴',
    ice: '火冰',
    aura: '火光',
    thorns: '火棘',
    summon: '火靈',
    barrage: '火彈',
    greed: '火金',
  },
  ice: {
    fire: '冰火',
    poison: '冰毒',
    bleed: '冰血',
    lightning: '冰雷',
    combo: '冰連',
    crit: '冰暴',
    aura: '冰光',
    thorns: '冰棘',
    summon: '冰靈',
    barrage: '冰彈',
    greed: '冰金',
  },
  lightning: {
    fire: '雷火',
    poison: '雷毒',
    bleed: '雷血',
    combo: '雷連',
    crit: '雷暴',
    ice: '雷冰',
    aura: '雷光',
    thorns: '雷棘',
    summon: '雷靈',
    barrage: '雷彈',
    greed: '雷金',
  },
  summon: {
    fire: '火召喚',
    poison: '毒召喚',
    bleed: '血召喚',
    lightning: '雷召喚',
    combo: '連擊召喚',
    crit: '暴擊召喚',
    ice: '冰召喚',
    aura: '光環召喚',
    thorns: '荊棘召喚',
    barrage: '彈幕召喚',
    greed: '貪婪召喚',
  },
};

const placeholders = (template: string): string[] =>
  [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string))].sort();
const braced = (names: readonly string[]): string =>
  names.length === 0 ? 'none' : names.map((name) => `{${name}}`).join(', ');

function listText(items: readonly string[], conjunction: 'and' | 'or' = 'and'): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1] as string}`;
}

const isCharacterId = (id: string | undefined): id is CharacterId =>
  (CHARACTER_IDS as readonly (string | undefined)[]).includes(id);
const isOuterId = (id: string | undefined): id is OuterId =>
  (OUTER_IDS as readonly (string | undefined)[]).includes(id);
const outerOf = (key: FusionKey): OuterId => key.split('.')[1] as OuterId;

const missing = (key: string, locale: Locale): string =>
  `key '${key}' is missing in ${FILE[locale]}; npm run content -- --stubs writes a TODO stub for each missing key`;

// V17: keys.

/** A node whose description is hand-written: a ★, an ascendancy final, a hand core, a rule's node. */
function needsDesc(web: AssembledWeb, node: WebNode): boolean {
  if (node.kind === 'keystone' || node.kind === 'ascFinal' || node.effects.rules.length > 0) {
    return true;
  }
  return node.kind === 'core' && web.fusions.get(outerOf(fusionKeyOf(node.board)))?.kind === 'hand';
}

/**
 * The content keys `web` needs (§4.7): the character's name and intro, every outer's name, each
 * ascendancy's and each fusion's title, every named node's name, every description, and each
 * branch's and hub group's name.
 */
function neededKeys(web: AssembledWeb): string[] {
  const keys: string[] = [web.def.nameKey, web.def.introKey];
  for (const board of web.boards) {
    if (board.kind === 'outer') keys.push(`web.outer.${board.id.slice('outer.'.length)}.name`);
  }
  for (const ascendancy of web.def.ascendancies ?? []) {
    keys.push(`web.asc.${web.character}.${ascendancy.slug}.name`);
  }
  for (const fusion of web.fusions.values()) keys.push(`web.fusion.${fusion.key}.title`);
  for (const node of web.nodes) {
    if (NAMED_KINDS.includes(node.kind)) keys.push(`web.node.${node.id}.name`);
    if (needsDesc(web, node)) keys.push(`web.node.${node.id}.desc`);
    const parsed = parseNodeId(node.id);
    if (
      (parsed?.block === 'center' || parsed?.block === 'outer') &&
      parsed.branch !== MAIN_BRANCH
    ) {
      keys.push(`web.branch.${parsed.board}.${parsed.branch}`);
    }
    if (parsed?.block === 'hub') keys.push(`web.branch.hub.${parsed.group}`);
  }
  return keys;
}

/**
 * Why a `web.node.*` or `web.fusion.*` key is an orphan, or null (D13), by its board
 * (`fusion.<c>.<o>` for a title): its id does not parse or its suffix is not `name` or `desc`
 * (`title` for a fusion); on a board some web holds open, it names a node missing there, or a
 * ranked, mastery, core or 強化∞ node, which text.ts names; else its board is one some web lists
 * as absent (the hub or an outer the content does not hold, and that outer's fusion), or a
 * center, ascendancy or fusion board of a given web's character that no web lists. A key on a
 * board the webs list only as locked, or that no web lists and no given character owns, is left
 * to the webs that hold it.
 */
function orphanCheck(webs: readonly AssembledWeb[]): (key: string) => string | null {
  const listed = new Map<string, Set<BoardStatus>>();
  const characters = new Set<CharacterId>(webs.map((web) => web.character));
  const nodes = new Map<string, WebNode>();
  const valid: string[] = [];
  for (const web of webs) {
    for (const board of web.boards) {
      const statuses = listed.get(board.id) ?? new Set<BoardStatus>();
      statuses.add(board.status);
      listed.set(board.id, statuses);
    }
    for (const node of web.nodes) {
      nodes.set(node.id, node);
      valid.push(`web.node.${node.id}.desc`);
      if (NAMED_KINDS.includes(node.kind)) valid.push(`web.node.${node.id}.name`);
    }
    for (const fusion of web.fusions.values()) valid.push(`web.fusion.${fusion.key}.title`);
  }
  const nowhere = (key: string): string => {
    const near = nearestName(key, valid);
    return `names no node or fusion of the content; ${near === null ? 'remove it' : `did you mean '${near}'?`}`;
  };
  /** How a key on `board` (`owner`'s, or null for the hub's and an outer's) is judged. */
  const judge = (board: string, owner: CharacterId | null): 'node' | 'orphan' | 'left' => {
    const statuses = listed.get(board);
    if (statuses?.has('open') === true) return 'node';
    if (statuses?.has('absent') === true) return 'orphan';
    if (statuses !== undefined) return 'left';
    return owner !== null && characters.has(owner) ? 'orphan' : 'left';
  };
  return (key) => {
    if (key.startsWith('web.node.')) {
      const rest = key.slice('web.node.'.length);
      const dot = rest.lastIndexOf('.');
      const id = rest.slice(0, Math.max(dot, 0));
      const suffix = rest.slice(dot + 1);
      const parsed = dot < 0 ? null : parseNodeId(id);
      if (parsed === null || (suffix !== 'name' && suffix !== 'desc')) return nowhere(key);
      const owner = parsed.block === 'hub' || parsed.block === 'outer' ? null : parsed.character;
      const judged = judge(parsed.board, owner);
      if (judged !== 'node') return judged === 'orphan' ? nowhere(key) : null;
      const node = nodes.get(id);
      if (node === undefined) return nowhere(key);
      if (suffix === 'name' && !NAMED_KINDS.includes(node.kind)) {
        return `node '${id}' is a ${node.kind} node, which text.ts names; remove it`;
      }
      return null;
    }
    if (key.startsWith('web.fusion.')) {
      const [c, o, suffix, ...rest] = key.slice('web.fusion.'.length).split('.');
      const formed =
        isCharacterId(c) &&
        isOuterId(o) &&
        (c as string) !== o &&
        suffix === 'title' &&
        rest.length === 0;
      if (!formed) return nowhere(key);
      return judge(`fusion.${c}.${o}`, c) === 'orphan' ? nowhere(key) : null;
    }
    return null;
  };
}

// V17: a hand description's numbers.

/** One number a description quotes: its accepted spellings, and the coef-scaled field it is. */
interface Quoted {
  readonly spellings: readonly string[];
  /** The field a fusion's coef scales, or null for a literal. */
  readonly field: string | null;
  /** Its spellings at the fusion's coef. */
  readonly scaled: readonly string[];
}

const same = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a !== undefined && b !== undefined && a.join('\n') === b.join('\n');

/**
 * `base`'s entries, each owned by the first of `probes` whose moved spec changes it: the field
 * each number stands for, found by moving one field at a time (+0.37) and listing again.
 */
function owners(
  base: readonly (readonly string[])[],
  probes: readonly (readonly [field: string, moved: readonly (readonly string[])[]])[],
): (string | null)[] {
  return base.map((spellings, i) => {
    for (const [field, moved] of probes) {
      if (moved.length === base.length && !same(moved[i], spellings)) return field;
    }
    return null;
  });
}

const NUDGE = 0.37;

/** The present, nonzero number fields of `spec` that `fields` names. */
function numberFields(spec: object, fields: readonly string[]): [string, number][] {
  const values = spec as Record<string, unknown>;
  return fields.flatMap((field): [string, number][] => {
    const value = values[field];
    return typeof value === 'number' && value !== 0 ? [[field, value]] : [];
  });
}

function ruleQuoted(rule: RuleSpec, coef: number, onFusion: boolean): Quoted[] {
  const base = quotedNumbers(rule);
  const scaled = quotedNumbers(onFusion ? scaleRuleSpec(rule, coef, RULE_COEF_FIELDS) : rule);
  const fields = onFusion ? Object.keys(RULE_COEF_FIELDS[rule.id] ?? {}) : [];
  const probes = numberFields(rule, fields).map(
    ([field, value]) =>
      [field, quotedNumbers({ ...rule, [field]: value + NUDGE } as RuleSpec)] as const,
  );
  return owners(base, probes).map((field, i) => ({
    spellings: base[i] as string[],
    field,
    scaled: scaled[i] ?? [],
  }));
}

/** `trigger` as a fusion board compiles it at `coef`: its chances and present COEF fields scaled. */
function scaledTrigger(trigger: TriggerSpec, coef: number): TriggerSpec {
  const when = trigger.when?.map((c): Condition =>
    'chance' in c ? { chance: Math.min(1, c.chance * coef) } : c,
  );
  const effects = trigger.do.map((effect) => {
    const scaled: Record<string, unknown> = { ...effect };
    for (const [field, value] of numberFields(effect, COEF_FIELDS[effect.kind])) {
      scaled[field] = value * coef;
    }
    return scaled as unknown as EffectSpec;
  });
  return when === undefined ? { ...trigger, do: effects } : { ...trigger, when, do: effects };
}

/**
 * A trigger's numbers: triggerNumbers', each owned by the field the coef scales on a fusion board
 * (a chance condition's chance, a present COEF field), and there a chainJump trigger's chance with
 * no chance condition, CHAIN_JUMP_CHANCE, as the field `chance` (D11), which triggerNumbers does
 * not list (M1's ruleText.test.ts reads it).
 */
function triggerQuoted(trigger: TriggerSpec, coef: number, onFusion: boolean): Quoted[] {
  const jump: Quoted[] =
    onFusion && trigger.on === 'chainJump' && !(trigger.when ?? []).some((c) => 'chance' in c)
      ? [
          {
            spellings: [percent(CHAIN_JUMP_CHANCE)],
            field: 'chance',
            scaled: [percent(Math.min(1, CHAIN_JUMP_CHANCE * coef))],
          },
        ]
      : [];
  const base = triggerNumbers(trigger);
  const scaled = triggerNumbers(onFusion ? scaledTrigger(trigger, coef) : trigger);
  const probes: (readonly [string, readonly (readonly string[])[]])[] = [];
  if (onFusion) {
    const when = trigger.when ?? [];
    when.forEach((condition, at) => {
      if (!('chance' in condition)) return;
      const moved = when.map((c, i) => (i === at ? { chance: condition.chance + NUDGE } : c));
      probes.push(['chance', triggerNumbers({ ...trigger, when: moved })]);
    });
    trigger.do.forEach((effect, at) => {
      for (const [field, value] of numberFields(effect, COEF_FIELDS[effect.kind])) {
        const moved = trigger.do.map((e, i) =>
          i === at ? ({ ...e, [field]: value + NUDGE } as EffectSpec) : e,
        );
        probes.push([field, triggerNumbers({ ...trigger, do: moved })]);
      }
    });
  }
  return [
    ...jump,
    ...owners(base, probes).map((field, i) => ({
      spellings: base[i] as string[],
      field,
      scaled: scaled[i] ?? [],
    })),
  ];
}

/**
 * A behaviour modifier's numbers, literals; but `bonus`'s modifier, a template core's bonus that
 * the coef scales (coefScalesBonus, Q2 (A)), is the field `bonus`, spelled at its template's value
 * and at the run's (D12).
 */
function modifierQuoted(mod: Modifier, bonus: CoreBonus | null): Quoted[] {
  if (mod !== bonus?.mod) {
    return modifierNumbers(mod).map((spellings) => ({ spellings, field: null, scaled: spellings }));
  }
  const scaled = modifierNumbers(mod);
  return modifierNumbers({ ...mod, value: bonus.value }).map((spellings, i) => ({
    spellings,
    field: 'bonus',
    scaled: scaled[i] ?? [],
  }));
}

/**
 * The numbers `node`'s description must quote (src/data/ruleText.test.ts's, on a web node): its
 * rules', triggers' and behaviour modifiers'. On a fusion board the ones its coef scales are
 * fields, written as placeholders: a rule's RULE_COEF_FIELDS, a chance condition's chance,
 * chainJump's chance (D11), the COEF fields the data sets, and a template core's bonus under
 * coefScalesBonus (D12; without it the bonus never moves and is quoted as a literal). The chance
 * of a trigger that is not chainJump and has no chance condition, under coef 1, is not asked
 * for: describeNode writes it in a line of its own after the description.
 */
function nodeQuoted(web: AssembledWeb, node: WebNode): Quoted[] {
  const onFusion = node.board.startsWith('fusion.');
  const fusion = onFusion ? web.fusions.get(outerOf(fusionKeyOf(node.board))) : undefined;
  const coef = fusion?.coef ?? 1;
  const bonus = fusion?.coefScalesBonus === true ? coreBonus(fusion, node) : null;
  return [
    ...node.effects.rules.flatMap((rule) => ruleQuoted(rule, coef, onFusion)),
    ...node.effects.triggers.flatMap((trigger) => triggerQuoted(trigger, coef, onFusion)),
    ...node.effects.modifiers
      .filter(isBehaviourModifier)
      .flatMap((mod) => modifierQuoted(mod, bonus)),
  ];
}

function numberIssues(
  web: AssembledWeb,
  node: WebNode,
  key: string,
  locale: Locale,
  text: string,
): string[] {
  const at = `key '${key}' (${FILE[locale]})`;
  const issues: string[] = [];
  for (const { spellings, field, scaled } of nodeQuoted(web, node)) {
    if (field === null) {
      if (!spellings.some((token) => mentions(text, token))) {
        issues.push(
          `${at}: does not quote ${listText(spellings, 'or')}; a hand description quotes every number of its node's rules, triggers and behaviour modifiers`,
        );
      }
      continue;
    }
    const literal = [...spellings, ...scaled].find((token) => mentions(text, token));
    if (literal !== undefined) {
      issues.push(
        `${at}: quotes ${literal}, which the fusion's coef scales; write {${field}} in its place`,
      );
    } else if (!text.includes(`{${field}}`)) {
      issues.push(
        `${at}: lacks {${field}}, which the fusion's coef scales; write it where the number goes`,
      );
    }
  }
  return issues;
}

function keyIssues(
  webs: readonly AssembledWeb[],
  lookups: Readonly<Record<Locale, TextLookup>>,
): string[] {
  const issues: string[] = [];
  const needed = new Set(webs.flatMap(neededKeys));
  for (const locale of LOCALES) {
    for (const key of needed) if (!lookups[locale].has(key)) issues.push(missing(key, locale));
  }
  const orphan = orphanCheck(webs);
  const webKeys = new Set(
    LOCALES.flatMap((locale) => [...lookups[locale].keys()]).filter((key) =>
      key.startsWith('web.'),
    ),
  );
  for (const key of [...webKeys].sort()) {
    const held = LOCALES.filter((locale) => lookups[locale].has(key));
    const why = orphan(key);
    if (why !== null) {
      for (const locale of held) issues.push(`key '${key}' (${FILE[locale]}): ${why}`);
      continue;
    }
    if (held.length < LOCALES.length) {
      if (!needed.has(key)) {
        for (const locale of LOCALES) if (!held.includes(locale)) issues.push(missing(key, locale));
      }
      continue;
    }
    for (const locale of LOCALES) {
      if (/\bTODO\b/.test(lookups[locale].get(key))) {
        issues.push(`key '${key}' (${FILE[locale]}): the text is a TODO stub; write it`);
      }
    }
    const en = placeholders(lookups.en.get(key));
    for (const locale of LOCALES) {
      const own = placeholders(lookups[locale].get(key));
      if (own.join() !== en.join()) {
        issues.push(
          `key '${key}' (${FILE[locale]}): placeholders ${braced(own)} differ from en's ${braced(en)}; use the same placeholders in both locales`,
        );
      }
    }
  }
  for (const web of webs) {
    for (const node of web.nodes) {
      const key = `web.node.${node.id}.desc`;
      for (const locale of LOCALES) {
        if (lookups[locale].has(key)) {
          issues.push(...numberIssues(web, node, key, locale, lookups[locale].get(key)));
        }
      }
    }
  }
  return issues;
}

// V19: every text filled.

type Recorded = { readonly lookup: TextLookup; readonly records: [key: string, text: string][] };

/** `lookup` with every `get` recorded, so a fault is traced to the first key whose text holds it. */
function recording(lookup: TextLookup): Recorded {
  const records: [string, string][] = [];
  return {
    records,
    lookup: {
      has: lookup.has,
      keys: lookup.keys,
      get: (key, values) => {
        const text = lookup.get(key, values);
        records.push([key, text]);
        return text;
      },
    },
  };
}

/** Each fault of `texts` (an unfilled placeholder, undefined, NaN, Infinity, an empty text) with its key. */
function faults(texts: readonly string[], records: Recorded['records']): string[] {
  const found: string[] = [];
  const keyOf = (test: (text: string) => boolean): string =>
    records.find(([, text]) => test(text))?.[0] ?? "the node's keys";
  for (const text of texts) {
    if (text.trim() === '') {
      found.push(`an empty line; check ${keyOf((t) => t.trim() === '')}`);
      continue;
    }
    const hole = /\{[^{}]*\}?/.exec(text)?.[0];
    if (hole !== undefined)
      found.push(`an unfilled ${hole}; check ${keyOf((t) => t.includes(hole))}`);
    const bad = /\b(?:undefined|NaN|Infinity)\b/.exec(text)?.[0];
    if (bad !== undefined) {
      found.push(`'${bad}'; check ${keyOf((t) => new RegExp(`\\b${bad}\\b`).test(t))}`);
    }
  }
  return found;
}

const cardTexts = (card: PreviewCard): string[] => [
  card.outer,
  ...card.entry,
  ...(card.fusion === null ? [] : [card.fusion.name, card.fusion.title, ...card.fusion.rule]),
  ...card.covers.answer,
  ...card.covers.helps,
];

function fillIssues(
  webs: readonly AssembledWeb[],
  lookups: Readonly<Record<Locale, TextLookup>>,
): string[] {
  const issues: string[] = [];
  for (const web of webs) {
    for (const locale of LOCALES) {
      for (const node of web.nodes) {
        const { lookup, records } = recording(lookups[locale]);
        const text = describeNode(web, node.id, 1, lookup);
        for (const fault of faults([text.name, text.kind, ...text.lines], records)) {
          issues.push(`node '${node.id}' (${locale}): the text has ${fault}`);
        }
      }
      for (const board of web.boards) {
        if (board.kind !== 'outer') continue;
        const outer = board.id.slice('outer.'.length) as OuterId;
        const { lookup, records } = recording(lookups[locale]);
        const card = previewCard(web, emptyProgress(web.character), outer, lookup);
        for (const fault of faults(cardTexts(card), records)) {
          issues.push(
            `outer '${outer}' (character '${web.character}', ${locale}): the preview card has ${fault}`,
          );
        }
      }
    }
  }
  return issues;
}

// V20: fusion names and titles.

/** The key whose text makes a fusion's zh-TW name (§4.7's rule). */
function nameKeys(key: FusionKey): string {
  const [c, o] = key.split('.') as [CharacterId, OuterId];
  if (c === 'summon') return `web.hivePrefix.${o}`;
  if (o === 'summon') return `web.abbr.${c}`;
  return `web.abbr.${c} and web.abbr.${o}`;
}

function nameIssues(
  webs: readonly AssembledWeb[],
  lookups: Readonly<Record<Locale, TextLookup>>,
): string[] {
  const issues: string[] = [];
  for (const web of webs) {
    const gd = GD_FUSION_NAMES[web.character] as Readonly<Partial<Record<OuterId, string>>>;
    for (const fusion of web.fusions.values()) {
      const name = fusionName(fusion.key, lookups['zh-TW']);
      const expected = gd[outerOf(fusion.key)];
      if (name !== expected) {
        issues.push(
          `fusion '${fusion.key}': name '${name}', gd §5.4 says '${expected ?? 'nothing'}'; check ${nameKeys(fusion.key)}`,
        );
      }
      if (fusionName(fusion.key, lookups.en).trim() === '') {
        issues.push(
          `fusion '${fusion.key}' (${FILE.en}): the English name is empty; check ${nameKeys(fusion.key)}`,
        );
      }
    }
    for (const locale of LOCALES) {
      const lookup = lookups[locale];
      const seen = new Map<string, FusionKey>();
      for (const fusion of web.fusions.values()) {
        const key = `web.fusion.${fusion.key}.title`;
        if (!lookup.has(key)) continue;
        const title = lookup.get(key);
        const at = `fusion '${fusion.key}' (${FILE[locale]})`;
        if (title.trim() === '') issues.push(`${at}: the title is empty; write it`);
        if (locale === 'zh-TW') {
          const length = [...title].length;
          const hand = fusion.kind === 'hand';
          if (hand ? length < 2 || length > 3 : length !== 2) {
            const rule = hand
              ? "a hand fusion's title has 2 or 3"
              : "a template fusion's title has 2";
            issues.push(`${at}: title '${title}' has ${length} characters; ${rule} (gd §5.1)`);
          }
        }
        const first = seen.get(title);
        if (first === undefined) seen.set(title, fusion.key);
        else {
          issues.push(
            `${at}: title '${title}' is also fusion '${first}''s; titles are unique per character`,
          );
        }
      }
    }
  }
  return issues;
}

/**
 * V17, V19 and V20 over `webs` (§4.8), each issue once: through `lookups`, by default each
 * locale's merged messages (F45: the tests pass the fixture's). Nothing here sets the locale.
 */
export function textIssues(
  webs: readonly AssembledWeb[],
  lookups: Readonly<Record<Locale, TextLookup>> = {
    en: messageLookup(MESSAGES.en),
    'zh-TW': messageLookup(MESSAGES['zh-TW']),
  },
): string[] {
  return [
    ...new Set([
      ...keyIssues(webs, lookups),
      ...fillIssues(webs, lookups),
      ...nameIssues(webs, lookups),
    ]),
  ];
}
