/**
 * The web fuzz (docs/v3 C6 design D25, §4.9; V23, P9, N-7; the lead's rulings R1, R2 and R7):
 * V23's 20 builds × 600 ticks pass, on the fixture until a registered character has a center
 * (F57); planted faults are found, each with its repro line (NaN hp, a summon cap breach, chain
 * hits past CHAIN_HIT_CAP, a throw, a non-deterministic rule or result, the end checks); a failing
 * run stops at its first failing tick and the next build runs, counted in "N runs stopped early";
 * more than 400 alive warns once a build, exactly 400 does not, and it never fails; a build's time
 * comes only from the caller's clock; --only reproduces a build of the full run; the draws are
 * §4.9's, from createRng(deriveSeed(seed, 'webFuzz:' + i)) in a fixed order, and sampleProgress
 * buys with them; a build that owns three fusion cores runs under the checks; FIXED_WEB_CASES is
 * empty until 熔核 has a center.
 */

import { describe, expect, it, vi } from 'vitest';
import { num } from '../../core/num';
import { createRng, deriveSeed } from '../../core/rng';
import { loadGameData } from '../../data';
import { coefRange } from '../../data/fusion/sensitivity';
import { CHARACTER_IDS } from '../../data/sources';
import { assembleWeb, loadContent } from '../../data/web';
import { fixtureContent } from '../../data/web/testing';
import type { AssembledWeb, FusionKey } from '../../data/web/types';
import type { TestModule } from '../../sim/rules';
import type { RunContext } from '../../sim/systems/context';
import { addEnemy } from '../../sim/systems/spawn';
import {
  ALIVE_WARNING,
  FIXED_WEB_CASES,
  fuzzWebs,
  runWebFuzz,
  WEB_FUZZ_SEED,
  WEB_FUZZ_WAVES,
} from './fuzz';
import { storedRank } from './counts';
import type { WebFuzzDraw, WebFuzzOptions } from './fuzz';
import { sampleProgress } from './sample';
import type * as SampleModule from './sample';

// sampleProgress, wrapped so a test can see the draws each build hands it.
vi.mock('./sample', async (importOriginal) => {
  const actual = await importOriginal<typeof SampleModule>();
  return { ...actual, sampleProgress: vi.fn(actual.sampleProgress) };
});

const data = loadGameData();
const fixture = fixtureContent();
const registered = loadContent();
const centered = CHARACTER_IDS.some((c) => registered.characters[c].center !== null);

/** The fixture's fuzz, `builds` × `ticks`, with `extra` options. */
const fuzz = (builds: number, ticks: number, extra: Partial<WebFuzzOptions> = {}) =>
  runWebFuzz({ content: fixture, data, builds, ticks, fixture: true, ...extra });

/** A tick hook that acts once, at the first tick from `tick` on where `act` says it acted. */
const once =
  (tick: number, act: (ctx: RunContext) => boolean): TestModule =>
  (b) => {
    let done = false;
    b.hook('tick', (ctx) => {
      if (!done && ctx.now >= tick) done = act(ctx);
    });
  };

describe('runWebFuzz (§4.9)', () => {
  it('V23: 20 builds × 600 ticks pass, on the fixture until a registered character has a center (R1)', () => {
    const report = runWebFuzz({
      content: centered ? registered : fixture,
      data,
      builds: 20,
      ticks: 600,
      fixture: !centered,
    });
    expect(report.failures).toEqual([]);
    expect(report.builds).toHaveLength(20);
    // Builds 0 and 10 run twice.
    expect(report.runs).toBe(22);
    expect(report.stoppedEarly).toBe(0);
    expect(report.kills).toBeGreaterThan(0);
  });

  it('finds planted faults with their repro lines, each run stopping at its first failing tick (P9)', () => {
    const nan = { tick: 0, id: 0 };
    let flaky = 0;
    const plant = (draw: WebFuzzDraw): TestModule[] => {
      if (draw.index === 3) {
        return [
          once(20, (ctx) => {
            const enemy = ctx.enemies[0];
            if (enemy === undefined) return false;
            Object.assign(nan, { tick: ctx.now, id: enemy.id });
            enemy.hp = num(NaN);
            return true;
          }),
        ];
      }
      if (draw.index === 5) {
        return [
          once(40, () => {
            throw new Error('planted throw');
          }),
        ];
      }
      if (draw.index === 6) {
        // Only a test module raises a run's cap: 30 drones under a cap of 40, past SUMMON_CAP.
        return [
          (b) => {
            const swarm = b.signature().swarm;
            if (swarm !== null) Object.assign(swarm, { drones: 30 });
          },
          Object.assign(() => undefined, { summonCap: 40 }),
        ];
      }
      if (draw.index === 10) {
        // A rule that reads state outside the run: its second use spawns one more enemy.
        flaky += 1;
        const salt = flaky;
        return [
          once(30, (ctx) => {
            const rec = ctx.current;
            if (rec === null) return false;
            if (salt % 2 === 0) addEnemy(ctx, ctx.data.enemies.square, rec, 1, 0, 3000);
            return true;
          }),
        ];
      }
      return [];
    };
    const report = fuzz(12, 300, { modules: plant });
    const build = (index: number) => report.builds[index] as (typeof report.builds)[number];
    const repro = (index: number) =>
      `npm run fuzz:web -- --fixture --ticks 300 --only ${build(index).name}`;
    expect(report.failures).toEqual([
      {
        kind: 'nonFinite',
        text: `fuzz build 3 (character 'ice', scope 'full'): tick ${nan.tick}: enemy ${nan.id} hp NaN`,
        repro: repro(3),
        ids: build(3).ids,
      },
      {
        kind: 'threw',
        text: "fuzz build 5 (character 'lightning', scope 'full'): tick 40: threw planted throw",
        repro: repro(5),
        ids: build(5).ids,
      },
      {
        kind: 'cap',
        text: expect.stringMatching(
          /^fuzz build 6 \(character 'summon', scope 'full'\): tick 0: \d+ summons, past the cap 24$/,
        ) as string,
        repro: repro(6),
        ids: build(6).ids,
      },
      {
        kind: 'hash',
        text: expect.stringMatching(
          /^fuzz build 10 \(character 'fire', scope 'demoB'\): runs differ \([0-9a-f]{16}, [0-9a-f]{16}\)$/,
        ) as string,
        repro: repro(10),
        ids: build(10).ids,
      },
    ]);
    expect(repro(3)).toBe('npm run fuzz:web -- --fixture --ticks 300 --only ice.full.3');
    // Each failing run stopped at its failing tick, once; the hash run ran both runs to the end.
    expect([3, 5, 6].map((i) => [build(i).ticks, build(i).stopped, build(i).runs])).toEqual([
      [nan.tick, true, 1],
      [39, true, 1],
      [0, true, 1],
    ]);
    expect(build(10)).toMatchObject({ runs: 2, stopped: false });
    expect(build(10).ticks).toBeGreaterThan(2 * 30);
    // The builds after a failing one run in full.
    expect(report.builds).toHaveLength(12);
    for (const i of [4, 7, 8, 9, 11]) expect(build(i).stopped).toBe(false);
    expect(build(4).ticks).toBeGreaterThan(nan.tick);
    expect(report.stoppedEarly).toBe(3);
  });

  it('fails the end checks: an effect dropped, a budget streak of 30 ticks, never 29 (F8)', () => {
    const set = (id: 'effectsDropped' | 'effectBudgetStreakMax', value: number): TestModule =>
      once(10, (ctx) => {
        ctx.counters[id] = value;
        return true;
      });
    const planted: Readonly<Record<number, TestModule>> = {
      1: set('effectsDropped', 1),
      2: set('effectBudgetStreakMax', 30),
      3: set('effectBudgetStreakMax', 29),
    };
    const report = fuzz(4, 60, {
      modules: (draw) => {
        const module = planted[draw.index];
        return module === undefined ? [] : [module];
      },
    });
    expect(report.failures.map(({ kind, text }) => [kind, text])).toEqual([
      ['dropped', "fuzz build 1 (character 'fire', scope 'demoA'): effectsDropped 1, not 0"],
      [
        'budget',
        "fuzz build 2 (character 'fire', scope 'demoB'): effectBudgetStreakMax 30, not below 30: " +
          'effects carried over half a second in a row (F8)',
      ],
    ]);
    // The end checks fail runs that stepped to their end: none stopped early.
    expect(report.stoppedEarly).toBe(0);
    expect(report.builds[2]?.peaks.budgetStreak).toBe(30);
  });

  it('warns once a build above 400 alive and never fails on it, until C7 (D31, R7)', () => {
    const crowd = once(20, (ctx) => {
      const rec = ctx.current;
      if (rec === null) return false;
      for (let k = 0; k <= ALIVE_WARNING; k++)
        addEnemy(ctx, ctx.data.enemies.square, rec, 1, 0, 3000);
      return true;
    });
    const report = fuzz(3, 60, { modules: (draw) => (draw.index === 1 ? [crowd] : []) });
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([
      {
        text: expect.stringMatching(
          /^fuzz build 1 \(character 'fire', scope 'demoA'\): tick 20: 4\d\d enemies alive, above 400 \(a failure once C7 exports ENEMY_CAP_ENFORCED; D31\)$/,
        ) as string,
        repro: 'npm run fuzz:web -- --fixture --ticks 60 --only fire.demoA.1',
      },
    ]);
    expect(report.builds[1]?.peaks.alive).toBeGreaterThan(ALIVE_WARNING);
    expect(report.peaks.alive).toBe(report.builds[1]?.peaks.alive);
  });

  it('warns above 400 alive only: exactly 400 at a tick is no warning (R7)', () => {
    // At the run's last tick, after the emitters, the crowd is topped up far away to `alive` and
    // every enemy made too strong to die in what is left of the tick: the count after it.
    const crowd = (alive: number): TestModule =>
      once(60, (ctx) => {
        const rec = ctx.current;
        if (rec === null) return false;
        while (ctx.enemies.length < alive) addEnemy(ctx, ctx.data.enemies.square, rec, 1, 0, 3000);
        for (const enemy of ctx.enemies) enemy.hp = num(1e200);
        return true;
      });
    const planted: Readonly<Record<number, TestModule>> = {
      1: crowd(ALIVE_WARNING),
      2: crowd(ALIVE_WARNING + 1),
    };
    const report = fuzz(3, 60, {
      modules: (draw) => {
        const module = planted[draw.index];
        return module === undefined ? [] : [module];
      },
    });
    expect(report.builds.map((line) => line.peaks.alive).slice(1)).toEqual([400, 401]);
    expect(report.failures).toEqual([]);
    expect(report.warnings.map((warning) => warning.text)).toEqual([
      "fuzz build 2 (character 'fire', scope 'demoB'): tick 60: 401 enemies alive, above 400 " +
        '(a failure once C7 exports ENEMY_CAP_ENFORCED; D31)',
    ]);
  });

  it("checks the chain hits after every tick against CHAIN_HIT_CAP, with the run's counters", () => {
    const peak = (value: number): TestModule =>
      once(10, (ctx) => {
        ctx.counters.chainHitsPeak = value;
        return true;
      });
    const report = fuzz(3, 60, {
      modules: (draw) => (draw.index === 1 ? [peak(33)] : draw.index === 2 ? [peak(32)] : []),
    });
    expect(report.failures.map(({ kind, text }) => [kind, text])).toEqual([
      [
        'cap',
        "fuzz build 1 (character 'fire', scope 'demoA'): tick 10: chainHitsPeak 33, past CHAIN_HIT_CAP",
      ],
    ]);
    expect(report.builds[1]).toMatchObject({ ticks: 10, stopped: true });
    expect(report.builds[2]?.peaks.chainHits).toBe(32);
    expect(report.stoppedEarly).toBe(1);
  });

  it("hashes the result as well as every tick's events: runs that differ in the result alone fail", () => {
    // Run 2 of build 0 counts one more zone eviction than run 1: its events are run 1's, its
    // result's counters are not.
    const evict = once(30, (ctx) => {
      ctx.counters.zonesEvicted += 1;
      return true;
    });
    const report = fuzz(1, 60, { modules: (_draw, run) => (run === 2 ? [evict] : []) });
    expect(report.failures.map(({ kind, text }) => [kind, text])).toEqual([
      [
        'hash',
        expect.stringMatching(
          /^fuzz build 0 \(character 'fire', scope 'full'\): runs differ \([0-9a-f]{16}, [0-9a-f]{16}\)$/,
        ),
      ],
    ]);
    expect(report.builds[0]).toMatchObject({ runs: 2, stopped: false, ticks: 120 });
  });

  it("records each build's time from the clock it is given, and reads no clock itself (N-7)", () => {
    const performanceNow = vi.spyOn(performance, 'now');
    const dateNow = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    let now = 0;
    const clock = vi.fn(() => (now += 7));
    const timed = fuzz(3, 60, { clock });
    const untimed = fuzz(3, 60);
    const calls = [performanceNow, dateNow, random].map((spy) => spy.mock.calls.length);
    [performanceNow, dateNow, random].forEach((spy) => spy.mockRestore());
    expect(calls).toEqual([0, 0, 0]);
    // Twice a build: before its first run and after its last.
    expect(clock).toHaveBeenCalledTimes(6);
    expect(timed.builds.map((line) => line.time)).toEqual([7, 7, 7]);
    expect(untimed.builds.map((line) => line.time)).toEqual([null, null, null]);
    expect({ ...untimed, builds: [] }).toEqual({ ...timed, builds: [] });
  });

  it('reproduces one build of the full run with --only, and refuses a build dealt elsewhere (R2)', () => {
    const full = fuzz(12, 120);
    expect(full.webs).toEqual([
      'fire.full',
      'fire.demoA',
      'fire.demoB',
      'ice.full',
      'ice.demoB',
      'lightning.full',
      'summon.full',
      'summon.demoA',
    ]);
    for (const index of [7, 10]) {
      const line = full.builds[index];
      const one = fuzz(12, 120, { only: line?.name as string });
      expect(one.builds).toEqual([line]);
      expect(one.runs).toBe(index === 10 ? 2 : 1);
    }
    expect(full.builds[10]?.name).toBe('fire.demoB.10');
    expect(() => fuzz(12, 120, { only: 'fire.full.10' })).toThrow(
      "runWebFuzz: --only 'fire.full.10': build 10 is dealt to 'fire.demoB'",
    );
    expect(() => fuzz(12, 120, { only: 'fire.10' })).toThrow('names no build');
    // A planted failure reproduces with its repro line's build alone.
    const plant = (draw: WebFuzzDraw) =>
      draw.index === 9
        ? [
            once(25, () => {
              throw new Error('again');
            }),
          ]
        : [];
    const failed = fuzz(12, 120, { modules: plant });
    const alone = fuzz(12, 120, { modules: plant, only: 'fire.demoA.9' });
    expect(alone.failures).toEqual(failed.failures);
    expect(alone.builds).toEqual([failed.builds[9]]);
  });

  it("draws §4.9's builds: purchases, slots, reveal, prestige, coef ends, start waves, hashes", () => {
    vi.mocked(sampleProgress).mockClear();
    const report = fuzz(90, 1);
    // sampleProgress buys with each build's draws, the third slot's account included: no fixture
    // build reaches a third core, so the progress alone would not show it.
    expect(vi.mocked(sampleProgress).mock.calls.map(([, , options]) => options)).toEqual(
      report.builds.map(({ purchases, account, bestWave, prestiged }) => ({
        purchases,
        account,
        bestWave,
        prestiged,
      })),
    );
    const webs = fuzzWebs(fixture);
    const share = (pick: (line: (typeof report.builds)[number]) => boolean): number =>
      report.builds.filter(pick).length / report.builds.length;
    const ends = new Set<string>();
    for (const line of report.builds) {
      expect(line.seed).toBe(deriveSeed(WEB_FUZZ_SEED, `webFuzz:${line.index}`));
      expect(line.purchases).toBeGreaterThanOrEqual(10);
      expect(line.purchases).toBeLessThanOrEqual(140);
      expect(line.ranks).toBeLessThanOrEqual(line.purchases);
      expect(WEB_FUZZ_WAVES).toContain(line.bestWave);
      expect(WEB_FUZZ_WAVES).toContain(line.startWave);
      expect(line.runs).toBe(line.index % 10 === 0 ? 2 : 1);
      expect(line.hash === null).toBe(line.index % 10 !== 0);
      const web = webs[line.index % webs.length];
      expect(`${line.character}.${line.scope}`).toBe(`${web?.character}.${web?.scope.name}`);
      if (line.coefs === null) continue;
      // line.coefs are read off the web the build ran on, so each end drawn is a coef run.
      for (const fusion of web?.fusions.values() ?? []) {
        const range = coefRange(fusion);
        const coef = line.coefs[fusion.key as FusionKey];
        if (range === null) expect(coef).toBe(1);
        else {
          expect(range).toContain(coef);
          ends.add(coef === range[0] ? 'lo' : 'hi');
        }
      }
    }
    expect(Math.min(...report.builds.map((line) => line.purchases))).toBeLessThan(40);
    expect(Math.max(...report.builds.map((line) => line.purchases))).toBeGreaterThan(110);
    expect(share((line) => line.account.singularityBeaten)).toBeGreaterThan(0.1);
    expect(share((line) => line.account.singularityBeaten)).toBeLessThan(0.4);
    expect(share((line) => line.prestiged)).toBeGreaterThan(0.15);
    expect(share((line) => line.prestiged)).toBeLessThan(0.45);
    expect(share((line) => line.coefs !== null)).toBeGreaterThan(0.2);
    expect(share((line) => line.coefs !== null)).toBeLessThan(0.5);
    expect([...ends].sort()).toEqual(['hi', 'lo']);
    for (const wave of WEB_FUZZ_WAVES) {
      expect(report.builds.some((line) => line.bestWave === wave)).toBe(true);
      expect(report.builds.some((line) => line.startWave === wave)).toBe(true);
    }
  });

  it("draws build i from createRng(deriveSeed(seed, 'webFuzz:' + i)), in the module's fixed order (L2, D3)", () => {
    const report = fuzz(24, 1);
    const webs = fuzzWebs(fixture);
    for (const line of report.builds) {
      const web = webs[line.index % webs.length] as AssembledWeb;
      const rng = createRng(deriveSeed(WEB_FUZZ_SEED, `webFuzz:${line.index}`));
      // 10–140 purchases, the third slot for a quarter, the reveal, a prestige for 30 %, every
      // fusion's coef at an end of its range for a third (each end by a fair coin, 1 with no
      // range), the start wave within the scope's cap, then sampleProgress on the same rng.
      const purchases = 10 + rng.int(131);
      const account = { singularityBeaten: rng.chance(0.25) };
      const bestWave = rng.pick(WEB_FUZZ_WAVES);
      const prestiged = rng.chance(0.3);
      let coefs: Partial<Record<FusionKey, number>> | null = null;
      if (rng.chance(1 / 3)) {
        coefs = {};
        for (const fusion of web.fusions.values()) {
          const range = coefRange(fusion);
          coefs[fusion.key] = range === null ? 1 : rng.chance(0.5) ? range[0] : range[1];
        }
      }
      const startWave = rng.pick(
        WEB_FUZZ_WAVES.filter((wave) => wave <= (web.scope.waveCap ?? Infinity)),
      );
      const built =
        coefs === null ? web : assembleWeb(fixture, web.character, web.scope, { coefs });
      const progress = sampleProgress(built, rng, { purchases, account, bestWave, prestiged });
      expect(line).toMatchObject({
        purchases,
        account,
        bestWave,
        prestiged,
        coefs,
        startWave,
        seed: deriveSeed(WEB_FUZZ_SEED, `webFuzz:${line.index}`),
        ids: built.nodes.filter((node) => storedRank(progress, node.id) > 0).map((node) => node.id),
      });
    }
    expect(report.builds.some((line) => line.coefs !== null)).toBe(true);
  });

  it('runs a build that owns three fusion cores under the checks, as only the third slot allows', () => {
    // No fixture draw of 10–140 purchases reaches a third core, so build fire.full.40, which drew
    // the third slot, makes 300 purchases here, from its own rng with its own account: three
    // cores, run twice under every check.
    const draw = vi.mocked(sampleProgress);
    const actual = draw.getMockImplementation() as typeof sampleProgress;
    draw.mockImplementationOnce((web, rng, options) =>
      actual(web, rng, { ...options, purchases: 300 }),
    );
    const report = fuzz(1, 600, { only: 'fire.full.40' });
    const [line] = report.builds;
    expect(line).toMatchObject({ account: { singularityBeaten: true }, runs: 2, stopped: false });
    const cores = new Set(
      [...(fuzzWebs(fixture)[0] as AssembledWeb).fusions.values()].flatMap((fusion) =>
        fusion.board.nodes.filter((node) => node.kind === 'core').map((node) => node.id),
      ),
    );
    expect(line?.ids.filter((id) => cores.has(id))).toHaveLength(3);
    expect(report.failures).toEqual([]);
  });

  it('runs no build of a content with no center, as the registered content before B1 (F57)', () => {
    const report = runWebFuzz({ content: registered, data, builds: 5, ticks: 60 });
    if (centered) expect(report.builds).toHaveLength(5);
    else {
      expect(report.webs).toEqual([]);
      expect([report.builds, report.failures, report.runs]).toEqual([[], [], 0]);
    }
  });

  it('runs a fixed case from its wave and says whether it cleared it, which is not a failure', () => {
    const order = fixture.characters.fire.defaultOrder;
    const at = { name: 'fire:default', character: 'fire', order, startWave: 30 } as const;
    const report = fuzz(0, 300, { cases: [at] });
    expect(report.builds).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.cases).toEqual([
      expect.objectContaining({ name: 'fire:default', index: -1, startWave: 30, runs: 1 }),
    ]);
    const line = report.cases[0];
    expect(line?.cleared).toBe((line?.highestWaveCleared ?? 0) >= 30);
    expect(fuzz(0, 300, { cases: [at], only: 'fire:default' }).cases).toEqual(report.cases);
  });

  it('holds no fixed case until 熔核 has a center, and the wave 30 case from then (S373)', () => {
    if (registered.characters.fire.center === null) expect(FIXED_WEB_CASES).toEqual([]);
    else {
      expect(FIXED_WEB_CASES).toContainEqual(
        expect.objectContaining({ character: 'fire', startWave: 30 }),
      );
    }
  });
});
