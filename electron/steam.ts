/**
 * Steam in the main process, through steamworks.js (docs/v3 C9 design §1.5). startSteam() loads
 * the native module and calls init(appId) before Electron is ready, since the overlay can hook
 * only a GPU device made after it; then, and only if init succeeded, electronEnableSteamOverlay()
 * appends OVERLAY_SWITCHES to Chromium's command line (C9/F7), so a run without Steam keeps the
 * default GPU process. `forceOverlaySwitches` (`--bc-overlay-switches`) appends them without
 * Steam, for the smoke. A load or init failure is a status, never an exception: the game plays on
 * without Steam (C9/F6). Every call into Steam checks its argument first and reads a throw as
 * false.
 */

import { isAchievementId } from '../src/platform/achievements';
import type { SteamStatus } from '../src/platform/steam/bridge';

/** Spacewar, the App ID every Steam account may run; C9 only (M3 uses the game's and the demo's). */
export const SPACEWAR_APP_ID = 480;

/** What electronEnableSteamOverlay() appends to Chromium's command line. */
export const OVERLAY_SWITCHES = ['in-process-gpu', 'disable-direct-composition'] as const;

/** The part of steamworks.js' client this shell calls. */
export interface SteamClient {
  readonly achievement: {
    activate(name: string): boolean;
    isActivated(name: string): boolean;
    clear(name: string): boolean;
  };
  readonly overlay: { activateDialog(dialog: number): void };
  readonly utils: { getAppId(): number; isSteamRunningOnSteamDeck(): boolean };
  readonly apps: { currentGameLanguage(): string };
}

/** The part of the steamworks.js module this shell calls. */
export interface SteamworksModule {
  init(appId: number): SteamClient;
  electronEnableSteamOverlay(): void;
}

export type OverlayDialog = 'achievements' | 'friends';

/** steamworks.js' overlay.Dialog values for the dialogs the check opens. */
export const OVERLAY_DIALOGS: Readonly<Record<OverlayDialog, number>> = {
  achievements: 6,
  friends: 0,
};

export interface SteamSession {
  readonly status: SteamStatus;
  /** The switches appended; empty unless Steam started (or they were forced). */
  readonly overlaySwitches: readonly string[];
  unlock(id: string): boolean;
  isUnlocked(id: string): boolean;
  clear(id: string): boolean;
  openOverlay(dialog: OverlayDialog): void;
}

export interface StartSteam {
  readonly appId: number;
  /** Loads steamworks.js; called once, here, so a missing native module is a status. */
  readonly load: () => SteamworksModule;
  /** Milliseconds, for initMs. */
  readonly clock: () => number;
  readonly forceOverlaySwitches?: boolean;
}

export function startSteam(o: StartSteam): SteamSession {
  let steamworks: SteamworksModule;
  try {
    steamworks = o.load();
  } catch (error) {
    return session(null, { ok: false, stage: 'load', error: describe(error) }, []);
  }
  let client: SteamClient | null = null;
  let status: SteamStatus;
  try {
    const started = o.clock();
    const steam = steamworks.init(o.appId);
    const initMs = Math.round(o.clock() - started);
    status = {
      ok: true,
      appId: steam.utils.getAppId(),
      language: steam.apps.currentGameLanguage(),
      steamDeck: steam.utils.isSteamRunningOnSteamDeck(),
      initMs,
    };
    client = steam;
  } catch (error) {
    status = { ok: false, stage: 'init', error: describe(error) };
  }
  let switches: readonly string[] = [];
  if (status.ok || o.forceOverlaySwitches === true) {
    try {
      steamworks.electronEnableSteamOverlay();
      switches = [...OVERLAY_SWITCHES];
    } catch {
      // Steam stays connected without its overlay; the empty list says so.
    }
  }
  return session(client, status, switches);
}

function session(
  client: SteamClient | null,
  status: SteamStatus,
  overlaySwitches: readonly string[],
): SteamSession {
  /** A call into Steam for a valid achievement id; false without Steam or when it throws. */
  const achievement = (id: string, call: (steam: SteamClient) => boolean): boolean => {
    if (client === null || !isAchievementId(id)) return false;
    try {
      return call(client) === true;
    } catch {
      return false;
    }
  };
  return {
    status,
    overlaySwitches,
    unlock: (id) => achievement(id, (steam) => steam.achievement.activate(id)),
    isUnlocked: (id) => achievement(id, (steam) => steam.achievement.isActivated(id)),
    clear: (id) => achievement(id, (steam) => steam.achievement.clear(id)),
    openOverlay(dialog) {
      if (client === null || !Object.hasOwn(OVERLAY_DIALOGS, dialog)) return;
      try {
        client.overlay.activateDialog(OVERLAY_DIALOGS[dialog]);
      } catch {
        // No overlay to open; the check records what the player saw.
      }
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
