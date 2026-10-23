import { describe, expect, it } from 'vitest';
import { createSimulation, NO_INPUT } from '../../sim';
import { livePoisonStacks } from '../../sim/ailments/rings';
import type { TestModule } from '../../sim/rules';
import type { Enemy, RunContext } from '../../sim/systems/context';
import { STRESS_START_WAVE } from '../../sim/testing';
import { BOSS_POISON_STACKS, RENDER_STRESS_AURA_RADIUS, renderStressSetup } from './presets';

/** What test 6 reads of renderStress's seed-1 run of 1,800 ticks (bench.ts' stress window). */
interface Reading {
  /** Alive enemies after each tick past 300, averaged over ticks 301–1800. */
  readonly aliveAvg: number;
  /** At tick 600: summons placed, orbs, aura emitters and their pulses so far. */
  readonly summons: number;
  readonly orbs: number;
  readonly orbitRings: number;
  readonly auras: number;
  readonly auraRadius: number;
  readonly auraPulses: number;
  /** The boss's live poison stacks at tick 900, and the fewest from tick 900 to 1800. */
  readonly poisonAt900: number;
  readonly poisonLeast: number;
  readonly boss: Enemy | null;
  readonly bossMoved: boolean;
}

let reading: Reading | null = null;

/** renderStress's seed-1 run, read once per file. */
function seedOne(): Reading {
  if (reading !== null) return reading;
  const setup = renderStressSetup();
  const seen: { ctx: RunContext | null } = { ctx: null };
  const watch: TestModule = (b) =>
    void b.hook('tick', (ctx) => {
      seen.ctx = ctx;
    });
  const config = { ...setup.config(1, STRESS_START_WAVE), maxTicks: 1800 };
  const sim = createSimulation(config, setup.data, [...setup.testModules, watch]);
  let aliveSum = 0;
  let aliveTicks = 0;
  let auraPulses = 0;
  let at600 = { summons: 0, orbs: 0, orbitRings: 0, auras: 0, auraRadius: 0, auraPulses: 0 };
  let poisonAt900 = 0;
  let poisonLeast = Infinity;
  let boss: Enemy | null = null;
  let bossAt: readonly [number, number] | null = null;
  let bossMoved = false;
  while (!sim.state.finished) {
    for (const event of sim.step(NO_INPUT)) {
      if (event.type === 'pulse' && event.kind === 'aura') auraPulses++;
    }
    const { tick, enemies } = sim.state;
    let alive = 0;
    for (const enemy of enemies) if (enemy.alive) alive++;
    if (tick > 300) {
      aliveSum += alive;
      aliveTicks++;
    }
    const ctx = seen.ctx as RunContext;
    boss ??= ctx.enemies.find((enemy) => enemy.def.boss) ?? null;
    if (boss !== null) {
      bossAt ??= [boss.x, boss.y];
      if (boss.x !== bossAt[0] || boss.y !== bossAt[1]) bossMoved = true;
    }
    if (tick === 600) {
      const orbits = ctx.emitters.filter((em) => em.spec.kind === 'orbit');
      at600 = {
        summons: sim.state.droneCount,
        orbs: orbits.reduce((sum, em) => sum + (em.orbs?.n ?? 0), 0),
        orbitRings: orbits.length,
        auras: ctx.emitters.filter((em) => em.spec.kind === 'aura').length,
        auraRadius: ctx.build.values.auraRadius,
        auraPulses,
      };
    }
    if (tick >= 900 && boss !== null) {
      const stacks = livePoisonStacks(boss, ctx.now);
      if (tick === 900) poisonAt900 = stacks;
      poisonLeast = Math.min(poisonLeast, stacks);
    }
  }
  reading = {
    aliveAvg: aliveSum / aliveTicks,
    ...at600,
    poisonAt900,
    poisonLeast,
    boss,
    bossMoved,
  };
  return reading;
}

/** Lead ruling J7: stress v4 alone sits at the stress band's floor, and the boss's poison, the aura and the orbs each kill more on top of it, so the composed scene cannot read 280 (v4 280.983; +boss 279.743; +aura 278.995; +8 orbs 275.803; all composed 271.183). */
const RENDER_STRESS_ALIVE_BAND = [260, 320] as const;

describe('renderStress in node, seed 1 (docs/v3 C10 design §2.5, OWN test 6)', () => {
  it('holds 260–320 alive on average over ticks 301–1800, its own band', () => {
    const { aliveAvg } = seedOne();
    const [least, most] = RENDER_STRESS_ALIVE_BAND;
    expect(aliveAvg).toBeGreaterThanOrEqual(least);
    expect(aliveAvg).toBeLessThanOrEqual(most);
  });

  it('runs 32 summons at tick 600, two rings of 4 orbs and the aura, pulsing', () => {
    const run = seedOne();
    expect(run.summons).toBe(32);
    expect([run.orbs, run.orbitRings]).toEqual([8, 2]);
    expect([run.auras, run.auraRadius]).toEqual([1, RENDER_STRESS_AURA_RADIUS]);
    expect(run.auraPulses).toBeGreaterThan(0);
  });

  it('holds 450–550 poison stacks on its boss by tick 900, which never moves or dies', () => {
    const run = seedOne();
    expect(BOSS_POISON_STACKS).toBe(500);
    expect(run.poisonAt900).toBeGreaterThanOrEqual(450);
    expect(run.poisonAt900).toBeLessThanOrEqual(550);
    expect(run.poisonLeast).toBeGreaterThanOrEqual(450);
    expect(run.boss?.alive).toBe(true);
    expect(run.bossMoved).toBe(false);
  });
});
