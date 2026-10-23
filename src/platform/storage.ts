/**
 * Save storage behind an interface (docs/ARCHITECTURE.md §7). The web build uses
 * localStorage; Steam (M2) writes files through the Electron preload.
 */

export type SaveSlot = 'main' | 'backup';

export interface SaveStorage {
  read(slot: SaveSlot): string | null;
  write(slot: SaveSlot, text: string): void;
}

const KEY_PREFIX = 'bc-incremental.save.';
/** The v3 game's save v2 (src/app/profileStore.ts), apart from M1's save under KEY_PREFIX. */
export const PROFILE_SAVE_PREFIX = 'bc-incremental.profile.';

/**
 * localStorage-backed slots, kept under `prefix` + the slot name; the default prefix is the M1
 * page's. Reads and writes swallow quota and privacy-mode errors. The `?hive` prototype
 * (src/app/devFlags.ts) and the v3 game (PROFILE_SAVE_PREFIX) pass their own prefixes, so neither
 * profile touches the M1 page's save.
 */
export class LocalSaveStorage implements SaveStorage {
  constructor(
    private readonly storage: Storage,
    private readonly prefix: string = KEY_PREFIX,
  ) {}

  read(slot: SaveSlot): string | null {
    try {
      return this.storage.getItem(this.prefix + slot);
    } catch {
      return null;
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

/** In-memory slots, for tests and when localStorage is unavailable. */
export class MemorySaveStorage implements SaveStorage {
  private readonly slots = new Map<SaveSlot, string>();

  read(slot: SaveSlot): string | null {
    return this.slots.get(slot) ?? null;
  }

  write(slot: SaveSlot, text: string): void {
    this.slots.set(slot, text);
  }
}
