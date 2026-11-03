import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mul, num } from '../../core/num';
import type { SourcedEmitter } from '../../data/emitters';
import { RULE_IDS } from '../../data/rules';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { StatId } from '../../data/stats';
import { TAG } from '../../data/tags';
import type { TriggerSpec } from '../../data/triggers';
import { compileBuild } from '../build/compile';
import { runLob } from '../emitters/lob';
import { createPayload, ROWS } from '../emitters/types';
import type { EmitterRuntime, OrbMemory } from '../emitters/types';
import { createSimulation } from '../simulation';
import { createRunContext } from '../systems/context';
import type { RunContext } from '../systems/context';
import { MOTION_STRAIGHT, spawnShot, stepShot } from '../systems/shots';
import {
  eventsOf,
  makeConfig,
  makeStats,
  makeTestData,
  placedEnemies,
  rngPositions,
} from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH, DRONE_KIND_DRONE, DRONE_KIND_TURRET, NO_INPUT } from '../types';
import { gigantism } from './gigantism';
import { RULE_MODULES } from './index';
import type { TestModule } from './index';

const GIANT: RuleSpec = { id: 'gigantism', sizeMult: 2 };
const MAGMA: SignatureSpec = { id: 'magmaBomb' };
const P = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/** A run of `signature` (M1's volley when omitted) at `values`, with `rules` and `emitters`. */
function run(
  values: Partial<Record<StatId, number>>,
  rules: readonly RuleSpec[],
  signature?: SignatureSpec,
  emitters: readonly SourcedEmitter[] = [],
): RunContext {
  return placedEnemies([], {
    stats: makeStats({ critChance: 0, igniteChance: 0, ...values }, [], {
      triggers: [],
      conversions: [],
      emitters,
    }),
    rules,
    ...(signature === undefined ? {} : { signature }),
  });
}

describe('巨大化 (gigantism, gd:268)', () => {
  it('is a rule module registered as glassCannon is: its RuleSpec id, RULE_IDS and RULE_MODULES', () => {
    // Appended after sixCoils (E1), with B1's and E2's modules after it.
    expect(RULE_IDS).toContain('gigantism');
    expect(RULE_IDS).toContain('poisonSlow');
    expect(RULE_MODULES.gigantism).toBe(gigantism);
    expect(gigantism.id).toBe('gigantism');
  });

  it('sets the size factor and the halving at compile, the first instance’s sizeMult, and no stat', () => {
    const stats = makeStats({ areaSize: 1.25 });
    const plain = compileBuild(stats, []).flags;
    expect([plain.sizeFactor, plain.halveCounts, plain.areaFactor]).toEqual([1, false, 1.25]);
    const giant = compileBuild(stats, [GIANT]);
    expect([giant.flags.sizeFactor, giant.flags.halveCounts]).toEqual([2, true]);
    expect(giant.flags.areaFactor).toBe(1.25 * 2);
    // Its halving is countOf's at the reads, never a scaleStat: every value stays as it was.
    expect(giant.values).toEqual(stats.values);
    const twice = compileBuild(stats, [{ id: 'gigantism', sizeMult: 3 }, GIANT]).flags;
    expect([twice.sizeFactor, twice.areaFactor]).toEqual([3, 1.25 * 3]);
  });

  it("halves magmaBomb's bombs after D5's −1, floored, at least 1: D29's four cases", () => {
    const bombs = (raw: number, rules: readonly RuleSpec[]): number =>
      run({ projectileCount: raw }, rules, MAGMA).projectileCount;
    // raw 5 → 4 → 2; raw 4 → 3 → 1 (not 1.5); raw 3 → 2 → 1; raw 2 → 1 → 1 (not 0.5).
    expect([5, 4, 3, 2].map((raw) => bombs(raw, [GIANT]))).toEqual([2, 1, 1, 1]);
    expect([5, 4, 3, 2].map((raw) => bombs(raw, []))).toEqual([4, 3, 2, 1]);
    // Before the −1 (Q3/F14's other fork) raw 5 would give floor(5 / 2) − 1 = 1.
    expect(bombs(5, [GIANT])).not.toBe(1);
    expect(bombs(7, [GIANT])).toBe(3);
  });

  it('throws the halved bombs and rolls no fraction: raw 4.6 is one bomb, nothing drawn', () => {
    const firing = (raw: number, rules: readonly RuleSpec[]) => {
      const ctx = placedEnemies(
        [
          { x: 1300, y: 500 },
          { x: 1500, y: 500 },
          { x: 1700, y: 500 },
        ],
        { stats: makeStats({ critChance: 0, projectileCount: raw }), rules, signature: MAGMA },
      );
      const em = ctx.emitters[0] as EmitterRuntime;
      const before = rngPositions(ctx);
      em.acc = em.interval - em.cadence;
      ctx.events.length = 0;
      runLob(ctx, em);
      const lobs = eventsOf([ctx.events], 'lob').length;
      const drew = JSON.stringify(rngPositions(ctx)) !== JSON.stringify(before);
      return { count: ctx.projectileCount, lobs, drew };
    };
    expect(firing(4.6, [GIANT])).toEqual({ count: 1, lobs: 1, drew: false });
    expect(firing(6, [GIANT])).toEqual({ count: 2, lobs: 2, drew: false });
    // Without it 3.6 bombs: three, and a drawn chance of a fourth.
    expect(firing(4.6, [])).toMatchObject({ drew: true });
    expect(firing(4.6, []).count).toBeCloseTo(3.6, 12);
  });

  it("halves the volley's projectiles and a turret's shots, which read the same count", () => {
    expect(run({ projectileCount: 5 }, [GIANT]).projectileCount).toBe(2);
    expect(run({ projectileCount: 3.5 }, [GIANT]).projectileCount).toBe(1);
    expect(run({ projectileCount: 1 }, [GIANT]).projectileCount).toBe(1);
    expect(run({ projectileCount: 3.5 }, []).projectileCount).toBe(3.5);
    // swarm's turret fires projectileCount − 1 shots: raw 5 → 4 → 2.
    expect(run({ projectileCount: 5 }, [GIANT], { id: 'swarm' }).projectileCount).toBe(2);
  });

  it("halves the ice fan's cones after iceFan's +3: raw 2 → 5 → 2, raw 3 → 6 → 3", () => {
    const cones = (raw: number, rules: readonly RuleSpec[]): number =>
      run({ projectileCount: raw }, rules, { id: 'iceFan' }).projectileCount;
    expect([2, 3].map((raw) => cones(raw, [GIANT]))).toEqual([2, 3]);
    expect([2, 3].map((raw) => cones(raw, []))).toEqual([5, 6]);
  });

  it('halves the chain jumps, floored, at least 1, none from none: triphaseArc’s +2 first', () => {
    const jumps = (raw: number, rules: readonly RuleSpec[], signature?: SignatureSpec) =>
      run({ chainCount: raw }, rules, signature).chainCount;
    expect([0, 0.5, 1, 2, 2.5, 3, 4.5, 9].map((raw) => jumps(raw, [GIANT]))).toEqual([
      0, 0, 1, 1, 1, 1, 2, 4,
    ]);
    expect([0, 1, 3, 4.5].map((raw) => jumps(raw, []))).toEqual([0, 1, 3, 4.5]);
    const arc: SignatureSpec = { id: 'triphaseArc' };
    expect([1, 2].map((raw) => jumps(raw, [GIANT], arc))).toEqual([1, 2]);
    expect([1, 2].map((raw) => jumps(raw, [], arc))).toEqual([3, 4]);
  });

  it('halves the drones of every drone emitter at the fill, the swarm’s and each grant’s, never its turrets', () => {
    const grants: SourcedEmitter[] = [
      { source: 'outer.summon', grant: { kind: 'drone', name: 'a', drones: 4, turrets: 2 } },
      { source: 'outer.summon', grant: { kind: 'drone', name: 'b', drones: 1 } },
      { source: 'outer.summon', grant: { kind: 'drone', name: 'c', turrets: 3 } },
      { source: 'outer.summon', grant: { kind: 'drone', name: 'd', drones: 5, turrets: 1 } },
    ];
    const placed = (rules: readonly RuleSpec[]): number[][] => {
      const ds = run({}, rules, { id: 'swarm' }, grants).sys.drones;
      return [0, 1, 2, 3, 4].map((i) => {
        const of = (kind: number): number =>
          Array.from(ds.owner).filter((o, s) => o === i && ds.kind[s] === kind).length;
        return [of(DRONE_KIND_DRONE), of(DRONE_KIND_TURRET)];
      });
    };
    expect(placed([])).toEqual([
      [3, 1],
      [4, 2],
      [1, 0],
      [0, 3],
      [5, 1],
    ]);
    expect(placed([GIANT])).toEqual([
      [1, 1],
      [2, 2],
      [1, 0],
      [0, 3],
      [2, 1],
    ]);
  });

  it('leaves the orbs as they are: count + floor(orbitCount), none of the four counts', () => {
    const orbs = (rules: readonly RuleSpec[]): number[] => {
      const ctx = run({ orbitCount: 1.5 }, rules, undefined, [
        { source: 'outer.aura', grant: { kind: 'orbit', count: 3 } },
        { source: 'outer.aura', grant: { kind: 'orbit', ring: 1, count: 2 } },
      ]);
      return [1, 2].map((i) => ((ctx.emitters[i] as EmitterRuntime).orbs as OrbMemory).n);
    };
    expect(orbs([])).toEqual([4, 3]);
    expect(orbs([GIANT])).toEqual([4, 3]);
  });

  it('doubles a straight shot’s hit radius once, in pathHits, and leaves a point a point; areaSize never', () => {
    // An enemy of radius 10 that a shot along y = P.y passes `offset` below, at `areaSize`.
    const hits = (
      rules: readonly RuleSpec[],
      radius: number,
      offset: number,
      areaSize = 1,
    ): number => {
      const ctx = placedEnemies([{ x: P.x + 100, y: P.y + offset, radius: 10 }], {
        stats: makeStats({ critChance: 0, igniteChance: 0, areaSize }),
        rules,
      });
      const payload = createPayload({
        baseDamage: mul(num(ctx.build.values.damage), 0.5),
        tags: TAG.hit | TAG.projectile,
        source: 0,
        flags: 0,
        rng: ctx.effectsRng,
        chains: false,
        rollsAilments: false,
        canCrit: true,
        damageMode: ROWS,
      });
      const s = spawnShot(
        ctx,
        MOTION_STRAIGHT,
        P.x,
        P.y,
        200,
        0,
        ctx.now + 100,
        payload,
        1,
        -1,
        0,
        0,
        -1,
        false,
        -1,
        -1,
        null,
      );
      ctx.shots.radius[s] = radius;
      ctx.events.length = 0;
      stepShot(ctx, s);
      return eventsOf([ctx.events], 'hit').length;
    };
    // Reach 10 + 14 = 24 without it, 10 + 28 = 38 under it: once, not 10 + 56.
    expect([hits([], 14, 24), hits([], 14, 25)]).toEqual([1, 0]);
    expect([hits([GIANT], 14, 38), hits([GIANT], 14, 38.01)]).toEqual([1, 0]);
    expect([hits([GIANT], 0, 10), hits([GIANT], 0, 10.01)]).toEqual([1, 0]);
    // areaSize sizes areas, not a projectile: at 1.5 the reach stays 24, and 38 under 巨大化.
    expect([hits([], 14, 24, 1.5), hits([], 14, 25, 1.5)]).toEqual([1, 0]);
    expect([hits([GIANT], 14, 38, 1.5), hits([GIANT], 14, 38.01, 1.5)]).toEqual([1, 0]);
  });
});

describe('巨大化’s counts are halved once, where the run reads them (lead ruling G4, D29)', () => {
  // A repeat every third attack, so each signature's repeat step reads its count too.
  const REPEAT_EVERY_3: TriggerSpec = {
    on: 'nthAttack',
    every: 3,
    do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }],
  };
  /** One signature at raw counts under 巨大化, and the raw counts a plain run halves to. */
  interface CountCase {
    readonly signature: SignatureSpec;
    readonly giant: Partial<Record<StatId, number>>;
    readonly plain: Partial<Record<StatId, number>>;
    /** The run's projectileCount and chainCount, both runs alike. */
    readonly counts: readonly [number, number];
    /** The plain run's drones of the swarm, which 巨大化 halves at the fill. */
    readonly swarmDrones?: number;
  }
  const CASES: readonly CountCase[] = [
    {
      signature: { id: 'm1Volley' },
      giant: { projectileCount: 8, chainCount: 6 },
      plain: { projectileCount: 4, chainCount: 3 },
      counts: [4, 3],
    },
    {
      signature: MAGMA,
      giant: { projectileCount: 9, chainCount: 6 },
      plain: { projectileCount: 5, chainCount: 3 },
      counts: [4, 3],
    },
    {
      signature: { id: 'iceFan' },
      giant: { projectileCount: 5, chainCount: 6 },
      plain: { projectileCount: 1, chainCount: 3 },
      counts: [4, 3],
    },
    {
      signature: { id: 'triphaseArc' },
      giant: { projectileCount: 2, chainCount: 6 },
      plain: { projectileCount: 1, chainCount: 2 },
      counts: [1, 4],
    },
    {
      signature: { id: 'swarm' },
      giant: { projectileCount: 9, chainCount: 6 },
      plain: { projectileCount: 5, chainCount: 3 },
      counts: [4, 3],
      swarmDrones: 1,
    },
  ];
  const statsAt = (values: Partial<Record<StatId, number>>) =>
    makeStats({ maxLife: 1e6, critChance: 0.2, igniteChance: 0.3, ...values }, [], {
      triggers: [{ source: 'center', spec: REPEAT_EVERY_3 }],
      conversions: [],
      emitters: [],
    });
  /** The plain run's module: the swarm's drones as 巨大化 leaves them. */
  const dronesModule = (drones: number): TestModule => {
    const module: TestModule = (b) => {
      const swarm = b.signature().swarm;
      if (swarm !== null) swarm.drones = drones;
    };
    return module;
  };
  /** Every tick's events and the result of a 600-tick run at wave 12, hashed. */
  const digest = (
    signature: SignatureSpec,
    values: Partial<Record<StatId, number>>,
    rules: readonly RuleSpec[],
    modules: readonly TestModule[],
  ): string => {
    const config = makeConfig({
      stats: statsAt(values),
      rules,
      signature,
      startWave: 12,
      maxTicks: 600,
    });
    const sim = createSimulation(config, makeTestData(), modules);
    const hash = createHash('sha256');
    while (!sim.state.finished) hash.update(JSON.stringify(sim.step(NO_INPUT)));
    hash.update(JSON.stringify(sim.result().damageBySource));
    return hash.digest('hex');
  };

  it.each(CASES)(
    'plays $signature.id under 巨大化 as a plain run at the halved counts, its areas at areaSize 2',
    ({ signature, giant, plain, counts, swarmDrones }) => {
      const modules = swarmDrones === undefined ? [] : [dronesModule(swarmDrones)];
      const plainValues = { ...plain, areaSize: 2 };
      const ctxOf = (values: Partial<Record<StatId, number>>, rules: readonly RuleSpec[]) =>
        createRunContext(
          makeConfig({ stats: statsAt(values), rules, signature }),
          makeTestData(),
          rules.length === 0 ? modules : [],
        );
      const g = ctxOf(giant, [GIANT]);
      const p = ctxOf(plainValues, []);
      expect([g.projectileCount, g.chainCount]).toEqual(counts);
      expect([p.projectileCount, p.chainCount]).toEqual(counts);
      expect(g.build.flags.areaFactor).toBe(p.build.flags.areaFactor);
      expect(g.sys.drones.count).toBe(p.sys.drones.count);
      // Every emitter, its repeats, its chains and its turrets read the one halved count: a
      // second halving anywhere would play fewer shots, cones, bombs or jumps than the plain run.
      expect(digest(signature, giant, [GIANT], [])).toBe(
        digest(signature, plainValues, [], modules),
      );
      // And the run is sensitive to the counts: the plain run at the giant's raw counts differs.
      expect(digest(signature, { ...giant, areaSize: 2 }, [], modules)).not.toBe(
        digest(signature, plainValues, [], modules),
      );
    },
  );

  it('halves the counts whatever its sizeMult: a 巨大化 of sizeMult 1 halves, and sizes nothing', () => {
    const one: RuleSpec = { id: 'gigantism', sizeMult: 1 };
    const ctx = run({ projectileCount: 5, chainCount: 4 }, [one]);
    expect([ctx.projectileCount, ctx.chainCount]).toEqual([2, 2]);
    expect([ctx.build.flags.sizeFactor, ctx.build.flags.areaFactor]).toEqual([1, 1]);
    expect(run({ projectileCount: 5 }, [one], MAGMA).projectileCount).toBe(2);
  });
});
