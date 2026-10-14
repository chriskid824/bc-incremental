import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { TAG } from '../data/tags';
import { num, toNumber } from '../core/num';
import {
  DEFAULT_ECONOMY,
  PROBE_SEEDS,
  allowedStartWave,
  clearsStartWave,
  collectRules,
  createMetaState,
  highestClearedStartWave,
  probeConfig,
  statBlockFor,
} from '../meta';
import type { MetaState } from '../meta';
import { MAX_RUN_SECONDS, TICK_RATE } from '../sim';
import { damageRow } from '../sim/testing';
import {
  FAILED_START_RATIO,
  RESULT_FRAME_MAX_MS,
  RESULT_SCREEN_MS,
  Session,
  leadsToTalents,
} from './session';
import type { ActiveRun, RunReport, SessionOptions } from './session';

const data = loadGameData();

/** The wave cap of the browser build's sessions in these tests. */
const WAVE_CAP = 40;

function createSession(options: SessionOptions = {}) {
  const started: ActiveRun[] = [];
  const finished: RunReport[] = [];
  let opened = 0;
  let changed = 0;
  const meta = createMetaState();
  const session = new Session(
    data,
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

/** Makes the report look like a poor run's, with nothing affordable. */
function nothingAffordable(session: Session, meta: MetaState): void {
  meta.shards = num(0);
  (session.report as { affordable: boolean }).affordable = false;
}

/** Frames of 20 ms, well under RESULT_FRAME_MAX_MS. */
function waitMs(session: Session, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) session.update(20);
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
    const { stats, rules } = run.config;
    expect(run.typicalHit).toBe(stats.values.damage * damageRow(stats, TAG.hit, rules));
    expect(() => session.start()).toThrow();
  });

  it('scales damage numbers by the hit row, Searing Crits and Glass Cannon included', () => {
    const { session, meta } = createSession();
    meta.allocated.add('searingCrits');
    meta.allocated.add('glassCannon');
    session.start();
    const { stats, rules } = session.run.config;
    const hit = TAG.hit;
    // Searing Crits halves non-crit hits; Glass Cannon is a rule whose ×2 reaches every row.
    expect(damageRow(stats, hit)).toBe(0.5);
    expect(damageRow(stats, hit, rules)).toBe(0.5 * 2);
    expect(session.run.typicalHit).toBe(stats.values.damage * damageRow(stats, hit, rules));
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
    expect(report.talentsQueued).toBe(false);
    expect(report.nextStartWave).toBe(session.startWave);
    expect(changed()).toBe(1);
    expect(() => session.step()).toThrow();
  });

  it('counts down to the next run when nothing is affordable', () => {
    const { session, meta, started } = createSession();
    session.start();
    playRun(session);
    nothingAffordable(session, meta);
    expect(session.report !== null && leadsToTalents(session.report)).toBe(false);
    expect(session.resultTimeLeftMs).toBe(RESULT_SCREEN_MS);
    waitMs(session, RESULT_SCREEN_MS - 20);
    expect(session.phase).toBe('results');
    expect(session.resultTimeLeftMs).toBe(20);
    session.update(20);
    expect(session.phase).toBe('running');
    expect(started).toHaveLength(2);
    expect(session.run.number).toBe(2);
    expect(session.run.config.seed).toBe(1001);
    // The highest allowed wave, unless the build does not clear it.
    const allowed = allowedStartWave(meta, DEFAULT_ECONOMY);
    expect(session.run.config.startWave).toBe(highestClearedStartWave(meta, data, allowed));
  });

  it('holds the countdown while paused and never skips it in one long frame', () => {
    const { session, meta } = createSession();
    session.start();
    playRun(session);
    nothingAffordable(session, meta);
    // The first frame after a hidden tab spans all the time it was hidden.
    session.update(60_000);
    expect(session.phase).toBe('results');
    expect(session.resultTimeLeftMs).toBe(RESULT_SCREEN_MS - RESULT_FRAME_MAX_MS);
    for (let i = 0; i < 1000; i++) session.update(16, true);
    expect(session.resultTimeLeftMs).toBe(RESULT_SCREEN_MS - RESULT_FRAME_MAX_MS);
    waitMs(session, RESULT_SCREEN_MS);
    expect(session.phase).toBe('running');
  });

  it('waits on the result screen and leads to the talent web when something is affordable', () => {
    const { session, opened } = createSession();
    session.start();
    playRun(session);
    expect(session.report?.affordable).toBe(true);
    expect(session.resultTimeLeftMs).toBe(0);
    waitMs(session, RESULT_SCREEN_MS * 2);
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
    const { session, meta } = createSession({ waveCap: WAVE_CAP });
    session.start();
    playRun(session);
    meta.maxWave = 30;
    expect(session.maxStartWave).toBe(15);
    session.setStartWave(4);
    expect(session.startWave).toBe(4);
    session.startNextRun();
    expect(session.run.config.startWave).toBe(4);
    expect(session.run.config.waveCap).toBe(WAVE_CAP);
    playRun(session);
    meta.maxWave = 200;
    session.setStartWave(1000);
    expect(session.startWave).toBe(WAVE_CAP);
  });

  it('opens on the talent web for a returning profile and starts runs from there', () => {
    const { session, meta, started, opened } = createSession();
    meta.runs = 7;
    meta.maxWave = 12;
    giveMight(meta, mightRanksToClear(meta, 6));
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

  it('banks an abandoned run so far and goes back to idle, like a reloaded page', () => {
    const { session, meta, finished, changed } = createSession();
    expect(session.abandonRun()).toBe(false);
    session.start();
    session.queueTalents();
    // Long enough for the first kills to drop shards.
    for (let tick = 0; tick < 20 * TICK_RATE && session.phase === 'running'; tick++) {
      session.step();
    }
    expect(session.phase).toBe('running');
    const state = session.run.sim.state;
    const shards = state.shards;
    const cores = state.cores;
    const wave = state.highestWaveReached;
    expect(toNumber(shards)).toBeGreaterThan(0);
    const saves = changed();
    expect(session.abandonRun()).toBe(true);
    expect(changed()).toBe(saves + 1);
    expect(finished).toHaveLength(0);
    expect(meta.shards).toEqual(shards);
    expect(meta.cores).toBe(cores);
    expect(meta.maxWave).toBe(wave);
    expect(meta.runs).toBe(1);
    expect(session.phase).toBe('idle');
    expect(session.currentRun).toBeNull();
    expect(session.talentsQueued).toBe(false);
    expect(session.abandonRun()).toBe(false);
    // The next page opens on the talent web, and the next run is run 2.
    session.resume();
    session.startNextRun();
    expect(session.run.number).toBe(2);
  });

  it('shows the result screen without a countdown when T was pressed during the run', () => {
    const { session, meta, finished, opened } = createSession();
    expect(session.queueTalents()).toBe(false);
    session.start();
    expect(session.queueTalents()).toBe(true);
    expect(session.talentsQueued).toBe(true);
    playRun(session);
    expect(finished).toHaveLength(1);
    expect(session.phase).toBe('results');
    const report = finished[0] as RunReport;
    expect(report.talentsQueued).toBe(true);
    expect(session.talentsQueued).toBe(false);
    // It waits for the player even with nothing to buy, and leads to the talent web.
    nothingAffordable(session, meta);
    expect(leadsToTalents(report)).toBe(true);
    expect(session.resultTimeLeftMs).toBe(0);
    waitMs(session, RESULT_SCREEN_MS * 2);
    expect(session.phase).toBe('results');
    expect(opened()).toBe(0);
    session.continueFromResults();
    expect(session.phase).toBe('talents');
    expect(opened()).toBe(1);
    expect(session.queueTalents()).toBe(false);
    session.startNextRun();
    playRun(session);
    expect(session.phase).toBe('results');
    expect(session.report?.talentsQueued).toBe(false);
  });
});

/** Sets the rank of the repeatable damage node directly, as a loaded profile would. */
function giveMight(meta: MetaState, ranks: number): void {
  meta.allocated.add('might');
  meta.ranks.set('might', ranks);
}

/**
 * The crit sector, each node next to one before it. Might alone cannot clear later start
 * waves: with every enemy dying in one hit, how many targets the build hits per second decides,
 * and the sector adds projectiles and attack speed.
 */
const CRIT_PATH = [
  'keenEye',
  'sharpen',
  'quickDraw',
  'precision',
  'deadlyAim',
  'splitShot',
  'assassin',
  'volley',
  'steadyAim',
] as const;

/** The crit sector plus enough Might ranks to clear `wave`, set directly. */
function giveStrongBuild(meta: MetaState, wave: number): void {
  for (const id of CRIT_PATH) meta.allocated.add(id);
  giveMight(meta, mightRanksToClear(meta, wave));
}

/** A copy of the talent state, for trying allocations without touching the session's meta. */
function cloneMeta(meta: MetaState): MetaState {
  return {
    ...meta,
    allocated: new Set(meta.allocated),
    ranks: new Map(meta.ranks),
  };
}

/** Whether the talents clear `wave` as a start wave on every probe seed (src/meta/startWave). */
function clears(meta: MetaState, wave: number): boolean {
  const stats = statBlockFor(meta, data);
  const rules = collectRules(meta, data);
  return PROBE_SEEDS.every((seed) =>
    clearsStartWave(probeConfig(stats, rules, wave, seed, { waveCap: WAVE_CAP }), data),
  );
}

/** The session's reach, by direct simulation. */
const reachOf = (meta: MetaState, maxStartWave: number): number =>
  highestClearedStartWave(meta, data, maxStartWave, { waveCap: WAVE_CAP });

/**
 * Might ranks on top of `meta`'s talents with which the build clears `wave` on every probe seed.
 * Searched rather than hard-coded, so the tests survive retuning of the curve and of Might.
 */
function mightRanksToClear(meta: MetaState, wave: number): number {
  const clearsWith = (ranks: number): boolean => {
    const trial = cloneMeta(meta);
    giveMight(trial, ranks);
    return clears(trial, wave);
  };
  if (clearsWith(0)) return 0;
  let high = 1;
  while (!clearsWith(high)) {
    high *= 2;
    if (high > 4096) throw new Error(`Might cannot clear wave ${wave}`);
  }
  // Clearing only roughly grows with damage: `high` always clears.
  let low = high / 2;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (clearsWith(mid)) high = mid;
    else low = mid;
  }
  return high;
}

interface VeteranOptions {
  /** Highest wave reached; the allowed start wave is half of it. */
  readonly maxWave?: number;
  /** Talents that clear the highest allowed start wave (giveStrongBuild). */
  readonly strong?: boolean;
  readonly reach?: SessionOptions['reach'];
}

/** A long-played profile between runs, with plenty to spend, on the talent web. */
function veteranSession({ maxWave = 24, strong = false, reach }: VeteranOptions = {}) {
  const created = createSession({ waveCap: WAVE_CAP, ...(reach === undefined ? {} : { reach }) });
  const { session, meta } = created;
  meta.runs = 20;
  meta.maxWave = maxWave;
  meta.shards = num(1e100);
  meta.cores = 1000;
  if (strong) giveStrongBuild(meta, session.maxStartWave);
  session.resume();
  return created;
}

function buyMight(session: Session, ranks: number): void {
  for (let i = 0; i < ranks; i++) expect(session.allocate('might')).toBe(true);
}

/**
 * Buys the strong build back one purchase at a time (`nodes` of the crit sector, then Might
 * ranks), re-aiming the start wave after each, until `done`.
 */
function rebuy(
  session: Session,
  nodes: readonly string[],
  afterEach: () => void,
  done: () => boolean,
): void {
  for (const id of nodes) {
    if (done()) return;
    expect(session.allocate(id)).toBe(true);
    session.refreshStartWave();
    afterEach();
  }
  let guard = 0;
  while (!done()) {
    buyMight(session, 3);
    session.refreshStartWave();
    afterEach();
    if (++guard > 100) throw new Error('the rebought build never got there');
  }
}

describe('Session start wave', () => {
  it('follows the highest allowed wave while the build clears it', () => {
    const { session } = veteranSession({ strong: true });
    expect(session.maxStartWave).toBe(12);
    expect(session.reach).toBe(12);
    expect(session.startWave).toBe(12);
    expect(session.startWaveLowering).toBeNull();
    buyMight(session, 5);
    session.refreshStartWave();
    expect(session.startWave).toBe(12);
  });

  it('drops on load to the highest start wave the build clears', () => {
    const { session, meta } = veteranSession({ maxWave: 80 });
    expect(session.maxStartWave).toBe(WAVE_CAP);
    const reach = reachOf(meta, WAVE_CAP);
    expect(reach).toBeLessThan(WAVE_CAP);
    expect(session.reach).toBe(reach);
    expect(session.startWave).toBe(reach);
    expect(session.startWaveLowering).toBe('build');
    session.startNextRun();
    expect(session.run.config.startWave).toBe(reach);
  });

  it('drops to the reach after a respec and climbs back as the build is rebought', () => {
    const { session, meta } = veteranSession({ strong: true });
    session.refund();
    const empty = reachOf(meta, 12);
    expect(empty).toBeLessThan(12);
    expect(session.reach).toBe(empty);
    expect(session.startWave).toBe(empty);
    expect(session.startWaveLowering).toBe('build');

    // Purchases do not measure the build; the next refresh (or run start) does.
    expect(session.allocate(CRIT_PATH[0])).toBe(true);
    expect(session.reach).toBeNull();
    expect(session.startWave).toBe(empty);
    rebuy(
      session,
      CRIT_PATH.slice(1),
      () => expect(session.startWave).toBe(session.reach),
      () => session.startWave >= 12,
    );
    expect(session.startWave).toBe(12);
    expect(session.startWaveLowering).toBeNull();
    // Back at the highest allowed wave, it follows that wave upward again.
    meta.maxWave = 30;
    expect(session.startWave).toBe(15);
  });

  it('never raises a start wave above the one the player picked', () => {
    const { session } = veteranSession({ strong: true });
    session.setStartWave(3);
    buyMight(session, 10);
    session.refreshStartWave();
    expect(session.startWave).toBe(3);

    session.setStartWave(10);
    session.refund();
    expect(session.startWave).toBe(Math.min(10, session.reach ?? 0));
    rebuy(
      session,
      CRIT_PATH,
      () => expect(session.startWave).toBe(Math.min(10, session.reach ?? 0)),
      () => session.reach === 12,
    );
    expect(session.startWave).toBe(10);
    expect(session.startWaveLowering).toBeNull();
  });

  it('keeps a start wave the player picked above the reach until the next respec', () => {
    const { session } = veteranSession({ maxWave: 80 });
    const reach = session.reach as number;
    const picked = Math.min(WAVE_CAP, reach + 3);
    session.setStartWave(picked);
    expect(session.startWave).toBe(picked);
    expect(session.startWaveLowering).toBeNull();
    buyMight(session, 1);
    session.refreshStartWave();
    expect(session.startWave).toBe(picked);
    session.refund();
    expect(session.startWave).toBe(session.reach);
  });

  it('lowers the start wave when the next run starts after the talents got weaker', () => {
    const { session, meta } = veteranSession({ strong: true });
    expect(session.startWave).toBe(12);
    // Talents changed between runs; nothing is measured until the run starts.
    meta.allocated.clear();
    meta.ranks.clear();
    expect(session.startWave).toBe(12);
    session.startNextRun();
    const weak = reachOf(meta, 12);
    expect(weak).toBeLessThan(12);
    expect(session.run.config.startWave).toBe(weak);
  });

  it('steps down after a run that does not clear it and climbs back once runs clear it', () => {
    // The stand-in reach calls every allowed wave cleared, as an unlucky seed would.
    const { session, meta } = veteranSession({ maxWave: 80, reach: (_meta, max) => max });
    expect(session.startWave).toBe(WAVE_CAP);
    session.startNextRun();
    playRun(session);
    const failed = session.report as RunReport;
    expect(failed.result.clearedStartWave).toBe(false);
    const lowered = Math.min(
      WAVE_CAP - 1,
      Math.floor(failed.result.highestWaveReached * FAILED_START_RATIO),
    );
    expect(session.startWave).toBe(Math.max(1, lowered));
    expect(failed.nextStartWave).toBe(session.startWave);
    expect(session.startWaveLowering).toBe('failedRun');

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
    // Once a run clears its start wave, a failed run is no longer given as the reason.
    expect(session.startWaveLowering).not.toBe('failedRun');

    // A much stronger build clears its start wave and the start wave climbs back.
    giveStrongBuild(meta, 20);
    const low = session.startWave;
    session.startNextRun();
    playRun(session);
    const cleared = session.report as RunReport;
    expect(cleared.result.clearedStartWave).toBe(true);
    const climbed = Math.floor(cleared.result.highestWaveReached * DEFAULT_ECONOMY.startWaveRatio);
    expect(climbed).toBeGreaterThan(low);
    expect(session.startWave).toBe(Math.min(WAVE_CAP, climbed));
  });

  it('climbs back after a failed run by no more than the reach gained', () => {
    let reach = 30;
    const { session } = veteranSession({
      maxWave: 80,
      reach: (_meta, max) => Math.min(max, reach),
    });
    expect(session.startWave).toBe(30);
    expect(session.startWaveLowering).toBe('build');
    // A fresh build does not clear wave 30, whatever the stand-in says.
    session.startNextRun();
    playRun(session);
    expect((session.report as RunReport).result.clearedStartWave).toBe(false);
    const lowered = session.startWave;
    expect(lowered + 3).toBeLessThan(33);
    session.openTalents();
    buyMight(session, 1);
    reach = 33;
    session.refreshStartWave();
    expect(session.startWave).toBe(lowered + 3);
    expect(session.startWaveLowering).toBe('failedRun');
  });

  it('does not climb past the reach after a run that clears its start wave', () => {
    const { session, meta } = createSession({ waveCap: WAVE_CAP, reach: () => 10 });
    meta.runs = 20;
    meta.maxWave = 80;
    giveStrongBuild(meta, 24);
    session.resume();
    expect(session.startWave).toBe(10);
    session.startNextRun();
    playRun(session);
    const report = session.report as RunReport;
    expect(report.result.clearedStartWave).toBe(true);
    // The run alone would allow a higher start wave; the measured reach says no.
    const frontier = Math.floor(report.result.highestWaveReached * DEFAULT_ECONOMY.startWaveRatio);
    expect(frontier).toBeGreaterThan(10);
    expect(session.startWave).toBe(10);
  });
});
