import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { DAMAGE_TAG_BIT } from '../data/stats';
import { num } from '../core/num';
import { DEFAULT_ECONOMY, allowedStartWave, createMetaState } from '../meta';
import { MAX_RUN_SECONDS, TICK_RATE } from '../sim';
import { RESULT_SCREEN_MS, Session } from './session';
import type { ActiveRun, RunReport, SessionOptions } from './session';

function createSession(options: SessionOptions = {}) {
  const started: ActiveRun[] = [];
  const finished: RunReport[] = [];
  let opened = 0;
  let changed = 0;
  const meta = createMetaState();
  const session = new Session(
    loadGameData(),
    meta,
    {
      runStarted: (run) => started.push(run),
      runFinished: (report) => finished.push(report),
      talentsOpened: () => opened++,
      profileChanged: () => changed++,
    },
    options,
  );
  return {
    session,
    meta,
    started,
    finished,
    opened: () => opened,
    changed: () => changed,
  };
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

  it('settles a finished run, saves and shows the result', () => {
    const { session, meta, finished, changed } = createSession();
    session.start();
    const ticks = playRun(session);
    expect(session.phase).toBe('results');
    expect(finished).toHaveLength(1);
    const report = finished[0] as RunReport;
    expect(report.result.ticks).toBe(ticks);
    expect(meta.runs).toBe(1);
    expect(meta.maxWave).toBe(report.result.highestWaveReached);
    expect(meta.allocated.size).toBe(0);
    expect(report.bankShards).toBe(meta.shards);
    expect(report.affordable).toBe(session.canAffordAny());
    expect(changed()).toBe(1);
    expect(() => session.step()).toThrow();
  });

  it('counts down to the next run when nothing is affordable', () => {
    const { session, meta, started } = createSession();
    session.start();
    playRun(session);
    meta.shards = num(0);
    // Re-evaluate affordability as the report would after a poor run.
    (session.report as { affordable: boolean }).affordable = false;
    expect(session.resultTimeLeftMs).toBe(RESULT_SCREEN_MS);
    session.update(RESULT_SCREEN_MS - 1);
    expect(session.phase).toBe('results');
    session.update(1);
    expect(session.phase).toBe('running');
    expect(started).toHaveLength(2);
    expect(session.run.number).toBe(2);
    expect(session.run.config.seed).toBe(1001);
    expect(session.run.config.startWave).toBe(allowedStartWave(meta, DEFAULT_ECONOMY));
  });

  it('waits on the result screen and leads to the talent web when something is affordable', () => {
    const { session, opened } = createSession();
    session.start();
    playRun(session);
    expect(session.report?.affordable).toBe(true);
    expect(session.resultTimeLeftMs).toBe(0);
    session.update(RESULT_SCREEN_MS * 10);
    expect(session.phase).toBe('results');
    session.continueFromResults();
    expect(session.phase).toBe('talents');
    expect(opened()).toBe(1);
  });

  it('allocates and refunds only on the talent web', () => {
    const { session, meta, changed } = createSession();
    session.start();
    expect(session.allocate('keenEye')).toBe(false);
    playRun(session);
    session.openTalents();
    const before = changed();
    expect(session.allocate('arcStorm')).toBe(false);
    expect(session.allocate('keenEye')).toBe(true);
    expect(meta.allocated.has('keenEye')).toBe(true);
    session.refund();
    expect(meta.allocated.size).toBe(0);
    expect(changed()).toBe(before + 2);
    session.startNextRun();
    expect(session.phase).toBe('running');
  });

  it('lets the player pick a lower start wave and caps runs at the wave cap', () => {
    const { session, meta } = createSession({ waveCap: 40 });
    session.start();
    playRun(session);
    meta.maxWave = 30;
    expect(session.maxStartWave).toBe(15);
    session.setStartWave(4);
    expect(session.startWave).toBe(4);
    session.startNextRun();
    expect(session.run.config.startWave).toBe(4);
    expect(session.run.config.waveCap).toBe(40);
    playRun(session);
    meta.maxWave = 200;
    session.setStartWave(1000);
    expect(session.startWave).toBe(40);
  });
});
