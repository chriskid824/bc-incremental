/**
 * Calibration (docs/v3 C6 design D26, §4.10; AMB15, S-2): φ on a hand-built result, split children
 * and a leak included, over waveHp; the probe's tracking of every enemy against the run's own
 * events, and its timeout flag; the search's bisection converging on a synthetic strength curve;
 * each status (ok, spread, weak, strong, insensitive), a range end that reads 1.20 exactly being
 * neither weak nor strong, a seed at exactly 1 + SEED_BAND.min or 1 + SEED_BAND.max being in the
 * band (the lead's ruling R10); and eight seeds with one outlier giving their median, not their
 * mean. The fixture's numbers are not content, so the end-to-end runs check the probe's plumbing,
 * not a status: each coef measured on the web reassembled at it, the core's run over the base's,
 * paired by seed, inside coefRange.
 */

import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed } from '../../core/rng';
import { loadGameData } from '../../data';
import { stdHp, stdHpAt } from '../../data/curve';
import { coefRange } from '../../data/fusion/sensitivity';
import type { GameData, SpawnRule } from '../../data/types';
import { assembleWeb } from '../../data/web/assemble';
import { FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import type { AssembledWeb, FusionKey } from '../../data/web/types';
import type { TestModule } from '../../sim/rules';
import { createSimulation } from '../../sim/simulation';
import { TEST_V3_WAVES, v3TestData } from '../../sim/testing';
import { NO_INPUT } from '../../sim/types';
import { webBuild, webRunConfig } from './build';
import {
  BISECTION_STEPS,
  calibrateFusion,
  CALIBRATION_ACCOUNT,
  CALIBRATION_SEED,
  frontierOf,
  median,
  PROBE_MAX_TICKS,
  probeRun,
  searchCoef,
  SEED_BAND,
  waveHp,
} from './calibrate';
import type { EnemyFate, ProbeRun } from './calibrate';
import { auditBuy, unlockInvestment } from './invest';
import { sampleProgress } from './sample';
import type { CharacterProgress } from './types';

const data = loadGameData();

/** Wave 8 of the real waves: 45 triangles (0.5), 13 squares (1) and 4 pentagons (1, + 3 × 0.25). */
const W8_UNITS = 45 * 0.5 + 13 * 1 + 4 * (1 + 3 * 0.25);

describe('waveHp and frontierOf (AMB15)', () => {
  it("counts a wave's split children in its HP, as dropUnits does", () => {
    expect(W8_UNITS).toBe(42.5);
    expect(waveHp(8, data)).toBeCloseTo(W8_UNITS * stdHp(8), 9);
    // Wave 1 has no pentagon: 45 triangles.
    expect(waveHp(1, data)).toBeCloseTo(45 * 0.5 * stdHp(1), 9);
    const cyclic: GameData = {
      ...data,
      enemies: {
        ...data.enemies,
        shard: { ...data.enemies.shard, splitInto: { enemy: 'pentagon', count: 1 } },
      },
    };
    expect(() => waveHp(8, cyclic)).toThrow('Cyclic splitInto through enemy pentagon');
  });

  it("credits a run at F + φ: wave F + 1's lost HP, split children and a leak included", () => {
    const s8 = stdHp(8);
    const fate = (wave: number, unit: number, hpUnit: number, end: EnemyFate['end']) => ({
      wave,
      maxHp: unit * stdHp(wave),
      hp: hpUnit * stdHp(wave),
      end,
    });
    const run: ProbeRun = {
      highestWaveCleared: 7,
      ticks: 5000,
      timeout: false,
      enemies: [
        // Wave 8: a pentagon killed, two of its shards killed and one at 0.1 of 0.25 left.
        fate(8, 1, -0.3, 'killed'),
        fate(8, 0.25, 0, 'killed'),
        fate(8, 0.25, -1, 'killed'),
        fate(8, 0.25, 0.1, 'alive'),
        // A triangle that reached the player with 0.2 of its 0.5 left: it lost 0.3.
        fate(8, 0.5, 0.2, 'leaked'),
        // A square untouched, and a triangle overhealed (its loss stays within [0, maxHp]).
        fate(8, 1, 1, 'alive'),
        fate(8, 0.5, 0.7, 'alive'),
        // Waves 7 and 9 count nothing toward wave 8.
        fate(7, 1, 0, 'killed'),
        fate(9, 0.5, 0, 'killed'),
        fate(9, 0.5, 0.1, 'leaked'),
      ],
    };
    const lost = 1 + 0.25 + 0.25 + 0.15 + 0.3;
    expect(frontierOf(run, data)).toBeCloseTo(7 + (lost * s8) / (W8_UNITS * s8), 12);
    expect(frontierOf({ ...run, enemies: [] }, data)).toBe(7);
    // Before wave 1 is cleared, φ is wave 1's.
    const early: ProbeRun = { ...run, highestWaveCleared: 0, enemies: [fate(1, 0.5, 0, 'killed')] };
    expect(frontierOf(early, data)).toBeCloseTo(1 / 45, 12);
  });

  it("tracks every enemy of a probe run, split children included, as the run's events count them", () => {
    const content = fixtureContent();
    const web = assembleWeb(content, 'lightning', FULL_SCOPE);
    const progress = sampleProgress(web, createRng(3), {
      purchases: 140,
      account: CALIBRATION_ACCOUNT,
      bestWave: 30,
      prestiged: false,
    });
    const run = probeRun(web, progress, 777, data, 20_000);
    // The same run, counted from its events.
    const counted = { spawned: 0, killed: 0, leaked: 0 };
    const sim = createSimulation(
      { ...webRunConfig(webBuild(web, progress), 777, 1), maxTicks: 20_000 },
      data,
      [((b) => void b.hook('onKill', () => undefined)) satisfies TestModule],
    );
    while (!sim.state.finished) {
      for (const event of sim.step(NO_INPUT)) {
        if (event.type === 'enemySpawned') counted.spawned += 1;
        else if (event.type === 'enemyKilled') counted.killed += 1;
        else if (event.type === 'playerHit') counted.leaked += 1;
      }
    }
    const ends = (end: EnemyFate['end']) => run.enemies.filter((fate) => fate.end === end).length;
    expect({ spawned: run.enemies.length, killed: ends('killed'), leaked: ends('leaked') }).toEqual(
      counted,
    );
    expect(ends('alive')).toBe(sim.state.enemies.length);
    expect(run.highestWaveCleared).toBe(sim.result().highestWaveCleared);
    expect(run.highestWaveCleared).toBeGreaterThanOrEqual(8);
    // Shards (0.25 of the standard HP) were spawned and killed: the pentagons split.
    const shards = run.enemies.filter(
      (fate) => fate.end === 'killed' && Math.abs(fate.maxHp / stdHp(fate.wave) - 0.25) < 1e-9,
    );
    expect(shards.length).toBeGreaterThan(0);
    const x = frontierOf(run, data);
    expect(x).toBeGreaterThanOrEqual(run.highestWaveCleared);
    expect(x).toBeLessThan(run.highestWaveCleared + 1);
  });

  it('flags a probe run that reaches maxTicks alive as a timeout, and one that dies as none', () => {
    const web = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
    const base = unlockInvestment(web, CALIBRATION_ACCOUNT, 'poison');
    const died = probeRun(web, base, 5, data);
    expect(died.timeout).toBe(false);
    expect(died.ticks).toBeLessThan(PROBE_MAX_TICKS);
    const cut = probeRun(web, base, 5, data, 60);
    expect([cut.timeout, cut.ticks]).toEqual([true, 60]);
  });
});

describe('probeRun on a v3 run (docs/v3 C7 design §2.6, C7/F12; lead ruling Y8)', () => {
  /** v3 fixture data of `rules` from wave 1, with no affix, treasure, elite or boss. */
  const v3Data = (rules: readonly SpawnRule[]): GameData =>
    v3TestData({
      waves: {
        rules,
        eliteEvery: 1000,
        bossEvery: 1000,
        v3: {
          ...TEST_V3_WAVES.v3,
          affixes: [],
          treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
        },
      },
    });
  const web = assembleWeb(fixtureContent(), 'lightning', FULL_SCOPE);
  const progress = sampleProgress(web, createRng(3), {
    purchases: 140,
    account: CALIBRATION_ACCOUNT,
    bestWave: 30,
    prestiged: false,
  });

  /** The probe's run again, counted from its events; `extras` from a tick hook. */
  function counted(v3: GameData) {
    const extras = new Set<number>();
    const watch: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        for (const e of ctx.enemies) if (e.v3 !== null && e.v3.extra) extras.add(e.id);
      });
    const sim = createSimulation(
      { ...webRunConfig(webBuild(web, progress), 777, 1), maxTicks: 20_000 },
      v3,
      [watch, ((b) => void b.hook('onKill', () => undefined)) satisfies TestModule],
    );
    const ids = { spawned: [] as number[], killed: [] as number[], leaked: [] as number[] };
    let summoned = 0;
    let bullets = 0;
    while (!sim.state.finished) {
      for (const event of sim.step(NO_INPUT)) {
        if (event.type === 'enemySpawned') ids.spawned.push(event.enemyId);
        else if (event.type === 'enemyKilled') ids.killed.push(event.enemyId);
        else if (event.type === 'playerHit') ids.leaked.push(event.enemyId);
        else if (event.type === 'summoned') summoned += event.count;
        else if (event.type === 'bulletHit') bullets++;
      }
    }
    const alive = sim.state.enemies.map((e) => e.id);
    return { ids, alive, extras, summoned, bullets };
  }

  it('leaves out a summoner’s children, killed, leaked or alive, as waveHp does (§2.6 OWN test 11)', () => {
    // Planted bug: the extra fates kept, so that φ counts HP its waveHp never holds.
    const v3 = v3Data([
      { enemy: 'summoner', fromWave: 1, base: 2, perWave: 0.2, maxCount: 8 },
      { enemy: 'triangle', fromWave: 1, base: 6, perWave: 0.6, maxCount: 40 },
    ]);
    const run = probeRun(web, progress, 777, v3, 20_000);
    const { ids, alive, extras, summoned } = counted(v3);
    const own = (list: readonly number[]) => list.filter((id) => !extras.has(id)).length;
    const ends = (end: EnemyFate['end']) => run.enemies.filter((fate) => fate.end === end).length;
    // The children: every extra enemy, many of them killed or leaked.
    expect(extras.size).toBe(summoned);
    expect(
      ids.killed.length + ids.leaked.length - own(ids.killed) - own(ids.leaked),
    ).toBeGreaterThan(10);
    expect({
      spawned: run.enemies.length,
      killed: ends('killed'),
      leaked: ends('leaked'),
      alive: ends('alive'),
    }).toEqual({
      spawned: ids.spawned.length - summoned,
      killed: own(ids.killed),
      leaked: own(ids.leaked),
      alive: own(alive),
    });
    // R-C7-6: φ stays below 1.
    const x = frontierOf(run, v3);
    expect(x).toBeGreaterThanOrEqual(run.highestWaveCleared);
    expect(x).toBeLessThan(run.highestWaveCleared + 1);
  });

  it('counts no shooter as leaked by its bullets: they push bulletHit, never playerHit (Y8)', () => {
    // Planted bug: a bullet's hit pushing playerHit, which marks its shooter leaked.
    const v3 = v3Data([{ enemy: 'shooter', fromWave: 1, base: 4, perWave: 0.4, maxCount: 8 }]);
    const run = probeRun(web, progress, 777, v3, 20_000);
    const { ids, bullets } = counted(v3);
    expect(bullets).toBeGreaterThan(0);
    // Shooters stand at their post: none reaches the player, and the run has no other enemy.
    expect(ids.leaked).toEqual([]);
    expect(run.enemies.filter((fate) => fate.end === 'leaked')).toEqual([]);
    expect(run.enemies.length).toBe(ids.spawned.length);
  });
});

/** Eight seeds of a strength curve: seed s at strength(coef) + offsets[s]. */
const seeds =
  (strength: (coef: number) => number, offsets: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0]) =>
  (coef: number): number[] =>
    offsets.map((offset) => strength(coef) + offset);

const SPREAD_OFFSETS = [-0.04, -0.03, -0.01, 0, 0, 0.01, 0.03, 0.04];

describe('searchCoef (§4.10)', () => {
  it('bisects log coef to the median strength of 1.20, at 3 significant digits', () => {
    // m(c) = 1 + 0.2 (c / 2.33)^0.6: 1.20 at 2.33, well inside its 3-digit rounding.
    const strength = (coef: number) => 1 + 0.2 * Math.pow(coef / 2.33, 0.6);
    const result = searchCoef([0.1, 10], seeds(strength, SPREAD_OFFSETS));
    expect(result.status).toBe('ok');
    expect(result.coef).toBe(2.33);
    // The ends, 12 halvings and the rounded coef: 15 measurements.
    expect(result.readings.map((reading) => reading.coef).slice(0, 2)).toEqual([0.1, 10]);
    expect(result.readings).toHaveLength(2 + BISECTION_STEPS + 1);
    expect(result.reading).toEqual({
      coef: 2.33,
      ratios: seeds(strength, SPREAD_OFFSETS)(2.33),
      median: strength(2.33),
    });
    // A decreasing bracket: each halving keeps the side where the median crosses 1.20.
    const mids = result.readings.slice(2, -1);
    for (const [i, reading] of mids.entries()) {
      const later = mids.slice(i + 1).map((other) => other.coef);
      if (reading.median < 1.2) expect(later.every((coef) => coef > reading.coef)).toBe(true);
      else expect(later.every((coef) => coef < reading.coef)).toBe(true);
    }
    // Inside a narrow range too.
    expect(searchCoef([1.5, 3], seeds(strength)).coef).toBe(2.33);
    // The coef is √(lo × hi) of the last bracket, not one of its ends: with the crossing just
    // above a rounding boundary the ends round apart, and the geometric mean decides.
    const linear = (crossing: number) => seeds((coef) => 1 + (0.2 * coef) / crossing);
    // The last bracket's top rounds to 1.03 here, its bottom to 1.01 in the second.
    expect(searchCoef([0.1, 10], linear(1.025 + 1e-9)).coef).toBe(1.02);
    expect(searchCoef([0.1, 10], linear(1.015 + 1e-9)).coef).toBe(1.02);
  });

  it('says spread when one seed leaves +10–30 %, though the median is on target', () => {
    const strength = (coef: number) => 1 + (0.2 * coef) / 1.23;
    const offsets = [0, 0, 0, 0, 0, 0, 0, 0.11];
    const result = searchCoef([0.1, 10], seeds(strength, offsets));
    expect(result.coef).toBe(1.23);
    expect(result.status).toBe('spread');
    expect(Math.max(...result.reading.ratios)).toBeCloseTo(1.31, 9);
    // Every seed at 1.29 or 1.11 is in the band; one at 1.09 is not.
    expect(searchCoef([0.1, 10], seeds(strength, [0, 0, 0, 0, 0, 0, -0.09, 0.09])).status).toBe(
      'ok',
    );
    expect(searchCoef([0.1, 10], seeds(strength, [0, 0, 0, 0, 0, 0, 0, -0.11])).status).toBe(
      'spread',
    );
  });

  it('holds a seed at exactly 1 + SEED_BAND.min or 1 + SEED_BAND.max in the band, not one past it', () => {
    // The first test's curve settles on 2.33, where seeds 0 and 7 read `low` and `high`.
    const strength = (coef: number) => 1 + 0.2 * Math.pow(coef / 2.33, 0.6);
    const settled = (low: number, high: number) =>
      searchCoef([0.1, 10], (coef) =>
        coef === 2.33 ? [low, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, high] : seeds(strength)(coef),
      );
    const [min, max] = [1 + SEED_BAND.min, 1 + SEED_BAND.max];
    // 1.30 − 1 is past SEED_BAND.max in floats, so the band is compared at 1 + its ends.
    expect(max - 1).toBeGreaterThan(SEED_BAND.max);
    const ends = settled(min, max);
    expect([ends.coef, ends.status]).toEqual([2.33, 'ok']);
    expect(ends.reading.ratios).toEqual([min, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, max]);
    // One float step (Number.EPSILON in [1, 2)) outside either end is out.
    expect(settled(min - Number.EPSILON, max).status).toBe('spread');
    expect(settled(min, max + Number.EPSILON).status).toBe('spread');
  });

  it('says weak at the top of the range, and strong at its bottom, when 1.20 is out of reach', () => {
    const weak = searchCoef(
      [0.1, 10],
      seeds((coef) => 1.1 + 0.009 * coef),
    );
    expect([weak.status, weak.coef]).toEqual(['weak', 10]);
    expect(weak.reading.median).toBeCloseTo(1.19, 12);
    expect(weak.readings).toHaveLength(2);
    const strong = searchCoef(
      [0.1, 10],
      seeds((coef) => 1.21 + 0.1 * coef),
    );
    expect([strong.status, strong.coef]).toEqual(['strong', 0.1]);
    expect(strong.reading.median).toBeCloseTo(1.22, 12);
  });

  it('bisects, neither strong nor weak, when an end of the range reads 1.20 exactly', () => {
    // 1.20 at the bottom, 1.40 at the top: the search keeps the bottom, ok there.
    const bottom = searchCoef(
      [0.1, 10],
      seeds((coef) => 1.2 + 0.1 * Math.log10(coef / 0.1)),
    );
    expect([bottom.status, bottom.coef]).toEqual(['ok', 0.1]);
    expect(bottom.readings).toHaveLength(2 + BISECTION_STEPS);
    // 1.00 at the bottom, 1.20 at the top: it bisects up to just below the top.
    const top = searchCoef(
      [0.1, 10],
      seeds((coef) => 1.2 - 0.1 * Math.log10(10 / coef)),
    );
    expect([top.status, top.coef]).toEqual(['ok', 9.99]);
  });

  it('says insensitive at coef 1 with no range or less than 0.05 between its ends', () => {
    let measured: number[] = [];
    const flat = (coef: number) => {
      measured.push(coef);
      return seeds(() => 1.1 + (0.039 * Math.log10(coef / 0.1)) / 2)(coef);
    };
    const none = searchCoef(null, flat);
    expect([none.status, none.coef, measured]).toEqual(['insensitive', 1, [1]]);
    measured = [];
    const narrow = searchCoef([0.1, 10], flat);
    expect([narrow.status, narrow.coef, measured]).toEqual(['insensitive', 1, [0.1, 10, 1]]);
    expect(narrow.reading.coef).toBe(1);
    // More between the ends is a reading: 0.06 here, weak.
    const wider = searchCoef(
      [0.1, 10],
      seeds((coef) => 1.1 + (0.06 * Math.log10(coef / 0.1)) / 2),
    );
    expect(wider.status).toBe('weak');
    // A coef measured once already is not measured again.
    measured = [];
    expect(searchCoef([0.5, 1], flat).status).toBe('insensitive');
    expect(measured).toEqual([0.5, 1]);
  });

  it('reads the median of eight seeds with one outlier, not their mean (S-2)', () => {
    expect(median([1.21, 1.19, 1.2, 1.2, 9, 1.2, 1.2, 1.2])).toBe(1.2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(() => median([])).toThrow(RangeError);
    // Seven seeds on 1 + 0.2 c / 1.23 and one ten times as strong: the search lands on 1.23.
    const outlier = (coef: number) => [...seeds((c) => 1 + (0.2 * c) / 1.23)(coef).slice(0, 7), 12];
    const result = searchCoef([0.1, 10], outlier);
    expect(result.coef).toBe(1.23);
    expect(result.status).toBe('spread');
    expect(result.reading.median).toBeCloseTo(1.2, 12);
  });
});

describe('calibrateFusion (D26)', () => {
  it("probes a fixture fusion end to end: base and core runs on each seed, the fusion's digest", () => {
    const content = fixtureContent();
    const result = calibrateFusion(content, 'fire.ice', data, { seeds: 2 });
    const fusion = assembleWeb(content, 'fire', FULL_SCOPE).fusions.get('ice');
    expect(result).toMatchObject({ key: 'fire.ice', kind: 'hand', range: null });
    expect(result.entry).toMatchObject({
      coef: 1,
      status: 'insensitive',
      seeds: 2,
      startWave: 1,
      digest: fusion?.digest,
    });
    // The base on each seed, then each coef measured on each seed.
    expect(result.runs).toBe(2 + 2 * result.readings.length);
    expect(result.baseFrontiers).toHaveLength(2);
    expect(result.ticks).toBeGreaterThan(0);
    expect(result.entry.min).toBeLessThanOrEqual(result.entry.median);
    expect(result.entry.median).toBeLessThanOrEqual(result.entry.max);
    expect(calibrateFusion(content, 'fire.ice', data, { seeds: 2 })).toEqual(result);
    expect(() => calibrateFusion(fixtureContent('B1'), 'ice.fire', data)).toThrow(
      "calibrateFusion 'ice.fire': character 'ice' has no center",
    );
  });

  it("measures each coef on the web reassembled at it: the core's run over the base's, seed by seed, inside coefRange", () => {
    const content = fixtureContent();
    const key = 'lightning.aura' satisfies FusionKey;
    const web = assembleWeb(content, 'lightning', FULL_SCOPE);
    const fusion = web.fusions.get('aura');
    const core = fusion?.board.nodes.find((node) => node.kind === 'core');
    if (fusion === undefined || core === undefined) throw new Error('no lightning.aura core');
    // A range of its own, not 0.1 to 10.
    const range = coefRange(fusion);
    expect(range?.[0]).toBe(0.1);
    expect(range?.[1]).toBeLessThan(10);
    const result = calibrateFusion(content, key, data, { seeds: 2 });
    expect(result.range).toEqual(range);
    expect(result.readings.slice(0, 2).map((reading) => reading.coef)).toEqual(range);
    // The probe: the unlock investment, and it with the core at rank 1.
    const base = unlockInvestment(web, CALIBRATION_ACCOUNT, 'aura');
    const step = auditBuy(web, base, CALIBRATION_ACCOUNT, core.id);
    if (!step.ok) throw new Error(step.refusal.reason);
    expect(step.progress.ranks).toEqual({ ...base.ranks, [core.id]: 1 });
    const frontier = (at: AssembledWeb, progress: CharacterProgress, s: number): number =>
      frontierOf(
        probeRun(at, progress, deriveSeed(CALIBRATION_SEED, `calibrate:${s}`), data),
        data,
      );
    const baseFrontiers = [0, 1].map((s) => frontier(web, base, s));
    expect(result.baseFrontiers).toEqual(baseFrontiers);
    expect(baseFrontiers[0]).not.toBe(baseFrontiers[1]);
    for (const reading of result.readings) {
      const at = assembleWeb(content, 'lightning', FULL_SCOPE, { coefs: { [key]: reading.coef } });
      expect(reading.ratios).toEqual(
        [0, 1].map(
          (s) => stdHpAt(frontier(at, step.progress, s)) / stdHpAt(baseFrontiers[s] as number),
        ),
      );
    }
    // The core and its coef move the frontier: the ends read apart, and neither at 1.
    const [low, high] = result.readings;
    expect(low?.median).not.toBe(high?.median);
    expect(result.readings.flatMap((reading) => reading.ratios)).not.toContain(1);
  });
});
