/**
 * Self-contained fixtures for simulation tests and tools: game data, stat blocks and run
 * configs built inline, so sim tests never depend on the tuned content in src/data.
 */

import { BASE_STATS, DAMAGE_TAG_MASK_COUNT } from '../data/stats';
import type { StatBlock, StatId } from '../data/stats';
import { ENEMY_IDS } from '../data/types';
import type { EnemyDef, EnemyId, GameData, WaveTable } from '../data/types';
import { createSimulation } from './simulation';
import { NO_INPUT } from './types';
import type { InputFrame, RunConfig, RunResult, SimEvent } from './types';

/** Enemy stats following docs/GDD.md §2.4. */
export const TEST_ENEMIES: Readonly<Record<EnemyId, EnemyDef>> = {
  triangle: {
    id: 'triangle',
    shape: 'triangle',
    hpMult: 0.5,
    speed: 220,
    radius: 16,
    contactDamage: 8,
    dropMult: 0.5,
    cores: 0,
    color: 0xff4fd8,
  },
  square: {
    id: 'square',
    shape: 'square',
    hpMult: 1,
    speed: 110,
    radius: 20,
    contactDamage: 15,
    dropMult: 1,
    cores: 0,
    color: 0x5b6cff,
  },
  pentagon: {
    id: 'pentagon',
    shape: 'pentagon',
    hpMult: 1,
    speed: 150,
    radius: 22,
    contactDamage: 12,
    dropMult: 1,
    cores: 0,
    splitInto: { enemy: 'shard', count: 3 },
    color: 0x3fe07a,
  },
  shard: {
    id: 'shard',
    shape: 'triangle',
    hpMult: 0.25,
    speed: 260,
    radius: 10,
    contactDamage: 4,
    dropMult: 0.25,
    cores: 0,
    color: 0xa6f7bf,
  },
  hexagon: {
    id: 'hexagon',
    shape: 'hexagon',
    hpMult: 3.5,
    speed: 90,
    radius: 34,
    contactDamage: 30,
    dropMult: 3.5,
    cores: 1,
    color: 0xa45cff,
  },
  boss: {
    id: 'boss',
    shape: 'octagon',
    hpMult: 6,
    speed: 60,
    radius: 70,
    contactDamage: 100,
    dropMult: 6,
    cores: 3,
    color: 0xff3d8b,
  },
};

export const TEST_WAVES: WaveTable = {
  rules: [
    { enemy: 'triangle', fromWave: 1, base: 6, perWave: 0.6, maxCount: 40 },
    { enemy: 'square', fromWave: 3, base: 2, perWave: 0.3, maxCount: 20 },
    { enemy: 'pentagon', fromWave: 8, base: 1, perWave: 0.2, maxCount: 12 },
  ],
  eliteEvery: 5,
  bossEvery: 10,
  spawnDurationSec: 1,
  waveTimerSec: 8,
};

export interface TestDataOverrides {
  readonly enemies?: Partial<Record<EnemyId, Partial<EnemyDef>>>;
  readonly waves?: Partial<WaveTable>;
}

/** Fixture game data (no talents); overrides are merged per enemy and into the wave table. */
export function makeTestData(overrides: TestDataOverrides = {}): GameData {
  const enemies = {} as Record<EnemyId, EnemyDef>;
  for (const id of ENEMY_IDS) enemies[id] = { ...TEST_ENEMIES[id], ...overrides.enemies?.[id] };
  return { enemies, waves: { ...TEST_WAVES, ...overrides.waves }, talents: [] };
}

/**
 * Stat block from BASE_STATS plus overrides. `damageMult` is either one multiplier for every
 * tag mask or a function of the mask.
 */
export function makeStats(
  values: Partial<Record<StatId, number>> = {},
  damageMult: number | ((mask: number) => number) = 1,
): StatBlock {
  const mults: number[] = [];
  for (let mask = 0; mask < DAMAGE_TAG_MASK_COUNT; mask++) {
    mults.push(typeof damageMult === 'number' ? damageMult : damageMult(mask));
  }
  return { values: { ...BASE_STATS, ...values }, damageMult: mults };
}

export function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return { seed: 1, stats: makeStats(), rules: [], startWave: 1, mode: 'auto', ...overrides };
}

export interface RecordedRun {
  /** Copied events of every tick; index i holds the events of tick i + 1. */
  readonly ticks: readonly (readonly SimEvent[])[];
  readonly result: RunResult;
}

/** Runs a simulation to its end with a constant input, keeping every tick's events. */
export function recordRun(
  config: RunConfig,
  data: GameData,
  input: InputFrame = NO_INPUT,
): RecordedRun {
  const sim = createSimulation(config, data);
  const ticks: SimEvent[][] = [];
  while (!sim.state.finished) ticks.push(sim.step(input).slice());
  return { ticks, result: sim.result() };
}
