import { describe, expect, it } from 'vitest';
import { HIVE_SAVE_PREFIX } from '../app/devFlags';
import { MUTED_KEY } from '../audio/prefs';
import { ACHIEVEMENTS_KEY } from './achievements';
import { INSTALL_ID_KEY, LOG_KEY, SENDING_KEY } from './analytics';
import {
  adoptSlots,
  DEMO_PROFILE_SAVE_PREFIX,
  LocalSaveStorage,
  MemorySaveStorage,
  PROFILE_SAVE_PREFIX,
  profileSavePrefix,
} from './storage';

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

/** A Storage whose getItem throws `thrown`, as a page's does when storage is blocked. */
class BlockedStorage extends MapStorage {
  constructor(private readonly thrown: unknown) {
    super();
  }

  override getItem(_key: string): string | null {
    throw this.thrown;
  }
}

// Catches a read that throws, swallowed as an empty slot, which the v3 store would write over.
describe('tryRead (the lead’s rulings SR1, SR8)', () => {
  it("answers a slot's text, '' as a text, and null for a slot that holds nothing", () => {
    const storage = new MapStorage();
    const slots = new LocalSaveStorage(storage, PROFILE_SAVE_PREFIX);
    slots.write('main', 'v2 progress');
    slots.write('backup', '');
    expect(slots.tryRead('main')).toEqual({ ok: true, text: 'v2 progress' });
    expect(slots.tryRead('backup')).toEqual({ ok: true, text: '' });
    expect(new LocalSaveStorage(storage).tryRead('main')).toEqual({ ok: true, text: null });
    // read() answers as before: '' is '' on the web.
    expect([slots.read('main'), slots.read('backup')]).toEqual(['v2 progress', '']);
  });

  it("fails with the error's message when getItem throws, which read() answers as null", () => {
    const blocked = new LocalSaveStorage(
      new BlockedStorage(new Error('SecurityError: The operation is insecure.')),
    );
    expect(blocked.tryRead('main')).toEqual({
      ok: false,
      error: 'SecurityError: The operation is insecure.',
    });
    expect(blocked.read('main')).toBeNull();
    // A throw that is not an Error: its text.
    const odd = new LocalSaveStorage(new BlockedStorage('storage gone'), PROFILE_SAVE_PREFIX);
    expect(odd.tryRead('backup')).toEqual({ ok: false, error: 'storage gone' });
    expect(odd.read('backup')).toBeNull();
  });

  it("never fails in memory: the text, '' and null, as read() gives them", () => {
    const slots = new MemorySaveStorage();
    expect([slots.tryRead('main'), slots.tryRead('backup')]).toEqual([
      { ok: true, text: null },
      { ok: true, text: null },
    ]);
    slots.write('main', 'progress');
    slots.write('backup', '');
    expect(slots.tryRead('main')).toEqual({ ok: true, text: 'progress' });
    expect(slots.tryRead('backup')).toEqual({ ok: true, text: '' });
    expect([slots.read('main'), slots.read('backup')]).toEqual(['progress', '']);
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

const FULL_MAIN = `${PROFILE_SAVE_PREFIX}main`;
const FULL_BACKUP = `${PROFILE_SAVE_PREFIX}backup`;
const DEMO_MAIN = `${DEMO_PROFILE_SAVE_PREFIX}main`;
const DEMO_BACKUP = `${DEMO_PROFILE_SAVE_PREFIX}backup`;

// Catches the Demo on the full game's prefix, or under it, where a Demo page's load of a full
// build refunds every board outside DEMO_SCOPE_A and the next save writes that over the full save.
describe("the Demo's save prefix (the lead's ruling R1)", () => {
  it('gives the full game PROFILE_SAVE_PREFIX, unchanged, and the Demo its own', () => {
    expect(profileSavePrefix('full')).toBe(PROFILE_SAVE_PREFIX);
    expect(PROFILE_SAVE_PREFIX).toBe('bc-incremental.profile.');
    expect(profileSavePrefix('demo')).toBe(DEMO_PROFILE_SAVE_PREFIX);
    expect(DEMO_PROFILE_SAVE_PREFIX).toBe('bc-incremental.demo.profile.');
    expect(profileSavePrefix('demo')).not.toBe(profileSavePrefix('full'));
  });

  it("keeps the Demo's apart from M1's, the hive's, the full game's and every other key", () => {
    const prefixes = [m1Prefix(), HIVE_SAVE_PREFIX, PROFILE_SAVE_PREFIX, DEMO_PROFILE_SAVE_PREFIX];
    expect(new Set(prefixes).size).toBe(4);
    for (const other of prefixes.slice(0, 3)) {
      expect(DEMO_PROFILE_SAVE_PREFIX.startsWith(other), other).toBe(false);
      expect(other.startsWith(DEMO_PROFILE_SAVE_PREFIX), other).toBe(false);
    }
    for (const key of [ACHIEVEMENTS_KEY, INSTALL_ID_KEY, SENDING_KEY, LOG_KEY, MUTED_KEY]) {
      expect(key.startsWith(DEMO_PROFILE_SAVE_PREFIX), key).toBe(false);
    }
  });
});

/**
 * A Map-backed Storage that logs every getItem, setItem and removeItem by key, and whose getItem
 * throws for the keys in `failing`, as a blocked storage does.
 */
class LoggedStorage extends MapStorage {
  readonly log: string[] = [];
  readonly failing = new Set<string>();

  constructor(items: Readonly<Record<string, string>> = {}) {
    super();
    for (const [key, value] of Object.entries(items)) super.setItem(key, value);
  }

  override getItem(key: string): string | null {
    this.log.push(`get ${key}`);
    if (this.failing.has(key)) throw new Error(`SecurityError: ${key} is blocked`);
    return super.getItem(key);
  }

  override setItem(key: string, value: string): void {
    this.log.push(`set ${key}`);
    super.setItem(key, value);
  }

  override removeItem(key: string): void {
    this.log.push(`remove ${key}`);
    super.removeItem(key);
  }

  /** The log's writes and removals. */
  get changes(): string[] {
    return this.log.filter((entry) => !entry.startsWith('get '));
  }
}

const adopt = (storage: Storage): void =>
  adoptSlots(storage, PROFILE_SAVE_PREFIX, DEMO_PROFILE_SAVE_PREFIX);

// The lead's ruling R2's copy; src/app/v3/store.test.ts covers who runs it.
describe("adoptSlots (the lead's ruling R2)", () => {
  it("copies both old slots' texts as they are into the new prefix, the old keys only read", () => {
    const items = { [FULL_MAIN]: 'full main', [FULL_BACKUP]: 'full backup', other: 'M1' };
    const storage = new LoggedStorage(items);
    adopt(storage);
    expect(storage.changes).toEqual([`set ${DEMO_MAIN}`, `set ${DEMO_BACKUP}`]);
    expect(Object.fromEntries(storage.items)).toEqual({
      ...items,
      [DEMO_MAIN]: 'full main',
      [DEMO_BACKUP]: 'full backup',
    });
  });

  it("copies only the backup when the old main holds nothing, and '' as ''", () => {
    const backupOnly = new LoggedStorage({ [FULL_BACKUP]: 'full backup' });
    adopt(backupOnly);
    expect(backupOnly.changes).toEqual([`set ${DEMO_BACKUP}`]);
    expect(Object.fromEntries(backupOnly.items)).toEqual({
      [FULL_BACKUP]: 'full backup',
      [DEMO_BACKUP]: 'full backup',
    });
    const empty = new LoggedStorage({ [FULL_MAIN]: '', [FULL_BACKUP]: 'full backup' });
    adopt(empty);
    expect([empty.getItem(DEMO_MAIN), empty.getItem(DEMO_BACKUP)]).toEqual(['', 'full backup']);
    expect([empty.getItem(FULL_MAIN), empty.getItem(FULL_BACKUP)]).toEqual(['', 'full backup']);
  });

  it("copies nothing once the new prefix holds a main or a backup, '' included", () => {
    for (const [key, value] of [
      [DEMO_MAIN, 'demo main'],
      [DEMO_BACKUP, 'demo backup'],
      [DEMO_MAIN, ''],
      [DEMO_BACKUP, ''],
    ] as const) {
      const items = { [FULL_MAIN]: 'full main', [FULL_BACKUP]: 'full backup', [key]: value };
      const storage = new LoggedStorage(items);
      adopt(storage);
      expect(storage.changes, `${key} ${value}`).toEqual([]);
      expect(Object.fromEntries(storage.items), `${key} ${value}`).toEqual(items);
    }
  });

  it('copies nothing when the old prefix holds nothing, or when any of four reads fails', () => {
    const none = new LoggedStorage({ other: 'M1' });
    adopt(none);
    expect(none.changes).toEqual([]);
    for (const key of [DEMO_MAIN, DEMO_BACKUP, FULL_MAIN, FULL_BACKUP]) {
      const storage = new LoggedStorage({ [FULL_MAIN]: 'full main', [FULL_BACKUP]: 'full backup' });
      storage.failing.add(key);
      adopt(storage);
      expect(storage.changes, key).toEqual([]);
      expect(storage.items.size, key).toBe(2);
    }
  });
});
