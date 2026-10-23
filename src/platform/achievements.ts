/**
 * Achievements behind an interface (docs/ARCHITECTURE.md §7; docs/v3 C9 design §1.2). The Steam
 * build unlocks them through its Electron shell (./steam/index.ts); the web build, and the Steam
 * build when Steam is not running (C9/F6), keep a local record. No game code unlocks anything
 * until M3, which should re-assert the unlocks a save implies at startup.
 */

import type { KeyValueStore } from './analytics';

export interface Achievements {
  /** True when the unlock was accepted, an achievement already unlocked included; never throws. */
  unlock(id: string): boolean;
  /** False when locked, unknown or undeterminable; never throws. */
  isUnlocked(id: string): boolean;
}

/** Steam's API names for achievements. */
export const ACHIEVEMENT_ID = /^[A-Za-z0-9_]{1,64}$/;

export function isAchievementId(id: unknown): id is string {
  return typeof id === 'string' && ACHIEVEMENT_ID.test(id);
}

export const ACHIEVEMENTS_KEY = 'bc-incremental.achievements';

/**
 * The local record: the unlocked ids under `key` as a sorted JSON array. Unlocking is idempotent;
 * an invalid id or a failed write returns false. A value that is not an array of valid ids is
 * corrupt: it reads as empty and the next unlock rewrites it.
 */
export class LocalAchievements implements Achievements {
  constructor(
    private readonly store: KeyValueStore,
    private readonly key: string = ACHIEVEMENTS_KEY,
  ) {}

  unlock(id: string): boolean {
    if (!isAchievementId(id)) return false;
    const unlocked = this.read();
    // An unreadable store is not overwritten: it may hold other unlocks.
    if (unlocked === null) return false;
    if (unlocked.includes(id)) return true;
    try {
      this.store.setItem(this.key, JSON.stringify([...unlocked, id].sort()));
      return true;
    } catch {
      return false;
    }
  }

  isUnlocked(id: string): boolean {
    return isAchievementId(id) && (this.read()?.includes(id) ?? false);
  }

  /** The unlocked ids; empty when missing or corrupt, null when the store throws. */
  private read(): string[] | null {
    let text: string | null;
    try {
      text = this.store.getItem(this.key);
    } catch {
      return null;
    }
    if (text === null) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) && parsed.every(isAchievementId) ? parsed : [];
    } catch {
      return [];
    }
  }
}
