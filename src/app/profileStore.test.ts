/**
 * The v3 profile store (docs/v3 C8 design §2.3): the slot order (T1), the rotation (T2), the newer
 * guard (T3), the one-time v1 import (T4) and a second load after it (T5), the claim end to end
 * (T6), the M1 page on the same localStorage (T7), the writes at open (T8), the refusals (T9), a
 * throw while loading (the lead's ruling P5), starting over (D3) and the store before open(). On
 * MemorySaveStorage and a Map-backed Storage, as src/platform/storage.test.ts; the loads run on the
 * four fixture webs (src/save/testing.ts), where save-v2.json loads with no notice. Profiles the
 * tests hand the store are deep-frozen, and M1's slots are given to it read-only: a write throws.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { add, num } from '../core/num';
import { loadGameData } from '../data';
import type { CharacterId } from '../data/sources';
import { createMetaState } from '../meta';
import { LocalSaveStorage, MemorySaveStorage, PROFILE_SAVE_PREFIX } from '../platform/storage';
import type { SaveSlot, SaveStorage } from '../platform/storage';
import { loadSave, serializeSave } from '../save';
import type { Profile } from '../save';
import { SAVE_VERSION } from '../save/format';
import {
  addPlaySeconds,
  freshProfile,
  parseProfile,
  SaveFormatError,
  selectCharacter,
  serializeProfile,
  setSpeed,
} from '../save/profile';
import type { LoadContext, SaveProfile } from '../save/profile';
import { deepFreeze, fixtureContext, withRenames } from '../save/testing';
import { HIVE_SAVE_PREFIX } from './devFlags';
import HIVE_PRESET from './hivePreset.json';
import { ProfileStore } from './profileStore';

/** A Map-backed Storage (the tests run in node); while `full`, setItem throws as quota does. */
class MapStorage implements Storage {
  readonly items = new Map<string, string>();
  full = false;

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
    if (this.full) throw new Error('QuotaExceededError: the test filled the storage');
    this.items.set(key, value);
  }
}

/** In-memory slots that record every write, in order. */
class LoggedSlots extends MemorySaveStorage {
  readonly writes: (readonly [SaveSlot, string])[] = [];

  constructor(main: string | null = null, backup: string | null = null) {
    super();
    if (main !== null) super.write('main', main);
    if (backup !== null) super.write('backup', backup);
  }

  override write(slot: SaveSlot, text: string): void {
    this.writes.push([slot, text]);
    super.write(slot, text);
  }

  /** The slots written, in order. */
  get written(): SaveSlot[] {
    return this.writes.map(([slot]) => slot);
  }
}

/** M1's slots as the store must use them: read, never written (a write throws). */
class ReadOnlySlots implements SaveStorage {
  constructor(private readonly slots: SaveStorage) {}

  read(slot: SaveSlot): string | null {
    return this.slots.read(slot);
  }

  write(slot: SaveSlot): void {
    throw new Error(`the store wrote M1's ${slot} slot`);
  }
}

const FIXTURES = new URL('../../tests/fixtures/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
const minified = (text: string): string => JSON.stringify(JSON.parse(text));
/** `text` with its envelope's version set to `v`. */
const withVersion = (text: string, v: number): string =>
  JSON.stringify({ ...(JSON.parse(text) as object), v });

/** The four fixture webs. */
const CONTEXT = fixtureContext();
/** save-v2.json as serializeProfile writes it: it loads on CONTEXT with no notice. */
const V2 = minified(fixture('save-v2.json'));
/** save-v1.json, an M1 save whose pending is PENDING. */
const V1 = fixture('save-v1.json');
const PENDING = { shards: 2221.75, cores: 3, maxWave: 18 };
const NEWER = withVersion(V2, SAVE_VERSION + 1);
const M1_DATA = loadGameData();

/** savedAt for every save of the file, one second apart, so no two texts are the same. */
const now = ((): (() => string) => {
  let second = 0;
  return () => new Date(Date.UTC(2026, 9, 23, 0, 0, ++second)).toISOString();
})();

/** The profile `text` loads as under `context`. */
function profileOf(text: string | null, context: LoadContext = CONTEXT): SaveProfile {
  const loaded = parseProfile(text ?? '', context);
  if (!loaded.ok) throw new Error(`the text does not load: ${JSON.stringify(loaded)}`);
  return loaded.profile;
}

/** Another valid save: save-v2.json's profile a minute of play later. */
const OTHER = serializeProfile(addPlaySeconds(profileOf(V2), 60), now());

/** A store on `slots`, with `v1` (read-only) as M1's slots. */
function storeOn(
  slots: SaveStorage,
  v1: SaveStorage | null = null,
  context: LoadContext = CONTEXT,
): ProfileStore {
  return new ProfileStore({
    storage: slots,
    v1: v1 === null ? null : new ReadOnlySlots(v1),
    context,
    now,
  });
}

/** B1's wiring on a page's localStorage (the store's header), M1's slots read-only. */
function webStore(local: Storage, context: LoadContext = CONTEXT): ProfileStore {
  return storeOn(
    new LocalSaveStorage(local, PROFILE_SAVE_PREFIX),
    new LocalSaveStorage(local),
    context,
  );
}

/** The items of `local` under PROFILE_SAVE_PREFIX, in order. */
const v2Items = (local: MapStorage): [string, string][] =>
  [...local.items].filter(([key]) => key.startsWith(PROFILE_SAVE_PREFIX));
/** The items of `local` under any other key, in order. */
const otherItems = (local: MapStorage): [string, string][] =>
  [...local.items].filter(([key]) => !key.startsWith(PROFILE_SAVE_PREFIX));

afterEach(() => {
  vi.restoreAllMocks();
});

// T1 catches a store preferring the backup, and one rotating the bad main into backup.
describe('the slot order (T1)', () => {
  it('loads a valid main, whatever the backup holds, and writes nothing', () => {
    const slots = new LoggedSlots(V2, OTHER);
    const store = storeOn(slots);
    expect(store.open()).toEqual({ status: 'loaded', notices: [] });
    expect(store.status).toBe('loaded');
    expect(store.writable).toBe(true);
    expect(store.profile).toEqual(profileOf(V2));
    expect(slots.writes).toEqual([]);
  });

  it('restores an invalid main from a valid backup: main rewritten from it, backup byte-identical', () => {
    const slots = new LoggedSlots('{', OTHER);
    const store = storeOn(slots);
    expect(store.open()).toEqual({
      status: 'restored',
      notices: [{ kind: 'restored', error: 'main: not JSON' }],
    });
    expect(store.profile).toEqual(profileOf(OTHER));
    expect(slots.written).toEqual(['backup', 'main']);
    expect(slots.read('backup')).toBe(OTHER);
    expect(profileOf(slots.read('main'))).toEqual(profileOf(OTHER));
  });

  it('restores from the backup when main is empty, the load’s notices after its own', () => {
    const context = withRenames(CONTEXT, { 'fire.center.alpha.r1': null });
    const slots = new LoggedSlots(null, V2);
    const store = storeOn(slots, null, context);
    expect(store.open()).toEqual({
      status: 'restored',
      notices: [
        { kind: 'restored', error: 'main: empty' },
        { kind: 'refundedAll', character: 'fire', ids: ['fire.center.alpha.r1'] },
      ],
    });
    expect(slots.read('backup')).toBe(V2);
    expect(profileOf(slots.read('main'), context)).toEqual(store.profile);
    expect(store.profile.characters.fire.progress.ranks).toEqual({});
  });

  it('is unreadable when no slot loads: a fresh profile, read-only, nothing written', () => {
    for (const [main, backup, errors] of [
      ['{', 'garbage', ['main: not JSON', 'backup: not JSON']],
      // An empty text is no empty slot: only null takes the fresh path.
      ['', null, ['main: not JSON', 'backup: empty']],
      [withVersion(V2, 0), null, [expect.stringMatching(/^main: bad envelope: /), 'backup: empty']],
      [
        null,
        JSON.stringify({ v: 2, savedAt: '', game: 'other', data: {} }),
        ['main: empty', expect.stringMatching(/^backup: bad envelope: /)],
      ],
    ] as const) {
      const slots = new LoggedSlots(main, backup);
      const store = storeOn(slots, new LoggedSlots(V1));
      expect(store.open()).toEqual({
        status: 'unreadable',
        notices: [{ kind: 'unreadable', errors }],
      });
      expect(store.writable).toBe(false);
      expect(store.profile).toEqual(freshProfile());
      expect(store.save()).toBe('readOnly');
      expect(slots.writes).toEqual([]);
    }
  });
});

// T2 catches backup given the new text.
describe('the rotation (T2; D4)', () => {
  it('writes main alone on the first save after fresh, then the last text into backup', () => {
    const slots = new LoggedSlots();
    const store = storeOn(slots);
    expect(store.open()).toEqual({ status: 'fresh', notices: [] });
    const first = deepFreeze(setSpeed(store.profile, 2));
    store.set(first);
    expect(store.profile).toBe(first);
    expect(slots.writes).toEqual([]);
    expect(store.save()).toBe('saved');
    expect(slots.written).toEqual(['main']);
    const firstText = slots.read('main');
    expect(profileOf(firstText)).toEqual(first);
    expect(slots.read('backup')).toBeNull();
    store.set(deepFreeze(setSpeed(first, 4)));
    expect(store.save()).toBe('saved');
    expect(slots.written).toEqual(['main', 'backup', 'main']);
    expect(slots.read('backup')).toBe(firstText);
    expect(profileOf(slots.read('main'))).toEqual(store.profile);
  });

  it('copies the text it loaded into backup, not what main holds by then', () => {
    const slots = new LoggedSlots(V2, OTHER);
    const store = storeOn(slots);
    expect(store.open().status).toBe('loaded');
    slots.write('main', 'damaged since');
    store.set(deepFreeze(setSpeed(store.profile, 4)));
    expect(store.save()).toBe('saved');
    expect(slots.read('backup')).toBe(V2);
    expect(profileOf(slots.read('main'))).toEqual(store.profile);
  });

  // The last good text is the last one loaded or written (D4): what open() wrote is the next
  // backup. Catches an open-time write that leaves the last good text unset or at the loaded one.
  it('copies the text written at open into backup on the next save: an import, a fix, a restore', () => {
    const renamed = withRenames(CONTEXT, { 'fire.center.alpha.r1': null });
    const cases: [LoggedSlots, LoggedSlots | null, LoadContext][] = [
      [new LoggedSlots(), new LoggedSlots(V1), CONTEXT],
      [new LoggedSlots(V2), null, renamed],
      [new LoggedSlots('{', V2), null, renamed],
    ];
    for (const [slots, v1, context] of cases) {
      const store = storeOn(slots, v1, context);
      store.open();
      const written = slots.read('main');
      expect(written).not.toBeNull();
      store.set(deepFreeze(setSpeed(store.profile, 4)));
      expect(store.save()).toBe('saved');
      expect(slots.read('backup')).toBe(written);
    }
  });
});

// T3 catches M1's behaviour on a newer save: a fresh profile, writable, written over it.
describe('the newer guard (T3; F12)', () => {
  it.each([
    ['a newer main', NEWER, OTHER],
    ['only a newer backup', V2, NEWER],
    ['a newer main alone', NEWER, null],
  ])(
    'keeps %s and the other slot byte-identical through open, set, save and startOver',
    (_name, main, backup) => {
      const slots = new LoggedSlots(main, backup);
      const store = storeOn(slots, new LoggedSlots(V1));
      expect(store.open()).toEqual({
        status: 'newer',
        notices: [{ kind: 'newer', version: SAVE_VERSION + 1 }],
      });
      expect(store.writable).toBe(false);
      expect(store.profile).toEqual(freshProfile());
      store.set(deepFreeze(setSpeed(store.profile, 4)));
      expect(store.save()).toBe('readOnly');
      expect(() => store.startOver()).toThrow(
        'ProfileStore.startOver: the store is newer, not unreadable',
      );
      expect(store.status).toBe('newer');
      expect(slots.writes).toEqual([]);
      expect([slots.read('main'), slots.read('backup')]).toEqual([main, backup]);
    },
  );

  it('names the newest version when both slots are newer', () => {
    const store = storeOn(new LoggedSlots(NEWER, withVersion(V2, SAVE_VERSION + 4)));
    expect(store.open().notices).toEqual([{ kind: 'newer', version: SAVE_VERSION + 4 }]);
  });
});

// T4 catches the store writing M1's keys, and reading the hive prototype's.
describe('the one-time v1 import (T4)', () => {
  it('imports a valid v1 main into empty v2 slots and writes v2 main at once', () => {
    const local = new MapStorage();
    const m1 = new LocalSaveStorage(local);
    m1.write('main', V1);
    // An older session in the v1 backup, one run fewer: main is the one imported.
    m1.write('backup', serializeSave(loadedM1(V1, -1), 'older'));
    const before = otherItems(local);
    const store = webStore(local);
    expect(store.open()).toEqual({
      status: 'imported',
      notices: [{ kind: 'v1Waiting', pending: PENDING }],
    });
    expect(store.writable).toBe(true);
    expect(store.profile).toEqual(profileOf(V1));
    expect(store.profile.account.pendingV1).toEqual(PENDING);
    expect(v2Items(local).map(([key]) => key)).toEqual([`${PROFILE_SAVE_PREFIX}main`]);
    expect(profileOf(local.getItem(`${PROFILE_SAVE_PREFIX}main`))).toEqual(store.profile);
    expect(otherItems(local)).toEqual(before);
  });

  it('imports a good v1 backup when the v1 main does not load', () => {
    for (const main of ['{', V2, withVersion(V1, SAVE_VERSION + 1)]) {
      const slots = new LoggedSlots();
      const store = storeOn(slots, new LoggedSlots(main, V1));
      expect(store.open()).toEqual({
        status: 'imported',
        notices: [{ kind: 'v1Waiting', pending: PENDING }],
      });
      expect(slots.written).toEqual(['main']);
    }
  });

  it('imports a v1 save without progress too: no notice, its speed and play time kept', () => {
    const m1: Profile = { meta: createMetaState(), playSeconds: 120, speed: 4 };
    const slots = new LoggedSlots();
    const store = storeOn(slots, new LoggedSlots(serializeSave(m1, 'unplayed')));
    expect(store.open()).toEqual({ status: 'imported', notices: [] });
    const { pendingV1, settings, stats } = store.profile.account;
    expect(pendingV1).toBeNull();
    expect([settings.speed, stats.playSeconds]).toEqual([4, 120]);
    expect(slots.written).toEqual(['main']);
  });

  it('passes over a v2, a newer or a broken text in the v1 slots: fresh, nothing written', () => {
    for (const [main, backup] of [
      [V2, NEWER],
      [OTHER, 'garbage'],
      [null, V2],
    ] as const) {
      const slots = new LoggedSlots();
      const store = storeOn(slots, new LoggedSlots(main, backup));
      expect(store.open()).toEqual({ status: 'fresh', notices: [] });
      expect(store.profile).toEqual(freshProfile());
      expect(slots.writes).toEqual([]);
    }
  });

  it('reads the M1 page’s slots only: the hive prototype’s keys alone give a fresh profile', () => {
    const local = new MapStorage();
    const preset = JSON.stringify(HIVE_PRESET);
    expect(parseProfile(preset, CONTEXT)).toMatchObject({ ok: true, fromVersion: 1 });
    new LocalSaveStorage(local, HIVE_SAVE_PREFIX).write('main', preset);
    const before = [...local.items];
    const store = webStore(local);
    expect(store.open()).toEqual({ status: 'fresh', notices: [] });
    expect([...local.items]).toEqual(before);
  });

  it('imports nothing on Steam (v1 null)', () => {
    const slots = new LoggedSlots();
    expect(storeOn(slots, null).open()).toEqual({ status: 'fresh', notices: [] });
    expect(slots.writes).toEqual([]);
  });
});

/** The M1 profile `text` holds, with `runs` more runs. */
function loadedM1(text: string, runs: number): Profile {
  const loaded = loadSave(text, M1_DATA);
  if (!loaded.ok) throw new Error(`not an M1 save: ${loaded.error}`);
  loaded.profile.meta.runs += runs;
  return loaded.profile;
}

// T5 catches a store that imports again while pendingV1 is non-null.
describe('a second load (T5)', () => {
  it('loads the imported save on the next open, though the M1 page played on meanwhile', () => {
    const local = new MapStorage();
    const m1 = new LocalSaveStorage(local);
    m1.write('main', V1);
    expect(webStore(local).open().status).toBe('imported');
    const v2 = v2Items(local);
    const played = loadedM1(V1, 5);
    played.meta.shards = add(played.meta.shards, num(1000));
    m1.write('main', serializeSave(played, 'later'));
    const again = webStore(local);
    expect(again.open()).toEqual({ status: 'loaded', notices: [] });
    expect(again.profile.account.pendingV1).toEqual(PENDING);
    expect(v2Items(local)).toEqual(v2);
  });
});

/** B1's pick on the select screen (§3): selectCharacter, then store.set and store.save() at once. */
function pick(store: ProfileStore, c: CharacterId) {
  const { profile, claimed } = selectCharacter(deepFreeze(store.profile), c);
  store.set(deepFreeze(profile));
  return { claimed, outcome: store.save() };
}

// T6 catches the pick's flow without its save (set alone).
describe('the claim end to end (T6)', () => {
  it('keeps the claimed progress once, in the fire wallet, through a save and two reopens', () => {
    const local = new MapStorage();
    new LocalSaveStorage(local).write('main', V1);
    const store = webStore(local);
    expect(store.open().status).toBe('imported');
    expect(pick(store, 'fire')).toEqual({ claimed: PENDING, outcome: 'saved' });
    const fire = { shards: PENDING.shards, cores: PENDING.cores, resonance: 0 };
    for (const round of [1, 2]) {
      const again = webStore(local);
      expect(again.open(), `reopen ${round}`).toEqual({ status: 'loaded', notices: [] });
      const { account, characters } = again.profile;
      expect(account.pendingV1).toBeNull();
      expect(account.lastCharacter).toBe('fire');
      const { wallet, spent, bestWave, cycleBest } = characters.fire.progress;
      expect(wallet).toEqual(fire);
      expect([bestWave, cycleBest]).toEqual([PENDING.maxWave, PENDING.maxWave]);
      expect(spent).toEqual({ shards: 0, cores: 0, resonance: 0 });
    }
    const later = webStore(local);
    later.open();
    expect(pick(later, 'ice')).toEqual({ claimed: null, outcome: 'saved' });
    const last = webStore(local);
    expect(last.open().status).toBe('loaded');
    const { account, characters } = last.profile;
    expect(account.lastCharacter).toBe('ice');
    expect(characters.ice.progress.wallet).toEqual({ shards: 0, cores: 0, resonance: 0 });
    expect(characters.fire.progress.wallet).toEqual(fire);
  });
});

/**
 * One session of the M1 page on `local`, copied from src/app/main.ts: loadProfile (:123-133) loads
 * the main slot, else the backup, else a fresh profile; a run is played; save (:180-184) copies
 * main into backup, then writes main.
 */
function m1Plays(local: Storage): void {
  const storage = new LocalSaveStorage(local);
  let profile: Profile = { meta: createMetaState(), playSeconds: 0, speed: 1 };
  for (const slot of ['main', 'backup'] as const) {
    const text = storage.read(slot);
    if (text === null) continue;
    const loaded = loadSave(text, M1_DATA);
    if (loaded.ok) {
      profile = loaded.profile;
      break;
    }
  }
  profile.meta.runs += 1;
  profile.playSeconds += 60;
  const previous = storage.read('main');
  if (previous !== null) storage.write('backup', previous);
  storage.write('main', serializeSave(profile, now()));
}

// T7 catches PROFILE_SAVE_PREFIX equal to M1's.
describe('the M1 page after the v3 game (T7)', () => {
  it('leaves both v2 keys byte-identical while the M1 page plays twice; the store reopens alike', () => {
    const local = new MapStorage();
    const store = webStore(local);
    expect(store.open().status).toBe('fresh');
    store.set(deepFreeze(profileOf(V2)));
    expect(store.save()).toBe('saved');
    store.set(deepFreeze(addPlaySeconds(store.profile, 30)));
    expect(store.save()).toBe('saved');
    const v2 = v2Items(local);
    expect(v2.map(([key]) => key)).toEqual([
      `${PROFILE_SAVE_PREFIX}main`,
      `${PROFILE_SAVE_PREFIX}backup`,
    ]);
    m1Plays(local);
    m1Plays(local);
    expect(v2Items(local)).toEqual(v2);
    const m1 = loadSave(new LocalSaveStorage(local).read('main') ?? '', M1_DATA);
    expect(m1.ok && m1.profile.meta.runs).toBe(2);
    const again = webStore(local);
    expect(again.open()).toEqual({ status: 'loaded', notices: [] });
    expect(again.profile).toEqual(store.profile);
  });
});

// T8 catches notices on every open: a fixed load never written back.
describe('writing at open (T8; D5)', () => {
  it('writes a load the renames refund once, and the next open finds nothing to fix', () => {
    const context = withRenames(CONTEXT, { 'fire.center.alpha.r1': null });
    const slots = new LoggedSlots(V2);
    const first = storeOn(slots, null, context);
    expect(first.open()).toEqual({
      status: 'loaded',
      notices: [{ kind: 'refundedAll', character: 'fire', ids: ['fire.center.alpha.r1'] }],
    });
    expect(slots.written).toEqual(['backup', 'main']);
    expect(slots.read('backup')).toBe(V2);
    expect(profileOf(slots.read('main'), context)).toEqual(first.profile);
    slots.writes.length = 0;
    const second = storeOn(slots, null, context);
    expect(second.open()).toEqual({ status: 'loaded', notices: [] });
    expect(second.profile).toEqual(first.profile);
    expect(slots.writes).toEqual([]);
  });

  it('writes a renamed id once, though a rename has no notice', () => {
    const old = 'fire.center.alpha.old-r1';
    const text = V2.replaceAll('"fire.center.alpha.r1":', `"${old}":`);
    expect(text.split(old).length - 1).toBe(2);
    const context = withRenames(CONTEXT, { [old]: 'fire.center.alpha.r1' });
    const slots = new LoggedSlots(text);
    expect(storeOn(slots, null, context).open()).toEqual({ status: 'loaded', notices: [] });
    expect(slots.written).toEqual(['backup', 'main']);
    expect(profileOf(slots.read('main'), context)).toEqual(profileOf(V2));
    slots.writes.length = 0;
    expect(storeOn(slots, null, context).open()).toEqual({ status: 'loaded', notices: [] });
    expect(slots.writes).toEqual([]);
  });

  it('writes a clean load nothing', () => {
    const slots = new LoggedSlots(V2);
    expect(storeOn(slots).open()).toEqual({ status: 'loaded', notices: [] });
    expect(slots.writes).toEqual([]);
  });

  // Catches a restore that copies the backup's text into main as it was, without the load's fixes.
  it('writes a restore with its fixes once: the next open finds nothing to fix', () => {
    const context = withRenames(CONTEXT, { 'fire.center.alpha.r1': null });
    const slots = new LoggedSlots('{', V2);
    expect(storeOn(slots, null, context).open().status).toBe('restored');
    slots.writes.length = 0;
    expect(storeOn(slots, null, context).open()).toEqual({ status: 'loaded', notices: [] });
    expect(slots.writes).toEqual([]);
  });
});

/** `profile` with 1.5 cores in fire's wallet, which the schema refuses (a count). */
function withFractionalCores(profile: SaveProfile): SaveProfile {
  const { characters } = profile;
  const { progress } = characters.fire;
  const wallet = { ...progress.wallet, cores: 1.5 };
  const fire = { ...characters.fire, progress: { ...progress, wallet } };
  return deepFreeze({ ...profile, characters: { ...characters, fire } });
}

// T9 catches a save without its read-back, so a swallowed error reports saved.
describe('refusals (T9; D2)', () => {
  it('refuses a profile the schema refuses: invalid, logged, the slots unchanged', () => {
    const slots = new LoggedSlots(V2, OTHER);
    const store = storeOn(slots);
    store.open();
    store.set(withFractionalCores(store.profile));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.save()).toBe('invalid');
    expect(logged).toHaveBeenCalledWith('The profile was not saved', expect.any(SaveFormatError));
    expect(slots.writes).toEqual([]);
    expect([slots.read('main'), slots.read('backup')]).toEqual([V2, OTHER]);
  });

  it('is read-only before it serializes anything: readOnly, not invalid, nothing logged', () => {
    const slots = new LoggedSlots('{');
    const store = storeOn(slots);
    expect(store.open().status).toBe('unreadable');
    store.set(withFractionalCores(store.profile));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.save()).toBe('readOnly');
    expect(logged).not.toHaveBeenCalled();
    expect(slots.writes).toEqual([]);
  });

  it('lets any other error through: only SaveFormatError is invalid', () => {
    const slots = new LoggedSlots();
    const store = new ProfileStore({
      storage: slots,
      v1: null,
      context: CONTEXT,
      now: () => {
        throw new Error('no clock');
      },
    });
    expect(store.open().status).toBe('fresh');
    expect(() => store.save()).toThrow('no clock');
    expect(slots.writes).toEqual([]);
  });

  it('reports a write the storage swallowed as failed, and keeps the last good text for backup', () => {
    const local = new MapStorage();
    const store = webStore(local);
    store.open();
    store.set(deepFreeze(profileOf(V2)));
    expect(store.save()).toBe('saved');
    const saved = local.getItem(`${PROFILE_SAVE_PREFIX}main`);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    local.full = true;
    store.set(deepFreeze(setSpeed(store.profile, 4)));
    expect(store.save()).toBe('failed');
    expect(warned).toHaveBeenCalled();
    expect(v2Items(local)).toEqual([[`${PROFILE_SAVE_PREFIX}main`, saved]]);
    local.full = false;
    expect(store.save()).toBe('saved');
    expect(local.getItem(`${PROFILE_SAVE_PREFIX}backup`)).toBe(saved);
    expect(profileOf(local.getItem(`${PROFILE_SAVE_PREFIX}main`))).toEqual(store.profile);
  });

  // Catches a read-back that takes an empty main for the text written.
  it('reports a first save the storage swallowed as failed, and keeps no text for backup', () => {
    const local = new MapStorage();
    local.full = true;
    const store = webStore(local);
    expect(store.open().status).toBe('fresh');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.set(deepFreeze(setSpeed(store.profile, 4)));
    expect(store.save()).toBe('failed');
    expect(v2Items(local)).toEqual([]);
    local.full = false;
    expect(store.save()).toBe('saved');
    expect(v2Items(local).map(([key]) => key)).toEqual([`${PROFILE_SAVE_PREFIX}main`]);
  });
});

/** CONTEXT, but webOf throws while `throws(c)` says so. */
function throwingContext(throws: (c: CharacterId) => boolean): LoadContext {
  return {
    webOf: (c) => {
      if (throws(c)) throw new Error(`no web for ${c}`);
      return CONTEXT.webOf(c);
    },
    economy: CONTEXT.economy,
    renames: CONTEXT.renames,
  };
}

// The lead's ruling P5 catches a fixProfile throw breaking the page (parseProfile lets it through).
describe('a throw while loading (the lead’s ruling P5)', () => {
  it('counts each slot whose load throws as failed: unreadable, logged, nothing written', () => {
    const slots = new LoggedSlots(V2, OTHER);
    const store = storeOn(
      slots,
      null,
      throwingContext((c) => c === 'ice'),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.open()).toEqual({
      status: 'unreadable',
      notices: [
        {
          kind: 'unreadable',
          errors: [
            'main: the load threw: no web for ice',
            'backup: the load threw: no web for ice',
          ],
        },
      ],
    });
    expect(logged.mock.calls).toEqual([
      ['The main save threw while loading', new Error('no web for ice')],
      ['The backup save threw while loading', new Error('no web for ice')],
    ]);
    expect(slots.writes).toEqual([]);
  });

  it('restores from the backup when only the load of main throws', () => {
    // The texts were written before the throw is armed: the context throws on its next call alone.
    let armed = true;
    const once = throwingContext(() => {
      const throws = armed;
      armed = false;
      return throws;
    });
    const slots = new LoggedSlots(V2, OTHER);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(storeOn(slots, null, once).open()).toEqual({
      status: 'restored',
      notices: [{ kind: 'restored', error: 'main: the load threw: no web for fire' }],
    });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(slots.read('backup')).toBe(OTHER);
    expect(profileOf(slots.read('main'))).toEqual(profileOf(OTHER));
  });

  it('passes over a v1 slot whose load throws, and imports the next', () => {
    let armed = true;
    const once = throwingContext(() => {
      const throws = armed;
      armed = false;
      return throws;
    });
    const slots = new LoggedSlots();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(storeOn(slots, new LoggedSlots(V1, V1), once).open()).toEqual({
      status: 'imported',
      notices: [{ kind: 'v1Waiting', pending: PENDING }],
    });
    expect(slots.written).toEqual(['main']);
  });

  // Catches a guard that lets a throw through unless it is an Error.
  it('counts a throw that is not an Error as failed too, its text the error', () => {
    const context: LoadContext = {
      webOf: (c) => {
        // A string, not an Error.
        if (c === 'ice') throw 'no web for ice';
        return CONTEXT.webOf(c);
      },
      economy: CONTEXT.economy,
      renames: CONTEXT.renames,
    };
    const slots = new LoggedSlots(V2, OTHER);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(storeOn(slots, null, context).open()).toEqual({
      status: 'unreadable',
      notices: [
        {
          kind: 'unreadable',
          errors: [
            'main: the load threw: no web for ice',
            'backup: the load threw: no web for ice',
          ],
        },
      ],
    });
    expect(logged.mock.calls).toEqual([
      ['The main save threw while loading', 'no web for ice'],
      ['The backup save threw while loading', 'no web for ice'],
    ]);
    expect(slots.writes).toEqual([]);
  });
});

// D3: 「重新開始」, only under unreadable.
describe('starting over (D3)', () => {
  it('starts fresh under unreadable: main written at once, the old backup kept until the next save', () => {
    const slots = new LoggedSlots('{', 'garbage');
    const store = storeOn(slots);
    expect(store.open().status).toBe('unreadable');
    store.set(deepFreeze(setSpeed(store.profile, 4)));
    expect(store.save()).toBe('readOnly');
    const result = store.startOver();
    expect(result).toEqual({ status: 'fresh', notices: [] });
    expect(store.open()).toBe(result);
    expect([store.status, store.writable]).toEqual(['fresh', true]);
    expect(slots.written).toEqual(['main']);
    expect(slots.read('backup')).toBe('garbage');
    const started = slots.read('main');
    expect(store.profile).toEqual(freshProfile());
    expect(profileOf(started)).toEqual(freshProfile());
    store.set(deepFreeze(setSpeed(store.profile, 2)));
    expect(store.save()).toBe('saved');
    expect(slots.read('backup')).toBe(started);
    expect(() => store.startOver()).toThrow(
      'ProfileStore.startOver: the store is fresh, not unreadable',
    );
  });

  it('imports the M1 save again, once, when the lost save had claimed it', () => {
    const local = new MapStorage();
    new LocalSaveStorage(local).write('main', V1);
    const lost = new LocalSaveStorage(local, PROFILE_SAVE_PREFIX);
    lost.write('main', '{');
    lost.write('backup', '{"v":');
    const store = webStore(local);
    expect(store.open().status).toBe('unreadable');
    expect(store.startOver()).toEqual({
      status: 'imported',
      notices: [{ kind: 'v1Waiting', pending: PENDING }],
    });
    expect(profileOf(local.getItem(`${PROFILE_SAVE_PREFIX}main`))).toEqual(store.profile);
    expect(local.getItem(`${PROFILE_SAVE_PREFIX}backup`)).toBe('{"v":');
    expect(pick(store, 'fire')).toEqual({ claimed: PENDING, outcome: 'saved' });
    expect(webStore(local).open().status).toBe('loaded');
  });
});

describe('the store before open()', () => {
  it('holds a fresh profile, writes nothing and refuses what open() would undo', () => {
    const slots = new LoggedSlots(V2, OTHER);
    const store = storeOn(slots);
    expect(store.profile).toEqual(freshProfile());
    expect(store.writable).toBe(false);
    expect(store.save()).toBe('readOnly');
    expect(() => store.status).toThrow('ProfileStore: open() first');
    expect(() => store.set(deepFreeze(freshProfile()))).toThrow('ProfileStore: open() first');
    expect(() => store.startOver()).toThrow('ProfileStore: open() first');
    expect(slots.writes).toEqual([]);
  });

  it('opens once: a later call returns the same result and reads nothing again', () => {
    const slots = new LoggedSlots(V2);
    const store = storeOn(slots);
    const result = store.open();
    slots.write('main', '{');
    slots.write('backup', '{');
    expect(store.open()).toBe(result);
    expect([store.status, store.writable]).toEqual(['loaded', true]);
    expect(store.profile).toEqual(profileOf(V2));
  });
});
