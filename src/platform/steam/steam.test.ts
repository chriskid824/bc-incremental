import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIVE_SAVE_PREFIX } from '../../app/devFlags';
import { MESSAGES, fill } from '../../i18n';
import { ACHIEVEMENTS_KEY } from '../achievements';
import type { Analytics } from '../analytics';
import type { AnalyticsPolicy } from '../platform';
import type { SaveReadResult, SaveSlot } from '../storage';
import { BRIDGE_VERSION, NATIVE_BRIDGE_KEY } from './bridge';
import type { CheckBridge, NativeBridge, SaveWriteResult, ShellInfo, SteamStatus } from './bridge';
import type { CheckPanelBridge } from './checkPanel';
import {
  BridgeSaveStorage,
  MissingBridgeError,
  STEAM_ANALYTICS_POLICY,
  SteamAchievements,
  createSteamPlatform,
} from './index';
import type { SteamEnv } from './index';

/** A Map-backed Storage, standing in for the page's localStorage. */
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

const STEAM_OK: SteamStatus = {
  ok: true,
  appId: 480,
  language: 'english',
  steamDeck: false,
  initMs: 140,
};
const NO_STEAM: SteamStatus = { ok: false, stage: 'init', error: 'Steam is not running' };

function shellInfo(steam: SteamStatus, checkMode = false): ShellInfo {
  return {
    bridgeVersion: 2,
    checkMode,
    steam,
    overlaySwitches: steam.ok ? ['in-process-gpu', 'disable-direct-composition'] : [],
    saveDir: '/home/player/.config/bc-incremental/saves',
    saveDirShown: '~/.config/bc-incremental/saves',
    autoCloud: {
      root: 'LinuxHome',
      subdirectory: '.config/bc-incremental/saves',
      pattern: '*.json',
    },
    versions: { app: '0.0.1', electron: '44.9.3', chrome: '', node: '', steamworks: '0.4.0' },
    os: { platform: 'linux', arch: 'x64', release: '6.8.0', translated: false },
    gpu: 'gpu_compositing=enabled webgl=enabled',
  };
}

/**
 * A bridge like the preload's: save files in a map, Steam's achievements in a set; every call is
 * logged. `writeResult` answers the writes; `steamInfo` can be swapped for a failing one. With
 * `checkMode`, steamInfo says the shell runs `--steam-check` (the check itself is fakeCheck's).
 */
function fakeBridge(steam: SteamStatus = STEAM_OK, checkMode = false) {
  const files = new Map<SaveSlot, string>();
  const steamUnlocked = new Set<string>();
  const calls: string[] = [];
  const state = { writeResult: { ok: true } as SaveWriteResult };
  const bridge = {
    version: 2,
    steamInfo: vi.fn((): ShellInfo => shellInfo(steam, checkMode)),
    storage: {
      read: vi.fn((slot: SaveSlot): SaveReadResult => {
        calls.push(`read ${slot}`);
        return { ok: true, text: files.get(slot) ?? null };
      }),
      write: vi.fn((slot: SaveSlot, text: string): SaveWriteResult => {
        calls.push(`write ${slot}`);
        if (state.writeResult.ok) files.set(slot, text);
        return state.writeResult;
      }),
    },
    achievements: {
      unlock: vi.fn((id: string): boolean => {
        calls.push(`unlock ${id}`);
        steamUnlocked.add(id);
        return true;
      }),
      isUnlocked: vi.fn((id: string): boolean => {
        calls.push(`isUnlocked ${id}`);
        return steamUnlocked.has(id);
      }),
    },
  } satisfies NativeBridge;
  return { bridge, files, steamUnlocked, calls, state };
}

/** The check's calls, as the preload exposes them under --steam-check. */
function fakeCheck() {
  return {
    clearAchievement: vi.fn((_id: string) => true),
    openOverlay: vi.fn((_dialog: 'achievements' | 'friends') => {}),
    listSaves: vi.fn(() => []),
    showSaves: vi.fn(() => {}),
    saveReport: vi.fn((_text: string) => ({ ok: true, where: 'report.txt' })),
    recentErrors: vi.fn(() => []),
  } satisfies CheckBridge;
}

const ANALYTICS: Analytics = {
  installId: 'install',
  canSend: false,
  sending: false,
  track: () => {},
  flush: () => {},
  exportLocal: () => '{}',
};

/** A page holding `bridge` (if any) under bcNative, with its own localStorage and panel mount. */
function page(bridge?: unknown) {
  const storage = new MapStorage();
  const global = bridge === undefined ? {} : { [NATIVE_BRIDGE_KEY]: bridge };
  const mount = vi.fn((_bridge: CheckPanelBridge, _info: ShellInfo) => {});
  const env: SteamEnv = { global, localStorage: () => storage, mountCheckPanel: mount };
  const analytics = vi.fn((_policy: AnalyticsPolicy): Analytics => ANALYTICS);
  return { env, storage, analytics, mount };
}

/**
 * What the shell's bridge may answer to a read: its name, the answer (a call that throws
 * included), what tryRead() makes of it and what read() does, M1's answer as before version 2.
 */
const BRIDGE_READS: readonly (readonly [string, () => unknown, SaveReadResult, string | null])[] = [
  ['a text', () => ({ ok: true, text: 'progress' }), { ok: true, text: 'progress' }, 'progress'],
  ["an empty file's ''", () => ({ ok: true, text: '' }), { ok: true, text: '' }, null],
  ['no file', () => ({ ok: true, text: null }), { ok: true, text: null }, null],
  [
    'a failed read',
    () => ({ ok: false, error: 'EBUSY: resource busy or locked' }),
    { ok: false, error: 'EBUSY: resource busy or locked' },
    null,
  ],
  [
    'a throw',
    () => {
      throw new Error('IPC failed');
    },
    { ok: false, error: "the bridge's read threw: IPC failed" },
    null,
  ],
  ['null', () => null, { ok: false, error: 'the bridge answered null' }, null],
  ['a bare string', () => 'progress', { ok: false, error: 'the bridge answered "progress"' }, null],
  [
    'ok without text',
    () => ({ ok: true }),
    { ok: false, error: 'the bridge answered {"ok":true}' },
    null,
  ],
  [
    'failed without error',
    () => ({ ok: false }),
    { ok: false, error: 'the bridge answered {"ok":false}' },
    null,
  ],
  [
    "ok: 'yes'",
    () => ({ ok: 'yes', text: 'progress' }),
    { ok: false, error: 'the bridge answered {"ok":"yes","text":"progress"}' },
    null,
  ],
  [
    'a text that is a number',
    () => ({ ok: true, text: 42 }),
    { ok: false, error: 'the bridge answered {"ok":true,"text":42}' },
    null,
  ],
  [
    'an error that is not text',
    () => ({ ok: false, error: { code: 'EBUSY' } }),
    { ok: false, error: 'the bridge answered {"ok":false,"error":{"code":"EBUSY"}}' },
    null,
  ],
  [
    'extra fields',
    () => ({ ok: true, text: 'progress', error: 'ignored' }),
    { ok: true, text: 'progress' },
    'progress',
  ],
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createSteamPlatform', () => {
  it('saves through the bridge in exactly the slots asked, and never in localStorage', () => {
    const { bridge, files, calls } = fakeBridge();
    for (const savePrefix of [undefined, HIVE_SAVE_PREFIX]) {
      const { env, storage, analytics } = page(bridge);
      const setup = { ...(savePrefix === undefined ? {} : { savePrefix }), analytics };
      const platform = createSteamPlatform(setup, env);
      expect(platform.id).toBe('steam');
      calls.length = 0;
      platform.storage.write('main', `main ${savePrefix}`);
      platform.storage.write('backup', `backup ${savePrefix}`);
      expect(platform.storage.read('main')).toBe(`main ${savePrefix}`);
      expect(platform.storage.read('backup')).toBe(`backup ${savePrefix}`);
      expect(calls).toEqual(['write main', 'write backup', 'read main', 'read backup']);
      expect([...files.keys()]).toEqual(['main', 'backup']);
      expect(storage.length, `localStorage beside the bridge (${savePrefix})`).toBe(0);
    }
  });

  it('reads null when the bridge has no text or its call throws', () => {
    const { bridge, files } = fakeBridge();
    const { env, analytics } = page(bridge);
    const { storage } = createSteamPlatform({ analytics }, env);
    expect(storage.read('main')).toBeNull();
    files.set('main', 'progress');
    expect(storage.read('main')).toBe('progress');
    bridge.storage.read.mockImplementation(() => {
      throw new Error('IPC failed');
    });
    expect(storage.read('main')).toBeNull();
    for (const answer of [undefined, 42, { text: 'progress' }]) {
      bridge.storage.read.mockReturnValue(answer as unknown as SaveReadResult);
      expect(storage.read('main'), JSON.stringify(answer)).toBeNull();
    }
  });

  // Catches a failed read, a throw or a malformed answer taken for an empty slot (the lead's
  // ruling SR5), and read() changing M1's answers, '' above all (SR2).
  it.each(BRIDGE_READS)(
    'reads %s through tryRead as the store needs it, and through read() as M1 did',
    (_name, answer, tried, read) => {
      const { bridge } = fakeBridge();
      bridge.storage.read.mockImplementation((): SaveReadResult => answer() as SaveReadResult);
      const slots = new BridgeSaveStorage(bridge.storage);
      expect(slots.tryRead('main')).toEqual(tried);
      expect(slots.read('main')).toBe(read);
      expect(bridge.storage.read.mock.calls).toEqual([['main'], ['main']]);
    },
  );

  it('cuts a malformed answer short in the error, and names a value JSON cannot write by its type', () => {
    const { bridge } = fakeBridge();
    const slots = new BridgeSaveStorage(bridge.storage);
    const save = `{"v":2,"data":"${'x'.repeat(5000)}"}`;
    bridge.storage.read.mockReturnValue(save as unknown as SaveReadResult);
    expect(slots.tryRead('backup')).toEqual({
      ok: false,
      error: `the bridge answered ${JSON.stringify(save).slice(0, 60)}…`,
    });
    for (const [answer, type] of [
      [undefined, 'undefined'],
      [10n, 'bigint'],
      [() => 'progress', 'function'],
    ] as const) {
      bridge.storage.read.mockReturnValue(answer as unknown as SaveReadResult);
      expect(slots.tryRead('main'), type).toEqual({
        ok: false,
        error: `the bridge answered ${type}`,
      });
    }
  });

  // Catches a throw that is not an Error escaping tryRead, which never throws (the lead's ruling
  // SR1): a call that throws anything is a failed read (SR5), and read() answers null for it, as M1
  // did (SR2).
  it('reads a throw that is not an Error as a failed read too, never throwing', () => {
    const { bridge } = fakeBridge();
    const slots = new BridgeSaveStorage(bridge.storage);
    const throws: readonly (readonly [unknown, string])[] = [
      ['IPC failed', 'IPC failed'],
      [null, 'null'],
      [undefined, 'undefined'],
    ];
    for (const [thrown, text] of throws) {
      bridge.storage.read.mockImplementation((): SaveReadResult => {
        throw thrown;
      });
      expect(slots.tryRead('main'), text).toEqual({
        ok: false,
        error: `the bridge's read threw: ${text}`,
      });
      expect(slots.read('main'), text).toBeNull();
    }
  });

  it('warns when a write fails, as LocalSaveStorage does, and never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bridge, files, state } = fakeBridge();
    const { env, analytics } = page(bridge);
    const { storage } = createSteamPlatform({ analytics }, env);
    storage.write('main', 'progress');
    expect(warn).not.toHaveBeenCalled();

    state.writeResult = { ok: false, error: 'ENOSPC: no space left on device' };
    storage.write('main', 'newer progress');
    expect(warn).toHaveBeenCalledWith('Save failed', 'ENOSPC: no space left on device');
    expect(files.get('main')).toBe('progress');

    const thrown = new Error('IPC failed');
    bridge.storage.write.mockImplementation(() => {
      throw thrown;
    });
    expect(() => storage.write('backup', 'progress')).not.toThrow();
    expect(warn).toHaveBeenLastCalledWith('Save failed', thrown);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('unlocks achievements through Steam when it started, and checks the ids first', () => {
    const { bridge, steamUnlocked, calls } = fakeBridge(STEAM_OK);
    const { env, storage, analytics } = page(bridge);
    const { achievements } = createSteamPlatform({ analytics }, env);
    expect(achievements.isUnlocked('ACH_WIN_ONE_GAME')).toBe(false);
    expect(achievements.unlock('ACH_WIN_ONE_GAME')).toBe(true);
    expect(achievements.isUnlocked('ACH_WIN_ONE_GAME')).toBe(true);
    expect([...steamUnlocked]).toEqual(['ACH_WIN_ONE_GAME']);
    for (const id of ['', 'ACH WIN', '../x', 'A'.repeat(65)]) {
      expect(achievements.unlock(id), id).toBe(false);
      expect(achievements.isUnlocked(id), id).toBe(false);
    }
    expect(calls).toEqual([
      'isUnlocked ACH_WIN_ONE_GAME',
      'unlock ACH_WIN_ONE_GAME',
      'isUnlocked ACH_WIN_ONE_GAME',
    ]);
    expect(storage.getItem(ACHIEVEMENTS_KEY)).toBeNull();
  });

  it("reads Steam's failures as false: a call that throws or answers anything but true", () => {
    const { bridge } = fakeBridge(STEAM_OK);
    const { env, analytics } = page(bridge);
    const { achievements } = createSteamPlatform({ analytics }, env);
    for (const answer of [false, null, undefined, 1, 'true', {}]) {
      bridge.achievements.unlock.mockReturnValue(answer as unknown as boolean);
      bridge.achievements.isUnlocked.mockReturnValue(answer as unknown as boolean);
      expect(achievements.unlock('ACH_WIN_ONE_GAME'), JSON.stringify(answer)).toBe(false);
      expect(achievements.isUnlocked('ACH_WIN_ONE_GAME'), JSON.stringify(answer)).toBe(false);
    }
    bridge.achievements.unlock.mockImplementation(() => {
      throw new Error('IPC failed');
    });
    bridge.achievements.isUnlocked.mockImplementation(() => {
      throw new Error('IPC failed');
    });
    expect(achievements.unlock('ACH_WIN_ONE_GAME')).toBe(false);
    expect(achievements.isUnlocked('ACH_WIN_ONE_GAME')).toBe(false);
  });

  it('keeps achievements in the local record while Steam is not running (C9/F6)', () => {
    const failing = fakeBridge(STEAM_OK);
    failing.bridge.steamInfo.mockImplementation(() => {
      throw new Error('IPC failed');
    });
    for (const { bridge, calls } of [fakeBridge(NO_STEAM), failing]) {
      const { env, storage, analytics } = page(bridge);
      const { achievements } = createSteamPlatform({ analytics }, env);
      expect(achievements.unlock('ACH_WIN_ONE_GAME')).toBe(true);
      expect(achievements.isUnlocked('ACH_WIN_ONE_GAME')).toBe(true);
      expect(achievements.unlock('ACH WIN')).toBe(false);
      expect(storage.getItem(ACHIEVEMENTS_KEY)).toBe('["ACH_WIN_ONE_GAME"]');
      expect(calls).toEqual([]);
      expect(bridge.steamInfo).toHaveBeenCalledTimes(1);
    }
  });

  it("mounts the check panel under --steam-check, on Steam's own achievements and the check", () => {
    for (const steam of [STEAM_OK, NO_STEAM]) {
      const { bridge, calls } = fakeBridge(steam, true);
      const check = fakeCheck();
      const { env, analytics, mount } = page({ ...bridge, check });
      const platform = createSteamPlatform({ analytics }, env);
      expect(mount).toHaveBeenCalledTimes(1);
      const [given, info] = mount.mock.calls[0] ?? [];
      expect(info).toEqual(shellInfo(steam, true));
      expect(given?.check).toBe(check);
      // Steam's achievements even while the game keeps its own in the local record (C9/F6).
      expect(given?.achievements).toBe(bridge.achievements);
      expect(platform.achievements instanceof SteamAchievements, JSON.stringify(steam)).toBe(
        steam.ok,
      );
      // One bc:info for the platform and the panel; the panel asks again for its report.
      expect(bridge.steamInfo).toHaveBeenCalledTimes(1);
      expect(given?.steamInfo()).toEqual(shellInfo(steam, true));
      expect(bridge.steamInfo).toHaveBeenCalledTimes(2);
      expect(calls).toEqual([]);
    }
  });

  it('mounts no panel outside the check mode, without check, or when the shell cannot tell', () => {
    const check = fakeCheck();
    const throwing = fakeBridge(STEAM_OK, true);
    throwing.bridge.steamInfo.mockImplementation(() => {
      throw new Error('IPC failed');
    });
    const silent = fakeBridge(STEAM_OK, true);
    silent.bridge.steamInfo.mockReturnValue(null as unknown as ShellInfo);
    const loose = fakeBridge(STEAM_OK, true);
    loose.bridge.steamInfo.mockReturnValue({
      ...shellInfo(STEAM_OK),
      checkMode: 'true',
    } as unknown as ShellInfo);
    const cases: readonly (readonly [string, unknown])[] = [
      ['not the check mode', { ...fakeBridge(STEAM_OK, false).bridge, check }],
      ['no check on the bridge', fakeBridge(STEAM_OK, true).bridge],
      ['check: undefined', { ...fakeBridge(STEAM_OK, true).bridge, check: undefined }],
      ['steamInfo throws', { ...throwing.bridge, check }],
      ['steamInfo answers null', { ...silent.bridge, check }],
      ["checkMode: 'true'", { ...loose.bridge, check }],
    ];
    for (const [name, bridge] of cases) {
      const { env, analytics, mount } = page(bridge);
      const platform = createSteamPlatform({ analytics }, env);
      expect(mount, name).not.toHaveBeenCalled();
      expect(platform.id, name).toBe('steam');
    }
    for (const call of Object.values(check)) expect(call).not.toHaveBeenCalled();
  });

  it('builds the analytics once, local only and off by default (C9/F12)', () => {
    const { bridge } = fakeBridge();
    const { env, analytics } = page(bridge);
    const platform = createSteamPlatform({ analytics }, env);
    expect(analytics).toHaveBeenCalledTimes(1);
    expect(analytics).toHaveBeenCalledWith({ cloud: false, sendByDefault: false });
    expect(STEAM_ANALYTICS_POLICY).toEqual({ cloud: false, sendByDefault: false });
    expect(platform.analytics).toBe(ANALYTICS);
  });

  // Catches a page that takes a version 1 bridge, whose read answers null for a failed read.
  it('throws MissingBridgeError without the bridge or with another version of it', () => {
    const { bridge } = fakeBridge();
    const cases: readonly (readonly [unknown, string])[] = [
      [undefined, 'no bcNative bridge on this page'],
      [null, 'no bcNative bridge on this page'],
      [{ ...bridge, version: 1 }, 'needs bcNative bridge version 2 (this page has version 1)'],
      [{ ...bridge, version: 3 }, 'needs bcNative bridge version 2 (this page has version 3)'],
      [{ ...bridge, version: '2' }, 'version 2 (this page has an unversioned one)'],
      [{ storage: bridge.storage }, 'version 2 (this page has an unversioned one)'],
      ['bcNative', 'version 2 (this page has an unversioned one)'],
    ];
    expect(BRIDGE_VERSION).toBe(2);
    for (const [found, message] of cases) {
      const { env, storage, analytics } = page();
      Object.assign(env.global, { [NATIVE_BRIDGE_KEY]: found });
      let error: unknown = null;
      try {
        createSteamPlatform({ analytics }, env);
      } catch (thrown) {
        error = thrown;
      }
      expect(error, JSON.stringify(found)).toBeInstanceOf(MissingBridgeError);
      expect((error as Error).name).toBe('MissingBridgeError');
      expect((error as Error).message).toContain(message);
      expect(analytics).not.toHaveBeenCalled();
      expect(storage.length).toBe(0);
    }
  });

  it("shows the missing bridge through main.ts' fatal error text, in both locales", () => {
    let message = '';
    try {
      createSteamPlatform({ analytics: () => ANALYTICS }, page().env);
    } catch (error) {
      message = (error as Error).message;
    }
    const reason =
      'the Steam build runs only in its Electron shell (no bcNative bridge on this page)';
    expect(message).toBe(reason);
    expect(fill(MESSAGES.en['error.init'], { message })).toBe(
      `The game could not start: ${reason}`,
    );
    expect(fill(MESSAGES['zh-TW']['error.init'], { message })).toBe(`遊戲無法啟動：${reason}`);
  });

  it("reads the bridge from the page's global object by default", () => {
    const { bridge, files } = fakeBridge(NO_STEAM);
    expect(() => createSteamPlatform({ analytics: () => ANALYTICS })).toThrow(MissingBridgeError);
    vi.stubGlobal(NATIVE_BRIDGE_KEY, bridge);
    vi.stubGlobal('localStorage', undefined);
    const platform = createSteamPlatform({ analytics: () => ANALYTICS });
    platform.storage.write('main', 'progress');
    expect(files.get('main')).toBe('progress');
    // No localStorage outside a browser: the local record lasts the page.
    expect(platform.achievements.unlock('ACH_WIN_ONE_GAME')).toBe(true);
    expect(platform.achievements.isUnlocked('ACH_WIN_ONE_GAME')).toBe(true);
  });
});
