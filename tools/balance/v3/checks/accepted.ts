/**
 * FAILs accepted on purpose (docs/v3 C10 design §1.4): a check's FAIL whose key is here prints
 * `FAIL (accepted: <reason>)` and does not fail the run. Fusion strength reads
 * content.acceptedFails instead (src/data/fusion/overrides.ts' ACCEPTED_FAILS; C6F F21).
 */

import type { CheckResult } from './types';

/** The key of a check's result: `${id}:${subject}`, e.g. 'pacing:fire @ 10 min'. */
export const acceptedKey = (result: Pick<CheckResult, 'id' | 'subject'>): string =>
  `${result.id}:${result.subject}`;

/** `table` as it is; throws for an entry whose reason is empty or blank. */
export function acceptedFails(
  table: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  for (const [key, reason] of Object.entries(table)) {
    if (reason.trim() === '') {
      throw new Error(`Accepted check FAIL '${key}' has no reason: give one, or drop the entry`);
    }
  }
  return table;
}

/** Accepted FAILs by acceptedKey, each with its reason; checked when this module loads. */
export const ACCEPTED_CHECK_FAILS: Readonly<Record<string, string>> = acceptedFails({
  // B2 (PR #6) lands the real prestige: 熔核 sessions now prestige at about 45 min and climb back
  // from wave 1, so the 60-min front reads the climb. B1 owns the economy and re-tunes it
  // against the hook, then drops this entry (蜂巢 passes at 60 min since E5).
  'pacing:fire @ 60 min':
    'real prestige landed in PR #6; post-prestige climb back to be re-tuned by B1',
});
