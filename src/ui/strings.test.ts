import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { formatClock, talentName } from './strings';

describe('formatClock', () => {
  it('formats m:ss rounding down', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9.99)).toBe('0:09');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(180)).toBe('3:00');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('talentName', () => {
  afterEach(() => setLocale('en'));

  it('translates the nameKey in the current locale', () => {
    const node = { id: 'keenEye', nameKey: 'talent.keenEye.name' };
    expect(talentName(node)).toBe('Keen Eye');
    setLocale('zh-TW');
    expect(talentName(node)).toBe('銳眼');
  });

  it('falls back to the id for an unknown nameKey', () => {
    expect(talentName({ id: 'mystery', nameKey: 'talent.mystery.name' })).toBe('mystery');
  });
});
