import { describe, expect, it } from 'vitest';
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

describe('builtRelease', () => {
  it('is dev when the build wrote no release in (tests, the source run)', () => {
    expect(builtRelease().release).toBe('dev');
  });
});
