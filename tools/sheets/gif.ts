/**
 * The PR GIF (docs/v3 C10 design §2.6; F7, F14; impl:546, :569): the replay page captured frame by
 * frame in step mode, encoded by ffmpeg into a GIF of at most GIF_MAX_BYTES and an H.264 MP4 beside
 * it (G11). `--character <c>` captures `gif:<c>`, c's typical build for 15 s from wave 30 (B1's PR
 * GIF, also marketing); `--fusion <c>.<o>` captures the fusion's clip `clip:<c>.<o>` for as long,
 * a hand fusion's GIF (impl:569's 「GIF；Hoshi 每條玩 5 分鐘」; the template fusions' 3 s clips are
 * the wall's, tools/sheets/clips.ts).
 *
 *   npx tsx tools/sheets/gif.ts --character <c> | --fusion <c>.<o> [--seconds 15] [--fps 30]
 *       [--width 640] [--out out/gif] [--fixture] [--max-bytes <n>]
 *
 * (1) A Vite dev server and headless Chromium with capture.ts' SwiftShader flags at device scale
 * factor 1. (2) The page `/?replay=gif:<c>` or `clip:<c>.<o>` with `&seconds=`, `&fps=`, `&width=`
 * and `&step=1` (and `&fixture`): a clip of seconds × TICK_RATE ticks stepped TICK_RATE ÷ fps
 * ticks a frame (the lead's ruling H8). (3) Per frame `window.__replay.step(1)`, then the canvas's
 * PNG, as replaySmoke.ts reads it, to <out>/frames/<name>-<fps>fps/NNNN.png from 0000: seconds ×
 * fps frames, so the last shows the clip's last tick and no loop restart falls inside the capture.
 * (4) ffmpeg: palettegen=stats_mode=diff, then paletteuse=dither=bayer:bayer_scale=5 with that
 * palette, for <out>/<name>.gif; libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart for
 * <out>/<name>.mp4, from the first capture, at --width and --fps. (5) The size ladder, stopping at
 * the first rung whose GIF fits the cap: --width at --fps (640 px at 30 fps by default); 480 px at
 * --fps, the captured frames scaled by ffmpeg (scale=480:-1:flags=lanczos), so every rung shows
 * the same picture; 480 px at 20 fps, captured again with `&fps=20` (3 ticks a frame, where
 * ffmpeg's fps filter would drop every third frame of a 30 fps capture and judder) and scaled.
 * With other flags a rung no smaller than the one before it is skipped. Past the last rung the MP4
 * is the attachment, and the output says so. `--max-bytes` is a dev flag for the cap: 1 walks
 * every rung.
 *
 * It writes files under --out and nothing else: no upload (the lead's ruling L9: the batch's
 * session attaches them); the frames stay under <out>/frames for re-encoding. Without ffmpeg on
 * PATH it says so and exits 1 before it starts anything. Playwright is taken from node_modules or
 * the global install, as capture.ts takes it. The server and the browser stop on every exit path,
 * errors included.
 */

import { execSync, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { GIF_FPS, GIF_SECONDS, GIF_WIDTH, parseReplayRoute } from '../../src/app/replay/specs';
import type { CharacterId } from '../../src/data/sources';
import type { FusionKey } from '../../src/data/web';
import { TICK_RATE } from '../../src/sim';

/**
 * The GIF's cap, in bytes (初始值): §1.8's 9.5 MB in decimal megabytes (9.5 × 10^6 B), under
 * GitHub's 10 MB for images and GIFs (G11) whether that is 10^7 bytes or 10 MiB.
 */
export const GIF_MAX_BYTES = 9_500_000;
/** The ladder's smaller rungs (§2.6 (5)): 480 px at the capture's rate, then 480 px at 20 fps. */
export const LADDER_WIDTH = 480;
export const LADDER_FPS = 20;
/** The ladder's scaling: a smaller rung is the captured picture shrunk, never drawn again. */
export const scaleFilter = (width: number): string => `scale=${width}:-1:flags=lanczos`;

/** capture.ts' flags: headless Chromium has no GPU, so WebGL runs on SwiftShader. */
export const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];
const LOAD_TIMEOUT_MS = 60_000;
const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** What to capture: a character's GIF build, or a fusion's clip. */
export type GifTarget =
  | { readonly kind: 'character'; readonly character: CharacterId }
  | { readonly kind: 'fusion'; readonly key: FusionKey };

export interface GifOptions {
  readonly target: GifTarget;
  readonly seconds: number;
  readonly fps: number;
  /** The canvas's CSS width at device scale 1; its height is 16:9, as the route makes it. */
  readonly width: number;
  readonly out: string;
  readonly fixture: boolean;
  /** The GIF's cap in bytes: GIF_MAX_BYTES unless `--max-bytes` says. */
  readonly maxBytes: number;
}

/** A target's file name: the character, or the fusion's key. */
export const targetName = (target: GifTarget): string =>
  target.kind === 'character' ? target.character : target.key;

/** The canvas's height at `width`: 16:9, as the route's `&width=` (src/app/replay/route.ts). */
export const heightOf = (width: number): number => Math.round((width * 9) / 16);

/** The replay page's path for `target` at this length, rate and width (the lead's ruling H8). */
export function replayQuery(
  target: GifTarget,
  at: Pick<GifOptions, 'seconds' | 'fps' | 'width' | 'fixture'>,
): string {
  const form = target.kind === 'character' ? `gif:${target.character}` : `clip:${target.key}`;
  return (
    `/?replay=${form}&seconds=${at.seconds}&fps=${at.fps}&width=${at.width}&step=1` +
    (at.fixture ? '&fixture' : '')
  );
}

/** A capture: `frames` frames of `frameTicks` ticks, frames × frameTicks the clip's ticks. */
export interface CapturePlan {
  readonly frames: number;
  readonly frameTicks: number;
}

/** `seconds` at `fps` (a divisor of TICK_RATE, as `&fps=` takes it): seconds × fps frames. */
export const capturePlan = (seconds: number, fps: number): CapturePlan => ({
  frames: seconds * fps,
  frameTicks: TICK_RATE / fps,
});

/** The frames' names from 0000, as ffmpeg's FRAME_PATTERN reads them from FIRST_FRAME. */
export const FIRST_FRAME = 0;
export const FRAME_PATTERN = '%04d.png';
export const frameName = (index: number): string => `${String(index).padStart(4, '0')}.png`;

const QUIET = ['-hide_banner', '-loglevel', 'error', '-y'];
/** The PNG frames in `dir` as one input, at `fps`. */
const framesInput = (dir: string, fps: number): string[] => [
  '-framerate',
  String(fps),
  '-start_number',
  String(FIRST_FRAME),
  '-i',
  join(dir, FRAME_PATTERN),
];
const PALETTE_GEN = 'palettegen=stats_mode=diff';
const PALETTE_USE = 'paletteuse=dither=bayer:bayer_scale=5';

/** ffmpeg's arguments for the palette of the frames in `dir`, scaled to `width` unless null. */
export function paletteArgs(
  dir: string,
  fps: number,
  width: number | null,
  palette: string,
): string[] {
  const filter = width === null ? PALETTE_GEN : `${scaleFilter(width)},${PALETTE_GEN}`;
  return [...QUIET, ...framesInput(dir, fps), '-vf', filter, palette];
}

/** ffmpeg's arguments for the GIF of the frames in `dir` through `palette`, scaled as it is. */
export function gifArgs(
  dir: string,
  fps: number,
  width: number | null,
  palette: string,
  gif: string,
): string[] {
  const graph =
    width === null
      ? `[0:v][1:v]${PALETTE_USE}`
      : `[0:v]${scaleFilter(width)}[scaled];[scaled][1:v]${PALETTE_USE}`;
  return [...QUIET, ...framesInput(dir, fps), '-i', palette, '-lavfi', graph, gif];
}

/** ffmpeg's arguments for the H.264 MP4 of the frames in `dir`. */
export function mp4Args(dir: string, fps: number, mp4: string): string[] {
  return [
    ...QUIET,
    ...framesInput(dir, fps),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '23',
    '-movflags',
    '+faststart',
    mp4,
  ];
}

/** A GIF's width and rate. */
export interface Rung {
  readonly width: number;
  readonly fps: number;
}

/**
 * The size ladder (§2.6 (5)): `first` (the capture's width and rate), then LADDER_WIDTH at its
 * rate, then LADDER_WIDTH at LADDER_FPS: 640 px at 30 fps, 480 at 30 and 480 at 20 with the
 * defaults. A rung is kept only when it is smaller than the last one kept: neither wider nor
 * faster, and narrower or slower.
 */
export function ladderRungs(first: Rung): Rung[] {
  const rungs = [first];
  for (const rung of [
    { width: LADDER_WIDTH, fps: first.fps },
    { width: LADDER_WIDTH, fps: LADDER_FPS },
  ]) {
    const last = rungs[rungs.length - 1] as Rung;
    const smaller =
      rung.width <= last.width &&
      rung.fps <= last.fps &&
      (rung.width < last.width || rung.fps < last.fps);
    if (smaller) rungs.push(rung);
  }
  return rungs;
}

/** A GIF over the cap: more than `maxBytes`, so the ladder goes on (§2.6 (5): at most 9.5 MB). */
export const overCap = (bytes: number, maxBytes: number): boolean => bytes > maxBytes;

/** A rung made, and its GIF's size. */
export interface Tried {
  readonly rung: Rung;
  readonly bytes: number;
}

/**
 * Makes the rungs' GIFs in order, stopping at the first that fits: at most `maxBytes`. The rung
 * chosen, or null when none fits.
 */
export async function climbLadder(
  rungs: readonly Rung[],
  make: (rung: Rung) => Promise<number>,
  maxBytes: number,
): Promise<{ readonly chosen: Rung | null; readonly tried: readonly Tried[] }> {
  const tried: Tried[] = [];
  for (const rung of rungs) {
    const bytes = await make(rung);
    tried.push({ rung, bytes });
    if (!overCap(bytes, maxBytes)) return { chosen: rung, tried };
  }
  return { chosen: null, tried };
}

/** `bytes` with thousands separators. */
export const bytesText = (bytes: number): string => `${bytes.toLocaleString('en-US')} B`;

/** What makeGif needs of the world: the browser, ffmpeg and the files; tests give stubs. */
export interface GifDeps {
  /** Captures plan.frames frames of the replay page at `query` into the empty folder `dir`. */
  capture(query: string, plan: CapturePlan, dir: string): Promise<void>;
  /** Runs ffmpeg with `args`; throws when it fails. */
  ffmpeg(args: readonly string[]): void;
  /** A file's size in bytes. */
  size(file: string): number;
  log(line: string): void;
}

export interface GifResult {
  readonly gif: string;
  readonly mp4: string;
  readonly tried: readonly Tried[];
  /** The first rung whose GIF fits; null past the ladder. */
  readonly chosen: Rung | null;
  /** The file the PR attaches: the GIF that fits, else the MP4. */
  readonly attachment: string;
}

/**
 * Captures `options.target` at --width and --fps and makes that capture's MP4, then climbs the size
 * ladder: a narrower rung scales the frames captured at its rate, and a slower rate is captured
 * again at --width, so the ladder re-encodes before it re-captures (the lead's ruling H8).
 */
export async function makeGif(options: GifOptions, deps: GifDeps): Promise<GifResult> {
  const name = targetName(options.target);
  const frameRoot = join(options.out, 'frames');
  const captures = new Map<number, string>();
  /** The frames at `fps`, captured once. */
  const framesAt = async (fps: number): Promise<string> => {
    const done = captures.get(fps);
    if (done !== undefined) return done;
    const dir = join(frameRoot, `${name}-${fps}fps`);
    const plan = capturePlan(options.seconds, fps);
    const query = replayQuery(options.target, { ...options, fps });
    deps.log(`capture: ${plan.frames} frames of ${plan.frameTicks} ticks, ${query}`);
    await deps.capture(query, plan, dir);
    captures.set(fps, dir);
    return dir;
  };
  const gif = join(options.out, `${name}.gif`);
  const mp4 = join(options.out, `${name}.mp4`);
  const palette = join(frameRoot, `${name}-palette.png`);
  const first: Rung = { width: options.width, fps: options.fps };
  const firstFrames = await framesAt(first.fps);
  deps.ffmpeg(mp4Args(firstFrames, first.fps, mp4));
  deps.log(`mp4: ${mp4}, ${bytesText(deps.size(mp4))} (${first.width} px at ${first.fps} fps)`);
  const cap = `the cap of ${bytesText(options.maxBytes)}`;
  let index = 0;
  const { chosen, tried } = await climbLadder(
    ladderRungs(first),
    async (rung) => {
      index++;
      const frames = await framesAt(rung.fps);
      const scaled = rung.width === options.width ? null : rung.width;
      deps.ffmpeg(paletteArgs(frames, rung.fps, scaled, palette));
      deps.ffmpeg(gifArgs(frames, rung.fps, scaled, palette, gif));
      const bytes = deps.size(gif);
      deps.log(
        `rung ${index}: ${rung.width} px at ${rung.fps} fps${scaled === null ? '' : ' (scaled)'}: ` +
          `${bytesText(bytes)}, ${overCap(bytes, options.maxBytes) ? 'over' : 'under'} ${cap}`,
      );
      return bytes;
    },
    options.maxBytes,
  );
  if (chosen === null) {
    deps.log(
      `attach: ${mp4}: no rung's GIF is under ${cap}, so the MP4 is the attachment ` +
        `(${gif} is the last rung's)`,
    );
  } else {
    deps.log(`attach: ${gif} (${chosen.width} px at ${chosen.fps} fps), with ${mp4} beside it`);
  }
  return { gif, mp4, tried, chosen, attachment: chosen === null ? mp4 : gif };
}

const USAGE =
  'usage: npx tsx tools/sheets/gif.ts --character <c> | --fusion <c>.<o> [--seconds 15] ' +
  '[--fps 30] [--width 640] [--out out/gif] [--fixture] [--max-bytes <n>]';

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `text` as a whole number, or an error naming `flag`. */
function whole(text: string, flag: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`${flag} ${text}: a whole number`);
  return Number(text);
}

/**
 * gif.ts' flags. The replay page's own grammar checks the target, the length (1–60 s), the rate (a
 * divisor of TICK_RATE) and the width; the MP4's yuv420p needs an even width and height.
 */
export function parseGifArgs(argv: readonly string[]): GifOptions | { readonly error: string } {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        character: { type: 'string' },
        fusion: { type: 'string' },
        seconds: { type: 'string', default: String(GIF_SECONDS) },
        fps: { type: 'string', default: String(GIF_FPS) },
        width: { type: 'string', default: String(GIF_WIDTH) },
        out: { type: 'string', default: 'out/gif' },
        fixture: { type: 'boolean', default: false },
        'max-bytes': { type: 'string', default: String(GIF_MAX_BYTES) },
      },
    });
    const { character, fusion } = values;
    if ((character === undefined) === (fusion === undefined)) {
      throw new Error('one of --character <c> and --fusion <c>.<o>');
    }
    const target: GifTarget =
      character === undefined
        ? { kind: 'fusion', key: fusion as FusionKey }
        : { kind: 'character', character: character as CharacterId };
    const options: GifOptions = {
      target,
      seconds: whole(values.seconds, '--seconds'),
      fps: whole(values.fps, '--fps'),
      width: whole(values.width, '--width'),
      out: values.out,
      fixture: values.fixture,
      maxBytes: whole(values['max-bytes'], '--max-bytes'),
    };
    if (options.maxBytes < 1) throw new Error(`--max-bytes ${options.maxBytes}: at least 1`);
    const query = replayQuery(target, options);
    const route = parseReplayRoute(query.slice(1));
    if ('error' in route) throw new Error(`the replay page refuses ${query}: ${route.error}`);
    const [c, o] = targetName(target).split('.');
    if (c === o)
      throw new Error(`--fusion ${targetName(target)}: a character has no fusion with itself`);
    if (options.width % 2 !== 0 || heightOf(options.width) % 2 !== 0) {
      throw new Error(
        `--width ${options.width}: the MP4's yuv420p needs an even width and height ` +
          `(${options.width} × ${heightOf(options.width)} px)`,
      );
    }
    return options;
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** The executable `name` on `env`'s PATH (with PATHEXT's endings on Windows), or null. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const endings =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ending of endings) {
      const file = join(dir, name + ending);
      try {
        accessSync(file, constants.X_OK);
        if (statSync(file).isFile()) return file;
      } catch {
        // Not here: the next one.
      }
    }
  }
  return null;
}

/** Runs `ffmpeg` with `args`, its errors on this process's stderr; throws when it fails. */
export function runFfmpeg(ffmpeg: string, args: readonly string[]): void {
  const result = spawnSync(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffmpeg exited ${result.status ?? result.signal}: ffmpeg ${args.join(' ')}`);
  }
}

/** The text ffmpeg's absence prints: what to install, and that nothing was captured. */
export const NO_FFMPEG =
  'ffmpeg is not on PATH: install it (with libx264) and run again; nothing was captured';

/** The part of the Playwright API the capture tools use. */
interface ConsoleMessage {
  type(): string;
  text(): string;
}
export interface CapturePage {
  goto(url: string, options: { timeout: number }): Promise<unknown>;
  waitForFunction(
    expression: string,
    arg: undefined,
    options: { timeout: number },
  ): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  locator(selector: string): { screenshot(options: { path: string }): Promise<unknown> };
  on(event: 'pageerror', listener: (error: Error) => void): void;
  on(event: 'console', listener: (message: ConsoleMessage) => void): void;
}
interface Browser {
  newPage(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  }): Promise<CapturePage>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(options: { args: string[] }): Promise<Browser> };
}

function loadPlaywright(): Playwright {
  const require = createRequire(import.meta.url);
  const roots = [process.cwd()];
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim());
  } catch {
    // No npm on PATH: only the local install can be used.
  }
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require(require.resolve(name, { paths: roots })) as Playwright;
    } catch {
      // Not installed here; try the next name.
    }
  }
  throw new Error('Playwright not found: install it globally (npm i -g playwright) or locally.');
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** A page of the dev server's site, and what it reported: page errors and console errors. */
export interface Session {
  readonly page: CapturePage;
  readonly base: string;
  readonly errors: string[];
  /** Rejects at the page's first error: a wait races it, so a broken page fails at once. */
  readonly failed: Promise<never>;
}

/** The server and the browser a session runs on; tests give stubs. */
export interface SessionDeps {
  /** A Vite dev server of this repository, listening at `base`. */
  startServer(): Promise<{ readonly base: string; close(): Promise<void> }>;
  /** Headless Chromium with CHROMIUM_ARGS. */
  launch(): Promise<{ newPage(viewport: Viewport): Promise<CapturePage>; close(): Promise<void> }>;
}

/** Runs `body` on a fresh page, then stops the browser and the server, whatever happens. */
export async function withSession<T>(
  deps: SessionDeps,
  viewport: Viewport,
  body: (session: Session) => Promise<T>,
): Promise<T> {
  const server = await deps.startServer();
  try {
    const browser = await deps.launch();
    try {
      const page = await browser.newPage(viewport);
      const errors: string[] = [];
      let fail: (error: Error) => void = () => undefined;
      const failed = new Promise<never>((_, reject) => {
        fail = reject;
      });
      // Only the waits that race it report it.
      failed.catch(() => undefined);
      const report = (line: string): void => {
        errors.push(line);
        fail(new Error(line));
      };
      page.on('pageerror', (error) => report(`page error: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') report(`console error: ${message.text()}`);
      });
      return await body({ page, base: server.base, errors, failed });
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

/** This repository's Vite dev server and Playwright's headless Chromium, at device scale 1. */
export const LIVE_SESSION: SessionDeps = {
  async startServer() {
    const server = await createServer({
      root: REPO,
      logLevel: 'warn',
      server: { host: '127.0.0.1', strictPort: false },
    });
    try {
      await server.listen();
      const base = server.resolvedUrls?.local[0];
      if (base === undefined) throw new Error('Vite did not report a local URL');
      return { base, close: () => server.close() };
    } catch (error) {
      await server.close();
      throw error;
    }
  },
  async launch() {
    const { chromium } = loadPlaywright();
    const browser = await chromium.launch({ args: CHROMIUM_ARGS });
    return {
      newPage: (viewport) => browser.newPage({ viewport, deviceScaleFactor: 1 }),
      close: () => browser.close(),
    };
  },
};

/** Loads `path` and waits until `ready` holds in the page, failing at the page's first error. */
export async function openPage(session: Session, path: string, ready: string): Promise<void> {
  const { page, base } = session;
  await page.goto(new URL(path, base).href, { timeout: LOAD_TIMEOUT_MS });
  const waiting = page.waitForFunction(ready, undefined, { timeout: LOAD_TIMEOUT_MS });
  // A wait the page's error cut short rejects when the browser closes: nobody reads it.
  waiting.catch(() => undefined);
  await Promise.race([waiting, session.failed]);
}

/** Throws what the page reported, if anything. */
export function checkPage(session: Session): void {
  if (session.errors.length > 0) throw new Error(session.errors.join('\n'));
}

/** Empties `dir` for a capture's frames: an earlier, longer capture's would be read on. */
export function emptyDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/** One frame: the replay stepped once, then its canvas's PNG. */
const STEP_AND_READ =
  '(() => { window.__replay.step(1); return window.__replay.canvas.toDataURL("image/png"); })()';

/** Captures plan.frames frames of the replay page at `query` into `dir`; the tick it ends on. */
export async function captureReplay(
  session: Session,
  query: string,
  plan: CapturePlan,
  dir: string,
): Promise<number> {
  emptyDir(dir);
  await openPage(session, query, 'window.__replay !== undefined');
  for (let frame = 0; frame < plan.frames; frame++) {
    const url = String(await session.page.evaluate(STEP_AND_READ));
    const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    writeFileSync(join(dir, frameName(FIRST_FRAME + frame)), png);
  }
  const tick = Number(await session.page.evaluate('window.__replay.tick'));
  checkPage(session);
  return tick;
}

export const secondsSince = (start: number): string =>
  `${((performance.now() - start) / 1000).toFixed(1)} s`;

/** gif.ts with `argv`: its exit code (2 for a usage error, 1 without ffmpeg or on a failure). */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  session: SessionDeps = LIVE_SESSION,
): Promise<number> {
  const options = parseGifArgs(argv);
  if ('error' in options) {
    console.error(`gif: ${options.error}\n${USAGE}`);
    return 2;
  }
  const ffmpeg = findOnPath('ffmpeg', env);
  if (ffmpeg === null) {
    console.error(`gif: ${NO_FFMPEG}`);
    return 1;
  }
  const started = performance.now();
  const out = resolve(options.out);
  const viewport = {
    width: Math.max(1280, options.width),
    height: Math.max(720, heightOf(options.width)),
  };
  const durationTicks = options.seconds * TICK_RATE;
  await withSession(session, viewport, (live) =>
    makeGif(
      { ...options, out },
      {
        async capture(query, plan, dir) {
          const start = performance.now();
          const tick = await captureReplay(live, query, plan, dir);
          console.log(
            `captured ${plan.frames} frames in ${secondsSince(start)} to ${dir}; the last at ` +
              `tick ${tick} of ${durationTicks}` +
              (tick < durationTicks ? ' (its run ended early)' : ''),
          );
        },
        ffmpeg: (args) => runFfmpeg(ffmpeg, args),
        size: (file) => statSync(file).size,
        log: (line) => console.log(line),
      },
    ),
  );
  console.log(`gif: done in ${secondsSince(started)}`);
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
