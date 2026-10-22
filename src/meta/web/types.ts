/**
 * A character's progress on its v3 web and the purchase rules' types (docs/v3 C6 design §3.8,
 * D18–D21): the wallet, a character's and the account's progress, the economy, a price, a gate's
 * progress, a purchase check, the board counts, a refund preview, an outer's view and a challenge
 * mode's limits. Progress is a value: buy, the refunds, legalize and settleWebRun return new ones
 * and never change what they are given (D21). C6 keeps it in memory; C8 stores it in save v2 (§6).
 */

import type { Num } from '../../core/num';
import type { CharacterId, OuterId } from '../../data/sources';
import type { WebNodeKind } from '../../data/web/types';
import type { BuyReason } from './rules';

export interface Wallet {
  readonly shards: Num;
  readonly cores: number;
  /** 迴響, the ascendancy currency. */
  readonly resonance: number;
}

export interface CharacterProgress {
  readonly character: CharacterId;
  /** Owned nodes and ranks; the signature is implied and never listed (D5). */
  readonly ranks: Readonly<Record<string, number>>;
  readonly wallet: Wallet;
  /** What refundAll returns: everything paid since the last full refund or prestige. */
  readonly spent: Wallet;
  /** All-time farthest wave reached: the reveal (never decreases; D20). */
  readonly bestWave: number;
  /** Farthest wave of this prestige cycle: the start-wave rule (MetaState.maxWave's meaning). */
  readonly cycleBest: number;
  readonly prestiges: number;
  /** 迴響 earned in total: the damage bonus reads this, not the balance (gd:778). */
  readonly resonanceEarned: number;
  /** The chosen ascendancy's slug; null before a choice. */
  readonly ascendancy: string | null;
  readonly runs: number;
}

export interface AccountProgress {
  /** 任一角色擊敗奇點: the third fusion slot (gd:788). */
  readonly singularityBeaten: boolean;
}

export interface PriceCurve {
  readonly base: number;
  readonly growth: number;
}

export interface WebEconomy {
  /** Every rank of ranked nodes and every notable, threshold, entry and core (D19). */
  readonly step: PriceCurve;
  /** All masteries, over the total mastery ranks owned (gd:975). */
  readonly mastery: PriceCurve;
  readonly might: PriceCurve;
  readonly cores: Readonly<Record<WebNodeKind, number>>;
  readonly resonance: Readonly<Record<WebNodeKind, number>>;
  /** Start wave = max(1, floor(cycleBest × ratio)); skip compensation as M1's (src/meta/types.ts). */
  readonly startWaveRatio: number;
  readonly skipRewardRate: number;
}

export interface Price {
  readonly shards: Num;
  readonly cores: number;
  readonly resonance: number;
}

/** A spoke's fusion progress and a gate's tooltip (gd:295). */
export interface GateProgress {
  readonly center: number;
  readonly centerNeed: number;
  readonly outer: number | null;
  readonly outerNeed: number | null;
}

export type BuyCheck =
  | { readonly ok: true; readonly price: Price }
  | { readonly ok: false; readonly reason: BuyReason; readonly gate: GateProgress | null };

export interface BoardCounts {
  /** Owned center nodes but the signature (D18). */
  readonly center: number;
  /** Owned nodes per outer board, entry included, fusion nodes never. */
  readonly outers: Readonly<Partial<Record<OuterId, number>>>;
  readonly cores: number;
  readonly keystones: number;
  readonly stepPurchases: number;
  readonly masteryRanks: number;
  readonly mightRanks: number;
}

export interface RefundPreview {
  /** `id` and every node that would drop with it, in drop order. */
  readonly dropped: readonly string[];
  readonly refund: Price;
}

export type OuterView = 'open' | 'hidden' | 'locked' | 'absent';

/**
 * A challenge mode's purchase limits (gd:789 「不能用關鍵天賦、只能接一塊外盤」); checked only when
 * passed (F51).
 */
export interface ChallengeRules {
  readonly noKeystones: boolean;
  /** Outer boards that may hold owned nodes; null for no limit. */
  readonly maxOuters: number | null;
}
