/**
 * Random legal builds for the web fuzz (docs/v3 C6 design D25, §3.8, §4.9; AMB18): sampleProgress
 * buys, one purchase after another, a node drawn uniformly among those canBuy accepts under an
 * unlimited wallet, until it has made its purchases or nothing is buyable, so every build is legal
 * under all six purchase rules (adjacency, the two thresholds, the fusion unlock, the slots and the
 * ★ cap). Every draw comes from the rng it is given. Only the fuzz uses it (src/meta/web/fuzz.ts).
 */

import { num, ZERO } from '../../core/num';
import type { Rng } from '../../core/rng';
import type { AssembledWeb } from '../../data/web/types';
import { buy, canBuy, emptyProgress } from './rules';
import type { AccountProgress, CharacterProgress, Wallet } from './types';

export interface SampleOptions {
  /** The purchases to make, ranks by repetition; fewer when nothing is left to buy. */
  readonly purchases: number;
  readonly account: AccountProgress;
  /** The best wave, which sets the outers revealed (D20). */
  readonly bestWave: number;
  /** One prestige, which opens the ascendancy nodes: the chain is the first one bought (F10). */
  readonly prestiged: boolean;
}

/** A wallet canBuy never refuses (row 12), while sampling. */
const UNLIMITED: Wallet = { shards: num(Infinity), cores: Infinity, resonance: Infinity };
const EMPTY: Wallet = { shards: ZERO, cores: 0, resonance: 0 };

/**
 * A random legal progress on `web` (D25): from empty, at `bestWave` and with a prestige when
 * `prestiged`, each purchase a node drawn uniformly among those canBuy accepts with an unlimited
 * wallet, made through buy. The draw is among the open nodes, the only ones rows 2 and 6 let canBuy
 * accept: unowned ones next to the root or an owned node, and owned ones below their last rank. A
 * node drawn and refused is dropped and the draw repeated, which picks uniformly among the
 * accepted ones. It stops after `purchases` purchases or when canBuy accepts nothing. The progress
 * returned holds an empty wallet, and spent the purchases' price.
 */
export function sampleProgress(
  web: AssembledWeb,
  rng: Rng,
  options: SampleOptions,
): CharacterProgress {
  let progress: CharacterProgress = {
    ...emptyProgress(web.character),
    wallet: UNLIMITED,
    bestWave: options.bestWave,
    prestiges: options.prestiged ? 1 : 0,
  };
  // The open nodes in the order they opened, kept as purchases are made, not found by a scan.
  const open = new Set<string>();
  const reach = (from: string): void => {
    for (const id of web.neighbours.get(from) ?? []) {
      if (web.byId.get(id)?.kind !== 'signature' && !Object.hasOwn(progress.ranks, id))
        open.add(id);
    }
  };
  reach(web.root);
  for (let n = 0; n < options.purchases; n++) {
    const pool = [...open];
    let bought: string | null = null;
    while (pool.length > 0) {
      const i = rng.int(pool.length);
      const id = pool[i] as string;
      if (canBuy(web, progress, options.account, id).ok) {
        progress = buy(web, progress, options.account, id);
        bought = id;
        break;
      }
      pool[i] = pool[pool.length - 1] as string;
      pool.pop();
    }
    if (bought === null) break;
    const { ranks } = web.byId.get(bought) as { readonly ranks: number | 'unlimited' };
    if (ranks !== 'unlimited' && (progress.ranks[bought] as number) >= ranks) open.delete(bought);
    reach(bought);
  }
  return { ...progress, wallet: EMPTY };
}
