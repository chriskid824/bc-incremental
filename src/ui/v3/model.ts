/**
 * The web panel's view model (docs/v3/game-design-v3.md §2.3, §2.4, §3, §8): what each node, outer,
 * spoke and slot shows for a character's progress, read off src/meta/web's rules and
 * layoutWeb's positions. Pure: the panel (webPanel.ts) draws it and sends the clicks back through
 * the click plan (planClick) and the slot bar's refunds.
 */

import { formatNum } from '../../core/format';
import { isZero, num } from '../../core/num';
import { OUTER_IDS } from '../../data/sources';
import type { OuterId } from '../../data/sources';
import type {
  AssembledWeb,
  Circle,
  FusionKey,
  Point,
  RowEnemy,
  ShapeId,
  WebBoard,
  WebLayout,
  WebNodeKind,
} from '../../data/web/types';
import { ROW_ENEMIES } from '../../data/web/types';
import {
  boardCounts,
  buyPath,
  canBuy,
  fusionProgress,
  fusionSlotOrder,
  fusionSlots,
  outerView,
  planPath,
  refundPreview,
  revealedOuters,
  WEB_RULES,
} from '../../meta/web';
import type {
  AccountProgress,
  BuyCheck,
  BuyReason,
  CharacterProgress,
  GateProgress,
  OuterView,
  Price,
  RefundPreview,
} from '../../meta/web';
import { fusionName, fusionTitle, nodeName, say } from '../web/names';
import { buyCheckText, describeNode } from '../web/text';
import type { TextLookup } from '../web/text';

/**
 * A node's look: owned (and more ranks to buy), maxed, buyable now, adjacent but refused (a gate,
 * a slot or the wallet), or not yet reachable.
 */
export type NodeState = 'owned' | 'maxed' | 'buyable' | 'blocked' | 'far';

export interface NodeView {
  readonly id: string;
  readonly kind: WebNodeKind;
  readonly board: string;
  readonly at: Point;
  readonly rank: number;
  /** null for an unlimited node (mastery, 強化∞). */
  readonly maxRank: number | null;
  readonly state: NodeState;
  readonly check: BuyCheck;
}

/**
 * An outer's place (gd §2.4): 'hidden' (not revealed: 「？」), 'locked' (the scope locks it),
 * 'absent' (revealed, not in the game yet), 'collapsed' (revealed, nothing bought, not opened:
 * a small circle with its name, icon and covered enemies) or 'open' (its nodes drawn).
 */
export type OuterState = 'hidden' | 'locked' | 'absent' | 'collapsed' | 'open';

export interface OuterBoardView {
  readonly outer: OuterId;
  readonly board: string;
  readonly state: OuterState;
  /** Owned nodes of the board (entry included). */
  readonly invested: number;
  /** The collapsed circle; the board's middle. */
  readonly circle: Circle;
  readonly label: Point;
  readonly icon: ShapeId | null;
  readonly accent: string | null;
  readonly answers: readonly RowEnemy[];
  readonly helps: readonly RowEnemy[];
}

/** A spoke's fusion progress 「中心 8/8・毒 3/6」 (gd §2.3). */
export interface SpokeView {
  readonly outer: OuterId;
  readonly at: Point;
  readonly gate: GateProgress & { readonly unlocked: boolean };
  /** The fusion's core is owned: the spoke shows its name instead. */
  readonly owned: boolean;
}

export interface EdgeView {
  readonly a: string;
  readonly b: string;
  readonly from: Point;
  readonly to: Point;
  /** Both ends owned (the root counting as owned). */
  readonly lit: boolean;
  /** One end owned and the other buyable. */
  readonly open: boolean;
}

export interface BranchLabel {
  readonly key: string;
  readonly at: Point;
}

export interface WebModel {
  readonly nodes: readonly NodeView[];
  readonly edges: readonly EdgeView[];
  readonly outers: readonly OuterBoardView[];
  readonly spokes: readonly SpokeView[];
  readonly branches: readonly BranchLabel[];
  /** Open boards' label anchors: the hub, the fusions, the ascendancies. */
  readonly labels: readonly { readonly board: WebBoard; readonly at: Point }[];
}

const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

/** The outer whose board (an outer's or a fusion's) holds a node, or null. */
export function outerOfBoard(board: string): OuterId | null {
  const parts = board.split('.');
  const outer = parts[0] === 'outer' ? parts[1] : parts[0] === 'fusion' ? parts[2] : undefined;
  return (OUTER_IDS as readonly (string | undefined)[]).includes(outer) ? (outer as OuterId) : null;
}

/** The ranks a node holds at most; null when unlimited. */
export const maxRankOf = (web: AssembledWeb, id: string): number | null => {
  const ranks = web.byId.get(id)?.ranks;
  return typeof ranks === 'number' ? ranks : null;
};

const rankIn = (progress: CharacterProgress, id: string): number => {
  const stored = Object.hasOwn(progress.ranks, id) ? progress.ranks[id] : undefined;
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= 1
    ? Math.floor(stored)
    : 0;
};

/** A node's state from its rank and canBuy's answer (§2.3's gates read as 'blocked'). */
export function nodeState(rank: number, check: BuyCheck): NodeState {
  if (rank > 0) {
    if (check.ok) return 'owned';
    return check.reason === 'owned' || check.reason === 'maxRank' ? 'maxed' : 'owned';
  }
  if (check.ok) return 'buyable';
  return check.reason === 'notAdjacent' ? 'far' : 'blocked';
}

/**
 * The state of each outer (gd §2.4): not revealed by the character's best wave → hidden, whatever
 * else; a board the scope locks → locked; one not in the content → absent; nothing bought and
 * not in `expanded` → collapsed; else open. The character's own clock holds no outer.
 */
export function outerStates(
  web: AssembledWeb,
  progress: CharacterProgress,
  expanded: ReadonlySet<OuterId>,
): ReadonlyMap<OuterId, OuterState> {
  const revealed = revealedOuters(web.def, progress.bestWave);
  const counts = boardCounts(web, progress);
  const states = new Map<OuterId, OuterState>();
  for (const outer of OUTER_IDS) {
    if (outer === web.character) continue;
    const board = web.boards.find((b) => b.id === `outer.${outer}`);
    if (board === undefined) continue;
    const view: OuterView = outerView(web, progress, outer);
    if (!revealed.has(outer)) states.set(outer, 'hidden');
    else if (view === 'locked') states.set(outer, 'locked');
    else if (view === 'absent') states.set(outer, 'absent');
    else if ((counts.outers[outer] ?? 0) === 0 && !expanded.has(outer)) {
      states.set(outer, 'collapsed');
    } else states.set(outer, 'open');
  }
  return states;
}

/**
 * Whether a node is drawn: an outer's node only while its outer is open; a fusion's while its outer
 * is revealed and in the game (collapsed included: the branch lies on the spoke); every other
 * board's always.
 */
function drawn(board: string, states: ReadonlyMap<OuterId, OuterState>): boolean {
  const outer = outerOfBoard(board);
  if (outer === null) return true;
  const state = states.get(outer);
  if (board.startsWith('outer.')) return state === 'open';
  return state === 'open' || state === 'collapsed';
}

/** The web as the panel draws it for `progress` (§3), with `expanded` outers opened by a click. */
export function webModel(
  web: AssembledWeb,
  layout: WebLayout,
  progress: CharacterProgress,
  account: AccountProgress,
  expanded: ReadonlySet<OuterId> = new Set(),
): WebModel {
  const states = outerStates(web, progress, expanded);
  const nodes: NodeView[] = [];
  const byId = new Map<string, NodeView>();
  for (const node of web.nodes) {
    if (!drawn(node.board, states)) continue;
    const at = layout.nodes[node.id];
    if (at === undefined) continue;
    const rank = node.id === web.root ? 1 : rankIn(progress, node.id);
    const check = canBuy(web, progress, account, node.id);
    const view: NodeView = {
      id: node.id,
      kind: node.kind,
      board: node.board,
      at,
      rank,
      maxRank: maxRankOf(web, node.id),
      state: nodeState(rank, check),
      check,
    };
    nodes.push(view);
    byId.set(node.id, view);
  }

  const collapsedAt = (id: string): Point | undefined => {
    const node = web.byId.get(id);
    const outer = node === undefined ? null : outerOfBoard(node.board);
    if (node === undefined || outer === null || !node.board.startsWith('outer.')) return undefined;
    return states.get(outer) === 'collapsed'
      ? (layout.boards[node.board]?.collapsed ?? undefined)
      : undefined;
  };
  const edges: EdgeView[] = [];
  for (const [a, b] of web.edges) {
    const va = byId.get(a);
    const vb = byId.get(b);
    // An edge into a collapsed outer ends at its circle (its entry's edge to the hub).
    const from = va?.at ?? collapsedAt(a);
    const to = vb?.at ?? collapsedAt(b);
    if (from === undefined || to === undefined || (va === undefined && vb === undefined)) continue;
    const owned = (v: NodeView | undefined): boolean => v !== undefined && v.rank > 0;
    const buyable = (v: NodeView | undefined): boolean => v?.state === 'buyable';
    edges.push({
      a,
      b,
      from,
      to,
      lit: owned(va) && owned(vb),
      open: (owned(va) && buyable(vb)) || (owned(vb) && buyable(va)),
    });
  }

  const counts = boardCounts(web, progress);
  const outers: OuterBoardView[] = [];
  for (const [outer, state] of states) {
    const board = `outer.${outer}`;
    const marks = layout.boards[board];
    if (marks?.collapsed === null || marks === undefined) continue;
    const def = web.outers.get(outer);
    const revealed = state !== 'hidden';
    const covered = (cover: 'answer' | 'helps'): RowEnemy[] =>
      revealed && def !== undefined ? ROW_ENEMIES.filter((e) => def.covers[e] === cover) : [];
    outers.push({
      outer,
      board,
      state,
      invested: counts.outers[outer] ?? 0,
      circle: marks.collapsed,
      label: marks.label,
      icon: revealed ? (def?.skin.shape ?? null) : null,
      accent: revealed && def !== undefined ? hex(def.skin.accent) : null,
      answers: covered('answer'),
      helps: covered('helps'),
    });
  }

  const owned = new Set(fusionSlotOrder(web, progress));
  const spokes: SpokeView[] = [];
  for (const [outer, at] of Object.entries(layout.progressMarks) as [OuterId, Point][]) {
    const state = states.get(outer);
    if (state !== 'open' && state !== 'collapsed') continue;
    spokes.push({
      outer,
      at,
      gate: fusionProgress(web, progress, outer),
      owned: owned.has(outer),
    });
  }

  const labels: { board: WebBoard; at: Point }[] = [];
  for (const board of web.boards) {
    if (board.status !== 'open' || board.kind === 'outer' || board.kind === 'center') continue;
    const outer = outerOfBoard(board.id);
    if (outer !== null && !drawn(board.id, states)) continue;
    const at = layout.boards[board.id]?.label;
    if (at !== undefined) labels.push({ board, at });
  }

  return { nodes, edges, outers, spokes, branches: branchLabels(web, byId), labels };
}

/**
 * The branch names (`web.branch.<board>.<slug>`) of the center and the drawn outers, each at the
 * middle of its branch's drawn nodes.
 */
function branchLabels(web: AssembledWeb, drawnNodes: ReadonlyMap<string, NodeView>): BranchLabel[] {
  const sums = new Map<string, { x: number; y: number; count: number }>();
  for (const node of web.nodes) {
    const view = drawnNodes.get(node.id);
    if (view === undefined) continue;
    const parts = node.id.split('.');
    if (parts.length !== 4) continue;
    const [head, , branch] = parts as [string, string, string, string];
    const center = parts[1] === 'center';
    if (!(head === 'outer' || center) || branch === 'main') continue;
    const key = `web.branch.${node.board}.${branch}`;
    const sum = sums.get(key) ?? { x: 0, y: 0, count: 0 };
    sums.set(key, { x: sum.x + view.at.x, y: sum.y + view.at.y, count: sum.count + 1 });
  }
  return [...sums].map(([key, { x, y, count }]) => ({
    key,
    at: { x: x / count, y: y / count },
  }));
}

// Prices and the click plan (§8 item 5).

/** A price as the panel writes it: 「1.20K 碎片 + 1 核心」; 「免費」 when it is nothing. */
export function priceText(price: Price, lookup: TextLookup): string {
  const parts: string[] = [];
  if (!isZero(price.shards)) {
    parts.push(
      say(lookup, 'panel.price.shards', { shards: formatNum(price.shards, { format: 'short' }) }),
    );
  }
  if (price.cores > 0) {
    const key = price.cores === 1 ? 'panel.price.core' : 'panel.price.cores';
    parts.push(say(lookup, key, { cores: price.cores }));
  }
  if (price.resonance > 0) {
    parts.push(say(lookup, 'panel.price.resonance', { resonance: price.resonance }));
  }
  return parts.length === 0 ? say(lookup, 'panel.price.free') : parts.join(' + ');
}

/**
 * What a left click on a node does: buy it now; plan a path to a node no owned node touches
 * (planPath: the shortest route and its total); or nothing, with the first refusal and the node it
 * stops at.
 */
export type ClickPlan =
  | { readonly kind: 'buy'; readonly id: string; readonly price: Price }
  | {
      readonly kind: 'path';
      readonly id: string;
      readonly ids: readonly string[];
      readonly price: Price;
    }
  | {
      readonly kind: 'refused';
      readonly id: string;
      readonly at: string;
      readonly reason: BuyReason;
      readonly check: Extract<BuyCheck, { readonly ok: false }> | null;
    };

export function planClick(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  id: string,
): ClickPlan {
  const check = canBuy(web, progress, account, id);
  if (check.ok) return { kind: 'buy', id, price: check.price };
  if (check.reason !== 'notAdjacent') {
    return { kind: 'refused', id, at: id, reason: check.reason, check };
  }
  const plan = planPath(web, progress, account, id);
  if (plan.ok) return { kind: 'path', id, ids: plan.ids, price: plan.price };
  return {
    kind: 'refused',
    id,
    at: plan.at,
    reason: plan.reason,
    check: refusalOnTheWay(web, progress, account, plan.at, plan.reason),
  };
}

/**
 * canBuy's refusal of `at` as the path meets it, which carries a gate's counts for the text:
 * `at` checked after the shortest planned path to one of its neighbours is bought (planPath does
 * not hand back the progress it stops at). Null when no such check gives the same reason.
 */
function refusalOnTheWay(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  at: string,
  reason: BuyReason,
): Extract<BuyCheck, { readonly ok: false }> | null {
  const same = (check: BuyCheck): Extract<BuyCheck, { readonly ok: false }> | null =>
    !check.ok && check.reason === reason ? check : null;
  const direct = same(canBuy(web, progress, account, at));
  if (direct !== null) return direct;
  let best: { readonly length: number; readonly check: BuyCheck } | null = null;
  for (const neighbour of web.neighbours.get(at) ?? []) {
    const plan = planPath(web, progress, account, neighbour);
    if (!plan.ok || (best !== null && plan.ids.length >= best.length)) continue;
    const after = buyPath(web, progress, account, neighbour);
    best = { length: plan.ids.length, check: canBuy(web, after, account, at) };
  }
  return best === null ? null : same(best.check);
}

/** A refusal's line: canBuy's reason translated, with a gate's counts. */
export function refusalText(
  plan: Extract<ClickPlan, { readonly kind: 'refused' }>,
  lookup: TextLookup,
): string {
  return buyCheckText(plan.check ?? { ok: false, reason: plan.reason, gate: null }, lookup);
}

// The tooltip.

export interface NodeTip {
  readonly name: string;
  readonly kind: string;
  /** 「等級 2/5」; null for a 1-rank node. */
  readonly rank: string | null;
  readonly lines: readonly string[];
  /** 「價格：…」 when it can take another rank. */
  readonly price: string | null;
  /** The action or the reason it cannot be bought, translated. */
  readonly action: string | null;
  /** The action is a refusal. */
  readonly refused: boolean;
  /** 「右鍵退點，返還 …」 for an owned node but the signature. */
  readonly refund: string | null;
}

const WALLET_REASONS: ReadonlySet<BuyReason> = new Set([
  'notEnoughShards',
  'notEnoughCores',
  'notEnoughResonance',
]);

/**
 * What a refusal for the wallet would cost, so 「碎片不足」 comes with the price: the node's own
 * price, or the whole path's when the click plans one. Null for every other refusal.
 */
function shortfallPrice(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  plan: Extract<ClickPlan, { readonly kind: 'refused' }>,
  lookup: TextLookup,
): string | null {
  if (!WALLET_REASONS.has(plan.reason)) return null;
  const rich: CharacterProgress = {
    ...progress,
    wallet: { shards: num(1e300), cores: 1e9, resonance: 1e9 },
  };
  const direct = canBuy(web, rich, account, plan.id);
  if (direct.ok) return say(lookup, 'panel.tip.price', { price: priceText(direct.price, lookup) });
  const path = planPath(web, rich, account, plan.id);
  if (!path.ok) return null;
  return say(lookup, 'panel.tip.pathPrice', {
    count: path.ids.length,
    price: priceText(path.price, lookup),
  });
}

/** The tooltip of a node (§8 item 1): name, kind, rank, describeNode's text, price, and what a click does. */
export function nodeTip(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  id: string,
  lookup: TextLookup,
): NodeTip {
  const node = web.byId.get(id);
  if (node === undefined) throw new Error(`node '${id}' is not on web '${web.character}'`);
  const rank = id === web.root ? 1 : rankIn(progress, id);
  const max = maxRankOf(web, id);
  const text = describeNode(web, id, Math.max(rank, 1), lookup);
  const plan = planClick(web, progress, account, id);
  let price: string | null = null;
  let action: string | null = null;
  if (plan.kind === 'buy') {
    price = say(lookup, 'panel.tip.price', { price: priceText(plan.price, lookup) });
    action = say(lookup, rank > 0 ? 'panel.tip.clickRank' : 'panel.tip.click');
  } else if (plan.kind === 'path') {
    action = say(lookup, 'panel.tip.path', {
      count: plan.ids.length,
      price: priceText(plan.price, lookup),
    });
  } else if (plan.reason !== 'owned') {
    price = shortfallPrice(web, progress, account, plan, lookup);
    const reason = refusalText(plan, lookup);
    action =
      plan.at === id
        ? reason
        : say(lookup, 'panel.path.blocked', { name: nodeName(web, plan.at, lookup), reason });
  }
  let refund: string | null = null;
  if (rank > 0 && id !== web.root) {
    const preview = refundPreview(web, progress, account, id);
    refund = refundText(web, preview, lookup);
  }
  let rankText: string | null = null;
  if (max === null) rankText = say(lookup, 'panel.tip.rankUnlimited', { rank });
  else if (max > 1) rankText = say(lookup, 'panel.tip.rank', { rank, max });
  return {
    name: text.name,
    kind: text.kind,
    rank: rankText,
    lines: text.lines,
    price,
    action,
    refused: plan.kind === 'refused',
    refund,
  };
}
/** 「右鍵退點，返還 …」 and, when more drops with it, 「連帶退掉 N 個節點」. */
export function refundText(web: AssembledWeb, preview: RefundPreview, lookup: TextLookup): string {
  const line = say(lookup, 'panel.tip.refund', { price: priceText(preview.refund, lookup) });
  const more = preview.dropped.filter((id) => web.byId.has(id)).length - 1;
  return more > 0 ? `${line} ${say(lookup, 'panel.refund.drops', { count: more })}` : line;
}

// The slot bar (§2.3, §8 item 11).

export interface SlotView {
  /** The owned core or ★ in the slot; null when empty. */
  readonly id: string | null;
  readonly name: string | null;
  /** What a click on it refunds and drops (refundPreview); null when empty. */
  readonly refund: RefundPreview | null;
}

export interface SlotBar {
  /** 2 fusion slots (3 after 奇點), filled in slot order (fusionSlotOrder). */
  readonly fusions: readonly SlotView[];
  /** 2 keystone slots, filled in web order. */
  readonly keystones: readonly SlotView[];
}

export function slotBar(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  lookup: TextLookup,
): SlotBar {
  const filled = (id: string, name: string): SlotView => ({
    id,
    name,
    refund: refundPreview(web, progress, account, id),
  });
  const empty: SlotView = { id: null, name: null, refund: null };
  const cores = fusionSlotOrder(web, progress).map((outer) => {
    const key = `${web.character}.${outer}` as FusionKey;
    return filled(
      `fusion.${key}.core`,
      say(lookup, 'web.coreName', {
        name: fusionName(key, lookup),
        title: fusionTitle(key, lookup),
      }),
    );
  });
  const keystones = web.nodes
    .filter((node) => node.kind === 'keystone' && rankIn(progress, node.id) > 0)
    .map((node) => filled(node.id, nodeName(web, node.id, lookup)));
  const pad = (views: SlotView[], count: number): SlotView[] => [
    ...views,
    ...Array.from({ length: Math.max(0, count - views.length) }, () => empty),
  ];
  return {
    fusions: pad(cores, fusionSlots(account)),
    keystones: pad(keystones, WEB_RULES.keystonesHeld),
  };
}

/** The spoke's line 「中心 8/8・毒 3/6」, or the fusion's name once its core is owned. */
export function spokeText(web: AssembledWeb, spoke: SpokeView, lookup: TextLookup): string {
  if (spoke.owned) return fusionName(`${web.character}.${spoke.outer}` as FusionKey, lookup);
  return say(lookup, 'panel.spoke', {
    center: spoke.gate.center,
    centerNeed: spoke.gate.centerNeed,
    outer: say(lookup, `web.outer.${spoke.outer}.name`),
    count: spoke.gate.outer ?? 0,
    outerNeed: spoke.gate.outerNeed ?? 0,
  });
}
