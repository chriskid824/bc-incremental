/**
 * The Steam build's platform, its page half (docs/v3 C9 design §1.1, §1.3). The Electron shell's
 * bridge (./bridge.ts) carries the save slots, files the main process writes, and Steam's
 * achievements; while Steam is not running the achievements go to a local record and the build
 * plays on (C9/F6). Without the bridge, or with another version of it, the page has nowhere to
 * save: createSteamPlatform throws MissingBridgeError, which src/app/main.ts shows as a fatal
 * error. Playtest events stay in the local log (C9/F12) until M3 applies ARCH §9's table. Under
 * `--steam-check` the shell's bridge also carries the check's calls, and the page shows the check
 * panel (./checkPanel.ts, design §2.2).
 *
 * Nothing here runs on import, so the web build drops this directory (../index.ts).
 */

import { LocalAchievements, isAchievementId } from '../achievements';
import type { Achievements } from '../achievements';
import { openKeyValueStore, pageLocalStorage } from '../platform';
import type { AnalyticsPolicy, Platform, PlatformSetup } from '../platform';
import type { SaveReadResult, SaveSlot, SaveStorage } from '../storage';
import { BRIDGE_VERSION, NATIVE_BRIDGE_KEY } from './bridge';
import type { NativeBridge, ShellInfo } from './bridge';
import { mountCheckPanel } from './checkPanel';
import type { CheckPanelBridge } from './checkPanel';

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

/**
 * The save slots as files in the main process (C9/F5), never in localStorage. tryRead() keeps a
 * file the shell could not read apart from a missing one (bridge version 2); read() keeps the M1
 * page's answers.
 */
export class BridgeSaveStorage implements SaveStorage {
  constructor(private readonly files: NativeBridge['storage']) {}

  /**
   * The M1 page's read, its answers as before bridge version 2: the slot's text, or null when the
   * slot holds nothing, the read fails, or the file is empty ('' or a byte-order mark alone, which
   * the shell answered as null then), so that M1's save() never copies an empty main over a good
   * backup.
   */
  read(slot: SaveSlot): string | null {
    const read = this.tryRead(slot);
    return read.ok && read.text !== '' ? read.text : null;
  }

  /**
   * The shell's answer when it is a SaveReadResult, '' for an empty file included; a call that
   * throws, or any other answer, is a failed read saying what came back, never an empty slot.
   */
  tryRead(slot: SaveSlot): SaveReadResult {
    let answer: unknown;
    try {
      answer = this.files.read(slot);
    } catch (error) {
      return { ok: false, error: `the bridge's read threw: ${errorText(error)}` };
    }
    return readResult(answer) ?? { ok: false, error: `the bridge answered ${shown(answer)}` };
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

/**
 * `answer` as a SaveReadResult, holding only its fields: `ok: true` with a string or null `text`,
 * or `ok: false` with a string `error`. Anything else is null.
 */
function readResult(answer: unknown): SaveReadResult | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const ok: unknown = Reflect.get(answer, 'ok');
  if (ok === true) {
    const text: unknown = Reflect.get(answer, 'text');
    return typeof text === 'string' || text === null ? { ok: true, text } : null;
  }
  const error: unknown = Reflect.get(answer, 'error');
  return ok === false && typeof error === 'string' ? { ok: false, error } : null;
}

/** A malformed answer for its error: as JSON, cut short (a whole save can come back), or its type. */
function shown(answer: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(answer);
  } catch {
    // A cycle or a BigInt: its type says enough.
  }
  if (json === undefined) return typeof answer;
  return json.length > 60 ? `${json.slice(0, 60)}…` : json;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the Steam platform takes from the page; the tests pass their own. */
export interface SteamEnv {
  /** The page's global object, where the preload puts the bridge. */
  readonly global: object;
  /** For the local achievements record while Steam is not running. */
  readonly localStorage: () => Storage;
  /** Shows the check panel; mountCheckPanel on the page's body when left out. */
  readonly mountCheckPanel?: (bridge: CheckPanelBridge, info: ShellInfo) => void;
}

export function createSteamPlatform(
  setup: PlatformSetup,
  env: SteamEnv = { global: globalThis, localStorage: pageLocalStorage },
): Platform {
  const bridge = readBridge(env.global);
  const info = shellInfo(bridge);
  const platform: Platform = {
    id: 'steam',
    // setup.savePrefix names localStorage keys; the files have their own names.
    storage: new BridgeSaveStorage(bridge.storage),
    achievements: steamStarted(info)
      ? new SteamAchievements(bridge.achievements)
      : new LocalAchievements(openKeyValueStore(env.localStorage)),
    analytics: setup.analytics(STEAM_ANALYTICS_POLICY),
  };
  // Only under --steam-check, where the preload also exposes the check's calls (design §2.2).
  const check = bridge.check;
  if (info !== null && info.checkMode === true && check !== undefined) {
    (env.mountCheckPanel ?? mountCheckPanel)(
      { steamInfo: () => bridge.steamInfo(), achievements: bridge.achievements, check },
      info,
    );
  }
  return platform;
}

/** The bridge on `global`; MissingBridgeError when there is none or it is another version. */
function readBridge(global: object): NativeBridge {
  const found: unknown = Reflect.get(global, NATIVE_BRIDGE_KEY);
  const isCurrent =
    typeof found === 'object' && found !== null && Reflect.get(found, 'version') === BRIDGE_VERSION;
  if (!isCurrent) throw new MissingBridgeError(found);
  return found as NativeBridge;
}

/** The shell's ShellInfo, or null when the bridge cannot tell (its call throws or answers nothing). */
function shellInfo(bridge: NativeBridge): ShellInfo | null {
  try {
    const info: unknown = bridge.steamInfo();
    return typeof info === 'object' && info !== null ? (info as ShellInfo) : null;
  } catch {
    return null;
  }
}

/** Whether Steam started in the main process; a bridge that cannot tell counts as no. */
function steamStarted(info: ShellInfo | null): boolean {
  const steam: unknown = info === null ? undefined : Reflect.get(info, 'steam');
  return typeof steam === 'object' && steam !== null && Reflect.get(steam, 'ok') === true;
}
