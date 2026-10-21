/**
 * The v3 web's content templates (docs/v3 C6 design §3.3; implementation-plan-v3 impl:440): the
 * modifier helpers, the node templates and the board builders a content file calls. A content
 * file fills slots and names ◆, ★ and branches by slug; the builders name every node by the D4
 * grammar (src/data/web/ids.ts), place it in its slot and add the board's fixed edges (§4.4), so
 * no author writes an id, an edge or a position.
 *
 * Builders are hoisted function declarations (L8) and never throw. A slot holding the wrong
 * template is recorded as written, and a slot, branch or chain left out (a half-written file the
 * dev server runs unchecked) leaves its nodes out while the board keeps its edges: validation
 * reports both (V3).
 */

import { CHARACTER_SIGNATURE, SIGNATURE_EVENT } from './rules';
import { ARCHETYPE_TAGS } from './sources';
import type { CharacterId, OuterId, SourceSelector } from './sources';
import type { Modifier, ModifierKind, StatId } from './stats';
import type { DamageTag } from './tags';
import { ASC_SLOTS, HUB_GROUPS, MAIN_BRANCH, nodeId, sourceOfBoard } from './web/ids';
import type { HubGroupId } from './web/ids';
import { CENTER_STEPS, OUTER_STEPS } from './web/types';
import type {
  AscendancyDef,
  BoardDef,
  BoardId,
  CenterStep,
  CharacterDef,
  ConstructId,
  Covers,
  EnemyRow,
  HubDef,
  NodeEffects,
  NodeSlot,
  NodeSpec,
  OuterDef,
  OuterPayload,
  OuterStep,
  RankCount,
  RankSpec,
  Ranks,
  RowEnemy,
  Skin,
  WebNode,
  WebNodeKind,
} from './web/types';

export type Effects = Partial<NodeEffects>;
export type ModOpts = Pick<Modifier, 'tags' | 'notTags' | 'scope' | 'when' | 'scaling'>;
/** What a mastery's more applies to: damage carrying these tags, or credited to this scope. */
export interface MasteryTarget {
  readonly tags?: readonly DamageTag[];
  readonly scope?: SourceSelector;
}

// Modifier helpers.

export function flat(stat: StatId, value: number, opts?: ModOpts): Modifier {
  return { stat, kind: 'flat', value, ...opts };
}

export function inc(stat: StatId, value: number, opts?: ModOpts): Modifier {
  return { stat, kind: 'increased', value, ...opts };
}

export function more(stat: StatId, value: number, opts?: ModOpts): Modifier {
  return { stat, kind: 'more', value, ...opts };
}

// Node templates (impl:440, with §3.3's changes).

/** A node spec with TalentNode's five arrays in order, each empty unless given. */
function template<K extends WebNodeKind>(
  kind: K,
  slug: string | null,
  ranks: Ranks,
  effects: Effects,
): NodeSpec<K> {
  return {
    kind,
    slug,
    ranks,
    effects: {
      modifiers: effects.modifiers ?? [],
      triggers: effects.triggers ?? [],
      conversions: effects.conversions ?? [],
      emitters: effects.emitters ?? [],
      rules: effects.rules ?? [],
    },
    answers: [],
  };
}

/** One modifier a rank: `perRank` of `stat`, increased unless `kind` says otherwise. */
export function ranked(
  stat: StatId,
  perRank: number,
  ranks: RankCount,
  kind: ModifierKind = 'increased',
  opts?: ModOpts,
): NodeSpec<'ranked'> {
  return template('ranked', null, ranks, { modifiers: [{ stat, kind, value: perRank, ...opts }] });
}

/**
 * Several modifiers a rank; `once` grants emitters at rank 1 only (AMB37): a node's emitters
 * apply once whatever its rank (NodeEffects), so they go in as written, never once per rank.
 */
export function rankedMods(
  modifiers: readonly Modifier[],
  ranks: RankCount,
  once?: Pick<Effects, 'emitters'>,
): NodeSpec<'ranked'> {
  return template('ranked', null, ranks, { modifiers, emitters: once?.emitters ?? [] });
}

/** A ◆: 1 rank, named by its slug. */
export function notable(slug: string, effects: Effects): NodeSpec<'notable'> {
  return template('notable', slug, 1, effects);
}

/** Effects, which may hold a rule; a ★ that data expresses needs no module (F34). */
export function keystone(slug: string, effects: Effects): NodeSpec<'keystone'> {
  return template('keystone', slug, 1, effects);
}

export function threshold(effects: Effects): NodeSpec<'threshold'> {
  return template('threshold', null, 1, effects);
}

export function entry(effects: Effects): NodeSpec<'entry'> {
  return template('entry', null, 1, effects);
}

/**
 * ∞: more 0.04 damage a rank (gd:975); the builder fills the target by board when it is omitted
 * (F7, defaultMasteryTarget).
 */
export function mastery(target?: MasteryTarget): NodeSpec<'mastery'> {
  return template('mastery', null, 'unlimited', { modifiers: [more('damage', 0.04, target)] });
}

/** 強化∞: more 0.10 damage a rank, M1's (src/data/talents.ts:115-122). */
export function might(): NodeSpec<'might'> {
  return template('might', null, 'unlimited', { modifiers: [more('damage', 0.1)] });
}

/** The root, owned for free (D5). */
export function signatureNode(): NodeSpec<'signature'> {
  return template('signature', null, 1, {});
}

export function ascNode(effects: Effects): NodeSpec<'asc'> {
  return template('asc', null, 1, effects);
}

export function ascFinal(effects: Effects): NodeSpec<'ascFinal'> {
  return template('ascFinal', null, 1, effects);
}

/** The same node, marked as the answer to these enemies (V18); each enemy once. */
export function answers<K extends WebNodeKind>(
  spec: NodeSpec<K>,
  ...enemies: readonly [RowEnemy, ...RowEnemy[]]
): NodeSpec<K> {
  return { ...spec, answers: [...new Set([...spec.answers, ...enemies])] };
}

/** One of an outer's fusion ranked nodes; `scope: 'fusion'` is narrowed to the fusion by generate. */
export function fusionRank(modifiers: readonly Modifier[], ranks: RankCount): RankSpec {
  return { modifiers, ranks };
}

// Board builders.

export interface CenterBranchSlots {
  readonly r1: NodeSpec<'ranked'>;
  readonly r2: NodeSpec<'ranked'>;
  readonly a: NodeSpec<'notable'>;
  readonly r3: NodeSpec<'ranked'>;
  readonly r4: NodeSpec<'ranked'>;
  readonly b: NodeSpec<'notable'>;
  readonly r5: NodeSpec<'ranked'>;
  readonly r6: NodeSpec<'ranked'>;
  readonly c: NodeSpec<'notable'>;
  readonly mastery: NodeSpec<'mastery'>;
}
export interface CenterBranchSpec {
  readonly slug: string;
  readonly slots: CenterBranchSlots;
}
export function centerBranch(slug: string, slots: CenterBranchSlots): CenterBranchSpec {
  return { slug, slots };
}

export interface OuterBranchSlots {
  readonly r1: NodeSpec<'ranked'>;
  readonly r2: NodeSpec<'ranked'>;
  readonly a: NodeSpec<'notable'>;
  readonly r3: NodeSpec<'ranked'>;
  readonly r4: NodeSpec<'ranked'>;
  readonly b: NodeSpec<'notable'>;
  readonly mastery: NodeSpec<'mastery'>;
}
export interface OuterBranchSpec {
  readonly slug: string;
  readonly slots: OuterBranchSlots;
}
export function outerBranch(slug: string, slots: OuterBranchSlots): OuterBranchSpec {
  return { slug, slots };
}

export interface AscendancySpec {
  readonly slug: string;
  readonly n1: NodeSpec<'asc'>;
  readonly n2: NodeSpec<'asc'>;
  readonly final: NodeSpec<'ascFinal'>;
}
export function ascendancy(slug: string, nodes: Omit<AscendancySpec, 'slug'>): AscendancySpec {
  return { slug, n1: nodes.n1, n2: nodes.n2, final: nodes.final };
}

export interface CenterSpec {
  readonly signature: NodeSpec<'signature'>;
  /** At clocks 0, 4 and 8, in this order. */
  readonly branches: readonly [CenterBranchSpec, CenterBranchSpec, CenterBranchSpec];
  /** At clocks 2 and 10. */
  readonly keystones: readonly [NodeSpec<'keystone'>, NodeSpec<'keystone'>];
  /** At clock 6. */
  readonly threshold: NodeSpec<'threshold'>;
  /** c1 … c6 at clocks 1, 3, 5, 7, 9, 11. */
  readonly connectors: readonly [
    NodeSpec<'ranked'>,
    NodeSpec<'ranked'>,
    NodeSpec<'ranked'>,
    NodeSpec<'ranked'>,
    NodeSpec<'ranked'>,
    NodeSpec<'ranked'>,
  ];
}
/** What a character file writes: CharacterDef without the derived fields (D14). */
export interface CharacterSpec {
  readonly id: CharacterId;
  readonly color: number;
  readonly center: CenterSpec | null;
  readonly ascendancies: readonly [AscendancySpec, AscendancySpec] | null;
  readonly recommendedOuter: readonly [OuterId, OuterId, OuterId];
  readonly revealAt15: readonly [OuterId, OuterId, OuterId];
  readonly enemyRow: EnemyRow;
  readonly difficulty: 1 | 2;
  readonly construct: ConstructId;
  readonly defaultOrder: readonly string[];
}

/**
 * The character's def: its spec with the fields D14 derives from the id (engine F36): archetype
 * and arena (the id), the name and intro keys, the signature (CHARACTER_SIGNATURE) and its center
 * event (SIGNATURE_EVENT); the center and the ascendancies as boards, or null.
 */
export function defineCharacter(spec: CharacterSpec): CharacterDef {
  const { id } = spec;
  const signature = CHARACTER_SIGNATURE[id];
  const chains = spec.ascendancies;
  return {
    id,
    archetype: id,
    nameKey: `web.char.${id}.name`,
    introKey: `web.char.${id}.intro`,
    color: spec.color,
    signature: { id: signature },
    centerEvent: SIGNATURE_EVENT[signature],
    center: spec.center === null ? null : centerBoard(id, spec.center),
    ascendancies:
      chains === null ? null : [ascendancyDef(id, 0, chains[0]), ascendancyDef(id, 1, chains[1])],
    recommendedOuter: spec.recommendedOuter,
    revealAt15: spec.revealAt15,
    enemyRow: spec.enemyRow,
    difficulty: spec.difficulty,
    construct: spec.construct,
    arena: id,
    defaultOrder: spec.defaultOrder,
  };
}

export interface OuterSpec {
  readonly id: OuterId;
  readonly entry: NodeSpec<'entry'>;
  /** The clockwise branch first. */
  readonly branches: readonly [OuterBranchSpec, OuterBranchSpec];
  /** The answer ◆ (gd:249): a notable with answers (V18). */
  readonly answer: NodeSpec<'notable'>;
  readonly keystone: NodeSpec<'keystone'>;
  readonly threshold: NodeSpec<'threshold'>;
  readonly payload: OuterPayload | null;
  readonly skin: Skin;
  readonly covers: Covers;
}
export function defineOuter(spec: OuterSpec): OuterDef {
  return {
    id: spec.id,
    board: outerBoard(spec),
    payload: spec.payload,
    skin: spec.skin,
    covers: spec.covers,
  };
}

type Tuple<T, N extends number, A extends T[] = []> = A['length'] extends N
  ? A
  : Tuple<T, N, [...A, T]>;
export interface HubGroup<R extends number, N extends number> {
  readonly ranked: Readonly<Tuple<NodeSpec<'ranked'>, R>>;
  readonly notables: Readonly<Tuple<NodeSpec<'notable'>, N>>;
}
/** gd:262-268; the builder places every node by the fixed table of §4.4 (D15). */
export interface HubSpec {
  readonly might: NodeSpec<'might'>;
  readonly defense: HubGroup<5, 2>;
  readonly economy: HubGroup<4, 2>;
  readonly echo: HubGroup<4, 4>;
  readonly rules: { readonly keystones: readonly [NodeSpec<'keystone'>, NodeSpec<'keystone'>] };
}
export function defineHub(spec: HubSpec): HubDef {
  return { board: hubBoard(spec) };
}

/**
 * The target a mastery written without one takes on `board` (F7, AMB16, H9): scope 'center' on
 * the center; on an outer its archetype's tags (ARCHETYPE_TAGS), or scope 'outer.<o>' for an
 * outer with none (combo, barrage, greed); scope 'fusion.<c>.<o>' on a fusion.
 */
export function defaultMasteryTarget(board: BoardId): MasteryTarget {
  if (board.startsWith('outer.')) {
    const tags = ARCHETYPE_TAGS[board.slice('outer.'.length) as OuterId] ?? [];
    if (tags.length > 0) return { tags };
  }
  return { scope: sourceOfBoard(board) as SourceSelector };
}

/** `effects` with the board's target on each modifier written with neither tags nor a scope. */
function targeted(effects: NodeEffects, board: BoardId): NodeEffects {
  const target = defaultMasteryTarget(board);
  const modifiers = effects.modifiers.map((mod) =>
    (mod.tags?.length ?? 0) === 0 && mod.scope === undefined ? { ...mod, ...target } : mod,
  );
  return { ...effects, modifiers };
}

/** Records `spec` in `slot` as written; a mastery written without a target takes its board's. */
function put(
  nodes: WebNode[],
  board: BoardId,
  id: string,
  slot: NodeSlot,
  spec: NodeSpec | undefined,
): void {
  if (spec === undefined) return;
  nodes.push({
    id,
    kind: spec.kind,
    board,
    slot,
    ranks: spec.ranks,
    effects: spec.kind === 'mastery' ? targeted(spec.effects, board) : spec.effects,
    answers: spec.answers,
  });
}

/** The name of a slug-named slot: its node's slug, or `fallback` for a node without one. */
const slugOf = (spec: NodeSpec | undefined, fallback: string): string => spec?.slug ?? fallback;

type Edge = readonly [string, string];

/** The center's branch, ★ and threshold clocks (§4.4); connector c<i> sits at clock 2i − 1. */
const BRANCH_CLOCKS = [0, 4, 8] as const;
const KEYSTONE_CLOCKS = [2, 10] as const;
const THRESHOLD_CLOCK = 6;
/** The ◆ steps of a branch, named by slug; the other steps are slot names. */
const NOTABLE_STEPS: readonly string[] = ['a', 'b', 'c'];

/**
 * 40 nodes: the signature, three branches at clocks 0, 4 and 8, ★ at 2 and 10, the threshold at
 * 6 and connectors c1–c6 at 1, 3, 5, 7, 9 and 11. 45 edges: per branch signature–r1–r2–◆a,
 * ◆a–r3–r4–◆b–mastery and ◆a–r5–r6–◆c–mastery, with r3 to the connector at k + 1 and r5 to the
 * one at k − 1; each ★ and the threshold to the connectors either side of it (§4.4).
 */
function centerBoard(character: CharacterId, spec: CenterSpec): BoardDef {
  const board = `${character}.center` as const;
  const nodes: WebNode[] = [];
  const edges: Edge[] = [];
  const main = (name: string): string => nodeId(board, MAIN_BRANCH, name);
  const connector = (clock: number): string => main(`c${((((clock % 12) + 12) % 12) + 1) / 2}`);
  const root = main('signature');
  put(nodes, board, root, { at: 'signature' }, spec.signature);
  const branches: string[] = [];
  for (const index of [0, 1, 2] as const) {
    const branch: CenterBranchSpec | undefined = spec.branches?.[index];
    const slug = branch?.slug ?? '';
    const k = BRANCH_CLOCKS[index];
    const id = (step: CenterStep): string =>
      nodeId(board, slug, NOTABLE_STEPS.includes(step) ? slugOf(branch?.slots[step], step) : step);
    branches.push(slug);
    for (const step of CENTER_STEPS) {
      put(nodes, board, id(step), { at: 'centerBranch', branch: index, step }, branch?.slots[step]);
    }
    edges.push(
      [root, id('r1')],
      [id('r1'), id('r2')],
      [id('r2'), id('a')],
      [id('a'), id('r3')],
      [id('r3'), id('r4')],
      [id('r4'), id('b')],
      [id('b'), id('mastery')],
      [id('a'), id('r5')],
      [id('r5'), id('r6')],
      [id('r6'), id('c')],
      [id('c'), id('mastery')],
      [id('r3'), connector(k + 1)],
      [id('r5'), connector(k - 1)],
    );
  }
  KEYSTONE_CLOCKS.forEach((clock, index) => {
    const star: NodeSpec | undefined = spec.keystones?.[index];
    const id = main(slugOf(star, `keystone-${clock}`));
    put(nodes, board, id, { at: 'centerEdge', clock }, star);
    edges.push([id, connector(clock - 1)], [id, connector(clock + 1)]);
  });
  const gate = main('threshold');
  put(nodes, board, gate, { at: 'centerEdge', clock: THRESHOLD_CLOCK }, spec.threshold);
  edges.push([gate, connector(THRESHOLD_CLOCK - 1)], [gate, connector(THRESHOLD_CLOCK + 1)]);
  for (let index = 0; index < 6; index++) {
    const clock = 2 * index + 1;
    put(nodes, board, connector(clock), { at: 'centerEdge', clock }, spec.connectors?.[index]);
  }
  return { id: board, nodes, edges, branches };
}

/**
 * 18 nodes: the entry, the clockwise branch (side 1) and the other (side −1), the answer ◆, the
 * ★ and the threshold. 20 edges: per side entry–r1–r2–◆a–r3–r4–mastery and ◆a–◆b–mastery; the
 * answer to both ◆b; the ★ and the threshold to the answer (§4.4).
 */
function outerBoard(spec: OuterSpec): BoardDef {
  const board = `outer.${spec.id}` as const;
  const nodes: WebNode[] = [];
  const edges: Edge[] = [];
  const main = (name: string): string => nodeId(board, MAIN_BRANCH, name);
  const start = main('entry');
  const answer = main(slugOf(spec.answer, 'answer'));
  put(nodes, board, start, { at: 'outerEntry' }, spec.entry);
  const branches: string[] = [];
  const answered: Edge[] = [];
  ([1, -1] as const).forEach((side, index) => {
    const branch: OuterBranchSpec | undefined = spec.branches?.[index];
    const slug = branch?.slug ?? '';
    const id = (step: OuterStep): string =>
      nodeId(board, slug, NOTABLE_STEPS.includes(step) ? slugOf(branch?.slots[step], step) : step);
    branches.push(slug);
    for (const step of OUTER_STEPS) {
      put(nodes, board, id(step), { at: 'outerBranch', side, step }, branch?.slots[step]);
    }
    edges.push(
      [start, id('r1')],
      [id('r1'), id('r2')],
      [id('r2'), id('a')],
      [id('a'), id('r3')],
      [id('r3'), id('r4')],
      [id('r4'), id('mastery')],
      [id('a'), id('b')],
      [id('b'), id('mastery')],
    );
    answered.push([answer, id('b')]);
  });
  const star = main(slugOf(spec.keystone, 'keystone'));
  const gate = main('threshold');
  put(nodes, board, answer, { at: 'outerEdge', place: 'answer' }, spec.answer);
  put(nodes, board, star, { at: 'outerEdge', place: 'keystone' }, spec.keystone);
  put(nodes, board, gate, { at: 'outerEdge', place: 'threshold' }, spec.threshold);
  edges.push(...answered, [star, answer], [gate, answer]);
  return { id: board, nodes, edges, branches };
}

/** One slot of the hub's fixed table: its group, its node and the slot name of a slug-less one. */
interface HubSlot {
  readonly group: HubGroupId;
  readonly spec: NodeSpec | undefined;
  /** 'might' or r<n>; null for a ◆ or ★, which its slug names. */
  readonly name: string | null;
}

/**
 * 24 nodes on D15's fixed table (§4.4): a closed ring of 12, ring node h at clock h, and one spur
 * per ring node. 24 edges: the ring, then each spur to its ring node.
 */
function hubBoard(spec: HubSpec): BoardDef {
  const rankedAt = (
    group: HubGroupId,
    list: readonly NodeSpec[] | undefined,
    n: number,
  ): HubSlot => ({ group, spec: list?.[n - 1], name: `r${n}` });
  const sluggedAt = (
    group: HubGroupId,
    list: readonly NodeSpec[] | undefined,
    n: number,
  ): HubSlot => ({ group, spec: list?.[n - 1], name: null });
  const { defense, economy, echo, rules } = spec;
  // Per clock: the ring node, then its spur.
  const table: readonly (readonly [HubSlot, HubSlot])[] = [
    [{ group: 'might', spec: spec.might, name: 'might' }, sluggedAt('rules', rules?.keystones, 1)],
    [rankedAt('defense', defense?.ranked, 1), sluggedAt('defense', defense?.notables, 1)],
    [rankedAt('defense', defense?.ranked, 2), sluggedAt('defense', defense?.notables, 2)],
    [rankedAt('defense', defense?.ranked, 3), rankedAt('defense', defense?.ranked, 5)],
    [rankedAt('defense', defense?.ranked, 4), sluggedAt('rules', rules?.keystones, 2)],
    [rankedAt('economy', economy?.ranked, 1), sluggedAt('economy', economy?.notables, 1)],
    [rankedAt('economy', economy?.ranked, 2), rankedAt('economy', economy?.ranked, 4)],
    [rankedAt('economy', economy?.ranked, 3), sluggedAt('economy', economy?.notables, 2)],
    [rankedAt('echo', echo?.ranked, 1), sluggedAt('echo', echo?.notables, 1)],
    [rankedAt('echo', echo?.ranked, 2), sluggedAt('echo', echo?.notables, 2)],
    [rankedAt('echo', echo?.ranked, 3), sluggedAt('echo', echo?.notables, 3)],
    [rankedAt('echo', echo?.ranked, 4), sluggedAt('echo', echo?.notables, 4)],
  ];
  const nameOf = (slot: HubSlot, clock: number): string =>
    nodeId('hub', slot.group, slot.name ?? slugOf(slot.spec, `spur-${clock}`));
  const ring = table.map(([slot], clock) => nameOf(slot, clock));
  const spurs = table.map(([, slot], clock) => nameOf(slot, clock));
  const nodes: WebNode[] = [];
  table.forEach(([ringSlot, spurSlot], clock) => {
    put(nodes, 'hub', ring[clock] as string, { at: 'hubRing', clock }, ringSlot.spec);
    put(nodes, 'hub', spurs[clock] as string, { at: 'hubSpur', clock }, spurSlot.spec);
  });
  const edges: Edge[] = [
    ...ring.map((id, clock): Edge => [id, ring[(clock + 1) % ring.length] as string]),
    ...ring.map((id, clock): Edge => [id, spurs[clock] as string]),
  ];
  return { id: 'hub', nodes, edges, branches: [...HUB_GROUPS] };
}

/** An ascendancy's board `<c>.asc.<slug>`: n1–n2–final, chain 0 the first (§3.2). */
function ascendancyDef(
  character: CharacterId,
  chain: 0 | 1,
  spec: AscendancySpec | undefined,
): AscendancyDef {
  const slug = spec?.slug ?? '';
  const board = `${character}.asc.${slug}` as const;
  const [n1, n2, final] = ASC_SLOTS.map((slot) => nodeId(board, slot)) as [string, string, string];
  const nodes: WebNode[] = [];
  put(nodes, board, n1, { at: 'asc', chain, step: 0 }, spec?.n1);
  put(nodes, board, n2, { at: 'asc', chain, step: 1 }, spec?.n2);
  put(nodes, board, final, { at: 'asc', chain, step: 2 }, spec?.final);
  return {
    slug,
    board: {
      id: board,
      nodes,
      edges: [
        [n1, n2],
        [n2, final],
      ],
      branches: [],
    },
  };
}
