import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { DAMAGE_TAG_BIT } from '../data/stats';
import { DEFAULT_ECONOMY, allowedStartWave, createMetaState } from '../meta';
import { MAX_RUN_SECONDS, TICK_RATE } from '../sim';
import { RESULT_SCREEN_MS, Session } from './session';
import type { ActiveRun, RunReport } from './session';

function createSession() {
  const started: ActiveRun[] = [];
  const finished: RunReport[] = [];
  const meta = createMetaState();
  const session = new Session(loadGameData(), meta, {
    runStarted: (run) => started.push(run),
    runFinished: (report) => finished.push(report),
  });
  return { session, meta, started, finished };
}

/** Steps until the run ends; a run can never outlast its tick cap. */
function playRun(session: Session): number {
  let ticks = 0;
  while (session.phase === 'running') {
    session.step();
    ticks++;
    if (ticks > MAX_RUN_SECONDS * TICK_RATE) throw new Error('run did not end');
  }
  return ticks;
}

describe('Session', () => {
  it('starts the first run from wave 1 with a run-counter seed', () => {
    const { session, started } = createSession();
    expect(session.phase).toBe('idle');
    session.start();
    expect(session.phase).toBe('running');
    expect(started).toHaveLength(1);
    const run = session.run;
    expect(run.number).toBe(1);
    expect(run.config.seed).toBe(1000);
    expect(run.config.startWave).toBe(1);
    expect(run.config.mode).toBe('auto');
    const { values, damageMult } = run.config.stats;
    expect(run.typicalHit).toBe(values.damage * (damageMult[DAMAGE_TAG_BIT.hit] as number));
    expect(() => session.start()).toThrow();
  });

  it('settles a finished run, auto-buys talents and shows the result', () => {
    const { session, meta, finished } = createSession();
    session.start();
    const ticks = playRun(session);
    expect(session.phase).toBe('results');
    expect(finished).toHaveLength(1);
    const report = finished[0] as RunReport;
    expect(report.result.ticks).toBe(ticks);
    expect(meta.runs).toBe(1);
    expect(meta.maxWave).toBe(report.result.highestWaveReached);
    for (const purchase of report.purchases) expect(meta.allocated.has(purchase.id)).toBe(true);
    expect(report.bankShards).toBe(meta.shards);
    expect(session.resultTimeLeftMs).toBe(RESULT_SCREEN_MS);
    expect(() => session.step()).toThrow();
  });

  it('starts the next run after the result screen with the next seed and start wave', () => {
    const { session, meta, started } = createSession();
    session.start();
    playRun(session);
    session.update(RESULT_SCREEN_MS - 1);
    expect(session.phase).toBe('results');
    session.update(1);
    expect(session.phase).toBe('running');
    expect(started).toHaveLength(2);
    expect(session.run.number).toBe(2);
    expect(session.run.config.seed).toBe(1001);
    expect(session.run.config.startWave).toBe(allowedStartWave(meta, DEFAULT_ECONOMY));
  });

  it('skips the result screen on request', () => {
    const { session, started } = createSession();
    session.start();
    session.skipResults();
    expect(started).toHaveLength(1);
    playRun(session);
    session.skipResults();
    expect(session.phase).toBe('running');
    expect(started).toHaveLength(2);
  });
});
