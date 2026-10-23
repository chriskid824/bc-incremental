/**
 * The §4 checks' shapes (docs/v3 C10 design §1.4): one CheckResult per check and subject, its
 * status, and why an n/a is n/a; the checks with implementation-plan-v3 §4's names; a set's plan
 * and its units, the balance pool's jobs, each with a stable id. Plain data, so a merge of shards
 * (C10.4) can evaluate results it did not run.
 */

import type { CharacterId } from '../../../../src/data';
import type { AccountProgress } from '../../../../src/meta/web';
import type { BalanceJob, JobResult } from '../../jobs';
import type { ContentRef } from '../content';
import type { MeasureId, MeasureReadings } from '../measures';
import type { CharacterSessionConfig, CharacterSessionResult } from '../session';
import type { C7Parts } from './c7';
import type { StrengthTarget } from './fusions';
import type { KeystoneTarget } from './keystones';

export type CheckStatus = 'pass' | 'FAIL' | 'n/a' | 'info';

/** Why a check is n/a, each with what unlocks it (NA_UNLOCKS). */
export const NA_REASONS = [
  'noCenter',
  'oneCharacter',
  'noPrestige',
  'noLegacy',
  'noSingularity',
  'c7Pending',
  'fewOuters',
  'uncalibrated',
  'noData',
] as const;
export type NaReason = (typeof NA_REASONS)[number];

/** What unlocks each n/a reason, as the report prints it. */
export const NA_UNLOCKS: Readonly<Record<NaReason, string>> = {
  noCenter: 'B1 registers 熔核, the first character with a center',
  oneCharacter: 'B2 registers 蜂巢, the second character',
  noPrestige: 'B2 writes the prestige (PRESTIGE, tools/balance/v3/prestige.ts)',
  noLegacy: 'B5 writes 傳承 (LEGACY, tools/balance/v3/legacy.ts)',
  noSingularity: 'B5 builds 奇點 and the clear, with 傳承 (LEGACY)',
  c7Pending: 'the C7 part named lands',
  fewOuters: 'B3 opens more than five outers',
  uncalibrated: "npm run calibrate writes the fusion's entry",
  noData: 'a session or a probe reaches the reading',
};

export type CheckSetId = 'pr' | 'nightly' | 'weekly';

/**
 * C10.2's checks in the report's order: implementation-plan-v3 §4's rows (impl:474-491), the two
 * checks from other sources after 遊玩時間, and the PR set's pointers to ci.yml's steps last.
 * C10.3 and C10.4 put theirs at their rows.
 */
export const CHECK_IDS = [
  'pacing',
  'firstHours',
  'newbie',
  'characterFairness',
  'fusionStrength',
  'centerShare',
  'keystones',
  'legacy',
  'playTime',
  'pointBudget',
  'prestigeReturn',
  'budget',
  'fuzz',
  'performance',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export interface CheckDef {
  /** implementation-plan-v3 §4's row name, zh-TW verbatim, or its source's. */
  readonly name: string;
  readonly source: string;
}

export const CHECK_DEFS: Readonly<Record<CheckId, CheckDef>> = {
  pacing: { name: '前線節奏', source: 'impl:474; GDD:208-219' },
  firstHours: { name: '前兩小時', source: 'impl:475; gd:829-835' },
  newbie: { name: '新手公平', source: 'impl:476; gd:838' },
  characterFairness: { name: '角色公平', source: 'impl:477; gd:839' },
  fusionStrength: { name: '融合強度', source: 'impl:480; src/meta/web/calibrate.ts' },
  centerShare: { name: '中心主體性', source: 'impl:482; C3D:1773-1776, :1799' },
  keystones: { name: '關鍵天賦', source: 'impl:485; tools/balance/keystones.ts' },
  legacy: { name: '傳承', source: 'impl:488; gd:792' },
  playTime: { name: '遊玩時間', source: 'impl:489; gd:794' },
  pointBudget: { name: '一輪轉生的點數', source: 'gd:318-319; S301' },
  prestigeReturn: { name: '轉生後回到最遠波次', source: 'GDD:245' },
  budget: { name: '預算報告', source: 'impl:490; C3D:1777; C5D:1483; C4D:3127' },
  fuzz: { name: '模糊測試', source: 'impl:463; ci.yml' },
  performance: { name: '效能', source: 'impl:491; ci.yml' },
};

export interface CheckResult {
  readonly id: CheckId;
  /** The set whose plan evaluated it. */
  readonly set: CheckSetId;
  /** CHECK_DEFS' name. */
  readonly name: string;
  readonly source: string;
  /** 'fire @ 10 min', 'fire × effectsDropped', 'fire.ice', 'all', … */
  readonly subject: string;
  readonly target: string;
  readonly measured: string;
  readonly status: CheckStatus;
  /** n/a only. */
  readonly reason?: { readonly id: NaReason; readonly detail: string };
  /** A FAIL accepted, with its reason; it does not fail the run. */
  readonly accepted?: string;
  /** Where the numbers are: 'curve_check.csv: fire default 10', … */
  readonly evidence: readonly string[];
}

/** A row of `id` in a set's report, with CHECK_DEFS' name and source. */
export function checkRow(
  id: CheckId,
  set: CheckSetId,
  fields: Omit<CheckResult, 'id' | 'set' | 'name' | 'source'>,
): CheckResult {
  const { name, source } = CHECK_DEFS[id];
  return { id, set, name, source, ...fields };
}

/** An n/a row: why, in detail, and what the check would read. */
export function naRow(
  id: CheckId,
  set: CheckSetId,
  subject: string,
  target: string,
  reason: NaReason,
  detail: string,
  measured = '—',
): CheckResult {
  return checkRow(id, set, {
    subject,
    target,
    measured,
    status: 'n/a',
    reason: { id: reason, detail },
    evidence: [],
  });
}

/** One unit of a plan: a balance pool job and its id, the same whatever runs it. */
export interface PlanUnit {
  readonly id: string;
  readonly job: BalanceJob;
}

/** The units' results by unit id. */
export type UnitResults = Readonly<Record<string, JobResult>>;

/**
 * A set's plan (docs/v3 C10 design §1.4–§1.6): its checks, what it read of the content and the
 * hooks, and its first phase of units; derivedUnits (run.ts) gives the second from their results.
 */
export interface CheckPlan {
  readonly set: CheckSetId;
  readonly content: ContentRef;
  readonly quick: boolean;
  /** The checks it evaluates, in the report's order. */
  readonly checks: readonly CheckId[];
  /** The characters with a center, in CHARACTER_IDS order. */
  readonly characters: readonly CharacterId[];
  /** Default sessions per character, and each one's minutes. */
  readonly sessions: number;
  readonly minutes: number;
  /** Whether B2's prestige (PRESTIGE), B5's 傳承 (LEGACY) and 奇點 are written. */
  readonly prestige: boolean;
  readonly legacy: boolean;
  readonly singularity: boolean;
  /** The first phase: the default sessions and the measures that read no session. */
  readonly units: readonly PlanUnit[];
  /** The fusions strength re-measures, with their entries. */
  readonly strength: readonly StrengthTarget[];
  /** The ★ keystones measures on each character's prestige-point snapshot. */
  readonly keystones: readonly KeystoneTarget[];
  /** Accepted FAILs by acceptedKey (accepted.ts). */
  readonly accepted: Readonly<Record<string, string>>;
  /** The C7 parts live where the plan was made (c7.ts). */
  readonly c7: C7Parts;
}

/** A default session's unit id. */
export const sessionUnitId = (character: CharacterId, session: number): string =>
  `session:${character}:default:${session}`;

/** A second character's session after the first's 傳承 (LEGACY). */
export const legacyUnitId = (character: CharacterId, session: number): string =>
  `session:${character}:legacy:${session}`;

/** A fresh save's account, which a session without one starts from. */
export const FRESH_ACCOUNT: AccountProgress = { singularityBeaten: false };

/** The config of the plan's character session unit `id`; throws when the plan has no such unit. */
export function sessionConfigOf(plan: CheckPlan, id: string): CharacterSessionConfig {
  const job = plan.units.find((unit) => unit.id === id)?.job;
  if (job?.kind !== 'character') throw new Error(`No character session unit '${id}' in the plan`);
  return job.config;
}

/** The character session result of unit `id`, or null when it has none. */
export function sessionResultOf(results: UnitResults, id: string): CharacterSessionResult | null {
  const result = results[id];
  return result?.kind === 'character' ? result.result : null;
}

/** The reading of measure unit `id` when it is a `measure` reading, else null. */
export function measureResultOf<K extends MeasureId>(
  results: UnitResults,
  id: string,
  measure: K,
): MeasureReadings[K] | null {
  const result = results[id];
  return result?.kind === 'measure' && result.measure === measure
    ? (result.result as MeasureReadings[K])
    : null;
}

/** A character's default sessions with results, by session index. */
export function defaultSessions(
  plan: CheckPlan,
  results: UnitResults,
  character: CharacterId,
): CharacterSessionResult[] {
  const found: CharacterSessionResult[] = [];
  for (let s = 0; s < plan.sessions; s++) {
    const result = sessionResultOf(results, sessionUnitId(character, s));
    if (result !== null) found.push(result);
  }
  return found;
}
