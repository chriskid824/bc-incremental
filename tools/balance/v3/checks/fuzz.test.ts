import { describe, expect, it } from 'vitest';
import { characterGameData } from '../../../../src/data';
import { fixtureContent } from '../../../../src/data/web/testing';
import {
  runWebFuzz,
  WEB_FUZZ_BUILDS,
  WEB_FUZZ_SEED,
  WEB_FUZZ_TICKS,
} from '../../../../src/meta/web/fuzz';
import type { JobResult } from '../../jobs';
import { resolveContent } from '../content';
import { fuzzCheck, fuzzUnitId, fuzzUnits, fuzzWebNames, measureFuzz } from './fuzz';
import type { FuzzInput, FuzzReading } from './fuzz';
import { checkSet } from './run';
import { NO_C7 } from './testing';
import type { CheckPlan, UnitResults } from './types';

const B1 = { fixture: 'B1' } as const;
const SEED = WEB_FUZZ_SEED + 0x4978_13;

/** The nightly's B1 plan at SEED, as nightly.ts plans it for a commit 497813…. */
const plan: CheckPlan = checkSet('nightly', fixtureContent('B1'), B1, {
  c7: NO_C7,
  fuzzSeed: SEED,
});
const fuzz = plan.units.filter(
  (unit) => unit.job.kind === 'measure' && unit.job.measure === 'fuzz',
);

/** Every fuzz unit read clean, then `failing` builds with one failure each. */
function fuzzResults(failing: readonly string[] = []): UnitResults {
  const results: Record<string, JobResult> = {};
  for (const unit of fuzz) {
    const { only } = (unit.job.kind === 'measure' ? unit.job.input : null) as FuzzInput;
    const result: FuzzReading = {
      name: only,
      runs: 2,
      ticks: 100,
      stopped: failing.includes(only),
      highestWaveCleared: 3,
      failures: failing.includes(only)
        ? [
            {
              kind: 'budget',
              text: 'over budget',
              repro: `npm run fuzz:web -- --fixture --seed ${SEED} --only ${only}`,
              ids: [],
            },
          ]
        : [],
    };
    results[unit.id] = { kind: 'measure', measure: 'fuzz', result };
  }
  return results;
}

describe('fuzz (the nightly web fuzz)', () => {
  it("deals WEB_FUZZ_BUILDS builds over fuzz:web's webs at the plan's seed", () => {
    const webs = fuzzWebNames(fixtureContent('B1'));
    expect(webs.length).toBeGreaterThan(0);
    expect(fuzz).toHaveLength(WEB_FUZZ_BUILDS);
    expect(fuzz.slice(0, 2)).toEqual(
      [0, 1].map((i) => ({
        id: fuzzUnitId(`${webs[i % webs.length] as string}.${i}`),
        job: {
          kind: 'measure',
          measure: 'fuzz',
          input: { content: B1, seed: SEED, only: `${webs[i % webs.length] as string}.${i}` },
        },
      })),
    );
    // No web on the registered content before B1: no unit.
    expect(fuzzUnits(resolveContent('registered'), 'registered', SEED)).toEqual([]);
    // The pr set points at ci.yml's step instead.
    const pr = checkSet('pr', fixtureContent('B1'), B1, { c7: NO_C7 });
    expect(
      pr.units.filter((unit) => unit.job.kind === 'measure' && unit.job.measure === 'fuzz'),
    ).toEqual([]);
  });

  it("runs one build exactly as fuzz:web's full run draws it", () => {
    const content = fixtureContent('B1');
    const index = 3;
    const unit = fuzz[index];
    const input = (unit?.job.kind === 'measure' ? unit.job.input : null) as FuzzInput;
    const reading = measureFuzz(input);
    const full = runWebFuzz({
      content,
      data: characterGameData(),
      builds: index + 1,
      ticks: WEB_FUZZ_TICKS,
      seed: SEED,
      fixture: true,
    });
    const line = full.builds[index];
    expect(reading).toEqual({
      name: line?.name,
      runs: line?.runs,
      ticks: line?.ticks,
      stopped: line?.stopped,
      highestWaveCleared: line?.highestWaveCleared,
      failures: [],
    });
    expect(reading.name).toBe(input.only);
  }, 60_000);

  it('passes with no failure; FAILs naming each repro line, its seed in it; noData while a build is unread', () => {
    expect(fuzzCheck(plan, fuzzResults())).toMatchObject([
      {
        subject: 'all',
        status: 'pass',
        target: expect.stringContaining(`seed ${SEED}`) as string,
        measured: `${WEB_FUZZ_BUILDS} builds, ${2 * WEB_FUZZ_BUILDS} runs, ${100 * WEB_FUZZ_BUILDS} ticks, 0 stopped early; no failure`,
      },
    ]);
    const names = fuzz
      .slice(0, 12)
      .map((unit) => (unit.job.kind === 'measure' ? (unit.job.input as FuzzInput).only : ''));
    const [row] = fuzzCheck(plan, fuzzResults(names));
    expect(row).toMatchObject({
      status: 'FAIL',
      measured: expect.stringMatching(
        /12 stopped early; 12 failures \(budget\) in 12 builds$/,
      ) as string,
    });
    expect(row?.evidence).toHaveLength(11);
    expect(row?.evidence[0]).toBe(
      `budget: npm run fuzz:web -- --fixture --seed ${SEED} --only ${names[0] as string}`,
    );
    expect(row?.evidence[10]).toBe('… and 2 more');
    const unread = fuzzResults();
    delete (unread as Record<string, JobResult>)[fuzz[0]?.id as string];
    expect(fuzzCheck(plan, unread)).toMatchObject([
      {
        status: 'n/a',
        reason: { id: 'noData', detail: `${WEB_FUZZ_BUILDS - 1} of ${WEB_FUZZ_BUILDS} builds run` },
      },
    ]);
  });
});
