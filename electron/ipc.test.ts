import { describe, expect, it, vi } from 'vitest';
import type { ShellInfo } from '../src/platform/steam/bridge';
import { CHANNELS } from './channels';
import type { Channel } from './channels';
import {
  MAX_SAVE_BYTES,
  RECENT_ERRORS,
  RecentErrors,
  createHandlers,
  isGamePage,
  isPageUrl,
  registerSync,
} from './ipc';
import type { HandlerDeps, SyncEvent, SyncIpc } from './ipc';

/** ipcMain as registerSync sees it: one listener per channel, called as Electron would. */
class FakeIpc implements SyncIpc {
  readonly listeners = new Map<string, (event: SyncEvent, ...args: unknown[]) => void>();

  on(channel: string, listener: (event: SyncEvent, ...args: unknown[]) => void): this {
    this.listeners.set(channel, listener);
    return this;
  }

  /** Sends like sendSync; the answer is whatever the listener left in returnValue. */
  send(channel: string, event: SyncEvent, ...args: unknown[]): unknown {
    const listener = this.listeners.get(channel);
    if (listener === undefined) throw new Error(`no listener on ${channel}`);
    listener(event, ...args);
    return event.returnValue;
  }
}

/** The game window's webContents, and another window's. */
const GAME = { id: 1 };
const OTHER = { id: 2 };
const PAGE = { webContents: GAME, dir: '/app/dist-steam' };
const PAGE_URL = 'file:///app/dist-steam/index.html';

const UNSET = Symbol('unset');

function event(sender: unknown, url: string | null, parent: unknown = null): SyncEvent {
  return { sender, senderFrame: url === null ? null : { url, parent }, returnValue: UNSET };
}

const INFO = { bridgeVersion: 1, checkMode: false } as ShellInfo;

function deps() {
  return {
    info: vi.fn(() => INFO),
    saves: {
      read: vi.fn((): string | null => 'progress'),
      write: vi.fn(() => ({ ok: true }) as const),
    },
    steam: { unlock: vi.fn(() => true), isUnlocked: vi.fn(() => true) },
  } satisfies HandlerDeps;
}

/** Every handler of createHandlers registered on a fake ipcMain, trusting only PAGE. */
function registered(given = deps()) {
  const ipc = new FakeIpc();
  const log = vi.fn((_line: string) => {});
  for (const [channel, { handle, fallback }] of Object.entries(createHandlers(given))) {
    registerSync(
      ipc,
      channel as Channel,
      handle,
      fallback,
      (e) => isGamePage(e, PAGE, 'linux'),
      log,
    );
  }
  const call = (channel: string, ...args: unknown[]): unknown =>
    ipc.send(channel, event(GAME, PAGE_URL), ...args);
  return { ipc, deps: given, log, call };
}

/** Each channel's fallback (§1.3): reads null, writes not-ok with an error, Steam false. */
const FALLBACKS: Readonly<Record<Channel, unknown>> = {
  [CHANNELS.info]: null,
  [CHANNELS.saveRead]: null,
  [CHANNELS.saveWrite]: { ok: false, error: 'bc:save:write failed' },
  [CHANNELS.achUnlock]: false,
  [CHANNELS.achIsUnlocked]: false,
};

describe('createHandlers', () => {
  it("answers §1.3's five channels and no check channel (C9.2b's)", () => {
    const handlers = createHandlers(deps());
    expect(Object.keys(handlers).sort()).toEqual(Object.values(CHANNELS).sort());
    expect(Object.keys(handlers).filter((channel) => channel.startsWith('bc:check:'))).toEqual([]);
    for (const [channel, { fallback }] of Object.entries(handlers)) {
      expect(fallback, channel).toEqual(FALLBACKS[channel as Channel]);
    }
  });

  it('passes valid calls through to the files, Steam and the shell info', () => {
    const { call, deps: given } = registered();
    expect(call(CHANNELS.info)).toBe(INFO);
    expect(call(CHANNELS.saveRead, 'main')).toBe('progress');
    expect(call(CHANNELS.saveRead, 'backup', 'extra')).toBe('progress');
    expect(given.saves.read.mock.calls).toEqual([['main'], ['backup']]);
    expect(call(CHANNELS.saveWrite, 'backup', '{"v":3}')).toEqual({ ok: true });
    expect(given.saves.write).toHaveBeenCalledWith('backup', '{"v":3}');
    expect(call(CHANNELS.achUnlock, 'ACH_WIN_ONE_GAME')).toBe(true);
    expect(call(CHANNELS.achIsUnlocked, 'ACH_WIN_ONE_GAME')).toBe(true);
    expect(given.steam.unlock).toHaveBeenCalledWith('ACH_WIN_ONE_GAME');
    expect(given.steam.isUnlocked).toHaveBeenCalledWith('ACH_WIN_ONE_GAME');
  });

  it('refuses a slot other than main and backup before the files see it', () => {
    const { call, deps: given } = registered();
    for (const slot of [
      '../main',
      '../../main',
      'main.json',
      'Main',
      '',
      'backup/../main',
      null,
      1,
    ]) {
      expect(call(CHANNELS.saveRead, slot), String(slot)).toBeNull();
      expect(call(CHANNELS.saveWrite, slot, 'x'), String(slot)).toEqual({
        ok: false,
        error: 'no such save slot',
      });
    }
    expect(given.saves.read).not.toHaveBeenCalled();
    expect(given.saves.write).not.toHaveBeenCalled();
  });

  it('writes only text of at most 8 MiB in UTF-8', () => {
    const { call, deps: given } = registered();
    for (const text of [42, null, undefined, { v: 3 }, ['x']]) {
      expect(call(CHANNELS.saveWrite, 'main', text), String(text)).toEqual({
        ok: false,
        error: 'the save is not text',
      });
    }
    expect(MAX_SAVE_BYTES).toBe(8 * 1024 * 1024);
    const over = { ok: false, error: 'the save is over 8 MiB' };
    expect(call(CHANNELS.saveWrite, 'main', 'x'.repeat(MAX_SAVE_BYTES + 1))).toEqual(over);
    // Fewer than 8 Mi characters, but two bytes each.
    expect(call(CHANNELS.saveWrite, 'main', 'é'.repeat(MAX_SAVE_BYTES / 2 + 1))).toEqual(over);
    expect(given.saves.write).not.toHaveBeenCalled();
    expect(call(CHANNELS.saveWrite, 'main', 'x'.repeat(MAX_SAVE_BYTES))).toEqual({ ok: true });
    expect(call(CHANNELS.saveWrite, 'main', 'é'.repeat(MAX_SAVE_BYTES / 2))).toEqual({ ok: true });
    expect(given.saves.write).toHaveBeenCalledTimes(2);
  });

  it('checks an achievement id before Steam sees it', () => {
    const { call, deps: given } = registered();
    for (const id of ['', 'ACH WIN', '../x', 'A'.repeat(65), 7, null]) {
      expect(call(CHANNELS.achUnlock, id), String(id)).toBe(false);
      expect(call(CHANNELS.achIsUnlocked, id), String(id)).toBe(false);
    }
    expect(given.steam.unlock).not.toHaveBeenCalled();
    expect(given.steam.isUnlocked).not.toHaveBeenCalled();
    given.steam.unlock.mockReturnValue(false);
    expect(call(CHANNELS.achUnlock, 'ACH_WIN_ONE_GAME')).toBe(false);
  });
});

describe('registerSync', () => {
  it("always sets the answer: the channel's fallback when the handler throws", () => {
    const thrown = (): never => {
      throw new Error('disk on fire');
    };
    const failing = deps();
    failing.info.mockImplementation(thrown);
    failing.saves.read.mockImplementation(thrown);
    failing.saves.write.mockImplementation(thrown);
    failing.steam.unlock.mockImplementation(thrown);
    failing.steam.isUnlocked.mockImplementation(thrown);
    const { call, log } = registered(failing);
    expect(call(CHANNELS.info)).toBeNull();
    expect(call(CHANNELS.saveRead, 'main')).toBeNull();
    expect(call(CHANNELS.saveWrite, 'main', 'x')).toEqual({
      ok: false,
      error: 'bc:save:write failed',
    });
    expect(call(CHANNELS.achUnlock, 'ACH_WIN_ONE_GAME')).toBe(false);
    expect(call(CHANNELS.achIsUnlocked, 'ACH_WIN_ONE_GAME')).toBe(false);
    expect(log).toHaveBeenCalledTimes(5);
    expect(log.mock.calls[0]?.[0]).toMatch(/^bc:info failed: Error: disk on fire/);
  });

  it('answers a refused sender with the fallback, without running the handler', () => {
    const { ipc, deps: given, log } = registered();
    const refused: readonly SyncEvent[] = [
      event(OTHER, PAGE_URL),
      event(null, PAGE_URL),
      event(GAME, PAGE_URL, { url: PAGE_URL }),
      event(GAME, null),
      event(GAME, 'https://example.com/index.html'),
      event(GAME, 'file:///app/index.html'),
    ];
    for (const sent of refused) {
      for (const channel of Object.values(CHANNELS)) {
        sent.returnValue = UNSET;
        const args = channel === CHANNELS.saveWrite ? ['main', 'x'] : ['main'];
        expect(ipc.send(channel, sent, ...args), channel).toEqual(FALLBACKS[channel]);
      }
    }
    expect(given.info).not.toHaveBeenCalled();
    expect(given.saves.read).not.toHaveBeenCalled();
    expect(given.saves.write).not.toHaveBeenCalled();
    expect(given.steam.unlock).not.toHaveBeenCalled();
    expect(given.steam.isUnlocked).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(`Refused bc:info from ${PAGE_URL}`);
    expect(log).toHaveBeenCalledWith('Refused bc:info from a closed frame');
  });

  it('answers with the fallback when the trust check itself throws', () => {
    const ipc = new FakeIpc();
    const handle = vi.fn(() => 'answer');
    registerSync(
      ipc,
      CHANNELS.saveRead,
      handle,
      null,
      () => {
        throw new Error('frame disposed');
      },
      () => {},
    );
    expect(ipc.send(CHANNELS.saveRead, event(GAME, PAGE_URL), 'main')).toBeNull();
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('isGamePage', () => {
  it("takes only the game window's main frame at a page under dist-steam/", () => {
    expect(isGamePage(event(GAME, PAGE_URL), PAGE, 'linux')).toBe(true);
    expect(isGamePage(event(GAME, `${PAGE_URL}?replay=renderStress`), PAGE, 'linux')).toBe(true);
    expect(isGamePage(event(GAME, `${PAGE_URL}#top`), PAGE, 'linux')).toBe(true);
    expect(isGamePage(event(OTHER, PAGE_URL), PAGE, 'linux'), 'another window').toBe(false);
    expect(isGamePage(event(GAME, PAGE_URL, { url: PAGE_URL }), PAGE, 'linux'), 'a subframe').toBe(
      false,
    );
    // A frame without the field is no main frame either (a default parameter would read it as null).
    const unknownParent = {
      ...event(GAME, PAGE_URL),
      senderFrame: { url: PAGE_URL, parent: undefined },
    };
    expect(isGamePage(unknownParent, PAGE, 'linux'), 'no parent field').toBe(false);
    expect(isGamePage(event(GAME, null), PAGE, 'linux'), 'a closed frame').toBe(false);
    // Before the window exists nothing is trusted, not even a sender of null.
    expect(isGamePage(event(null, PAGE_URL), { webContents: null, dir: PAGE.dir }, 'linux')).toBe(
      false,
    );
  });

  it('refuses every URL outside dist-steam/, however it is spelt', () => {
    for (const url of [
      'https://example.com/dist-steam/index.html',
      'http://localhost:5173/index.html',
      'devtools://devtools/bundled/devtools_app.html',
      'about:blank',
      'data:text/html,<p>x</p>',
      '',
      'not a url',
      'file:///app/index.html',
      'file:///app/dist/index.html',
      'file:///app/dist-steam',
      'file:///app/dist-steam/',
      'file:///app/dist-steam-other/index.html',
      'file:///app/dist-steamy/index.html',
      'file:///other/dist-steam/index.html',
      'file:///app/dist-steam/../index.html',
      'file:///app/dist-steam/%2E%2E/index.html',
      'file:///app/dist-steam/%2e%2e/%2e%2e/etc/passwd',
      'file:///app/dist-steam/a%2Fb.html',
      'file://evil.example/app/dist-steam/index.html',
    ]) {
      expect(isPageUrl(url, PAGE.dir, 'linux'), url).toBe(false);
    }
    expect(isPageUrl('file:///app/dist-steam/assets/x.html', PAGE.dir, 'linux')).toBe(true);
  });

  it("reads Windows file URLs by Windows' rules", () => {
    const dir = 'C:\\Users\\Hoshi\\bc-steam-check\\dist-steam';
    expect(
      isPageUrl('file:///C:/Users/Hoshi/bc-steam-check/dist-steam/index.html', dir, 'win32'),
    ).toBe(true);
    expect(
      isPageUrl('file:///c:/users/hoshi/bc-steam-check/dist-steam/index.html', dir, 'win32'),
    ).toBe(true);
    for (const url of [
      'file:///D:/Users/Hoshi/bc-steam-check/dist-steam/index.html',
      'file:///C:/Users/Hoshi/bc-steam-check/index.html',
      'file://server/share/dist-steam/index.html',
      'file:///C:/Users/Hoshi/bc-steam-check/dist-steam/..%5Cindex.html',
    ]) {
      expect(isPageUrl(url, dir, 'win32'), url).toBe(false);
    }
  });
});

describe('RecentErrors', () => {
  it('keeps the last 50 errors, oldest first, and echoes each as it comes', () => {
    const echo = vi.fn((_line: string) => {});
    const errors = new RecentErrors(echo);
    expect(RECENT_ERRORS).toBe(50);
    for (let i = 1; i <= 52; i += 1) errors.add(`error ${i}`);
    const list = errors.list();
    expect(list).toHaveLength(50);
    expect(list[0]).toBe('error 3');
    expect(list.at(-1)).toBe('error 52');
    expect(echo).toHaveBeenCalledTimes(52);
    expect(echo).toHaveBeenLastCalledWith('error 52');
    (list as string[]).length = 0;
    expect(errors.list()).toHaveLength(50);
  });
});
