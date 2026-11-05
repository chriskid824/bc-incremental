import { describe, expect, it } from 'vitest';
import { autoCloudRow, userDataDir } from './paths';
import {
  ARCHEFUSE_APP_ID,
  ARCHEFUSE_DEMO_APP_ID,
  builtRelease,
  parseRelease,
  releaseSetup,
} from './release';

describe('parseRelease', () => {
  it('reads unset, empty and dev as dev', () => {
    expect(parseRelease(undefined)).toBe('dev');
    expect(parseRelease('')).toBe('dev');
    expect(parseRelease('dev')).toBe('dev');
  });

  it('reads demo and full', () => {
    expect(parseRelease('demo')).toBe('demo');
    expect(parseRelease('full')).toBe('full');
  });

  it('rejects anything else', () => {
    expect(() => parseRelease('Demo')).toThrow(/BC_RELEASE/);
  });
});

describe('releaseSetup', () => {
  it('keeps the C9 check build on Spacewar and the M1 page', () => {
    expect(releaseSetup('dev')).toMatchObject({ appId: 480, page: 'index.html' });
  });

  it("starts the demo on the demo's App ID and the v3 page", () => {
    expect(releaseSetup('demo')).toMatchObject({
      appId: ARCHEFUSE_DEMO_APP_ID,
      page: 'game.html',
      title: 'Archefuse Demo',
    });
    expect(ARCHEFUSE_DEMO_APP_ID).toBe(5560180);
  });

  it("starts the full game on Archefuse's App ID and the v3 page", () => {
    expect(releaseSetup('full')).toMatchObject({ appId: ARCHEFUSE_APP_ID, page: 'game.html' });
    expect(ARCHEFUSE_APP_ID).toBe(5554510);
  });
});

describe('release folders', () => {
  it('gives each release its own userData folder, the C9 one unchanged', () => {
    const folders = (['dev', 'demo', 'full'] as const).map((r) => releaseSetup(r).folder);
    expect(folders).toEqual(['bc-incremental', 'archefuse-demo', 'archefuse']);
    expect(new Set(folders).size).toBe(3);
  });

  it("puts each release's saves and Auto-Cloud row in its own folder", () => {
    const demo = releaseSetup('demo').folder;
    const full = releaseSetup('full').folder;
    expect(userDataDir('C:\\Users\\hoshi\\AppData\\Roaming', null, 'win32', demo)).toBe(
      'C:\\Users\\hoshi\\AppData\\Roaming\\archefuse-demo',
    );
    expect(autoCloudRow('win32', demo)).toEqual({
      root: 'WinAppDataRoaming',
      subdirectory: 'archefuse-demo/saves',
      pattern: '*.json',
    });
    expect(autoCloudRow('win32', full)).toEqual({
      root: 'WinAppDataRoaming',
      subdirectory: 'archefuse/saves',
      pattern: '*.json',
    });
    expect(autoCloudRow('win32', releaseSetup('dev').folder).subdirectory).toBe(
      'bc-incremental/saves',
    );
  });
});

describe('builtRelease', () => {
  it('is dev when the build wrote no release in (tests, the source run)', () => {
    expect(builtRelease().release).toBe('dev');
  });
});
