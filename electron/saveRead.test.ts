/**
 * A save slot that fails to read, through the real layers from the shell's files to the v3 profile
 * store (the lead's rulings SR3–SR6): openSaveFiles on Windows over a fake save folder, the bridge's
 * read and write handlers (createHandlers), the page's BridgeSaveStorage, and ProfileStore on the
 * fixture webs. A main.json another program holds past the busy retries must not read as an empty
 * slot: the store neither restores the older backup over it nor writes anything. A main.json held
 * for a moment loads after the waits.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProfileStore } from '../src/app/profileStore';
import { BridgeSaveStorage } from '../src/platform/steam';
import type { NativeBridge, SaveWriteResult } from '../src/platform/steam/bridge';
import type { SaveReadResult } from '../src/platform/storage';
import { freshProfile, parseProfile } from '../src/save/profile';
import { fixtureContext } from '../src/save/testing';
import { CHANNELS } from './channels';
import { createHandlers } from './ipc';
import { openSaveFiles } from './saveFiles';
import type { FileOps } from './saveFiles';

const DIR = '/saves';
/** backup.json: save-v2.json, which loads on the fixture webs with no notice. */
const BACKUP = readFileSync(new URL('../tests/fixtures/save-v2.json', import.meta.url), 'utf8');
/** main.json: the same save as serializeProfile writes it, so `loaded` tells main from backup. */
const MAIN = JSON.stringify(JSON.parse(BACKUP));
const CONTEXT = fixtureContext();

/** What node:fs says on Windows while another program holds `name`. */
const busy = (name: string): string => `EBUSY: resource busy or locked, open '${DIR}/${name}'`;

function fsError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/**
 * The save folder in memory: `files` by name, where a read of a name in `held` throws EBUSY that
 * many times before it reads (Infinity: every time). Every call that changes a file is logged.
 */
function fakeFolder(files: Map<string, string>, held: ReadonlyMap<string, number>) {
  const changes: string[] = [];
  const left = new Map(held);
  const open = new Map<number, { readonly name: string; data: string }>();
  let nextFd = 3;
  const ops = {
    mkdirSync: () => undefined,
    readdirSync: () => [...files.keys()],
    readFileSync: (path: string) => {
      const name = basename(path);
      const times = left.get(name) ?? 0;
      if (times > 0) {
        left.set(name, times - 1);
        throw fsError('EBUSY', busy(name));
      }
      const text = files.get(name);
      if (text === undefined) {
        throw fsError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
      }
      return text;
    },
    openSync: (path: string, flags: string) => {
      changes.push(`open ${basename(path)} ${flags}`);
      open.set(nextFd, { name: basename(path), data: '' });
      return nextFd++;
    },
    writeSync: (fd: number, data: Buffer, offset: number, length: number) => {
      const file = open.get(fd);
      changes.push(`write ${file?.name}`);
      if (file !== undefined) file.data += data.toString('utf8', offset, offset + length);
      return length;
    },
    fsyncSync: () => undefined,
    closeSync: (fd: number) => {
      const file = open.get(fd);
      if (file !== undefined) files.set(file.name, file.data);
      open.delete(fd);
    },
    renameSync: (from: string, to: string) => {
      changes.push(`rename ${basename(from)} ${basename(to)}`);
      const text = files.get(basename(from));
      if (text !== undefined) files.set(basename(to), text);
      files.delete(basename(from));
    },
    unlinkSync: (path: string) => {
      changes.push(`unlink ${basename(path)}`);
      files.delete(basename(path));
    },
    statSync: () => {
      throw new Error('the chain never lists the folder');
    },
  };
  // node:fs's overloads, as far as the files call them.
  return { ops: ops as unknown as FileOps, changes };
}

/** Not part of the chain: a call fails the test. */
const unused = (): never => {
  throw new Error('the chain called a handler dep it does not use');
};

/** The Steam build's chain on Windows, from the fake folder to a store; `held` as fakeFolder's. */
function chain(held: ReadonlyMap<string, number>) {
  const files = new Map([
    ['main.json', MAIN],
    ['backup.json', BACKUP],
  ]);
  const { ops, changes } = fakeFolder(files, held);
  const sleep = vi.fn((_ms: number) => {});
  const log = vi.fn((_line: string) => {});
  const saves = openSaveFiles(DIR, { fs: ops, platform: 'win32', sleep, log });
  const handlers = createHandlers({
    info: unused,
    saves,
    steam: { unlock: unused, isUnlocked: unused, clear: unused, openOverlay: unused },
    checkMode: false,
    saveReport: unused,
    showSaves: unused,
    recentErrors: unused,
  });
  // The preload's storage, its sendSync answered by the handlers as registerSync would.
  const bridge: NativeBridge['storage'] = {
    read: (slot) => handlers[CHANNELS.saveRead].handle(slot) as SaveReadResult,
    write: (slot, text) => handlers[CHANNELS.saveWrite].handle(slot, text) as SaveWriteResult,
  };
  const store = new ProfileStore({
    storage: new BridgeSaveStorage(bridge),
    v1: null,
    context: CONTEXT,
    now: () => '2026-10-23T00:00:00.000Z',
  });
  const waits = (): number[] => sleep.mock.calls.map(([ms]) => ms);
  return { files, changes, log, waits, store };
}

describe('a save file that fails to read, from the shell to the store (SR3–SR6)', () => {
  it('story 1: main.json busy past the retries beside a good backup.json is readFailed, nothing written', () => {
    const { files, changes, log, waits, store } = chain(new Map([['main.json', Infinity]]));
    expect(store.open()).toEqual({
      status: 'readFailed',
      notices: [{ kind: 'readFailed', errors: [`main: ${busy('main.json')}`] }],
    });
    expect(waits()).toEqual([10, 20, 40, 80, 160]);
    expect([store.writable, store.profile]).toEqual([false, freshProfile()]);
    expect(store.save()).toBe('readOnly');
    expect(changes).toEqual([]);
    expect([files.get('main.json'), files.get('backup.json')]).toEqual([MAIN, BACKUP]);
    expect(log.mock.calls).toEqual([[`Could not read main.json: ${busy('main.json')}`]]);
  });

  it('story 2: both files busy past the retries is readFailed with both errors, nothing written', () => {
    const { changes, waits, store } = chain(
      new Map([
        ['main.json', Infinity],
        ['backup.json', Infinity],
      ]),
    );
    expect(store.open()).toEqual({
      status: 'readFailed',
      notices: [
        {
          kind: 'readFailed',
          errors: [`main: ${busy('main.json')}`, `backup: ${busy('backup.json')}`],
        },
      ],
    });
    expect(waits()).toEqual([10, 20, 40, 80, 160, 10, 20, 40, 80, 160]);
    expect(store.save()).toBe('readOnly');
    expect(changes).toEqual([]);
  });

  it('loads a main.json held for a moment after waits of 10 and 20 ms, and saves through the chain', () => {
    const { files, changes, log, waits, store } = chain(new Map([['main.json', 2]]));
    expect(store.open()).toEqual({ status: 'loaded', notices: [] });
    expect(waits()).toEqual([10, 20]);
    const loaded = parseProfile(MAIN, CONTEXT);
    expect(loaded.ok && store.profile).toEqual(loaded.ok && loaded.profile);
    expect(changes).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    // The writes reach the folder, so the stories' empty change logs mean nothing was written.
    expect(store.save()).toBe('saved');
    expect(changes).toEqual([
      'open backup.json.tmp w',
      'write backup.json.tmp',
      'rename backup.json.tmp backup.json',
      'open main.json.tmp w',
      'write main.json.tmp',
      'rename main.json.tmp main.json',
    ]);
    expect(files.get('backup.json')).toBe(MAIN);
    expect([...files.keys()].sort()).toEqual(['backup.json', 'main.json']);
  });
});
