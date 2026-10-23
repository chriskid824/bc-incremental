/**
 * The text of a save notice (docs/v3 C8 design §2.3; SaveNotice in src/save/profile.ts): its
 * `save.notice.*` key and the values to fill it with, for B1 to show as t(key, values). The values
 * are formatted before they are passed (src/i18n/index.ts): `format` names the character (B1:
 * t(def.nameKey), web.char.<c>.name) and formats shards (src/core/format.ts), and the whole
 * numbers (cores, a wave, a count, a version) go as they are, as the HUD passes cores. The errors
 * of `restored`, `unreadable` and `readFailed` are for the log, not the player. DOM-free so tests
 * can run it.
 */

import type { Num } from '../core/num';
import type { CharacterId } from '../data/sources';
import type { MessageKey, MessageValues } from '../i18n';
import type { SaveNotice } from '../save/profile';

export interface NoticeFormat {
  shards(value: Num): string;
  character(c: CharacterId): string;
}

export interface NoticeText {
  readonly key: MessageKey;
  readonly values: MessageValues;
}

export function saveNoticeText(notice: SaveNotice, format: NoticeFormat): NoticeText {
  switch (notice.kind) {
    case 'restored':
      return { key: 'save.notice.restored', values: {} };
    case 'v1Waiting': {
      const { shards, cores, maxWave } = notice.pending;
      return {
        key: 'save.notice.v1Waiting',
        values: { shards: format.shards(shards), cores, wave: maxWave },
      };
    }
    case 'v1Claimed': {
      const { shards, cores, maxWave } = notice.pending;
      return {
        key: 'save.notice.v1Claimed',
        values: {
          character: format.character(notice.character),
          shards: format.shards(shards),
          cores,
          wave: maxWave,
        },
      };
    }
    case 'refundedAll':
      // No count (the lead's ruling P6): an ascendancy lost alone names no id, and a Demo scope
      // locks boards that are not gone.
      return {
        key: 'save.notice.refundedAll',
        values: { character: format.character(notice.character) },
      };
    case 'dropped':
      return {
        key: 'save.notice.dropped',
        values: { character: format.character(notice.character), count: notice.ids.length },
      };
    case 'newer':
      return { key: 'save.notice.newer', values: { version: notice.version } };
    case 'unreadable':
      return { key: 'save.notice.unreadable', values: {} };
    // No button: the restart is the player's, and 重新開始 stays unreadable's.
    case 'readFailed':
      return { key: 'save.notice.readFailed', values: {} };
  }
}
