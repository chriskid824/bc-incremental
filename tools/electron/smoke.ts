/**
 * ESMOKE, the Steam build's shell in the container (docs/v3 C9 design §2.2, C9/F10; C10 ruling
 * L1): launches Electron on this repository through Playwright's `_electron`, with no Steam
 * running and each run's userData in a fresh temporary folder, and plays the page under xvfb on
 * SwiftShader. The runs:
 *
 * 1. Normal: the intro; the page has no `require` or `process`, and bcNative is exactly the minimal
 *    API; Steam is not connected at stage init, so steamworks.js loaded; no overlay switch;
 *    userData is the temporary folder; the page is denied a permission check (geolocation) and a
 *    request (notifications). 20 s at 4×, Enter each second, then Enter each second until the
 *    first game run has ended and saved main.json (within TIMEOUT_MS, however slow the frames).
 *    After closing, saves/ holds main.json (written as the window closed) and backup.json, both
 *    saves, and no temp.
 * 2. `--steam-check` on run 1's save: the talent web and the check panel (design §2.2); bcNative
 *    carries `check`; the page is denied run 1's permission check and request, as the check mode
 *    permits nothing more; no panel button keeps the focus; [Unlock] logs that Steam is not
 *    connected; [Copy report] puts one report in the textarea, the clipboard and
 *    `<userData>/steam-check/` (not saves/), reading `steam: not-connected stage=init`, with every
 *    path redacted.
 * 3. Garbage in main.json beside run 1's save as backup.json: the page lands on the talent web
 *    from the backup, with a warning and no error.
 *    3b. main.json a directory beside the same backup.json, so its read fails (EISDIR): the bridge
 *    answers a failed read for main, never an empty slot, and the backup's text for backup; the
 *    page lands on the talent web from the backup. After closing, backup.json is unchanged (the
 *    M1 page copies nothing over it when main reads null, and its write of main fails on the
 *    directory) and no temp is left. The shell's one line about the failed read is expected.
 * 4. `--bc-overlay-switches`: the intro without errors while in-process-gpu is set (weak, and
 *    Linux only).
 * 5. `--bc-replay`: `renderStress` reaches the page as `?replay=renderStress`; `a&b` reaches it as
 *    no query, and leaves one line on the terminal.
 *
 * Any error fails it: the page's console errors and exceptions (its console history, read when the
 * run ends, so those from before Playwright attached count), the main process's ring buffer of
 * renderer errors (electron/ipc.ts), the main process's console errors and exceptions (its console
 * history, read through an inspector session in that process), and the main process's error lines
 * on stderr until it exits; only the lines a run expects (finish()'s `lines`, run 3b's alone) are
 * let through. Every run also checks the game window's security settings as Electron applied them
 * (getLastWebPreferences; design §1.3), and that the panel's `[data-check]` elements exist only in
 * the check mode. Each shell's process has exited before its folder is removed.
 *
 *   electron_config_cache=<folder> npm run electron:install   (once: Electron's binary)
 *   xvfb-run -a -s "-screen 0 1280x800x24" npm run smoke:electron [-- --out out/electron-smoke]
 *
 * Playwright is taken from node_modules or the global install, as tools/sheets/capture.ts takes
 * it. Electron's binary must be installed already: this smoke never downloads it.
 */

import { execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { App, BrowserWindow, Clipboard } from 'electron';
import { RECENT_ERRORS_GLOBAL } from '../../electron/ipc';
import { OVERLAY_SWITCHES } from '../../electron/steam';

const ROOT = resolve(import.meta.dirname, '../..');
/** tools/sheets/capture.ts' switches: WebGL on SwiftShader, as there is no GPU. */
const SWIFTSHADER = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];
/** Run 1 plays this long at 4×. */
const PLAY_MS = 20_000;
/** Enter starts the next run from the result screen or the talent web (src/app/input.ts). */
const CONFIRM_EVERY_MS = 1_000;
const TIMEOUT_MS = 60_000;

const INTRO = '.bc-intro:not([hidden])';
const TALENTS = '.bc-talents:not([hidden])';
const HUD = '.bc-hud:not([hidden])';

const BRIDGE_KEYS = '["achievements","steamInfo","storage","version"]';
const CHECK_BRIDGE_KEYS = '["achievements","check","steamInfo","storage","version"]';
const CHECK_KEYS =
  '["clearAchievement","listSaves","openOverlay","recentErrors","saveReport","showSaves"]';
/** The check panel (src/platform/steam/checkPanel.ts) and its parts. */
const PANEL = '[data-check="panel"]';
const PANEL_BUTTONS = 17;
const REPORT_TITLE = 'bc-incremental steam check v1';
/** The game window's security settings (design §1.3), as getLastWebPreferences() must give them. */
const SECURE_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  webSecurity: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
};
const GARBAGE = 'not a save {';
/** Run 3b's failed read of main.json, a directory, as node:fs reports it on Linux. */
const EISDIR_READ = 'EISDIR: illegal operation on a directory, read';
/** The shell's line about it (electron/saveFiles.ts), once in its console and on stderr. */
const READ_FAILED_LINE = `Could not read main.json: ${EISDIR_READ}`;
/** The page's warning if the M1 page's save writes main.json, which the directory refuses. */
const SAVE_FAILED_LINE = 'Save failed EISDIR: illegal operation on a directory, rename';
const REPLAY = 'renderStress';
const BAD_REPLAY = 'a&b';
const BAD_REPLAY_LINE = `Ignoring --bc-replay=${JSON.stringify(BAD_REPLAY)}: a replay is letters, digits, ':' and '.'.`;
/** The first line of what the main process writes to stderr when something fails. */
const MAIN_ERROR_LINE =
  /^(\[renderer\] |Refused bc:|bc:[a-z:-]+ failed: |Could not |Uncaught |A JavaScript error occurred|App threw an error|\(node:\d+\) UnhandledPromiseRejection)/;

/** The part of the Playwright API this script uses. */
interface ConsoleApiCalled {
  readonly type: string;
  readonly args: readonly RemoteObject[];
}
interface RemoteObject {
  readonly value?: unknown;
  readonly description?: string;
}
interface ExceptionThrown {
  readonly exceptionDetails: { readonly text: string; readonly exception?: RemoteObject };
}
interface CdpSession {
  on(event: 'Runtime.consoleAPICalled', listener: (event: ConsoleApiCalled) => void): void;
  on(event: 'Runtime.exceptionThrown', listener: (event: ExceptionThrown) => void): void;
  send(method: 'Runtime.enable'): Promise<unknown>;
  detach(): Promise<void>;
}
interface Page {
  readonly keyboard: { press(key: string): Promise<void> };
  context(): { newCDPSession(page: Page): Promise<CdpSession> };
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  click(selector: string, options: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
}
/** The main process's `electron` module, as Playwright hands it to a function evaluated there. */
interface MainModule {
  readonly app: App;
  readonly BrowserWindow: typeof BrowserWindow;
  readonly clipboard: Clipboard;
}
interface ElectronApplication {
  firstWindow(options: { timeout: number }): Promise<Page>;
  evaluate<R, A>(fn: (electron: MainModule, arg: A) => R, arg: A): Promise<R>;
  process(): ChildProcess;
  close(): Promise<void>;
}
interface Playwright {
  _electron: {
    launch(options: {
      executablePath: string;
      cwd: string;
      args: string[];
      timeout: number;
    }): Promise<ElectronApplication>;
  };
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

/** The installed Electron binary; `require('electron')` would download a missing one (E2). */
function electronBinary(): string {
  const require = createRequire(join(ROOT, 'package.json'));
  const folder = dirname(require.resolve('electron/package.json'));
  const pathFile = join(folder, 'path.txt');
  if (!existsSync(pathFile) || !existsSync(join(folder, 'dist', readFileSync(pathFile, 'utf8')))) {
    throw new Error("Electron's binary is not installed: run `npm run electron:install` first.");
  }
  return require('electron') as string;
}

/** What went wrong, run by run; the smoke fails when it is not empty. */
const failures: string[] = [];
/** The run under way, for the failures. */
let current = 'no run yet';

function check(ok: boolean, what: string): void {
  if (!ok) failures.push(`${current}: ${what}`);
}

/** A console message or an exception, as `type: text`; the type is 'exception' for the latter. */
interface Logged {
  readonly type: string;
  readonly text: string;
}

/**
 * A line finish() fails a run on that the run expects instead: a page warning, a main-process
 * console line, or a line of the main process's output (stderr), starting with `text`. `times` is
 * how often it must appear, or 'any' for a page warning that may come only as the window closes,
 * after finish() has read the page's history.
 */
interface ExpectedLine {
  readonly where: 'page' | 'main' | 'stderr';
  readonly text: string;
  readonly times: number | 'any';
}

/** One launch of the shell, with its own userData. */
interface Shell {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly userData: string;
  readonly saves: string;
  /** The main process's stdout and stderr lines from Playwright's attach until it exits. */
  readonly output: string[];
  /** Resolves when the main process has exited, with its exit code. */
  readonly exited: Promise<number | null>;
}

/** Folders the smoke made, removed at the end. */
const temporary: string[] = [];
/** Shells not closed yet, killed at the end if a run stopped half way. */
const running = new Set<Shell>();

async function launch(
  electron: Playwright['_electron'],
  executablePath: string,
  extra: readonly string[],
  seed: (saves: string) => void = () => {},
): Promise<Shell> {
  const userData = mkdtempSync(join(tmpdir(), 'bc-esmoke-'));
  temporary.push(userData);
  const saves = join(userData, 'saves');
  seed(saves);
  const app = await electron.launch({
    executablePath,
    cwd: ROOT,
    args: [
      ...SWIFTSHADER,
      '--disable-dev-shm-usage',
      '.',
      `--bc-user-data-dir=${userData}`,
      ...extra,
    ],
    timeout: TIMEOUT_MS,
  });
  const child = app.process();
  const output: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (stream !== null) createInterface({ input: stream }).on('line', (line) => output.push(line));
  }
  const exited = new Promise<number | null>((done) => {
    if (child.exitCode !== null) done(child.exitCode);
    else child.once('exit', (code) => done(code));
  });
  const shell = { app, page: null as Page | null, userData, saves, output, exited };
  running.add(shell as Shell);
  const page = await app.firstWindow({ timeout: TIMEOUT_MS });
  return Object.assign(shell, { page }) as Shell;
}

/** The page's console history since it loaded, replayed to a new DevTools session. */
async function pageHistory(page: Page): Promise<Logged[]> {
  const session = await page.context().newCDPSession(page);
  const logged: Logged[] = [];
  session.on('Runtime.consoleAPICalled', (event) =>
    logged.push({ type: event.type, text: event.args.map(describeArg).join(' ') }),
  );
  session.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
    logged.push({
      type: 'exception',
      text: exceptionDetails.exception?.description ?? exceptionDetails.text,
    }),
  );
  await session.send('Runtime.enable');
  await session.detach();
  return logged;
}

function describeArg(arg: RemoteObject): string {
  return arg.value === undefined ? (arg.description ?? '') : String(arg.value);
}

/**
 * The main process's console history since it started: what the shell printed to the terminal,
 * replayed to an inspector session opened in that process (Playwright's `--inspect` keeps it).
 */
function mainHistory(shell: Shell): Promise<Logged[]> {
  return shell.app.evaluate(() => {
    const inspector = process.getBuiltinModule('node:inspector');
    const session = new inspector.Session();
    const logged: { type: string; text: string }[] = [];
    session.connect();
    session.on('Runtime.consoleAPICalled', ({ params }) => {
      const text = params.args.map((arg) =>
        arg.value === undefined ? (arg.description ?? '') : String(arg.value),
      );
      logged.push({ type: params.type, text: text.join(' ') });
    });
    session.on('Runtime.exceptionThrown', ({ params }) => {
      const details = params.exceptionDetails;
      logged.push({ type: 'exception', text: details.exception?.description ?? details.text });
    });
    session.post('Runtime.enable');
    session.post('Runtime.disable');
    session.disconnect();
    return logged;
  }, null);
}

/**
 * What the main process knows: userData, the overlay's switches, its windows, the ring buffer, and
 * the game window's security settings (getLastWebPreferences(), which Electron 44's typings leave
 * out).
 */
function mainFacts(shell: Shell) {
  return shell.app.evaluate(
    ({ app, BrowserWindow }, { key, switches, preferences }) => {
      const recent: unknown = Reflect.get(globalThis, key);
      const windows = BrowserWindow.getAllWindows();
      const contents = windows[0]?.webContents;
      const read: unknown =
        contents === undefined ? undefined : Reflect.get(contents, 'getLastWebPreferences');
      const last: unknown = typeof read === 'function' ? read.call(contents) : null;
      return {
        userData: app.getPath('userData'),
        switches: switches.filter((name) => app.commandLine.hasSwitch(name)),
        windows: windows.length,
        recentErrors: typeof recent === 'function' ? (recent() as string[]) : null,
        preferences:
          typeof last === 'object' && last !== null
            ? Object.fromEntries(preferences.map((name) => [name, Reflect.get(last, name)]))
            : null,
      };
    },
    {
      key: RECENT_ERRORS_GLOBAL,
      switches: [...OVERLAY_SWITCHES],
      preferences: Object.keys(SECURE_PREFERENCES),
    },
  );
}

/** The page's view of the shell, from its bridge. */
interface ShellView {
  readonly checkMode: boolean;
  readonly steam: { readonly ok: boolean; readonly stage?: string; readonly error?: string };
  readonly overlaySwitches: readonly string[];
  readonly saveDir: string;
  readonly versions: { readonly electron: string; readonly steamworks: string | null };
}

/** The bridge's steamInfo(), or null (a failure) when main refused the page or answered nothing. */
async function shellView(page: Page): Promise<ShellView | null> {
  const view = (await page.evaluate('window.bcNative.steamInfo()')) as ShellView | null;
  check(view !== null, 'steamInfo() answered null');
  return view;
}

/**
 * Reads both processes' histories and the main process's facts, checks what every run must
 * hold, closes the shell and waits for it to exit. Returns the two histories. A line that fails a
 * run fails it unless the run expects it (`lines`, none by default), and each expected line must
 * appear as often as it says.
 */
async function finish(
  shell: Shell,
  expect: {
    readonly switches: readonly string[];
    readonly ignored: readonly string[];
    readonly checkMode: boolean;
    readonly lines?: readonly ExpectedLine[];
  },
): Promise<{ page: Logged[]; main: Logged[] }> {
  const page = await pageHistory(shell.page);
  const main = await mainHistory(shell);
  const facts = await mainFacts(shell);
  const lines = expect.lines ?? [];
  const seen = new Map<ExpectedLine, number>();
  /** Whether the run expects `text` in `where`; counted if so. */
  const expected = (where: ExpectedLine['where'], text: string): boolean => {
    const line = lines.find((entry) => entry.where === where && text.startsWith(entry.text));
    if (line !== undefined) seen.set(line, (seen.get(line) ?? 0) + 1);
    return line !== undefined;
  };
  for (const line of page) {
    const failed =
      line.type === 'error' ||
      line.type === 'exception' ||
      (line.type === 'warning' && line.text.startsWith('Save failed'));
    check(!failed || expected('page', line.text), `page ${line.type}: ${line.text}`);
  }
  for (const line of main) {
    const failed =
      line.type === 'error' ||
      line.type === 'exception' ||
      (line.type === 'warning' && line.text.startsWith('Could not'));
    check(!failed || expected('main', line.text), `main ${line.type}: ${line.text}`);
  }
  check(facts.recentErrors !== null, `no ${RECENT_ERRORS_GLOBAL} in the main process`);
  for (const line of facts.recentErrors ?? []) check(false, `ring buffer: ${line}`);
  check(facts.userData === shell.userData, `userData is ${facts.userData}`);
  check(facts.windows === 1, `${facts.windows} windows`);
  check(
    JSON.stringify(facts.preferences) === JSON.stringify(SECURE_PREFERENCES),
    `the window's web preferences are ${JSON.stringify(facts.preferences)}`,
  );
  check(
    JSON.stringify(facts.switches) === JSON.stringify(expect.switches),
    `the overlay switches set are ${JSON.stringify(facts.switches)}`,
  );
  const steamLines = main.filter((line) => line.text.startsWith('Steam: '));
  check(
    steamLines.length === 1 &&
      steamLines[0]?.text.startsWith('Steam: NOT connected (init): ') === true,
    `the terminal's Steam lines are ${JSON.stringify(steamLines)}`,
  );
  const ignored = main.filter((line) => line.text.startsWith('Ignoring ')).map((line) => line.text);
  check(
    JSON.stringify(ignored) === JSON.stringify(expect.ignored),
    `the terminal's ignored arguments are ${JSON.stringify(ignored)}`,
  );
  // The check panel, and the bridge's check, only in the check mode.
  const panelParts = Number(
    await shell.page.evaluate("document.querySelectorAll('[data-check]').length"),
  );
  check(
    expect.checkMode ? panelParts > 0 : panelParts === 0,
    `the page has ${panelParts} [data-check] elements`,
  );
  const hasCheck = await shell.page.evaluate("'check' in window.bcNative");
  check(hasCheck === expect.checkMode, `'check' in bcNative is ${String(hasCheck)}`);
  const view = await shellView(shell.page);
  if (view !== null) {
    check(view.checkMode === expect.checkMode, `checkMode is ${String(view.checkMode)}`);
    check(
      view.steam.ok === false && view.steam.stage === 'init',
      `steam is ${JSON.stringify(view.steam)}`,
    );
    check(
      JSON.stringify(view.overlaySwitches) === JSON.stringify(expect.switches),
      `steamInfo's overlaySwitches are ${JSON.stringify(view.overlaySwitches)}`,
    );
    check(view.saveDir === shell.saves, `saveDir is ${view.saveDir}`);
  }

  await close(shell);
  for (const line of shell.output) {
    check(!MAIN_ERROR_LINE.test(line) || expected('stderr', line), `main stderr: ${line}`);
  }
  for (const line of lines) {
    const times = seen.get(line) ?? 0;
    check(
      line.times === 'any' || times === line.times,
      `${line.where} said ${JSON.stringify(line.text)} ${times} times, not ${line.times}`,
    );
  }
  console.log(`${current}: the terminal said`);
  for (const line of main) console.log(`  [${line.type}] ${line.text}`);
  for (const line of page.filter((entry) => entry.type === 'warning')) {
    console.log(`  page warning: ${line.text.split('\n')[0]}`);
  }
  return { page, main };
}

/** Closes the shell (app.quit(), so the page's pagehide saves), or kills it after TIMEOUT_MS. */
async function close(shell: Shell): Promise<void> {
  running.delete(shell);
  if ((await within(shell.app.close(), TIMEOUT_MS)) === 'timeout') {
    check(false, `the shell did not close in ${TIMEOUT_MS} ms`);
    shell.app.process().kill('SIGKILL');
  }
  const code = await within(shell.exited, TIMEOUT_MS);
  check(code === 0, `the main process exited with ${String(code)}`);
}

/** Removes `folder`, and once more a second later if something wrote to it meanwhile. */
async function remove(folder: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      if (attempt === 2) console.error(`Could not remove ${folder}: ${String(error)}`);
    }
    if (!existsSync(folder) || attempt === 2) break;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  current = 'cleanup';
  check(!existsSync(folder), `${folder} is still there`);
}

/** `promise`'s value, or 'timeout' after `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((done) => {
    timer = setTimeout(() => done('timeout'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The save files' names in `saves`, and each slot's parsed save. */
function savesIn(saves: string) {
  const names = existsSync(saves) ? readdirSync(saves).sort() : [];
  const parse = (name: string): { game?: unknown; savedAt?: unknown } | null => {
    try {
      return JSON.parse(readFileSync(join(saves, name), 'utf8')) as { game?: unknown };
    } catch {
      return null;
    }
  };
  return { names, main: parse('main.json'), backup: parse('backup.json') };
}

/**
 * The window's one permission is the clipboard's (design §1.3), in the check mode too: a
 * permission check (geolocation) and a request (notifications) both fail.
 */
async function checkPermissionsDenied(page: Page): Promise<void> {
  const geolocation = await page.evaluate(
    "navigator.permissions.query({ name: 'geolocation' }).then((status) => status.state)",
  );
  check(geolocation === 'denied', `geolocation's permission is ${String(geolocation)}`);
  const notifications = await page.evaluate('Notification.requestPermission()');
  check(notifications === 'denied', `a notification request answered ${String(notifications)}`);
}

async function runNormal(electron: Playwright['_electron'], binary: string, out: string) {
  current = 'run 1 (normal)';
  const shell = await launch(electron, binary, []);
  const { page } = shell;
  await page.waitForSelector(INTRO, { timeout: TIMEOUT_MS });
  await page.screenshot({ path: join(out, 'run1-intro.png') });
  check((await page.evaluate('typeof window.require')) === 'undefined', 'window.require exists');
  check((await page.evaluate('typeof window.process')) === 'undefined', 'window.process exists');
  const keys = await page.evaluate('JSON.stringify(Object.keys(window.bcNative).sort())');
  check(keys === BRIDGE_KEYS, `bcNative's keys are ${String(keys)}`);
  check((await page.evaluate("'check' in window.bcNative")) === false, 'bcNative has check');
  check((await page.evaluate('location.search')) === '', 'the page has a query');
  const view = await shellView(page);
  console.log(
    `${current}: electron ${view?.versions.electron}, steamworks.js ${view?.versions.steamworks}, ` +
      `steam ${JSON.stringify(view?.steam)}`,
  );

  await checkPermissionsDenied(page);

  await page.keyboard.press('Enter');
  await page.waitForSelector(HUD, { timeout: TIMEOUT_MS });
  await page.keyboard.press('4');
  for (let waited = 0; waited < PLAY_MS; waited += CONFIRM_EVERY_MS) {
    await page.waitForTimeout(CONFIRM_EVERY_MS);
    if (waited === PLAY_MS / 2) await page.screenshot({ path: join(out, 'run1-play.png') });
    await page.keyboard.press('Enter');
  }
  // On until the first game run has ended and saved, however slow the frames (the first run at
  // seed 1000 lasts 53 s of game time; a busy container needs more than 20 s for it at 4×).
  const saved = join(shell.saves, 'main.json');
  let extra = 0;
  for (; !existsSync(saved) && extra < TIMEOUT_MS; extra += CONFIRM_EVERY_MS) {
    await page.waitForTimeout(CONFIRM_EVERY_MS);
    await page.keyboard.press('Enter');
  }
  check(existsSync(saved), `no main.json after ${PLAY_MS + extra} ms at 4×`);
  console.log(`${current}: main.json was there after ${PLAY_MS + extra} ms at 4×`);
  const closing = new Date().toISOString();
  await finish(shell, { switches: [], ignored: [], checkMode: false });

  const saves = savesIn(shell.saves);
  check(
    JSON.stringify(saves.names) === '["backup.json","main.json"]',
    `saves/ holds ${JSON.stringify(saves.names)}`,
  );
  check(saves.main?.game === 'bc-incremental', 'main.json is not a save');
  check(saves.backup?.game === 'bc-incremental', 'backup.json is not a save');
  const savedAt = String(saves.main?.savedAt);
  check(
    savedAt >= closing,
    `main.json was saved at ${savedAt}, before the window closed (${closing})`,
  );
  console.log(`${current}: saves/ holds ${saves.names.join(', ')}; main.json saved at ${savedAt}`);
  return readFileSync(join(shell.saves, 'main.json'), 'utf8');
}

/** The text of the panel's element named `name` (its data-check), or null without one. */
async function panelText(page: Page, name: string): Promise<string | null> {
  const text = await page.evaluate(
    `document.querySelector('[data-check=${JSON.stringify(name)}]')?.textContent ?? null`,
  );
  return typeof text === 'string' ? text : null;
}

async function runCheck(
  electron: Playwright['_electron'],
  binary: string,
  out: string,
  save: string,
) {
  current = 'run 2 (--steam-check)';
  const shell = await launch(electron, binary, ['--steam-check'], (saves) => {
    mkdirSync(saves, { recursive: true });
    writeFileSync(join(saves, 'main.json'), save);
  });
  const { page } = shell;
  await page.waitForSelector(TALENTS, { timeout: TIMEOUT_MS });
  await page.waitForSelector(PANEL, { timeout: TIMEOUT_MS });
  const keys = await page.evaluate('JSON.stringify(Object.keys(window.bcNative).sort())');
  check(keys === CHECK_BRIDGE_KEYS, `bcNative's keys are ${String(keys)}`);
  const checkKeys = await page.evaluate(
    'JSON.stringify(Object.keys(window.bcNative.check).sort())',
  );
  check(checkKeys === CHECK_KEYS, `bcNative.check's keys are ${String(checkKeys)}`);
  // The check mode permits nothing more than the normal one.
  await checkPermissionsDenied(page);
  const steam = await panelText(page, 'steam');
  check(
    steam?.startsWith('Steam: NOT connected (init): ') === true,
    `the panel's Steam line is ${JSON.stringify(steam)}`,
  );
  const buttons = await page.evaluate(
    `JSON.stringify([...document.querySelectorAll('${PANEL} button')].map((button) => button.tabIndex))`,
  );
  check(
    buttons === JSON.stringify(Array.from({ length: PANEL_BUTTONS }, () => -1)),
    `the panel's buttons' tabIndex are ${String(buttons)}`,
  );
  const readOnly = await page.evaluate(`document.querySelector('[data-check="report"]').readOnly`);
  check(readOnly === true, 'the report textarea is not read-only');

  // [Unlock] without Steam: logged as not connected, and the button lets the focus go.
  await page.click('[data-check="unlock"]', { timeout: TIMEOUT_MS });
  const logged = await panelText(page, 'ach-log');
  check(
    /^\d\d:\d\d:\d\d Unlock returned=no now=unknown \(Steam not connected\)$/.test(logged ?? ''),
    `the panel logged ${JSON.stringify(logged)}`,
  );
  const focused = await page.evaluate('document.activeElement?.tagName ?? null');
  check(focused !== 'BUTTON', `a ${String(focused)} kept the focus after [Unlock]`);
  await page.click('[data-check="open-overlay"]', { timeout: TIMEOUT_MS });
  await page.click('[data-check="overlay_page=nothing"]', { timeout: TIMEOUT_MS });
  await page.click('[data-check="refresh"]', { timeout: TIMEOUT_MS });
  const files = await panelText(page, 'save-files');
  check(files?.startsWith('main.json ') === true, `the panel lists ${JSON.stringify(files)}`);

  // [Copy report]: one report in the textarea, the clipboard and steam-check/.
  await page.click('[data-check="copy-report"]', { timeout: TIMEOUT_MS });
  await page.waitForTimeout(1_000);
  const status = await panelText(page, 'report-status');
  const shown = String(
    await page.evaluate(`document.querySelector('[data-check="report"]').value`),
  );
  const reports = join(shell.userData, 'steam-check');
  const written = existsSync(reports) ? readdirSync(reports) : [];
  check(
    written.length === 1 && /^report-[\dT-]+Z\.txt$/.test(written[0] ?? ''),
    `steam-check/ holds ${JSON.stringify(written)}`,
  );
  const file = written.length === 1 ? readFileSync(join(reports, written[0] ?? ''), 'utf8') : '';
  check(file === shown, 'the saved report differs from the textarea');
  check(
    status === `Copied to the clipboard. Saved as ${join(reports, written[0] ?? '')}.`,
    `the panel says ${JSON.stringify(status)}`,
  );
  const copied = await shell.app.evaluate(({ clipboard }) => clipboard.readText(), null);
  check(copied === shown, 'the clipboard holds another text than the textarea');
  const lines = shown.split('\n');
  check(lines[0] === REPORT_TITLE, `the report starts ${JSON.stringify(lines[0])}`);
  const steamLine = lines.find((line) => line.startsWith('steam: '));
  check(
    steamLine?.startsWith('steam: not-connected stage=init error="') === true,
    `the report's steam line is ${JSON.stringify(steamLine)}`,
  );
  const savesLine = lines.find((line) => line.startsWith('saves: '));
  check(
    savesLine === 'saves: <path>   autocloud: LinuxHome .config/bc-incremental/saves *.json',
    `the report's saves line is ${JSON.stringify(savesLine)}`,
  );
  check(
    lines.includes(
      'answers: hint_at_start=unknown unlock_popup=unknown shift_tab=unknown overlay_page=nothing',
    ),
    'the report does not say what the panel was answered',
  );
  check(
    lines.includes('ach: before=unknown | unlock returned=no now=unknown'),
    'the report does not log [Unlock]',
  );
  for (const absolute of [shell.userData, tmpdir(), '/root/', '/home/']) {
    check(!shown.includes(absolute), `the report holds ${absolute}`);
  }
  await page.screenshot({ path: join(out, 'check-panel.png') });
  console.log(`${current}: the report, ${lines.length - 1} lines:`);
  for (const line of lines.slice(0, -1)) console.log(`  ${line}`);

  await finish(shell, { switches: [], ignored: [], checkMode: true });
  // Reports stay out of saves/, where Auto-Cloud's *.json looks.
  const saves = savesIn(shell.saves).names;
  check(
    saves.every((name) => name === 'main.json' || name === 'backup.json'),
    `saves/ holds ${JSON.stringify(saves)}`,
  );
}

async function runGarbage(
  electron: Playwright['_electron'],
  binary: string,
  out: string,
  backup: string,
) {
  current = 'run 3 (garbage main.json)';
  const shell = await launch(electron, binary, [], (saves) => {
    mkdirSync(saves, { recursive: true });
    writeFileSync(join(saves, 'main.json'), GARBAGE);
    writeFileSync(join(saves, 'backup.json'), backup);
  });
  await shell.page.waitForSelector(TALENTS, { timeout: TIMEOUT_MS });
  await shell.page.screenshot({ path: join(out, 'run3-backup.png') });
  const read = await shell.page.evaluate("window.bcNative.storage.read('main')");
  check(
    JSON.stringify(read) === JSON.stringify({ ok: true, text: GARBAGE }),
    `main.json reads as ${JSON.stringify(read)}`,
  );
  const { page } = await finish(shell, { switches: [], ignored: [], checkMode: false });
  const warned = page.filter(
    (line) => line.type === 'warning' && line.text.startsWith('Ignoring main save:'),
  );
  check(warned.length === 1, `the page warned ${warned.length} times about main.json`);
  // src/app/main.ts' save() copies main over backup whatever main holds (design §0.5, C8.3).
  const after = readFileSync(join(shell.saves, 'backup.json'), 'utf8');
  console.log(
    `${current}: after closing, backup.json ${after === GARBAGE ? 'holds the garbage main.json' : 'is a save'}`,
  );
}

async function runReadFailed(
  electron: Playwright['_electron'],
  binary: string,
  out: string,
  backup: string,
) {
  current = 'run 3b (main.json unreadable)';
  const shell = await launch(electron, binary, [], (saves) => {
    mkdirSync(join(saves, 'main.json'), { recursive: true });
    writeFileSync(join(saves, 'backup.json'), backup);
  });
  const { page } = shell;
  await page.waitForSelector(TALENTS, { timeout: TIMEOUT_MS });
  await page.screenshot({ path: join(out, 'run3b-read-failed.png') });
  // A failed read, never an empty slot (the lead's ruling SR3): the M1 page reads it as null.
  const main = await page.evaluate("window.bcNative.storage.read('main')");
  check(
    JSON.stringify(main) === JSON.stringify({ ok: false, error: EISDIR_READ }),
    `main.json reads as ${JSON.stringify(main)}`,
  );
  const read = await page.evaluate("window.bcNative.storage.read('backup')");
  check(
    JSON.stringify(read) === JSON.stringify({ ok: true, text: backup }),
    `backup.json reads as ${JSON.stringify(read)?.slice(0, 80)}`,
  );
  await finish(shell, {
    switches: [],
    ignored: [],
    checkMode: false,
    lines: [
      { where: 'main', text: READ_FAILED_LINE, times: 1 },
      { where: 'stderr', text: READ_FAILED_LINE, times: 1 },
      { where: 'page', text: SAVE_FAILED_LINE, times: 'any' },
    ],
  });
  const names = existsSync(shell.saves) ? readdirSync(shell.saves).sort() : [];
  check(
    JSON.stringify(names) === '["backup.json","main.json"]',
    `saves/ holds ${JSON.stringify(names)}`,
  );
  check(statSync(join(shell.saves, 'main.json')).isDirectory(), 'main.json is not a directory');
  const after = readFileSync(join(shell.saves, 'backup.json'));
  check(after.equals(Buffer.from(backup, 'utf8')), 'backup.json changed');
  console.log(
    `${current}: after closing, saves/ holds ${names.join(', ')}; backup.json ` +
      `${after.equals(Buffer.from(backup, 'utf8')) ? 'is unchanged' : 'changed'}`,
  );
}

async function runOverlaySwitches(electron: Playwright['_electron'], binary: string, out: string) {
  current = 'run 4 (--bc-overlay-switches)';
  const shell = await launch(electron, binary, ['--bc-overlay-switches']);
  await shell.page.waitForSelector(INTRO, { timeout: TIMEOUT_MS });
  await shell.page.screenshot({ path: join(out, 'run4-overlay-switches.png') });
  await finish(shell, { switches: [...OVERLAY_SWITCHES], ignored: [], checkMode: false });
}

async function runReplay(electron: Playwright['_electron'], binary: string, out: string) {
  current = `run 5a (--bc-replay=${REPLAY})`;
  const taken = await launch(electron, binary, [`--bc-replay=${REPLAY}`]);
  // C10.5a: ?replay= opens the replay page, a canvas of its own, instead of the game.
  await taken.page.waitForSelector('canvas', { timeout: TIMEOUT_MS });
  await taken.page.screenshot({ path: join(out, 'run5-replay.png') });
  const search = await taken.page.evaluate('location.search');
  check(search === `?replay=${REPLAY}`, `location.search is ${JSON.stringify(search)}`);
  await finish(taken, { switches: [], ignored: [], checkMode: false });

  current = `run 5b (--bc-replay=${BAD_REPLAY})`;
  const ignored = await launch(electron, binary, [`--bc-replay=${BAD_REPLAY}`]);
  const { page } = ignored;
  await page.waitForSelector(INTRO, { timeout: TIMEOUT_MS });
  await page.screenshot({ path: join(out, 'run5-replay-ignored.png') });
  const empty = await page.evaluate('location.search');
  check(empty === '', `location.search is ${JSON.stringify(empty)}`);
  // The window's other rules (design §1.3): no navigation away, no new window.
  const opened = await page.evaluate("window.open('about:blank') === null");
  check(opened === true, 'window.open opened a window');
  await page.evaluate("location.assign('file:///'); 'navigating'");
  await page.waitForTimeout(1_000);
  const href = String(await page.evaluate('location.href'));
  check(href.endsWith('/dist-steam/index.html'), `the page navigated to ${href}`);
  await finish(ignored, { switches: [], ignored: [BAD_REPLAY_LINE], checkMode: false });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { out: { type: 'string', default: 'out/electron-smoke' } },
  });
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const binary = electronBinary();
  const { _electron: electron } = loadPlaywright();
  try {
    const save = await runNormal(electron, binary, out);
    await runCheck(electron, binary, out, save);
    await runGarbage(electron, binary, out, save);
    await runReadFailed(electron, binary, out, save);
    await runOverlaySwitches(electron, binary, out);
    await runReplay(electron, binary, out);
    console.log(`screenshots in ${out}:`);
    for (const name of readdirSync(out).sort()) console.log(`  ${name}`);
  } finally {
    // Every shell's process has exited before its folder goes, so that no late write of
    // Chromium's leaves a file behind; a folder still there after its removal gets one more.
    for (const shell of running) shell.app.process().kill('SIGKILL');
    await Promise.all([...running].map((shell) => within(shell.exited, TIMEOUT_MS)));
    for (const folder of temporary) await remove(folder);
    // Printed here so that what was found before an error is not lost with it.
    if (failures.length > 0) console.error(`failures:\n  ${failures.join('\n  ')}`);
  }
  if (failures.length > 0) throw new Error(`electron smoke failed: ${failures.length} failure(s)`);
  console.log('electron smoke passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
