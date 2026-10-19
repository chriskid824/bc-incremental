/**
 * zod schemas for the data files. Each schema's output type must equal the interface it
 * mirrors (checked at compile time by `exact`), so the interfaces stay the source of truth.
 * Schemas check shape, enums and finiteness; cross-references and value ranges are checked
 * by `validateGameData` (src/data/validate.ts). `.readonly()` also freezes parsed values.
 */

import { z } from 'zod';
import type { EmitterGrant, GrantKind } from './emitters';
import type { RuleSpec } from './rules';
import { isSourceSelector } from './sources';
import type { SourceSelector } from './sources';
import { isScopedStat, STAT_IDS } from './stats';
import type { Modifier, ModifierKind, StatId } from './stats';
import { DAMAGE_TAGS } from './tags';
import {
  APPLIED_AILMENTS,
  CONVERSION_TARGETS,
  DETONATE_AILMENTS,
  HELD_AILMENTS,
  HIT_KINDS,
  KILL_KINDS,
  SCALING_CURVES,
  SCALING_VARS,
  SELECTOR_ORIGINS,
  STACK_AILMENTS,
  TARGET_KINDS,
  TARGET_ORDERS,
  TARGET_PICKS,
  TRIGGER_EVENTS,
} from './triggers';
import type {
  Condition,
  ConversionSpec,
  EffectSpec,
  ScalingSpec,
  TargetCondition,
  TargetSelector,
  TriggerSpec,
} from './triggers';
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

/**
 * Scoped stats take tags, notTags, a scope, conditions and a scaling; flat damage stays untagged
 * in StatBlock.values.
 */
const taggable = (m: { readonly stat: StatId; readonly kind: ModifierKind }): boolean =>
  isScopedStat(m.stat) && !(m.stat === 'damage' && m.kind === 'flat');

export const SourceSelectorSchema = z.custom<SourceSelector>(
  (value) => typeof value === 'string' && isSourceSelector(value),
  { message: 'must be a source class or a source id (src/data/sources.ts)' },
);

export const ScalingSpecSchema = exact<ScalingSpec>()(
  z
    .strictObject({
      per: z.enum(SCALING_VARS),
      every: finite.exactOptional(),
      curve: z.enum(SCALING_CURVES).exactOptional(),
      exponent: finite.exactOptional(),
      cap: finite.exactOptional(),
    })
    .refine((s) => (s.curve === 'pow') === (s.exponent !== undefined), {
      message: "exponent is required with curve 'pow' and allowed only there",
      path: ['exponent'],
    })
    .readonly(),
);

export const TargetConditionSchema = exact<TargetCondition>()(
  z.union([
    z.strictObject({ targetHas: z.enum(HELD_AILMENTS) }).readonly(),
    z.strictObject({ targetKind: z.enum(TARGET_KINDS) }).readonly(),
    z.strictObject({ targetHpBelow: finite }).readonly(),
    z
      .strictObject({
        stacksAtLeast: z
          .strictObject({
            ailment: z.enum(STACK_AILMENTS),
            stacks: z.union([finite, z.literal('max')]),
          })
          .readonly(),
      })
      .readonly(),
    z.strictObject({ inZone: SourceSelectorSchema }).readonly(),
  ]),
);

export const ConditionSchema = exact<Condition>()(
  z.union([
    TargetConditionSchema,
    z.strictObject({ chance: finite }).readonly(),
    z.strictObject({ cooldownSec: finite }).readonly(),
    z.strictObject({ hitIs: z.enum(HIT_KINDS) }).readonly(),
    z.strictObject({ victimHas: z.enum(HELD_AILMENTS) }).readonly(),
    z.strictObject({ killedBy: z.enum(KILL_KINDS) }).readonly(),
    z.strictObject({ ailment: z.enum(APPLIED_AILMENTS) }).readonly(),
  ]),
);

export const ModifierSchema = exact<Modifier>()(
  z
    .strictObject({
      stat: z.enum(STAT_IDS),
      kind: z.enum(MODIFIER_KINDS),
      value: finite,
      tags: z.array(z.enum(DAMAGE_TAGS)).readonly().exactOptional(),
      notTags: z.array(z.enum(DAMAGE_TAGS)).readonly().exactOptional(),
      scope: SourceSelectorSchema.exactOptional(),
      when: z.array(TargetConditionSchema).readonly().exactOptional(),
      scaling: ScalingSpecSchema.exactOptional(),
    })
    .refine((m) => m.tags === undefined || taggable(m), {
      message: 'tags are only allowed on scoped stats, and not on flat damage',
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
    .refine((m) => m.notTags === undefined || taggable(m), {
      message: 'notTags are only allowed on scoped stats, and not on flat damage',
      path: ['notTags'],
    })
    .refine((m) => m.notTags === undefined || m.notTags.length > 0, {
      message: 'notTags must not be empty; omit the field instead',
      path: ['notTags'],
    })
    .refine((m) => m.notTags === undefined || new Set(m.notTags).size === m.notTags.length, {
      message: 'notTags must be unique',
      path: ['notTags'],
    })
    .refine((m) => !(m.notTags ?? []).some((tag) => m.tags?.includes(tag) === true), {
      message: 'notTags must not repeat a tag from tags',
      path: ['notTags'],
    })
    .refine((m) => m.scope === undefined || taggable(m), {
      message: 'scope is only allowed on scoped stats, and not on flat damage',
      path: ['scope'],
    })
    .refine((m) => m.when === undefined || taggable(m), {
      message: 'conditions are only allowed on scoped stats, and not on flat damage',
      path: ['when'],
    })
    .refine((m) => m.when === undefined || m.when.length > 0, {
      message: 'when must not be empty; omit the field instead',
      path: ['when'],
    })
    .refine((m) => m.scaling === undefined || taggable(m), {
      message: 'scaling is only allowed on scoped stats, and not on flat damage',
      path: ['scaling'],
    })
    .readonly(),
);

/** Which of the enemies within an effect's radius its maxTargets keeps (TARGET_ORDERS). */
const order = z.enum(TARGET_ORDERS).exactOptional();

/** Fields of an explode's, a nova's or projectiles' hits (src/data/triggers.ts DamagePart). */
const damagePart = {
  damagePct: finite,
  tags: z.array(z.enum(DAMAGE_TAGS)).readonly().exactOptional(),
  element: z.enum(['cold', 'lightning']).exactOptional(),
};

export const EffectSpecSchema = exact<EffectSpec>()(
  z.discriminatedUnion('kind', [
    z
      .strictObject({
        kind: z.literal('applyAilment'),
        ailment: z.enum(APPLIED_AILMENTS),
        stacks: finite.exactOptional(),
        damagePct: finite.exactOptional(),
        radius: finite.exactOptional(),
        maxTargets: finite.exactOptional(),
        order,
      })
      .readonly(),
    // A burn spread may move records, which M1's spread copies whole to every enemy in range:
    // only a poison spread takes a stack fraction, a target cap and a share for split children.
    z.discriminatedUnion('ailment', [
      z
        .strictObject({
          kind: z.literal('spreadAilment'),
          ailment: z.literal('burn'),
          radius: finite,
          effect: finite.exactOptional(),
        })
        .readonly(),
      z
        .strictObject({
          kind: z.literal('spreadAilment'),
          ailment: z.literal('poison'),
          radius: finite,
          effect: finite.exactOptional(),
          stacks: finite.exactOptional(),
          maxTargets: finite.exactOptional(),
          order,
          toSplitChildren: finite.exactOptional(),
        })
        .readonly(),
    ]),
    z
      .strictObject({
        kind: z.literal('explode'),
        radius: finite,
        maxTargets: finite.exactOptional(),
        order,
        ...damagePart,
      })
      .readonly(),
    z
      .strictObject({
        kind: z.literal('nova'),
        radius: finite,
        at: z.enum(['player', 'event']).exactOptional(),
        ...damagePart,
      })
      .readonly(),
    z.strictObject({ kind: z.literal('push'), distance: finite, radius: finite }).readonly(),
    z
      .strictObject({
        kind: z.literal('addFrost'),
        amount: finite,
        radius: finite.exactOptional(),
        maxTargets: finite.exactOptional(),
        order,
      })
      .readonly(),
    z.strictObject({ kind: z.literal('heal'), lifePct: finite }).readonly(),
    z.strictObject({ kind: z.literal('gainShards'), fraction: finite }).readonly(),
    z
      .strictObject({
        kind: z.literal('groundZone'),
        radius: finite,
        durationSec: finite,
        // Required, so that a zone without damage says so (0) rather than by omission.
        damagePctPerSec: z.number({
          error: (issue) =>
            issue.input === undefined
              ? 'damagePctPerSec is required; use 0 for a zone that only applies its status terms'
              : undefined,
        }),
        ailment: z.enum(APPLIED_AILMENTS).exactOptional(),
        ailmentStacks: finite.exactOptional(),
        ailmentDamagePct: finite.exactOptional(),
        addFrostPerSec: finite.exactOptional(),
        slow: finite.exactOptional(),
        tags: damagePart.tags,
        element: damagePart.element,
      })
      .readonly(),
    z
      .strictObject({
        kind: z.literal('repeatAttack'),
        count: finite,
        damagePct: finite,
        timing: z.enum(['now', 'nextAttack']).exactOptional(),
      })
      .readonly(),
    z
      .strictObject({
        kind: z.literal('detonate'),
        ailment: z.enum(DETONATE_AILMENTS),
        fraction: finite.exactOptional(),
        damage: finite.exactOptional(),
        radius: finite.exactOptional(),
        maxTargets: finite.exactOptional(),
        order,
      })
      .readonly(),
    z
      .strictObject({
        kind: z.literal('projectiles'),
        count: finite,
        aim: z.enum(['target', 'distinct', 'radial', 'fan']),
        from: z.enum(['event', 'player']).exactOptional(),
        pierce: finite.exactOptional(),
        bounce: finite.exactOptional(),
        spreadDeg: finite.exactOptional(),
        ...damagePart,
      })
      .readonly(),
  ]),
);

export const TargetSelectorSchema = exact<TargetSelector>()(
  z
    .strictObject({
      pick: z.enum(TARGET_PICKS),
      ailment: z.enum(STACK_AILMENTS).exactOptional(),
      from: z.enum(SELECTOR_ORIGINS).exactOptional(),
      range: finite.exactOptional(),
      excludeEventTarget: z.boolean().exactOptional(),
      excludeBoss: z.boolean().exactOptional(),
    })
    .readonly(),
);

export const TriggerSpecSchema = exact<TriggerSpec>()(
  z
    .strictObject({
      on: z.enum(TRIGGER_EVENTS),
      every: finite.exactOptional(),
      when: z.array(ConditionSchema).readonly().exactOptional(),
      target: TargetSelectorSchema.exactOptional(),
      do: z.array(EffectSpecSchema).readonly(),
    })
    .readonly(),
);

export const ConversionSpecSchema = exact<ConversionSpec>()(
  z
    .strictObject({
      tags: z.array(z.enum(DAMAGE_TAGS)).readonly().exactOptional(),
      to: z.enum(CONVERSION_TARGETS),
      fraction: finite,
    })
    .readonly(),
);

export const RuleSpecSchema = exact<RuleSpec>()(
  z.discriminatedUnion('id', [
    z
      .strictObject({
        id: z.literal('steadyAim'),
        everyNth: finite,
        critMultiplierMore: finite,
        counts: z.enum(['shot', 'attack']),
      })
      .readonly(),
    z.strictObject({ id: z.literal('eternalFlame'), durationMore: finite }).readonly(),
    z
      .strictObject({
        id: z.literal('overload'),
        chainCountMultiplier: finite,
        retentionPenalty: finite,
        chainMore: finite.exactOptional(),
      })
      .readonly(),
    z.strictObject({ id: z.literal('glassCannon'), damageMore: finite }).readonly(),
    z.strictObject({ id: z.literal('farThrow'), every: finite }).readonly(),
    z
      .strictObject({
        id: z.literal('volcano'),
        periodSec: finite,
        radiusMult: finite,
        damageMult: finite,
      })
      .readonly(),
    z
      .strictObject({
        id: z.literal('chainBlast'),
        radius: finite,
        damagePct: finite,
        perBomb: finite,
      })
      .readonly(),
  ]),
);

/**
 * The schema of each emitter grant kind (src/data/emitters.ts). Typed over the kinds, so a new
 * kind needs its entry here; EmitterGrantSchema joins them. They live here rather than in
 * emitters.ts, which the simulation imports, so that zod stays out of the simulation's modules.
 */
export const GRANT_SCHEMAS = {
  thorns: z
    .strictObject({ kind: z.literal('thorns'), damagePct: finite.exactOptional() })
    .readonly(),
} as const satisfies { readonly [K in GrantKind]: z.ZodType<Extract<EmitterGrant, { kind: K }>> };

export const EmitterGrantSchema = exact<EmitterGrant>()(
  z.discriminatedUnion('kind', [GRANT_SCHEMAS.thorns]),
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
      minCount: finite.exactOptional(),
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
      triggers: z.array(TriggerSpecSchema).readonly(),
      conversions: z.array(ConversionSpecSchema).readonly(),
      emitters: z.array(EmitterGrantSchema).readonly(),
      archetype: z.enum(TALENT_ARCHETYPES),
      nameKey: z.string(),
      descKey: z.string().exactOptional(),
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
