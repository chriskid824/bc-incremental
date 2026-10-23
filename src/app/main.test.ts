/**
 * The page's playtest analytics (docs/ARCHITECTURE.md §9) comes from the factory main.ts hands
 * createPlatform, which the platform calls with its policy (docs/v3 C9 design §1.1). The factory
 * gives the analytics a Firestore sink only where the policy lets the build send, and never on the
 * dev server or `?hive`; it sends by default only where the policy says so. `?hive` also keeps its
 * own save slots (./devFlags.ts). main.ts boots the page when it loads, so each case loads it
 * afresh on a stub page with a Firestore project configured; createPlatform records what it is
 * given and stops the boot there, which the page reports through showFatal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as PixiModule from 'pixi.js';
import type * as PlatformModule from '../platform';
import type { AnalyticsPolicy, PlatformSetup } from '../platform';
import { STEAM_ANALYTICS_POLICY } from '../platform/steam';
import { WEB_ANALYTICS_POLICY } from '../platform/web';
import { HIVE_SAVE_PREFIX } from './devFlags';
import type * as PlaytestModule from './playtest';

const boot = vi.hoisted(() => ({
  setups: [] as PlatformSetup[],
  stop: new Error('the test stops the page at createPlatform'),
}));

vi.mock('pixi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PixiModule>()),
  // No renderer in node: the page stops before it draws anything.
  Application: class {
    readonly canvas = {};
    init(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
vi.mock('./playtest', async (importOriginal) => ({
  ...(await importOriginal<typeof PlaytestModule>()),
  FIREBASE: { projectId: 'test-project', apiKey: 'test-key' },
}));
vi.mock('../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof PlatformModule>()),
  createPlatform: (setup: PlatformSetup) => {
    boot.setups.push(setup);
    throw boot.stop;
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Loads main.ts on a stub page at `search` and returns what it gave createPlatform. */
async function bootAt(search: string): Promise<PlatformSetup> {
  const root = { append: vi.fn(), appendChild: vi.fn(), replaceChildren: vi.fn() };
  vi.stubGlobal('window', {
    location: { search },
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
  });
  vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'], userAgent: '' });
  vi.stubGlobal('document', {
    documentElement: { lang: '' },
    head: { appendChild: vi.fn() },
    getElementById: (id: string) => (id === 'app' ? root : null),
    createElement: () => ({}),
  });
  vi.stubGlobal('localStorage', undefined);
  const fatal = vi.spyOn(console, 'error').mockImplementation(() => {});
  boot.setups.length = 0;
  vi.resetModules();
  // A computed path: main.ts needs the DOM, which the tools' tsconfig (the tests') leaves out.
  const page = './main';
  await import(/* @vite-ignore */ page);
  await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith(boot.stop), { timeout: 10_000 });
  const [setup, ...more] = boot.setups;
  expect(more).toEqual([]);
  if (setup === undefined) throw new Error('main.ts never called createPlatform');
  return setup;
}

/** Whether the analytics the page builds under `policy` has a sink, and sends from the start. */
function analyticsUnder(setup: PlatformSetup, policy: AnalyticsPolicy) {
  const { canSend, sending } = setup.analytics(policy);
  return { canSend, sending };
}

const LOCAL_ONLY = { canSend: false, sending: false };

describe('main.ts', () => {
  it("keeps ?hive's profile under its own save slots, and the player's under the default ones", async () => {
    expect(await bootAt('')).not.toHaveProperty('savePrefix');
    expect((await bootAt('?hive')).savePrefix).toBe(HIVE_SAVE_PREFIX);
  });

  it('sends the web playtest by default, and nothing where the policy keeps events local', async () => {
    vi.stubEnv('DEV', false);
    const setup = await bootAt('');
    expect(analyticsUnder(setup, WEB_ANALYTICS_POLICY)).toEqual({ canSend: true, sending: true });
    expect(analyticsUnder(setup, STEAM_ANALYTICS_POLICY)).toEqual(LOCAL_ONLY);
    expect(analyticsUnder(setup, { cloud: false, sendByDefault: true })).toEqual(LOCAL_ONLY);
  });

  it("starts sending only where the policy's default says so", async () => {
    vi.stubEnv('DEV', false);
    const setup = await bootAt('');
    expect(analyticsUnder(setup, { cloud: true, sendByDefault: false })).toEqual({
      canSend: true,
      sending: false,
    });
  });

  it("never sends from ?hive or the dev server, even under the web playtest's policy", async () => {
    vi.stubEnv('DEV', false);
    expect(analyticsUnder(await bootAt('?hive'), WEB_ANALYTICS_POLICY)).toEqual(LOCAL_ONLY);
    vi.stubEnv('DEV', true);
    expect(analyticsUnder(await bootAt(''), WEB_ANALYTICS_POLICY)).toEqual(LOCAL_ONLY);
  });
});
