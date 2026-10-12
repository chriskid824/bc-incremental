/**
 * Talent-buying strategies for the balance simulator (docs/ARCHITECTURE.md §12).
 *
 * Each strategy repeatedly buys one node until nothing it wants is affordable. Choices depend
 * only on the meta state, data order and prices, so a strategy is deterministic. Strategies
 * never save up: when the preferred class has nothing affordable they move on to the next one.
 */

import { eq, lt } from '../../src/core/num';
import type { GameData, TalentNode } from '../../src/data';
import { allocate, canAllocate, nodePrice } from '../../src/meta';
import type { EconomyConfig, MetaState } from '../../src/meta';

export const STRATEGY_IDS = [
  'crit-greedy',
  'dot-greedy',
  'chain-greedy',
  'cheapest',
  'balanced',
] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export const isStrategyId = (value: string): value is StrategyId =>
  (STRATEGY_IDS as readonly string[]).includes(value);

const FOCUS_ARCHETYPES = ['crit', 'dot', 'chain'] as const;
type FocusArchetype = (typeof FOCUS_ARCHETYPES)[number];

/** Buying class of a node: its archetype, or 'generic' for none/hybrid and repeatable nodes. */
export type NodeClass = FocusArchetype | 'generic';

export function nodeClass(node: TalentNode): NodeClass {
  if (node.kind === 'repeatable') return 'generic';
  const archetype = node.archetype;
  return archetype === 'crit' || archetype === 'dot' || archetype === 'chain'
    ? archetype
    : 'generic';
}

/**
 * The affordable, reachable node accepted by `accept` with the lowest shard price, then the
 * lowest core price, then the earliest position in the data file.
 */
function cheapestAllocatable(
  meta: Readonly<MetaState>,
  data: GameData,
  economy: EconomyConfig,
  accept: (node: TalentNode) => boolean,
): TalentNode | null {
  let best: TalentNode | null = null;
  let bestPrice: ReturnType<typeof nodePrice> | null = null;
  for (const node of data.talents) {
    if (node.kind === 'start' || !accept(node)) continue;
    // The M0 simulation ignores keystone rules, so buying one only raises later prices.
    // Drop this once src/sim implements RuleSpec (M1).
    if (node.kind === 'keystone') continue;
    if (!canAllocate(meta, node.id, data, economy).ok) continue;
    const price = nodePrice(meta, node, economy);
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
 * - `<archetype>-greedy`: cheapest node of that archetype, else cheapest generic node; nodes
 *   of the other archetypes are never bought (pure builds).
 * - `cheapest`: cheapest node of any class.
 * - `balanced`: round-robin over the archetypes, implemented statelessly as "the archetype
 *   with the fewest allocated nodes first" (ties in crit, dot, chain order); falls back to
 *   the next archetype when one has nothing affordable, then to generic nodes.
 */
export function nextPurchase(
  strategy: StrategyId,
  meta: Readonly<MetaState>,
  data: GameData,
  economy: EconomyConfig,
): TalentNode | null {
  const pick = (cls: NodeClass): TalentNode | null =>
    cheapestAllocatable(meta, data, economy, ofClass(cls));
  switch (strategy) {
    case 'crit-greedy':
      return pick('crit') ?? pick('generic');
    case 'dot-greedy':
      return pick('dot') ?? pick('generic');
    case 'chain-greedy':
      return pick('chain') ?? pick('generic');
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
      return pick('generic');
    }
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
