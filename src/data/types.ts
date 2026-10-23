/**
 * Shapes of the typed data files (docs/ARCHITECTURE.md §6). zod schemas in
 * `src/data/schema.ts` must produce exactly these types; content lives in the other
 * files under `src/data/` and is validated on load.
 */

import type { EmitterGrant } from './emitters';
import type { Modifier } from './stats';
import type { RuleSpec } from './rules';
import type { ConversionSpec, TriggerSpec } from './triggers';

/**
 * M1's six types, then v3's (docs/v3 C7 design §1.2): ROW_ENEMIES' six spellings and the onion,
 * the v3 boss. Appended, so M1's order (mainThreat's ties, RunResult.damageTakenBy) stays.
 */
export const ENEMY_IDS = [
  'triangle',
  'square',
  'pentagon',
  'shard',
  'hexagon',
  'boss',
  'shielder',
  'regenerator',
  'dasher',
  'shooter',
  'summoner',
  'treasure',
  'onion',
] as const;
/** `shard` is the small triangle a pentagon splits into; `boss` is M1's octagon. */
export type EnemyId = (typeof ENEMY_IDS)[number];

export type EnemyShape =
  | 'triangle'
  | 'square'
  | 'pentagon'
  | 'hexagon'
  | 'octagon'
  | 'circle'
  | 'cross'
  | 'rhombus'
  | 'trapezoid'
  | 'ring'
  | 'diamond'
  | 'onion';

/**
 * What a v3 type does beyond walking in (docs/v3 C7 design §1.2). Data only: each kind's numbers
 * are read by the commit that builds its mechanic, and a run of this commit spawns every type as
 * a plain walker.
 */
export type EnemyBehaviour =
  /** Hits below this fraction of its max life are blocked (盾兵). */
  | { readonly kind: 'shield'; readonly blockBelowPct: number }
  /** Regains this fraction of its max life a second (再生者). */
  | { readonly kind: 'regen'; readonly lifePctPerSec: number }
  /** Charges for chargeSec at chargeDist from the player, then runs at dashMult × speed (衝刺者). */
  | {
      readonly kind: 'dash';
      readonly chargeDist: number;
      readonly chargeSec: number;
      readonly dashMult: number;
    }
  /** Stops at stopDist and fires a bullet at the player every periodSec (射手). */
  | {
      readonly kind: 'shoot';
      readonly stopDist: number;
      readonly periodSec: number;
      readonly bulletSpeed: number;
      readonly bulletDamage: number;
    }
  /** Stops at stopDist and spawns `count` of `enemy` around itself every periodSec (召喚者). */
  | {
      readonly kind: 'summon';
      readonly stopDist: number;
      readonly periodSec: number;
      readonly enemy: EnemyId;
      readonly count: number;
    }
  /** Circles at orbitDist for orbitSec, then flees at fleeMult × its speed (寶藏怪). */
  | {
      readonly kind: 'treasure';
      readonly orbitDist: number;
      readonly orbitSec: number;
      readonly fleeMult: number;
    }
  /** Its hpMult split over `layers` shells, each spraying `burst` when it breaks (洋蔥). */
  | {
      readonly kind: 'layers';
      readonly layers: number;
      readonly burst: { readonly enemy: EnemyId; readonly count: number };
    };

export interface EnemyDef {
  readonly id: EnemyId;
  readonly shape: EnemyShape;
  /** HP = hpMult × standard HP of the wave (src/data/curve.ts). */
  readonly hpMult: number;
  /** Arena units per second. */
  readonly speed: number;
  /** Collision radius in arena units. */
  readonly radius: number;
  /** Life the player loses when this enemy reaches it (the enemy is removed, no drop). */
  readonly contactDamage: number;
  /** Shard drop = dropMult × shardsPerStdEnemy(wave) × shardGain. */
  readonly dropMult: number;
  /** Cores dropped on death (before coreGain). */
  readonly cores: number;
  /** On death, spawn these enemies at the same position (e.g. pentagon → 3 shards). */
  readonly splitInto?: { readonly enemy: EnemyId; readonly count: number };
  /** Fill color as 0xRRGGBB, used by the renderer only. */
  readonly color: number;
  /** An elite or a boss (Enemy.tough): a focus target, and the shots' tough pass. */
  readonly tough: boolean;
  /** A boss (Enemy.boss): targetKind 'boss' and the boss frost cap; always tough as well. */
  readonly boss: boolean;
  /** A v3 type's behaviour; none for M1's six. */
  readonly behaviour?: EnemyBehaviour;
}

/** A recurring group of enemies inside normal waves. */
export interface SpawnRule {
  readonly enemy: EnemyId;
  /** First wave this rule applies to. */
  readonly fromWave: number;
  /** count(w) = min(maxCount, max(minCount, floor(base + perWave × (w − fromWave)))). */
  readonly base: number;
  readonly perWave: number;
  /**
   * Floor on the count, so the first waves already fill the screen; once the growth passes
   * it, the rule grows as before. Defaults to 0.
   */
  readonly minCount?: number;
  readonly maxCount: number;
}

export interface WaveTable {
  readonly rules: readonly SpawnRule[];
  /** Every Nth wave adds one elite (hexagon). */
  readonly eliteEvery: number;
  /** Every Nth wave adds one boss; boss waves take precedence over elite waves. */
  readonly bossEvery: number;
  /** Enemies of one wave appear spread evenly over this many seconds. */
  readonly spawnDurationSec: number;
  /** The next wave starts when the field is clear or after this many seconds. */
  readonly waveTimerSec: number;
  /**
   * The v3 rules: present only in the data character runs receive (characterGameData) and in v3
   * test data, and a run whose table has them is a v3 run (docs/v3 C7 design §1.1).
   */
  readonly v3?: V3WaveRules;
}

/**
 * A v3 run's wave rules beyond M1's (docs/v3 C7 design §1.2). The whole block is fixed here for
 * the content and the simulator; each field is read from the commit that builds its mechanic.
 */
export interface V3WaveRules {
  /** Enemies alive at once at most (the enemy cap). */
  readonly enemyCap: number;
  /** The boss of each boss wave in turn, from the first: boss-flagged types. */
  readonly bossRotation: readonly EnemyId[];
  /** Affixes on each elite from `fromWave` on: strictly ascending in fromWave. */
  readonly affixes: readonly { readonly fromWave: number; readonly count: number }[];
  /** The treasure's schedule: `enemy` from `fromWave` on, one every `every` waves. */
  readonly treasure: { readonly enemy: EnemyId; readonly fromWave: number; readonly every: number };
}

export type TalentKind = 'start' | 'small' | 'notable' | 'keystone' | 'repeatable';

export interface TalentNode {
  readonly id: string;
  readonly kind: TalentKind;
  /** Layout position in talent-web units; the start node sits at (0, 0). */
  readonly pos: { readonly x: number; readonly y: number };
  /** Neighbour ids. Links are undirected and must be listed on both nodes. */
  readonly links: readonly string[];
  /** Multiplier on the global shard price (src/meta). Defaults to 1. */
  readonly shardCostFactor?: number;
  /** Cores required in addition to shards. Defaults to 0. */
  readonly coreCost?: number;
  /** For `repeatable` nodes: price of rank r (0-based) = baseShards × growth^r. */
  readonly repeat?: { readonly baseShards: number; readonly growth: number };
  /** Modifiers granted once (or per rank for repeatable nodes). */
  readonly modifiers: readonly Modifier[];
  readonly rules: readonly RuleSpec[];
  /**
   * Triggers granted once (or per rank for repeatable nodes), credited to the node's source
   * (sourceOfNode, src/data/sources.ts).
   */
  readonly triggers: readonly TriggerSpec[];
  /** Damage conversions of hits, granted once (or per rank for repeatable nodes). */
  readonly conversions: readonly ConversionSpec[];
  /**
   * Emitters the node adds to the run, such as thorns (src/data/emitters.ts): granted once, also
   * on repeatable nodes, credited to the node's source.
   */
  readonly emitters: readonly EmitterGrant[];
  /** Archetype for UI color and balance reporting. */
  readonly archetype: 'none' | 'crit' | 'dot' | 'chain' | 'hybrid';
  readonly nameKey: string;
  /**
   * Text for what the node's rules, triggers, conversions, emitters and behaviour modifiers do;
   * required exactly when it has any (needsDescKey, src/data/validate.ts).
   */
  readonly descKey?: string;
}

export interface GameData {
  readonly enemies: Readonly<Record<EnemyId, EnemyDef>>;
  readonly waves: WaveTable;
  readonly talents: readonly TalentNode[];
}
