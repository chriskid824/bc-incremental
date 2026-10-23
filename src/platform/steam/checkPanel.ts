/**
 * The Steam check's panel (docs/v3 C9 design §2.2, C9/F13): an English dev panel in the top right
 * corner of the real game, outside i18n like viewer.html, shown only under `--steam-check`
 * (./index.ts mounts it). It holds what the runbook walks through: whether Steam started,
 * ACH_WIN_ONE_GAME's unlock and clear (each press logged with Steam's answer), the questions only
 * Hoshi's eyes can answer, the save files, and [Copy report] (./report.ts), which writes the report
 * to the clipboard, to `<userData>/steam-check/` through the shell, and to a read-only textarea.
 *
 * Its buttons never keep the keyboard focus (tabIndex -1, blurred after each click): if the overlay
 * misses Shift+Tab (macOS), focus would otherwise land on a button that a later Space presses
 * while starting a run. Every text goes in through textContent.
 *
 * It types the few DOM members it uses itself and finds the page through globalThis, because the
 * tools' tsconfig, which compiles ./index.ts through the tests, has no DOM (as pageLocalStorage
 * does).
 */

import type { CheckBridge, NativeBridge, SaveFileInfo, ShellInfo, SteamStatus } from './bridge';
import { buildReport } from './report';
import type {
  AchievementPress,
  AchievementState,
  Answer,
  CheckAnswers,
  OverlayAnswer,
} from './report';

/** src/env.d.ts' build id, declared again for the tools' tsconfig, which leaves that file out. */
declare const __BUILD_ID__: string;

/** Spacewar's "Winner", the achievement the check unlocks and clears (C9/F4). */
export const CHECK_ACHIEVEMENT = 'ACH_WIN_ONE_GAME';

/** What the panel calls: Steam's own achievements (never the page's local record) and the check's. */
export interface CheckPanelBridge {
  steamInfo(): ShellInfo;
  readonly achievements: NativeBridge['achievements'];
  readonly check: CheckBridge;
}

/** The part of a DOM element the panel uses. */
export interface PanelElement {
  textContent: string | null;
  hidden: boolean;
  tabIndex: number;
  readonly style: { cssText: string };
  setAttribute(name: string, value: string): void;
  append(...nodes: (PanelElement | string)[]): void;
  replaceChildren(...nodes: (PanelElement | string)[]): void;
  addEventListener(type: 'click', listener: () => void): void;
  blur(): void;
}

export interface PanelTextArea extends PanelElement {
  value: string;
  readOnly: boolean;
  rows: number;
}

export interface PanelDocument {
  createElement(tag: 'textarea'): PanelTextArea;
  createElement(tag: 'button' | 'div' | 'span'): PanelElement;
  readonly body: PanelElement;
}

/** The page the panel lives on; the tests pass their own. */
export interface PanelPage {
  readonly document: PanelDocument;
  /** navigator.clipboard, or null where there is none. */
  readonly clipboard: { writeText(text: string): Promise<void> } | null;
  readonly now: () => Date;
  /** __BUILD_ID__, for the report. */
  readonly build: string;
}

/** The panel's first line, as the runbook quotes it. */
export function steamLine(steam: SteamStatus): string {
  return steam.ok
    ? `Steam: connected (app ${steam.appId})`
    : `Steam: NOT connected (${steam.stage}): ${steam.error}`;
}

/** The yes-or-no questions, by their names in the report. */
const QUESTIONS: readonly (readonly ['hint_at_start' | 'unlock_popup' | 'shift_tab', string])[] = [
  ['hint_at_start', 'Steam hint (Shift+Tab) at start?'],
  ['unlock_popup', 'Unlock popup appeared?'],
  ['shift_tab', 'Shift+Tab opened the overlay?'],
];
const YES_NO: readonly (readonly [Answer, string])[] = [
  ['yes', 'Yes'],
  ['no', 'No'],
];
/** What [Open achievements overlay] showed. */
const OVERLAY_ANSWERS: readonly (readonly [OverlayAnswer, string])[] = [
  ['overlay', 'Overlay'],
  ['steam-window', 'Steam window'],
  ['nothing', 'Nothing'],
];

const PANEL_STYLE =
  'position:fixed;top:8px;right:8px;z-index:1000;width:360px;max-height:calc(100vh - 16px);' +
  'overflow:auto;box-sizing:border-box;padding:8px 10px;border:1px solid #3a4560;' +
  'border-radius:6px;background:rgba(14,17,26,0.94);color:#e8ecf6;pointer-events:auto;' +
  'font:12px/1.4 system-ui,sans-serif;user-select:text;';
const ROW_STYLE = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:3px 0;';
const HEADING_STYLE = 'margin:8px 0 2px;font-weight:700;color:#9fe8ff;';
const BUTTON_STYLE = 'font:inherit;padding:1px 6px;cursor:pointer;';
const MONO_STYLE = 'font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;';

/** Mounts the panel on `page`'s body. `info` is what the shell said when the page started. */
export function mountCheckPanel(
  bridge: CheckPanelBridge,
  info: ShellInfo,
  page: PanelPage = thisPage(),
): void {
  const doc = page.document;
  const make = (tag: 'button' | 'div' | 'span', text = '', check = '', style = '') => {
    const element = doc.createElement(tag);
    element.textContent = text;
    if (check !== '') element.setAttribute('data-check', check);
    if (style !== '') element.style.cssText = style;
    return element;
  };
  const button = (text: string, check: string, onClick: () => void): PanelElement => {
    const element = make('button', text, check, BUTTON_STYLE);
    element.tabIndex = -1;
    element.addEventListener('click', () => {
      try {
        onClick();
      } finally {
        element.blur();
      }
    });
    return element;
  };
  const row = (...nodes: (PanelElement | string)[]): PanelElement => {
    const element = make('div', '', '', ROW_STYLE);
    element.append(...nodes);
    return element;
  };
  const time = (): string => page.now().toISOString().slice(11, 19);

  // Steam's state and the achievement.
  const connected = info.steam.ok;
  const stateNow = (): AchievementState => {
    const unlocked = attempt(() => bridge.achievements.isUnlocked(CHECK_ACHIEVEMENT));
    if (!connected || unlocked === null) return 'unknown';
    return unlocked === true ? 'unlocked' : 'locked';
  };
  const before = stateNow();
  const presses: AchievementPress[] = [];
  const state = make('span', before, 'ach-state');
  const achLog = make('div', '', 'ach-log', MONO_STYLE);
  const record = (label: string, press: AchievementPress): void => {
    presses.push(press);
    state.textContent = press.now;
    const returned = press.action === 'recheck' ? '' : ` returned=${press.returned ? 'yes' : 'no'}`;
    const note = connected ? '' : ' (Steam not connected)';
    achLog.append(make('div', `${time()} ${label}${returned} now=${press.now}${note}`));
  };
  const press = (label: string, action: 'unlock' | 'clear', call: () => boolean): void => {
    const returned = attempt(call) === true;
    record(label, { action, returned, now: stateNow() });
  };

  // The questions.
  const answers: { -readonly [K in keyof CheckAnswers]: CheckAnswers[K] } = {};
  const question = <K extends keyof CheckAnswers>(
    key: K,
    text: string,
    choices: readonly (readonly [NonNullable<CheckAnswers[K]>, string])[],
  ): PanelElement => {
    const shown = make('span', 'unknown', key);
    const buttons = choices.map(([value, label]) =>
      button(label, `${key}=${value}`, () => {
        answers[key] = value;
        shown.textContent = value;
      }),
    );
    return row(text, ...buttons, shown);
  };

  // The save files.
  const files = make('div', '', 'save-files', MONO_STYLE);
  const listSaves = (): readonly SaveFileInfo[] => {
    const listed = attempt(() => bridge.check.listSaves());
    const list = Array.isArray(listed) ? listed : [];
    files.replaceChildren(
      ...(list.length === 0
        ? ['none']
        : list.map((file) => make('div', `${file.name} ${file.bytes} B ${file.modified}`))),
    );
    return list;
  };

  // The report.
  const status = make('div', '', 'report-status');
  const report = doc.createElement('textarea');
  report.setAttribute('data-check', 'report');
  report.readOnly = true;
  report.tabIndex = -1;
  report.rows = 14;
  report.style.cssText = `${MONO_STYLE}width:100%;box-sizing:border-box;font-size:11px;`;
  const copyReport = (): void => {
    const latest = attempt(() => bridge.steamInfo());
    const text = buildReport(
      typeof latest === 'object' && latest !== null ? latest : info,
      {
        before,
        presses,
        answers,
        saveFiles: listSaves(),
        errors: listOf(attempt(() => bridge.check.recentErrors())),
      },
      { when: page.now().toISOString(), build: page.build },
    );
    report.value = text;
    const saved = attempt(() => bridge.check.saveReport(text));
    const where =
      saved === null
        ? 'Not saved: the shell did not answer.'
        : saved.ok === true
          ? `Saved as ${saved.where}.`
          : `Not saved: ${saved.where}.`;
    status.textContent = `Copying… ${where}`;
    void copy(page.clipboard, text).then(
      () => {
        status.textContent = `Copied to the clipboard. ${where}`;
      },
      (error: unknown) => {
        status.textContent = `Clipboard failed: ${String(error)}. ${where}`;
      },
    );
  };

  const body = make('div', '', 'body');
  body.append(
    make('div', 'Achievement', '', HEADING_STYLE),
    row(`${CHECK_ACHIEVEMENT}:`, state),
    row(
      button('Unlock', 'unlock', () =>
        press('Unlock', 'unlock', () => bridge.achievements.unlock(CHECK_ACHIEVEMENT)),
      ),
      button('Clear', 'clear', () =>
        press('Clear', 'clear', () => bridge.check.clearAchievement(CHECK_ACHIEVEMENT)),
      ),
      button('Re-check', 'recheck', () =>
        record('Re-check', { action: 'recheck', now: stateNow() }),
      ),
    ),
    achLog,
    make('div', 'Questions', '', HEADING_STYLE),
    ...QUESTIONS.map(([key, text]) => question(key, text, YES_NO)),
    make('div', 'Overlay', '', HEADING_STYLE),
    row(
      button('Open achievements overlay', 'open-overlay', () =>
        attempt(() => bridge.check.openOverlay('achievements')),
      ),
    ),
    question('overlay_page', 'What appeared?', OVERLAY_ANSWERS),
    make('div', 'Saves', '', HEADING_STYLE),
    make('div', info.saveDir, 'save-dir', MONO_STYLE),
    files,
    row(
      button('Refresh', 'refresh', () => listSaves()),
      button('Show folder', 'show-folder', () => attempt(() => bridge.check.showSaves())),
    ),
    make('div', 'Report', '', HEADING_STYLE),
    row(button('Copy report', 'copy-report', copyReport)),
    status,
    report,
  );

  // The first line is Steam's state; clicking it folds the rest away and back.
  const mark = make('span', '▾');
  const header = button('', 'toggle', () => {
    body.hidden = !body.hidden;
    mark.textContent = body.hidden ? '▸' : '▾';
  });
  header.style.cssText = `${BUTTON_STYLE}width:100%;text-align:left;font-weight:700;`;
  header.append(mark, ' ', make('span', steamLine(info.steam), 'steam'));

  const panel = make('div', '', 'panel', PANEL_STYLE);
  panel.append(header, body);
  listSaves();
  page.document.body.append(panel);
}

/** A bridge call's answer, or null when it throws (the shell refused it, or the IPC failed). */
function attempt<T>(call: () => T): T | null {
  try {
    return call();
  } catch {
    return null;
  }
}

/** Writes `text` to the clipboard; a page without one, or a call that throws, rejects. */
function copy(clipboard: PanelPage['clipboard'], text: string): Promise<void> {
  try {
    if (clipboard === null) throw new Error('no clipboard on this page');
    return clipboard.writeText(text);
  } catch (error) {
    return Promise.reject(error);
  }
}

function listOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** The page this module runs on. */
function thisPage(): PanelPage {
  const navigator: unknown = Reflect.get(globalThis, 'navigator');
  const clipboard: unknown =
    typeof navigator === 'object' && navigator !== null
      ? Reflect.get(navigator, 'clipboard')
      : undefined;
  return {
    document: Reflect.get(globalThis, 'document') as PanelDocument,
    clipboard:
      typeof clipboard === 'object' && clipboard !== null
        ? (clipboard as NonNullable<PanelPage['clipboard']>)
        : null,
    now: () => new Date(),
    build: __BUILD_ID__,
  };
}
