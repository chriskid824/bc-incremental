/**
 * The fixes a load applies (docs/v3 C8 design §1.5; §2.1's T8 and T9; §0.2 items 1-2): renames,
 * full refunds for what a web lacks, legalize's exact refunds, the loadouts, `changed`, and every
 * currency conserved over 500 damaged profiles. Fixture content in FULL_SCOPE unless a test says
 * otherwise; inputs are deep-frozen, so a mutation throws.
 */

import { describe, expect, it } from 'vitest';
import { add, gt, min, num, sub, ZERO } from '../core/num';
import type { Num } from '../core/num';
import { createRng, deriveSeed } from '../core/rng';
import { CHARACTER_IDS } from '../data/sources';
import type { CharacterId } from '../data/sources';
import { DEMO_SCOPE_A, FULL_SCOPE } from '../data/web/scope';
import { fixtureContent } from '../data/web/testing';
import type { AssembledWeb } from '../data/web/types';
import { progressFromOrder, unlockInvestment } from '../meta/web/invest';
import { canonicalCost, DEFAULT_WEB_ECONOMY } from '../meta/web/price';
import type { AccountProgress, CharacterProgress, Wallet, WebEconomy } from '../meta/web/types';
import { fixProfile, freshProfile, profileContext, toProfileData } from './profile';
import type { CharacterSlot, LoadoutRanks, SaveProfile } from './profile';
import {
  conservationIssues,
  damageProfile,
  deepFreeze,
  fixtureContext,
  PROFILE_SEED,
  randomProfiles,
  withRenames,
} from './testing';

const content = fixtureContent();
const context = fixtureContext();
const fire = context.webOf('fire') as AssembledWeb;
const account: AccountProgress = { singularityBeaten: false };

const C = 'fire.center';
const R1 = `${C}.alpha.r1`;
const R2 = `${C}.alpha.r2`;
const C3 = `${C}.main.c3`;
const BETA_R1 = `${C}.beta.r1`;
const THRESHOLD = `${C}.main.threshold`;
const MIGHT = 'hub.might.might';
const PATH_ONE_N1 = 'fire.asc.path-one.n1';
const ROUTE_C1 = [R1, R2, `${C}.alpha.alpha-one`, `${C}.alpha.r3`, `${C}.main.c1`];
const ROUTE_C3 = [BETA_R1, `${C}.beta.r2`, `${C}.beta.beta-one`, `${C}.beta.r3`, C3];
/** Twelve center nodes, c3 (next to the threshold) among them, in an order buy accepts. */
const CENTER_12 = [...ROUTE_C3, ...ROUTE_C1, `${C}.alpha.r4`, `${C}.gamma.r1`];

const WALLET: Wallet = deepFreeze({ shards: num(98765.4321), cores: 11, resonance: 4 });
const ZEROS: Wallet = { shards: ZERO, cores: 0, resonance: 0 };

/** A legal fire build: both routes to c1 and c3, r1 at rank 2, might, and path one's first node. */
const FIRE: CharacterProgress = deepFreeze({
  ...progressFromOrder(fire, account, [
    ...ROUTE_C3,
    ...ROUTE_C1,
    R1,
    'hub.defense.r1',
    MIGHT,
    PATH_ONE_N1,
  ]),
  wallet: WALLET,
});
const ICE: CharacterProgress = deepFreeze({
  ...progressFromOrder(context.webOf('ice') as AssembledWeb, account, [
    'ice.center.alpha.r1',
    'ice.center.alpha.r2',
    'ice.center.alpha.r1',
  ]),
  wallet: { shards: num(0.7), cores: 2, resonance: 0 },
});
const SUMMON: CharacterProgress = deepFreeze({
  ...progressFromOrder(context.webOf('summon') as AssembledWeb, account, [
    'summon.center.alpha.r1',
    'summon.center.alpha.r2',
    'summon.center.alpha.r1',
  ]),
  wallet: WALLET,
});

/** freshProfile with `slots` in place of its empty ones, frozen. */
function profileOf(slots: Partial<Record<CharacterId, Partial<CharacterSlot>>>): SaveProfile {
  const fresh = freshProfile();
  return deepFreeze({
    account: fresh.account,
    characters: Object.fromEntries(
      CHARACTER_IDS.map((c) => [c, { ...fresh.characters[c], ...slots[c] }]),
    ) as SaveProfile['characters'],
  });
}

/** `ranks` with `id` stored under `old` in its place. */
const storedAs = (ranks: LoadoutRanks, id: string, old: string): Record<string, number> =>
  Object.fromEntries(Object.entries(ranks).map(([key, rank]) => [key === id ? old : key, rank]));

const without = (ranks: LoadoutRanks, ...ids: readonly string[]): Record<string, number> =>
  Object.fromEntries(Object.entries(ranks).filter(([id]) => !ids.includes(id)));

/** refundAll's outcome by §1.5's step 4: wallet + spent exactly, spent 0, nothing owned. */
const refundedAll = (progress: CharacterProgress): CharacterProgress => ({
  ...progress,
  ranks: {},
  wallet: {
    shards: add(progress.wallet.shards, progress.spent.shards),
    cores: progress.wallet.cores + progress.spent.cores,
    resonance: progress.wallet.resonance + progress.spent.resonance,
  },
  spent: ZEROS,
});

/** c's slot as JSON: what a save writes of it. */
const slotText = (p: SaveProfile, c: CharacterId): string =>
  JSON.stringify(toProfileData(p).characters[c]);

describe('fixProfile (T8)', () => {
  it('keeps a legal profile as it is, renames of ids it does not hold included', () => {
    const p = profileOf({ fire: { progress: FIRE }, ice: { progress: ICE } });
    expect(fixProfile(p, context)).toEqual({ profile: p, notices: [], changed: false });
    expect(fixProfile(p, context).profile).toBe(p);
    const elsewhere = withRenames(context, { [`${C}.alpha.gone`]: R2, [`${C}.beta.gone`]: null });
    expect(fixProfile(p, elsewhere).profile).toBe(p);
  });

  // Catches renamed ids refunded.
  it('(a) moves a renamed id to its new name in place, keeping its rank, with no notice', () => {
    const OLD = `${C}.alpha.old-r2`;
    const p = profileOf({
      fire: { progress: { ...FIRE, ranks: storedAs(FIRE.ranks, R2, OLD) } },
      ice: { progress: ICE },
    });
    const { profile, notices, changed } = fixProfile(p, withRenames(context, { [OLD]: R2 }));
    expect(notices).toEqual([]);
    expect(changed).toBe(true);
    const { progress } = profile.characters.fire;
    expect(progress).toEqual(FIRE);
    expect(Object.keys(progress.ranks)).toEqual(Object.keys(FIRE.ranks));
    expect(progress.wallet).toBe(FIRE.wallet);
    expect(progress.spent).toBe(FIRE.spent);
    expect(profile.characters.fire.loadouts).toBe(p.characters.fire.loadouts);
    expect(profile.characters.ice).toBe(p.characters.ice);
    expect(profile.account).toBe(p.account);
  });

  // Catches a removal by legalize alone, which leaves the cost in spent.
  it('(b) refunds in full the character holding an id renamed to null, and no other', () => {
    const RETIRED = `${C}.alpha.retired`;
    const stored = deepFreeze({ ...FIRE, ranks: { ...FIRE.ranks, [RETIRED]: 2 } });
    const p = profileOf({ fire: { progress: stored }, ice: { progress: ICE } });
    const { profile, notices, changed } = fixProfile(p, withRenames(context, { [RETIRED]: null }));
    expect(notices).toEqual([{ kind: 'refundedAll', character: 'fire', ids: [RETIRED] }]);
    expect(changed).toBe(true);
    const { progress } = profile.characters.fire;
    expect(progress).toEqual(refundedAll(stored));
    expect(Object.is(progress.wallet.shards, add(WALLET.shards, FIRE.spent.shards))).toBe(true);
    expect(progress.spent).toEqual(ZEROS);
    expect(progress.ascendancy).toBe('path-one');
    for (const c of CHARACTER_IDS) {
      if (c === 'fire') continue;
      expect(profile.characters[c]).toBe(p.characters[c]);
      expect(slotText(profile, c)).toBe(slotText(p, c));
    }
  });

  // Catches relying on legalize, which prices nothing outside the web (§0.2 items 1-2).
  it('(c) refunds in full a build holding ids outside the web: a locked outer, an id found nowhere', () => {
    const demo = profileContext(content, DEMO_SCOPE_A);
    const fireA = demo.webOf('fire') as AssembledWeb;
    const invested = deepFreeze({
      ...unlockInvestment(fire, account, 'lightning'),
      wallet: WALLET,
    });
    const outside = Object.keys(invested.ranks).filter((id) => !fireA.byId.has(id));
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every((id) => id.startsWith('outer.lightning.'))).toBe(true);
    const p = profileOf({ fire: { progress: invested }, ice: { progress: ICE } });
    const locked = fixProfile(p, demo);
    expect(locked.notices).toEqual([{ kind: 'refundedAll', character: 'fire', ids: outside }]);
    expect(locked.changed).toBe(true);
    expect(locked.profile.characters.fire.progress).toEqual(refundedAll(invested));
    expect(locked.profile.characters.fire.progress.spent).toEqual(ZEROS);
    // 霜晶 is outside the Demo's scope: no web, so its slot waits as it is.
    expect(locked.profile.characters.ice).toBe(p.characters.ice);

    const LOST = `${C}.alpha.lost`;
    const stored = deepFreeze({ ...FIRE, ranks: { ...FIRE.ranks, [LOST]: 1 } });
    const nowhere = fixProfile(profileOf({ fire: { progress: stored } }), context);
    expect(nowhere.notices).toEqual([{ kind: 'refundedAll', character: 'fire', ids: [LOST] }]);
    expect(nowhere.profile.characters.fire.progress).toEqual(refundedAll(stored));
  });

  // Catches ranks summed.
  it('(d) refunds in full a merge: two old ids onto one, or an old id onto one stored as it is', () => {
    const OLD_A = `${C}.alpha.old-a`;
    const OLD_B = `${C}.alpha.old-b`;
    const cases: readonly (readonly [CharacterProgress, Record<string, string>, string[]])[] = [
      [
        { ...FIRE, ranks: { ...storedAs(FIRE.ranks, R1, OLD_A), [OLD_B]: 1 } },
        { [OLD_A]: R1, [OLD_B]: R1 },
        [OLD_A, OLD_B],
      ],
      [{ ...FIRE, ranks: { ...FIRE.ranks, [OLD_A]: 1 } }, { [OLD_A]: R1 }, [R1, OLD_A]],
    ];
    for (const [stored, renames, ids] of cases) {
      const p = profileOf({ fire: { progress: stored } });
      const { profile, notices, changed } = fixProfile(p, withRenames(context, renames));
      expect(notices).toEqual([{ kind: 'refundedAll', character: 'fire', ids }]);
      expect(changed).toBe(true);
      expect(profile.characters.fire.progress).toEqual(refundedAll(stored));
    }
  });

  // Catches all of spent refunded, legalize before renames and a silent cut.
  describe('(e) a moved gate: an exact move of what drops', () => {
    // Bought with the threshold's 12 center nodes, beta.r1 at 3 ranks and path one's first node.
    const gated = progressFromOrder(fire, account, [
      ...CENTER_12,
      THRESHOLD,
      'hub.defense.r1',
      MIGHT,
      PATH_ONE_N1,
      BETA_R1,
      BETA_R1,
    ]);
    // As an older build left it: the gate counted 11 center nodes (gamma.r1 never bought), beta.r1
    // had 5 ranks, c3 an older name, and no prestige stands behind path one's node.
    const current = { ...without(gated.ranks, `${C}.gamma.r1`), [BETA_R1]: 5 };
    const priced: CharacterProgress = { ...gated, ranks: current, prestiges: 0, wallet: WALLET };
    const OLD_C3 = `${C}.main.old-c3`;
    const renames = { [OLD_C3]: C3 };
    const kept = { ...without(current, THRESHOLD, PATH_ONE_N1), [BETA_R1]: 3 };
    const before = canonicalCost(fire, priced);
    const after = canonicalCost(fire, { ...priced, ranks: kept });
    /** r = min(spent, before − after), never below 0 (rules.ts:382-417). */
    const refundOf = (spent: Wallet): Wallet => {
      const shards: Num = min(spent.shards, sub(before.shards, after.shards));
      const count = (s: number, d: number): number => Math.max(0, Math.min(s, d));
      return {
        shards: gt(shards, ZERO) ? shards : ZERO,
        cores: count(spent.cores, before.cores - after.cores),
        resonance: count(spent.resonance, before.resonance - after.resonance),
      };
    };
    const SPENTS: readonly (readonly [string, Wallet])[] = [
      ['the price paid', before],
      ['less spent than the drop costs', { shards: num(10.5), cores: 1, resonance: 0 }],
      ['nothing spent', ZEROS],
    ];

    it.each(SPENTS)('moves r from spent to the wallet bit for bit, with %s', (_name, spent) => {
      const stored = deepFreeze({ ...priced, ranks: storedAs(current, C3, OLD_C3), spent });
      const p = profileOf({ fire: { progress: stored } });
      const { profile, notices, changed } = fixProfile(p, withRenames(context, renames));
      expect(notices).toEqual([
        { kind: 'dropped', character: 'fire', ids: [PATH_ONE_N1, THRESHOLD, BETA_R1] },
      ]);
      expect(changed).toBe(true);
      const r = refundOf(spent);
      const { progress } = profile.characters.fire;
      expect(Object.keys(progress.ranks)).toEqual(Object.keys(kept));
      expect(progress).toEqual({
        ...stored,
        ranks: kept,
        wallet: {
          shards: add(WALLET.shards, r.shards),
          cores: WALLET.cores + r.cores,
          resonance: WALLET.resonance + r.resonance,
        },
        spent: {
          shards: sub(spent.shards, r.shards),
          cores: spent.cores - r.cores,
          resonance: spent.resonance - r.resonance,
        },
      });
      expect(Object.is(progress.wallet.shards, add(WALLET.shards, r.shards))).toBe(true);
      expect(Object.is(progress.spent.shards, sub(spent.shards, r.shards))).toBe(true);
      expect(progress.wallet.cores + progress.spent.cores).toBe(WALLET.cores + spent.cores);
      expect(progress.wallet.resonance + progress.spent.resonance).toBe(
        WALLET.resonance + spent.resonance,
      );
    });

    it('refunds only what drops, never all of spent: the threshold’s 2 cores, the node’s 迴響', () => {
      const r = refundOf(before);
      expect(gt(r.shards, ZERO)).toBe(true);
      expect(gt(sub(before.shards, r.shards), ZERO)).toBe(true);
      expect([r.cores, r.resonance]).toEqual([2, 1]);
      expect(before.cores - r.cores).toBeGreaterThan(0);
    });

    it('prices the move with the context’s economy', () => {
      const economy: WebEconomy = {
        ...DEFAULT_WEB_ECONOMY,
        step: { base: 250, growth: 1.25 },
        cores: { ...DEFAULT_WEB_ECONOMY.cores, threshold: 5 },
      };
      const paid = canonicalCost(fire, priced, economy);
      const left = canonicalCost(fire, { ...priced, ranks: kept }, economy);
      const stored = deepFreeze({ ...priced, ranks: storedAs(current, C3, OLD_C3), spent: paid });
      const own = profileContext(content, FULL_SCOPE, economy, renames);
      const { profile, notices } = fixProfile(profileOf({ fire: { progress: stored } }), own);
      expect(notices).toEqual([
        { kind: 'dropped', character: 'fire', ids: [PATH_ONE_N1, THRESHOLD, BETA_R1] },
      ]);
      const r = sub(paid.shards, left.shards);
      expect(r).not.toBe(sub(before.shards, after.shards));
      const { progress } = profile.characters.fire;
      expect(Object.is(progress.wallet.shards, add(WALLET.shards, r))).toBe(true);
      expect(Object.is(progress.spent.shards, sub(paid.shards, r))).toBe(true);
      expect([progress.wallet.cores, progress.spent.cores]).toEqual([
        WALLET.cores + 5,
        paid.cores - 5,
      ]);
    });
  });

  // Catches assembleWeb called (it throws) and the slot dropped.
  it('(f) keeps, under B1, the slot of a character without a web exactly as stored', () => {
    const b1 = profileContext(fixtureContent('B1'), FULL_SCOPE);
    const stored: CharacterSlot = {
      progress: {
        ...SUMMON,
        ranks: { ...SUMMON.ranks, 'summon.center.alpha.r9': 7, 'summon.center.alpha.r2': 99 },
        ascendancy: 'path-lost',
      },
      loadouts: [{ 'summon.center.alpha.r1': 1, 'summon.center.alpha.nowhere': 1 }, null, null],
      startWave: 12,
    };
    const p = profileOf({ summon: stored, ice: { progress: ICE } });
    const kept = fixProfile(p, b1);
    expect(kept).toEqual({ profile: p, notices: [], changed: false });
    expect(kept.profile).toBe(p);
    // Renames still apply without a web, and a null rename still refunds in full.
    const OLD = 'summon.center.alpha.old-r2';
    const aliased = profileOf({
      summon: {
        progress: { ...SUMMON, ranks: storedAs(SUMMON.ranks, 'summon.center.alpha.r2', OLD) },
        loadouts: [null, { [OLD]: 2, 'summon.center.alpha.nowhere': 1 }, null],
      },
    });
    const renamed = fixProfile(aliased, withRenames(b1, { [OLD]: 'summon.center.alpha.r2' }));
    expect(renamed.notices).toEqual([]);
    expect(renamed.changed).toBe(true);
    expect(renamed.profile.characters.summon.progress).toEqual(SUMMON);
    expect(renamed.profile.characters.summon.loadouts).toEqual([
      null,
      { 'summon.center.alpha.r2': 2, 'summon.center.alpha.nowhere': 1 },
      null,
    ]);
    const retired = fixProfile(
      profileOf({ summon: { progress: SUMMON } }),
      withRenames(b1, { 'summon.center.alpha.r2': null }),
    );
    expect(retired.notices).toEqual([
      { kind: 'refundedAll', character: 'summon', ids: ['summon.center.alpha.r2'] },
    ]);
    expect(retired.profile.characters.summon.progress).toEqual(refundedAll(SUMMON));
  });

  // Catches loadouts skipped.
  it('(g) maps the loadouts through the renames, dropping removed ids and ids outside the web', () => {
    const OLD = `${C}.alpha.old-r2`;
    const OLD_R1 = `${C}.alpha.old-r1`;
    const RETIRED = `${C}.alpha.retired`;
    const first = { [R1]: 2, [OLD]: 1, [RETIRED]: 3, [`${C}.alpha.lost`]: 1, [C3]: 1 };
    const merged = { [OLD_R1]: 2, [R1]: 1, [MIGHT]: 4 };
    const untouched = { [MIGHT]: 4, [BETA_R1]: 3 };
    const p = profileOf({
      fire: { progress: FIRE, loadouts: [first, merged, untouched] },
      summon: { loadouts: [null, { [OLD]: 1, 'summon.center.alpha.r1': 2 }, null] },
    });
    const renames = { [OLD]: R2, [OLD_R1]: R1, [RETIRED]: null };
    const { profile, notices, changed } = fixProfile(p, withRenames(context, renames));
    expect(notices).toEqual([]);
    expect(changed).toBe(true);
    const slot = profile.characters.fire;
    expect(slot.progress).toBe(p.characters.fire.progress);
    expect(slot.loadouts).toEqual([{ [R1]: 2, [R2]: 1, [C3]: 1 }, { [MIGHT]: 4 }, untouched]);
    expect(Object.keys(slot.loadouts[0] ?? {})).toEqual([R1, R2, C3]);
    expect(slot.loadouts[2]).toBe(untouched);
    expect(profile.characters.summon.loadouts).toEqual([
      null,
      { 'summon.center.alpha.r1': 2 },
      null,
    ]);
    expect(profile.characters.summon.progress).toBe(p.characters.summon.progress);
    expect(profile.account).toBe(p.account);
  });

  // Catches the slug kept.
  it('(h) clears an ascendancy the web’s character does not have, refunding in full', () => {
    const lost = deepFreeze({ ...FIRE, ascendancy: 'path-lost' });
    const { profile, notices, changed } = fixProfile(
      profileOf({ fire: { progress: lost } }),
      context,
    );
    expect(notices).toEqual([{ kind: 'refundedAll', character: 'fire', ids: [] }]);
    expect(changed).toBe(true);
    expect(profile.characters.fire.progress).toEqual({ ...refundedAll(lost), ascendancy: null });
    // A slug the web has stays with none of its nodes; under B1 (no ascendancies yet) any stays.
    const other = profileOf({
      fire: {
        progress: { ...FIRE, ranks: without(FIRE.ranks, PATH_ONE_N1), ascendancy: 'path-two' },
      },
    });
    expect(fixProfile(other, context).profile).toBe(other);
    const early = profileOf({
      fire: {
        progress: { ...FIRE, ranks: without(FIRE.ranks, PATH_ONE_N1, MIGHT, 'hub.defense.r1') },
      },
    });
    const b1 = profileContext(fixtureContent('B1'), FULL_SCOPE);
    expect(b1.webOf('fire')?.def.ascendancies).toBeNull();
    expect(fixProfile(early, b1).profile).toBe(early);
  });

  it('reads the renames as own entries only: an id named like a prototype member stays itself', () => {
    const b1 = profileContext(fixtureContent('B1'), FULL_SCOPE);
    const odd = profileOf({
      summon: {
        progress: { ...SUMMON, ranks: { ...SUMMON.ranks, toString: 1, constructor: 2 } },
        loadouts: [{ valueOf: 1, hasOwnProperty: 2 }, null, null],
      },
    });
    expect(fixProfile(odd, b1)).toEqual({ profile: odd, notices: [], changed: false });
    const stored = deepFreeze({ ...FIRE, ranks: { ...FIRE.ranks, toString: 1 } });
    expect(fixProfile(profileOf({ fire: { progress: stored } }), context).notices).toEqual([
      { kind: 'refundedAll', character: 'fire', ids: ['toString'] },
    ]);
  });

  it('gives its notices in character order, and fixes every character', () => {
    const RETIRED = 'hub.defense.retired';
    const p = profileOf({
      fire: { progress: { ...FIRE, ranks: { ...FIRE.ranks, [RETIRED]: 1 } } },
      summon: { progress: { ...SUMMON, ranks: { [RETIRED]: 1, ...SUMMON.ranks } } },
      ice: { progress: { ...ICE, ascendancy: 'path-lost' } },
    });
    const { notices } = fixProfile(p, withRenames(context, { [RETIRED]: null }));
    expect(notices).toEqual([
      { kind: 'refundedAll', character: 'fire', ids: [RETIRED] },
      { kind: 'refundedAll', character: 'ice', ids: [] },
      { kind: 'refundedAll', character: 'summon', ids: [RETIRED] },
    ]);
  });

  it('keeps a cut alone, with nothing spent to refund', () => {
    const p = profileOf({
      fire: { progress: { ...FIRE, ranks: { ...FIRE.ranks, [R1]: 5 }, spent: ZEROS } },
    });
    const { profile, notices, changed } = fixProfile(p, context);
    expect(notices).toEqual([{ kind: 'dropped', character: 'fire', ids: [R1] }]);
    expect(changed).toBe(true);
    expect(profile.characters.fire.progress).toEqual({
      ...p.characters.fire.progress,
      ranks: { ...FIRE.ranks, [R1]: 3 },
    });
  });

  it('names a cut under its new name when the id was renamed as well', () => {
    const OLD_R1 = `${C}.alpha.old-r1`;
    const ranks = storedAs({ ...FIRE.ranks, [R1]: 5 }, R1, OLD_R1);
    const p = profileOf({ fire: { progress: { ...FIRE, ranks, spent: ZEROS } } });
    const { profile, notices, changed } = fixProfile(p, withRenames(context, { [OLD_R1]: R1 }));
    expect(notices).toEqual([{ kind: 'dropped', character: 'fire', ids: [R1] }]);
    expect(changed).toBe(true);
    expect(profile.characters.fire.progress).toEqual({
      ...p.characters.fire.progress,
      ranks: { ...FIRE.ranks, [R1]: 3 },
    });
    expect(Object.keys(profile.characters.fire.progress.ranks)).toEqual(Object.keys(FIRE.ranks));
  });

  it('keeps a third core while any character has beaten 奇點, and drops it once none has', () => {
    const beaten: AccountProgress = { singularityBeaten: true };
    const order: string[] = [];
    for (const outer of ['poison', 'crit', 'ice'] as const) {
      for (const id of Object.keys(unlockInvestment(fire, beaten, outer).ranks)) {
        if (!order.includes(id)) order.push(id);
      }
      order.push(`fusion.fire.${outer}.core`);
    }
    const three = deepFreeze({ ...progressFromOrder(fire, beaten, order), wallet: WALLET });
    const fresh = freshProfile();
    const flagged = (...by: readonly CharacterId[]): SaveProfile =>
      deepFreeze({
        account: {
          ...fresh.account,
          singularity: {
            fire: false,
            ice: false,
            lightning: false,
            summon: false,
            ...Object.fromEntries(by.map((c) => [c, true])),
          },
        },
        characters: { ...fresh.characters, fire: { ...fresh.characters.fire, progress: three } },
      });
    for (const c of CHARACTER_IDS) {
      const p = flagged(c);
      expect(fixProfile(p, context).profile, c).toBe(p);
    }
    const { profile, notices } = fixProfile(flagged(), context);
    expect(notices).toEqual([
      { kind: 'dropped', character: 'fire', ids: ['fusion.fire.ice.core'] },
    ]);
    expect(profile.characters.fire.progress.ranks).toEqual(
      without(three.ranks, 'fusion.fire.ice.core'),
    );
    expect(profile.characters.fire.progress.wallet.cores).toBe(WALLET.cores + 1);
  });
});

/** T2's 300 profiles and 200 more from the same seed: legal on the fixture webs. */
const LEGAL = deepFreeze(randomProfiles(context, 500, PROFILE_SEED));
/** Each damaged (testing.ts' damageProfile), with the renames its damage needs. */
const DAMAGED = LEGAL.map((profile, i) =>
  damageProfile(profile, context, createRng(deriveSeed(PROFILE_SEED, `damage:${i}`))),
);
for (const damaged of DAMAGED) deepFreeze([damaged.profile, damaged.context.renames]);
/** The first pass over DAMAGED[i], made once, when a test first needs it. */
const passes: ReturnType<typeof fixProfile>[] = [];
const firstPass = (i: number): ReturnType<typeof fixProfile> => {
  const damaged = DAMAGED[i] as (typeof DAMAGED)[number];
  return (passes[i] ??= fixProfile(damaged.profile, damaged.context));
};

// (i) catches changed always true (every open writes); T9, a path that loses or creates value.
describe('fixProfile on random profiles (T8 (i), T9)', () => {
  it('(i) keeps each legal profile: the same object, no notice, nothing changed', () => {
    for (const [i, profile] of LEGAL.slice(0, 300).entries()) {
      const result = fixProfile(profile, context);
      expect(result.notices, `profile ${i}`).toEqual([]);
      expect(result.changed, `profile ${i}`).toBe(false);
      expect(result.profile, `profile ${i}`).toBe(profile);
    }
  });

  it('(i) fixes a damaged profile in one pass, saying exactly whether it changed', () => {
    for (const [i, { profile, context: damage }] of DAMAGED.entries()) {
      const first = firstPass(i);
      const differs =
        JSON.stringify(toProfileData(first.profile)) !== JSON.stringify(toProfileData(profile));
      expect(first.changed, `profile ${i}`).toBe(differs);
      expect(first.profile === profile, `profile ${i}`).toBe(!first.changed);
      const second = fixProfile(deepFreeze(first.profile), damage);
      expect(second.notices, `profile ${i}`).toEqual([]);
      expect(second.changed, `profile ${i}`).toBe(false);
      expect(second.profile, `profile ${i}`).toBe(first.profile);
    }
  });

  it('T9: conserves every currency, by refundAll or by legalize’s exact move', () => {
    const issues = DAMAGED.flatMap(({ profile, context: damage }, i) => {
      const { profile: fixed, notices } = firstPass(i);
      return conservationIssues(profile, fixed, notices, damage).map((issue) => `${i} ${issue}`);
    });
    expect(issues).toEqual([]);
  });

  it('T9 covers both forms, partial and capped moves, cuts and loadouts', () => {
    let refunded = 0;
    let dropped = 0;
    let partial = 0;
    let capped = 0;
    let cut = 0;
    let loadouts = 0;
    let unchanged = 0;
    for (const [i, { profile }] of DAMAGED.entries()) {
      const { profile: fixed, notices, changed } = firstPass(i);
      if (!changed) unchanged++;
      for (const notice of notices) {
        if (notice.kind === 'refundedAll') refunded++;
        if (notice.kind !== 'dropped') continue;
        dropped++;
        const was = profile.characters[notice.character].progress;
        const now = fixed.characters[notice.character].progress;
        if (gt(now.spent.shards, ZERO) && gt(now.wallet.shards, was.wallet.shards)) partial++;
        if (now.spent.shards === 0 && gt(was.spent.shards, ZERO)) capped++;
        cut += notice.ids.filter((id) => Object.hasOwn(now.ranks, id)).length;
      }
      for (const c of CHARACTER_IDS) {
        if (fixed.characters[c].loadouts !== profile.characters[c].loadouts) loadouts++;
      }
    }
    const counts = { refunded, dropped, partial, capped, cut, loadouts, unchanged };
    const least = { refunded: 50, dropped: 50, partial: 10, capped: 1, cut: 10, loadouts: 10 };
    for (const [name, n] of Object.entries(least)) {
      expect(counts[name as keyof typeof least], JSON.stringify(counts)).toBeGreaterThanOrEqual(n);
    }
    expect(unchanged, JSON.stringify(counts)).toBeGreaterThanOrEqual(1);
  });
});
