/**
 * The Steam check's report (docs/v3 C9 design §2.2, C9/F13): what the check panel (./checkPanel.ts)
 * copies to the clipboard and saves, and what Hoshi pastes back after the session. Fixed-order
 * `key: value` lines, the first one naming the format. It never holds a Steam name or ID or an
 * absolute path: the save folder is the shell's shown path (`%APPDATA%\…`, `~/…`), and any absolute
 * path left in a value, such as one in Steam's error, is written as `<path>`. A question nobody
 * answered is `unknown`. Pure: the panel passes the time and the build.
 */

import type { SaveFileInfo, ShellInfo } from './bridge';

export const REPORT_TITLE = 'bc-incremental steam check v1';

/** An achievement's state as the panel read it: unknown while Steam is not connected. */
export type AchievementState = 'locked' | 'unlocked' | 'unknown';

/** One press of the panel's achievement buttons, with what Steam answered. */
export type AchievementPress =
  | {
      readonly action: 'unlock' | 'clear';
      readonly returned: boolean;
      readonly now: AchievementState;
    }
  | { readonly action: 'recheck'; readonly now: AchievementState };

export type Answer = 'yes' | 'no';
export type OverlayAnswer = 'overlay' | 'steam-window' | 'nothing';

/** The panel's questions, by their names in the report; one left out was never answered. */
export interface CheckAnswers {
  readonly hint_at_start?: Answer;
  readonly unlock_popup?: Answer;
  readonly shift_tab?: Answer;
  readonly overlay_page?: OverlayAnswer;
}

/** The answers line's order. */
export const ANSWER_KEYS = ['hint_at_start', 'unlock_popup', 'shift_tab', 'overlay_page'] as const;

/** What the panel recorded, and what it read from the shell for the report. */
export interface CheckLog {
  /** The achievement's state when the panel opened. */
  readonly before: AchievementState;
  readonly presses: readonly AchievementPress[];
  readonly answers: CheckAnswers;
  readonly saveFiles: readonly SaveFileInfo[];
  /** The main process's ring buffer of the page's errors, counted only (their text can hold paths). */
  readonly errors: readonly string[];
}

export interface ReportMeta {
  /** When the report was made, as an ISO time. */
  readonly when: string;
  /** __BUILD_ID__. */
  readonly build: string;
}

/**
 * An absolute path in a value: POSIX, a Windows drive, or UNC (`\\?\` included), from where it
 * starts. In quotes it runs to the closing quote, spaces and all; elsewhere to the end of the line,
 * a quote, `)`, `, ` or `: `, so a folder with a space in its name (`Application Support`, a user
 * name) is taken whole.
 */
const QUOTED_PATH = /(['"`])(?:\/|\\\\|[A-Za-z]:[\\/])[^'"`\r\n]*\1/g;
const BARE_PATH = /(^|[\s(=,:[])(?:\/|\\\\|[A-Za-z]:[\\/])(?:[^'"`)\r\n,:]|[,:](?! ))*/g;

/** `text` with every absolute path written as `<path>`, so that no folder or user name shows. */
export function redactPaths(text: string): string {
  return text.replace(QUOTED_PATH, '$1<path>$1').replace(BARE_PATH, '$1<path>');
}

export function buildReport(info: ShellInfo, log: CheckLog, meta: ReportMeta): string {
  const { steam, versions, os, autoCloud } = info;
  const files = log.saveFiles.map((file) => `${file.name} ${file.bytes} B ${file.modified}`);
  const presses = log.presses.map(
    (press) =>
      ` | ${press.action}${press.action === 'recheck' ? '' : ` returned=${yesNo(press.returned)}`}` +
      ` now=${press.now}`,
  );
  const answers = ANSWER_KEYS.map((key) => `${key}=${log.answers[key] ?? 'unknown'}`);
  const lines = [
    REPORT_TITLE,
    `when: ${meta.when}   build: ${meta.build}`,
    `os: ${os.platform} ${os.arch} ${os.release} translated=${yesNo(os.translated)}`,
    `versions: electron ${versions.electron} chrome ${versions.chrome} node ${versions.node} ` +
      `steamworks.js ${versions.steamworks ?? 'unknown'}`,
    steam.ok
      ? `steam: ok app=${steam.appId} language=${steam.language} deck=${yesNo(steam.steamDeck)} ` +
        `init_ms=${steam.initMs}`
      : // Quoted, so that a line break in Steam's error stays inside this line.
        `steam: not-connected stage=${steam.stage} error=${JSON.stringify(redactPaths(steam.error))}`,
    `overlay_switches: ${info.overlaySwitches.join(', ') || 'none'}`,
    `gpu: ${info.gpu || 'unknown'}`,
    `saves: ${redactPaths(info.saveDirShown)}   ` +
      `autocloud: ${autoCloud.root} ${autoCloud.subdirectory} ${autoCloud.pattern}`,
    `save_files: ${files.join('; ') || 'none'}`,
    `ach: before=${log.before}${presses.join('')}`,
    `answers: ${answers.join(' ')}`,
    `errors: ${log.errors.length}`,
  ];
  return `${lines.join('\n')}\n`;
}

function yesNo(value: boolean): Answer {
  return value ? 'yes' : 'no';
}
