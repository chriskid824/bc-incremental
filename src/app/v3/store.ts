/**
 * The v3 page's save wiring (src/app/profileStore.ts' header, the lead's ruling P3): save v2's
 * slots from createPlatform under PROFILE_SAVE_PREFIX, the M1 page's v1 slots for the one-time
 * import (none on Steam, nor where the page has no localStorage), the load context of the
 * registered content in FULL_SCOPE, and ISO timestamps. The page sends no playtest event in B1,
 * so its analytics is a stand-in that only drops events.
 */

import type { Content } from '../../data/web';
import { FULL_SCOPE } from '../../data/web';
import { createPlatform } from '../../platform';
import type { Platform } from '../../platform';
import type { Analytics } from '../../platform/analytics';
import { pageLocalStorage } from '../../platform/platform';
import { LocalSaveStorage, PROFILE_SAVE_PREFIX } from '../../platform/storage';
import type { SaveStorage } from '../../platform/storage';
import { profileContext } from '../../save/profile';
import { ProfileStore } from '../profileStore';

/** Analytics that keeps and sends nothing (B1: no playtest events on the v3 page). */
export const NO_ANALYTICS: Analytics = {
  installId: '',
  canSend: false,
  sending: false,
  track: () => undefined,
  flush: () => undefined,
  exportLocal: () => '[]',
};

/** The M1 page's v1 slots on the web; null on Steam and where the page has no localStorage. */
function v1Storage(platform: Platform): SaveStorage | null {
  if (platform.id !== 'web') return null;
  try {
    return new LocalSaveStorage(pageLocalStorage());
  } catch {
    return null;
  }
}

export function openProfileStore(content: Content): ProfileStore {
  const platform = createPlatform({
    savePrefix: PROFILE_SAVE_PREFIX,
    analytics: () => NO_ANALYTICS,
  });
  return new ProfileStore({
    storage: platform.storage,
    v1: v1Storage(platform),
    context: profileContext(content, FULL_SCOPE),
    now: () => new Date().toISOString(),
  });
}
