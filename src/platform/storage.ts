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

/**
 * localStorage-backed slots, kept under `prefix` + the slot name. Reads and writes swallow quota
 * and privacy-mode errors. The `?hive` prototype passes its own prefix (src/app/devFlags.ts), so
 * its profile never touches the player's save.
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
