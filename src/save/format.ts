/**
 * Save file format (docs/ARCHITECTURE.md §8): a versioned JSON envelope around the profile.
 * Changing SaveData means: bump SAVE_VERSION, add a migration from the previous version in
 * src/save/migrations.ts, and add a fixture under tests/fixtures.
 */

import { z } from 'zod';

export const SAVE_GAME_ID = 'bc-incremental';
export const SAVE_VERSION = 1;

const finite = z.number();
const count = z.number().int().nonnegative();

export const MetaSaveSchema = z.strictObject({
  shards: finite.nonnegative(),
  cores: count,
  /** Allocated talent ids, repeatable nodes included once. */
  allocated: z.array(z.string()),
  /** Ranks bought on repeatable nodes, by node id. */
  ranks: z.record(z.string(), count),
  maxWave: count,
  runs: count,
  spentShards: finite.nonnegative(),
  spentCores: count,
});

export const SaveDataSchema = z.strictObject({
  meta: MetaSaveSchema,
  /** Total time spent in runs and menus, in seconds. */
  playSeconds: finite.nonnegative(),
  /** Game speed the player last picked. */
  speed: z.union([z.literal(1), z.literal(2), z.literal(4)]),
});

export type MetaSave = z.infer<typeof MetaSaveSchema>;
export type SaveData = z.infer<typeof SaveDataSchema>;

/** The envelope written to storage. `data` is validated after migration. */
export const EnvelopeSchema = z.strictObject({
  v: z.number().int().positive(),
  savedAt: z.string(),
  game: z.literal(SAVE_GAME_ID),
  data: z.unknown(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
