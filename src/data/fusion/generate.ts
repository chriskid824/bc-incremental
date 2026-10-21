/**
 * The fusion generator (docs/v3 C6 design §4.1, D11–D13a; implementation-plan-v3 §2.12): the
 * five-node board of a character with each outer but its own. A template pair's core is the
 * outer's payload placed on the character's center event, with the payload's bonus; a hand pair's
 * (a character with another archetype's outer) is the rule its override gives. The overrides
 * (src/data/fusion/overrides.ts) apply on top in §4.1's order. The generator reads no payload
 * kind of its own (D11), so a new payload needs no change here.
 *
 * Like the builders, it never throws: a hand pair without its override gets an empty core and
 * HAND_RANKS (V11 reports it), and a template pair whose outer has no payload an empty core and
 * EMPTY_RANKS (V12), so the viewer can draw a half-written fusion.
 */

import { digest } from '../../core/digest';
import { CHARACTER_IDS } from '../sources';
import type { Modifier } from '../stats';
import { defaultMasteryTarget, fusionRank, inc, mastery, rankedMods } from '../templates';
import type { CenterEvent, EffectSpec } from '../triggers';
import { FUSION_SLOTS, nodeId } from '../web/ids';
import type {
  BoardDef,
  BonusSpec,
  CharacterDef,
  FusionDef,
  FusionKey,
  FusionOverride,
  FusionRanks,
  FusionTemplate,
  NodeEffects,
  NodeSpec,
  OuterDef,
  OuterPayload,
  PayloadEffect,
  WebNode,
} from '../web/types';

/** A fusion's board id, which is also the source of every node on it (sourceOfNode, V2). */
type FusionSource = `fusion.${FusionKey}`;

/** The 12 hand pairs: each character with each other archetype's outer (impl:343). */
export const HAND_PAIRS: ReadonlySet<FusionKey> = new Set(
  CHARACTER_IDS.flatMap((c) =>
    CHARACTER_IDS.filter((o) => o !== c).map((o): FusionKey => `${c}.${o}`),
  ),
);

/** A hand pair's r1–r3 unless its override gives its own (D13a): +10 % damage, 3 ranks each. */
export const HAND_RANKS: FusionRanks = [
  fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3),
  fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3),
  fusionRank([inc('damage', 0.1, { scope: 'fusion' })], 3),
];

/** r1–r3 of a template pair whose outer has no payload, while V12 reports it: no modifiers. */
export const EMPTY_RANKS: FusionRanks = [fusionRank([], 3), fusionRank([], 3), fusionRank([], 3)];

/** Where a slash runs on each center event (F11): droneImpact outward until drones fly a way. */
const SLASH_PLACEMENT: Readonly<
  Record<
    CenterEvent,
    { readonly from: 'event' | 'target'; readonly toward: 'nearest' | 'outward' | 'along' }
  >
> = {
  explode: { from: 'event', toward: 'nearest' },
  freeze: { from: 'target', toward: 'outward' },
  chainJump: { from: 'target', toward: 'along' },
  droneImpact: { from: 'target', toward: 'outward' },
};

/**
 * A payload effect written for one enemy (impl:313), fitted to `event` (gd §5.3, AMB24): a slash
 * starts and runs by SLASH_PLACEMENT, projectiles start at the event and a nova centers on it.
 * Everything else acts at the event's point or enemy as written; a status effect keeps no radius,
 * so on explode and freeze the engine fans it out over the event's list (CompiledEffect.fanout).
 */
export function place(effect: PayloadEffect, event: CenterEvent): EffectSpec {
  switch (effect.kind) {
    case 'slashLine':
      return { ...effect, ...SLASH_PLACEMENT[event] };
    case 'projectiles':
      return { ...effect, from: 'event' };
    case 'nova':
      return { ...effect, at: 'event' };
    default:
      return effect;
  }
}

/**
 * A template core before its override's triggers (impl:316-322 without coef): `payload` placed
 * for `event`, or its perEvent entry, and the payload's bonus, which the override replaces or,
 * with null, drops.
 */
export function templateOf(
  event: CenterEvent,
  payload: OuterPayload,
  override?: FusionOverride,
): FusionTemplate {
  return {
    on: event,
    do: payload.perEvent?.[event] ?? payload.effects.map((effect) => place(effect, event)),
    bonus: override?.bonus === undefined ? payload.bonus : override.bonus,
  };
}

/**
 * The core's modifiers for a bonus (D13): damage increased, scope 'center', when the target holds
 * the ailment (status) or stands in the fusion's own zones (inZone); a scaled damage modifier,
 * scope 'center' (scaling); none for inPayload and null. Each value × k, which is 1 except under
 * coefScalesBonus (Q2 (A)).
 */
export function bonusModifiers(
  bonus: BonusSpec | null,
  source: FusionSource,
  k: number,
): Modifier[] {
  if (bonus === null) return [];
  switch (bonus.form) {
    case 'status':
      return [
        {
          stat: 'damage',
          kind: 'increased',
          value: bonus.value * k,
          scope: 'center',
          when: [{ targetHas: bonus.ailment }],
        },
      ];
    case 'inZone':
      return [
        {
          stat: 'damage',
          kind: 'increased',
          value: bonus.value * k,
          scope: 'center',
          when: [{ inZone: source }],
        },
      ];
    case 'scaling':
      return [
        {
          stat: 'damage',
          kind: bonus.kind,
          value: bonus.value * k,
          scope: 'center',
          scaling: bonus.scaling,
        },
      ];
    case 'inPayload':
      return [];
  }
}

/**
 * `ranks` as the board's r1–r3: a modifier written with scope 'fusion' narrowed to `source`, so
 * one outer file serves its 3–4 fusions; r3's values × k (Q2 (A)).
 */
function narrowRanks(ranks: FusionRanks, source: FusionSource, k: number): FusionRanks {
  const narrowed = (mod: Modifier): Modifier =>
    mod.scope === 'fusion' ? { ...mod, scope: source } : mod;
  const [r1, r2, r3] = ranks;
  return [
    { ...r1, modifiers: r1.modifiers.map(narrowed) },
    { ...r2, modifiers: r2.modifiers.map(narrowed) },
    { ...r3, modifiers: r3.modifiers.map((mod) => ({ ...narrowed(mod), value: mod.value * k })) },
  ];
}

/**
 * The board `source`: the core (1 rank), r1–r3 and the mastery (more 0.04 damage a rank on the
 * fusion's own damage, unlimited; H9), in slots { at: 'fusion', step: 0–4 }, edges
 * core–r1–r2–r3–mastery.
 */
function fusionBoard(source: FusionSource, core: NodeEffects, ranks: FusionRanks): BoardDef {
  const node = (step: 0 | 1 | 2 | 3 | 4, spec: NodeSpec): WebNode => ({
    id: nodeId(source, FUSION_SLOTS[step]),
    kind: spec.kind,
    board: source,
    slot: { at: 'fusion', step },
    ranks: spec.ranks,
    effects: spec.effects,
    answers: spec.answers,
  });
  const [r1, r2, r3] = ranks;
  const nodes = [
    node(0, { kind: 'core', slug: null, ranks: 1, effects: core, answers: [] }),
    node(1, rankedMods(r1.modifiers, r1.ranks)),
    node(2, rankedMods(r2.modifiers, r2.ranks)),
    node(3, rankedMods(r3.modifiers, r3.ranks)),
    node(4, mastery(defaultMasteryTarget(source))),
  ] as const;
  return {
    id: source,
    nodes,
    edges: [
      [nodes[0].id, nodes[1].id],
      [nodes[1].id, nodes[2].id],
      [nodes[2].id, nodes[3].id],
      [nodes[3].id, nodes[4].id],
    ],
    branches: [],
  };
}

/** What a fusion's calibration depends on (F28): the coef, which the tool writes, never enters. */
export interface FusionDigestParts {
  readonly event: CenterEvent;
  readonly template: FusionTemplate | null;
  readonly override: FusionOverride | undefined;
  /** As written: before narrowing and before coefScalesBonus scales r3. */
  readonly ranks: FusionRanks;
  /** The payload's coefScalesBonus. */
  readonly scalesBonus: boolean;
}

/**
 * The digest of a fusion's own inputs (src/core/digest.ts; F28): what moves strength from outside
 * them (the center, the outer's other nodes, the engine) leaves it alone, for C10's nightly check.
 */
export function fusionDigest(parts: FusionDigestParts): string {
  return digest(parts);
}

/**
 * The fusion of `def` and `outer` at `coef` (§4.1). The core holds the bonus's modifiers then the
 * override's; the template trigger, or the override's triggers in its place, then its
 * addTriggers; on a hand pair the override's rule, elsewhere its addRules. r1–r3 are the
 * override's ranks, else HAND_RANKS on a hand pair, else the payload's (EMPTY_RANKS without one).
 * The coef scales nothing here but, under the payload's coefScalesBonus on a template pair, the
 * bonus and r3 (Q2 (A)); the compile scales the triggers and rules (D10).
 */
export function generate(
  def: CharacterDef,
  outer: OuterDef,
  override: FusionOverride | undefined,
  coef: number,
): FusionDef {
  const key: FusionKey = `${def.id}.${outer.id}`;
  const source: FusionSource = `fusion.${key}`;
  const hand = HAND_PAIRS.has(key);
  const payload = outer.payload;
  const template = hand || payload === null ? null : templateOf(def.centerEvent, payload, override);
  const coefScalesBonus = !hand && payload?.coefScalesBonus === true;
  const k = coefScalesBonus ? coef : 1; // Q2 (A); 1 everywhere else (D10)
  const core: NodeEffects = {
    modifiers: [
      ...bonusModifiers(template?.bonus ?? null, source, k),
      ...(override?.modifiers ?? []),
    ],
    triggers: [
      ...(template === null ? [] : (override?.triggers ?? [{ on: template.on, do: template.do }])),
      ...(override?.addTriggers ?? []),
    ],
    conversions: [],
    emitters: [],
    rules: hand
      ? override?.rule === undefined
        ? []
        : [override.rule]
      : (override?.addRules ?? []),
  };
  const ranks = override?.ranks ?? (hand ? HAND_RANKS : (payload?.ranks ?? EMPTY_RANKS));
  return {
    key,
    kind: hand ? 'hand' : override === undefined ? 'template' : 'templateOverride',
    board: fusionBoard(source, core, narrowRanks(ranks, source, k)),
    template,
    coef,
    coefScalesBonus,
    skin: { ...outer.skin, ...override?.skin },
    digest: fusionDigest({
      event: def.centerEvent,
      template,
      override,
      ranks,
      scalesBonus: payload?.coefScalesBonus === true,
    }),
  };
}
