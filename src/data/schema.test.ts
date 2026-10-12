import { describe, expect, it } from 'vitest';
import { ENEMIES } from './enemies';
import { parseGameData } from './index';
import type { RuleId, RuleSpec } from './rules';
import { RULE_IDS } from './rules';
import { GameDataSchema, ModifierSchema, RuleSpecSchema } from './schema';
import { TALENTS } from './talents';
import type { GameData, TalentNode } from './types';
import { WAVES } from './waves';

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

const content = (): Mutable<GameData> =>
  structuredClone({ enemies: ENEMIES, waves: WAVES, talents: TALENTS }) as Mutable<GameData>;

function talentAt(data: Mutable<GameData>, id: string): [number, Mutable<TalentNode>] {
  const index = data.talents.findIndex((node) => node.id === id);
  const node = data.talents[index];
  if (node === undefined) throw new Error(`No talent '${id}'`);
  return [index, node];
}

const SAMPLE_RULES: { readonly [K in RuleId]: Extract<RuleSpec, { id: K }> } = {
  critsAlwaysIgnite: { id: 'critsAlwaysIgnite', nonCritHitMore: -0.5 },
  steadyAim: { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5 },
  pandemic: { id: 'pandemic', spreadRadius: 150, spreadEffect: 0.5, hitMore: -0.3 },
  eternalFlame: { id: 'eternalFlame', durationMore: -0.5 },
  overload: { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.15 },
  glassCannon: { id: 'glassCannon', damageMore: 1 },
  critIgniteChance: { id: 'critIgniteChance', chance: 0.3 },
  chainIgniteChance: { id: 'chainIgniteChance', chance: 0.25 },
  chainCritChance: { id: 'chainCritChance', perJump: 0.1 },
};

describe('ModifierSchema', () => {
  it.each([
    { stat: 'critChance', kind: 'flat', value: 0.02 },
    { stat: 'damage', kind: 'flat', value: 5 },
    { stat: 'damage', kind: 'increased', value: 0.2, tags: ['burn'] },
    { stat: 'damage', kind: 'more', value: -0.3, tags: ['hit', 'crit'] },
  ])('accepts %o', (modifier) => {
    expect(ModifierSchema.parse(modifier)).toEqual(modifier);
  });

  it.each([
    [
      'a tag on a non-damage stat',
      { stat: 'critChance', kind: 'increased', value: 1, tags: ['crit'] },
    ],
    ['a tag on a flat modifier', { stat: 'damage', kind: 'flat', value: 5, tags: ['burn'] }],
    ['empty tags', { stat: 'damage', kind: 'increased', value: 0.1, tags: [] }],
    ['duplicate tags', { stat: 'damage', kind: 'more', value: 0.1, tags: ['burn', 'burn'] }],
    ['an unknown tag', { stat: 'damage', kind: 'more', value: 0.1, tags: ['all'] }],
    ['an unknown stat', { stat: 'armour', kind: 'flat', value: 1 }],
    ['an unknown kind', { stat: 'damage', kind: 'added', value: 1 }],
    ['an infinite value', { stat: 'damage', kind: 'flat', value: Infinity }],
    ['a NaN value', { stat: 'damage', kind: 'flat', value: Number.NaN }],
    ['an unknown key', { stat: 'damage', kind: 'flat', value: 1, tag: ['hit'] }],
  ])('rejects %s', (_label, modifier) => {
    expect(ModifierSchema.safeParse(modifier).success).toBe(false);
  });

  it('reports tag errors on the tags field', () => {
    const result = ModifierSchema.safeParse({
      stat: 'chainCount',
      kind: 'more',
      value: 1,
      tags: ['chain'],
    });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['tags']]);
  });
});

describe('RuleSpecSchema', () => {
  it('accepts every rule id with its parameters', () => {
    for (const id of RULE_IDS) {
      expect(RuleSpecSchema.parse(SAMPLE_RULES[id])).toEqual(SAMPLE_RULES[id]);
    }
  });

  it.each([
    ['an unknown rule id', { id: 'searingCrits', nonCritHitMore: -0.5 }],
    ['a missing parameter', { id: 'steadyAim', everyNth: 3 }],
    ['a parameter of another rule', { id: 'glassCannon', damageMore: 1, hitMore: 1 }],
    ['a non-numeric parameter', { id: 'eternalFlame', durationMore: '-0.5' }],
  ])('rejects %s', (_label, rule) => {
    expect(RuleSpecSchema.safeParse(rule).success).toBe(false);
  });
});

describe('GameDataSchema', () => {
  it('parses the real content unchanged and freezes it', () => {
    const data = GameDataSchema.parse(content());
    expect(data).toEqual(content());
    expect(Object.isFrozen(data.talents)).toBe(true);
    expect(Object.isFrozen(data.enemies.pentagon.splitInto)).toBe(true);
    expect(Object.isFrozen(data.talents[0]?.links)).toBe(true);
  });

  it('requires every enemy id and rejects unknown ones', () => {
    const missing = content();
    Reflect.deleteProperty(missing.enemies, 'shard');
    expect(GameDataSchema.safeParse(missing).success).toBe(false);

    const unknown = { ...content(), enemies: { ...ENEMIES, circle: ENEMIES.square } };
    expect(GameDataSchema.safeParse(unknown).success).toBe(false);
  });

  it('rejects unknown talent kinds and archetypes', () => {
    const kind = content();
    Object.assign(talentAt(kind, 'vitality')[1], { kind: 'mastery' });
    expect(GameDataSchema.safeParse(kind).success).toBe(false);

    const archetype = content();
    Object.assign(talentAt(archetype, 'vitality')[1], { archetype: 'summon' });
    expect(GameDataSchema.safeParse(archetype).success).toBe(false);
  });
});

describe('parseGameData schema errors', () => {
  it('rejects a tag on a non-damage stat, naming the path', () => {
    const data = content();
    const [i, node] = talentAt(data, 'keenEye');
    node.modifiers.push({ stat: 'critChance', kind: 'more', value: 0.1, tags: ['crit'] });
    expect(() => parseGameData(data)).toThrow(
      `talents.${i}.modifiers.1.tags: tags are only allowed on increased/more damage modifiers`,
    );
  });

  it('rejects a tag on a flat damage modifier', () => {
    const data = content();
    const [i, node] = talentAt(data, 'keenEye');
    node.modifiers.push({ stat: 'damage', kind: 'flat', value: 2, tags: ['hit'] });
    expect(() => parseGameData(data)).toThrow(`talents.${i}.modifiers.1.tags: tags are only`);
  });

  it('rejects an unknown rule id', () => {
    const data = content();
    const [i, node] = talentAt(data, 'glassCannon');
    Object.assign(node, { rules: [{ id: 'glasCannon', damageMore: 1 }] });
    expect(() => parseGameData(data)).toThrow(`talents.${i}.rules.0.id: Invalid discriminator`);
  });
});
