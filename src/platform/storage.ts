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

import type { Flavor } from './flavor';

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
 * The Demo's save v2, apart from the full game's on the same origin: the Demo loads a save in
 * DEMO_SCOPE_A, where a build with a rank on a board outside it is refunded whole
 * (src/save/fixes.ts).
 */
export const DEMO_PROFILE_SAVE_PREFIX = 'bc-incremental.demo.profile.';

/** The prefix the v3 game keeps save v2 under in `flavor`; no other code picks between the two. */
export function profileSavePrefix(flavor: Flavor): string {
  return flavor === 'demo' ? DEMO_PROFILE_SAVE_PREFIX : PROFILE_SAVE_PREFIX;
}

/**
 * localStorage-backed slots, kept under `prefix` + the slot name; the default prefix is the M1
 * page's. Writes swallow quota and privacy-mode errors; a read that throws is a failed read, which
 * read() answers as null. The `?hive` prototype (src/app/devFlags.ts) and the v3 game
 * (profileSavePrefix) pass their own prefixes, so neither profile touches the M1 page's save.
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

const SLOTS: readonly SaveSlot[] = ['main', 'backup'];

/**
 * Copies the slots under `from` into `to`'s while neither of `to`'s holds anything: each of
 * `from`'s that holds a text ('' included) is written under `to` as it is, through
 * LocalSaveStorage, so the keys are its `prefix` + slot. `from`'s keys are only read, never
 * written, moved or deleted. Nothing is copied once `to` holds either slot, nor when any of the
 * four reads fails, since an unread slot may hold anything (a blocked localStorage fails the
 * store's own reads too, and the store then writes nothing).
 */
export function adoptSlots(storage: Storage, from: string, to: string): void {
  const target = new LocalSaveStorage(storage, to);
  const own = SLOTS.map((slot) => target.tryRead(slot));
  if (!own.every((read) => read.ok && read.text === null)) return;
  const source = new LocalSaveStorage(storage, from);
  const reads = SLOTS.map((slot) => [slot, source.tryRead(slot)] as const);
  if (!reads.every(([, read]) => read.ok)) return;
  for (const [slot, read] of reads) {
    if (read.ok && read.text !== null) target.write(slot, read.text);
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
