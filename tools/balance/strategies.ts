/**
 * Talent-buying strategies for the balance simulator (docs/ARCHITECTURE.md §12).
 *
 * Each strategy repeatedly buys one node until nothing it wants is affordable. Choices depend
 * only on the meta state, data order and prices, so a strategy is deterministic. Archetype
 * strategies save up: while a reachable node of their archetype is short of shards only (they
 * have its cores), they keep its price in the bank instead of spending it on fallback classes
 * such as the repeatable node. `cheapest` and `might-only` never save.
 */

import { eq, lt, sub, ZERO } from '../../src/core/num';
import type { Num } from '../../src/core/num';
import type { GameData, TalentNode } from '../../src/data';
import { allocate, canAllocate, nodePrice } from '../../src/meta';
import type { EconomyConfig, MetaState } from '../../src/meta';

export const STRATEGY_IDS = [
  'crit-greedy',
  'dot-greedy',
  'chain-greedy',
  'cheapest',
  'balanced',
  'might-only',
] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export const isStrategyId = (value: string): value is StrategyId =>
  (STRATEGY_IDS as readonly string[]).includes(value);

const FOCUS_ARCHETYPES = ['crit', 'dot', 'chain'] as const;
type FocusArchetype = (typeof FOCUS_ARCHETYPES)[number];

/**
 * Buying class of a node: its archetype, 'hybrid' for bridge nodes, or 'generic' for
 * archetype-less and repeatable nodes.
 */
export type NodeClass = FocusArchetype | 'hybrid' | 'generic';

export function nodeClass(node: TalentNode): NodeClass {
  if (node.kind === 'repeatable') return 'generic';
  const archetype = node.archetype;
  return archetype === 'none' ? 'generic' : archetype;
}

/**
 * The affordable, reachable node accepted by `accept` with the lowest shard price, then the
 * lowest core price, then the earliest position in the data file. With a `reserve`, only
 * nodes that leave at least that many shards in the bank count as affordable.
 */
function cheapestAllocatable(
  meta: Readonly<MetaState>,
  data: GameData,
  economy: EconomyConfig,
  accept: (node: TalentNode) => boolean,
  reserve: Num = ZERO,
): TalentNode | null {
  let best: TalentNode | null = null;
  let bestPrice: ReturnType<typeof nodePrice> | null = null;
  for (const node of data.talents) {
    if (node.kind === 'start' || !accept(node)) continue;
    // Generic keystones (glassCannon: life becomes 1) are gambles no bot should take blind.
    if (node.kind === 'keystone' && node.archetype === 'none') continue;
    if (!canAllocate(meta, node.id, data, economy).ok) continue;
    const price = nodePrice(meta, node, economy);
    if (lt(sub(meta.shards, reserve), price.shards)) continue;
    if (
      bestPrice === null ||
      lt(price.shards, bestPrice.shards) ||
      (eq(price.shards, bestPrice.shards) && price.cores < bestPrice.cores)
    ) {
      best = node;
      bestPrice = price;
    }
  }
  return best;
}

const ofClass =
  (cls: NodeClass) =>
  (node: TalentNode): boolean =>
    nodeClass(node) === cls;

/**
 * Shards an archetype bot keeps for its next sector node: the shard price of the cheapest
 * reachable node in `classes` it has the cores for but not the shards, or zero. Without it, a
 * bot whose next notable cost more than one repeatable rank kept buying ranks and stalled
 * before its keystone (docs/GDD.md §9.1).
 */
function savingsFor(
  meta: Readonly<MetaState>,
  data: GameData,
  economy: EconomyConfig,
  classes: readonly NodeClass[],
): Num {
  let reserve: Num | null = null;
  for (const node of data.talents) {
    if (node.kind === 'repeatable' || !classes.includes(nodeClass(node))) continue;
    const check = canAllocate(meta, node.id, data, economy);
    if (check.ok || check.reason !== 'notEnoughShards') continue;
    const price = nodePrice(meta, node, economy);
    if (price.cores > meta.cores) continue;
    if (reserve === null || lt(price.shards, reserve)) reserve = price.shards;
  }
  return reserve ?? ZERO;
}

/** Allocated non-repeatable nodes of an archetype. */
function allocatedCount(meta: Readonly<MetaState>, data: GameData, cls: NodeClass): number {
  let count = 0;
  for (const node of data.talents) {
    if (node.kind !== 'repeatable' && meta.allocated.has(node.id) && nodeClass(node) === cls) {
      count++;
    }
  }
  return count;
}

/**
 * The node the strategy buys next, or null when it is done for now.
 * - `<archetype>-greedy`: cheapest node of that archetype, else cheapest generic node, else
 *   cheapest bridge (hybrid) node, the fallbacks only from shards above the savings for the
 *   archetype (see savingsFor); sector nodes of the other archetypes are never bought.
 * - `cheapest`: cheapest node of any class.
 * - `balanced`: round-robin over the archetypes, implemented statelessly as "the archetype
 *   with the fewest allocated nodes first" (ties in crit, dot, chain order); falls back to
 *   the next archetype when one has nothing affordable, then to generic, then hybrid nodes,
 *   saving for all three archetypes like the greedy strategies.
 * - `might-only`: ranks of the repeatable node (Might) and nothing else, the baseline every
 *   archetype must beat (docs/GDD.md §9.1).
 */
export function nextPurchase(
  strategy: StrategyId,
  meta: Readonly<MetaState>,
  data: GameData,
  economy: EconomyConfig,
): TalentNode | null {
  const pick = (cls: NodeClass, reserve: Num = ZERO): TalentNode | null =>
    cheapestAllocatable(meta, data, economy, ofClass(cls), reserve);
  const greedy = (cls: FocusArchetype): TalentNode | null => {
    const own = pick(cls);
    if (own) return own;
    const reserve = savingsFor(meta, data, economy, [cls]);
    return pick('generic', reserve) ?? pick('hybrid', reserve);
  };
  switch (strategy) {
    case 'crit-greedy':
      return greedy('crit');
    case 'dot-greedy':
      return greedy('dot');
    case 'chain-greedy':
      return greedy('chain');
    case 'cheapest':
      return cheapestAllocatable(meta, data, economy, () => true);
    case 'balanced': {
      const order = FOCUS_ARCHETYPES.map((cls, index) => ({
        cls,
        index,
        count: allocatedCount(meta, data, cls),
      })).sort((a, b) => a.count - b.count || a.index - b.index);
      for (const { cls } of order) {
        const node = pick(cls);
        if (node) return node;
      }
      const reserve = savingsFor(meta, data, economy, FOCUS_ARCHETYPES);
      return pick('generic', reserve) ?? pick('hybrid', reserve);
    }
    case 'might-only':
      return cheapestAllocatable(meta, data, economy, (node) => node.kind === 'repeatable');
  }
}

/** Upper bound on purchases in one menu visit; prices grow, so hitting it means a data bug. */
const MAX_PURCHASES_PER_VISIT = 10_000;

/** Spends currencies with the strategy. Returns the ids bought, in order. */
export function spend(
  strategy: StrategyId,
  meta: MetaState,
  data: GameData,
  economy: EconomyConfig,
): string[] {
  const bought: string[] = [];
  for (;;) {
    const node = nextPurchase(strategy, meta, data, economy);
    if (node === null) return bought;
    if (bought.length >= MAX_PURCHASES_PER_VISIT) {
      throw new Error(`Strategy ${strategy} bought ${MAX_PURCHASES_PER_VISIT} nodes in one visit`);
    }
    allocate(meta, node.id, data, economy);
    bought.push(node.id);
  }
}
