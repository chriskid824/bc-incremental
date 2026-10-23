/**
 * The web build's platform (docs/ARCHITECTURE.md §7; docs/v3 C9 design §1.1): the save slots in
 * localStorage, or in memory when the page may not use it; achievements in a local record; and
 * the web playtest's analytics policy.
 */

import { LocalAchievements } from './achievements';
import { openKeyValueStore, pageLocalStorage } from './platform';
import type { AnalyticsPolicy, Platform, PlatformSetup } from './platform';
import { LocalSaveStorage, MemorySaveStorage } from './storage';
import type { SaveStorage } from './storage';

/** The web playtest sends anonymous events unless the player turns it off (ARCH §9). */
export const WEB_ANALYTICS_POLICY: AnalyticsPolicy = { cloud: true, sendByDefault: true };

/** What the web platform takes from the page; the tests pass their own. */
export interface WebEnv {
  readonly localStorage: () => Storage;
}

export function createWebPlatform(
  setup: PlatformSetup,
  env: WebEnv = { localStorage: pageLocalStorage },
): Platform {
  return {
    id: 'web',
    storage: openStorage(env, setup.savePrefix),
    achievements: new LocalAchievements(openKeyValueStore(env.localStorage)),
    analytics: setup.analytics(WEB_ANALYTICS_POLICY),
  };
}

/** Save slots under `prefix` (./storage.ts), or the player's own when omitted. */
function openStorage(env: WebEnv, prefix: string | undefined): SaveStorage {
  try {
    return new LocalSaveStorage(env.localStorage(), prefix);
  } catch {
    return new MemorySaveStorage();
  }
}
