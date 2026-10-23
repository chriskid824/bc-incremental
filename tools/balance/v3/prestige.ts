/**
 * The prestige transition of character sessions (docs/v3 C10 design §1.2, C10/F13). Until B2
 * writes it in src/meta, PRESTIGE is null and a session stops after its first run that ends with
 * cycleBest ≥ PRESTIGE_WAVE (tools/balance/v3/session.ts): the first prestige point. B2 sets
 * PRESTIGE to its transition; sessions then prestige when it says so, go on and stop at the clear.
 */

import type { AssembledWeb } from '../../../src/data/web';
import type { AccountProgress, CharacterProgress, WebEconomy } from '../../../src/meta/web';

/** What a session knows when it asks whether to prestige, after a run and its visit. */
export interface PrestigeState {
  readonly progress: CharacterProgress;
  /** Runs in a row, this one included, that raised no cycleBest. */
  readonly runsSinceNewBest: number;
  /** Play time at the end of the run. */
  readonly minutes: number;
  readonly prestiges: number;
}

export interface PrestigeHook {
  shouldPrestige(state: PrestigeState): boolean;
  apply(
    web: AssembledWeb,
    progress: CharacterProgress,
    account: AccountProgress,
    economy: WebEconomy,
  ): { readonly progress: CharacterProgress; readonly account: AccountProgress };
}

/** None before B2, which sets it to its src/meta transition. */
export const PRESTIGE: PrestigeHook | null = null;
