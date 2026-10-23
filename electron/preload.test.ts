/**
 * The preload against a stand-in `electron` (C9/F1: a test never loads Electron itself). Each case
 * loads it afresh, with main answering bc:info in or out of the check mode, and inspects the one
 * object it hands contextBridge.
 */

import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_VERSION, NATIVE_BRIDGE_KEY } from '../src/platform/steam/bridge';
import type { NativeBridge } from '../src/platform/steam/bridge';
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

/** Main's answer on each channel: `answer:<channel>`, and a ShellInfo's checkMode on bc:info. */
function main(checkMode: boolean) {
  return (channel: string): unknown =>
    channel === CHANNELS.info ? { bridgeVersion: 1, checkMode } : `answer:${channel}`;
}

/** Loads the preload afresh and returns what it exposed, and what it sent while loading. */
async function load(checkMode: boolean) {
  vi.resetModules();
  vi.clearAllMocks();
  electron.ipcRenderer.sendSync.mockImplementation(main(checkMode));
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

/** Each function's channel and how many of its arguments it sends (NativeBridge's signatures). */
const SENDS: Record<string, readonly [string, number]> = {
  steamInfo: [CHANNELS.info, 0],
  'storage.read': [CHANNELS.saveRead, 1],
  'storage.write': [CHANNELS.saveWrite, 2],
  'achievements.unlock': [CHANNELS.achUnlock, 1],
  'achievements.isUnlocked': [CHANNELS.achIsUnlocked, 1],
};

describe('the preload', () => {
  it("exposes one frozen bridge under bcNative with exactly ARCH §11's minimal API", async () => {
    for (const checkMode of [false, true]) {
      const { key, bridge, loadCalls } = await load(checkMode);
      expect(key).toBe(NATIVE_BRIDGE_KEY);
      expect(key).toBe('bcNative');
      expect(Object.keys(bridge).sort()).toEqual([
        'achievements',
        'steamInfo',
        'storage',
        'version',
      ]);
      expect(Object.keys(bridge.storage as object).sort()).toEqual(['read', 'write']);
      expect(Object.keys(bridge.achievements as object).sort()).toEqual(['isUnlocked', 'unlock']);
      expect(bridge.version).toBe(BRIDGE_VERSION);
      expect(bridge.version).toBe(1);
      expect(Object.isFrozen(bridge)).toBe(true);
      expect(Object.isFrozen(bridge.storage)).toBe(true);
      expect(Object.isFrozen(bridge.achievements)).toBe(true);
      expect([...walk(bridge).functions.keys()].sort()).toEqual(Object.keys(SENDS).sort());
      // At most the design's one bc:info for the check mode (C9.2b's), and nothing else.
      expect(loadCalls.filter(([channel]) => channel !== CHANNELS.info)).toEqual([]);
      expect(loadCalls.length).toBeLessThanOrEqual(1);
      expect(electron.contextBridge.exposeInIsolatedWorld).not.toHaveBeenCalled();
    }
  });

  it('never exposes check, in or out of the check mode (C9.2b adds it)', async () => {
    for (const checkMode of [false, true]) {
      const { bridge } = await load(checkMode);
      expect('check' in bridge, String(checkMode)).toBe(false);
      expect(walk(bridge).functions.size).toBe(5);
    }
  });

  it('sends each call on its own channel with only its declared arguments', async () => {
    const { bridge } = await load(false);
    const { functions } = walk(bridge);
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
      expect(answer, name).toEqual(
        channel === CHANNELS.info ? main(false)(channel) : `answer:${channel}`,
      );
    }
  });

  it("returns main's answer as it came", async () => {
    const { bridge } = await load(false);
    const shell = bridge as unknown as NativeBridge;
    const written = { ok: false, error: 'bc:save:write failed' };
    electron.ipcRenderer.sendSync.mockImplementation((channel: string) =>
      channel === CHANNELS.saveWrite ? written : channel === CHANNELS.saveRead ? null : true,
    );
    expect(shell.storage.write('main', '{"game":"bc-incremental"}')).toBe(written);
    expect(shell.storage.read('backup')).toBeNull();
    expect(shell.achievements.unlock('ACH_WIN_ONE_GAME')).toBe(true);
    expect(shell.achievements.isUnlocked('ACH_WIN_ONE_GAME')).toBe(true);
    expect(electron.ipcRenderer.sendSync.mock.calls).toEqual([
      [CHANNELS.saveWrite, 'main', '{"game":"bc-incremental"}'],
      [CHANNELS.saveRead, 'backup'],
      [CHANNELS.achUnlock, 'ACH_WIN_ONE_GAME'],
      [CHANNELS.achIsUnlocked, 'ACH_WIN_ONE_GAME'],
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
