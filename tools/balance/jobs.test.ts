import { describe, expect, it } from 'vitest';
import { DEFAULT_ECONOMY } from '../../src/meta';
import { DEFAULT_WEB_ECONOMY } from '../../src/meta/web';
import { jobOf, runJob, runJobs } from './jobs';
import { runSessions } from './pool';
import type { SessionConfig, SessionResult } from './session';
import type { CharacterSessionConfig } from './v3/session';

const m1 = (strategy: SessionConfig['strategy'], session: number): SessionConfig => ({
  strategy,
  session,
  seed: 1,
  minutes: 10,
  startWave: { kind: 'max' },
  economy: DEFAULT_ECONOMY,
  menuSeconds: 20,
  waveCap: null,
});

const character: CharacterSessionConfig = {
  character: 'fire',
  strategy: 'cheapest',
  session: 0,
  seed: 1,
  minutes: 1,
  startWave: { kind: 'max' },
  economy: DEFAULT_WEB_ECONOMY,
  menuSeconds: 20,
  content: { fixture: 'B5' },
  scope: 'full',
};

/** Each run's maxWave and purchases, as `maxWave:bought`. */
const trace = (result: SessionResult): string =>
  result.rows.map((row) => `${row.maxWave}:${row.bought}`).join(' ');

describe('balance jobs', () => {
  it('runs M1 sessions through the pool as at the parent commit, in job order', async () => {
    // Recorded with the parent's runSessions (tools/balance/pool.ts before character jobs).
    const configs = [m1('crit-greedy', 0), m1('chain-greedy', 1)];
    const pool = await runSessions(configs, 2);
    expect(pool.mode).toBe('workers');
    expect(pool.results.map((result) => [result.strategy, result.session, trace(result)])).toEqual([
      [
        'crit-greedy',
        0,
        '7:keenEye 9:sharpen 9:quickDraw 10: 10:precision 10:deadlyAim 10:splitShot 14:assassin 14:',
      ],
      [
        'chain-greedy',
        1,
        '8:spark 9:conductor 10:charge 10:arcStorm 12:reach 13:fork voltage 14: 15:tempest 15:',
      ],
    ]);
    const jobs = await runJobs(configs.map(jobOf), 2);
    expect(jobs.results).toEqual(pool.results.map((result) => ({ kind: 'm1', result })));
  }, 30_000);

  it('dispatches on the kind, an M1 config having no character', () => {
    expect(jobOf(m1('cheapest', 0)).kind).toBe('m1');
    expect(jobOf(character).kind).toBe('character');
    const result = runJob({ kind: 'character', config: character });
    expect(result.kind).toBe('character');
    expect(result.result).toMatchObject({ character: 'fire', strategy: 'cheapest', session: 0 });
  });

  it('keeps job order across kinds on two workers', async () => {
    // The first job is the longest, so the other two finish before it.
    const jobs = [
      jobOf({ ...character, minutes: 20 }),
      jobOf({ ...m1('balanced', 0), minutes: 0.5 }),
      jobOf(character),
    ];
    const pool = await runJobs(jobs, 2);
    expect(pool.mode).toBe('workers');
    expect(pool.results.map((result) => result.kind)).toEqual(['character', 'm1', 'character']);
    expect(pool.results).toEqual(jobs.map(runJob));
  }, 30_000);
});
