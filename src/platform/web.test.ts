import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIVE_SAVE_PREFIX } from '../app/devFlags';
import { ACHIEVEMENTS_KEY } from './achievements';
import type { Analytics } from './analytics';
import { createPlatform } from './index';
import type { AnalyticsPolicy } from './platform';
import { WEB_ANALYTICS_POLICY, createWebPlatform } from './web';
import type { WebEnv } from './web';

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

const ANALYTICS: Analytics = {
  installId: 'install',
  canSend: false,
  sending: false,
  track: () => {},
  flush: () => {},
  exportLocal: () => '{}',
};

/** The setup main.ts passes, with a factory that records each policy it is called with. */
function setup(savePrefix?: string) {
  const analytics = vi.fn((_policy: AnalyticsPolicy): Analytics => ANALYTICS);
  return { analytics, setup: { ...(savePrefix === undefined ? {} : { savePrefix }), analytics } };
}

const pageWith = (storage: Storage): WebEnv => ({ localStorage: () => storage });

/** A page whose localStorage throws on access, as with blocked site data. */
const BLOCKED: WebEnv = {
  localStorage: () => {
    throw new Error('SecurityError');
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWebPlatform', () => {
  it("keeps the player's save in localStorage under bc-incremental.save.main and .backup", () => {
    const storage = new MapStorage();
    const platform = createWebPlatform(setup().setup, pageWith(storage));
    expect(platform.id).toBe('web');
    platform.storage.write('main', 'one');
    platform.storage.write('backup', 'two');
    expect([...storage.items]).toEqual([
      ['bc-incremental.save.main', 'one'],
      ['bc-incremental.save.backup', 'two'],
    ]);
    expect(platform.storage.read('main')).toBe('one');
    expect(createWebPlatform(setup().setup, pageWith(storage)).storage.read('backup')).toBe('two');
  });

  it("keeps ?hive's profile under its save prefix, apart from the player's save", () => {
    const storage = new MapStorage();
    createWebPlatform(setup().setup, pageWith(storage)).storage.write('main', 'M1 progress');
    const hive = createWebPlatform(setup(HIVE_SAVE_PREFIX).setup, pageWith(storage));
    expect(hive.storage.read('main')).toBeNull();
    hive.storage.write('main', 'hive progress');
    hive.storage.write('backup', 'older hive progress');
    expect([...storage.items]).toEqual([
      ['bc-incremental.save.main', 'M1 progress'],
      ['bc-incremental.hive.save.main', 'hive progress'],
      ['bc-incremental.hive.save.backup', 'older hive progress'],
    ]);
    expect(hive.storage.read('main')).toBe('hive progress');
  });

  it('keeps achievements in the local record in localStorage', () => {
    const storage = new MapStorage();
    const platform = createWebPlatform(setup().setup, pageWith(storage));
    expect(platform.achievements.unlock('ACH_WIN_ONE_GAME')).toBe(true);
    expect(storage.getItem(ACHIEVEMENTS_KEY)).toBe('["ACH_WIN_ONE_GAME"]');
    const again = createWebPlatform(setup().setup, pageWith(storage));
    expect(again.achievements.isUnlocked('ACH_WIN_ONE_GAME')).toBe(true);
  });

  it('falls back to memory when localStorage throws: saves and achievements last the page', () => {
    const { analytics, setup: blockedSetup } = setup();
    const platform = createWebPlatform(blockedSetup, BLOCKED);
    expect(platform.storage.read('main')).toBeNull();
    platform.storage.write('main', 'progress');
    expect(platform.storage.read('main')).toBe('progress');
    expect(platform.achievements.unlock('ACH_WIN_ONE_GAME')).toBe(true);
    expect(platform.achievements.isUnlocked('ACH_WIN_ONE_GAME')).toBe(true);
    expect(createWebPlatform(setup().setup, BLOCKED).storage.read('main')).toBeNull();
    expect(analytics).toHaveBeenCalledTimes(1);
  });

  it("builds the analytics once, under the web playtest's policy (send by default)", () => {
    const { analytics, setup: webSetup } = setup();
    const platform = createWebPlatform(webSetup, pageWith(new MapStorage()));
    expect(analytics).toHaveBeenCalledTimes(1);
    expect(analytics).toHaveBeenCalledWith({ cloud: true, sendByDefault: true });
    expect(WEB_ANALYTICS_POLICY).toEqual({ cloud: true, sendByDefault: true });
    expect(platform.analytics).toBe(ANALYTICS);
  });

  it("uses the page's localStorage by default, and memory where the page has none", () => {
    const storage = new MapStorage();
    vi.stubGlobal('localStorage', storage);
    const platform = createWebPlatform(setup().setup);
    platform.storage.write('main', 'progress');
    platform.achievements.unlock('ACH_WIN_ONE_GAME');
    expect([...storage.items.keys()]).toEqual(['bc-incremental.save.main', ACHIEVEMENTS_KEY]);

    vi.stubGlobal('localStorage', undefined);
    const bare = createWebPlatform(setup().setup);
    bare.storage.write('main', 'progress');
    expect(bare.storage.read('main')).toBe('progress');
    expect(bare.achievements.unlock('ACH_WIN_ONE_GAME')).toBe(true);
  });
});

describe('createPlatform', () => {
  it('gives the web platform in every mode but steam (here MODE is test)', () => {
    expect(import.meta.env.MODE).toBe('test');
    vi.stubGlobal('localStorage', new MapStorage());
    const { analytics, setup: appSetup } = setup();
    const platform = createPlatform(appSetup);
    expect(platform.id).toBe('web');
    expect(analytics).toHaveBeenCalledTimes(1);
    expect(analytics).toHaveBeenCalledWith(WEB_ANALYTICS_POLICY);
  });
});
