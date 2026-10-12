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
    giveMight(meta, mightRanksFor(meta, 12));
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

/** Sets the rank of the repeatable damage node directly, as a loaded profile would. */
function giveMight(meta: MetaState, ranks: number): void {
  meta.allocated.add('might');
  meta.ranks.set('might', ranks);
}

/**
 * The fewest Might ranks on top of `meta`'s talents whose estimated frontier reaches `wave`.
 * Searched rather than hard-coded, so the tests survive retuning of the curve and of Might.
 */
function mightRanksFor(meta: MetaState, wave: number): number {
  const data = loadGameData();
  for (let ranks = 0; ranks <= 1000; ranks++) {
    const trial = cloneMeta(meta);
    giveMight(trial, ranks);
    if (estimateBuild(trial, data, DEFAULT_ECONOMY).frontier >= wave) return ranks;
  }
  throw new Error(`Might cannot reach wave ${wave}`);
}

/** A copy of the talent state, for trying allocations without touching the session's meta. */
function cloneMeta(meta: MetaState): MetaState {
  return {
    ...meta,
    allocated: new Set(meta.allocated),
    ranks: new Map(meta.ranks),
  };
}

/**
 * A session between runs with a long-played profile: allowed start wave 12, plenty to spend,
 * and, when `strong`, enough Might ranks for a build that reached wave 24.
 */
function veteranSession(strong = true) {
  const created = createSession({ waveCap: 40 });
  const { session, meta } = created;
  meta.runs = 20;
  meta.maxWave = 24;
  meta.shards = num(1e100);
  meta.cores = 1000;
  if (strong) giveMight(meta, mightRanksFor(meta, 24));
  session.resume();
  return created;
}

function buyMight(session: Session, ranks: number): void {
  for (let i = 0; i < ranks; i++) expect(session.allocate('might')).toBe(true);
}

describe('Session start wave', () => {
  it('follows the highest allowed wave while the build keeps up', () => {
    const { session } = veteranSession();
    expect(session.maxStartWave).toBe(12);
    expect(session.estimate.frontier).toBeGreaterThanOrEqual(12);
    expect(session.startWave).toBe(12);
    buyMight(session, 5);
    expect(session.startWave).toBe(12);
  });

  it('drops on load when the build is not expected to reach the start wave', () => {
    const { session } = veteranSession(false);
    expect(session.estimate.frontier).toBeLessThan(12);
    expect(session.startWave).toBe(session.estimate.startWave);
  });

  it('drops to the estimate after a respec and climbs back as the build is rebought', () => {
    const { session, meta } = veteranSession();
    session.refund();
    const empty = estimateBuild(meta, loadGameData(), DEFAULT_ECONOMY);
    expect(empty.frontier).toBeLessThan(12);
    expect(session.startWave).toBe(empty.startWave);

    let previous = session.startWave;
    while (session.startWave < 12) {
      buyMight(session, 1);
      expect(session.startWave).toBe(Math.min(12, session.estimate.startWave));
      expect(session.startWave).toBeGreaterThanOrEqual(previous);
      previous = session.startWave;
      expect(meta.ranks.get('might')).toBeLessThan(1000);
    }
    // Back at the highest allowed wave, it follows that wave upward again.
    meta.maxWave = 30;
    expect(session.startWave).toBe(15);
  });

  it('keeps a start wave the player picked unless the build stops reaching it', () => {
    const { session } = veteranSession();
    session.setStartWave(3);
    buyMight(session, 10);
    expect(session.startWave).toBe(3);
    session.setStartWave(10);
    session.refund();
    expect(session.startWave).toBe(session.estimate.startWave);
    expect(session.startWave).toBeLessThan(10);
    // Picked past the estimated frontier on purpose: buying talents does not undo it.
    session.setStartWave(12);
    expect(session.estimate.frontier).toBeLessThan(12);
    buyMight(session, 3);
    expect(session.startWave).toBe(12);
  });

  it('drops when a keystone with a damage cost puts the start wave past the estimate', () => {
    const { session, meta } = veteranSession(false);
    const data = loadGameData();
    for (const id of ['kindling', 'fuel', 'slowBurn', 'inferno', 'stoke', 'heat']) {
      expect(session.allocate(id)).toBe(true);
    }
    // Find a Might rank where Pandemic's hit damage cost lowers the estimated frontier.
    const withPandemic = (ranks: number) => {
      const trial = cloneMeta(meta);
      giveMight(trial, ranks);
      const before = estimateBuild(trial, data, DEFAULT_ECONOMY);
      trial.allocated.add('pandemic');
      return { before, after: estimateBuild(trial, data, DEFAULT_ECONOMY) };
    };
    let rank = 0;
    while (rank < 200) {
      const { before, after } = withPandemic(rank);
      if (after.frontier < before.frontier && before.frontier <= 12) break;
      rank++;
    }
    const { before, after } = withPandemic(rank);
    expect(after.frontier).toBeLessThan(before.frontier);
    giveMight(meta, rank);
    session.setStartWave(before.frontier);
    expect(session.startWave).toBe(before.frontier);
    expect(session.allocate('pandemic')).toBe(true);
    expect(session.startWave).toBe(after.startWave);
  });

  it('steps down after a run that does not clear it and climbs back once runs clear it', () => {
    const { session, meta } = veteranSession();
    expect(session.startWave).toBe(12);
    // The build is far weaker than the session assumes, as when the estimate is too kind.
    giveMight(meta, 0);
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
    giveMight(meta, mightRanksFor(meta, 34));
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

  it('keeps the step down after a failed run when the estimate stays too kind', () => {
    const { session, meta } = veteranSession();
    const strong = meta.ranks.get('might') as number;
    // The build is far weaker than the estimate says and fails its start wave.
    giveMight(meta, 0);
    session.startNextRun();
    playRun(session);
    expect((session.report as RunReport).result.clearedStartWave).toBe(false);
    const lowered = session.startWave;
    expect(lowered).toBeLessThan(session.maxStartWave);

    // The estimate goes back to calling the highest allowed wave safe, as it does for burn
    // builds; buying talents only climbs as far as the estimate gains.
    giveMight(meta, strong);
    const before = session.estimate;
    expect(before.startWave).toBeGreaterThanOrEqual(session.maxStartWave);
    session.openTalents();
    let guard = 0;
    while (session.estimate.startWave === before.startWave) {
      buyMight(session, 1);
      if (++guard > 100) throw new Error('the estimated start wave never went up');
    }
    const gained = session.estimate.startWave - before.startWave;
    expect(lowered + gained).toBeLessThan(session.maxStartWave);
    expect(session.startWave).toBe(lowered + gained);
  });
});
