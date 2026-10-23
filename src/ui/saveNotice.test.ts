/**
 * The text of a save notice (docs/v3 C8 design §2.3, T10): every SaveNotice kind maps to a key
 * both locales define, its values fill every placeholder and t() leaves none, in the words §2.3
 * drafts (refundedAll's as the lead's ruling P6 has them). The format is B1's: shards as the HUD
 * shows them, a character by its name key.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { formatNum } from '../core/format';
import { num } from '../core/num';
import { loadContent } from '../data/web';
import { LOCALES, MESSAGES, setLocale, t } from '../i18n';
import type { Locale } from '../i18n';
import type { SaveNotice } from '../save/profile';
import { saveNoticeText } from './saveNotice';
import type { NoticeFormat } from './saveNotice';

const CONTENT = loadContent();

const FORMAT: NoticeFormat = {
  shards: (value) => formatNum(value, { format: 'short' }),
  character: (c) => t(CONTENT.characters[c].nameKey),
};

const PENDING = { shards: num(2221.75), cores: 3, maxWave: 18 };

type Kind = SaveNotice['kind'];

/** A notice of every kind: a kind SaveNotice gains and this record lacks does not compile. */
const NOTICES: { readonly [K in Kind]: Extract<SaveNotice, { readonly kind: K }> } = {
  restored: { kind: 'restored', error: 'main: not JSON' },
  v1Waiting: { kind: 'v1Waiting', pending: PENDING },
  v1Claimed: { kind: 'v1Claimed', character: 'ice', pending: PENDING },
  // An ascendancy lost alone names no id (the lead's ruling P6).
  refundedAll: { kind: 'refundedAll', character: 'fire', ids: [] },
  dropped: { kind: 'dropped', character: 'summon', ids: ['summon.center.a', 'summon.center.b'] },
  newer: { kind: 'newer', version: 3 },
  unreadable: { kind: 'unreadable', errors: ['main: not JSON', 'backup: empty'] },
};

/** What each notice says in each locale. */
const TEXTS: Readonly<Record<Locale, Readonly<Record<Kind, string>>>> = {
  en: {
    restored: 'Your latest save could not be read; the backup was loaded.',
    v1Waiting:
      'Playtest progress waiting: 2.22K shards, 3 cores, best wave 18. Your first pick gets it.',
    v1Claimed: 'Frost Crystal got your playtest progress: 2.22K shards, 3 cores, best wave 18.',
    refundedAll:
      'Magma Core: some talents are not available in this version, so all talents were refunded.',
    dropped: 'Hive: 2 talents no longer fit the web and were refunded.',
    newer:
      'This save is from a newer version (save version 3). Update the game; progress here is not saved.',
    unreadable: 'Your save could not be read. Progress is not saved until you start over.',
  },
  'zh-TW': {
    restored: '最新的存檔讀不出來，已改讀備份。',
    v1Waiting: '試玩版的進度待領取：2.22K 碎片、3 核心、最遠第 18 波，給你第一個選的角色。',
    v1Claimed: '霜晶 拿到了試玩版的進度：2.22K 碎片、3 核心、最遠第 18 波。',
    refundedAll: '熔核 有天賦在這個版本無法使用，全部天賦都退還了。',
    dropped: '蜂巢 有 2 個天賦不再符合天賦網的規則，已經退還。',
    newer: '這份存檔來自較新的版本（存檔版本 3）。請更新遊戲；這裡的進度不會存下來。',
    unreadable: '存檔讀不出來。重新開始之前，進度不會存下來。',
  },
};

const placeholders = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();

describe('saveNoticeText (T10)', () => {
  afterEach(() => setLocale('en'));

  // T10 catches a missing zh-TW key.
  it.each(LOCALES)('%s: maps every kind to its key, each placeholder filled', (locale) => {
    setLocale(locale);
    for (const notice of Object.values(NOTICES)) {
      const { key, values } = saveNoticeText(notice, FORMAT);
      expect(key).toBe(`save.notice.${notice.kind}`);
      const template: string | undefined = MESSAGES[locale][key];
      expect(template?.trim(), `${locale} ${key}`).toBeTruthy();
      expect(placeholders(template ?? ''), `${locale} ${key}`).toEqual(Object.keys(values).sort());
      expect(t(key, values), `${locale} ${key}`).not.toMatch(/[{}]/);
    }
  });

  it.each(LOCALES)('%s: says what §2.3 drafts, shards formatted, the character named', (locale) => {
    setLocale(locale);
    for (const notice of Object.values(NOTICES)) {
      const { key, values } = saveNoticeText(notice, FORMAT);
      expect(t(key, values), `${locale} ${notice.kind}`).toBe(TEXTS[locale][notice.kind]);
    }
  });

  it('defines the eight save keys, the start-over button among them', () => {
    for (const locale of LOCALES) {
      const keys = Object.keys(MESSAGES[locale]).filter((key) => key.startsWith('save.'));
      expect(keys.sort(), locale).toEqual([
        'save.action.startOver',
        'save.notice.dropped',
        'save.notice.newer',
        'save.notice.refundedAll',
        'save.notice.restored',
        'save.notice.unreadable',
        'save.notice.v1Claimed',
        'save.notice.v1Waiting',
      ]);
    }
    expect(MESSAGES.en['save.action.startOver']).toBe('Start over');
    expect(MESSAGES['zh-TW']['save.action.startOver']).toBe('重新開始');
  });
});
