import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { DAMAGE_TAG_BIT } from '../data/stats';
import { num } from '../core/num';
import { DEFAULT_ECONOMY, allowedStartWave, createMetaState, estimateBuild } from '../meta';
import type { MetaState } from '../meta';
import { MAX_RUN_SECONDS, TICK_RATE } from '../sim';
import { FAILED_START_RATIO, RESULT_SCREEN_MS, Session } from './session';
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

  it('opens on the talent web for a returning profile and starts runs from there', () => {
    const { session, meta, started, opened } = createSession();
    meta.runs = 7;
    meta.maxWave = 12;
    session.resume();
    expect(session.phase).toBe('talents');
    expect(opened()).toBe(1);
    expect(started).toHaveLength(0);
    expect(session.currentRun).toBeNull();
    expect(() => session.start()).toThrow();
    session.startNextRun();
    expect(session.phase).toBe('running');
    expect(session.run.number).toBe(8);
    expect(session.run.config.startWave).toBe(6);
    expect(session.currentRun).toBe(session.run);
  });

  it('opens the talent web when a run ends if T was pressed during it', () => {
    const { session, finished, opened } = createSession();
    expect(session.queueTalents()).toBe(false);
    session.start();
    expect(session.queueTalents()).toBe(true);
    expect(session.talentsQueued).toBe(true);
    playRun(session);
    expect(finished).toHaveLength(1);
    expect(session.phase).toBe('talents');
    expect(opened()).toBe(1);
    expect(session.talentsQueued).toBe(false);
    expect(session.resultTimeLeftMs).toBe(0);
    expect(session.queueTalents()).toBe(false);
    session.startNextRun();
    playRun(session);
    expect(session.phase).toBe('results');
  });
});

/** A session between runs with a long-played profile: allowed start wave 12, plenty to spend. */
function veteranSession() {
  const created = createSession({ waveCap: 40 });
  const { session, meta } = created;
  meta.runs = 20;
  meta.maxWave = 24;
  meta.shards = num(1e12);
  meta.cores = 1000;
  session.resume();
  return created;
}

function buyMight(session: Session, ranks: number): void {
  for (let i = 0; i < ranks; i++) expect(session.allocate('might')).toBe(true);
}

/** A copy of the talent state, for trying allocations without touching the session's meta. */
function cloneMeta(meta: MetaState): MetaState {
  return {
    ...meta,
    allocated: new Set(meta.allocated),
    ranks: new Map(meta.ranks),
  };
}

describe('Session start wave', () => {
  it('follows the highest allowed wave while the build keeps up', () => {
    const { session } = veteranSession();
    expect(session.maxStartWave).toBe(12);
    expect(session.startWave).toBe(12);
    buyMight(session, 5);
    expect(session.startWave).toBe(12);
  });

  it('drops to the estimate after a respec and climbs back as the build is rebought', () => {
    const { session, meta } = veteranSession();
    buyMight(session, 70);
    expect(session.estimate.startWave).toBeGreaterThanOrEqual(12);
    expect(session.startWave).toBe(12);

    session.refund();
    const empty = estimateBuild(meta, loadGameData(), DEFAULT_ECONOMY);
    expect(session.startWave).toBe(empty.startWave);
    expect(session.startWave).toBeLessThan(12);

    let previous = session.startWave;
    for (let rank = 1; rank <= 70; rank++) {
      buyMight(session, 1);
      expect(session.startWave).toBe(Math.min(12, session.estimate.startWave));
      expect(session.startWave).toBeGreaterThanOrEqual(previous);
      previous = session.startWave;
    }
    expect(session.startWave).toBe(12);
    // Back at the highest allowed wave, it follows that wave upward again.
    meta.maxWave = 30;
    expect(session.startWave).toBe(15);
  });

  it('keeps a start wave the player picked unless the build gets weaker than it', () => {
    const { session } = veteranSession();
    session.setStartWave(3);
    buyMight(session, 70);
    expect(session.startWave).toBe(3);
    session.setStartWave(10);
    session.refund();
    expect(session.startWave).toBe(session.estimate.startWave);
    expect(session.startWave).toBeLessThan(10);
  });

  it('drops when a keystone with a damage cost lowers the estimate below it', () => {
    const { session, meta } = veteranSession();
    const data = loadGameData();
    for (const id of ['kindling', 'fuel', 'slowBurn', 'inferno', 'stoke', 'heat']) {
      expect(session.allocate(id)).toBe(true);
    }
    // Find a Might rank where Pandemic's hit damage cost moves the estimate down a start wave.
    let rank = 0;
    const withPandemic = (ranks: number) => {
      const trial = cloneMeta(meta);
      trial.ranks.set('might', ranks);
      trial.allocated.add('might');
      const before = estimateBuild(trial, data, DEFAULT_ECONOMY).startWave;
      trial.allocated.add('pandemic');
      return { before, after: estimateBuild(trial, data, DEFAULT_ECONOMY).startWave };
    };
    while (rank < 200) {
      const { before, after } = withPandemic(rank);
      if (after < before && before <= 12) break;
      rank++;
    }
    const { before, after } = withPandemic(rank);
    expect(after).toBeLessThan(before);
    buyMight(session, rank);
    session.setStartWave(before);
    expect(session.startWave).toBe(before);
    expect(session.allocate('pandemic')).toBe(true);
    expect(session.startWave).toBe(after);
  });

  it('steps down after a run that does not clear it and climbs back once runs clear it', () => {
    const { session, meta } = veteranSession();
    session.startNextRun();
    expect(session.run.config.startWave).toBe(12);
    playRun(session);
    const failed = session.report as RunReport;
    expect(failed.result.clearedStartWave).toBe(false);
    const lowered = Math.min(11, Math.floor(failed.result.highestWaveReached * FAILED_START_RATIO));
    expect(session.startWave).toBe(Math.max(1, lowered));

    // Keep failing until a start wave is cleared; each failure lowers it.
    let guard = 0;
    while (!(session.report as RunReport).result.clearedStartWave) {
      const before = session.startWave;
      session.startNextRun();
      playRun(session);
      if (!(session.report as RunReport).result.clearedStartWave) {
        expect(session.startWave).toBeLessThan(Math.max(2, before));
      }
      if (++guard > 20) throw new Error('never cleared a start wave');
    }

    // A much stronger build clears its start wave and the start wave climbs back.
    meta.allocated.add('might');
    meta.ranks.set('might', 80);
    const low = session.startWave;
    session.startNextRun();
    playRun(session);
    const cleared = session.report as RunReport;
    expect(cleared.result.clearedStartWave).toBe(true);
    const reached = cleared.result.highestWaveReached;
    const climbed = Math.floor(reached * DEFAULT_ECONOMY.startWaveRatio);
    expect(climbed).toBeGreaterThan(low);
    expect(session.startWave).toBe(Math.min(session.maxStartWave, climbed));
  });
});
