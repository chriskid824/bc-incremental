/**
 * E8's seated rows in the data (lead ruling T1): a spawnDrone's `seat` and `fires` in the strict
 * schema and the web payload's, and their validation case by case, beside spawnDrone.test.ts:
 * the two only together, a seated row without its own impact, pick, dash and ailment terms and
 * with damagePct 0, a period of a tick or more and a range above 0, and a `do` that is a
 * projectiles effect (not from 'player') or a chainBolt, checked as that effect is anywhere else.
 */

import { describe, expect, it } from 'vitest';
import { ENEMIES } from './enemies';
import { EffectSpecSchema, TriggerSpecSchema } from './schema';
import { TALENTS } from './talents';
import type { EffectSpec, SpawnDroneSpec, TriggerSpec } from './triggers';
import type { GameData, TalentNode } from './types';
import { validateGameData } from './validate';
import { WAVES } from './waves';
import { PayloadEffectSchema } from './web/schema';

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

const content = (): Mutable<GameData> =>
  structuredClone({ enemies: ENEMIES, waves: WAVES, talents: TALENTS }) as Mutable<GameData>;

/** Issues of the real content with `triggers` on 'vitality', which then has its descKey. */
function triggerIssues(...triggers: TriggerSpec[]): string[] {
  const data = content();
  const node = data.talents.find((n) => n.id === 'vitality') as Mutable<TalentNode>;
  node.triggers.push(...(triggers as Mutable<TriggerSpec>[]));
  node.descKey = 'talent.vitality.desc';
  return validateGameData(data);
}

const at = "talent 'vitality': triggers[0]";
const heal = { kind: 'heal', lifePct: 0.05 } as const;
/** 冰晶哨's shape: 5 s, at most 4, firing a cold fan of 3 every 0.5 s within 300. */
const ICE_SENTRY: SpawnDroneSpec = {
  kind: 'spawnDrone',
  lifeSec: 5,
  damagePct: 0,
  maxLive: 4,
  seat: true,
  element: 'cold',
  fires: {
    everySec: 0.5,
    range: 300,
    do: { kind: 'projectiles', count: 3, aim: 'fan', spreadDeg: 30, damagePct: 0.3 },
  },
};
/** 電蜂's shape: 5 s, at most 3, a bolt of 2 jumps every second, any distance. */
const BOLT_BEE: SpawnDroneSpec = {
  kind: 'spawnDrone',
  lifeSec: 5,
  damagePct: 0,
  maxLive: 3,
  seat: true,
  fires: { everySec: 1, do: { kind: 'chainBolt', jumps: 2, damagePct: 0.5 } },
};
/** A seated row with `fields` written over it, unchecked, as data that skipped the schema. */
const seatedWith = (fields: Record<string, unknown>): EffectSpec =>
  ({ ...BOLT_BEE, ...fields }) as unknown as EffectSpec;
/** BOLT_BEE with `fires` fields written over its own, unchecked. */
const firesWith = (fields: Record<string, unknown>): EffectSpec =>
  seatedWith({ fires: { ...BOLT_BEE.fires, ...fields } });

describe('seated rows in the schema', () => {
  it.each([
    ['冰晶哨’s shape', ICE_SENTRY],
    ['電蜂’s shape', BOLT_BEE],
    [
      'every projectiles field',
      {
        ...ICE_SENTRY,
        fires: {
          everySec: 0.25,
          do: {
            kind: 'projectiles',
            count: 2,
            aim: 'distinct',
            from: 'event',
            pierce: 1,
            bounce: 1,
            spreadDeg: 10,
            countStat: 'barrageCount',
            damagePct: 0.2,
            tags: ['area'],
            element: 'lightning',
          },
        },
      },
    ],
    [
      'every chainBolt field',
      {
        ...BOLT_BEE,
        fires: {
          everySec: 1,
          range: 500,
          do: {
            kind: 'chainBolt',
            jumps: 4,
            damagePct: 1,
            shockStacks: 1,
            from: 'nearestOther',
            bolts: 2,
            arc: true,
          },
        },
      },
    ],
  ])('accepts %s', (_label, effect) => {
    expect(EffectSpecSchema.parse(effect)).toEqual(effect);
    expect(PayloadEffectSchema.parse(effect)).toEqual(effect);
    expect(TriggerSpecSchema.parse({ on: 'shatter', do: [effect] })).toEqual({
      on: 'shatter',
      do: [effect],
    });
  });

  it.each([
    ['seat false', { ...BOLT_BEE, seat: false }],
    ['seat a string', { ...BOLT_BEE, seat: 'yes' }],
    ['fires without do', { ...BOLT_BEE, fires: { everySec: 1 } }],
    ['fires without everySec', { ...BOLT_BEE, fires: { do: BOLT_BEE.fires?.do } }],
    [
      'an everySec that is not finite',
      { ...BOLT_BEE, fires: { ...BOLT_BEE.fires, everySec: NaN } },
    ],
    ['a range that is a string', { ...BOLT_BEE, fires: { ...BOLT_BEE.fires, range: '300' } }],
    ['an unknown key in fires', { ...BOLT_BEE, fires: { ...BOLT_BEE.fires, count: 2 } }],
    [
      'a do of another kind',
      { ...BOLT_BEE, fires: { everySec: 1, do: { kind: 'explode', radius: 60, damagePct: 1 } } },
    ],
    [
      'a do with an unknown key',
      {
        ...BOLT_BEE,
        fires: { everySec: 1, do: { kind: 'chainBolt', jumps: 2, damagePct: 1, x: 1 } },
      },
    ],
    [
      'a do with an unknown aim',
      {
        ...ICE_SENTRY,
        fires: { everySec: 1, do: { kind: 'projectiles', count: 1, aim: 'back', damagePct: 1 } },
      },
    ],
  ])('rejects %s', (_label, effect) => {
    expect(EffectSpecSchema.safeParse(effect).success).toBe(false);
    expect(PayloadEffectSchema.safeParse(effect).success).toBe(false);
  });
});

describe('seated rows: validation', () => {
  it('accepts 冰晶哨 on shatter at 25 %, 電蜂 on a periodic trigger and each do kind and aim, on events with an enemy or none', () => {
    const aims = (['target', 'distinct', 'radial', 'fan'] as const).map((aim): SpawnDroneSpec => ({
      ...ICE_SENTRY,
      fires: { everySec: 1, do: { kind: 'projectiles', count: 2, aim, damagePct: 0.5 } },
    }));
    expect(
      triggerIssues(
        { on: 'shatter', when: [{ chance: 0.25 }], do: [ICE_SENTRY] },
        { on: 'periodic', every: 1, do: [BOLT_BEE] },
        { on: 'nthAttack', every: 3, do: aims },
        {
          on: 'droneExpire',
          do: [
            {
              ...BOLT_BEE,
              fires: {
                everySec: 1 / 60,
                do: { kind: 'chainBolt', jumps: 0, damagePct: 1, from: 'nearestToPoint' },
              },
            },
          ],
        },
        { on: 'hit', do: [{ ...ICE_SENTRY, count: 2, maxLive: 24, tags: ['area'] }] },
      ),
    ).toEqual([]);
  });

  it.each([
    [
      'seat without fires',
      { fires: undefined },
      [
        'seat needs fires: a seated row never dashes or impacts, it only fires',
        'spawnDrone does nothing: give it damagePct > 0 or ailment',
      ],
    ],
    [
      'fires without seat',
      { seat: undefined },
      ['fires needs seat: true; a row that dashes and impacts fires nothing'],
    ],
    [
      'seat false',
      { seat: false },
      [
        'seat must be true or left out (got false)',
        'fires needs seat: true; a row that dashes and impacts fires nothing',
      ],
    ],
    [
      'impacts',
      { impacts: 1 },
      ['impacts does not apply to a seated row, which never dashes or impacts'],
    ],
    [
      'aim',
      { aim: 'nearest' },
      ['aim does not apply to a seated row, which never dashes or impacts'],
    ],
    [
      'speed',
      { speed: 300 },
      ['speed does not apply to a seated row, which never dashes or impacts'],
    ],
    [
      'splash',
      { splash: 0 },
      ['splash does not apply to a seated row, which never dashes or impacts'],
    ],
    [
      'an ailment',
      { ailment: 'burn' },
      ['ailment does not apply to a seated row, which never dashes or impacts'],
    ],
    [
      'ailmentStacks',
      { ailment: 'burn', ailmentStacks: 2 },
      [
        'ailment does not apply to a seated row, which never dashes or impacts',
        'ailmentStacks does not apply to a seated row, which never dashes or impacts',
      ],
    ],
    [
      'ailmentDamagePct',
      { ailment: 'poison', ailmentDamagePct: 0.5 },
      [
        'ailment does not apply to a seated row, which never dashes or impacts',
        'ailmentDamagePct does not apply to a seated row, which never dashes or impacts',
      ],
    ],
    [
      'damagePct 0.5',
      { damagePct: 0.5 },
      ["damagePct must be 0 on a seated row, whose hits are its fires' (got 0.5)"],
    ],
  ])('rejects %s', (_label, fields, issues) => {
    expect(triggerIssues({ on: 'hit', do: [heal, seatedWith(fields)] })).toEqual(
      issues.map((issue) => `${at} do[1] ${issue}`),
    );
  });

  it.each([
    [
      'everySec 0',
      { everySec: 0 },
      'fires.everySec must be finite with round(everySec × 60) >= 1 (got 0)',
    ],
    [
      'a negative everySec',
      { everySec: -1 },
      'fires.everySec must be finite with round(everySec × 60) >= 1 (got -1)',
    ],
    [
      'everySec NaN',
      { everySec: NaN },
      'fires.everySec must be finite with round(everySec × 60) >= 1 (got NaN)',
    ],
    [
      'everySec Infinity',
      { everySec: Infinity },
      'fires.everySec must be finite with round(everySec × 60) >= 1 (got Infinity)',
    ],
    [
      'an everySec of 1/200, under half a tick',
      { everySec: 1 / 200 },
      'fires.everySec must be finite with round(everySec × 60) >= 1 (got 0.005)',
    ],
    ['range 0', { range: 0 }, 'fires.range must be finite and > 0 (got 0)'],
    ['a negative range', { range: -10 }, 'fires.range must be finite and > 0 (got -10)'],
    ['range NaN', { range: NaN }, 'fires.range must be finite and > 0 (got NaN)'],
    ['range Infinity', { range: Infinity }, 'fires.range must be finite and > 0 (got Infinity)'],
    [
      'a do of another kind',
      { do: { kind: 'explode', radius: 60, damagePct: 1 } },
      'fires.do must be a projectiles or chainBolt effect (got explode)',
    ],
    [
      'projectiles from the player',
      { do: { kind: 'projectiles', count: 1, aim: 'target', from: 'player', damagePct: 1 } },
      "fires.do's projectiles start where the row stands: leave out from 'player'",
    ],
  ])('rejects %s', (_label, fields, issue) => {
    expect(triggerIssues({ on: 'hit', do: [heal, firesWith(fields)] })).toEqual([
      `${at} do[1] ${issue}`,
    ]);
  });

  it('checks its do as that effect anywhere else, each issue under fires.do', () => {
    const issues = triggerIssues(
      {
        on: 'hit',
        do: [firesWith({ do: { kind: 'chainBolt', jumps: 40, damagePct: -1, bolts: 2 } })],
      },
      {
        on: 'hit',
        do: [
          firesWith({
            do: { kind: 'projectiles', count: 0, aim: 'target', damagePct: 1, pierce: -2 },
          }),
        ],
      },
    );
    const second = "talent 'vitality': triggers[1]";
    expect(issues).toEqual([
      `${at} do[0] fires.do jumps must be an integer in [0, 31] (got 40)`,
      `${at} do[0] fires.do damagePct must be >= 0 (got -1)`,
      `${at} do[0] fires.do chainBolt from 'eventTarget' starts on one enemy; bolts 2 needs from 'nearestToPoint' or 'nearestOther'`,
      `${second} do[0] fires.do count must be an integer in [1, 64] (got 0)`,
      `${second} do[0] fires.do pierce must be an integer >= -1 (-1: every enemy) (got -2)`,
    ]);
  });
});
