/**
 * Shapes of the typed data files (docs/ARCHITECTURE.md §6). zod schemas in
 * `src/data/schema.ts` must produce exactly these types; content lives in the other
 * files under `src/data/` and is validated on load.
 */

import type { Modifier } from './stats';
import type { RuleSpec } from './rules';

export const ENEMY_IDS = ['triangle', 'square', 'pentagon', 'shard', 'hexagon', 'boss'] as const;
/** `shard` is the small triangle a pentagon splits into. */
export type EnemyId = (typeof ENEMY_IDS)[number];

export type EnemyShape = 'triangle' | 'square' | 'pentagon' | 'hexagon' | 'octagon';

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
}

/** A recurring group of enemies inside normal waves. */
export interface SpawnRule {
  readonly enemy: EnemyId;
  /** First wave this rule applies to. */
  readonly fromWave: number;
  /** count(w) = min(maxCount, floor(base + perWave × (w − fromWave))). */
  readonly base: number;
  readonly perWave: number;
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
  /** Archetype for UI color and balance reporting. */
  readonly archetype: 'none' | 'crit' | 'dot' | 'chain' | 'hybrid';
  readonly nameKey: string;
  readonly descKey: string;
}

export interface GameData {
  readonly enemies: Readonly<Record<EnemyId, EnemyDef>>;
  readonly waves: WaveTable;
  readonly talents: readonly TalentNode[];
}
