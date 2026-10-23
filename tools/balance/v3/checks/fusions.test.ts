import { describe, expect, it } from 'vitest';
import { deriveSeed } from '../../../../src/core/rng';
import { characterGameData } from '../../../../src/data';
import { assembleWeb, FULL_SCOPE } from '../../../../src/data/web';
import type { CalibrationEntry, Content, FusionKey } from '../../../../src/data/web';
import { fixtureContent } from '../../../../src/data/web/testing';
import { calibrateFusion, CALIBRATION_SEED, median } from '../../../../src/meta/web/calibrate';
import { runJob } from '../../jobs';
import type { JobResult } from '../../jobs';
import { measureStrength, strengthSeed } from '../measures';
import type { MeasureProbe, StrengthReading } from '../measures';
import {
  fusionStrengthCheck,
  STRENGTH_BAND,
  STRENGTH_DRIFT,
  strengthTargets,
  strengthUnitId,
} from './fusions';
import { checkSet, evaluate, exitCodeOf } from './run';
import { NO_C7 } from './testing';
import type { CheckResult } from './types';

const B5 = { fixture: 'B5' } as const;
const KEY: FusionKey = 'fire.crit';
const fixture = fixtureContent('B5');
const digest = assembleWeb(fixture, 'fire', FULL_SCOPE).fusions.get('crit')?.digest as string;

/** A ratio as calibrateFusion's entry keeps it: 4 decimals. */
const kept = (value: number): number => Math.round(value * 1e4) / 1e4;

/** The next double above (+1) or below (−1) a positive `value`. */
function floatStep(value: number, by: 1 | -1): number {
  const bits = new BigInt64Array(new Float64Array([value]).buffer);
  bits[0] = (bits[0] as bigint) + BigInt(by);
  return new Float64Array(bits.buffer)[0] as number;
}

const entry = (overrides: Partial<CalibrationEntry> = {}): CalibrationEntry => ({
  coef: 0.5,
  status: 'ok',
  median: 1.2,
  min: 1.1,
  max: 1.3,
  seeds: 2,
  startWave: 1,
  digest,
  ...overrides,
});

/** The fixture with fire.crit calibrated as `calibration` and, with `accepted`, its FAIL accepted. */
const content = (calibration: CalibrationEntry, accepted?: string): Content => ({
  ...fixture,
  calibrated: { [KEY]: calibration },
  acceptedFails: accepted === undefined ? {} : { [KEY]: accepted },
});

/** Each seed's reading of fire.crit, as its strength units' results. */
const strengthResults = (ratios: readonly number[]): Record<string, JobResult> =>
  Object.fromEntries(
    ratios.map((ratio, seed) => {
      const result: StrengthReading = { key: KEY, seed, base: 10, with: 11, ratio };
      return [strengthUnitId(KEY, seed), { kind: 'measure', measure: 'fusionStrength', result }];
    }),
  );

const strengthRow = (
  calibration: CalibrationEntry,
  ratios: readonly number[],
  accepted?: string,
): CheckResult => {
  const plan = checkSet('pr', content(calibration, accepted), B5, { c7: NO_C7 });
  const row = fusionStrengthCheck(plan, strengthResults(ratios)).find((r) => r.subject === KEY);
  if (row === undefined) throw new Error('no fire.crit row');
  return row;
};

describe('fusionStrength (融合強度)', () => {
  it('re-measures a fixture fusion calibrated here to its median, min and max exactly', () => {
    const data = characterGameData();
    const calibration = calibrateFusion(fixture, KEY, data, { seeds: 2 });
    const { entry: calibrated } = calibration;
    const readings = Array.from({ length: calibrated.seeds }, (_, seed) =>
      measureStrength({ content: B5, key: KEY, coef: calibrated.coef, seed }),
    );
    const ratios = readings.map((reading) => reading.ratio);
    expect([kept(median(ratios)), kept(Math.min(...ratios)), kept(Math.max(...ratios))]).toEqual([
      calibrated.median,
      calibrated.min,
      calibrated.max,
    ]);
    expect(readings.map((reading) => reading.base)).toEqual(calibration.baseFrontiers);

    // The same through the pr plan's units and the check: the entry's own ratios, this fixture's
    // spread FAILing unless accepted.
    const plan = checkSet('pr', content(calibrated), B5, { c7: NO_C7 });
    const units = plan.units.filter((unit) => unit.job.kind === 'measure');
    expect(units.map((unit) => unit.id)).toEqual([strengthUnitId(KEY, 0), strengthUnitId(KEY, 1)]);
    const results = Object.fromEntries(units.map((unit) => [unit.id, runJob(unit.job)]));
    const row = evaluate(plan, results).find((r) => r.subject === KEY);
    expect(row?.measured).toMatch(
      new RegExp(
        `^median ${calibrated.median} \\(min ${calibrated.min}, max ${calibrated.max}; entry ` +
          `${calibrated.median}\\)`,
      ),
    );
  });

  it("measures on calibrateFusion's seeds, deriveSeed(CALIBRATION_SEED, calibrate:s)", () => {
    const seen: number[] = [];
    const probe: MeasureProbe = (_web, _progress, seed) => {
      seen.push(seed);
      return 10;
    };
    measureStrength({ content: B5, key: KEY, coef: 0.5, seed: 1 }, probe);
    expect(seen).toEqual([strengthSeed(1), strengthSeed(1)]);
    expect(strengthSeed(1)).toBe(deriveSeed(CALIBRATION_SEED, 'calibrate:1'));
  });

  it('passes every seed in [1.1, 1.3], both ends in, and FAILs one float step outside', () => {
    expect([STRENGTH_BAND.min, STRENGTH_BAND.max]).toEqual([1.1, 1.3]);
    expect(strengthRow(entry(), [1.1, 1.3])).toMatchObject({
      status: 'pass',
      measured: 'median 1.2 (min 1.1, max 1.3; entry 1.2)',
      evidence: ['checks.json: seeds 1.1 1.3'],
    });
    expect(strengthRow(entry(), [floatStep(1.1, -1), 1.2]).status).toBe('FAIL');
    expect(strengthRow(entry(), [1.2, floatStep(1.3, 1)])).toMatchObject({
      status: 'FAIL',
      measured: 'median 1.25 (min 1.2, max 1.3; entry 1.2); 1 seed outside; drifted from 1.2',
    });
  });

  it("FAILs a stale digest, prints an accepted key's reason and does not fail on it", () => {
    const stale = strengthRow(entry({ digest: 'old' }), [1.2, 1.2]);
    expect(stale).toMatchObject({
      status: 'FAIL',
      measured: `median 1.2 (min 1.2, max 1.2; entry 1.2); digest stale (old → ${digest})`,
    });
    const accepted = strengthRow(entry(), [1.05, 1.2], 'C6 spread, Hoshi 10/20');
    expect(accepted).toMatchObject({ status: 'FAIL', accepted: 'C6 spread, Hoshi 10/20' });
    expect(exitCodeOf([accepted])).toBe(0);
    expect(exitCodeOf([stale])).toBe(1);
    // Accepted marks only a FAIL.
    expect(strengthRow(entry(), [1.2, 1.2], 'unused').accepted).toBeUndefined();
  });

  it('is info past STRENGTH_DRIFT from the entry, pass within it', () => {
    const at = (ratio: number): string => strengthRow(entry(), [ratio, ratio]).status;
    expect(at(1.2 + STRENGTH_DRIFT - 0.001)).toBe('pass');
    expect(at(1.2 + STRENGTH_DRIFT + 0.001)).toBe('info');
    expect(at(1.2 - STRENGTH_DRIFT - 0.001)).toBe('info');
  });

  it("is info by its distance from the entry's median, not from the band's middle", () => {
    // An entry at 1.15: a re-measure at 1.15 passes; one at 1.2, the band's middle, has drifted.
    expect(strengthRow(entry({ median: 1.15 }), [1.15, 1.15]).status).toBe('pass');
    expect(strengthRow(entry({ median: 1.15 }), [1.2, 1.2])).toMatchObject({
      status: 'info',
      measured: 'median 1.2 (min 1.2, max 1.2; entry 1.15); drifted from 1.15',
    });
  });

  it('reads the first hand and template fusions with entries; uncalibrated ones by the first', () => {
    const fusions = [...assembleWeb(fixture, 'fire', FULL_SCOPE).fusions.values()];
    const firstHand = fusions.find((fusion) => fusion.kind === 'hand')?.key;
    const firstTemplate = fusions.find((fusion) => fusion.kind !== 'hand')?.key;
    expect([firstHand, firstTemplate]).toEqual(['fire.lightning', 'fire.poison']);
    const none = strengthTargets(fixture, ['fire', 'ice']);
    expect(none.map(({ group, key, entry: e }) => [group, key, e])).toEqual([
      ['hand', 'fire.lightning', null],
      ['template', 'fire.poison', null],
    ]);
    const plan = checkSet('pr', fixture, B5, { c7: NO_C7 });
    expect(evaluate(plan, {}).filter((row) => row.id === 'fusionStrength')).toMatchObject([
      { subject: 'fire.lightning', status: 'n/a', reason: { id: 'uncalibrated' } },
      { subject: 'fire.poison', status: 'n/a', reason: { id: 'uncalibrated' } },
    ]);
    const calibrated: Content = {
      ...fixture,
      calibrated: { 'ice.fire': entry(), 'fire.summon': entry(), 'fire.crit': entry() },
    };
    expect(strengthTargets(calibrated, ['fire', 'ice']).map((target) => target.key)).toEqual([
      'fire.summon',
      'fire.crit',
    ]);
  });

  it('reads each calibrated fusion by its own seeds and its own entry', () => {
    const summon = assembleWeb(fixture, 'fire', FULL_SCOPE).fusions.get('summon')?.digest as string;
    const two: Content = {
      ...fixture,
      calibrated: {
        'fire.summon': entry({ median: 1.15, digest: summon }),
        [KEY]: entry({ median: 1.25 }),
      },
    };
    const seeds = (key: FusionKey, ratio: number): Record<string, JobResult> =>
      Object.fromEntries(
        [0, 1].map((seed) => {
          const result: StrengthReading = { key, seed, base: 10, with: 11, ratio };
          return [
            strengthUnitId(key, seed),
            { kind: 'measure', measure: 'fusionStrength', result },
          ];
        }),
      );
    const plan = checkSet('pr', two, B5, { c7: NO_C7 });
    const rows = fusionStrengthCheck(plan, { ...seeds('fire.summon', 1.15), ...seeds(KEY, 1.25) });
    expect(rows.map((row) => [row.subject, row.status, row.measured])).toEqual([
      ['fire.summon', 'pass', 'median 1.15 (min 1.15, max 1.15; entry 1.15)'],
      [KEY, 'pass', 'median 1.25 (min 1.25, max 1.25; entry 1.25)'],
    ]);
  });

  it('is noData while a seed has no reading', () => {
    expect(strengthRow(entry(), [1.2])).toMatchObject({
      status: 'n/a',
      reason: { id: 'noData', detail: '1 of 2 seeds measured' },
    });
  });
});
