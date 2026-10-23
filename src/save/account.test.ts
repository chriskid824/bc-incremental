/**
 * The account's operations and what it derives (docs/v3 C8 design §1.2, §2.1's T4-T7; F3-F5, F7):
 * the first pick's claim of v1's pending, the codex marks, a run's record, the enemy types met (the
 * lead's ruling K3), the checks, and the purchase rules' account, the legacy milestones and the
 * challenge unlocks. Everything is imported from profile.ts, B1's one import. Inputs are
 * deep-frozen, so a mutation throws.
 */

import { describe, expect, it } from 'vitest';
import { add, num, ZERO } from '../core/num';
import { createRng, deriveSeed } from '../core/rng';
import { CHARACTER_IDS } from '../data/sources';
import type { CharacterId } from '../data/sources';
import type { EnemyId } from '../data/types';
import { emptyProgress, fusionSlots, refundAll } from '../meta/web/rules';
import type { CharacterProgress, Wallet } from '../meta/web/types';
import {
  accountProgress,
  addPlaySeconds,
  challengeUnlocked,
  freshProfile,
  LEGACY_WAVES,
  legacyMilestones,
  recordRun,
  recordSeenEnemies,
  selectCharacter,
  serializeProfile,
  setProgress,
  setSpeed,
  setStartWave,
} from './profile';
import type { AccountSave, PendingV1, SaveProfile, Speed } from './profile';
import { deepFreeze, PROFILE_SEED, randomAmount } from './testing';

const FRESH = deepFreeze(freshProfile());
const EMPTY: Wallet = { shards: ZERO, cores: 0, resonance: 0 };

/** `p` with `changes` to its account, frozen. */
const withAccount = (p: SaveProfile, changes: Partial<AccountSave>): SaveProfile =>
  deepFreeze({ ...p, account: { ...p.account, ...changes } });

/** `p` with `changes` to c's progress, frozen. */
function withProgress(
  p: SaveProfile,
  c: CharacterId,
  changes: Partial<CharacterProgress>,
): SaveProfile {
  const slot = p.characters[c];
  return deepFreeze({
    ...p,
    characters: { ...p.characters, [c]: { ...slot, progress: { ...slot.progress, ...changes } } },
  });
}

/** `flags` as the account's singularity record, every other character false. */
const flags = (...beaten: readonly CharacterId[]): Record<CharacterId, boolean> =>
  Object.fromEntries(CHARACTER_IDS.map((c) => [c, beaten.includes(c)])) as Record<
    CharacterId,
    boolean
  >;

const POISON_CORE = 'fusion.fire.poison.core';
const CRIT_CORE = 'fusion.fire.crit.core';
const ICE_FIRE_CORE = 'fusion.ice.fire.core';

// T4 catches a pending kept (a double claim), a wallet overwritten and only bestWave set.
describe('selectCharacter: the claim of v1’s progress (T4; F5)', () => {
  const pending: PendingV1 = deepFreeze({ shards: num(2221.75), cores: 3, maxWave: 18 });
  const waiting = withAccount(FRESH, { pendingV1: pending });

  it('starts a fresh slot exactly where v1 left off, and takes the pending off the account', () => {
    for (const c of CHARACTER_IDS) {
      const { profile, claimed } = selectCharacter(waiting, c);
      expect(claimed).toBe(pending);
      const { progress } = profile.characters[c];
      expect(progress).toEqual({
        ...emptyProgress(c),
        wallet: { shards: pending.shards, cores: 3, resonance: 0 },
        bestWave: 18,
        cycleBest: 18,
      });
      expect(Object.is(progress.wallet.shards, pending.shards)).toBe(true);
      expect(progress.spent).toEqual(EMPTY);
      expect(profile.account).toEqual({ ...waiting.account, lastCharacter: c, pendingV1: null });
      expect(profile.characters[c].loadouts).toBe(waiting.characters[c].loadouts);
      for (const other of CHARACTER_IDS) {
        if (other !== c) expect(profile.characters[other]).toBe(waiting.characters[other]);
      }
    }
  });

  it('claims on the pick of the last character too', () => {
    const last = withAccount(waiting, { lastCharacter: 'ice' });
    const { profile, claimed } = selectCharacter(last, 'ice');
    expect(claimed).toBe(pending);
    expect(profile.account.pendingV1).toBeNull();
    expect(profile.characters.ice.progress.wallet.shards).toBe(pending.shards);
  });

  it('claims once: a later pick claims nothing', () => {
    const first = selectCharacter(waiting, 'fire').profile;
    const again = selectCharacter(deepFreeze(first), 'fire');
    expect(again.claimed).toBeNull();
    expect(again.profile).toBe(first);
    const other = selectCharacter(first, 'ice');
    expect(other.claimed).toBeNull();
    expect(other.profile.characters).toBe(first.characters);
    expect(other.profile.account).toEqual({ ...first.account, lastCharacter: 'ice' });
    expect(other.profile.characters.fire.progress.wallet.shards).toBe(pending.shards);
  });

  it('adds to a played slot, one add per currency, and raises both best waves to maxWave', () => {
    const rng = createRng(deriveSeed(PROFILE_SEED, 'claim'));
    for (let i = 0; i < 200; i++) {
      const wallet: Wallet = {
        shards: randomAmount(rng),
        cores: rng.int(1e6),
        resonance: rng.int(9),
      };
      const spent: Wallet = { shards: randomAmount(rng), cores: rng.int(50), resonance: 1 };
      const bestWave = rng.int(80);
      const cycleBest = rng.int(bestWave + 1);
      const claim: PendingV1 = {
        shards: randomAmount(rng),
        cores: rng.int(1e6),
        maxWave: rng.int(41),
      };
      const p = withAccount(
        withProgress(FRESH, 'summon', {
          ranks: { 'summon.center.alpha.r1': 2 },
          wallet,
          spent,
          bestWave,
          cycleBest,
          prestiges: 2,
          runs: 5,
        }),
        { pendingV1: claim, lastCharacter: 'fire' },
      );
      const { profile, claimed } = selectCharacter(p, 'summon');
      expect(claimed).toBe(p.account.pendingV1);
      const before = p.characters.summon.progress;
      const after = profile.characters.summon.progress;
      expect(Object.is(after.wallet.shards, add(wallet.shards, claim.shards)), `${i}`).toBe(true);
      expect(after).toEqual({
        ...before,
        wallet: {
          shards: after.wallet.shards,
          cores: wallet.cores + claim.cores,
          resonance: wallet.resonance,
        },
        bestWave: Math.max(bestWave, claim.maxWave),
        cycleBest: Math.max(cycleBest, claim.maxWave),
      });
      expect(after.spent).toBe(before.spent);
      expect(after.ranks).toBe(before.ranks);
      expect(profile.account).toEqual({ ...p.account, lastCharacter: 'summon', pendingV1: null });
    }
  });

  it('without a pending changes lastCharacter only, and nothing once it is c', () => {
    const p = withAccount(FRESH, { lastCharacter: 'ice' });
    expect(selectCharacter(p, 'ice')).toEqual({ profile: p, claimed: null });
    expect(selectCharacter(p, 'ice').profile).toBe(p);
    const { profile, claimed } = selectCharacter(p, 'lightning');
    expect(claimed).toBeNull();
    expect(profile.account).toEqual({ ...p.account, lastCharacter: 'lightning' });
    expect(profile.characters).toBe(p.characters);
    expect(profile.account.codex).toBe(p.account.codex);
    expect(selectCharacter(FRESH, 'fire').profile.account.lastCharacter).toBe('fire');
  });
});

/** c's progress owning `ranks`, frozen. */
const owning = (
  c: CharacterId,
  ranks: Record<string, number>,
  changes: Partial<CharacterProgress> = {},
): CharacterProgress => deepFreeze({ ...emptyProgress(c), ranks, ...changes });

// T5 catches an entry deleted on refund and a best wave reset.
describe('setProgress: the codex (T5)', () => {
  it('marks each core c owns once, at best wave 0, and keeps the mark through a refund', () => {
    const progress = owning(
      'fire',
      { 'fire.center.alpha.r1': 2, [POISON_CORE]: 1, 'fusion.fire.ice.r1': 2, [CRIT_CORE]: 1 },
      { spent: { shards: num(5000.5), cores: 3, resonance: 0 } },
    );
    const marked = deepFreeze(setProgress(FRESH, 'fire', progress));
    expect(marked.characters.fire.progress).toBe(progress);
    expect(marked.account.codex).toEqual({
      'fire.poison': { bestWave: 0 },
      'fire.crit': { bestWave: 0 },
    });
    expect(Object.keys(marked.account.codex)).toEqual(['fire.poison', 'fire.crit']);
    expect(marked.account.singularity).toBe(FRESH.account.singularity);
    for (const c of CHARACTER_IDS) {
      if (c !== 'fire') expect(marked.characters[c]).toBe(FRESH.characters[c]);
    }
    const refunded = refundAll(progress);
    const kept = setProgress(marked, 'fire', refunded);
    expect(kept.characters.fire.progress).toBe(refunded);
    expect(kept.account).toBe(marked.account);
    // Bought again later: the entry is there already.
    expect(setProgress(deepFreeze(kept), 'fire', progress).account).toBe(marked.account);
  });

  it('never lowers or resets a best wave', () => {
    const p = withAccount(FRESH, {
      codex: { 'fire.poison': { bestWave: 40 }, 'ice.fire': { bestWave: 7 } },
    });
    const marked = setProgress(p, 'fire', owning('fire', { [POISON_CORE]: 1, [CRIT_CORE]: 1 }));
    expect(marked.account.codex).toEqual({
      'fire.poison': { bestWave: 40 },
      'ice.fire': { bestWave: 7 },
      'fire.crit': { bestWave: 0 },
    });
    expect(marked.account.codex['fire.poison']).toBe(p.account.codex['fire.poison']);
    expect(setProgress(p, 'fire', owning('fire', { [POISON_CORE]: 1 })).account).toBe(p.account);
  });

  it('marks nothing for another character’s core, a core not owned, or a node that is no core', () => {
    const progress = owning('fire', {
      'fusion.ice.poison.core': 1,
      [CRIT_CORE]: 0,
      'fusion.fire.bleed.core': Number.NaN,
      'fusion.fire.combo.core': -1,
      'fusion.fire.aura.core': Infinity,
      'fusion.fire.combo.r1': 3,
      'fusion.fire.fire.core': 1,
      'fusion.fire.nope.core': 1,
      'fire.center.alpha.r1': 1,
    });
    const p = setProgress(FRESH, 'fire', progress);
    expect(p.account).toBe(FRESH.account);
    expect(p.characters.fire.progress).toBe(progress);
  });

  it('returns p itself when nothing changes, and throws for another character’s progress', () => {
    expect(setProgress(FRESH, 'ice', FRESH.characters.ice.progress)).toBe(FRESH);
    expect(() => setProgress(FRESH, 'ice', emptyProgress('fire'))).toThrow(
      /progress of 'fire' given for 'ice'/,
    );
  });

  it('marks an owned core with no entry even when the progress given is the slot’s own', () => {
    const p = withProgress(FRESH, 'fire', { ranks: { [POISON_CORE]: 1 } });
    const marked = setProgress(p, 'fire', p.characters.fire.progress);
    expect(marked.account.codex).toEqual({ 'fire.poison': { bestWave: 0 } });
    expect(marked.characters).toBe(p.characters);
    expect(setProgress(deepFreeze(marked), 'fire', marked.characters.fire.progress)).toBe(marked);
  });
});

// T6 catches every character's cores recorded and singularity[c] = beatSingularity.
describe('recordRun (T6)', () => {
  const played = deepFreeze({
    ...withProgress(
      withProgress(FRESH, 'fire', {
        ranks: { [POISON_CORE]: 1, 'fusion.fire.poison.r1': 2, [CRIT_CORE]: 1 },
      }),
      'ice',
      { ranks: { [ICE_FIRE_CORE]: 1 } },
    ),
    account: {
      ...FRESH.account,
      codex: {
        'fire.poison': { bestWave: 12 },
        'ice.fire': { bestWave: 3 },
        'summon.greed': { bestWave: 77 },
      },
      singularity: flags('fire'),
      stats: { playSeconds: 99.5, runs: 41 },
    },
  });

  it('raises only the cores c owns, to the run’s highest wave, adding a missing entry', () => {
    const run = recordRun(played, 'fire', { highestWave: 20, beatSingularity: false });
    expect(run.account.codex).toEqual({
      'fire.poison': { bestWave: 20 },
      'ice.fire': { bestWave: 3 },
      'summon.greed': { bestWave: 77 },
      'fire.crit': { bestWave: 20 },
    });
    expect(Object.keys(run.account.codex)).toEqual([
      'fire.poison',
      'ice.fire',
      'summon.greed',
      'fire.crit',
    ]);
    expect(run.characters).toBe(played.characters);
    const lower = recordRun(deepFreeze(run), 'fire', { highestWave: 5, beatSingularity: false });
    expect(lower.account.codex).toBe(run.account.codex);
    const ice = recordRun(played, 'ice', { highestWave: 2, beatSingularity: false });
    expect(ice.account.codex).toBe(played.account.codex);
    const iceHigher = recordRun(played, 'ice', { highestWave: 9, beatSingularity: false });
    expect(iceHigher.account.codex).toEqual({
      ...played.account.codex,
      'ice.fire': { bestWave: 9 },
    });
    const unplayed = recordRun(played, 'summon', { highestWave: 100, beatSingularity: false });
    expect(unplayed.account.codex).toBe(played.account.codex);
  });

  it('sets c’s flag when the run beat 奇點, and never clears one', () => {
    const kept = recordRun(played, 'fire', { highestWave: 1, beatSingularity: false });
    expect(kept.account.singularity).toBe(played.account.singularity);
    const beaten = recordRun(played, 'ice', { highestWave: 100, beatSingularity: true });
    expect(beaten.account.singularity).toEqual(flags('fire', 'ice'));
    const again = recordRun(deepFreeze(beaten), 'ice', { highestWave: 3, beatSingularity: false });
    expect(again.account.singularity).toBe(beaten.account.singularity);
    expect(
      recordRun(played, 'summon', { highestWave: 3, beatSingularity: false }).account.singularity
        .summon,
    ).toBe(false);
  });

  it('counts each run once, and changes no other stat', () => {
    const one = recordRun(played, 'lightning', { highestWave: 0, beatSingularity: false });
    expect(one.account.stats).toEqual({ playSeconds: 99.5, runs: 42 });
    const two = recordRun(deepFreeze(one), 'fire', { highestWave: 0, beatSingularity: true });
    expect(two.account.stats).toEqual({ playSeconds: 99.5, runs: 43 });
    expect(two.account.settings).toBe(played.account.settings);
    expect(two.account.pendingV1).toBe(played.account.pendingV1);
    expect(two.account.lastCharacter).toBe(played.account.lastCharacter);
  });
});

// The lead's ruling K3 (C7's L7: the new-enemy banner shows once per profile).
describe('recordSeenEnemies (the lead’s ruling K3)', () => {
  const seen = (...ids: readonly string[]): SaveProfile => withAccount(FRESH, { seenEnemies: ids });

  it('adds the ids not seen yet, keeping the list sorted and distinct', () => {
    const first = recordSeenEnemies(FRESH, ['triangle', 'boss', 'triangle']);
    expect(first.account).toEqual({ ...FRESH.account, seenEnemies: ['boss', 'triangle'] });
    expect(first.characters).toBe(FRESH.characters);
    const more = recordSeenEnemies(deepFreeze(first), ['square', 'boss', 'hexagon']);
    expect(more.account.seenEnemies).toEqual(['boss', 'hexagon', 'square', 'triangle']);
    expect(more.account.codex).toBe(FRESH.account.codex);
  });

  it('returns p itself when every id is seen already, or none is given', () => {
    const p = seen('boss', 'square');
    expect(recordSeenEnemies(p, ['square', 'boss', 'square'])).toBe(p);
    expect(recordSeenEnemies(p, [])).toBe(p);
    expect(recordSeenEnemies(FRESH, [])).toBe(FRESH);
  });

  it('never removes an id, one the content no longer has included', () => {
    const p = seen('gone', 'square');
    expect(recordSeenEnemies(p, ['boss']).account.seenEnemies).toEqual(['boss', 'gone', 'square']);
    expect(recordSeenEnemies(p, ['square'])).toBe(p);
  });

  // localeCompare puts 'boss' before 'Gone'; the schema reads the list in code-unit order.
  it('sorts by code unit, the order the schema reads, whatever ids the list already holds', () => {
    const next = recordSeenEnemies(seen('Gone', 'square'), ['boss']);
    expect(next.account.seenEnemies).toEqual(['Gone', 'boss', 'square']);
    expect(() => serializeProfile(next, 'now')).not.toThrow();
  });

  it('throws a RangeError for an id outside ENEMY_IDS, changing nothing', () => {
    for (const id of ['nope', '', 'Boss']) {
      expect(() => recordSeenEnemies(FRESH, ['boss', id as EnemyId]), id).toThrow(RangeError);
    }
    expect(FRESH.account.seenEnemies).toEqual([]);
  });
});

describe('the checks: start wave, speed and play time', () => {
  it('setStartWave stores a whole wave ≥ 1 as given, or null, and refuses anything else', () => {
    const seven = setStartWave(FRESH, 'fire', 7);
    expect(seven.characters.fire).toEqual({ ...FRESH.characters.fire, startWave: 7 });
    expect(seven.characters.fire.progress).toBe(FRESH.characters.fire.progress);
    expect(seven.characters.ice).toBe(FRESH.characters.ice);
    expect(seven.account).toBe(FRESH.account);
    expect(setStartWave(deepFreeze(seven), 'fire', 7)).toBe(seven);
    expect(setStartWave(seven, 'fire', null).characters.fire.startWave).toBeNull();
    expect(setStartWave(FRESH, 'fire', null)).toBe(FRESH);
    expect(setStartWave(FRESH, 'ice', 1).characters.ice.startWave).toBe(1);
    expect(setStartWave(FRESH, 'ice', 500).characters.ice.startWave).toBe(500);
    for (const wave of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53]) {
      expect(() => setStartWave(FRESH, 'fire', wave), `${wave}`).toThrow(RangeError);
    }
  });

  it('setSpeed takes 1, 2 or 4', () => {
    const fast = setSpeed(FRESH, 4);
    expect(fast.account).toEqual({ ...FRESH.account, settings: { speed: 4 } });
    expect(fast.characters).toBe(FRESH.characters);
    expect(setSpeed(deepFreeze(fast), 4)).toBe(fast);
    expect(setSpeed(fast, 2).account.settings.speed).toBe(2);
    expect(setSpeed(FRESH, 1)).toBe(FRESH);
    for (const speed of [3, 0, 8, 1.5]) {
      expect(() => setSpeed(FRESH, speed as Speed), `${speed}`).toThrow(RangeError);
    }
  });

  it('addPlaySeconds adds a finite number of seconds ≥ 0, exactly', () => {
    const once = addPlaySeconds(FRESH, 0.1);
    expect(once.account.stats).toEqual({ playSeconds: 0.1, runs: 0 });
    const twice = addPlaySeconds(deepFreeze(once), 0.2);
    expect(Object.is(twice.account.stats.playSeconds, 0.1 + 0.2)).toBe(true);
    expect(twice.characters).toBe(FRESH.characters);
    expect(addPlaySeconds(once, 0)).toBe(once);
    for (const seconds of [-1, -5e-324, Number.NaN, Infinity]) {
      expect(() => addPlaySeconds(FRESH, seconds), `${seconds}`).toThrow(RangeError);
    }
  });
});

// T7 catches every for some and > for ≥.
describe('derived values (T7; F7)', () => {
  it('opens the third fusion slot on any one character’s flag, and that character’s challenge', () => {
    expect(accountProgress(FRESH)).toEqual({ singularityBeaten: false });
    expect(fusionSlots(accountProgress(FRESH))).toBe(2);
    expect(legacyMilestones(FRESH).anySingularity).toBe(false);
    for (const c of CHARACTER_IDS) {
      const p = withAccount(FRESH, { singularity: flags(c) });
      expect(accountProgress(p)).toEqual({ singularityBeaten: true });
      expect(fusionSlots(accountProgress(p))).toBe(3);
      const milestones = legacyMilestones(p);
      expect(milestones.anySingularity).toBe(true);
      expect(milestones.singularity).toEqual(flags(c));
      for (const other of CHARACTER_IDS) expect(challengeUnlocked(p, other)).toBe(other === c);
    }
    const all = withAccount(FRESH, { singularity: flags(...CHARACTER_IDS) });
    expect(accountProgress(all)).toEqual({ singularityBeaten: true });
  });

  it('reads each character’s legacy wave as the highest of 30, 60, 100 at or below its best', () => {
    expect(LEGACY_WAVES).toEqual([30, 60, 100]);
    const cases: readonly (readonly [number, number])[] = [
      [0, 0],
      [29, 0],
      [30, 30],
      [59, 30],
      [60, 60],
      [99, 60],
      [100, 100],
      [140, 100],
    ];
    const none = { fire: 0, ice: 0, lightning: 0, summon: 0 };
    for (const [bestWave, wave] of cases) {
      for (const c of CHARACTER_IDS) {
        const p = withProgress(FRESH, c, { bestWave });
        expect(legacyMilestones(p).waves, `${c} ${bestWave}`).toEqual({ ...none, [c]: wave });
      }
    }
    let p = FRESH;
    for (const [c, bestWave] of [
      ['fire', 29],
      ['ice', 30],
      ['lightning', 60],
      ['summon', 100],
    ] as const) {
      p = withProgress(p, c, { bestWave, cycleBest: 0 });
    }
    expect(legacyMilestones(p).waves).toEqual({ fire: 0, ice: 30, lightning: 60, summon: 100 });
  });

  it('counts a first prestige from 1, on any character', () => {
    expect(legacyMilestones(FRESH).firstPrestige).toBe(false);
    for (const c of CHARACTER_IDS) {
      expect(legacyMilestones(withProgress(FRESH, c, { prestiges: 1 })).firstPrestige).toBe(true);
    }
    expect(legacyMilestones(withProgress(FRESH, 'summon', { prestiges: 3 })).firstPrestige).toBe(
      true,
    );
  });
});
