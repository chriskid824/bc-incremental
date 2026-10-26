/**
 * SMOKE of the replay page (docs/v3 C10 design §1.7, §2.5): starts a Vite dev server and opens
 * `?replay=renderStress&step=1` in headless Chromium through Playwright, as hiveSmoke.ts does,
 * twice in one fresh browser context (empty localStorage). Each load steps the replay through
 * `window.__replay` to frames 60, 180 and 300 and hashes the canvas's PNG at each: both loads
 * must draw the same frames, and the frames must change. Then `seek(60)`, and frame 60 of the
 * clip's next loop, must draw frame 60 again (§1.7: seek re-creates the run, a loop repeats it).
 *
 * It fails on any page error or console error, on a localStorage key the replay page leaves, and
 * on a request that is not a GET from the server itself (the page's assets): the page writes no
 * storage, sends no playtest event and calls no platform API (the lead's ruling J3). In a second
 * fresh context it opens the plain page and `?hive`, which must never fetch the replay's modules
 * (src/app/replay/, a build's lazy chunk), while the replay page must.
 *
 * It saves the first load's three frames for the lead to look at.
 *
 * The clips smoke (§2.6; the lead's ruling H6), in a third fresh context:
 * `/clips.html?fixture&step=1` opens 12 fixture tiles of 320 × 180 px on page 1 of 3; five flips
 * (pages 2, 3, 1, 2, 3, each stepped) show each page's tiles, and no tile shown loses its WebGL
 * context: none fires `webglcontextlost` while on the wall, none reads isContextLost() after the
 * flips, and Chromium never warns of too many active contexts. A flip's destroy() releases each
 * replaced tile's context (WEBGL_lose_context), so its canvas, off the wall by then, fires one
 * `webglcontextlost`: the smoke counts them, one a destroyed tile.
 *
 *   npx tsx tools/sheets/replaySmoke.ts [--out out/replay-smoke]
 *
 * Playwright is taken from node_modules or the global install, as capture.ts takes it.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { RENDER_STRESS_TICKS } from '../../src/app/replay/specs';

const REPLAY = '/?replay=renderStress&step=1';
/** The frames each load hashes (§2.5). */
const FRAMES = [60, 180, 300] as const;
/** The replay's modules, which only the replay page may fetch: the dev server's lazy chunk. */
const REPLAY_MODULES = '/src/app/replay/';
const LOAD_TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 720 };
const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The clip wall's smoke (§2.6): fixture tiles, a page's 12 of 32, and the five flips' pages. */
const CLIPS = '/clips.html?fixture&step=1';
const CLIPS_VIEWPORT = { width: 1400, height: 900 };
const CLIPS_PAGES = 3;
const CLIPS_FLIPS = [2, 3, 1, 2, 3] as const;
/** The tiles of each fixture page: 32 template and templateOverride fusions, 12 a page. */
const CLIPS_TILES = [12, 12, 8] as const;
/**
 * Watches the wall's canvases not yet watched: a `webglcontextlost` on one still on the wall is a
 * tile shown losing its context, on one off it a destroy() releasing it (C10.5a). The canvases now.
 */
const WATCH_WALL = `(() => {
  const seen = (window.__smokeSeen ??= new WeakSet());
  const lost = (window.__smokeLost ??= { shown: 0, released: 0 });
  const canvases = [...document.querySelectorAll('#wall canvas')];
  for (const canvas of canvases) {
    if (seen.has(canvas)) continue;
    seen.add(canvas);
    canvas.addEventListener('webglcontextlost', () => {
      if (canvas.isConnected) lost.shown++;
      else lost.released++;
    });
  }
  return canvases.map((canvas) => canvas.width + 'x' + canvas.height);
})()`;
/** The wall's canvases whose context is lost. */
const LOST_NOW = `[...document.querySelectorAll('#wall canvas')].filter((canvas) =>
  (canvas.getContext('webgl2') ?? canvas.getContext('webgl'))?.isContextLost() ?? true).length`;

const INTRO = '.bc-intro:not([hidden])';
const TALENTS = '.bc-talents:not([hidden])';

/** The part of the Playwright API this script uses. */
interface ConsoleMessage {
  type(): string;
  text(): string;
}
interface Request {
  url(): string;
  method(): string;
}
interface Page {
  goto(url: string, options?: { timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  waitForFunction(
    expression: string,
    arg: undefined,
    options: { timeout: number },
  ): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  on(event: 'pageerror', listener: (error: Error) => void): void;
  on(event: 'console', listener: (message: ConsoleMessage) => void): void;
  on(event: 'request', listener: (request: Request) => void): void;
}
interface StorageState {
  readonly origins: readonly {
    readonly origin: string;
    readonly localStorage: readonly { readonly name: string; readonly value: string }[];
  }[];
}
interface BrowserContext {
  newPage(): Promise<Page>;
  storageState(): Promise<StorageState>;
  close(): Promise<void>;
}
interface Browser {
  newContext(options: {
    viewport: { width: number; height: number };
    locale: string;
  }): Promise<BrowserContext>;
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

/** What went wrong, page by page; the smoke fails when it is not empty. */
const failures: string[] = [];
/** The page being loaded, for the listeners. */
let current = 'no page yet';

function check(ok: boolean, what: string): void {
  if (!ok) failures.push(`${current}: ${what}`);
}

/** A page that reports its errors as failures and keeps every request's method and URL. */
async function watchedPage(context: BrowserContext): Promise<{ page: Page; requests: string[] }> {
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('pageerror', (error) => failures.push(`${current}: page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`${current}: console error: ${message.text()}`);
  });
  page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));
  return { page, requests };
}

/** The canvas's PNG, as the page encodes it. */
async function canvasPng(page: Page): Promise<Buffer> {
  const url = String(await page.evaluate('window.__replay.canvas.toDataURL("image/png")'));
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Loads the replay and steps it to each of FRAMES: each frame's PNG. */
async function framesOf(page: Page, base: string, load: number): Promise<Buffer[]> {
  current = `${REPLAY} (load ${load})`;
  await page.goto(new URL(REPLAY, base).href, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction('window.__replay !== undefined', undefined, {
    timeout: LOAD_TIMEOUT_MS,
  });
  const pngs: Buffer[] = [];
  let at = 0;
  for (const frame of FRAMES) {
    await page.evaluate(`window.__replay.step(${frame - at})`);
    at = frame;
    const tick = Number(await page.evaluate('window.__replay.tick'));
    check(tick === frame, `frame ${frame} shows tick ${tick}`);
    pngs.push(await canvasPng(page));
  }
  return pngs;
}

/** `requests` that are not a GET of `origin`'s own. */
function foreign(requests: readonly string[], origin: string): string[] {
  return requests.filter((request) => {
    const [method, url = ''] = request.split(' ');
    return method !== 'GET' || new URL(url).origin !== origin;
  });
}

const fetchesReplay = (requests: readonly string[], origin: string): boolean =>
  requests.some((request) => request.startsWith(`GET ${origin}${REPLAY_MODULES}`));

/** The clips smoke (§2.6): the wall's first page, five flips and its contexts; what it read. */
async function clipsSmoke(browser: Browser, base: string): Promise<string[]> {
  const context = await browser.newContext({ viewport: CLIPS_VIEWPORT, locale: 'en-US' });
  const { page } = await watchedPage(context);
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('WebGL contexts')) warnings.push(message.text());
  });
  current = CLIPS;
  await page.goto(new URL(CLIPS, base).href, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction('window.__clips?.ready === true', undefined, {
    timeout: LOAD_TIMEOUT_MS,
  });
  const pages = Number(await page.evaluate('window.__clips.pages'));
  check(pages === CLIPS_PAGES, `${pages} pages, not ${CLIPS_PAGES}`);
  const first = (await page.evaluate(WATCH_WALL)) as string[];
  check(first.length === CLIPS_TILES[0], `page 1 shows ${first.length} tiles`);
  check(
    first.every((size) => size === '320x180'),
    `page 1's canvases: ${[...new Set(first)].join(', ')}`,
  );
  await page.evaluate('window.__clips.step(15)');
  let destroyed = first.length;
  const shown: string[] = [];
  for (const [i, n] of CLIPS_FLIPS.entries()) {
    current = `${CLIPS} (page ${n})`;
    await page.evaluate(`window.__clips.page(${n})`);
    const sizes = (await page.evaluate(WATCH_WALL)) as string[];
    const tiles = CLIPS_TILES[n - 1] ?? 0;
    check(sizes.length === tiles, `page ${n} shows ${sizes.length} tiles, not ${tiles}`);
    await page.evaluate('window.__clips.step(15)');
    shown.push(`${n}: ${sizes.length}`);
    // The next flip destroys them; the last flip's page stays.
    if (i < CLIPS_FLIPS.length - 1) destroyed += sizes.length;
  }
  current = `${CLIPS} (after ${CLIPS_FLIPS.length} flips)`;
  // The released contexts' events come a task after their destroy().
  await page
    .waitForFunction(`window.__smokeLost.released >= ${destroyed}`, undefined, { timeout: 10_000 })
    .catch(() => undefined);
  const lost = (await page.evaluate('window.__smokeLost')) as { shown: number; released: number };
  const lostNow = Number(await page.evaluate(LOST_NOW));
  check(lost.shown === 0, `${lost.shown} webglcontextlost on tiles shown`);
  check(lostNow === 0, `${lostNow} tiles shown have lost their context`);
  check(
    lost.released === destroyed,
    `${lost.released} contexts released of ${destroyed} destroyed`,
  );
  check(warnings.length === 0, `warnings: ${warnings.join(' | ')}`);
  await context.close();
  return [
    `${CLIPS} at ${CLIPS_VIEWPORT.width}x${CLIPS_VIEWPORT.height}: ${pages} pages, page 1 ` +
      `${first.length} tiles of ${first[0] ?? 'none'}`,
    `  ${CLIPS_FLIPS.length} flips (page: tiles) ${shown.join(', ')}; webglcontextlost on tiles ` +
      `shown: ${lost.shown}; lost after the flips: ${lostNow}; released by destroy(): ` +
      `${lost.released} of ${destroyed}; context warnings: ${warnings.length}`,
  ];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { out: { type: 'string', default: 'out/replay-smoke' } },
  });
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });

  const { chromium } = loadPlaywright();
  const server = await createServer({
    root: resolve(import.meta.dirname, '../..'),
    logLevel: 'warn',
    server: { host: '127.0.0.1', strictPort: false },
  });
  let browser: Browser | null = null;
  try {
    await server.listen();
    const base = server.resolvedUrls?.local[0];
    if (base === undefined) throw new Error('Vite did not report a local URL');
    const origin = new URL(base).origin;
    browser = await chromium.launch({ args: CHROMIUM_ARGS });

    // The replay page, twice, in a fresh context: equal frames, no storage, only its assets.
    const replayContext = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US' });
    const { page, requests } = await watchedPage(replayContext);
    const first = await framesOf(page, base, 1);
    const second = await framesOf(page, base, 2);
    current = REPLAY;
    const hashes = FRAMES.map((frame, i) => {
      const [a, b] = [sha256(first[i] as Buffer), sha256(second[i] as Buffer)];
      check(a === b, `frame ${frame} differs between the loads: ${a} vs ${b}`);
      writeFileSync(join(out, `replay-frame${frame}.png`), first[i] as Buffer);
      return a;
    });
    check(new Set(hashes).size === FRAMES.length, 'the frames do not change');

    // A seek, then the clip's next loop, draw the frame 60 a fresh load draws.
    current = `${REPLAY} (seek and loop)`;
    const at60 = hashes[0] as string;
    await page.evaluate('window.__replay.seek(60)');
    const sought = sha256(await canvasPng(page));
    check(sought === at60, `seek(60) draws ${sought}, frame 60 ${at60}`);
    await page.evaluate(`window.__replay.step(${RENDER_STRESS_TICKS - 60})`);
    await page.evaluate('window.__replay.step(60)');
    const tick = Number(await page.evaluate('window.__replay.tick'));
    check(tick === 60, `the next loop's frame 60 shows tick ${tick}`);
    const looped = sha256(await canvasPng(page));
    check(looped === at60, `the next loop's frame 60 draws ${looped}, the first ${at60}`);
    current = REPLAY;
    const state = await replayContext.storageState();
    const keys = state.origins.flatMap((entry) => entry.localStorage.map((item) => item.name));
    check(keys.length === 0, `localStorage keys left: ${keys.join(', ')}`);
    const others = foreign(requests, origin);
    for (const request of others) check(false, `request ${request}`);
    check(fetchesReplay(requests, origin), `never fetched ${REPLAY_MODULES}`);
    await replayContext.close();

    // The plain page and `?hive` never fetch the replay's modules.
    const gameContext = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US' });
    const game = await watchedPage(gameContext);
    const fetched: string[] = [];
    for (const [url, ready] of [
      ['/', INTRO],
      ['/?hive', TALENTS],
    ] as const) {
      current = url;
      game.requests.length = 0;
      await game.page.goto(new URL(url, base).href, { timeout: LOAD_TIMEOUT_MS });
      await game.page.waitForSelector(ready, { timeout: LOAD_TIMEOUT_MS });
      if (fetchesReplay(game.requests, origin)) fetched.push(url);
      check(!fetchesReplay(game.requests, origin), `fetched ${REPLAY_MODULES}`);
    }
    await gameContext.close();

    const clips = await clipsSmoke(browser, base);

    console.log(`${REPLAY}, loaded twice at ${VIEWPORT.width}x${VIEWPORT.height}:`);
    for (const [i, frame] of FRAMES.entries()) {
      console.log(`  frame ${frame}: sha256 ${hashes[i]}`);
      console.log(`    ${join(out, `replay-frame${frame}.png`)}`);
    }
    console.log(`seek(60): sha256 ${sought}; the next loop's frame 60: sha256 ${looped}`);
    console.log(
      `requests: ${requests.length}, ${others.length} not a GET from ${origin}; ` +
        `localStorage keys: ${keys.length}`,
    );
    console.log(`pages that fetched ${REPLAY_MODULES} of /, /?hive: ${fetched.length}`);
    for (const line of clips) console.log(line);
  } finally {
    await browser?.close();
    await server.close();
    // Printed here so that what was found before an error is not lost with it.
    if (failures.length > 0) console.error(`failures:\n  ${failures.join('\n  ')}`);
  }
  if (failures.length > 0) throw new Error(`replay smoke failed: ${failures.length} failure(s)`);
  console.log('replay smoke passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
