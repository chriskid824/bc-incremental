import { describe, expect, it } from 'vitest';
import {
  APP_FOLDER,
  REPORTS_FOLDER,
  SAVES_FOLDER,
  autoCloudRow,
  reportDirOf,
  saveDirOf,
  shownPath,
  userDataDir,
} from './paths';

const WINDOWS = { home: 'C:\\Users\\Hoshi', appData: 'C:\\Users\\Hoshi\\AppData\\Roaming' };
const MAC = { home: '/Users/hoshi', appData: '/Users/hoshi/Library/Application Support' };
const LINUX = { home: '/home/hoshi', appData: '/home/hoshi/.config' };

describe('userDataDir', () => {
  it('is appData/bc-incremental unless an override names another folder', () => {
    expect(APP_FOLDER).toBe('bc-incremental');
    expect(userDataDir(WINDOWS.appData, null, 'win32')).toBe(
      'C:\\Users\\Hoshi\\AppData\\Roaming\\bc-incremental',
    );
    expect(userDataDir(MAC.appData, null, 'darwin')).toBe(
      '/Users/hoshi/Library/Application Support/bc-incremental',
    );
    expect(userDataDir(LINUX.appData, null, 'linux')).toBe('/home/hoshi/.config/bc-incremental');
    expect(userDataDir(LINUX.appData, '/tmp/smoke-1', 'linux')).toBe('/tmp/smoke-1');
    expect(userDataDir(WINDOWS.appData, 'D:\\bc', 'win32')).toBe('D:\\bc');
  });

  it("keeps the saves in userData's saves folder", () => {
    expect(saveDirOf('C:\\Users\\Hoshi\\AppData\\Roaming\\bc-incremental', 'win32')).toBe(
      'C:\\Users\\Hoshi\\AppData\\Roaming\\bc-incremental\\saves',
    );
    expect(saveDirOf('/home/hoshi/.config/bc-incremental', 'linux')).toBe(
      '/home/hoshi/.config/bc-incremental/saves',
    );
  });

  it("keeps the check's reports in userData's steam-check folder, beside the saves", () => {
    expect(REPORTS_FOLDER).toBe('steam-check');
    expect(REPORTS_FOLDER).not.toBe(SAVES_FOLDER);
    expect(reportDirOf('C:\\Users\\Hoshi\\AppData\\Roaming\\bc-incremental', 'win32')).toBe(
      'C:\\Users\\Hoshi\\AppData\\Roaming\\bc-incremental\\steam-check',
    );
    expect(reportDirOf('/Users/hoshi/Library/Application Support/bc-incremental', 'darwin')).toBe(
      '/Users/hoshi/Library/Application Support/bc-incremental/steam-check',
    );
  });
});

describe('shownPath', () => {
  it('writes Windows appData as %APPDATA% and home as ~, whatever the case or slashes', () => {
    const cases: readonly (readonly [string, string])[] = [
      [
        'C:\\Users\\Hoshi\\AppData\\Roaming\\bc-incremental\\saves',
        '%APPDATA%\\bc-incremental\\saves',
      ],
      [
        'c:\\users\\hoshi\\appdata\\roaming\\bc-incremental\\saves',
        '%APPDATA%\\bc-incremental\\saves',
      ],
      [
        'C:\\USERS\\HOSHI\\APPDATA\\ROAMING\\bc-incremental\\saves',
        '%APPDATA%\\bc-incremental\\saves',
      ],
      ['C:/Users/Hoshi/AppData/Roaming/bc-incremental/saves', '%APPDATA%\\bc-incremental\\saves'],
      ['C:\\Users\\Hoshi\\AppData\\Roaming', '%APPDATA%'],
      ['C:\\Users\\Hoshi\\Documents\\bc\\saves', '~\\Documents\\bc\\saves'],
      ['c:\\users\\hoshi', '~'],
    ];
    for (const [path, shown] of cases) {
      expect(shownPath(path, WINDOWS, 'win32'), path).toBe(shown);
      expect(shownPath(path, WINDOWS, 'win32').toLowerCase(), path).not.toContain('hoshi');
    }
  });

  it('writes macOS and Linux home as ~, and a moved XDG config folder by its variable', () => {
    expect(shownPath(`${MAC.appData}/bc-incremental/saves`, MAC, 'darwin')).toBe(
      '~/Library/Application Support/bc-incremental/saves',
    );
    expect(shownPath(`${LINUX.appData}/bc-incremental/saves`, LINUX, 'linux')).toBe(
      '~/.config/bc-incremental/saves',
    );
    expect(shownPath('/home/hoshi', LINUX, 'linux')).toBe('~');
    const moved = { home: '/home/hoshi', appData: '/srv/hoshi-config' };
    expect(shownPath('/srv/hoshi-config/bc-incremental/saves', moved, 'linux')).toBe(
      '$XDG_CONFIG_HOME/bc-incremental/saves',
    );
  });

  it('leaves a path outside home and appData as it is, a neighbour sharing their prefix too', () => {
    expect(shownPath('D:\\Games\\bc\\saves', WINDOWS, 'win32')).toBe('D:\\Games\\bc\\saves');
    expect(shownPath('C:\\Users\\Hoshiko\\saves', WINDOWS, 'win32')).toBe(
      'C:\\Users\\Hoshiko\\saves',
    );
    expect(shownPath('C:\\Users\\Hoshi\\AppData\\RoamingX\\bc', WINDOWS, 'win32')).toBe(
      '~\\AppData\\RoamingX\\bc',
    );
    expect(shownPath('/tmp/smoke/saves', LINUX, 'linux')).toBe('/tmp/smoke/saves');
    expect(shownPath('/home/hoshiko/saves', LINUX, 'linux')).toBe('/home/hoshiko/saves');
    expect(shownPath('/Users/hoshi2/saves', MAC, 'darwin')).toBe('/Users/hoshi2/saves');
    // Linux reads paths with case: /HOME/HOSHI is another folder.
    expect(shownPath('/HOME/HOSHI/saves', LINUX, 'linux')).toBe('/HOME/HOSHI/saves');
  });
});

describe('autoCloudRow', () => {
  it("is §1.4's row for each OS: the saves folder under the OS's root, *.json", () => {
    expect(autoCloudRow('win32')).toEqual({
      root: 'WinAppDataRoaming',
      subdirectory: 'bc-incremental/saves',
      pattern: '*.json',
    });
    expect(autoCloudRow('darwin')).toEqual({
      root: 'MacAppSupport',
      subdirectory: 'bc-incremental/saves',
      pattern: '*.json',
    });
    expect(autoCloudRow('linux')).toEqual({
      root: 'LinuxHome',
      subdirectory: '.config/bc-incremental/saves',
      pattern: '*.json',
    });
  });
});
