import { describe, expect, it } from 'vitest';
import { createSimulation } from './simulation';
import { createRunContext } from './systems/context';
import { makeConfig, makeStats, makeTestData } from './testing';
import { COUNTER_IDS, MAX_RUN_SECONDS, NO_INPUT, TICK_RATE } from './types';

describe('simulation speed', () => {
  it('keeps the run context below 128 properties, so every run shares its hidden class', () => {
    // V8 caches the hidden class of an object literal only below 128 properties; past that each
    // createRunContext builds its own, and every ctx access in the systems goes megamorphic
    // once a few runs have passed through them (C4.4 measured a quarter slower). So add no
    // top-level field: a system's state goes into its member of ctx.sys (SystemState, from
    // C4.6), a per-emitter or shot buffer into the object that owns it (EmitterRuntime,
    // ShotPool), each created with all its members in its owner's literal, as ctx.selection and
    // ctx.centerEvents group theirs (docs/v3 C4 design §0.7).
    const ctx = createRunContext(makeConfig(), makeTestData());
    expect(Object.keys(ctx).length).toBeLessThan(128);
  });

  it('builds RunContext.counters as one object literal of every COUNTER_IDS key, in order', () => {
    // Filled key by key from COUNTER_IDS, as createRunContext did up to 19 counters, the object
    // keeps a hidden class only while it is small; past about 20 keys V8 may turn it into a
    // dictionary, and every counter write in the systems slows down (docs/v3 C5 design §0.4,
    // CD12). So from E10a's barrageCapped, the 20th, it is one literal, typed over CounterId so
    // that a new counter does not compile without its key; this holds its order to the list's.
    const ctx = createRunContext(makeConfig(), makeTestData());
    expect(COUNTER_IDS).toHaveLength(20);
    expect(Object.keys(ctx.counters)).toEqual([...COUNTER_IDS]);
  });

  it('runs a full 180 s run with a crowded arena quickly', () => {
    // Mid-strength build pushed past its frontier: enemies pile up, burn and chain all run.
    const config = makeConfig({
      seed: 7,
      startWave: 40,
      stats: makeStats({
        damage: 3e4,
        attackSpeed: 12,
        critChance: 0.3,
        igniteChance: 0.8,
        chainCount: 4,
        maxLife: 1e12,
      }),
    });
    const data = makeTestData();
    for (const label of ['cold', 'warm']) {
      const sim = createSimulation(config, data);
      let maxAlive = 0;
      const start = performance.now();
      while (!sim.state.finished) {
        sim.step(NO_INPUT);
        if (sim.state.enemies.length > maxAlive) maxAlive = sim.state.enemies.length;
      }
      const ms = performance.now() - start;
      const result = sim.result();
      console.log(
        `180 s run (${label}): ${ms.toFixed(1)} ms, ${result.kills} kills, ` +
          `up to ${maxAlive} enemies alive`,
      );
      expect(result.ticks).toBe(MAX_RUN_SECONDS * TICK_RATE);
      expect(maxAlive).toBeGreaterThan(50);
      expect(ms).toBeLessThan(3000);
    }
  });
});
