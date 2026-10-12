import { afterEach, describe, expect, it } from 'vitest';
import { TALENTS } from '../data/talents';
import { LOCALES, MESSAGES, fill, getLocale, isMessageKey, pickLocale, setLocale, t } from '.';
import type { MessageKey } from '.';

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
