import { describe, expect, it } from 'vitest';
import type { CharacterId } from '../../../../src/data';
import type { Batch } from '../../../../src/data/web';
import { fixtureContent } from '../../../../src/data/web/testing';
import type { CharacterRunRow, CharacterSessionResult } from '../session';
import { checkSet } from './run';
import type { CheckSetOptions } from './run';
import {
  centerShareCheck,
  centerShareCsv,
  characterFairnessCheck,
  firstHoursCheck,
  legacyCheck,
  legacyUnits,
  newbieCheck,
  pacingCheck,
  playTimeCheck,
  pointBudgetCheck,
  prestigeReturnCheck,
  prestigeReturns,
} from './sessions';
import { FIRST_HOURS_TOLERANCE, LEGACY_MAX, NEWBIE_BAND } from './targets';
import { merged, milestones, NO_C7, runRow, sessionResult, sessionResults } from './testing';
import type { CheckPlan, CheckResult, UnitResults } from './types';

/** The nightly plan on the fixture after `batch`: B1 has 熔核 alone, B2 adds 蜂巢, B5 all four. */
const plan = (batch: Batch = 'B5', options: CheckSetOptions = {}): CheckPlan =>
  checkSet('nightly', fixtureContent(batch), { fixture: batch }, { c7: NO_C7, ...options });

/** `count` default sessions of `character`, each made by `make(session)`. */
const sessions = (
  character: CharacterId,
  count: number,
  make: (session: number) => Partial<CharacterSessionResult>,
): CharacterSessionResult[] =>
  Array.from({ length: count }, (_, session) => sessionResult(character, session, make(session)));

const rowOf = (rows: readonly CheckResult[], subject: string): CheckResult => {
  const row = rows.find((candidate) => candidate.subject === subject);
  if (row === undefined)
    throw new Error(`no row '${subject}' in ${rows.map((r) => r.subject).join(', ')}`);
  return row;
};
const statusOf = (rows: readonly CheckResult[], subject: string): string => {
  const row = rowOf(rows, subject);
  return row.status === 'n/a' ? `n/a ${row.reason?.id}` : row.status;
};

/** One row per session at `minutes`, of bestWave `waves[s]`. */
const wavesAt = (minutes: number, waves: readonly number[]): UnitResults =>
  sessionResults(
    sessions('fire', waves.length, (s) => ({
      rows: [runRow({ minutes, bestWave: waves[s] as number })],
    })),
  );

describe('pacing (前線節奏)', () => {
  const at10 = (waves: readonly number[]): string =>
    statusOf(pacingCheck(plan(), wavesAt(9, waves)), 'fire @ 10 min');

  it('passes at both ends of ±15% of the target and FAILs past either', () => {
    // 15 at 10 min: 12.75 to 17.25.
    expect(at10([12.75, 12.75, 12.75, 12.75])).toBe('pass');
    expect(at10([17.25, 17.25, 17.25, 17.25])).toBe('pass');
    expect(at10([12.7, 12.7, 12.7, 12.7])).toBe('FAIL');
    expect(at10([17.3, 17.3, 17.3, 17.3])).toBe('FAIL');
    // The median over the sessions: two of four far off still pass.
    expect(at10([3, 15, 15, 40])).toBe('pass');
  });

  it("reads each session's last run ending by the minute, and takes the median over sessions, not runs", () => {
    const results = sessionResults(
      sessions('fire', 4, () => ({
        rows: [
          runRow({ minutes: 2, bestWave: 1 }),
          runRow({ minutes: 5, run: 2, bestWave: 2 }),
          runRow({ minutes: 9, run: 3, bestWave: 15 }),
          runRow({ minutes: 11, run: 4, bestWave: 40 }),
        ],
      })),
    );
    const row = rowOf(pacingCheck(plan(), results), 'fire @ 10 min');
    expect(row.status).toBe('pass');
    expect(row.measured).toBe('median 15 over 4 sessions');
    expect(row.evidence).toEqual(['curve_check.csv: fire default 10']);
  });

  it('carries a session stopped at its prestige point past its end, and drops a budget-stopped one', () => {
    const stopped = sessions('fire', 4, () => ({
      rows: [runRow({ minutes: 34, bestWave: 30, cycleBest: 30 })],
      endMinutes: 34.5,
      stop: 'prestigePoint',
    }));
    const row = rowOf(pacingCheck(plan(), sessionResults(stopped)), 'fire @ 40 min');
    expect([row.status, row.measured]).toEqual([
      'pass',
      'median 30 over 4 sessions (4 carried past their end)',
    ]);
    const budget = stopped.map((result) => ({ ...result, stop: 'budget' as const }));
    expect(statusOf(pacingCheck(plan(), sessionResults(budget)), 'fire @ 40 min')).toBe(
      'n/a noData',
    );
  });

  it('is noPrestige past wave 30 until B2, and reads it with the prestige', () => {
    const rows = pacingCheck(plan(), wavesAt(59, [40, 40, 40, 40]));
    expect(
      ['fire @ 60 min', 'fire @ 180 min', 'fire @ 300 min'].map((s) => statusOf(rows, s)),
    ).toEqual(['n/a noPrestige', 'n/a noPrestige', 'n/a noPrestige']);
    expect(statusOf(rows, 'fire @ 40 min')).toBe('FAIL');
    const after = pacingCheck(plan('B5', { prestige: true }), wavesAt(59, [40, 40, 40, 40]));
    expect(statusOf(after, 'fire @ 60 min')).toBe('pass');
    expect(rows.filter((row) => row.subject.startsWith('fire @'))).toHaveLength(7);
  });

  it("reads a character's default sessions only, never its legacy ones", () => {
    const p = plan('B2', { legacy: true });
    const summon = (bestWave: number, legacy = false): UnitResults =>
      sessionResults(
        sessions('summon', 4, () => ({
          rows: [runRow({ character: 'summon', minutes: 9, bestWave })],
        })),
        legacy,
      );
    const row = rowOf(pacingCheck(p, merged(summon(15), summon(40, true))), 'summon @ 10 min');
    expect([row.status, row.measured]).toEqual(['pass', 'median 15 over 4 sessions']);
  });
});

describe('firstHours (前兩小時)', () => {
  const lo = (minutes: number): number => minutes * (1 - FIRST_HOURS_TOLERANCE);
  const hi = (minutes: number): number => minutes * (1 + FIRST_HOURS_TOLERANCE);
  const reached = {
    firstOuterNode: 8,
    firstFusionCore: 20,
    firstKeystoneAffordable: 30,
    prestigePoint: { minutes: 45, purchases: 70 },
  };
  const check = (
    overrides: Parameters<typeof milestones>[0],
    options: CheckSetOptions = {},
  ): CheckResult[] =>
    firstHoursCheck(
      plan('B5', options),
      sessionResults(
        sessions('fire', 4, () => ({
          milestones: milestones(overrides),
          // A cycleBest at wave 30 long before the prestige point the session records.
          rows: [runRow({ minutes: 12, cycleBest: 30, bestWave: 30 })],
        })),
      ),
    );

  it('reads each milestone in its own time, the prestige point from the milestones', () => {
    const rows = check(reached);
    expect(
      [
        'fire × first outer node',
        'fire × first fusion core',
        'fire × first ★ affordable',
        'fire × prestige point',
      ].map((s) => statusOf(rows, s)),
    ).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(rowOf(rows, 'fire × prestige point').measured).toBe(
      'median 45 min (4 of 4 sessions get there)',
    );
    expect(rowOf(rows, 'fire × first outer node').evidence).toEqual([
      'milestones.csv: fire default firstOuterNode',
    ]);
  });

  it('passes at both ends of the tolerance and FAILs past either', () => {
    const outer = (minutes: number): string =>
      statusOf(check({ ...reached, firstOuterNode: minutes }), 'fire × first outer node');
    expect([lo(8), hi(8), lo(8) - 0.01, hi(8) + 0.01].map(outer)).toEqual([
      'pass',
      'pass',
      'FAIL',
      'FAIL',
    ]);
    const core = (minutes: number): string =>
      statusOf(check({ ...reached, firstFusionCore: minutes }), 'fire × first fusion core');
    expect([lo(20), hi(20), lo(20) - 0.01, hi(20) + 0.01].map(core)).toEqual([
      'pass',
      'pass',
      'FAIL',
      'FAIL',
    ]);
  });

  it('takes the median over sessions, not the mean', () => {
    // 8, 8, 8 and 20 min: the median 8 is on time; the mean 11 would be past 8 × 1.15.
    const rows = firstHoursCheck(
      plan(),
      sessionResults(
        sessions('fire', 4, (s) => ({
          milestones: milestones({ ...reached, firstOuterNode: s === 3 ? 20 : 8 }),
        })),
      ),
    );
    expect(rowOf(rows, 'fire × first outer node')).toMatchObject({
      status: 'pass',
      measured: 'median 8 min (4 of 4 sessions get there)',
    });
  });

  it('counts a milestone most sessions never reach as never', () => {
    const rows = firstHoursCheck(
      plan(),
      sessionResults(
        sessions('fire', 4, (s) => ({
          milestones: milestones({ ...reached, firstFusionCore: s === 0 ? 20 : null }),
        })),
      ),
    );
    expect(rowOf(rows, 'fire × first fusion core')).toMatchObject({
      status: 'FAIL',
      measured: 'median ∞ min (1 of 4 sessions get there)',
    });
  });

  it('is noPrestige after the first prestige until B2; then the wall needs its time and waves', () => {
    const before = check(reached);
    expect(['fire × center threshold', 'fire × the wall'].map((s) => statusOf(before, s))).toEqual([
      'n/a noPrestige',
      'n/a noPrestige',
    ]);
    const wall = (minutes: number, wave: number): string =>
      statusOf(
        check({ ...reached, centerThreshold: 75, wall: { minutes, wave } }, { prestige: true }),
        'fire × the wall',
      );
    expect(wall(100, 50)).toBe('pass');
    expect(wall(100, 60)).toBe('pass');
    expect(wall(lo(90), 55)).toBe('pass');
    expect(wall(hi(120), 55)).toBe('pass');
    expect(wall(100, 49)).toBe('FAIL');
    expect(wall(100, 61)).toBe('FAIL');
    expect(wall(hi(120) + 0.01, 55)).toBe('FAIL');
    const threshold = check({ ...reached, centerThreshold: 75 }, { prestige: true });
    expect(statusOf(threshold, 'fire × center threshold')).toBe('pass');
  });

  it('is noPrestige after the first prestige until B2 without a session too, the rest noData', () => {
    expect(firstHoursCheck(plan('B1'), {}).map((row) => row.reason?.id)).toEqual([
      'noData',
      'noData',
      'noData',
      'noData',
      'noPrestige',
      'noPrestige',
    ]);
  });
});

describe('newbie (新手公平)', () => {
  const four: CharacterId[] = ['fire', 'ice', 'lightning', 'summon'];
  const fronts = (values: readonly number[]): UnitResults =>
    merged(
      ...four.map((character, i) =>
        sessionResults(
          sessions(character, 4, () => ({
            rows: [runRow({ character, minutes: 9, bestWave: values[i] as number })],
          })),
        ),
      ),
    );
  const at10 = (values: readonly number[]): CheckResult =>
    rowOf(newbieCheck(plan(), fronts(values)), 'all @ 10 min');

  it('divides by the median of the fronts, ≤ the band passing', () => {
    // Median 10: 9 and 11 are 0.1 off it (by the slowest, 11 would be 0.111 off).
    expect(at10([9, 10, 10, 11])).toMatchObject({
      status: 'pass',
      measured: '0.1 (fronts fire 9, ice 10, lightning 10, summon 11; median 10)',
    });
    // 8.9 is 0.11 off the median 10 (but only 0.085 off the mean 9.725).
    expect(at10([8.9, 10, 10, 10]).status).toBe('FAIL');
    expect(at10([10, 10, 10, 10 * (1 + NEWBIE_BAND) + 0.01]).status).toBe('FAIL');
    expect(newbieCheck(plan(), fronts([10, 10, 10, 10])).map((row) => row.subject)).toEqual([
      'all @ 10 min',
      'all @ 20 min',
      'all @ 30 min',
    ]);
  });

  it("reads a character's front from each session's last run by the minute, the median over sessions", () => {
    // 熔核's sessions end runs at 2, 5, 9 and 12 min: wave 10 by 10 min in each (over its runs
    // to then, the median would be 7); the others' one run reaches wave 10 at 9 min.
    const fire = sessionResults(
      sessions('fire', 3, () => ({
        rows: [2, 5, 9, 12].map((minutes, i) =>
          runRow({ minutes, run: i + 1, bestWave: [4, 7, 10, 20][i] as number }),
        ),
      })),
    );
    const others = four.slice(1).map((character) =>
      sessionResults(
        sessions(character, 3, () => ({
          rows: [runRow({ character, minutes: 9, bestWave: 10 })],
        })),
      ),
    );
    expect(rowOf(newbieCheck(plan(), merged(fire, ...others)), 'all @ 10 min')).toMatchObject({
      status: 'pass',
      measured: '0 (fronts fire 10, ice 10, lightning 10, summon 10; median 10)',
    });
  });

  it('is oneCharacter with one built character, its front shown', () => {
    const rows = newbieCheck(plan('B1'), wavesAt(9, [12, 14, 16, 18]));
    expect(rows[0]).toMatchObject({
      subject: 'all @ 10 min',
      status: 'n/a',
      measured: 'fronts fire 15',
      reason: { id: 'oneCharacter' },
    });
  });

  it('is oneCharacter with one character whatever it reads, and noData while a front is unread', () => {
    expect(newbieCheck(plan('B1'), {})[0]).toMatchObject({
      status: 'n/a',
      measured: 'fronts fire —',
      reason: { id: 'oneCharacter' },
    });
    // 蜂巢 has no session: noData, never a verdict on a NaN front.
    expect(rowOf(newbieCheck(plan('B2'), wavesAt(9, [10, 10])), 'all @ 10 min')).toMatchObject({
      status: 'n/a',
      measured: 'fronts fire 10, summon —',
      reason: { id: 'noData' },
    });
  });
});

describe('characterFairness (角色公平)', () => {
  const times = (minutes: Readonly<Partial<Record<CharacterId, number | null>>>): UnitResults =>
    merged(
      ...(Object.entries(minutes) as [CharacterId, number | null][]).map(([character, value]) =>
        sessionResults(
          sessions(character, 4, () => ({
            milestones: milestones({ minutesToWave: { 30: value, 60: value } }),
          })),
        ),
      ),
    );

  it('passes the slowest at 1.25 × the fastest and FAILs past it', () => {
    const check = (ice: number | null): CheckResult =>
      rowOf(
        characterFairnessCheck(plan(), times({ fire: 20, ice, lightning: 22, summon: 21 })),
        'all × wave 30',
      );
    expect(check(25)).toMatchObject({
      status: 'pass',
      measured: '1.25 (minutes fire 20, ice 25, lightning 22, summon 21)',
    });
    expect(check(25.2).status).toBe('FAIL');
    expect(check(null).status).toBe('FAIL');
  });

  it("takes each character's median over its sessions, not the mean", () => {
    // 熔核 at 20, 20, 20 and 60 min: its median 20 makes 24 ÷ 20 = 1.2; its mean 30 would be 1.43.
    const results = merged(
      sessionResults(
        sessions('fire', 4, (s) => ({
          milestones: milestones({ minutesToWave: { 30: s === 3 ? 60 : 20 } }),
        })),
      ),
      times({ ice: 24, lightning: 22, summon: 21 }),
    );
    expect(rowOf(characterFairnessCheck(plan(), results), 'all × wave 30')).toMatchObject({
      status: 'pass',
      measured: '1.2 (minutes fire 20, ice 24, lightning 22, summon 21)',
    });
  });

  it('is oneCharacter with one character, and wave 60 noPrestige until B2', () => {
    expect(
      characterFairnessCheck(plan('B1'), times({ fire: 20 })).map((row) => row.reason?.id),
    ).toEqual(['oneCharacter', 'oneCharacter']);
    const all = times({ fire: 20, ice: 21, lightning: 22, summon: 23 });
    expect(statusOf(characterFairnessCheck(plan(), all), 'all × wave 60')).toBe('n/a noPrestige');
    expect(
      statusOf(characterFairnessCheck(plan('B5', { prestige: true }), all), 'all × wave 60'),
    ).toBe('pass');
  });

  it('keeps wave 60 noPrestige until B2 while a character has no session, wave 30 noData', () => {
    expect(
      characterFairnessCheck(plan('B2'), times({ fire: 20 })).map((row) => row.reason?.id),
    ).toEqual(['noData', 'noPrestige']);
  });
});

describe('centerShare (中心主體性)', () => {
  const share = (rows: (s: number) => CharacterRunRow[]): CheckResult =>
    rowOf(
      centerShareCheck(plan(), sessionResults(sessions('fire', 4, (s) => ({ rows: rows(s) })))),
      'fire',
    );
  const at30 = (damage: Partial<CharacterRunRow>, wave = 30): CharacterRunRow =>
    runRow({ highestWaveReached: wave, ...damage });

  it('passes a median share of exactly 0.5 and FAILs below it', () => {
    expect(share(() => [at30({ dmgCenter: 50, dmgOuter: 50 })])).toMatchObject({
      status: 'pass',
      measured: 'median 50 % (asc 0 % of all) over 4 sessions',
    });
    expect(share(() => [at30({ dmgCenter: 49, dmgOuter: 51 })]).status).toBe('FAIL');
  });

  it('counts the ascendancy for the center and shows it apart', () => {
    expect(share(() => [at30({ dmgCenter: 30, dmgAsc: 25, dmgOuter: 45 })])).toMatchObject({
      status: 'pass',
      measured: 'median 55 % (asc 25 % of all) over 4 sessions',
    });
  });

  it("reads each session's first run reaching wave 30, the median over sessions", () => {
    const rows = (): CharacterRunRow[] => [
      at30({ dmgCenter: 90, dmgOuter: 10 }, 29),
      at30({ run: 2, dmgCenter: 60, dmgOuter: 40 }, 30),
      at30({ run: 3, dmgCenter: 20, dmgOuter: 80 }, 31),
      at30({ run: 4, dmgCenter: 10, dmgOuter: 90 }, 32),
    ];
    expect(share(rows)).toMatchObject({
      status: 'pass',
      measured: expect.stringMatching(/^median 60 %/),
    });
  });

  it('takes the median share over the sessions, not the mean', () => {
    // Three sessions at 50 % and one at 10 %: the median 50 % passes; the mean 40 % would FAIL.
    const row = share((s) => [at30({ dmgCenter: s === 3 ? 10 : 50, dmgOuter: s === 3 ? 90 : 50 })]);
    expect(row).toMatchObject({
      status: 'pass',
      measured: 'median 50 % (asc 0 % of all) over 4 sessions',
    });
  });

  it('FAILs a character with a session that never reaches wave 30', () => {
    const row = share((s) => [at30({ dmgCenter: 90, dmgOuter: 10 }, s === 3 ? 29 : 30)]);
    expect([row.status, row.measured]).toEqual(['FAIL', '1 of 4 sessions never reach wave 30']);
  });

  it("writes center_share.csv: each session's first run reaching wave 30, blank for none", () => {
    const p = plan();
    const results = sessionResults(
      sessions('fire', 2, (s) => ({
        rows: [
          at30(
            { run: 3, minutes: 12.5, dmgCenter: 30, dmgAsc: 25, dmgOuter: 45 },
            s === 0 ? 30 : 12,
          ),
        ],
      })),
    );
    expect(centerShareCsv(p, results).trimEnd().split('\n')).toEqual([
      'character,session,run,minutes,highestWaveReached,dmgCenter,dmgHub,dmgOuter,dmgFusion,dmgAsc,share,ascShare',
      'fire,0,3,12.5,30,30,0,45,0,25,0.55,0.25',
      'fire,1,,,,,,,,,,',
    ]);
  });
});

describe('pointBudget (一輪轉生的點數)', () => {
  const atPrestige = (purchases: readonly (number | null)[]): CheckResult[] =>
    pointBudgetCheck(
      plan(),
      sessionResults(
        sessions('fire', purchases.length, (s) => {
          const value = purchases[s];
          return {
            milestones: milestones({
              prestigePoint:
                value === null || value === undefined ? null : { minutes: 40, purchases: value },
            }),
          };
        }),
      ),
    );

  it('passes the median purchases at the prestige point from 60 to 80, both ends in', () => {
    const status = (n: number): string =>
      statusOf(atPrestige([n, n, n, n]), 'fire × prestige point');
    expect([60, 80, 59, 81].map(status)).toEqual(['pass', 'pass', 'FAIL', 'FAIL']);
    // Over the sessions that reach it.
    expect(rowOf(atPrestige([70, null, 70, null]), 'fire × prestige point')).toMatchObject({
      status: 'pass',
      measured: 'median 70 over 2 of 4 sessions',
    });
    expect(statusOf(atPrestige([null, null]), 'fire × prestige point')).toBe('n/a noData');
  });

  it('takes the median purchases over the sessions, not the mean', () => {
    // 70, 70, 70 and 200: the median 70 passes; the mean 102.5 would FAIL.
    expect(rowOf(atPrestige([70, 70, 70, 200]), 'fire × prestige point')).toMatchObject({
      status: 'pass',
      measured: 'median 70 over 4 of 4 sessions',
    });
  });

  it('is noSingularity at the clear until B5, then reads the cleared sessions from 120 to 150', () => {
    expect(statusOf(atPrestige([70]), 'fire × clear')).toBe('n/a noSingularity');
    const cleared = (n: number): string =>
      statusOf(
        pointBudgetCheck(
          plan('B5', { prestige: true, singularity: true }),
          sessionResults(
            sessions('fire', 2, () => ({
              stop: 'cleared',
              rows: [runRow({ purchases: 3 }), runRow({ run: 2, purchases: n })],
            })),
          ),
        ),
        'fire × clear',
      );
    expect([120, 150, 119, 151].map(cleared)).toEqual(['pass', 'pass', 'FAIL', 'FAIL']);
  });
});

describe('legacy (傳承)', () => {
  const toWave30 = (character: CharacterId, minutes: number, legacy = false): UnitResults =>
    sessionResults(
      sessions(character, 4, () => ({
        milestones: milestones({ minutesToWave: { 30: minutes } }),
      })),
      legacy,
    );

  it('is noLegacy until B5 sets LEGACY, then oneCharacter with one', () => {
    expect(legacyCheck(plan('B2'), {})).toMatchObject([
      { subject: 'all', status: 'n/a', reason: { id: 'noLegacy' } },
    ]);
    expect(legacyCheck(plan('B1', { legacy: true }), {})).toMatchObject([
      { subject: 'all', status: 'n/a', reason: { id: 'oneCharacter' } },
    ]);
  });

  it('is noLegacy at B1, one character, until B5 sets LEGACY (design §2.2)', () => {
    expect(legacyCheck(plan('B1'), {})).toMatchObject([
      { subject: 'all', status: 'n/a', reason: { id: 'noLegacy' } },
    ]);
  });

  it("passes the second character at 0.6 × the first's minutes to wave 30 and FAILs past it", () => {
    const check = (minutes: number): CheckResult =>
      rowOf(
        legacyCheck(
          plan('B2', { legacy: true }),
          merged(toWave30('fire', 50), toWave30('summon', minutes, true)),
        ),
        'summon after fire',
      );
    expect(check(LEGACY_MAX * 50)).toMatchObject({
      status: 'pass',
      measured: '30 min against 50 (0.6×)',
    });
    expect(check(30.5).status).toBe('FAIL');
  });

  it("plays each second character's session from the account the first's leaves", () => {
    const p = plan('B2', { legacy: true });
    const first = sessions('fire', p.sessions, () => ({}));
    const hook = {
      accountAfter: (
        result: CharacterSessionResult,
        account: { readonly singularityBeaten: boolean },
      ) => ({
        singularityBeaten: result.session === 1 || account.singularityBeaten,
      }),
    };
    const units = legacyUnits(p, sessionResults(first), hook);
    expect(units.map((unit) => unit.id)).toEqual(
      Array.from({ length: p.sessions }, (_, s) => `session:summon:legacy:${s}`),
    );
    expect(units[1]?.job).toMatchObject({
      kind: 'character',
      config: {
        character: 'summon',
        strategy: 'default',
        session: 1,
        account: { singularityBeaten: true },
      },
    });
    expect(units[0]?.job).toMatchObject({ config: { account: { singularityBeaten: false } } });
    expect(legacyUnits(p, sessionResults(first), null)).toEqual([]);
    expect(legacyUnits(plan('B2'), sessionResults(first), hook)).toEqual([]);
  });
});

describe('playTime (遊玩時間)', () => {
  const clears = (minutes: readonly (number | null)[], options: CheckSetOptions): CheckResult =>
    rowOf(
      playTimeCheck(
        plan('B5', options),
        sessionResults(
          sessions('fire', minutes.length, (s) => {
            const value = minutes[s];
            return value === null || value === undefined
              ? { stop: 'budget', endMinutes: 360 }
              : { stop: 'cleared', endMinutes: value };
          }),
        ),
      ),
      'fire',
    );

  it('is noPrestige until B2 and info until B5 builds 奇點', () => {
    expect(clears([300], {}).reason?.id).toBe('noPrestige');
    expect(statusOf(playTimeCheck(plan('B1'), {}), 'fire')).toBe('n/a noPrestige');
    expect(clears([300, null, 300], { prestige: true })).toMatchObject({
      status: 'info',
      measured: 'median 300 min (2 of 3 sessions clear)',
    });
  });

  it('passes a median clear from 240 to 360 min, both ends in, once 奇點 is built', () => {
    const status = (n: number): string =>
      clears([n, n], { prestige: true, singularity: true }).status;
    expect([240, 360, 239, 361].map(status)).toEqual(['pass', 'pass', 'FAIL', 'FAIL']);
    expect(clears([300, null, null], { prestige: true, singularity: true }).status).toBe('FAIL');
  });
});

describe('prestigeReturn (轉生後回到最遠波次)', () => {
  /** A cycle of 20 min to wave 30, a prestige, and the next cycle back at wave 30 after `back` min. */
  const twoCycles = (back: number | null): CharacterRunRow[] => [
    runRow({ minutes: 10, cycleBest: 20 }),
    runRow({ run: 2, minutes: 19, cycleBest: 30 }),
    runRow({ run: 3, minutes: 21, runSeconds: 60, cycleBest: 10, prestiges: 1 }),
    runRow({
      run: 4,
      minutes: 20 + (back ?? 30),
      cycleBest: back === null ? 25 : 30,
      prestiges: 1,
    }),
  ];

  it("divides the minutes back to the last cycle's best by that cycle's", () => {
    expect(prestigeReturns(sessionResult('fire', 0, { rows: twoCycles(8) }))).toEqual([0.4]);
    expect(prestigeReturns(sessionResult('fire', 0, { rows: twoCycles(null) }))).toEqual([
      Infinity,
    ]);
    // A second prestige measures its cycle from the first.
    const rows = [
      ...twoCycles(8),
      runRow({ run: 5, minutes: 41, runSeconds: 60, cycleBest: 10, prestiges: 2 }),
      runRow({ run: 6, minutes: 46, cycleBest: 30, prestiges: 2 }),
    ];
    expect(prestigeReturns(sessionResult('fire', 0, { rows }))).toEqual([0.4, 6 / 20]);
  });

  it('passes a median of 0.4 and FAILs above; noPrestige until B2', () => {
    const check = (
      back: number | null,
      options: CheckSetOptions = { prestige: true },
    ): CheckResult =>
      rowOf(
        prestigeReturnCheck(
          plan('B5', options),
          sessionResults(sessions('fire', 4, () => ({ rows: twoCycles(back) }))),
        ),
        'fire',
      );
    expect(check(8)).toMatchObject({ status: 'pass', measured: 'median 0.4 over 4 prestiges' });
    expect(check(8.5).status).toBe('FAIL');
    expect(check(null).status).toBe('FAIL');
    expect(check(8, {}).reason?.id).toBe('noPrestige');
    const none = prestigeReturnCheck(
      plan('B5', { prestige: true }),
      sessionResults(sessions('fire', 4, () => ({ rows: [runRow()] }))),
    );
    expect(statusOf(none, 'fire')).toBe('n/a noData');
  });

  it('is noPrestige until B2 where no session prestiged, as none can before B2', () => {
    const b1 = sessionResults(
      sessions('fire', 4, () => ({ rows: [runRow()], stop: 'prestigePoint' })),
    );
    expect(statusOf(prestigeReturnCheck(plan('B1'), b1), 'fire')).toBe('n/a noPrestige');
  });
});
