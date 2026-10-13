/**
 * Captures the construct reference sheet (sheet.html, src/app/sheet.ts) to PNGs for the capsule
 * art brief (docs/v3/game-design-v3.md §11.8): the whole sheet plus one image per construct.
 * Starts a Vite dev server, opens the sheet in headless Chromium through Playwright and waits
 * for the page's ready flag.
 *
 *   npx tsx tools/sheets/capture.ts [--out out/sheets] [--scale 2]
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
const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The part of the Playwright API this script uses. */
interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: 'string', default: 'out/sheets' },
      scale: { type: 'string', default: '2' },
    },
  });
  const out = resolve(values.out);
  const scale = Number(values.scale);
  if (!(scale > 0)) throw new Error(`--scale must be a positive number, got '${values.scale}'`);
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
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: scale });
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    await page.goto(new URL('sheet.html', base).href);
    await page.waitForSelector(READY, { timeout: READY_TIMEOUT_MS }).catch((error: unknown) => {
      throw errors[0] ?? error;
    });
    if (errors.length > 0) throw errors[0];

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
    console.log(`wrote ${written.length} PNGs at device scale ${scale}:`);
    for (const path of written) console.log(`  ${path}`);
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
