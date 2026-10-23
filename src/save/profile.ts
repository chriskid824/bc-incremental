/**
 * Save v2 (docs/v3 C8 design §1.1–§1.5, §2.1, §2.2): the profile as immutable values, an account
 * and one slot per character; its strict zod schema; the data form it is written in, in a fixed key
 * order, so a load followed by a save gives the same text; a fresh profile; the context the
 * load-time fixes read; and the v3 loader and serializer of the SAVE_VERSION envelope, parseProfile
 * (§1.5's pipeline: v1 migrates, a newer version is refused as such) and serializeProfile, which
 * never writes what this build cannot read (D2). src/save/index.ts stays the M1 entry and
 * re-exports none of this (D1). B1 imports this module alone: it re-exports the account's
 * operations (account.ts) and the load-time fixes (fixes.ts), which import it for types only, so
 * no value-import cycle runs through src/save.
 */

import { z } from 'zod';
import { fromJSON, toJSON } from '../core/num';
import type { Num } from '../core/num';
import { CHARACTER_IDS, OUTER_IDS } from '../data/sources';
import type { CharacterId } from '../data/sources';
import { assembleWeb, scopeHolds } from '../data/web/assemble';
import { ID_RENAMES } from '../data/web/renames';
import type { AssembledWeb, Content, FusionKey, WebScope } from '../data/web/types';
import { DEFAULT_WEB_ECONOMY } from '../meta/web/price';
import { emptyProgress } from '../meta/web/rules';
import type { CharacterProgress, Wallet, WebEconomy } from '../meta/web/types';
import { fixProfile } from './fixes';
import { EnvelopeSchema, SAVE_GAME_ID, SAVE_VERSION } from './format';
import type { Envelope } from './format';
import { MIGRATIONS } from './migrations';

export * from './account';
export * from './fixes';

export type Speed = 1 | 2 | 4;

/** A loadout's node ranks (gd:808); B5 applies one through legalize. */
export type LoadoutRanks = Readonly<Record<string, number>>;

/** A character's slot: its progress (C6's CharacterProgress), its 3 loadouts and its start wave. */
export interface CharacterSlot {
  readonly progress: CharacterProgress;
  readonly loadouts: readonly [LoadoutRanks | null, LoadoutRanks | null, LoadoutRanks | null];
  /** The last start wave picked, as given (B1 clamps it to webStartWave); null before a pick. */
  readonly startWave: number | null;
}

/** v1's progress waiting on the account for the first pick (impl:506; C8.2's migration). */
export interface PendingV1 {
  readonly shards: Num;
  readonly cores: number;
  readonly maxWave: number;
}

/** A codex entry: the fusion was bought (「點過」); its best wave is the highest reached owning it. */
export interface CodexEntry {
  readonly bestWave: number;
}

export interface AccountSave {
  readonly codex: Readonly<Partial<Record<FusionKey, CodexEntry>>>;
  /** Each character's 奇點 beaten: the stored form of the challenge unlocks (F3, F7). */
  readonly singularity: Readonly<Record<CharacterId, boolean>>;
  readonly settings: { readonly speed: Speed };
  readonly stats: { readonly playSeconds: number; readonly runs: number };
  /** Where the select screen's cursor starts (impl:502). */
  readonly lastCharacter: CharacterId | null;
  readonly pendingV1: PendingV1 | null;
  /**
   * The enemy types met on this profile (C7's ruling L7: the new-enemy banner shows once per
   * profile), sorted and distinct: EnemyIds once a load's fixes have run.
   */
  readonly seenEnemies: readonly string[];
}

export interface SaveProfile {
  readonly account: AccountSave;
  /** All four characters, an unplayed one holding emptyProgress. */
  readonly characters: Readonly<Record<CharacterId, CharacterSlot>>;
}

/**
 * The 44 fusion keys, CHARACTER_IDS × OUTER_IDS without each character's own outer, in that
 * order: the codex's keys. validate.ts keeps its own list private.
 */
export const CODEX_KEYS: readonly FusionKey[] = CHARACTER_IDS.flatMap((c) =>
  OUTER_IDS.filter((o) => o !== c).map((o): FusionKey => `${c}.${o}`),
);

const count = z.number().int().nonnegative(); // zod 4: safe integers only
const amount = z.number().nonnegative(); // zod 4: rejects ±Infinity and NaN
/** Ids in strictly ascending order (the default sort's), so none twice; an unknown one is fine. */
const SeenEnemiesSchema = z
  .array(z.string().min(1))
  .refine((ids) => ids.every((id, i) => i === 0 || (ids[i - 1] as string) < id), {
    message: 'seenEnemies must be sorted and distinct',
  });

/** A strict object of one `schema` per character, in CHARACTER_IDS order. */
function perCharacter<S extends z.ZodType>(schema: S) {
  return z.strictObject(
    Object.fromEntries(CHARACTER_IDS.map((c) => [c, schema])) as Record<CharacterId, S>,
  );
}

const RanksSchema = z.record(z.string().min(1), z.number().int().min(1));
const WalletSchema = z.strictObject({ shards: amount, cores: count, resonance: count });
const SlotSchema = z.strictObject({
  ranks: RanksSchema,
  wallet: WalletSchema,
  spent: WalletSchema,
  bestWave: count,
  cycleBest: count,
  prestiges: count,
  resonanceEarned: count,
  ascendancy: z.string().min(1).nullable(),
  runs: count,
  loadouts: z.tuple([RanksSchema.nullable(), RanksSchema.nullable(), RanksSchema.nullable()]),
  startWave: z.number().int().min(1).nullable(),
});
const AccountSchema = z.strictObject({
  codex: z.partialRecord(z.enum(CODEX_KEYS), z.strictObject({ bestWave: count })),
  singularity: perCharacter(z.boolean()),
  settings: z.strictObject({ speed: z.union([z.literal(1), z.literal(2), z.literal(4)]) }),
  stats: z.strictObject({ playSeconds: amount, runs: count }),
  lastCharacter: z.enum(CHARACTER_IDS).nullable(),
  pendingV1: z.strictObject({ shards: amount, cores: count, maxWave: count }).nullable(),
  seenEnemies: SeenEnemiesSchema,
});

/** Save v2's data, the envelope's `data` from C8.2 (§1.4): every object strict. */
export const ProfileDataSchema = z.strictObject({
  account: AccountSchema,
  characters: perCharacter(SlotSchema),
});

export type ProfileData = z.infer<typeof ProfileDataSchema>;
type SlotData = ProfileData['characters'][CharacterId];
type WalletData = SlotData['wallet'];

/**
 * What a load tells the player (§1.5): fixProfile makes the first two, parseProfile v1Waiting,
 * B1 v1Claimed and the store (src/app/profileStore.ts) the last four.
 */
export type SaveNotice =
  /** Step 4: ids renamed to null, merged or outside the web, or a lost ascendancy: all refunded. */
  | {
      readonly kind: 'refundedAll';
      readonly character: CharacterId;
      readonly ids: readonly string[];
    }
  /** Step 5: ids legalize dropped, then ids whose rank it cut, each refunded exactly. */
  | { readonly kind: 'dropped'; readonly character: CharacterId; readonly ids: readonly string[] }
  /** parseProfile: a v1 save's progress waits for the first pick. */
  | { readonly kind: 'v1Waiting'; readonly pending: PendingV1 }
  /** B1, when selectCharacter claims the pending. */
  | { readonly kind: 'v1Claimed'; readonly character: CharacterId; readonly pending: PendingV1 }
  /** The store: `main` failed and `backup` loaded; the error is for the log. */
  | { readonly kind: 'restored'; readonly error: string }
  /** The store: a slot is from a newer version, so nothing is written. */
  | { readonly kind: 'newer'; readonly version: number }
  /** The store: no slot loads; the errors are for the log. */
  | { readonly kind: 'unreadable'; readonly errors: readonly string[] }
  /** The store: a slot could not be read, so nothing is saved until a restart; errors for the log. */
  | { readonly kind: 'readFailed'; readonly errors: readonly string[] };

/** What fixProfile reads: each character's web, the economy legalize prices with, the renames. */
export interface LoadContext {
  /** null while the character is 「製作中」 or outside the scope: then no legalize. */
  webOf(character: CharacterId): AssembledWeb | null;
  readonly economy: WebEconomy;
  readonly renames: Readonly<Record<string, string | null>>;
}

/** A record of `value(c)` per character, in CHARACTER_IDS order. */
const byCharacter = <T>(value: (c: CharacterId) => T): Record<CharacterId, T> =>
  Object.fromEntries(CHARACTER_IDS.map((c) => [c, value(c)])) as Record<CharacterId, T>;

/** A profile before any play (§1.2, §1.3): four empty slots, speed 1, nothing else set. */
export function freshProfile(): SaveProfile {
  return {
    account: {
      codex: {},
      singularity: byCharacter(() => false),
      settings: { speed: 1 },
      stats: { playSeconds: 0, runs: 0 },
      lastCharacter: null,
      pendingV1: null,
      seenEnemies: [],
    },
    characters: byCharacter((c) => ({
      progress: emptyProgress(c),
      loadouts: [null, null, null],
      startWave: null,
    })),
  };
}

/** The codex's entries copied in their order. */
function copyCodex(
  codex: Readonly<Partial<Record<FusionKey, CodexEntry>>>,
): Partial<Record<FusionKey, CodexEntry>> {
  const copy: Partial<Record<FusionKey, CodexEntry>> = {};
  for (const key of Object.keys(codex) as FusionKey[]) {
    const entry = codex[key];
    if (entry !== undefined) copy[key] = { bestWave: entry.bestWave };
  }
  return copy;
}

const walletData = (wallet: Wallet): WalletData => ({
  shards: toJSON(wallet.shards),
  cores: wallet.cores,
  resonance: wallet.resonance,
});

const walletFrom = (data: WalletData): Wallet => ({
  shards: fromJSON(data.shards),
  cores: data.cores,
  resonance: data.resonance,
});

const copyRanks = (ranks: LoadoutRanks | null): Record<string, number> | null =>
  ranks === null ? null : { ...ranks };

/**
 * The data form of `profile` (§1.4): shards through toJSON, no `character`, the account and then
 * the characters in CHARACTER_IDS order, every object's fields in the schema's order and records
 * in their own, so the text depends on the profile alone, not on how it was built.
 */
export function toProfileData(profile: SaveProfile): ProfileData {
  const { account } = profile;
  const pending = account.pendingV1;
  return {
    account: {
      codex: copyCodex(account.codex),
      singularity: byCharacter((c) => account.singularity[c]),
      settings: { speed: account.settings.speed },
      stats: { playSeconds: account.stats.playSeconds, runs: account.stats.runs },
      lastCharacter: account.lastCharacter,
      pendingV1:
        pending === null
          ? null
          : { shards: toJSON(pending.shards), cores: pending.cores, maxWave: pending.maxWave },
      seenEnemies: [...account.seenEnemies],
    },
    characters: byCharacter((c): SlotData => {
      const { progress, loadouts, startWave } = profile.characters[c];
      return {
        ranks: { ...progress.ranks },
        wallet: walletData(progress.wallet),
        spent: walletData(progress.spent),
        bestWave: progress.bestWave,
        cycleBest: progress.cycleBest,
        prestiges: progress.prestiges,
        resonanceEarned: progress.resonanceEarned,
        ascendancy: progress.ascendancy,
        runs: progress.runs,
        loadouts: [copyRanks(loadouts[0]), copyRanks(loadouts[1]), copyRanks(loadouts[2])],
        startWave,
      };
    }),
  };
}

/**
 * The profile of validated `data`: each slot's `character` from its key, shards through fromJSON
 * (which throws on a non-finite value), every object built in the same fixed order as freshProfile.
 */
export function fromProfileData(data: ProfileData): SaveProfile {
  const { account } = data;
  const pending = account.pendingV1;
  return {
    account: {
      codex: copyCodex(account.codex),
      singularity: byCharacter((c) => account.singularity[c]),
      settings: { speed: account.settings.speed },
      stats: { playSeconds: account.stats.playSeconds, runs: account.stats.runs },
      lastCharacter: account.lastCharacter,
      pendingV1:
        pending === null
          ? null
          : { shards: fromJSON(pending.shards), cores: pending.cores, maxWave: pending.maxWave },
      seenEnemies: [...account.seenEnemies],
    },
    characters: byCharacter((character): CharacterSlot => {
      const slot = data.characters[character];
      return {
        progress: {
          character,
          ranks: { ...slot.ranks },
          wallet: walletFrom(slot.wallet),
          spent: walletFrom(slot.spent),
          bestWave: slot.bestWave,
          cycleBest: slot.cycleBest,
          prestiges: slot.prestiges,
          resonanceEarned: slot.resonanceEarned,
          ascendancy: slot.ascendancy,
          runs: slot.runs,
        },
        loadouts: [
          copyRanks(slot.loadouts[0]),
          copyRanks(slot.loadouts[1]),
          copyRanks(slot.loadouts[2]),
        ],
        startWave: slot.startWave,
      };
    }),
  };
}

/**
 * The load context of `content` in `scope` (F9: FULL_SCOPE until B2's VITE_FLAVOR): webOf(c) is c's
 * web when c has a center and the scope holds it, as the viewer tests (src/app/viewer.ts), else
 * null, so assembleWeb, which throws for either, is never called for it. Each web is assembled on
 * its first request and at most once.
 */
export function profileContext(
  content: Content,
  scope: WebScope,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
  renames: Readonly<Record<string, string | null>> = ID_RENAMES,
): LoadContext {
  const webs = new Map<CharacterId, AssembledWeb | null>();
  return {
    webOf(character: CharacterId): AssembledWeb | null {
      if (!webs.has(character)) {
        const built =
          content.characters[character].center !== null && scopeHolds(scope.characters, character);
        webs.set(character, built ? assembleWeb(content, character, scope) : null);
      }
      return webs.get(character) ?? null;
    },
    economy,
    renames,
  };
}

/** serializeProfile's refusal of a profile this build could not read back (D2). */
export class SaveFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SaveFormatError';
  }
}

/**
 * The SAVE_VERSION envelope of `profile`, as JSON text; `savedAt` is an ISO timestamp. The data is
 * toProfileData's as ProfileDataSchema reads it back; a profile the schema refuses (a fractional
 * count, a non-finite amount, a rank of 0, an unsorted seenEnemies) throws SaveFormatError with
 * the schema's issues, so nothing is written that this build cannot read (D2).
 */
export function serializeProfile(profile: SaveProfile, savedAt: string): string {
  const parsed = ProfileDataSchema.safeParse(toProfileData(profile));
  if (!parsed.success) {
    throw new SaveFormatError(`the profile cannot be saved: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  const envelope: Envelope = { v: SAVE_VERSION, savedAt, game: SAVE_GAME_ID, data: parsed.data };
  return JSON.stringify(envelope);
}

/** What parseProfile gives: a profile with its notices, or why there is none. */
export type ProfileLoad =
  | {
      readonly ok: true;
      readonly profile: SaveProfile;
      /** The version the text was written with, 1 to SAVE_VERSION. */
      readonly fromVersion: number;
      readonly notices: readonly SaveNotice[];
      /** The profile differs from the text (an older version, a load-time fix): save at once. */
      readonly changed: boolean;
    }
  /** A version this build does not know: the text must not be overwritten (F12). */
  | { readonly ok: false; readonly reason: 'newer'; readonly version: number }
  | { readonly ok: false; readonly reason: 'invalid'; readonly error: string };

const invalid = (error: string): ProfileLoad => ({ ok: false, reason: 'invalid', error });
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The v3 loader (§1.5): JSON.parse, the envelope, a version above SAVE_VERSION refused as `newer`
 * (never `invalid`, which the store's guard depends on), MIGRATIONS[v] to SAVE_VERSION in order
 * (one that throws, as MIGRATIONS[1] does on bad v1 data, makes it `invalid`), ProfileDataSchema,
 * fromProfileData, then fixProfile under `context`. A v1 save with progress waiting adds a
 * v1Waiting notice after the fixes' (B1 builds v1Claimed from selectCharacter's `claimed`), and
 * `changed` is true for a text of an older version as well as for any fix.
 */
export function parseProfile(text: string, context: LoadContext): ProfileLoad {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid('not JSON');
  }
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) return invalid(`bad envelope: ${envelope.error.message}`);
  const { v } = envelope.data;
  if (v > SAVE_VERSION) return { ok: false, reason: 'newer', version: v };

  let body = envelope.data.data;
  for (let version = v; version < SAVE_VERSION; version++) {
    const migrate = MIGRATIONS[version];
    if (migrate === undefined) return invalid(`no migration from version ${version}`);
    try {
      body = migrate(body);
    } catch (error) {
      return invalid(`v${version} data: ${messageOf(error)}`);
    }
  }
  const parsed = ProfileDataSchema.safeParse(body);
  if (!parsed.success) return invalid(`bad data: ${parsed.error.message}`);
  let profile: SaveProfile;
  try {
    profile = fromProfileData(parsed.data);
  } catch (error) {
    return invalid(`bad data: ${messageOf(error)}`);
  }

  const fixed = fixProfile(profile, context);
  const pending = fixed.profile.account.pendingV1;
  const waiting: SaveNotice[] = v === 1 && pending !== null ? [{ kind: 'v1Waiting', pending }] : [];
  return {
    ok: true,
    profile: fixed.profile,
    fromVersion: v,
    notices: [...fixed.notices, ...waiting],
    changed: fixed.changed || v < SAVE_VERSION,
  };
}
