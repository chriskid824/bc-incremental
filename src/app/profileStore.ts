/**
 * The v3 game's profile store (docs/v3 C8 design §2.3; docs/ARCHITECTURE.md §8): save v2 in two
 * slots, `main` and `backup`, read in that order and rotated on every save, with the guards that
 * keep a save this build cannot read from being overwritten, and the one-time import of the M1
 * page's v1 progress. It reads and writes through SaveStorage (src/platform/storage.ts) and loads
 * and writes through parseProfile and serializeProfile (src/save/profile.ts), so it knows nothing
 * of localStorage, files or key prefixes.
 *
 * open() reads both slots. Either one from a newer version makes the store read-only (`newer`,
 * F12); else `main` loads (`loaded`), else `backup` (`restored`); else the store stays read-only
 * until the player starts over (`unreadable`, D3), so a fixed build can still read what this one
 * could not. With both slots empty, the M1 page's first v1 save that loads (`main`, then
 * `backup`) becomes the profile (`imported`), else a fresh one does (`fresh`). An import, a
 * restore and a load that migrated or fixed anything are written at once, so each notice shows
 * once (D5). save() copies the last text loaded or written into `backup`, never what `main` holds
 * (D4), then writes `main` and reads it back.
 *
 * B1 wires it on the page (the lead's ruling P3):
 * - storage: createPlatform({ savePrefix: PROFILE_SAVE_PREFIX, … }).storage, the slots in
 *   localStorage under that prefix on the web (in memory where the page may not use localStorage)
 *   and the Electron bridge's files on Steam, which ignore the prefix;
 * - v1: new LocalSaveStorage(pageLocalStorage()) on the web, under M1's default prefix
 *   (src/platform); null on Steam, and where the page has no localStorage (pageLocalStorage throws);
 * - context: profileContext(loadContent(), FULL_SCOPE); now: () => new Date().toISOString().
 * On Steam the bridge keeps one pair of slot files, so a second profile there needs file names of
 * its own (C9.1's savePrefix note).
 */

import type { SaveSlot, SaveStorage } from '../platform/storage';
import { M1_SAVE_VERSION } from '../save/format';
import { freshProfile, parseProfile, SaveFormatError, serializeProfile } from '../save/profile';
import type { LoadContext, ProfileLoad, SaveNotice, SaveProfile } from '../save/profile';

export type OpenStatus = 'fresh' | 'imported' | 'loaded' | 'restored' | 'newer' | 'unreadable';

export interface OpenResult {
  readonly status: OpenStatus;
  /** For src/ui/saveNotice.ts: the load's notices, and the store's own (§1.5's table). */
  readonly notices: readonly SaveNotice[];
}

export type SaveOutcome = 'saved' | 'readOnly' | 'invalid' | 'failed';

export interface ProfileStoreOptions {
  /** Save v2's slots. */
  readonly storage: SaveStorage;
  /** The M1 page's slots, read for the import and never written; null on Steam (no M1 save). */
  readonly v1: SaveStorage | null;
  readonly context: LoadContext;
  /** The ISO timestamp a save is written with (`savedAt`). */
  now(): string;
}

type Loaded = Extract<ProfileLoad, { readonly ok: true }>;

const SLOTS: readonly SaveSlot[] = ['main', 'backup'];

/**
 * parseProfile on the text of `slot`. A throw (the load-time fixes run unguarded: the lead's ruling
 * P5) is logged and counts as that slot's failure, so it never stops the page.
 */
function load(text: string, slot: string, context: LoadContext): ProfileLoad {
  try {
    return parseProfile(text, context);
  } catch (error) {
    console.error(`The ${slot} save threw while loading`, error);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'invalid', error: `the load threw: ${message}` };
  }
}

/** A slot that holds a text, as open() reads it: loaded, from a newer version, or failed. */
type SlotRead =
  | { readonly kind: 'loaded'; readonly text: string; readonly loaded: Loaded }
  | { readonly kind: 'newer'; readonly version: number }
  | { readonly kind: 'failed'; readonly error: string };

/** Why `slot` gave no profile, for the log: it was empty, or parseProfile's error. */
function failure(slot: SaveSlot, read: Extract<SlotRead, { kind: 'failed' }> | null): string {
  return `${slot}: ${read === null ? 'empty' : read.error}`;
}

export class ProfileStore {
  private current: SaveProfile = freshProfile();
  /** open()'s result, or startOver()'s since; null before open(). */
  private result: OpenResult | null = null;
  private canWrite = false;
  /** The last text loaded or written: what the next save copies into `backup` (D4). */
  private lastGood: string | null = null;

  constructor(private readonly options: ProfileStoreOptions) {}

  /** Reads the slots the first time; every later call returns that result (or startOver()'s). */
  open(): OpenResult {
    this.result ??= this.read();
    return this.result;
  }

  /** The profile: freshProfile() before open(), and under `newer` and `unreadable`. */
  get profile(): SaveProfile {
    return this.current;
  }

  /** The open result's status (startOver's after a start over); throws before open(). */
  get status(): OpenStatus {
    return this.opened().status;
  }

  /** False before open(), under `newer`, and under `unreadable` until startOver(). */
  get writable(): boolean {
    return this.canWrite;
  }

  /**
   * The profile from now on, after a pick, a buy or a run; only save() writes it. In memory alone
   * while the store is read-only. Throws before open(), which would replace it.
   */
  set(profile: SaveProfile): void {
    this.opened();
    this.current = profile;
  }

  /**
   * Writes the profile: `backup` ← the last text loaded or written (if any), then `main` ← the new
   * text, then reads `main` back. `readOnly` while not writable; `invalid`, logged, when the
   * profile cannot be saved (D2), nothing written; `failed` when `main` does not read back as
   * written (LocalSaveStorage swallows quota and privacy errors), so the next save copies the same
   * text into `backup` again.
   */
  save(): SaveOutcome {
    if (!this.canWrite) return 'readOnly';
    let text: string;
    try {
      text = serializeProfile(this.current, this.options.now());
    } catch (error) {
      if (!(error instanceof SaveFormatError)) throw error;
      console.error('The profile was not saved', error);
      return 'invalid';
    }
    const { storage } = this.options;
    if (this.lastGood !== null) storage.write('backup', this.lastGood);
    storage.write('main', text);
    if (storage.read('main') !== text) return 'failed';
    this.lastGood = text;
    return 'saved';
  }

  /**
   * The player's 「重新開始」 under `unreadable` (it throws in any other state): the store takes
   * the fresh path again, the v1 import included, becomes writable and writes `main` at once;
   * `backup` keeps the unreadable text until the next save. A v1 import the lost save had claimed
   * comes back once, since that save is gone.
   */
  startOver(): OpenResult {
    const { status } = this.opened();
    if (status !== 'unreadable') {
      throw new Error(`ProfileStore.startOver: the store is ${status}, not unreadable`);
    }
    this.result = this.freshPath();
    this.save();
    return this.result;
  }

  private opened(): OpenResult {
    if (this.result === null) throw new Error('ProfileStore: open() first');
    return this.result;
  }

  /** open()'s work (§2.3): the fresh path, or the first of newer, loaded, restored, unreadable. */
  private read(): OpenResult {
    const main = this.readSlot('main');
    const backup = this.readSlot('backup');
    if (main === null && backup === null) {
      const result = this.freshPath();
      if (result.status === 'imported') this.save();
      return result;
    }
    if (main?.kind === 'newer' || backup?.kind === 'newer') {
      const versions = [main, backup].flatMap((read) =>
        read?.kind === 'newer' ? [read.version] : [],
      );
      return { status: 'newer', notices: [{ kind: 'newer', version: Math.max(...versions) }] };
    }
    if (main?.kind === 'loaded') return this.adopt('loaded', main, []);
    if (backup?.kind === 'loaded') {
      return this.adopt('restored', backup, [{ kind: 'restored', error: failure('main', main) }]);
    }
    const errors = [failure('main', main), failure('backup', backup)];
    return { status: 'unreadable', notices: [{ kind: 'unreadable', errors }] };
  }

  /** What `slot` holds, loaded; null when it is empty. */
  private readSlot(slot: SaveSlot): SlotRead | null {
    const text = this.options.storage.read(slot);
    if (text === null) return null;
    const loaded = load(text, slot, this.options.context);
    if (loaded.ok) return { kind: 'loaded', text, loaded };
    return loaded.reason === 'newer'
      ? { kind: 'newer', version: loaded.version }
      : { kind: 'failed', error: loaded.error };
  }

  /** The profile `read` loaded, written at once when restored or changed (D5). */
  private adopt(
    status: 'loaded' | 'restored',
    read: Extract<SlotRead, { kind: 'loaded' }>,
    notices: readonly SaveNotice[],
  ): OpenResult {
    const { text, loaded } = read;
    this.current = loaded.profile;
    this.lastGood = text;
    this.canWrite = true;
    if (status === 'restored' || loaded.changed) this.save();
    return { status, notices: [...notices, ...loaded.notices] };
  }

  /**
   * Both slots empty: the M1 page's first v1 save that loads, `main` then `backup` as the M1 page
   * reads them, becomes the profile with its notices (v1Waiting while progress waits for the first
   * pick); a text of any other version there is passed over, and M1's slots are never written.
   * Else a fresh profile. Writable either way, with no last good text: nothing was loaded or written
   * before open(), nor under `unreadable`.
   */
  private freshPath(): OpenResult {
    const { v1, context } = this.options;
    this.canWrite = true;
    for (const slot of SLOTS) {
      const text = v1 === null ? null : v1.read(slot);
      if (text === null) continue;
      const loaded = load(text, `v1 ${slot}`, context);
      if (loaded.ok && loaded.fromVersion === M1_SAVE_VERSION) {
        this.current = loaded.profile;
        return { status: 'imported', notices: loaded.notices };
      }
    }
    this.current = freshProfile();
    return { status: 'fresh', notices: [] };
  }
}
