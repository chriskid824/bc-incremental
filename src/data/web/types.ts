/**
 * The v3 talent web's content types (docs/v3 C6 design §3.1–§3.6; implementation-plan-v3
 * §2.12–§2.14, §3): nodes and boards, characters, outers with their fusion payloads, fusions, the
 * content a web is assembled from, scopes and the layout. Their zod schemas are in
 * src/data/web/schema.ts, the id grammar in src/data/web/ids.ts. The M1 talent web
 * (src/data/types.ts TalentNode, loadGameData().talents) is separate content: src/data/index.ts
 * does not re-export this folder, and no M1 consumer imports it (src/data/web/isolation.test.ts).
 */

import type { EmitterGrant } from '../emitters';
import type { SignatureSpec, RuleSpec } from '../rules';
import type { CharacterId, OuterId } from '../sources';
import type { Modifier } from '../stats';
import type { EnemyId } from '../types';
import type {
  CenterEvent,
  ConversionSpec,
  EffectSpec,
  HeldAilment,
  ScalingSpec,
  TriggerSpec,
} from '../triggers';

// Nodes and boards (§3.1).

export const WEB_NODE_KINDS = [
  'signature', // the root, owned for free (D5)
  'ranked', // 3–5 ranks: branch nodes, connectors, hub ranked, fusion r1–r3
  'notable', // ◆: 1 rank, shards + 1 core
  'threshold', // 1 rank, shards + 2 cores, behind its board's gate
  'keystone', // ★: 1 rank, 3 cores, counts toward the held cap (D6)
  'mastery', // ∞: unlimited ranks on the mastery curve
  'might', // 強化∞: unlimited ranks on its own curve
  'entry', // an outer's entry: 1 rank
  'core', // a fusion core: 1 rank, shards + 1 core, takes a fusion slot
  'asc', // an ascendancy ◆: 1 rank, 1 迴響
  'ascFinal', // an ascendancy final: 1 rank, 1 迴響
] as const;
export type WebNodeKind = (typeof WEB_NODE_KINDS)[number];
/** Kinds whose name is hand-written, `web.node.<id>.name` (V17); the others are named by text.ts. */
export const NAMED_KINDS: readonly WebNodeKind[] = [
  'signature',
  'notable',
  'threshold',
  'keystone',
  'entry',
  'asc',
  'ascFinal',
];

/** What a node gives: modifiers, triggers and conversions per rank; emitters and rules once (TalentNode's five arrays). */
export interface NodeEffects {
  readonly modifiers: readonly Modifier[];
  readonly triggers: readonly TriggerSpec[];
  readonly conversions: readonly ConversionSpec[];
  readonly emitters: readonly EmitterGrant[];
  readonly rules: readonly RuleSpec[];
}

/** gd §6.4's columns in order: 三角 方塊 五角 盾兵 再生 衝刺 射手 召喚者 寶藏 Boss (F30). */
export const ROW_ENEMIES = [
  'triangle',
  'square',
  'pentagon',
  'shielder',
  'regenerator',
  'dasher',
  'shooter',
  'summoner',
  'treasure',
  'boss',
] as const;
export type RowEnemy = (typeof ROW_ENEMIES)[number];

/**
 * The column each enemy type counts in (docs/v3 C7 design §1.7): its own; a shard its
 * pentagon's; every boss-flagged type, the onion and the bosses after it, the Boss column. The
 * elite has none.
 */
const ROW_OF: Readonly<Record<EnemyId, RowEnemy | null>> = {
  triangle: 'triangle',
  square: 'square',
  pentagon: 'pentagon',
  shard: 'pentagon',
  hexagon: null,
  boss: 'boss',
  shielder: 'shielder',
  regenerator: 'regenerator',
  dasher: 'dasher',
  shooter: 'shooter',
  summoner: 'summoner',
  treasure: 'treasure',
  onion: 'boss',
};

/** The gd §6.4 column enemy type `id` counts in, null for the elite (ROW_OF). */
export const rowEnemyOf = (id: EnemyId): RowEnemy | null => ROW_OF[id];

export type RankCount = 3 | 4 | 5;
export type Ranks = 1 | RankCount | 'unlimited';

/** A template's output: one slot's node before its builder names it (D3). */
export interface NodeSpec<K extends WebNodeKind = WebNodeKind> {
  readonly kind: K;
  /** The slug of a slug-named node (◆, ★; D4); null for a slot-named one. */
  readonly slug: string | null;
  readonly ranks: Ranks;
  readonly effects: NodeEffects;
  /** Enemies the node answers (「答案：盾兵」; V18). */
  readonly answers: readonly RowEnemy[];
}

export const CENTER_STEPS = ['r1', 'r2', 'a', 'r3', 'r4', 'b', 'r5', 'r6', 'c', 'mastery'] as const;
export type CenterStep = (typeof CENTER_STEPS)[number];
export const OUTER_STEPS = ['r1', 'r2', 'a', 'r3', 'r4', 'b', 'mastery'] as const;
export type OuterStep = (typeof OUTER_STEPS)[number];

/** Where a node sits; the layout reads only this and its board's clock (D17). */
export type NodeSlot =
  | { readonly at: 'signature' }
  | { readonly at: 'centerBranch'; readonly branch: 0 | 1 | 2; readonly step: CenterStep }
  /** Connectors at clocks 1, 3, 5, 7, 9, 11; ★ at 2 and 10; the threshold at 6. */
  | { readonly at: 'centerEdge'; readonly clock: number }
  | { readonly at: 'hubRing'; readonly clock: number }
  | { readonly at: 'hubSpur'; readonly clock: number }
  | { readonly at: 'outerEntry' }
  /** side 1: the clockwise branch (the file's first); −1 the other. */
  | { readonly at: 'outerBranch'; readonly side: 1 | -1; readonly step: OuterStep }
  | { readonly at: 'outerEdge'; readonly place: 'answer' | 'keystone' | 'threshold' }
  /** 0 core, 1–3 r1–r3, 4 mastery. */
  | { readonly at: 'fusion'; readonly step: 0 | 1 | 2 | 3 | 4 }
  /** chain 0 the first ascendancy; step 0 n1, 1 n2, 2 final. */
  | { readonly at: 'asc'; readonly chain: 0 | 1; readonly step: 0 | 1 | 2 };

export type BoardId =
  | `${CharacterId}.center`
  | 'hub'
  | `outer.${OuterId}`
  | `fusion.${CharacterId}.${OuterId}`
  | `${CharacterId}.asc.${string}`;

export interface WebNode {
  readonly id: string;
  readonly kind: WebNodeKind;
  readonly board: BoardId;
  readonly slot: NodeSlot;
  readonly ranks: Ranks;
  readonly effects: NodeEffects;
  readonly answers: readonly RowEnemy[];
}

export interface BoardDef {
  readonly id: BoardId;
  readonly nodes: readonly WebNode[];
  /** Undirected edges, each once, in builder order: the board's fixed shape (§4.4). */
  readonly edges: readonly (readonly [string, string])[];
  /** Branch slugs in slot order: 3 on a center, 2 on an outer, the hub's groups; else none. */
  readonly branches: readonly string[];
}

/** The hub's 24 nodes, placed by defineHub's fixed table (D15). */
export interface HubDef {
  readonly board: BoardDef;
}

// Characters (§3.2).

export type Mark = 'strong' | 'even' | 'weak'; // ✓ △ ✗
export type EnemyRow = Readonly<Record<RowEnemy, Mark>>;
export type Cover = 'answer' | 'helps'; // gd §6.5's ◆ and ＋; '·' is absent
export type Covers = Readonly<Partial<Record<RowEnemy, Cover>>>;

/**
 * In character order: 熔核, 霜晶, 雷塔, 蜂巢. src/render/constructs/index.ts, which draws them,
 * re-exports them (merge row 41).
 */
export const CONSTRUCT_IDS = ['magmaCore', 'frostCrystal', 'teslaTower', 'hive'] as const;
export type ConstructId = (typeof CONSTRUCT_IDS)[number];

export interface AscendancyDef {
  readonly slug: string;
  /** Id `<c>.asc.<slug>`: n1, n2 (kind asc) and final (ascFinal). */
  readonly board: BoardDef;
}

export interface CharacterDef {
  /** The save key, the `fusion.<c>` prefix and the own clock (the OUTER_IDS index). */
  readonly id: CharacterId;
  /** = id (impl:356); derived. */
  readonly archetype: CharacterId;
  /** `web.char.<id>.name`, `web.char.<id>.intro` (the select card's one-liner, AMB7); derived. */
  readonly nameKey: `web.char.${CharacterId}.name`;
  readonly introKey: `web.char.${CharacterId}.intro`;
  /** Main colour 0xRRGGBB = CONSTRUCT_COLORS[construct].main (src/render/palette.ts). */
  readonly color: number;
  /** { id: CHARACTER_SIGNATURE[id] }; derived. */
  readonly signature: SignatureSpec;
  /** SIGNATURE_EVENT[signature.id]: the event of every template core; derived. */
  readonly centerEvent: CenterEvent;
  /** Id `<c>.center`, 40 nodes; null is 「製作中」 until the character's batch (D14). */
  readonly center: BoardDef | null;
  /** null until the batch that writes them (AMB6). */
  readonly ascendancies: readonly [AscendancyDef, AscendancyDef] | null;
  readonly recommendedOuter: readonly [OuterId, OuterId, OuterId];
  /** Added at best wave 15 (gd:305; AMB3). */
  readonly revealAt15: readonly [OuterId, OuterId, OuterId];
  readonly enemyRow: EnemyRow;
  readonly difficulty: 1 | 2;
  readonly construct: ConstructId;
  /** = id: the key of B1's arena registry (impl:366); derived. */
  readonly arena: CharacterId;
  /** 預設 build: node ids in a default player's purchase order, ranks by repetition (V25; AMB4). */
  readonly defaultOrder: readonly string[];
}

// Outers, payloads and bonuses (§3.4).

/** gd §4's shape languages, one per outer in clock order. */
export const SHAPE_IDS = [
  'flame',
  'bubble',
  'trail',
  'arc',
  'afterimage',
  'slash',
  'crystal',
  'ring',
  'spike',
  'drone',
  'bullet',
  'coin',
] as const;
export type ShapeId = (typeof SHAPE_IDS)[number];
export interface Skin {
  readonly accent: number;
  readonly shape: ShapeId;
}

/** 上狀態, 落點, 給自己 (gd:560-573). */
export type PayloadType = 'status' | 'placement' | 'self';

/** The fields a center event decides (§4.1 place()): an author never writes them (merge row 20). */
type Placed = 'slashLine' | 'projectiles' | 'nova';
export type PayloadEffect =
  | Exclude<EffectSpec, { readonly kind: Placed }>
  | Omit<Extract<EffectSpec, { readonly kind: 'slashLine' }>, 'from' | 'toward'>
  | Omit<Extract<EffectSpec, { readonly kind: 'projectiles' }>, 'from'>
  | Omit<Extract<EffectSpec, { readonly kind: 'nova' }>, 'at'>;

/** The bonus a template fusion adds beside its payload (impl:320; D13). */
export type BonusSpec =
  /** damage increased +value, scope 'center', when the target holds `ailment`. */
  | { readonly form: 'status'; readonly ailment: HeldAilment; readonly value: number }
  /** The same when the target stands in the fusion's own zones. */
  | { readonly form: 'inZone'; readonly value: number }
  /** A scaled damage modifier, scope 'center' (combo, summon, greed once their variables exist). */
  | {
      readonly form: 'scaling';
      readonly kind: 'increased' | 'more';
      readonly value: number;
      readonly scaling: ScalingSpec;
    }
  /** None added: the payload carries it (crit's critScale, thorns' tag, barrage's count). */
  | { readonly form: 'inPayload' };

export interface RankSpec {
  /** Per rank; `scope: 'fusion'` is narrowed to `fusion.<c>.<o>` by generate. */
  readonly modifiers: readonly Modifier[];
  readonly ranks: RankCount;
}
/** r1 payload strength, r2 cap or chance, r3 the bonus (gd:577). */
export type FusionRanks = readonly [RankSpec, RankSpec, RankSpec];

export interface OuterPayload {
  readonly type: PayloadType;
  /** Written for one enemy target; place() fits it to each center event (§4.1). */
  readonly effects: readonly PayloadEffect[];
  /** Replaces the placed list for an event whose shape differs (AMB24). */
  readonly perEvent?: Readonly<Partial<Record<CenterEvent, readonly EffectSpec[]>>>;
  /** null: no bonus yet (vocabulary missing; D11, D13). */
  readonly bonus: BonusSpec | null;
  readonly ranks: FusionRanks;
  /** Q2 (A): coef also multiplies the bonus and r3; only with no COEF field above 0 (V12). */
  readonly coefScalesBonus?: true;
}

export interface OuterDef {
  readonly id: OuterId;
  /** Id `outer.<o>`, 18 nodes. */
  readonly board: BoardDef;
  /** null only on the four archetype outers, which feed no template (AMB30). */
  readonly payload: OuterPayload | null;
  readonly skin: Skin;
  readonly covers: Covers;
}

// Fusions (§3.5).

export type FusionKey = `${CharacterId}.${OuterId}`;
export type FusionKind = 'hand' | 'template' | 'templateOverride';

/** impl:316-322 without coef, which FusionDef carries because hand cores read it too. */
export interface FusionTemplate {
  readonly on: CenterEvent;
  /** The payload placed for `on`, or its perEvent entry. */
  readonly do: readonly EffectSpec[];
  readonly bonus: BonusSpec | null;
}

export interface FusionOverride {
  /** The hand core's rule: required on the 12 hand pairs, absent elsewhere (V11). */
  readonly rule?: RuleSpec;
  /** Replaces a template core's trigger (impl:344). */
  readonly triggers?: readonly TriggerSpec[];
  /** Added after the core's trigger (瘟疫爆彈). */
  readonly addTriggers?: readonly TriggerSpec[];
  /** Only for TEMPLATE_RULE_OVERRIDES (冰光, 雷光; D12). */
  readonly addRules?: readonly RuleSpec[];
  /** Added to the core after the bonus's. */
  readonly modifiers?: readonly Modifier[];
  /** Replaces the payload's bonus; null drops it. */
  readonly bonus?: BonusSpec | null;
  /** Replaces the payload's ranks, or HAND_RANKS on a hand pair (D13a). */
  readonly ranks?: FusionRanks;
  readonly skin?: Partial<Skin>;
}

export interface FusionDef {
  readonly key: FusionKey;
  readonly kind: FusionKind;
  /** Id `fusion.<c>.<o>`: core, r1, r2, r3, mastery. */
  readonly board: BoardDef;
  /** null on a hand fusion and on an outer with no payload. */
  readonly template: FusionTemplate | null;
  /** CALIBRATED[key].coef, or 1 without an entry (V9 fails that in CHECK); options.coefs overrides it (§4.3). */
  readonly coef: number;
  /** coef also scales the bonus and r3: a template pair's payload has coefScalesBonus (Q2 (A)). */
  readonly coefScalesBonus: boolean;
  /** The outer's skin with the override's; the UI blends in the character colour. */
  readonly skin: Skin;
  /** fusionDigest of what calibration depends on (F28). */
  readonly digest: string;
}

export const CALIBRATION_STATUSES = ['ok', 'spread', 'weak', 'strong', 'insensitive'] as const;
export type CalibrationStatus = (typeof CALIBRATION_STATUSES)[number];
export interface CalibrationEntry {
  readonly coef: number;
  readonly status: CalibrationStatus;
  /** Paired strength ratios at `coef` (§4.10): median, lowest and highest seed. */
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly seeds: number;
  readonly startWave: number;
  readonly digest: string;
}

// Content, scope, the assembled web and the layout (§3.6).

export interface Content {
  readonly characters: Readonly<Record<CharacterId, CharacterDef>>;
  readonly outers: Readonly<Partial<Record<OuterId, OuterDef>>>;
  readonly hub: HubDef | null;
  readonly overrides: Readonly<Partial<Record<FusionKey, FusionOverride>>>;
  readonly calibrated: Readonly<Partial<Record<FusionKey, CalibrationEntry>>>;
  readonly acceptedFails: Readonly<Partial<Record<FusionKey, string>>>;
}

export interface WebScope {
  readonly name: string;
  readonly characters: readonly CharacterId[] | 'all';
  readonly outers: readonly OuterId[] | 'all';
  /** Fusions cut by the 12/14 line (impl:623): not assembled, shown as locked spokes. */
  readonly deferredFusions: readonly FusionKey[];
  readonly waveCap: number | null;
}

/** open: built and in scope; locked: outside the scope (「完整版」); absent: in scope, not built. */
export type BoardStatus = 'open' | 'locked' | 'absent';
export interface WebBoard {
  readonly id: BoardId;
  readonly kind: 'center' | 'hub' | 'outer' | 'fusion' | 'asc';
  /** The OUTER_IDS index of an outer, fusion or ascendancy board; null for the center and hub. */
  readonly clock: number | null;
  readonly status: BoardStatus;
}

export interface AssembleOptions {
  /** Coefficients that replace the calibrated ones (the fuzz's range ends, calibration's probes). */
  readonly coefs?: Readonly<Partial<Record<FusionKey, number>>>;
}

export interface AssembledWeb {
  readonly character: CharacterId;
  readonly def: CharacterDef;
  readonly scope: WebScope;
  /** Center, hub, outers then fusions in clock order, then ascendancies: webBuild's data order. */
  readonly nodes: readonly WebNode[];
  readonly byId: ReadonlyMap<string, WebNode>;
  readonly edges: readonly (readonly [string, string])[];
  readonly neighbours: ReadonlyMap<string, readonly string[]>;
  /** Every board slot of the character: center, hub, 11 outers, 11 fusions, 2 ascendancies. */
  readonly boards: readonly WebBoard[];
  readonly outers: ReadonlyMap<OuterId, OuterDef>;
  readonly fusions: ReadonlyMap<OuterId, FusionDef>;
  /** `<c>.center.main.signature`. */
  readonly root: string;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Circle extends Point {
  readonly r: number;
}
export interface WebLayout {
  /** Expanded positions in layout units (100 between neighbours; §4.4). */
  readonly nodes: Readonly<Record<string, Point>>;
  /** Per board: its label anchor and, for an outer, its collapsed circle (impl:452; gd:310). */
  readonly boards: Readonly<
    Record<string, { readonly label: Point; readonly collapsed: Circle | null }>
  >;
  /** Where each spoke's 「中心 8/8・毒 3/6」 goes (gd:295). */
  readonly progressMarks: Readonly<Partial<Record<OuterId, Point>>>;
  readonly bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  };
}
