import { describe, expect, it } from 'vitest';
import { deriveSeed } from '../../../../src/core/rng';
import { fixtureContent } from '../../../../src/data/web/testing';
import { DEFAULT_WEB_ECONOMY } from '../../../../src/meta/web';
import type { CharacterProgress } from '../../../../src/meta/web';
import { GATED_KINDS, storedRank } from '../../../../src/meta/web/counts';
import { auditBuy, auditStart, fillBoard } from '../../../../src/meta/web/invest';
import { shortestRoute } from '../../../../src/meta/web/path';
import { runJob } from '../../jobs';
import type { JobResult } from '../../jobs';
import { C10_SEED, webOf } from '../content';
import { keystoneSeed, measureKeystone } from '../measures';
import type { KeystoneReading, MeasureProbe } from '../measures';
import { purchasesOf } from '../session';
import type { SessionSnapshot } from '../session';
import {
  KEYSTONE_GAIN,
  KEYSTONE_SEEDS,
  keystonesCheck,
  keystonesCsv,
  keystoneTargets,
  keystoneUnitId,
  keystoneUnits,
} from './keystones';
import { checkSet, derivedUnits, evaluate } from './run';
import { merged, NO_C7, sessionResult, sessionResults } from './testing';
import { FRESH_ACCOUNT } from './types';
import type { CheckPlan, CheckResult, UnitResults } from './types';

const B1 = { fixture: 'B1' } as const;
const web = webOf(B1, 'fire', 'full');
const STAR = 'fire.center.main.star-one';
const plan = checkSet('nightly', fixtureContent('B1'), B1, { c7: NO_C7 });
/** The plan with one ★, the center's first, to keep the measured tests short. */
const onePlan: CheckPlan = { ...plan, keystones: plan.keystones.slice(0, 1) };

/** A prestige-point snapshot of `progress`. */
const snapshot = (progress: CharacterProgress): SessionSnapshot => ({
  minutes: 'prestige',
  progress,
  earned: { shards: 0, cores: 0 },
});

/** 熔核's default sessions 0 and 1, the prestige point in session `at` only. */
const withSnapshot = (progress: CharacterProgress, at = 0): UnitResults =>
  sessionResults(
    [0, 1].map((s) =>
      sessionResult('fire', s, {
        stop: s === at ? 'prestigePoint' : 'budget',
        snapshots: s === at ? [snapshot(progress)] : [],
      }),
    ),
  );

/** The audit start with the route to `star`, its gate and the ★ bought: a snapshot owning it. */
function owning(star: string): CharacterProgress {
  const start = auditStart(web, false);
  const route = shortestRoute(web, start, star, (node) => !GATED_KINDS.has(node.kind)) ?? [];
  let progress = start;
  for (const id of route.slice(0, -1)) {
    const step = auditBuy(web, progress, FRESH_ACCOUNT, id);
    if (step.ok) progress = step.progress;
  }
  const board = web.byId.get(star)?.board ?? 'hub';
  progress = fillBoard(
    web,
    progress,
    FRESH_ACCOUNT,
    board,
    (p) => auditBuy(web, p, FRESH_ACCOUNT, star).ok,
  );
  const step = auditBuy(web, progress, FRESH_ACCOUNT, star);
  if (!step.ok) throw new Error(`cannot own ${star}: ${step.refusal.reason}`);
  return step.progress;
}

/** 16 readings of `star` whose medians are `with` and `without`. */
const readings = (
  star: string,
  read: (seed: number) => Pick<KeystoneReading, 'with' | 'without'> & { refused?: string },
): Record<string, JobResult> =>
  Object.fromEntries(
    Array.from({ length: KEYSTONE_SEEDS }, (_, seed) => {
      const { refused = null, ...xs } = read(seed);
      const result: KeystoneReading = {
        character: 'fire',
        star,
        seed,
        route: ['a', 'b'],
        refused,
        ...xs,
      };
      return [keystoneUnitId('fire', star, seed), { kind: 'measure', measure: 'keystone', result }];
    }),
  );

const rowOf = (rows: readonly CheckResult[], star = STAR): CheckResult => {
  const row = rows.find((candidate) => candidate.subject === `fire × ${star}`);
  if (row === undefined) throw new Error(`no row for ${star}`);
  return row;
};

/** x = 10 + Σ ranks + 4 for the ★: a ★ worth +5 with its own rank. */
const plusFive =
  (star: string): MeasureProbe =>
  (at, progress) =>
    10 + purchasesOf(at, progress) + (storedRank(progress, star) > 0 ? 4 : 0);

describe('keystones (關鍵天賦)', () => {
  it("lists each character's center ★ and each open outer's, not the hub's", () => {
    expect(keystoneTargets(B1, ['fire']).map((target) => target.star)).toEqual([
      'fire.center.main.star-one',
      'fire.center.main.star-two',
      'outer.poison.main.star',
      'outer.crit.main.star',
      'outer.ice.main.star',
      'outer.summon.main.star',
    ]);
    expect(keystoneTargets(B1, ['fire'])[0]).toEqual({
      character: 'fire',
      star: STAR,
      slug: 'star-one',
      board: 'fire.center',
    });
  });

  it('passes a gain from +4 to +6 waves, both ends in, and FAILs past either', () => {
    const status = (gain: number): string =>
      rowOf(
        keystonesCheck(
          onePlan,
          merged(
            withSnapshot(auditStart(web, false)),
            readings(STAR, () => ({ with: 10 + gain, without: 10 })),
          ),
        ),
      ).status;
    expect([KEYSTONE_GAIN.low, KEYSTONE_GAIN.high, 3.99, 6.01].map(status)).toEqual([
      'pass',
      'pass',
      'FAIL',
      'FAIL',
    ]);
  });

  it('takes the medians over the seeds, a gamble as info, and reads the snapshot it names', () => {
    const results = merged(
      withSnapshot(auditStart(web, false), 1),
      readings(STAR, (seed) => ({ with: seed === 0 ? 100 : 15, without: 10 })),
    );
    expect(rowOf(keystonesCheck(onePlan, results))).toMatchObject({
      status: 'pass',
      measured:
        "+5 (x 15 with, 10 without; session 1's prestige point, 2 route and gate purchases)",
      evidence: [`keystones.csv: fire ${STAR}`],
    });
    expect(rowOf(keystonesCheck(onePlan, results, ['star-one'])).status).toBe('info');
    // The gain is median x(with) − median x(without), 27.5 − 22.5: the median of the seeds'
    // differences (7 on 14 of them) would FAIL.
    const crossed = merged(
      withSnapshot(auditStart(web, false)),
      readings(STAR, (seed) => ({ with: 20 + ((seed + 2) % KEYSTONE_SEEDS), without: 15 + seed })),
    );
    expect(rowOf(keystonesCheck(onePlan, crossed))).toMatchObject({
      status: 'pass',
      measured: expect.stringMatching(/^\+5 \(x 27\.5 with, 22\.5 without; session 0's/),
    });
  });

  it('is noData without a prestige point, a seed short or a purchase refused', () => {
    const reason = (results: UnitResults): string | undefined =>
      rowOf(keystonesCheck(onePlan, results)).reason?.detail;
    const all = readings(STAR, () => ({ with: 15, without: 10 }));
    expect(reason(merged(sessionResults([sessionResult('fire', 0)]), all))).toBe(
      'no default session of fire reached the prestige point',
    );
    const short = { ...all };
    delete short[keystoneUnitId('fire', STAR, 15)];
    expect(reason(merged(withSnapshot(auditStart(web, false)), short))).toBe(
      '15 of 16 seeds measured',
    );
    expect(
      reason(
        merged(
          withSnapshot(auditStart(web, false)),
          readings(STAR, () => ({ with: null, without: null, refused: `${STAR}: keystoneCap` })),
        ),
      ),
    ).toBe(`a purchase is refused on session 0's prestige point: ${STAR}: keystoneCap`);
  });

  it("derives the ★ units from the lowest session's prestige point, the same 16 seeds for any session", () => {
    const progress = auditStart(web, false);
    const units = keystoneUnits(plan, withSnapshot(progress, 1));
    expect(units).toHaveLength(plan.keystones.length * KEYSTONE_SEEDS);
    expect(units[0]).toEqual({
      id: `measure:keystone:fire:${STAR}:0`,
      job: {
        kind: 'measure',
        measure: 'keystone',
        input: {
          content: B1,
          character: 'fire',
          star: STAR,
          snapshot: progress,
          account: FRESH_ACCOUNT,
          economy: DEFAULT_WEB_ECONOMY,
          seed: 0,
        },
      },
    });
    const seeds = units
      .slice(0, KEYSTONE_SEEDS)
      .map((unit) =>
        unit.job.kind === 'measure' && 'seed' in unit.job.input ? unit.job.input.seed : -1,
      );
    expect(seeds).toEqual(Array.from({ length: KEYSTONE_SEEDS }, (_, s) => s));
    expect(derivedUnits(plan, withSnapshot(progress, 1))).toEqual(units);
    expect(keystoneUnits(plan, withSnapshot(progress, 5))).toEqual([]);
    // Both sessions at their prestige point: the lowest one's snapshot.
    const later = { ...progress, runs: progress.runs + 1 };
    const both = sessionResults(
      [progress, later].map((snap, s) =>
        sessionResult('fire', s, { stop: 'prestigePoint', snapshots: [snapshot(snap)] }),
      ),
    );
    expect(keystoneUnits(plan, both).map((unit) => unit.job)).toEqual(
      units.map((unit) => unit.job),
    );
    const pr = checkSet('pr', fixtureContent('B1'), B1, { c7: NO_C7 });
    expect(keystoneUnits(pr, withSnapshot(progress))).toEqual([]);
  });

  it("derives each character's ★ units from its own prestige point", () => {
    const B2 = { fixture: 'B2' } as const;
    const two = checkSet('nightly', fixtureContent('B2'), B2, { c7: NO_C7 });
    const own = (character: 'fire' | 'summon'): CharacterProgress =>
      auditStart(webOf(B2, character, 'full'), false);
    const results = sessionResults(
      (['fire', 'summon'] as const).map((character) =>
        sessionResult(character, 0, {
          stop: 'prestigePoint',
          snapshots: [snapshot(own(character))],
        }),
      ),
    );
    const units = keystoneUnits(two, results);
    for (const character of ['fire', 'summon'] as const) {
      const snapshots = units.flatMap((unit) =>
        unit.job.kind === 'measure' &&
        'star' in unit.job.input &&
        unit.job.input.character === character
          ? [unit.job.input.snapshot]
          : [],
      );
      const stars = two.keystones.filter((target) => target.character === character).length;
      expect(stars).toBeGreaterThan(0);
      expect(snapshots).toHaveLength(stars * KEYSTONE_SEEDS);
      expect(new Set(snapshots.map((progress) => progress.character))).toEqual(
        new Set([character]),
      );
    }
  });

  it("measures on a session's prestige-point snapshot, never an earlier one", () => {
    const progress = auditStart(web, false);
    const early: SessionSnapshot = {
      minutes: 10,
      progress: { ...progress, runs: progress.runs + 3 },
      earned: { shards: 0, cores: 0 },
    };
    const units = keystoneUnits(
      onePlan,
      sessionResults([
        sessionResult('fire', 0, { snapshots: [early] }),
        sessionResult('fire', 1, { stop: 'prestigePoint', snapshots: [early, snapshot(progress)] }),
      ]),
    );
    expect(units).toHaveLength(KEYSTONE_SEEDS);
    expect(units[0]?.job).toMatchObject({ input: { snapshot: progress } });
    // Minute snapshots alone: no prestige point, so no units and a noData row.
    const minutesOnly = sessionResults([sessionResult('fire', 0, { snapshots: [early] })]);
    expect(keystoneUnits(onePlan, minutesOnly)).toEqual([]);
    const all = readings(STAR, () => ({ with: 15, without: 10 }));
    expect(rowOf(keystonesCheck(onePlan, merged(minutesOnly, all))).reason?.id).toBe('noData');
  });

  it("reads each ★'s own 16 readings, whatever order they come in", () => {
    const second = 'fire.center.main.star-two';
    const two: CheckPlan = { ...plan, keystones: plan.keystones.slice(0, 2) };
    const results = merged(
      withSnapshot(auditStart(web, false)),
      readings(second, () => ({ with: 20, without: 10 })),
      readings(STAR, () => ({ with: 15, without: 10 })),
    );
    const rows = keystonesCheck(two, results);
    expect(rowOf(rows)).toMatchObject({
      status: 'pass',
      measured: expect.stringMatching(/^\+5 \(x 15 with, 10 without;/),
    });
    expect(rowOf(rows, second)).toMatchObject({
      status: 'FAIL',
      measured: expect.stringMatching(/^\+10 \(x 20 with, 10 without;/),
    });
  });

  it('measures each seed on deriveSeed(C10_SEED, keystone:s), whatever the session', () => {
    const seen: number[] = [];
    const probe: MeasureProbe = (_web, _progress, seed) => {
      seen.push(seed);
      return 0;
    };
    const input = {
      content: B1,
      character: 'fire' as const,
      star: STAR,
      snapshot: auditStart(web, false),
      account: FRESH_ACCOUNT,
      economy: DEFAULT_WEB_ECONOMY,
    };
    measureKeystone({ ...input, seed: 3 }, probe);
    expect(seen).toEqual([keystoneSeed(3), keystoneSeed(3)]);
    expect(keystoneSeed(3)).toBe(deriveSeed(C10_SEED, 'keystone:3'));
  });

  it('passes a ★ a +5 stub probe values at +5: the route is in both builds (no ★ has a gate as built)', () => {
    const reading = measureKeystone(
      {
        content: B1,
        character: 'fire',
        star: STAR,
        snapshot: auditStart(web, false),
        account: FRESH_ACCOUNT,
        economy: DEFAULT_WEB_ECONOMY,
        seed: 0,
      },
      plusFive(STAR),
    );
    expect(reading.refused).toBeNull();
    // The route to the ★ and its gate's fill are bought in both.
    expect(reading.route.length).toBeGreaterThanOrEqual(2);
    expect((reading.with as number) - (reading.without as number)).toBe(5);
    const results = merged(
      withSnapshot(auditStart(web, false)),
      readings(STAR, () => ({ with: reading.with, without: reading.without })),
    );
    expect(rowOf(keystonesCheck(onePlan, results)).status).toBe('pass');
  });

  it('refunds the ★ a snapshot owns before it measures it', () => {
    const owned = owning(STAR);
    expect(storedRank(owned, STAR)).toBe(1);
    const reading = measureKeystone(
      {
        content: B1,
        character: 'fire',
        star: STAR,
        snapshot: owned,
        account: FRESH_ACCOUNT,
        economy: DEFAULT_WEB_ECONOMY,
        seed: 0,
      },
      plusFive(STAR),
    );
    expect([reading.refused, reading.route]).toEqual([null, []]);
    expect((reading.with as number) - (reading.without as number)).toBe(5);
  });

  it('reports a ★ the cap refuses instead of measuring it', () => {
    // Both center ★ owned: the keystone cap's 2.
    const both = mergeRanks(owning('fire.center.main.star-two'), owning(STAR));
    const reading = measureKeystone(
      {
        content: B1,
        character: 'fire',
        star: 'outer.ice.main.star',
        snapshot: both,
        account: FRESH_ACCOUNT,
        economy: DEFAULT_WEB_ECONOMY,
        seed: 0,
      },
      plusFive('outer.ice.main.star'),
    );
    expect(reading).toMatchObject({ with: null, without: null });
    expect(reading.refused).toBe('outer.ice.main.star: keystoneCap');
  });

  it('FAILs the fixture, whose ★ have no effect: gain 0 on 16 probe seeds', () => {
    const first = withSnapshot(auditStart(web, false));
    const units = derivedUnits(onePlan, first);
    expect(units).toHaveLength(KEYSTONE_SEEDS);
    const results = merged(
      first,
      Object.fromEntries(units.map((unit) => [unit.id, runJob(unit.job)])),
    );
    const row = rowOf(evaluate({ ...onePlan, checks: ['keystones'] }, results));
    expect(row.status).toBe('FAIL');
    expect(row.measured).toMatch(
      /^\+0 \(x [\d.]+ with, [\d.]+ without; session 0's prestige point/,
    );
    const csv = keystonesCsv(onePlan, results).trimEnd().split('\n');
    expect(csv[0]).toBe('character,star,slug,session,seed,with,without,gain,route,refused');
    expect(csv).toHaveLength(1 + KEYSTONE_SEEDS);
    expect(csv[1]).toMatch(/^fire,fire\.center\.main\.star-one,star-one,0,0,[\d.]+,[\d.]+,0,/);
  });
});

/** `a` with `b`'s ranks too, the wallet and spends of `a`. */
function mergeRanks(a: CharacterProgress, b: CharacterProgress): CharacterProgress {
  return { ...a, ranks: { ...b.ranks, ...a.ranks } };
}
