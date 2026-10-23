/**
 * Save migrations: MIGRATIONS[v] turns version v data into version v + 1; parseProfile
 * (src/save/profile.ts) runs them in order, and a throw makes the text invalid. Version 1 is M1's
 * format and version 2 save v2 (docs/v3 C8 design §2.2). This module imports only ./format and
 * CHARACTER_IDS (src/data/sources.ts, whose imports are types only) and writes v2's empty parts as
 * literals, so the M1 entry (src/save/index.ts), which imports it, loads nothing of save v2 (D1);
 * src/save/migrations.test.ts checks those literals against toProfileData(freshProfile()).
 */

import { CHARACTER_IDS } from '../data/sources';
import { SaveDataSchema } from './format';
import type { MetaSave } from './format';

export type Migration = (data: unknown) => unknown;

/** A slot before any play, as toProfileData writes freshProfile's (§1.3). */
const emptySlot = () => ({
  ranks: {},
  wallet: { shards: 0, cores: 0, resonance: 0 },
  spent: { shards: 0, cores: 0, resonance: 0 },
  bestWave: 0,
  cycleBest: 0,
  prestiges: 0,
  resonanceEarned: 0,
  ascendancy: null,
  runs: 0,
  loadouts: [null, null, null],
  startWave: null,
});

/**
 * v1's progress waiting for the first pick (impl:506; F5): everything it holds or spent, each
 * currency one IEEE addition, shards clamped to Number.MAX_VALUE when the sum is not finite and
 * cores to Number.MAX_SAFE_INTEGER (both unreachable under 1e300), and its farthest wave; null
 * when all three are 0.
 */
function pendingOf(meta: MetaSave) {
  const sum = meta.shards + meta.spentShards;
  const shards = Number.isFinite(sum) ? sum : Number.MAX_VALUE;
  const cores = Math.min(meta.cores + meta.spentCores, Number.MAX_SAFE_INTEGER);
  const { maxWave } = meta;
  return shards === 0 && cores === 0 && maxWave === 0 ? null : { shards, cores, maxWave };
}

/**
 * v1 → v2 (§2.2): M1's data, parsed with SaveDataSchema (which throws on bad data), becomes four
 * empty slots and an account holding its speed, its play time and runs, and its progress as the
 * pending. The allocation and ranks are dropped, since everything goes back (impl:506): a stale
 * allocation changes nothing, nor does a save the M1 page refunded already, as (s + p) + 0 is
 * s + p. Every enemy type is met afresh: seenEnemies is [] (C7's ruling L7).
 */
function v1ToV2(data: unknown): unknown {
  const v1 = SaveDataSchema.parse(data);
  return {
    account: {
      codex: {},
      singularity: Object.fromEntries(CHARACTER_IDS.map((c) => [c, false])),
      settings: { speed: v1.speed },
      stats: { playSeconds: v1.playSeconds, runs: v1.meta.runs },
      lastCharacter: null,
      pendingV1: pendingOf(v1.meta),
      seenEnemies: [],
    },
    characters: Object.fromEntries(CHARACTER_IDS.map((c) => [c, emptySlot()])),
  };
}

export const MIGRATIONS: Readonly<Record<number, Migration>> = { 1: v1ToV2 };
