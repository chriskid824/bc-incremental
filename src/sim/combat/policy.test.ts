import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import type { EnemyId } from '../../data/types';
import { activeShockStacks } from '../ailments/shock';
import { compileBuild } from '../build/compile';
import { CHAIN_HIT_CAP, EXTRA_JUMP_CAP } from '../caps';
import { PRIMARY } from '../effects/flags';
import { createPayload, ROWS } from '../emitters/types';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import { compilePolicy, NO_POLICY_SPEC } from '../systems/systemState';
import type { ChainPolicySpec } from '../systems/systemState';
import {
  eventsOf,
  GOLDEN_BUILDS,
  makeConfig,
  makeStats,
  makeTestData,
  maskProbeMods,
  placedEnemies,
  rngPositions,
} from '../testing';
import type { PlacedEnemy, PlacedOptions } from '../testing';
import { NO_INPUT } from '../types';
import { beginAttack, chainAttack, chainFrom, endAttack, primaryHit } from './chain';
import { chainGeneral, farthestChainTarget } from './policy';

const signaturePayload = (ctx: RunContext): Payload => (ctx.emitters[0] as EmitterRuntime).payload;

/** A module that writes the build's chain policy. */
const policyModule =
  (edit: (spec: ChainPolicySpec) => void): TestModule =>
  (b) => {
    edit(b.chainPolicy());
  };

/** `count` immortal squares on a grid of 20 per row, 20 apart: all within one chain's range. */
const rows = (count: number): PlacedEnemy[] =>
  Array.from({ length: count }, (_, i) => ({
    x: 100 + 20 * (i % 20),
    y: 100 + 20 * Math.floor(i / 20),
  }));

/** `count` immortal squares on one line, 20 apart from x = 100: each one's nearest is the next. */
const line = (count: number): PlacedEnemy[] =>
  Array.from({ length: count }, (_, i) => ({ x: 100 + 20 * i, y: 100 }));

const CHAINS = makeStats({ chainRange: 5000, critChance: 0, igniteChance: 0 });

/** A context of `placed` whose chain policy `edit` writes, and its signature payload. */
function withPolicy(
  placed: readonly PlacedEnemy[],
  edit: (spec: ChainPolicySpec) => void,
  options: PlacedOptions = {},
): RunContext {
  return placedEnemies(placed, {
    stats: CHAINS,
    ...options,
    modules: [...(options.modules ?? []), policyModule(edit)],
  });
}

/** One attack of the signature payload on enemies[primary]; its hit events. */
function attack(ctx: RunContext, count: number, primary = 0, steady = false) {
  const before = ctx.events.length;
  chainAttack(ctx, signaturePayload(ctx), ctx.enemies[primary] as Enemy, count, steady, 0, -1);
  return eventsOf([ctx.events.slice(before)], 'hit');
}

/** A payload's members are readonly; the differential test's switch writes general anyway. */
function forceGeneral(p: Payload): void {
  (p as { general: boolean }).general = true;
}

/** Every chain payload of the run: the emitters' and the repeats'. */
function forceGeneralAll(ctx: RunContext): void {
  for (const em of ctx.emitters) forceGeneral(em.payload);
  for (const p of ctx.sys.repeat.payloads) if (p !== null) forceGeneral(p);
}

describe('the policy compile', () => {
  it('forks into [1, branchFirst, branchLater], and not at all without a fork', () => {
    const of = (branchFirst: number, branchLater: number): number[] => [
      ...compilePolicy({ ...NO_POLICY_SPEC, branchFirst, branchLater }, 0.5).branch,
    ];
    expect([...compilePolicy(NO_POLICY_SPEC, 0.5).branch]).toEqual([1, 1]);
    expect(of(3, 2)).toEqual([1, 3, 2]);
    expect(of(1, 2)).toEqual([1, 1, 2]);
    expect(of(3, 1)).toEqual([1, 3, 1]);
  });

  it("without decay forms the linear chain's retention, bit for bit", () => {
    const rng = createRng(16);
    for (let i = 0; i < 40; i++) {
      const retention = i === 0 ? 1 : i === 1 ? 0 : rng.next();
      const scale = compilePolicy(NO_POLICY_SPEC, retention).scale;
      expect(scale).toHaveLength(CHAIN_HIT_CAP + EXTRA_JUMP_CAP + 1);
      let product = 1;
      for (let k = 0; k < scale.length; k++) {
        expect(Object.is(scale[k], product), `retention ${retention}, level ${k}`).toBe(true);
        product *= retention;
      }
    }
  });

  it("puts a decay entry's factor in place of chainRetention, the last entry's on overlaps", () => {
    const R = 0.6;
    /** Whether the table's first levels are the running product of `factors`, levels 1 on. */
    const productOf = (decay: ChainPolicySpec['decay'], factors: number[]): void => {
      const scale = compilePolicy({ ...NO_POLICY_SPEC, decay }, R).scale;
      const expected = [1];
      for (const f of factors) expected.push((expected.at(-1) as number) * f);
      expect([...scale.slice(0, expected.length)]).toEqual(expected);
    };
    // 電荷: level 1 keeps full damage.
    const charge = compilePolicy({ ...NO_POLICY_SPEC, decay: [{ from: 1, to: 1, factor: 1 }] }, R);
    expect([...charge.scale.slice(0, 4)]).toEqual([1, 1, R, R * R]);
    // 蓄電: from level 3 on, each level gains 15%.
    const store = compilePolicy({ ...NO_POLICY_SPEC, decay: [{ from: 3, factor: 1.15 }] }, R);
    expect([...store.scale.slice(0, 5)]).toEqual([1, R, R * R, R * R * 1.15, R * R * 1.15 * 1.15]);
    // A running product to the last level, CHAIN_HIT_CAP + EXTRA_JUMP_CAP.
    let product = R * R;
    for (let k = 3; k <= CHAIN_HIT_CAP + EXTRA_JUMP_CAP; k++) product *= 1.15;
    expect(store.scale[CHAIN_HIT_CAP + EXTRA_JUMP_CAP]).toBe(product);
    // Both, and an entry whose range ends.
    const both = compilePolicy(
      {
        ...NO_POLICY_SPEC,
        decay: [
          { from: 1, to: 1, factor: 1 },
          { from: 3, factor: 1.15 },
        ],
      },
      R,
    );
    expect([...both.scale.slice(0, 5)]).toEqual([1, 1, R, R * 1.15, R * 1.15 * 1.15]);
    productOf([{ from: 2, to: 3, factor: 0.9 }], [R, 0.9, 0.9, R, R]);
    // Overlapping entries: the later one.
    productOf(
      [
        { from: 2, factor: 0.9 },
        { from: 3, to: 4, factor: 1 },
      ],
      [R, 0.9, 1, 1, 0.9],
    );
  });

  it('copies extraJumpChance, bounces and lastFarthest', () => {
    const pol = compilePolicy(
      { ...NO_POLICY_SPEC, extraJumpChance: 0.25, bounces: 3, lastFarthest: true },
      0.5,
    );
    expect([pol.extraJumpChance, pol.bounces, pol.lastFarthest]).toEqual([0.25, 3, true]);
  });

  it('keeps NO_POLICY_SPEC frozen: a module writes its own copy', () => {
    expect(Object.isFrozen(NO_POLICY_SPEC)).toBe(true);
    expect(Object.isFrozen(NO_POLICY_SPEC.decay)).toBe(true);
    const build = compileBuild(CHAINS, [], undefined, [
      policyModule((spec) => {
        spec.branchFirst = 3;
        spec.decay.push({ from: 1, to: 1, factor: 1 });
      }),
    ]);
    expect(build.chainPolicy).not.toBe(NO_POLICY_SPEC);
    expect(build.chainPolicy?.decay).not.toBe(NO_POLICY_SPEC.decay);
    expect(NO_POLICY_SPEC).toEqual({
      branchFirst: 1,
      branchLater: 1,
      extraJumpChance: 0,
      bounces: 0,
      lastFarthest: false,
      decay: [],
    });
  });
});

describe('BuildCompiler.chainPolicy', () => {
  it('is null on a build whose modules never ask for it', () => {
    expect(compileBuild(CHAINS, []).chainPolicy).toBeNull();
    for (const build of Object.values(GOLDEN_BUILDS)) {
      expect(compileBuild(build.stats, build.rules).chainPolicy).toBeNull();
    }
  });

  it("starts from NO_POLICY_SPEC's values and is the same object for every module", () => {
    const seen: ChainPolicySpec[] = [];
    const build = compileBuild(CHAINS, [], undefined, [
      (b) => {
        seen.push({ ...b.chainPolicy(), decay: [...b.chainPolicy().decay] });
        b.chainPolicy().branchFirst = 3;
      },
      (b) => {
        b.chainPolicy().branchLater = 2;
        b.chainPolicy().extraJumpChance = 0.1;
      },
    ]);
    expect(seen).toEqual([{ ...NO_POLICY_SPEC, decay: [] }]);
    expect(build.chainPolicy).toEqual({
      ...NO_POLICY_SPEC,
      branchFirst: 3,
      branchLater: 2,
      extraJumpChance: 0.1,
      decay: [],
    });
    // Asking adds no trigger: the build is the same but for its policy.
    expect(build.triggers).toHaveLength(compileBuild(CHAINS, []).triggers.length);
  });
});

describe('the payload', () => {
  const spec = {
    baseDamage: 0 as Payload['baseDamage'],
    tags: 0,
    source: 0,
    flags: 0,
    rng: createRng(1),
    chains: true,
    rollsAilments: false,
    canCrit: true,
    damageMode: ROWS,
  } as const;

  it('writes its 19 members in one order', () => {
    expect(Object.keys(createPayload(spec))).toEqual([
      'baseDamage',
      'tags',
      'source',
      'jumpSource',
      'extraJumpPayload',
      'flags',
      'rng',
      'chains',
      'rollsAilments',
      'canCrit',
      'damageMode',
      'rows',
      'policy',
      'raisesChainJump',
      'shockOnHit',
      'general',
      'zoneVariant',
      'aggregate',
      'bypass',
    ]);
  });

  it('is general with a policy, a chainJump to raise or shock on hit, and only then', () => {
    const plain = createPayload(spec);
    expect([plain.policy, plain.raisesChainJump, plain.shockOnHit, plain.general]).toEqual([
      null,
      false,
      0,
      false,
    ]);
    const policy = compilePolicy(NO_POLICY_SPEC, 0.5);
    expect(createPayload({ ...spec, policy }).general).toBe(true);
    expect(createPayload({ ...spec, policy }).policy).toBe(policy);
    expect(createPayload({ ...spec, raisesChainJump: true }).general).toBe(true);
    expect(createPayload({ ...spec, shockOnHit: 1 }).general).toBe(true);
    expect(createPayload({ ...spec, shockOnHit: 0, policy: null }).general).toBe(false);
  });

  it('is general on no payload of an M1 build', () => {
    for (const build of Object.values(GOLDEN_BUILDS)) {
      const ctx = placedEnemies([], { stats: build.stats, rules: build.rules });
      for (const em of ctx.emitters) expect(em.payload.general).toBe(false);
      for (const p of ctx.effectPayloads) expect(p?.general ?? false).toBe(false);
    }
  });

  it("carries the build's policy on the signature payload and its repeats, compiled once", () => {
    const stats = makeStats({ chainRange: 5000, chainRetention: 0.4 }, [], {
      triggers: [
        {
          source: 'center',
          spec: {
            on: 'nthAttack',
            every: 3,
            do: [{ kind: 'repeatAttack', count: 1, damagePct: 0.5 }],
          },
        },
        {
          source: 'center',
          spec: { on: 'hit', do: [{ kind: 'explode', radius: 40, damagePct: 0.5 }] },
        },
      ],
      conversions: [],
      emitters: [{ source: 'outer.thorns', grant: { kind: 'thorns' } }],
    });
    const ctx = placedEnemies([], {
      stats,
      modules: [policyModule((s) => (s.branchFirst = 2))],
    });
    const sig = signaturePayload(ctx);
    expect(sig.general).toBe(true);
    expect([...(sig.policy?.branch ?? [])]).toEqual([1, 2, 1]);
    expect(sig.policy?.scale[2]).toBe(0.4 * 0.4);
    const repeats = ctx.sys.repeat.payloads.filter((p) => p !== null);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]?.policy).toBe(sig.policy);
    expect(repeats[0]?.general).toBe(true);
    // The other emitters and the effects chain without one.
    const thorns = ctx.emitters.find((em) => em.spec.kind === 'thorns') as EmitterRuntime;
    expect([thorns.payload.policy, thorns.payload.general]).toEqual([null, false]);
    for (const p of ctx.effectPayloads) expect(p?.policy ?? null).toBeNull();
    // The policy-free table is the run's own, apart from the build's policy.
    expect(ctx.sys.chain.noPolicy).not.toBe(sig.policy);
    expect([...ctx.sys.chain.noPolicy.branch]).toEqual([1, 1]);
  });
});

describe('the run tables (K4)', () => {
  it('are per run: two runs with another chainRetention in one process keep their own', () => {
    const ctxOf = (chainRetention: number): RunContext =>
      placedEnemies(line(6), {
        stats: makeStats({ chainRange: 5000, critChance: 0, chainRetention }),
      });
    const ratios = (ctx: RunContext): number[] => {
      const hits = attack(ctx, 4);
      return hits.slice(2).map((hit, i) => hit.amount / (hits[i + 1]?.amount as number));
    };
    const a = ctxOf(0.5);
    const b = ctxOf(0.8);
    expect([...a.sys.chain.noPolicy.scale.slice(0, 4)]).toEqual([1, 0.5, 0.25, 0.125]);
    expect([...b.sys.chain.noPolicy.scale.slice(0, 4)]).toEqual([
      1,
      0.8,
      0.8 * 0.8,
      0.8 * 0.8 * 0.8,
    ]);
    expect(a.sys.chain).not.toBe(b.sys.chain);
    for (const ctx of [a, b, a, b]) forceGeneral(signaturePayload(ctx));
    for (const [ctx, r] of [
      [a, 0.5],
      [b, 0.8],
      [a, 0.5],
    ] as const) {
      for (const ratio of ratios(ctx)) expect(ratio).toBeCloseTo(r, 12);
    }
    // A third run with the first one's retention builds the same table anew.
    expect([...ctxOf(0.5).sys.chain.noPolicy.scale]).toEqual([...a.sys.chain.noPolicy.scale]);
  });
});

describe('the C15 vectors', () => {
  // branch [1, 2]: every enemy jumps twice; 64 enemies scan linearly, 200 through the grid.
  it.each([
    [4, 31, 0],
    [5, 32, 31],
    [6, 32, 33],
    [7, 32, 35],
  ])('chain %i: %i hits, %i refused', (chain, hits, capped) => {
    for (const n of [64, 200]) {
      const ctx = withPolicy(rows(n), (s) => {
        s.branchFirst = 2;
        s.branchLater = 2;
      });
      const events = attack(ctx, chain);
      expect(events).toHaveLength(hits);
      expect(new Set(events.map((hit) => hit.targetId)).size).toBe(hits);
      expect(ctx.counters.chainHitCapped).toBe(capped);
      expect(ctx.chainBudget.hits).toBe(hits);
      expect(ctx.counters.chainHitsPeak).toBe(hits);
      // Level k holds 2^k hits, in breadth-first order.
      const levels = events.map((hit) => hit.chainIndex);
      expect(levels).toEqual([...levels].sort((x, y) => x - y));
      for (let k = 0; k <= 4 && k <= chain; k++) {
        expect(levels.filter((level) => level === k)).toHaveLength(2 ** k);
      }
    }
  });

  it('forks 渦流 by 3 at level 1 and 分岔 by 2 after it', () => {
    const ctx = withPolicy(rows(40), (s) => {
      s.branchFirst = 3;
      s.branchLater = 2;
    });
    const levels = attack(ctx, 2).map((hit) => hit.chainIndex);
    expect(levels).toEqual([0, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
  });

  it('jumps each level from the nodes of the one before, nearest first', () => {
    // Two branches from 1 at (100, 100): 2 and 3; then 2's two nearest, then 3's.
    const placed: PlacedEnemy[] = [
      { x: 100, y: 100 },
      { x: 120, y: 100 },
      { x: 80, y: 100 },
      { x: 150, y: 100 },
      { x: 135, y: 100 },
      { x: 40, y: 100 },
      { x: 60, y: 100 },
    ];
    const ctx = withPolicy(placed, (s) => {
      s.branchFirst = 2;
      s.branchLater = 2;
    });
    const hits = attack(ctx, 2);
    expect(hits.map((hit) => hit.targetId)).toEqual([1, 2, 3, 5, 4, 7, 6]);
    expect(hits.map((hit) => hit.fromX)).toEqual([null, 100, 100, 120, 120, 80, 80]);
  });

  it('stops the siblings of a node that found no enemy', () => {
    // 1 jumps to 2, then finds none for its second branch.
    const ctx = withPolicy(line(2), (s) => {
      s.branchFirst = 3;
    });
    expect(attack(ctx, 1).map((hit) => hit.targetId)).toEqual([1, 2]);
    expect(ctx.counters.chainHitCapped).toBe(0);
  });
});

describe('回彈', () => {
  it('re-hits a lone boss: chain 2 with 2 bounces is 3 hits', () => {
    const ctx = withPolicy([{ x: 300, y: 300, type: 'boss' }], (s) => {
      s.bounces = 2;
    });
    const hits = attack(ctx, 2);
    expect(hits.map((hit) => [hit.targetId, hit.chainIndex, hit.fromX])).toEqual([
      [1, 0, null],
      [1, 1, 300],
      [1, 2, 300],
    ]);
    expect(ctx.chainBudget.extraJumps).toBe(2);
    expect(ctx.counters.extraJumpsCapped).toBe(0);
    // Each bounce is a hit of the attack's CHAIN_HIT_CAP budget too.
    expect(ctx.chainBudget.hits).toBe(3);
    expect(ctx.counters.chainHitsPeak).toBe(3);
  });

  it('refuses a third bounce at EXTRA_JUMP_CAP, counting it', () => {
    expect(EXTRA_JUMP_CAP).toBe(2);
    const ctx = withPolicy([{ x: 300, y: 300, type: 'boss' }], (s) => {
      s.bounces = 5;
    });
    expect(attack(ctx, 4)).toHaveLength(3);
    expect(ctx.counters.extraJumpsCapped).toBe(1);
    expect(ctx.counters.chainHitCapped).toBe(0);
    // The next attack has its own budget.
    expect(attack(ctx, 1)).toHaveLength(2);
    expect(ctx.counters.extraJumpsCapped).toBe(1);
  });

  it('bounces no more than the policy says', () => {
    const ctx = withPolicy([{ x: 300, y: 300, type: 'boss' }], (s) => {
      s.bounces = 1;
    });
    expect(attack(ctx, 3)).toHaveLength(2);
    expect(ctx.chainBudget.extraJumps).toBe(1);
    expect(ctx.counters.extraJumpsCapped).toBe(0);
  });

  it('does not bounce off a dead enemy', () => {
    const ctx = withPolicy([{ x: 300, y: 300, hp: 1 }], (s) => {
      s.bounces = 2;
    });
    expect(attack(ctx, 2)).toHaveLength(1);
    expect(ctx.chainBudget.extraJumps).toBe(0);
  });

  it('bounces in a level whose other enemies jump on, and rolls nothing without a chance', () => {
    // 1 forks to 2 and 3; 2 has no other enemy in range (50) and bounces twice, while 3 jumps
    // on to 4 and 5. No roll is made, so the jumps after the bounces count nothing.
    const placed: PlacedEnemy[] = [
      { x: 300, y: 100 },
      { x: 330, y: 100 },
      { x: 270, y: 100 },
      { x: 230, y: 100 },
      { x: 195, y: 100 },
    ];
    const stats = makeStats({ chainRange: 50, critChance: 0, igniteChance: 0 });
    const ctx = withPolicy(
      placed,
      (s) => {
        s.branchFirst = 2;
        s.bounces = 2;
      },
      { stats },
    );
    const before = rngPositions(ctx);
    expect(attack(ctx, 3).map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
      [2, 2],
      [4, 2],
      [2, 3],
      [5, 3],
    ]);
    expect(ctx.chainBudget.extraJumps).toBe(2);
    expect(ctx.counters.extraJumpsCapped).toBe(0);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('bounces only for the first branch of a node', () => {
    // 1 jumps to 2, then its second branch finds none: no bounce there; 2 bounces at level 2.
    const ctx = withPolicy(line(2), (s) => {
      s.branchFirst = 2;
      s.branchLater = 2;
      s.bounces = 1;
    });
    expect(attack(ctx, 2).map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
      [1, 0],
      [2, 1],
      [2, 2],
    ]);
  });
});

describe('跳電', () => {
  it('adds the extra jumps after the last level, the levels continuing (chain 3: 6 hits)', () => {
    const ctx = withPolicy(
      line(10),
      (s) => {
        s.extraJumpChance = 1;
      },
      {
        stats: makeStats({ chainRange: 5000, critChance: 0, igniteChance: 0, chainRetention: 0.5 }),
      },
    );
    const before = rngPositions(ctx);
    const hits = attack(ctx, 3);
    expect(hits.map((hit) => [hit.targetId, hit.chainIndex, hit.fromX])).toEqual([
      [1, 0, null],
      [2, 1, 100],
      [3, 2, 120],
      [4, 3, 140],
      [5, 4, 160],
      [6, 5, 180],
    ]);
    // Two rolls passed; the third was not made, and chance(1) draws nothing.
    expect(ctx.chainBudget.extraJumps).toBe(2);
    expect(ctx.counters.extraJumpsCapped).toBe(1);
    expect(rngPositions(ctx)).toEqual(before);
    // Each level keeps half of the one before, the extra ones too.
    for (let k = 2; k <= 5; k++) {
      expect((hits[k]?.amount as number) / (hits[k - 1]?.amount as number)).toBeCloseTo(0.5, 12);
    }
  });

  it('rolls once per jump hit on the payload stream until EXTRA_JUMP_CAP', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const ctx = withPolicy(
        line(14),
        (s) => {
          s.extraJumpChance = 0.4;
        },
        { seed },
      );
      // The same rolls on a twin's stream: one per jump hit while fewer than 2 passed.
      const twin = placedEnemies(line(14), { stats: CHAINS, seed });
      let extra = 0;
      let notMade = 0;
      for (let jump = 0; jump < 6; jump++) {
        if (extra >= EXTRA_JUMP_CAP) notMade++;
        else if (twin.combatRng.chance(0.4)) extra++;
      }
      const hits = attack(ctx, 6);
      expect(hits, `seed ${seed}`).toHaveLength(7 + extra);
      expect(ctx.counters.extraJumpsCapped).toBe(notMade);
      expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    }
  });

  it('jumps from the last enemy hit, the last of the last level', () => {
    // 1 forks to 2 (left) and 3 (right); the extra jump goes on from 3 to 5, not from 2 to 4.
    const placed: PlacedEnemy[] = [
      { x: 300, y: 100 },
      { x: 280, y: 100 },
      { x: 330, y: 100 },
      { x: 250, y: 100 },
      { x: 370, y: 100 },
    ];
    const ctx = withPolicy(placed, (s) => {
      s.branchFirst = 2;
      s.extraJumpChance = 1;
      s.bounces = 0;
    });
    const hits = attack(ctx, 1);
    expect(hits.map((hit) => [hit.targetId, hit.chainIndex, hit.fromX])).toEqual([
      [1, 0, null],
      [2, 1, 300],
      [3, 1, 300],
      [5, 2, 330],
      [4, 3, 370],
    ]);
  });

  it('refuses the extra jumps past CHAIN_HIT_CAP, counting them', () => {
    const ctx = withPolicy(rows(64), (s) => {
      s.branchFirst = 2;
      s.branchLater = 2;
      s.extraJumpChance = 1;
    });
    // 31 hits by the levels; one extra jump fits, the other is refused. 28 rolls not made.
    expect(attack(ctx, 4)).toHaveLength(CHAIN_HIT_CAP);
    expect(ctx.counters.chainHitCapped).toBe(1);
    expect(ctx.counters.extraJumpsCapped).toBe(28);
  });

  it('shares EXTRA_JUMP_CAP with the bounces', () => {
    // 1 to 2 rolls one extra jump; 2 bounces once; the second bounce is refused; the extra jump
    // finds nothing.
    const ctx = withPolicy(line(2), (s) => {
      s.extraJumpChance = 1;
      s.bounces = 2;
    });
    expect(attack(ctx, 3).map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
      [1, 0],
      [2, 1],
      [2, 2],
    ]);
    expect(ctx.chainBudget.extraJumps).toBe(2);
    expect(ctx.counters.extraJumpsCapped).toBe(1);
  });
});

describe('電荷 and 蓄電', () => {
  it("scale each level's hits by the policy's table", () => {
    const R = 0.5;
    const stats = makeStats({
      chainRange: 5000,
      critChance: 0,
      igniteChance: 0,
      chainRetention: R,
    });
    const ctx = withPolicy(
      line(7),
      (s) => {
        s.decay.push({ from: 1, to: 1, factor: 1 });
        s.decay.push({ from: 3, factor: 1.15 });
      },
      { stats },
    );
    const linear = placedEnemies(line(7), { stats });
    const hits = attack(ctx, 5);
    const plain = attack(linear, 5);
    expect(hits.map((hit) => hit.targetId)).toEqual(plain.map((hit) => hit.targetId));
    // Against the linear chain's R^k: level 1 keeps full damage, levels 3 on gain 15% each.
    const scale = [1, 1, R, R * 1.15, R * 1.15 * 1.15, R * 1.15 * 1.15 * 1.15];
    hits.forEach((hit, k) => {
      expect(hit.amount / (plain[k]?.amount as number)).toBeCloseTo(
        (scale[k] as number) / R ** k,
        9,
      );
    });
  });
});

describe('遠雷', () => {
  it('jumps to the farthest enemy in range at the last level only', () => {
    const placed: PlacedEnemy[] = [
      { x: 500, y: 300 },
      { x: 520, y: 300 },
      { x: 560, y: 300 },
      { x: 700, y: 300 },
      // Out of range of 2 (radius 200).
      { x: 521, y: 501 },
    ];
    const stats = makeStats({ chainRange: 200, critChance: 0, igniteChance: 0 });
    const ctx = withPolicy(placed, (s) => (s.lastFarthest = true), { stats });
    expect(attack(ctx, 2).map((hit) => hit.targetId)).toEqual([1, 2, 4]);
    const three = withPolicy(placed, (s) => (s.lastFarthest = true), { stats });
    expect(attack(three, 3).map((hit) => hit.targetId)).toEqual([1, 2, 3, 4]);
  });

  it('skips the enemies the attack hit, and takes the lower id on ties', () => {
    // From 2, the primary is the farthest in range, but hit; 3 and 4 are as far: 3.
    const placed: PlacedEnemy[] = [
      { x: 500, y: 300 },
      { x: 650, y: 300 },
      { x: 650, y: 230 },
      { x: 650, y: 370 },
    ];
    const stats = makeStats({ chainRange: 200, critChance: 0, igniteChance: 0 });
    const ctx = withPolicy(placed, (s) => (s.lastFarthest = true), { stats });
    expect(attack(ctx, 2).map((hit) => hit.targetId)).toEqual([1, 2, 3]);
    // farthestChainTarget alone: none once every enemy in range is hit.
    expect(farthestChainTarget(ctx, 650, 300)?.id).toBe(4);
    ctx.attackSerial++;
    expect(farthestChainTarget(ctx, 650, 300)?.id).toBe(1);
    expect(farthestChainTarget(ctx, 2000, 2000)).toBeNull();
  });
});

describe('the jump hits', () => {
  it("credit the extra jumps and bounces to extraJumpPayload's source (A9)", () => {
    const ctx = withPolicy(line(6), (s) => {
      s.extraJumpChance = 1;
      s.bounces = 1;
    });
    const p = signaturePayload(ctx);
    const rule = ctx.build.sources.index('outer.lightning');
    const extraPayload = createPayload({ ...p, source: rule, jumpSource: rule });
    (p as { extraJumpPayload: Payload }).extraJumpPayload = extraPayload;
    const hits = attack(ctx, 3);
    expect(hits.map((hit) => [hit.targetId, hit.source])).toEqual([
      [1, p.source],
      [2, p.jumpSource],
      [3, p.jumpSource],
      [4, p.jumpSource],
      [5, rule],
      [6, rule],
    ]);
    expect(ctx.bySource[rule]).toBe((hits[4]?.amount as number) + (hits[5]?.amount as number));
    // A bounce: 2 enemies, so the chain ends on 2 and bounces there.
    const lone = withPolicy(line(2), (s) => (s.bounces = 1));
    const q = signaturePayload(lone);
    (q as { extraJumpPayload: Payload }).extraJumpPayload = createPayload({
      ...q,
      source: rule,
      jumpSource: rule,
    });
    expect(attack(lone, 2).map((hit) => [hit.targetId, hit.source])).toEqual([
      [1, q.source],
      [2, q.jumpSource],
      [2, rule],
    ]);
  });

  it("carry the attack's steady crit, depth and origin, and no PRIMARY", () => {
    const seen: [number, number, boolean, number, number, boolean][] = [];
    // A line, and a lone enemy out of its range (50).
    const placed = [...line(5), { x: 800, y: 800 }];
    const stats = makeStats({ chainRange: 50, critChance: 0, igniteChance: 0 });
    const ctx = withPolicy(
      placed,
      (s) => {
        s.extraJumpChance = 1;
        s.bounces = 1;
      },
      {
        stats,
        modules: [
          (b) =>
            b.hook('onHit', (_ctx, hit) => {
              const primary = (hit.flags & PRIMARY) !== 0;
              seen.push([hit.target.id, hit.chainIndex, hit.crit, hit.depth, hit.origin, primary]);
            }),
        ],
      },
    );
    // Two jumps and two extra ones along the line; a bounce on the lone enemy.
    for (const primary of [0, 5]) {
      chainAttack(ctx, signaturePayload(ctx), ctx.enemies[primary] as Enemy, 2, true, 2, 7);
    }
    expect(seen.map(([id, k]) => [id, k])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
      [6, 0],
      [6, 1],
    ]);
    for (const [, k, crit, depth, origin, primary] of seen) {
      expect([crit, depth, origin, primary]).toEqual([true, 2, 7, k === 0]);
    }
  });

  it('run on the general path from chainFrom with the same roll', () => {
    // chainFrom rolls the count's fraction, then chains on the general path.
    const ctx = withPolicy(line(8), (s) => (s.branchLater = 1));
    const twin = placedEnemies(line(8), { stats: CHAINS });
    const p = signaturePayload(ctx);
    const q = signaturePayload(twin);
    expect([p.general, q.general]).toEqual([true, false]);
    for (const c of [ctx, twin]) c.attackSerial++;
    chainFrom(ctx, p, ctx.enemies[0] as Enemy, 2.5, false, 0, -1);
    chainFrom(twin, q, twin.enemies[0] as Enemy, 2.5, false, 0, -1);
    expect(ctx.events).toEqual(twin.events);
    expect(rngPositions(ctx)).toEqual(rngPositions(twin));
  });
});

/**
 * One attack of the signature payload from the enemies `ids` (1-based), each a primary hit and
 * a root of the general path at level 0, `jumps` levels deep; its hit events.
 */
function attackFromRoots(ctx: RunContext, ids: readonly number[], jumps: number) {
  const before = ctx.events.length;
  const p = signaturePayload(ctx);
  const roots = ctx.sys.chain.frontier;
  beginAttack(ctx);
  ids.forEach((id, i) => {
    const enemy = ctx.enemies[id - 1] as Enemy;
    primaryHit(ctx, p, enemy, 1, false, 0, -1);
    roots[i] = enemy;
  });
  chainGeneral(ctx, p, roots, ids.length, jumps, false, 0, -1);
  endAttack(ctx);
  return eventsOf([ctx.events.slice(before)], 'hit');
}

describe('the general path, step by step (§4.3)', () => {
  const NEAR = makeStats({ chainRange: 50, critChance: 0, igniteChance: 0, chainRetention: 0.5 });

  it('counts a bounce toward CHAIN_HIT_CAP, and stops its node without refusing its siblings', () => {
    // 31 enemies: levels 1-4 hit the 30 others (31 hits). At level 5 the first node finds none
    // and bounces, the 32nd hit; its second jump is not tried, and the other 15 nodes' 30 are
    // refused.
    const ctx = withPolicy(rows(31), (s) => {
      s.branchFirst = 2;
      s.branchLater = 2;
      s.bounces = 1;
    });
    const hits = attack(ctx, 5);
    expect(hits).toHaveLength(CHAIN_HIT_CAP);
    expect(hits.at(-1)?.chainIndex).toBe(5);
    expect(ctx.chainBudget.hits).toBe(CHAIN_HIT_CAP);
    expect(ctx.chainBudget.extraJumps).toBe(1);
    expect(ctx.counters.chainHitCapped).toBe(30);
    expect(ctx.counters.extraJumpsCapped).toBe(0);
  });

  it('refuses every extra jump left at CHAIN_HIT_CAP, counting each', () => {
    // Chain 5 fills the cap at level 5 (32 hits, 31 refused); both extra jumps, rolled at
    // level 1, are refused too. 31 jump hits, 2 rolls made.
    const ctx = withPolicy(rows(64), (s) => {
      s.branchFirst = 2;
      s.branchLater = 2;
      s.extraJumpChance = 1;
    });
    expect(attack(ctx, 5)).toHaveLength(CHAIN_HIT_CAP);
    expect(ctx.chainBudget.extraJumps).toBe(EXTRA_JUMP_CAP);
    expect(ctx.counters.chainHitCapped).toBe(31 + 2);
    expect(ctx.counters.extraJumpsCapped).toBe(29);
  });

  it("bounces from its own enemy at its level's share, and the extra jumps go on from the last jump", () => {
    // Roots 1 and 2 (range 50, 60 apart). Level 1: 1 jumps to 3 and rolls an extra jump; 2
    // finds none and bounces from where it stands. The extra jump goes on from 3 to 4, not
    // from the bounced 2, which has none in range.
    const placed: PlacedEnemy[] = [
      { x: 270, y: 100 },
      { x: 330, y: 100 },
      { x: 230, y: 100 },
      { x: 195, y: 100 },
    ];
    const ctx = withPolicy(
      placed,
      (s) => {
        s.extraJumpChance = 1;
        s.bounces = 1;
      },
      { stats: NEAR },
    );
    const hits = attackFromRoots(ctx, [1, 2], 1);
    expect(hits.map((hit) => [hit.targetId, hit.chainIndex, hit.fromX])).toEqual([
      [1, 0, null],
      [2, 0, null],
      [3, 1, 270],
      [2, 1, 330],
      [4, 2, 230],
    ]);
    // The bounce keeps level 1's share (scale[1]), as the jump beside it does.
    expect(hits[3]?.amount).toBe(hits[2]?.amount);
    expect(ctx.chainBudget.extraJumps).toBe(EXTRA_JUMP_CAP);
  });

  it('shares EXTRA_JUMP_CAP between a bounce and the rolls after it', () => {
    // Roots 1 (alone) and 2. Level 1: 1 bounces, then 2 jumps to 3 and its roll passes: the
    // cap is full. Level 2: 1's second bounce is refused and 3's jump to 4 makes no roll. The
    // one extra jump goes from 4 to 5; 6 is left.
    const placed: PlacedEnemy[] = [
      { x: 330, y: 100 },
      { x: 270, y: 100 },
      { x: 230, y: 100 },
      { x: 195, y: 100 },
      { x: 160, y: 100 },
      { x: 125, y: 100 },
    ];
    const ctx = withPolicy(
      placed,
      (s) => {
        s.extraJumpChance = 1;
        s.bounces = 2;
      },
      { stats: NEAR },
    );
    const before = rngPositions(ctx);
    const hits = attackFromRoots(ctx, [1, 2], 2);
    expect(hits.map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
      [1, 0],
      [2, 0],
      [1, 1],
      [3, 1],
      [4, 2],
      [5, 3],
    ]);
    expect(ctx.chainBudget.extraJumps).toBe(EXTRA_JUMP_CAP);
    expect(ctx.counters.extraJumpsCapped).toBe(2);
    expect(rngPositions(ctx)).toEqual(before);
  });

  it('rolls no extra jump on a bounce', () => {
    const ctx = withPolicy([{ x: 300, y: 300, type: 'boss' }], (s) => {
      s.extraJumpChance = 1;
      s.bounces = 1;
    });
    expect(attack(ctx, 1)).toHaveLength(2);
    expect(ctx.chainBudget.extraJumps).toBe(1);
    expect(ctx.counters.extraJumpsCapped).toBe(0);
  });

  it("rolls each extra jump right after its jump hit's own draws, on the payload stream", () => {
    const stats = makeStats({ chainRange: 5000, critChance: 0.5, igniteChance: 0 });
    for (let seed = 1; seed <= 12; seed++) {
      const ctx = withPolicy(line(14), (s) => (s.extraJumpChance = 0.4), { stats, seed });
      // The twin's stream: the primary's crit roll, each jump's crit roll and then its extra-jump
      // roll while fewer than 2 passed, then each extra jump's crit roll.
      const twin = placedEnemies(line(14), { stats, seed });
      const rng = twin.combatRng;
      const crits = [rng.chance(0.5)];
      let extra = 0;
      for (let jump = 0; jump < 6; jump++) {
        crits.push(rng.chance(0.5));
        if (extra < EXTRA_JUMP_CAP && rng.chance(0.4)) extra++;
      }
      for (let e = 0; e < extra; e++) crits.push(rng.chance(0.5));
      expect(
        attack(ctx, 6).map((hit) => hit.crit),
        `seed ${seed}`,
      ).toEqual(crits);
      expect(rngPositions(ctx)).toEqual(rngPositions(twin));
    }
  });

  it('sends the extra jumps to the nearest enemy under 遠雷', () => {
    // From 1 (range 70) the last level's jump goes to the farthest, 4 at 160; the extra jump
    // from there to the nearest, 3 (ties to the lower id), not the farthest, 7.
    const stats = makeStats({ chainRange: 70, critChance: 0, igniteChance: 0 });
    const ctx = withPolicy(
      line(7),
      (s) => {
        s.lastFarthest = true;
        s.extraJumpChance = 1;
      },
      { stats },
    );
    expect(attack(ctx, 1).map((hit) => hit.targetId)).toEqual([1, 4, 3]);
  });

  it('forks to the nearest enemies, and only the last level to the farthest under 遠雷', () => {
    // Level 1 forks from 1 to its two nearest, 2 and 3; level 2, the last, from each to the
    // farthest it has not hit: 2 to 5, then 3 to 4.
    const placed: PlacedEnemy[] = [
      { x: 500, y: 300 },
      { x: 520, y: 300 },
      { x: 480, y: 300 },
      { x: 650, y: 300 },
      { x: 350, y: 300 },
    ];
    const stats = makeStats({ chainRange: 200, critChance: 0, igniteChance: 0 });
    const ctx = withPolicy(
      placed,
      (s) => {
        s.branchFirst = 2;
        s.lastFarthest = true;
      },
      { stats },
    );
    expect(attack(ctx, 2).map((hit) => hit.targetId)).toEqual([1, 2, 3, 5, 4]);
  });

  it('takes, under 遠雷, an enemy standing on the point it jumps from', () => {
    const stats = makeStats({ chainRange: 200, critChance: 0, igniteChance: 0 });
    const placed: PlacedEnemy[] = [
      { x: 500, y: 300 },
      { x: 500, y: 300 },
    ];
    const ctx = withPolicy(placed, (s) => (s.lastFarthest = true), { stats });
    expect(attack(ctx, 1).map((hit) => hit.targetId)).toEqual([1, 2]);
  });

  it('compiles both tables from the clamped chainRetention, as the linear chain keeps it', () => {
    for (const [retention, clamped] of [
      [1.5, 1],
      [-0.25, 0],
    ] as const) {
      const stats = makeStats({
        chainRange: 5000,
        critChance: 0,
        igniteChance: 0,
        chainRetention: retention,
      });
      const ctx = withPolicy(line(6), () => undefined, { stats });
      expect(ctx.chainRetention).toBe(clamped);
      const table = [...compilePolicy(NO_POLICY_SPEC, clamped).scale];
      expect([...(signaturePayload(ctx).policy?.scale ?? [])]).toEqual(table);
      expect([...ctx.sys.chain.noPolicy.scale]).toEqual(table);
      // The policy's chain deals what the linear one does.
      const linear = placedEnemies(line(6), { stats });
      expect(attack(ctx, 4)).toEqual(attack(linear, 4));
    }
  });

  it("carries the build's policy on a magmaBomb signature's payload too", () => {
    const ctx = placedEnemies([], {
      stats: CHAINS,
      signature: { id: 'magmaBomb' },
      modules: [policyModule((s) => (s.branchFirst = 2))],
    });
    const sig = signaturePayload(ctx);
    expect((ctx.emitters[0] as EmitterRuntime).spec.kind).toBe('lob');
    expect(sig.general).toBe(true);
    expect([...(sig.policy?.branch ?? [])]).toEqual([1, 2, 1]);
  });
});

/** Every hit and tally of a context, and its stream positions, for the differential test. */
function snapshotOf(ctx: RunContext): string {
  return JSON.stringify([
    ctx.events,
    ctx.counters,
    rngPositions(ctx),
    ctx.kills,
    [ctx.damageHit, ctx.damageCrit, ctx.damageChain, ctx.damageBurn, ctx.damagePoison],
    [ctx.damageBleed, ctx.maxHit, ctx.bySource],
    ctx.enemies.map((e) => [e.id, e.alive, e.hp]),
  ]);
}

const FIXTURE_TYPES: readonly EnemyId[] = ['square', 'triangle', 'pentagon', 'hexagon'];

describe('shock on hit (C4.17)', () => {
  const SHOCKS = makeStats({
    chainRange: 5000,
    critChance: 0,
    igniteChance: 0,
    shockMaxStacks: 10,
  });

  /**
   * The signature payload of `ctx` again, shocking each enemy its jumps hit by `jump` stacks,
   * and those its extraJumpPayload hits by `extra`.
   */
  function shocking(ctx: RunContext, jump: number, extra: number): Payload {
    const p = signaturePayload(ctx);
    const q = createPayload({ ...p, shockOnHit: jump });
    (q as { extraJumpPayload: Payload }).extraJumpPayload = createPayload({
      ...p,
      shockOnHit: extra,
    });
    return q;
  }

  const shocks = (ctx: RunContext): number[] =>
    ctx.enemies.map((e) => activeShockStacks(e, ctx.now));

  it("shocks each enemy a jump hits by the payload's stacks and an extra jump's by extraJumpPayload's, after the hit; never the primary", () => {
    // The target's shock stacks as each hit lands.
    const before: number[] = [];
    const ctx = withPolicy(line(6), (s) => (s.extraJumpChance = 1), {
      stats: SHOCKS,
      modules: [
        (b) =>
          b.hook('onHit', (c, hit) => {
            before.push(activeShockStacks(hit.target, c.now));
          }),
      ],
    });
    const q = shocking(ctx, 1, 2);
    expect(q.general).toBe(true);
    chainAttack(ctx, q, ctx.enemies[0] as Enemy, 3, false, 0, -1);
    // Jumps to 2, 3 and 4; the two extra jumps go on to 5 and 6.
    expect(eventsOf([ctx.events], 'hit').map((hit) => hit.targetId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(before).toEqual([0, 0, 0, 0, 0, 0]);
    expect(shocks(ctx)).toEqual([0, 1, 1, 1, 2, 2]);
  });

  it("shocks an enemy that bounces by extraJumpPayload's stacks on top of its jump's", () => {
    const ctx = withPolicy(line(2), (s) => (s.bounces = 1), { stats: SHOCKS });
    chainAttack(ctx, shocking(ctx, 1, 2), ctx.enemies[0] as Enemy, 2, false, 0, -1);
    expect(eventsOf([ctx.events], 'hit').map((hit) => [hit.targetId, hit.chainIndex])).toEqual([
      [1, 0],
      [2, 1],
      [2, 2],
    ]);
    expect(shocks(ctx)).toEqual([0, 3]);
  });

  it('shocks no enemy its jump killed, at the depth of the attack', () => {
    const placed = [...line(4)];
    placed[1] = { ...placed[1], hp: 1 } as PlacedEnemy;
    const ctx = placedEnemies(placed, {
      stats: makeStats({ chainRange: 5000, critChance: 0, igniteChance: 0, damage: 10 }),
    });
    const p = signaturePayload(ctx);
    chainAttack(
      ctx,
      createPayload({ ...p, shockOnHit: 2 }),
      ctx.enemies[0] as Enemy,
      3,
      false,
      2,
      7,
    );
    expect(eventsOf([ctx.events], 'hit').map((hit) => hit.targetId)).toEqual([1, 2, 3, 4]);
    expect(ctx.enemies.map((e) => [e.alive, e.shockStacks, e.ailDepth])).toEqual([
      [true, 0, 3],
      [false, 0, 3],
      [true, 2, 2],
      [true, 2, 2],
    ]);
  });
});

describe('the differential test (§4.3)', () => {
  it('gives the linear path and the general one the same hits on 50 random chain fixtures', () => {
    const rng = createRng(4316);
    let jumps = 0;
    let capped = 0;
    for (let f = 0; f < 50; f++) {
      const n = f % 10 === 9 ? 130 + Math.floor(rng.next() * 40) : 1 + Math.floor(rng.next() * 60);
      const spread = 80 + rng.next() * 500;
      const placed: PlacedEnemy[] = Array.from({ length: n }, () => ({
        x: 960 + (rng.next() - 0.5) * spread,
        y: 540 + (rng.next() - 0.5) * spread,
        type: FIXTURE_TYPES[Math.floor(rng.next() * FIXTURE_TYPES.length)] as EnemyId,
        ...(rng.next() < 0.3 ? { hp: 5 + rng.next() * 60 } : {}),
      }));
      const stats = makeStats(
        {
          damage: 5 + rng.next() * 20,
          chainCount: rng.next() < 0.2 ? 30 + rng.next() * 10 : rng.next() * 8,
          chainRetention: 0.2 + rng.next() * 0.8,
          chainRange: 40 + rng.next() * 400,
          critChance: rng.next() * 0.5,
          igniteChance: rng.next() * 0.5,
          poisonChance: rng.next() * 0.3,
          shockChance: rng.next() * 0.3,
        },
        maskProbeMods(),
      );
      const seed = 1 + Math.floor(rng.next() * 1000);
      const linear = placedEnemies(placed, { stats, seed });
      const forced = placedEnemies(placed, { stats, seed });
      forceGeneral(signaturePayload(forced));
      // A compiled policy with NO_POLICY_SPEC's values: the general path on its own table.
      const policy = placedEnemies(placed, {
        stats,
        seed,
        modules: [policyModule(() => undefined)],
      });
      expect(signaturePayload(policy).general).toBe(true);
      const attacks = Array.from({ length: 5 }, () => ({
        primary: Math.floor(rng.next() * n),
        steady: rng.next() < 0.25,
      }));
      for (const ctx of [linear, forced, policy]) {
        for (const { primary, steady } of attacks) {
          const enemy = ctx.enemies[primary] as Enemy;
          if (!enemy.alive) continue;
          chainAttack(ctx, signaturePayload(ctx), enemy, ctx.chainCount, steady, 0, -1);
        }
      }
      const expected = snapshotOf(linear);
      expect(snapshotOf(forced), `fixture ${f}`).toBe(expected);
      expect(snapshotOf(policy), `fixture ${f}`).toBe(expected);
      jumps += eventsOf([linear.events], 'hit').filter((hit) => hit.chainIndex > 0).length;
      capped += linear.counters.chainHitCapped;
    }
    // The fixtures chain, and some reach CHAIN_HIT_CAP.
    expect(jumps).toBeGreaterThan(500);
    expect(capped).toBeGreaterThan(0);
  });

  /** [seed, start wave] of the golden runs (src/sim/golden.test.ts). */
  const STARTS = [
    [1, 8],
    [2, 15],
  ] as const;

  /**
   * A golden run's hash (every tick's events whole, then the result) and its end stream
   * positions: on the linear path, forced onto the general path from the first tick, or with
   * a compiled policy of NO_POLICY_SPEC's values. A tick hook captures the context in all
   * three, so their builds are the same.
   */
  function goldenRun(
    name: keyof typeof GOLDEN_BUILDS,
    seed: number,
    startWave: number,
    mode: 'linear' | 'forced' | 'policy',
  ): { hash: string; positions: unknown; general: boolean; jumps: number } {
    let ctx: RunContext | null = null;
    const capture: TestModule = (b) =>
      b.hook('tick', (c) => {
        if (ctx !== null) return;
        ctx = c;
        expect(c.state.tick).toBe(1);
        if (mode === 'forced') forceGeneralAll(c);
      });
    const modules = mode === 'policy' ? [policyModule(() => undefined), capture] : [capture];
    const config = makeConfig({ seed, startWave, ...GOLDEN_BUILDS[name], maxTicks: 1200 });
    const sim = createSimulation(config, makeTestData(), modules);
    const hash = createHash('sha256');
    let jumps = 0;
    while (!sim.state.finished) {
      const events = sim.step(NO_INPUT);
      for (const event of events) if (event.type === 'hit' && event.chainIndex > 0) jumps++;
      hash.update(JSON.stringify(events));
    }
    hash.update(JSON.stringify(sim.result()));
    const run = ctx as RunContext | null;
    if (run === null) throw new Error('no tick ran');
    return {
      hash: hash.digest('hex'),
      positions: rngPositions(run),
      general: signaturePayload(run).general,
      jumps,
    };
  }

  const cases = Object.keys(GOLDEN_BUILDS).flatMap((name) =>
    STARTS.map(([seed, startWave]) => ({
      id: `${name}/s${seed}/w${startWave}`,
      name: name as keyof typeof GOLDEN_BUILDS,
      seed,
      startWave,
    })),
  );

  it.each(cases)('gives the golden run $id the same events, result and streams', (c) => {
    const linear = goldenRun(c.name, c.seed, c.startWave, 'linear');
    const forced = goldenRun(c.name, c.seed, c.startWave, 'forced');
    const policy = goldenRun(c.name, c.seed, c.startWave, 'policy');
    expect([linear.general, forced.general, policy.general]).toEqual([false, true, true]);
    expect(forced.hash).toBe(linear.hash);
    expect(policy.hash).toBe(linear.hash);
    expect(forced.positions).toEqual(linear.positions);
    expect(policy.positions).toEqual(linear.positions);
    if (['chain', 'overload', 'bridges'].includes(c.name)) expect(linear.jumps).toBeGreaterThan(0);
  });
});
