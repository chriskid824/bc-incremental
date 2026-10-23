/**
 * The Steam build's save slots as files, written by the main process (docs/v3 C9 design §1.4,
 * C9/F5): `<dir>/main.json` and `<dir>/backup.json`, `dir` being userData's `saves/` folder
 * (./paths.ts). These files never rotate on their own; the page's caller does. The M1 page
 * (src/app/main.ts' save()) copies main into backup, then writes main, and reads null for an
 * empty, missing or failed slot (BridgeSaveStorage.read). The v3 profile store
 * (src/app/profileStore.ts, which B1 wires) copies the last text it loaded or wrote into backup,
 * writes a restore from backup at open, and turns read-only for the session on a failed read. The
 * one writer is this process (the single-instance lock), and every call is synchronous.
 *
 * A read never throws and answers one of three (SaveReadResult): a missing file is a slot that
 * holds nothing (`text: null`, as at the first launch); a file is its text, a leading byte-order
 * mark taken off, so an empty file is the text ''; any other error is a failed read, with its
 * reason, logged once per slot and code. A failed read is never an empty slot, since a caller that
 * wrote over a file it could not read could lose the newest save.
 *
 * A write goes to `<slot>.json.tmp`, is flushed to disk, and replaces the slot's file by a rename,
 * so the file is always either the old save or the new one, never a torn mix; the temp never ends
 * in `.json`, so Auto-Cloud's `*.json` sees only the slots. A write that fails keeps the old file
 * and answers why; the page's next autosave tries again. On Windows an antivirus, indexer or cloud
 * client holding a file makes a read or a rename fail for a moment, so both are retried
 * (BUSY_RETRY_MS) before they fail.
 *
 * Also the check mode's reports (writeReport, design §2.2): each a new file of its own, never a
 * save, so it needs neither the temp nor the rename.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import type { CheckBridge, SaveFileInfo, SaveWriteResult } from '../src/platform/steam/bridge';
import type { SaveReadResult, SaveSlot } from '../src/platform/storage';

export interface SaveFiles {
  /**
   * The slot's text, a byte-order mark taken off ('' for an empty file); `text: null` when there
   * is no file; else a failed read. Never throws.
   */
  read(slot: SaveSlot): SaveReadResult;
  /** Replaces the slot's file as a whole, or keeps the old one and answers why. Never throws. */
  write(slot: SaveSlot, text: string): SaveWriteResult;
  /** The folder's `*.json` files, by name: what Auto-Cloud's pattern would sync. */
  list(): readonly SaveFileInfo[];
}

/** The node:fs calls the files use; the tests pass failing ones. */
export type FileOps = Pick<
  typeof fs,
  | 'closeSync'
  | 'fsyncSync'
  | 'mkdirSync'
  | 'openSync'
  | 'readFileSync'
  | 'readdirSync'
  | 'renameSync'
  | 'statSync'
  | 'unlinkSync'
  | 'writeSync'
>;

export interface SaveFilesDeps {
  readonly fs?: FileOps;
  /** Which OS's rules apply (the busy retries, the folder flush). */
  readonly platform?: NodeJS.Platform;
  /** Blocks for `ms`; the calls are synchronous, so the retries wait in place. */
  readonly sleep?: (ms: number) => void;
  /** Where the files say what went wrong; the terminal by default. */
  readonly log?: (line: string) => void;
}

export const SAVE_SLOTS: readonly SaveSlot[] = ['main', 'backup'];

export function isSaveSlot(slot: unknown): slot is SaveSlot {
  return slot === 'main' || slot === 'backup';
}

/** Appended to a slot's file name while it is written: `main.json.tmp`. */
export const TEMP_SUFFIX = '.tmp';

/** The waits before each retry of a read or a rename on Windows: five retries, 310 ms in all. */
export const BUSY_RETRY_MS: readonly number[] = [10, 20, 40, 80, 160];

/** The errors Windows gives while another program holds the file. */
const BUSY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** The files in `dir`, which opening creates; it also deletes the temps a crash left there. */
export function openSaveFiles(dir: string, deps: SaveFilesDeps = {}): SaveFiles {
  const ops = deps.fs ?? fs;
  const platform = deps.platform ?? process.platform;
  const sleep = deps.sleep ?? sleepSync;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const logged = new Set<string>();
  const logOnce = (key: string, line: string): void => {
    if (logged.has(key)) return;
    logged.add(key);
    log(line);
  };

  try {
    ops.mkdirSync(dir, { recursive: true });
    for (const name of ops.readdirSync(dir)) {
      if (!name.endsWith(`.json${TEMP_SUFFIX}`)) continue;
      try {
        ops.unlinkSync(join(dir, name));
      } catch (error) {
        log(`Could not delete the leftover ${name}: ${describe(error)}`);
      }
    }
  } catch (error) {
    // The writes will fail and say why; the game plays on.
    log(`Could not open the save folder ${dir}: ${describe(error)}`);
  }

  /** Writes `text` to `temp` and flushes it to disk before closing it. */
  const writeTemp = (temp: string, text: string): void => {
    const fd = ops.openSync(temp, 'w');
    let closed = false;
    try {
      writeAll(ops, fd, text, temp);
      ops.fsyncSync(fd);
      closed = true;
      ops.closeSync(fd);
    } finally {
      if (!closed) closeQuietly(ops, fd);
    }
  };

  /** `call`'s answer, retried on Windows while another program holds the file. */
  const whileBusy = <T>(call: () => T): T => {
    for (let retry = 0; ; retry += 1) {
      try {
        return call();
      } catch (error) {
        const wait =
          platform === 'win32' && BUSY_CODES.has(codeOf(error)) ? BUSY_RETRY_MS[retry] : undefined;
        if (wait === undefined) throw error;
        sleep(wait);
      }
    }
  };

  /** Flushes the folder's entry for the rename, where the OS can (best effort). */
  const syncFolder = (): void => {
    if (platform !== 'darwin' && platform !== 'linux') return;
    let fd: number | null = null;
    try {
      fd = ops.openSync(dir, 'r');
      ops.fsyncSync(fd);
    } catch {
      // The rename stands; the folder's entry reaches the disk a little later.
    } finally {
      if (fd !== null) closeQuietly(ops, fd);
    }
  };

  return {
    read(slot) {
      if (!isSaveSlot(slot)) return { ok: false, error: `no save slot ${JSON.stringify(slot)}` };
      const name = `${slot}.json`;
      let text: string;
      try {
        text = whileBusy(() => ops.readFileSync(join(dir, name), 'utf8'));
      } catch (error) {
        const code = codeOf(error);
        if (code === 'ENOENT') {
          logOnce(`${slot} ${code}`, `No ${name} yet.`);
          return { ok: true, text: null };
        }
        logOnce(`${slot} ${code}`, `Could not read ${name}: ${describe(error)}`);
        return { ok: false, error: describe(error) };
      }
      if (text.startsWith('\uFEFF')) text = text.slice(1);
      // '' too: the M1 page reads it as null, the v3 store as a save that does not load.
      if (text === '') logOnce(`${slot} empty`, `${name} is empty.`);
      return { ok: true, text };
    },

    write(slot, text) {
      if (!isSaveSlot(slot)) return { ok: false, error: `no save slot ${JSON.stringify(slot)}` };
      const file = join(dir, `${slot}.json`);
      const temp = `${file}${TEMP_SUFFIX}`;
      try {
        writeTemp(temp, text);
        whileBusy(() => ops.renameSync(temp, file));
      } catch (error) {
        try {
          ops.unlinkSync(temp);
        } catch {
          // Never written, or already gone.
        }
        return { ok: false, error: describe(error) };
      }
      syncFolder();
      return { ok: true };
    },

    list() {
      let names: string[];
      try {
        names = ops.readdirSync(dir);
      } catch {
        return [];
      }
      return names
        .filter((name) => name.endsWith('.json'))
        .sort()
        .flatMap((name) => {
          try {
            const stat = ops.statSync(join(dir, name));
            return stat.isFile()
              ? [{ name, bytes: stat.size, modified: stat.mtime.toISOString() }]
              : [];
          } catch {
            return [];
          }
        });
    },
  };
}

/** What CheckBridge.saveReport answers: the file written, or why there is none. */
export type ReportResult = ReturnType<CheckBridge['saveReport']>;

/** A report's file name: `report-<UTC time>.txt`, without ':' (Windows) and never `*.json`. */
export function reportFileName(time: Date): string {
  return `report-${time.toISOString().replaceAll(':', '-').replaceAll('.', '-')}.txt`;
}

/**
 * Writes `text` as a new file in `dir` (created if missing), named by `now`, and answers its path,
 * or why it could not (the half-written file removed). Never throws, and never replaces a file.
 */
export function writeReport(
  dir: string,
  text: string,
  deps: { readonly fs?: FileOps; readonly now?: () => Date } = {},
): ReportResult {
  const ops = deps.fs ?? fs;
  const file = join(dir, reportFileName((deps.now ?? (() => new Date()))()));
  let created = false;
  try {
    ops.mkdirSync(dir, { recursive: true });
    const fd = ops.openSync(file, 'wx');
    created = true;
    let closed = false;
    try {
      writeAll(ops, fd, text, file);
      closed = true;
      ops.closeSync(fd);
    } finally {
      if (!closed) closeQuietly(ops, fd);
    }
    return { ok: true, where: file };
  } catch (error) {
    // Only a file this call created is removed; 'wx' never opens another's.
    if (created) {
      try {
        ops.unlinkSync(file);
      } catch {
        // Already gone.
      }
    }
    return { ok: false, where: describe(error) };
  }
}

/** Writes all of `text` to `fd`, however few bytes each call takes. */
function writeAll(ops: FileOps, fd: number, text: string, name: string): void {
  const data = Buffer.from(text, 'utf8');
  for (let at = 0; at < data.length;) {
    const wrote = ops.writeSync(fd, data, at, data.length - at);
    if (wrote <= 0) throw new Error(`could not write ${name}`);
    at += wrote;
  }
}

function closeQuietly(ops: FileOps, fd: number): void {
  try {
    ops.closeSync(fd);
  } catch {
    // Already failing; the first error is the one reported.
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function codeOf(error: unknown): string {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : '';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
