/**
 * Strict zod schemas of the v3 web's content (docs/v3 C6 design §3.1–§3.6): what the content
 * files write (characters with their centers and ascendancies, outers with their payloads, the
 * hub, fusion overrides), the calibration entries the tool writes, and the scopes. Each is
 * composed from the M1 data schemas (src/data/schema.ts), so a node's effects are checked as an
 * M1 talent's are, and each one's output type must equal its interface (`exact`). Like those,
 * they check shape, enums and finiteness: ids are checked against the grammar
 * (src/data/web/ids.ts) by web validation. Generated and computed values (FusionDef, the
 * assembled web, the layout) have no schema.
 */

import { z } from 'zod';
import type { SignatureSpec } from '../rules';
import {
  ConversionSpecSchema,
  EffectSpecSchema,
  EmitterGrantSchema,
  exact,
  ModifierSchema,
  RuleSpecSchema,
  ScalingSpecSchema,
  TriggerSpecSchema,
} from '../schema';
import { CHARACTER_IDS, OUTER_IDS } from '../sources';
import { CENTER_EVENTS, HELD_AILMENTS } from '../triggers';
import {
  CALIBRATION_STATUSES,
  CENTER_STEPS,
  CONSTRUCT_IDS,
  OUTER_STEPS,
  ROW_ENEMIES,
  SHAPE_IDS,
  WEB_NODE_KINDS,
} from './types';
import type {
  AscendancyDef,
  BoardDef,
  BoardId,
  BonusSpec,
  CalibrationEntry,
  CharacterDef,
  Covers,
  EnemyRow,
  FusionKey,
  FusionOverride,
  FusionRanks,
  HubDef,
  NodeEffects,
  NodeSlot,
  OuterDef,
  OuterPayload,
  PayloadEffect,
  PayloadType,
  RankSpec,
  Ranks,
  Skin,
  WebNode,
  WebScope,
} from './types';

/** z.number() rejects NaN and ±Infinity in zod v4. */
const finite = z.number();

const CharacterIdSchema = z.enum(CHARACTER_IDS);
const OuterIdSchema = z.enum(OUTER_IDS);
const RowEnemySchema = z.enum(ROW_ENEMIES);
const PAYLOAD_TYPES = ['status', 'placement', 'self'] as const satisfies PayloadType[];

export const FusionKeySchema = exact<FusionKey>()(
  z.templateLiteral([CharacterIdSchema, '.', OuterIdSchema]),
);

export const BoardIdSchema = exact<BoardId>()(
  z.union([
    z.templateLiteral([CharacterIdSchema, '.center']),
    z.literal('hub'),
    z.templateLiteral(['outer.', OuterIdSchema]),
    z.templateLiteral(['fusion.', CharacterIdSchema, '.', OuterIdSchema]),
    z.templateLiteral([CharacterIdSchema, '.asc.', z.string()]),
  ]),
);

// Nodes and boards (§3.1).

export const NodeEffectsSchema = exact<NodeEffects>()(
  z
    .strictObject({
      modifiers: z.array(ModifierSchema).readonly(),
      triggers: z.array(TriggerSpecSchema).readonly(),
      conversions: z.array(ConversionSpecSchema).readonly(),
      emitters: z.array(EmitterGrantSchema).readonly(),
      rules: z.array(RuleSpecSchema).readonly(),
    })
    .readonly(),
);

const RanksSchema = exact<Ranks>()(z.literal([1, 3, 4, 5, 'unlimited']));

export const NodeSlotSchema = exact<NodeSlot>()(
  z.discriminatedUnion('at', [
    z.strictObject({ at: z.literal('signature') }).readonly(),
    z
      .strictObject({
        at: z.literal('centerBranch'),
        branch: z.literal([0, 1, 2]),
        step: z.enum(CENTER_STEPS),
      })
      .readonly(),
    z.strictObject({ at: z.literal('centerEdge'), clock: finite }).readonly(),
    z.strictObject({ at: z.literal('hubRing'), clock: finite }).readonly(),
    z.strictObject({ at: z.literal('hubSpur'), clock: finite }).readonly(),
    z.strictObject({ at: z.literal('outerEntry') }).readonly(),
    z
      .strictObject({
        at: z.literal('outerBranch'),
        side: z.literal([1, -1]),
        step: z.enum(OUTER_STEPS),
      })
      .readonly(),
    z
      .strictObject({
        at: z.literal('outerEdge'),
        place: z.enum(['answer', 'keystone', 'threshold']),
      })
      .readonly(),
    z.strictObject({ at: z.literal('fusion'), step: z.literal([0, 1, 2, 3, 4]) }).readonly(),
    z
      .strictObject({ at: z.literal('asc'), chain: z.literal([0, 1]), step: z.literal([0, 1, 2]) })
      .readonly(),
  ]),
);

export const WebNodeSchema = exact<WebNode>()(
  z
    .strictObject({
      id: z.string(),
      kind: z.enum(WEB_NODE_KINDS),
      board: BoardIdSchema,
      slot: NodeSlotSchema,
      ranks: RanksSchema,
      effects: NodeEffectsSchema,
      answers: z.array(RowEnemySchema).readonly(),
    })
    .readonly(),
);

export const BoardDefSchema = exact<BoardDef>()(
  z
    .strictObject({
      id: BoardIdSchema,
      nodes: z.array(WebNodeSchema).readonly(),
      edges: z.array(z.tuple([z.string(), z.string()]).readonly()).readonly(),
      branches: z.array(z.string()).readonly(),
    })
    .readonly(),
);

export const HubDefSchema = exact<HubDef>()(z.strictObject({ board: BoardDefSchema }).readonly());

// Characters (§3.2).

const EnemyRowSchema = exact<EnemyRow>()(
  z.record(RowEnemySchema, z.enum(['strong', 'even', 'weak'])).readonly(),
);

const CoversSchema = exact<Covers>()(
  z.partialRecord(RowEnemySchema, z.enum(['answer', 'helps'])).readonly(),
);

/** SignatureSpec (src/data/rules.ts): one member per signature, which takes no parameters yet. */
const SignatureSpecSchema = exact<SignatureSpec>()(
  z.discriminatedUnion('id', [
    z.strictObject({ id: z.literal('m1Volley') }).readonly(),
    z.strictObject({ id: z.literal('magmaBomb') }).readonly(),
    z.strictObject({ id: z.literal('iceFan') }).readonly(),
    z.strictObject({ id: z.literal('triphaseArc') }).readonly(),
    z.strictObject({ id: z.literal('swarm') }).readonly(),
  ]),
);

export const AscendancyDefSchema = exact<AscendancyDef>()(
  z.strictObject({ slug: z.string(), board: BoardDefSchema }).readonly(),
);

const OuterTripleSchema = z.tuple([OuterIdSchema, OuterIdSchema, OuterIdSchema]).readonly();

export const CharacterDefSchema = exact<CharacterDef>()(
  z
    .strictObject({
      id: CharacterIdSchema,
      archetype: CharacterIdSchema,
      nameKey: z.templateLiteral(['web.char.', CharacterIdSchema, '.name']),
      introKey: z.templateLiteral(['web.char.', CharacterIdSchema, '.intro']),
      color: finite,
      signature: SignatureSpecSchema,
      centerEvent: z.enum(CENTER_EVENTS),
      center: BoardDefSchema.nullable(),
      ascendancies: z.tuple([AscendancyDefSchema, AscendancyDefSchema]).readonly().nullable(),
      recommendedOuter: OuterTripleSchema,
      revealAt15: OuterTripleSchema,
      enemyRow: EnemyRowSchema,
      difficulty: z.literal([1, 2]),
      construct: z.enum(CONSTRUCT_IDS),
      arena: CharacterIdSchema,
      defaultOrder: z.array(z.string()).readonly(),
    })
    .readonly(),
);

// Outers, payloads and bonuses (§3.4).

export const SkinSchema = exact<Skin>()(
  z.strictObject({ accent: finite, shape: z.enum(SHAPE_IDS) }).readonly(),
);

const [
  applyAilment,
  spreadAilment,
  explode,
  nova,
  push,
  addFrost,
  heal,
  gainShards,
  groundZone,
  repeatAttack,
  detonate,
  projectiles,
  slashLine,
  coinHit,
  chainBolt,
] = EffectSpecSchema.options;

/**
 * An effect as a payload writes it, for one enemy target: EffectSpecSchema's members, with the
 * fields a center event decides (§4.1 place()) left out of slashLine (from, toward), projectiles
 * (from) and nova (at), so that their strict objects reject them as unknown keys (merge row 20).
 */
export const PayloadEffectSchema = exact<PayloadEffect>()(
  z.discriminatedUnion('kind', [
    applyAilment,
    spreadAilment,
    explode,
    nova.unwrap().omit({ at: true }).readonly(),
    push,
    addFrost,
    heal,
    gainShards,
    groundZone,
    repeatAttack,
    detonate,
    projectiles.unwrap().omit({ from: true }).readonly(),
    slashLine.unwrap().omit({ from: true, toward: true }).readonly(),
    coinHit,
    chainBolt,
  ]),
);

export const BonusSpecSchema = exact<BonusSpec>()(
  z.discriminatedUnion('form', [
    z
      .strictObject({ form: z.literal('status'), ailment: z.enum(HELD_AILMENTS), value: finite })
      .readonly(),
    z.strictObject({ form: z.literal('inZone'), value: finite }).readonly(),
    z
      .strictObject({
        form: z.literal('scaling'),
        kind: z.enum(['increased', 'more']),
        value: finite,
        scaling: ScalingSpecSchema,
      })
      .readonly(),
    z.strictObject({ form: z.literal('inPayload') }).readonly(),
  ]),
);

export const RankSpecSchema = exact<RankSpec>()(
  z
    .strictObject({ modifiers: z.array(ModifierSchema).readonly(), ranks: z.literal([3, 4, 5]) })
    .readonly(),
);

export const FusionRanksSchema = exact<FusionRanks>()(
  z.tuple([RankSpecSchema, RankSpecSchema, RankSpecSchema]).readonly(),
);

export const OuterPayloadSchema = exact<OuterPayload>()(
  z
    .strictObject({
      type: z.enum(PAYLOAD_TYPES),
      effects: z.array(PayloadEffectSchema).readonly(),
      perEvent: z
        .partialRecord(z.enum(CENTER_EVENTS), z.array(EffectSpecSchema).readonly())
        .readonly()
        .exactOptional(),
      bonus: BonusSpecSchema.nullable(),
      ranks: FusionRanksSchema,
      coefScalesBonus: z.literal(true).exactOptional(),
    })
    .readonly(),
);

export const OuterDefSchema = exact<OuterDef>()(
  z
    .strictObject({
      id: OuterIdSchema,
      board: BoardDefSchema,
      payload: OuterPayloadSchema.nullable(),
      skin: SkinSchema,
      covers: CoversSchema,
    })
    .readonly(),
);

// Fusions (§3.5).

export const FusionOverrideSchema = exact<FusionOverride>()(
  z
    .strictObject({
      rule: RuleSpecSchema.exactOptional(),
      triggers: z.array(TriggerSpecSchema).readonly().exactOptional(),
      addTriggers: z.array(TriggerSpecSchema).readonly().exactOptional(),
      addRules: z.array(RuleSpecSchema).readonly().exactOptional(),
      modifiers: z.array(ModifierSchema).readonly().exactOptional(),
      bonus: BonusSpecSchema.nullable().exactOptional(),
      ranks: FusionRanksSchema.exactOptional(),
      skin: z
        .strictObject({ accent: finite.exactOptional(), shape: z.enum(SHAPE_IDS).exactOptional() })
        .readonly()
        .exactOptional(),
    })
    .readonly(),
);

export const CalibrationEntrySchema = exact<CalibrationEntry>()(
  z
    .strictObject({
      coef: finite,
      status: z.enum(CALIBRATION_STATUSES),
      median: finite,
      min: finite,
      max: finite,
      seeds: finite,
      startWave: finite,
      digest: z.string(),
    })
    .readonly(),
);

// Scopes (§3.6).

export const WebScopeSchema = exact<WebScope>()(
  z
    .strictObject({
      name: z.string(),
      characters: z.union([z.array(CharacterIdSchema).readonly(), z.literal('all')]),
      outers: z.union([z.array(OuterIdSchema).readonly(), z.literal('all')]),
      deferredFusions: z.array(FusionKeySchema).readonly(),
      waveCap: finite.nullable(),
    })
    .readonly(),
);
