/**
 * The prestige transition of character sessions (docs/v3 C10 design §1.2, §3.2, C10/F13): PRESTIGE
 * is B2's src/meta transition (src/meta/web/prestige.ts) with a bot's rule for when to take it.
 * Sessions prestige when shouldPrestige says so, go on, and stop at the clear (the Demo's at its
 * wave-40 cap) or the play-time budget.
 */

import type { AssembledWeb } from '../../../src/data/web';
import { canPrestige, prestige } from '../../../src/meta/web';
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

/**
 * Stalled runs before the first prestige (初始值): gd §9's 「第 30 波：第一次轉生」 at about 0:45
 * is a player who pushes on past wave 30 while it still moves and prestiges once it stops.
 */
export const FIRST_PRESTIGE_STALL = 3;
/**
 * Stalled runs before a later prestige (初始值): twice the session's WALL_STALL_RUNS (5,
 * session.ts), so a bot always meets gd §9's wall (5 runs without a new cycleBest after the first
 * prestige) and the wall milestone reads it before the bot prestiges through it (C10 design §3.2).
 */
export const LATER_PRESTIGE_STALL = 10;

/**
 * The bots' rule: allowed (cycleBest ≥ 30), and the cycle stalled for FIRST_PRESTIGE_STALL runs
 * before the first prestige, LATER_PRESTIGE_STALL after it.
 */
export function shouldPrestige(state: PrestigeState): boolean {
  if (!canPrestige(state.progress)) return false;
  const stall = state.prestiges === 0 ? FIRST_PRESTIGE_STALL : LATER_PRESTIGE_STALL;
  return state.runsSinceNewBest >= stall;
}

/** B2's transition: src/meta's prestige; the account's legacy rewards are B5's. */
export const PRESTIGE: PrestigeHook | null = {
  shouldPrestige,
  apply: (_web, progress, account) => ({ progress: prestige(progress), account }),
};
