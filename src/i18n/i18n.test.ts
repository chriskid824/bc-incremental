import { afterEach, describe, expect, it } from 'vitest';
import { AFFIX_IDS } from '../data/affixes';
import { STAT_IDS } from '../data/stats';
import { TALENTS } from '../data/talents';
import { LOCALES, MESSAGES, fill, getLocale, isMessageKey, pickLocale, setLocale, t } from '.';
import type { MessageKey } from '.';
import en from './en.json';
import webEn from './web.en.json';
import webZhTW from './web.zh-TW.json';
import zhTW from './zh-TW.json';

const placeholders = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();

const keys = Object.keys(MESSAGES.en) as MessageKey[];

describe('messages', () => {
  it.each(LOCALES)('%s has exactly the en keys, non-empty, with the same placeholders', (id) => {
    const messages = MESSAGES[id];
    expect(Object.keys(messages).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(messages[key].trim(), `${id} ${key}`).not.toBe('');
      expect(placeholders(messages[key]), `${id} ${key}`).toEqual(placeholders(MESSAGES.en[key]));
    }
  });

  it('names every talent', () => {
    for (const node of TALENTS) {
      expect(isMessageKey(node.nameKey), node.nameKey).toBe(true);
      if (node.descKey !== undefined) expect(isMessageKey(node.descKey), node.descKey).toBe(true);
    }
    expect(isMessageKey('talent.missing.name')).toBe(false);
    expect(isMessageKey('toString')).toBe(false);
  });

  it('defines each key in one file: no web key shadows an M1 key (docs/v3 C6 design D22)', () => {
    for (const [m1, web] of [
      [en, webEn],
      [zhTW, webZhTW],
    ] as const) {
      expect(Object.keys(web).filter((key) => Object.hasOwn(m1, key))).toEqual([]);
      expect(Object.keys(web).filter((key) => !key.startsWith('web.'))).toEqual([]);
    }
  });

  it('labels the ?hive prototype in both locales', () => {
    expect(MESSAGES.en['app.prototype.hive']).toBe('Hive prototype');
    expect(MESSAGES['zh-TW']['app.prototype.hive']).toBe('蜂巢原型');
  });

  it('asks for a restart when a save could not be read, in both locales (the lead’s ruling SR7)', () => {
    expect(MESSAGES.en['save.notice.readFailed']).toBe(
      'Your save could not be read just now. Progress is not saved until you restart the game.',
    );
    expect(MESSAGES['zh-TW']['save.notice.readFailed']).toBe(
      '存檔暫時讀不到。重新啟動遊戲之前，進度不會存下來。',
    );
  });

  it.each(LOCALES)('%s names every stat', (id) => {
    for (const stat of STAT_IDS) {
      const key = `stat.${stat}`;
      expect(isMessageKey(key), key).toBe(true);
      expect(MESSAGES[id][key as MessageKey]?.trim(), `${id} ${key}`).toBeTruthy();
    }
  });

  it.each(LOCALES)('%s names every affix (C7.6)', (id) => {
    for (const affix of AFFIX_IDS) {
      const key = `affix.${affix}.name`;
      expect(isMessageKey(key), key).toBe(true);
      expect(MESSAGES[id][key as MessageKey]?.trim(), `${id} ${key}`).toBeTruthy();
    }
  });
});

describe('t', () => {
  afterEach(() => setLocale('en'));

  it('uses the current locale and fills placeholders', () => {
    expect(getLocale()).toBe('en');
    expect(t('hud.run', { run: 3, startWave: 12 })).toBe('Run 3 · from wave 12');
    setLocale('zh-TW');
    expect(getLocale()).toBe('zh-TW');
    expect(t('hud.run', { run: 3, startWave: 12 })).toBe('第 3 局 · 從第 12 波開始');
    expect(t('hud.shards')).toBe('碎片');
  });
});

describe('fill', () => {
  it('replaces placeholders and leaves unknown ones', () => {
    expect(fill('Run {run} · from wave {startWave}', { run: 3, startWave: 12 })).toBe(
      'Run 3 · from wave 12',
    );
    expect(fill('{a} {b}', { a: 'x' })).toBe('x {b}');
  });
});

describe('pickLocale', () => {
  it('maps Traditional Chinese tags to zh-TW', () => {
    for (const tag of ['zh-TW', 'zh-tw', 'zh-Hant', 'zh-Hant-TW', 'zh-HK', 'zh-MO']) {
      expect(pickLocale([tag]), tag).toBe('zh-TW');
    }
  });

  it('takes the first supported tag and falls back to English', () => {
    expect(pickLocale(['fr-FR', 'zh-TW', 'en-US'])).toBe('zh-TW');
    expect(pickLocale(['en-GB', 'zh-TW'])).toBe('en');
    expect(pickLocale(['zh-CN', 'ja'])).toBe('en');
    expect(pickLocale(['zh-Hans-TW'])).toBe('en');
    expect(pickLocale([])).toBe('en');
  });
});
