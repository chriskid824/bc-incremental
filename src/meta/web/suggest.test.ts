import { describe, expect, it } from 'vitest';
import { num } from '../../core/num';
import { ENEMY_IDS } from '../../data/types';
import type { EnemyId } from '../../data/types';
import { loadContent } from '../../data/web';
import { assembleWeb } from '../../data/web/assemble';
import { FULL_SCOPE } from '../../data/web/scope';
import type { ContactTally } from '../../sim/types';
import { emptyProgress } from './rules';
import { suggest, SUGGESTED_NODES, threatsOf } from './suggest';
import type { AccountProgress, CharacterProgress } from './types';

const ice = assembleWeb(loadContent(), 'ice', FULL_SCOPE);
const account: AccountProgress = { singularityBeaten: false };
const progress = (ranks: Readonly<Record<string, number>> = {}): CharacterProgress => ({
  ...emptyProgress('ice'),
  ranks,
  wallet: { shards: num(0), cores: 0, resonance: 0 },
});

/** A damageTakenBy with `damage` from each listed enemy and none from the rest. */
function taken(damage: Partial<Record<EnemyId, number>>): Record<EnemyId, ContactTally> {
  const by = {} as Record<EnemyId, ContactTally>;
  for (const id of ENEMY_IDS)
    by[id] = { hits: damage[id] === undefined ? 0 : 1, damage: damage[id] ?? 0 };
  return by;
}

describe('threatsOf', () => {
  it("orders gd §6.4's columns by the damage taken, bullets counted, bosses as one column", () => {
    const threats = threatsOf({
      damageTakenBy: taken({ triangle: 30, onion: 10, prism: 25, shooter: 5 }),
      bulletTakenBy: { shooter: { hits: 3, damage: 40 } },
    });
    expect(threats).toEqual(['shooter', 'boss', 'triangle']);
  });

  it('is empty when nothing got through', () => {
    expect(threatsOf({ damageTakenBy: taken({}) })).toEqual([]);
  });
});

describe('suggest (gd §8 items 8 and 14)', () => {
  it("marks the center's answer first, then the default order", () => {
    const out = suggest(ice, progress(), account, { damageTakenBy: taken({ shielder: 50 }) });
    // poison's 滲透 answers the shielder too, but the outer is not invested in: the 建議外盤 names it.
    const [first, second] = [...new Set(ice.def.defaultOrder)];
    expect(out.nodes).toEqual([
      { id: 'ice.center.shatter.icicle', answers: 'shielder' },
      { id: first, answers: null },
      { id: second, answers: null },
    ]);
  });

  it("marks an answer on an outer the character has invested in, after the center's", () => {
    const owned = progress({ 'outer.poison.main.entry': 1 });
    const out = suggest(ice, owned, account, { damageTakenBy: taken({ shielder: 50 }) });
    expect(out.nodes.slice(0, 2)).toEqual([
      { id: 'ice.center.shatter.icicle', answers: 'shielder' },
      { id: 'outer.poison.virulence.seep', answers: 'shielder' },
    ]);
  });

  it('leaves out a node that can take no more ranks', () => {
    const out = suggest(ice, progress({ 'ice.center.shatter.icicle': 1 }), account, {
      damageTakenBy: taken({ shielder: 50 }),
    });
    expect(out.nodes.map((node) => node.id)).not.toContain('ice.center.shatter.icicle');
  });

  it('suggests an open outer whose gd §6.5 cover of the threat is ◆ before one that only helps', () => {
    const out = suggest(ice, progress(), account, { damageTakenBy: taken({ shielder: 50 }) });
    // Of 霜晶's three open outers (fire, poison, crit) only poison answers the shielder.
    expect(out.outer).toEqual({ outer: 'poison', enemy: 'shielder', cover: 'answer' });
  });

  it('prefers an outer the character has not invested in, and skips the ones it cannot see', () => {
    const owned = progress({ 'outer.poison.main.entry': 1 });
    const out = suggest(ice, owned, account, { damageTakenBy: taken({ triangle: 50 }) });
    // fire and poison both answer the triangle; poison is invested, so fire.
    expect(out.outer).toEqual({ outer: 'fire', enemy: 'triangle', cover: 'answer' });
    const hidden = suggest(ice, progress(), account, { damageTakenBy: taken({ summoner: 50 }) });
    // lightning answers the summoner but is hidden before wave 15; poison helps.
    expect(hidden.outer).toEqual({ outer: 'poison', enemy: 'summoner', cover: 'helps' });
  });

  it('suggests no outer without a threat, and the default order alone', () => {
    const out = suggest(ice, progress(), account, { damageTakenBy: taken({}) });
    expect(out.outer).toBeNull();
    expect(out.nodes.map((node) => node.id)).toEqual(
      [...new Set(ice.def.defaultOrder)].slice(0, SUGGESTED_NODES),
    );
  });
});
