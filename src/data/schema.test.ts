import { describe, expect, it } from 'vitest';
import type { EmitterGrant, GrantKind } from './emitters';
import { ENEMIES } from './enemies';
import { parseGameData } from './index';
import type { RuleId, RuleSpec } from './rules';
import { RULE_IDS } from './rules';
import {
  ConditionSchema,
  ConversionSpecSchema,
  EffectSpecSchema,
  EmitterGrantSchema,
  GameDataSchema,
  GRANT_SCHEMAS,
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
  eternalFlame: { id: 'eternalFlame', durationMore: -0.5 },
  overload: { id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.15 },
  glassCannon: { id: 'glassCannon', damageMore: 1 },
  farThrow: { id: 'farThrow', every: 4 },
  volcano: { id: 'volcano', periodSec: 3, radiusMult: 3, damageMult: 5 },
  chainBlast: { id: 'chainBlast', radius: 40, damagePct: 0.5, perBomb: 2 },
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
    { stat: 'damage', kind: 'more', value: 0.02, scaling: { per: 'targetPoisonStacks' } },
    { stat: 'damage', kind: 'more', value: 0.1, scaling: { per: 'targetShockStacks' } },
    { stat: 'damage', kind: 'increased', value: 0.6, scaling: { per: 'targetFrost', every: 0.1 } },
    { stat: 'damage', kind: 'more', value: 0.15, when: [{ targetHas: 'frost' }] },
    { stat: 'damage', kind: 'more', value: 0.3, when: [{ targetHas: 'frozen' }], scope: 'fusion' },
    { stat: 'frostOnHit', kind: 'flat', value: 0.08 },
    { stat: 'frostOnHit', kind: 'flat', value: 0.1, tags: ['projectile'] },
    { stat: 'damage', kind: 'more', value: 0.3, when: [{ targetHas: 'burn' }] },
    { stat: 'damage', kind: 'more', value: 0.3, when: [{ targetHas: 'poison' }] },
    { stat: 'damage', kind: 'more', value: 0.2, when: [{ targetHas: 'bleed' }] },
    {
      stat: 'damage',
      kind: 'more',
      value: 0.2,
      when: [{ stacksAtLeast: { ailment: 'shock', stacks: 2 } }],
    },
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
    [
      'a frost stat that is not scoped with a tag',
      { stat: 'frostSlowCap', kind: 'flat', value: 0.2, tags: ['hit'] },
    ],
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
      'frost stacks, which it has none of',
      {
        stat: 'damage',
        kind: 'more',
        value: 0.1,
        when: [{ stacksAtLeast: { ailment: 'frost', stacks: 1 } }],
      },
    ],
    [
      'an ailment condition on a modifier',
      { stat: 'damage', kind: 'more', value: 0.1, when: [{ ailment: 'burn' }] },
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
    ...['poison', 'bleed', 'shock'].flatMap((ailment) => [
      { targetHas: ailment },
      { victimHas: ailment },
    ]),
    { stacksAtLeast: { ailment: 'poison', stacks: 10 } },
    { stacksAtLeast: { ailment: 'shock', stacks: 2 } },
    // 'max': the ailment's stack cap; validation rejects it for poison, which has none.
    ...['burn', 'poison', 'shock'].map((ailment) => ({
      stacksAtLeast: { ailment, stacks: 'max' },
    })),
    { killedBy: 'poison' },
    { killedBy: 'bleed' },
    ...['burn', 'poison', 'bleed', 'shock'].map((ailment) => ({ ailment })),
    ...['frost', 'frozen'].flatMap((ailment) => [{ targetHas: ailment }, { victimHas: ailment }]),
    // inZone names a source; validation rejects the classes the selector syntax also takes.
    { inZone: 'outer.fire' },
    { inZone: 'center' },
    { inZone: 'fusion.fire.ice' },
  ])('accepts %o', (condition) => {
    expect(ConditionSchema.parse(condition)).toEqual(condition);
  });

  it.each([
    // Frost is a meter, not stacks, and is never applied as an ailment.
    ...['frost', 'frozen'].flatMap((ailment) => [
      { stacksAtLeast: { ailment, stacks: 1 } },
      { ailment },
      { killedBy: ailment },
    ]),
    // Bleed keeps one bleed, so it has no stacks to count; shock kills nothing.
    { stacksAtLeast: { ailment: 'bleed', stacks: 1 } },
    { stacksAtLeast: { ailment: 'bleed', stacks: 'max' } },
    { stacksAtLeast: { ailment: 'burn', stacks: 'cap' } },
    { stacksAtLeast: { ailment: 'burn' } },
    { killedBy: 'shock' },
    { targetKind: 'minion' },
    { hitIs: 'dot' },
    { chance: 0.5, cooldownSec: 1 },
    { inZone: 'fire' },
    { inZone: 'outer.fire', radius: 50 },
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
    ...['poison', 'bleed', 'shock'].map((ailment) => ({ kind: 'applyAilment', ailment })),
    { kind: 'applyAilment', ailment: 'poison', stacks: 3, damagePct: 0.5, radius: 80 },
    { kind: 'spreadAilment', ailment: 'poison', radius: 100 },
    {
      kind: 'spreadAilment',
      ailment: 'poison',
      radius: 200,
      effect: 0.5,
      stacks: 0.5,
      maxTargets: 3,
    },
    { kind: 'explode', radius: 90, damagePct: 0.5 },
    { kind: 'explode', radius: 90, damagePct: 2, maxTargets: 5, tags: ['strike'], element: 'cold' },
    { kind: 'nova', radius: 200, damagePct: 1 },
    { kind: 'nova', radius: 200, damagePct: 1, at: 'event', element: 'lightning' },
    { kind: 'nova', radius: 200, damagePct: 1, at: 'player' },
    { kind: 'push', distance: 60, radius: 150 },
    { kind: 'addFrost', amount: 0.2 },
    { kind: 'addFrost', amount: 0.1, radius: 200, maxTargets: 5 },
    { kind: 'addFrost', amount: 0.1, radius: 200, maxTargets: 2, order: 'nearest' },
    { kind: 'applyAilment', ailment: 'shock', radius: 150, maxTargets: 2, order: 'id' },
    { kind: 'explode', radius: 90, damagePct: 0.5, maxTargets: 2, order: 'nearest' },
    {
      kind: 'spreadAilment',
      ailment: 'poison',
      radius: 200,
      maxTargets: 3,
      order: 'nearest',
    },
    { kind: 'heal', lifePct: 0.05 },
    { kind: 'gainShards', fraction: 0.5 },
    { kind: 'groundZone', radius: 60, durationSec: 2, damagePctPerSec: 0.2 },
    {
      kind: 'groundZone',
      radius: 80,
      durationSec: 3,
      damagePctPerSec: 0,
      ailment: 'poison',
      ailmentStacks: 2,
      ailmentDamagePct: 0.5,
      addFrostPerSec: 0.4,
      slow: 0.3,
      tags: ['area'],
      element: 'cold',
    },
    { kind: 'repeatAttack', count: 1, damagePct: 0.5 },
    { kind: 'repeatAttack', count: 2, damagePct: 0.3, timing: 'now' },
    { kind: 'repeatAttack', count: 4, damagePct: 1, timing: 'nextAttack' },
    { kind: 'detonate', ailment: 'burn' },
    { kind: 'detonate', ailment: 'poison', fraction: 0.5, damage: 2 },
    { kind: 'detonate', ailment: 'bleed', radius: 120, maxTargets: 3, order: 'nearest' },
    { kind: 'spreadAilment', ailment: 'poison', radius: 100, toSplitChildren: 0.5 },
    { kind: 'projectiles', count: 3, damagePct: 0.5, aim: 'target' },
    { kind: 'projectiles', count: 4, damagePct: 0.2, aim: 'distinct', from: 'player' },
    { kind: 'projectiles', count: 12, damagePct: 0.1, aim: 'radial', pierce: -1, bounce: 2 },
    {
      kind: 'projectiles',
      count: 5,
      damagePct: 0.3,
      aim: 'fan',
      from: 'event',
      pierce: 1,
      spreadDeg: 45,
      tags: ['chain'],
      element: 'lightning',
    },
    { kind: 'slashLine', length: 300, width: 24, damagePct: 0.5, toward: 'outward' },
    { kind: 'slashLine', length: 200, width: 30, damagePct: 1, toward: 'nearest', from: 'event' },
    {
      kind: 'slashLine',
      length: 400,
      width: 40,
      damagePct: 0.8,
      toward: 'eventTarget',
      from: 'target',
      alwaysCrit: true,
      critScale: 1,
      tags: ['chain'],
    },
    { kind: 'coinHit', multiplier: 10 },
    { kind: 'coinHit', multiplier: 5, ignoreShield: true, ignoreArmour: false },
    { kind: 'chainBolt', jumps: 2, damagePct: 0.5 },
    { kind: 'chainBolt', jumps: 0, damagePct: 1, shockStacks: 1, from: 'eventTarget' },
    { kind: 'chainBolt', jumps: 31, damagePct: 0.2, shockStacks: 3, from: 'nearestToPoint' },
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
    [
      'spreadAilment burn with toSplitChildren',
      { kind: 'spreadAilment', ailment: 'burn', radius: 250, toSplitChildren: 0.5 },
    ],
    ...['frost', 'frozen'].map((ailment): [string, unknown] => [
      `applyAilment ${ailment}`,
      { kind: 'applyAilment', ailment },
    ]),
    ...['bleed', 'shock', 'frost'].map((ailment): [string, unknown] => [
      `spreadAilment ${ailment}`,
      { kind: 'spreadAilment', ailment, radius: 100 },
    ]),
    [
      'spreadAilment poison with an unknown key',
      { kind: 'spreadAilment', ailment: 'poison', radius: 100, targets: 3 },
    ],
    ['addFrost without an amount', { kind: 'addFrost', radius: 100 }],
    ['addFrost with an unknown key', { kind: 'addFrost', amount: 0.2, stacks: 1 }],
    ['detonate without an ailment', { kind: 'detonate', radius: 100 }],
    ...['shock', 'frost', 'frozen'].map((ailment): [string, unknown] => [
      `detonate ${ailment}, which deals no damage over time`,
      { kind: 'detonate', ailment },
    ]),
    ['detonate with an unknown key', { kind: 'detonate', ailment: 'burn', stacks: 2 }],
    ['detonate at an unknown order', { kind: 'detonate', ailment: 'burn', order: 'farthest' }],
    ['explode without a radius', { kind: 'explode', damagePct: 0.5 }],
    ['nova at an unknown point', { kind: 'nova', radius: 100, damagePct: 1, at: 'target' }],
    ['an element that is not one', { kind: 'nova', radius: 100, damagePct: 1, element: 'fire' }],
    ['an unknown key', { kind: 'heal', lifePct: 0.1, amount: 1 }],
    ['an unknown order', { kind: 'explode', radius: 90, damagePct: 1, order: 'farthest' }],
    ['order on a nova', { kind: 'nova', radius: 90, damagePct: 1, order: 'nearest' }],
    ['order on push', { kind: 'push', distance: 60, radius: 150, order: 'nearest' }],
    [
      'order on a burn spread',
      { kind: 'spreadAilment', ailment: 'burn', radius: 250, order: 'nearest' },
    ],
    [
      'groundZone with an unknown key',
      { kind: 'groundZone', radius: 60, durationSec: 2, damagePctPerSec: 0.2, maxTargets: 3 },
    ],
    [
      'groundZone applying frost as an ailment',
      { kind: 'groundZone', radius: 60, durationSec: 2, damagePctPerSec: 0, ailment: 'frost' },
    ],
    ['groundZone without a duration', { kind: 'groundZone', radius: 60, damagePctPerSec: 0.2 }],
    ['repeatAttack without a count', { kind: 'repeatAttack', damagePct: 0.5 }],
    ['repeatAttack without damagePct', { kind: 'repeatAttack', count: 1 }],
    [
      'repeatAttack at an unknown timing',
      { kind: 'repeatAttack', count: 1, damagePct: 0.5, timing: 'later' },
    ],
    [
      'repeatAttack with an unknown key',
      { kind: 'repeatAttack', count: 1, damagePct: 0.5, radius: 100 },
    ],
    ['projectiles without an aim', { kind: 'projectiles', count: 3, damagePct: 0.5 }],
    ['projectiles without a count', { kind: 'projectiles', damagePct: 0.5, aim: 'radial' }],
    ['projectiles without damagePct', { kind: 'projectiles', count: 3, aim: 'radial' }],
    [
      'projectiles at an unknown aim',
      { kind: 'projectiles', count: 3, damagePct: 0.5, aim: 'nearest' },
    ],
    [
      'projectiles from an unknown point',
      { kind: 'projectiles', count: 3, damagePct: 0.5, aim: 'radial', from: 'target' },
    ],
    [
      'projectiles with an unknown key',
      { kind: 'projectiles', count: 3, damagePct: 0.5, aim: 'radial', radius: 100 },
    ],
    ...(['flight', 'along', 'player'] as const).map((toward): [string, unknown] => [
      `slashLine toward '${toward}'`,
      { kind: 'slashLine', length: 300, width: 24, damagePct: 0.5, toward },
    ]),
    ['slashLine without toward', { kind: 'slashLine', length: 300, width: 24, damagePct: 0.5 }],
    [
      'slashLine without length',
      { kind: 'slashLine', width: 24, damagePct: 0.5, toward: 'outward' },
    ],
    [
      'slashLine without width',
      { kind: 'slashLine', length: 300, damagePct: 0.5, toward: 'outward' },
    ],
    [
      'slashLine without damagePct',
      { kind: 'slashLine', length: 300, width: 24, toward: 'outward' },
    ],
    [
      'slashLine from an unknown point',
      {
        kind: 'slashLine',
        length: 300,
        width: 24,
        damagePct: 0.5,
        toward: 'outward',
        from: 'player',
      },
    ],
    [
      'slashLine with an element',
      {
        kind: 'slashLine',
        length: 300,
        width: 24,
        damagePct: 0.5,
        toward: 'outward',
        element: 'cold',
      },
    ],
    ['coinHit without a multiplier', { kind: 'coinHit' }],
    ['coinHit with tags', { kind: 'coinHit', multiplier: 10, tags: ['chain'] }],
    ['coinHit with shardCostPct (B4)', { kind: 'coinHit', multiplier: 10, shardCostPct: 0.1 }],
    ['chainBolt without jumps', { kind: 'chainBolt', damagePct: 0.5 }],
    ['chainBolt without damagePct', { kind: 'chainBolt', jumps: 2 }],
    ['chainBolt from the player', { kind: 'chainBolt', jumps: 2, damagePct: 0.5, from: 'player' }],
    ['chainBolt with an element', { kind: 'chainBolt', jumps: 2, damagePct: 0.5, element: 'cold' }],
    ['chainBolt with tags', { kind: 'chainBolt', jumps: 2, damagePct: 0.5, tags: ['area'] }],
    [
      'chainBolt with a chain policy field',
      { kind: 'chainBolt', jumps: 2, damagePct: 0.5, bounces: 1 },
    ],
  ])('rejects %s', (_label, effect) => {
    expect(EffectSpecSchema.safeParse(effect).success).toBe(false);
  });

  it('requires damagePctPerSec on a groundZone, saying how to write a zone without damage', () => {
    const result = EffectSpecSchema.safeParse({ kind: 'groundZone', radius: 60, durationSec: 2 });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['damagePctPerSec'],
        message: 'damagePctPerSec is required; use 0 for a zone that only applies its status terms',
      }),
    ]);
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
    { pick: 'nearest' },
    { pick: 'farthest', from: 'player', range: 400 },
    { pick: 'highestHp', excludeBoss: true },
    { pick: 'densest', from: 'event' },
    { pick: 'outermost', excludeEventTarget: false },
    { pick: 'player' },
    { pick: 'mostStacks', ailment: 'shock', range: 300, excludeEventTarget: true },
  ])('accepts the target selector %o', (target) => {
    const trigger = { on: 'periodic', every: 2, target, do: [{ kind: 'heal', lifePct: 0.05 }] };
    expect(TriggerSpecSchema.parse(trigger)).toEqual(trigger);
  });

  it.each<[string, unknown]>([
    ['no pick', {}],
    ['an unknown pick', { pick: 'random' }],
    ['a pick name alone', 'nearest'],
    ['an ailment without stacks', { pick: 'mostStacks', ailment: 'bleed' }],
    ['an unknown origin', { pick: 'nearest', from: 'target' }],
    ['an infinite range', { pick: 'nearest', range: Infinity }],
    ['an unknown key', { pick: 'nearest', maxTargets: 2 }],
  ])('rejects a target selector with %s', (_label, target) => {
    const trigger = { on: 'kill', target, do: [{ kind: 'heal', lifePct: 0.05 }] };
    expect(TriggerSpecSchema.safeParse(trigger).success).toBe(false);
  });

  it.each([
    ['an unknown event', { on: 'tick', do: [{ kind: 'heal', lifePct: 0.1 }] }],
    ['no effect list', { on: 'kill' }],
    ['an unknown effect', { on: 'kill', do: [{ kind: 'teleport' }] }],
    ['an unknown key', { on: 'kill', do: [], selector: { pick: 'nearest' } }],
  ])('rejects %s', (_label, trigger) => {
    expect(TriggerSpecSchema.safeParse(trigger).success).toBe(false);
  });
});

describe('ConversionSpecSchema', () => {
  it.each([
    ['to poison', { to: 'poison', fraction: 0.3 }],
    ['tagged, to an element', { tags: ['minion', 'crit'], to: 'cold', fraction: 0.5 }],
    ['to burn', { to: 'burn', fraction: 1 }],
    ['to bleed', { to: 'bleed', fraction: 0.1 }],
    ['to lightning', { to: 'lightning', fraction: 0.2 }],
  ])('accepts a conversion %s', (_label, conversion) => {
    expect(ConversionSpecSchema.parse(conversion)).toEqual(conversion);
  });

  it.each([
    ['an unknown target', { to: 'fire', fraction: 0.3 }],
    ['a target that is a hit', { to: 'hit', fraction: 0.3 }],
    ['no fraction', { to: 'poison' }],
    ['an unknown tag', { tags: ['drone'], to: 'poison', fraction: 0.3 }],
    ['an unknown key', { to: 'poison', fraction: 0.3, scope: 'center' }],
  ])('rejects %s', (_label, conversion) => {
    expect(ConversionSpecSchema.safeParse(conversion).success).toBe(false);
  });
});

const SAMPLE_GRANTS: { readonly [K in GrantKind]: Extract<EmitterGrant, { kind: K }> } = {
  thorns: { kind: 'thorns', damagePct: 2 },
  segment: {
    kind: 'segment',
    endpoints: 'shocked',
    links: 1,
    range: 150,
    damagePct: 0.2,
    shockStacks: 2,
    periodSec: 0.5,
  },
};

describe('EmitterGrantSchema', () => {
  it('accepts every grant kind with its fields, through its own schema too', () => {
    for (const kind of Object.keys(GRANT_SCHEMAS) as GrantKind[]) {
      const grant = SAMPLE_GRANTS[kind];
      expect(EmitterGrantSchema.parse(grant)).toEqual(grant);
      expect(GRANT_SCHEMAS[kind].parse(grant)).toEqual(grant);
    }
    expect(EmitterGrantSchema.parse({ kind: 'thorns' })).toEqual({ kind: 'thorns' });
    const bare = { kind: 'segment', endpoints: 'shocked' };
    expect(EmitterGrantSchema.parse(bare)).toEqual(bare);
  });

  it.each([
    ['an unknown kind', { kind: 'spikes' }],
    ['a damage share that is not a number', { kind: 'thorns', damagePct: '3' }],
    ['a damage share that is not finite', { kind: 'thorns', damagePct: Infinity }],
    ['an unknown key', { kind: 'thorns', radius: 40 }],
    ['a segment without endpoints', { kind: 'segment', links: 2 }],
    ['a segment between the drones, which C5 adds', { kind: 'segment', endpoints: 'drones' }],
    ['a segment between the summons, which C5 adds', { kind: 'segment', endpoints: 'summons' }],
    ['a segment range that is not finite', { kind: 'segment', endpoints: 'shocked', range: NaN }],
    ['a segment with an unknown key', { kind: 'segment', endpoints: 'shocked', radius: 40 }],
  ])('rejects %s', (_label, grant) => {
    expect(EmitterGrantSchema.safeParse(grant).success).toBe(false);
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
    [
      'Pandemic, which became data',
      { id: 'pandemic', spreadRadius: 250, spreadEffect: 0.4, hitMore: -0.3 },
    ],
    ['a missing parameter', { id: 'steadyAim', everyNth: 3 }],
    ['a missing choice', { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5 }],
    [
      'an unknown choice',
      { id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5, counts: 'volley' },
    ],
    ['a parameter of another rule', { id: 'glassCannon', damageMore: 1, durationMore: 1 }],
    ['a lob form missing a parameter', { id: 'volcano', periodSec: 3, radiusMult: 3 }],
    ['a lob form with the params name', { id: 'farThrow', farThrowEvery: 4 }],
    [
      'a lob form with its compiled fields',
      { id: 'chainBlast', radius: 40, damagePct: 0.5, perBomb: 2, trigger: 1, effect: 0 },
    ],
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

  it('accepts triggers and conversions on a talent, and requires both lists', () => {
    const triggers = content();
    Object.assign(talentAt(triggers, 'vitality')[1], {
      triggers: [{ on: 'kill', do: [{ kind: 'gainShards', fraction: 0.2 }] }],
    });
    expect(GameDataSchema.safeParse(triggers).success).toBe(true);

    const conversions = content();
    Object.assign(talentAt(conversions, 'vitality')[1], {
      conversions: [{ to: 'poison', fraction: 0.3 }],
    });
    expect(GameDataSchema.safeParse(conversions).success).toBe(true);

    const bad = content();
    Object.assign(talentAt(bad, 'vitality')[1], { conversions: [{ to: 'fire', fraction: 0.3 }] });
    expect(GameDataSchema.safeParse(bad).success).toBe(false);

    for (const list of ['triggers', 'conversions']) {
      const missing = content();
      Reflect.deleteProperty(talentAt(missing, 'vitality')[1], list);
      expect(GameDataSchema.safeParse(missing).success, list).toBe(false);
    }
  });

  it('accepts emitter grants on a talent, and requires the list', () => {
    const grants = content();
    Object.assign(talentAt(grants, 'vitality')[1], { emitters: [{ kind: 'thorns' }] });
    expect(GameDataSchema.safeParse(grants).success).toBe(true);

    const bad = content();
    Object.assign(talentAt(bad, 'vitality')[1], { emitters: [{ kind: 'aura' }] });
    expect(GameDataSchema.safeParse(bad).success).toBe(false);

    const missing = content();
    Reflect.deleteProperty(talentAt(missing, 'vitality')[1], 'emitters');
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
