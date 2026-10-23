/**
 * The v1 → v2 migration (docs/v3 C8 design §2.2): MIGRATIONS[1]'s empty parts, written as literals,
 * against toProfileData(freshProfile()) (T1's check; D1, the lead's ruling K7), its conservation
 * over 500 random v1 saves (T3), its numbers on the fixtures (T4), F5's clamps (K5), the enemy
 * types met it writes (K3), its refusal of bad v1 data and the imports that keep the M1 entry
 * free of save v2. Inputs are deep-frozen, so a mutation throws.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed } from '../core/rng';
import type { Rng } from '../core/rng';
import { loadGameData } from '../data';
import { SAVE_VERSION } from './format';
import type { SaveData } from './format';
import { MIGRATIONS } from './migrations';
import type { Migration } from './migrations';
import { freshProfile, parseProfile, ProfileDataSchema, toProfileData } from './profile';
import type { ProfileData } from './profile';
import { deepFreeze, fixtureContext } from './testing';

const migrate = MIGRATIONS[1] as Migration;
const FRESH: ProfileData = deepFreeze(toProfileData(freshProfile()));

const fixture = (name: string): string =>
  readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), 'utf8');
/** A v1 fixture's data, frozen. */
const v1DataOf = (text: string): SaveData =>
  deepFreeze((JSON.parse(text) as { data: SaveData }).data);

/** A v1 save with nothing in it: no currency, wave, run or play time, speed 1. */
const EMPTY_V1: SaveData = deepFreeze({
  meta: {
    shards: 0,
    cores: 0,
    allocated: [],
    ranks: {},
    maxWave: 0,
    runs: 0,
    spentShards: 0,
    spentCores: 0,
  },
  playSeconds: 0,
  speed: 1,
});

/** EMPTY_V1 with `changes` to its meta, frozen. */
const withMeta = (changes: Partial<SaveData['meta']>): SaveData =>
  deepFreeze({ ...EMPTY_V1, meta: { ...EMPTY_V1.meta, ...changes } });

/** MIGRATIONS[1] of `data`, as the v2 schema reads it. */
const v2Of = (data: SaveData): ProfileData => ProfileDataSchema.parse(migrate(data));

describe('MIGRATIONS[1]: the empty parts (T1’s check; D1, the lead’s ruling K7)', () => {
  it('writes an empty v1 save as toProfileData(freshProfile()), text and key order alike', () => {
    expect(JSON.stringify(migrate(EMPTY_V1))).toBe(JSON.stringify(FRESH));
  });

  it('gives every character an empty slot and the account nothing v1 lacks, whatever v1 holds', () => {
    const v2 = v2Of(v1DataOf(fixture('save-v1-playtest.json')));
    expect(JSON.stringify(v2.characters)).toBe(JSON.stringify(FRESH.characters));
    const { codex, singularity, lastCharacter, seenEnemies } = v2.account;
    expect({ codex, singularity, lastCharacter, seenEnemies }).toEqual({
      codex: {},
      singularity: FRESH.account.singularity,
      lastCharacter: null,
      seenEnemies: [],
    });
  });

  it('meets every enemy type afresh: seenEnemies is [] (the lead’s ruling K3)', () => {
    for (const data of [
      EMPTY_V1,
      withMeta({ maxWave: 40, runs: 300 }),
      v1DataOf(fixture('save-v1.json')),
    ]) {
      expect(v2Of(data).account.seenEnemies).toEqual([]);
    }
  });

  it('has a migration for every version below SAVE_VERSION, and none from it', () => {
    for (let v = 1; v < SAVE_VERSION; v++) expect(MIGRATIONS[v]).toBeTypeOf('function');
    expect(Object.keys(MIGRATIONS)).toEqual(
      Array.from({ length: SAVE_VERSION - 1 }, (_, i) => String(i + 1)),
    );
  });

  it('imports only ./format and CHARACTER_IDS, whose module imports types only', () => {
    const importsOf = (path: string): string[] => {
      const text = readFileSync(new URL(path, import.meta.url), 'utf8');
      return [...text.matchAll(/^import [^;]*;/gm)].map(([statement]) => statement);
    };
    expect(importsOf('./migrations.ts')).toEqual([
      "import { CHARACTER_IDS } from '../data/sources';",
      "import { SaveDataSchema } from './format';",
      "import type { MetaSave } from './format';",
    ]);
    for (const statement of importsOf('../data/sources.ts')) {
      expect(statement).toMatch(/^import type /);
    }
  });
});

const T3_SEED = 0xc82;
const STALE_ID = 'retiredTalent';
const M1_IDS = loadGameData().talents.map((node) => node.id);

/** A shard amount for T3: 0, a small fraction, log-uniform from 0.001 to 1e300, or MAX_VALUE. */
function v1Amount(rng: Rng): number {
  const kind = rng.next();
  if (kind < 0.15) return 0;
  if (kind < 0.45) return rng.next() * 1000;
  if (kind < 0.9) return 10 ** rng.range(-3, 300);
  return Number.MAX_VALUE;
}

/** A count of cores for T3: up to 10^6, or within 4 of 2^52. */
const v1Count = (rng: Rng): number =>
  rng.chance(0.15) ? 2 ** 52 - 4 + rng.int(9) : rng.int(1_000_001);

/** A random v1 save: M1 ids and sometimes a stale one, its might ranks, waves 0 to 40. */
function randomV1(rng: Rng): SaveData {
  const allocated = M1_IDS.filter(() => rng.chance(0.3));
  if (rng.chance(0.2)) allocated.push(STALE_ID);
  return {
    meta: {
      shards: v1Amount(rng),
      cores: v1Count(rng),
      allocated,
      ranks: allocated.includes('might') ? { might: 1 + rng.int(20) } : {},
      maxWave: rng.int(41),
      runs: rng.int(1000),
      spentShards: v1Amount(rng),
      spentCores: v1Count(rng),
    },
    playSeconds: rng.chance(0.1) ? 0 : 10 ** rng.range(-1, 6),
    speed: rng.pick([1, 2, 4] as const),
  };
}

/** T3's 500 v1 saves, and the empty one, whose progress is all 0. */
const V1_SAVES: readonly SaveData[] = deepFreeze([
  ...Array.from({ length: 500 }, (_, i) => randomV1(createRng(deriveSeed(T3_SEED, `v1:${i}`)))),
  EMPTY_V1,
]);

/**
 * The save the M1 page would hold after refunding `data` (src/meta/talents.ts' refundAll): its
 * spent back in the bank, nothing allocated. Null when the bank could not hold the sum.
 */
function refundedTwin(data: SaveData): SaveData | null {
  const { meta } = data;
  const shards = meta.shards + meta.spentShards;
  const cores = meta.cores + meta.spentCores;
  if (!Number.isFinite(shards) || !Number.isSafeInteger(cores)) return null;
  return deepFreeze({
    ...data,
    meta: { ...meta, shards, cores, allocated: [], ranks: {}, spentShards: 0, spentCores: 0 },
  });
}

// T3 catches Math.round on the sum, spentCores forgotten and the post-refund wallet without the
// spent part.
describe('MIGRATIONS[1]: conservation (T3, property over 500 random v1 saves)', () => {
  it('gives the pending every shard and core v1 holds or spent, and its farthest wave', () => {
    const issues: string[] = [];
    for (const [i, data] of V1_SAVES.entries()) {
      const { meta } = data;
      const { pendingV1 } = v2Of(data).account;
      const sum = meta.shards + meta.spentShards;
      const shards = Number.isFinite(sum) ? sum : Number.MAX_VALUE;
      const cores = Math.min(meta.cores + meta.spentCores, Number.MAX_SAFE_INTEGER);
      if (shards === 0 && cores === 0 && meta.maxWave === 0) {
        if (pendingV1 !== null) issues.push(`${i}: a pending for nothing`);
        continue;
      }
      if (pendingV1 === null) {
        issues.push(`${i}: no pending`);
      } else if (
        !Object.is(pendingV1.shards, shards) ||
        pendingV1.cores !== cores ||
        pendingV1.maxWave !== meta.maxWave
      ) {
        issues.push(`${i}: ${JSON.stringify(pendingV1)}, not ${shards}, ${cores}, ${meta.maxWave}`);
      }
    }
    expect(issues).toEqual([]);
  });

  it('carries the stats and the speed, and writes the empty parts', () => {
    for (const data of V1_SAVES) {
      const { account, characters } = v2Of(data);
      expect(Object.is(account.stats.playSeconds, data.playSeconds)).toBe(true);
      expect(account.stats.runs).toBe(data.meta.runs);
      expect(account.settings.speed).toBe(data.speed);
      expect(characters).toEqual(FRESH.characters);
      expect(account.lastCharacter).toBeNull();
    }
  });

  it('gives a save the M1 page refunded the same values as the save before the refund', () => {
    let twins = 0;
    for (const data of V1_SAVES) {
      const twin = refundedTwin(data);
      if (twin === null) continue;
      twins += 1;
      const before = v2Of(data).account.pendingV1;
      const after = v2Of(twin).account.pendingV1;
      expect(after).toEqual(before);
      if (before !== null && after !== null) {
        expect(Object.is(after.shards, before.shards)).toBe(true);
      }
    }
    expect(twins).toBeGreaterThan(400);
  });

  it('covers overflowing and clamped sums, fractions, stale ids and an all-zero save', () => {
    const shards = ({ meta }: SaveData): number => meta.shards + meta.spentShards;
    const cores = ({ meta }: SaveData): number => meta.cores + meta.spentCores;
    const count = (holds: (data: SaveData) => boolean): number => V1_SAVES.filter(holds).length;
    const counts = {
      overflowing: count((d) => !Number.isFinite(shards(d))),
      fractional: count((d) => shards(d) > 1 && shards(d) < 1e6 && !Number.isInteger(shards(d))),
      huge: count((d) => Number.isFinite(shards(d)) && shards(d) > 1e200),
      clamped: count((d) => cores(d) > Number.MAX_SAFE_INTEGER),
      nearSafe: count((d) => cores(d) > 2 ** 52 && cores(d) <= Number.MAX_SAFE_INTEGER),
      stale: count((d) => d.meta.allocated.includes(STALE_ID)),
      noWave: count((d) => d.meta.maxWave === 0 && shards(d) + cores(d) > 0),
      noPending: count((d) => v2Of(d).account.pendingV1 === null),
    };
    const least = {
      overflowing: 5,
      fractional: 40,
      huge: 100,
      clamped: 4,
      nearSafe: 60,
      stale: 40,
      noWave: 5,
      noPending: 1,
    };
    for (const [name, n] of Object.entries(least)) {
      expect(counts[name as keyof typeof least], JSON.stringify(counts)).toBeGreaterThanOrEqual(n);
    }
    expect(M1_IDS).not.toContain(STALE_ID);
  });
});

// T4 catches spentShards left out.
describe('MIGRATIONS[1] on the fixtures (T4)', () => {
  it('gives save-v1.json the pending {2221.75, 3, 18}, stats {1520, 27} and speed 2', () => {
    const loaded = parseProfile(fixture('save-v1.json'), fixtureContext());
    expect(loaded).toMatchObject({ ok: true, fromVersion: 1 });
    if (!loaded.ok) return;
    const { account } = loaded.profile;
    expect(account.pendingV1).toEqual({ shards: 1234.5 + 987.25, cores: 3, maxWave: 18 });
    expect(Object.is(account.pendingV1?.shards, 2221.75)).toBe(true);
    expect(account.stats).toEqual({ playSeconds: 1520, runs: 27 });
    expect(account.settings.speed).toBe(2);
  });

  it('gives the playtest save its own sums', () => {
    const text = fixture('save-v1-playtest.json');
    const { meta, playSeconds, speed } = v1DataOf(text);
    const loaded = parseProfile(text, fixtureContext());
    expect(loaded).toMatchObject({ ok: true, fromVersion: 1 });
    if (!loaded.ok) return;
    const { account } = loaded.profile;
    expect(account.pendingV1).toEqual({
      shards: meta.shards + meta.spentShards,
      cores: meta.cores + meta.spentCores,
      maxWave: meta.maxWave,
    });
    expect(Object.is(account.pendingV1?.shards, meta.shards + meta.spentShards)).toBe(true);
    expect(meta.spentCores).toBeGreaterThan(0);
    expect(account.stats).toEqual({ playSeconds, runs: meta.runs });
    expect(account.settings.speed).toBe(speed);
  });
});

describe('MIGRATIONS[1]: F5’s clamps and the empty pending (the lead’s ruling K5)', () => {
  it('clamps shards to Number.MAX_VALUE when the sum is not finite', () => {
    const max = Number.MAX_VALUE;
    for (const [shards, spentShards] of [
      [max, max],
      [max, 1e300],
      [1e300, max],
    ] as const) {
      expect(v2Of(withMeta({ shards, spentShards })).account.pendingV1?.shards).toBe(max);
    }
    expect(v2Of(withMeta({ shards: 1e300, spentShards: 1e300 })).account.pendingV1?.shards).toBe(
      2e300,
    );
  });

  it('clamps cores to Number.MAX_SAFE_INTEGER', () => {
    const safe = Number.MAX_SAFE_INTEGER;
    for (const [cores, spentCores] of [
      [safe, safe],
      [safe, 1],
      [2 ** 52, 2 ** 52],
    ] as const) {
      expect(v2Of(withMeta({ cores, spentCores })).account.pendingV1?.cores).toBe(safe);
    }
    expect(v2Of(withMeta({ cores: safe - 1, spentCores: 1 })).account.pendingV1?.cores).toBe(safe);
    expect(v2Of(withMeta({ cores: 2 ** 52, spentCores: 7 })).account.pendingV1?.cores).toBe(
      2 ** 52 + 7,
    );
  });

  it('gives no pending when shards, cores and the farthest wave are all 0, and one otherwise', () => {
    expect(v2Of(EMPTY_V1).account.pendingV1).toBeNull();
    expect(
      v2Of(withMeta({ allocated: ['might'], ranks: { might: 2 }, runs: 4 })).account.pendingV1,
    ).toBeNull();
    expect(v2Of(withMeta({ maxWave: 1 })).account.pendingV1).toEqual({
      shards: 0,
      cores: 0,
      maxWave: 1,
    });
    expect(v2Of(withMeta({ spentCores: 1 })).account.pendingV1).toEqual({
      shards: 0,
      cores: 1,
      maxWave: 0,
    });
    expect(v2Of(withMeta({ spentShards: 5e-324 })).account.pendingV1).toEqual({
      shards: 5e-324,
      cores: 0,
      maxWave: 0,
    });
  });
});

describe('MIGRATIONS[1]: bad v1 data', () => {
  it('throws on data the v1 schema refuses, and changes nothing it is given', () => {
    const bad: unknown[] = [
      null,
      'save',
      [],
      {},
      { ...EMPTY_V1, speed: 3 },
      { ...EMPTY_V1, extra: 1 },
      { meta: EMPTY_V1.meta, speed: 1 },
      withMeta({ shards: -1 }),
      withMeta({ cores: 1.5 }),
      withMeta({ ranks: { might: -1 } }),
      FRESH,
    ];
    for (const data of bad) expect(() => migrate(deepFreeze(data)), JSON.stringify(data)).toThrow();
    expect(() => migrate(v1DataOf(fixture('save-v1.json')))).not.toThrow();
  });
});
