/**
 * Single-type test waves (docs/v3 C10 design §2.3; gd:766, impl:478): wave ENEMY_ROW_WAVE of a
 * table whose one rule is ENEMY_ROW_COUNT enemies of a type (the Boss row: the rotation's boss on a
 * boss wave), played alone from that wave to its clear or ENEMY_ROW_MAX_SECONDS, and read as the
 * clear time and the damage that type's column took from the player. The enemy and outer rows and
 * the affix proxy (checks/rows.ts) are measured on them.
 */

import { deriveSeed } from '../../../src/core/rng';
import { composeWave, parseGameData } from '../../../src/data';
import type { GameData, V3WaveRules, WaveTable } from '../../../src/data';
import { rowEnemyOf } from '../../../src/data/web';
import type { AssembledWeb, RowEnemy } from '../../../src/data/web';
import { webBuild, webRunConfig } from '../../../src/meta/web';
import type { CharacterProgress } from '../../../src/meta/web';
import { CALIBRATION_SEEDS } from '../../../src/meta/web/calibrate';
import { createSimulation, NO_INPUT, TICK_RATE } from '../../../src/sim';
import type { EnemyState, RunResult } from '../../../src/sim';
import { C10_SEED } from './content';
import { typeTallies } from './session';
import type { TypeColumn } from './session';

/**
 * The test wave (初始值): below the 30-min frontier (GDD:212-213: waves 22–30), so a plain wave
 * clears and its time measures the type.
 */
export const ENEMY_ROW_WAVE = 20;
/** Enemies of the type in a test wave (初始值): gd:766 counts leaks per 10. The Boss row has one. */
export const ENEMY_ROW_COUNT = 10;
/** The cut for a wave that never clears (初始值); waveTimerSec equals it, so no second wave starts. */
export const ENEMY_ROW_MAX_SECONDS = 60;
/** Seeds per reading (初始值): CALIBRATION_SEEDS, so a row reads like a calibration (C10/F6). */
export const ENEMY_ROW_SEEDS = CALIBRATION_SEEDS;

/** The design's off switches: an every-N beyond the test, and a treasure wave never reached. */
const NEVER_EVERY = 1000;
const NEVER_TREASURE = 999;

/** A test wave's seed s for type (or column) t: deriveSeed(C10_SEED, 'row:' + t + ':' + s). */
export const rowSeed = (t: string, s: number): number => deriveSeed(C10_SEED, `row:${t}:${s}`);

const tables = new WeakMap<GameData, Map<string, GameData>>();

/** `base` with its wave table replaced, parsed once per key and base, so once per worker. */
function cached(base: GameData, key: string, waves: (v3: V3WaveRules) => WaveTable): GameData {
  let byKey = tables.get(base);
  if (byKey === undefined) {
    byKey = new Map();
    tables.set(base, byKey);
  }
  let data = byKey.get(key);
  if (data === undefined) {
    const v3 = base.waves.v3;
    if (v3 === undefined) throw new Error('A test wave needs v3 data (characterGameData)');
    data = parseGameData({ ...base, waves: waves(v3) });
    byKey.set(key, data);
  }
  return data;
}

/**
 * The test wave data of column t: ENEMY_ROW_COUNT of t from wave 1 and nothing else (no elite,
 * boss, treasure or affix; C7D §1.2 admits any non-tough, non-boss type, the treasure included).
 * The Boss row has no rule and keeps the base's bossEvery, so ENEMY_ROW_WAVE (2 × 10) holds the
 * rotation's boss (bossOf).
 */
export function testWaveData(base: GameData, t: RowEnemy): GameData {
  return cached(base, `row:${t}`, (v3) => ({
    ...base.waves,
    rules:
      t === 'boss'
        ? []
        : [
            {
              enemy: t,
              fromWave: 1,
              base: ENEMY_ROW_COUNT,
              perWave: 0,
              maxCount: ENEMY_ROW_COUNT,
            },
          ],
    eliteEvery: NEVER_EVERY,
    bossEvery: t === 'boss' ? base.waves.bossEvery : NEVER_EVERY,
    waveTimerSec: ENEMY_ROW_MAX_SECONDS,
    v3: { ...v3, affixes: [], treasure: { ...v3.treasure, fromWave: NEVER_TREASURE } },
  }));
}

/**
 * The affix proxy's elite test wave (design §2.3; lead ruling L6): one elite a wave
 * (`eliteEvery` 1) and nothing else; plain, or with one affix from wave 1.
 */
export function eliteWaveData(base: GameData, affixed: boolean): GameData {
  return cached(base, affixed ? 'elite:affixed' : 'elite:plain', (v3) => ({
    ...base.waves,
    rules: [],
    eliteEvery: 1,
    bossEvery: NEVER_EVERY,
    waveTimerSec: ENEMY_ROW_MAX_SECONDS,
    v3: {
      ...v3,
      affixes: affixed ? [{ fromWave: 1, count: 1 }] : [],
      treasure: { ...v3.treasure, fromWave: NEVER_TREASURE },
    },
  }));
}

/** One test wave: its clear time and what its column's enemies did to the player. */
export interface TestWaveReading {
  /** Seconds to the clear, or ENEMY_ROW_MAX_SECONDS when the wave never cleared (flagged). */
  readonly clearSeconds: number;
  readonly cleared: boolean;
  readonly died: boolean;
  /** The wave's enemies: ENEMY_ROW_COUNT, the Boss row's 1, the elite's 1. */
  readonly count: number;
  /** damageTakenBy's hits and damage and bulletTakenBy's damage (null before C7.4b), by column. */
  readonly leaks: number;
  readonly contact: number;
  readonly bullet: number | null;
}

/**
 * A run's reading: cleared when its highestWaveCleared reaches ENEMY_ROW_WAVE (an escaped
 * treasure is gone, so it neither leaks nor stops the clear: C7D §3.2); the tallies of `column`
 * (session.ts' typeTallies: rowEnemyOf's column, a shard's in pentagon's, the rotation boss's in
 * Boss).
 */
export function testWaveReading(
  result: RunResult,
  column: TypeColumn,
  count: number,
): TestWaveReading {
  const cleared = result.highestWaveCleared >= ENEMY_ROW_WAVE;
  const tally = typeTallies(result)[column];
  return {
    clearSeconds: cleared ? result.ticks / TICK_RATE : ENEMY_ROW_MAX_SECONDS,
    cleared,
    died: result.endReason === 'death',
    count,
    leaks: tally.leaks,
    contact: tally.contact,
    bullet: tally.bullet,
  };
}

/**
 * `progress` on `web` against the one type of `data`'s ENEMY_ROW_WAVE: from that wave with
 * waveCap the same, so the run ends at the clear, cut at ENEMY_ROW_MAX_SECONDS. `watch` sees each
 * enemy as it spawns.
 */
export function testWaveRun(
  web: AssembledWeb,
  progress: CharacterProgress,
  data: GameData,
  seed: number,
  watch?: (enemy: EnemyState) => void,
): TestWaveReading {
  const entries = composeWave(ENEMY_ROW_WAVE, data.waves);
  const entry = entries[0];
  if (entry === undefined || entries.length > 1) {
    const types = entries.map(({ enemy }) => enemy).join(', ') || 'none';
    throw new Error(`A test wave holds one type; wave ${ENEMY_ROW_WAVE} holds ${types}`);
  }
  const config = {
    ...webRunConfig(webBuild(web, progress), seed, ENEMY_ROW_WAVE, ENEMY_ROW_WAVE),
    maxTicks: ENEMY_ROW_MAX_SECONDS * TICK_RATE,
  };
  const sim = createSimulation(config, data);
  while (!sim.state.finished) {
    const events = sim.step(NO_INPUT);
    if (watch === undefined) continue;
    for (const event of events) {
      if (event.type !== 'enemySpawned') continue;
      const enemy = sim.state.enemies.find(({ id }) => id === event.enemyId);
      if (enemy !== undefined) watch(enemy);
    }
  }
  return testWaveReading(sim.result(), rowEnemyOf(entry.enemy) ?? 'elite', entry.count);
}
