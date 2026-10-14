import { describe, expect, it } from 'vitest';
import { compileCondition, conditionsMet } from '../build/eval';
import { CHAIN_HIT_CAP } from '../caps';
import { CHAIN_JUMP, HIT_EVENT, PRIMARY, REPEAT } from '../effects/flags';
import type { EmitterRuntime, Payload } from '../emitters/types';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import type { Enemy, RunContext } from '../systems/context';
import {
  centerTriggers,
  eventsOf,
  makeConfig,
  makeStats,
  placedEnemies,
  stationarySquares,
} from '../testing';
import type { PlacedEnemy } from '../testing';
import { NO_INPUT } from '../types';
import { chainAttack } from './chain';

const signaturePayload = (ctx: RunContext): Payload => (ctx.emitters[0] as EmitterRuntime).payload;

/** `count` immortal squares on a grid of 20 per row, 20 apart: all within one chain's range. */
const rows = (count: number): PlacedEnemy[] =>
  Array.from({ length: count }, (_, i) => ({
    x: 100 + 20 * (i % 20),
    y: 100 + 20 * Math.floor(i / 20),
  }));

const CHAINS = makeStats({ chainRange: 5000, critChance: 0, igniteChance: 0 });

describe('the chain cap', () => {
  // 50 enemies scan linearly; 200 go through the grid (GRID_LINEAR_BELOW is 128).
  it.each([50, 200])('stops a chain of 40 at %i enemies after 32 hits, counting 9 refused', (n) => {
    const ctx = placedEnemies(rows(n), { stats: CHAINS });
    expect(ctx.grid.linearSource() === null).toBe(n >= 128);
    chainAttack(ctx, signaturePayload(ctx), ctx.enemies[0] as Enemy, 40, false, 0, -1);
    const hits = eventsOf([ctx.events], 'hit');
    expect(CHAIN_HIT_CAP).toBe(32);
    expect(hits).toHaveLength(32);
    expect(hits.map((hit) => hit.chainIndex)).toEqual(Array.from({ length: 32 }, (_, k) => k));
    expect(new Set(hits.map((hit) => hit.targetId)).size).toBe(32);
    // Jumps 32 to 40 were refused: 40 − 32 + 1.
    expect(ctx.counters.chainHitCapped).toBe(9);
    expect(ctx.counters.chainHitsPeak).toBe(32);
    expect(ctx.chainBudget.hits).toBe(32);
  });

  it('refuses nothing when the chain runs out of enemies first', () => {
    const ctx = placedEnemies(rows(10), { stats: CHAINS });
    chainAttack(ctx, signaturePayload(ctx), ctx.enemies[0] as Enemy, 40, false, 0, -1);
    expect(eventsOf([ctx.events], 'hit')).toHaveLength(10);
    expect(ctx.counters.chainHitCapped).toBe(0);
    expect(ctx.counters.chainHitsPeak).toBe(10);
  });

  it('keeps the most hits one attack dealt in chainHitsPeak', () => {
    const ctx = placedEnemies(rows(50), { stats: CHAINS });
    const p = signaturePayload(ctx);
    const first = ctx.enemies[0] as Enemy;
    const peaks: number[] = [];
    for (const count of [3, 1, 40, 0, 5]) {
      const serial = ctx.attackSerial;
      chainAttack(ctx, p, first, count, false, 0, -1);
      // Each attack has its own serial and budget.
      expect(ctx.attackSerial).toBe(serial + 1);
      expect(ctx.chainBudget.hits).toBe(Math.min(count + 1, CHAIN_HIT_CAP));
      peaks.push(ctx.counters.chainHitsPeak);
    }
    expect(peaks).toEqual([4, 4, 32, 32, 32]);
    expect(ctx.counters.chainHitCapped).toBe(9);
  });
});

describe('PRIMARY', () => {
  /** Every hit of a run with chains and effect hits: its chain index, origin and flags. */
  function hitFlags(): { chainIndex: number; origin: number; flags: number }[] {
    const seen: { chainIndex: number; origin: number; flags: number }[] = [];
    const module: TestModule = (b) =>
      b.hook('onHit', (_ctx, hit) => {
        seen.push({ chainIndex: hit.chainIndex, origin: hit.origin, flags: hit.flags });
      });
    // Crits explode, so effect hits (origin ≥ 0) land on the squares too.
    const stats = makeStats(
      { damage: 10, critChance: 0.5, chainCount: 2, chainRange: 5000, projectileCount: 2 },
      [],
      centerTriggers([{ on: 'crit', do: [{ kind: 'explode', radius: 200, damagePct: 0.2 }] }]),
    );
    const sim = createSimulation(makeConfig({ stats, maxTicks: 300 }), stationarySquares(6, 1e6), [
      module,
    ]);
    while (!sim.state.finished) sim.step(NO_INPUT);
    return seen;
  }

  it('marks exactly the primary hits of the arrivals, never a jump or an effect hit', () => {
    const hits = hitFlags();
    const arrival = (hit: (typeof hits)[number]): boolean =>
      hit.origin === -1 && hit.chainIndex === 0;
    expect(hits.filter(arrival).length).toBeGreaterThan(10);
    expect(hits.filter((hit) => hit.chainIndex > 0).length).toBeGreaterThan(10);
    expect(hits.filter((hit) => hit.origin >= 0).length).toBeGreaterThan(10);
    for (const hit of hits) {
      expect((hit.flags & PRIMARY) !== 0, JSON.stringify(hit)).toBe(arrival(hit));
      expect(hit.flags & REPEAT).toBe(0);
    }
  });

  it("holds hitIs 'primary' on the arrivals' primary hits only", () => {
    const primary = [compileCondition({ hitIs: 'primary' })];
    const hits = hitFlags();
    for (const hit of hits) {
      const holds = conditionsMet(primary, null, 0, hit.flags);
      expect(holds, JSON.stringify(hit)).toBe(hit.origin === -1 && hit.chainIndex === 0);
    }
    // An effect hit is chain index 0 and HIT, which held for 'primary' before PRIMARY existed.
    expect(hits.some((hit) => hit.origin >= 0 && (hit.flags & HIT_EVENT) !== 0)).toBe(true);
  });

  it('reaches the kill flags: a kill by the primary hit carries it, a kill by a jump not', () => {
    const killFlags: number[] = [];
    const module: TestModule = (b) =>
      b.hook('onKill', (_ctx, _victim, kill) => {
        killFlags.push(kill.flags);
      });
    const ctx = placedEnemies(
      [
        { x: 100, y: 100, hp: 1 },
        { x: 120, y: 100, hp: 1 },
      ],
      { stats: CHAINS, modules: [module] },
    );
    chainAttack(ctx, signaturePayload(ctx), ctx.enemies[0] as Enemy, 1, false, 0, -1);
    expect(killFlags).toHaveLength(2);
    const [byPrimary, byJump] = killFlags as [number, number];
    expect(byPrimary & (PRIMARY | CHAIN_JUMP)).toBe(PRIMARY);
    expect(byJump & (PRIMARY | CHAIN_JUMP)).toBe(CHAIN_JUMP);
  });
});
