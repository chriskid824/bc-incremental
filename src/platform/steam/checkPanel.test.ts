/**
 * The check panel on a stand-in DOM: the tests run in Node, with no DOM environment, so the few
 * members the panel uses are faked here. ESMOKE's run 2 (tools/electron/smoke.ts) shows the panel
 * in the real page.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaveFileInfo, ShellInfo } from './bridge';
import { CHECK_ACHIEVEMENT, mountCheckPanel, steamLine } from './checkPanel';
import type { CheckPanelBridge, PanelDocument, PanelElement, PanelPage } from './checkPanel';

/** src/env.d.ts' build id, which the tools' tsconfig leaves out. */
declare const __BUILD_ID__: string;

type Child = FakeElement | string;

/** An element as far as the panel uses one; text nodes are strings. */
class FakeElement implements PanelElement {
  readonly children: Child[] = [];
  readonly attributes = new Map<string, string>();
  readonly style = { cssText: '' };
  readonly listeners: (() => void)[] = [];
  hidden = false;
  tabIndex: number;
  blurs = 0;

  constructor(readonly tag: string) {
    // As a browser's: buttons and text fields are in the tab order, other elements not.
    this.tabIndex = tag === 'button' || tag === 'textarea' ? 0 : -1;
  }

  get textContent(): string {
    return this.children
      .map((child) => (typeof child === 'string' ? child : child.textContent))
      .join('');
  }

  set textContent(text: string | null) {
    this.children.splice(0, this.children.length, ...(text === null || text === '' ? [] : [text]));
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...nodes: (PanelElement | string)[]): void {
    this.children.push(...(nodes as Child[]));
  }

  replaceChildren(...nodes: (PanelElement | string)[]): void {
    this.children.splice(0, this.children.length, ...(nodes as Child[]));
  }

  addEventListener(_type: 'click', listener: () => void): void {
    this.listeners.push(listener);
  }

  blur(): void {
    this.blurs += 1;
  }

  click(): void {
    for (const listener of this.listeners) listener();
  }
}

class FakeTextArea extends FakeElement {
  value = '';
  readOnly = false;
  rows = 2;
}

class FakeDocument implements PanelDocument {
  readonly body = new FakeElement('body');

  createElement(tag: 'textarea'): FakeTextArea;
  createElement(tag: 'button' | 'div' | 'span'): FakeElement;
  createElement(tag: string): FakeElement {
    return tag === 'textarea' ? new FakeTextArea(tag) : new FakeElement(tag);
  }
}

/** Every element under `root`, `root` included. */
function elements(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (typeof child === 'string' ? [] : elements(child))),
  ];
}

const NOW = new Date('2026-10-30T09:15:42.123Z');
const BUILD = '0.0.1+e57606a';
const REPORT_FILE = 'C:\\Users\\Hoshi\\AppData\\Roaming\\bc-incremental\\steam-check\\r.txt';

const STEAM: ShellInfo = {
  bridgeVersion: 1,
  checkMode: true,
  steam: { ok: true, appId: 480, language: 'tchinese', steamDeck: false, initMs: 137 },
  overlaySwitches: ['in-process-gpu', 'disable-direct-composition'],
  saveDir: 'C:\\Users\\Hoshi\\AppData\\Roaming\\bc-incremental\\saves',
  saveDirShown: '%APPDATA%\\bc-incremental\\saves',
  autoCloud: { root: 'WinAppDataRoaming', subdirectory: 'bc-incremental/saves', pattern: '*.json' },
  versions: { app: '0.0.1', electron: '44.8.0', chrome: '1', node: '2', steamworks: '0.4.0' },
  os: { platform: 'win32', arch: 'x64', release: '10.0.22631', translated: false },
  gpu: 'gpu_compositing=enabled webgl=enabled',
};
const NO_STEAM: ShellInfo = {
  ...STEAM,
  steam: { ok: false, stage: 'init', error: 'Steam is not running' },
  overlaySwitches: [],
};

const SAVE_FILES: readonly SaveFileInfo[] = [
  { name: 'backup.json', bytes: 4790, modified: '2026-10-30T09:14:10.000Z' },
  { name: 'main.json', bytes: 4812, modified: '2026-10-30T09:15:20.000Z' },
];

/** The shell as the panel sees it: Steam's one achievement, the check's calls, all fakes. */
function fakeBridge(info: ShellInfo) {
  const steam = { unlocked: false };
  const bridge = {
    steamInfo: vi.fn(() => info),
    achievements: {
      unlock: vi.fn((_id: string) => {
        if (info.steam.ok) steam.unlocked = true;
        return info.steam.ok;
      }),
      isUnlocked: vi.fn((_id: string) => steam.unlocked),
    },
    check: {
      clearAchievement: vi.fn((_id: string) => {
        if (info.steam.ok) steam.unlocked = false;
        return info.steam.ok;
      }),
      openOverlay: vi.fn((_dialog: 'achievements' | 'friends') => {}),
      listSaves: vi.fn((): readonly SaveFileInfo[] => SAVE_FILES),
      showSaves: vi.fn(() => {}),
      saveReport: vi.fn((_text: string): { ok: boolean; where: string } => ({
        ok: true,
        where: REPORT_FILE,
      })),
      recentErrors: vi.fn((): readonly string[] => []),
    },
  } satisfies CheckPanelBridge;
  return bridge;
}

/** Mounts the panel for `info` on a fake page; `get` finds one element by its data-check. */
function mount(info: ShellInfo = STEAM, clipboard?: PanelPage['clipboard']) {
  const bridge = fakeBridge(info);
  const writeText = vi.fn(async (_text: string) => {});
  const document = new FakeDocument();
  const page: PanelPage = {
    document,
    clipboard: clipboard === undefined ? { writeText } : clipboard,
    now: () => NOW,
    build: BUILD,
  };
  mountCheckPanel(bridge, info, page);
  const [panel, ...more] = document.body.children;
  expect(more).toEqual([]);
  if (!(panel instanceof FakeElement)) throw new Error('no panel on the body');
  const get = (check: string): FakeElement => {
    const found = elements(panel).filter(
      (element) => element.attributes.get('data-check') === check,
    );
    expect(found, check).toHaveLength(1);
    return found[0] as FakeElement;
  };
  const report = get('report') as FakeTextArea;
  return { bridge, writeText, panel, get, report };
}

/** Lets the clipboard's promise settle. */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0));
}

/** The report's line starting `key: `. */
function line(report: string, key: string): string | undefined {
  return report.split('\n').find((text) => text.startsWith(`${key}: `));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mountCheckPanel', () => {
  it("shows the runbook's labels and buttons verbatim, and folds to its Steam line", () => {
    const { panel, get } = mount(STEAM);
    expect(get('steam').textContent).toBe('Steam: connected (app 480)');
    const buttons: Readonly<Record<string, string>> = {
      unlock: 'Unlock',
      clear: 'Clear',
      recheck: 'Re-check',
      'hint_at_start=yes': 'Yes',
      'hint_at_start=no': 'No',
      'unlock_popup=yes': 'Yes',
      'unlock_popup=no': 'No',
      'shift_tab=yes': 'Yes',
      'shift_tab=no': 'No',
      'open-overlay': 'Open achievements overlay',
      'overlay_page=overlay': 'Overlay',
      'overlay_page=steam-window': 'Steam window',
      'overlay_page=nothing': 'Nothing',
      refresh: 'Refresh',
      'show-folder': 'Show folder',
      'copy-report': 'Copy report',
    };
    for (const [check, label] of Object.entries(buttons)) {
      expect(get(check).tag, check).toBe('button');
      expect(get(check).textContent, check).toBe(label);
    }
    const text = panel.textContent;
    for (const label of [
      'ACH_WIN_ONE_GAME:',
      'Steam hint (Shift+Tab) at start?',
      'Unlock popup appeared?',
      'Shift+Tab opened the overlay?',
      'Saves',
    ]) {
      expect(text, label).toContain(label);
    }
    expect(CHECK_ACHIEVEMENT).toBe('ACH_WIN_ONE_GAME');
    expect(get('ach-state').textContent).toBe('locked');
    for (const key of ['hint_at_start', 'unlock_popup', 'shift_tab', 'overlay_page']) {
      expect(get(key).textContent, key).toBe('unknown');
    }
    // The panel shows the absolute save folder; only the report leaves it out.
    expect(get('save-dir').textContent).toBe(STEAM.saveDir);
    expect(get('save-files').textContent).toBe(
      'backup.json 4790 B 2026-10-30T09:14:10.000Zmain.json 4812 B 2026-10-30T09:15:20.000Z',
    );
    expect(get('panel').style.cssText).toContain('position:fixed;top:8px;right:8px;');
    get('toggle').click();
    expect(get('body').hidden).toBe(true);
    expect(get('toggle').textContent).toBe('▸ Steam: connected (app 480)');
    get('toggle').click();
    expect(get('body').hidden).toBe(false);
    expect(get('toggle').textContent).toBe('▾ Steam: connected (app 480)');
  });

  it('keeps no button in the tab order, and blurs each one after its click, even a failing one', () => {
    const { bridge, panel, report } = mount(STEAM);
    bridge.check.showSaves.mockImplementation(() => {
      throw new Error('refused');
    });
    const buttons = elements(panel).filter((element) => element.tag === 'button');
    expect(buttons).toHaveLength(17);
    for (const button of buttons) {
      const name = button.attributes.get('data-check');
      expect(button.tabIndex, name).toBe(-1);
      expect(() => button.click(), name).not.toThrow();
      expect(button.blurs, name).toBe(1);
    }
    expect(bridge.check.openOverlay.mock.calls).toEqual([['achievements']]);
    expect(bridge.check.showSaves.mock.calls).toEqual([[]]);
    expect(report.tag).toBe('textarea');
    expect(report.readOnly).toBe(true);
    expect(report.tabIndex).toBe(-1);
  });

  it("logs each press with Steam's answer and the state read back", () => {
    const { bridge, get } = mount(STEAM);
    get('unlock').click();
    expect(bridge.achievements.unlock).toHaveBeenCalledWith('ACH_WIN_ONE_GAME');
    expect(get('ach-state').textContent).toBe('unlocked');
    get('clear').click();
    expect(bridge.check.clearAchievement).toHaveBeenCalledWith('ACH_WIN_ONE_GAME');
    get('recheck').click();
    bridge.achievements.unlock.mockImplementationOnce(() => {
      throw new Error('IPC failed');
    });
    get('unlock').click();
    expect(get('ach-log').children.map((entry) => (entry as FakeElement).textContent)).toEqual([
      '09:15:42 Unlock returned=yes now=unlocked',
      '09:15:42 Clear returned=yes now=locked',
      '09:15:42 Re-check now=locked',
      '09:15:42 Unlock returned=no now=locked',
    ]);
  });

  it('says when Steam is not connected: its stage and error, and a note on each press', () => {
    const { get, report } = mount(NO_STEAM);
    expect(get('steam').textContent).toBe('Steam: NOT connected (init): Steam is not running');
    expect(steamLine({ ok: false, stage: 'load', error: 'x' })).toBe(
      'Steam: NOT connected (load): x',
    );
    expect(get('ach-state').textContent).toBe('unknown');
    get('unlock').click();
    expect(get('ach-log').textContent).toBe(
      '09:15:42 Unlock returned=no now=unknown (Steam not connected)',
    );
    get('copy-report').click();
    expect(line(report.value, 'ach')).toBe('ach: before=unknown | unlock returned=no now=unknown');
  });

  it("[Copy report] puts one report in the textarea, the shell's file and the clipboard", async () => {
    const { bridge, writeText, get, report } = mount(STEAM);
    get('hint_at_start=no').click();
    get('hint_at_start=yes').click();
    get('overlay_page=steam-window').click();
    expect(get('hint_at_start').textContent).toBe('yes');
    expect(get('overlay_page').textContent).toBe('steam-window');
    bridge.steamInfo.mockReturnValue({ ...STEAM, gpu: 'gpu_compositing=disabled' });
    bridge.check.recentErrors.mockReturnValue(['console error: a', 'console error: b']);
    get('copy-report').click();
    const text = report.value;
    expect(line(text, 'when')).toBe(`when: 2026-10-30T09:15:42.123Z   build: ${BUILD}`);
    // The shell's state when copied, the files listed again, the errors counted.
    expect(line(text, 'gpu')).toBe('gpu: gpu_compositing=disabled');
    expect(line(text, 'save_files')).toBe(
      'save_files: backup.json 4790 B 2026-10-30T09:14:10.000Z; main.json 4812 B 2026-10-30T09:15:20.000Z',
    );
    expect(line(text, 'answers')).toBe(
      'answers: hint_at_start=yes unlock_popup=unknown shift_tab=unknown overlay_page=steam-window',
    );
    expect(line(text, 'errors')).toBe('errors: 2');
    // The shown folder, never the absolute one the panel shows.
    expect(line(text, 'saves')).toBe(
      'saves: %APPDATA%\\bc-incremental\\saves   autocloud: WinAppDataRoaming bc-incremental/saves *.json',
    );
    expect(text).not.toContain(STEAM.saveDir);
    expect(bridge.check.saveReport.mock.calls).toEqual([[text]]);
    expect(writeText.mock.calls).toEqual([[text]]);
    expect(get('report-status').textContent).toBe(`Copying… Saved as ${REPORT_FILE}.`);
    await settle();
    expect(get('report-status').textContent).toBe(
      `Copied to the clipboard. Saved as ${REPORT_FILE}.`,
    );
  });

  it('reports a failed copy or save, and falls back to the first answers of a failing shell', async () => {
    const denied = { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) };
    const first = mount(STEAM, denied);
    first.bridge.check.saveReport.mockReturnValue({
      ok: false,
      where: 'the report is over 64 KiB',
    });
    first.get('copy-report').click();
    await settle();
    expect(first.get('report-status').textContent).toBe(
      'Clipboard failed: Error: denied. Not saved: the report is over 64 KiB.',
    );

    const second = mount(STEAM, null);
    const thrown = (): never => {
      throw new Error('IPC failed');
    };
    for (const call of [
      second.bridge.steamInfo,
      second.bridge.check.saveReport,
      second.bridge.check.listSaves,
      second.bridge.check.recentErrors,
    ]) {
      call.mockImplementation(thrown);
    }
    second.get('copy-report').click();
    await settle();
    expect(second.get('report-status').textContent).toBe(
      'Clipboard failed: Error: no clipboard on this page. Not saved: the shell did not answer.',
    );
    const text = second.report.value;
    expect(line(text, 'steam')).toBe('steam: ok app=480 language=tchinese deck=no init_ms=137');
    expect(line(text, 'save_files')).toBe('save_files: none');
    expect(line(text, 'errors')).toBe('errors: 0');
    expect(second.get('save-files').textContent).toBe('none');
  });

  it("mounts on the page's own document and clipboard by default, with the build's id", async () => {
    const document = new FakeDocument();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('document', document);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    mountCheckPanel(fakeBridge(STEAM), STEAM);
    const panel = document.body.children[0];
    if (!(panel instanceof FakeElement)) throw new Error('no panel on the body');
    elements(panel)
      .find((element) => element.attributes.get('data-check') === 'copy-report')
      ?.click();
    await settle();
    const when = line(String(writeText.mock.calls[0]?.[0]), 'when');
    expect(when).toMatch(/^when: \d{4}-\d\d-\d\dT[\d:.]+Z {3}build: /);
    expect(when?.endsWith(`build: ${__BUILD_ID__}`)).toBe(true);
  });
});
