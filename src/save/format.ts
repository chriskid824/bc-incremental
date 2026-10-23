/**
 * Save file format (docs/ARCHITECTURE.md §8): a versioned JSON envelope around the profile.
 * Version 2 is save v2 (docs/v3 C8 design §1), whose data is ProfileDataSchema
 * (src/save/profile.ts); version 1 is M1's SaveData, which the M1 entry (src/save/index.ts) still
 * writes and reads under M1_SAVE_VERSION. Changing the data means: bump SAVE_VERSION, add a
 * migration from the previous version in src/save/migrations.ts, and add a fixture under
 * tests/fixtures.
 */

import { z } from 'zod';

export const SAVE_GAME_ID = 'bc-incremental';
/** The version parseProfile and serializeProfile (src/save/profile.ts) read and write. */
export const SAVE_VERSION = 2;
/**
 * M1's version: the M1 page, `?hive`, `hivePreset` and the tools until C6's D34 retires them;
 * src/save/index.ts writes it and reads nothing newer.
 */
export const M1_SAVE_VERSION = 1;

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

/** Version 1's data (M1). */
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
