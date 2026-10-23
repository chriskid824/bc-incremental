/**
 * The account's operations on a SaveProfile and what it derives (docs/v3 C8 design §1.2, §2.1; F3,
 * F4, F5, F7): the first pick's claim of v1's pending progress, a character's progress with its
 * codex marks, a run's record, the enemy types met, the start wave, speed and play time, and,
 * never stored, the purchase rules' AccountProgress, the legacy milestones and the challenge
 * unlocks. Each operation returns a new profile and changes nothing it is given (C6's D21): the
 * parts it leaves are shared, and a no-op returns the same object. The recorders live here, not in
 * src/meta/web, so no C8 file is in the run path (F4); the milestones' effects are B5's.
 * profile.ts re-exports this module, which imports it for types only.
 */

import { add } from '../core/num';
import { CHARACTER_IDS } from '../data/sources';
import type { CharacterId } from '../data/sources';
import { ENEMY_IDS } from '../data/types';
import type { EnemyId } from '../data/types';
import { parseNodeId } from '../data/web/ids';
import type { FusionKey } from '../data/web/types';
import type { AccountProgress, CharacterProgress } from '../meta/web/types';
import type { AccountSave, CodexEntry, PendingV1, SaveProfile, Speed } from './profile';

type Codex = AccountSave['codex'];

/**
 * The fusion keys of the cores `character` owns in `progress`, in key order: ids parseNodeId reads
 * as `fusion.<character>.<o>.core`, stored at a finite rank of at least 1 (rankOf's reading).
 */
function ownedCores(progress: CharacterProgress, character: CharacterId): FusionKey[] {
  const keys: FusionKey[] = [];
  for (const [id, rank] of Object.entries(progress.ranks)) {
    if (!(Number.isFinite(rank) && rank >= 1)) continue;
    const parsed = parseNodeId(id);
    if (parsed?.block === 'fusion' && parsed.slot === 'core' && parsed.character === character) {
      keys.push(`${character}.${parsed.outer}`);
    }
  }
  return keys;
}

/** `codex` with `entry` under `key`, appended when new; the same codex when it already holds it. */
function withEntry(codex: Codex, key: FusionKey, entry: CodexEntry): Codex {
  return codex[key]?.bestWave === entry.bestWave ? codex : { ...codex, [key]: entry };
}

/**
 * The pick of `c` on the select screen: lastCharacter becomes c, and a pending v1 progress goes to
 * c's slot (impl:506; F5): its shards added to the wallet's with one add, its cores to the
 * wallet's, bestWave and cycleBest raised to its maxWave, so an empty slot starts exactly as
 * C6D:1876 says and a played one keeps what it has. `claimed` is the pending (B1's v1Claimed
 * notice); the account keeps none. Without a pending only lastCharacter changes, and not at all
 * when it is c already.
 */
export function selectCharacter(
  p: SaveProfile,
  c: CharacterId,
): { readonly profile: SaveProfile; readonly claimed: PendingV1 | null } {
  const { account } = p;
  const pending = account.pendingV1;
  if (pending === null) {
    if (account.lastCharacter === c) return { profile: p, claimed: null };
    return { profile: { ...p, account: { ...account, lastCharacter: c } }, claimed: null };
  }
  const slot = p.characters[c];
  const { progress } = slot;
  const claimant: CharacterProgress = {
    ...progress,
    wallet: {
      ...progress.wallet,
      shards: add(progress.wallet.shards, pending.shards),
      cores: progress.wallet.cores + pending.cores,
    },
    bestWave: Math.max(progress.bestWave, pending.maxWave),
    cycleBest: Math.max(progress.cycleBest, pending.maxWave),
  };
  return {
    profile: {
      ...p,
      account: { ...account, lastCharacter: c, pendingV1: null },
      characters: { ...p.characters, [c]: { ...slot, progress: claimant } },
    },
    claimed: pending,
  };
}

/**
 * c's progress replaced by `progress` (after a buy, a refund or a run's settlement), and a codex
 * entry { bestWave: 0 } for each core it owns that has none: 「點過」 is for good, so an entry is
 * never removed or lowered. Throws when `progress` is another character's.
 */
export function setProgress(
  p: SaveProfile,
  c: CharacterId,
  progress: CharacterProgress,
): SaveProfile {
  if (progress.character !== c) {
    throw new Error(`setProgress: progress of '${progress.character}' given for '${c}'`);
  }
  const { account } = p;
  let codex = account.codex;
  for (const key of ownedCores(progress, c)) {
    if (codex[key] === undefined) codex = withEntry(codex, key, { bestWave: 0 });
  }
  const slot = p.characters[c];
  if (slot.progress === progress && codex === account.codex) return p;
  return {
    ...p,
    account: codex === account.codex ? account : { ...account, codex },
    characters:
      slot.progress === progress ? p.characters : { ...p.characters, [c]: { ...slot, progress } },
  };
}

/**
 * A finished run of c (B1 calls it after setProgress with the settled progress): each core c owns
 * has its codex best wave raised to the run's highest wave (an entry it lacks is added), c's
 * singularity flag set when the run beat 奇點 and never cleared, and the account's runs + 1.
 * beatSingularity stays false until B5 builds 奇點 (RunResult has no such signal).
 */
export function recordRun(
  p: SaveProfile,
  c: CharacterId,
  run: { readonly highestWave: number; readonly beatSingularity: boolean },
): SaveProfile {
  const { account } = p;
  let codex = account.codex;
  for (const key of ownedCores(p.characters[c].progress, c)) {
    const best = codex[key]?.bestWave ?? 0;
    codex = withEntry(codex, key, { bestWave: Math.max(best, run.highestWave) });
  }
  const beaten = account.singularity[c] || run.beatSingularity;
  return {
    ...p,
    account: {
      ...account,
      codex,
      singularity:
        beaten === account.singularity[c]
          ? account.singularity
          : { ...account.singularity, [c]: beaten },
      stats: { ...account.stats, runs: account.stats.runs + 1 },
    },
  };
}

const KNOWN_ENEMIES: ReadonlySet<string> = new Set(ENEMY_IDS);

/**
 * The enemy types `ids` met (C7's ruling L7: the new-enemy banner shows once per profile, so B1
 * records each sighting): the ones not seen yet join seenEnemies, which stays sorted (the default
 * sort's order) and distinct. An id is never removed, and the same profile comes back when none is
 * new. Throws a RangeError for an id outside ENEMY_IDS.
 */
export function recordSeenEnemies(p: SaveProfile, ids: readonly EnemyId[]): SaveProfile {
  for (const id of ids) {
    if (!KNOWN_ENEMIES.has(id)) {
      throw new RangeError(`recordSeenEnemies: '${String(id)}' is not an enemy id`);
    }
  }
  const { account } = p;
  const seen = new Set(account.seenEnemies);
  if (ids.every((id) => seen.has(id))) return p;
  for (const id of ids) seen.add(id);
  return { ...p, account: { ...account, seenEnemies: [...seen].sort() } };
}

/** c's start wave as picked, a whole wave of at least 1 or null (B1 clamps it to webStartWave). */
export function setStartWave(p: SaveProfile, c: CharacterId, wave: number | null): SaveProfile {
  if (wave !== null && !(Number.isSafeInteger(wave) && wave >= 1)) {
    throw new RangeError(`setStartWave: ${wave} is not a whole wave of at least 1, nor null`);
  }
  const slot = p.characters[c];
  if (slot.startWave === wave) return p;
  return { ...p, characters: { ...p.characters, [c]: { ...slot, startWave: wave } } };
}

/** The game speed: 1, 2 or 4. */
export function setSpeed(p: SaveProfile, speed: Speed): SaveProfile {
  if (speed !== 1 && speed !== 2 && speed !== 4) {
    throw new RangeError(`setSpeed: ${String(speed)} is not 1, 2 or 4`);
  }
  const { account } = p;
  if (account.settings.speed === speed) return p;
  return { ...p, account: { ...account, settings: { ...account.settings, speed } } };
}

/** Time played added to the account's stats: a finite number of seconds, at least 0. */
export function addPlaySeconds(p: SaveProfile, seconds: number): SaveProfile {
  if (!(Number.isFinite(seconds) && seconds >= 0)) {
    throw new RangeError(`addPlaySeconds: ${seconds} is not a finite number of seconds ≥ 0`);
  }
  if (seconds === 0) return p;
  const { account } = p;
  const playSeconds = account.stats.playSeconds + seconds;
  return { ...p, account: { ...account, stats: { ...account.stats, playSeconds } } };
}

/** The purchase rules' account (canBuy, buy, legalize): 奇點 beaten by any character (gd:788). */
export function accountProgress(p: SaveProfile): AccountProgress {
  return { singularityBeaten: CHARACTER_IDS.some((c) => p.account.singularity[c]) };
}

/** The waves each character's legacy milestones are reached at (gd:787), 初始值. */
export const LEGACY_WAVES = [30, 60, 100] as const;
export type LegacyWave = 0 | (typeof LEGACY_WAVES)[number];

/** The legacy milestones (gd:786-789), derived from the profile and never stored (F3). */
export interface LegacyMilestones {
  /** 任一角色第一次轉生: some character has prestiged. */
  readonly firstPrestige: boolean;
  /** 每個角色到第 30／60／100 波: the highest LEGACY_WAVES entry ≤ its best wave, else 0. */
  readonly waves: Readonly<Record<CharacterId, LegacyWave>>;
  /** 任一角色擊敗奇點: the third fusion slot. */
  readonly anySingularity: boolean;
  /** 每個角色擊敗奇點: that character's challenge mode. */
  readonly singularity: Readonly<Record<CharacterId, boolean>>;
}

/** The highest LEGACY_WAVES entry at or below `bestWave`, else 0. */
function legacyWave(bestWave: number): LegacyWave {
  let reached: LegacyWave = 0;
  for (const wave of LEGACY_WAVES) if (bestWave >= wave) reached = wave;
  return reached;
}

/** The legacy milestones reached (B5 gives them their effects). */
export function legacyMilestones(p: SaveProfile): LegacyMilestones {
  const { characters, account } = p;
  return {
    firstPrestige: CHARACTER_IDS.some((c) => characters[c].progress.prestiges >= 1),
    waves: Object.fromEntries(
      CHARACTER_IDS.map((c) => [c, legacyWave(characters[c].progress.bestWave)]),
    ) as Record<CharacterId, LegacyWave>,
    anySingularity: accountProgress(p).singularityBeaten,
    singularity: account.singularity,
  };
}

/** c's challenge mode is unlocked once c has beaten 奇點 (gd:789; F7). */
export function challengeUnlocked(p: SaveProfile, c: CharacterId): boolean {
  return p.account.singularity[c];
}
