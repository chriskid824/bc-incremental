import { describe, expect, it, vi } from 'vitest';
import type { SaveFileInfo, ShellInfo } from '../src/platform/steam/bridge';
import type { SaveReadResult } from '../src/platform/storage';
import { CHANNELS } from './channels';
import type { Channel } from './channels';
import {
  MAX_REPORT_BYTES,
  MAX_SAVE_BYTES,
  RECENT_ERRORS,
  RecentErrors,
  createHandlers,
  isGamePage,
  isPageUrl,
  registerSync,
} from './ipc';
import type { HandlerDeps, SyncEvent, SyncIpc } from './ipc';
import type { ReportResult } from './saveFiles';
import type { OverlayDialog } from './steam';

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

const INFO = { bridgeVersion: 2, checkMode: false } as ShellInfo;
const SAVE_FILES: readonly SaveFileInfo[] = [
  { name: 'main.json', bytes: 812, modified: '2026-10-23T09:00:00.000Z' },
];
const REPORT_FILE = '/home/hoshi/.config/bc-incremental/steam-check/report-x.txt';
const ERRORS: readonly string[] = ['console error: boom (file:///app/dist-steam/x.js:1)'];

/** The handlers' deps, all fakes; `checkMode` is the shell's `--steam-check`. */
function deps(checkMode = false) {
  return {
    info: vi.fn(() => INFO),
    saves: {
      read: vi.fn((): SaveReadResult => ({ ok: true, text: 'progress' })),
      write: vi.fn(() => ({ ok: true }) as const),
      list: vi.fn(() => SAVE_FILES),
    },
    steam: {
      unlock: vi.fn(() => true),
      isUnlocked: vi.fn(() => true),
      clear: vi.fn((_id: string) => true),
      openOverlay: vi.fn((_dialog: OverlayDialog) => {}),
    },
    checkMode,
    saveReport: vi.fn((_text: string): ReportResult => ({ ok: true, where: REPORT_FILE })),
    showSaves: vi.fn(() => {}),
    recentErrors: vi.fn(() => ERRORS),
  } satisfies HandlerDeps;
}

/** The deps a test's calls reached, by name. */
function reached(given: ReturnType<typeof deps>): string[] {
  const fakes = {
    info: given.info,
    'saves.read': given.saves.read,
    'saves.write': given.saves.write,
    'saves.list': given.saves.list,
    'steam.unlock': given.steam.unlock,
    'steam.isUnlocked': given.steam.isUnlocked,
    'steam.clear': given.steam.clear,
    'steam.openOverlay': given.steam.openOverlay,
    saveReport: given.saveReport,
    showSaves: given.showSaves,
    recentErrors: given.recentErrors,
  };
  return Object.entries(fakes)
    .filter(([, fake]) => fake.mock.calls.length > 0)
    .map(([name]) => name);
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

/**
 * Each channel's fallback (§1.3): the shell info and void calls null, a save's read and write
 * not-ok with an error (bridge version 2's read), Steam false, lists empty.
 */
const FALLBACKS: Readonly<Record<Channel, unknown>> = {
  [CHANNELS.info]: null,
  [CHANNELS.saveRead]: { ok: false, error: 'bc:save:read failed' },
  [CHANNELS.saveWrite]: { ok: false, error: 'bc:save:write failed' },
  [CHANNELS.achUnlock]: false,
  [CHANNELS.achIsUnlocked]: false,
  [CHANNELS.checkClear]: false,
  [CHANNELS.checkOverlay]: null,
  [CHANNELS.checkSaves]: [],
  [CHANNELS.checkShowSaves]: null,
  [CHANNELS.checkReport]: { ok: false, where: 'bc:check:report failed' },
  [CHANNELS.checkErrors]: [],
};

/** A valid call's arguments on each channel. */
const VALID_ARGS: Readonly<Record<Channel, readonly unknown[]>> = {
  [CHANNELS.info]: [],
  [CHANNELS.saveRead]: ['main'],
  [CHANNELS.saveWrite]: ['main', 'x'],
  [CHANNELS.achUnlock]: ['ACH_WIN_ONE_GAME'],
  [CHANNELS.achIsUnlocked]: ['ACH_WIN_ONE_GAME'],
  [CHANNELS.checkClear]: ['ACH_WIN_ONE_GAME'],
  [CHANNELS.checkOverlay]: ['achievements'],
  [CHANNELS.checkSaves]: [],
  [CHANNELS.checkShowSaves]: [],
  [CHANNELS.checkReport]: ['bc-incremental steam check v1\n'],
  [CHANNELS.checkErrors]: [],
};

const CHECK_CHANNELS = Object.values(CHANNELS).filter((channel) => channel.startsWith('bc:check:'));

describe('createHandlers', () => {
  it('answers every channel, the six bc:check:* ones included, each with its fallback', () => {
    const handlers = createHandlers(deps());
    expect(Object.keys(handlers).sort()).toEqual(Object.values(CHANNELS).sort());
    expect(CHECK_CHANNELS).toHaveLength(6);
    for (const [channel, { fallback }] of Object.entries(handlers)) {
      expect(fallback, channel).toEqual(FALLBACKS[channel as Channel]);
    }
  });

  it('passes valid calls through to the files, Steam and the shell info', () => {
    const { call, deps: given } = registered();
    expect(call(CHANNELS.info)).toBe(INFO);
    expect(call(CHANNELS.saveRead, 'main')).toEqual({ ok: true, text: 'progress' });
    expect(call(CHANNELS.saveRead, 'backup', 'extra')).toEqual({ ok: true, text: 'progress' });
    expect(given.saves.read.mock.calls).toEqual([['main'], ['backup']]);
    expect(call(CHANNELS.saveWrite, 'backup', '{"v":3}')).toEqual({ ok: true });
    expect(given.saves.write).toHaveBeenCalledWith('backup', '{"v":3}');
    expect(call(CHANNELS.achUnlock, 'ACH_WIN_ONE_GAME')).toBe(true);
    expect(call(CHANNELS.achIsUnlocked, 'ACH_WIN_ONE_GAME')).toBe(true);
    expect(given.steam.unlock).toHaveBeenCalledWith('ACH_WIN_ONE_GAME');
    expect(given.steam.isUnlocked).toHaveBeenCalledWith('ACH_WIN_ONE_GAME');
  });

  // Catches a read answer changed on its way: an empty file's '' or a failed read made null.
  it("passes each of the files' read answers through as it came", () => {
    const { call, deps: given } = registered();
    const answers: readonly SaveReadResult[] = [
      { ok: true, text: '{"v":2}' },
      { ok: true, text: '' },
      { ok: true, text: null },
      { ok: false, error: "EBUSY: resource busy or locked, open 'main.json'" },
    ];
    for (const answer of answers) {
      given.saves.read.mockReturnValueOnce(answer);
      expect(call(CHANNELS.saveRead, 'main'), JSON.stringify(answer)).toBe(answer);
    }
    expect(given.saves.read).toHaveBeenCalledTimes(answers.length);
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
      expect(call(CHANNELS.saveRead, slot), String(slot)).toEqual({
        ok: false,
        error: 'no such save slot',
      });
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

  it('answers every bc:check:* call outside the check mode with its fallback, its handler not run', () => {
    const { call, deps: given } = registered(deps(false));
    for (const channel of CHECK_CHANNELS) {
      expect(call(channel, ...VALID_ARGS[channel]), channel).toEqual(FALLBACKS[channel]);
    }
    expect(reached(given)).toEqual([]);
    // The rest of the bridge answers as ever.
    expect(call(CHANNELS.achUnlock, 'ACH_WIN_ONE_GAME')).toBe(true);
  });

  it("passes the check mode's calls through to Steam, the files and the shell", () => {
    const { call, deps: given } = registered(deps(true));
    expect(call(CHANNELS.checkClear, 'ACH_WIN_ONE_GAME')).toBe(true);
    expect(given.steam.clear).toHaveBeenCalledWith('ACH_WIN_ONE_GAME');
    given.steam.clear.mockReturnValue(false);
    expect(call(CHANNELS.checkClear, 'ACH_WIN_ONE_GAME')).toBe(false);
    expect(call(CHANNELS.checkOverlay, 'achievements')).toBeNull();
    expect(call(CHANNELS.checkOverlay, 'friends', 'extra')).toBeNull();
    expect(given.steam.openOverlay.mock.calls).toEqual([['achievements'], ['friends']]);
    expect(call(CHANNELS.checkSaves)).toBe(SAVE_FILES);
    // The page names no file to show: whatever it sends is dropped.
    expect(call(CHANNELS.checkShowSaves, '/etc/passwd')).toBeNull();
    expect(given.showSaves.mock.calls).toEqual([[]]);
    const report = VALID_ARGS[CHANNELS.checkReport][0];
    expect(call(CHANNELS.checkReport, report)).toEqual({ ok: true, where: REPORT_FILE });
    // Nor does it name the report's file: main names it by the time, in steam-check/.
    expect(call(CHANNELS.checkReport, report, '../saves/main.json')).toEqual({
      ok: true,
      where: REPORT_FILE,
    });
    expect(given.saveReport.mock.calls).toEqual([[report], [report]]);
    expect(call(CHANNELS.checkErrors)).toBe(ERRORS);
  });

  it("checks the achievement id and the overlay's dialog before Steam sees them", () => {
    const { call, deps: given } = registered(deps(true));
    for (const id of ['', 'ACH WIN', '../x', 'A'.repeat(65), 7, null]) {
      expect(call(CHANNELS.checkClear, id), String(id)).toBe(false);
    }
    for (const dialog of [
      'Achievements',
      'achievements ',
      'players',
      'toString',
      '__proto__',
      'hasOwnProperty',
      '',
      2,
      null,
      undefined,
      ['achievements'],
      { dialog: 'achievements' },
    ]) {
      expect(call(CHANNELS.checkOverlay, dialog), String(dialog)).toBeNull();
    }
    expect(given.steam.clear).not.toHaveBeenCalled();
    expect(given.steam.openOverlay).not.toHaveBeenCalled();
  });

  it('saves only a report that is text of at most 64 KiB in UTF-8', () => {
    const { call, deps: given } = registered(deps(true));
    for (const text of [42, null, undefined, { text: 'x' }, ['x']]) {
      expect(call(CHANNELS.checkReport, text), String(text)).toEqual({
        ok: false,
        where: 'the report is not text',
      });
    }
    expect(MAX_REPORT_BYTES).toBe(64 * 1024);
    const over = { ok: false, where: 'the report is over 64 KiB' };
    expect(call(CHANNELS.checkReport, 'x'.repeat(MAX_REPORT_BYTES + 1))).toEqual(over);
    // Fewer than 64 Ki characters, but three bytes each.
    const wide = '進'.repeat(Math.floor(MAX_REPORT_BYTES / 3) + 1);
    expect(wide.length).toBeLessThan(MAX_REPORT_BYTES);
    expect(call(CHANNELS.checkReport, wide)).toEqual(over);
    expect(given.saveReport).not.toHaveBeenCalled();
    expect(call(CHANNELS.checkReport, 'x'.repeat(MAX_REPORT_BYTES))).toEqual({
      ok: true,
      where: REPORT_FILE,
    });
    expect(call(CHANNELS.checkReport, 'é'.repeat(MAX_REPORT_BYTES / 2))).toEqual({
      ok: true,
      where: REPORT_FILE,
    });
    expect(given.saveReport).toHaveBeenCalledTimes(2);
  });
});

describe('registerSync', () => {
  it("always sets the answer: the channel's fallback when the handler throws", () => {
    const thrown = (): never => {
      throw new Error('disk on fire');
    };
    const failing = deps(true);
    failing.info.mockImplementation(thrown);
    failing.saves.read.mockImplementation(thrown);
    failing.saves.write.mockImplementation(thrown);
    failing.saves.list.mockImplementation(thrown);
    failing.steam.unlock.mockImplementation(thrown);
    failing.steam.isUnlocked.mockImplementation(thrown);
    failing.steam.clear.mockImplementation(thrown);
    failing.steam.openOverlay.mockImplementation(thrown);
    failing.saveReport.mockImplementation(thrown);
    failing.showSaves.mockImplementation(thrown);
    failing.recentErrors.mockImplementation(thrown);
    const { call, log } = registered(failing);
    expect(call(CHANNELS.info)).toBeNull();
    expect(call(CHANNELS.saveRead, 'main')).toEqual({ ok: false, error: 'bc:save:read failed' });
    expect(call(CHANNELS.saveWrite, 'main', 'x')).toEqual({
      ok: false,
      error: 'bc:save:write failed',
    });
    expect(call(CHANNELS.achUnlock, 'ACH_WIN_ONE_GAME')).toBe(false);
    expect(call(CHANNELS.achIsUnlocked, 'ACH_WIN_ONE_GAME')).toBe(false);
    for (const channel of CHECK_CHANNELS) {
      expect(call(channel, ...VALID_ARGS[channel]), channel).toEqual(FALLBACKS[channel]);
    }
    expect(reached(failing)).toHaveLength(11);
    expect(log).toHaveBeenCalledTimes(11);
    expect(log.mock.calls[0]?.[0]).toMatch(/^bc:info failed: Error: disk on fire/);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/^bc:check:errors failed: Error: disk on fire/);
  });

  it('answers a refused sender with the fallback, without running the handler', () => {
    // In the check mode, so that the bc:check:* channels' answers come from the refusal.
    const { ipc, deps: given, log } = registered(deps(true));
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
        expect(ipc.send(channel, sent, ...VALID_ARGS[channel]), channel).toEqual(
          FALLBACKS[channel],
        );
      }
    }
    expect(reached(given)).toEqual([]);
    expect(log).toHaveBeenCalledWith(`Refused bc:info from ${PAGE_URL}`);
    expect(log).toHaveBeenCalledWith(`Refused bc:check:report from ${PAGE_URL}`);
    expect(log).toHaveBeenCalledWith('Refused bc:info from a closed frame');
  });

  // Catches a fallback read as an empty slot ({ ok: true, text: null }) or as version 1's null:
  // the page would take a file it never read for an empty slot and write over it.
  it('answers a refused sender and a throwing read with a failed read, never an empty slot', () => {
    const failing = deps();
    failing.saves.read.mockImplementation(() => {
      throw new Error('disk on fire');
    });
    const { call } = registered(failing);
    const { ipc } = registered();
    for (const answer of [
      call(CHANNELS.saveRead, 'main'),
      ipc.send(CHANNELS.saveRead, event(OTHER, PAGE_URL), 'main'),
      ipc.send(CHANNELS.saveRead, event(GAME, 'https://example.com/index.html'), 'backup'),
    ]) {
      expect(answer).toEqual({ ok: false, error: 'bc:save:read failed' });
    }
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
    expect(echo).toHaveBeenLastCalledWith('"error 52"');
    (list as string[]).length = 0;
    expect(errors.list()).toHaveLength(50);
  });

  it('echoes each error JSON-quoted, so that a page writes no control sequence to the terminal', () => {
    const echo = vi.fn((_line: string) => {});
    const errors = new RecentErrors(echo);
    const line = 'console error: \u001b[2J\u001b]0;title\u0007 "x"\r\n[renderer] fake';
    errors.add(line);
    expect(echo).toHaveBeenCalledWith(
      '"console error: \\u001b[2J\\u001b]0;title\\u0007 \\"x\\"\\r\\n[renderer] fake"',
    );
    const echoed = String(echo.mock.calls[0]?.[0]);
    expect([...echoed].filter((char) => char < ' ')).toEqual([]);
    // The buffer keeps the text as it came; only the terminal gets it quoted.
    expect(errors.list()).toEqual([line]);
  });
});
