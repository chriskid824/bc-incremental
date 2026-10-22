/**
 * Prices of the v3 web (docs/v3 C6 design D19, §4.5, F17): one canonical shard curve per kind, so
 * k purchases cost base × (g^k − 1) / (g − 1) in any order and a refund is the difference of two
 * closed forms; plus each kind's cores and 迴響. Shard values are Num (src/core/num.ts).
 */

import { add, div, gt, mul, num, ONE, pow, sub, toNumber, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { AssembledWeb, WebNode, WebNodeKind } from '../../data/web/types';
import { boardCounts, PRICE_CURVE_OF, storedRank } from './counts';
import type { BoardCounts, CharacterProgress, Price, PriceCurve, WebEconomy } from './types';

export { PRICE_CURVE_OF } from './counts';

/**
 * 初始值; C10 retunes them through the simulator (gd:322). Steps start at M1's 180 × 1.31
 * (DEFAULT_ECONOMY's talentBaseShards and talentGrowth, src/meta/types.ts), masteries and 強化∞ at
 * 300 × 1.4, the repeat of M1's one repeatable node, might (src/data/talents.ts); ★ 3 cores,
 * thresholds 2, ◆ and cores 1 (gd:971-974); 1 迴響 an ascendancy node (gd:977); the start-wave
 * ratio and skip reward as DEFAULT_ECONOMY's.
 */
export const DEFAULT_WEB_ECONOMY: WebEconomy = {
  step: { base: 180, growth: 1.31 },
  mastery: { base: 300, growth: 1.4 },
  might: { base: 300, growth: 1.4 },
  cores: {
    signature: 0,
    ranked: 0,
    notable: 1,
    threshold: 2,
    keystone: 3,
    mastery: 0,
    might: 0,
    entry: 0,
    core: 1,
    asc: 0,
    ascFinal: 0,
  },
  resonance: {
    signature: 0,
    ranked: 0,
    notable: 0,
    threshold: 0,
    keystone: 0,
    mastery: 0,
    might: 0,
    entry: 0,
    core: 0,
    asc: 1,
    ascFinal: 1,
  },
  startWaveRatio: 0.5,
  skipRewardRate: 1,
};

const CURVES = ['step', 'mastery', 'might'] as const;
type CurveId = (typeof CURVES)[number];

/** The purchases counted on `curve` (BoardCounts). */
function countOn(curve: CurveId, counts: BoardCounts): number {
  if (curve === 'step') return counts.stepPurchases;
  return curve === 'mastery' ? counts.masteryRanks : counts.mightRanks;
}

/** The shards of a curve's purchase at count k: base × growth^k, in M1's order (nodePrice). */
function curvePrice(curve: PriceCurve, k: number): Num {
  return mul(pow(num(curve.growth), k), curve.base);
}

/** The shards of a curve's first k purchases: base × (g^k − 1) / (g − 1), or base × k at g = 1. */
function curveSum(curve: PriceCurve, k: number): Num {
  if (k === 0) return ZERO;
  if (curve.growth === 1) return mul(num(curve.base), k);
  return mul(div(sub(pow(num(curve.growth), k), ONE), curve.growth - 1), curve.base);
}

/** The price of `node`'s next rank on these counts (nextPrice without recounting). */
export function priceOf(node: WebNode, counts: BoardCounts, economy: WebEconomy): Price {
  const curve = PRICE_CURVE_OF[node.kind];
  return {
    shards: curve === null ? ZERO : curvePrice(economy[curve], countOn(curve, counts)),
    cores: economy.cores[node.kind],
    resonance: economy.resonance[node.kind],
  };
}

/**
 * The price of the next rank of `id`: base × growth^k shards on its kind's curve, k being the
 * purchases already counted on that curve (boardCounts), plus its kind's cores and 迴響. Throws
 * for an id outside the web; canBuy says `unknown` for one.
 */
export function nextPrice(
  web: AssembledWeb,
  progress: CharacterProgress,
  id: string,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
): Price {
  const node = web.byId.get(id);
  if (node === undefined) {
    throw new Error(
      `nextPrice: '${id}' is not a node of web '${web.character}' in scope '${web.scope.name}'`,
    );
  }
  return priceOf(node, boardCounts(web, progress), economy);
}

/**
 * What the owned nodes cost bought in any order: Σ over the curves of base × (g^k − 1) / (g − 1),
 * plus the cores and 迴響 of every owned rank. Ids outside the web have no kind to price them by
 * and count nothing; spent keeps what they cost for refundAll (§6).
 */
export function canonicalCost(
  web: AssembledWeb,
  progress: CharacterProgress,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
): Price {
  const counts = boardCounts(web, progress);
  let shards = ZERO;
  for (const curve of CURVES)
    shards = add(shards, curveSum(economy[curve], countOn(curve, counts)));
  let cores = 0;
  let resonance = 0;
  for (const node of web.nodes) {
    if (node.kind === 'signature') continue;
    const rank = storedRank(progress, node.id);
    cores += rank * economy.cores[node.kind];
    resonance += rank * economy.resonance[node.kind];
  }
  return { shards, cores, resonance };
}

/** V16's cores and 迴響 per kind (gd:971-977). */
const PINNED_CORES: readonly (readonly [WebNodeKind, number])[] = [
  ['keystone', 3],
  ['threshold', 2],
  ['notable', 1],
  ['core', 1],
];
const PINNED_RESONANCE: readonly (readonly [WebNodeKind, number])[] = [
  ['asc', 1],
  ['ascFinal', 1],
];

/**
 * V16 (§4.8; S-3): each curve's base above 0, its growth above 1 and its price strictly rising
 * from count 0 to count 1, finite; cores ★ 3, threshold 2, ◆ and core 1; 1 迴響 an ascendancy
 * node. `name` is the subject of the messages, `economy '<name>': <problem>`.
 */
export function economyIssues(economy: WebEconomy, name = 'DEFAULT_WEB_ECONOMY'): string[] {
  const at = `economy '${name}'`;
  const issues: string[] = [];
  for (const id of CURVES) {
    const curve = economy[id];
    const baseOk = curve.base > 0;
    const growthOk = curve.growth > 1;
    if (!baseOk) issues.push(`${at}: ${id}.base ${curve.base} must be above 0`);
    if (!growthOk) issues.push(`${at}: ${id}.growth ${curve.growth} must be above 1`);
    const first = curvePrice(curve, 0);
    const second = curvePrice(curve, 1);
    if (baseOk && growthOk && !(Number.isFinite(toNumber(second)) && gt(second, first))) {
      issues.push(
        `${at}: ${id} price ${toNumber(second)} at count 1 must be above ` +
          `${toNumber(first)} at count 0 and finite`,
      );
    }
  }
  for (const [kind, cores] of PINNED_CORES) {
    if (economy.cores[kind] !== cores) {
      issues.push(`${at}: cores.${kind} ${economy.cores[kind]} must be ${cores}`);
    }
  }
  for (const [kind, resonance] of PINNED_RESONANCE) {
    if (economy.resonance[kind] !== resonance) {
      issues.push(`${at}: resonance.${kind} ${economy.resonance[kind]} must be ${resonance}`);
    }
  }
  return issues;
}
