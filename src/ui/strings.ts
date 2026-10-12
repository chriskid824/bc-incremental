/** Display helpers for player-visible text; the text itself lives in src/i18n. */

import type { TalentNode } from '../data/types';
import { isMessageKey, t } from '../i18n';

/** Localized talent name; the id if its nameKey has no message (tests prevent that). */
export function talentName(node: Pick<TalentNode, 'id' | 'nameKey'>): string {
  return isMessageKey(node.nameKey) ? t(node.nameKey) : node.id;
}

/** Run time as m:ss, rounding down. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
