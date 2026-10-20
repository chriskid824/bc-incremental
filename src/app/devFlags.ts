/**
 * Developer URL flags of the browser build (docs/v3 C5 design D21). `?hive` opens the 蜂巢
 * prototype: runs play the swarm signature, the profile lives under its own save keys and starts
 * from a preset save, the center is the hive with its drones, and no playtest events are sent.
 * Under it, `&wave=N` starts the first run at wave N and `&shards=N` tops the shards up to at
 * least N; without `?hive` neither does anything. Like `?lang=`, these are not player text.
 * Everything main.ts does with them is here, pure, so the tests reach it.
 */

import { max, num } from '../core/num';
import type { SignatureSpec } from '../data/rules';
import type { MetaState } from '../meta';
import type { SaveStorage } from '../platform/storage';
import type { Session } from './session';

export interface DevFlags {
  /** `?hive`, with or without a value. */
  readonly hive: boolean;
  /** `&wave=N` under `?hive`, clamped to 1 .. the wave cap; null when absent or not a number. */
  readonly wave: number | null;
  /** `&shards=N` under `?hive`, a whole number ≥ 0; null when absent, negative or not a number. */
  readonly shards: number | null;
}

/** Save keys of the `?hive` profile (`…main`, `…backup`), apart from the player's own save. */
export const HIVE_SAVE_PREFIX = 'bc-incremental.hive.save.';

/** The signature attack of every `?hive` run: 蜂巢's swarm (src/sim/rules/swarm.ts). */
export const HIVE_SIGNATURE: SignatureSpec = { id: 'swarm' };

/** A whole number in decimal digits, optionally negative. */
const WHOLE = /^-?\d+$/;

/** The flags in a page's query string (location.search); `&wave=` is clamped to `waveCap`. */
export function readDevFlags(search: string, waveCap: number): DevFlags {
  const params = new URLSearchParams(search);
  if (!params.has('hive')) return { hive: false, wave: null, shards: null };
  const wave = wholeNumber(params.get('wave'));
  const shards = wholeNumber(params.get('shards'));
  return {
    hive: true,
    wave: wave === null ? null : Math.min(Math.max(1, wave), Math.max(1, waveCap)),
    shards: shards === null || shards < 0 ? null : shards,
  };
}

/** The whole number `text` spells, or null for anything else (empty, a fraction, junk). */
function wholeNumber(text: string | null): number | null {
  if (text === null || !WHOLE.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Writes `save` into an empty slot set, neither main nor backup holding anything, and returns
 * whether it did: the first `?hive` opens on the preset, and whatever the hive slots already
 * hold (progress made since, a respec, a lowered start wave) is kept.
 */
export function seedEmptySlots(storage: SaveStorage, save: string): boolean {
  if (storage.read('main') !== null || storage.read('backup') !== null) return false;
  storage.write('main', save);
  return true;
}

/** `&shards=N`: raises the shards to at least N, so a reload does not keep adding them. */
export function raiseShards(meta: MetaState, shards: number | null): void {
  if (shards !== null) meta.shards = max(meta.shards, num(shards));
}

/**
 * Opens a returning profile on the talent web, then, under `&wave=N`, picks N through `pick`,
 * the start-wave selector's own path. resume() aims afresh, lowering a start wave above the
 * build's reach to the reach, so the pick comes after it; picked above the reach, it stands for
 * the next run.
 */
export function resumeAtWave(
  session: Pick<Session, 'resume'>,
  wave: number | null,
  pick: (wave: number) => void,
): void {
  session.resume();
  if (wave !== null) pick(wave);
}

/**
 * Starts a fresh profile's first run, at wave N under `&wave=N`: picked first, since the run's
 * own aim would otherwise lower it to the fresh build's reach.
 */
export function startAtWave(
  session: Pick<Session, 'setStartWave' | 'start'>,
  wave: number | null,
): void {
  if (wave !== null) session.setStartWave(wave);
  session.start();
}
