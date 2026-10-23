import { describe, expect, it } from 'vitest';
import { HIVE_SAVE_PREFIX } from '../app/devFlags';
import { ACHIEVEMENTS_KEY } from './achievements';
import { INSTALL_ID_KEY, LOG_KEY, SENDING_KEY } from './analytics';
import { LocalSaveStorage, PROFILE_SAVE_PREFIX } from './storage';

/** A Map-backed Storage, standing in for window.localStorage (the tests run in node). */
class MapStorage implements Storage {
  readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

describe('LocalSaveStorage', () => {
  it("keeps the player's save under bc-incremental.save.main and .backup", () => {
    const storage = new MapStorage();
    const slots = new LocalSaveStorage(storage);
    slots.write('main', 'one');
    slots.write('backup', 'two');
    expect([...storage.items]).toEqual([
      ['bc-incremental.save.main', 'one'],
      ['bc-incremental.save.backup', 'two'],
    ]);
    expect(slots.read('main')).toBe('one');
    expect(slots.read('backup')).toBe('two');
  });

  it("keeps the ?hive profile under its own prefix, apart from the player's save", () => {
    const storage = new MapStorage();
    const player = new LocalSaveStorage(storage);
    player.write('main', 'M1 progress');
    const hive = new LocalSaveStorage(storage, 'bc-incremental.hive.save.');
    expect(hive.read('main')).toBeNull();
    hive.write('main', 'hive progress');
    hive.write('backup', 'older hive progress');
    expect(storage.getItem('bc-incremental.hive.save.main')).toBe('hive progress');
    expect(storage.getItem('bc-incremental.hive.save.backup')).toBe('older hive progress');
    expect(storage.getItem('bc-incremental.save.main')).toBe('M1 progress');
    expect(storage.getItem('bc-incremental.save.backup')).toBeNull();
    expect(player.read('main')).toBe('M1 progress');
    expect(storage.length).toBe(3);
  });

  it("keeps the v3 game's save v2 under bc-incremental.profile.main and .backup, apart from both", () => {
    const storage = new MapStorage();
    new LocalSaveStorage(storage).write('main', 'M1 progress');
    new LocalSaveStorage(storage, HIVE_SAVE_PREFIX).write('main', 'hive progress');
    const profile = new LocalSaveStorage(storage, PROFILE_SAVE_PREFIX);
    expect([profile.read('main'), profile.read('backup')]).toEqual([null, null]);
    profile.write('main', 'v2 progress');
    profile.write('backup', 'older v2 progress');
    expect([...storage.items]).toEqual([
      ['bc-incremental.save.main', 'M1 progress'],
      ['bc-incremental.hive.save.main', 'hive progress'],
      ['bc-incremental.profile.main', 'v2 progress'],
      ['bc-incremental.profile.backup', 'older v2 progress'],
    ]);
    expect([profile.read('main'), profile.read('backup')]).toEqual([
      'v2 progress',
      'older v2 progress',
    ]);
  });
});

/** The prefix a default LocalSaveStorage (the M1 page's) keeps its slots under. */
function m1Prefix(): string {
  const storage = new MapStorage();
  new LocalSaveStorage(storage).write('main', '');
  const [key = ''] = storage.items.keys();
  return key.slice(0, -'main'.length);
}

// T11 catches 'bc-incremental.' as the v2 prefix, which holds every M1 and hive key.
describe('the save prefixes (T11)', () => {
  it("keeps M1's, the hive's and the v3 game's apart: distinct, none a prefix of another", () => {
    const prefixes = [m1Prefix(), HIVE_SAVE_PREFIX, PROFILE_SAVE_PREFIX];
    expect(new Set(prefixes).size).toBe(3);
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a !== b) expect(b.startsWith(a), `${b} starts with ${a}`).toBe(false);
      }
    }
  });

  it('puts no other key the code writes under the v3 prefix (the lead’s ruling P10)', () => {
    for (const key of [ACHIEVEMENTS_KEY, INSTALL_ID_KEY, SENDING_KEY, LOG_KEY]) {
      expect(key.startsWith(PROFILE_SAVE_PREFIX), key).toBe(false);
    }
  });
});
