/**
 * What the build's flavor lets the v3 game page show (docs/v3/game-design-v3.md §1.1, §10; the B2
 * row of docs/v3/implementation-plan-v3.md §8.1): the Demo assembles every web in DEMO_SCOPE_A,
 * the Demo's only definition (src/data/web/scope.ts; the nightly's Demo rows read the same
 * constant), and the full game in FULL_SCOPE. A character outside the scope is locked with
 * 「完整版」; one in it whose center is not written yet is 「製作中」. DOM-free, so the tests reach it.
 */

import type { CharacterId } from '../../data/sources';
import { DEMO_SCOPE_A, FULL_SCOPE, scopeHolds } from '../../data/web';
import type { Content, WebScope } from '../../data/web';
import type { Flavor } from '../../platform/flavor';

/** The scope the page assembles webs in: DEMO_SCOPE_A in the Demo, else FULL_SCOPE. */
export function gameScope(flavor: Flavor): WebScope {
  return flavor === 'demo' ? DEMO_SCOPE_A : FULL_SCOPE;
}

/**
 * Why a select card cannot be picked: 'fullVersion' outside the scope (the Demo's 霜晶 and 雷塔,
 * gd:43), 'inProgress' while its center is not written (「製作中」); null when it is playable.
 */
export type CardLock = 'fullVersion' | 'inProgress' | null;

export function cardLock(content: Content, scope: WebScope, c: CharacterId): CardLock {
  if (!scopeHolds(scope.characters, c)) return 'fullVersion';
  return content.characters[c].center === null ? 'inProgress' : null;
}

/** The result screens that offer 「換一個角色試試」: the account's first 3 runs (gd §1.1, §9). */
export const SWITCH_HINT_RUNS = 3;

/**
 * Whether a result screen shows 「換一個角色試試」: `runs`, the account's runs with this one counted
 * (save v2's account.stats.runs), within SWITCH_HINT_RUNS, and a second character playable.
 */
export function showsSwitchHint(runs: number, playable: number): boolean {
  return playable >= 2 && runs >= 1 && runs <= SWITCH_HINT_RUNS;
}
