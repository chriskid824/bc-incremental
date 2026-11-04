import { describe, expect, it } from 'vitest';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import type { TriggerSpec } from '../../data/triggers';
import { compileBuild } from '../build/compile';
import { num } from '../../core/num';
import { applyBurn } from '../ailments/apply';
import { CENTER } from '../build/sources';
import { hitWithPayload } from '../combat/hit';
import { dispatchPendingKills } from '../effects/dispatch';
import { runEffectQueue } from '../effects/execute';
import { MAX_DEPTH } from '../effects/types';
import type { EmitterRuntime } from '../emitters/types';
import type { Enemy } from '../systems/context';
import { centerTriggers, makeStats, placedEnemies } from '../testing';
import type { PlacedEnemy } from '../testing';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../types';

const MAGMA: SignatureSpec = { id: 'magmaBomb' };
const SWARM: SignatureSpec = { id: 'swarm' };

describe('zoneTune (熔流, 灼地, 火海)', () => {
  it('multiplies the fire zone factors over its instances', () => {
    const build = compileBuild(
      makeStats(),
      [
        { id: 'zoneTune', durationMult: 2, damageMult: 1, radiusMult: 1 },
        { id: 'zoneTune', durationMult: 1, damageMult: 5 / 3, radiusMult: 1 },
        { id: 'zoneTune', durationMult: 1, damageMult: 2, radiusMult: 1.25 },
      ],
      MAGMA,
    );
    expect(build.signature.lob?.zone).toMatchObject({ durationMult: 2, radiusMult: 1.25 });
    expect(build.signature.lob?.zone.damageMult).toBeCloseTo(10 / 3, 12);
  });

  it('leaves the factors at 1 without it', () => {
    expect(compileBuild(makeStats(), [], MAGMA).signature.lob?.zone).toEqual({
      slow: 0,
      durationMult: 1,
      damageMult: 1,
      radiusMult: 1,
    });
  });

  it('is a compile error in a run of another signature', () => {
    expect(() =>
      compileBuild(
        makeStats(),
        [{ id: 'zoneTune', durationMult: 2, damageMult: 1, radiusMult: 1 }],
        SWARM,
      ),
    ).toThrow("rule 'zoneTune' tunes the magmaBomb signature, but this run's signature is 'swarm'");
  });
});

describe('pyreChain (連環焚燒)', () => {
  /** 焚屍: a burning enemy's death detonates its burn around it. */
  const PYRE: TriggerSpec = {
    on: 'kill',
    when: [{ victimHas: 'burn' }],
    do: [{ kind: 'detonate', ailment: 'burn', radius: 60 }],
  };
  const P = { x: ARENA_WIDTH / 2 + 300, y: ARENA_HEIGHT / 2 };
  /** A line of burning enemies 50 apart: each detonation reaches the next one only. */
  const LINE: readonly PlacedEnemy[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    x: P.x + 50 * i,
    y: P.y,
    hp: 1,
  }));

  /** How many of LINE die when the first is killed by a hit, under `rules`. */
  function dead(rules: readonly RuleSpec[]): number {
    const ctx = placedEnemies(LINE, {
      stats: makeStats(
        { critChance: 0, igniteChance: 0, projectileCount: 1, burnMaxStacks: 5 },
        [],
        centerTriggers([PYRE]),
      ),
      rules,
      signature: MAGMA,
    });
    for (const e of ctx.enemies) applyBurn(ctx, e as Enemy, num(10), 200, 0, CENTER, 1);
    const first = ctx.enemies[0] as Enemy;
    hitWithPayload(
      ctx,
      first,
      (ctx.emitters[0] as EmitterRuntime).payload,
      0,
      1e6,
      null,
      null,
      false,
      0,
      -1,
    );
    for (let i = 0; i < 20 && (ctx.pendingCount > 0 || ctx.effectQueue.size > 0); i++) {
      dispatchPendingKills(ctx);
      runEffectQueue(ctx);
    }
    return ctx.enemies.filter((e) => !e.alive).length;
  }

  it('compiles one kill hook for its first instance', () => {
    const build = compileBuild(makeStats(), [{ id: 'pyreChain', depth: 3 }], MAGMA);
    expect(build.hooks.onKill).toHaveLength(1);
  });

  it('without it 焚屍 never fires on its own kills: one link only', () => {
    expect(dead([])).toBe(2);
  });

  it('detonates the burning enemies 焚屍 kills, up to the trigger depth cap', () => {
    // Kills at depths 0 (the hit), 1 (焚屍), 2 (this) and 3 (焚屍): MAX_DEPTH ends the chain
    // there, whatever `depth` allows beyond it.
    expect(MAX_DEPTH).toBe(3);
    expect(dead([{ id: 'pyreChain', depth: 1 }])).toBe(4);
    expect(dead([{ id: 'pyreChain', depth: 3 }])).toBe(4);
  });
});
