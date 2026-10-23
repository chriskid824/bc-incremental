/**
 * Where the shell keeps its files (docs/v3 C9 design §1.4): userData is appData + APP_FOLDER
 * unless `--bc-user-data-dir` names another folder, and the saves live in its `saves/` folder,
 * the only part of userData that Steam's Auto-Cloud may sync (Chromium's own data shares
 * userData). The check mode's reports go beside it, in `steam-check/` (design §2.2).
 * shownPath() writes a path without the home or appData folder in it, for reports;
 * autoCloudRow() is the Auto-Cloud path M3 configures for this OS. Pure: every function takes the
 * OS it answers for.
 */

import { posix, win32 } from 'node:path';
import type { PlatformPath } from 'node:path';
import type { ShellInfo } from '../src/platform/steam/bridge';

/**
 * The shell's folder under appData (C9/F14). Auto-Cloud's paths and installed copies name it, so
 * it is frozen at the first Steam build; M3 names it.
 */
export const APP_FOLDER = 'bc-incremental';

/** The save files' folder inside userData. */
export const SAVES_FOLDER = 'saves';

/** The check mode's reports' folder inside userData, outside saves/ so that Auto-Cloud skips it. */
export const REPORTS_FOLDER = 'steam-check';

function pathOf(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix;
}

/** userData: `override` (an absolute `--bc-user-data-dir`), or appData/APP_FOLDER. */
export function userDataDir(
  appData: string,
  override: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  return override ?? pathOf(platform).join(appData, APP_FOLDER);
}

/** The save files' folder in `userData`. */
export function saveDirOf(userData: string, platform: NodeJS.Platform = process.platform): string {
  return pathOf(platform).join(userData, SAVES_FOLDER);
}

/** The check mode's reports' folder in `userData`. */
export function reportDirOf(
  userData: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathOf(platform).join(userData, REPORTS_FOLDER);
}

/** The folders a shown path leaves out. */
export interface Places {
  readonly home: string;
  readonly appData: string;
}

/**
 * How appData is written where it is not under home: Windows' variable, or the XDG variable that
 * moves Linux's ~/.config elsewhere. On macOS appData is always under home.
 */
const APP_DATA_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: '%APPDATA%',
  linux: '$XDG_CONFIG_HOME',
};

/**
 * `path` with appData written as %APPDATA% (Windows) and home as `~`, so that a report shows no
 * user name; a path outside both is unchanged. Windows compares paths without case.
 */
export function shownPath(
  path: string,
  places: Places,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = pathOf(platform);
  const appData = APP_DATA_NAMES[platform];
  const home: [string, string] = [places.home, '~'];
  // Windows' appData lies under home, so it goes first; elsewhere home does.
  const prefixes: [string, string][] =
    platform === 'win32'
      ? [[places.appData, '%APPDATA%'], home]
      : [home, ...(appData === undefined ? [] : [[places.appData, appData] as [string, string]])];
  for (const [folder, name] of prefixes) {
    const rest = within(paths, folder, path);
    if (rest !== null) return rest === '' ? name : `${name}${paths.sep}${rest}`;
  }
  return path;
}

/** `path` relative to `folder` when it lies inside it ('' for the folder itself), else null. */
function within(paths: PlatformPath, folder: string, path: string): string | null {
  if (folder === '' || !paths.isAbsolute(folder) || !paths.isAbsolute(path)) return null;
  const rest = paths.relative(folder, path);
  if (rest === '..' || rest.startsWith(`..${paths.sep}`) || paths.isAbsolute(rest)) return null;
  return rest;
}

/**
 * The Auto-Cloud path for this OS's saves (§1.4's table), configured on the App ID in M3: Windows'
 * is the cross-platform row, not recursive; macOS and Linux override its root. Linux assumes no
 * $XDG_CONFIG_HOME (else M3 moves Linux saves to LinuxXdgDataHome).
 */
export function autoCloudRow(platform: NodeJS.Platform = process.platform): ShellInfo['autoCloud'] {
  const saves = `${APP_FOLDER}/${SAVES_FOLDER}`;
  switch (platform) {
    case 'win32':
      return { root: 'WinAppDataRoaming', subdirectory: saves, pattern: '*.json' };
    case 'darwin':
      return { root: 'MacAppSupport', subdirectory: saves, pattern: '*.json' };
    default:
      return { root: 'LinuxHome', subdirectory: `.config/${saves}`, pattern: '*.json' };
  }
}
