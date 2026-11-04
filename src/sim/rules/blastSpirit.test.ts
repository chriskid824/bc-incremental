import { describe, expect, it } from 'vitest';
import type { RuleSpec, SignatureSpec } from '../../data/rules';
import { compileBuild } from '../build/compile';
import { EVENT } from '../effects/types';
import { createSimulation } from '../simulation';
import type { DronePool } from '../systems/systemState';
import { makeConfig, makeStats, makeTestData } from '../testing';
import { NO_INPUT } from '../types';
import type { TestModule } from './module';

const MAGMA: SignatureSpec = { id: 'magmaBomb' };
const SPIRIT = (every = 4, maxLive = 6): RuleSpec => ({
  id: 'blastSpirit',
  every,
  lifeSec: 4,
  damagePct: 1,
  burnStacks: 3,
  burnDamagePct: 1,
  maxLive,
});

describe('blastSpirit (爆靈)', () => {
  it('compiles one spawnDrone effect of its numbers and one onCenterEvent hook', () => {
    const plain = compileBuild(makeStats(), [], MAGMA);
    const build = compileBuild(makeStats(), [SPIRIT()], MAGMA);
    expect(build.effects.map((fx) => fx.spec)).toContainEqual({
      kind: 'spawnDrone',
      lifeSec: 4,
      damagePct: 1,
      maxLive: 6,
      ailment: 'burn',
      ailmentStacks: 3,
      ailmentDamagePct: 1,
      tags: ['trigger'],
    });
    expect(build.hooks.onCenterEvent).toHaveLength(plain.hooks.onCenterEvent.length + 1);
  });

  it('is a compile error in a run of another signature', () => {
    expect(() => compileBuild(makeStats(), [SPIRIT()])).toThrow(
      "rule 'blastSpirit' tunes the magmaBomb signature, but this run's signature is 'm1Volley'",
    );
  });

  it.each([
    [4, 6],
    [2, 2],
  ])(
    'spawns a spirit at every %i-th bomb explosion of a run, at most %i alive at once',
    (every, maxLive) => {
      let explodes = 0;
      const counter: TestModule = (b) =>
        b.hook('onCenterEvent', (_ctx, ev) => {
          if (ev.event === EVENT.explode) explodes++;
        });
      const sim = createSimulation(
        makeConfig({
          stats: makeStats({ maxLife: 1e12 }),
          signature: MAGMA,
          rules: [SPIRIT(every, maxLive)],
          maxTicks: 1800,
        }),
        makeTestData(),
        [counter],
      );
      const ds = sim.state.drones as DronePool;
      let expired = 0;
      let peak = 0;
      while (!sim.state.finished) {
        expired += sim.step(NO_INPUT).filter((e) => e.type === 'droneExpire').length;
        peak = Math.max(peak, ds.count);
      }
      const spawned = expired + ds.count + sim.result().counters.summonCapped;
      expect(explodes).toBeGreaterThan(8 * every);
      // The last explosion's spirit may still sit in the queue when the run ends.
      expect(Math.floor(explodes / every) - spawned).toBeGreaterThanOrEqual(0);
      expect(Math.floor(explodes / every) - spawned).toBeLessThanOrEqual(1);
      expect(peak).toBeLessThanOrEqual(maxLive);
      expect(peak).toBeGreaterThan(0);
    },
  );
});
