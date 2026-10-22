import { describe, expect, it } from 'vitest';
import { num } from '../../core/num';
import { CHARACTER_IDS, OUTER_IDS } from '../../data/sources';
import type { OuterId } from '../../data/sources';
import { assembleWeb } from '../../data/web/assemble';
import { DEMO_SCOPE_A, DEMO_SCOPE_B, FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import { outerView, revealedOuters } from './reveal';
import { canBuy, emptyProgress } from './rules';
import type { AccountProgress, CharacterProgress } from './types';

const content = fixtureContent();
const fire = assembleWeb(content, 'fire', FULL_SCOPE);
const account: AccountProgress = { singularityBeaten: false };

const at = (bestWave: number, ranks: Readonly<Record<string, number>> = {}): CharacterProgress => ({
  ...emptyProgress('fire'),
  ranks,
  wallet: { shards: num(1e12), cores: 100, resonance: 100 },
  bestWave,
});
const sorted = (set: ReadonlySet<OuterId>): OuterId[] => [...set].sort();

describe('revealedOuters (D20)', () => {
  it('shows the three recommended outers, revealAt15 from best wave 15, all 11 from 30', () => {
    const three: OuterId[] = ['crit', 'ice', 'summon'];
    const six: OuterId[] = ['crit', 'ice', 'lightning', 'poison', 'summon', 'thorns'];
    const all = OUTER_IDS.filter((o) => o !== 'fire');
    for (const wave of [0, 1, 14])
      expect(sorted(revealedOuters(fire.def, wave)), `${wave}`).toEqual(three);
    for (const wave of [15, 16, 29])
      expect(sorted(revealedOuters(fire.def, wave)), `${wave}`).toEqual(six);
    for (const wave of [30, 31, 100, 1000]) {
      expect(sorted(revealedOuters(fire.def, wave)), `${wave}`).toEqual([...all].sort());
    }
  });

  it('gives every character 3, 6 and 11 outers, never its own', () => {
    for (const c of CHARACTER_IDS) {
      const def = content.characters[c];
      expect(
        [14, 15, 29, 30].map((wave) => revealedOuters(def, wave).size),
        c,
      ).toEqual([3, 6, 6, 11]);
      expect(revealedOuters(def, 30).has(c), c).toBe(false);
      expect(sorted(revealedOuters(def, 15)), c).toEqual(
        [...def.recommendedOuter, ...def.revealAt15].sort(),
      );
    }
  });

  it('never shrinks as the best wave rises', () => {
    for (let wave = 0; wave < 60; wave++) {
      const now = revealedOuters(fire.def, wave);
      const next = revealedOuters(fire.def, wave + 1);
      for (const outer of now) expect(next.has(outer), `${outer} at ${wave + 1}`).toBe(true);
    }
  });
});

describe('outerView (§4.6, F15)', () => {
  it('gives each of its four values', () => {
    expect(outerView(fire, at(0), 'ice')).toBe('open');
    expect(outerView(fire, at(0), 'poison')).toBe('hidden');
    expect(outerView(fire, at(15), 'poison')).toBe('open');
    expect(outerView(fire, at(29), 'bleed')).toBe('hidden');
    expect(outerView(fire, at(30), 'bleed')).toBe('open');
    expect(outerView(assembleWeb(content, 'fire', DEMO_SCOPE_A), at(0), 'bleed')).toBe('locked');
    // B1 has not registered bleed; the character's own clock holds no outer.
    const early = assembleWeb(fixtureContent('B1'), 'fire', FULL_SCOPE);
    expect(outerView(early, at(30), 'bleed')).toBe('absent');
    expect(outerView(fire, at(30), 'fire')).toBe('absent');
  });

  it('keeps an outer outside the scope locked before and after its reveal wave', () => {
    const demoA = assembleWeb(content, 'fire', DEMO_SCOPE_A);
    const demoB = assembleWeb(content, 'fire', DEMO_SCOPE_B);
    for (const wave of [0, 14, 15, 29, 30, 100]) {
      expect(outerView(demoA, at(wave), 'lightning'), `${wave}`).toBe('locked');
      expect(outerView(demoA, at(wave), 'bleed'), `${wave}`).toBe('locked');
      // demoB locks summon, one of fire's three recommended outers.
      expect(outerView(demoB, at(wave), 'summon'), `${wave}`).toBe('locked');
      expect(
        canBuy(demoA, at(wave, { 'hub.defense.r3': 1 }), account, 'outer.lightning.main.entry'),
      ).toMatchObject({
        reason: 'locked',
      });
    }
    expect(outerView(demoA, at(14), 'poison')).toBe('hidden');
    expect(outerView(demoA, at(15), 'poison')).toBe('open');
  });
});

describe('a hidden outer to canBuy', () => {
  const ranks = {
    'fire.center.alpha.r1': 1,
    'fire.center.alpha.r2': 1,
    'fire.center.alpha.alpha-one': 1,
    'fire.center.alpha.r3': 1,
    'fire.center.main.c1': 1,
    'hub.defense.r1': 1,
    'hub.defense.r2': 1,
  };

  it('hides its nodes and its fusion’s', () => {
    for (const id of [
      'outer.poison.main.entry',
      'outer.poison.alpha.r1',
      'outer.poison.main.threshold',
      'fusion.fire.poison.core',
      'fusion.fire.poison.mastery',
    ]) {
      expect(canBuy(fire, at(14, ranks), account, id), id).toMatchObject({ reason: 'hidden' });
    }
    expect(canBuy(fire, at(15, ranks), account, 'outer.poison.main.entry').ok).toBe(true);
    expect(canBuy(fire, at(29, ranks), account, 'outer.bleed.main.entry')).toMatchObject({
      reason: 'hidden',
    });
    expect(canBuy(fire, at(30, ranks), account, 'outer.bleed.main.entry').ok).toBe(true);
  });
});
