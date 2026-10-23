/**
 * The bridge between the Steam build's page and its Electron shell (docs/v3 C9 design §1.3). The
 * shell's preload exposes one frozen NativeBridge on the page's global object under
 * NATIVE_BRIDGE_KEY, with contextIsolation and the sandbox on (ARCH §11's minimal API: storage,
 * achievements, steamInfo); each call is a synchronous IPC to the main process, which owns the
 * save files and steamworks.js. Types and constants only, no DOM and no globals: the page
 * (./index.ts) and the preload both import this module.
 */

import type { SaveSlot } from '../storage';

export const NATIVE_BRIDGE_KEY = 'bcNative';
export const BRIDGE_VERSION = 1;

export type SteamStatus =
  | {
      readonly ok: true;
      readonly appId: number;
      readonly language: string;
      readonly steamDeck: boolean;
      readonly initMs: number;
    }
  | { readonly ok: false; readonly stage: 'load' | 'init'; readonly error: string };

export interface ShellInfo {
  readonly bridgeVersion: 1;
  readonly checkMode: boolean;
  readonly steam: SteamStatus;
  /** Empty unless Steam started. */
  readonly overlaySwitches: readonly string[];
  /** Absolute; for the check panel only. */
  readonly saveDir: string;
  /** `%APPDATA%\…` or `~/…`, for reports. */
  readonly saveDirShown: string;
  readonly autoCloud: {
    readonly root: string;
    readonly subdirectory: string;
    readonly pattern: '*.json';
  };
  readonly versions: {
    readonly app: string;
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
    readonly steamworks: string | null;
  };
  readonly os: {
    readonly platform: string;
    readonly arch: string;
    readonly release: string;
    readonly translated: boolean;
  };
  /** A compact app.getGPUFeatureStatus(). */
  readonly gpu: string;
}

export type SaveWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface SaveFileInfo {
  readonly name: string;
  readonly bytes: number;
  readonly modified: string;
}

export interface NativeBridge {
  readonly version: 1;
  steamInfo(): ShellInfo;
  readonly storage: {
    read(slot: SaveSlot): string | null;
    write(slot: SaveSlot, text: string): SaveWriteResult;
  };
  readonly achievements: { unlock(id: string): boolean; isUnlocked(id: string): boolean };
  /** Only under `--steam-check`. */
  readonly check?: CheckBridge;
}

/** The Steam check's extra calls (C9/F13), refused by the main process outside check mode. */
export interface CheckBridge {
  clearAchievement(id: string): boolean;
  openOverlay(dialog: 'achievements' | 'friends'): void;
  listSaves(): readonly SaveFileInfo[];
  showSaves(): void;
  saveReport(text: string): { readonly ok: boolean; readonly where: string };
  recentErrors(): readonly string[];
}
