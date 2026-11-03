import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { assembleWeb } from '../../data/web/assemble';
import { FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import { webBuild } from './build';
import {
  canPrestige,
  prestige,
  PRESTIGE_RULES,
  prestigeResonance,
  resonanceDamageMore,
} from './prestige';
import { buy, canBuy, emptyProgress } from './rules';
import type { AccountProgress, CharacterProgress } from './types';

const fire = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
const account: AccountProgress = { singularityBeaten: false };
const ONE = 'fire.asc.path-one';
const TWO = 'fire.asc.path-two';
/** Center and hub nodes up to the might node, next to fire's ascendancy chains (hand-built). */
const ROUTE = [
  'fire.center.alpha.r1',
  'fire.center.alpha.r2',
  'fire.center.alpha.alpha-one',
  'fire.center.alpha.r3',
  'fire.center.main.c1',
  'hub.defense.r1',
  'hub.might.might',
];
const routed = (progress: CharacterProgress): CharacterProgress => ({
  ...progress,
  ranks: Object.fromEntries(ROUTE.map((id) => [id, 1])),
});

/** A cycle at `cycleBest` with some center nodes, a fusion core and a rich wallet. */
function cycle(cycleBest: number, extra: Partial<CharacterProgress> = {}): CharacterProgress {
  return {
    ...emptyProgress('fire'),
    ranks: { 'fire.center.alpha.r1': 2, 'fusion.fire.ice.core': 1 },
    wallet: { shards: num(500), cores: 3, resonance: 0 },
    spent: { shards: num(120), cores: 1, resonance: 0 },
    bestWave: Math.max(cycleBest, 44),
    cycleBest,
    runs: 17,
    ...extra,
  };
}

describe('prestigeResonance (gd:778)', () => {
  it('pays floor((cycleBest − 25)^1.5)', () => {
    expect(prestigeResonance(30)).toBe(11);
    expect(prestigeResonance(40)).toBe(58);
    expect(prestigeResonance(100)).toBe(Math.floor(75 ** 1.5));
    expect(prestigeResonance(25)).toBe(0);
    expect(prestigeResonance(0)).toBe(0);
  });
});

describe('canPrestige', () => {
  it('needs this cycle’s best at wave 30, not the all-time best', () => {
    expect(PRESTIGE_RULES.wave).toBe(30);
    expect(canPrestige(cycle(29))).toBe(false);
    expect(canPrestige(cycle(29, { bestWave: 80 }))).toBe(false);
    expect(canPrestige(cycle(30))).toBe(true);
  });
});

describe('prestige', () => {
  it('resets nodes, shards, cores and the cycle; keeps the best wave and runs; pays 迴響', () => {
    const before = cycle(40);
    const after = prestige(before);
    expect(after.ranks).toEqual({});
    expect(toNumber(after.wallet.shards)).toBe(0);
    expect(after.wallet.cores).toBe(0);
    expect(after.wallet.resonance).toBe(58);
    expect(toNumber(after.spent.shards)).toBe(0);
    expect(after.spent.cores).toBe(0);
    expect(after.cycleBest).toBe(0);
    expect(after.bestWave).toBe(44);
    expect(after.runs).toBe(17);
    expect(after.prestiges).toBe(1);
    expect(after.resonanceEarned).toBe(58);
    expect(after.ascendancy).toBeNull();
    // Pure: the input is unchanged.
    expect(before.cycleBest).toBe(40);
    expect(before.ranks['fusion.fire.ice.core']).toBe(1);
  });

  it('throws below the prestige wave', () => {
    expect(() => prestige(cycle(29))).toThrow(/below wave 30/);
  });

  it('opens the ascendancy nodes, 2 chains pick 1, and a new prestige frees the choice', () => {
    const fresh = routed(cycle(30));
    expect(canBuy(fire, fresh, account, `${ONE}.n1`)).toMatchObject({
      ok: false,
      reason: 'needsPrestige',
    });
    const first = routed(prestige(fresh));
    expect(canBuy(fire, first, account, `${ONE}.n1`)).toMatchObject({
      ok: true,
      price: { resonance: 1 },
    });
    const chose = buy(fire, first, account, `${ONE}.n1`);
    expect(chose.ascendancy).toBe('path-one');
    expect(chose.wallet.resonance).toBe(10);
    expect(canBuy(fire, chose, account, `${TWO}.n1`)).toMatchObject({
      ok: false,
      reason: 'otherAscendancy',
    });
    // The next cycle: the 迴響 spent comes back with the reset nodes, and the other chain opens.
    const reset = prestige({ ...chose, cycleBest: 33 });
    expect(reset.ascendancy).toBeNull();
    expect(reset.ranks).toEqual({});
    const second = routed(reset);
    expect(second.wallet.resonance).toBe(11 + prestigeResonance(33));
    expect(second.resonanceEarned).toBe(11 + prestigeResonance(33));
    expect(second.prestiges).toBe(2);
    expect(buy(fire, second, account, `${TWO}.n1`).ascendancy).toBe('path-two');
  });

  it('raises the run’s damage by 5 % more per 迴響 ever earned', () => {
    expect(resonanceDamageMore(0)).toBe(0);
    expect(resonanceDamageMore(11)).toBeCloseTo(0.55, 12);
    const after = prestige(cycle(30));
    const more = webBuild(fire, after).stats.scoped.filter((mod) => mod.stat === 'damage');
    expect(more).toEqual([{ stat: 'damage', kind: 'more', value: resonanceDamageMore(11) }]);
  });
});
