/**
 * 建議節點 and the death review's 建議外盤 (docs/v3/game-design-v3.md §8 items 8 and 14, A.4):
 * after a death, 3 nodes marked on the web and 1 outer named on the result screen, picked by
 * what got through. The threats are the enemy columns of gd §6.4, ordered by the damage they did
 * to the player (contact and bullets, the result's own tallies). A node is suggested when it
 * answers a threat (「答案：盾兵」, V18) and can still take a rank: the center's first, then the
 * outers' the character has invested in, then the other open outers'. The rest of the 3 are the
 * next nodes of the character's default order (the 預設 build) that can still take a rank. The
 * outer is an open one whose gd §6.5 cover of the first threat it can is ◆, else ＋, preferring
 * one the character has not invested in (「優先選已揭露但還沒投資的」). Pure, so the tests and the
 * balance tools reach it.
 */

import { ENEMY_IDS } from '../../data/types';
import type { EnemyId } from '../../data/types';
import { OUTER_IDS } from '../../data/sources';
import type { OuterId } from '../../data/sources';
import { rowEnemyOf } from '../../data/web/types';
import type { AssembledWeb, RowEnemy, WebNode } from '../../data/web/types';
import type { ContactTally } from '../../sim/types';
import { storedRank } from './counts';
import { outerView } from './reveal';
import { canBuy } from './rules';
import type { BuyReason } from './rules';
import type { AccountProgress, CharacterProgress } from './types';

/** How many nodes the web marks (gd §8 item 8). */
export const SUGGESTED_NODES = 3;

export interface SuggestedNode {
  readonly id: string;
  /** The threat it answers; null for a node of the default order. */
  readonly answers: RowEnemy | null;
}

export interface SuggestedOuter {
  readonly outer: OuterId;
  /** The threat it covers. */
  readonly enemy: RowEnemy;
  /** gd §6.5's ◆ (an answer node) or ＋ (the mechanism helps). */
  readonly cover: 'answer' | 'helps';
}

export interface Suggestions {
  readonly threats: readonly RowEnemy[];
  readonly nodes: readonly SuggestedNode[];
  readonly outer: SuggestedOuter | null;
}

/** What the player took from each enemy type: the result's contact and bullet tallies. */
export interface ThreatTallies {
  readonly damageTakenBy: Readonly<Record<EnemyId, ContactTally>>;
  readonly bulletTakenBy?: Readonly<Partial<Record<EnemyId, ContactTally>>>;
}

/** The gd §6.4 columns that hurt the player, most damage first (the elite counts in none). */
export function threatsOf(tallies: ThreatTallies): RowEnemy[] {
  const damage = new Map<RowEnemy, number>();
  for (const id of ENEMY_IDS) {
    const row = rowEnemyOf(id);
    if (row === null) continue;
    const taken =
      (tallies.damageTakenBy[id]?.damage ?? 0) + (tallies.bulletTakenBy?.[id]?.damage ?? 0);
    if (taken > 0) damage.set(row, (damage.get(row) ?? 0) + taken);
  }
  return [...damage.entries()].sort((a, b) => b[1] - a[1]).map(([row]) => row);
}

/** Refusals that mean the node can take no rank this cycle, or is not on the player's web. */
const UNREACHABLE: ReadonlySet<BuyReason> = new Set<BuyReason>([
  'unknown',
  'locked',
  'hidden',
  'owned',
  'maxRank',
  'needsPrestige',
  'otherAscendancy',
]);

/** Whether `id` can still take a rank on this web, now or after more shards, a path or gates. */
function open(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  id: string,
): boolean {
  const check = canBuy(web, progress, account, id);
  return check.ok || !UNREACHABLE.has(check.reason);
}

const outerOf = (node: WebNode): OuterId | null =>
  node.board.startsWith('outer.') ? (node.board.slice('outer.'.length) as OuterId) : null;

/** Whether the character owns any rank on outer `outer`'s board. */
function invested(web: AssembledWeb, progress: CharacterProgress, outer: OuterId): boolean {
  const board = `outer.${outer}`;
  return web.nodes.some((node) => node.board === board && storedRank(progress, node.id) > 0);
}

/** 0 the center, 1 an invested outer, 2 another outer, 3 anything else (the hub, fusions). */
function nodeTier(web: AssembledWeb, progress: CharacterProgress, node: WebNode): number {
  if (node.board === `${web.character}.center`) return 0;
  const outer = outerOf(node);
  if (outer === null) return 3;
  return invested(web, progress, outer) ? 1 : 2;
}

export function suggest(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  tallies: ThreatTallies,
): Suggestions {
  const threats = threatsOf(tallies);
  const nodes: SuggestedNode[] = [];
  const taken = new Set<string>();
  const add = (id: string, answers: RowEnemy | null): void => {
    if (nodes.length >= SUGGESTED_NODES || taken.has(id)) return;
    taken.add(id);
    nodes.push({ id, answers });
  };
  for (const enemy of threats) {
    const answering = web.nodes
      .filter((node) => node.answers.includes(enemy) && open(web, progress, account, node.id))
      .map((node, index) => ({ node, index, tier: nodeTier(web, progress, node) }))
      .sort((a, b) => a.tier - b.tier || a.index - b.index);
    for (const { node } of answering) add(node.id, enemy);
  }
  for (const id of web.def.defaultOrder) {
    if (nodes.length >= SUGGESTED_NODES) break;
    if (web.byId.has(id) && open(web, progress, account, id)) add(id, null);
  }
  return { threats, nodes, outer: suggestOuter(web, progress, threats) };
}

function suggestOuter(
  web: AssembledWeb,
  progress: CharacterProgress,
  threats: readonly RowEnemy[],
): SuggestedOuter | null {
  const candidates = OUTER_IDS.filter(
    (outer) => web.outers.has(outer) && outerView(web, progress, outer) === 'open',
  );
  for (const enemy of threats) {
    let best: { outer: OuterId; cover: 'answer' | 'helps'; score: number } | null = null;
    for (const outer of candidates) {
      const cover = web.outers.get(outer)?.covers[enemy];
      if (cover === undefined) continue;
      // ◆ before ＋, an outer not invested in before one that is, then clock order.
      const score = (cover === 'answer' ? 0 : 2) + (invested(web, progress, outer) ? 1 : 0);
      if (best === null || score < best.score) best = { outer, cover, score };
    }
    if (best !== null) return { outer: best.outer, enemy, cover: best.cover };
  }
  return null;
}
