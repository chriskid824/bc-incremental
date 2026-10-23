/**
 * Save storage behind an interface (docs/ARCHITECTURE.md §7). The web build uses
 * localStorage; Steam writes files through the Electron shell's bridge (./steam).
 *
 * A read tells a slot that holds nothing from one that failed to read: tryRead() answers the
 * slot's text, null for an empty slot, or a failed read with its error, and an empty value is the
 * text '', never an empty slot. The v3 profile store reads through it, since writing over a slot
 * it could not read could lose the newest save. read() keeps the M1 page's answers, null for an
 * empty slot and for a failed read alike, for the M1 page and `?hive`.
 */

export type SaveSlot = 'main' | 'backup';

/** A slot's text ('' is a text), null when the slot holds nothing, or why it could not be read. */
export type SaveReadResult =
  | { readonly ok: true; readonly text: string | null }
  | { readonly ok: false; readonly error: string };

export interface SaveStorage {
  /**
   * The slot's text, or null when it holds nothing or cannot be read (and, on Steam, for an empty
   * file): the M1 page's read.
   */
  read(slot: SaveSlot): string | null;
  /** The slot's text, null when it holds nothing, or a failed read. Never throws. */
  tryRead(slot: SaveSlot): SaveReadResult;
  write(slot: SaveSlot, text: string): void;
}

const KEY_PREFIX = 'bc-incremental.save.';
/** The v3 game's save v2 (src/app/profileStore.ts), apart from M1's save under KEY_PREFIX. */
export const PROFILE_SAVE_PREFIX = 'bc-incremental.profile.';

/**
 * localStorage-backed slots, kept under `prefix` + the slot name; the default prefix is the M1
 * page's. Writes swallow quota and privacy-mode errors; a read that throws is a failed read, which
 * read() answers as null. The `?hive` prototype (src/app/devFlags.ts) and the v3 game
 * (PROFILE_SAVE_PREFIX) pass their own prefixes, so neither profile touches the M1 page's save.
 */
export class LocalSaveStorage implements SaveStorage {
  constructor(
    private readonly storage: Storage,
    private readonly prefix: string = KEY_PREFIX,
  ) {}

  read(slot: SaveSlot): string | null {
    const read = this.tryRead(slot);
    return read.ok ? read.text : null;
  }

  /** A getItem that throws (storage blocked or gone) fails with its message; '' is the text ''. */
  tryRead(slot: SaveSlot): SaveReadResult {
    try {
      return { ok: true, text: this.storage.getItem(this.prefix + slot) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  write(slot: SaveSlot, text: string): void {
    try {
      this.storage.setItem(this.prefix + slot, text);
    } catch (error) {
      console.warn('Save failed', error);
    }
  }
}

/** In-memory slots, for tests and when localStorage is unavailable; a read never fails. */
export class MemorySaveStorage implements SaveStorage {
  private readonly slots = new Map<SaveSlot, string>();

  read(slot: SaveSlot): string | null {
    const read = this.tryRead(slot);
    return read.ok ? read.text : null;
  }

  tryRead(slot: SaveSlot): SaveReadResult {
    return { ok: true, text: this.slots.get(slot) ?? null };
  }

  write(slot: SaveSlot, text: string): void {
    this.slots.set(slot, text);
  }
}
