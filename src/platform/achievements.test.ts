import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS_KEY, LocalAchievements, isAchievementId } from './achievements';
import type { KeyValueStore } from './analytics';

/** A Map-backed store that counts its writes. */
class MapStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    this.map.set(key, value);
  }
}

/** A store whose reads, writes or both throw, like a full or blocked localStorage. */
class ThrowingStore extends MapStore {
  constructor(private readonly failing: { read: boolean; write: boolean }) {
    super();
  }
  override getItem(key: string): string | null {
    if (this.failing.read) throw new Error('SecurityError');
    return super.getItem(key);
  }
  override setItem(key: string, value: string): void {
    if (this.failing.write) throw new Error('QuotaExceededError');
    super.setItem(key, value);
  }
}

const WIN = 'ACH_WIN_ONE_GAME';

/** Not Steam API names: empty, 65 characters, a space, a path, other punctuation, a newline, non-ASCII letters. */
const INVALID = ['', 'A'.repeat(65), 'ACH WIN', '../x', 'ACH-WIN', 'ACH.WIN', `${WIN}\n`, '成就'];

describe('isAchievementId', () => {
  it("accepts Steam's API names: 1 to 64 letters, digits and underscores", () => {
    for (const id of [WIN, 'a', '0', '_', 'A'.repeat(64), 'ach_2026_Win']) {
      expect(isAchievementId(id), id).toBe(true);
    }
    for (const id of INVALID) expect(isAchievementId(id), JSON.stringify(id)).toBe(false);
    for (const id of [undefined, null, 7, [WIN], { id: WIN }]) {
      expect(isAchievementId(id), JSON.stringify(id)).toBe(false);
    }
  });
});

describe('LocalAchievements', () => {
  it('unlocks once: unlocking again is accepted and writes nothing', () => {
    const store = new MapStore();
    const achievements = new LocalAchievements(store);
    expect(achievements.isUnlocked(WIN)).toBe(false);
    expect(achievements.unlock(WIN)).toBe(true);
    expect(achievements.unlock(WIN)).toBe(true);
    expect(achievements.isUnlocked(WIN)).toBe(true);
    expect(store.writes).toBe(1);
    expect([...store.map]).toEqual([[ACHIEVEMENTS_KEY, JSON.stringify([WIN])]]);
  });

  it('keeps the unlocked ids sorted in a JSON array under bc-incremental.achievements', () => {
    const store = new MapStore();
    const achievements = new LocalAchievements(store);
    for (const id of ['ACH_WIN_100_GAMES', 'ACH_TRAVEL_FAR_ACCUM', WIN, 'ACH_TRAVEL_FAR_SINGLE']) {
      expect(achievements.unlock(id), id).toBe(true);
    }
    expect(ACHIEVEMENTS_KEY).toBe('bc-incremental.achievements');
    expect(store.getItem(ACHIEVEMENTS_KEY)).toBe(
      '["ACH_TRAVEL_FAR_ACCUM","ACH_TRAVEL_FAR_SINGLE","ACH_WIN_100_GAMES","ACH_WIN_ONE_GAME"]',
    );
  });

  it('persists across instances on the same store, and under the key given', () => {
    const store = new MapStore();
    expect(new LocalAchievements(store).unlock(WIN)).toBe(true);
    const later = new LocalAchievements(store);
    expect(later.isUnlocked(WIN)).toBe(true);
    expect(later.isUnlocked('ACH_WIN_100_GAMES')).toBe(false);

    const other = new LocalAchievements(store, 'bc-incremental.other.achievements');
    expect(other.isUnlocked(WIN)).toBe(false);
    expect(other.unlock('ACH_WIN_100_GAMES')).toBe(true);
    expect(store.getItem('bc-incremental.other.achievements')).toBe('["ACH_WIN_100_GAMES"]');
    expect(store.getItem(ACHIEVEMENTS_KEY)).toBe(JSON.stringify([WIN]));
  });

  it('refuses invalid ids and stores none of them', () => {
    const store = new MapStore();
    const achievements = new LocalAchievements(store);
    for (const id of INVALID) {
      expect(achievements.unlock(id), JSON.stringify(id)).toBe(false);
      expect(achievements.isUnlocked(id), JSON.stringify(id)).toBe(false);
    }
    expect(store.writes).toBe(0);
    expect(achievements.unlock(WIN)).toBe(true);
    for (const id of INVALID) expect(achievements.unlock(id), JSON.stringify(id)).toBe(false);
    expect(store.getItem(ACHIEVEMENTS_KEY)).toBe(JSON.stringify([WIN]));
  });

  it('reads a corrupt value as empty and rewrites it on the next unlock', () => {
    const corrupt = ['{not json', 'null', '"ACH_WIN_ONE_GAME"', '{"ACH_WIN_ONE_GAME":true}', '[1]'];
    for (const text of [...corrupt, '["ACH WIN"]', '["ACH_WIN_ONE_GAME",null]']) {
      const store = new MapStore();
      store.map.set(ACHIEVEMENTS_KEY, text);
      const achievements = new LocalAchievements(store);
      expect(achievements.isUnlocked(WIN), text).toBe(false);
      expect(achievements.unlock('ACH_WIN_100_GAMES'), text).toBe(true);
      expect(store.getItem(ACHIEVEMENTS_KEY), text).toBe('["ACH_WIN_100_GAMES"]');
    }
  });

  it('returns false instead of throwing when the store fails, and keeps a record it cannot read', () => {
    const blocked = new LocalAchievements(new ThrowingStore({ read: true, write: true }));
    expect(blocked.unlock(WIN)).toBe(false);
    expect(blocked.isUnlocked(WIN)).toBe(false);

    const full = new ThrowingStore({ read: false, write: true });
    expect(new LocalAchievements(full).unlock(WIN)).toBe(false);
    expect(new LocalAchievements(full).isUnlocked(WIN)).toBe(false);
    expect(full.map.size).toBe(0);

    // A record that cannot be read is not overwritten with the one new id.
    const unreadable = new ThrowingStore({ read: true, write: false });
    unreadable.map.set(ACHIEVEMENTS_KEY, JSON.stringify(['ACH_WIN_100_GAMES']));
    expect(new LocalAchievements(unreadable).unlock(WIN)).toBe(false);
    expect(unreadable.writes).toBe(0);
    expect(unreadable.map.get(ACHIEVEMENTS_KEY)).toBe('["ACH_WIN_100_GAMES"]');
  });
});
