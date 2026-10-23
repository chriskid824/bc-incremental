/**
 * The preload against a stand-in `electron` (C9/F1: a test never loads Electron itself). Each case
 * loads it afresh, with main answering bc:info in or out of the check mode, and inspects the one
 * object it hands contextBridge: `check` (design §2.2) is on it only in the check mode.
 */

import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_VERSION, NATIVE_BRIDGE_KEY } from '../src/platform/steam/bridge';
import type { CheckBridge, NativeBridge } from '../src/platform/steam/bridge';
import { CHANNELS } from './channels';

type Call = (...args: unknown[]) => unknown;

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn(), exposeInIsolatedWorld: vi.fn() },
  ipcRenderer: {
    sendSync: vi.fn(),
    send: vi.fn(),
    invoke: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    addListener: vi.fn(),
  },
}));

vi.mock('electron', () => electron);

/** A ShellInfo, as far as the preload reads it. */
function infoOf(checkMode: boolean): unknown {
  return { bridgeVersion: 1, checkMode };
}

/** Main's answer on each channel: `answer:<channel>`, and `info` on bc:info. */
function main(info: unknown) {
  return (channel: string): unknown => (channel === CHANNELS.info ? info : `answer:${channel}`);
}

/**
 * Loads the preload afresh, main answering bc:info with `info`, and returns what it exposed and
 * what it sent while loading.
 */
async function load(checkMode: boolean, info: unknown = infoOf(checkMode)) {
  vi.resetModules();
  vi.clearAllMocks();
  electron.ipcRenderer.sendSync.mockImplementation(main(info));
  await import('./preload');
  const loadCalls = [...electron.ipcRenderer.sendSync.mock.calls];
  const [exposed, ...more] = electron.contextBridge.exposeInMainWorld.mock.calls;
  expect(more).toEqual([]);
  if (exposed === undefined) throw new Error('the preload exposed nothing');
  electron.ipcRenderer.sendSync.mockClear();
  const [key, bridge] = exposed as [unknown, Record<string, unknown>];
  return { key, bridge, loadCalls };
}

/** Every function in `value`, by its dotted path, and every object or value on the way. */
function walk(value: unknown, path = ''): { functions: Map<string, Call>; values: unknown[] } {
  const functions = new Map<string, Call>();
  const values: unknown[] = [value];
  if (typeof value === 'function') functions.set(path, value as Call);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      const found = walk(inner, path === '' ? key : `${path}.${key}`);
      for (const [name, fn] of found.functions) functions.set(name, fn);
      values.push(...found.values);
    }
  }
  return { functions, values };
}

/**
 * Each function's channel and how many of its arguments it sends (NativeBridge's and
 * CheckBridge's signatures).
 */
const SENDS: Record<string, readonly [string, number]> = {
  steamInfo: [CHANNELS.info, 0],
  'storage.read': [CHANNELS.saveRead, 1],
  'storage.write': [CHANNELS.saveWrite, 2],
  'achievements.unlock': [CHANNELS.achUnlock, 1],
  'achievements.isUnlocked': [CHANNELS.achIsUnlocked, 1],
  'check.clearAchievement': [CHANNELS.checkClear, 1],
  'check.openOverlay': [CHANNELS.checkOverlay, 1],
  'check.listSaves': [CHANNELS.checkSaves, 0],
  'check.showSaves': [CHANNELS.checkShowSaves, 0],
  'check.saveReport': [CHANNELS.checkReport, 1],
  'check.recentErrors': [CHANNELS.checkErrors, 0],
};

/** The functions that return nothing, whatever main answers. */
const VOID = ['check.openOverlay', 'check.showSaves'];

const MINIMAL = Object.keys(SENDS).filter((name) => !name.startsWith('check.'));

describe('the preload', () => {
  it("exposes one frozen bridge under bcNative with exactly ARCH §11's minimal API", async () => {
    const { key, bridge, loadCalls } = await load(false);
    expect(key).toBe(NATIVE_BRIDGE_KEY);
    expect(key).toBe('bcNative');
    expect(Object.keys(bridge).sort()).toEqual(['achievements', 'steamInfo', 'storage', 'version']);
    expect(Object.keys(bridge.storage as object).sort()).toEqual(['read', 'write']);
    expect(Object.keys(bridge.achievements as object).sort()).toEqual(['isUnlocked', 'unlock']);
    expect(bridge.version).toBe(BRIDGE_VERSION);
    expect(bridge.version).toBe(1);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(bridge.storage)).toBe(true);
    expect(Object.isFrozen(bridge.achievements)).toBe(true);
    expect([...walk(bridge).functions.keys()].sort()).toEqual(MINIMAL.sort());
    // The design's one bc:info, to learn whether this is the check mode, and nothing else.
    expect(loadCalls).toEqual([[CHANNELS.info]]);
    expect(electron.contextBridge.exposeInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("adds check, the check mode's six calls, frozen, when main says the check mode", async () => {
    const { key, bridge, loadCalls } = await load(true);
    expect(key).toBe(NATIVE_BRIDGE_KEY);
    expect(Object.keys(bridge).sort()).toEqual([
      'achievements',
      'check',
      'steamInfo',
      'storage',
      'version',
    ]);
    const check: Record<keyof CheckBridge, true> = {
      clearAchievement: true,
      openOverlay: true,
      listSaves: true,
      showSaves: true,
      saveReport: true,
      recentErrors: true,
    };
    expect(Object.keys(bridge.check as object).sort()).toEqual(Object.keys(check).sort());
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(bridge.check)).toBe(true);
    expect([...walk(bridge).functions.keys()].sort()).toEqual(Object.keys(SENDS).sort());
    expect(loadCalls).toEqual([[CHANNELS.info]]);
  });

  it('leaves check out unless bc:info says checkMode: true', async () => {
    for (const info of [
      infoOf(false),
      null,
      undefined,
      'answer:bc:info',
      {},
      { checkMode: 'true' },
      { checkMode: 1 },
      [true],
    ]) {
      const { bridge, loadCalls } = await load(false, info);
      expect('check' in bridge, JSON.stringify(info)).toBe(false);
      expect(walk(bridge).functions.size).toBe(MINIMAL.length);
      expect(loadCalls).toEqual([[CHANNELS.info]]);
    }
  });

  it('sends each call on its own channel with only its declared arguments', async () => {
    const { bridge } = await load(true);
    const { functions } = walk(bridge);
    expect(functions.size).toBe(Object.keys(SENDS).length);
    // Extra arguments, and arguments that name another channel, change nothing.
    const extra = [CHANNELS.saveWrite, 'bc:check:clear', 'bc:save:write', { slot: 'main' }];
    for (const [name, fn] of functions) {
      const sends = SENDS[name];
      if (sends === undefined) throw new Error(`${name} is not part of the bridge`);
      const [channel, count] = sends;
      electron.ipcRenderer.sendSync.mockClear();
      const args = ['bc:check:report', 'bc:ach:unlock', ...extra];
      const answer = fn(...args);
      expect(electron.ipcRenderer.sendSync.mock.calls, name).toEqual([
        [channel, ...args.slice(0, count)],
      ]);
      const expected = VOID.includes(name)
        ? undefined
        : channel === CHANNELS.info
          ? infoOf(true)
          : `answer:${channel}`;
      expect(answer, name).toEqual(expected);
    }
  });

  it("returns main's answer as it came", async () => {
    const { bridge } = await load(true);
    const shell = bridge as unknown as NativeBridge;
    const written = { ok: false, error: 'bc:save:write failed' };
    const saved = { ok: true, where: '/home/hoshi/.config/bc-incremental/steam-check/r.txt' };
    const files = [{ name: 'main.json', bytes: 812, modified: '2026-10-23T09:00:00.000Z' }];
    const errors = ['console error: boom'];
    const answers: Readonly<Record<string, unknown>> = {
      [CHANNELS.saveWrite]: written,
      [CHANNELS.saveRead]: null,
      [CHANNELS.checkClear]: false,
      [CHANNELS.checkSaves]: files,
      [CHANNELS.checkReport]: saved,
      [CHANNELS.checkErrors]: errors,
    };
    electron.ipcRenderer.sendSync.mockImplementation((channel: string) =>
      Object.hasOwn(answers, channel) ? answers[channel] : true,
    );
    expect(shell.storage.write('main', '{"game":"bc-incremental"}')).toBe(written);
    expect(shell.storage.read('backup')).toBeNull();
    expect(shell.achievements.unlock('ACH_WIN_ONE_GAME')).toBe(true);
    expect(shell.achievements.isUnlocked('ACH_WIN_ONE_GAME')).toBe(true);
    const check = shell.check;
    if (check === undefined) throw new Error('no check in the check mode');
    expect(check.clearAchievement('ACH_WIN_ONE_GAME')).toBe(false);
    expect(check.openOverlay('friends')).toBeUndefined();
    expect(check.listSaves()).toBe(files);
    expect(check.showSaves()).toBeUndefined();
    expect(check.saveReport('report')).toBe(saved);
    expect(check.recentErrors()).toBe(errors);
    expect(electron.ipcRenderer.sendSync.mock.calls).toEqual([
      [CHANNELS.saveWrite, 'main', '{"game":"bc-incremental"}'],
      [CHANNELS.saveRead, 'backup'],
      [CHANNELS.achUnlock, 'ACH_WIN_ONE_GAME'],
      [CHANNELS.achIsUnlocked, 'ACH_WIN_ONE_GAME'],
      [CHANNELS.checkClear, 'ACH_WIN_ONE_GAME'],
      [CHANNELS.checkOverlay, 'friends'],
      [CHANNELS.checkSaves],
      [CHANNELS.checkShowSaves],
      [CHANNELS.checkReport, 'report'],
      [CHANNELS.checkErrors],
    ]);
  });

  it('gives the page no ipcRenderer, none of its methods and no listener', async () => {
    for (const checkMode of [false, true]) {
      const { bridge } = await load(checkMode);
      const ipc = Object.values(electron.ipcRenderer);
      for (const value of walk(bridge).values) {
        expect(value).not.toBe(electron.ipcRenderer);
        expect(value).not.toBe(electron.contextBridge);
        expect(ipc).not.toContain(value);
      }
      expect(electron.ipcRenderer.on).not.toHaveBeenCalled();
      expect(electron.ipcRenderer.once).not.toHaveBeenCalled();
      expect(electron.ipcRenderer.addListener).not.toHaveBeenCalled();
      expect(electron.ipcRenderer.send).not.toHaveBeenCalled();
      expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
    }
  });
});
