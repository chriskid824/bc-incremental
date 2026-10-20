/**
 * SMOKE of the `?hive` prototype (docs/v3 C5 design §0.2, §13): starts a Vite dev server and
 * plays the browser build in headless Chromium through Playwright, as tools/sheets/capture.ts
 * does. In one fresh browser context (empty localStorage) it opens the plain page first, then
 * `?hive`, `?hive&lang=zh-TW` and `?hive&wave=30`, and plays each for 60 s at 4×, pressing
 * Enter so a new run starts whenever one ends.
 *
 * It fails on any page error or console error. On the plain page it also fails on the
 * prototype's badge anywhere in the page and on a `bc-incremental.hive.save.` key in
 * localStorage afterwards, so a hive prefix, badge or preset wired without the flag fails here.
 * Under `?hive` it checks the badge in both locales, that the `&wave=30` page's first run starts
 * at wave 30, and that the plain page's save is left as it was. localStorage is read after
 * leaving a page, so the save each page makes on its way out counts.
 *
 * It saves three screenshots for the lead to look at: the hive docked as a run starts, the
 * drones mid-sortie, and wave 30 from the `&wave=30` page's first run. The page's clock
 * (Playwright's clock) is paused for them, so each shows a fixed moment of the run.
 *
 *   npx tsx tools/sheets/hiveSmoke.ts [--out out/smoke]
 *
 * Playwright is taken from node_modules or the global install, as capture.ts takes it.
 */

import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';

/** Each page plays this long at 4×. */
const PLAY_MS = 60_000;
/** Enter starts the next run from the result screen or the talent web (src/app/input.ts). */
const CONFIRM_EVERY_MS = 1_000;
const LOAD_TIMEOUT_MS = 30_000;
/**
 * Leaving a page waits for the game's save on the way out. With another headless Chromium on the
 * same cores that once took over 30 s, so leaving gets longer than loading.
 */
const LEAVE_TIMEOUT_MS = 120_000;
const VIEWPORT = { width: 1280, height: 720 };
const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** src/app/devFlags.ts and src/platform/storage.ts. */
const HIVE_SAVE_PREFIX = 'bc-incremental.hive.save.';
const PLAYER_SAVE = 'bc-incremental.save.main';
/** The badge's text in each locale (src/i18n, app.prototype.hive). */
const BADGES = { en: 'Hive prototype', 'zh-TW': '蜂巢原型' } as const;

const INTRO = '.bc-intro:not([hidden])';
const TALENTS = '.bc-talents:not([hidden])';
const HUD = '.bc-hud:not([hidden])';

/**
 * Clock time from a run's start to each screenshot. The preset's first `?hive` run (seed 1028)
 * launches its first drone on tick 11 (≈ 180 ms), and around tick 240 has every drone out and
 * three impacts from the last 16 ticks. A run from wave 30 lasts about five seconds, its first
 * sorties striking from about tick 50 on.
 */
const DOCKED_AT_MS = 20;
const SORTIE_AT_MS = 4_000;
const WAVE30_AT_MS = 1_500;
/**
 * The page's clock runs on until the pause lands, a round trip after Date.now() was read (tens
 * of ms under load), and a pause in its past throws "Cannot fast-forward to the past". Pausing
 * this far ahead is safe: no run is playing yet, and the jump only lands before the run starts.
 */
const PAUSE_AHEAD_MS = 1_000;

/** The part of the Playwright API this script uses. */
interface Clock {
  install(): Promise<void>;
  pauseAt(time: number): Promise<void>;
  runFor(ms: number): Promise<void>;
  resume(): Promise<void>;
}
interface ConsoleMessage {
  type(): string;
  text(): string;
}
interface Page {
  readonly clock: Clock;
  readonly keyboard: { press(key: string): Promise<void> };
  goto(url: string, options?: { timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
  on(event: 'pageerror', listener: (error: Error) => void): void;
  on(event: 'console', listener: (message: ConsoleMessage) => void): void;
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
/** The page being played, for the page error and console listeners. */
let current = 'no page yet';

function check(ok: boolean, what: string): void {
  if (!ok) failures.push(`${current}: ${what}`);
}

async function text(page: Page, expression: string): Promise<string> {
  return String(await page.evaluate(expression));
}

/** Leaves the game for a blank page, then reads what the game left in `origin`'s localStorage. */
async function storageAfterLeaving(
  page: Page,
  context: BrowserContext,
  origin: string,
): Promise<Map<string, string>> {
  await page.goto('about:blank', { timeout: LEAVE_TIMEOUT_MS });
  const state = await context.storageState();
  const items = state.origins.find((entry) => entry.origin === origin)?.localStorage ?? [];
  return new Map(items.map((item) => [item.name, item.value]));
}

/** Opens `url` and waits for `ready`, the screen a page with this profile lands on. */
async function open(page: Page, base: string, url: string, ready: string): Promise<void> {
  current = url;
  await page.goto(new URL(url, base).href);
  await page.waitForSelector(ready, { timeout: LOAD_TIMEOUT_MS });
}

/** Plays at 4× for PLAY_MS, pressing Enter so a new run starts whenever one ends. */
async function play(page: Page): Promise<void> {
  await page.keyboard.press('4');
  for (let waited = 0; waited < PLAY_MS; waited += CONFIRM_EVERY_MS) {
    await page.waitForTimeout(CONFIRM_EVERY_MS);
    await page.keyboard.press('Enter');
  }
}

/**
 * Starts the next run at 1× with the page's clock paused, and runs the clock to each of `shots`
 * (ms of clock time from the start) for a screenshot. The clock flows again afterwards.
 */
async function startPaused(
  page: Page,
  shots: readonly { readonly atMs: number; readonly path: string }[],
): Promise<void> {
  await page.keyboard.press('1');
  const now = Number(await page.evaluate('Date.now()'));
  await page.clock.pauseAt(now + PAUSE_AHEAD_MS);
  await page.keyboard.press('Enter');
  await page.waitForSelector(HUD, { timeout: LOAD_TIMEOUT_MS });
  let ranMs = 0;
  for (const shot of shots) {
    await page.clock.runFor(shot.atMs - ranMs);
    ranMs = shot.atMs;
    await page.screenshot({ path: shot.path });
  }
}

async function badge(page: Page): Promise<string | null> {
  const label = await page.evaluate('document.querySelector(".bc-badge")?.textContent ?? null');
  return label as string | null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { out: { type: 'string', default: 'out/smoke' } },
  });
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const docked = join(out, 'hive-docked.png');
  const sortie = join(out, 'hive-sortie.png');
  const wave30 = join(out, 'hive-wave30.png');

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
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    // A fresh context: empty localStorage, as on a first visit.
    const context = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US' });
    const page = await context.newPage();
    page.on('pageerror', (error) => failures.push(`${current}: page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(`${current}: console error: ${message.text()}`);
    });
    await page.clock.install();

    // The plain page: M1, with nothing of the prototype.
    await open(page, base, '/', INTRO);
    await page.keyboard.press('Enter');
    await page.waitForSelector(HUD, { timeout: LOAD_TIMEOUT_MS });
    await play(page);
    const plainText = await text(page, 'document.body.innerText');
    for (const label of Object.values(BADGES)) {
      check(!plainText.includes(label), `the prototype's badge "${label}" is on the plain page`);
    }
    check((await badge(page)) === null, 'a .bc-badge element is on the plain page');
    const origin = new URL(base).origin;
    const plain = await storageAfterLeaving(page, context, origin);
    for (const key of plain.keys()) {
      check(!key.startsWith(HIVE_SAVE_PREFIX), `the plain page wrote ${key}`);
    }
    const playerSave = plain.get(PLAYER_SAVE);
    check(playerSave !== undefined, `the plain page saved nothing under ${PLAYER_SAVE}`);

    // `?hive`: the preset opens on the talent web; the first run's start for two screenshots.
    await open(page, base, '/?hive', TALENTS);
    check((await badge(page)) === BADGES.en, `the badge reads ${await badge(page)}`);
    const preset = await page.evaluate(
      `window.localStorage.getItem(${JSON.stringify(`${HIVE_SAVE_PREFIX}main`)})`,
    );
    check(preset !== null, 'no preset in the hive slot');
    await startPaused(page, [
      { atMs: DOCKED_AT_MS, path: docked },
      { atMs: SORTIE_AT_MS, path: sortie },
    ]);
    await page.clock.resume();
    await play(page);

    await open(page, base, '/?hive&lang=zh-TW', TALENTS);
    check((await badge(page)) === BADGES['zh-TW'], `the badge reads ${await badge(page)}`);
    await page.keyboard.press('Enter');
    await page.waitForSelector(HUD, { timeout: LOAD_TIMEOUT_MS });
    await play(page);

    // `&wave=30`: its first run starts at wave 30.
    await open(page, base, '/?hive&wave=30', TALENTS);
    await startPaused(page, [{ atMs: WAVE30_AT_MS, path: wave30 }]);
    const wave = await text(page, 'document.querySelector(".bc-hud-wave-number")?.textContent');
    const runLine = await text(page, 'document.querySelector(".bc-hud-sub")?.textContent');
    check(wave === '30', `the first run's HUD shows wave ${wave}`);
    check(/ 30$/.test(runLine), `the first run's HUD reads "${runLine}"`);
    await page.clock.resume();
    await play(page);

    current = 'after the hive pages';
    const after = await storageAfterLeaving(page, context, origin);
    check(after.has(`${HIVE_SAVE_PREFIX}main`), 'no hive save');
    check(after.get(PLAYER_SAVE) === playerSave, `the hive pages changed ${PLAYER_SAVE}`);

    console.log(`played 4 pages for ${PLAY_MS / 1000} s each at 4×; screenshots:`);
    for (const path of [docked, sortie, wave30]) console.log(`  ${path}`);
    console.log(`localStorage keys: ${[...after.keys()].sort().join(', ')}`);
  } finally {
    await browser?.close();
    await server.close();
    // Printed here so that what was found before an error is not lost with it.
    if (failures.length > 0) console.error(`failures:\n  ${failures.join('\n  ')}`);
  }
  if (failures.length > 0) throw new Error(`hive smoke failed: ${failures.length} failure(s)`);
  console.log('hive smoke passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
