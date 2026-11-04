/**
 * The mute choice, kept per device in the page's key-value store (localStorage through
 * src/platform's openKeyValueStore, an in-memory map where the page may not use it), not in the
 * save: save v2's account settings are a strict schema, and a sound toggle is no progress.
 */

import type { KeyValueStore } from '../platform/analytics';

export const MUTED_KEY = 'bc-incremental.audio.muted';

export function readMuted(store: KeyValueStore): boolean {
  try {
    return store.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeMuted(store: KeyValueStore, muted: boolean): void {
  try {
    store.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch {
    // Private mode or a full quota: the choice lasts for the session.
  }
}
