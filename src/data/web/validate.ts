/**
 * Content validation of the v3 web (docs/v3 C6 design D23, §4.8): the load-time checks V1–V8,
 * V10–V14, V18 and V24, which loadContent() runs, and zodIssueText, which words a zod issue.
 * Every message reads `<subject> '<id>' (<file>): <problem>; <what to do>`, with the nearest
 * valid name for a misspelt one (nearestName); the checks extracted from M1's validation keep
 * M1's text after the subject and file (rule (a)), and the file follows from the board (rule
 * (c)). The messages are for content authors, not players: English literals, not i18n keys.
 */

import type { z } from 'zod';
import { bonusModifiers, HAND_PAIRS, templateOf } from '../fusion/generate';
import { TEMPLATE_RULE_OVERRIDES } from '../fusion/overrides';
import { coefRange, scalesDamage } from '../fusion/sensitivity';
import {
  CHARACTER_SIGNATURE,
  POLICY_RULES,
  RULE_COEF_FIELDS,
  SIGNATURE_EVENT,
  SIGNATURE_FORMS,
} from '../rules';
import type { SignatureId } from '../rules';
import { RuleSpecSchema } from '../schema';
import { CHARACTER_IDS, OUTER_IDS, SOURCE_CLASSES } from '../sources';
import type { CharacterId, OuterId } from '../sources';
import { CENTER_EVENTS, TRANSFER_EFFECTS } from '../triggers';
import { grantConflicts, nodeEffectIssues, starArchetypeIssues } from '../validate';
import { assembleWeb, scopeHolds } from './assemble';
import {
  ASC_SLOTS,
  FUSION_SLOTS,
  isSlug,
  MAIN_BRANCH,
  nearestName,
  parseNodeId,
  RESERVED_SLUGS,
} from './ids';
import type { HubGroupId } from './ids';
import {
  CalibrationEntrySchema,
  CharacterDefSchema,
  FusionOverrideSchema,
  HubDefSchema,
  OuterDefSchema,
} from './schema';
import { BATCH_COUNTS, batchOf, FULL_SCOPE, SCOPES } from './scope';
import { CENTER_STEPS, OUTER_STEPS, ROW_ENEMIES } from './types';
import type {
  AssembledWeb,
  BoardDef,
  CharacterDef,
  Content,
  FusionKey,
  FusionOverride,
  NodeSlot,
  OuterDef,
  WebBoard,
  WebNode,
  WebNodeKind,
  WebScope,
} from './types';

/** One problem with the content, for loadContent's ContentError and the viewer. */
export interface ContentIssue {
  /** The content file that holds it (§4.8 rule (c)); null for a web's or a scope's count. */
  readonly file: string | null;
  /** The node it is about, which the viewer draws it beside; null for a board, key or scope. */
  readonly node: string | null;
  readonly message: string;
}

export interface ValidateOptions {
  /** The scopes to assemble each built character in (default SCOPES). */
  readonly scopes?: readonly WebScope[];
  /** FIRST_PICK (src/data/characters/index.ts), which V4 checks against the registry. */
  readonly firstPick?: string;
}

type ZodIssue = z.core.$ZodIssue;
type Path = readonly PropertyKey[];

const CHARACTERS_FILE = 'src/data/characters/index.ts';
const OUTERS_FILE = 'src/data/outer/index.ts';
const HUB_FILE = 'src/data/hub.ts';
const OVERRIDES_FILE = 'src/data/fusion/overrides.ts';
const CALIBRATED_FILE = 'src/data/fusion/calibrated.ts';
const SCOPE_FILE = 'src/data/web/scope.ts';
const RULES_FILE = 'src/data/rules.ts';

const isCharacterId = (id: string): id is CharacterId =>
  (CHARACTER_IDS as readonly string[]).includes(id);
const isOuterId = (id: string): id is OuterId => (OUTER_IDS as readonly string[]).includes(id);

/** The 44 fusion keys: each character with each outer but its own. */
const FUSION_KEYS: readonly FusionKey[] = CHARACTER_IDS.flatMap((c) =>
  OUTER_IDS.filter((o) => o !== c).map((o): FusionKey => `${c}.${o}`),
);

/** The content file of a board (rule (c)): a center or ascendancy board is its character's. */
export function fileOfBoard(board: string): string {
  const [head, second] = board.split('.');
  if (board === 'hub') return HUB_FILE;
  if (head === 'outer') return `src/data/outer/${second ?? ''}.ts`;
  if (head === 'fusion') return OVERRIDES_FILE;
  return `src/data/characters/${head ?? ''}.ts`;
}

/** 'a' or 'an' before `noun`. */
const article = (noun: string): string => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

/** 'a', 'a and b', 'a, b and c' (or 'a, b or c'). */
function listText(items: readonly string[], conjunction: 'and' | 'or' = 'and'): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1] as string}`;
}
const quoted = (items: readonly string[]): string[] => items.map((item) => `'${item}'`);

/** A number as a message prints it, without float noise (0.5 × 2.1 = 1.05). */
const num = (value: number): string => String(Number(value.toPrecision(6)));

// zodIssueText (N-5, rule (b)).

/** A path as messages write it: keys joined by '.', indices in brackets (`modifiers[0].stat`). */
export function pathText(path: Path): string {
  let text = '';
  for (const key of path) {
    if (typeof key === 'number') text += `[${key}]`;
    else text += text === '' ? String(key) : `.${String(key)}`;
  }
  return text;
}

/** A path and the space after it, or nothing at the root. */
const before = (path: Path): string => (path.length === 0 ? '' : `${pathText(path)} `);

/** What a value under one of these keys is called; any other key names itself. */
const NOUNS: Readonly<Record<string, string>> = {
  on: 'event',
  centerEvent: 'event',
  targetHas: 'ailment',
  victimHas: 'ailment',
  killedBy: 'ailment',
  per: 'variable',
  answers: 'enemy',
  recommendedOuter: 'outer',
  revealAt15: 'outer',
};

/** The noun of the value at `path`: its key's, singular after an index (`tags[0]` a tag). */
function nounOf(path: Path): string {
  const last = path.length - 1;
  for (let i = last; i >= 0; i--) {
    const key = path[i];
    if (typeof key !== 'string') continue;
    return NOUNS[key] ?? (i < last && key.endsWith('s') ? key.slice(0, -1) : key);
  }
  return 'value';
}

/** A value as a message writes it: a string in quotes, anything else as JSON, cut at 60. */
function literal(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Every valid modifier scope (SourceSelector): a source class, an outer or a fusion. */
const SOURCE_SELECTORS: readonly string[] = [
  ...SOURCE_CLASSES,
  ...OUTER_IDS.map((o) => `outer.${o}`),
  ...FUSION_KEYS.map((key) => `fusion.${key}`),
];

/**
 * `<path> '<value>' is not a <noun>`, with the nearest candidate or the short list of them; a
 * value among numbers is `<path> <value> is not one of <list>`.
 */
function notOneOf(
  path: Path,
  value: unknown,
  candidates: readonly unknown[],
  noun = nounOf(path),
): string {
  const where = before(path);
  const few = candidates.length <= 8;
  const list = `one of ${listText(candidates.map(literal), 'or')}`;
  if (value === undefined) return `${pathText(path)} is missing${few ? `; write ${list}` : ''}`;
  if (candidates.some((candidate) => typeof candidate !== 'string')) {
    return `${where}${literal(value)} is not ${few ? list : article(noun)}`;
  }
  const nearest =
    typeof value === 'string' ? nearestName(value, candidates as readonly string[]) : null;
  const hint = nearest !== null ? `; did you mean '${nearest}'?` : few ? `; write ${list}` : '';
  return `${where}${literal(value)} is not ${article(noun)}${hint}`;
}

/** The branch of a union issue worth wording, or null when no branch stands out. */
function unionBranch(errors: readonly (readonly ZodIssue[])[]): readonly ZodIssue[] | null {
  const single = errors.find((branch) => branch.length === 1);
  if (single !== undefined) return single;
  const fewest = Math.min(...errors.map((branch) => branch.length));
  return errors.find((branch) => branch.length === fewest) ?? null;
}

/**
 * A zod issue in rule (b)'s words, behind `at` (`node '<id>' (<file>)`): `<path> '<value>' is
 * not a <stat, id or key>; did you mean '<nearestName>'?`. `keys` are the fields the object at
 * the issue's path allows, for an unknown key's nearest name; a union is worded by its branch
 * that fits best.
 */
export function zodIssueText(at: string, issue: ZodIssue, keys: readonly string[] = []): string {
  return `${at}: ${issueText(issue, keys)}`;
}

function issueText(issue: ZodIssue, keys: readonly string[]): string {
  const input = (issue as { readonly input?: unknown }).input;
  switch (issue.code) {
    case 'invalid_value':
      return notOneOf(issue.path, input, issue.values);
    case 'invalid_union': {
      const loose = issue as {
        readonly discriminator?: string;
        readonly options?: readonly unknown[];
      };
      if (loose.discriminator !== undefined) {
        const value = (input as Readonly<Record<string, unknown>> | undefined)?.[
          loose.discriminator
        ];
        return notOneOf(issue.path, value, loose.options ?? []);
      }
      // A field no branch knows: every branch reports it; the others' fields are the candidates.
      const unknown = issue.errors.map((branch) =>
        branch.find((inner) => inner.code === 'unrecognized_keys' && inner.path.length === 0),
      );
      if (issue.errors.length > 0 && unknown.every((inner) => inner !== undefined)) {
        const fields = issue.errors.flatMap((branch) =>
          branch.flatMap((inner) => (typeof inner.path[0] === 'string' ? [inner.path[0]] : [])),
        );
        const first = unknown[0] as ZodIssue & { readonly keys: readonly string[] };
        return issueText({ ...first, path: issue.path }, [...new Set(fields)]);
      }
      const branch = unionBranch(issue.errors);
      const inner = branch?.[0];
      if (inner === undefined) break;
      return issueText({ ...inner, path: [...issue.path, ...inner.path] } as ZodIssue, []);
    }
    case 'unrecognized_keys': {
      const where = before(issue.path);
      if (issue.keys.length !== 1) return `${where}${quoted(issue.keys).join(', ')} are not keys`;
      const key = issue.keys[0] as string;
      const nearest = nearestName(key, keys);
      return `${where}'${key}' is not a key${nearest === null ? '' : `; did you mean '${nearest}'?`}`;
    }
    case 'invalid_format':
      return `${before(issue.path)}${literal(input)} is not a valid ${nounOf(issue.path)}`;
    case 'invalid_type':
      return input === undefined
        ? `${pathText(issue.path)} is missing; write ${article(issue.expected)}`
        : `${before(issue.path)}${literal(input)} is not ${article(issue.expected)}`;
    case 'custom': {
      const key = issue.path[issue.path.length - 1];
      const nearest =
        (key === 'scope' || key === 'inZone') && typeof input === 'string'
          ? nearestName(input, SOURCE_SELECTORS)
          : null;
      const value = input === undefined ? '' : `${literal(input)} `;
      return `${before(issue.path)}${value}${issue.message}${nearest === null ? '' : `; did you mean '${nearest}'?`}`;
    }
    default:
      break;
  }
  const value = input === undefined || typeof input === 'object' ? '' : literal(input);
  const head = [pathText(issue.path), value].filter((part) => part !== '').join(' ');
  return `${head === '' ? '' : `${head}: `}${issue.message}`;
}

// Walking a schema for the fields an unknown key could have meant.

/** What the key walker reads of a zod 4 schema's definition. */
interface SchemaDef {
  readonly type: string;
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly element?: z.ZodType;
  readonly items?: readonly z.ZodType[];
  readonly valueType?: z.ZodType;
  readonly innerType?: z.ZodType;
  readonly in?: z.ZodType;
  readonly getter?: () => z.ZodType;
  readonly options?: readonly z.ZodType[];
  readonly values?: readonly unknown[];
}
const defOf = (schema: z.ZodType): SchemaDef => schema.def as unknown as SchemaDef;

/** `schema` without its optional, nullable, readonly, pipe and lazy wrappers. */
function bare(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const def = defOf(current);
    const inner = def.innerType ?? def.in ?? def.getter?.();
    if (inner === undefined) return current;
    current = inner;
  }
}

/** The object schemas `schema` can be for `value`: a union's members whose literals it fits. */
function objectsOf(schema: z.ZodType, value: unknown): z.ZodType[] {
  const plain = bare(schema);
  const def = defOf(plain);
  if (def.type === 'object') return [plain];
  if (def.type !== 'union') return [];
  const members = (def.options ?? []).flatMap((option) => objectsOf(option, value));
  const fields = (value ?? {}) as Readonly<Record<string, unknown>>;
  const fitting = members.filter((member) =>
    Object.entries(defOf(member).shape ?? {}).every(([key, field]) => {
      const own = defOf(bare(field));
      return own.type !== 'literal' || (own.values ?? []).includes(fields[key]);
    }),
  );
  return fitting.length > 0 ? fitting : members;
}

/** The schema `schema` has at `key` of `value`. */
function childOf(schema: z.ZodType, value: unknown, key: PropertyKey): z.ZodType | undefined {
  const plain = bare(schema);
  const def = defOf(plain);
  if (def.type === 'array') return def.element;
  if (def.type === 'tuple') return typeof key === 'number' ? def.items?.[key] : undefined;
  if (def.type === 'record') return def.valueType;
  return objectsOf(plain, value)
    .map((member) => defOf(member).shape?.[String(key)])
    .find((field) => field !== undefined);
}

/** The fields the object at `path` of `value` may have under `schema`. */
export function keysAt(schema: z.ZodType, value: unknown, path: Path): string[] {
  let current: z.ZodType | undefined = schema;
  let data = value;
  for (const key of path) {
    if (current === undefined) return [];
    current = childOf(current, data, key);
    data = (data as Readonly<Record<PropertyKey, unknown>> | undefined)?.[key];
  }
  if (current === undefined) return [];
  return [...new Set(objectsOf(current, data).flatMap((o) => Object.keys(defOf(o).shape ?? {})))];
}

// The boards a content writes, as the checks see them.

interface Board {
  readonly def: BoardDef;
  readonly kind: WebBoard['kind'];
  /** The board's subject and file: `center 'fire.center' (src/data/characters/fire.ts)`. */
  readonly at: string;
  readonly file: string;
  /** The board's id as its owner's builder names it. */
  readonly expectedId: string;
  /** An ascendancy's chain. */
  readonly chain: 0 | 1;
}

const nodeSubject = (node: WebNode, file: string): string => `node '${node.id}' (${file})`;

function centerBoard(def: CharacterDef, center: BoardDef): Board {
  const file = fileOfBoard(`${def.id}.center`);
  const id = `${def.id}.center`;
  return {
    def: center,
    kind: 'center',
    at: `center '${id}' (${file})`,
    file,
    expectedId: id,
    chain: 0,
  };
}

function ascendancyBoards(def: CharacterDef): Board[] {
  return (def.ascendancies ?? []).map((ascendancy, chain) => {
    const file = fileOfBoard(`${def.id}.asc`);
    const id = `${def.id}.asc.${ascendancy.slug}`;
    return {
      def: ascendancy.board,
      kind: 'asc',
      at: `ascendancy '${id}' (${file})`,
      file,
      expectedId: id,
      chain: chain === 1 ? 1 : 0,
    };
  });
}

function outerBoard(outer: OuterDef): Board {
  const file = fileOfBoard(`outer.${outer.id}`);
  return {
    def: outer.board,
    kind: 'outer',
    at: `outer '${outer.id}' (${file})`,
    file,
    expectedId: `outer.${outer.id}`,
    chain: 0,
  };
}

function hubBoard(board: BoardDef): Board {
  return {
    def: board,
    kind: 'hub',
    at: `hub 'hub' (${HUB_FILE})`,
    file: HUB_FILE,
    expectedId: 'hub',
    chain: 0,
  };
}

function fusionBoard(key: FusionKey, board: BoardDef): Board {
  return {
    def: board,
    kind: 'fusion',
    at: `fusion '${key}' (${OVERRIDES_FILE})`,
    file: OVERRIDES_FILE,
    expectedId: `fusion.${key}`,
    chain: 0,
  };
}

// V1: the schemas, then every node's effects and every board's grants.

/** The node a zod path leads into (`…nodes[i]…`), its subject, and the path inside its effects. */
function locate(
  value: unknown,
  path: Path,
  at: string,
  file: string,
): { readonly at: string; readonly node: string | null; readonly path: Path } {
  for (let i = path.length - 2; i >= 0; i--) {
    if (path[i] !== 'nodes' || typeof path[i + 1] !== 'number') continue;
    let node: unknown = value;
    for (const key of path.slice(0, i + 2)) {
      node = (node as Readonly<Record<PropertyKey, unknown>> | undefined)?.[key];
    }
    const id = (node as { readonly id?: unknown } | undefined)?.id;
    if (typeof id !== 'string') break;
    const inner = path.slice(i + 2);
    return {
      at: `node '${id}' (${file})`,
      node: id,
      path: inner[0] === 'effects' ? inner.slice(1) : inner,
    };
  }
  return { at, node: null, path };
}

function schemaIssues(content: Content): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const check = (schema: z.ZodType, value: unknown, at: string, file: string): void => {
    const parsed = schema.safeParse(value, { reportInput: true });
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      // An object with several unknown keys gets a nearest name for each.
      const split: ZodIssue[] =
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => ({ ...issue, keys: [key] }))
          : [issue];
      for (const one of split) {
        const where = locate(value, one.path, at, file);
        const keys = keysAt(schema, value, one.path);
        issues.push({
          file,
          node: where.node,
          message: zodIssueText(where.at, { ...one, path: [...where.path] } as ZodIssue, keys),
        });
      }
    }
  };
  for (const [key, def] of Object.entries(content.characters)) {
    const file = isCharacterId(key) ? fileOfBoard(`${key}.center`) : CHARACTERS_FILE;
    check(CharacterDefSchema, def, `character '${key}' (${file})`, file);
  }
  for (const [key, outer] of Object.entries(content.outers)) {
    const file = isOuterId(key) ? fileOfBoard(`outer.${key}`) : OUTERS_FILE;
    check(OuterDefSchema, outer, `outer '${key}' (${file})`, file);
  }
  if (content.hub !== null) check(HubDefSchema, content.hub, `hub 'hub' (${HUB_FILE})`, HUB_FILE);
  for (const [key, override] of Object.entries(content.overrides)) {
    check(FusionOverrideSchema, override, `override '${key}' (${OVERRIDES_FILE})`, OVERRIDES_FILE);
  }
  for (const [key, entry] of Object.entries(content.calibrated)) {
    check(CalibrationEntrySchema, entry, `fusion '${key}' (${CALIBRATED_FILE})`, CALIBRATED_FILE);
  }
  return issues;
}

/** V1 on a board: each node's effects (nodeEffectIssues) and its grants (grantConflicts). */
function effectIssues(board: Board): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const node of board.def.nodes) {
    for (const message of nodeEffectIssues(nodeSubject(node, board.file), node.effects)) {
      issues.push({ file: board.file, node: node.id, message });
    }
  }
  const granting = board.def.nodes.map((node) => ({
    id: node.id,
    emitters: node.effects.emitters,
  }));
  for (const message of grantConflicts(granting, board.at)) {
    issues.push({ file: board.file, node: null, message });
  }
  return issues;
}

// V2: ids, slugs and keys.

/** The parts of a node's id that are slugs, by its slot (D4). */
function slugParts(node: WebNode): (string | undefined)[] {
  const parts = node.id.split('.');
  const slot = node.slot;
  switch (slot.at) {
    case 'centerBranch':
      return ['a', 'b', 'c'].includes(slot.step) ? [parts[2], parts[3]] : [parts[2]];
    case 'centerEdge':
      return slot.clock === 2 || slot.clock === 10 ? [parts[3]] : [];
    case 'hubSpur':
      return HUB_TABLE[slot.clock]?.[1][1] === null ? [parts[2]] : [];
    case 'outerBranch':
      return slot.step === 'a' || slot.step === 'b' ? [parts[2], parts[3]] : [parts[2]];
    case 'outerEdge':
      return slot.place === 'threshold' ? [] : [parts[3]];
    case 'asc':
      return [parts[2]];
    default:
      return [];
  }
}

/** Why `slug` is not one, with the slug to write when one is near. */
function slugProblem(slug: string): string {
  if (RESERVED_SLUGS.includes(slug) || /^[rcn]\d+$/.test(slug)) {
    return `slug '${slug}' is a reserved word; pick another slug`;
  }
  const kebab = slug
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
  return isSlug(kebab)
    ? `slug '${slug}' is not kebab-case; write '${kebab}'`
    : `slug '${slug}' is not kebab-case; write lowercase English words joined by '-'`;
}

function idIssues(board: Board): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const push = (node: WebNode, problem: string): void => {
    issues.push({
      file: board.file,
      node: node.id,
      message: `${nodeSubject(node, board.file)}: ${problem}`,
    });
  };
  const seen = new Set<string>();
  for (const node of board.def.nodes) {
    if (seen.has(node.id))
      push(node, `the id is used twice on board '${board.def.id}'; give one of them another slug`);
    seen.add(node.id);
    const bad = slugParts(node).find((part) => part !== undefined && !isSlug(part));
    if (bad !== undefined) {
      push(node, slugProblem(bad));
      continue;
    }
    const parsed = parseNodeId(node.id);
    if (parsed === null) {
      push(node, "the id is outside D4's grammar; write the node through its board's template");
    } else if (parsed.board !== node.board || node.board !== board.def.id) {
      push(
        node,
        `the id names board '${parsed.board}', the node sits on '${board.def.id}'; write the node through its board's template`,
      );
    }
  }
  return issues;
}

/** V2 and V10's subject for a key of overrides, CALIBRATED or ACCEPTED_FAILS. */
interface KeyedEntry {
  readonly key: string;
  readonly subject: 'override' | 'fusion';
  readonly file: string;
}

function keyedEntries(content: Content): KeyedEntry[] {
  return [
    ...Object.keys(content.overrides).map((key) => ({
      key,
      subject: 'override' as const,
      file: OVERRIDES_FILE,
    })),
    ...Object.keys(content.calibrated).map((key) => ({
      key,
      subject: 'fusion' as const,
      file: CALIBRATED_FILE,
    })),
    ...Object.keys(content.acceptedFails).map((key) => ({
      key,
      subject: 'fusion' as const,
      file: OVERRIDES_FILE,
    })),
  ];
}

/** V2: each key names one of the 44 fusions, never a character with its own archetype. */
function keyIssues(entries: readonly KeyedEntry[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const { key, subject, file } of entries) {
    if ((FUSION_KEYS as readonly string[]).includes(key)) continue;
    const [c, o] = key.split('.');
    const message =
      c !== undefined && c === o && isCharacterId(c)
        ? `'${c}' is the character's own archetype, which has no fusion; remove the entry`
        : notOneOf([], key, FUSION_KEYS, 'fusion');
    issues.push({ file, node: null, message: `${subject} '${key}' (${file}): ${message}` });
  }
  return issues;
}

// V3: each board's shape.

/** D15's table (§4.4): per clock the ring node and its spur, as group, fixed name (null: a slug) and kind. */
const HUB_TABLE: readonly (readonly [
  readonly [HubGroupId, string | null, WebNodeKind],
  readonly [HubGroupId, string | null, WebNodeKind],
])[] = [
  [
    ['might', 'might', 'might'],
    ['rules', null, 'keystone'],
  ],
  [
    ['defense', 'r1', 'ranked'],
    ['defense', null, 'notable'],
  ],
  [
    ['defense', 'r2', 'ranked'],
    ['defense', null, 'notable'],
  ],
  [
    ['defense', 'r3', 'ranked'],
    ['defense', 'r5', 'ranked'],
  ],
  [
    ['defense', 'r4', 'ranked'],
    ['rules', null, 'keystone'],
  ],
  [
    ['economy', 'r1', 'ranked'],
    ['economy', null, 'notable'],
  ],
  [
    ['economy', 'r2', 'ranked'],
    ['economy', 'r4', 'ranked'],
  ],
  [
    ['economy', 'r3', 'ranked'],
    ['economy', null, 'notable'],
  ],
  [
    ['echo', 'r1', 'ranked'],
    ['echo', null, 'notable'],
  ],
  [
    ['echo', 'r2', 'ranked'],
    ['echo', null, 'notable'],
  ],
  [
    ['echo', 'r3', 'ranked'],
    ['echo', null, 'notable'],
  ],
  [
    ['echo', 'r4', 'ranked'],
    ['echo', null, 'notable'],
  ],
];

/** The template that writes each kind, for V3's what-to-do part. */
const TEMPLATES: Readonly<Record<WebNodeKind, string>> = {
  signature: 'signatureNode()',
  ranked: 'ranked(stat, perRank, ranks)',
  notable: 'notable(slug, effects)',
  threshold: 'threshold(effects)',
  keystone: 'keystone(slug, effects)',
  mastery: 'mastery(target?)',
  might: 'might()',
  entry: 'entry(effects)',
  core: 'the generated core',
  asc: 'ascNode(effects)',
  ascFinal: 'ascFinal(effects)',
};

/** One slot of a board's shape. */
interface Slot {
  readonly key: string;
  /** "branch 'spread' slot b"; `short` is "slot b". */
  readonly label: string;
  readonly short: string;
  readonly kind: WebNodeKind;
  /** The node's id, or with `slugged` the prefix a slug completes. */
  readonly id: string;
  readonly slugged: boolean;
  /** The center or outer branch it belongs to, for a missing branch. */
  readonly branch: number | null;
}

/** A slot's key: what places a node on its board (D17). */
function slotKey(slot: NodeSlot): string {
  switch (slot.at) {
    case 'centerBranch':
      return `branch:${slot.branch}:${slot.step}`;
    case 'outerBranch':
      return `branch:${slot.side === 1 ? 0 : 1}:${slot.step}`;
    case 'centerEdge':
    case 'hubRing':
    case 'hubSpur':
      return `${slot.at}:${slot.clock}`;
    case 'outerEdge':
      return `${slot.at}:${slot.place}`;
    case 'fusion':
      return `fusion:${slot.step}`;
    case 'asc':
      return `asc:${slot.chain}:${slot.step}`;
    default:
      return slot.at;
  }
}

const stepKind = (step: string): WebNodeKind =>
  step === 'mastery' ? 'mastery' : ['a', 'b', 'c'].includes(step) ? 'notable' : 'ranked';

/** The slots of `board`'s shape (§4.4's tables), in builder order. */
function shapeOf(board: Board): Slot[] {
  const b = board.def.id;
  const slot = (
    key: string,
    label: string,
    kind: WebNodeKind,
    id: string,
    slugged = false,
    branch: number | null = null,
    short = label,
  ): Slot => ({ key, label, short, kind, id, slugged, branch });
  const main = `${b}.${MAIN_BRANCH}.`;
  switch (board.kind) {
    case 'center':
      return [
        slot('signature', 'the signature', 'signature', `${main}signature`),
        ...[0, 1, 2].flatMap((i) => {
          const name = board.def.branches[i] ?? '';
          return CENTER_STEPS.map((step) => {
            const kind = stepKind(step);
            const id = `${b}.${name}.${kind === 'notable' ? '' : step}`;
            return slot(
              `branch:${i}:${step}`,
              `branch '${name}' slot ${step}`,
              kind,
              id,
              kind === 'notable',
              i,
              `slot ${step}`,
            );
          });
        }),
        ...[2, 10].map((clock) =>
          slot(`centerEdge:${clock}`, `the ★ at clock ${clock}`, 'keystone', main, true),
        ),
        slot('centerEdge:6', 'the threshold', 'threshold', `${main}threshold`),
        ...[1, 3, 5, 7, 9, 11].map((clock) => {
          const name = `c${(clock + 1) / 2}`;
          return slot(`centerEdge:${clock}`, `connector ${name}`, 'ranked', `${main}${name}`);
        }),
      ];
    case 'outer':
      return [
        slot('outerEntry', 'the entry', 'entry', `${main}entry`),
        ...[0, 1].flatMap((i) => {
          const name = board.def.branches[i] ?? '';
          return OUTER_STEPS.map((step) => {
            const kind = stepKind(step);
            const id = `${b}.${name}.${kind === 'notable' ? '' : step}`;
            return slot(
              `branch:${i}:${step}`,
              `branch '${name}' slot ${step}`,
              kind,
              id,
              kind === 'notable',
              i,
              `slot ${step}`,
            );
          });
        }),
        slot('outerEdge:answer', 'the answer ◆', 'notable', main, true),
        slot('outerEdge:keystone', 'the ★', 'keystone', main, true),
        slot('outerEdge:threshold', 'the threshold', 'threshold', `${main}threshold`),
      ];
    case 'hub':
      return HUB_TABLE.flatMap(([ring, spur], clock) =>
        (
          [
            ['hubRing', `ring slot ${clock}`, ring],
            ['hubSpur', `spur ${clock}`, spur],
          ] as const
        ).map(([at, label, [group, name, kind]]) =>
          slot(`${at}:${clock}`, label, kind, `hub.${group}.${name ?? ''}`, name === null),
        ),
      );
    case 'fusion':
      return FUSION_SLOTS.map((name, step) =>
        slot(
          `fusion:${step}`,
          `slot ${name}`,
          step === 0 ? 'core' : step === 4 ? 'mastery' : 'ranked',
          `${b}.${name}`,
        ),
      );
    case 'asc':
      return ASC_SLOTS.map((name, step) =>
        slot(
          `asc:${board.chain}:${step}`,
          `slot ${name}`,
          step === 2 ? 'ascFinal' : 'asc',
          `${b}.${name}`,
        ),
      );
  }
}

/** The edges of `board`'s shape between slot keys (§4.4's edges). */
function shapeEdges(board: Board): (readonly [string, string])[] {
  const edges: (readonly [string, string])[] = [];
  const chainOf = (keys: readonly string[]): void => {
    for (let i = 1; i < keys.length; i++) edges.push([keys[i - 1] as string, keys[i] as string]);
  };
  const edge = (clock: number): string => `centerEdge:${(clock + 12) % 12}`;
  switch (board.kind) {
    case 'center':
      [0, 1, 2].forEach((i) => {
        const s = (step: string): string => `branch:${i}:${step}`;
        chainOf(['signature', s('r1'), s('r2'), s('a'), s('r3'), s('r4'), s('b'), s('mastery')]);
        chainOf([s('a'), s('r5'), s('r6'), s('c'), s('mastery')]);
        edges.push([s('r3'), edge(4 * i + 1)], [s('r5'), edge(4 * i - 1)]);
      });
      for (const clock of [2, 10, 6])
        edges.push([edge(clock), edge(clock - 1)], [edge(clock), edge(clock + 1)]);
      return edges;
    case 'outer':
      [0, 1].forEach((i) => {
        const s = (step: string): string => `branch:${i}:${step}`;
        chainOf(['outerEntry', s('r1'), s('r2'), s('a'), s('r3'), s('r4'), s('mastery')]);
        chainOf([s('a'), s('b'), s('mastery')]);
        edges.push(['outerEdge:answer', s('b')]);
      });
      edges.push(
        ['outerEdge:keystone', 'outerEdge:answer'],
        ['outerEdge:threshold', 'outerEdge:answer'],
      );
      return edges;
    case 'hub':
      for (let clock = 0; clock < 12; clock++) {
        edges.push(
          [`hubRing:${clock}`, `hubRing:${(clock + 1) % 12}`],
          [`hubRing:${clock}`, `hubSpur:${clock}`],
        );
      }
      return edges;
    case 'fusion':
      chainOf(FUSION_SLOTS.map((_, step) => `fusion:${step}`));
      return edges;
    case 'asc':
      chainOf(ASC_SLOTS.map((_, step) => `asc:${board.chain}:${step}`));
      return edges;
  }
}

const RANKS_OF: Readonly<Partial<Record<WebNodeKind, string>>> = {
  ranked: '3–5',
  mastery: 'unlimited',
  might: 'unlimited',
};

function shapeIssues(board: Board): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const push = (problem: string, node: string | null = null): void => {
    issues.push({ file: board.file, node, message: `${board.at}: ${problem}` });
  };
  if (board.def.id !== board.expectedId) {
    push(`the board's id is '${board.def.id}'; it must be '${board.expectedId}'`);
  }
  const shape = shapeOf(board);
  const slots = new Map(shape.map((slot) => [slot.key, slot]));
  const held = new Map<string, WebNode>();
  for (const node of board.def.nodes) {
    const key = slotKey(node.slot);
    const slot = slots.get(key);
    const other = held.get(key);
    if (slot === undefined) {
      push(
        `'${node.id}' sits in no slot of the board; write it through the board's template`,
        node.id,
      );
    } else if (other !== undefined) {
      push(`${slot.label} holds '${other.id}' and '${node.id}'; a slot holds one node`, node.id);
    } else {
      held.set(key, node);
    }
  }
  const missing = new Set<number>();
  for (const slot of shape) {
    if (slot.branch === null || missing.has(slot.branch)) continue;
    if (shape.every((other) => other.branch !== slot.branch || !held.has(other.key))) {
      missing.add(slot.branch);
      const writer = board.kind === 'center' ? 'centerBranch' : 'outerBranch';
      const of = board.kind === 'center' ? 3 : 2;
      push(`branch ${slot.branch + 1} of ${of} is missing; write ${writer}(slug, slots)`);
    }
  }
  if (board.kind === 'asc' && held.size === 0) {
    push('the chain is empty; write ascendancy(slug, { n1, n2, final })');
    return issues;
  }
  for (const slot of shape) {
    const node = held.get(slot.key);
    if (node === undefined) {
      if (slot.branch === null || !missing.has(slot.branch)) {
        push(`${slot.label} is empty; ${slot.short} takes ${TEMPLATES[slot.kind]}`);
      }
      continue;
    }
    if (node.kind !== slot.kind) {
      push(
        `${slot.label} holds ${article(node.kind)} node; ${slot.short} takes ${TEMPLATES[slot.kind]}`,
        node.id,
      );
      continue;
    }
    const ranks = RANKS_OF[slot.kind] ?? '1';
    const fits =
      ranks === '3–5'
        ? node.ranks !== 1 && node.ranks !== 'unlimited'
        : String(node.ranks) === ranks;
    if (!fits)
      push(`${slot.label} has ${node.ranks} ranks; a ${slot.kind} node takes ${ranks}`, node.id);
    const named = slot.slugged
      ? node.id.startsWith(slot.id) && !node.id.slice(slot.id.length).includes('.')
      : node.id === slot.id;
    if (!named) {
      const wanted = slot.slugged ? `'${slot.id}<slug>'` : `'${slot.id}'`;
      push(`${slot.label} holds '${node.id}'; ${slot.short} takes ${wanted}`, node.id);
    }
  }
  // The written edges between the board's nodes equal the shape's (a hole's edges are dropped).
  const pair = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const expected = new Map<string, readonly [string, string]>();
  for (const [a, b] of shapeEdges(board)) {
    const from = held.get(a)?.id;
    const to = held.get(b)?.id;
    if (from !== undefined && to !== undefined) expected.set(pair(from, to), [from, to]);
  }
  const ids = new Set([...held.values()].map((node) => node.id));
  const written = new Map<string, readonly [string, string]>();
  for (const [a, b] of board.def.edges)
    if (ids.has(a) && ids.has(b)) written.set(pair(a, b), [a, b]);
  for (const [key, [a, b]] of expected) {
    if (!written.has(key)) push(`edge '${a}'–'${b}' is missing; the board's builder makes it`);
  }
  for (const [key, [a, b]] of written) {
    if (!expected.has(key))
      push(`edge '${a}'–'${b}' is not in the board's shape; edges come from its builder`);
  }
  return issues;
}

// V4: the registries and each character's derived fields.

function registryIssues(content: Content, firstPick: string | undefined): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const push = (file: string, message: string): void => {
    issues.push({ file, node: null, message });
  };
  const characters = content.characters as Readonly<Record<string, CharacterDef | undefined>>;
  for (const [key, def] of Object.entries(characters)) {
    if (def === undefined) continue;
    if (!isCharacterId(key)) {
      push(
        CHARACTERS_FILE,
        `character '${key}' (${CHARACTERS_FILE}): ${notOneOf([], key, CHARACTER_IDS, 'character')}`,
      );
    } else if (def.id !== key) {
      push(
        CHARACTERS_FILE,
        `character '${def.id}' (${CHARACTERS_FILE}): registered as '${key}'; the key must be the def's id`,
      );
    }
  }
  for (const c of CHARACTER_IDS) {
    if (characters[c] === undefined)
      push(
        CHARACTERS_FILE,
        `character '${c}' (${CHARACTERS_FILE}): not registered; add it to CHARACTERS`,
      );
  }
  if (firstPick !== undefined && characters[firstPick] === undefined) {
    const nearest = nearestName(firstPick, Object.keys(characters));
    push(
      CHARACTERS_FILE,
      `character '${firstPick}' (${CHARACTERS_FILE}): FIRST_PICK is not a registered character` +
        (nearest === null ? '; name one of CHARACTERS' : `; did you mean '${nearest}'?`),
    );
  }
  const constructs = new Map<string, string>();
  for (const def of Object.values(characters)) {
    if (def === undefined || !isCharacterId(def.id)) continue;
    const file = fileOfBoard(`${def.id}.center`);
    const at = `character '${def.id}' (${file})`;
    const signature = CHARACTER_SIGNATURE[def.id];
    const derived: readonly (readonly [string, unknown, unknown])[] = [
      ['archetype', def.archetype, def.id],
      ['nameKey', def.nameKey, `web.char.${def.id}.name`],
      ['introKey', def.introKey, `web.char.${def.id}.intro`],
      ['signature', def.signature, { id: signature }],
      ['centerEvent', def.centerEvent, SIGNATURE_EVENT[signature]],
      ['arena', def.arena, def.id],
    ];
    for (const [field, actual, wanted] of derived) {
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        push(
          file,
          `${at}: ${field} ${literal(actual)} is not its derivation ${literal(wanted)}; build the def with defineCharacter`,
        );
      }
    }
    for (const field of ['recommendedOuter', 'revealAt15'] as const) {
      const list = def[field];
      list.forEach((o, i) => {
        if (list.indexOf(o) !== i)
          push(file, `${at}: ${field} names '${o}' twice; name three different outers`);
      });
      if (list.includes(def.id)) {
        push(
          file,
          `${at}: ${field} names its own archetype '${def.id}'; its clock holds the ascendancies`,
        );
      }
    }
    for (const o of def.recommendedOuter) {
      if (def.revealAt15.includes(o))
        push(
          file,
          `${at}: '${o}' is in both recommendedOuter and revealAt15; reveal each outer once`,
        );
    }
    const other = constructs.get(def.construct);
    if (other !== undefined) {
      push(
        file,
        `${at}: construct '${def.construct}' is also '${other}''s; each character has its own construct`,
      );
    }
    constructs.set(def.construct, def.id);
  }
  const outers = content.outers as Readonly<Record<string, OuterDef | undefined>>;
  for (const [key, outer] of Object.entries(outers)) {
    if (outer === undefined) continue;
    if (!isOuterId(key)) {
      push(
        OUTERS_FILE,
        `outer '${key}' (${OUTERS_FILE}): ${notOneOf([], key, OUTER_IDS, 'outer')}`,
      );
    } else if (outer.id !== key) {
      push(
        OUTERS_FILE,
        `outer '${outer.id}' (${OUTERS_FILE}): registered as '${key}'; the key must be the def's id`,
      );
    }
  }
  return issues;
}

// V5, V6, V7, V8 and V12's scope rule: each written node's rules, ★, transfers and scopes.

/** The forms (SIGNATURE_FORMS) and the signature each belongs to. */
const FORM_OWNER = new Map<string, SignatureId>(
  (Object.entries(SIGNATURE_FORMS) as [SignatureId, readonly string[]][]).flatMap(
    ([signature, forms]) => forms.map((form) => [form, signature] as const),
  ),
);
const formsText = (signature: SignatureId): string =>
  SIGNATURE_FORMS[signature].length === 0 ? 'no form' : listText(SIGNATURE_FORMS[signature]);

/** V5: why form `form` cannot sit on `node` of `board`, or null when it may. */
function formProblem(form: string, node: WebNode, board: Board): string | null {
  const owner = FORM_OWNER.get(form) as SignatureId;
  const character = board.def.id.split('.')[0] ?? '';
  if (board.kind !== 'center' || !isCharacterId(character)) {
    return `form '${form}' is ${owner}'s; a form sits only on a center ◆ or ★ of a character whose signature takes it`;
  }
  const signature = CHARACTER_SIGNATURE[character];
  if (owner !== signature)
    return `form '${form}' is ${owner}'s; ${signature} takes ${formsText(signature)}`;
  if (node.kind !== 'notable' && node.kind !== 'keystone') {
    return `form '${form}' sits on ${article(node.kind)} node; a form takes a center ◆ or ★`;
  }
  return null;
}

/** Rules a node of this kind may hold besides forms (D8, F50): ★, cores, finals; a ◆ a chain policy. */
const holdsRule = (node: WebNode, rule: string): boolean =>
  node.kind === 'keystone' ||
  node.kind === 'core' ||
  node.kind === 'ascFinal' ||
  ((node.kind === 'notable' || node.kind === 'asc') &&
    (POLICY_RULES as readonly string[]).includes(rule));

/** Each transfer in `node`'s triggers with its effect (1 when left out). */
function transfers(node: WebNode): { readonly kind: string; readonly effect: number }[] {
  return node.effects.triggers.flatMap((trigger) =>
    trigger.do
      .filter((effect) => TRANSFER_EFFECTS.has(effect.kind))
      .map((effect) => ({
        kind: effect.kind,
        effect: (effect as { readonly effect?: number }).effect ?? 1,
      })),
  );
}

function nodeRuleIssues(board: Board): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const node of board.def.nodes) {
    const at = nodeSubject(node, board.file);
    const push = (problem: string): void => {
      issues.push({ file: board.file, node: node.id, message: `${at}: ${problem}` });
    };
    for (const rule of node.effects.rules) {
      if (FORM_OWNER.has(rule.id)) {
        const problem = formProblem(rule.id, node, board);
        if (problem !== null) push(problem);
      } else if (!holdsRule(node, rule.id)) {
        push(
          `rule '${rule.id}' sits on ${article(node.kind)} node; a rule takes a ★, a fusion core or an ` +
            'ascendancy final, or a ◆ when POLICY_RULES lists it',
        );
      }
    }
    if (board.kind === 'outer' && node.kind === 'keystone') {
      const star = {
        id: node.id,
        kind: node.kind,
        modifiers: node.effects.modifiers,
        rules: node.effects.rules,
      };
      for (const message of starArchetypeIssues(star, `keystone '${node.id}' (${board.file})`)) {
        issues.push({ file: board.file, node: node.id, message });
      }
    }
    if (board.kind !== 'fusion') {
      for (const { kind, effect } of transfers(node)) {
        if (effect >= 1)
          push(`${kind}.effect ${num(effect)} × coef 1 = ${num(effect)}; a transfer stays below 1`);
      }
      node.effects.modifiers.forEach((mod, i) => {
        if (mod.scope === 'fusion') {
          push(
            `modifiers[${i}] scope 'fusion' is for a fusion's ranks only; scope it to '${board.def.id === 'hub' ? 'hub' : board.def.id.startsWith('outer.') ? board.def.id : board.def.id.includes('.asc.') ? 'asc' : 'center'}'`,
          );
        }
      });
    }
  }
  return issues;
}

// V6, V11 and V12 on the overrides; V6 on RULE_COEF_FIELDS.

function overrideIssues(content: Content): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const [key, override] of Object.entries(content.overrides) as [
    string,
    FusionOverride | undefined,
  ][]) {
    if (override === undefined || !(FUSION_KEYS as readonly string[]).includes(key)) continue;
    const at = `override '${key}' (${OVERRIDES_FILE})`;
    const push = (problem: string): void => {
      issues.push({ file: OVERRIDES_FILE, node: null, message: `${at}: ${problem}` });
    };
    if (HAND_PAIRS.has(key as FusionKey)) {
      if (override.rule === undefined) push('a hand-made fusion needs its rule');
      for (const field of ['triggers', 'addTriggers', 'bonus', 'addRules'] as const) {
        if (override[field] !== undefined)
          push(`a hand-made fusion takes no ${field}; its rule is its core`);
      }
    } else {
      if (override.rule !== undefined) {
        push(
          "a template fusion takes no rule; its core is its outer's payload, which addRules extends on a TEMPLATE_RULE_OVERRIDES pair",
        );
      }
      if (
        override.addRules !== undefined &&
        !(TEMPLATE_RULE_OVERRIDES as readonly string[]).includes(key)
      ) {
        push(
          `addRules is only for TEMPLATE_RULE_OVERRIDES (${listText(quoted(TEMPLATE_RULE_OVERRIDES))}); write a trigger instead`,
        );
      }
    }
    for (const rule of [
      ...(override.rule === undefined ? [] : [override.rule]),
      ...(override.addRules ?? []),
    ]) {
      const owner = FORM_OWNER.get(rule.id);
      if (owner !== undefined) {
        push(
          `form '${rule.id}' is ${owner}'s; a form sits only on a center ◆ or ★ of a character whose signature takes it`,
        );
      }
    }
    (override.modifiers ?? []).forEach((mod, i) => {
      if (mod.scope === 'fusion')
        push(
          `modifiers[${i}] scope 'fusion' is for a fusion's ranks only; scope it to 'fusion.${key}'`,
        );
    });
  }
  return issues;
}

/** The number fields of rule `id`'s spec (RuleSpecSchema). */
function numberFields(id: string): string[] {
  const member = objectsOf(RuleSpecSchema, { id })[0];
  if (member === undefined) return [];
  return Object.entries(defOf(member).shape ?? {})
    .filter(([, field]) => defOf(bare(field)).type === 'number')
    .map(([name]) => name);
}

/** V6: a RULE_COEF_FIELDS entry names only number fields of its spec. */
function coefFieldIssues(): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const [id, entry] of Object.entries(RULE_COEF_FIELDS)) {
    const fields = numberFields(id);
    for (const field of Object.keys(entry ?? {})) {
      if (fields.includes(field)) continue;
      const nearest = nearestName(field, fields);
      issues.push({
        file: RULES_FILE,
        node: null,
        message:
          `rule '${id}' (${RULES_FILE}): RULE_COEF_FIELDS names '${field}', which is not a number field of its spec` +
          (nearest === null
            ? `; name one of ${listText(quoted(fields), 'or')}`
            : `; did you mean '${nearest}'?`),
      });
    }
  }
  return issues;
}

// V12 and V18 on an outer.

function payloadIssues(outer: OuterDef): ContentIssue[] {
  const file = fileOfBoard(`outer.${outer.id}`);
  const at = `outer '${outer.id}' (${file})`;
  const issues: ContentIssue[] = [];
  const push = (problem: string): void => {
    issues.push({ file, node: null, message: `${at}: ${problem}` });
  };
  const payload = outer.payload;
  if (payload === null) {
    if (!isCharacterId(outer.id))
      push('a template outer needs a payload; write its effects, bonus and ranks');
    return issues;
  }
  const effects = [...payload.effects, ...Object.values(payload.perEvent ?? {}).flat()];
  const bonus = payload.bonus;
  if (bonus?.form === 'status') {
    const fits = effects.some(
      (effect) =>
        (effect.kind === 'applyAilment' && effect.ailment === bonus.ailment) ||
        (effect.kind === 'addFrost' && bonus.ailment === 'frost'),
    );
    if (!fits)
      push(`bonus 'status' needs an applyAilment or addFrost of ${bonus.ailment} in the payload`);
  } else if (bonus?.form === 'inZone') {
    if (!effects.some((effect) => effect.kind === 'groundZone'))
      push("bonus 'inZone' needs a groundZone in the payload");
  } else if (bonus?.form === 'inPayload') {
    const fits = effects.some(
      (effect) =>
        ('critScale' in effect && effect.critScale !== undefined) ||
        ('tags' in effect &&
          (effect.tags as readonly string[] | undefined)?.includes('thorns') === true) ||
        effect.kind === 'projectiles',
    );
    if (!fits)
      push(
        "bonus 'inPayload' needs a critScale, a thorns tag or a projectile count in the payload",
      );
  }
  payload.effects.forEach((effect, i) => {
    if (
      (effect.kind === 'applyAilment' || effect.kind === 'addFrost') &&
      effect.radius !== undefined
    ) {
      push(
        `payload.effects[${i}] ${effect.kind} has a radius, which stops the engine's fan-out on explode and freeze; write it per event in perEvent`,
      );
    }
  });
  // The payload as each center event places it, which is what a template core holds. Under an
  // inZone bonus the core also holds the bonus's inZone modifier (bonusModifiers), which reads the
  // core's own zones, so a zone with no damage and no term passes as on the core (F24). The core's
  // other modifiers are V1's, on each assembled core.
  const placed = CENTER_EVENTS.map((event) => ({ on: event, do: templateOf(event, payload).do }));
  for (const trigger of placed) {
    const c = CHARACTER_IDS.find((id) => SIGNATURE_EVENT[CHARACTER_SIGNATURE[id]] === trigger.on);
    const modifiers =
      bonus?.form === 'inZone' && c !== undefined
        ? bonusModifiers(bonus, `fusion.${c}.${outer.id}`, 1)
        : [];
    const lists = { modifiers, triggers: [trigger], conversions: [], emitters: [], rules: [] };
    for (const message of nodeEffectIssues(`${at} on ${trigger.on}`, lists))
      issues.push({ file, node: null, message });
  }
  if (payload.coefScalesBonus === true) {
    const scaled = placed.flatMap((trigger) => trigger.do).find(scalesDamage);
    if (scaled !== undefined)
      push(`coefScalesBonus with a ${scaled.kind} the coef already scales; drop coefScalesBonus`);
    if (bonus?.form === 'scaling' && bonus.scaling.curve === 'powFactor') {
      push(
        'coefScalesBonus with a powFactor bonus, which the coef cannot scale; drop coefScalesBonus',
      );
    }
  }
  return issues;
}

/** The ✗ a character must answer on its center (gd:730): every one but 寶藏. */
const weakEnemies = (def: CharacterDef) =>
  ROW_ENEMIES.filter((enemy) => def.enemyRow[enemy] === 'weak');

function answerIssues(content: Content, built: readonly CharacterDef[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const def of built) {
    const file = fileOfBoard(`${def.id}.center`);
    const answered = new Set(def.center?.nodes.flatMap((node) => node.answers));
    for (const enemy of weakEnemies(def)) {
      if (enemy !== 'treasure' && !answered.has(enemy)) {
        issues.push({
          file,
          node: null,
          message: `character '${def.id}' (${file}): enemyRow marks '${enemy}' ✗ and no center node answers it; tag one with answers(spec, '${enemy}')`,
        });
      }
    }
  }
  const outers = Object.values(content.outers).filter(
    (outer): outer is OuterDef => outer !== undefined,
  );
  for (const outer of outers) {
    const file = fileOfBoard(`outer.${outer.id}`);
    const at = `outer '${outer.id}' (${file})`;
    const answered = new Set(outer.board.nodes.flatMap((node) => node.answers));
    for (const enemy of ROW_ENEMIES) {
      if (outer.covers[enemy] === 'answer' && !answered.has(enemy)) {
        issues.push({
          file,
          node: null,
          message: `${at}: covers marks '${enemy}' 'answer' and no node answers it; tag one with answers(spec, '${enemy}')`,
        });
      } else if (outer.covers[enemy] !== 'answer' && answered.has(enemy)) {
        issues.push({
          file,
          node: null,
          message: `${at}: a node answers '${enemy}', which covers does not mark 'answer'; mark it 'answer' in covers`,
        });
      }
    }
    const answer = outer.board.nodes.find(
      (node) => node.slot.at === 'outerEdge' && node.slot.place === 'answer',
    );
    if (answer !== undefined && answer.answers.length === 0) {
      issues.push({
        file,
        node: answer.id,
        message: `${at}: its answer ◆ '${answer.id}' answers no enemy; tag it with answers(spec, enemy)`,
      });
    }
  }
  // From B4, when every outer is registered: each ✗ is covered by 3 of the outers a character sees (gd:762).
  if (OUTER_IDS.every((o) => content.outers[o] !== undefined)) {
    for (const def of built) {
      const file = fileOfBoard(`${def.id}.center`);
      for (const enemy of weakEnemies(def)) {
        const covering = outers.filter(
          (outer) => outer.id !== def.id && outer.covers[enemy] !== undefined,
        );
        if (covering.length < 3) {
          issues.push({
            file,
            node: null,
            message:
              `character '${def.id}' (${file}): enemyRow marks '${enemy}' ✗ and ${covering.length} of the outers it sees cover it; ` +
              "gd:762 asks for 3, so mark it in more outers' covers",
          });
        }
      }
    }
  }
  return issues;
}

// V24: the scopes.

function scopeIssues(scopes: readonly WebScope[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const names = new Set<string>();
  for (const scope of scopes) {
    const at = `scope '${scope.name}' (${SCOPE_FILE})`;
    const push = (problem: string): void => {
      issues.push({ file: SCOPE_FILE, node: null, message: `${at}: ${problem}` });
    };
    if (names.has(scope.name)) push('another scope has this name; give each scope its own');
    names.add(scope.name);
    const lists: readonly (readonly [string, readonly string[] | 'all', readonly string[]])[] = [
      ['character', scope.characters, CHARACTER_IDS],
      ['outer', scope.outers, OUTER_IDS],
      ['fusion', scope.deferredFusions, FUSION_KEYS],
    ];
    for (const [noun, list, valid] of lists) {
      if (list === 'all') continue;
      for (const id of list) {
        if (valid.includes(id)) continue;
        const nearest = nearestName(id, valid);
        push(
          `${noun} '${id}' is not ${article(noun)}${nearest === null ? '' : `; did you mean '${nearest}'?`}`,
        );
      }
    }
  }
  return issues;
}

// The web checks: V1, V3 and V8 on fusions, V2's uniqueness, V6's one board per rule, V11, V13, V14.

function webIssues(content: Content, web: AssembledWeb): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const c = web.character;
  for (const [o, fusion] of web.fusions) {
    const key: FusionKey = `${c}.${o}`;
    const board = fusionBoard(key, fusion.board);
    issues.push(...effectIssues(board), ...shapeIssues(board));
    const range = coefRange(fusion);
    const coefs = [...new Set([fusion.coef, ...(range === null ? [] : [range[1]])])];
    for (const node of fusion.board.nodes) {
      for (const { kind, effect } of transfers(node)) {
        for (const coef of coefs) {
          if (effect * coef >= 1) {
            issues.push({
              file: OVERRIDES_FILE,
              node: node.id,
              message: `fusion '${key}' (${OVERRIDES_FILE}): ${kind}.effect ${num(effect)} × coef ${num(coef)} = ${num(effect * coef)}; a transfer stays below 1`,
            });
          }
        }
      }
    }
    if (fusion.kind === 'hand' && content.overrides[key]?.rule === undefined) {
      issues.push({
        file: OVERRIDES_FILE,
        node: null,
        message: `override '${key}' (${OVERRIDES_FILE}): a hand-made fusion needs its rule`,
      });
    }
  }
  const boardOf = new Map<string, string>();
  for (const node of web.nodes) {
    const first = boardOf.get(node.id);
    if (first !== undefined && first !== node.board) {
      const file = fileOfBoard(node.board);
      issues.push({
        file,
        node: node.id,
        message: `${nodeSubject(node, file)}: the id is on boards '${first}' and '${node.board}' in web '${c}'; give one of them another slug`,
      });
    }
    if (first === undefined) boardOf.set(node.id, node.board);
  }
  const ruleBoards = new Map<string, string[]>();
  for (const node of web.nodes) {
    for (const rule of node.effects.rules) {
      const boards = ruleBoards.get(rule.id) ?? [];
      if (!boards.includes(node.board)) boards.push(node.board);
      ruleBoards.set(rule.id, boards);
    }
  }
  for (const [rule, boards] of ruleBoards) {
    if (boards.length > 1) {
      issues.push({
        file: null,
        node: null,
        message: `rule '${rule}' (web '${c}'): on boards ${listText(quoted(boards))}; a rule id may sit on one board per web`,
      });
    }
  }
  // V13: every node reachable from the signature; every outer's entry without fusion nodes.
  const reach = (allowed: (node: WebNode) => boolean): Set<string> => {
    const reached = new Set<string>([web.root]);
    const queue = [web.root];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      for (const next of web.neighbours.get(id) ?? []) {
        const node = web.byId.get(next);
        if (node !== undefined && allowed(node) && !reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    return reached;
  };
  const reached = reach(() => true);
  const direct = reach((node) => !node.board.startsWith('fusion.'));
  for (const board of web.boards) {
    const lost = web.nodes.filter((node) => node.board === board.id && !reached.has(node.id));
    const first = lost[0];
    if (first === undefined) continue;
    const file = fileOfBoard(board.id);
    const subject =
      board.kind === 'outer'
        ? `outer '${board.id.slice('outer.'.length)}'`
        : board.kind === 'fusion'
          ? `fusion '${board.id.slice('fusion.'.length)}'`
          : board.kind === 'asc'
            ? `ascendancy '${board.id}'`
            : `${board.kind} '${board.id}'`;
    issues.push({
      file,
      node: first.id,
      message: `${subject} (${file}): ${lost.length === 1 ? '1 of its nodes is' : `${lost.length} of its nodes are`} not reachable from '${web.root}', '${first.id}' first; connect them through the board's edges and the hub`,
    });
  }
  for (const [o, outer] of web.outers) {
    const entry = outer.board.nodes.find((node) => node.slot.at === 'outerEntry');
    if (entry !== undefined && reached.has(entry.id) && !direct.has(entry.id)) {
      issues.push({
        file: null,
        node: entry.id,
        message: `outer '${o}': its entry '${entry.id}' is reachable only through fusion nodes`,
      });
    }
  }
  return issues;
}

/** gd §2.1's count of `c`'s web in `scope` over the registered blocks (V14). */
function formulaCount(content: Content, def: CharacterDef, scope: WebScope): number {
  const open = OUTER_IDS.filter(
    (o) => o !== def.id && scopeHolds(scope.outers, o) && content.outers[o] !== undefined,
  );
  const fusions = open.filter((o) => !scope.deferredFusions.includes(`${def.id}.${o}`));
  return (
    40 +
    (content.hub === null ? 0 : 24) +
    18 * open.length +
    5 * fusions.length +
    (def.ascendancies === null ? 0 : 2 * 3)
  );
}

/** gd §2.1's total over the blocks a scope's built characters see (V14). */
function formulaTotal(content: Content, built: readonly CharacterDef[], scope: WebScope): number {
  const seen = built.filter((def) => scopeHolds(scope.characters, def.id));
  if (seen.length === 0) return 0;
  const outers = OUTER_IDS.filter(
    (o) =>
      scopeHolds(scope.outers, o) &&
      content.outers[o] !== undefined &&
      seen.some((def) => def.id !== o),
  );
  const fusions = seen.flatMap((def) =>
    outers.filter((o) => o !== def.id && !scope.deferredFusions.includes(`${def.id}.${o}`)),
  );
  const ascendancies = seen.filter((def) => def.ascendancies !== null).length;
  return (
    40 * seen.length +
    (content.hub === null ? 0 : 24) +
    18 * outers.length +
    5 * fusions.length +
    6 * ascendancies
  );
}

function countIssues(
  content: Content,
  built: readonly CharacterDef[],
  scope: WebScope,
  webs: readonly AssembledWeb[],
): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const web of webs) {
    const wanted = formulaCount(content, web.def, scope);
    if (web.nodes.length !== wanted) {
      issues.push({
        file: null,
        node: null,
        message: `scope '${scope.name}': character '${web.character}' sees ${web.nodes.length} nodes; gd §2.1's formula over its blocks gives ${wanted}`,
      });
    }
  }
  const total = new Set(webs.flatMap((web) => web.nodes.map((node) => node.id))).size;
  const wanted = formulaTotal(content, built, scope);
  if (total !== wanted) {
    issues.push({
      file: null,
      node: null,
      message: `scope '${scope.name}': the webs hold ${total} nodes in all; gd §2.1's formula over the registered blocks gives ${wanted}`,
    });
  }
  return issues;
}

/** V14 with BATCH_COUNTS: the registered blocks' total, when they are a batch's (B-2). */
function batchIssues(content: Content, built: readonly CharacterDef[]): ContentIssue[] {
  const batch = batchOf({
    centers: built.map((def) => def.id),
    hub: content.hub !== null,
    outers: OUTER_IDS.filter((o) => content.outers[o] !== undefined),
    ascendancies: CHARACTER_IDS.filter(
      (c) => (content.characters[c]?.ascendancies ?? null) !== null,
    ),
  });
  if (batch === null) return [];
  const ids = new Set(
    built.flatMap((def) => assembleWeb(content, def.id, FULL_SCOPE).nodes.map((node) => node.id)),
  );
  if (ids.size === BATCH_COUNTS[batch]) return [];
  return [
    {
      file: null,
      node: null,
      message: `scope '${FULL_SCOPE.name}': the registered blocks are ${batch}'s, which BATCH_COUNTS counts ${BATCH_COUNTS[batch]}; the webs hold ${ids.size}`,
    },
  ];
}

/** V10: an override or calibration entry of a pair no scope assembles. */
function deadEntryIssues(
  content: Content,
  entries: readonly KeyedEntry[],
  assembled: ReadonlySet<string>,
): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const { key, subject, file } of entries) {
    if (assembled.has(key) || !(FUSION_KEYS as readonly string[]).includes(key)) continue;
    const [c, o] = key.split('.') as [CharacterId, OuterId];
    const problem =
      content.outers[o] === undefined
        ? `outer '${o}' is not registered; move it to the batch that adds ${o}`
        : (content.characters[c]?.center ?? null) === null
          ? `character '${c}' has no center yet; move it to the batch that writes ${c}'s center`
          : `no scope assembles fusion '${key}'; remove the entry or add the fusion to a scope`;
    issues.push({ file, node: null, message: `${subject} '${key}' (${file}): ${problem}` });
  }
  return issues;
}

/** Sorted by file (stable; issues without a file last), each once. */
function sortedIssues(issues: readonly ContentIssue[]): ContentIssue[] {
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const key = `${issue.file ?? ''}\n${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const order = (file: string | null): string => file ?? '￿';
  return unique
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) =>
      order(a.issue.file) < order(b.issue.file)
        ? -1
        : order(a.issue.file) > order(b.issue.file)
          ? 1
          : a.index - b.index,
    )
    .map(({ issue }) => issue);
}

/**
 * The load-time checks of §4.8 (V1–V8, V10–V14, V18, V24) over `content`, sorted by file. A
 * character whose center is null is checked by V1 and V4 only and assembles no web (N-6); every
 * other one is assembled in each scope that lists it. After a schema issue (V1's zod part) only
 * the schema issues and the scopes' are returned: the other checks read what the schemas check.
 */
export function contentIssues(content: Content, options: ValidateOptions = {}): ContentIssue[] {
  const scopes = options.scopes ?? SCOPES;
  const scoped = scopeIssues(scopes);
  const schema = schemaIssues(content);
  if (schema.length > 0) return sortedIssues([...schema, ...scoped]);
  const issues: ContentIssue[] = [...scoped, ...registryIssues(content, options.firstPick)];
  const characters = Object.values(
    content.characters as Readonly<Record<string, CharacterDef | undefined>>,
  ).filter((def): def is CharacterDef => def !== undefined && isCharacterId(def.id));
  const built = characters.filter((def) => def.center !== null);
  const boards: Board[] = [];
  for (const def of built) if (def.center !== null) boards.push(centerBoard(def, def.center));
  if (content.hub !== null) boards.push(hubBoard(content.hub.board));
  for (const outer of Object.values(content.outers))
    if (outer !== undefined) boards.push(outerBoard(outer));
  for (const def of built) boards.push(...ascendancyBoards(def));
  for (const board of boards) {
    issues.push(
      ...effectIssues(board),
      ...idIssues(board),
      ...shapeIssues(board),
      ...nodeRuleIssues(board),
    );
  }
  // A null-center character's ascendancies get V1 alone (N-6).
  for (const def of characters)
    if (def.center === null)
      for (const board of ascendancyBoards(def)) issues.push(...effectIssues(board));
  for (const outer of Object.values(content.outers))
    if (outer !== undefined) issues.push(...payloadIssues(outer));
  issues.push(...answerIssues(content, built));
  const entries = keyedEntries(content);
  issues.push(...keyIssues(entries), ...overrideIssues(content), ...coefFieldIssues());
  const assembled = new Set<string>();
  for (const scope of scopes) {
    const webs = built
      .filter((def) => scopeHolds(scope.characters, def.id))
      .map((def) => assembleWeb(content, def.id, scope));
    for (const web of webs) {
      for (const o of web.fusions.keys()) assembled.add(`${web.character}.${o}`);
      issues.push(...webIssues(content, web));
    }
    issues.push(...countIssues(content, built, scope, webs));
  }
  issues.push(...batchIssues(content, built), ...deadEntryIssues(content, entries, assembled));
  return sortedIssues(issues);
}
