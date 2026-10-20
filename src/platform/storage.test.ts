import { describe, expect, it } from 'vitest';
import { LocalSaveStorage } from './storage';

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
});
