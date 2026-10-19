import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import type { RuleSpec } from '../../data/rules';
import { BASE_STATS } from '../../data/stats';
import type { TestModule } from '../rules';
import { createSimulation } from '../simulation';
import { createRunContext } from '../systems/context';
import { EMITTER_STEPS } from '../systems/emitters';
import { makeConfig, makeStats, makeTestData, stationarySquares } from '../testing';
import { NO_INPUT, TICK_RATE } from '../types';
import type { RunConfig } from '../types';
import { BASE_ATTACK_SPEED, VOLLEY_RATE } from './types';

/**
 * The steady flag of each attack's projectiles, in attack order. Every attack fires within one
 * tick, and its projectiles are still in flight at the end of it (the squares stand far off).
 */
function steadyByAttack(config: RunConfig, count: number, modules: TestModule[] = []) {
  const sim = createSimulation(config, stationarySquares(count), modules);
  const attacks: boolean[][] = [];
  while (!sim.state.finished) {
    const fired = sim.step(NO_INPUT).flatMap((event) => (event.type === 'attack' ? [event] : []));
    if (fired.length === 0) continue;
    const steady = new Map(sim.state.projectiles.map((p) => [p.id, p.steady]));
    attacks.push(fired.map((event) => steady.get(event.projectileId) ?? false));
  }
  return attacks;
}

const VOLLEY = { damage: 10, attackSpeed: 6, projectileCount: 3, critChance: 0 };
const steadyAim = (counts: 'shot' | 'attack', everyNth = 2): RuleSpec => ({
  id: 'steadyAim',
  everyNth,
  critMultiplierMore: 0,
  counts,
});

describe('volley', () => {
  it("makes every shot of each Nth attack steady with steadyAim counting 'attack'", () => {
    const config = makeConfig({ stats: makeStats(VOLLEY), rules: [steadyAim('attack')] });
    const attacks = steadyByAttack({ ...config, maxTicks: 300 }, 4);
    expect(attacks.length).toBeGreaterThan(10);
    attacks.forEach((shots, i) => {
      expect(shots).toEqual(Array<boolean>(3).fill((i + 1) % 2 === 0));
    });
  });

  it("makes every Nth shot steady with steadyAim counting 'shot', across attacks", () => {
    const config = makeConfig({ stats: makeStats(VOLLEY), rules: [steadyAim('shot')] });
    const attacks = steadyByAttack({ ...config, maxTicks: 300 }, 4);
    expect(attacks.every((shots) => shots.length === 3)).toBe(true);
    attacks.flat().forEach((steady, i) => expect(steady, `shot ${i + 1}`).toBe((i + 1) % 2 === 0));
  });

  it('counts an attack before it fires, then each projectile it fires as a shot', () => {
    const seen: { attacks: number; shots: number; volley: number }[] = [];
    const module: TestModule = (b) =>
      b.hook('onAttack', (_ctx, em) => {
        seen.push({ attacks: em.attacks, shots: em.shots, volley: em.volley });
      });
    // 2 or 3 projectiles per attack, rolled when the attack fires, after the hooks.
    const config = makeConfig({
      stats: makeStats({ ...VOLLEY, projectileCount: 2.5 }),
      rules: [steadyAim('shot', 3)],
      maxTicks: 600,
    });
    const attacks = steadyByAttack(config, 4, [module]);
    const sizes = attacks.map((shots) => shots.length);
    expect(new Set(sizes)).toEqual(new Set([2, 3]));
    let fired = 0;
    expect(seen).toEqual(
      sizes.map((size, i) => {
        const before = fired;
        fired += size;
        return { attacks: i + 1, shots: before, volley: i + 1 };
      }),
    );
    // Shots count across attacks of any size: every 3rd projectile fired is steady.
    attacks.flat().forEach((steady, i) => expect(steady, `shot ${i + 1}`).toBe((i + 1) % 3 === 0));
  });

  it('makes every projectile of an attack steady when an onAttack hook sets forceCrit', () => {
    const module: TestModule = (b) =>
      b.hook('onAttack', (_ctx, em, shot) => {
        if (em.attacks % 2 === 0) shot.forceCrit = true;
      });
    const config = makeConfig({ stats: makeStats(VOLLEY), maxTicks: 300 });
    const attacks = steadyByAttack(config, 4, [module]);
    expect(attacks.length).toBeGreaterThan(10);
    attacks.forEach((shots, i) => {
      expect(shots).toEqual(Array<boolean>(3).fill((i + 1) % 2 === 0));
    });
  });

  it('attacks every 60 / attackSpeed ticks exactly, from the emitter stage at index 0', () => {
    expect(BASE_ATTACK_SPEED).toBe(BASE_STATS.attackSpeed);
    expect(VOLLEY_RATE).toBe(BASE_ATTACK_SPEED);
    const rng = createRng(11);
    const data = makeTestData();
    const speeds = [0, ...Array.from({ length: 20 }, () => 10 ** rng.range(-2, 3))];
    for (const attackSpeed of speeds) {
      const ctx = createRunContext(makeConfig({ stats: makeStats({ attackSpeed }) }), data);
      const [volley] = ctx.emitters;
      expect(volley?.interval, `attackSpeed ${attackSpeed}`).toBe(
        attackSpeed > 0 ? TICK_RATE / attackSpeed : Infinity,
      );
      expect(volley?.index).toBe(0);
      const stepped = ctx.emitters.filter((em) => EMITTER_STEPS[em.spec.kind] !== null);
      expect(stepped).toHaveLength(1);
      expect(stepped[0]).toBe(volley);
      expect(ctx.thornsEmitters).toEqual([]);
      expect(ctx.sys.segments.emitters).toEqual([]);
    }
  });

  it("attacks on M1's accumulator ticks at any attack speed (cadence 1)", () => {
    const ticks = 120;
    const rng = createRng(5);
    let mismatches = 0;
    for (let run = 0; run < 2000; run++) {
      const attackSpeed = rng.range(0.5, 40);
      // M1: attackTicks += 1 per tick; an attack each time it reaches the interval.
      const interval = TICK_RATE / attackSpeed;
      const expected: number[] = [];
      let attackTicks = 0;
      for (let tick = 1; tick <= ticks; tick++) {
        attackTicks += 1;
        while (attackTicks >= interval) {
          attackTicks -= interval;
          expected.push(tick);
        }
      }
      const stats = makeStats({ attackSpeed, projectileCount: 1 });
      const sim = createSimulation(makeConfig({ stats, maxTicks: ticks }), stationarySquares(1));
      const actual: number[] = [];
      while (!sim.state.finished) {
        for (const event of sim.step(NO_INPUT)) {
          if (event.type === 'attack') actual.push(sim.state.tick);
        }
      }
      if (actual.join() !== expected.join()) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});
