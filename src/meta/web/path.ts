/**
 * Path buying (docs/v3 C6 design §4.5; gd:807): the shortest route from what a character owns to a
 * node, by node count, ties in web order, never through a threshold, core, ★ or ascendancy node
 * unless it is the target; each step checked with canBuy against the progress so far.
 */

import { add, ZERO } from '../../core/num';
import type { AssembledWeb, WebNode } from '../../data/web/types';
import { GATED_KINDS, storedRank } from './counts';
import { DEFAULT_WEB_ECONOMY } from './price';
import { buy, canBuy } from './rules';
import type { BuyReason } from './rules';
import type {
  AccountProgress,
  ChallengeRules,
  CharacterProgress,
  Price,
  WebEconomy,
} from './types';

export type PathPlan =
  | { readonly ok: true; readonly ids: readonly string[]; readonly price: Price }
  | { readonly ok: false; readonly at: string; readonly reason: BuyReason };

/**
 * The nodes to buy, in order, to reach `target` from the root and the owned nodes: a breadth-first
 * search over web.neighbours that expands an owned node or one `passes` lets through, a level at a
 * time in web order. Each node is reached from the earliest in web order of the expanded nodes on
 * the level before it, and the route is read back from the target. `[target]` when the target is
 * the root or owned (one rank more); null when no route reaches it.
 */
export function shortestRoute(
  web: AssembledWeb,
  progress: CharacterProgress,
  target: string,
  passes: (node: WebNode) => boolean,
): readonly string[] | null {
  if (target === web.root || storedRank(progress, target) > 0) return [target];
  if (!web.byId.has(target)) return null;
  const order = new Map(web.nodes.map((node, index) => [node.id, index]));
  const byOrder = (a: string, b: string): number =>
    (order.get(a) as number) - (order.get(b) as number);
  const sources = new Set(
    web.nodes
      .filter((node) => node.id === web.root || storedRank(progress, node.id) > 0)
      .map((node) => node.id),
  );
  const parent = new Map<string, string | null>([...sources].map((id) => [id, null]));
  let level = [...sources].sort(byOrder);
  while (level.length > 0 && !parent.has(target)) {
    const next: string[] = [];
    for (const id of level) {
      if (!sources.has(id) && !passes(web.byId.get(id) as WebNode)) continue;
      for (const other of web.neighbours.get(id) ?? []) {
        if (parent.has(other)) continue;
        parent.set(other, id);
        next.push(other);
      }
    }
    level = next.sort(byOrder);
  }
  if (!parent.has(target)) return null;
  const route: string[] = [];
  let id: string | null = target;
  while (id !== null && !sources.has(id)) {
    route.push(id);
    id = parent.get(id) ?? null;
  }
  return route.reverse();
}

/** A path never passes through a threshold, core, ★ or ascendancy node (§4.5). */
const notGated = (node: WebNode): boolean => !GATED_KINDS.has(node.kind);

/** planPath's plan, and the progress after its purchases (up to the first refused one). */
function walk(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  target: string,
  economy: WebEconomy,
  challenge: ChallengeRules | undefined,
): { readonly plan: PathPlan; readonly progress: CharacterProgress } {
  // With no route the target is not adjacent to anything owned, and its own check says why.
  const route = shortestRoute(web, progress, target, notGated) ?? [target];
  let current = progress;
  let shards = ZERO;
  let cores = 0;
  let resonance = 0;
  for (const id of route) {
    const check = canBuy(web, current, account, id, economy, challenge);
    if (!check.ok) return { plan: { ok: false, at: id, reason: check.reason }, progress: current };
    shards = add(shards, check.price.shards);
    cores += check.price.cores;
    resonance += check.price.resonance;
    current = buy(web, current, account, id, economy, challenge);
  }
  return { plan: { ok: true, ids: route, price: { shards, cores, resonance } }, progress: current };
}

/**
 * The purchases that reach `target` (gd:807's preview): the shortest route, by node count, ties in
 * web order, never through a threshold, core, ★ or ascendancy node unless it is the target, each
 * node one rank, checked with canBuy against the progress so far; the ids and the summed price, or
 * the first failing step and its reason.
 */
export function planPath(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  target: string,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
  challenge?: ChallengeRules,
): PathPlan {
  return walk(web, progress, account, target, economy, challenge).plan;
}

/** planPath's purchases made; throws, as buy does, when the plan fails. */
export function buyPath(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  target: string,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
  challenge?: ChallengeRules,
): CharacterProgress {
  const { plan, progress: after } = walk(web, progress, account, target, economy, challenge);
  if (!plan.ok) {
    throw new Error(
      `buyPath '${target}' (character '${web.character}', scope '${web.scope.name}'): ` +
        `${plan.reason} at '${plan.at}'`,
    );
  }
  return after;
}
