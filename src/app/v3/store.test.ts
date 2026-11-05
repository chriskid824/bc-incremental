/**
 * The v3 page's save wiring by flavor (./store.ts; the lead's rulings R1-R3): the Demo's own
 * prefix, its one-time adoption of the slots under PROFILE_SAVE_PREFIX on the web, and the full
 * game's save surviving a Demo page on the same localStorage. openProfileStore runs on the page's
 * localStorage, a logged Map-backed Storage given through vi.stubGlobal (the tests run in node,
 * where createPlatform gives the web platform), and on the fixture content (src/data/web/testing),
 * where 熔核's full web holds the 雷 outer that DEMO_SCOPE_A locks.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { num } from '../../core/num';
import { DEMO_SCOPE_A, FULL_SCOPE } from '../../data/web';
import type { AssembledWeb } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import { unlockInvestment } from '../../meta/web/invest';
import type { CharacterProgress } from '../../meta/web/types';
import { DEMO_PROFILE_SAVE_PREFIX, PROFILE_SAVE_PREFIX } from '../../platform/storage';
import {
  addPlaySeconds,
  freshProfile,
  parseProfile,
  profileContext,
  serializeProfile,
} from '../../save/profile';
import type { SaveProfile } from '../../save/profile';
import { deepFreeze } from '../../save/testing';
import { adoptSharedSlots, openProfileStore } from './store';

/**
 * A Map-backed Storage that logs every getItem, setItem and removeItem by key (the platform's
 * achievements read theirs too).
 */
class LoggedStorage implements Storage {
  readonly items = new Map<string, string>();
  readonly log: string[] = [];

  constructor(items: Readonly<Record<string, string>> = {}) {
    for (const [key, value] of Object.entries(items)) this.items.set(key, value);
  }

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.log.push('clear');
    this.items.clear();
  }

  getItem(key: string): string | null {
    this.log.push(`get ${key}`);
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.log.push(`remove ${key}`);
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.log.push(`set ${key}`);
    this.items.set(key, value);
  }

  /** The logged calls on keys under `prefix`, writes and removals alone when `changes`. */
  touched(prefix: string, changes = false): string[] {
    return this.log.filter(
      (entry) =>
        entry === 'clear' ||
        (entry.slice(entry.indexOf(' ') + 1).startsWith(prefix) &&
          !(changes && entry.startsWith('get '))),
    );
  }

  /** The items under `prefix`, as an object. */
  under(prefix: string): Record<string, string> {
    return Object.fromEntries([...this.items].filter(([key]) => key.startsWith(prefix)));
  }
}

const FULL_MAIN = `${PROFILE_SAVE_PREFIX}main`;
const FULL_BACKUP = `${PROFILE_SAVE_PREFIX}backup`;
const DEMO_MAIN = `${DEMO_PROFILE_SAVE_PREFIX}main`;
const DEMO_BACKUP = `${DEMO_PROFILE_SAVE_PREFIX}backup`;

const CONTENT = fixtureContent();
const FULL_FIRE = profileContext(CONTENT, FULL_SCOPE).webOf('fire') as AssembledWeb;
const DEMO_FIRE = profileContext(CONTENT, DEMO_SCOPE_A).webOf('fire') as AssembledWeb;

/** 熔核's investment in its 雷 fusion (src/save/fixes.test.ts' case (c)): legal in the full game. */
const INVESTED: CharacterProgress = deepFreeze({
  ...unlockInvestment(FULL_FIRE, { singularityBeaten: false }, 'lightning'),
  wallet: { shards: num(987.25), cores: 3, resonance: 1 },
});
/** INVESTED's ids that the Demo's 熔核 web lacks: the 雷 outer's. */
const OUTSIDE = Object.keys(INVESTED.ranks).filter((id) => !DEMO_FIRE.byId.has(id));

/** freshProfile with 熔核 on `progress`. */
function withFire(progress: CharacterProgress): SaveProfile {
  const fresh = freshProfile();
  const fire = { ...fresh.characters.fire, progress };
  return deepFreeze({ ...fresh, characters: { ...fresh.characters, fire } });
}

/** The full game's save of INVESTED, and an older text of it for the backup. */
const FULL = withFire(INVESTED);
const FULL_TEXT = serializeProfile(FULL, '2026-11-05T01:00:00.000Z');
const FULL_OLDER = serializeProfile(FULL, '2026-11-05T00:59:30.000Z');
/** A Demo save of its own: a fresh profile a minute into play. */
const DEMO_TEXT = serializeProfile(addPlaySeconds(freshProfile(), 60), '2026-11-04T12:00:00.000Z');

/** The profile `text` loads as in the full game. */
function fullProfileOf(text: string | null): SaveProfile {
  const loaded = parseProfile(text ?? '', profileContext(CONTENT, FULL_SCOPE));
  if (!loaded.ok) throw new Error(`the text does not load: ${JSON.stringify(loaded)}`);
  return loaded.profile;
}

/** A page whose localStorage holds `items`, its log started after them. */
function page(items: Readonly<Record<string, string>> = {}): LoggedStorage {
  const local = new LoggedStorage(items);
  vi.stubGlobal('localStorage', local);
  return local;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the fixture build', () => {
  it('ranks the 雷 outer alone outside DEMO_SCOPE_A, and loads clean in the full game', () => {
    expect(OUTSIDE.length).toBeGreaterThan(0);
    expect(OUTSIDE.every((id) => id.startsWith('outer.lightning.'))).toBe(true);
    const loaded = parseProfile(FULL_TEXT, profileContext(CONTENT, FULL_SCOPE));
    expect(loaded.ok && { notices: loaded.notices, changed: loaded.changed }).toEqual({
      notices: [],
      changed: false,
    });
  });
});

// The bug this fixes: both flavors opened PROFILE_SAVE_PREFIX, so a Demo page on the full game's
// origin refunded 熔核's whole build (fixedSlot steps 2-4) and wrote that over the full save.
describe("the full game's save through a Demo page (the lead's rulings R1, R2)", () => {
  it('stays byte-identical while the Demo refunds its copy; the full game loads it intact', () => {
    const local = page({ [FULL_MAIN]: FULL_TEXT, [FULL_BACKUP]: FULL_OLDER });
    const demo = openProfileStore(CONTENT, 'demo');
    expect(demo.open()).toEqual({
      status: 'loaded',
      notices: [{ kind: 'refundedAll', character: 'fire', ids: OUTSIDE }],
    });
    expect(demo.profile.characters.fire.progress.ranks).toEqual({});
    // The refund is written at open into the Demo's slots, the adopted text rotated into backup.
    expect(local.getItem(DEMO_BACKUP)).toBe(FULL_TEXT);
    demo.set(addPlaySeconds(demo.profile, 60));
    expect(demo.save()).toBe('saved');
    expect(fullProfileOf(local.getItem(DEMO_MAIN))).toEqual(demo.profile);
    expect(local.under(PROFILE_SAVE_PREFIX)).toEqual({
      [FULL_MAIN]: FULL_TEXT,
      [FULL_BACKUP]: FULL_OLDER,
    });
    expect(local.touched(PROFILE_SAVE_PREFIX, true)).toEqual([]);

    const full = openProfileStore(CONTENT, 'full');
    expect(full.open()).toEqual({ status: 'loaded', notices: [] });
    expect(full.profile.characters.fire.progress).toEqual(INVESTED);
    expect(full.profile).toEqual(FULL);
    expect(local.under(PROFILE_SAVE_PREFIX)).toEqual({
      [FULL_MAIN]: FULL_TEXT,
      [FULL_BACKUP]: FULL_OLDER,
    });
  });
});

describe("the prefix and the scope follow the flavor (the lead's rulings R1, R3)", () => {
  it("keeps the Demo's save and the full game's apart, each under its flavor's prefix", () => {
    const local = page();
    const demo = openProfileStore(CONTENT, 'demo');
    expect(demo.open()).toEqual({ status: 'fresh', notices: [] });
    demo.set(withFire(INVESTED));
    expect(demo.save()).toBe('saved');
    expect(Object.keys(local.under('bc-incremental.'))).toEqual([DEMO_MAIN]);

    const full = openProfileStore(CONTENT, 'full');
    expect(full.open()).toEqual({ status: 'fresh', notices: [] });
    expect(full.save()).toBe('saved');
    expect(Object.keys(local.under('bc-incremental.'))).toEqual([DEMO_MAIN, FULL_MAIN]);
    expect(fullProfileOf(local.getItem(FULL_MAIN))).toEqual(freshProfile());
    // The Demo's save loads in DEMO_SCOPE_A, the full game's in FULL_SCOPE.
    expect(openProfileStore(CONTENT, 'demo').open()).toEqual({
      status: 'loaded',
      notices: [{ kind: 'refundedAll', character: 'fire', ids: OUTSIDE }],
    });
  });

  it("defaults to the build's FLAVOR: full here, the Demo's under VITE_FLAVOR=demo", async () => {
    const local = page({ [FULL_MAIN]: FULL_TEXT });
    expect(openProfileStore(CONTENT).open()).toEqual({ status: 'loaded', notices: [] });
    expect(local.touched(DEMO_PROFILE_SAVE_PREFIX)).toEqual([]);

    vi.stubEnv('VITE_FLAVOR', 'demo');
    vi.resetModules();
    const demoBuild = await import('./store');
    expect((await import('../../platform/flavor')).FLAVOR).toBe('demo');
    expect(demoBuild.openProfileStore(CONTENT).open()).toEqual({
      status: 'loaded',
      notices: [{ kind: 'refundedAll', character: 'fire', ids: OUTSIDE }],
    });
    expect(local.getItem(DEMO_BACKUP)).toBe(FULL_TEXT);
    expect(local.getItem(FULL_MAIN)).toBe(FULL_TEXT);
  });
});

describe("the Demo's one-time adoption (the lead's ruling R2)", () => {
  it('copies main and backup when the Demo has neither; the old keys stay byte-identical', () => {
    const local = page({ [FULL_MAIN]: FULL_TEXT, [FULL_BACKUP]: FULL_OLDER });
    const demo = openProfileStore(CONTENT, 'demo');
    // Copied as the store opens, before its first read.
    expect(local.under(DEMO_PROFILE_SAVE_PREFIX)).toEqual({
      [DEMO_MAIN]: FULL_TEXT,
      [DEMO_BACKUP]: FULL_OLDER,
    });
    expect(demo.open().status).toBe('loaded');
    for (let i = 0; i < 2; i++) {
      demo.set(addPlaySeconds(demo.profile, 30));
      expect(demo.save()).toBe('saved');
    }
    expect(local.under(PROFILE_SAVE_PREFIX)).toEqual({
      [FULL_MAIN]: FULL_TEXT,
      [FULL_BACKUP]: FULL_OLDER,
    });
    expect(local.touched(PROFILE_SAVE_PREFIX, true)).toEqual([]);
    // A second Demo page finds its own slots and copies nothing again.
    const before = local.under(DEMO_PROFILE_SAVE_PREFIX);
    local.log.length = 0;
    expect(openProfileStore(CONTENT, 'demo').open()).toEqual({ status: 'loaded', notices: [] });
    expect(local.under(DEMO_PROFILE_SAVE_PREFIX)).toEqual(before);
    expect(local.touched('bc-incremental.', true)).toEqual([]);
  });

  it('copies only the backup when only the backup exists, which the Demo restores from', () => {
    const local = page({ [FULL_BACKUP]: FULL_OLDER });
    const demo = openProfileStore(CONTENT, 'demo');
    expect(local.under(DEMO_PROFILE_SAVE_PREFIX)).toEqual({ [DEMO_BACKUP]: FULL_OLDER });
    expect(demo.open()).toEqual({
      status: 'restored',
      notices: [
        { kind: 'restored', error: 'main: empty' },
        { kind: 'refundedAll', character: 'fire', ids: OUTSIDE },
      ],
    });
    expect(local.getItem(DEMO_BACKUP)).toBe(FULL_OLDER);
    expect(local.under(PROFILE_SAVE_PREFIX)).toEqual({ [FULL_BACKUP]: FULL_OLDER });
    expect(local.touched(PROFILE_SAVE_PREFIX, true)).toEqual([]);
  });

  it('copies nothing when the Demo already has a main or a backup', () => {
    const old = { [FULL_MAIN]: FULL_TEXT, [FULL_BACKUP]: FULL_OLDER };
    const withMain = page({ ...old, [DEMO_MAIN]: DEMO_TEXT });
    const loaded = openProfileStore(CONTENT, 'demo');
    expect(withMain.under(DEMO_PROFILE_SAVE_PREFIX)).toEqual({ [DEMO_MAIN]: DEMO_TEXT });
    expect(loaded.open()).toEqual({ status: 'loaded', notices: [] });
    expect(loaded.profile.account.stats.playSeconds).toBe(60);

    const withBackup = page({ ...old, [DEMO_BACKUP]: DEMO_TEXT });
    const restored = openProfileStore(CONTENT, 'demo');
    expect(withBackup.under(DEMO_PROFILE_SAVE_PREFIX)).toEqual({ [DEMO_BACKUP]: DEMO_TEXT });
    expect(restored.open()).toEqual({
      status: 'restored',
      notices: [{ kind: 'restored', error: 'main: empty' }],
    });
    expect(restored.profile.account.stats.playSeconds).toBe(60);
    for (const local of [withMain, withBackup]) {
      expect(local.under(PROFILE_SAVE_PREFIX)).toEqual(old);
      expect(local.touched(PROFILE_SAVE_PREFIX, true)).toEqual([]);
    }
  });

  it('never adopts in the full game, which neither reads nor writes a Demo key', () => {
    const demoOnly = { [DEMO_MAIN]: DEMO_TEXT, [DEMO_BACKUP]: DEMO_TEXT };
    const local = page(demoOnly);
    const full = openProfileStore(CONTENT, 'full');
    expect(full.open()).toEqual({ status: 'fresh', notices: [] });
    full.set(withFire(INVESTED));
    expect(full.save()).toBe('saved');
    expect(full.save()).toBe('saved');
    expect(local.under(DEMO_PROFILE_SAVE_PREFIX)).toEqual(demoOnly);
    expect(local.touched(DEMO_PROFILE_SAVE_PREFIX)).toEqual([]);

    const both = { [FULL_MAIN]: FULL_TEXT, [FULL_BACKUP]: FULL_OLDER };
    const seeded = page(both);
    expect(openProfileStore(CONTENT, 'full').open()).toEqual({ status: 'loaded', notices: [] });
    expect(Object.fromEntries(seeded.items)).toEqual(both);
    expect(seeded.touched(DEMO_PROFILE_SAVE_PREFIX)).toEqual([]);
    // The gate does not even open the full game's localStorage.
    seeded.log.length = 0;
    const opened = vi.fn(() => seeded);
    adoptSharedSlots('web', 'full', opened);
    expect(opened).not.toHaveBeenCalled();
    expect(seeded.log).toEqual([]);
  });

  it('never adopts on Steam, whose localStorage it does not open', () => {
    const local = new LoggedStorage({ [FULL_MAIN]: FULL_TEXT, [FULL_BACKUP]: FULL_OLDER });
    const opened = vi.fn(() => local);
    adoptSharedSlots('steam', 'demo', opened);
    expect(opened).not.toHaveBeenCalled();
    expect(local.log).toEqual([]);
    expect(local.under(DEMO_PROFILE_SAVE_PREFIX)).toEqual({});
    // On the web the same Demo adopts.
    adoptSharedSlots('web', 'demo', opened);
    expect(local.under(DEMO_PROFILE_SAVE_PREFIX)).toEqual({
      [DEMO_MAIN]: FULL_TEXT,
      [DEMO_BACKUP]: FULL_OLDER,
    });
  });

  it('copies nothing where the page has no localStorage, which keeps the slots in memory', () => {
    expect(() =>
      adoptSharedSlots('web', 'demo', () => {
        throw new Error('SecurityError');
      }),
    ).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    const demo = openProfileStore(CONTENT, 'demo');
    expect(demo.open()).toEqual({ status: 'fresh', notices: [] });
    expect(demo.save()).toBe('saved');
  });
});
