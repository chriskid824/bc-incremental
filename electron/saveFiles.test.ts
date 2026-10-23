import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUSY_RETRY_MS,
  SAVE_SLOTS,
  TEMP_SUFFIX,
  openSaveFiles,
  reportFileName,
  writeReport,
} from './saveFiles';
import type { FileOps, SaveFilesDeps } from './saveFiles';

let root: string;
/** The save folder of each test, which openSaveFiles creates. */
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'bc-saves-'));
  dir = join(root, 'saves');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A node:fs error with its code, as the real calls throw them. */
function fsError(code: string, call: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: failed, ${call}`), { code });
}

/** The folder's file names. */
function names(): string[] {
  return fs.readdirSync(dir).sort();
}

function text(name: string): string {
  return fs.readFileSync(join(dir, name), 'utf8');
}

/** The names Steam's Auto-Cloud pattern `*.json` matches. */
function autoCloudSees(list: readonly string[]): string[] {
  return list.filter((name) => /^[^/\\]*\.json$/.test(name));
}

/** Real file calls, each logged by the file's name (`open main.json.tmp w`, `fsync saves`). */
function loggedFs(overrides: Partial<FileOps> = {}) {
  const calls: string[] = [];
  const opened = new Map<number, string>();
  const ops: FileOps = {
    ...fs,
    openSync: ((path: string, flags: string) => {
      const fd = fs.openSync(path, flags);
      opened.set(fd, basename(path));
      calls.push(`open ${basename(path)} ${flags}`);
      return fd;
    }) as FileOps['openSync'],
    writeSync: ((fd: number, data: Buffer, offset: number, length: number) => {
      calls.push(`write ${opened.get(fd)}`);
      return fs.writeSync(fd, data, offset, length);
    }) as FileOps['writeSync'],
    fsyncSync: (fd) => {
      calls.push(`fsync ${opened.get(fd)}`);
      fs.fsyncSync(fd);
    },
    closeSync: (fd) => {
      calls.push(`close ${opened.get(fd)}`);
      fs.closeSync(fd);
    },
    renameSync: (from, to) => {
      calls.push(`rename ${basename(String(from))} ${basename(String(to))}`);
      fs.renameSync(from, to);
    },
    ...overrides,
  };
  return { ops, calls };
}

/** A rename that fails `times` times with `code`, then renames. */
function failingRename(code: string, times: number): FileOps['renameSync'] {
  let left = times;
  return (from, to) => {
    if (left > 0) {
      left -= 1;
      throw fsError(code, 'rename');
    }
    fs.renameSync(from, to);
  };
}

/** A read of `name` that fails `times` times with `code`, then reads; other files read as ever. */
function failingRead(code: string, times: number, name = 'main.json'): FileOps['readFileSync'] {
  let left = times;
  return ((path: string, options: BufferEncoding) => {
    if (basename(path) === name && left > 0) {
      left -= 1;
      throw fsError(code, `open '${name}'`);
    }
    return fs.readFileSync(path, options);
  }) as FileOps['readFileSync'];
}

/**
 * A write that takes nothing (answers 0) on its first call and writes on later ones: a writer that
 * tried again would succeed and one that stopped would keep a short file, so neither passes, and
 * neither loops forever as it would on a write that always answers 0.
 */
function writesNothingFirst(): FileOps['writeSync'] {
  let first = true;
  return ((fd: number, data: Buffer, offset: number, length: number) => {
    if (first) {
      first = false;
      return 0;
    }
    return fs.writeSync(fd, data, offset, length);
  }) as FileOps['writeSync'];
}

function open(deps: SaveFilesDeps = {}) {
  const log = vi.fn((_line: string) => {});
  const sleep = vi.fn((_ms: number) => {});
  const files = openSaveFiles(dir, { platform: 'linux', log, sleep, ...deps });
  return { files, log, sleep };
}

describe('openSaveFiles', () => {
  it('creates the folder, and a slot reads back exactly what was written', () => {
    const { files } = open();
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    const save = `{"v":3,"game":"bc-incremental","data":{"name":"成就 ✓"}}\r\n  `;
    expect(files.write('main', save)).toEqual({ ok: true });
    expect(files.read('main')).toEqual({ ok: true, text: save });
    expect(text('main.json')).toBe(save);
    const large = 'x'.repeat(3 * 1024 * 1024);
    expect(files.write('backup', large)).toEqual({ ok: true });
    expect(files.read('backup')).toEqual({ ok: true, text: large });
    expect(names()).toEqual(['backup.json', 'main.json']);
  });

  // Catches a failed read answered as an empty slot (the lead's ruling SR3), and ENOENT as failed.
  it('reads a missing file as empty, and fails a read of a directory or a denied file, never throwing', () => {
    const { files, log } = open();
    expect(files.read('main')).toEqual({ ok: true, text: null });
    fs.mkdirSync(join(dir, 'main.json'));
    expect(() => files.read('main')).not.toThrow();
    expect(files.read('main')).toEqual({
      ok: false,
      error: 'EISDIR: illegal operation on a directory, read',
    });
    const denied = open({ fs: { ...fs, readFileSync: failingRead('EACCES', Infinity) } });
    expect(denied.files.read('main')).toEqual({
      ok: false,
      error: "EACCES: failed, open 'main.json'",
    });
    expect(denied.log).toHaveBeenCalledWith(
      "Could not read main.json: EACCES: failed, open 'main.json'",
    );
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'No main.json yet.',
      'Could not read main.json: EISDIR: illegal operation on a directory, read',
    ]);
  });

  // Catches '' or a lone byte-order mark read as an empty slot, and a mark left in the text.
  it("reads an empty file and a byte-order mark alone as the text ''", () => {
    const { files, log } = open();
    fs.writeFileSync(join(dir, 'main.json'), '');
    fs.writeFileSync(join(dir, 'backup.json'), '\uFEFF');
    expect(files.read('main')).toEqual({ ok: true, text: '' });
    expect(files.read('backup')).toEqual({ ok: true, text: '' });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'main.json is empty.',
      'backup.json is empty.',
    ]);
  });

  it('logs each kind of unreadable slot once per slot and code, however often it is read', () => {
    const { files, log } = open();
    for (let i = 0; i < 3; i += 1) {
      files.read('main');
      files.read('backup');
    }
    fs.writeFileSync(join(dir, 'backup.json'), '');
    const denied = open({ fs: { ...fs, readFileSync: failingRead('EACCES', Infinity) } });
    for (let i = 0; i < 3; i += 1) {
      files.read('backup');
      denied.files.read('main');
      denied.files.read('backup');
    }
    fs.mkdirSync(join(dir, 'main.json'));
    for (let i = 0; i < 3; i += 1) files.read('main');
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'No main.json yet.',
      'No backup.json yet.',
      'backup.json is empty.',
      'Could not read main.json: EISDIR: illegal operation on a directory, read',
    ]);
    expect(denied.log.mock.calls.map(([line]) => line)).toEqual([
      "Could not read main.json: EACCES: failed, open 'main.json'",
      'backup.json is empty.',
    ]);
  });

  it('takes a byte-order mark off the start, and only there', () => {
    const { files } = open();
    fs.writeFileSync(join(dir, 'main.json'), '\uFEFF{"v":3}');
    expect(files.read('main')).toEqual({ ok: true, text: '{"v":3}' });
    fs.writeFileSync(join(dir, 'main.json'), '{"v":3,"a":"\uFEFF"}');
    expect(files.read('main')).toEqual({ ok: true, text: '{"v":3,"a":"\uFEFF"}' });
  });

  // Catches a read that fails at once on Windows while an antivirus or a cloud client holds it.
  it('retries a read Windows refuses while another program holds the file, five times', () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, 'main.json'), 'progress');
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      for (const times of [1, 2, 5]) {
        const { files, sleep, log } = open({
          platform: 'win32',
          fs: { ...fs, readFileSync: failingRead(code, times) },
        });
        expect(files.read('main'), `${code} ×${times}`).toEqual({ ok: true, text: 'progress' });
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(BUSY_RETRY_MS.slice(0, times));
        expect(log).not.toHaveBeenCalled();
      }
      const { files, sleep, log } = open({
        platform: 'win32',
        fs: { ...fs, readFileSync: failingRead(code, 6) },
      });
      expect(files.read('main'), code).toEqual({
        ok: false,
        error: `${code}: failed, open 'main.json'`,
      });
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20, 40, 80, 160]);
      expect(log.mock.calls).toEqual([
        [`Could not read main.json: ${code}: failed, open 'main.json'`],
      ]);
    }
    expect(BUSY_RETRY_MS).toEqual([10, 20, 40, 80, 160]);
  });

  // Catches the retry on every OS, and a missing file or a directory retried on Windows.
  it('retries no read elsewhere, nor a missing file or a directory on Windows', () => {
    for (const [code, platform] of [
      ['EACCES', 'linux'],
      ['EACCES', 'darwin'],
      ['EBUSY', 'linux'],
      ['EPERM', 'darwin'],
    ] as const) {
      const { files, sleep } = open({
        platform,
        fs: { ...fs, readFileSync: failingRead(code, 1) },
      });
      expect(files.read('main'), `${code} on ${platform}`).toEqual({
        ok: false,
        error: `${code}: failed, open 'main.json'`,
      });
      expect(sleep).not.toHaveBeenCalled();
    }
    const { files, sleep } = open({ platform: 'win32' });
    expect(files.read('main')).toEqual({ ok: true, text: null });
    fs.mkdirSync(join(dir, 'main.json'));
    expect(files.read('main')).toEqual({
      ok: false,
      error: 'EISDIR: illegal operation on a directory, read',
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  // Catches another error read as an empty slot, which the store would write over, or a throw let
  // through: only a missing file holds nothing, and the read never throws (the lead's ruling SR3),
  // whether a folder on the path is a file (ENOTDIR), too many files are open (EMFILE), the disk
  // fails (EIO), the error has no code or the throw is not an Error.
  it('fails a read on every error but a missing file, on every OS, never as an empty slot', () => {
    const throws: readonly (readonly [unknown, string])[] = [
      [fsError('ENOTDIR', "open 'main.json'"), "ENOTDIR: failed, open 'main.json'"],
      [fsError('EMFILE', "open 'main.json'"), "EMFILE: failed, open 'main.json'"],
      [fsError('EIO', 'read'), 'EIO: failed, read'],
      [new Error('no code'), 'no code'],
      ['not an Error', 'not an Error'],
      [null, 'null'],
    ];
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      for (const [thrown, error] of throws) {
        const { files, sleep } = open({
          platform,
          fs: {
            ...fs,
            readFileSync: (() => {
              throw thrown;
            }) as FileOps['readFileSync'],
          },
        });
        expect(files.read('main'), `${error} on ${platform}`).toEqual({ ok: false, error });
        expect(sleep).not.toHaveBeenCalled();
      }
    }
  });

  it('writes a temp, flushes it, closes it, renames it over the slot, then flushes the folder', () => {
    const { ops, calls } = loggedFs();
    const { files } = open({ fs: ops });
    calls.length = 0;
    expect(files.write('main', 'progress')).toEqual({ ok: true });
    expect(calls).toEqual([
      'open main.json.tmp w',
      'write main.json.tmp',
      'fsync main.json.tmp',
      'close main.json.tmp',
      'rename main.json.tmp main.json',
      'open saves r',
      'fsync saves',
      'close saves',
    ]);
    expect(TEMP_SUFFIX).toBe('.tmp');
    // Windows cannot open a folder to flush it.
    const windows = loggedFs();
    const onWindows = open({ fs: windows.ops, platform: 'win32' });
    windows.calls.length = 0;
    expect(onWindows.files.write('backup', 'progress')).toEqual({ ok: true });
    expect(windows.calls.at(-1)).toBe('rename backup.json.tmp backup.json');
  });

  it('writes the whole text when the OS takes it a few bytes at a time', () => {
    const { files } = open({
      fs: {
        ...fs,
        writeSync: ((fd: number, data: Buffer, offset: number, length: number) =>
          fs.writeSync(fd, data, offset, Math.min(length, 7))) as FileOps['writeSync'],
      },
    });
    const save = `{"v":3,"data":"${'進度'.repeat(500)}"}`;
    expect(files.write('main', save)).toEqual({ ok: true });
    expect(text('main.json')).toBe(save);
  });

  it('keeps the old file and leaves no temp when the disk fills mid-write (ENOSPC)', () => {
    const { files: first } = open();
    first.write('main', 'old progress');
    let writes = 0;
    const { files } = open({
      fs: {
        ...fs,
        writeSync: ((fd: number, data: Buffer, offset: number, length: number) => {
          writes += 1;
          if (writes > 1) throw fsError('ENOSPC', 'write');
          return fs.writeSync(fd, data, offset, Math.min(length, 4));
        }) as FileOps['writeSync'],
      },
    });
    expect(files.write('main', 'newer progress')).toEqual({
      ok: false,
      error: 'ENOSPC: failed, write',
    });
    expect(text('main.json')).toBe('old progress');
    expect(names()).toEqual(['main.json']);
    expect(files.read('main')).toEqual({ ok: true, text: 'old progress' });
  });

  it('keeps the old file and leaves no temp when the OS writes nothing (writeSync answers 0)', () => {
    open().files.write('main', 'old progress');
    const { files } = open({ fs: { ...fs, writeSync: writesNothingFirst() } });
    expect(files.write('main', 'newer progress')).toEqual({
      ok: false,
      error: `could not write ${join(dir, 'main.json.tmp')}`,
    });
    expect(text('main.json')).toBe('old progress');
    expect(names()).toEqual(['main.json']);
    expect(files.read('main')).toEqual({ ok: true, text: 'old progress' });
  });

  it('keeps the old file when the flush or the rename fails, and leaves no temp', () => {
    open().files.write('main', 'old progress');
    const failures: Partial<FileOps>[] = [
      {
        fsyncSync: () => {
          throw fsError('EIO', 'fsync');
        },
      },
      {
        closeSync: () => {
          throw fsError('EIO', 'close');
        },
      },
      { renameSync: failingRename('EXDEV', 1) },
    ];
    for (const failure of failures) {
      const { files } = open({ fs: { ...fs, ...failure } });
      const result = files.write('main', 'newer progress');
      expect(result.ok, Object.keys(failure)[0]).toBe(false);
      expect(text('main.json')).toBe('old progress');
      expect(names()).toEqual(['main.json']);
    }
  });

  it('after a crash before the rename, keeps the old save and sweeps the temp on reopening', () => {
    open().files.write('main', 'old progress');
    // What a crash between the flush and the rename leaves: the new save, whole, in the temp.
    fs.writeFileSync(join(dir, 'main.json.tmp'), 'newer progress');
    fs.writeFileSync(join(dir, 'backup.json.tmp'), 'newer back');
    fs.writeFileSync(join(dir, 'notes.tmp'), 'not a save');
    const { files } = open();
    expect(names()).toEqual(['main.json', 'notes.tmp']);
    expect(files.read('main')).toEqual({ ok: true, text: 'old progress' });
    expect(files.read('backup')).toEqual({ ok: true, text: null });
  });

  it('retries a rename Windows refuses while another program holds the file, five times', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      for (const times of [2, 5]) {
        open({ platform: 'win32' }).files.write('main', 'old progress');
        const { files, sleep } = open({
          platform: 'win32',
          fs: { ...fs, renameSync: failingRename(code, times) },
        });
        expect(files.write('main', `newer ${code} ${times}`), `${code} ×${times}`).toEqual({
          ok: true,
        });
        expect(text('main.json')).toBe(`newer ${code} ${times}`);
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(BUSY_RETRY_MS.slice(0, times));
        expect(names()).toEqual(['main.json']);
      }
      const { files, sleep } = open({
        platform: 'win32',
        fs: { ...fs, renameSync: failingRename(code, 6) },
      });
      expect(files.write('main', 'lost')).toEqual({ ok: false, error: `${code}: failed, rename` });
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20, 40, 80, 160]);
      expect(text('main.json')).toBe(`newer ${code} 5`);
      expect(names()).toEqual(['main.json']);
    }
  });

  it('retries nothing else: another error on Windows, or any error elsewhere, fails at once', () => {
    for (const [code, platform] of [
      ['ENOENT', 'win32'],
      ['EXDEV', 'win32'],
      ['EPERM', 'linux'],
      ['EBUSY', 'darwin'],
    ] as const) {
      const { files, sleep } = open({
        platform,
        fs: { ...fs, renameSync: failingRename(code, 1) },
      });
      expect(files.write('main', 'progress').ok, `${code} on ${platform}`).toBe(false);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it('writes each slot to its own file: no rotation, no slot touching the other', () => {
    const { files } = open();
    files.write('main', 'main 1');
    files.write('backup', 'backup 1');
    files.write('main', 'main 2');
    files.write('main', 'main 3');
    expect(files.read('main')).toEqual({ ok: true, text: 'main 3' });
    expect(files.read('backup')).toEqual({ ok: true, text: 'backup 1' });
    expect(names()).toEqual(['backup.json', 'main.json']);
    files.write('backup', 'backup 2');
    expect(text('main.json')).toBe('main 3');
    expect(SAVE_SLOTS).toEqual(['main', 'backup']);
  });

  it("shows Auto-Cloud's *.json only the two slots, even while a write is under way", () => {
    const seen: string[][] = [];
    const { files } = open({
      fs: {
        ...fs,
        renameSync: (from, to) => {
          seen.push(names());
          fs.renameSync(from, to);
        },
      },
    });
    files.write('main', 'progress');
    files.write('backup', 'progress');
    expect(seen).toEqual([['main.json.tmp'], ['backup.json.tmp', 'main.json']]);
    expect(seen.map(autoCloudSees)).toEqual([[], ['main.json']]);
    expect(autoCloudSees(names())).toEqual(['backup.json', 'main.json']);
  });

  it('refuses a slot other than main and backup', () => {
    const { files } = open();
    for (const slot of ['../main', 'main.json', 'Main', '', 'backup/../main']) {
      expect(files.write(slot as 'main', 'x').ok, slot).toBe(false);
      expect(files.read(slot as 'main'), slot).toEqual({
        ok: false,
        error: `no save slot ${JSON.stringify(slot)}`,
      });
    }
    expect(fs.readdirSync(root)).toEqual(['saves']);
    expect(names()).toEqual([]);
  });

  it("lists the folder's *.json files with their size and time, and nothing else", () => {
    const { files } = open();
    expect(files.list()).toEqual([]);
    files.write('main', '{"v":3}');
    files.write('backup', '{"v":33}');
    fs.writeFileSync(join(dir, 'main.json.tmp'), 'leftover');
    fs.writeFileSync(join(dir, 'notes.txt'), 'notes');
    fs.mkdirSync(join(dir, 'old.json'));
    const listed = files.list();
    expect(listed.map(({ name, bytes }) => ({ name, bytes }))).toEqual([
      { name: 'backup.json', bytes: 8 },
      { name: 'main.json', bytes: 7 },
    ]);
    for (const { name, modified } of listed) {
      expect(modified).toBe(fs.statSync(join(dir, name)).mtime.toISOString());
    }
  });

  it('plays on without a folder it cannot create: writes fail and say why', () => {
    const { files, log } = open({
      fs: {
        ...fs,
        mkdirSync: (() => {
          throw fsError('EACCES', 'mkdir');
        }) as FileOps['mkdirSync'],
      },
    });
    expect(log).toHaveBeenCalledWith(
      `Could not open the save folder ${dir}: EACCES: failed, mkdir`,
    );
    const result = files.write('main', 'progress');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('ENOENT');
    expect(files.read('main')).toEqual({ ok: true, text: null });
    expect(files.list()).toEqual([]);
  });
});

describe('writeReport', () => {
  const NOW = new Date('2026-10-30T09:15:42.123Z');
  /** The check's reports' folder, beside saves/ in userData. */
  const reports = (): string => join(root, 'steam-check');

  it('writes the report as a new text file named by the time, making the folder', () => {
    const report = 'bc-incremental steam check v1\nerrors: 0\n';
    const file = join(reports(), 'report-2026-10-30T09-15-42-123Z.txt');
    expect(writeReport(reports(), report, { now: () => NOW })).toEqual({ ok: true, where: file });
    expect(fs.readFileSync(file, 'utf8')).toBe(report);
    expect(fs.readdirSync(root)).toEqual(['steam-check']);
    // No ':' (Windows refuses it), and never a name Auto-Cloud's *.json would take.
    expect(reportFileName(NOW)).toBe('report-2026-10-30T09-15-42-123Z.txt');
    expect(autoCloudSees([reportFileName(NOW)])).toEqual([]);
  });

  it('never replaces a file: a second report in the same millisecond fails, the first kept', () => {
    expect(writeReport(reports(), 'first', { now: () => NOW }).ok).toBe(true);
    const second = writeReport(reports(), 'second', { now: () => NOW });
    expect(second.ok).toBe(false);
    expect(second.where).toMatch(/^EEXIST/);
    expect(fs.readFileSync(join(reports(), reportFileName(NOW)), 'utf8')).toBe('first');
  });

  it('removes a half-written report and says why, never throwing', () => {
    const failures: readonly (readonly [Partial<FileOps>, string])[] = [
      [{ writeSync: writesNothingFirst() }, 'could not write '],
      [
        {
          writeSync: ((fd: number, data: Buffer, offset: number, length: number) => {
            if (offset > 0) throw fsError('ENOSPC', 'write');
            return fs.writeSync(fd, data, offset, Math.min(length, 4));
          }) as FileOps['writeSync'],
        },
        'ENOSPC: failed, write',
      ],
      [
        {
          closeSync: () => {
            throw fsError('EIO', 'close');
          },
        },
        'EIO: failed, close',
      ],
    ];
    for (const [failure, why] of failures) {
      const result = writeReport(reports(), 'bc-incremental steam check v1\n', {
        now: () => NOW,
        fs: { ...fs, ...failure },
      });
      expect(result.ok, why).toBe(false);
      expect(result.where.startsWith(why), result.where).toBe(true);
      expect(fs.readdirSync(reports()), why).toEqual([]);
    }
    const blocked = writeReport(reports(), 'x', {
      fs: {
        ...fs,
        mkdirSync: (() => {
          throw fsError('EACCES', 'mkdir');
        }) as FileOps['mkdirSync'],
      },
    });
    expect(blocked).toEqual({ ok: false, where: 'EACCES: failed, mkdir' });
  });
});
