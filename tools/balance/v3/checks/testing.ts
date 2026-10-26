/**
 * Synthetic character sessions for the checks' tests: a run row and a session result with neutral
 * defaults, their milestones, and the unit results a plan reads them from; for C10.3's, sessions
 * holding one snapshot, measure readings and test waves.
 */

import type { CharacterId } from '../../../../src/data';
import { auditStart } from '../../../../src/meta/web/invest';
import type { JobResult } from '../../jobs';
import { webOf } from '../content';
import type { MeasureId, MeasureInput, MeasureReading } from '../measures';
import { BUDGET_COUNTERS, TYPE_COLUMNS, V3_MILESTONE_WAVES } from '../session';
import type {
  BudgetCounter,
  CharacterRunRow,
  CharacterSessionResult,
  SessionMilestones,
  SessionSnapshot,
  TypeColumn,
  TypeTally,
} from '../session';
import type { TestWaveReading } from '../testWave';
import type { C7Parts } from './c7';
import { legacyUnitId, sessionUnitId } from './types';
import type { CheckPlan, CheckResult, PlanUnit, UnitResults } from './types';

/** No C7 part live: a plan's c7 without the probe. */
export const NO_C7: C7Parts = {
  'C7.3': false,
  'C7.4a': false,
  'C7.4b': false,
  'C7.5': false,
  'C7.6': false,
  'C7.7': false,
};

/**
 * C7.3 and C7.5 live: C10.2's probe on 270d22b, the base C10.3 was built on (d1faea0 adds C7.4a).
 */
export const BASE_C7: C7Parts = { ...NO_C7, 'C7.3': true, 'C7.5': true };

/** Every C7 part live. */
export const ALL_C7: C7Parts = {
  'C7.3': true,
  'C7.4a': true,
  'C7.4b': true,
  'C7.5': true,
  'C7.6': true,
  'C7.7': true,
};

/** A run row: wave 1, no damage, every counter 0, then `overrides`. */
export function runRow(overrides: Partial<CharacterRunRow> = {}): CharacterRunRow {
  const byType = {} as Record<TypeColumn, TypeTally>;
  for (const column of TYPE_COLUMNS) byType[column] = { leaks: 0, contact: 0, bullet: null };
  const budget = {} as Record<BudgetCounter, number | null>;
  for (const counter of BUDGET_COUNTERS) budget[counter] = 0;
  return {
    character: 'fire',
    scope: 'full',
    strategy: 'default',
    session: 0,
    run: 1,
    minutes: 1,
    startWave: 1,
    highestWaveReached: 1,
    highestWaveCleared: 0,
    endReason: 'death',
    runSeconds: 60,
    cycleBest: 1,
    bestWave: 1,
    prestiges: 0,
    kills: 0,
    leaks: 0,
    damageTaken: 0,
    killedBy: null,
    shardsFromRun: 0,
    skipShards: 0,
    coresFromRun: 0,
    skipCores: 0,
    shardsBank: 0,
    coresBank: 0,
    purchases: 0,
    nodesCenter: 0,
    nodesHub: 0,
    nodesOuter: 0,
    outersUsed: 0,
    keystones: 0,
    fusionCores: 0,
    dmgCenter: 0,
    dmgHub: 0,
    dmgOuter: 0,
    dmgFusion: 0,
    dmgAsc: 0,
    centerShare: null,
    byType,
    bombs: 0,
    bombsPeak: 0,
    budget,
    bought: '',
    ...overrides,
  };
}

/** Milestones none of which is reached, then `overrides`. */
export function milestones(overrides: Partial<SessionMilestones> = {}): SessionMilestones {
  const minutesToWave: Record<number, number | null> = {};
  for (const wave of V3_MILESTONE_WAVES) minutesToWave[wave] = null;
  return {
    minutesToWave,
    firstOuterNode: null,
    firstFusionCore: null,
    firstKeystoneAffordable: null,
    firstKeystone: null,
    prestigePoint: null,
    centerThreshold: null,
    wall: null,
    ...overrides,
  };
}

/** A default session of `character` with no runs, stopped by its budget at 60 min, then `overrides`. */
export function sessionResult(
  character: CharacterId,
  session: number,
  overrides: Partial<CharacterSessionResult> = {},
): CharacterSessionResult {
  return {
    character,
    scope: 'full',
    strategy: 'default',
    session,
    rows: [],
    endMinutes: 60,
    stop: 'budget',
    milestones: milestones(),
    snapshots: [],
    bought: [],
    ...overrides,
  };
}

/** The unit results of default sessions (legacy ones with `legacy`), by their unit ids. */
export function sessionResults(
  sessions: readonly CharacterSessionResult[],
  legacy = false,
): Record<string, JobResult> {
  const results: Record<string, JobResult> = {};
  for (const result of sessions) {
    const id = (legacy ? legacyUnitId : sessionUnitId)(result.character, result.session);
    results[id] = { kind: 'character', result };
  }
  return results;
}

/** Results merged, the later ones winning. */
export const merged = (...parts: readonly UnitResults[]): UnitResults =>
  Object.assign({}, ...parts);

/**
 * Session 0 of each of the plan's characters, holding one snapshot at `minutes`: the audit start
 * (best wave 30, nothing owned), having earned `earned`.
 */
export function snapshotSessions(
  plan: CheckPlan,
  minutes: SessionSnapshot['minutes'],
  earned: SessionSnapshot['earned'] = { shards: 1_000, cores: 2 },
): Record<string, JobResult> {
  return sessionResults(
    plan.characters.map((character) =>
      sessionResult(character, 0, {
        snapshots: [
          { minutes, progress: auditStart(webOf(plan.content, character, 'full'), false), earned },
        ],
      }),
    ),
  );
}

/** The results of `units`' measure jobs: `read` gives each one's reading, or null to leave it unread. */
export function measureResults(
  units: readonly PlanUnit[],
  read: (measure: MeasureId, input: MeasureInput) => MeasureReading | null,
): Record<string, JobResult> {
  const results: Record<string, JobResult> = {};
  for (const unit of units) {
    if (unit.job.kind !== 'measure') continue;
    const result = read(unit.job.measure, unit.job.input);
    if (result !== null) results[unit.id] = { kind: 'measure', measure: unit.job.measure, result };
  }
  return results;
}

/** A test wave's reading: cleared in 10 s with no leak and no damage, then `fields`. */
export const testWave = (fields: Partial<TestWaveReading> = {}): TestWaveReading => ({
  clearSeconds: 10,
  cleared: true,
  died: false,
  count: 10,
  leaks: 0,
  contact: 0,
  bullet: null,
  ...fields,
});

/** The row of `rows` with `subject`; throws when there is none or more than one. */
export function rowWith(rows: readonly CheckResult[], subject: string): CheckResult {
  const found = rows.filter((row) => row.subject === subject);
  if (found.length !== 1) throw new Error(`${found.length} rows for '${subject}'`);
  return found[0] as CheckResult;
}
