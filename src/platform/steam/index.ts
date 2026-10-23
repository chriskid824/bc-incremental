/**
 * The Steam build's platform, its page half (docs/v3 C9 design §1.1, §1.3). The Electron shell's
 * bridge (./bridge.ts) carries the save slots, files the main process writes, and Steam's
 * achievements; while Steam is not running the achievements go to a local record and the build
 * plays on (C9/F6). Without the bridge, or with another version of it, the page has nowhere to
 * save: createSteamPlatform throws MissingBridgeError, which src/app/main.ts shows as a fatal
 * error. Playtest events stay in the local log (C9/F12) until M3 applies ARCH §9's table.
 *
 * Nothing here runs on import, so the web build drops this directory (../index.ts).
 */

import { LocalAchievements, isAchievementId } from '../achievements';
import type { Achievements } from '../achievements';
import { openKeyValueStore, pageLocalStorage } from '../platform';
import type { AnalyticsPolicy, Platform, PlatformSetup } from '../platform';
import type { SaveSlot, SaveStorage } from '../storage';
import { BRIDGE_VERSION, NATIVE_BRIDGE_KEY } from './bridge';
import type { NativeBridge } from './bridge';

/** Check runs stay out of the playtest data: the local log only (C9/F12). */
export const STEAM_ANALYTICS_POLICY: AnalyticsPolicy = { cloud: false, sendByDefault: false };

/** The page has no bridge from the Electron shell, or one of another version. */
export class MissingBridgeError extends Error {
  constructor(found: unknown) {
    super(
      found === undefined || found === null
        ? `the Steam build runs only in its Electron shell (no ${NATIVE_BRIDGE_KEY} bridge on this page)`
        : `the Steam build needs ${NATIVE_BRIDGE_KEY} bridge version ${BRIDGE_VERSION} ` +
            `(this page has ${versionOf(found)})`,
    );
    this.name = 'MissingBridgeError';
  }
}

/** How the message names a bridge of another version. */
function versionOf(found: unknown): string {
  const version: unknown =
    typeof found === 'object' && found !== null ? Reflect.get(found, 'version') : undefined;
  return typeof version === 'number' ? `version ${version}` : 'an unversioned one';
}

/** The save slots as files in the main process (C9/F5), never in localStorage. */
export class BridgeSaveStorage implements SaveStorage {
  constructor(private readonly files: NativeBridge['storage']) {}

  /** The slot's text, or null when it holds nothing or the call fails. */
  read(slot: SaveSlot): string | null {
    try {
      const text = this.files.read(slot);
      return typeof text === 'string' ? text : null;
    } catch {
      return null;
    }
  }

  /** A failed write warns, as LocalSaveStorage's does; the next save tries again. */
  write(slot: SaveSlot, text: string): void {
    try {
      const result = this.files.write(slot, text);
      if (!result.ok) console.warn('Save failed', result.error);
    } catch (error) {
      console.warn('Save failed', error);
    }
  }
}

/** Steam's achievements, through the bridge to steamworks.js in the main process. */
export class SteamAchievements implements Achievements {
  constructor(private readonly steam: NativeBridge['achievements']) {}

  unlock(id: string): boolean {
    return isAchievementId(id) && answer(() => this.steam.unlock(id));
  }

  isUnlocked(id: string): boolean {
    return isAchievementId(id) && answer(() => this.steam.isUnlocked(id));
  }
}

/** A bridge call's boolean: true only for true, so a throw or a missing answer reads as false. */
function answer(call: () => boolean): boolean {
  try {
    return call() === true;
  } catch {
    return false;
  }
}

/** What the Steam platform takes from the page; the tests pass their own. */
export interface SteamEnv {
  /** The page's global object, where the preload puts the bridge. */
  readonly global: object;
  /** For the local achievements record while Steam is not running. */
  readonly localStorage: () => Storage;
}

export function createSteamPlatform(
  setup: PlatformSetup,
  env: SteamEnv = { global: globalThis, localStorage: pageLocalStorage },
): Platform {
  const bridge = readBridge(env.global);
  return {
    id: 'steam',
    // setup.savePrefix names localStorage keys; the files have their own names.
    storage: new BridgeSaveStorage(bridge.storage),
    achievements: steamStarted(bridge)
      ? new SteamAchievements(bridge.achievements)
      : new LocalAchievements(openKeyValueStore(env.localStorage)),
    analytics: setup.analytics(STEAM_ANALYTICS_POLICY),
  };
}

/** The bridge on `global`; MissingBridgeError when there is none or it is another version. */
function readBridge(global: object): NativeBridge {
  const found: unknown = Reflect.get(global, NATIVE_BRIDGE_KEY);
  const isCurrent =
    typeof found === 'object' && found !== null && Reflect.get(found, 'version') === BRIDGE_VERSION;
  if (!isCurrent) throw new MissingBridgeError(found);
  return found as NativeBridge;
}

/** Whether Steam started in the main process; a bridge that cannot tell counts as no. */
function steamStarted(bridge: NativeBridge): boolean {
  try {
    return bridge.steamInfo().steam.ok === true;
  } catch {
    return false;
  }
}
