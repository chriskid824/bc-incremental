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
    const node = { id: 'critChance1', nameKey: 'talent.critChance1.name' };
    expect(talentName(node)).toBe('Crit Chance 1');
    setLocale('zh-TW');
    expect(talentName(node)).toBe('暴擊率 1');
  });

  it('falls back to the id for an unknown nameKey', () => {
    expect(talentName({ id: 'mystery', nameKey: 'talent.mystery.name' })).toBe('mystery');
  });
});
