import { describe, expect, it } from 'vitest';
import { ENEMIES } from './enemies';
import { parseGameData } from './index';
import type { RuleId, RuleSpec } from './rules';
import { RULE_IDS } from './rules';
import {
  ConditionSchema,
  EffectSpecSchema,
  GameDataSchema,
  ModifierSchema,
  RuleSpecSchema,
  TriggerSpecSchema,
} from './schema';
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
  steadyAim: { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'shot' },
  pandemic: { id: 'pandemic', spreadRadius: 150, spreadEffect: 0.5, hitMore: -0.3 },
  eternalFlame: { id: 'eternalFlame', durationMore: -0.5 },
  overload: { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.15 },
  glassCannon: { id: 'glassCannon', damageMore: 1 },
};

describe('ModifierSchema', () => {
  it.each([
    { stat: 'critChance', kind: 'flat', value: 0.02 },
    { stat: 'damage', kind: 'flat', value: 5 },
    { stat: 'damage', kind: 'increased', value: 0.2, tags: ['burn'] },
    { stat: 'damage', kind: 'more', value: -0.3, tags: ['hit', 'crit'] },
    { stat: 'damage', kind: 'increased', value: 0.5, tags: ['minion', 'poison'] },
    { stat: 'damage', kind: 'more', value: -0.5, tags: ['hit'], notTags: ['crit'] },
    { stat: 'damage', kind: 'increased', value: 0.1, notTags: ['projectile', 'lightning'] },
    { stat: 'damage', kind: 'more', value: 0.04, scope: 'fusion.fire.poison' },
    { stat: 'damage', kind: 'increased', value: 0.2, scope: 'center', tags: ['hit'] },
    { stat: 'damage', kind: 'increased', value: 0.3, scope: 'outer.barrage' },
    { stat: 'damage', kind: 'more', value: 0.1, scope: 'outer' },
    { stat: 'igniteChance', kind: 'flat', value: 0.3, tags: ['crit'] },
    { stat: 'critChance', kind: 'increased', value: 0.5, notTags: ['chain'], scope: 'hub' },
    { stat: 'critMultiplier', kind: 'more', value: 0.2, tags: ['chain'] },
    { stat: 'igniteAlways', kind: 'flat', value: 1, tags: ['crit'] },
    { stat: 'critAlways', kind: 'flat', value: 1, tags: ['chain'] },
    { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'chainJump' } },
    {
      stat: 'damage',
      kind: 'more',
      value: 0.2,
      tags: ['chain'],
      scaling: { per: 'chainJump', every: 2, curve: 'log10', cap: 0.5 },
    },
    {
      stat: 'damage',
      kind: 'increased',
      value: 0.1,
      scaling: { per: 'chainJump', curve: 'pow', exponent: 1.5 },
    },
    { stat: 'damage', kind: 'more', value: 0.05, scaling: { per: 'targetBurnStacks' } },
    { stat: 'critChance', kind: 'flat', value: 0.001, scaling: { per: 'targetDistance' } },
    { stat: 'damage', kind: 'increased', value: 1, scaling: { per: 'lifeLostPct', cap: 0.5 } },
    { stat: 'damage', kind: 'more', value: 0.3, when: [{ targetHas: 'burn' }] },
    {
      stat: 'critChance',
      kind: 'flat',
      value: 0.2,
      tags: ['hit'],
      when: [{ targetKind: 'boss' }, { targetHpBelow: 0.5 }],
    },
    {
      stat: 'damage',
      kind: 'increased',
      value: 0.5,
      when: [{ stacksAtLeast: { ailment: 'burn', stacks: 3 } }],
      scaling: { per: 'chainJump' },
    },
  ])('accepts %o', (modifier) => {
    expect(ModifierSchema.parse(modifier)).toEqual(modifier);
  });

  it.each<[string, unknown]>([
    [
      'a tag on a stat that is not scoped',
      { stat: 'attackSpeed', kind: 'increased', value: 1, tags: ['crit'] },
    ],
    ['a tag on a flat modifier', { stat: 'damage', kind: 'flat', value: 5, tags: ['burn'] }],
    ['empty tags', { stat: 'damage', kind: 'increased', value: 0.1, tags: [] }],
    ['duplicate tags', { stat: 'damage', kind: 'more', value: 0.1, tags: ['burn', 'burn'] }],
    ['an unknown tag', { stat: 'damage', kind: 'more', value: 0.1, tags: ['all'] }],
    [
      'notTags on a stat that is not scoped',
      { stat: 'chainCount', kind: 'increased', value: 1, notTags: ['crit'] },
    ],
    ['notTags on a flat modifier', { stat: 'damage', kind: 'flat', value: 5, notTags: ['burn'] }],
    ['empty notTags', { stat: 'damage', kind: 'increased', value: 0.1, notTags: [] }],
    ['duplicate notTags', { stat: 'damage', kind: 'more', value: 0.1, notTags: ['crit', 'crit'] }],
    [
      'a tag in both tags and notTags',
      { stat: 'damage', kind: 'more', value: 0.1, tags: ['hit', 'crit'], notTags: ['crit'] },
    ],
    [
      'a scope on a stat that is not scoped',
      { stat: 'burnDamage', kind: 'flat', value: 1, scope: 'hub' },
    ],
    ['a scope on a flat modifier', { stat: 'damage', kind: 'flat', value: 5, scope: 'center' }],
    ['an unknown outer board', { stat: 'damage', kind: 'more', value: 1, scope: 'outer.water' }],
    ['a node id as scope', { stat: 'damage', kind: 'more', value: 1, scope: 'outer.fire.a.b' }],
    [
      'a fusion without its board',
      { stat: 'damage', kind: 'more', value: 1, scope: 'fusion.fire' },
    ],
    ['a non-string scope', { stat: 'damage', kind: 'more', value: 1, scope: 0 }],
    [
      'a scaling on a stat that is not scoped',
      { stat: 'chainCount', kind: 'flat', value: 1, scaling: { per: 'chainJump' } },
    ],
    [
      'a scaling on a flat damage modifier',
      { stat: 'damage', kind: 'flat', value: 1, scaling: { per: 'chainJump' } },
    ],
    [
      'an unknown scaling variable',
      { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'minionCount' } },
    ],
    [
      'an unknown scaling curve',
      { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'chainJump', curve: 'exp' } },
    ],
    [
      'a pow curve without an exponent',
      { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'chainJump', curve: 'pow' } },
    ],
    [
      'an exponent without the pow curve',
      { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'chainJump', exponent: 2 } },
    ],
    [
      'an unknown scaling key',
      { stat: 'critChance', kind: 'flat', value: 0.1, scaling: { per: 'chainJump', step: 2 } },
    ],
    ...['targetPoisonStacks', 'targetShockStacks', 'targetFrost'].map((per): [string, unknown] => [
      `the scaling variable ${per}, which lands with its ailment`,
      { stat: 'damage', kind: 'more', value: 0.1, scaling: { per } },
    ]),
    [
      'conditions on a stat that is not scoped',
      { stat: 'attackSpeed', kind: 'more', value: 0.1, when: [{ targetHas: 'burn' }] },
    ],
    [
      'conditions on flat damage',
      { stat: 'damage', kind: 'flat', value: 5, when: [{ targetKind: 'elite' }] },
    ],
    ['empty conditions', { stat: 'damage', kind: 'more', value: 0.1, when: [] }],
    [
      'a trigger condition on a modifier',
      { stat: 'damage', kind: 'more', value: 0.1, when: [{ chance: 0.5 }] },
    ],
    [
      'a kill condition on a modifier',
      { stat: 'damage', kind: 'more', value: 0.1, when: [{ victimHas: 'burn' }] },
    ],
    [
      'an ailment that has no condition reader yet',
      { stat: 'damage', kind: 'more', value: 0.1, when: [{ targetHas: 'poison' }] },
    ],
    ['an unknown stat', { stat: 'armour', kind: 'flat', value: 1 }],
    ['an unknown kind', { stat: 'damage', kind: 'added', value: 1 }],
    ['an infinite value', { stat: 'damage', kind: 'flat', value: Infinity }],
    ['a NaN value', { stat: 'damage', kind: 'flat', value: Number.NaN }],
    ['an unknown key', { stat: 'damage', kind: 'flat', value: 1, tag: ['hit'] }],
  ])('rejects %s', (_label, modifier) => {
    expect(ModifierSchema.safeParse(modifier).success).toBe(false);
  });

  it('reports tag, scope and scaling errors on their fields', () => {
    const result = ModifierSchema.safeParse({
      stat: 'chainCount',
      kind: 'more',
      value: 1,
      tags: ['chain'],
    });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['tags']]);
    const not = ModifierSchema.safeParse({
      stat: 'damage',
      kind: 'more',
      value: 1,
      tags: ['chain'],
      notTags: ['chain'],
    });
    expect(not.error?.issues.map((issue) => issue.path)).toEqual([['notTags']]);
    const scope = ModifierSchema.safeParse({
      stat: 'chainCount',
      kind: 'more',
      value: 1,
      scope: 'outer.lightning',
    });
    expect(scope.error?.issues.map((issue) => issue.path)).toEqual([['scope']]);
    const unknown = ModifierSchema.safeParse({
      stat: 'damage',
      kind: 'more',
      value: 1,
      scope: 'x',
    });
    expect(unknown.error?.issues.map((issue) => issue.path)).toEqual([['scope']]);
    const scaling = ModifierSchema.safeParse({
      stat: 'maxLife',
      kind: 'flat',
      value: 1,
      scaling: { per: 'chainJump' },
    });
    expect(scaling.error?.issues.map((issue) => issue.path)).toEqual([['scaling']]);
    const pow = ModifierSchema.safeParse({
      stat: 'damage',
      kind: 'more',
      value: 1,
      scaling: { per: 'chainJump', curve: 'pow' },
    });
    expect(pow.error?.issues.map((issue) => issue.path)).toEqual([['scaling', 'exponent']]);
  });
});

describe('ConditionSchema', () => {
  it.each([
    { targetHas: 'burn' },
    { targetKind: 'normal' },
    { targetKind: 'elite' },
    { targetKind: 'boss' },
    { targetHpBelow: 0.3 },
    { stacksAtLeast: { ailment: 'burn', stacks: 4 } },
    { chance: 0.25 },
    { cooldownSec: 2 },
    ...['crit', 'nonCrit', 'primary', 'chainJump', 'signature'].map((hitIs) => ({ hitIs })),
    { victimHas: 'burn' },
    { killedBy: 'hit' },
    { killedBy: 'burn' },
  ])('accepts %o', (condition) => {
    expect(ConditionSchema.parse(condition)).toEqual(condition);
  });

  it.each([
    ...['poison', 'bleed', 'shock', 'frost', 'frozen'].flatMap((ailment) => [
      { targetHas: ailment },
      { victimHas: ailment },
      { stacksAtLeast: { ailment, stacks: 1 } },
    ]),
    { killedBy: 'poison' },
    { killedBy: 'bleed' },
    { targetKind: 'minion' },
    { hitIs: 'dot' },
    { ailment: 'burn' },
    { chance: 0.5, cooldownSec: 1 },
    {},
  ])('rejects %o', (condition) => {
    expect(ConditionSchema.safeParse(condition).success).toBe(false);
  });
});

describe('EffectSpecSchema', () => {
  it.each([
    { kind: 'applyAilment', ailment: 'burn' },
    {
      kind: 'applyAilment',
      ailment: 'burn',
      stacks: 2,
      damagePct: 0.5,
      radius: 120,
      maxTargets: 3,
    },
    { kind: 'spreadAilment', ailment: 'burn', radius: 250 },
    { kind: 'spreadAilment', ailment: 'burn', radius: 250, effect: 0.4 },
    { kind: 'explode', radius: 90, damagePct: 0.5 },
    { kind: 'explode', radius: 90, damagePct: 2, maxTargets: 5, tags: ['strike'], element: 'cold' },
    { kind: 'nova', radius: 200, damagePct: 1 },
    { kind: 'nova', radius: 200, damagePct: 1, at: 'event', element: 'lightning' },
    { kind: 'nova', radius: 200, damagePct: 1, at: 'player' },
    { kind: 'push', distance: 60, radius: 150 },
    { kind: 'heal', lifePct: 0.05 },
    { kind: 'gainShards', fraction: 0.5 },
  ])('accepts %o', (effect) => {
    expect(EffectSpecSchema.parse(effect)).toEqual(effect);
  });

  it.each<[string, unknown]>([
    [
      'spreadAilment burn with stacks',
      { kind: 'spreadAilment', ailment: 'burn', radius: 250, stacks: 0.5 },
    ],
    [
      'spreadAilment burn with maxTargets',
      { kind: 'spreadAilment', ailment: 'burn', radius: 250, maxTargets: 3 },
    ],
    ...['poison', 'bleed', 'shock'].map((ailment): [string, unknown] => [
      `applyAilment ${ailment}`,
      { kind: 'applyAilment', ailment },
    ]),
    ['spreadAilment poison', { kind: 'spreadAilment', ailment: 'poison', radius: 100 }],
    ['addFrost', { kind: 'addFrost', amount: 0.2 }],
    ['detonate', { kind: 'detonate', ailment: 'burn', radius: 100 }],
    ['explode without a radius', { kind: 'explode', damagePct: 0.5 }],
    ['nova at an unknown point', { kind: 'nova', radius: 100, damagePct: 1, at: 'target' }],
    ['an element that is not one', { kind: 'nova', radius: 100, damagePct: 1, element: 'fire' }],
    ['an unknown key', { kind: 'heal', lifePct: 0.1, amount: 1 }],
  ])('rejects %s', (_label, effect) => {
    expect(EffectSpecSchema.safeParse(effect).success).toBe(false);
  });
});

describe('TriggerSpecSchema', () => {
  it('accepts a trigger with conditions and effects', () => {
    const trigger = {
      on: 'crit',
      when: [{ chance: 0.3 }, { targetHas: 'burn' }],
      do: [{ kind: 'explode', radius: 90, damagePct: 0.5 }],
    };
    expect(TriggerSpecSchema.parse(trigger)).toEqual(trigger);
    const periodic = { on: 'periodic', every: 8, do: [{ kind: 'heal', lifePct: 0.05 }] };
    expect(TriggerSpecSchema.parse(periodic)).toEqual(periodic);
  });

  it.each([
    ['an unknown event', { on: 'tick', do: [{ kind: 'heal', lifePct: 0.1 }] }],
    ['no effect list', { on: 'kill' }],
    ['an unknown effect', { on: 'kill', do: [{ kind: 'detonate' }] }],
    ['an unknown key', { on: 'kill', do: [], target: 'nearest' }],
  ])('rejects %s', (_label, trigger) => {
    expect(TriggerSpecSchema.safeParse(trigger).success).toBe(false);
  });
});

describe('RuleSpecSchema', () => {
  it('accepts every rule id with its parameters', () => {
    for (const id of RULE_IDS) {
      expect(RuleSpecSchema.parse(SAMPLE_RULES[id])).toEqual(SAMPLE_RULES[id]);
    }
    const chainMore = { ...SAMPLE_RULES.overload, chainMore: 3.5 };
    expect(RuleSpecSchema.parse(chainMore)).toEqual(chainMore);
    const perAttack = { ...SAMPLE_RULES.steadyAim, counts: 'attack' };
    expect(RuleSpecSchema.parse(perAttack)).toEqual(perAttack);
  });

  it.each([
    ['a rule that became data', { id: 'critsAlwaysIgnite', nonCritHitMore: -0.5 }],
    ['a missing parameter', { id: 'steadyAim', everyNth: 3 }],
    ['a missing choice', { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5 }],
    [
      'an unknown choice',
      { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'volley' },
    ],
    ['a parameter of another rule', { id: 'glassCannon', damageMore: 1, hitMore: 1 }],
    ['a non-numeric parameter', { id: 'eternalFlame', durationMore: '-0.5' }],
    [
      'an undefined optional parameter',
      { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2, chainMore: undefined },
    ],
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

  it('accepts triggers on a talent and rejects any conversion', () => {
    const triggers = content();
    Object.assign(talentAt(triggers, 'vitality')[1], {
      triggers: [{ on: 'kill', do: [{ kind: 'gainShards', fraction: 0.2 }] }],
    });
    expect(GameDataSchema.safeParse(triggers).success).toBe(true);

    const conversions = content();
    Object.assign(talentAt(conversions, 'vitality')[1], {
      conversions: [{ to: 'poison', fraction: 0.3 }],
    });
    expect(GameDataSchema.safeParse(conversions).success).toBe(false);

    const missing = content();
    Reflect.deleteProperty(talentAt(missing, 'vitality')[1], 'triggers');
    expect(GameDataSchema.safeParse(missing).success).toBe(false);
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
  it('rejects a tag on a stat that is not scoped, naming the path', () => {
    const data = content();
    const [i, node] = talentAt(data, 'keenEye');
    const m = node.modifiers.length;
    node.modifiers.push({ stat: 'attackSpeed', kind: 'more', value: 0.1, tags: ['crit'] });
    expect(() => parseGameData(data)).toThrow(
      `talents.${i}.modifiers.${m}.tags: tags are only allowed on scoped stats, and not on flat damage`,
    );
  });

  it('rejects a tag on a flat damage modifier', () => {
    const data = content();
    const [i, node] = talentAt(data, 'keenEye');
    const m = node.modifiers.length;
    node.modifiers.push({ stat: 'damage', kind: 'flat', value: 2, tags: ['hit'] });
    expect(() => parseGameData(data)).toThrow(`talents.${i}.modifiers.${m}.tags: tags are only`);
  });

  it('rejects an unknown rule id', () => {
    const data = content();
    const [i, node] = talentAt(data, 'glassCannon');
    Object.assign(node, { rules: [{ id: 'glasCannon', damageMore: 1 }] });
    expect(() => parseGameData(data)).toThrow(`talents.${i}.rules.0.id: Invalid discriminator`);
  });
});
