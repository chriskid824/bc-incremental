/**
 * The main process's half of the bridge (docs/v3 C9 design §1.3): what each channel of
 * ./channels.ts answers (createHandlers, pure), how a channel is registered (registerSync), and
 * which sender may call it (isGamePage): only the game window's main frame showing a page from
 * dist-steam/. Every argument comes from the page, so each is checked before it reaches the files
 * or Steam. A sender that is refused, or a handler that throws, gets the channel's fallback; so
 * does every bc:check:* call outside the check mode (`--steam-check`, design §2.2), its handler
 * not run.
 *
 * Also the ring buffer of the renderer's recent errors, which main.ts fills and echoes to the
 * terminal; the check mode's report counts it.
 */

import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAchievementId } from '../src/platform/achievements';
import type { SaveWriteResult, ShellInfo } from '../src/platform/steam/bridge';
import { CHANNELS } from './channels';
import type { Channel } from './channels';
import { isSaveSlot } from './saveFiles';
import type { ReportResult, SaveFiles } from './saveFiles';
import { isOverlayDialog } from './steam';
import type { SteamSession } from './steam';

/** The largest save text a write takes, in UTF-8 bytes. */
export const MAX_SAVE_BYTES = 8 * 1024 * 1024;

/** The largest report the check mode saves, in UTF-8 bytes. */
export const MAX_REPORT_BYTES = 64 * 1024;

/** What the handlers answer from. */
export interface HandlerDeps {
  readonly info: () => ShellInfo;
  readonly saves: Pick<SaveFiles, 'read' | 'write' | 'list'>;
  readonly steam: Pick<SteamSession, 'unlock' | 'isUnlocked' | 'clear' | 'openOverlay'>;
  /** `--steam-check`: without it, every bc:check:* call gets its fallback. */
  readonly checkMode: boolean;
  /** Saves a report as `<userData>/steam-check/report-<stamp>.txt`. */
  readonly saveReport: (text: string) => ReportResult;
  /** Shows the save folder in the OS's file manager, at a file of main's choosing. */
  readonly showSaves: () => void;
  /** The ring buffer of the page's recent errors (a copy). */
  readonly recentErrors: () => readonly string[];
}

/** A channel's handler, and what the page gets instead when it is refused or throws. */
export interface SyncHandler {
  readonly handle: (...args: unknown[]) => unknown;
  readonly fallback: unknown;
}

/** A write's fallback names its channel, since the page logs the error it is given. */
const WRITE_FALLBACK: SaveWriteResult = Object.freeze({
  ok: false,
  error: `${CHANNELS.saveWrite} failed`,
});

/** The report's fallback likewise: the panel shows why the report was not saved. */
const REPORT_FALLBACK: ReportResult = Object.freeze({
  ok: false,
  where: `${CHANNELS.checkReport} failed`,
});

/** The lists' fallback. */
const NONE: readonly never[] = Object.freeze([]);

/**
 * Each channel's handler: reads and void calls fall back to null, writes to not-ok, Steam to
 * false, lists to an empty list. Outside the check mode a bc:check:* handler answers its fallback.
 */
export function createHandlers(deps: HandlerDeps): Readonly<Record<Channel, SyncHandler>> {
  const check = (handle: SyncHandler['handle'], fallback: unknown): SyncHandler => ({
    handle: deps.checkMode ? handle : () => fallback,
    fallback,
  });
  return {
    [CHANNELS.info]: { handle: () => deps.info(), fallback: null },
    [CHANNELS.saveRead]: {
      handle: (slot) => (isSaveSlot(slot) ? deps.saves.read(slot) : null),
      fallback: null,
    },
    [CHANNELS.saveWrite]: {
      handle: (slot, text) => writeSave(deps.saves, slot, text),
      fallback: WRITE_FALLBACK,
    },
    [CHANNELS.achUnlock]: {
      handle: (id) => isAchievementId(id) && deps.steam.unlock(id),
      fallback: false,
    },
    [CHANNELS.achIsUnlocked]: {
      handle: (id) => isAchievementId(id) && deps.steam.isUnlocked(id),
      fallback: false,
    },
    [CHANNELS.checkClear]: check((id) => isAchievementId(id) && deps.steam.clear(id), false),
    [CHANNELS.checkOverlay]: check((dialog) => {
      if (isOverlayDialog(dialog)) deps.steam.openOverlay(dialog);
      return null;
    }, null),
    [CHANNELS.checkSaves]: check(() => deps.saves.list(), NONE),
    // The page names no file: main shows the folder its own way.
    [CHANNELS.checkShowSaves]: check(() => {
      deps.showSaves();
      return null;
    }, null),
    [CHANNELS.checkReport]: check((text) => saveReport(deps, text), REPORT_FALLBACK),
    [CHANNELS.checkErrors]: check(() => deps.recentErrors(), NONE),
  };
}

function writeSave(saves: HandlerDeps['saves'], slot: unknown, text: unknown): SaveWriteResult {
  if (!isSaveSlot(slot)) return { ok: false, error: 'no such save slot' };
  if (typeof text !== 'string') return { ok: false, error: 'the save is not text' };
  // A string is at least as many UTF-8 bytes as UTF-16 units, so its length rules out most first.
  if (text.length > MAX_SAVE_BYTES || Buffer.byteLength(text, 'utf8') > MAX_SAVE_BYTES) {
    return { ok: false, error: 'the save is over 8 MiB' };
  }
  return saves.write(slot, text);
}

function saveReport(deps: HandlerDeps, text: unknown): ReportResult {
  if (typeof text !== 'string') return { ok: false, where: 'the report is not text' };
  if (text.length > MAX_REPORT_BYTES || Buffer.byteLength(text, 'utf8') > MAX_REPORT_BYTES) {
    return { ok: false, where: 'the report is over 64 KiB' };
  }
  return deps.saveReport(text);
}

/** The frame an IPC message came from: Electron's WebFrameMain, as far as it is read here. */
export interface SenderFrame {
  readonly url: string;
  /** Null for a main frame. */
  readonly parent: unknown;
}

/** The part of Electron's IpcMainEvent that registerSync reads and answers through. */
export interface SyncEvent {
  readonly sender: unknown;
  readonly senderFrame: SenderFrame | null;
  returnValue: unknown;
}

/** The part of Electron's ipcMain that registerSync uses. */
export interface SyncIpc {
  on(channel: string, listener: (event: SyncEvent, ...args: unknown[]) => void): unknown;
}

/**
 * Answers `channel`'s synchronous messages with `handler` when `isTrusted` takes the sender, and
 * with `fallback` otherwise, the handler not run, or when the handler throws. The answer is
 * always set: unset, the page's sendSync would wait forever.
 */
export function registerSync(
  ipc: SyncIpc,
  channel: Channel,
  handler: SyncHandler['handle'],
  fallback: unknown,
  isTrusted: (event: SyncEvent) => boolean,
  log: (line: string) => void = (line) => console.error(line),
): void {
  ipc.on(channel, (event, ...args) => {
    let answer = fallback;
    try {
      if (isTrusted(event)) answer = handler(...args);
      else log(`Refused ${channel} from ${event.senderFrame?.url ?? 'a closed frame'}`);
    } catch (error) {
      answer = fallback;
      log(`${channel} failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
    } finally {
      event.returnValue = answer;
    }
  });
}

/** The game window's page: its webContents (null until the window exists) and its folder. */
export interface GamePage {
  readonly webContents: unknown;
  /** `<appPath>/dist-steam`. */
  readonly dir: string;
}

/** Whether `event` comes from the game window's main frame, at a page under `page.dir`. */
export function isGamePage(
  event: SyncEvent,
  page: GamePage,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (page.webContents === null || event.sender !== page.webContents) return false;
  const frame = event.senderFrame;
  if (frame === null || frame.parent !== null) return false;
  return isPageUrl(frame.url, page.dir, platform);
}

/** Whether `url` is a `file:` URL of a file inside `dir`; its query does not matter. */
export function isPageUrl(
  url: string,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  let file: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    file = fileURLToPath(parsed, { windows: platform === 'win32' });
  } catch {
    return false;
  }
  const paths = platform === 'win32' ? win32 : posix;
  const rest = paths.relative(dir, file);
  return (
    rest !== '' && rest !== '..' && !rest.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rest)
  );
}

/** How many of the renderer's errors the ring buffer keeps. */
export const RECENT_ERRORS = 50;

/**
 * The main-process global under which main.ts exposes RecentErrors.list(), for the container
 * smoke (tools/electron/smoke.ts) to read through Playwright; no page can reach it.
 */
export const RECENT_ERRORS_GLOBAL = 'bcShellRecentErrors';

/**
 * The renderer's last errors, oldest first; each is echoed as it comes, JSON-quoted (as ./args.ts
 * quotes its lines), so that a page cannot write control sequences to the terminal.
 */
export class RecentErrors {
  private readonly lines: string[] = [];

  constructor(
    private readonly echo: (line: string) => void = (line) => console.error(line),
    private readonly limit: number = RECENT_ERRORS,
  ) {}

  add(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.shift();
    this.echo(JSON.stringify(line));
  }

  list(): readonly string[] {
    return [...this.lines];
  }
}
