import { describe, expect, it, vi } from 'vitest';
import { loadGameData } from '../data';
import type { GameData } from '../data';
import { TAG } from '../data/tags';
import { num, toNumber } from '../core/num';
import { createStreams } from '../core/rng';
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
import type { RuleSpec, SignatureId, SignatureSpec } from '../data/rules';
import { MAX_RUN_SECONDS, TICK_RATE, compileBuild, signatureRows } from '../sim';
import { CritStopGate } from '../render/critStop';
import { loadSave } from '../save';
import { emitterPayload } from '../sim/emitters/types';
import type { DroneSpec, EmitterSpec } from '../sim/emitters/types';
import { SIGNATURES } from '../sim/rules';
import { damageRow } from '../sim/testing';
import {
  FAILED_START_RATIO,
  RESULT_FRAME_MAX_MS,
  RESULT_SCREEN_MS,
  Session,
  leadsToTalents,
} from './session';
import type { ActiveRun, RunReport, SessionOptions } from './session';
import HIVE_PRESET from './hivePreset.json';

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

  it("scales damage numbers by the signature attack's hit row, projectile modifiers included", () => {
    // Searing Crits with a ×3 on projectile hits: M1's hits are hit and projectile.
    const projectileMore = {
      stat: 'damage',
      kind: 'more',
      value: 2,
      tags: ['projectile'],
    } as const;
    const withProjectile: GameData = {
      ...data,
      talents: data.talents.map((node) =>
        node.id === 'searingCrits'
          ? { ...node, modifiers: [...node.modifiers, projectileMore] }
          : node,
      ),
    };
    const meta = createMetaState();
    meta.allocated.add('searingCrits');
    const session = new Session(withProjectile, meta, {
      runStarted: () => undefined,
      runFinished: () => undefined,
      talentsOpened: () => undefined,
      profileChanged: () => undefined,
    });
    session.start();
    const { stats, rules } = session.run.config;
    expect(session.run.config.signature).toBeUndefined();
    expect(damageRow(stats, TAG.hit, rules)).toBe(0.5);
    expect(damageRow(stats, TAG.hit | TAG.projectile, rules)).toBe(0.5 * 3);
    expect(session.run.typicalHit).toBe(stats.values.damage * 0.5 * 3);
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

/** The `?hive` prototype's runs (src/app/devFlags.ts). */
const SWARM: SignatureSpec = { id: 'swarm' };

describe('Session with a signature and a minimum start wave (?hive)', () => {
  it('passes the signature to every run after the rules; without one the configs are as before', () => {
    const hive = createSession({ waveCap: WAVE_CAP, signature: SWARM });
    hive.session.start();
    const config = hive.session.run.config;
    expect(Object.keys(config)).toEqual([
      'seed',
      'stats',
      'rules',
      'signature',
      'startWave',
      'mode',
      'waveCap',
    ]);
    expect(config.signature).toEqual(SWARM);
    // An impact's plain hit: the impact's share of the damage stat through its hit row.
    const typical = compileBuild(config.stats, config.rules, SWARM);
    const impact = typical.emitters[0] as EmitterSpec;
    expect(hive.session.run.typicalHit).toBe(
      typical.values.damage * impact.damagePct * typical.table.damage(signatureRows(typical).hit),
    );

    const m1 = createSession({ waveCap: WAVE_CAP });
    m1.session.start();
    const plain = m1.session.run.config;
    expect(Object.keys(plain)).toEqual(['seed', 'stats', 'rules', 'startWave', 'mode', 'waveCap']);
    expect(plain).toEqual({
      seed: 1000,
      stats: statBlockFor(m1.meta, data),
      rules: collectRules(m1.meta, data),
      startWave: 1,
      mode: 'auto',
      waveCap: WAVE_CAP,
    });
  });

  it('probes the reach with the signature its runs play', () => {
    const { session, meta } = createSession({ waveCap: WAVE_CAP, signature: SWARM });
    meta.runs = 20;
    meta.maxWave = 80;
    session.resume();
    const swarm = highestClearedStartWave(meta, data, WAVE_CAP, {
      waveCap: WAVE_CAP,
      signature: SWARM,
    });
    expect(session.reach).toBe(swarm);
    expect(session.startWave).toBe(swarm);
    // M1's volley reaches another wave with the same talents.
    expect(reachOf(meta, WAVE_CAP)).not.toBe(swarm);
  });

  it('raises the highest start wave to minStartWave, but never above the wave cap', () => {
    const floor = createSession({ waveCap: WAVE_CAP, minStartWave: 30 });
    expect(allowedStartWave(floor.meta, DEFAULT_ECONOMY)).toBe(1);
    expect(floor.session.maxStartWave).toBe(30);
    // An allowed wave above the floor wins.
    floor.meta.maxWave = 70;
    expect(floor.session.maxStartWave).toBe(35);
    floor.meta.maxWave = 200;
    expect(floor.session.maxStartWave).toBe(WAVE_CAP);
    expect(createSession({ waveCap: WAVE_CAP, minStartWave: 50 }).session.maxStartWave).toBe(
      WAVE_CAP,
    );
    expect(createSession({ minStartWave: 50 }).session.maxStartWave).toBe(50);
    expect(createSession({ waveCap: WAVE_CAP }).session.maxStartWave).toBe(1);
  });

  it('starts at wave 30 with resume() then setStartWave(30) (&wave=30), as M1 lowers a failed start', () => {
    const hive = (): ReturnType<typeof createSession> => {
      const created = createSession({ waveCap: WAVE_CAP, minStartWave: 30, reach: () => 18 });
      created.meta.runs = 20;
      created.meta.maxWave = 24;
      return created;
    };
    const resumed = hive();
    resumed.session.resume();
    resumed.session.startNextRun();
    expect(resumed.session.run.config.startWave).toBe(18);

    const { session } = hive();
    session.resume();
    session.setStartWave(30);
    expect(session.startWave).toBe(30);
    expect(session.startWaveLowering).toBeNull();
    session.startNextRun();
    expect(session.run.config.startWave).toBe(30);
    // A fresh build does not clear wave 30: the next start steps down, as in M1.
    playRun(session);
    const failed = session.report as RunReport;
    expect(failed.result.clearedStartWave).toBe(false);
    const lowered = Math.min(29, Math.floor(failed.result.highestWaveReached * FAILED_START_RATIO));
    expect(session.startWave).toBe(lowered);
    expect(session.startWaveLowering).toBe('failedRun');
    // Picking 30 again (or reloading the page) restores it.
    session.setStartWave(30);
    expect(session.startWave).toBe(30);
    session.openTalents();
    session.startNextRun();
    expect(session.run.config.startWave).toBe(30);
  });
});

/** 六線圈 (C13) as a talent's rule: six coils, two targets a discharge, 55% of the arc's damage. */
const SIX_COILS: RuleSpec = { id: 'sixCoils', coils: 6, targets: 2, damageMult: 0.55 };

/**
 * M1's talents with a thorns grant on Keen Eye, an emitter after any signature's, and 六線圈 on
 * Sharpen, which only the arc's runs may take (another signature's compile throws on it).
 */
const SHARE_DATA: GameData = {
  ...data,
  talents: data.talents.map((node) =>
    node.id === 'keenEye'
      ? { ...node, emitters: [...node.emitters, { kind: 'thorns' } as const] }
      : node.id === 'sharpen'
        ? { ...node, rules: [...node.rules, SIX_COILS] }
        : node,
  ),
};

/** The first run of a fresh profile on SHARE_DATA with `nodes` allocated, playing `signature`. */
function shareRun(signature: SignatureSpec, nodes: readonly string[]): ActiveRun {
  const meta = createMetaState();
  for (const id of nodes) meta.allocated.add(id);
  const session = new Session(
    SHARE_DATA,
    meta,
    {
      runStarted: () => undefined,
      runFinished: () => undefined,
      talentsOpened: () => undefined,
      profileChanged: () => undefined,
    },
    { signature },
  );
  session.start();
  return session.run;
}

/**
 * The plain hit of `run`'s signature payload: its base damage, the share of the damage stat that
 * emitterPayload gives emitter 0, through the signature attack's hit row.
 */
function payloadHit(run: ActiveRun): number {
  const { seed, stats, rules, signature } = run.config;
  const build = compileBuild(stats, rules, signature);
  const spec = build.emitters[0] as EmitterSpec;
  const payload = emitterPayload(build, spec, createStreams(seed).combat, null);
  return toNumber(payload.baseDamage) * build.table.damage(signatureRows(build).hit);
}

/** Makes the swarm's impacts 200% of the damage stat, as C5.R's options (A) and (C) tune them. */
function tuneImpacts() {
  const untuned = SIGNATURES.swarm.emitter;
  return vi
    .spyOn(SIGNATURES.swarm, 'emitter')
    .mockImplementation((spec): EmitterSpec => ({ ...(untuned(spec) as DroneSpec), damagePct: 2 }));
}

describe('Session typical hit', () => {
  it.each(Object.keys(SIGNATURES) as SignatureId[])(
    "is the plain hit of %s's payload, its share of the damage stat included, beside a granted emitter",
    (id) => {
      const run = shareRun({ id }, ['keenEye']);
      const { stats, rules } = run.config;
      // The thorns grant (300%) follows the signature emitter, and the typical hit never reads it.
      expect(compileBuild(stats, rules, { id }).emitters[1]?.kind).toBe('thorns');
      expect(run.typicalHit).toBe(payloadHit(run));
    },
  );

  it("takes 六線圈's damageMult into the arc's share, as the arc's payload does", () => {
    const arc: SignatureSpec = { id: 'triphaseArc' };
    const run = shareRun(arc, ['sharpen']);
    const { stats, rules } = run.config;
    const build = compileBuild(stats, rules, arc);
    expect(build.signature.arc?.damageMult).toBe(0.55);
    expect(run.typicalHit).toBe(payloadHit(run));
    expect(run.typicalHit).toBe(
      stats.values.damage * 0.55 * build.table.damage(signatureRows(build).hit),
    );
  });

  it("follows a tuning of the swarm's impact share (C5.R), not DRONE_DEFAULTS' or the turret's", () => {
    const untuned = SIGNATURES.swarm.emitter;
    const spy = tuneImpacts();
    try {
      const { session } = createSession({ signature: SWARM });
      session.start();
      const { stats, rules } = session.run.config;
      const build = compileBuild(stats, rules, SWARM);
      expect((build.emitters[0] as EmitterSpec).damagePct).toBe(2);
      expect(session.run.typicalHit).toBe(payloadHit(session.run));
      expect(session.run.typicalHit).toBe(
        stats.values.damage * 2 * build.table.damage(signatureRows(build).hit),
      );
    } finally {
      spy.mockRestore();
    }
    expect(SIGNATURES.swarm.emitter).toBe(untuned);
  });

  it("is each run's own: the run after purchases on the talent web measures its own build's plain hit", () => {
    const { session, meta } = createSession();
    session.start();
    const first = session.run.typicalHit;
    expect(first).toBe(payloadHit(session.run));
    playRun(session);
    session.openTalents();
    meta.shards = num(1e9);
    meta.cores = 10;
    buyMight(session, 1);
    expect(session.allocate('glassCannon')).toBe(true);
    session.startNextRun();
    expect(session.run.number).toBe(2);
    expect(session.run.typicalHit).toBe(payloadHit(session.run));
    // Might's ×1.1 and Glass Cannon's ×2 reach the hit row.
    expect(session.run.typicalHit / first).toBeCloseTo(2.2, 12);
  });

  it("counts a 六線圈 allocated between runs in the next arc run's share, as that run's payload does", () => {
    const arc: SignatureSpec = { id: 'triphaseArc' };
    const meta = createMetaState();
    const session = new Session(
      SHARE_DATA,
      meta,
      {
        runStarted: () => undefined,
        runFinished: () => undefined,
        talentsOpened: () => undefined,
        profileChanged: () => undefined,
      },
      { signature: arc },
    );
    session.start();
    const before = session.run;
    playRun(session);
    session.openTalents();
    // SHARE_DATA's Sharpen carries 六線圈; set directly, as a loaded profile would.
    meta.allocated.add('keenEye');
    meta.allocated.add('sharpen');
    session.startNextRun();
    const after = session.run;
    const compiled = (run: ActiveRun) =>
      compileBuild(run.config.stats, run.config.rules, run.config.signature);
    expect(compiled(before).signature.arc?.damageMult).toBe(1);
    expect(compiled(after).signature.arc?.damageMult).toBe(0.55);
    expect(before.typicalHit).toBe(payloadHit(before));
    expect(after.typicalHit).toBe(payloadHit(after));
  });
});

/**
 * The crit hit-stops the renderer's gate asks for in the first minute at 1× of the ?hive preset's
 * first run, opened as main.ts opens it, with every crit's decades taken over `typical` of the
 * run, and the ticks it played: review 2's T4, shared with the control that shows it counts.
 */
function presetCritStops(typical: (run: ActiveRun) => number): { stops: number; ticks: number } {
  const loaded = loadSave(JSON.stringify(HIVE_PRESET), data);
  if (!loaded.ok) throw new Error(loaded.error);
  const session = new Session(
    data,
    loaded.profile.meta,
    {
      runStarted: () => undefined,
      runFinished: () => undefined,
      talentsOpened: () => undefined,
      profileChanged: () => undefined,
    },
    { waveCap: WAVE_CAP, signature: SWARM },
  );
  // As main.ts opens ?hive on a returning profile: the talent web, then Enter.
  session.resume();
  session.startNextRun();
  const typicalHit = typical(session.run);
  // The renderer's gate (src/render/renderer.ts onHit), fed every crit's decades over the
  // typical hit (DamageNumbers.decades) and a frame of wall-clock time a tick, as at 1×.
  const gate = new CritStopGate();
  let stops = 0;
  let ticks = 0;
  for (; ticks < 60 * TICK_RATE && session.phase === 'running'; ticks++) {
    for (const event of session.step()) {
      if (event.type !== 'hit' || !event.crit) continue;
      const decades = Math.log10(toNumber(event.amount)) - Math.log10(typicalHit);
      if (gate.crit(decades) > 0) stops++;
    }
    gate.update(1000 / TICK_RATE);
  }
  return { stops, ticks };
}

/** 5d10c39's typical hit (review 2's B1): the damage stat through the hit row, with no share. */
function sharelessHit(run: ActiveRun): number {
  const { stats, rules, signature } = run.config;
  const build = compileBuild(stats, rules, signature);
  return build.values.damage * build.table.damage(signatureRows(build).hit);
}

describe('?hive crit hit-stops (C5.R option (A); review 2)', () => {
  it('asks for at most one crit hit-stop in the preset’s first ?hive minute at 1×, as on C5.4: a rare accent, not a beat (ARCHITECTURE §10.3)', () => {
    const { stops, ticks } = presetCritStops((run) => run.typicalHit);
    // The preset's first ?hive run outlives the minute (about 70 s from wave 13).
    expect(ticks).toBe(60 * TICK_RATE);
    expect(stops).toBeLessThanOrEqual(1);
  });

  it('counts the hitch it guards against: 200% impacts stop every few seconds over the share-less typical hit (B1), at most once over theirs', () => {
    const untuned = SIGNATURES.swarm.emitter;
    const spy = tuneImpacts();
    try {
      expect(presetCritStops((run) => run.typicalHit).stops).toBeLessThanOrEqual(1);
      // One every 5 s at least, where the gate's 2.5 s cooldown allows 24 a minute.
      expect(presetCritStops(sharelessHit).stops).toBeGreaterThanOrEqual(12);
    } finally {
      spy.mockRestore();
    }
    expect(SIGNATURES.swarm.emitter).toBe(untuned);
  });
});
