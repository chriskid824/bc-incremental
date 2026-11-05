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
  // B3 (PR #8) adds 霜晶, pending Hoshi's call on its late game: its runs stall near wave 40
  // (the 180 s run cap and the wave-40 onion), and it has no ascendancy before B5, which carries
  // 熔核's and 蜂巢's late damage. Its first run also lasts to wave 5 on the faster fan.
  'pacing:ice @ 0 min':
    'B3: the faster fan (3.75 rounds/s) holds the first waves; first run reaches wave 5',
  'pacing:ice @ 60 min': 'B3: post-prestige climb back, as fire @ 60 min',
  'pacing:ice @ 180 min':
    'B3: late game stalls near wave 40 without ascendancies (B5); pending Hoshi',
  'pacing:ice @ 300 min':
    'B3: late game stalls near wave 40 without ascendancies (B5); pending Hoshi',
  // With 霜晶 the median front at 30 min is 24 (霜晶 and 蜂巢), and 熔核's 27 sits 12.5 % above it.
  'newbie:all @ 30 min':
    'B3: 熔核 runs 12.5 % ahead of 霜晶 and 蜂巢 at 30 min; re-tune with the late game',
  // bfb07af's bot fix: default shares greedy's memory, so once the preset order runs out it keeps
  // buying instead of stalling, and 蜂巢's sessions reach a median of about wave 84-87 at 180 min
  // (66.5-70.5 before). The game did not change. Hoshi's 11-05 answer keeps the numbers until the
  // post-prestige run is redesigned after the Demo (before B5); that work drops this entry.
  'pacing:summon @ 180 min':
    'default bot stopped stalling (bfb07af); post-prestige pacing re-tuned after the Demo',
});
