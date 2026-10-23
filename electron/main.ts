/**
 * The Steam build's Electron main process (docs/v3 C9 design §1.5), run from source with
 * `npm run electron` (C9/F2). Before Electron is ready it sets userData, takes the single-instance
 * lock in it, starts Steam (App ID 480, Spacewar) with the overlay's Chromium switches, which only
 * take effect this early, and registers the bridge's channels; once ready it opens the game window
 * on dist-steam/index.html, the page `vite build --mode steam` makes. Without Steam the game plays
 * on, saving to files and keeping achievements locally (C9/F6).
 *
 * `--steam-check` (`npm run steam:check`) adds the check mode's channels for the page's check
 * panel (design §2.2): clearing the achievement, the overlay's dialogs, the save files, and the
 * report saved beside them in userData's steam-check/ folder.
 *
 * Never restartAppIfNecessary (this is a dev run from a terminal), and never
 * disableHardwareAcceleration (it can break the overlay; C9/F7).
 */

import { BrowserWindow, app, dialog, ipcMain, session, shell } from 'electron';
import type { WebContents } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_VERSION } from '../src/platform/steam/bridge';
import type { ShellInfo, SteamStatus } from '../src/platform/steam/bridge';
import { parseShellArgs } from './args';
import type { Channel } from './channels';
import {
  RECENT_ERRORS_GLOBAL,
  RecentErrors,
  createHandlers,
  isGamePage,
  registerSync,
} from './ipc';
import { autoCloudRow, reportDirOf, saveDirOf, shownPath, userDataDir } from './paths';
import { openSaveFiles, writeReport } from './saveFiles';
import { SPACEWAR_APP_ID, startSteam } from './steam';
import type { SteamworksModule } from './steam';

/**
 * The one permission the page may have, in every mode: writing the clipboard (only [Copy report],
 * in the check mode, uses it).
 */
const PERMITTED = 'clipboard-sanitized-write';

const args = parseShellArgs(process.argv.slice(1));
const appPath = app.getAppPath();

// (1) userData, before anything reads it and before the lock, which lives in it.
const userData = userDataDir(app.getPath('appData'), args.userDataDir);
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

// (2) One instance per userData, so the save files have one writer.
if (app.requestSingleInstanceLock()) start();
else app.quit();

function start(): void {
  // (3) What the shell's arguments left out.
  for (const line of args.ignored) console.warn(line);

  // (4) Steam, then the overlay's switches only if it started (or --bc-overlay-switches).
  const appRequire = createRequire(join(appPath, 'package.json'));
  const steam = startSteam({
    appId: SPACEWAR_APP_ID,
    load: () => appRequire('steamworks.js') as SteamworksModule,
    clock: () => performance.now(),
    forceOverlaySwitches: args.overlaySwitches,
  });
  console.log(steamLine(steam.status));
  const steamworksVersion = packageVersion(appRequire, 'steamworks.js');

  // (5) The bridge's channels. Nothing is trusted until the game window exists.
  const pageDir = join(appPath, 'dist-steam');
  const saveDir = saveDirOf(userData);
  const saves = openSaveFiles(saveDir);
  let game: WebContents | null = null;
  const info = (): ShellInfo => ({
    bridgeVersion: BRIDGE_VERSION,
    checkMode: args.checkMode,
    steam: steam.status,
    overlaySwitches: steam.overlaySwitches,
    saveDir,
    saveDirShown: shownPath(saveDir, {
      home: app.getPath('home'),
      appData: app.getPath('appData'),
    }),
    autoCloud: autoCloudRow(),
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      steamworks: steamworksVersion,
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      release: release(),
      translated: app.runningUnderARM64Translation,
    },
    gpu: compactGpu(app.getGPUFeatureStatus()),
  });
  // The renderer's errors, echoed to the terminal; the check's report and the smoke read them.
  const errors = new RecentErrors((line) => console.error(`[renderer] ${line}`));
  Reflect.set(globalThis, RECENT_ERRORS_GLOBAL, () => errors.list());

  const reportDir = reportDirOf(userData);
  const handlers = createHandlers({
    info,
    saves,
    steam,
    checkMode: args.checkMode,
    saveReport: (text) => writeReport(reportDir, text),
    // main.json selected in its folder, once there is one; else the folder itself.
    showSaves: () =>
      shell.showItemInFolder(
        saves.list().some(({ name }) => name === 'main.json')
          ? join(saveDir, 'main.json')
          : saveDir,
      ),
    recentErrors: () => errors.list(),
  });
  for (const [channel, { handle, fallback }] of Object.entries(handlers)) {
    registerSync(ipcMain, channel as Channel, handle, fallback, (event) =>
      isGamePage(event, { webContents: game, dir: pageDir }),
    );
  }

  app.on('second-instance', () => {
    const window = game === null ? null : BrowserWindow.fromWebContents(game);
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(() => {
    const pages = session.defaultSession;
    pages.setPermissionRequestHandler((_contents, permission, grant) =>
      grant(permission === PERMITTED),
    );
    pages.setPermissionCheckHandler((_contents, permission) => permission === PERMITTED);

    const page = join(pageDir, 'index.html');
    if (!existsSync(page)) {
      dialog.showErrorBox('bc-incremental', `${page} is missing: run npm run build:electron.`);
      app.exit(1);
      return;
    }
    const window = new BrowserWindow({
      width: 1280,
      height: 800,
      backgroundColor: '#0b0d12',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(appPath, 'dist-electron', 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const contents = window.webContents;
    game = contents;
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttps(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('console-message', (event) => {
      if (event.level === 'error') {
        errors.add(`console error: ${event.message} (${event.sourceId}:${event.lineNumber})`);
      }
    });
    contents.on('preload-error', (_event, preloadPath, error) =>
      errors.add(`preload error in ${preloadPath}: ${error.message}`),
    );
    contents.on('render-process-gone', (_event, details) =>
      errors.add(`renderer gone: ${details.reason} (exit code ${details.exitCode})`),
    );
    contents.on('did-fail-load', (_event, code, description, url) =>
      errors.add(`load failed: ${description} (${code}) at ${url}`),
    );
    // A failed load is in the ring buffer already (did-fail-load).
    window
      .loadFile(page, args.replay === null ? undefined : { query: { replay: args.replay } })
      .catch(() => {});
  });
}

function steamLine(status: SteamStatus): string {
  return status.ok
    ? `Steam: connected (app ${status.appId}, ${status.language}, ${status.initMs} ms)`
    : `Steam: NOT connected (${status.stage}): ${status.error}`;
}

/** An installed package's version, or null. */
function packageVersion(load: NodeJS.Require, name: string): string | null {
  try {
    const version: unknown = (load(`${name}/package.json`) as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** app.getGPUFeatureStatus() as `feature=status` pairs, by feature. */
function compactGpu(status: object): string {
  return Object.entries(status)
    .map(([feature, state]) => `${feature}=${String(state)}`)
    .sort()
    .join(' ');
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
