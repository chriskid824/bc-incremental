/**
 * Talent allocation (docs/GDD.md §4.1): PoE-style adjacency, shard price growing with the
 * number of allocated nodes, and free full respec.
 */

import { add, ZERO, lt, mul, num, pow, sub } from '../core/num';
import type { Num } from '../core/num';
import type { GameData, TalentNode } from '../data/types';
import type { EconomyConfig, MetaState } from './types';

interface TalentIndex {
  readonly byId: ReadonlyMap<string, TalentNode>;
  readonly startId: string;
}

const indexCache = new WeakMap<readonly TalentNode[], TalentIndex>();

/** Lookup tables for a talent list, built once per list. Throws on malformed graphs. */
function talentIndex(talents: readonly TalentNode[]): TalentIndex {
  const cached = indexCache.get(talents);
  if (cached) return cached;
  const byId = new Map<string, TalentNode>();
  let startId: string | undefined;
  for (const node of talents) {
    if (byId.has(node.id)) throw new Error(`Duplicate talent id: ${node.id}`);
    byId.set(node.id, node);
    if (node.kind === 'start') {
      if (startId !== undefined) throw new Error('Talent web has more than one start node');
      startId = node.id;
    }
  }
  if (startId === undefined) throw new Error('Talent web has no start node');
  const index = { byId, startId };
  indexCache.set(talents, index);
  return index;
}

/**
 * How many times a node's modifiers apply: 1 for the start node, the bought rank for
 * repeatable nodes, otherwise 1 if allocated and 0 if not.
 */
export function nodeRank(meta: Readonly<MetaState>, node: TalentNode): number {
  if (node.kind === 'start') return 1;
  if (node.kind === 'repeatable') return meta.ranks.get(node.id) ?? 0;
  return meta.allocated.has(node.id) ? 1 : 0;
}

/**
 * Price of the next purchase of a node.
 * Normal nodes: talentBaseShards × talentGrowth^n × shardCostFactor, where n counts the
 * allocated non-repeatable nodes. Repeatable nodes: repeat.baseShards × repeat.growth^rank.
 * Both add coreCost cores. Meaningless for the start node, which cannot be bought.
 */
export function nodePrice(
  meta: Readonly<MetaState>,
  node: TalentNode,
  economy: EconomyConfig,
): { shards: Num; cores: number } {
  const cores = node.coreCost ?? 0;
  if (node.kind === 'repeatable') {
    if (!node.repeat) throw new Error(`Repeatable talent ${node.id} has no repeat pricing`);
    const rank = meta.ranks.get(node.id) ?? 0;
    return { shards: mul(pow(num(node.repeat.growth), rank), node.repeat.baseShards), cores };
  }
  let n = 0;
  for (const id of meta.allocated) {
    // Repeatable nodes are exactly the allocated ids that carry a rank.
    if (!meta.ranks.has(id)) n++;
  }
  const shards = mul(
    mul(pow(num(economy.talentGrowth), n), economy.talentBaseShards),
    node.shardCostFactor ?? 1,
  );
  return { shards, cores };
}

export type AllocateCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        'unknown' | 'start' | 'allocated' | 'notAdjacent' | 'notEnoughShards' | 'notEnoughCores';
    };

/**
 * Whether the node can be bought now. A node is adjacent when one of its links is the start
 * node or an allocated node. Repeatable nodes stay buyable (next rank) and never report
 * 'allocated'.
 */
export function canAllocate(
  meta: Readonly<MetaState>,
  nodeId: string,
  data: GameData,
  economy: EconomyConfig,
): AllocateCheck {
  const index = talentIndex(data.talents);
  const node = index.byId.get(nodeId);
  if (!node) return { ok: false, reason: 'unknown' };
  if (node.kind === 'start') return { ok: false, reason: 'start' };
  if (node.kind !== 'repeatable' && meta.allocated.has(nodeId)) {
    return { ok: false, reason: 'allocated' };
  }
  const adjacent = node.links.some((id) => id === index.startId || meta.allocated.has(id));
  if (!adjacent) return { ok: false, reason: 'notAdjacent' };
  const price = nodePrice(meta, node, economy);
  if (lt(meta.shards, price.shards)) return { ok: false, reason: 'notEnoughShards' };
  if (meta.cores < price.cores) return { ok: false, reason: 'notEnoughCores' };
  return { ok: true };
}

/** Buys the node (or its next rank). Throws without changing state if it cannot be bought. */
export function allocate(
  meta: MetaState,
  nodeId: string,
  data: GameData,
  economy: EconomyConfig,
): void {
  const check = canAllocate(meta, nodeId, data, economy);
  if (!check.ok) throw new Error(`Cannot allocate talent ${nodeId}: ${check.reason}`);
  const node = talentIndex(data.talents).byId.get(nodeId) as TalentNode;
  const price = nodePrice(meta, node, economy);
  meta.shards = sub(meta.shards, price.shards);
  meta.cores -= price.cores;
  meta.spentShards = add(meta.spentShards, price.shards);
  meta.spentCores += price.cores;
  if (node.kind === 'repeatable') meta.ranks.set(nodeId, (meta.ranks.get(nodeId) ?? 0) + 1);
  meta.allocated.add(nodeId);
}

/**
 * Free full respec: returns everything spent and clears all talents. Single-node refunds are
 * not supported because they could disconnect the rest of the web.
 */
export function refundAll(meta: MetaState): void {
  meta.shards = add(meta.shards, meta.spentShards);
  meta.cores += meta.spentCores;
  meta.spentShards = ZERO;
  meta.spentCores = 0;
  meta.allocated.clear();
  meta.ranks.clear();
}
