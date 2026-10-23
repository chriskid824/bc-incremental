/**
 * Save v2's data (docs/v3 C8 design §1.2-§1.4; §2.1's T1-T3): the strict schema, the data form's
 * round trip and its fixed key order, freshProfile, CODEX_KEYS, profileContext, the import graph of
 * src/save (D1; the lead's ruling L4) and the stale v1 twin C8.2 builds (the lead's ruling L2).
 * Inputs are deep-frozen, so a mutation throws.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { num, toNumber } from '../core/num';
import { loadGameData } from '../data';
import { CHARACTER_IDS, OUTER_IDS } from '../data/sources';
import type { CharacterId } from '../data/sources';
import { assembleWeb } from '../data/web/assemble';
import { parseNodeId } from '../data/web/ids';
import { ID_RENAMES } from '../data/web/renames';
import { DEMO_SCOPE_A, FULL_SCOPE } from '../data/web/scope';
import { fixtureContent } from '../data/web/testing';
import { DEFAULT_WEB_ECONOMY } from '../meta/web/price';
import { emptyProgress } from '../meta/web/rules';
import { loadSave } from './index';
import {
  CODEX_KEYS,
  freshProfile,
  fromProfileData,
  ProfileDataSchema,
  profileContext,
  toProfileData,
} from './profile';
import type { CharacterSlot, ProfileData, SaveProfile } from './profile';
import { deepFreeze, fixtureContext, PROFILE_SEED, randomProfiles, staleTwinV1 } from './testing';
import type * as AssembleModule from '../data/web/assemble';

// assembleWeb, wrapped so the tests can see which webs profileContext assembles, and how often.
vi.mock('../data/web/assemble', async (importOriginal) => {
  const actual = await importOriginal<typeof AssembleModule>();
  return { ...actual, assembleWeb: vi.fn(actual.assembleWeb) };
});

const EMPTY_SLOT: CharacterSlot = deepFreeze({
  progress: emptyProgress('ice'),
  loadouts: [null, null, null],
  startWave: null,
});
const slotOf = (c: CharacterId): CharacterSlot => ({
  ...EMPTY_SLOT,
  progress: emptyProgress(c),
});

/** A profile with every field off its default (legal or not: the schema does not ask). */
const RICH: SaveProfile = deepFreeze({
  account: {
    codex: { 'ice.fire': { bestWave: 41 }, 'fire.poison': { bestWave: 0 } },
    singularity: { fire: true, ice: false, lightning: false, summon: true },
    settings: { speed: 4 },
    stats: { playSeconds: 1520.25, runs: 27 },
    lastCharacter: 'summon',
    pendingV1: { shards: num(2221.75), cores: 3, maxWave: 18 },
  },
  characters: {
    fire: {
      progress: {
        ...emptyProgress('fire'),
        ranks: { 'fire.center.alpha.r1': 2, 'fusion.fire.poison.core': 1 },
        wallet: { shards: num(0.1), cores: 7, resonance: 2 },
        spent: { shards: num(1234.5678), cores: 1, resonance: 1 },
        bestWave: 33,
        cycleBest: 12,
        prestiges: 1,
        resonanceEarned: 3,
        ascendancy: 'path-one',
        runs: 9,
      },
      loadouts: [{ 'fire.center.alpha.r1': 1 }, null, {}],
      startWave: 7,
    },
    ice: slotOf('ice'),
    lightning: slotOf('lightning'),
    summon: { ...slotOf('summon'), startWave: 1 },
  },
});
const BASE: ProfileData = deepFreeze(toProfileData(RICH));

type Path = readonly (string | number)[];
const REMOVE = Symbol('remove');

/** BASE with the value at `path` replaced by `value`, or removed. */
function edited(path: Path, value: unknown): unknown {
  const copy = structuredClone(BASE) as unknown as Record<string | number, unknown>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  const last = path.at(-1) as string | number;
  if (value === REMOVE) delete parent[last];
  else parent[last] = value;
  return copy;
}

const accepts = (data: unknown): boolean => ProfileDataSchema.safeParse(data).success;

const SLOT = ['characters', 'fire'] as const;
/** Every strict object of the schema, by its path in BASE. */
const STRICT_OBJECTS: readonly Path[] = [
  [],
  ['account'],
  ['account', 'codex', 'ice.fire'],
  ['account', 'singularity'],
  ['account', 'settings'],
  ['account', 'stats'],
  ['account', 'pendingV1'],
  ['characters'],
  SLOT,
  [...SLOT, 'wallet'],
  [...SLOT, 'spent'],
];
/** Every count of the schema: an int ≥ 0, safe. */
const COUNTS: readonly Path[] = [
  [...SLOT, 'wallet', 'cores'],
  [...SLOT, 'wallet', 'resonance'],
  [...SLOT, 'spent', 'cores'],
  [...SLOT, 'spent', 'resonance'],
  [...SLOT, 'bestWave'],
  [...SLOT, 'cycleBest'],
  [...SLOT, 'prestiges'],
  [...SLOT, 'resonanceEarned'],
  [...SLOT, 'runs'],
  ['account', 'codex', 'ice.fire', 'bestWave'],
  ['account', 'stats', 'runs'],
  ['account', 'pendingV1', 'cores'],
  ['account', 'pendingV1', 'maxWave'],
];
/** Every amount of the schema: finite ≥ 0. */
const AMOUNTS: readonly Path[] = [
  [...SLOT, 'wallet', 'shards'],
  [...SLOT, 'spent', 'shards'],
  ['account', 'pendingV1', 'shards'],
  ['account', 'stats', 'playSeconds'],
];
/** Every ranks record: node id (non-empty) → int ≥ 1. */
const RANKS: readonly Path[] = [
  [...SLOT, 'ranks'],
  [...SLOT, 'loadouts', 0],
];

// T1 catches z.object for z.strictObject (an unknown key at any level) and z.string() codex keys.
describe('ProfileDataSchema (T1, §1.4)', () => {
  it('accepts the data of a profile with every field set, and of a fresh one', () => {
    expect(ProfileDataSchema.parse(BASE)).toEqual(BASE);
    expect(accepts(toProfileData(freshProfile()))).toBe(true);
  });

  it.each(STRICT_OBJECTS.map((path) => [path.join('.') || '(top)', path] as const))(
    'rejects an unknown key in %s',
    (_name, path) => {
      const result = ProfileDataSchema.safeParse(edited([...path, 'extra'], 1));
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({ code: 'unrecognized_keys', keys: ['extra'], path }),
      );
    },
  );

  it('rejects a missing or a fifth character, in characters and in singularity', () => {
    expect(accepts(edited(['characters', 'summon'], REMOVE))).toBe(false);
    expect(accepts(edited(['characters', 'water'], structuredClone(BASE.characters.ice)))).toBe(
      false,
    );
    expect(accepts(edited(['account', 'singularity', 'ice'], REMOVE))).toBe(false);
    expect(accepts(edited(['account', 'singularity', 'water'], false))).toBe(false);
  });

  it('keys the codex by the 44 fusion keys only', () => {
    for (const key of ['fire.fire', 'fire.nope', 'water.fire', 'fire', 'fire.poison.core', '']) {
      expect(accepts(edited(['account', 'codex', key], { bestWave: 1 })), key).toBe(false);
    }
    const all = Object.fromEntries(CODEX_KEYS.map((key, i) => [key, { bestWave: i }]));
    expect(accepts(edited(['account', 'codex'], all))).toBe(true);
    expect(accepts(edited(['account', 'codex', 'ice.fire'], {}))).toBe(false);
    expect(accepts(edited(['account', 'codex', 'ice.fire'], null))).toBe(false);
  });

  it('takes ranks of whole numbers ≥ 1 on non-empty ids, in the ranks and the loadouts', () => {
    for (const path of RANKS) {
      for (const rank of [0, 1.5, -1, Infinity, Number.NaN, 2 ** 53, '1', null]) {
        expect(accepts(edited([...path, 'fire.center.alpha.r1'], rank)), `${rank}`).toBe(false);
      }
      expect(accepts(edited([...path, ''], 1))).toBe(false);
      expect(accepts(edited([...path, 'fire.center.alpha.r9'], 2 ** 53 - 1))).toBe(true);
    }
  });

  it('takes amounts that are finite and ≥ 0', () => {
    for (const path of AMOUNTS) {
      for (const amount of [-1, -5e-324, Infinity, -Infinity, Number.NaN, '1', null]) {
        expect(accepts(edited(path, amount)), `${path.join('.')} ${amount}`).toBe(false);
      }
      for (const amount of [0, 5e-324, 0.1, 1e300, Number.MAX_VALUE]) {
        expect(accepts(edited(path, amount)), `${path.join('.')} ${amount}`).toBe(true);
      }
    }
  });

  it('takes counts that are safe integers ≥ 0', () => {
    for (const path of COUNTS) {
      for (const value of [1.5, 2 ** 53, -1, Infinity, Number.NaN, '3', null]) {
        expect(accepts(edited(path, value)), `${path.join('.')} ${value}`).toBe(false);
      }
      expect(accepts(edited(path, 2 ** 53 - 1)), path.join('.')).toBe(true);
    }
  });

  it('rejects a speed other than 1, 2 or 4, an unknown last character and bad slot fields', () => {
    for (const speed of [3, 0, 2.5, '2']) {
      expect(accepts(edited(['account', 'settings', 'speed'], speed))).toBe(false);
    }
    expect(accepts(edited(['account', 'lastCharacter'], 'water'))).toBe(false);
    expect(accepts(edited([...SLOT, 'loadouts'], [{}, null]))).toBe(false);
    expect(accepts(edited([...SLOT, 'loadouts'], [null, null, null, null]))).toBe(false);
    expect(accepts(edited([...SLOT, 'loadouts'], null))).toBe(false);
    expect(accepts(edited([...SLOT, 'ascendancy'], ''))).toBe(false);
    for (const wave of [0, 1.5, -2, '3']) {
      expect(accepts(edited([...SLOT, 'startWave'], wave))).toBe(false);
    }
    expect(accepts(edited(['account', 'singularity', 'fire'], 'true'))).toBe(false);
    for (const path of [
      [...SLOT, 'startWave'],
      [...SLOT, 'wallet', 'resonance'],
      ['account', 'pendingV1'],
    ]) {
      expect(accepts(edited(path, REMOVE)), path.join('.')).toBe(false);
    }
    expect(accepts(edited(['account', 'pendingV1'], null))).toBe(true);
    expect(accepts(edited(['account', 'lastCharacter'], null))).toBe(true);
  });
});

/** Each number in `value` with its path, in key order. */
function numbersIn(value: unknown, path = '', out: [string, number][] = []): [string, number][] {
  if (typeof value === 'number') out.push([path, value]);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) numbersIn(inner, `${path}.${key}`, out);
  }
  return out;
}

/** T2's 300 profiles (testing.ts): sampleProgress builds on the four fixture webs. */
const PROFILES = deepFreeze(randomProfiles(fixtureContext(), 300, PROFILE_SEED));

/** The shard amounts of `profile`: wallets, spent and the pending. */
const shardsOf = (profile: SaveProfile): number[] => [
  ...CHARACTER_IDS.flatMap((c) => {
    const { wallet, spent } = profile.characters[c].progress;
    return [toNumber(wallet.shards), toNumber(spent.shards)];
  }),
  ...(profile.account.pendingV1 === null ? [] : [toNumber(profile.account.pendingV1.shards)]),
];

// T2 catches toFixed or Math.round on shards and a dropped resonance or loadout null.
describe('the data form (T2, §1.4)', () => {
  it('round-trips every number Object.is-equal and the JSON text identical', () => {
    const mismatches: string[] = [];
    for (const [i, profile] of PROFILES.entries()) {
      const text = JSON.stringify(toProfileData(profile));
      const back = fromProfileData(ProfileDataSchema.parse(JSON.parse(text)));
      expect(JSON.stringify(toProfileData(back)), `profile ${i}`).toBe(text);
      const before = numbersIn(profile);
      const after = numbersIn(back);
      expect(after.map(([path]) => path)).toEqual(before.map(([path]) => path));
      for (const [k, [path, value]] of before.entries()) {
        if (!Object.is(after[k]?.[1], value)) mismatches.push(`${i}${path}: ${value}`);
      }
      expect(back).toEqual(profile);
    }
    expect(mismatches).toEqual([]);
  });

  it('covers the amounts and the shapes the design names', () => {
    const shards = PROFILES.flatMap(shardsOf);
    for (const special of [0, 5e-324, 1e300, 0.1, 1 / 3]) expect(shards).toContain(special);
    expect(shards.some((x) => x > 1e200)).toBe(true);
    expect(shards.some((x) => x > 1 && x < 1e6 && !Number.isInteger(x))).toBe(true);
    const slots = PROFILES.flatMap((profile) => CHARACTER_IDS.map((c) => profile.characters[c]));
    const loadouts = slots.flatMap((slot) => slot.loadouts);
    expect(loadouts).toContain(null);
    expect(loadouts.some((loadout) => loadout !== null && Object.keys(loadout).length > 0)).toBe(
      true,
    );
    expect(slots.some((slot) => slot.startWave === null)).toBe(true);
    expect(slots.some((slot) => slot.startWave !== null)).toBe(true);
    expect(slots.some((slot) => slot.progress.ascendancy !== null)).toBe(true);
    expect(slots.some((slot) => slot.progress.wallet.resonance > 0)).toBe(true);
    expect(slots.some((slot) => Object.keys(slot.progress.ranks).length > 80)).toBe(true);
    expect(PROFILES.some((profile) => profile.account.pendingV1 === null)).toBe(true);
    expect(PROFILES.some((profile) => profile.account.pendingV1 !== null)).toBe(true);
    expect(PROFILES.some((profile) => Object.keys(profile.account.codex).length > 3)).toBe(true);
  });

  it('writes in a fixed key order: account, then characters in CHARACTER_IDS order, fields as §1.4', () => {
    const data = toProfileData(RICH);
    expect(Object.keys(data)).toEqual(['account', 'characters']);
    expect(Object.keys(data.account)).toEqual([
      'codex',
      'singularity',
      'settings',
      'stats',
      'lastCharacter',
      'pendingV1',
    ]);
    expect(Object.keys(data.account.singularity)).toEqual(CHARACTER_IDS);
    expect(Object.keys(data.account.stats)).toEqual(['playSeconds', 'runs']);
    expect(Object.keys(data.account.pendingV1 ?? {})).toEqual(['shards', 'cores', 'maxWave']);
    expect(Object.keys(data.characters)).toEqual(CHARACTER_IDS);
    expect(Object.keys(data.characters.fire)).toEqual([
      'ranks',
      'wallet',
      'spent',
      'bestWave',
      'cycleBest',
      'prestiges',
      'resonanceEarned',
      'ascendancy',
      'runs',
      'loadouts',
      'startWave',
    ]);
    expect(Object.keys(data.characters.fire.wallet)).toEqual(['shards', 'cores', 'resonance']);
    expect(data.characters.fire).not.toHaveProperty('character');
  });

  it('keeps that order whatever order the profile’s objects hold their keys in', () => {
    const reversed = <T extends object>(value: T): T =>
      Object.fromEntries(Object.entries(value).reverse()) as T;
    const shuffle = (profile: SaveProfile): SaveProfile => {
      const characters = Object.fromEntries(
        [...CHARACTER_IDS].reverse().map((c) => {
          const slot = profile.characters[c];
          const progress = reversed({
            ...slot.progress,
            wallet: reversed(slot.progress.wallet),
            spent: reversed(slot.progress.spent),
          });
          return [c, reversed({ ...slot, progress })];
        }),
      ) as SaveProfile['characters'];
      const { account } = profile;
      return reversed({
        account: reversed({
          ...account,
          singularity: reversed(account.singularity),
          settings: reversed(account.settings),
          stats: reversed(account.stats),
          pendingV1: account.pendingV1 === null ? null : reversed(account.pendingV1),
        }),
        characters,
      });
    };
    for (const profile of [RICH, ...PROFILES.slice(0, 50)]) {
      expect(JSON.stringify(toProfileData(shuffle(profile)))).toBe(
        JSON.stringify(toProfileData(profile)),
      );
    }
  });

  it('keeps the records’ own order: ranks, loadouts and codex as stored', () => {
    const ranks = { 'fire.center.beta.r1': 1, 'fire.center.alpha.r1': 3, 'hub.might.might': 2 };
    const profile: SaveProfile = deepFreeze({
      ...RICH,
      account: {
        ...RICH.account,
        codex: { 'summon.greed': { bestWave: 3 }, 'fire.bleed': { bestWave: 0 } },
      },
      characters: {
        ...RICH.characters,
        fire: {
          ...RICH.characters.fire,
          progress: { ...RICH.characters.fire.progress, ranks },
          loadouts: [null, ranks, null],
        },
      },
    });
    const data = toProfileData(profile);
    expect(Object.keys(data.characters.fire.ranks)).toEqual(Object.keys(ranks));
    expect(Object.keys(data.characters.fire.loadouts[1] ?? {})).toEqual(Object.keys(ranks));
    expect(Object.keys(data.account.codex)).toEqual(['summon.greed', 'fire.bleed']);
    const back = fromProfileData(ProfileDataSchema.parse(JSON.parse(JSON.stringify(data))));
    expect(Object.keys(back.characters.fire.progress.ranks)).toEqual(Object.keys(ranks));
    expect(Object.keys(back.account.codex)).toEqual(['summon.greed', 'fire.bleed']);
  });

  it('reads back each character from its key, in freshProfile’s order, sharing nothing', () => {
    const data = deepFreeze(toProfileData(RICH));
    const shuffled = deepFreeze({
      characters: Object.fromEntries(
        [...CHARACTER_IDS].reverse().map((c) => [c, data.characters[c]]),
      ),
      account: data.account,
    }) as unknown as ProfileData;
    const profile = fromProfileData(shuffled);
    expect(profile).toEqual(RICH);
    const fresh = freshProfile();
    expect(Object.keys(profile)).toEqual(Object.keys(fresh));
    expect(Object.keys(profile.account)).toEqual(Object.keys(fresh.account));
    expect(Object.keys(profile.characters)).toEqual(CHARACTER_IDS);
    for (const c of CHARACTER_IDS) {
      const slot = profile.characters[c];
      expect(slot.progress.character).toBe(c);
      expect(Object.keys(slot)).toEqual(Object.keys(fresh.characters[c]));
      expect(Object.keys(slot.progress)).toEqual(Object.keys(emptyProgress(c)));
      expect(slot.progress.ranks).not.toBe(data.characters[c].ranks);
    }
    expect(profile.account.codex).not.toBe(data.account.codex);
    // The profile is its own: changing it leaves the frozen data as it was.
    expect(Object.isFrozen(profile.characters.fire.progress.ranks)).toBe(false);
  });
});

/** freshProfile's data, written out (§1.2-§1.3's defaults). */
const FRESH_SLOT_TEXT =
  '{"ranks":{},"wallet":{"shards":0,"cores":0,"resonance":0},' +
  '"spent":{"shards":0,"cores":0,"resonance":0},"bestWave":0,"cycleBest":0,"prestiges":0,' +
  '"resonanceEarned":0,"ascendancy":null,"runs":0,"loadouts":[null,null,null],"startWave":null}';
const FRESH_TEXT =
  '{"account":{"codex":{},' +
  '"singularity":{"fire":false,"ice":false,"lightning":false,"summon":false},' +
  '"settings":{"speed":1},"stats":{"playSeconds":0,"runs":0},' +
  '"lastCharacter":null,"pendingV1":null},' +
  `"characters":{"fire":${FRESH_SLOT_TEXT},"ice":${FRESH_SLOT_TEXT},` +
  `"lightning":${FRESH_SLOT_TEXT},"summon":${FRESH_SLOT_TEXT}}}`;

// T3 catches speed 2 and a missing character.
describe('freshProfile (T3, §1.2-§1.3)', () => {
  it('holds the defaults: four empty slots, speed 1, nothing else set', () => {
    const fresh = freshProfile();
    expect(fresh).toEqual({
      account: {
        codex: {},
        singularity: { fire: false, ice: false, lightning: false, summon: false },
        settings: { speed: 1 },
        stats: { playSeconds: 0, runs: 0 },
        lastCharacter: null,
        pendingV1: null,
      },
      characters: Object.fromEntries(
        CHARACTER_IDS.map((c) => [
          c,
          { progress: emptyProgress(c), loadouts: [null, null, null], startWave: null },
        ]),
      ),
    });
    expect(Object.keys(fresh.characters)).toEqual(CHARACTER_IDS);
  });

  it('passes the schema and writes the defaults’ text', () => {
    const data = toProfileData(freshProfile());
    expect(ProfileDataSchema.parse(data)).toEqual(data);
    expect(JSON.stringify(data)).toBe(FRESH_TEXT);
    expect(fromProfileData(ProfileDataSchema.parse(JSON.parse(FRESH_TEXT)))).toEqual(
      freshProfile(),
    );
  });
});

describe('CODEX_KEYS (§1.4)', () => {
  it('is CHARACTER_IDS × OUTER_IDS without each character’s own outer: 44 keys, in that order', () => {
    expect(CODEX_KEYS).toHaveLength(44);
    expect(new Set(CODEX_KEYS).size).toBe(44);
    expect(CODEX_KEYS.slice(0, 3)).toEqual(['fire.poison', 'fire.bleed', 'fire.lightning']);
    expect(CODEX_KEYS.slice(-3)).toEqual(['summon.thorns', 'summon.barrage', 'summon.greed']);
    for (const c of CHARACTER_IDS) {
      expect(CODEX_KEYS).not.toContain(`${c}.${c}`);
      expect(CODEX_KEYS.filter((key) => key.startsWith(`${c}.`))).toEqual(
        OUTER_IDS.filter((o) => o !== c).map((o) => `${c}.${o}`),
      );
    }
  });

  it('names the fusions of the four fixture webs, in their clock order', () => {
    const context = fixtureContext();
    const keys = CHARACTER_IDS.flatMap((c) =>
      (context.webOf(c)?.nodes ?? []).flatMap((node) => {
        const parsed = parseNodeId(node.id);
        return parsed?.block === 'fusion' && parsed.slot === 'core'
          ? [`${parsed.character}.${parsed.outer}`]
          : [];
      }),
    );
    expect(keys).toEqual(CODEX_KEYS);
  });
});

describe('profileContext (F9)', () => {
  const assembled = vi.mocked(assembleWeb);
  const calls = (): string[] =>
    assembled.mock.calls.map(([, character, scope]) => `${character}.${scope.name}`);

  it('assembles each web on its first request, and once only', () => {
    assembled.mockClear();
    const context = profileContext(fixtureContent(), FULL_SCOPE);
    expect(calls()).toEqual([]);
    const fire = context.webOf('fire');
    expect(fire?.character).toBe('fire');
    expect(fire?.scope).toBe(FULL_SCOPE);
    expect(context.webOf('fire')).toBe(fire);
    for (const c of [...CHARACTER_IDS, ...CHARACTER_IDS]) expect(context.webOf(c)).not.toBeNull();
    expect(calls()).toEqual(['fire.full', 'ice.full', 'lightning.full', 'summon.full']);
  });

  it('gives null, assembling nothing, for a character without a center or outside the scope', () => {
    assembled.mockClear();
    const b1 = profileContext(fixtureContent('B1'), FULL_SCOPE);
    for (const c of [...CHARACTER_IDS, ...CHARACTER_IDS]) {
      expect(b1.webOf(c) === null, c).toBe(c !== 'fire');
    }
    expect(calls()).toEqual(['fire.full']);
    assembled.mockClear();
    const demo = profileContext(fixtureContent(), DEMO_SCOPE_A);
    expect(CHARACTER_IDS.map((c) => demo.webOf(c)?.scope.name ?? null)).toEqual([
      'demoA',
      null,
      null,
      'demoA',
    ]);
    expect(demo.webOf('summon')).toBe(demo.webOf('summon'));
    expect(calls()).toEqual(['fire.demoA', 'summon.demoA']);
  });

  it('prices with DEFAULT_WEB_ECONOMY and renames with ID_RENAMES unless given others', () => {
    const content = fixtureContent();
    const context = profileContext(content, FULL_SCOPE);
    expect(context.economy).toBe(DEFAULT_WEB_ECONOMY);
    expect(context.renames).toBe(ID_RENAMES);
    const economy = { ...DEFAULT_WEB_ECONOMY, cores: { ...DEFAULT_WEB_ECONOMY.cores } };
    const renames = { 'fire.center.alpha.old': 'fire.center.alpha.r1' };
    const given = profileContext(content, FULL_SCOPE, economy, renames);
    expect(given.economy).toBe(economy);
    expect(given.renames).toBe(renames);
  });
});

/** src/save's modules but the tests, by name. */
const MODULES = readdirSync(new URL('./', import.meta.url))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .map((file) => file.slice(0, -'.ts'.length))
  .sort();

/**
 * The modules of src/save that `name` imports or re-exports from: values (a declaration that loads
 * the module) or types only (`import type`, erased).
 */
function localImports(name: string, kind: 'value' | 'type'): string[] {
  const text = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
  const found = new Set<string>();
  for (const match of text.matchAll(/^(?:import|export)(\s+type)?\s[^;]*?from '\.\/(\w+)';/gm)) {
    if ((match[1] === undefined) === (kind === 'value')) found.add(match[2] as string);
  }
  return [...found].sort();
}

describe('src/save import graph (D1; the lead’s ruling L4)', () => {
  it('has profile.ts re-export account.ts and fixes.ts, which import it for types only', () => {
    expect(MODULES).toEqual(expect.arrayContaining(['account', 'fixes', 'profile', 'testing']));
    expect(localImports('profile', 'value')).toEqual(['account', 'fixes']);
    expect(localImports('account', 'value')).toEqual([]);
    expect(localImports('account', 'type')).toEqual(['profile']);
    expect(localImports('fixes', 'value')).toEqual(['account']);
    expect(localImports('fixes', 'type')).toEqual(['profile']);
  });

  it('has no value-import cycle, and keeps the M1 entry free of save v2 (D1)', () => {
    const graph = new Map(MODULES.map((name) => [name, localImports(name, 'value')]));
    const done = new Set<string>();
    const visit = (name: string, trail: readonly string[]): void => {
      expect(trail, `cycle ${[...trail, name].join(' → ')}`).not.toContain(name);
      if (done.has(name)) return;
      for (const next of graph.get(name) ?? []) visit(next, [...trail, name]);
      done.add(name);
    };
    for (const name of MODULES) visit(name, []);
    const reached = new Set(['index']);
    for (const name of reached) for (const next of graph.get(name) ?? []) reached.add(next);
    expect([...reached].sort()).toEqual(['format', 'index', 'migrations']);
  });

  it.each(['account', 'fixes', 'profile'])(
    'defines every export when %s is imported first',
    async (name) => {
      vi.resetModules();
      // A computed path: @vite-ignore keeps Vite from rewriting it into a glob.
      await import(/* @vite-ignore */ `./${name}`);
      const save = await import('./profile');
      expect(save.CODEX_KEYS).toHaveLength(44);
      expect(save.LEGACY_WAVES).toEqual([30, 60, 100]);
      const fresh = save.freshProfile();
      expect(save.selectCharacter(fresh, 'ice').profile.account.lastCharacter).toBe('ice');
      expect(save.accountProgress(fresh)).toEqual({ singularityBeaten: false });
      const context = save.profileContext(fixtureContent('B1'), FULL_SCOPE);
      expect(save.fixProfile(fresh, context)).toEqual({
        profile: fresh,
        notices: [],
        changed: false,
      });
    },
  );
});

describe('staleTwinV1 (the lead’s ruling L2, for C8.2)', () => {
  const text = readFileSync(new URL('../../tests/fixtures/save-v1.json', import.meta.url), 'utf8');
  const data = loadGameData();

  it('gives a v1 save whose allocation the M1 loader refunds in full', () => {
    expect(data.talents.some((node) => node.id === 'retiredTalent')).toBe(false);
    expect(loadSave(text, data)).toMatchObject({ ok: true, fromVersion: 1, refunded: false });
    const twin = staleTwinV1(text, 'retiredTalent');
    const original = JSON.parse(text) as { data: { meta: { allocated: string[] } } };
    expect(JSON.parse(twin)).toEqual({
      ...original,
      data: {
        ...original.data,
        meta: {
          ...original.data.meta,
          allocated: [...original.data.meta.allocated, 'retiredTalent'],
        },
      },
    });
    const loaded = loadSave(twin, data);
    expect(loaded).toMatchObject({ ok: true, fromVersion: 1, refunded: true });
    if (!loaded.ok) return;
    expect(toNumber(loaded.profile.meta.shards)).toBe(1234.5 + 987.25);
    expect(loaded.profile.meta.cores).toBe(3);
    expect(loaded.profile.meta.allocated.size).toBe(0);
  });

  it('refuses a save that is not v1, and an id allocated already', () => {
    expect(() => staleTwinV1(text, 'might')).toThrow(/allocated already/);
    const v2 = JSON.stringify({ ...(JSON.parse(text) as object), v: 2 });
    expect(() => staleTwinV1(v2, 'retiredTalent')).toThrow(/a v1 save is needed/);
    expect(() => staleTwinV1('{}', 'retiredTalent')).toThrow();
  });
});
