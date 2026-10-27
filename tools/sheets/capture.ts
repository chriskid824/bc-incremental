/**
 * Captures the construct reference sheet (sheet.html, src/app/sheet.ts) to PNGs for the capsule
 * art brief (docs/v3/game-design-v3.md §11.8): the whole sheet plus one image per construct.
 * Starts a Vite dev server, opens the sheet in headless Chromium through Playwright and waits
 * for the page's ready flag.
 *
 * It also captures the enemy grid (`/?enemies&step=1`, src/app/enemies/route.ts; docs/v3 C7
 * design §2.9): every v3 type and every affix, at the frames where each behaviour shows, the
 * whole arena and close-ups of its two rows, and the banner's first line in zh-TW. The grid's
 * step mode draws at resolution 1, as the replay's, so it is shot at 1:1 arena pixels
 * (deviceScaleFactor 1); `--scale` is the construct sheet's. `--only constructs|enemies` takes
 * one of the two.
 *
 *   npx tsx tools/sheets/capture.ts [--out out/sheets] [--scale 2] [--only constructs|enemies]
 *
 * Playwright is not a project dependency: the script takes it from node_modules if it is there,
 * else from the global install (`npm root -g`), and uses that install's Chromium. Headless
 * Chromium has no GPU, so WebGL runs on SwiftShader.
 */

import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';

const READY = 'html[data-sheet-ready="true"]';
const READY_TIMEOUT_MS = 30_000;
/** Wide enough for the sheet's fixed 1340 px layout; the height grows with the full-page shot. */
const VIEWPORT = { width: 1340, height: 900 };
/** The enemy grid's page, its ready flag, and the arena at 1:1. */
const ENEMIES = '/?enemies&step=1';
const ENEMIES_READY = 'html[data-enemies-ready="true"]';
const ENEMIES_VIEWPORT = { width: 1920, height: 1080 };
/**
 * The frames shot, one tick each: 20, 衝刺者 red in its charge and 盾兵's line; 300, bullets in
 * flight, 召喚者's triangles, the shield's arc and the second line; 600, 寶藏怪 fleeing.
 */
const ENEMIES_FRAMES = [20, 300, 600] as const;
/** Each shot waits this long after its step: the banner's slide (.bc-banner, 250 ms) settles. */
const BANNER_SETTLE_MS = 400;
/** Close-ups of frame 300 in arena pixels: the types' row above the player, the affixes' below. */
const ENEMIES_CLIPS = {
  types: { x: 280, y: 180, width: 1360, height: 260 },
  affixes: { x: 340, y: 680, width: 1240, height: 230 },
} as const;
const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The part of the Playwright API this script uses. */
interface Clip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean; clip?: Clip }): Promise<unknown>;
  locator(selector: string): { screenshot(options: { path: string }): Promise<unknown> };
  on(event: 'pageerror', listener: (error: Error) => void): void;
}
interface Browser {
  newPage(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  }): Promise<Page>;
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

/** A page at `url` once `ready` shows; it throws the first page error, if any. */
async function openPage(
  browser: Browser,
  url: string,
  ready: string,
  viewport: { width: number; height: number },
  scale: number,
): Promise<Page> {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto(url);
  await page.waitForSelector(ready, { timeout: READY_TIMEOUT_MS }).catch((error: unknown) => {
    throw errors[0] ?? error;
  });
  if (errors.length > 0) throw errors[0];
  return page;
}

/** The construct sheet, whole and one image per construct. */
async function captureConstructs(
  browser: Browser,
  base: string,
  out: string,
  scale: number,
): Promise<string[]> {
  const page = await openPage(browser, new URL('sheet.html', base).href, READY, VIEWPORT, scale);
  const written: string[] = [];
  const sheet = join(out, 'constructs-sheet.png');
  await page.screenshot({ path: sheet, fullPage: true });
  written.push(sheet);
  const ids = (await page.evaluate(
    'Array.from(document.querySelectorAll("section[data-construct]"), (s) => s.dataset.construct)',
  )) as string[];
  for (const id of ids) {
    const path = join(out, `construct-${id}.png`);
    await page.locator(`section[data-construct="${id}"]`).screenshot({ path });
    written.push(path);
  }
  return written;
}

const frameName = (frame: number): string => `frame${String(frame).padStart(4, '0')}`;

/** The enemy grid at each of ENEMIES_FRAMES, frame 300's close-ups, and zh-TW's first line. */
async function captureEnemies(browser: Browser, base: string, out: string): Promise<string[]> {
  const written: string[] = [];
  const page = await openPage(
    browser,
    new URL(ENEMIES, base).href,
    ENEMIES_READY,
    ENEMIES_VIEWPORT,
    1,
  );
  let at = 0;
  for (const frame of ENEMIES_FRAMES) {
    await page.evaluate(`window.__enemies.step(${frame - at})`);
    await page.waitForTimeout(BANNER_SETTLE_MS);
    at = frame;
    const path = join(out, `enemies-${frameName(frame)}.png`);
    await page.screenshot({ path });
    written.push(path);
    if (frame !== 300) continue;
    for (const [name, clip] of Object.entries(ENEMIES_CLIPS)) {
      const close = join(out, `enemies-${name}-${frameName(frame)}.png`);
      await page.screenshot({ path: close, clip });
      written.push(close);
    }
  }
  const zh = await openPage(
    browser,
    new URL(`${ENEMIES}&lang=zh-TW`, base).href,
    ENEMIES_READY,
    ENEMIES_VIEWPORT,
    1,
  );
  const first = ENEMIES_FRAMES[0];
  await zh.evaluate(`window.__enemies.step(${first})`);
  await zh.waitForTimeout(BANNER_SETTLE_MS);
  const path = join(out, `enemies-zh-TW-${frameName(first)}.png`);
  await zh.screenshot({ path });
  written.push(path);
  return written;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: 'string', default: 'out/sheets' },
      scale: { type: 'string', default: '2' },
      only: { type: 'string' },
    },
  });
  const out = resolve(values.out);
  const scale = Number(values.scale);
  if (!(scale > 0)) throw new Error(`--scale must be a positive number, got '${values.scale}'`);
  const only = values.only;
  if (only !== undefined && only !== 'constructs' && only !== 'enemies') {
    throw new Error(`--only must be constructs or enemies, got '${only}'`);
  }
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
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    if (only !== 'enemies') {
      const written = await captureConstructs(browser, base, out, scale);
      console.log(`wrote ${written.length} construct PNGs at device scale ${scale}:`);
      for (const path of written) console.log(`  ${path}`);
    }
    if (only !== 'constructs') {
      const written = await captureEnemies(browser, base, out);
      console.log(`wrote ${written.length} enemy grid PNGs at device scale 1:`);
      for (const path of written) console.log(`  ${path}`);
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
