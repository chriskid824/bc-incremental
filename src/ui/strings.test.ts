import { describe, expect, it } from 'vitest';
import { STRINGS, fill, formatClock, talentName } from './strings';

describe('fill', () => {
  it('replaces placeholders and leaves unknown ones', () => {
    expect(fill('Run {run} · from wave {startWave}', { run: 3, startWave: 12 })).toBe(
      'Run 3 · from wave 12',
    );
    expect(fill('{a} {b}', { a: 'x' })).toBe('x {b}');
  });

  it('covers every placeholder used by the HUD run line', () => {
    expect(fill(STRINGS.hud.run, { run: 1, startWave: 1 })).not.toContain('{');
  });
});

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
  it('splits camelCase ids and trailing digits', () => {
    expect(talentName('critChance1')).toBe('Crit Chance 1');
    expect(talentName('glassCannon')).toBe('Glass Cannon');
    expect(talentName('might')).toBe('Might');
  });
});
