/**
 * spawnDrone's data (C5.7, lead ruling K1): its strict schema, its validation field by field, the
 * droneExpire event it raises (wired, without an enemy), its numbers for the talent text and its
 * COEF fields.
 */

import { describe, expect, it } from 'vitest';
import { ENEMIES } from './enemies';
import { parseGameData } from './index';
import { effectNumbers } from './ruleNumbers';
import { EffectSpecSchema, TriggerSpecSchema } from './schema';
import { scalesDamage } from './fusion/sensitivity';
import { TALENTS } from './talents';
import { COEF_FIELDS, TARGETLESS_EVENTS, TRIGGER_EVENTS, WIRED_EVENTS } from './triggers';
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

function vitality(data: Mutable<GameData>): Mutable<TalentNode> {
  const node = data.talents.find((n) => n.id === 'vitality');
  if (node === undefined) throw new Error("No talent 'vitality'");
  return node;
}

/** Issues of the real content with `triggers` on 'vitality', which then has its descKey. */
function triggerIssues(...triggers: TriggerSpec[]): string[] {
  const data = content();
  const node = vitality(data);
  node.triggers.push(...(triggers as Mutable<TriggerSpec>[]));
  node.descKey = 'talent.vitality.desc';
  return validateGameData(data);
}

const at = "talent 'vitality': triggers[0]";
const heal = { kind: 'heal', lifePct: 0.05 } as const;
/** 爆靈's rows: 1 of 4 s at the nearest enemy, 3 burn stacks, at most 6. */
const SPIRIT: SpawnDroneSpec = {
  kind: 'spawnDrone',
  lifeSec: 4,
  damagePct: 1,
  maxLive: 6,
  ailment: 'burn',
  ailmentStacks: 3,
};
const FULL: SpawnDroneSpec = {
  kind: 'spawnDrone',
  lifeSec: 2.5,
  damagePct: 0.4,
  count: 3,
  impacts: 3,
  maxLive: 24,
  aim: 'outer',
  speed: 450,
  splash: 0,
  ailment: 'poison',
  ailmentStacks: 2,
  ailmentDamagePct: 0.5,
  tags: ['area'],
  element: 'cold',
};
/** The spec with `fields` written over it, unchecked, as data that skipped the schema. */
const spawnWith = (fields: Record<string, unknown>): EffectSpec =>
  ({ kind: 'spawnDrone', lifeSec: 4, damagePct: 1, ...fields }) as unknown as EffectSpec;

describe('spawnDrone in the schema', () => {
  it.each([
    ['its required fields alone', { kind: 'spawnDrone', lifeSec: 4, damagePct: 1 }],
    ['爆靈’s rows', SPIRIT],
    ['every field', FULL],
    ['an ailment-only row', { kind: 'spawnDrone', lifeSec: 1, damagePct: 0, ailment: 'shock' }],
  ])('accepts %s', (_label, effect) => {
    expect(EffectSpecSchema.parse(effect)).toEqual(effect);
    expect(PayloadEffectSchema.parse(effect)).toEqual(effect);
  });

  it.each([
    ['without lifeSec', { kind: 'spawnDrone', damagePct: 1 }],
    ['a lifeSec that is not finite', { kind: 'spawnDrone', lifeSec: Infinity, damagePct: 1 }],
    ['a damagePct that is not a number', { kind: 'spawnDrone', lifeSec: 4, damagePct: '1' }],
    ['an unknown aim', { ...SPIRIT, aim: 'farthest' }],
    ['an aim of the drones’ own word', { ...SPIRIT, aim: 'outermost' }],
    ['frost as its ailment', { ...SPIRIT, ailment: 'frost' }],
    ['an unknown tag', { ...SPIRIT, tags: ['summon'] }],
    ['an element that is not one', { ...SPIRIT, element: 'fire' }],
    ['an unknown key', { ...SPIRIT, durationSec: 4 }],
    ['a radius, which a zone has', { ...SPIRIT, radius: 40 }],
    ['count undefined', { ...SPIRIT, count: undefined }],
    ['a speed that is not finite', { ...SPIRIT, speed: NaN }],
  ])('rejects %s', (_label, effect) => {
    expect(EffectSpecSchema.safeParse(effect).success).toBe(false);
  });

  it('requires damagePct, saying how to write a row without damage', () => {
    const result = EffectSpecSchema.safeParse({ kind: 'spawnDrone', lifeSec: 4 });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['damagePct'],
        message: 'damagePct is required; use 0 for a row that only applies its ailment',
      }),
    ]);
  });

  it('takes a trigger on droneExpire, the last of the trigger events, now raised', () => {
    const trigger = { on: 'droneExpire', do: [{ ...SPIRIT, lifeSec: 1 }] };
    expect(TriggerSpecSchema.parse(trigger)).toEqual(trigger);
    expect(TRIGGER_EVENTS.at(-1)).toBe('droneExpire');
    expect(WIRED_EVENTS.has('droneExpire')).toBe(true);
    expect(TARGETLESS_EVENTS.has('droneExpire')).toBe(false);
    expect(TRIGGER_EVENTS.filter((e) => !WIRED_EVENTS.has(e))).toEqual([]);
  });
});

describe('spawnDrone validation', () => {
  it('accepts its rows on every event, an ailment-only row among them', () => {
    expect(
      triggerIssues(
        { on: 'nthAttack', every: 4, do: [SPIRIT] },
        { on: 'hit', do: [FULL] },
        { on: 'kill', do: [{ kind: 'spawnDrone', lifeSec: 0.1, damagePct: 0, ailment: 'bleed' }] },
        { on: 'droneExpire', do: [{ kind: 'spawnDrone', lifeSec: 1, damagePct: 0.5 }] },
        { on: 'periodic', every: 2, do: [{ ...SPIRIT, impacts: 32767, maxLive: 1 }] },
      ),
    ).toEqual([]);
  });

  it.each([
    ['lifeSec 0', { lifeSec: 0 }, 'lifeSec must be finite and > 0 (got 0)'],
    ['a negative lifeSec', { lifeSec: -1 }, 'lifeSec must be finite and > 0 (got -1)'],
    ['lifeSec NaN', { lifeSec: NaN }, 'lifeSec must be finite and > 0 (got NaN)'],
    ['lifeSec Infinity', { lifeSec: Infinity }, 'lifeSec must be finite and > 0 (got Infinity)'],
    ['a negative damagePct', { damagePct: -0.5 }, 'damagePct must be finite and >= 0 (got -0.5)'],
    ['damagePct NaN', { damagePct: NaN }, 'damagePct must be finite and >= 0 (got NaN)'],
    [
      'damagePct Infinity',
      { damagePct: Infinity },
      'damagePct must be finite and >= 0 (got Infinity)',
    ],
    [
      'no damagePct',
      { damagePct: undefined },
      'damagePct is required; use 0 for a row that only applies its ailment',
    ],
    ['count 0', { count: 0 }, 'count must be a positive integer (got 0)'],
    ['count 1.5', { count: 1.5 }, 'count must be a positive integer (got 1.5)'],
    ['impacts 0', { impacts: 0 }, 'impacts must be an integer in [1, 32767] (got 0)'],
    ['impacts 2.5', { impacts: 2.5 }, 'impacts must be an integer in [1, 32767] (got 2.5)'],
    ['impacts 32768', { impacts: 32768 }, 'impacts must be an integer in [1, 32767] (got 32768)'],
    ['maxLive 0', { maxLive: 0 }, 'maxLive must be an integer in [1, 24] (got 0)'],
    ['maxLive 25', { maxLive: 25 }, 'maxLive must be an integer in [1, 24] (got 25)'],
    ['maxLive 6.5', { maxLive: 6.5 }, 'maxLive must be an integer in [1, 24] (got 6.5)'],
    ['an unknown aim', { aim: 'farthest' }, "aim must be 'nearest' or 'outer' (got farthest)"],
    ['speed 0', { speed: 0 }, 'speed must be finite and > 0 (got 0)'],
    ['speed Infinity', { speed: Infinity }, 'speed must be finite and > 0 (got Infinity)'],
    ['a negative splash', { splash: -1 }, 'splash must be finite and >= 0 (got -1)'],
    ['splash NaN', { splash: NaN }, 'splash must be finite and >= 0 (got NaN)'],
    [
      'ailmentStacks 0',
      { ailment: 'burn', ailmentStacks: 0 },
      'ailmentStacks must be a positive integer (got 0)',
    ],
    [
      'ailmentStacks 1.5',
      { ailment: 'burn', ailmentStacks: 1.5 },
      'ailmentStacks must be a positive integer (got 1.5)',
    ],
    [
      'ailmentDamagePct 0',
      { ailment: 'poison', ailmentDamagePct: 0 },
      'ailmentDamagePct must be > 0 (got 0)',
    ],
    [
      'ailmentStacks without an ailment',
      { ailmentStacks: 2 },
      'ailmentStacks and ailmentDamagePct need ailment',
    ],
    [
      'ailmentDamagePct without an ailment',
      { ailmentDamagePct: 0.5 },
      'ailmentStacks and ailmentDamagePct need ailment',
    ],
    [
      'a row that does nothing',
      { damagePct: 0 },
      'spawnDrone does nothing: give it damagePct > 0 or ailment',
    ],
    ['a burn tag', { tags: ['burn'] }, "tag 'burn' is not an owner or geometry tag"],
  ])('rejects %s', (_label, fields, issue) => {
    expect(triggerIssues({ on: 'hit', do: [heal, spawnWith(fields)] })).toEqual([
      `${at} do[1] ${issue}`,
    ]);
  });

  it('lists every issue of one row, in field order', () => {
    expect(
      triggerIssues({
        on: 'hit',
        do: [
          spawnWith({
            lifeSec: 0,
            damagePct: 0,
            count: 0,
            impacts: 0,
            maxLive: 0,
            speed: 0,
            splash: -1,
            ailmentStacks: 0,
          }),
        ],
      }),
    ).toEqual([
      `${at} do[0] lifeSec must be finite and > 0 (got 0)`,
      `${at} do[0] count must be a positive integer (got 0)`,
      `${at} do[0] impacts must be an integer in [1, 32767] (got 0)`,
      `${at} do[0] maxLive must be an integer in [1, 24] (got 0)`,
      `${at} do[0] speed must be finite and > 0 (got 0)`,
      `${at} do[0] splash must be finite and >= 0 (got -1)`,
      `${at} do[0] ailmentStacks must be a positive integer (got 0)`,
      `${at} do[0] ailmentStacks and ailmentDamagePct need ailment`,
      `${at} do[0] spawnDrone does nothing: give it damagePct > 0 or ailment`,
    ]);
  });

  it('requires damagePct through the schema too (parseGameData)', () => {
    const data = content();
    vitality(data).triggers.push({
      on: 'hit',
      do: [{ kind: 'spawnDrone', lifeSec: 4 }],
    } as unknown as Mutable<TriggerSpec>);
    vitality(data).descKey = 'talent.vitality.desc';
    expect(() => parseGameData(data)).toThrow(
      'damagePct is required; use 0 for a row that only applies its ailment',
    );
  });

  it('gives droneExpire no enemy: an effect or selector that needs the event’s enemy is rejected on it, and a selector’s pick is taken', () => {
    expect(
      triggerIssues(
        { on: 'droneExpire', do: [{ kind: 'applyAilment', ailment: 'burn' }] },
        {
          on: 'droneExpire',
          target: { pick: 'nearest', excludeEventTarget: true },
          do: [{ kind: 'explode', radius: 60, damagePct: 0.5 }],
        },
        {
          on: 'droneExpire',
          target: { pick: 'nearest', range: 300 },
          do: [{ kind: 'applyAilment', ailment: 'burn' }],
        },
        { on: 'droneExpire', do: [{ kind: 'explode', radius: 60, damagePct: 0.5 }] },
      ),
    ).toEqual([
      `${at} do[0] applyAilment needs the event's enemy, which 'droneExpire' events have not`,
      "talent 'vitality': triggers[1] target.excludeEventTarget needs the event's enemy, which 'droneExpire' events have not",
    ]);
  });
});

describe('spawnDrone’s numbers and COEF fields', () => {
  it('gives the talent text its numbers in the template’s order: count, lifeSec, damagePct, impacts, maxLive, the ailment’s stacks and share', () => {
    expect(effectNumbers(SPIRIT)).toEqual([['4'], ['100%'], ['6'], ['3']]);
    expect(effectNumbers(FULL)).toEqual([['3'], ['2.5'], ['40%'], ['3'], ['24'], ['2'], ['50%']]);
    expect(
      effectNumbers({ kind: 'spawnDrone', lifeSec: 1, damagePct: 0, ailment: 'shock' }),
    ).toEqual([['1']]);
  });

  it('scales damagePct and ailmentDamagePct, the latter only with an ailment', () => {
    expect(COEF_FIELDS.spawnDrone).toEqual(['damagePct', 'ailmentDamagePct']);
    expect(scalesDamage(SPIRIT)).toBe(true);
    expect(scalesDamage({ kind: 'spawnDrone', lifeSec: 1, damagePct: 0, ailment: 'burn' })).toBe(
      true,
    );
    expect(scalesDamage({ kind: 'spawnDrone', lifeSec: 1, damagePct: 0 })).toBe(false);
    expect(
      scalesDamage({ kind: 'spawnDrone', lifeSec: 1, damagePct: 0, ailmentDamagePct: 0.5 }),
    ).toBe(false);
  });
});
