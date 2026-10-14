import { describe, expect, it, vi } from 'vitest';
import { stdHp } from '../../data/curve';
import { createSimulation } from '../simulation';
import {
  centerTriggers,
  makeConfig,
  makeStats,
  makeTestData,
  PANDEMIC_MODS,
  PANDEMIC_TRIGGER,
} from '../testing';
import { NO_INPUT } from '../types';
import type { RunConfig } from '../types';
import type * as GridSystem from './grid';
import { GRID_LINEAR_BELOW } from './grid';

/** linearBelow of the next enemy grid the simulation creates. */
const forced = vi.hoisted(() => ({ linearBelow: 0 }));

vi.mock('./grid', async (importOriginal) => {
  const original = await importOriginal<typeof GridSystem>();
  const { SpatialGrid } = await import('../grid');
  const { ARENA_HEIGHT, ARENA_WIDTH } = await import('../types');
  return {
    ...original,
    createEnemyGrid: () =>
      new SpatialGrid(ARENA_WIDTH, ARENA_HEIGHT, original.GRID_CELL_SIZE, forced.linearBelow),
  };
});

/** About 300 enemies alive, elites and bosses among them, pentagons splitting on death. */
const DENSE = makeTestData({
  waves: {
    rules: [
      { enemy: 'triangle', fromWave: 1, base: 60, perWave: 0, maxCount: 60 },
      { enemy: 'square', fromWave: 1, base: 60, perWave: 0, maxCount: 60 },
      { enemy: 'pentagon', fromWave: 1, base: 20, perWave: 0, maxCount: 20 },
    ],
    eliteEvery: 2,
    bossEvery: 5,
    spawnDurationSec: 1.5,
    waveTimerSec: 2,
  },
});

const START_WAVE = 20;
const HP = stdHp(START_WAVE);

/** Every grid query kind the simulation makes: targets, volleys and focus, chains, spread. */
const SCENARIOS: Record<string, Partial<RunConfig>> = {
  chains: {
    stats: makeStats({
      damage: HP * 0.6,
      attackSpeed: 6,
      critChance: 0.25,
      igniteChance: 0.5,
      chainCount: 3,
      chainRange: 250,
      maxLife: 1e12,
    }),
  },
  volleys: {
    stats: makeStats({
      damage: HP * 0.15,
      attackSpeed: 12,
      projectileCount: 4,
      critChance: 0.25,
      igniteChance: 0.3,
      chainCount: 5,
      chainRange: 300,
      maxLife: 1e12,
    }),
  },
  pandemic: {
    stats: makeStats(
      {
        damage: HP * 0.5,
        attackSpeed: 5,
        projectileCount: 3,
        igniteChance: 0.7,
        burnMaxStacks: 6,
        chainCount: 2,
        maxLife: 1e12,
      },
      PANDEMIC_MODS,
      centerTriggers([PANDEMIC_TRIGGER]),
    ),
  },
};

interface Run {
  /** Every tick's events, serialized. */
  readonly ticks: readonly string[];
  readonly result: string;
  readonly maxAlive: number;
}

function run(config: RunConfig, linearBelow: number): Run {
  forced.linearBelow = linearBelow;
  const sim = createSimulation(config, DENSE);
  const ticks: string[] = [];
  let maxAlive = 0;
  while (!sim.state.finished) {
    ticks.push(JSON.stringify(sim.step(NO_INPUT)));
    maxAlive = Math.max(maxAlive, sim.state.enemies.length);
  }
  return { ticks, result: JSON.stringify(sim.result()), maxAlive };
}

describe('grid system', () => {
  // The simulation's grid sorts the enemies into cells only from GRID_LINEAR_BELOW enemies on;
  // forcing either way for whole dense runs shows both give the very same run.
  describe.each(Object.entries(SCENARIOS))('%s', (_name, overrides) => {
    it.each([1, 2])('gives the same run with cells or linear scans (seed %i)', (seed) => {
      const config = makeConfig({ seed, startWave: START_WAVE, maxTicks: 600, ...overrides });
      const cells = run(config, 0);
      expect(cells.maxAlive).toBeGreaterThan(GRID_LINEAR_BELOW * 2);
      for (const linearBelow of [GRID_LINEAR_BELOW, Infinity]) {
        const other = run(config, linearBelow);
        // The first tick whose events differ, if any; -1 keeps the failure message short.
        expect(other.ticks.findIndex((tick, i) => tick !== cells.ticks[i])).toBe(-1);
        expect(other.ticks.length).toBe(cells.ticks.length);
        expect(other.result).toBe(cells.result);
      }
    });
  });
});
