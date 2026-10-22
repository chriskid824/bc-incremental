/**
 * Which outers a character sees (docs/v3 C6 design D20, §4.6, F15): derived from the stored
 * all-time best wave, never stored (impl:508), so it never shrinks (「轉生後不會再藏起來」). An outer
 * outside the scope stays locked before and after its reveal wave: the Demo lock wins (AMB35).
 */

import { OUTER_IDS } from '../../data/sources';
import type { OuterId } from '../../data/sources';
import type { AssembledWeb, CharacterDef } from '../../data/web/types';
import { WEB_RULES } from './counts';
import type { CharacterProgress, OuterView } from './types';

/**
 * The three recommended outers; from best wave 15 revealAt15 too; from 30 all 11 (impl:393;
 * gd:302-306).
 */
export function revealedOuters(def: CharacterDef, bestWave: number): ReadonlySet<OuterId> {
  const [w15, w30] = WEB_RULES.revealWaves;
  if (bestWave >= w30) return new Set(OUTER_IDS.filter((o) => o !== def.id));
  return new Set(
    bestWave >= w15 ? [...def.recommendedOuter, ...def.revealAt15] : def.recommendedOuter,
  );
}

/**
 * outerView on a set revealedOuters gave: a board the scope locks is locked whatever the wave
 * (F15); one that is absent, or the character's own clock, which holds no outer, absent.
 */
export function viewIn(
  web: AssembledWeb,
  revealed: ReadonlySet<OuterId>,
  outer: OuterId,
): OuterView {
  const board = web.boards.find((candidate) => candidate.id === `outer.${outer}`);
  if (board === undefined || board.status === 'absent') return 'absent';
  if (board.status === 'locked') return 'locked';
  return revealed.has(outer) ? 'open' : 'hidden';
}

/** A board absent → 'absent'; locked → 'locked'; not revealed → 'hidden'; else 'open' (§4.6). */
export function outerView(
  web: AssembledWeb,
  progress: CharacterProgress,
  outer: OuterId,
): OuterView {
  return viewIn(web, revealedOuters(web.def, progress.bestWave), outer);
}
