/**
 * Builds made by rule (docs/v3 C6 design D14, D26): a prefix of the 預設 build (defaultProgress),
 * any purchase order from empty (progressFromOrder) and a fusion's 固定投入 (unlockInvestment),
 * which calibration measures a fusion against. Each purchase is an audit purchase (the lead's
 * ruling R3): canBuy on a progress whose wallet holds that purchase's price, whose best wave is 30
 * (all 11 outers revealed; the scope's wave cap if lower) and which has a prestige when the order
 * holds an ascendancy node, so only the rules and the gates refuse, and spent ends as the true cost.
 * V15 and V25 (buyable.ts) make their purchases the same way.
 */

import { add } from '../../core/num';
import type { OuterId } from '../../data/sources';
import type { AssembledWeb, BoardId } from '../../data/web/types';
import {
  boardCounts,
  chainOfBoard,
  GATED_KINDS,
  isCenterBoard,
  storedRank,
  WEB_RULES,
} from './counts';
import { shortestRoute } from './path';
import { nextPrice } from './price';
import { buy, canBuy, emptyProgress } from './rules';
import type { AccountProgress, BuyCheck, CharacterProgress } from './types';

/** canBuy's answer when it refuses. */
export type Refusal = Extract<BuyCheck, { readonly ok: false }>;

/** The audits' best wave (R3): 30, which reveals all 11 outers (D20), or the scope's cap if lower. */
export function auditWave(web: AssembledWeb): number {
  return Math.min(WEB_RULES.revealWaves[1], web.scope.waveCap ?? Infinity);
}

/** True when `id` is an ascendancy node of the web. */
export function isAscendancy(web: AssembledWeb, id: string): boolean {
  const node = web.byId.get(id);
  return node !== undefined && chainOfBoard(node.board) !== null;
}

/** An audit's start (R3): emptyProgress at the audits' best wave, with a prestige if `prestiged`. */
export function auditStart(web: AssembledWeb, prestiged: boolean): CharacterProgress {
  return {
    ...emptyProgress(web.character),
    bestWave: auditWave(web),
    prestiges: prestiged ? 1 : 0,
  };
}

export type AuditStep =
  | { readonly ok: true; readonly progress: CharacterProgress }
  | { readonly ok: false; readonly refusal: Refusal };

/** One audit purchase (R3): the wallet credited with the price, then canBuy and buy. */
export function auditBuy(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  id: string,
): AuditStep {
  const price = web.byId.has(id) ? nextPrice(web, progress, id) : null;
  const credited: CharacterProgress =
    price === null
      ? progress
      : {
          ...progress,
          wallet: {
            shards: add(progress.wallet.shards, price.shards),
            cores: progress.wallet.cores + price.cores,
            resonance: progress.wallet.resonance + price.resonance,
          },
        };
  const check = canBuy(web, credited, account, id);
  if (!check.ok) return { ok: false, refusal: check };
  return { ok: true, progress: buy(web, credited, account, id) };
}

export type Replay =
  | { readonly ok: true; readonly progress: CharacterProgress }
  | {
      readonly ok: false;
      readonly index: number;
      readonly id: string;
      readonly refusal: Refusal;
      /** The progress before the refused purchase. */
      readonly progress: CharacterProgress;
    };

/** `order`'s audit purchases from empty, ranks by repetition, up to the first refusal. */
export function replay(
  web: AssembledWeb,
  account: AccountProgress,
  order: readonly string[],
): Replay {
  let progress = auditStart(
    web,
    order.some((id) => isAscendancy(web, id)),
  );
  for (const [index, id] of order.entries()) {
    const step = auditBuy(web, progress, account, id);
    if (!step.ok) return { ok: false, index, id, refusal: step.refusal, progress };
    progress = step.progress;
  }
  return { ok: true, progress };
}

/** The purchases of `order` from empty, each checked by canBuy; throws at the first refusal with its reason. */
export function progressFromOrder(
  web: AssembledWeb,
  account: AccountProgress,
  order: readonly string[],
): CharacterProgress {
  const result = replay(web, account, order);
  if (!result.ok) {
    throw new Error(
      `progressFromOrder (character '${web.character}', scope '${web.scope.name}'): ` +
        `order[${result.index}] '${result.id}' refused: ${result.refusal.reason}`,
    );
  }
  return result.progress;
}

/** The first `count` purchases of defaultOrder (all by default), each checked by canBuy. */
export function defaultProgress(
  web: AssembledWeb,
  account: AccountProgress,
  count?: number,
): CharacterProgress {
  const order = web.def.defaultOrder;
  return progressFromOrder(
    web,
    account,
    count === undefined ? order : order.slice(0, Math.max(0, count)),
  );
}

/**
 * The nodes of `board` not owned and not of a gated kind, breadth-first from the owned nodes and
 * the root, a level at a time in web order.
 */
function boardOrder(web: AssembledWeb, progress: CharacterProgress, board: BoardId): string[] {
  const order = new Map(web.nodes.map((node, index) => [node.id, index]));
  const byOrder = (a: string, b: string): number =>
    (order.get(a) as number) - (order.get(b) as number);
  let level = web.nodes
    .filter((node) => node.id === web.root || storedRank(progress, node.id) > 0)
    .map((node) => node.id);
  const seen = new Set(level);
  const found: string[] = [];
  while (level.length > 0) {
    const next: string[] = [];
    for (const id of level) {
      for (const other of web.neighbours.get(id) ?? []) {
        const node = web.byId.get(other);
        if (seen.has(other) || node === undefined) continue;
        if (node.board !== board || GATED_KINDS.has(node.kind)) continue;
        seen.add(other);
        next.push(other);
      }
    }
    level = next.sort(byOrder);
    found.push(...level);
  }
  return found;
}

/**
 * Fillers (§4.8's witness; D26): nodes of `board` bought breadth-first from the owned nodes and the
 * root, never a gated kind, each at rank 1, until `done` holds or none is left; one the audit
 * refuses is passed over.
 */
export function fillBoard(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  board: BoardId,
  done: (progress: CharacterProgress) => boolean,
): CharacterProgress {
  let current = progress;
  if (done(current)) return current;
  for (const id of boardOrder(web, current, board)) {
    const step = auditBuy(web, current, account, id);
    if (!step.ok) continue;
    current = step.progress;
    if (done(current)) break;
  }
  return current;
}

/**
 * 固定投入 of fusion c.o (D26): its unlock gate at rank 1, without the core. The center nodes of
 * defaultOrder, each once, while fewer than 8 are counted (one canBuy refuses then, reached in the
 * order through another board, is passed over); the shortest path from them to the outer's entry,
 * whose center and hub nodes count as they come; the center filled breadth-first to 8 counted; the
 * outer filled breadth-first from its entry to 6. Never a gated kind outside defaultOrder, never
 * the core. Throws when the fusion is not in the web or its gate cannot be met.
 */
export function unlockInvestment(
  web: AssembledWeb,
  account: AccountProgress,
  outer: OuterId,
): CharacterProgress {
  const key = `${web.character}.${outer}`;
  const at = `unlockInvestment '${key}' (scope '${web.scope.name}')`;
  const entry = web.nodes.find(
    (node) => node.board === `outer.${outer}` && node.slot.at === 'outerEntry',
  );
  if (!web.fusions.has(outer) || entry === undefined) {
    throw new Error(`${at}: the fusion or its outer's entry is not in web '${web.character}'`);
  }
  const centerDone = (p: CharacterProgress): boolean =>
    boardCounts(web, p).center >= WEB_RULES.fusionCenter;
  const outerDone = (p: CharacterProgress): boolean =>
    (boardCounts(web, p).outers[outer] ?? 0) >= WEB_RULES.fusionOuter;
  let progress = auditStart(web, false);
  for (const id of web.def.defaultOrder) {
    if (centerDone(progress)) break;
    const node = web.byId.get(id);
    if (node === undefined || !isCenterBoard(node.board) || storedRank(progress, id) > 0) continue;
    const step = auditBuy(web, progress, account, id);
    if (step.ok) progress = step.progress;
  }
  const route = shortestRoute(web, progress, entry.id, (node) => !GATED_KINDS.has(node.kind));
  if (route === null) throw new Error(`${at}: no path reaches '${entry.id}'`);
  for (const id of route) {
    const step = auditBuy(web, progress, account, id);
    if (!step.ok) throw new Error(`${at}: '${id}' refused: ${step.refusal.reason}`);
    progress = step.progress;
  }
  progress = fillBoard(web, progress, account, `${web.character}.center`, centerDone);
  progress = fillBoard(web, progress, account, entry.board, outerDone);
  if (!centerDone(progress) || !outerDone(progress)) {
    const counts = boardCounts(web, progress);
    throw new Error(
      `${at}: its gate is not met, center ${counts.center} of ${WEB_RULES.fusionCenter} and ` +
        `'outer.${outer}' ${counts.outers[outer] ?? 0} of ${WEB_RULES.fusionOuter}`,
    );
  }
  return progress;
}
