/**
 * The wall's capture (docs/v3 C10 design §2.6; impl:569, :571): the clip wall (clips.html,
 * src/app/clips.ts) captured page by page in step mode, each page for its clips' 3 s at GIF_FPS
 * (90 frames of 2 ticks, so the last shows each clip's last tick), as <out>/wall-<n>.gif and
 * <out>/wall-<n>.mp4, which B1's PR attaches beside the GIF (the lead's ruling L9). `--all` and
 * `--fixture` are the wall's `?all` and `?fixture`; a hand fusion's 15 s GIF is gif.ts' (--fusion).
 *
 *   npx tsx tools/sheets/clips.ts [--all] [--fixture] [--out out/clips]
 *
 * As gif.ts: a Vite dev server and headless Chromium at device scale factor 1, the page
 * `/clips.html?step=1`; per frame `window.__clips.step(1)` steps every tile, then the wall's
 * screenshot (its tiles and their labels) goes to <out>/frames/wall-<n>/NNNN.png from 0000; ffmpeg
 * makes the GIF through its palette and the MP4 with gif.ts' arguments, at the wall's own size. It
 * writes files under --out and nothing else, says so and exits 1 without ffmpeg on PATH or with
 * an empty wall, and stops the server and the browser on every exit path.
 */

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CLIP_TICKS, GIF_FPS } from '../../src/app/replay/specs';
import { TICK_RATE } from '../../src/sim';
import {
  bytesText,
  capturePlan,
  checkPage,
  emptyDir,
  errorText,
  findOnPath,
  FIRST_FRAME,
  frameName,
  gifArgs,
  LIVE_SESSION,
  mp4Args,
  NO_FFMPEG,
  openPage,
  paletteArgs,
  runFfmpeg,
  secondsSince,
  withSession,
} from './gif';
import type { CapturePlan, Session, SessionDeps } from './gif';

/** A wall page's capture: its clips' CLIP_TICKS at GIF_FPS, 90 frames of 2 ticks (H10). */
export const WALL_PLAN = capturePlan(CLIP_TICKS / TICK_RATE, GIF_FPS);
/** Wider and taller than a page of four 320 px tiles a row, three rows and the header. */
const VIEWPORT = { width: 1400, height: 900 };

export interface ClipsOptions {
  readonly all: boolean;
  readonly fixture: boolean;
  readonly out: string;
}

/** The wall's page for a capture: step mode, with `?all` and `?fixture` as the flags say. */
export const wallQuery = (options: Pick<ClipsOptions, 'all' | 'fixture'>): string =>
  `/clips.html?step=1${options.all ? '&all' : ''}${options.fixture ? '&fixture' : ''}`;

const USAGE = 'usage: npx tsx tools/sheets/clips.ts [--all] [--fixture] [--out out/clips]';

export function parseClipsArgs(argv: readonly string[]): ClipsOptions | { readonly error: string } {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        all: { type: 'boolean', default: false },
        fixture: { type: 'boolean', default: false },
        out: { type: 'string', default: 'out/clips' },
      },
    });
    return { all: values.all, fixture: values.fixture, out: values.out };
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** What makeWall needs of the world: the wall's page, ffmpeg and the files; tests give stubs. */
export interface WallDeps {
  /** Opens the wall at `query`: its number of pages. */
  open(query: string): Promise<number>;
  /** Shows page `n` and captures plan.frames frames of it into the empty folder `dir`. */
  capture(n: number, plan: CapturePlan, dir: string): Promise<void>;
  /** Runs ffmpeg with `args`; throws when it fails. */
  ffmpeg(args: readonly string[]): void;
  /** A file's size in bytes. */
  size(file: string): number;
  log(line: string): void;
}

/** A page's files. */
export interface WallFiles {
  readonly page: number;
  readonly gif: string;
  readonly mp4: string;
}

/** Captures every page of the wall `options` names: its files, none for an empty wall. */
export async function makeWall(options: ClipsOptions, deps: WallDeps): Promise<WallFiles[]> {
  const pages = await deps.open(wallQuery(options));
  const files: WallFiles[] = [];
  for (let n = 1; n <= pages; n++) {
    const dir = join(options.out, 'frames', `wall-${n}`);
    await deps.capture(n, WALL_PLAN, dir);
    const palette = join(options.out, 'frames', `wall-${n}-palette.png`);
    const gif = join(options.out, `wall-${n}.gif`);
    const mp4 = join(options.out, `wall-${n}.mp4`);
    deps.ffmpeg(paletteArgs(dir, GIF_FPS, null, palette));
    deps.ffmpeg(gifArgs(dir, GIF_FPS, null, palette, gif));
    deps.ffmpeg(mp4Args(dir, GIF_FPS, mp4));
    deps.log(
      `page ${n} of ${pages}: ${gif}, ${bytesText(deps.size(gif))}; ` +
        `${mp4}, ${bytesText(deps.size(mp4))}`,
    );
    files.push({ page: n, gif, mp4 });
  }
  return files;
}

/** Opens the wall at `query` in `session`: its number of pages. */
export async function openWall(session: Session, query: string): Promise<number> {
  await openPage(session, query, 'window.__clips !== undefined && window.__clips.ready');
  return Number(await session.page.evaluate('window.__clips.pages'));
}

/**
 * Shows page `n` of the wall open in `session`, then captures plan.frames frames of it into `dir`:
 * per frame `window.__clips.step(1)` (WALL_FRAME_TICKS ticks, plan.frameTicks), then the wall's
 * screenshot, from 0000.png.
 */
export async function captureWall(
  session: Session,
  n: number,
  plan: CapturePlan,
  dir: string,
): Promise<void> {
  emptyDir(dir);
  await session.page.evaluate(`window.__clips.page(${n})`);
  const wall = session.page.locator('#wall');
  for (let frame = 0; frame < plan.frames; frame++) {
    await session.page.evaluate('window.__clips.step(1)');
    await wall.screenshot({ path: join(dir, frameName(FIRST_FRAME + frame)) });
  }
  checkPage(session);
}

/** clips.ts with `argv`: its exit code (2 for a usage error, 1 without ffmpeg or a page). */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  session: SessionDeps = LIVE_SESSION,
): Promise<number> {
  const options = parseClipsArgs(argv);
  if ('error' in options) {
    console.error(`clips: ${options.error}\n${USAGE}`);
    return 2;
  }
  const ffmpeg = findOnPath('ffmpeg', env);
  if (ffmpeg === null) {
    console.error(`clips: ${NO_FFMPEG}`);
    return 1;
  }
  const started = performance.now();
  const out = resolve(options.out);
  const files = await withSession(session, VIEWPORT, (live) =>
    makeWall(
      { ...options, out },
      {
        async open(query) {
          const pages = await openWall(live, query);
          console.log(`clips: ${query}: ${pages} page(s)`);
          return pages;
        },
        async capture(n, plan, dir) {
          const start = performance.now();
          await captureWall(live, n, plan, dir);
          console.log(`captured page ${n}: ${plan.frames} frames in ${secondsSince(start)}`);
        },
        ffmpeg: (args) => runFfmpeg(ffmpeg, args),
        size: (file) => statSync(file).size,
        log: (line) => console.log(line),
      },
    ),
  );
  if (files.length === 0) {
    console.error(
      'clips: the wall has no page, so nothing was captured: before B1 no character has a ' +
        'center (--fixture captures the test fixture), and without --all only template fusions show',
    );
    return 1;
  }
  console.log(`clips: ${files.length} page(s) in ${secondsSince(started)} in ${out}`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
