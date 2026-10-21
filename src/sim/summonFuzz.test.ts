/**
 * The summon fuzz in CHECK (docs/v3 C5 design D22, §8.1 C5.5): 20 seeded builds of drones and
 * turrets (summonFuzzBuilds, src/sim/testing.ts), each run from start waves 1 and 30 for 600
 * ticks, twice. Every run holds the checks of runSummonFuzz after every tick: every enemy's hp
 * and position and every summon's position finite, turrets included; the summons placed as the
 * cap says and never past it; the shots within PROJECTILE_CAP; no attack past CHAIN_HIT_CAP. The
 * two runs of a build must hash alike. tools/balance/fuzzSummons.ts runs 100 builds for 60 s.
 */

import { describe, expect, it } from 'vitest';
import { add, num, ONE } from '../core/num';
import { deriveSeed } from '../core/rng';
import type { SourcedTrigger } from '../data/stats';
import { CHAIN_HIT_CAP, DRONE_MEMORY, PROJECTILE_CAP, SUMMON_CAP } from './caps';
import type { TestModule } from './rules';
import { createSimulation } from './simulation';
import {
  checkSummonTick,
  makeTestData,
  runSummonFuzzCase,
  stressData,
  SUMMON_FUZZ_SEED,
  SUMMON_FUZZ_SHAPES,
  SUMMON_FUZZ_START_WAVES,
  summonFuzzBuilds,
  summonFuzzCap,
  summonFuzzConfig,
  summonFuzzModules,
  summonFuzzName,
  summonFuzzRows,
} from './testing';
import type { SummonFuzzBuild, SummonFuzzCase, SummonFuzzFailure, SummonFuzzRun } from './testing';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DRONE_DASH,
  DRONE_KIND_DRONE,
  DRONE_KIND_TURRET,
  NO_INPUT,
} from './types';

const BUILDS = summonFuzzBuilds(20);
const TICKS = 600;

const memo = new Map<string, SummonFuzzCase>();

/** The build's case from `startWave`, run once for the tests below. */
function fuzzCase(build: SummonFuzzBuild, startWave: number): SummonFuzzCase {
  const key = `${build.index}/${startWave}`;
  let found = memo.get(key);
  if (found === undefined) {
    found = runSummonFuzzCase(build, startWave, TICKS);
    memo.set(key, found);
  }
  return found;
}

/** Every case's first run. */
const allRuns = (): SummonFuzzRun[] =>
  BUILDS.flatMap((build) => SUMMON_FUZZ_START_WAVES.map((w) => fuzzCase(build, w).runs[0]));

const CASES = BUILDS.flatMap((build) =>
  SUMMON_FUZZ_START_WAVES.map((wave) => ({ index: build.index, shape: build.shape, wave })),
);

describe('summon fuzz', () => {
  it('draws every shape twice, with the summons, caps and stats they stand for', () => {
    expect(BUILDS.map((b) => b.shape)).toEqual([...SUMMON_FUZZ_SHAPES, ...SUMMON_FUZZ_SHAPES]);
    const swarms = BUILDS.flatMap((b) => (b.swarm === null ? [] : [b.swarm]));
    // D17: every swarm has a row; drone-only, turret-only and mixed ones.
    expect(swarms.every(([d, t]) => Number.isInteger(d + t) && d + t >= 1)).toBe(true);
    expect(swarms.some(([d, t]) => d > 0 && t === 0)).toBe(true);
    expect(swarms.some(([d, t]) => d === 0 && t > 0)).toBe(true);
    expect(swarms.some(([d, t]) => d > 0 && t > 0)).toBe(true);
    // Grants within validation's 24 slots, turret-only and zero-row ones among them (CHK7-7).
    const grants = BUILDS.flatMap((b) => b.grants);
    expect(grants.every(([d, t]) => Number.isInteger(d + t) && d + t <= SUMMON_CAP)).toBe(true);
    expect(grants.some(([d, t]) => d === 0 && t > 0)).toBe(true);
    expect(grants.some(([d, t]) => d === 0 && t === 0)).toBe(true);
    // A drone on an emitter index past the pool's rows (M1's volley, a zero-row grant, one drone).
    expect(BUILDS.some((b) => summonFuzzRows(b) < b.grants.length + 1)).toBe(true);
    // Over the cap at SUMMON_CAP, under a raised cap past SUMMON_CAP and past it, and with a
    // lowered summonCap, which leaves the cap at SUMMON_CAP.
    const over = (b: SummonFuzzBuild): boolean => summonFuzzRows(b) > summonFuzzCap(b);
    expect(BUILDS.some((b) => b.summonCap === null && over(b))).toBe(true);
    const raised = BUILDS.filter((b) => (b.summonCap ?? 0) > SUMMON_CAP);
    expect(raised.some((b) => summonFuzzRows(b) > SUMMON_CAP && !over(b))).toBe(true);
    expect(raised.some(over)).toBe(true);
    const lowered = BUILDS.filter((b) => b.summonCap !== null && b.summonCap < SUMMON_CAP);
    expect(lowered.some((b) => summonFuzzRows(b) > (b.summonCap as number))).toBe(true);
    // The stats on the summons' paths, a droneImpact trigger, the repeats, cadences, policies.
    const values = BUILDS.map((b) => b.stats.values);
    expect(values.some((v) => v.attackSpeed === 0)).toBe(true);
    expect(values.some((v) => v.attackSpeed >= 40)).toBe(true);
    expect(values.some((v) => v.projectileCount < 1)).toBe(true);
    expect(values.some((v) => v.projectileCount >= 5)).toBe(true);
    expect(values.some((v) => v.chainCount > CHAIN_HIT_CAP)).toBe(true);
    for (const stat of ['critChance', 'igniteChance', 'poisonChance', 'bleedChance'] as const) {
      expect(values.some((v) => v[stat] > 0)).toBe(true);
    }
    expect(values.some((v) => v.shockChance > 0)).toBe(true);
    const on = (event: string) => (b: SummonFuzzBuild) =>
      b.stats.triggers.some((t) => t.spec.on === event);
    expect(BUILDS.some((b) => b.swarm !== null && on('droneImpact')(b))).toBe(true);
    const repeats = (b: SummonFuzzBuild): boolean =>
      b.stats.triggers.some((t) => t.spec.do.some((e) => e.kind === 'repeatAttack'));
    expect(BUILDS.some((b) => b.swarm !== null && repeats(b))).toBe(true);
    expect(BUILDS.some((b) => typeof b.cadence === 'number')).toBe(true);
    expect(BUILDS.some((b) => b.cadence === 'random')).toBe(true);
    expect(BUILDS.some((b) => b.policy)).toBe(true);
    expect(BUILDS.some((b) => b.stress) && BUILDS.some((b) => !b.stress)).toBe(true);
  });

  it.each(CASES)(
    'build $index ($shape) from wave $wave holds every check, twice alike',
    ({ index, wave }) => {
      const result = fuzzCase(BUILDS[index] as SummonFuzzBuild, wave);
      expect(result.failures).toEqual([]);
      expect(result.runs.map((run) => run.ticks)).toEqual([TICKS, TICKS]);
    },
  );

  it('reaches every cap it checks, and its summons are busy', () => {
    const runs = allRuns();
    const total = (pick: (run: SummonFuzzRun) => number): number =>
      runs.reduce((sum, run) => sum + pick(run), 0);
    const counter = (run: SummonFuzzRun, id: 'summonCapped' | 'projectilesCapped') =>
      run.counters?.[id] ?? 0;
    // summonCapped, at SUMMON_CAP and at a raised cap; more than SUMMON_CAP placed.
    expect(runs.some((run) => run.cap === SUMMON_CAP && counter(run, 'summonCapped') > 0)).toBe(
      true,
    );
    expect(runs.some((run) => run.cap > SUMMON_CAP && counter(run, 'summonCapped') > 0)).toBe(true);
    expect(Math.max(...runs.map((run) => run.placed))).toBeGreaterThan(SUMMON_CAP);
    // PROJECTILE_CAP: reached by the pool's shots alone, and refusing.
    expect(Math.max(...runs.map((run) => run.peakShots))).toBe(PROJECTILE_CAP);
    expect(total((run) => counter(run, 'projectilesCapped'))).toBeGreaterThan(0);
    // CHAIN_HIT_CAP: reached, and refusing, on the linear chain and on a policy's.
    for (const policy of [false, true]) {
      const chained = BUILDS.filter((b) => b.policy === policy).flatMap((b) =>
        SUMMON_FUZZ_START_WAVES.map((w) => fuzzCase(b, w).runs[0]),
      );
      expect(Math.max(...chained.map((run) => run.counters?.chainHitsPeak ?? 0))).toBe(
        CHAIN_HIT_CAP,
      );
      expect(chained.some((run) => (run.counters?.chainHitCapped ?? 0) > 0)).toBe(true);
    }
    // Workload: impacts, repeats, firings and kills; every build that can act acts.
    expect(total((run) => run.impacts)).toBeGreaterThan(0);
    expect(total((run) => run.repeatImpacts)).toBeGreaterThan(0);
    expect(total((run) => run.firings)).toBeGreaterThan(0);
    expect(total((run) => run.kills)).toBeGreaterThan(0);
    for (const build of BUILDS) {
      if (build.stats.values.attackSpeed === 0) continue;
      const acted = SUMMON_FUZZ_START_WAVES.map((w) => fuzzCase(build, w).runs[0]).some(
        (run) => run.impacts + run.firings > 0,
      );
      expect(acted, `build ${build.index}`).toBe(true);
    }
  });
});

/** The first fuzz build with drones and turrets of the swarm that act. */
const HOST = BUILDS.find(
  (b) => b.swarm !== null && b.swarm[0] > 0 && b.swarm[1] > 0 && b.stats.values.attackSpeed > 0,
) as SummonFuzzBuild;

/** A test module that sets the first alive enemy's `field` to `value` on tick `at` or after. */
const plantEnemy =
  (field: 'x' | 'y' | 'hp', value: number, at: number): TestModule =>
  (b) => {
    let done = false;
    b.hook('tick', (ctx) => {
      if (done || ctx.now < at) return;
      const enemy = ctx.enemies.find((e) => e.alive);
      if (enemy === undefined) return;
      if (field === 'hp') enemy.hp = num(value);
      else enemy[field] = value;
      done = true;
    });
  };

/** A test module that sets the first summon of `kind`'s `field` to `value` on tick `at`. */
const plantSummon =
  (kind: number, field: 'x' | 'y', value: number, at: number): TestModule =>
  (b) =>
    void b.hook('tick', (ctx) => {
      if (ctx.now !== at) return;
      const ds = ctx.sys.drones;
      const s = Array.from(ds.kind.subarray(0, ds.count)).indexOf(kind);
      if (s >= 0) ds[field][s] = value;
    });

/** The failures of HOST's two runs from `startWave` with `plant`'s modules, 120 ticks each. */
const planted = (startWave: number, plant: () => readonly TestModule[] = () => []) =>
  runSummonFuzzCase(HOST, startWave, 120, plant).failures;

describe('summon fuzz checks, planted', () => {
  it('pass a clean run', () => {
    expect(HOST).toBeDefined();
    for (const wave of SUMMON_FUZZ_START_WAVES) expect(planted(wave)).toEqual([]);
  });

  it.each(SUMMON_FUZZ_START_WAVES)('catch an enemy x of NaN from wave %i', (wave) => {
    const failures = planted(wave, () => [plantEnemy('x', NaN, 30)]);
    // Each run stops on the tick; the drones dashing at the enemy went NaN with it.
    const enemy = failures.filter((f) => / enemy \d+ x NaN$/.test(f.text));
    expect(enemy.map((f) => /run \d: tick 30:/.exec(f.text)?.[0])).toEqual([
      'run 1: tick 30:',
      'run 2: tick 30:',
    ]);
    expect(failures.every((f) => f.kind === 'nonFinite' && f.text.includes(': tick 30: '))).toBe(
      true,
    );
  });

  it('catch an enemy hp of NaN and an enemy y of Infinity', () => {
    const hp = planted(30, () => [plantEnemy('hp', NaN, 20)]);
    expect(hp.map((f) => f.text)).toEqual([
      expect.stringMatching(/run 1: tick 20: enemy \d+ hp NaN$/),
      expect.stringMatching(/run 2: tick 20: enemy \d+ hp NaN$/),
    ]);
    const y = planted(1, () => [plantEnemy('y', Infinity, 20)]);
    expect(y.map((f) => f.text)).toEqual([
      expect.stringMatching(/run 1: tick 20: enemy \d+ y Infinity$/),
      expect.stringMatching(/run 2: tick 20: enemy \d+ y Infinity$/),
    ]);
  });

  it('catch an Infinity, not only a NaN: in an enemy hp and x, and in a turret row x', () => {
    const hp = planted(30, () => [plantEnemy('hp', Infinity, 20)]);
    expect(hp.map((f) => f.text)).toEqual([
      expect.stringMatching(/run 1: tick 20: enemy \d+ hp Infinity$/),
      expect.stringMatching(/run 2: tick 20: enemy \d+ hp Infinity$/),
    ]);
    const x = planted(1, () => [plantEnemy('x', -Infinity, 20)]);
    expect(x.map((f) => f.text)).toEqual([
      expect.stringMatching(/run 1: tick 20: enemy \d+ x -Infinity$/),
      expect.stringMatching(/run 2: tick 20: enemy \d+ x -Infinity$/),
    ]);
    const turret = planted(30, () => [plantSummon(DRONE_KIND_TURRET, 'x', Infinity, 1)]);
    expect(turret.map((f) => f.text)).toEqual([
      expect.stringMatching(/run 1: tick 1: turret \d+ x Infinity$/),
      expect.stringMatching(/run 2: tick 1: turret \d+ x Infinity$/),
    ]);
  });

  it('catch a turret row x of NaN and a drone row y of Infinity at wave 1', () => {
    const turret = planted(1, () => [plantSummon(DRONE_KIND_TURRET, 'x', NaN, 1)]);
    expect(turret.map((f) => f.text)).toEqual([
      expect.stringMatching(/run 1: tick 1: turret \d+ x NaN$/),
      expect.stringMatching(/run 2: tick 1: turret \d+ x NaN$/),
    ]);
    const drone = planted(1, () => [plantSummon(DRONE_KIND_DRONE, 'y', Infinity, 1)]);
    expect(drone.map((f) => f.kind)).toEqual(['nonFinite', 'nonFinite']);
    expect(drone[0]?.text).toMatch(/run 1: tick 1: drone 1 y Infinity$/);
  });

  it('catch chainHitsPeak past CHAIN_HIT_CAP', () => {
    const peak: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        if (ctx.now === 10) ctx.counters.chainHitsPeak = CHAIN_HIT_CAP + 1;
      });
    const failures = planted(30, () => [peak]);
    expect(failures.map((f) => [f.kind, f.text.replace(/^.*: tick/, 'tick')])).toEqual([
      ['cap', 'tick 10: chainHitsPeak 33, past CHAIN_HIT_CAP'],
      ['cap', 'tick 10: chainHitsPeak 33, past CHAIN_HIT_CAP'],
    ]);
  });

  it('catch two runs that differ: a module whose state outlives its run', () => {
    let runs = 0;
    // The second run gains one shard more on tick 50, which its result carries.
    const leak: TestModule = (b) => {
      const run = ++runs;
      b.hook('tick', (ctx) => {
        if (run === 2 && ctx.now === 50) ctx.state.shards = add(ctx.state.shards, ONE);
      });
    };
    const failures = planted(30, () => [leak]);
    expect(failures.map((f) => f.kind)).toEqual(['hash']);
    expect(failures[0]?.text).toMatch(/from wave 30: runs differ \([0-9a-f]{16}, [0-9a-f]{16}\)$/);
  });
});

describe('summon fuzz builds', () => {
  it('rebuild any build from its index: summonFuzzBuilds(i + 1)[i], with the seed its name prints', () => {
    const tool = summonFuzzBuilds(100);
    // The tool's 100 builds start with CHECK's 20.
    expect(tool.slice(0, BUILDS.length)).toEqual(BUILDS);
    for (const i of [0, 19, 36, 96, 99]) {
      const alone = summonFuzzBuilds(i + 1)[i] as SummonFuzzBuild;
      expect(alone).toEqual(tool[i]);
      expect(alone.index).toBe(i);
      expect(alone.seed).toBe(deriveSeed(SUMMON_FUZZ_SEED, `summonFuzz:${i}`));
      expect(summonFuzzName(alone)).toBe(`build ${i} (seed ${alone.seed}, ${alone.shape})`);
    }
  });
});

/** HOST's failure prefix from `startWave`, run `run`. */
const named = (startWave: number, run: number): string =>
  `${summonFuzzName(HOST)} from wave ${startWave}, run ${run}`;

describe('summon fuzz checks, planted past the cap, the layout and a throw', () => {
  it('catch more summons than the cap the fuzz expects: the layout and droneCount at tick 0', () => {
    const rows = summonFuzzRows(HOST);
    expect(rows).toBeGreaterThan(SUMMON_CAP);
    expect(summonFuzzCap(HOST)).toBe(SUMMON_CAP);
    // A summonCap the build does not declare: the run places every row, past SUMMON_CAP.
    const raised = Object.assign(() => undefined, { summonCap: rows });
    expect(planted(1, () => [raised]).map((f) => [f.kind, f.text])).toEqual(
      [1, 2].flatMap((run) => [
        [
          'layout',
          `${named(1, run)}: tick 0: ${rows} summons placed of ${rows}, not ${SUMMON_CAP} ` +
            `(cap ${SUMMON_CAP})`,
        ],
        ['cap', `${named(1, run)}: tick 0: ${rows} summons, past the cap ${SUMMON_CAP}`],
      ]),
    );
  });

  it('catch a summonCapped other than the rows the cap refused', () => {
    const refused = summonFuzzRows(HOST) - SUMMON_CAP;
    const bump: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        if (ctx.now === 5) ctx.counters.summonCapped++;
      });
    expect(planted(30, () => [bump]).map((f) => [f.kind, f.text])).toEqual(
      [1, 2].map((run) => [
        'layout',
        `${named(30, run)}: summonCapped ${refused + 1}, not the ${refused} refused`,
      ]),
    );
  });

  it('catch a run that throws, on the tick it throws', () => {
    const boom: TestModule = (b) =>
      void b.hook('tick', (ctx) => {
        if (ctx.now === 7) throw new Error('planted');
      });
    expect(planted(30, () => [boom]).map((f) => [f.kind, f.text])).toEqual(
      [1, 2].map((run) => ['threw', `${named(30, run)}: tick 7: threw planted`]),
    );
  });

  it('catch shots, projectiles with shots, and summons past their caps, and pass each at it', () => {
    // M1 with turret grants: the volley's projectiles and the pool's shots share the cap.
    const build = BUILDS.find((b) => b.shape === 'turretGrants') as SummonFuzzBuild;
    const data = build.stress ? stressData() : makeTestData();
    const sim = createSimulation(summonFuzzConfig(build, 1, TICKS), data, summonFuzzModules(build));
    const { state } = sim;
    while (state.projectiles.length === 0 && !state.finished) sim.step(NO_INPUT);
    const flying = state.projectiles.length;
    const placed = state.droneCount;
    expect(flying).toBeGreaterThan(0);
    expect(placed).toBeGreaterThan(0);
    const check = (shots: number, cap: number): string[] => {
      const out: SummonFuzzFailure[] = [];
      checkSummonTick({ ...state, shotCount: shots }, cap, null, out);
      return out.map((f) => `${f.kind}: ${f.text}`);
    };
    const at = `tick ${state.tick}`;
    expect(check(PROJECTILE_CAP - flying, placed)).toEqual([]);
    expect(check(PROJECTILE_CAP - flying + 1, placed)).toEqual([
      `cap: ${at}: ${PROJECTILE_CAP + 1} projectiles and shots, past PROJECTILE_CAP`,
    ]);
    expect(check(PROJECTILE_CAP + 1, placed)).toEqual([
      `cap: ${at}: ${PROJECTILE_CAP + 1} shots, past PROJECTILE_CAP`,
      `cap: ${at}: ${PROJECTILE_CAP + 1 + flying} projectiles and shots, past PROJECTILE_CAP`,
    ]);
    expect(check(0, placed - 1)).toEqual([
      `cap: ${at}: ${placed} summons, past the cap ${placed - 1}`,
    ]);
  });
});

/** A droneImpact push (C4's push effect) that throws the impact's enemies past the arena's edge. */
const PUSH_OUT: SourcedTrigger = {
  source: 'center',
  spec: { on: 'droneImpact', do: [{ kind: 'push', distance: 400, radius: 60 }] },
};

describe('summon fuzz, pushed out of the arena', () => {
  it.each([0, HOST.index])(
    'build %i from wave 30 holds every check while its impacts push their targets out, and its drones drop them there (CD8)',
    (index) => {
      const base = BUILDS[index] as SummonFuzzBuild;
      const build = {
        ...base,
        stats: { ...base.stats, triggers: [...base.stats.triggers, PUSH_OUT] },
      };
      // The DASH slots whose target is alive with its center outside the arena when the tick hooks
      // run: nothing moves an enemy between them and the drone stage, which drops each such target
      // that tick. One the slot impacted is in its live memory (it sits on it); else it dashes at it.
      // A slot that still dashes at the same target outside the arena a tick later kept it.
      const lost = { sitting: 0, dashing: 0, kept: 0 };
      const watch: TestModule = (b) => {
        let last = new Map<number, number>();
        b.hook('tick', (ctx) => {
          const ds = ctx.sys.drones;
          const seen = new Map<number, number>();
          for (let s = 0; s < ds.count; s++) {
            const t = ds.target[s];
            if (ds.mode[s] !== DRONE_DASH || t === null || t === undefined || !t.alive) continue;
            if (t.x >= 0 && t.x <= ARENA_WIDTH && t.y >= 0 && t.y <= ARENA_HEIGHT) continue;
            let sitting = false;
            for (let k = s * DRONE_MEMORY; k < (s + 1) * DRONE_MEMORY; k++) {
              if (ds.memId[k] === t.id && (ds.memUntil[k] as number) > ctx.now) sitting = true;
            }
            if (sitting) lost.sitting++;
            else lost.dashing++;
            if (last.get(s) === t.id) lost.kept++;
            seen.set(s, t.id);
          }
          last = seen;
        });
      };
      const result = runSummonFuzzCase(build, 30, TICKS, () => [watch]);
      expect(result.failures).toEqual([]);
      expect(result.runs.map((run) => run.ticks)).toEqual([TICKS, TICKS]);
      expect(result.runs[0].impacts).toBeGreaterThan(0);
      expect(lost.sitting).toBeGreaterThan(0);
      expect(lost.dashing).toBeGreaterThan(0);
      expect(lost.kept).toBe(0);
    },
  );
});
