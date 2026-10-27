/**
 * The page's playtest analytics (docs/ARCHITECTURE.md §9) comes from the factory main.ts hands
 * createPlatform, which the platform calls with its policy (docs/v3 C9 design §1.1). The factory
 * gives the analytics a Firestore sink only where the policy lets the build send, and never on the
 * dev server or `?hive`; it sends by default only where the policy says so. `?hive` also keeps its
 * own save slots (./devFlags.ts). main.ts boots the page when it loads, so each case loads it
 * afresh on a stub page with a Firestore project configured; createPlatform records what it is
 * given and stops the boot there, which the page reports through showFatal. Given a stub platform
 * instead, the boot goes on to the Renderer, which records its options and stops it: the M1 page
 * and `?hive` give it no RenderRandom (docs/v3 C10 design §2.5). `?replay=` loads the replay
 * route's chunk instead of the game, and only it does (§1.7); `?enemies` loads the enemy grid's
 * chunk the same way, and only it does (docs/v3 C7 design §2.9).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as PixiModule from 'pixi.js';
import type * as PlatformModule from '../platform';
import type { AnalyticsPolicy, Platform, PlatformSetup } from '../platform';
import { STEAM_ANALYTICS_POLICY } from '../platform/steam';
import { WEB_ANALYTICS_POLICY } from '../platform/web';
import { HIVE_SAVE_PREFIX } from './devFlags';
import type * as PlaytestModule from './playtest';

/**
 * The Renderer's options as the stub records them; src/render's own types reach modules that need
 * the DOM, which the tools' tsconfig (the tests') leaves out.
 */
type RendererOptions = Readonly<Record<string, unknown>>;

const boot = vi.hoisted(() => ({
  setups: [] as PlatformSetup[],
  stop: new Error('the test stops the page at createPlatform'),
  /** What createPlatform returns instead of stopping the page, when set. */
  platform: null as Platform | null,
  /** Each Renderer's options; the Renderer stops the page. */
  renderers: [] as RendererOptions[],
  /** Loads of the replay route's chunk, and the searches it was started with. */
  routeLoads: 0,
  routes: [] as string[],
  /** Loads of the enemy grid's chunk, and the searches it was started with. */
  enemiesLoads: 0,
  enemiesRoutes: [] as string[],
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
    if (boot.platform !== null) return boot.platform;
    throw boot.stop;
  },
}));
vi.mock('../render', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Renderer: class {
    constructor(_app: unknown, _data: unknown, options: RendererOptions) {
      boot.renderers.push(options);
      throw boot.stop;
    }
  },
}));

afterEach(() => {
  boot.platform = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Loads main.ts on a stub page at `search` and waits for whatever stops it. */
async function loadPage(search: string): Promise<void> {
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
  // The spy outlives a page loaded before in the same case: wait for this page's own stop.
  fatal.mockClear();
  boot.setups.length = 0;
  boot.renderers.length = 0;
  boot.routeLoads = 0;
  boot.routes.length = 0;
  boot.enemiesLoads = 0;
  boot.enemiesRoutes.length = 0;
  vi.resetModules();
  // Registered afresh for each page, so that each page's load of the chunk counts (resetModules
  // keeps a mocked module).
  vi.doMock('./replay/route', () => {
    boot.routeLoads++;
    return {
      startReplayRoute: (_root: unknown, search: string) => {
        boot.routes.push(search);
        return Promise.reject(boot.stop);
      },
    };
  });
  vi.doMock('./enemies/route', () => {
    boot.enemiesLoads++;
    return {
      startEnemiesRoute: (_root: unknown, search: string) => {
        boot.enemiesRoutes.push(search);
        return Promise.reject(boot.stop);
      },
    };
  });
  // A computed path: main.ts needs the DOM, which the tools' tsconfig (the tests') leaves out.
  const page = './main';
  await import(/* @vite-ignore */ page);
  await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith(boot.stop), { timeout: 10_000 });
}

/** Loads main.ts on a stub page at `search` and returns what it gave createPlatform. */
async function bootAt(search: string): Promise<PlatformSetup> {
  await loadPage(search);
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

/** A platform with in-memory save slots and local-only analytics, so the boot reaches the Renderer. */
function stubPlatform(): Platform {
  const slots = new Map<string, string>();
  return {
    id: 'web',
    storage: {
      read: (slot) => slots.get(slot) ?? null,
      tryRead: (slot) => ({ ok: true, text: slots.get(slot) ?? null }),
      write: (slot, text) => void slots.set(slot, text),
    },
    achievements: { unlock: () => false, isUnlocked: () => false },
    analytics: {
      installId: 'test-install',
      canSend: false,
      sending: false,
      track: () => undefined,
      flush: () => undefined,
      exportLocal: () => '[]',
    },
  };
}

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

describe('main.ts and the replay (docs/v3 C10 design §1.7, §2.5)', () => {
  it('gives the M1 page’s and ?hive’s renderer no RenderRandom: their effects draw Math.random', async () => {
    for (const search of ['', '?hive']) {
      boot.platform = stubPlatform();
      await loadPage(search);
      expect(boot.renderers, search).toHaveLength(1);
      expect(boot.renderers[0], search).not.toHaveProperty('random');
      expect(boot.renderers[0]?.construct, search).toBe(search === '' ? undefined : 'hive');
      expect(boot.routeLoads, search).toBe(0);
      expect(boot.enemiesLoads, search).toBe(0);
    }
  });

  it('loads the replay route’s chunk for ?replay= only, instead of the game and its platform', async () => {
    for (const search of ['?replay=renderStress', '?lang=zh-TW&replay=gif:fire']) {
      await loadPage(search);
      expect([boot.routeLoads, boot.routes], search).toEqual([1, [search]]);
      expect([boot.setups, boot.renderers], search).toEqual([[], []]);
    }
    for (const search of ['', '?hive', '?wave=12', '?replay=']) {
      await loadPage(search);
      expect(boot.routeLoads, search).toBe(0);
      expect(boot.setups, search).toHaveLength(1);
    }
  });
});

describe('main.ts and the enemy grid (docs/v3 C7 design §2.9, the lead’s ruling P7)', () => {
  it('loads the ?enemies chunk for ?enemies only, instead of the game and its platform', async () => {
    for (const search of ['?enemies', '?lang=zh-TW&enemies&step=1', '?hive&enemies']) {
      await loadPage(search);
      expect([boot.enemiesLoads, boot.enemiesRoutes], search).toEqual([1, [search]]);
      expect([boot.routeLoads, boot.setups, boot.renderers], search).toEqual([0, [], []]);
    }
    // The M1 page, ?hive and a replay never fetch it; a replay named beside it opens first.
    for (const search of [
      '',
      '?hive',
      '?enemy',
      '?replay=renderStress',
      '?enemies&replay=renderStress',
    ]) {
      await loadPage(search);
      expect(boot.enemiesLoads, search).toBe(0);
    }
    expect(boot.routeLoads).toBe(1);
  });
});
