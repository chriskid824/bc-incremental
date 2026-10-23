/**
 * Seeded profiles for save v2's tests and tools (docs/v3 C8 design §2.1's T2, T8 (i) and T9):
 * legal random profiles built from sampleProgress on the fixture webs, random damage of the kinds
 * a load repairs, the conservation check a repaired profile passes, deepFreeze for a test's
 * inputs, and a v1 save's stale twin (the lead's ruling L2, for C8.2's tests). Every draw comes
 * from createRng and deriveSeed. Imported by tests and tools only, as src/data/web/testing.ts is.
 */

import { add, gt, min, num, sub, ZERO } from '../core/num';
import type { Num } from '../core/num';
import { createRng, deriveSeed } from '../core/rng';
import type { Rng } from '../core/rng';
import { CHARACTER_IDS } from '../data/sources';
import type { CharacterId } from '../data/sources';
import { FULL_SCOPE } from '../data/web/scope';
import { fixtureContent } from '../data/web/testing';
import type { AssembledWeb, FusionKey } from '../data/web/types';
import { canonicalCost } from '../meta/web/price';
import { emptyProgress } from '../meta/web/rules';
import { sampleProgress } from '../meta/web/sample';
import type { CharacterProgress, Wallet } from '../meta/web/types';
import { EnvelopeSchema, SaveDataSchema } from './format';
import { CODEX_KEYS, profileContext } from './profile';
import type {
  AccountSave,
  CharacterSlot,
  CodexEntry,
  LoadContext,
  LoadoutRanks,
  SaveNotice,
  SaveProfile,
  Speed,
} from './profile';

type Renames = LoadContext['renames'];

/** The seed of the property tests' profiles (T2, T8 (i)). */
export const PROFILE_SEED = 0xc81;

/** profileContext on fixtureContent() in FULL_SCOPE: the four fixture webs, with `renames`. */
export function fixtureContext(renames: Renames = {}): LoadContext {
  return profileContext(fixtureContent(), FULL_SCOPE, undefined, renames);
}

/** `context` with other renames: the same webs, assembled once, and the same economy. */
export function withRenames(context: LoadContext, renames: Renames): LoadContext {
  return { webOf: (c) => context.webOf(c), economy: context.economy, renames };
}

/**
 * Amounts that must survive JSON exactly: 0, the least subnormal, the 1e300 ceiling and fractions,
 * most of which no binary fraction ends.
 */
const SPECIAL_AMOUNTS: readonly number[] = [
  0,
  5e-324,
  1e300,
  0.1,
  0.7,
  1 / 3,
  2 / 3,
  987.25,
  1234.5678,
  98765.4321,
];

/** A shard amount: a special one, else log-uniform from 0.001 to 1e300. */
export function randomAmount(rng: Rng): Num {
  return num(rng.chance(0.25) ? rng.pick(SPECIAL_AMOUNTS) : 10 ** rng.range(-3, 300));
}

/** A count of cores: mostly below a million, sometimes 0 or near 2^31 and 2^51. */
const randomCount = (rng: Rng): number =>
  rng.chance(0.1) ? rng.pick([0, 2 ** 31, 2 ** 51]) : rng.int(1_000_000);

const randomWallet = (rng: Rng): Wallet => ({
  shards: randomAmount(rng),
  cores: randomCount(rng),
  resonance: rng.int(60),
});

/** `items` in an order drawn from `rng`. */
function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Best waves a build is drawn at: around both reveal waves (D20) and the legacy ones. */
const BEST_WAVES = [0, 3, 14, 15, 29, 30, 59, 60, 100, 140] as const;
/** Builds drawn per web; a profile picks its characters' builds among them. */
const BUILDS_PER_WEB = 24;

interface Build {
  readonly progress: CharacterProgress;
  /** Drawn with the third fusion slot open (an account that has beaten 奇點). */
  readonly thirdSlot: boolean;
}

/** BUILDS_PER_WEB legal builds of `web` (sampleProgress, D25), each from its own seed. */
function buildsOf(web: AssembledWeb, seed: number): Build[] {
  return Array.from({ length: BUILDS_PER_WEB }, (_, i) => {
    const rng = createRng(deriveSeed(seed, `build:${web.character}:${i}`));
    const thirdSlot = rng.chance(0.3);
    const progress = sampleProgress(web, rng, {
      purchases: rng.int(141),
      account: { singularityBeaten: thirdSlot },
      bestWave: rng.pick(BEST_WAVES),
      prestiged: rng.chance(0.5),
    });
    return { progress, thirdSlot };
  });
}

/** `ranks` keeping each entry with probability 1/2, in order. */
const someOf = (rng: Rng, ranks: LoadoutRanks): LoadoutRanks =>
  Object.fromEntries(Object.entries(ranks).filter(() => rng.chance(0.5)));

/**
 * A played slot on `build`: a random wallet, a random spent for some (else the build's price), a
 * cycle best up to the best wave, more prestiges for a prestiged build, a chain chosen without its
 * nodes for some, random counters, loadouts from the web's builds and a start wave or none.
 */
function playedSlot(
  rng: Rng,
  web: AssembledWeb,
  build: CharacterProgress,
  builds: readonly Build[],
): CharacterSlot {
  const prestiges = build.prestiges > 0 ? 1 + rng.int(4) : 0;
  const slugs = web.def.ascendancies?.map((ascendancy) => ascendancy.slug) ?? [];
  const chosen = prestiges > 0 && slugs.length > 0 && rng.chance(0.3) ? rng.pick(slugs) : null;
  const loadout = (): LoadoutRanks | null =>
    rng.chance(0.5) ? null : someOf(rng, rng.pick(builds).progress.ranks);
  return {
    progress: {
      ...build,
      wallet: randomWallet(rng),
      spent: rng.chance(0.3) ? randomWallet(rng) : build.spent,
      cycleBest: rng.int(build.bestWave + 1),
      prestiges,
      resonanceEarned: rng.int(40),
      ascendancy: build.ascendancy ?? chosen,
      runs: rng.int(600),
    },
    loadouts: [loadout(), loadout(), loadout()],
    startWave: rng.chance(0.5) ? null : 1 + rng.int(80),
  };
}

/** One profile: each character empty or on one of its web's builds, with a random account. */
function randomProfile(
  rng: Rng,
  context: LoadContext,
  builds: ReadonlyMap<CharacterId, readonly Build[]>,
): SaveProfile {
  let thirdSlot = false;
  const characters = {} as Record<CharacterId, CharacterSlot>;
  for (const c of CHARACTER_IDS) {
    const web = context.webOf(c);
    const pool = builds.get(c);
    if (web === null || pool === undefined || rng.chance(0.15)) {
      characters[c] = { progress: emptyProgress(c), loadouts: [null, null, null], startWave: null };
      continue;
    }
    const build = rng.pick(pool);
    thirdSlot ||= build.thirdSlot;
    characters[c] = playedSlot(rng, web, build.progress, pool);
  }
  const singularity = Object.fromEntries(CHARACTER_IDS.map((c) => [c, rng.chance(0.15)])) as Record<
    CharacterId,
    boolean
  >;
  // A build drawn with the third slot is legal only while some character has beaten 奇點.
  if (thirdSlot && !CHARACTER_IDS.some((c) => singularity[c])) {
    singularity[rng.pick(CHARACTER_IDS)] = true;
  }
  const codex: Partial<Record<FusionKey, CodexEntry>> = {};
  for (const key of shuffled(rng, CODEX_KEYS).slice(0, rng.int(13))) {
    codex[key] = { bestWave: rng.int(120) };
  }
  const account: AccountSave = {
    codex,
    singularity,
    settings: { speed: rng.pick<Speed>([1, 2, 4]) },
    stats: { playSeconds: rng.next() * 10 ** rng.int(8), runs: rng.int(5000) },
    lastCharacter: rng.chance(0.3) ? null : rng.pick(CHARACTER_IDS),
    pendingV1: rng.chance(0.3)
      ? { shards: randomAmount(rng), cores: randomCount(rng), maxWave: rng.int(41) }
      : null,
  };
  return { account, characters };
}

/**
 * `count` random profiles, legal under `context` (fixProfile keeps them as they are): each
 * character with a web is empty or holds one of BUILDS_PER_WEB legal builds of it, drawn once per
 * call, under an account whose singularity flags open every third slot a build uses; wallets,
 * spent, counters, codex, settings, stats, pending and loadouts are random. Profile i draws from
 * deriveSeed(seed, 'profile:' + i), so a seed gives the same profiles in every test file.
 */
export function randomProfiles(context: LoadContext, count: number, seed: number): SaveProfile[] {
  const builds = new Map<CharacterId, Build[]>();
  for (const c of CHARACTER_IDS) {
    const web = context.webOf(c);
    if (web !== null) builds.set(c, buildsOf(web, seed));
  }
  return Array.from({ length: count }, (_, i) =>
    randomProfile(createRng(deriveSeed(seed, `profile:${i}`)), context, builds),
  );
}

/** A profile damaged as a load may find it, and the context whose renames the damage needs. */
export interface Damaged {
  readonly profile: SaveProfile;
  readonly context: LoadContext;
}

/**
 * The damage a load repairs: an owned id dropped (what it connected or unlocked no longer fits), a
 * rank above its node's count, an id found nowhere, an id renamed to null, an id stored under an
 * old name, a merge onto a stored id, an unknown ascendancy, the other chain chosen, a lower best
 * wave, no prestige, a random spent, and a loadout with old, removed and unknown ids.
 */
export const DAMAGE_KINDS = [
  'drop',
  'overRank',
  'unknown',
  'nullRename',
  'alias',
  'merge',
  'slug',
  'otherChain',
  'lowerWave',
  'unprestige',
  'spent',
  'loadout',
] as const;
export type DamageKind = (typeof DAMAGE_KINDS)[number];

/** `ranks` with `from` replaced by `to` in its place, keeping its rank. */
const replaced = (ranks: LoadoutRanks, from: string, to: string): LoadoutRanks =>
  Object.fromEntries(Object.entries(ranks).map(([id, rank]) => [id === from ? to : id, rank]));

/**
 * One damage of `kind` to `slot`, adding to `renames` what it needs. A renamed id never becomes the
 * target of another rename, nor a target an old id (as V21 keeps ID_RENAMES), so the fixes stay
 * idempotent; a kind that cannot apply leaves the slot as it is.
 */
function damaged(
  rng: Rng,
  kind: DamageKind,
  slot: CharacterSlot,
  web: AssembledWeb,
  renames: Record<string, string | null>,
): CharacterSlot {
  const { progress } = slot;
  const owned = Object.keys(progress.ranks);
  const targets = new Set(Object.values(renames));
  // An owned id free to rename (no rename points at it) or to point a rename at (none from it).
  const free = owned.filter((id) => !targets.has(id) && !Object.hasOwn(renames, id));
  const withProgress = (changes: Partial<CharacterProgress>): CharacterSlot => ({
    ...slot,
    progress: { ...progress, ...changes },
  });
  const slugs = web.def.ascendancies?.map((ascendancy) => ascendancy.slug) ?? [];
  switch (kind) {
    case 'drop': {
      if (owned.length === 0) return slot;
      const id = rng.pick(owned);
      return withProgress({
        ranks: Object.fromEntries(Object.entries(progress.ranks).filter(([key]) => key !== id)),
      });
    }
    case 'overRank': {
      const counted = owned.filter((id) => typeof web.byId.get(id)?.ranks === 'number');
      if (counted.length === 0) return slot;
      const id = rng.pick(counted);
      const ranks = web.byId.get(id)?.ranks as number;
      return withProgress({ ranks: { ...progress.ranks, [id]: ranks + 1 + rng.int(3) } });
    }
    case 'unknown': {
      const id = `${web.character}.center.alpha.lost-${rng.int(100)}`;
      return withProgress({ ranks: { ...progress.ranks, [id]: 1 + rng.int(3) } });
    }
    case 'nullRename': {
      if (free.length === 0) return slot;
      renames[rng.pick(free)] = null;
      return slot;
    }
    case 'alias': {
      if (free.length === 0) return slot;
      const id = rng.pick(free);
      renames[`${id}-was`] = id;
      return withProgress({ ranks: replaced(progress.ranks, id, `${id}-was`) });
    }
    case 'merge': {
      if (free.length === 0) return slot;
      const id = rng.pick(free);
      renames[`${id}-dup`] = id;
      return withProgress({ ranks: { ...progress.ranks, [`${id}-dup`]: 1 + rng.int(2) } });
    }
    case 'slug':
      return slugs.length === 0 ? slot : withProgress({ ascendancy: 'path-lost' });
    case 'otherChain': {
      const other = slugs.find((slug) => slug !== progress.ascendancy);
      return progress.ascendancy === null || other === undefined
        ? slot
        : withProgress({ ascendancy: other });
    }
    case 'lowerWave':
      return withProgress({ bestWave: rng.int(progress.bestWave + 1) });
    case 'unprestige':
      return withProgress({ prestiges: 0 });
    case 'spent':
      return withProgress({ spent: randomWallet(rng) });
    case 'loadout': {
      const k = rng.int(3);
      const loadout: Record<string, number> = { ...(slot.loadouts[k] ?? {}) };
      loadout[`${web.character}.center.beta.lost-${rng.int(100)}`] = 1;
      if (free.length > 0) {
        const id = rng.pick(free);
        renames[`${id}-was`] = id;
        renames[`${id}-gone`] = null;
        loadout[`${id}-was`] = 1 + rng.int(3);
        loadout[`${id}-gone`] = 1;
      }
      const loadouts = [...slot.loadouts] as [
        LoadoutRanks | null,
        LoadoutRanks | null,
        LoadoutRanks | null,
      ];
      loadouts[k] = loadout;
      return { ...slot, loadouts };
    }
  }
}

/**
 * `profile` with random damage (DAMAGE_KINDS): each character with a web takes one to three kinds
 * with probability 0.7, and one profile in ten loses every singularity flag (a third core no
 * longer fits). The context returned is `context` with the renames the damage added.
 */
export function damageProfile(profile: SaveProfile, context: LoadContext, rng: Rng): Damaged {
  const renames: Record<string, string | null> = { ...context.renames };
  const characters: Record<CharacterId, CharacterSlot> = { ...profile.characters };
  for (const c of CHARACTER_IDS) {
    const web = context.webOf(c);
    if (web === null || !rng.chance(0.7)) continue;
    let slot = characters[c];
    for (let n = 1 + rng.int(3); n > 0; n--) {
      slot = damaged(rng, rng.pick(DAMAGE_KINDS), slot, web, renames);
    }
    characters[c] = slot;
  }
  const unbeaten = Object.fromEntries(CHARACTER_IDS.map((c) => [c, false]));
  const account: AccountSave = rng.chance(0.1)
    ? { ...profile.account, singularity: unbeaten as Record<CharacterId, boolean> }
    : profile.account;
  return { profile: { account, characters }, context: withRenames(context, renames) };
}

/** min(spent, difference), never below 0: what legalize refunds (rules.ts' capped). */
function capped(spent: Num, difference: Num): Num {
  const refund = min(spent, difference);
  return gt(refund, ZERO) ? refund : ZERO;
}
const cappedCount = (spent: number, difference: number): number =>
  spent > 0 && difference > 0 ? Math.min(spent, difference) : 0;

/** `ranks` with each id through the renames, null and merged ones included (a check's reading). */
const renamedKeys = (ranks: LoadoutRanks, renames: Renames): LoadoutRanks =>
  Object.fromEntries(
    Object.entries(ranks).map(([id, rank]) => [
      Object.hasOwn(renames, id) ? String(renames[id]) : id,
      rank,
    ]),
  );

/**
 * T9's conservation (§2.1) of `before` fixed into `after` with `notices` under `context`. Per
 * character and currency, with w and s the wallet and spent before, one form holds: refundAll
 * for a character with a refundedAll notice (r = s, so spent' = 0, and no rank kept); else
 * legalize's move with a web, r = min(s, canonicalCost(before) − canonicalCost(after)) floored
 * at 0, `before` being the stored ranks through the renames; else none (r = 0). Then
 * wallet' = add(w, r) and spent' = sub(s, r) bit for bit, and cores and 迴響 also as an exact
 * sum. One message per broken rule: [] when no value was lost or made.
 */
export function conservationIssues(
  before: SaveProfile,
  after: SaveProfile,
  notices: readonly SaveNotice[],
  context: LoadContext,
): string[] {
  const issues: string[] = [];
  for (const c of CHARACTER_IDS) {
    const was = before.characters[c].progress;
    const now = after.characters[c].progress;
    const web = context.webOf(c);
    const { wallet: w, spent: s } = was;
    let refund: Wallet;
    if (notices.some((notice) => notice.kind === 'refundedAll' && notice.character === c)) {
      refund = s;
      if (Object.keys(now.ranks).length > 0) issues.push(`${c}: refunded in full but owns ranks`);
    } else if (web === null) {
      refund = { shards: ZERO, cores: 0, resonance: 0 };
    } else {
      const cost = canonicalCost(
        web,
        { ...was, ranks: renamedKeys(was.ranks, context.renames) },
        context.economy,
      );
      const left = canonicalCost(web, now, context.economy);
      refund = {
        shards: capped(s.shards, sub(cost.shards, left.shards)),
        cores: cappedCount(s.cores, cost.cores - left.cores),
        resonance: cappedCount(s.resonance, cost.resonance - left.resonance),
      };
    }
    if (!Object.is(now.wallet.shards, add(w.shards, refund.shards))) {
      issues.push(`${c}: wallet shards ${now.wallet.shards}, not ${w.shards} + ${refund.shards}`);
    }
    if (!Object.is(now.spent.shards, sub(s.shards, refund.shards))) {
      issues.push(`${c}: spent shards ${now.spent.shards}, not ${s.shards} − ${refund.shards}`);
    }
    for (const currency of ['cores', 'resonance'] as const) {
      const r = refund[currency];
      if (now.wallet[currency] !== w[currency] + r || now.spent[currency] !== s[currency] - r) {
        issues.push(
          `${c}: ${currency} ${now.wallet[currency]} and spent ${now.spent[currency]}, ` +
            `not ${w[currency]} + ${r} and ${s[currency]} − ${r}`,
        );
      }
      if (now.wallet[currency] + now.spent[currency] !== w[currency] + s[currency]) {
        issues.push(`${c}: ${currency} sum ${now.wallet[currency] + now.spent[currency]} changed`);
      }
    }
  }
  return issues;
}

/** `value` with every object and array in it frozen: a test's input, so a mutation throws. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * A v1 save's stale twin (the lead's ruling L2, for C8.2): `text` with `staleId` appended to its
 * allocated talents and written as serializeSave writes, so the M1 loader finds an allocation that
 * no longer fits and refunds it. Throws when `text` is not a v1 save or already allocates the id;
 * the caller asserts that the M1 web lacks it.
 */
export function staleTwinV1(text: string, staleId: string): string {
  const envelope = EnvelopeSchema.parse(JSON.parse(text));
  if (envelope.v !== 1) throw new Error(`staleTwinV1: a v1 save is needed, not v${envelope.v}`);
  const data = SaveDataSchema.parse(envelope.data);
  if (data.meta.allocated.includes(staleId)) {
    throw new Error(`staleTwinV1: '${staleId}' is allocated already`);
  }
  const meta = { ...data.meta, allocated: [...data.meta.allocated, staleId] };
  return JSON.stringify({ ...envelope, data: { ...data, meta } });
}
