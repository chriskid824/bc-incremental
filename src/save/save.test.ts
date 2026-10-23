/**
 * Save files (docs/v3 C8 design §1.1, §1.5, §2.2): the M1 entry, which stays v1-only (T2), and save
 * v2's loader and serializer: every fixture through parseProfile (T1), the notices and `changed`
 * (the lead's ruling K5), the claim kept through a save (T5), the refusals (T6), D2's refusal to
 * write what this build cannot read (T7), byte stability (T8), the format's tripwire (T9; D7) and
 * zod's drop of a `__proto__` key (K4). Inputs are deep-frozen where an operation takes them.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fromJSON, num, toNumber } from '../core/num';
import type * as NumModule from '../core/num';
import { loadGameData } from '../data';
import type { CharacterId } from '../data/sources';
import { loadContent } from '../data/web';
import { FULL_SCOPE } from '../data/web/scope';
import { createMetaState } from '../meta';
import { loadSave, M1_SAVE_VERSION, serializeSave } from '.';
import type { Profile } from '.';
import { EnvelopeSchema, SAVE_VERSION, SaveDataSchema } from './format';
import type { MetaSave } from './format';
import { MIGRATIONS } from './migrations';
import type { Migration } from './migrations';
import {
  freshProfile,
  fromProfileData,
  parseProfile,
  ProfileDataSchema,
  profileContext,
  SaveFormatError,
  selectCharacter,
  serializeProfile,
  toProfileData,
} from './profile';
import type { CharacterSlot, SaveProfile } from './profile';
import {
  conservationIssues,
  deepFreeze,
  fixtureContext,
  PROFILE_SEED,
  randomProfiles,
  staleTwinV1,
} from './testing';

// fromJSON, wrapped so a test can make it throw once; it reads every amount as before otherwise.
vi.mock('../core/num', async (importOriginal) => {
  const actual = await importOriginal<typeof NumModule>();
  return { ...actual, fromJSON: vi.fn(actual.fromJSON) };
});

const data = loadGameData();
const FIXTURES = new URL('../../tests/fixtures/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
/** `text` without its formatting, as serializeProfile writes JSON. */
const minified = (text: string): string => JSON.stringify(JSON.parse(text));
const savedAtOf = (text: string): string => EnvelopeSchema.parse(JSON.parse(text)).savedAt;
/** A v1 save's meta, as the v1 schema reads it. */
const v1MetaOf = (text: string): MetaSave =>
  SaveDataSchema.parse(EnvelopeSchema.parse(JSON.parse(text)).data).meta;

/** An id the M1 web does not have: the stale twins' (the lead's ruling K2). */
const STALE_ID = 'retiredTalent';

/** The four fixture webs, and the registered content's (none while no center is registered). */
const FIXTURE_CONTEXT = fixtureContext();
const CONTENT_CONTEXT = profileContext(loadContent(), FULL_SCOPE);

function profile(): Profile {
  const meta = createMetaState();
  meta.shards = num(42.5);
  meta.cores = 2;
  meta.allocated.add('spark');
  meta.allocated.add('might');
  meta.ranks.set('might', 3);
  meta.maxWave = 12;
  meta.runs = 9;
  meta.spentShards = num(100);
  meta.spentCores = 1;
  return { meta, playSeconds: 600, speed: 4 };
}

describe('save (the M1 page’s v1 format)', () => {
  it('round-trips a profile', () => {
    const text = serializeSave(profile(), '2026-10-20T00:00:00.000Z');
    const loaded = loadSave(text, data);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.fromVersion).toBe(M1_SAVE_VERSION);
    expect(loaded.refunded).toBe(false);
    const { meta } = loaded.profile;
    expect(toNumber(meta.shards)).toBe(42.5);
    expect([...meta.allocated]).toEqual(['spark', 'might']);
    expect(meta.ranks.get('might')).toBe(3);
    expect(loaded.profile.speed).toBe(4);
  });

  it('refunds everything when the allocation no longer fits the talent web', () => {
    const p = profile();
    p.meta.allocated.add('removedNode');
    const loaded = loadSave(serializeSave(p, 'now'), data);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.refunded).toBe(true);
    expect(loaded.profile.meta.allocated.size).toBe(0);
    expect(toNumber(loaded.profile.meta.shards)).toBe(142.5);
    expect(loaded.profile.meta.cores).toBe(3);
  });

  it('refunds a disconnected allocation', () => {
    const p = profile();
    p.meta.allocated.add('arcStorm');
    const loaded = loadSave(serializeSave(p, 'now'), data);
    expect(loaded.ok && loaded.refunded).toBe(true);
  });

  it('rejects garbage, other games and newer versions', () => {
    expect(loadSave('{', data).ok).toBe(false);
    expect(loadSave(JSON.stringify({ v: 1, savedAt: '', game: 'x', data: {} }), data).ok).toBe(
      false,
    );
    const newer = JSON.parse(serializeSave(profile(), 'now')) as { v: number };
    newer.v = M1_SAVE_VERSION + 1;
    expect(loadSave(JSON.stringify(newer), data)).toMatchObject({ ok: false });
    const bad = JSON.parse(serializeSave(profile(), 'now')) as { data: { speed: number } };
    bad.data.speed = 3;
    expect(loadSave(JSON.stringify(bad), data).ok).toBe(false);
  });
});

// T2 catches v: SAVE_VERSION left in serializeSave and the M1 loader migrating.
describe('the M1 loader stays v1-only (T2; F1, D1)', () => {
  const V1_FIXTURES = ['save-v1.json', 'save-v1-playtest.json'];

  it('writes v: 1, M1_SAVE_VERSION, below SAVE_VERSION', () => {
    expect(M1_SAVE_VERSION).toBe(1);
    expect(SAVE_VERSION).toBeGreaterThan(M1_SAVE_VERSION);
    expect(EnvelopeSchema.parse(JSON.parse(serializeSave(deepFreeze(profile()), 'now'))).v).toBe(1);
  });

  it.each(V1_FIXTURES)('loads %s with nothing refunded', (name) => {
    expect(loadSave(fixture(name), data)).toMatchObject({
      ok: true,
      fromVersion: 1,
      refunded: false,
    });
  });

  it.each(V1_FIXTURES)('refunds the stale twin of %s in full: its shards plus spent', (name) => {
    expect(data.talents.some((node) => node.id === STALE_ID)).toBe(false);
    const text = fixture(name);
    const meta = v1MetaOf(text);
    const loaded = loadSave(staleTwinV1(text, STALE_ID), data);
    expect(loaded).toMatchObject({ ok: true, fromVersion: 1, refunded: true });
    if (!loaded.ok) return;
    const after = loaded.profile.meta;
    expect(Object.is(toNumber(after.shards), meta.shards + meta.spentShards)).toBe(true);
    expect(after.cores).toBe(meta.cores + meta.spentCores);
    expect([after.allocated.size, toNumber(after.spentShards), after.spentCores]).toEqual([
      0, 0, 0,
    ]);
  });

  it('refuses save-v2.json and a v1 save marked 2 with its own text, reading no data', () => {
    const refusal = { ok: false, error: 'save version 2 is newer than this build' };
    expect(loadSave(fixture('save-v2.json'), data)).toEqual(refusal);
    const marked = { ...(JSON.parse(fixture('save-v1.json')) as object), v: 2 };
    expect(loadSave(JSON.stringify(marked), data)).toEqual(refusal);
  });
});

const FIXTURE_FILES = readdirSync(FIXTURES)
  .filter((name) => /^save-v\d+(-[a-z0-9-]+)?\.json$/.test(name))
  .sort();
const versionOf = (name: string): number => Number(/^save-v(\d+)/.exec(name)?.[1]);

/** The profile `text` holds before the load-time fixes: §1.5's pipeline up to fromProfileData. */
function unfixed(text: string): SaveProfile {
  const envelope = EnvelopeSchema.parse(JSON.parse(text));
  let body = envelope.data;
  for (let v = envelope.v; v < SAVE_VERSION; v++) {
    body = (MIGRATIONS[v] as Migration)(deepFreeze(body));
  }
  return fromProfileData(deepFreeze(ProfileDataSchema.parse(body)));
}

// T1 catches MIGRATIONS[1] missing and a misnamed fixture.
describe('every fixture loads in the v3 loader (T1)', () => {
  it('has a fixture for each version from 1 to SAVE_VERSION, and none past it', () => {
    expect(FIXTURE_FILES).toEqual(
      expect.arrayContaining(['save-v1.json', 'save-v1-playtest.json', 'save-v2.json']),
    );
    expect([...new Set(FIXTURE_FILES.map(versionOf))].sort((a, b) => a - b)).toEqual(
      Array.from({ length: SAVE_VERSION }, (_, i) => i + 1),
    );
  });

  it.each(FIXTURE_FILES)(
    'loads %s from its own version on the fixture webs and the content, conserving currency',
    (name) => {
      const text = fixture(name);
      const version = versionOf(name);
      expect(EnvelopeSchema.parse(JSON.parse(text)).v).toBe(version);
      for (const context of [FIXTURE_CONTEXT, CONTENT_CONTEXT]) {
        const loaded = parseProfile(text, context);
        expect(loaded).toMatchObject({ ok: true, fromVersion: version });
        if (!loaded.ok) return;
        expect(conservationIssues(unfixed(text), loaded.profile, loaded.notices, context)).toEqual(
          [],
        );
        if (version !== 1) continue;
        const meta = v1MetaOf(text);
        const pending = loaded.profile.account.pendingV1;
        expect(Object.is(pending?.shards, meta.shards + meta.spentShards)).toBe(true);
        expect(pending?.cores).toBe(meta.cores + meta.spentCores);
      }
    },
  );

  it('loads save-v2.json on the fixture webs with no notice and nothing changed', () => {
    expect(parseProfile(fixture('save-v2.json'), FIXTURE_CONTEXT)).toMatchObject({
      ok: true,
      fromVersion: 2,
      notices: [],
      changed: false,
    });
  });
});

// The lead's ruling K5: parseProfile emits v1Waiting only, and a text of an older version is
// always changed, on top of fixProfile's changes.
describe('parseProfile: notices and changed (§1.5; the lead’s ruling K5)', () => {
  it('has a v1 save’s progress wait for the first pick: v1Waiting with the pending, changed', () => {
    const loaded = parseProfile(fixture('save-v1.json'), FIXTURE_CONTEXT);
    expect(loaded).toMatchObject({ ok: true, fromVersion: 1, changed: true });
    if (!loaded.ok) return;
    const { pendingV1 } = loaded.profile.account;
    expect(pendingV1).toEqual({ shards: 2221.75, cores: 3, maxWave: 18 });
    expect(loaded.notices).toEqual([{ kind: 'v1Waiting', pending: pendingV1 }]);
  });

  it('gives a v1 save without progress no notice, and still changed', () => {
    const v1: Profile = deepFreeze({ meta: createMetaState(), playSeconds: 12.5, speed: 1 });
    const text = serializeSave(v1, 'now');
    const loaded = parseProfile(text, FIXTURE_CONTEXT);
    expect(loaded).toMatchObject({ ok: true, fromVersion: 1, notices: [], changed: true });
    if (!loaded.ok) return;
    expect(loaded.profile.account.pendingV1).toBeNull();
    expect(loaded.profile.account.stats).toEqual({ playSeconds: 12.5, runs: 0 });
  });

  it('gives a v2 save holding a pending no v1Waiting, and changed only for a fix', () => {
    const first = parseProfile(fixture('save-v1.json'), FIXTURE_CONTEXT);
    if (!first.ok) throw new Error('save-v1.json does not load');
    const again = parseProfile(serializeProfile(deepFreeze(first.profile), 'now'), FIXTURE_CONTEXT);
    expect(again).toMatchObject({ ok: true, fromVersion: 2, notices: [], changed: false });
    if (!again.ok) return;
    expect(again.profile).toEqual(first.profile);
  });

  it('drops an enemy id the content lacks, with changed and no notice (the lead’s ruling K3)', () => {
    const text = minified(fixture('save-v2.json'));
    const stale = text.replace('"seenEnemies":["boss",', '"seenEnemies":["boss","gone",');
    expect(stale).not.toBe(text);
    const loaded = parseProfile(stale, FIXTURE_CONTEXT);
    expect(loaded).toMatchObject({ ok: true, fromVersion: 2, notices: [], changed: true });
    if (!loaded.ok) return;
    expect(serializeProfile(deepFreeze(loaded.profile), savedAtOf(text))).toBe(text);
  });
});

// T5 catches the claim lost in the data form.
describe('the claim persists (T5)', () => {
  it('keeps the pending claimed through a save and a load: once, in the fire wallet', () => {
    const loaded = parseProfile(fixture('save-v1.json'), FIXTURE_CONTEXT);
    if (!loaded.ok) throw new Error('save-v1.json does not load');
    const pending = loaded.profile.account.pendingV1;
    if (pending === null) throw new Error('save-v1.json has no pending');
    const { profile: claimed, claimed: pendingClaimed } = selectCharacter(
      deepFreeze(loaded.profile),
      'fire',
    );
    expect(pendingClaimed).toBe(pending);
    const back = parseProfile(serializeProfile(deepFreeze(claimed), 'now'), FIXTURE_CONTEXT);
    expect(back).toMatchObject({ ok: true, fromVersion: 2, notices: [], changed: false });
    if (!back.ok) return;
    const { account, characters } = back.profile;
    expect(account.pendingV1).toBeNull();
    expect(account.lastCharacter).toBe('fire');
    const { wallet, spent, bestWave, cycleBest } = characters.fire.progress;
    expect(Object.is(wallet.shards, pending.shards)).toBe(true);
    expect([wallet.cores, bestWave, cycleBest]).toEqual([pending.cores, 18, 18]);
    expect(spent).toEqual({ shards: 0, cores: 0, resonance: 0 });
    for (const c of ['fire', 'ice'] as const) {
      expect(selectCharacter(deepFreeze(back.profile), c).claimed).toBeNull();
    }
  });
});

/** save-v2.json's envelope, frozen: read when a test runs, so a missing file fails that test. */
const v2Envelope = (): Readonly<Record<string, unknown>> =>
  deepFreeze(JSON.parse(fixture('save-v2.json')));
/** save-v2.json's envelope with `changes`, as text. */
const v2Text = (changes: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ ...v2Envelope(), ...changes });
/** The error of a text parseProfile refuses as invalid. */
function invalidError(text: string): string {
  const loaded = parseProfile(text, FIXTURE_CONTEXT);
  if (loaded.ok || loaded.reason !== 'invalid') {
    throw new Error(`not refused as invalid: ${JSON.stringify(loaded).slice(0, 200)}`);
  }
  return loaded.error;
}

// T6 catches newer read as invalid (the store would overwrite it).
describe('parseProfile: refusals (T6)', () => {
  it('refuses a version above SAVE_VERSION as newer, whatever its data', () => {
    expect(parseProfile(v2Text({ v: SAVE_VERSION + 1 }), FIXTURE_CONTEXT)).toEqual({
      ok: false,
      reason: 'newer',
      version: SAVE_VERSION + 1,
    });
    expect(parseProfile(v2Text({ v: 99, data: 'from later' }), FIXTURE_CONTEXT)).toEqual({
      ok: false,
      reason: 'newer',
      version: 99,
    });
  });

  it('refuses garbage, another game, a bad envelope and bad data as invalid, saying which', () => {
    expect(invalidError('{')).toBe('not JSON');
    expect(invalidError('')).toBe('not JSON');
    expect(invalidError('null')).toMatch(/^bad envelope: /);
    expect(invalidError(v2Text({ game: 'other' }))).toMatch(/^bad envelope: /);
    expect(invalidError(v2Text({ extra: 1 }))).toMatch(/^bad envelope: /);
    expect(invalidError(v2Text({ savedAt: undefined }))).toMatch(/^bad envelope: /);
    for (const v of [0, -1, 1.5, '2', null]) {
      expect(invalidError(v2Text({ v })), String(v)).toMatch(/^bad envelope: /);
    }
    const { account, characters } = v2Envelope().data as { account: object; characters: object };
    const speed3 = { characters, account: { ...account, settings: { speed: 3 } } };
    expect(invalidError(v2Text({ data: speed3 }))).toMatch(/^bad data: /);
    expect(invalidError(v2Text({ data: {} }))).toMatch(/^bad data: /);
  });

  it('refuses data a migration throws on as invalid', () => {
    const v1 = JSON.parse(fixture('save-v1.json')) as { data: Record<string, unknown> };
    const speed3 = JSON.stringify({ ...v1, data: { ...v1.data, speed: 3 } });
    expect(invalidError(speed3)).toMatch(/^v1 data: /);
    expect(invalidError(v2Text({ v: 1 }))).toMatch(/^v1 data: /);
  });

  it('refuses a profile fromJSON throws on as invalid', () => {
    vi.mocked(fromJSON).mockImplementationOnce(() => {
      throw new TypeError('Invalid serialized Num: a test');
    });
    expect(invalidError(fixture('save-v2.json'))).toBe('bad data: Invalid serialized Num: a test');
    expect(parseProfile(fixture('save-v2.json'), FIXTURE_CONTEXT).ok).toBe(true);
  });
});

/** freshProfile with `changes` to fire's progress, frozen. */
function brokenFire(changes: Partial<SaveProfile['characters']['fire']['progress']>): SaveProfile {
  const fresh = freshProfile();
  const fire = fresh.characters.fire;
  return deepFreeze({
    ...fresh,
    characters: {
      ...fresh.characters,
      fire: { ...fire, progress: { ...fire.progress, ...changes } },
    },
  });
}
/** freshProfile with `changes` to the account, frozen. */
const brokenAccount = (changes: Partial<SaveProfile['account']>): SaveProfile => {
  const fresh = freshProfile();
  return deepFreeze({ ...fresh, account: { ...fresh.account, ...changes } });
};

// T7 catches no validation on write.
describe('serializeProfile refuses what this build cannot read (T7; D2)', () => {
  const ZEROS = { shards: num(0), cores: 0, resonance: 0 };
  const FIRE = ['characters', 'fire'];
  /** A profile the schema refuses, and the path of its issue. */
  const BROKEN: readonly (readonly [string, SaveProfile, readonly PropertyKey[]])[] = [
    [
      'fractional cores',
      brokenFire({ wallet: { ...ZEROS, cores: 1.5 } }),
      [...FIRE, 'wallet', 'cores'],
    ],
    [
      'NaN shards',
      brokenFire({ wallet: { ...ZEROS, shards: num(Number.NaN) } }),
      [...FIRE, 'wallet', 'shards'],
    ],
    [
      'Infinity spent',
      brokenFire({ spent: { ...ZEROS, shards: num(Infinity) } }),
      [...FIRE, 'spent', 'shards'],
    ],
    [
      'a rank of 0',
      brokenFire({ ranks: { 'fire.center.alpha.r1': 0 } }),
      [...FIRE, 'ranks', 'fire.center.alpha.r1'],
    ],
    [
      'an unsorted seenEnemies',
      brokenAccount({ seenEnemies: ['square', 'boss'] }),
      ['account', 'seenEnemies'],
    ],
    [
      'an enemy id twice',
      brokenAccount({ seenEnemies: ['boss', 'boss'] }),
      ['account', 'seenEnemies'],
    ],
    [
      'fractional pending cores',
      brokenAccount({ pendingV1: { shards: num(1), cores: 0.5, maxWave: 1 } }),
      ['account', 'pendingV1', 'cores'],
    ],
  ];

  it.each(BROKEN)('throws SaveFormatError for %s, with the issue', (_name, broken, path) => {
    let error: unknown;
    try {
      serializeProfile(broken, 'now');
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(SaveFormatError);
    if (!(error instanceof SaveFormatError)) return;
    expect(error.name).toBe('SaveFormatError');
    expect(error.message).toMatch(/^the profile cannot be saved: /);
    const { issues } = error.cause as { issues: readonly { path: readonly PropertyKey[] }[] };
    expect(issues.map((issue) => issue.path)).toEqual([path]);
    expect(error.message).toContain(JSON.stringify(path.at(-1)));
  });

  it('writes the SAVE_VERSION envelope of a profile the schema reads back', () => {
    const fresh = deepFreeze(freshProfile());
    const text = serializeProfile(fresh, 'when');
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['v', 'savedAt', 'game', 'data']);
    expect(JSON.parse(text)).toEqual({
      v: SAVE_VERSION,
      savedAt: 'when',
      game: 'bc-incremental',
      data: toProfileData(fresh),
    });
  });
});

// T8 catches key order depending on the load path.
describe('byte stability (T8)', () => {
  it('writes save-v2.json, loaded on the fixture webs, back to its own minified text', () => {
    const text = minified(fixture('save-v2.json'));
    const loaded = parseProfile(text, FIXTURE_CONTEXT);
    if (!loaded.ok) throw new Error('save-v2.json does not load');
    expect(serializeProfile(deepFreeze(loaded.profile), savedAtOf(text))).toBe(text);
  });

  it('writes each of 100 random profiles back to its own text through a load', () => {
    const profiles = deepFreeze(randomProfiles(FIXTURE_CONTEXT, 100, PROFILE_SEED));
    for (const [i, random] of profiles.entries()) {
      const text = serializeProfile(random, 'now');
      const loaded = parseProfile(text, FIXTURE_CONTEXT);
      expect(loaded, `profile ${i}`).toMatchObject({ ok: true, notices: [], changed: false });
      if (!loaded.ok) continue;
      expect(serializeProfile(deepFreeze(loaded.profile), 'now'), `profile ${i}`).toBe(text);
    }
  });
});

const TRIPWIRE = 'the save format changed: SAVE_VERSION + 1, a migration and a fixture (CLAUDE.md)';

/** A slot with every field off its default, its ids c's. */
const pinSlot = (c: CharacterId): CharacterSlot => ({
  progress: {
    character: c,
    ranks: { [`${c}.center.alpha.r1`]: 2, [`${c}.center.beta.r1`]: 1 },
    wallet: { shards: num(0.1), cores: 7, resonance: 2 },
    spent: { shards: num(1234.5678), cores: 1, resonance: 3 },
    bestWave: 33,
    cycleBest: 12,
    prestiges: 1,
    resonanceEarned: 5,
    ascendancy: 'path-one',
    runs: 9,
  },
  loadouts: [{ [`${c}.center.alpha.r1`]: 1 }, null, {}],
  startWave: 7,
});

/** The tripwire's profile: every field of the format off its default. */
const PIN: SaveProfile = deepFreeze({
  account: {
    codex: { 'fire.poison': { bestWave: 34 }, 'summon.greed': { bestWave: 3 } },
    singularity: { fire: true, ice: false, lightning: true, summon: false },
    settings: { speed: 4 },
    stats: { playSeconds: 3600.5, runs: 61 },
    lastCharacter: 'lightning',
    pendingV1: { shards: num(2221.75), cores: 3, maxWave: 18 },
    seenEnemies: ['pentagon', 'shard', 'triangle'],
  },
  characters: {
    fire: pinSlot('fire'),
    ice: pinSlot('ice'),
    lightning: pinSlot('lightning'),
    summon: pinSlot('summon'),
  },
});

/** PIN's slot text, written out. */
const pinSlotText = (c: CharacterId): string =>
  `{"ranks":{"${c}.center.alpha.r1":2,"${c}.center.beta.r1":1},` +
  '"wallet":{"shards":0.1,"cores":7,"resonance":2},' +
  '"spent":{"shards":1234.5678,"cores":1,"resonance":3},' +
  '"bestWave":33,"cycleBest":12,"prestiges":1,"resonanceEarned":5,"ascendancy":"path-one",' +
  `"runs":9,"loadouts":[{"${c}.center.alpha.r1":1},null,{}],"startWave":7}`;
/** serializeProfile(PIN, 'pin'), written out: no snapshot updates it. */
const PIN_TEXT =
  '{"v":2,"savedAt":"pin","game":"bc-incremental","data":{"account":{' +
  '"codex":{"fire.poison":{"bestWave":34},"summon.greed":{"bestWave":3}},' +
  '"singularity":{"fire":true,"ice":false,"lightning":true,"summon":false},' +
  '"settings":{"speed":4},"stats":{"playSeconds":3600.5,"runs":61},"lastCharacter":"lightning",' +
  '"pendingV1":{"shards":2221.75,"cores":3,"maxWave":18},' +
  '"seenEnemies":["pentagon","shard","triangle"]},' +
  `"characters":{"fire":${pinSlotText('fire')},"ice":${pinSlotText('ice')},` +
  `"lightning":${pinSlotText('lightning')},"summon":${pinSlotText('summon')}}}}`;

/** Records and lists are compared whole; every other object field by field. */
const WHOLE_FIELDS = new Set([
  'codex',
  'singularity',
  'pendingV1',
  'seenEnemies',
  'ranks',
  'loadouts',
]);

/** The paths of the fields of `value` that equal `fresh`'s. */
function defaultsIn(value: unknown, fresh: unknown, path = '', out: string[] = []): string[] {
  const field = path.split('.').at(-1) ?? '';
  if (typeof fresh === 'object' && fresh !== null && !WHOLE_FIELDS.has(field)) {
    for (const key of Object.keys(fresh)) {
      defaultsIn(
        (value as Record<string, unknown>)[key],
        (fresh as Record<string, unknown>)[key],
        `${path}.${key}`,
        out,
      );
    }
  } else if (JSON.stringify(value) === JSON.stringify(fresh)) {
    out.push(path);
  }
  return out;
}

// T9 catches a field added without a bump.
describe('the format’s tripwire (T9; D7)', () => {
  it('pins SAVE_VERSION and the exact text of a profile with every field set', () => {
    expect(SAVE_VERSION, TRIPWIRE).toBe(2);
    expect(serializeProfile(PIN, 'pin'), TRIPWIRE).toBe(PIN_TEXT);
  });

  it('sets every field of the format off its default, and reads back as PIN', () => {
    const fresh = deepFreeze(freshProfile());
    expect(defaultsIn(toProfileData(PIN), toProfileData(fresh)), TRIPWIRE).toEqual([]);
    const { data: pinData } = EnvelopeSchema.parse(JSON.parse(PIN_TEXT));
    expect(fromProfileData(deepFreeze(ProfileDataSchema.parse(pinData)))).toEqual(PIN);
  });
});

// The lead's ruling K4: zod 4.6.7's z.record drops an own "__proto__" key without an error. No
// legal node id can be one (parseNodeId gives null), so nothing paid is lost; this pins the drop,
// so a zod upgrade that changes it is noticed.
describe('a "__proto__" key in a record (the lead’s ruling K4)', () => {
  it('loads a v2 text whose fire ranks hold "__proto__", without it and with the rest kept', () => {
    const text = minified(fixture('save-v2.json'));
    const first = '"ranks":{"fire.center.alpha.r1":1,';
    const poisoned = text.replace(first, `"ranks":{"__proto__":1,"fire.center.alpha.r1":1,`);
    expect(poisoned).not.toBe(text);
    expect(Object.hasOwn(JSON.parse(poisoned).data.characters.fire.ranks, '__proto__')).toBe(true);
    const loaded = parseProfile(poisoned, FIXTURE_CONTEXT);
    expect(loaded).toMatchObject({ ok: true, fromVersion: 2, notices: [], changed: false });
    if (!loaded.ok) return;
    const { ranks } = loaded.profile.characters.fire.progress;
    expect(Object.hasOwn(ranks, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(ranks)).toBe(Object.prototype);
    expect(ranks['fire.center.alpha.r1']).toBe(1);
    expect(serializeProfile(deepFreeze(loaded.profile), savedAtOf(text))).toBe(text);
  });
});
