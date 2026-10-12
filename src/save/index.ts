/**
 * Save serialization and loading (docs/ARCHITECTURE.md §8). Pure: the caller provides the
 * timestamp and does the storage I/O (src/platform).
 */

import { fromJSON, toJSON } from '../core/num';
import type { GameData } from '../data/types';
import { refundAll } from '../meta/talents';
import type { MetaState } from '../meta/types';
import { EnvelopeSchema, SAVE_GAME_ID, SAVE_VERSION, SaveDataSchema } from './format';
import type { Envelope, SaveData } from './format';
import { MIGRATIONS } from './migrations';

export * from './format';
export { MIGRATIONS } from './migrations';

export interface Profile {
  readonly meta: MetaState;
  playSeconds: number;
  speed: 1 | 2 | 4;
}

export function toSaveData(profile: Readonly<Profile>): SaveData {
  const { meta } = profile;
  return {
    meta: {
      shards: toJSON(meta.shards),
      cores: meta.cores,
      allocated: [...meta.allocated],
      ranks: Object.fromEntries(meta.ranks),
      maxWave: meta.maxWave,
      runs: meta.runs,
      spentShards: toJSON(meta.spentShards),
      spentCores: meta.spentCores,
    },
    playSeconds: profile.playSeconds,
    speed: profile.speed,
  };
}

/**
 * Every allocated id exists, ranks belong to allocated repeatable nodes, and the allocation
 * is connected to the start node through allocated nodes.
 */
function allocationFits(meta: Readonly<MetaState>, data: GameData): boolean {
  const byId = new Map(data.talents.map((node) => [node.id, node]));
  for (const id of meta.allocated) {
    const node = byId.get(id);
    if (node === undefined || node.kind === 'start') return false;
    if ((node.kind === 'repeatable') !== meta.ranks.has(id)) return false;
  }
  for (const id of meta.ranks.keys()) if (!meta.allocated.has(id)) return false;
  const start = data.talents.find((node) => node.kind === 'start');
  if (start === undefined) return meta.allocated.size === 0;
  const reached = new Set<string>();
  const queue = [start.id];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const link of byId.get(id)?.links ?? []) {
      if (meta.allocated.has(link) && !reached.has(link)) {
        reached.add(link);
        queue.push(link);
      }
    }
  }
  return reached.size === meta.allocated.size;
}

/** JSON text of the current-version envelope. `savedAt` is an ISO timestamp. */
export function serializeSave(profile: Readonly<Profile>, savedAt: string): string {
  const envelope: Envelope = {
    v: SAVE_VERSION,
    savedAt,
    game: SAVE_GAME_ID,
    data: toSaveData(profile),
  };
  return JSON.stringify(envelope);
}

export type LoadResult =
  | {
      readonly ok: true;
      readonly profile: Profile;
      /** Version the file was written with (≤ SAVE_VERSION). */
      readonly fromVersion: number;
      /** Talents unknown to this build were found; everything was refunded. */
      readonly refunded: boolean;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Parses a save, migrates it to the current version and validates it. Talent ids the
 * current data does not know (renamed or removed nodes) trigger a full free refund, so a
 * player never loses currency to a content change.
 */
export function loadSave(text: string, data: GameData): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { ok: false, error: `bad envelope: ${envelope.error.message}` };
  const { v } = envelope.data;
  if (v > SAVE_VERSION) return { ok: false, error: `save version ${v} is newer than this build` };

  let body = envelope.data.data;
  for (let version = v; version < SAVE_VERSION; version++) {
    const migrate = MIGRATIONS[version];
    if (migrate === undefined) return { ok: false, error: `no migration from version ${version}` };
    body = migrate(body);
  }
  const parsed = SaveDataSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: `bad data: ${parsed.error.message}` };
  const save = parsed.data;

  const meta: MetaState = {
    shards: fromJSON(save.meta.shards),
    cores: save.meta.cores,
    allocated: new Set(save.meta.allocated),
    ranks: new Map(Object.entries(save.meta.ranks)),
    maxWave: save.meta.maxWave,
    runs: save.meta.runs,
    spentShards: fromJSON(save.meta.spentShards),
    spentCores: save.meta.spentCores,
  };
  const stale = !allocationFits(meta, data);
  if (stale) refundAll(meta);
  return {
    ok: true,
    profile: { meta, playSeconds: save.playSeconds, speed: save.speed },
    fromVersion: v,
    refunded: stale,
  };
}
