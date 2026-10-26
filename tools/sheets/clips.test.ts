/**
 * The wall's capture (tools/sheets/clips.ts, docs/v3 C10 design §2.6): a page's plan, the wall's
 * query for the flags, makeWall's captures and encodes on stub deps, a page's frames on a stub
 * page, and the run's exits: no ffmpeg, a usage error, an empty wall and a failure, each with the
 * server and the browser stopped.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureWall,
  makeWall,
  openWall,
  parseClipsArgs,
  run,
  WALL_PLAN,
  wallQuery,
} from './clips';
import type { ClipsOptions, WallDeps } from './clips';
import { gifArgs, mp4Args, paletteArgs } from './gif';
import type { CapturePage, CapturePlan, Session, SessionDeps } from './gif';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bc-clips-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('a wall page’s capture (docs/v3 C10 design §2.6; the lead’s ruling H10)', () => {
  it('captures each page for its clips’ 3 s at 30 fps: 90 frames of 2 ticks', () => {
    expect(WALL_PLAN).toEqual({ frames: 90, frameTicks: 2 });
  });

  it('opens the wall in step mode with ?all and ?fixture as the flags say', () => {
    expect(wallQuery({ all: false, fixture: false })).toBe('/clips.html?step=1');
    expect(wallQuery({ all: false, fixture: true })).toBe('/clips.html?step=1&fixture');
    expect(wallQuery({ all: true, fixture: true })).toBe('/clips.html?step=1&all&fixture');
  });

  it('takes --all, --fixture and --out, and refuses anything else', () => {
    expect(parseClipsArgs([])).toEqual({ all: false, fixture: false, out: 'out/clips' });
    expect(parseClipsArgs(['--all', '--fixture', '--out', 'x'])).toEqual({
      all: true,
      fixture: true,
      out: 'x',
    });
    expect(parseClipsArgs(['--fusion', 'fire.ice'])).toEqual({
      error: expect.stringContaining("Unknown option '--fusion'") as unknown,
    });
  });
});

/** Stub deps: the wall's pages, and the captures, ffmpeg's runs and the lines in order. */
function stubDeps(pages: number) {
  const opened: string[] = [];
  const captures: { n: number; plan: CapturePlan; dir: string }[] = [];
  const ffmpeg: string[][] = [];
  const lines: string[] = [];
  const deps: WallDeps = {
    open: (query) => {
      opened.push(query);
      return Promise.resolve(pages);
    },
    capture: (n, plan, dir) => {
      captures.push({ n, plan, dir });
      return Promise.resolve();
    },
    ffmpeg: (args) => void ffmpeg.push([...args]),
    size: (file) => (file.endsWith('.gif') ? 3_000_000 : 400_000),
    log: (line) => void lines.push(line),
  };
  return { deps, opened, captures, ffmpeg, lines };
}

const OPTIONS: ClipsOptions = { all: false, fixture: true, out: 'out/clips' };

describe('makeWall (docs/v3 C10 design §2.6)', () => {
  it('captures every page and makes its GIF through its palette and its MP4, at the wall’s size', async () => {
    const { deps, opened, captures, ffmpeg, lines } = stubDeps(3);
    const files = await makeWall(OPTIONS, deps);
    expect(opened).toEqual(['/clips.html?step=1&fixture']);
    expect(captures).toEqual(
      [1, 2, 3].map((n) => ({ n, plan: WALL_PLAN, dir: join('out/clips', 'frames', `wall-${n}`) })),
    );
    const at = (n: number) => ({
      frames: join('out/clips', 'frames', `wall-${n}`),
      palette: join('out/clips', 'frames', `wall-${n}-palette.png`),
      gif: join('out/clips', `wall-${n}.gif`),
      mp4: join('out/clips', `wall-${n}.mp4`),
    });
    expect(ffmpeg).toEqual(
      [1, 2, 3].flatMap((n) => {
        const { frames, palette, gif, mp4 } = at(n);
        return [
          paletteArgs(frames, 30, null, palette),
          gifArgs(frames, 30, null, palette, gif),
          mp4Args(frames, 30, mp4),
        ];
      }),
    );
    expect(files).toEqual([1, 2, 3].map((n) => ({ page: n, gif: at(n).gif, mp4: at(n).mp4 })));
    expect(lines[0]).toBe(`page 1 of 3: ${at(1).gif}, 3,000,000 B; ${at(1).mp4}, 400,000 B`);
  });

  it('opens every fusion with --all', async () => {
    const { deps, opened } = stubDeps(4);
    const files = await makeWall({ ...OPTIONS, all: true }, deps);
    expect([opened, files.length]).toEqual([['/clips.html?step=1&all&fixture'], 4]);
  });

  it('captures nothing on an empty wall', async () => {
    const { deps, opened, captures, ffmpeg } = stubDeps(0);
    expect(await makeWall({ ...OPTIONS, fixture: false }, deps)).toEqual([]);
    expect([opened, captures, ffmpeg]).toEqual([['/clips.html?step=1'], [], []]);
  });
});

/** A stub of Playwright's page on the wall: what was asked of it, each screenshot its frame. */
function stubPage(pages = 3, goto: () => Promise<unknown> = () => Promise.resolve(null)) {
  const asked: string[] = [];
  let steps = 0;
  const page: CapturePage & { asked: string[] } = {
    asked,
    goto(url) {
      asked.push(`goto ${url}`);
      return goto();
    },
    waitForFunction(expression) {
      asked.push(`wait ${expression}`);
      return Promise.resolve(true);
    },
    evaluate(expression) {
      asked.push(expression);
      if (expression === 'window.__clips.pages') return Promise.resolve(pages);
      if (expression === 'window.__clips.step(1)') steps++;
      return Promise.resolve(undefined);
    },
    locator: (selector) => ({
      screenshot: ({ path }) => {
        writeFileSync(path, `${selector} after ${steps} steps`);
        return Promise.resolve(null);
      },
    }),
    on: () => undefined,
  };
  return page;
}

const sessionOf = (page: CapturePage): Session => ({
  page,
  base: 'http://127.0.0.1:5173/',
  errors: [],
  failed: new Promise<never>(() => undefined),
});

describe('a page’s frames (docs/v3 C10 design §2.6)', () => {
  it('opens the wall, waits for it to be ready and reads its pages', async () => {
    const page = stubPage(3);
    expect(await openWall(sessionOf(page), '/clips.html?step=1&fixture')).toBe(3);
    expect(page.asked).toEqual([
      'goto http://127.0.0.1:5173/clips.html?step=1&fixture',
      'wait window.__clips !== undefined && window.__clips.ready',
      'window.__clips.pages',
    ]);
  });

  it('shows the page, then steps every tile and shoots the wall once a frame, from 0000.png', async () => {
    const page = stubPage();
    const dir = join(root, 'frames', 'wall-2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '0090.png'), 'stale');
    await captureWall(sessionOf(page), 2, WALL_PLAN, dir);
    expect(page.asked.slice(0, 3)).toEqual([
      'window.__clips.page(2)',
      'window.__clips.step(1)',
      'window.__clips.step(1)',
    ]);
    expect(page.asked).toHaveLength(91);
    const names = readdirSync(dir).sort();
    expect([names.length, names[0], names.at(-1)]).toEqual([90, '0000.png', '0089.png']);
    expect(readFileSync(join(dir, '0000.png'), 'utf8')).toBe('#wall after 1 steps');
    expect(readFileSync(join(dir, '0089.png'), 'utf8')).toBe('#wall after 90 steps');
  });

  it('fails with what the page reported during the capture', async () => {
    const session = { ...sessionOf(stubPage()), errors: ['console error: boom'] };
    await expect(captureWall(session, 1, WALL_PLAN, join(root, 'frames'))).rejects.toThrow(
      'console error: boom',
    );
  });
});

/** Stub server and browser on `page`: what started and stopped, in order. */
function stubSession(page: CapturePage) {
  const log: string[] = [];
  const deps: SessionDeps = {
    startServer: () => {
      log.push('start server');
      return Promise.resolve({
        base: 'http://127.0.0.1:5173/',
        close: () => {
          log.push('close server');
          return Promise.resolve();
        },
      });
    },
    launch: () => {
      log.push('launch');
      return Promise.resolve({
        newPage: (viewport) => {
          log.push(`page ${viewport.width}x${viewport.height}`);
          return Promise.resolve(page);
        },
        close: () => {
          log.push('close browser');
          return Promise.resolve();
        },
      });
    },
  };
  return { deps, log };
}

describe('clips.ts’ run', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  /** PATH holding an executable named ffmpeg, never run here. */
  function fakeFfmpeg(): NodeJS.ProcessEnv {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ffmpeg'), '');
    chmodSync(join(bin, 'ffmpeg'), 0o755);
    return { PATH: bin, PATHEXT: '' };
  }
  const STARTED = ['start server', 'launch', 'page 1400x900'];
  const STOPPED = ['close browser', 'close server'];

  it('says ffmpeg is missing and exits 1 before it starts anything', async () => {
    const { deps, log } = stubSession(stubPage());
    expect(await run(['--fixture'], { PATH: join(root, 'none') }, deps)).toBe(1);
    expect(log).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ffmpeg is not on PATH'));
  });

  it('exits 2 on a usage error', async () => {
    const { deps, log } = stubSession(stubPage());
    expect(await run(['--fps', '20'], {}, deps)).toBe(2);
    expect(log).toEqual([]);
  });

  it('says the wall is empty and exits 1, the server and the browser stopped', async () => {
    const { deps, log } = stubSession(stubPage(0));
    expect(await run(['--out', join(root, 'clips')], fakeFfmpeg(), deps)).toBe(1);
    expect(log).toEqual([...STARTED, ...STOPPED]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('the wall has no page'));
  });

  it('stops the server and the browser when the wall does not load, and rejects', async () => {
    const page = stubPage(3, () => Promise.reject(new Error('net::ERR_CONNECTION_REFUSED')));
    const { deps, log } = stubSession(page);
    await expect(
      run(['--fixture', '--out', join(root, 'clips')], fakeFfmpeg(), deps),
    ).rejects.toThrow('ERR_CONNECTION_REFUSED');
    expect(log).toEqual([...STARTED, ...STOPPED]);
  });
});
