import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../../data/sources';
import { DEMO_SCOPE_A, FULL_SCOPE } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import { cardLock, gameScope, showsSwitchHint, SWITCH_HINT_RUNS } from './scope';

const locks = (content: ReturnType<typeof fixtureContent>, flavor: 'demo' | 'full') =>
  Object.fromEntries(CHARACTER_IDS.map((c) => [c, cardLock(content, gameScope(flavor), c)]));

describe('the flavor’s scope', () => {
  it('is DEMO_SCOPE_A in the Demo, FULL_SCOPE otherwise', () => {
    expect(gameScope('demo')).toBe(DEMO_SCOPE_A);
    expect(gameScope('full')).toBe(FULL_SCOPE);
    expect(gameScope('demo').waveCap).toBe(40);
  });
});

describe('select card states', () => {
  it('locks 霜晶 and 雷塔 with 「完整版」 in the Demo, even with their centers written', () => {
    expect(locks(fixtureContent('B5'), 'demo')).toEqual({
      fire: null,
      ice: 'fullVersion',
      lightning: 'fullVersion',
      summon: null,
    });
    expect(locks(fixtureContent('B5'), 'full')).toEqual({
      fire: null,
      ice: null,
      lightning: null,
      summon: null,
    });
  });

  it('marks a character in the scope without a center 「製作中」', () => {
    // B1: 熔核 alone has its center.
    expect(locks(fixtureContent('B1'), 'demo')).toEqual({
      fire: null,
      ice: 'fullVersion',
      lightning: 'fullVersion',
      summon: 'inProgress',
    });
    expect(locks(fixtureContent('B1'), 'full')).toEqual({
      fire: null,
      ice: 'inProgress',
      lightning: 'inProgress',
      summon: 'inProgress',
    });
  });
});

describe('「換一個角色試試」', () => {
  it('shows on the first 3 runs once a second character is playable', () => {
    expect(SWITCH_HINT_RUNS).toBe(3);
    expect([1, 2, 3, 4].map((runs) => showsSwitchHint(runs, 2))).toEqual([true, true, true, false]);
    expect(showsSwitchHint(1, 1)).toBe(false);
    expect(showsSwitchHint(0, 4)).toBe(false);
  });
});
