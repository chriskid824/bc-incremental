/**
 * SMOKE of the enemy grid (docs/v3 C7 design §2.9, the lead's ruling P7): starts a Vite dev
 * server and opens `/?enemies&step=1` in headless Chromium through Playwright, as replaySmoke.ts
 * opens the replay, in a fresh browser context (empty localStorage). It waits for the grid's
 * ready flag, steps it through `window.__enemies` and reads the banner's line as it goes: the
 * first tick slides 盾兵's line in, the ticks go on while it shows (the loop never pauses), the
 * seven v3 types' lines follow one at a time in the grid's spawn order, and the grid's restart
 * shows none again (a fresh seen set per page load, the lead's ruling L7). The canvas must change
 * between frames. `&lang=zh-TW` must show the first line in Traditional Chinese.
 *
 * It fails on any page error or console error, on a localStorage key the page leaves, and on a
 * request that is not a GET from the server itself (the page's assets): the page writes no
 * storage, sends no playtest event and calls no platform API. In a second fresh context it opens
 * the plain page and `?hive`, which must never fetch the grid's modules (src/app/enemies/, a
 * build's lazy chunk) nor show a banner, while the grid's page must fetch them.
 *
 *   npx tsx tools/sheets/enemiesSmoke.ts
 *
 * Playwright is taken from node_modules or the global install, as capture.ts takes it.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const ENEMIES = '/?enemies&step=1';
const READY = 'html[data-enemies-ready="true"]';
/** The grid's modules, which only its page may fetch: the dev server's lazy chunk. */
const ENEMIES_MODULES = '/src/app/enemies/';
const LOAD_TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 720 };
const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];
/** The lines the banner shows, in the grid's spawn order (en). */
const LINES = [
  'New enemy: Shielder',
  'New enemy: Regenerator',
  'New enemy: Dasher',
  'New enemy: Shooter',
  'New enemy: Summoner',
  'New enemy: Treasure',
  'New enemy: Onion',
] as const;
/** gd:1015's example, which `&lang=zh-TW`'s first line is word for word. */
const ZH_FIRST = '新敵人：盾兵　擋下小於其最大生命 15% 的擊中。燃燒可以繞過。';
/** Frames stepped in all: past every line (7 × 2.85 s) and the grid's restart at 20 s. */
const FRAMES = 2_000;
/** Frames a step call takes, so the line watcher sees every line. */
const CHUNK = 10;

/** Records each line the banner shows, in order: window.__smokeLines. */
const WATCH_BANNER = `(() => {
  const lines = (window.__smokeLines = []);
  const banner = document.querySelector('.bc-banner');
  if (banner === null) return false;
  const seen = () => {
    if (banner.classList.contains('bc-visible') && lines.at(-1) !== banner.textContent) {
      lines.push(banner.textContent);
    }
  };
  new MutationObserver(seen).observe(banner, { attributes: true, childList: true, characterData: true, subtree: true });
  seen();
  return true;
})()`;
const BANNER_TEXT = `(() => {
  const banner = document.querySelector('.bc-banner');
  return banner?.classList.contains('bc-visible') ? banner.textContent : null;
})()`;

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

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The canvas's PNG hash, as the page encodes it. */
async function canvasHash(page: Page): Promise<string> {
  const url = String(await page.evaluate('window.__enemies.canvas.toDataURL("image/png")'));
  return sha256(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
}

/** `requests` that are not a GET of `origin`'s own. */
function foreign(requests: readonly string[], origin: string): string[] {
  return requests.filter((request) => {
    const [method, url = ''] = request.split(' ');
    return method !== 'GET' || new URL(url).origin !== origin;
  });
}

const fetchesGrid = (requests: readonly string[], origin: string): boolean =>
  requests.some((request) => request.startsWith(`GET ${origin}${ENEMIES_MODULES}`));

/** Opens `url` on `page` and waits for the grid's ready flag. */
async function openGrid(page: Page, base: string, url: string): Promise<void> {
  current = url;
  await page.goto(new URL(url, base).href, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForSelector(READY, { timeout: LOAD_TIMEOUT_MS });
}

async function main(): Promise<void> {
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

    // The grid, in a fresh context: its lines, its ticks, no storage, only its assets.
    const context = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US' });
    const { page, requests } = await watchedPage(context);
    await openGrid(page, base, ENEMIES);
    check((await page.evaluate(WATCH_BANNER)) === true, 'no .bc-banner on the page');
    const before = await canvasHash(page);
    await page.evaluate('window.__enemies.step(1)');
    const first = String(await page.evaluate(BANNER_TEXT));
    check(first.startsWith(LINES[0]), `the first tick's line: ${first}`);
    await page.evaluate('window.__enemies.step(99)');
    const tick = Number(await page.evaluate('window.__enemies.tick'));
    const still = String(await page.evaluate(BANNER_TEXT));
    check(tick === 100, `100 frames show tick ${tick}: the loop paused`);
    check(still === first, `frame 100's line: ${still}`);
    const after = await canvasHash(page);
    check(before !== after, 'the canvas did not change');
    for (let frame = 100; frame < FRAMES; frame += CHUNK) {
      await page.evaluate(`window.__enemies.step(${CHUNK})`);
    }
    const lines = (await page.evaluate('window.__smokeLines')) as string[];
    check(lines.length === LINES.length, `${lines.length} lines, not ${LINES.length}`);
    LINES.forEach((line, i) => {
      check(lines[i]?.startsWith(line) === true, `line ${i + 1}: ${lines[i] ?? 'none'}`);
    });
    const finalTick = Number(await page.evaluate('window.__enemies.tick'));
    check(finalTick < FRAMES, `tick ${finalTick} after ${FRAMES} frames: the grid never restarted`);
    const state = await context.storageState();
    const keys = state.origins.flatMap((entry) => entry.localStorage.map((item) => item.name));
    check(keys.length === 0, `localStorage keys left: ${keys.join(', ')}`);
    const others = foreign(requests, origin);
    for (const request of others) check(false, `request ${request}`);
    check(fetchesGrid(requests, origin), `never fetched ${ENEMIES_MODULES}`);
    await context.close();

    // The first line in zh-TW.
    const zhContext = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US' });
    const zh = await watchedPage(zhContext);
    await openGrid(zh.page, base, `${ENEMIES}&lang=zh-TW`);
    await zh.page.evaluate('window.__enemies.step(1)');
    const zhFirst = String(await zh.page.evaluate(BANNER_TEXT));
    check(zhFirst === ZH_FIRST, `the first line: ${zhFirst}`);
    await zhContext.close();

    // The plain page and `?hive` never fetch the grid's modules nor show a banner.
    const gameContext = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US' });
    const game = await watchedPage(gameContext);
    const fetched: string[] = [];
    const banners: string[] = [];
    for (const [url, ready] of [
      ['/', INTRO],
      ['/?hive', TALENTS],
    ] as const) {
      current = url;
      game.requests.length = 0;
      await game.page.goto(new URL(url, base).href, { timeout: LOAD_TIMEOUT_MS });
      await game.page.waitForSelector(ready, { timeout: LOAD_TIMEOUT_MS });
      if (fetchesGrid(game.requests, origin)) fetched.push(url);
      check(!fetchesGrid(game.requests, origin), `fetched ${ENEMIES_MODULES}`);
      const banner = Number(
        await game.page.evaluate('document.querySelectorAll(".bc-banner").length'),
      );
      if (banner > 0) banners.push(url);
      check(banner === 0, `${banner} banners`);
    }
    await gameContext.close();

    console.log(`${ENEMIES} at ${VIEWPORT.width}x${VIEWPORT.height}, ${FRAMES} frames:`);
    console.log(`  frame 1's line: ${first}`);
    console.log(`  frame 100: tick ${tick}, the same line showing`);
    console.log(`  lines shown (${lines.length}):`);
    for (const line of lines) console.log(`    ${line}`);
    console.log(`  tick after ${FRAMES} frames: ${finalTick} (the grid restarted)`);
    console.log(`  canvas sha256 at load ${before}, at frame 100 ${after}`);
    console.log(
      `  requests: ${requests.length}, ${others.length} not a GET from ${origin}; ` +
        `localStorage keys: ${keys.length}`,
    );
    console.log(`${ENEMIES}&lang=zh-TW, frame 1's line: ${zhFirst}`);
    console.log(
      `pages of /, /?hive that fetched ${ENEMIES_MODULES}: ${fetched.length}; ` +
        `that showed a banner: ${banners.length}`,
    );
  } finally {
    await browser?.close();
    await server.close();
    // Printed here so that what was found before an error is not lost with it.
    if (failures.length > 0) console.error(`failures:\n  ${failures.join('\n  ')}`);
  }
  if (failures.length > 0) throw new Error(`enemies smoke failed: ${failures.length} failure(s)`);
  console.log('enemies smoke passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
