/**
 * Player-visible text (docs/ARCHITECTURE.md §13). en.json is the source of keys and of the
 * MessageKey type; every other locale must define every key, which the compiler checks below
 * and i18n.test.ts checks for extra keys and placeholders. Templates use `{name}` placeholders;
 * format numbers (src/core/format.ts) before passing them in.
 */

import en from './en.json';
import zhTW from './zh-TW.json';

export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;
export type MessageValues = Readonly<Record<string, string | number>>;

export const LOCALES = ['en', 'zh-TW'] as const;
export type Locale = (typeof LOCALES)[number];

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, 'zh-TW': zhTW };

let current: Locale = 'en';

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** Whether `key` is a known message key, e.g. a nameKey from game data. */
export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(en, key);
}

/** The message in the current locale, with its placeholders filled. */
export function t(key: MessageKey, values?: MessageValues): string {
  const template = MESSAGES[current][key];
  return values === undefined ? template : fill(template, values);
}

/** Replaces each `{name}` in the template with the matching value; unknown ones stay. */
export function fill(template: string, values: MessageValues): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * The first supported locale among language tags in preference order (navigator.languages).
 * Traditional Chinese tags map to zh-TW; anything unsupported falls back to English.
 */
export function pickLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (lower === 'en' || lower.startsWith('en-')) return 'en';
    if (/^zh-(tw|hk|mo|hant)(-|$)/.test(lower)) return 'zh-TW';
  }
  return 'en';
}
