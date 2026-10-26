import { describe, expect, it } from 'vitest';
import { deriveSeed } from '../../../../src/core/rng';
import { characterGameData, stdHpAt } from '../../../../src/data';
import type { CharacterId, OuterId, SourceClass } from '../../../../src/data';
import { assembleWeb, FULL_SCOPE } from '../../../../src/data/web';
import type { CalibrationEntry, Content, FusionKey } from '../../../../src/data/web';
import { fixtureContent } from '../../../../src/data/web/testing';
import type { CharacterProgress } from '../../../../src/meta/web';
import {
  CALIBRATION_ACCOUNT,
  calibrateFusion,
  CALIBRATION_SEED,
  median,
  probeRun,
} from '../../../../src/meta/web/calibrate';
import { storedRank } from '../../../../src/meta/web/counts';
import { unlockInvestment } from '../../../../src/meta/web/invest';
import { runJob } from '../../jobs';
import type { JobResult } from '../../jobs';
import { webOf } from '../content';
import {
  COMBO_ACCOUNTS,
  comboSeed,
  measureCombo,
  measureMirror,
  measureStrength,
  strengthSeed,
} from '../measures';
import type {
  ComboInput,
  ComboReading,
  MeasureProbe,
  MirrorReading,
  StrengthInput,
  StrengthReading,
} from '../measures';
import {
  COMBO_FAIL_RATIO,
  COMBO_LISTED,
  comboName,
  comboUnits,
  combinations,
  DOUBLE_SEEDS,
  doublesCheck,
  doublesCsv,
  fusionsCsv,
  fusionStrengthCheck,
  MIRROR_MIN_L1,
  MIRROR_PAIRS,
  mirrorsCheck,
  mirrorUnitId,
  STRENGTH_BAND,
  STRENGTH_DRIFT,
  strengthTargets,
  strengthUnitId,
  TRIPLE_SEEDS,
  triplesCheck,
} from './fusions';
import { checkSet, evaluate, exitCodeOf } from './run';
import { measureResults, NO_C7, rowWith } from './testing';
import type { CheckPlan, CheckResult, UnitResults } from './types';

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

/**
 * fire.crit's row in the pr set, which reads it as its first calibrated template fusion; the
 * nightly, which reads every calibrated entry (lead ruling U3), must give the same row.
 */
const strengthRow = (
  calibration: CalibrationEntry,
  ratios: readonly number[],
  accepted?: string,
): CheckResult => {
  const [pr, nightly] = (['pr', 'nightly'] as const).map((set) => {
    const plan = checkSet(set, content(calibration, accepted), B5, { c7: NO_C7 });
    const row = fusionStrengthCheck(plan, strengthResults(ratios)).find((r) => r.subject === KEY);
    if (row === undefined) throw new Error(`no fire.crit row in the ${set} set`);
    return row;
  }) as [CheckResult, CheckResult];
  expect({ ...nightly, set: 'pr' }).toEqual(pr);
  return pr;
};

describe('fusionStrength (融合強度)', () => {
  it('re-measures every fixture fusion calibrated here to its median, min and max exactly (OWN 2)', () => {
    // Two template fusions calibrated: the pr set reads the first (C10.2), the nightly both.
    const data = characterGameData();
    const keys: readonly FusionKey[] = [KEY, 'summon.crit'];
    const calibrations = keys.map((key) => calibrateFusion(fixture, key, data, { seeds: 2 }));
    const two: Content = {
      ...fixture,
      calibrated: Object.fromEntries(keys.map((key, i) => [key, calibrations[i]?.entry])),
    };
    keys.forEach((key, i) => {
      const calibration = calibrations[i] as (typeof calibrations)[number];
      const { entry: calibrated } = calibration;
      const readings = Array.from({ length: calibrated.seeds }, (_, seed) =>
        measureStrength({ content: B5, key, coef: calibrated.coef, seed }),
      );
      const ratios = readings.map((reading) => reading.ratio);
      expect([kept(median(ratios)), kept(Math.min(...ratios)), kept(Math.max(...ratios))]).toEqual([
        calibrated.median,
        calibrated.min,
        calibrated.max,
      ]);
      expect(readings.map((reading) => reading.base)).toEqual(calibration.baseFrontiers);
    });

    // The same through each plan's units and the check: the entries' own ratios, this fixture's
    // spread FAILing unless accepted.
    const strength = (plan: CheckPlan) =>
      plan.units.filter(
        (unit) => unit.job.kind === 'measure' && unit.job.measure === 'fusionStrength',
      );
    const pr = checkSet('pr', two, B5, { c7: NO_C7 });
    expect(strength(pr).map((unit) => unit.id)).toEqual([
      strengthUnitId(KEY, 0),
      strengthUnitId(KEY, 1),
    ]);
    const nightly = checkSet('nightly', two, B5, { c7: NO_C7 });
    const units = strength(nightly);
    expect(units.map((unit) => unit.id)).toEqual(
      keys.flatMap((key) => [strengthUnitId(key, 0), strengthUnitId(key, 1)]),
    );
    const results = Object.fromEntries(units.map((unit) => [unit.id, runJob(unit.job)]));
    const rows = evaluate(nightly, results).filter((row) => row.id === 'fusionStrength');
    keys.forEach((key, i) => {
      const { entry: calibrated } = calibrations[i] as (typeof calibrations)[number];
      expect(rowWith(rows, key).measured).toMatch(
        new RegExp(
          `^median ${calibrated.median} \\(min ${calibrated.min}, max ${calibrated.max}; entry ` +
            `${calibrated.median}\\)`,
        ),
      );
    });
    // Every other fusion of the four characters: uncalibrated.
    expect(rows).toHaveLength(4 * 11);
    expect(rows.filter((row) => row.reason?.id === 'uncalibrated')).toHaveLength(4 * 11 - 2);
  }, 30_000);

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

  it('passes every seed in [1.1, 1.3], both ends in, and FAILs one float step outside (OWN 3)', () => {
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

  it("FAILs a stale digest, prints an accepted key's reason and does not fail on it (OWN 3)", () => {
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

  it('is noData for an entry with seeds: 0, never a throw (lead ruling U16)', () => {
    expect(strengthRow(entry({ seeds: 0 }), [])).toMatchObject({
      status: 'n/a',
      reason: { id: 'noData', detail: 'the entry has seeds: 0, so there is nothing to re-measure' },
    });
    expect(
      checkSet('nightly', content(entry({ seeds: 0 })), B5, { c7: NO_C7 }).units,
    ).not.toContainEqual(expect.objectContaining({ id: strengthUnitId(KEY, 0) }));
  });

  it("is one noData row when the nightly's webs have no fusion", () => {
    const registered = checkSet('nightly', { ...fixtureContent('B1'), outers: {} }, B5, {
      c7: NO_C7,
    });
    expect(registered.strength).toEqual([]);
    expect(fusionStrengthCheck(registered, {})).toMatchObject([
      { subject: 'all', status: 'n/a', reason: { id: 'noData', detail: 'no fusion in the webs' } },
    ]);
  });
});

// ---- 鏡像融合 ----

type Damage = Readonly<Record<SourceClass, number>>;
const damage = (fields: Partial<Damage>): Damage => ({
  center: 0,
  outer: 0,
  fusion: 0,
  hub: 0,
  asc: 0,
  ...fields,
});

/** B5 with 火召喚's pair calibrated on 2 seeds each: fire.summon and summon.fire. */
const pairContent: Content = {
  ...fixture,
  calibrated: { 'fire.summon': entry(), 'summon.fire': entry() },
};
const PAIR = 'fire.summon ↔ summon.fire';

/** The mirror units' results: each seed of fire.summon dealing `a`, of summon.fire `b`. */
const mirrorResults = (plan: CheckPlan, a: Partial<Damage>, b: Partial<Damage>): UnitResults =>
  measureResults(plan.units, (measure, input) => {
    if (measure !== 'mirror') return null;
    const { key, seed } = input as StrengthInput;
    const reading: MirrorReading = {
      key,
      seed,
      damage: damage(key === 'fire.summon' ? a : b),
      highestWaveCleared: 10,
      ticks: 600,
    };
    return reading;
  });

/** The pair's mirrors row on the nightly plan of pairContent. */
const mirrorRow = (a: Partial<Damage>, b: Partial<Damage>): CheckResult => {
  const plan = checkSet('nightly', pairContent, B5, { c7: NO_C7 });
  return rowWith(mirrorsCheck(plan, mirrorResults(plan, a, b)), PAIR);
};

describe('mirrors (鏡像融合)', () => {
  // fire.summon's two seeds: center 6, hub 1, outer 2, fusion 1 of 10.
  const a = { center: 3, hub: 0.5, outer: 1, fusion: 0.5 };

  it('passes a pair whose class shares differ by L1 0.2, FAILs one at 0.19 (OWN 4)', () => {
    expect(MIRROR_MIN_L1).toBe(0.2);
    expect(mirrorRow(a, { center: 3, hub: 1, outer: 0.5, fusion: 0.5 })).toMatchObject({
      status: 'pass',
      measured:
        'L1 0.2; fire.summon: center + asc 0.6, hub 0.1, outer 0.2, fusion 0.1; ' +
        'summon.fire: center + asc 0.6, hub 0.2, outer 0.1, fusion 0.1',
      evidence: ['fusions.csv: fire.summon summon.fire'],
    });
    expect(mirrorRow(a, { center: 3, hub: 0.975, outer: 0.525, fusion: 0.5 })).toMatchObject({
      status: 'FAIL',
      measured: expect.stringMatching(/^L1 0\.19;/) as string,
    });
  });

  it("counts the ascendancy's damage with the center's: center + asc the largest share (OWN 4)", () => {
    // fire.summon: center 0.3 and asc 0.2 against outer 0.4: the center class is the largest.
    const withAsc = { center: 1.5, asc: 1, outer: 2, fusion: 0.5 };
    expect(mirrorRow(withAsc, { center: 3, hub: 1, outer: 0.5, fusion: 0.5 })).toMatchObject({
      status: 'pass',
      measured: expect.stringContaining(
        'fire.summon: center + asc 0.5, hub 0, outer 0.4',
      ) as string,
    });
    // Either fusion's center not the largest FAILs, whatever the distance.
    expect(mirrorRow(a, { center: 1, hub: 0.5, outer: 3, fusion: 0.5 }).status).toBe('FAIL');
    expect(mirrorRow({ center: 1, hub: 0.5, outer: 3, fusion: 0.5 }, a).status).toBe('FAIL');
  });

  it('compares shares, not damage: the same makeup at twice the damage FAILs', () => {
    const twice = { center: 6, hub: 1, outer: 2, fusion: 1 };
    expect(mirrorRow(a, twice)).toMatchObject({
      status: 'FAIL',
      measured: expect.stringMatching(/^L1 0;/),
    });
  });

  it('reads the six pairs both of whose fusions exist; an uncalibrated or unread one is n/a', () => {
    expect(MIRROR_PAIRS.map(([x, y]) => `${x} ${y}`)).toEqual([
      'fire.ice ice.fire',
      'fire.lightning lightning.fire',
      'fire.summon summon.fire',
      'ice.lightning lightning.ice',
      'ice.summon summon.ice',
      'lightning.summon summon.lightning',
    ]);
    const plan = checkSet('nightly', pairContent, B5, { c7: NO_C7 });
    // Each calibrated fusion of the pair on its two strength seeds.
    expect(
      plan.units.filter((unit) => unit.job.kind === 'measure' && unit.job.measure === 'mirror'),
    ).toEqual(
      (['fire.summon', 'summon.fire'] as const).flatMap((key) =>
        [0, 1].map((seed) => ({
          id: mirrorUnitId(key, seed),
          job: { kind: 'measure', measure: 'mirror', input: { content: B5, key, coef: 0.5, seed } },
        })),
      ),
    );
    const rows = mirrorsCheck(plan, mirrorResults(plan, a, a));
    expect(rows.map((row) => [row.subject, row.status, row.reason?.id])).toEqual([
      ['fire.ice ↔ ice.fire', 'n/a', 'uncalibrated'],
      ['fire.lightning ↔ lightning.fire', 'n/a', 'uncalibrated'],
      [PAIR, 'FAIL', undefined],
      ['ice.lightning ↔ lightning.ice', 'n/a', 'uncalibrated'],
      ['ice.summon ↔ summon.ice', 'n/a', 'uncalibrated'],
      ['lightning.summon ↔ summon.lightning', 'n/a', 'uncalibrated'],
    ]);
    const unread = mirrorResults(plan, a, a);
    delete (unread as Record<string, JobResult>)[mirrorUnitId('summon.fire', 1)];
    expect(rowWith(mirrorsCheck(plan, unread), PAIR)).toMatchObject({
      status: 'n/a',
      reason: { id: 'noData', detail: 'summon.fire: 1 of 2 seeds measured' },
    });
    const none: Content = {
      ...pairContent,
      calibrated: { 'fire.summon': entry({ seeds: 0 }), 'summon.fire': entry() },
    };
    const zero = checkSet('nightly', none, B5, { c7: NO_C7 });
    expect(rowWith(mirrorsCheck(zero, mirrorResults(zero, a, a)), PAIR)).toMatchObject({
      status: 'n/a',
      reason: {
        id: 'noData',
        detail: 'fire.summon: the entry has seeds: 0, so there is nothing to re-measure',
      },
    });
    const one = checkSet('nightly', fixtureContent('B1'), { fixture: 'B1' }, { c7: NO_C7 });
    expect(mirrorsCheck(one, {})).toMatchObject([
      { subject: 'all', status: 'n/a', reason: { id: 'oneCharacter' } },
    ]);
  });

  it("reads the strength measure's with-core run, as calibration's probe runs it", () => {
    const input: StrengthInput = { content: B5, key: KEY, coef: 0.5, seed: 1 };
    const runs: [AssembledWebOf, CharacterProgress, number][] = [];
    measureStrength(input, (web, progress, seed) => {
      runs.push([web, progress, seed]);
      return 10;
    });
    const [web, progress, seed] = runs[1] as [AssembledWebOf, CharacterProgress, number];
    const probe = probeRun(web, progress, seed, characterGameData());
    const mirror = measureMirror(input);
    expect(mirror).toMatchObject({
      key: KEY,
      seed: 1,
      highestWaveCleared: probe.highestWaveCleared,
      ticks: probe.ticks,
    });
    expect(Object.keys(mirror.damage).sort()).toEqual(['asc', 'center', 'fusion', 'hub', 'outer']);
    expect(mirror.damage.fusion).toBeGreaterThan(0);
  }, 60_000);

  it('writes fusions.csv: one line per calibrated fusion and seed, its strength and its damage', () => {
    const plan = checkSet('nightly', pairContent, B5, { c7: NO_C7 });
    const csv = fusionsCsv(plan, mirrorResults(plan, a, { ...a, asc: 0.25 }));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('key,seed,coef,base,with,ratio,center,asc,hub,outer,fusion');
    expect(lines.slice(1)).toEqual([
      'fire.summon,0,0.5,,,,3,0,0.5,1,0.5',
      'fire.summon,1,0.5,,,,3,0,0.5,1,0.5',
      'summon.fire,0,0.5,,,,3,0.25,0.5,1,0.5',
      'summon.fire,1,0.5,,,,3,0.25,0.5,1,0.5',
    ]);
  });
});

// ---- 雙融合組合, 三融合組合 ----

/** The plan's double and triple units, each seed read at `ratio(character, name, seed)`. */
const comboResults = (
  plan: CheckPlan,
  ratio: (character: CharacterId, name: string, seed: number) => number,
): UnitResults =>
  measureResults(plan.units, (measure, input) => {
    if (measure !== 'double' && measure !== 'triple') return null;
    const { character, outers, seed } = input as ComboInput;
    const r = ratio(character, comboName(outers), seed);
    const reading: ComboReading = {
      character,
      outers,
      seed,
      base: 10,
      with: 10 * r,
      ratio: r,
      refused: null,
    };
    return reading;
  });

const B1 = { fixture: 'B1' } as const;
const planB = (batch: 'B1' | 'B2' | 'B5', set: 'nightly' | 'weekly' = 'nightly'): CheckPlan =>
  checkSet(set, fixtureContent(batch), { fixture: batch }, { c7: NO_C7 });

describe('doubles and triples (雙融合組合, 三融合組合)', () => {
  it('takes C(k, 2) and C(k, 3): 6 and 4 of 4 fusions, 55 and 165 of 11, each once (OWN 1)', () => {
    const of = (k: number, size: number): number[][] =>
      combinations(
        Array.from({ length: k }, (_, i) => i),
        size,
      );
    expect([of(4, 2), of(4, 3), of(11, 2), of(11, 3)].map((list) => list.length)).toEqual([
      6, 4, 55, 165,
    ]);
    expect(of(4, 2)).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
    for (const [k, size] of [
      [4, 2],
      [4, 3],
      [11, 2],
      [11, 3],
    ] as const) {
      const list = of(k, size);
      expect(new Set(list.map((combo) => combo.join('+'))).size).toBe(list.length);
      expect(
        list.every((combo) => combo.every((x, i) => i === 0 || x > (combo[i - 1] as number))),
      ).toBe(true);
    }
    // The plan's units: B1's 熔核 has 4 fusions, B5's every character 11, on DOUBLE_SEEDS and
    // TRIPLE_SEEDS seeds each.
    const b1 = comboUnits('double', fixtureContent('B1'), B1, ['fire']);
    expect(b1).toHaveLength(6 * DOUBLE_SEEDS);
    expect(b1[0]).toEqual({
      id: 'measure:double:fire:poison+crit:0',
      job: {
        kind: 'measure',
        measure: 'double',
        input: { content: B1, character: 'fire', outers: ['poison', 'crit'], seed: 0 },
      },
    });
    expect(comboUnits('triple', fixtureContent('B1'), B1, ['fire'])).toHaveLength(4 * TRIPLE_SEEDS);
    expect(comboUnits('double', fixture, B5, ['fire', 'summon'])).toHaveLength(
      2 * 55 * DOUBLE_SEEDS,
    );
    expect(comboUnits('triple', fixture, B5, ['fire'])).toHaveLength(165 * TRIPLE_SEEDS);
    // The triples only in the weekly.
    const kinds = (plan: CheckPlan) =>
      new Set(
        plan.units.flatMap((unit) => (unit.job.kind === 'measure' ? [unit.job.measure] : [])),
      );
    expect(kinds(planB('B1')).has('triple')).toBe(false);
    expect(kinds(planB('B1', 'weekly')).has('triple')).toBe(true);
  });

  it("FAILs a combination above 2 × its character's median gain, not one at it (OWN 5)", () => {
    expect(COMBO_FAIL_RATIO).toBe(2);
    // 熔核's six on B1: gains 0.125, 0.25 × 3, 0.5 and one float step above 0.5: median 0.25.
    const ratios: Record<string, number> = {
      'poison+crit': 1.125,
      'poison+ice': 1.25,
      'poison+summon': 1.25,
      'crit+ice': 1.25,
      'crit+summon': 1.5,
      'ice+summon': floatStep(1.5, 1),
    };
    const plan = planB('B1');
    const rows = doublesCheck(
      plan,
      comboResults(plan, (_c, name) => ratios[name] as number),
    );
    expect(rows.map((row) => [row.subject, row.status])).toEqual([
      ['fire', 'info'],
      ['fire × ice+summon', 'FAIL'],
    ]);
    expect(rows[0]?.measured).toBe(
      '6 combinations, median gain +25%; strongest ice+summon +50%, crit+summon +50%, ' +
        'poison+ice +25%, poison+summon +25%, crit+ice +25%, poison+crit +12.5%; weakest ' +
        'poison+crit +12.5%, poison+ice +25%, poison+summon +25%, crit+ice +25%, crit+summon +50%, ' +
        'ice+summon +50%; 1 above 2 × the median',
    );
    expect(rows[1]).toMatchObject({
      target: "gain ≤ 2 × fire's median gain (初始值)",
      measured: 'gain +50% > 2 × +25%',
      evidence: ['doubles.csv: fire ice+summon'],
    });
    // Without it, the listing passes.
    const at = comboResults(plan, (_c, name) =>
      name === 'ice+summon' ? 1.5 : (ratios[name] as number),
    );
    expect(doublesCheck(plan, at).map((row) => [row.subject, row.status])).toEqual([
      ['fire', 'pass'],
    ]);
  });

  it("judges each character by its own median gain, not the mean or every character's median (OWN 5)", () => {
    // 熔核: 0.125 × 4, 0.3125 and 1: median 0.125 (mean 0.3); 蜂巢: 0.5 × 6 (with 熔核's, a
    // median of 0.5 over both).
    const fire: Record<string, number> = { 'crit+summon': 1.3125, 'ice+summon': 2 };
    const plan = planB('B2');
    const results = comboResults(plan, (character, name) =>
      character === 'summon' ? 1.5 : (fire[name] ?? 1.125),
    );
    expect(doublesCheck(plan, results).map((row) => [row.subject, row.status])).toEqual([
      ['fire', 'info'],
      ['fire × crit+summon', 'FAIL'],
      ['fire × ice+summon', 'FAIL'],
      ['summon', 'pass'],
    ]);
  });

  it('lists the strongest and the weakest 10 by median gain over the seeds, not the mean (OWN 5)', () => {
    // On B5 every combination gains 0.25 but two of 熔核's: poison+bleed's seeds read 1.125 five
    // times and 2 three times (median gain 0.125, mean 0.45); aura+thorns' 1.375 on every seed.
    const plan = planB('B5');
    const results = comboResults(plan, (character, name, seed) => {
      if (character === 'fire' && name === 'poison+bleed') return seed < 5 ? 1.125 : 2;
      if (character === 'fire' && name === 'aura+thorns') return 1.375;
      return 1.25;
    });
    const row = rowWith(doublesCheck(plan, results), 'fire');
    const [strongest, weakest] = (/strongest (.*); weakest (.*)$/.exec(row.measured) ?? []).slice(
      1,
    );
    expect(strongest?.split(', ')).toHaveLength(COMBO_LISTED);
    expect(weakest?.split(', ')).toHaveLength(COMBO_LISTED);
    expect(strongest?.split(', ').slice(0, 3)).toEqual([
      'aura+thorns +37.5%',
      'poison+lightning +25%',
      'poison+combo +25%',
    ]);
    expect(weakest?.split(', ').slice(0, 2)).toEqual([
      'poison+bleed +12.5%',
      'poison+lightning +25%',
    ]);
    const lines = doublesCsv(plan, results).trimEnd().split('\n');
    expect(lines[0]).toBe('character,outers,seed,base,with,ratio,refused,gain,rank,above');
    expect(lines).toHaveLength(1 + 4 * 55 * DOUBLE_SEEDS);
    expect(lines[1]).toBe('fire,poison+bleed,0,10,11.25,1.125,,0.125,55,false');
    expect(lines.find((line) => line.startsWith('fire,aura+thorns,0,'))).toBe(
      'fire,aura+thorns,0,10,13.75,1.375,,0.375,1,false',
    );
  });

  it('is noData for a character while a combination is unread or refused', () => {
    const plan = planB('B1');
    const all = comboResults(plan, () => 1.25);
    const unread = { ...all };
    delete unread['measure:double:fire:crit+ice:7'];
    expect(doublesCheck(plan, unread)).toMatchObject([
      {
        subject: 'fire',
        status: 'n/a',
        reason: { id: 'noData', detail: '5 of 6 combinations read on every seed' },
      },
    ]);
    const refused = measureResults(plan.units, (measure, input) => {
      if (measure !== 'double') return null;
      const { character, outers, seed } = input as ComboInput;
      return {
        character,
        outers,
        seed,
        base: null,
        with: null,
        ratio: null,
        refused: 'core: fusionSlots',
      };
    });
    expect(doublesCheck(plan, refused)).toMatchObject([
      {
        subject: 'fire',
        status: 'n/a',
        reason: { id: 'noData', detail: 'poison+crit: a purchase is refused: core: fusionSlots' },
      },
    ]);
  });

  it('reads the triples as the doubles, on the weekly with its own id and CSV', () => {
    const plan = planB('B1', 'weekly');
    const results = comboResults(plan, (_c, name) => (name === 'crit+ice+summon' ? 2 : 1.25));
    expect(triplesCheck(plan, results)).toMatchObject([
      { id: 'triples', subject: 'fire', status: 'info' },
      {
        id: 'triples',
        subject: 'fire × crit+ice+summon',
        status: 'FAIL',
        evidence: ['triples.csv: fire crit+ice+summon'],
      },
    ]);
  });

  /** The probes of a measure: each build's progress and seed. */
  const recording = (): { probe: MeasureProbe; runs: [CharacterProgress, number][] } => {
    const runs: [CharacterProgress, number][] = [];
    return {
      runs,
      probe: (_web, progress, seed) => {
        runs.push([progress, seed]);
        return runs.length === 1 ? 10 : 12;
      },
    };
  };

  it('probes a double on both investments, then with both cores: the base holds neither core', () => {
    const web = webOf(B5, 'fire', 'full');
    const coreOf = (outer: OuterId): string =>
      web.fusions.get(outer)?.board.nodes.find((node) => node.kind === 'core')?.id as string;
    const { probe, runs } = recording();
    const outers: OuterId[] = ['crit', 'ice'];
    const reading = measureCombo(
      'double',
      { content: B5, character: 'fire', outers, seed: 3 },
      probe,
    );
    expect(reading).toEqual({
      character: 'fire',
      outers,
      seed: 3,
      base: 10,
      with: 12,
      ratio: stdHpAt(12) / stdHpAt(10),
      refused: null,
    });
    const [[base, seed], [withCores, seedWith]] = runs as [
      [CharacterProgress, number],
      [CharacterProgress, number],
    ];
    expect([seed, seedWith]).toEqual([comboSeed('double', 3), comboSeed('double', 3)]);
    expect(comboSeed('double', 3)).toBe(deriveSeed(1031, 'double:3'));
    for (const outer of outers) {
      expect(storedRank(base, coreOf(outer))).toBe(0);
      expect(storedRank(withCores, coreOf(outer))).toBe(1);
      const unlock = unlockInvestment(web, CALIBRATION_ACCOUNT, outer);
      for (const id of Object.keys(unlock.ranks)) {
        expect(storedRank(base, id)).toBeGreaterThanOrEqual(storedRank(unlock, id));
      }
    }
    // The cores are all the with-build adds.
    const added = Object.keys(withCores.ranks).filter(
      (id) => storedRank(withCores, id) !== storedRank(base, id),
    );
    expect(added.sort()).toEqual(outers.map(coreOf).sort());
  });

  it("probes a triple with 奇點 beaten, whose third fusion slot a fresh save's account lacks", () => {
    expect(COMBO_ACCOUNTS).toEqual({
      double: CALIBRATION_ACCOUNT,
      triple: { singularityBeaten: true },
    });
    const outers: OuterId[] = ['crit', 'ice', 'summon'];
    const { probe, runs } = recording();
    const triple = measureCombo(
      'triple',
      { content: B5, character: 'fire', outers, seed: 0 },
      probe,
    );
    expect(triple).toMatchObject({ base: 10, with: 12, refused: null });
    expect(runs.map(([, seed]) => seed)).toEqual([comboSeed('triple', 0), comboSeed('triple', 0)]);
    // A double's account, two slots: the third core is refused, and reported, not probed.
    const fresh = recording();
    const refused = measureCombo(
      'double',
      { content: B5, character: 'fire', outers, seed: 0 },
      fresh.probe,
    );
    expect(refused).toMatchObject({
      base: null,
      with: null,
      ratio: null,
      refused: 'fusion.fire.summon.core: noFusionSlot',
    });
    expect(fresh.runs).toEqual([]);
  });
});

type AssembledWebOf = Parameters<MeasureProbe>[0];
