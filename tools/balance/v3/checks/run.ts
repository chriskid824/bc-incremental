/**
 * The §4 checks' sets, plans and evaluation (docs/v3 C10 design §1.4–§1.6, §2.2–§2.4). checkSet
 * makes a set's plan from the content: the checks, and units that are plain-data balance jobs with
 * stable ids. derivedUnits gives the second phase's units from the first phase's results (the ★
 * measures on the prestige-point snapshots, the legacy sessions, and the rows', affixes' and dead
 * boards' measures on the DEAD_BOARD_MINUTES snapshots), and derivedReads says which sessions it
 * reads for a character; runPlan runs both on the pool; evaluate turns the results into one
 * CheckResult per check and subject. evaluate is a pure function of the plan and the results, so
 * the nightly's shards (nightly.ts) split a plan and its merge evaluates results it did not run.
 */

import { PACING_TOLERANCE } from '../../../../src/data';
import type { CharacterId } from '../../../../src/data';
import type { Content } from '../../../../src/data/web';
import { DEFAULT_WEB_ECONOMY } from '../../../../src/meta/web';
import { WEB_FUZZ_SEED } from '../../../../src/meta/web/fuzz';
import { runJobs } from '../../jobs';
import type { BalanceJob, JobResult } from '../../jobs';
import type { PoolRun } from '../../pool';
import { builtCharacters, C10_SEED, formatContentRef, webOf } from '../content';
import type { ContentRef } from '../content';
import { LEGACY } from '../legacy';
import type { LegacyHook } from '../legacy';
import { PRESTIGE } from '../prestige';
import {
  CLEAR_WAVE,
  FULL_SESSION_MINUTES,
  OTHER_SESSION_MINUTES,
  PRE_PRESTIGE_MINUTES,
} from '../session';
import type { CharacterSessionConfig, SessionSnapshot } from '../session';
import { webStrategiesFor } from '../strategies';
import type { WebStrategyId } from '../strategies';
import { ACCEPTED_CHECK_FAILS, acceptedKey } from './accepted';
import {
  boardUnits,
  DEAD_BOARD_MINUTES,
  DEAD_BOARDS_STANDARD,
  DEAD_NODES_STANDARD,
  deadBoardsCheck,
  deadNodesCheck,
} from './boards';
import { budgetCheck } from './budget';
import { probeC7Parts } from './c7';
import type { C7Parts } from './c7';
import {
  comboStandard,
  comboUnits,
  doublesCheck,
  everyStrengthTarget,
  fusionStrengthCheck,
  mirrorsCheck,
  MIRRORS_STANDARD,
  mirrorUnits,
  STRENGTH_BAND,
  strengthTargets,
  strengthUnits,
  triplesCheck,
} from './fusions';
import { FUZZ_NIGHTLY_STANDARD, fuzzCheck, fuzzUnits } from './fuzz';
import {
  KEYSTONE_GAIN,
  KEYSTONE_SEEDS,
  keystonesCheck,
  keystoneTargets,
  keystoneUnits,
} from './keystones';
import {
  affixesCheck,
  AFFIXES_STANDARD,
  ENEMY_ROW_STANDARD,
  enemyRowCheck,
  OUTER_ROW_STANDARD,
  outerRowCheck,
  rowUnits,
} from './rows';
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
import { m1Check, M1_STANDARD, m1Units } from './m1';
import { checkRow, naRow, sessionUnitId, strategyUnitId } from './types';
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
 * the center share, and ci.yml's fuzz and performance steps. The nightly is every other check on
 * NIGHTLY_SESSIONS sessions: fusion strength over every fusion, the mirrors, the doubles, the M1
 * diffs and its own fuzz (the global-fuzz shard); the weekly is the nightly with the triples.
 */
export const SET_CHECKS: Readonly<Record<CheckSetId, readonly CheckId[]>> = {
  pr: ['pacing', 'newbie', 'fusionStrength', 'centerShare', 'fuzz', 'performance'],
  nightly: [
    'pacing',
    'firstHours',
    'newbie',
    'characterFairness',
    'enemyRow',
    'outerRow',
    'fusionStrength',
    'mirrors',
    'centerShare',
    'deadBoards',
    'deadNodes',
    'keystones',
    'doubles',
    'legacy',
    'playTime',
    'pointBudget',
    'prestigeReturn',
    'affixes',
    'budget',
    'm1',
    'fuzz',
  ],
  weekly: [
    'pacing',
    'firstHours',
    'newbie',
    'characterFairness',
    'enemyRow',
    'outerRow',
    'fusionStrength',
    'mirrors',
    'centerShare',
    'deadBoards',
    'deadNodes',
    'keystones',
    'doubles',
    'triples',
    'legacy',
    'playTime',
    'pointBudget',
    'prestigeReturn',
    'affixes',
    'budget',
    'm1',
    'fuzz',
  ],
};

/** The checks that read the default sessions, which a plan then plays. */
const SESSION_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>([
  'pacing',
  'firstHours',
  'newbie',
  'characterFairness',
  'enemyRow',
  'outerRow',
  'centerShare',
  'deadBoards',
  'deadNodes',
  'keystones',
  'legacy',
  'playTime',
  'pointBudget',
  'prestigeReturn',
  'affixes',
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
  enemyRow: ENEMY_ROW_STANDARD,
  outerRow: OUTER_ROW_STANDARD,
  fusionStrength:
    `every calibration seed in [${STRENGTH_BAND.min}, ${STRENGTH_BAND.max}] at the entry's ` +
    'coef; digest current (初始值)',
  mirrors: MIRRORS_STANDARD,
  centerShare:
    `median (center + asc) ÷ all damage ≥ ${CENTER_SHARE_MIN} in the first run reaching wave ` +
    `${CENTER_SHARE_WAVE} (初始值)`,
  deadBoards: DEAD_BOARDS_STANDARD,
  deadNodes: DEAD_NODES_STANDARD,
  keystones:
    `each visible ★: median x(with) − median x(without) over ${KEYSTONE_SEEDS} seeds in ` +
    `[+${KEYSTONE_GAIN.low}, +${KEYSTONE_GAIN.high}] waves (初始值)`,
  doubles: comboStandard('double'),
  triples: comboStandard('triple'),
  legacy: `the second character's minutes to wave ${LEGACY_WAVE} ≤ ${LEGACY_MAX} × the first's (初始值)`,
  playTime:
    `a fresh account clears wave ${CLEAR_WAVE} in ${PLAY_TIME_MINUTES[0]}–` +
    `${PLAY_TIME_MINUTES[1]} min (初始值)`,
  pointBudget:
    `median purchases ${POINT_BUDGET.prestige.join('–')} at the prestige point, ` +
    `${POINT_BUDGET.clear.join('–')} at the clear (初始值)`,
  prestigeReturn: `median minutes back to the last cycle's best ≤ ${PRESTIGE_RETURN_MAX} × that cycle's (初始值)`,
  affixes: AFFIXES_STANDARD,
  budget: 'Σ effectsDropped = 0; the other budget and cap counters are info',
  m1: M1_STANDARD,
  fuzz: "ci.yml's `npm run fuzz:web` passes",
  performance: "ci.yml's `npm run bench -- --check` passes",
};

/** A check's standard in `set`: the nightly's fuzz runs its own builds, the pr set's points at ci.yml. */
export const standardOf = (set: CheckSetId, id: CheckId): string =>
  id === 'fuzz' && set !== 'pr' ? FUZZ_NIGHTLY_STANDARD : CHECK_STANDARDS[id];

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
  /** The nightly fuzz's seed (nightly.ts: WEB_FUZZ_SEED + the commit's first six hex digits). */
  readonly fuzzSeed?: number;
}

/**
 * A session of the checks: the C10 seed, the max start wave, a fresh account, the full scope;
 * `strategy`'s, the default build's unless named.
 */
function defaultSessionConfig(
  ref: ContentRef,
  character: CharacterSessionConfig['character'],
  session: number,
  minutes: number,
  strategy: WebStrategyId = 'default',
): CharacterSessionConfig {
  return {
    character,
    strategy,
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
 * the strength measures (the pr set's first hand and template fusions with entries, the nightly's
 * every calibrated fusion) and the visible ★; in the nightly, every other strategy's sessions
 * (which deadNodes reads), the mirrors', doubles' and triples' measures, the M1 diffs and the
 * fuzz's builds. Before B1 it has no characters, and only the M1 diffs' units.
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
  const otherMinutes = options.minutes ?? (prestige ? OTHER_SESSION_MINUTES : PRE_PRESTIGE_MINUTES);
  const has = (id: CheckId): boolean => checks.includes(id);
  const strength =
    has('fusionStrength') || has('mirrors')
      ? set === 'pr'
        ? strengthTargets(content, characters)
        : everyStrengthTarget(content, characters)
      : [];
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
  // Every other strategy's sessions, whose purchases deadNodes reads (C10.3's D15).
  const strategyUnits = has('deadNodes')
    ? characters.flatMap((character) =>
        webStrategiesFor(webOf(ref, character, 'full'))
          .filter((strategy) => strategy !== 'default')
          .flatMap((strategy) =>
            Array.from({ length: sessions }, (_, session): PlanUnit => ({
              id: strategyUnitId(character, strategy, session),
              job: {
                kind: 'character',
                config: defaultSessionConfig(ref, character, session, otherMinutes, strategy),
              },
            })),
          ),
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
    units: [
      ...sessionUnits,
      ...strategyUnits,
      ...(has('fusionStrength') ? strengthUnits(ref, strength) : []),
      ...(has('mirrors') ? mirrorUnits(ref, strength) : []),
      ...(has('doubles') ? comboUnits('double', content, ref, characters) : []),
      ...(has('triples') ? comboUnits('triple', content, ref, characters) : []),
      ...(has('m1') ? m1Units() : []),
      ...(has('fuzz') && set !== 'pr'
        ? fuzzUnits(content, ref, options.fuzzSeed ?? WEB_FUZZ_SEED)
        : []),
    ],
    strength,
    keystones: checks.includes('keystones') ? keystoneTargets(ref, characters) : [],
    accepted: options.accepted ?? ACCEPTED_CHECK_FAILS,
    c7: options.c7 ?? probeC7Parts(),
  };
}

/**
 * The plan's second phase, a pure function of the plan and the first phase's results (design
 * G4): the ★ measures on each character's prestige-point snapshot (keystones.ts' keystoneUnits);
 * once B5 sets LEGACY, the legacy sessions (sessions.ts' legacyUnits); and the row, affix and
 * dead-board measures on each character's DEAD_BOARD_MINUTES snapshot (rows.ts' rowUnits,
 * boards.ts' boardUnits).
 */
export function derivedUnits(
  plan: CheckPlan,
  results: UnitResults,
  legacy: LegacyHook | null = LEGACY,
): PlanUnit[] {
  return [
    ...keystoneUnits(plan, results),
    ...legacyUnits(plan, results, legacy),
    ...rowUnits(plan, results),
    ...boardUnits(plan, results),
  ];
}

/** The checks whose units derive from a character's DEAD_BOARD_MINUTES snapshot (rows.ts, boards.ts). */
const BOARD_SNAPSHOT_CHECKS: readonly CheckId[] = ['enemyRow', 'outerRow', 'deadBoards'];

/** The sessions derivedUnits reads for one character's units (lead ruling U11). */
export interface DerivedReads {
  /** The character's default session ids in index order; empty when no derived check reads them. */
  readonly sessions: readonly string[];
  /** The snapshots read off them: the sessions up to the lowest holding each one are enough. */
  readonly snapshots: readonly SessionSnapshot['minutes'][];
  /** Sessions read whole: for a later character's legacy units, the first's default sessions. */
  readonly whole: readonly string[];
}

/**
 * What derivedUnits reads to make `character`'s units, from keystoneUnits', rowUnits',
 * boardUnits' and legacyUnits' rules: its default sessions in index order up to the lowest holding
 * the prestige point (when it has a ★ to measure) and a DEAD_BOARD_MINUTES snapshot (for the rows,
 * the dead boards and, once C7.6 is live, the affixes); and, once B5 sets LEGACY, a later
 * character's legacy sessions read every default session of the first. nightly.ts' `<c>-probes`
 * replays exactly these, and its merge checks the units they gave against derivedUnits on every
 * merged session.
 */
export function derivedReads(
  plan: CheckPlan,
  character: CharacterId,
  legacy: LegacyHook | null = LEGACY,
): DerivedReads {
  const snapshots: SessionSnapshot['minutes'][] = [];
  if (
    plan.checks.includes('keystones') &&
    plan.keystones.some((target) => target.character === character)
  ) {
    snapshots.push('prestige');
  }
  if (
    BOARD_SNAPSHOT_CHECKS.some((id) => plan.checks.includes(id)) ||
    (plan.checks.includes('affixes') && plan.c7['C7.6'])
  ) {
    snapshots.push(DEAD_BOARD_MINUTES);
  }
  const [first] = plan.characters;
  const legacyReads =
    plan.checks.includes('legacy') &&
    plan.legacy &&
    legacy !== null &&
    first !== undefined &&
    first !== character &&
    plan.characters.includes(character);
  const ids = (of: CharacterId): string[] =>
    Array.from({ length: plan.sessions }, (_, session) => sessionUnitId(of, session));
  return {
    sessions: snapshots.length > 0 && plan.characters.includes(character) ? ids(character) : [],
    snapshots,
    whole: legacyReads ? ids(first) : [],
  };
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
  enemyRow: enemyRowCheck,
  outerRow: outerRowCheck,
  fusionStrength: fusionStrengthCheck,
  mirrors: mirrorsCheck,
  centerShare: centerShareCheck,
  deadBoards: deadBoardsCheck,
  deadNodes: deadNodesCheck,
  keystones: keystonesCheck,
  doubles: doublesCheck,
  triples: triplesCheck,
  legacy: legacyCheck,
  playTime: playTimeCheck,
  pointBudget: pointBudgetCheck,
  prestigeReturn: prestigeReturnCheck,
  affixes: affixesCheck,
  budget: budgetCheck,
  m1: m1Check,
  fuzz: (plan, results) =>
    plan.set === 'pr' ? ciStep(plan, 'fuzz', 'npm run fuzz:web') : fuzzCheck(plan, results),
  performance: (plan) => ciStep(plan, 'performance', 'npm run bench -- --check'),
};

/** Checks real before B1: m1 judges the M1 path, which needs no center (lead ruling U15). */
const CENTERLESS_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>(['m1']);

/**
 * The plan's rows in check order, a pure function of the plan and the unit results. Before B1
 * (no character with a center) every check but m1 is one noCenter row. A FAIL whose acceptedKey
 * the plan accepts carries the reason; fusion strength's come from content.acceptedFails instead.
 */
export function evaluate(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const rows = plan.checks.flatMap((id) =>
    plan.characters.length === 0 && !CENTERLESS_CHECKS.has(id)
      ? [
          naRow(
            id,
            plan.set,
            'all',
            standardOf(plan.set, id),
            'noCenter',
            `no character has a center in the ${formatContentRef(plan.content)} content`,
          ),
        ]
      : EVALUATORS[id](plan, results),
  );
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
