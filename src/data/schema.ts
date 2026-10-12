/**
 * zod schemas for the data files. Each schema's output type must equal the interface it
 * mirrors (checked at compile time by `exact`), so the interfaces stay the source of truth.
 * Schemas check shape, enums and finiteness; cross-references and value ranges are checked
 * by `validateGameData` (src/data/validate.ts). `.readonly()` also freezes parsed values.
 */

import { z } from 'zod';
import type { RuleSpec } from './rules';
import { DAMAGE_TAGS, STAT_IDS } from './stats';
import type { Modifier, ModifierKind } from './stats';
import { ENEMY_IDS } from './types';
import type {
  EnemyDef,
  EnemyShape,
  GameData,
  SpawnRule,
  TalentKind,
  TalentNode,
  WaveTable,
} from './types';

/**
 * True when A and B are the same type. The identity check catches readonly differences;
 * mutual assignability catches `prop?: T | undefined` vs `prop?: T`, which the identity
 * check ignores under exactOptionalPropertyTypes.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? [A] extends [B]
      ? [B] extends [A]
        ? true
        : false
      : false
    : false;

/** Identity that fails typecheck unless the schema's output type is exactly `T`. */
const exact =
  <T>() =>
  <S extends z.ZodType>(schema: S & (Equals<z.output<S>, T> extends true ? unknown : never)): S =>
    schema;

export const MODIFIER_KINDS = ['flat', 'increased', 'more'] as const satisfies ModifierKind[];
export const ENEMY_SHAPES = [
  'triangle',
  'square',
  'pentagon',
  'hexagon',
  'octagon',
] as const satisfies EnemyShape[];
export const TALENT_KINDS = [
  'start',
  'small',
  'notable',
  'keystone',
  'repeatable',
] as const satisfies TalentKind[];
export const TALENT_ARCHETYPES = [
  'none',
  'crit',
  'dot',
  'chain',
  'hybrid',
] as const satisfies TalentNode['archetype'][];

/** z.number() rejects NaN and ±Infinity in zod v4. */
const finite = z.number();

export const ModifierSchema = exact<Modifier>()(
  z
    .strictObject({
      stat: z.enum(STAT_IDS),
      kind: z.enum(MODIFIER_KINDS),
      value: finite,
      tags: z.array(z.enum(DAMAGE_TAGS)).readonly().exactOptional(),
    })
    .refine((m) => m.tags === undefined || (m.stat === 'damage' && m.kind !== 'flat'), {
      message: 'tags are only allowed on increased/more damage modifiers',
      path: ['tags'],
    })
    .refine((m) => m.tags === undefined || m.tags.length > 0, {
      message: 'tags must not be empty; omit the field instead',
      path: ['tags'],
    })
    .refine((m) => m.tags === undefined || new Set(m.tags).size === m.tags.length, {
      message: 'tags must be unique',
      path: ['tags'],
    })
    .readonly(),
);

export const RuleSpecSchema = exact<RuleSpec>()(
  z.discriminatedUnion('id', [
    z.strictObject({ id: z.literal('critsAlwaysIgnite'), nonCritHitMore: finite }).readonly(),
    z
      .strictObject({ id: z.literal('steadyAim'), everyNth: finite, critMultiplierMore: finite })
      .readonly(),
    z.strictObject({ id: z.literal('pandemic'), spreadRadius: finite, hitMore: finite }).readonly(),
    z.strictObject({ id: z.literal('eternalFlame'), durationMore: finite }).readonly(),
    z
      .strictObject({
        id: z.literal('overload'),
        chainCountMultiplier: finite,
        retentionPenalty: finite,
      })
      .readonly(),
    z.strictObject({ id: z.literal('glassCannon'), damageMore: finite }).readonly(),
  ]),
);

export const EnemyDefSchema = exact<EnemyDef>()(
  z
    .strictObject({
      id: z.enum(ENEMY_IDS),
      shape: z.enum(ENEMY_SHAPES),
      hpMult: finite,
      speed: finite,
      radius: finite,
      contactDamage: finite,
      dropMult: finite,
      cores: finite,
      splitInto: z
        .strictObject({ enemy: z.enum(ENEMY_IDS), count: finite })
        .readonly()
        .exactOptional(),
      color: finite,
    })
    .readonly(),
);

export const SpawnRuleSchema = exact<SpawnRule>()(
  z
    .strictObject({
      enemy: z.enum(ENEMY_IDS),
      fromWave: finite,
      base: finite,
      perWave: finite,
      maxCount: finite,
    })
    .readonly(),
);

export const WaveTableSchema = exact<WaveTable>()(
  z
    .strictObject({
      rules: z.array(SpawnRuleSchema).readonly(),
      eliteEvery: finite,
      bossEvery: finite,
      spawnDurationSec: finite,
      waveTimerSec: finite,
    })
    .readonly(),
);

export const TalentNodeSchema = exact<TalentNode>()(
  z
    .strictObject({
      id: z.string(),
      kind: z.enum(TALENT_KINDS),
      pos: z.strictObject({ x: finite, y: finite }).readonly(),
      links: z.array(z.string()).readonly(),
      shardCostFactor: finite.exactOptional(),
      coreCost: finite.exactOptional(),
      repeat: z.strictObject({ baseShards: finite, growth: finite }).readonly().exactOptional(),
      modifiers: z.array(ModifierSchema).readonly(),
      rules: z.array(RuleSpecSchema).readonly(),
      archetype: z.enum(TALENT_ARCHETYPES),
      nameKey: z.string(),
      descKey: z.string(),
    })
    .readonly(),
);

export const GameDataSchema = exact<GameData>()(
  z
    .strictObject({
      enemies: z.record(z.enum(ENEMY_IDS), EnemyDefSchema).readonly(),
      waves: WaveTableSchema,
      talents: z.array(TalentNodeSchema).readonly(),
    })
    .readonly(),
);
