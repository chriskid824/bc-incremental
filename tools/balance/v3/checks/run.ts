/**
 * The §4 checks' sets, plans and evaluation (docs/v3 C10 design §1.4–§1.6, §2.2). checkSet makes
 * a set's plan from the content: the checks, and units that are plain-data balance jobs with
 * stable ids. derivedUnits gives the second phase's units from the first phase's results (the ★
 * measures on the prestige-point snapshots, the legacy sessions); runPlan runs both on the pool;
 * evaluate turns the results into one CheckResult per check and subject. evaluate is a pure
 * function of the plan and the results, so the nightly's shards (C10.4) can split a plan and its
 * merge can evaluate results it did not run.
 */

import { PACING_TOLERANCE } from '../../../../src/data';
import type { Content } from '../../../../src/data/web';
import { DEFAULT_WEB_ECONOMY } from '../../../../src/meta/web';
import { runJobs } from '../../jobs';
import type { BalanceJob, JobResult } from '../../jobs';
import type { PoolRun } from '../../pool';
import { builtCharacters, C10_SEED, formatContentRef } from '../content';
import type { ContentRef } from '../content';
import { LEGACY } from '../legacy';
import type { LegacyHook } from '../legacy';
import { PRESTIGE } from '../prestige';
import { CLEAR_WAVE, FULL_SESSION_MINUTES, PRE_PRESTIGE_MINUTES } from '../session';
import type { CharacterSessionConfig } from '../session';
import { ACCEPTED_CHECK_FAILS, acceptedKey } from './accepted';
import { budgetCheck } from './budget';
import { probeC7Parts } from './c7';
import type { C7Parts } from './c7';
import { fusionStrengthCheck, STRENGTH_BAND, strengthTargets, strengthUnits } from './fusions';
import {
  KEYSTONE_GAIN,
  KEYSTONE_SEEDS,
  keystonesCheck,
  keystoneTargets,
  keystoneUnits,
} from './keystones';
import {
  centerShareCheck,
  characterFairnessCheck,
  firstHoursCheck,
  legacyCheck,
  legacyUnits,
  newbieCheck,
  pacingCheck,
  playTimeCheck,
  pointBudgetCheck,
  prestigeReturnCheck,
} from './sessions';
import {
  CENTER_SHARE_MIN,
  CENTER_SHARE_WAVE,
  FAIRNESS_MAX,
  FAIRNESS_WAVES,
  FIRST_HOURS_TOLERANCE,
  LEGACY_MAX,
  LEGACY_WAVE,
  NEWBIE_BAND,
  NEWBIE_MINUTES,
  PLAY_TIME_MINUTES,
  POINT_BUDGET,
  PRESTIGE_RETURN_MAX,
} from './targets';
import { checkRow, naRow, sessionUnitId } from './types';
import type { CheckId, CheckPlan, CheckResult, CheckSetId, PlanUnit, UnitResults } from './types';

/**
 * Default sessions per character in the pr set and a quick nightly, and in a full nightly
 * (初始值): the M1 probe's 12 sessions per seed (tools/balance/probe.ts) as a quick and a full
 * reading.
 */
export const PR_SESSIONS = 4;
export const NIGHTLY_SESSIONS = 8;
/** The pr set's wall time in seconds (初始值): printed, never gated; beside C6's 60 s fuzz card (R14, C6D:2166). */
export const PR_TARGET_SECONDS = 90;
/** Seconds of menus between runs (impl:489; GDD:243; 初始值): the balance CLI's --menu-seconds default. */
export const MENU_SECONDS = 20;

/**
 * Each set's checks in the report's order (design §1.4, §1.5). pr is impl:493's list: the built
 * characters' default build (quick pacing), one hand and one template fusion, newbie fairness,
 * the center share, and ci.yml's fuzz and performance steps. The nightly is every C10.2 check on
 * NIGHTLY_SESSIONS sessions; C10.3 and C10.4 add theirs and the nightly's global fuzz shard, and
 * the weekly is the nightly plus C10.4's triples.
 */
export const SET_CHECKS: Readonly<Record<CheckSetId, readonly CheckId[]>> = {
  pr: ['pacing', 'newbie', 'fusionStrength', 'centerShare', 'fuzz', 'performance'],
  nightly: [
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
  ],
  weekly: [
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
  ],
};

/** The checks that read the default sessions, which a plan then plays. */
const SESSION_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>([
  'pacing',
  'firstHours',
  'newbie',
  'characterFairness',
  'centerShare',
  'keystones',
  'legacy',
  'playTime',
  'pointBudget',
  'prestigeReturn',
  'budget',
]);

/** What each check judges, as its rows print it before B1 (noCenter) and ARCHITECTURE.md §12 lists it. */
export const CHECK_STANDARDS: Readonly<Record<CheckId, string>> = {
  pacing:
    `the default sessions' median bestWave at each V3_PACING_TARGETS minute within ` +
    `±${Math.round(PACING_TOLERANCE * 100)}% (初始值)`,
  firstHours:
    "median minutes to each of gd §9's first-two-hours milestones within " +
    `±${Math.round(FIRST_HOURS_TOLERANCE * 100)}% (初始值)`,
  newbie: `max |front − median| ÷ median ≤ ${NEWBIE_BAND} at ${NEWBIE_MINUTES.join(', ')} min (初始值)`,
  characterFairness:
    `slowest ÷ fastest median minutes to waves ${FAIRNESS_WAVES.join(', ')} ≤ ` +
    `${FAIRNESS_MAX} (初始值)`,
  fusionStrength:
    `every calibration seed in [${STRENGTH_BAND.min}, ${STRENGTH_BAND.max}] at the entry's ` +
    'coef; digest current (初始值)',
  centerShare:
    `median (center + asc) ÷ all damage ≥ ${CENTER_SHARE_MIN} in the first run reaching wave ` +
    `${CENTER_SHARE_WAVE} (初始值)`,
  keystones:
    `each visible ★: median x(with) − median x(without) over ${KEYSTONE_SEEDS} seeds in ` +
    `[+${KEYSTONE_GAIN.low}, +${KEYSTONE_GAIN.high}] waves (初始值)`,
  legacy: `the second character's minutes to wave ${LEGACY_WAVE} ≤ ${LEGACY_MAX} × the first's (初始值)`,
  playTime:
    `a fresh account clears wave ${CLEAR_WAVE} in ${PLAY_TIME_MINUTES[0]}–` +
    `${PLAY_TIME_MINUTES[1]} min (初始值)`,
  pointBudget:
    `median purchases ${POINT_BUDGET.prestige.join('–')} at the prestige point, ` +
    `${POINT_BUDGET.clear.join('–')} at the clear (初始值)`,
  prestigeReturn: `median minutes back to the last cycle's best ≤ ${PRESTIGE_RETURN_MAX} × that cycle's (初始值)`,
  budget: 'Σ effectsDropped = 0; the other budget and cap counters are info',
  fuzz: "ci.yml's `npm run fuzz:web` passes",
  performance: "ci.yml's `npm run bench -- --check` passes",
};

export interface CheckSetOptions {
  /** The nightly's --quick: PR_SESSIONS where the set reads NIGHTLY_SESSIONS. */
  readonly quick?: boolean;
  /** Test seams: sessions per character and their minutes. */
  readonly sessions?: number;
  readonly minutes?: number;
  /** Test seams: whether B2's PRESTIGE, B5's LEGACY and 奇點 are written (by default, the hooks'). */
  readonly prestige?: boolean;
  readonly legacy?: boolean;
  readonly singularity?: boolean;
  /** The C7 parts in place of c7.ts' probe. */
  readonly c7?: C7Parts;
  /** In place of ACCEPTED_CHECK_FAILS. */
  readonly accepted?: Readonly<Record<string, string>>;
}

/** A default session of the checks: the C10 seed, the max start wave, a fresh account, the full scope. */
function defaultSessionConfig(
  ref: ContentRef,
  character: CharacterSessionConfig['character'],
  session: number,
  minutes: number,
): CharacterSessionConfig {
  return {
    character,
    strategy: 'default',
    session,
    seed: C10_SEED,
    minutes,
    startWave: { kind: 'max' },
    economy: DEFAULT_WEB_ECONOMY,
    menuSeconds: MENU_SECONDS,
    content: ref,
    scope: 'full',
  };
}

/**
 * The plan of `set` on `content` (read from `ref` by the units): the characters with a center,
 * their default sessions (PR_SESSIONS in the pr set and a quick nightly, else NIGHTLY_SESSIONS),
 * the strength measures of the first hand and template fusions with entries, and the visible ★.
 * Before B1 it has no characters and no units.
 */
export function checkSet(
  set: CheckSetId,
  content: Content,
  ref: ContentRef,
  options: CheckSetOptions = {},
): CheckPlan {
  const quick = options.quick ?? false;
  const checks = SET_CHECKS[set];
  const characters = builtCharacters(content);
  const prestige = options.prestige ?? PRESTIGE !== null;
  const legacy = options.legacy ?? LEGACY !== null;
  const sessions = options.sessions ?? (set === 'pr' || quick ? PR_SESSIONS : NIGHTLY_SESSIONS);
  const minutes = options.minutes ?? (prestige ? FULL_SESSION_MINUTES : PRE_PRESTIGE_MINUTES);
  const strength = checks.includes('fusionStrength') ? strengthTargets(content, characters) : [];
  const sessionUnits = checks.some((id) => SESSION_CHECKS.has(id))
    ? characters.flatMap((character) =>
        Array.from({ length: sessions }, (_, session): PlanUnit => ({
          id: sessionUnitId(character, session),
          job: {
            kind: 'character',
            config: defaultSessionConfig(ref, character, session, minutes),
          },
        })),
      )
    : [];
  return {
    set,
    content: ref,
    quick,
    checks,
    characters,
    sessions,
    minutes,
    prestige,
    legacy,
    // 奇點 and the clear land with 傳承 in B5 (implementation-plan-v3 §8.1).
    singularity: options.singularity ?? LEGACY !== null,
    units: [...sessionUnits, ...strengthUnits(ref, strength)],
    strength,
    keystones: checks.includes('keystones') ? keystoneTargets(ref, characters) : [],
    accepted: options.accepted ?? ACCEPTED_CHECK_FAILS,
    c7: options.c7 ?? probeC7Parts(),
  };
}

/**
 * The plan's second phase, a pure function of the plan and the first phase's results (design
 * G4): the ★ measures on each character's prestige-point snapshot (keystones.ts' keystoneUnits)
 * and, once B5 sets LEGACY, the legacy sessions (sessions.ts' legacyUnits).
 */
export function derivedUnits(
  plan: CheckPlan,
  results: UnitResults,
  legacy: LegacyHook | null = LEGACY,
): PlanUnit[] {
  return [...keystoneUnits(plan, results), ...legacyUnits(plan, results, legacy)];
}

/** Runs balance jobs; runJobs (tools/balance/jobs.ts) unless a test passes its own. */
export type RunJobs = (
  jobs: readonly BalanceJob[],
  workers: number,
  log: (message: string) => void,
) => Promise<PoolRun<JobResult>>;

export interface PlanRun {
  readonly results: UnitResults;
  /** How each phase with units ran: 'in-process' or 'k workers'. */
  readonly modes: readonly string[];
}

/** Runs the plan's units, then derivedUnits' from their results, on up to `workers` workers. */
export async function runPlan(
  plan: CheckPlan,
  workers: number,
  log: (message: string) => void = () => {},
  run: RunJobs = runJobs,
  legacy: LegacyHook | null = LEGACY,
): Promise<PlanRun> {
  const results: Record<string, JobResult> = {};
  const modes: string[] = [];
  const phase = async (units: readonly PlanUnit[]): Promise<void> => {
    if (units.length === 0) return;
    const pool = await run(
      units.map((unit) => unit.job),
      workers,
      log,
    );
    units.forEach((unit, index) => {
      if (unit.id in results) throw new Error(`Two units have the id '${unit.id}'`);
      results[unit.id] = pool.results[index] as JobResult;
    });
    modes.push(pool.mode === 'workers' ? `${pool.workers} workers` : 'in-process');
  };
  await phase(plan.units);
  await phase(derivedUnits(plan, results, legacy));
  return { results, modes };
}

/** ci.yml runs the fuzz and the performance check before the checks' step: an info row naming it. */
function ciStep(plan: CheckPlan, id: 'fuzz' | 'performance', command: string): CheckResult[] {
  return [
    checkRow(id, plan.set, {
      subject: 'all',
      target: CHECK_STANDARDS[id],
      measured: `not run here: ci.yml runs \`${command}\` before this step`,
      status: 'info',
      evidence: [`ci.yml: ${command}`],
    }),
  ];
}

const EVALUATORS: Readonly<
  Record<CheckId, (plan: CheckPlan, results: UnitResults) => CheckResult[]>
> = {
  pacing: pacingCheck,
  firstHours: firstHoursCheck,
  newbie: newbieCheck,
  characterFairness: characterFairnessCheck,
  fusionStrength: fusionStrengthCheck,
  centerShare: centerShareCheck,
  keystones: keystonesCheck,
  legacy: legacyCheck,
  playTime: playTimeCheck,
  pointBudget: pointBudgetCheck,
  prestigeReturn: prestigeReturnCheck,
  budget: budgetCheck,
  fuzz: (plan) => ciStep(plan, 'fuzz', 'npm run fuzz:web'),
  performance: (plan) => ciStep(plan, 'performance', 'npm run bench -- --check'),
};

/**
 * The plan's rows in check order, a pure function of the plan and the unit results. Before B1
 * (no character with a center) every check is one noCenter row. A FAIL whose acceptedKey the plan
 * accepts carries the reason; fusion strength's come from content.acceptedFails instead.
 */
export function evaluate(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const rows =
    plan.characters.length === 0
      ? plan.checks.map((id) =>
          naRow(
            id,
            plan.set,
            'all',
            CHECK_STANDARDS[id],
            'noCenter',
            `no character has a center in the ${formatContentRef(plan.content)} content`,
          ),
        )
      : plan.checks.flatMap((id) => EVALUATORS[id](plan, results));
  return rows.map((row) => {
    if (row.status !== 'FAIL' || row.accepted !== undefined || row.id === 'fusionStrength') {
      return row;
    }
    const reason = plan.accepted[acceptedKey(row)];
    return reason === undefined ? row : { ...row, accepted: reason };
  });
}

/** 1 for an unaccepted FAIL, else 0: n/a and info never fail the run (design §1.4). */
export const exitCodeOf = (results: readonly CheckResult[]): 0 | 1 =>
  results.some((row) => row.status === 'FAIL' && row.accepted === undefined) ? 1 : 0;
