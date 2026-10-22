/**
 * The purchase audits of the content (docs/v3 C6 design §4.8, D23): V15, every visible node of a
 * web reachable by a legal purchase order, and V25, the 預設 build a legal order. They run as tests
 * (CHECK and CI); the viewer (C6.8) and `npm run content` (C6.9) call the same functions (S-3). The
 * purchases are invest.ts' audit purchases (R3).
 */

import { nearestName } from '../../data/web/ids';
import type { AssembledWeb, BoardId, WebNode } from '../../data/web/types';
import { fileOfBoard } from '../../data/web/validate';
import { boardCounts, chainOfBoard, GATED_KINDS, outerOfBoard, WEB_RULES } from './counts';
import { auditBuy, auditStart, auditWave, fillBoard, replay } from './invest';
import type { Refusal } from './invest';
import { shortestRoute } from './path';
import { revealedOuters } from './reveal';
import { canBuy, fusionSlots } from './rules';
import type { BuyReason } from './rules';
import type { AccountProgress, CharacterProgress } from './types';

/** The audits' account: two fusion slots (gd:788). */
const AUDIT_ACCOUNT: AccountProgress = { singularityBeaten: false };

/**
 * The state a V15 witness stopped in (§4.8): a gate with its count, else the step it stopped on.
 */
function stateOf(web: AssembledWeb, at: string, refusal: Refusal): string {
  const gate = refusal.gate;
  const outer = outerOfBoard((web.byId.get(at) as WebNode).board);
  if (gate !== null && refusal.reason === 'centerGate') {
    return `with ${gate.center} of ${gate.centerNeed} nodes on '${web.character}.center'`;
  }
  if (gate !== null && refusal.reason === 'outerGate') {
    return `with ${gate.outer ?? 0} of ${gate.outerNeed ?? 0} nodes on 'outer.${outer ?? ''}'`;
  }
  if (gate !== null && refusal.reason === 'fusionGate') {
    return (
      `with ${gate.center} of ${gate.centerNeed} nodes on '${web.character}.center' and ` +
      `${gate.outer ?? 0} of ${gate.outerNeed ?? 0} on 'outer.${outer ?? ''}'`
    );
  }
  return `on '${at}'`;
}

/**
 * A witness's fillers before step `node` (§4.8): a threshold's board filled to its gate, a core's
 * center to 8 and then its outer to 6; before any other step, `progress` as it is.
 */
function fillersFor(
  web: AssembledWeb,
  progress: CharacterProgress,
  node: WebNode,
): CharacterProgress {
  const outer = outerOfBoard(node.board);
  const center: BoardId = `${web.character}.center`;
  const centerAt = (need: number) => (p: CharacterProgress) => boardCounts(web, p).center >= need;
  const outerAt = (o: NonNullable<typeof outer>, need: number) => (p: CharacterProgress) =>
    (boardCounts(web, p).outers[o] ?? 0) >= need;
  if (node.kind === 'threshold') {
    return outer === null
      ? fillBoard(web, progress, AUDIT_ACCOUNT, center, centerAt(WEB_RULES.centerThreshold))
      : fillBoard(
          web,
          progress,
          AUDIT_ACCOUNT,
          node.board,
          outerAt(outer, WEB_RULES.outerThreshold),
        );
  }
  if (node.kind === 'core' && outer !== null) {
    const filled = fillBoard(
      web,
      progress,
      AUDIT_ACCOUNT,
      center,
      centerAt(WEB_RULES.fusionCenter),
    );
    return fillBoard(
      web,
      filled,
      AUDIT_ACCOUNT,
      `outer.${outer}`,
      outerAt(outer, WEB_RULES.fusionOuter),
    );
  }
  return progress;
}

/**
 * Why no legal order reaches `target` (§4.8's witness), or null when one does: the shortest route
 * from the root through nodes that are not gated or sit on the target's own fusion or ascendancy
 * board; before each gated step, fillers on its board until its count is met. Only the target's
 * own core or ★ is bought, so the slot and ★ caps never bind.
 */
function witness(web: AssembledWeb, target: WebNode): string | null {
  const own = chainOfBoard(target.board) !== null || target.board.startsWith('fusion.');
  let progress = auditStart(web, chainOfBoard(target.board) !== null);
  const route = shortestRoute(
    web,
    progress,
    target.id,
    (node) => !GATED_KINDS.has(node.kind) || (own && node.board === target.board),
  );
  if (route === null) {
    const check = canBuy(web, progress, AUDIT_ACCOUNT, target.id);
    const reason: BuyReason = check.ok ? 'notAdjacent' : check.reason;
    return `it stopped at ${reason} with no path from '${web.root}'`;
  }
  for (const id of route) {
    progress = fillersFor(web, progress, web.byId.get(id) as WebNode);
    const step = auditBuy(web, progress, AUDIT_ACCOUNT, id);
    if (!step.ok) return `it stopped at ${step.refusal.reason} ${stateOf(web, id, step.refusal)}`;
    progress = step.progress;
  }
  return null;
}

/**
 * V15 (§4.8): from empty progress with an unlimited wallet, a legal purchase order reaches every
 * visible node of the web (the signature is owned), under the six rules: fusion by fusion, ★ by ★,
 * ascendancy nodes after a prestige with their chain chosen, best wave 30 within the wave cap.
 * `node '<id>' (character '<c>', scope '<s>'): no legal order reaches it; it stopped at <reason>
 * <state>`.
 */
export function buyabilityIssues(web: AssembledWeb): string[] {
  const revealed = revealedOuters(web.def, auditWave(web));
  const issues: string[] = [];
  for (const node of web.nodes) {
    if (node.kind === 'signature') continue;
    const outer = outerOfBoard(node.board);
    if (outer !== null && !revealed.has(outer)) continue;
    const stop = witness(web, node);
    if (stop !== null) {
      issues.push(
        `node '${node.id}' (character '${web.character}', scope '${web.scope.name}'): ` +
          `no legal order reaches it; ${stop}`,
      );
    }
  }
  return issues;
}

/** "another …" for one missing, "n more …" for more. */
const more = (missing: number, one: string, many: string): string =>
  missing === 1 ? `another ${one}` : `${missing} more ${many}`;

/** What a V25 message tells the author to do, per reason (D23's `; <what to do>`). */
const ORDER_FIXES: Readonly<
  Record<
    BuyReason,
    (web: AssembledWeb, refusal: Refusal, id: string, chosen: string | null) => string
  >
> = {
  unknown: (web, _refusal, id) => {
    const near = nearestName(id, web.byId.keys());
    return near === null
      ? `no node of web '${web.character}' has this id`
      : `did you mean '${near}'?`;
  },
  owned: () => 'it has 1 rank; drop the repeat',
  maxRank: (web, _refusal, id) => {
    const ranks = web.byId.get(id)?.ranks;
    return `it has ${String(ranks)} ranks; drop the repeat`;
  },
  hidden: (web) => `its outer is hidden at best wave ${auditWave(web)}; leave it out`,
  locked: (web) => `scope '${web.scope.name}' locks its board; leave it out`,
  challengeKeystone: () => 'a challenge forbids it',
  challengeOuter: () => 'a challenge forbids it',
  needsPrestige: () => 'it needs a prestige',
  otherAscendancy: (_web, _refusal, _id, chosen) =>
    `the order chose ascendancy '${chosen ?? ''}' first; keep to one chain`,
  notAdjacent: () => 'move it after one of its neighbours',
  centerGate: (_web, refusal) => {
    const gate = refusal.gate;
    const missing = gate === null ? 1 : gate.centerNeed - gate.center;
    return `move it after ${more(missing, 'center node', 'center nodes')}`;
  },
  outerGate: (web, refusal, id) => {
    const gate = refusal.gate;
    const missing = gate === null ? 1 : (gate.outerNeed ?? 0) - (gate.outer ?? 0);
    const board = web.byId.get(id)?.board ?? '';
    return `move it after ${more(missing, 'node', 'nodes')} on '${board}'`;
  },
  fusionGate: (web, _refusal, id) => {
    const outer = outerOfBoard(web.byId.get(id)?.board ?? 'hub') ?? '';
    return (
      `move it after the center has ${WEB_RULES.fusionCenter} and 'outer.${outer}' ` +
      `${WEB_RULES.fusionOuter} nodes`
    );
  },
  noFusionSlot: () => `the order holds ${fusionSlots(AUDIT_ACCOUNT)} cores already; leave one out`,
  keystoneCap: () => `the order holds ${WEB_RULES.keystonesHeld} ★ already; leave one out`,
  notEnoughShards: () => 'the price is above the wallet',
  notEnoughCores: () => 'the price is above the wallet',
  notEnoughResonance: () => 'the price is above the wallet',
};

/** The state V25 prints after the reason: a gate's count (§4.8's 「centerGate with 11 of 12」). */
function orderState(web: AssembledWeb, refusal: Refusal, id: string): string {
  const gate = refusal.gate;
  if (gate === null) return '';
  if (refusal.reason === 'centerGate') return ` with ${gate.center} of ${gate.centerNeed}`;
  const board = web.byId.get(id)?.board ?? 'hub';
  if (refusal.reason === 'outerGate') {
    return ` with ${gate.outer ?? 0} of ${gate.outerNeed ?? 0} on '${board}'`;
  }
  return (
    ` with ${gate.center} of ${gate.centerNeed} center nodes and ` +
    `${gate.outer ?? 0} of ${gate.outerNeed ?? 0} on 'outer.${outerOfBoard(board) ?? ''}'`
  );
}

/**
 * V25 (§4.8): every defaultOrder id is a node of the web, and the list is a legal purchase order
 * from empty, ranks by repetition. `character '<c>' defaultOrder[<i>] '<id>' (<file>): <reason>
 * <state>; <what to do>`, the file the character's (rule (c)); each id the web does not hold, else
 * the first refused purchase.
 */
export function orderIssues(web: AssembledWeb): string[] {
  const order = web.def.defaultOrder;
  const file = fileOfBoard(`${web.character}.center`);
  const issue = (index: number, id: string, refusal: Refusal, chosen: string | null): string =>
    `character '${web.character}' defaultOrder[${index}] '${id}' (${file}): ` +
    `${refusal.reason}${orderState(web, refusal, id)}; ` +
    ORDER_FIXES[refusal.reason](web, refusal, id, chosen);
  const start = auditStart(web, false);
  const missing: string[] = [];
  order.forEach((id, index) => {
    if (web.byId.has(id)) return;
    const check = canBuy(web, start, AUDIT_ACCOUNT, id);
    if (!check.ok) missing.push(issue(index, id, check, null));
  });
  if (missing.length > 0) return missing;
  const result = replay(web, AUDIT_ACCOUNT, order);
  if (result.ok) return [];
  return [issue(result.index, result.id, result.refusal, result.progress.ascendancy)];
}
