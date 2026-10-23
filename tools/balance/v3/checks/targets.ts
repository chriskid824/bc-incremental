/**
 * The targets of the §4 checks on character sessions (docs/v3 C10 design §1.8, §2.2). Every number
 * is a source's as given, or a named constant with its reason; all are 初始值. The sessions'
 * curve check (tools/balance/v3/report.ts) reads V3_PACING_TARGETS from here.
 */

import { PACING_TARGETS } from '../../../../src/data';

/**
 * The pacing targets of character sessions (初始值): src/data/curve.ts' PACING_TARGETS (GDD §7.3)
 * plus F5's wave 100 at 5 h, kept in the tools so M1's curve check never moves.
 */
export const V3_PACING_TARGETS: readonly {
  readonly minutes: number;
  readonly frontierWave: number;
  readonly event: string;
}[] = [...PACING_TARGETS, { minutes: 300, frontierWave: 100, event: 'clear' }];

/** A milestone of gd §9's first two hours, read from SessionMilestones. */
export type FirstHoursMilestone =
  | 'firstOuterNode'
  | 'firstFusionCore'
  | 'firstKeystoneAffordable'
  | 'prestigePoint'
  | 'centerThreshold'
  | 'wall';

export interface FirstHoursTarget {
  readonly milestone: FirstHoursMilestone;
  readonly label: string;
  /** Minutes, from and to; one time where both are equal. */
  readonly minutes: readonly [number, number];
  /** The wall's waves. */
  readonly waves?: readonly [number, number];
  /** After the first prestige: no session gets there before B2's prestige. */
  readonly afterPrestige: boolean;
}

/**
 * gd §9's first two hours (gd:829-835, 初始值): 0:08 the first outer node, 0:20 the first fusion
 * core, 0:30 the first ★ affordable (「買得起」, W3), 0:45 the first prestige at wave 30, 1:15 the
 * center threshold, 1:30–2:00 the first wall at waves 50–60.
 */
export const FIRST_HOURS: readonly FirstHoursTarget[] = [
  { milestone: 'firstOuterNode', label: 'first outer node', minutes: [8, 8], afterPrestige: false },
  {
    milestone: 'firstFusionCore',
    label: 'first fusion core',
    minutes: [20, 20],
    afterPrestige: false,
  },
  {
    milestone: 'firstKeystoneAffordable',
    label: 'first ★ affordable',
    minutes: [30, 30],
    afterPrestige: false,
  },
  { milestone: 'prestigePoint', label: 'prestige point', minutes: [45, 45], afterPrestige: false },
  {
    milestone: 'centerThreshold',
    label: 'center threshold',
    minutes: [75, 75],
    afterPrestige: true,
  },
  {
    milestone: 'wall',
    label: 'the wall',
    minutes: [90, 120],
    waves: [50, 60],
    afterPrestige: true,
  },
];

/** gd §9 gives no tolerance (「推論，信心中低」, gd:823): GDD:231's ±15 % band, on the minutes (初始值). */
export const FIRST_HOURS_TOLERANCE = 0.15;

/** impl:476; gd:838 「第 10／20／30 分鐘時的前線」 (初始值). */
export const NEWBIE_MINUTES: readonly number[] = [10, 20, 30];
/** impl:476; gd:838 「差距在 ±10% 內」: the largest |front − median| ÷ median (初始值). */
export const NEWBIE_BAND = 0.1;

/** impl:477; gd:839 「到第 30／60 波的時間」 (初始值). */
export const FAIRNESS_WAVES: readonly number[] = [30, 60];
/** impl:477; gd:839 「最慢 ÷ 最快 ≤ 1.25」 (初始值). */
export const FAIRNESS_MAX = 1.25;

/** impl:482 「預設 build 在第 30 波」 (初始值). */
export const CENTER_SHARE_WAVE = 30;
/** impl:482 「中心的傷害占比 ≥ 50%」, the ascendancy counted for the center (C3D:1773-1776) (初始值). */
export const CENTER_SHARE_MIN = 0.5;

/** gd:318-319 「一輪轉生 約 60–80」「破關 約 120–150」 nodes (S301; 初始值). */
export const POINT_BUDGET = {
  prestige: [60, 80],
  clear: [120, 150],
} as const satisfies Readonly<Record<string, readonly [number, number]>>;

/** impl:489; gd:794 「第一個角色破關 4–6 小時」, with the 20 s between runs (初始值). */
export const PLAY_TIME_MINUTES: readonly [number, number] = [240, 360];

/** impl:488; gd:792 「第二個角色到第 30 波的時間 ≤ 第一個角色的 60%」 (初始值). */
export const LEGACY_MAX = 0.6;
/** The wave the legacy check times (impl:488; gd:792) (初始值). */
export const LEGACY_WAVE = 30;

/** GDD:245 「回到上一輪最遠波次的時間不超過上一輪的 40%」 (初始值). */
export const PRESTIGE_RETURN_MAX = 0.4;
