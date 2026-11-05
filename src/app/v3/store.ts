/**
 * The v3 page's save wiring (src/app/profileStore.ts' header, the lead's ruling P3): save v2's
 * slots from createPlatform under the flavor's prefix (profileSavePrefix: PROFILE_SAVE_PREFIX in
 * the full game, DEMO_PROFILE_SAVE_PREFIX in the Demo, so the two never share a slot on one
 * origin), the M1 page's v1 slots for the one-time import (none on Steam, nor where the page has
 * no localStorage), the load context of the registered content in the flavor's scope (./scope.ts:
 * DEMO_SCOPE_A in the Demo, else FULL_SCOPE), and ISO timestamps. The page sends no playtest event
 * in B1, so its analytics is a stand-in that only drops events.
 */

import type { Content } from '../../data/web';
import { createPlatform } from '../../platform';
import { FLAVOR } from '../../platform/flavor';
import type { Flavor } from '../../platform/flavor';
import type { Platform, PlatformId } from '../../platform';
import type { Analytics } from '../../platform/analytics';
import { pageLocalStorage } from '../../platform/platform';
import {
  adoptSlots,
  LocalSaveStorage,
  PROFILE_SAVE_PREFIX,
  profileSavePrefix,
} from '../../platform/storage';
import type { SaveStorage } from '../../platform/storage';
import { profileContext } from '../../save/profile';
import { ProfileStore } from '../profileStore';
import { gameScope } from './scope';

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

/**
 * The Demo's one-time adoption on the web: Demo players saved under PROFILE_SAVE_PREFIX until the
 * Demo had a prefix of its own, so a Demo page whose own two slots are empty copies that prefix's
 * slots into its own (adoptSlots), never touching the old keys. A copy loads in DEMO_SCOPE_A as
 * any save does, so a full game's save copied this way can lose progress in the Demo's copy
 * alone. The full game never adopts, nor does Steam, whose files ignore the prefix. A page without
 * localStorage keeps its slots in memory, with nothing to adopt.
 */
export function adoptSharedSlots(platform: PlatformId, flavor: Flavor, local: () => Storage): void {
  if (flavor !== 'demo' || platform !== 'web') return;
  let storage: Storage;
  try {
    storage = local();
  } catch {
    return;
  }
  adoptSlots(storage, PROFILE_SAVE_PREFIX, profileSavePrefix(flavor));
}

/** The page's ProfileStore in `flavor` (the build's; the tests pass their own), not yet open. */
export function openProfileStore(content: Content, flavor: Flavor = FLAVOR): ProfileStore {
  const platform = createPlatform({
    savePrefix: profileSavePrefix(flavor),
    analytics: () => NO_ANALYTICS,
  });
  adoptSharedSlots(platform.id, flavor, pageLocalStorage);
  return new ProfileStore({
    storage: platform.storage,
    v1: v1Storage(platform),
    context: profileContext(content, gameScope(flavor)),
    now: () => new Date().toISOString(),
  });
}
