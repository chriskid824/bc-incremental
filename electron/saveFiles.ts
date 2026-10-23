/**
 * The Steam build's save slots as files, written by the main process (docs/v3 C9 design §1.4,
 * C9/F5): `<dir>/main.json` and `<dir>/backup.json`, `dir` being userData's `saves/` folder
 * (./paths.ts). The page's caller rotates main into backup (src/app/main.ts' save()), so these
 * files never rotate on their own; the one writer is this process (the single-instance lock), and
 * every call is synchronous.
 *
 * A write goes to `<slot>.json.tmp`, is flushed to disk, and replaces the slot's file by a rename,
 * so the file is always either the old save or the new one, never a torn mix; the temp never ends
 * in `.json`, so Auto-Cloud's `*.json` sees only the slots. On Windows an antivirus, indexer or
 * cloud client holding the file makes the rename fail for a moment, so it is retried. A write that
 * fails keeps the old file and answers why; the page's next autosave tries again. A read never
 * throws: a missing, empty or unreadable file is null (logged once), which sends the page's loader
 * to the backup.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import type { SaveFileInfo, SaveWriteResult } from '../src/platform/steam/bridge';
import type { SaveSlot } from '../src/platform/storage';

export interface SaveFiles {
  /** The slot's text, a byte-order mark taken off, or null. Never throws. */
  read(slot: SaveSlot): string | null;
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
  /** Which OS's rules apply (the rename retries, the folder flush). */
  readonly platform?: NodeJS.Platform;
  /** Blocks for `ms`; the writes are synchronous, so the retries wait in place. */
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

/** The waits before each retry of a rename on Windows: five retries, 310 ms in all. */
export const RENAME_RETRY_MS: readonly number[] = [10, 20, 40, 80, 160];

/** The errors Windows gives while another program holds the file. */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

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
    const data = Buffer.from(text, 'utf8');
    const fd = ops.openSync(temp, 'w');
    let closed = false;
    try {
      for (let at = 0; at < data.length;) {
        const wrote = ops.writeSync(fd, data, at, data.length - at);
        if (wrote <= 0) throw new Error(`could not write ${temp}`);
        at += wrote;
      }
      ops.fsyncSync(fd);
      closed = true;
      ops.closeSync(fd);
    } finally {
      if (!closed) closeQuietly(ops, fd);
    }
  };

  /** Renames `from` over `to`, retrying on Windows while another program holds the file. */
  const rename = (from: string, to: string): void => {
    for (let retry = 0; ; retry += 1) {
      try {
        ops.renameSync(from, to);
        return;
      } catch (error) {
        const wait =
          platform === 'win32' && RENAME_RETRY_CODES.has(codeOf(error))
            ? RENAME_RETRY_MS[retry]
            : undefined;
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
      if (!isSaveSlot(slot)) return null;
      const name = `${slot}.json`;
      let text: string;
      try {
        text = ops.readFileSync(join(dir, name), 'utf8');
      } catch (error) {
        const code = codeOf(error);
        logOnce(
          `${slot} ${code}`,
          code === 'ENOENT' ? `No ${name} yet.` : `Could not read ${name}: ${describe(error)}`,
        );
        return null;
      }
      if (text.startsWith('\uFEFF')) text = text.slice(1);
      if (text === '') {
        logOnce(`${slot} empty`, `${name} is empty.`);
        return null;
      }
      return text;
    },

    write(slot, text) {
      if (!isSaveSlot(slot)) return { ok: false, error: `no save slot ${JSON.stringify(slot)}` };
      const file = join(dir, `${slot}.json`);
      const temp = `${file}${TEMP_SUFFIX}`;
      try {
        writeTemp(temp, text);
        rename(temp, file);
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
