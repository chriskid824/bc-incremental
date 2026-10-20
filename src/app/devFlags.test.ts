import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../core/num';
import { loadGameData } from '../data';
import { createMetaState } from '../meta';
import { MemorySaveStorage } from '../platform/storage';
import {
  HIVE_SAVE_PREFIX,
  HIVE_SIGNATURE,
  raiseShards,
  readDevFlags,
  resumeAtWave,
  seedEmptySlots,
  startAtWave,
} from './devFlags';
import { Session } from './session';
import type { SessionOptions } from './session';

const data = loadGameData();
const WAVE_CAP = 40;
const NONE = { hive: false, wave: null, shards: null };

const flags = (search: string) => readDevFlags(search, WAVE_CAP);

/** Not a whole number: each is ignored in &wave= and &shards=. */
const JUNK = ['', 'abc', '3.5', '1e3', '30abc', ' 30', '0x10', '+30', 'Infinity', 'NaN'];

describe('readDevFlags', () => {
  it('reads nothing without ?hive, whatever else the query holds', () => {
    expect(flags('')).toEqual(NONE);
    expect(flags('?lang=zh-TW')).toEqual(NONE);
    expect(flags('?wave=30&shards=500')).toEqual(NONE);
    expect(flags('?hives&wave=30')).toEqual(NONE);
  });

  it('turns the prototype on with ?hive, with or without a value', () => {
    for (const search of ['?hive', 'hive', '?hive=1', '?hive=', '?lang=zh-TW&hive']) {
      expect(flags(search), search).toEqual({ hive: true, wave: null, shards: null });
    }
    expect(flags('?hive&wave=30&shards=500')).toEqual({ hive: true, wave: 30, shards: 500 });
  });

  it('clamps &wave= to 1 .. the wave cap', () => {
    const wave = (value: string): number | null => flags(`?hive&wave=${value}`).wave;
    expect(wave('1')).toBe(1);
    expect(wave('30')).toBe(30);
    expect(wave('40')).toBe(40);
    expect(wave('41')).toBe(WAVE_CAP);
    expect(wave('999999999999')).toBe(WAVE_CAP);
    expect(wave('0')).toBe(1);
    expect(wave('-5')).toBe(1);
    expect(readDevFlags('?hive&wave=30', 20).wave).toBe(20);
  });

  it('takes &shards= as a whole number of at least 0', () => {
    const shards = (value: string): number | null => flags(`?hive&shards=${value}`).shards;
    expect(shards('0')).toBe(0);
    expect(shards('500')).toBe(500);
    expect(shards('123456789012')).toBe(123456789012);
    expect(shards('-3')).toBeNull();
  });

  it('ignores junk in &wave= and &shards=', () => {
    for (const junk of JUNK) {
      const query = encodeURIComponent(junk);
      const read = flags(`?hive&wave=${query}&shards=${query}`);
      expect(read, JSON.stringify(junk)).toEqual({ hive: true, wave: null, shards: null });
    }
    // Digits too long for a number are not a whole number either.
    expect(flags(`?hive&shards=${'9'.repeat(400)}`).shards).toBeNull();
  });
});

describe('the ?hive profile', () => {
  it('keeps its saves under its own prefix and plays the swarm', () => {
    expect(HIVE_SAVE_PREFIX).toBe('bc-incremental.hive.save.');
    expect(HIVE_SIGNATURE).toEqual({ id: 'swarm' });
  });

  it('writes the preset into empty hive slots only', () => {
    const empty = new MemorySaveStorage();
    expect(seedEmptySlots(empty, 'preset')).toBe(true);
    expect(empty.read('main')).toBe('preset');
    expect(empty.read('backup')).toBeNull();
    // Progress made since stays.
    empty.write('main', 'progress');
    expect(seedEmptySlots(empty, 'preset')).toBe(false);
    expect(empty.read('main')).toBe('progress');
    // A backup alone is a save too (the main slot may have been unreadable).
    const backupOnly = new MemorySaveStorage();
    backupOnly.write('backup', 'older');
    expect(seedEmptySlots(backupOnly, 'preset')).toBe(false);
    expect(backupOnly.read('main')).toBeNull();
    expect(backupOnly.read('backup')).toBe('older');
  });

  it('raises the shards to at least &shards=N, so a reload does not add them again', () => {
    const meta = createMetaState();
    meta.shards = num(100);
    raiseShards(meta, null);
    expect(toNumber(meta.shards)).toBe(100);
    raiseShards(meta, 500);
    expect(toNumber(meta.shards)).toBe(500);
    raiseShards(meta, 500);
    expect(toNumber(meta.shards)).toBe(500);
    meta.shards = num(1e30);
    raiseShards(meta, 500);
    expect(toNumber(meta.shards)).toBe(1e30);
  });
});

/** A returning profile (allowed start 12) whose talents clear wave 18, by a stand-in reach. */
function returningSession(options: SessionOptions = {}) {
  const meta = createMetaState();
  meta.runs = 20;
  meta.maxWave = 24;
  const session = new Session(
    data,
    meta,
    {
      runStarted: () => undefined,
      runFinished: () => undefined,
      talentsOpened: () => undefined,
      profileChanged: () => undefined,
    },
    { waveCap: WAVE_CAP, minStartWave: 30, reach: () => 18, ...options },
  );
  return session;
}

describe('&wave=N', () => {
  it('opens a returning profile on the talent web, then picks N', () => {
    const calls: unknown[] = [];
    resumeAtWave({ resume: () => calls.push('resume') }, 30, (wave) => calls.push(wave));
    expect(calls).toEqual(['resume', 30]);
    calls.length = 0;
    resumeAtWave({ resume: () => calls.push('resume') }, null, (wave) => calls.push(wave));
    expect(calls).toEqual(['resume']);
  });

  it('starts the next run at N above the reach: resume() aims first, the pick then stands', () => {
    const picked = returningSession();
    resumeAtWave(picked, 30, (wave) => picked.setStartWave(wave));
    picked.startNextRun();
    expect(picked.run.config.startWave).toBe(30);
    // resume() alone lowers it to the reach.
    const resumed = returningSession();
    resumeAtWave(resumed, null, (wave) => resumed.setStartWave(wave));
    resumed.startNextRun();
    expect(resumed.run.config.startWave).toBe(18);
  });

  it("picks N before a fresh profile's first run, which would otherwise aim at the reach", () => {
    const fresh = (wave: number | null) => {
      const meta = createMetaState();
      const session = new Session(
        data,
        meta,
        {
          runStarted: () => undefined,
          runFinished: () => undefined,
          talentsOpened: () => undefined,
          profileChanged: () => undefined,
        },
        { waveCap: WAVE_CAP, minStartWave: 30, reach: () => 4 },
      );
      startAtWave(session, wave);
      return session.run.config.startWave;
    };
    expect(fresh(30)).toBe(30);
    expect(fresh(null)).toBe(4);
    const calls: unknown[] = [];
    startAtWave({ setStartWave: (wave) => calls.push(wave), start: () => calls.push('start') }, 30);
    expect(calls).toEqual([30, 'start']);
  });
});
