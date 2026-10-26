import { describe, expect, it } from 'vitest';
import type { CalibrationEntry, Content } from '../../../../src/data/web';
import { fixtureContent } from '../../../../src/data/web/testing';
import { WEB_FUZZ_BUILDS } from '../../../../src/meta/web/fuzz';
import { auditStart } from '../../../../src/meta/web/invest';
import type { BalanceJob, JobResult } from '../../jobs';
import { C10_SEED, resolveContent, webOf } from '../content';
import type { LegacyHook } from '../legacy';
import type { KeystoneReading } from '../measures';
import { PRE_PRESTIGE_MINUTES } from '../session';
import { webStrategiesFor } from '../strategies';
import { DOUBLE_SEEDS, strengthUnitId, TRIPLE_SEEDS } from './fusions';
import { KEYSTONE_SEEDS } from './keystones';
import { m1Units } from './m1';
import {
  checkSet,
  derivedUnits,
  evaluate,
  exitCodeOf,
  MENU_SECONDS,
  NIGHTLY_SESSIONS,
  PR_SESSIONS,
  runPlan,
  SET_CHECKS,
  standardOf,
} from './run';
import type { RunJobs } from './run';
import { centerShareCsv } from './sessions';
import { milestones, NO_C7, runRow, sessionResult, sessionResults } from './testing';
import { CHECK_IDS, checkRow, naRow, NA_UNLOCKS, sessionUnitId } from './types';
import type { CheckPlan, CheckResult, CheckSetId, UnitResults } from './types';

const B1 = { fixture: 'B1' } as const;
const B2 = { fixture: 'B2' } as const;
const B5 = { fixture: 'B5' } as const;
const SETS: readonly CheckSetId[] = ['pr', 'nightly', 'weekly'];

/** An entry for fire.crit on two seeds: the pr set's template fusion with an entry. */
const entry: CalibrationEntry = {
  coef: 0.5,
  status: 'ok',
  median: 1.2,
  min: 1.1,
  max: 1.3,
  seeds: 2,
  startWave: 1,
  digest: 'd',
};
const calibrated: Content = { ...fixtureContent('B5'), calibrated: { 'fire.crit': entry } };

/**
 * Each character's default sessions 0…n−1, one run each reaching `wave`; past wave 30, stopped at
 * the prestige point with the audit start as its snapshot.
 */
function synthetic(plan: CheckPlan, wave = 31): UnitResults {
  return sessionResults(
    plan.characters.flatMap((character) =>
      Array.from({ length: plan.sessions }, (_, session) =>
        sessionResult(character, session, {
          snapshots:
            wave >= 30
              ? [
                  {
                    minutes: 'prestige',
                    progress: auditStart(webOf(plan.content, character, 'full'), false),
                    earned: { shards: 0, cores: 0 },
                  },
                ]
              : [],
          rows: [
            runRow({
              character,
              session,
              minutes: 12 + session,
              highestWaveReached: wave,
              cycleBest: wave,
              bestWave: wave,
              purchases: 70,
              dmgCenter: 6,
              dmgOuter: 4,
            }),
          ],
          stop: wave >= 30 ? 'prestigePoint' : 'budget',
          endMinutes: 12 + session,
          milestones: milestones({ firstOuterNode: 8, minutesToWave: { 30: 12 + session } }),
        }),
      ),
    ),
  );
}

/** `value` and everything in it frozen, so a write to it throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

describe('the check sets', () => {
  it("makes the pr set impl:493's list: the built characters' default sessions only, PR_SESSIONS each", () => {
    expect(SET_CHECKS.pr).toEqual([
      'pacing',
      'newbie',
      'fusionStrength',
      'centerShare',
      'fuzz',
      'performance',
    ]);
    const plan = checkSet('pr', fixtureContent('B2'), B2, { c7: NO_C7 });
    expect(plan.characters).toEqual(['fire', 'summon']);
    expect(plan.units.map((unit) => unit.id)).toEqual(
      (['fire', 'summon'] as const).flatMap((character) =>
        Array.from({ length: PR_SESSIONS }, (_, session) => sessionUnitId(character, session)),
      ),
    );
    for (const unit of plan.units) {
      expect(unit.job).toMatchObject({
        kind: 'character',
        config: {
          strategy: 'default',
          seed: C10_SEED,
          minutes: PRE_PRESTIGE_MINUTES,
          startWave: { kind: 'max' },
          menuSeconds: MENU_SECONDS,
          content: B2,
          scope: 'full',
        },
      });
    }
    expect(plan.keystones).toEqual([]);
    // --quick is the nightly's flag: the pr set reads PR_SESSIONS either way.
    expect(checkSet('pr', fixtureContent('B2'), B2, { c7: NO_C7, quick: true })).toEqual({
      ...plan,
      quick: true,
    });
  });

  it('measures the strength of the first hand and template fusions with entries in the pr set', () => {
    const plan = checkSet('pr', calibrated, B5, { c7: NO_C7 });
    expect(plan.strength.map(({ group, key }) => [group, key])).toEqual([
      ['hand', 'fire.lightning'],
      ['template', 'fire.crit'],
    ]);
    const measures = plan.units.filter((unit) => unit.job.kind === 'measure');
    expect(measures).toEqual(
      [0, 1].map((seed) => ({
        id: strengthUnitId('fire.crit', seed),
        job: {
          kind: 'measure',
          measure: 'fusionStrength',
          input: { content: B5, key: 'fire.crit', coef: 0.5, seed },
        },
      })),
    );
  });

  it('makes the nightly and weekly plans on NIGHTLY_SESSIONS sessions, PR_SESSIONS with --quick', () => {
    // B2's two characters, four fusions each: C(4, 2) doubles and C(4, 3) triples a character.
    const strategies = webStrategiesFor(webOf(B2, 'fire', 'full')).length;
    const kinds = (plan: CheckPlan): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const { id, job } of plan.units) {
        const kind =
          job.kind === 'measure'
            ? job.measure
            : id.split(':')[2] === 'default'
              ? 'default'
              : 'strategy';
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      return counts;
    };
    for (const set of ['nightly', 'weekly'] as const) {
      const plan = checkSet(set, fixtureContent('B2'), B2, { c7: NO_C7 });
      expect(plan.checks).toEqual(SET_CHECKS[set]);
      expect(plan.sessions).toBe(NIGHTLY_SESSIONS);
      const units = (sessions: number) => ({
        default: 2 * sessions,
        strategy: 2 * (strategies - 1) * sessions,
        double: 2 * 6 * DOUBLE_SEEDS,
        ...(set === 'weekly' ? { triple: 2 * 4 * TRIPLE_SEEDS } : {}),
        m1: 2,
        fuzz: WEB_FUZZ_BUILDS,
      });
      expect(kinds(plan)).toEqual(units(NIGHTLY_SESSIONS));
      expect(plan.keystones.length).toBeGreaterThan(0);
      const quick = checkSet(set, fixtureContent('B2'), B2, { c7: NO_C7, quick: true });
      expect([quick.quick, quick.sessions, kinds(quick)]).toEqual([
        true,
        PR_SESSIONS,
        units(PR_SESSIONS),
      ]);
    }
    // Every check but ci.yml's performance is in the weekly; the nightly leaves out the triples.
    expect(SET_CHECKS.weekly).toEqual(CHECK_IDS.filter((id) => id !== 'performance'));
    expect(SET_CHECKS.nightly).toEqual(SET_CHECKS.weekly.filter((id) => id !== 'triples'));
  });

  it('gives each unit an id from what it reads, the same in any plan, plain data a worker takes', () => {
    const one = checkSet('nightly', calibrated, B5, { c7: NO_C7, sessions: 1 });
    const two = checkSet('nightly', calibrated, B5, { c7: NO_C7, sessions: 2 });
    const ids = two.units.map((unit) => unit.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(one.units.map((unit) => unit.id)));
    expect(checkSet('nightly', calibrated, B5, { c7: NO_C7, sessions: 2 })).toEqual(two);
    const derived = derivedUnits(two, synthetic(two));
    expect(derived).toHaveLength(two.keystones.length * KEYSTONE_SEEDS);
    const all = [...ids, ...derived.map((unit) => unit.id)];
    expect(new Set(all).size).toBe(all.length);
    for (const unit of [...two.units, ...derived]) {
      expect(JSON.parse(JSON.stringify(unit))).toStrictEqual(unit);
    }
    expect(JSON.parse(JSON.stringify(two))).toStrictEqual(two);
  }, 30_000);
});

describe('derivedUnits', () => {
  it("derives the legacy sessions once B5 sets LEGACY, from the first character's sessions", () => {
    const plan = checkSet('nightly', fixtureContent('B2'), B2, {
      c7: NO_C7,
      sessions: 2,
      legacy: true,
    });
    const hook: LegacyHook = { accountAfter: () => ({ singularityBeaten: true }) };
    // No session reaches its prestige point: no ★ units, the legacy sessions alone.
    const results = synthetic(plan, 12);
    const units = derivedUnits(plan, results, hook);
    expect(units.map((unit) => unit.id)).toEqual([
      'session:summon:legacy:0',
      'session:summon:legacy:1',
    ]);
    expect(units[1]?.job).toMatchObject({
      kind: 'character',
      config: { character: 'summon', session: 1, account: { singularityBeaten: true } },
    });
    expect(derivedUnits(plan, results, null)).toEqual([]);
  });
});

describe('evaluate', () => {
  it('evaluates the nightly and weekly plans on synthetic results: every check, in order, each row its set', () => {
    for (const set of ['nightly', 'weekly'] as const) {
      const plan = checkSet(set, fixtureContent('B2'), B2, { c7: NO_C7 });
      const rows = evaluate(plan, synthetic(plan));
      expect([...new Set(rows.map((row) => row.id))]).toEqual(SET_CHECKS[set]);
      for (const row of rows) {
        expect(row.set).toBe(set);
        expect(row.reason !== undefined).toBe(row.status === 'n/a');
      }
      expect(rows.filter((row) => row.status === 'pass').length).toBeGreaterThan(0);
    }
  });

  it('is a pure function of the plan and the results', () => {
    const plan = deepFreeze(checkSet('nightly', fixtureContent('B2'), B2, { c7: NO_C7 }));
    const results = deepFreeze(synthetic(plan));
    const rows = evaluate(plan, results);
    expect(evaluate(plan, results)).toEqual(rows);
    expect(JSON.parse(JSON.stringify(rows))).toStrictEqual(rows);
  });

  it('marks a FAIL whose key the plan accepts with its reason, and only a FAIL', () => {
    const plan = checkSet('pr', fixtureContent('B2'), B2, {
      c7: NO_C7,
      accepted: {
        'centerShare:fire': 'B1 tuning, Hoshi 10/28',
        'pacing:fire @ 60 min': 'an n/a stays n/a',
      },
    });
    const rows = evaluate(plan, synthetic(plan, 12));
    const center = rows.filter((row) => row.id === 'centerShare');
    expect(center.map((row) => [row.subject, row.status, row.accepted])).toEqual([
      ['fire', 'FAIL', 'B1 tuning, Hoshi 10/28'],
      ['summon', 'FAIL', undefined],
    ]);
    const na = rows.find((row) => row.subject === 'fire @ 60 min');
    expect([na?.status, na?.accepted]).toEqual(['n/a', undefined]);
    expect(rows.filter((row) => row.accepted !== undefined)).toHaveLength(1);
    const centerOnly = rows.filter((row) => row.id === 'centerShare');
    expect(exitCodeOf(centerOnly)).toBe(1);
    expect(exitCodeOf(centerOnly.filter((row) => row.subject === 'fire'))).toBe(0);
  });

  it('matches an accepted key by its check and its subject both', () => {
    const plan = checkSet('nightly', fixtureContent('B1'), B1, {
      c7: NO_C7,
      prestige: true,
      singularity: true,
      accepted: { 'centerShare:fire': 'B1 tuning, Hoshi 10/28' },
    });
    // centerShare and playTime both FAIL on the subject 'fire'; only centerShare's key is listed.
    const fails = evaluate(plan, synthetic(plan, 12)).filter(
      (row) => row.status === 'FAIL' && row.subject === 'fire',
    );
    expect(fails.map((row) => [row.id, row.accepted])).toEqual([
      ['centerShare', 'B1 tuning, Hoshi 10/28'],
      ['playTime', undefined],
    ]);
    expect(exitCodeOf(fails)).toBe(1);
  });

  it('reads each session by its unit id: the same rows and CSV in any order, one the plan lacks unread', () => {
    const plan = checkSet('nightly', fixtureContent('B2'), B2, { c7: NO_C7, sessions: 2 });
    const results = synthetic(plan);
    const rows = evaluate(plan, results);
    const reversed: UnitResults = Object.fromEntries(Object.entries(results).reverse());
    expect(evaluate(plan, reversed)).toEqual(rows);
    expect(centerShareCsv(plan, reversed)).toBe(centerShareCsv(plan, results));
    // 熔核's session 2, which the plan of two sessions has no unit for, changes nothing.
    const extra: UnitResults = {
      ...results,
      [sessionUnitId('fire', 2)]: {
        kind: 'character',
        result: sessionResult('fire', 2, {
          rows: [runRow({ session: 2, highestWaveReached: 99, bestWave: 99, dmgAsc: 50 })],
        }),
      },
    };
    expect(evaluate(plan, extra)).toEqual(rows);
    expect(centerShareCsv(plan, extra)).toBe(centerShareCsv(plan, results));
  });

  it("reads fusion strength's accepted FAILs from the content, not the plan's list", () => {
    const failing: UnitResults = Object.fromEntries(
      [0, 1].map((seed) => [
        strengthUnitId('fire.crit', seed),
        {
          kind: 'measure',
          measure: 'fusionStrength',
          result: { key: 'fire.crit', seed, base: 10, with: 11, ratio: 1.5 },
        },
      ]),
    );
    const strength = (content: Content, accepted: Readonly<Record<string, string>> = {}) =>
      evaluate(checkSet('pr', content, B5, { c7: NO_C7, accepted }), failing).find(
        (row) => row.subject === 'fire.crit',
      );
    const listed = strength(calibrated, { 'fusionStrength:fire.crit': 'not this list' });
    expect([listed?.status, listed?.accepted]).toEqual(['FAIL', undefined]);
    expect(
      strength({ ...calibrated, acceptedFails: { 'fire.crit': 'C6 spread, Hoshi 10/20' } }),
    ).toMatchObject({ status: 'FAIL', accepted: 'C6 spread, Hoshi 10/20' });
  });
});

describe('the exit code', () => {
  const at = (status: CheckResult['status'], accepted?: string): CheckResult =>
    status === 'n/a'
      ? naRow('pacing', 'pr', 'fire @ 60 min', 't', 'noPrestige', 'd')
      : checkRow('pacing', 'pr', {
          subject: 'fire @ 10 min',
          target: 't',
          measured: 'm',
          status,
          evidence: [],
          ...(accepted === undefined ? {} : { accepted }),
        });

  it('is 0 for n/a, info, pass and an accepted FAIL, and 1 for an unaccepted FAIL', () => {
    expect(exitCodeOf([])).toBe(0);
    expect(exitCodeOf([at('n/a'), at('info'), at('pass')])).toBe(0);
    expect(exitCodeOf([at('n/a')])).toBe(0);
    expect(exitCodeOf([at('FAIL', 'B1 tuning')])).toBe(0);
    expect(exitCodeOf([at('pass'), at('FAIL')])).toBe(1);
    expect(exitCodeOf([at('FAIL', 'B1 tuning'), at('FAIL')])).toBe(1);
  });
});

describe('registered content before B1', () => {
  const registered = resolveContent('registered');

  it('is noCenter in every check of every set but m1, with what unlocks it, and exits 0', async () => {
    for (const set of SETS) {
      const plan = checkSet(set, registered, 'registered');
      expect([plan.characters, plan.keystones]).toEqual([[], []]);
      // The M1 diffs alone, which need no center (lead ruling U15); the pr set has none.
      expect(plan.units).toEqual(set === 'pr' ? [] : m1Units());
      // The pr set's two groups, unfilled; the nightly's every fusion, none.
      expect(plan.strength.map(({ group, key }) => [group, key])).toEqual(
        set === 'pr'
          ? [
              ['hand', null],
              ['template', null],
            ]
          : [],
      );
      if (set === 'pr') expect(await runPlan(plan, 2)).toEqual({ results: {}, modes: [] });
      const rows = evaluate(plan, {});
      expect(rows.filter((row) => row.id !== 'm1')).toEqual(
        plan.checks
          .filter((id) => id !== 'm1')
          .map((id) =>
            naRow(
              id,
              set,
              'all',
              standardOf(set, id),
              'noCenter',
              'no character has a center in the registered content',
            ),
          ),
      );
      // Unread here: m1's rows are noData, never noCenter (checks/m1.test.ts reads them).
      expect(rows.filter((row) => row.id === 'm1').map((row) => row.reason?.id)).toEqual(
        set === 'pr' ? [] : ['noData', 'noData'],
      );
      expect(exitCodeOf(rows)).toBe(0);
    }
    expect(NA_UNLOCKS.noCenter).toBe('B1 registers 熔核, the first character with a center');
  });
});

describe('runPlan', () => {
  /** A stub pool: each character job a session with a prestige point, each ★ measure x 10 and 15. */
  const stub = (calls: BalanceJob[][]): RunJobs => {
    return (jobs, workers) => {
      calls.push([...jobs]);
      const results = jobs.map((job): JobResult => {
        if (job.kind === 'character') {
          const { character, session } = job.config;
          return {
            kind: 'character',
            result: sessionResult(character, session, {
              stop: 'prestigePoint',
              snapshots: [
                {
                  minutes: 'prestige',
                  progress: auditStart(webOf(B1, 'fire', 'full'), false),
                  earned: { shards: 0, cores: 0 },
                },
              ],
            }),
          };
        }
        if (job.kind === 'measure' && job.measure === 'keystone' && 'star' in job.input) {
          const result: KeystoneReading = {
            character: job.input.character,
            star: job.input.star,
            seed: job.input.seed,
            with: 15,
            without: 10,
            route: [],
            refused: null,
            refunded: [],
          };
          return { kind: 'measure', measure: 'keystone', result };
        }
        throw new Error(`unexpected job ${job.kind}`);
      });
      return Promise.resolve({
        results,
        mode: workers > 1 ? 'workers' : 'in-process',
        workers,
        fallbackReason: null,
      });
    };
  };

  it('runs the sessions, then the measures derivedUnits reads from them, every result by its unit id', async () => {
    const nightly = checkSet('nightly', fixtureContent('B1'), B1, { c7: NO_C7, sessions: 2 });
    // The sessions alone: the stub plays no first-phase measure (C10.4's doubles, M1 diffs, fuzz).
    const plan = {
      ...nightly,
      units: nightly.units.filter((unit) => unit.job.kind === 'character'),
    };
    const calls: BalanceJob[][] = [];
    const run = await runPlan(plan, 3, () => {}, stub(calls));
    expect(calls[0]).toEqual(plan.units.map((unit) => unit.job));
    const first: UnitResults = Object.fromEntries(
      plan.units.map((unit) => [unit.id, run.results[unit.id] as JobResult]),
    );
    const derived = derivedUnits(plan, first);
    expect(derived).toHaveLength(plan.keystones.length * KEYSTONE_SEEDS);
    expect(calls[1]).toEqual(derived.map((unit) => unit.job));
    expect(calls).toHaveLength(2);
    expect(Object.keys(run.results)).toEqual([
      ...plan.units.map((unit) => unit.id),
      ...derived.map((unit) => unit.id),
    ]);
    expect(run.modes).toEqual(['3 workers', '3 workers']);
    expect(evaluate(plan, run.results).find((row) => row.id === 'keystones')?.status).toBe('pass');
  });

  it('refuses two units with one id', async () => {
    const plan = checkSet('pr', fixtureContent('B1'), B1, { c7: NO_C7, sessions: 1 });
    const twice: CheckPlan = { ...plan, units: [...plan.units, ...plan.units] };
    await expect(runPlan(twice, 1, () => {}, stub([]))).rejects.toThrow(
      /Two units have the id 'session:fire:default:0'/,
    );
  });

  it('gives the same results by unit id in-process and on two workers', async () => {
    const plan = checkSet('pr', calibrated, B5, { c7: NO_C7, sessions: 1, minutes: 1 });
    expect(plan.units.filter((unit) => unit.job.kind === 'measure')).toHaveLength(2);
    const [inProcess, workers] = [await runPlan(plan, 1), await runPlan(plan, 2)];
    expect([inProcess.modes, workers.modes]).toEqual([['in-process'], ['2 workers']]);
    expect(Object.keys(workers.results)).toEqual(plan.units.map((unit) => unit.id));
    expect(workers.results).toEqual(inProcess.results);
  }, 60_000);
});
