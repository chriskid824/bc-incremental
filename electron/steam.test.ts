import { describe, expect, expectTypeOf, it, vi } from 'vitest';
// Types only: no test loads the native module.
import type * as SteamworksJs from 'steamworks.js';
import type { Client } from 'steamworks.js';
import { OVERLAY_DIALOGS, OVERLAY_SWITCHES, SPACEWAR_APP_ID, startSteam } from './steam';
import type { SteamClient, SteamworksModule } from './steam';

/** A steamworks.js stand-in: Steam's achievements in a set, every native call logged. */
function fakeSteamworks(o: { initThrows?: unknown; appId?: number } = {}) {
  const calls: string[] = [];
  const unlocked = new Set<string>();
  const client = {
    achievement: {
      activate: vi.fn((name: string): boolean => {
        calls.push(`activate ${name}`);
        unlocked.add(name);
        return true;
      }),
      isActivated: vi.fn((name: string): boolean => {
        calls.push(`isActivated ${name}`);
        return unlocked.has(name);
      }),
      clear: vi.fn((name: string): boolean => {
        calls.push(`clear ${name}`);
        unlocked.delete(name);
        return true;
      }),
    },
    overlay: {
      activateDialog: vi.fn((dialog: number): void => {
        calls.push(`dialog ${dialog}`);
      }),
    },
    utils: {
      getAppId: vi.fn((): number => o.appId ?? 480),
      isSteamRunningOnSteamDeck: vi.fn((): boolean => true),
    },
    apps: { currentGameLanguage: vi.fn((): string => 'tchinese') },
  } satisfies SteamClient;
  const steamworks = {
    init: vi.fn((appId: number): SteamClient => {
      calls.push(`init ${appId}`);
      if (o.initThrows !== undefined) throw o.initThrows;
      return client;
    }),
    electronEnableSteamOverlay: vi.fn((): void => {
      calls.push('overlay');
    }),
  } satisfies SteamworksModule;
  return { steamworks, client, calls, unlocked };
}

/** A clock that reads 1000 ms, then 1140.4 ms: init took 140 ms. */
function clock(): () => number {
  const times = [1000, 1140.4];
  return () => times.shift() ?? 2000;
}

const ACH = 'ACH_WIN_ONE_GAME';

describe('startSteam', () => {
  it('reports a module that cannot load as stage load, and never enables the overlay', () => {
    for (const forceOverlaySwitches of [false, true]) {
      const session = startSteam({
        appId: SPACEWAR_APP_ID,
        load: () => {
          throw new Error('The specified module could not be found.');
        },
        clock: clock(),
        forceOverlaySwitches,
      });
      expect(session.status).toEqual({
        ok: false,
        stage: 'load',
        error: 'The specified module could not be found.',
      });
      expect(session.overlaySwitches).toEqual([]);
      expect(session.unlock(ACH)).toBe(false);
      expect(() => session.openOverlay('achievements')).not.toThrow();
    }
  });

  it('reports a failed init as stage init, enables no overlay and calls nothing in Steam', () => {
    for (const thrown of [new Error('Steam is not running'), 'Steam is not running']) {
      const { steamworks, calls } = fakeSteamworks({ initThrows: thrown });
      const session = startSteam({
        appId: SPACEWAR_APP_ID,
        load: () => steamworks,
        clock: clock(),
      });
      expect(session.status).toEqual({ ok: false, stage: 'init', error: 'Steam is not running' });
      expect(steamworks.electronEnableSteamOverlay).not.toHaveBeenCalled();
      expect(session.overlaySwitches).toEqual([]);
      expect(session.unlock(ACH)).toBe(false);
      expect(session.isUnlocked(ACH)).toBe(false);
      expect(session.clear(ACH)).toBe(false);
      session.openOverlay('achievements');
      expect(calls).toEqual(['init 480']);
    }
  });

  it('starts Steam on App ID 480, then enables the overlay once and lists its switches', () => {
    const { steamworks, calls } = fakeSteamworks({ appId: 481 });
    const load = vi.fn(() => steamworks);
    const session = startSteam({ appId: SPACEWAR_APP_ID, load, clock: clock() });
    expect(SPACEWAR_APP_ID).toBe(480);
    expect(load).toHaveBeenCalledTimes(1);
    expect(steamworks.init).toHaveBeenCalledWith(480);
    // The App ID Steam reports, not the one asked for.
    expect(session.status).toEqual({
      ok: true,
      appId: 481,
      language: 'tchinese',
      steamDeck: true,
      initMs: 140,
    });
    expect(calls).toEqual(['init 480', 'overlay']);
    expect(steamworks.electronEnableSteamOverlay).toHaveBeenCalledTimes(1);
    expect(session.overlaySwitches).toEqual(['in-process-gpu', 'disable-direct-composition']);
    expect(OVERLAY_SWITCHES).toEqual(['in-process-gpu', 'disable-direct-composition']);
  });

  it('reads a client that fails after init as stage init, without the overlay', () => {
    const { steamworks, client } = fakeSteamworks();
    client.utils.getAppId.mockImplementation(() => {
      throw new Error('no app');
    });
    const session = startSteam({ appId: SPACEWAR_APP_ID, load: () => steamworks, clock: clock() });
    expect(session.status).toEqual({ ok: false, stage: 'init', error: 'no app' });
    expect(steamworks.electronEnableSteamOverlay).not.toHaveBeenCalled();
    expect(session.unlock(ACH)).toBe(false);
  });

  it('appends the switches without Steam only when forced (--bc-overlay-switches)', () => {
    const { steamworks } = fakeSteamworks({ initThrows: new Error('Steam is not running') });
    const session = startSteam({
      appId: SPACEWAR_APP_ID,
      load: () => steamworks,
      clock: clock(),
      forceOverlaySwitches: true,
    });
    expect(session.status.ok).toBe(false);
    expect(steamworks.electronEnableSteamOverlay).toHaveBeenCalledTimes(1);
    expect(session.overlaySwitches).toEqual(['in-process-gpu', 'disable-direct-composition']);
  });

  it('keeps Steam connected, without switches, when enabling the overlay throws', () => {
    const { steamworks } = fakeSteamworks();
    steamworks.electronEnableSteamOverlay.mockImplementation(() => {
      throw new Error('Electron module not found');
    });
    const session = startSteam({ appId: SPACEWAR_APP_ID, load: () => steamworks, clock: clock() });
    expect(session.status.ok).toBe(true);
    expect(session.overlaySwitches).toEqual([]);
  });
});

describe('a started session', () => {
  function started() {
    const fake = fakeSteamworks();
    const session = startSteam({
      appId: SPACEWAR_APP_ID,
      load: () => fake.steamworks,
      clock: clock(),
    });
    fake.calls.length = 0;
    return { ...fake, session };
  }

  it('unlocks, reads and clears an achievement in Steam', () => {
    const { session, calls } = started();
    expect(session.isUnlocked(ACH)).toBe(false);
    expect(session.unlock(ACH)).toBe(true);
    expect(session.isUnlocked(ACH)).toBe(true);
    expect(session.clear(ACH)).toBe(true);
    expect(session.isUnlocked(ACH)).toBe(false);
    expect(calls).toEqual([
      `isActivated ${ACH}`,
      `activate ${ACH}`,
      `isActivated ${ACH}`,
      `clear ${ACH}`,
      `isActivated ${ACH}`,
    ]);
  });

  it('checks the id before Steam sees it', () => {
    const { session, calls } = started();
    for (const id of ['', 'ACH WIN', '../x', 'ACH-WIN', 'A'.repeat(65), '成就', 42, null]) {
      expect(session.unlock(id as string), String(id)).toBe(false);
      expect(session.isUnlocked(id as string), String(id)).toBe(false);
      expect(session.clear(id as string), String(id)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("reads Steam's throw, or any answer but true, as false", () => {
    const { session, client } = started();
    for (const answer of [false, undefined, null, 1, 'true']) {
      client.achievement.activate.mockReturnValue(answer as boolean);
      client.achievement.isActivated.mockReturnValue(answer as boolean);
      client.achievement.clear.mockReturnValue(answer as boolean);
      expect(session.unlock(ACH), String(answer)).toBe(false);
      expect(session.isUnlocked(ACH), String(answer)).toBe(false);
      expect(session.clear(ACH), String(answer)).toBe(false);
    }
    const thrown = (): never => {
      throw new Error('Steam API call failed');
    };
    client.achievement.activate.mockImplementation(thrown);
    client.achievement.isActivated.mockImplementation(thrown);
    client.achievement.clear.mockImplementation(thrown);
    client.overlay.activateDialog.mockImplementation(thrown);
    expect(session.unlock(ACH)).toBe(false);
    expect(session.isUnlocked(ACH)).toBe(false);
    expect(session.clear(ACH)).toBe(false);
    expect(() => session.openOverlay('friends')).not.toThrow();
  });

  it("opens Steam's achievements dialog as 6 and friends as 0, and nothing else", () => {
    const { session, calls } = started();
    session.openOverlay('achievements');
    session.openOverlay('friends');
    for (const dialog of ['stats', 'Achievements', 'toString', '__proto__', '']) {
      session.openOverlay(dialog as 'friends');
    }
    expect(calls).toEqual(['dialog 6', 'dialog 0']);
    expect(OVERLAY_DIALOGS).toEqual({ achievements: 6, friends: 0 });
  });
});

describe("steamworks.js' types", () => {
  it('fit the parts of the client and module the shell calls', () => {
    expectTypeOf<Omit<Client, 'init' | 'runCallbacks'>>().toExtend<SteamClient>();
    expectTypeOf<typeof SteamworksJs>().toExtend<SteamworksModule>();
  });
});
