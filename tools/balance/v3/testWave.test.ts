import { describe, expect, it } from 'vitest';
import { deriveSeed } from '../../../src/core/rng';
import {
  bossOf,
  characterGameData,
  composeWave,
  loadGameData,
  parseGameData,
} from '../../../src/data';
import type { EnemyId } from '../../../src/data';
import { ROW_ENEMIES } from '../../../src/data/web';
import { auditStart } from '../../../src/meta/web/invest';
import type { ContactTally, RunResult } from '../../../src/sim';
import { C10_SEED, webOf } from './content';
import {
  ENEMY_ROW_COUNT,
  ENEMY_ROW_MAX_SECONDS,
  ENEMY_ROW_SEEDS,
  ENEMY_ROW_WAVE,
  eliteWaveData,
  rowSeed,
  testWaveData,
  testWaveReading,
  testWaveRun,
} from './testWave';

const base = characterGameData();

describe('test wave data', () => {
  it('holds ENEMY_ROW_COUNT of the type on every wave to the test wave, and no elite, boss, treasure or affix (OWN 1)', () => {
    expect([ENEMY_ROW_WAVE, ENEMY_ROW_COUNT, ENEMY_ROW_MAX_SECONDS, ENEMY_ROW_SEEDS]).toEqual([
      20, 10, 60, 8,
    ]);
    for (const t of ROW_ENEMIES.filter((column) => column !== 'boss')) {
      const data = testWaveData(base, t);
      expect(data.waves.rules).toEqual([
        { enemy: t, fromWave: 1, base: 10, perWave: 0, maxCount: 10 },
      ]);
      for (let wave = 1; wave <= ENEMY_ROW_WAVE; wave++) {
        expect(composeWave(wave, data.waves)).toEqual([{ enemy: t, count: ENEMY_ROW_COUNT }]);
      }
      expect(data.waves).toMatchObject({
        eliteEvery: 1000,
        bossEvery: 1000,
        waveTimerSec: ENEMY_ROW_MAX_SECONDS,
      });
      expect(data.waves.v3?.affixes).toEqual([]);
      expect(data.waves.v3?.treasure.fromWave).toBe(999);
      // Only the wave table changes: the types and the rest of the v3 block are the base's.
      expect(data.enemies).toEqual(base.enemies);
      expect(data.waves.v3?.bossRotation).toEqual(base.waves.v3?.bossRotation);
      expect(data.waves.v3?.enemyCap).toEqual(base.waves.v3?.enemyCap);
    }
  });

  it("holds the rotation's boss alone on the test wave, a boss wave of the base (OWN 1)", () => {
    const data = testWaveData(base, 'boss');
    expect(data.waves.rules).toEqual([]);
    expect(data.waves.bossEvery).toBe(base.waves.bossEvery);
    expect(ENEMY_ROW_WAVE % base.waves.bossEvery).toBe(0);
    expect(bossOf(ENEMY_ROW_WAVE, base.waves)).toBe('onion');
    expect(composeWave(ENEMY_ROW_WAVE, data.waves)).toEqual([{ enemy: 'onion', count: 1 }]);
    expect(data.waves.eliteEvery).toBe(1000);
    expect(data.waves.v3?.affixes).toEqual([]);
    expect(data.waves.v3?.treasure.fromWave).toBe(999);
  });

  it('parses each table once per base and key', () => {
    expect(testWaveData(base, 'square')).toBe(testWaveData(base, 'square'));
    expect(testWaveData(base, 'square')).not.toBe(testWaveData(base, 'triangle'));
    expect(testWaveData({ ...base }, 'square')).not.toBe(testWaveData(base, 'square'));
    expect(eliteWaveData(base, true)).toBe(eliteWaveData(base, true));
    expect(eliteWaveData(base, true)).not.toBe(eliteWaveData(base, false));
  });

  it('refuses a base without the v3 block', () => {
    expect(() => testWaveData(loadGameData(), 'triangle')).toThrow('A test wave needs v3 data');
  });

  it('holds one elite a wave, plain or with one affix from wave 1 (lead ruling L6)', () => {
    for (const affixed of [false, true]) {
      const data = eliteWaveData(base, affixed);
      expect(data.waves.rules).toEqual([]);
      for (const wave of [1, 5, 10, ENEMY_ROW_WAVE]) {
        expect(composeWave(wave, data.waves)).toEqual([{ enemy: 'hexagon', count: 1 }]);
      }
      expect(data.waves.v3?.affixes).toEqual(affixed ? [{ fromWave: 1, count: 1 }] : []);
      expect(data.waves.v3?.treasure.fromWave).toBe(999);
      expect(data.waves.waveTimerSec).toBe(ENEMY_ROW_MAX_SECONDS);
    }
  });

  it("derives a type's seeds from C10_SEED, the type and the index", () => {
    expect(rowSeed('triangle', 3)).toBe(deriveSeed(C10_SEED, 'row:triangle:3'));
    expect(rowSeed('boss', 0)).toBe(deriveSeed(C10_SEED, 'row:boss:0'));
    expect(rowSeed('triangle', 0)).not.toBe(rowSeed('square', 0));
    expect(rowSeed('triangle', 0)).not.toBe(rowSeed('triangle', 1));
  });
});

describe('test wave readings', () => {
  const tally = (hits: number, damage: number): ContactTally => ({ hits, damage });
  const takenBy = (entries: Partial<Record<EnemyId, ContactTally>>) => {
    const zero = Object.fromEntries(Object.keys(base.enemies).map((id) => [id, tally(0, 0)]));
    return { ...zero, ...entries } as Record<EnemyId, ContactTally>;
  };
  const result = (fields: Record<string, unknown>): RunResult =>
    ({
      highestWaveCleared: ENEMY_ROW_WAVE,
      ticks: 600,
      endReason: 'waveCap',
      kills: 0,
      leaks: 0,
      damageTakenBy: takenBy({}),
      ...fields,
    }) as unknown as RunResult;

  it("reads leaks from the column's hits and damage from its contact, bullets null before C7.4b", () => {
    const run = result({ damageTakenBy: takenBy({ triangle: tally(3, 7) }), leaks: 5, kills: 2 });
    expect(testWaveReading(run, 'triangle', 10)).toEqual({
      clearSeconds: 10,
      cleared: true,
      died: false,
      count: 10,
      leaks: 3,
      kills: 2,
      contact: 7,
      bullet: null,
    });
  });

  it("adds bulletTakenBy's damage when the result has it, 0 for a column no shot hit", () => {
    const damageTakenBy = takenBy({ shooter: tally(1, 4) });
    const shot = result({ damageTakenBy, bulletTakenBy: takenBy({ shooter: tally(2, 5) }) });
    expect(testWaveReading(shot, 'shooter', 10)).toMatchObject({
      leaks: 1,
      contact: 4,
      bullet: 5,
    });
    const missed = result({ damageTakenBy, bulletTakenBy: takenBy({}) });
    expect(testWaveReading(missed, 'shooter', 10).bullet).toBe(0);
  });

  it("counts a pentagon's shards in its column and the rotation's boss in the Boss column", () => {
    const damageTakenBy = takenBy({
      pentagon: tally(2, 3),
      shard: tally(4, 5),
      onion: tally(1, 9),
    });
    expect(testWaveReading(result({ damageTakenBy }), 'pentagon', 10)).toMatchObject({
      leaks: 6,
      contact: 8,
    });
    expect(testWaveReading(result({ damageTakenBy }), 'boss', 1)).toMatchObject({
      count: 1,
      leaks: 1,
      contact: 9,
    });
  });

  it('reads an uncleared wave at ENEMY_ROW_MAX_SECONDS, flagged, whatever its ticks', () => {
    const died = result({
      highestWaveCleared: ENEMY_ROW_WAVE - 1,
      ticks: 1_200,
      endReason: 'death',
    });
    expect(testWaveReading(died, 'square', 10)).toMatchObject({
      clearSeconds: ENEMY_ROW_MAX_SECONDS,
      cleared: false,
      died: true,
    });
    const cut = result({
      highestWaveCleared: ENEMY_ROW_WAVE - 1,
      ticks: 3_600,
      endReason: 'timeout',
    });
    expect(testWaveReading(cut, 'square', 10)).toMatchObject({
      clearSeconds: ENEMY_ROW_MAX_SECONDS,
      cleared: false,
      died: false,
    });
  });

  it('reads an escaped treasure as neither a leak nor a failed clear (C7D §3.2)', () => {
    // Seven killed, three gone off the field: no hit, and the wave cleared.
    const fled = result({ damageTakenBy: takenBy({}), kills: 7, leaks: 0, ticks: 900 });
    expect(testWaveReading(fled, 'treasure', 10)).toMatchObject({
      clearSeconds: 15,
      cleared: true,
      leaks: 0,
      contact: 0,
    });
  });
});

describe('test wave runs', () => {
  const web = webOf({ fixture: 'B1' }, 'fire', 'full');
  const progress = auditStart(web, false);

  it("plays the type's wave alone from ENEMY_ROW_WAVE to its clear, the same on the same seed", () => {
    const spawned: [EnemyId, number][] = [];
    const data = testWaveData(base, 'triangle');
    const reading = testWaveRun(web, progress, data, rowSeed('triangle', 0), (enemy) =>
      spawned.push([enemy.type, enemy.wave]),
    );
    expect(spawned).toEqual(Array.from({ length: 10 }, () => ['triangle', ENEMY_ROW_WAVE]));
    expect(reading).toMatchObject({ cleared: true, count: 10 });
    expect(reading.clearSeconds).toBeLessThan(ENEMY_ROW_MAX_SECONDS);
    expect(testWaveRun(web, progress, data, rowSeed('triangle', 0))).toEqual(reading);
  });

  it('plays the Boss row on the rotation boss alone', () => {
    const spawned: EnemyId[] = [];
    const reading = testWaveRun(
      web,
      progress,
      testWaveData(base, 'boss'),
      rowSeed('boss', 0),
      (enemy) => spawned.push(enemy.type),
    );
    expect(spawned).toEqual(['onion']);
    // At auditStart the onion reaches the player: its hit and damage are the Boss column's.
    expect(reading).toMatchObject({ count: 1, leaks: 1 });
    expect(reading.contact).toBeGreaterThan(0);
  });

  it("reads an elite wave's elite in the elite column", () => {
    const reading = testWaveRun(web, progress, eliteWaveData(base, false), rowSeed('hexagon', 0));
    // At auditStart the elite reaches the player: its hit and damage are the elite column's.
    expect(reading).toMatchObject({ count: 1, leaks: 1 });
    expect(reading.contact).toBeGreaterThan(0);
  });

  it('cuts a wave nothing clears at ENEMY_ROW_MAX_SECONDS, before a later hit', () => {
    // Triangles no hit kills, slow enough to reach the player only after the cut (67 s on).
    const slow = parseGameData({
      ...base,
      enemies: { ...base.enemies, triangle: { ...base.enemies.triangle, hpMult: 1e9, speed: 8 } },
    });
    const data = testWaveData(slow, 'triangle');
    expect(testWaveRun(web, progress, data, rowSeed('triangle', 0))).toEqual({
      clearSeconds: ENEMY_ROW_MAX_SECONDS,
      cleared: false,
      died: false,
      count: ENEMY_ROW_COUNT,
      leaks: 0,
      kills: 0,
      contact: 0,
      bullet: 0,
    });
  });

  it('refuses a table whose test wave holds more than one type', () => {
    expect(() => testWaveRun(web, progress, base, 1)).toThrow(
      /A test wave holds one type; wave 20 holds .*, onion/,
    );
  });
});
