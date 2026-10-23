/**
 * The platform aggregate (docs/ARCHITECTURE.md §7, without `ads` until a portal needs it: docs/v3
 * C9 design §1.1, C9/F8). A page gets one Platform from createPlatform (./index.ts), chosen when
 * the build is made: the web build's (./web.ts) or the Steam build's renderer half
 * (./steam/index.ts).
 */

import type { Achievements } from './achievements';
import type { Analytics, KeyValueStore } from './analytics';
import type { SaveStorage } from './storage';

export type PlatformId = 'web' | 'steam';

export interface Platform {
  readonly id: PlatformId;
  readonly storage: SaveStorage;
  readonly achievements: Achievements;
  readonly analytics: Analytics;
}

/**
 * ARCH §9's per-build rule: whether this build may send playtest events to the cloud at all, and
 * whether it sends before the player chooses.
 */
export interface AnalyticsPolicy {
  readonly cloud: boolean;
  readonly sendByDefault: boolean;
}

export interface PlatformSetup {
  /**
   * The web build's localStorage prefix for the save slots (`?hive`'s, src/app/devFlags.ts, and
   * C8.3's v2 page), or the player's own when omitted. The Steam build's file storage ignores it.
   */
  readonly savePrefix?: string;
  /** Builds the analytics under the build's policy; the Firestore wiring stays in src/app. */
  readonly analytics: (policy: AnalyticsPolicy) => Analytics;
}

/**
 * The page's localStorage. Reading it throws where the page may not use storage (blocked site
 * data, a sandboxed frame); outside a browser, where there is none, it throws too.
 */
export function pageLocalStorage(): Storage {
  const storage: Storage | undefined = globalThis.localStorage;
  if (storage === undefined) throw new Error('This page has no localStorage');
  return storage;
}

/** `localStorage` as a KeyValueStore, or an in-memory map when reading it throws. */
export function openKeyValueStore(localStorage: () => Storage = pageLocalStorage): KeyValueStore {
  try {
    return localStorage();
  } catch {
    const map = new Map<string, string>();
    return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  }
}
