import { describe, expect, it } from 'vitest';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import { burnCapOf } from '../ailments/records';
import { compileBuild } from '../build/compile';
import { BURN_RINGS_MAX_STACKS } from '../caps';
import type { Enemy, RunContext } from '../systems/context';
import { makeStats } from '../testing';

const MAGMA: SignatureSpec = { id: 'magmaBomb' };
const FROSTFLAME: RuleSpec = { id: 'frostflame', frostPct: 0.3, burnCapBonus: 3, zoneSlow: 0.3 };

describe('frostflame (霜焰)', () => {
  it('adds an explode trigger of frostPct chill, the frost burn cap and the zone slow', () => {
    const plain = compileBuild(makeStats(), [], MAGMA);
    const build = compileBuild(makeStats(), [FROSTFLAME], MAGMA);
    expect(plain.flags.frostBurnCap).toBe(0);
    expect(build.flags.frostBurnCap).toBe(3);
    expect(build.signature.lob?.zone.slow).toBe(0.3);
    expect(build.effects.map((fx) => fx.spec)).toContainEqual({ kind: 'addFrost', amount: 0.3 });
    expect(build.triggers).toHaveLength(plain.triggers.length + 1);
  });

  it('adds up the frost and the cap over instances, and takes the largest slow', () => {
    const build = compileBuild(
      makeStats(),
      [FROSTFLAME, { id: 'frostflame', frostPct: 0.2, burnCapBonus: 1, zoneSlow: 0.5 }],
      MAGMA,
    );
    expect(build.flags.frostBurnCap).toBe(4);
    expect(build.signature.lob?.zone.slow).toBe(0.5);
    expect(build.effects.map((fx) => fx.spec)).toContainEqual({ kind: 'addFrost', amount: 0.5 });
  });

  it('is a compile error in a run of another signature', () => {
    expect(() => compileBuild(makeStats(), [FROSTFLAME])).toThrow(
      "rule 'frostflame' tunes the magmaBomb signature, but this run's signature is 'm1Volley'",
    );
  });
});

describe('burnCapOf under 霜焰', () => {
  const ctx = (over: Partial<RunContext>): RunContext =>
    ({ now: 10, burnCap: 5, frostBurnCap: 3, burnRings: false, ...over }) as RunContext;
  const enemy = (frost: number): Enemy => ({ boss: false, frozenUntil: 0, frost }) as Enemy;

  it('adds the frost burn cap while the enemy holds frost, and only then', () => {
    expect(burnCapOf(ctx({}), enemy(0.2))).toBe(8);
    expect(burnCapOf(ctx({}), enemy(0))).toBe(5);
    expect(burnCapOf(ctx({ frostBurnCap: 0 }), enemy(0.2))).toBe(5);
  });

  it("keeps eternalFlame's rings at BURN_RINGS_MAX_STACKS (C4D F1)", () => {
    expect(burnCapOf(ctx({ burnRings: true }), enemy(0.2))).toBe(BURN_RINGS_MAX_STACKS);
  });
});
