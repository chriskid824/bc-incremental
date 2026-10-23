/**
 * The 傳承 (legacy) transition of character sessions (docs/v3 C10 design §2.2's legacy row), a hook
 * like PRESTIGE (tools/balance/v3/prestige.ts). Until B5 writes 傳承 in src/meta, LEGACY is null:
 * the legacy check reads noLegacy, and the clear's checks noSingularity, since 奇點 and the clear
 * land with 傳承 in B5 (implementation-plan-v3 §8.1). B5 sets LEGACY to its transition; the checks
 * then play the second characters' default sessions from the account the first one leaves.
 */

import type { AccountProgress } from '../../../src/meta/web';
import type { CharacterSessionResult } from './session';

export interface LegacyHook {
  /** The account a character's session starts from after `first`'s session on `account`. */
  accountAfter(first: CharacterSessionResult, account: AccountProgress): AccountProgress;
}

/** None before B5, which sets it to its src/meta transition. */
export const LEGACY: LegacyHook | null = null;
