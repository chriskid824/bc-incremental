import { describe, expect, it } from 'vitest';
import { deriveSeed } from '../../../src/core/rng';
import { characterGameData } from '../../../src/data';
import type { FusionKey } from '../../../src/data/web';
import { DEFAULT_WEB_ECONOMY } from '../../../src/meta/web';
import type { CharacterProgress } from '../../../src/meta/web';
import { frontierOf, probeRun } from '../../../src/meta/web/calibrate';
import { auditBuy, auditStart } from '../../../src/meta/web/invest';
import { runJob, runJobs } from '../jobs';
import type { BalanceJob } from '../jobs';
import { boardInvestment, boardPlan, deadBoardBase } from './checks/boards';
import { FRESH_ACCOUNT } from './checks/types';
import { C10_SEED, webOf } from './content';
import {
  deadBoardSeed,
  measureAffix,
  measureDeadBoard,
  measureEnemyRow,
  measureKeystone,
  measureMirror,
  measureOuterRow,
  measureStrength,
  runMeasure,
} from './measures';
import type {
  AffixInput,
  DeadBoardInput,
  EnemyRowInput,
  KeystoneInput,
  MeasureId,
  MeasureInput,
  MeasureProbe,
  OuterRowInput,
} from './measures';
import { eliteWaveData, rowSeed, testWaveData, testWaveRun } from './testWave';

type MeasureJob = Extract<BalanceJob, { kind: 'measure' }>;

const B1 = { fixture: 'B1' } as const;
const B5 = { fixture: 'B5' } as const;

const star: KeystoneInput = {
  content: B1,
  character: 'fire',
  star: 'fire.center.main.star-one',
  snapshot: auditStart(webOf(B1, 'fire', 'full'), false),
  account: FRESH_ACCOUNT,
  economy: DEFAULT_WEB_ECONOMY,
  seed: 0,
};
const keystone = (seed: number): MeasureJob => ({
  kind: 'measure',
  measure: 'keystone',
  input: { ...star, seed },
});
const strength = (seed: number): MeasureJob => ({
  kind: 'measure',
  measure: 'fusionStrength',
  input: { content: B5, key: 'fire.crit', coef: 0.5, seed },
});

describe('measure jobs', () => {
  it('runs each measure through runJob, its input and its reading plain data', () => {
    for (const job of [keystone(0), strength(0)]) {
      const result = runJob(job);
      expect(result).toMatchObject({ kind: 'measure', measure: job.measure });
      expect(result.result).toEqual(runMeasure(job.measure, job.input));
      expect(JSON.parse(JSON.stringify(job))).toStrictEqual(job);
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
    }
  });

  it('reads the same on two workers as in-process, in job order', async () => {
    const jobs = [keystone(0), strength(0), keystone(1), strength(1)];
    const inProcess = await runJobs(jobs, 1);
    const workers = await runJobs(jobs, 2);
    expect([inProcess.mode, workers.mode]).toEqual(['in-process', 'workers']);
    expect(workers.results).toEqual(inProcess.results);
  }, 30_000);

  it('refuses a ★ or a fusion core the web does not have', () => {
    expect(() => measureKeystone({ ...star, star: 'fire.center.main.nope' })).toThrow(
      "keystone 'fire.center.main.nope': no such ★ in fire's web",
    );
    expect(() => measureKeystone({ ...star, star: 'fire.center.alpha.alpha-one' })).toThrow(
      /no such ★/,
    );
    expect(() =>
      measureStrength({ content: B5, key: 'fire.nope' as FusionKey, coef: 1, seed: 0 }),
    ).toThrow("fusionStrength 'fire.nope': no such fusion core in the web");
  });
});

describe("C10.4's measures", () => {
  const jobs: MeasureJob[] = [
    {
      kind: 'measure',
      measure: 'mirror',
      input: { content: B5, key: 'fire.crit', coef: 0.5, seed: 0 },
    },
    {
      kind: 'measure',
      measure: 'double',
      input: { content: B1, character: 'fire', outers: ['poison', 'crit'], seed: 0 },
    },
    {
      kind: 'measure',
      measure: 'triple',
      input: { content: B1, character: 'fire', outers: ['poison', 'crit', 'ice'], seed: 1 },
    },
    { kind: 'measure', measure: 'fuzz', input: { content: B1, seed: 1029, only: 'fire.full.0' } },
  ];

  it('runs each through runJob, its input and reading plain data, the same on two workers', async () => {
    for (const job of jobs) {
      const result = runJob(job);
      expect(result).toMatchObject({ kind: 'measure', measure: job.measure });
      expect(JSON.parse(JSON.stringify(job))).toStrictEqual(job);
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
    }
    const [inProcess, workers] = [await runJobs(jobs, 1), await runJobs(jobs, 2)];
    expect(workers.mode).toBe('workers');
    expect(workers.results).toEqual(inProcess.results);
  }, 60_000);

  it('refuses a fusion core the web does not have', () => {
    expect(() =>
      measureMirror({ content: B5, key: 'fire.nope' as FusionKey, coef: 1, seed: 0 }),
    ).toThrow("mirror 'fire.nope': no such fusion core in the web");
  });

  it('throws, naming it, on a job kind or a measure it does not know (lead ruling U14)', () => {
    expect(() => runJob({ kind: 'warp' } as unknown as BalanceJob)).toThrow(
      "Unknown balance job kind 'warp'",
    );
    expect(() => runMeasure('teleport' as MeasureId, {} as MeasureInput)).toThrow(
      "Unknown measure 'teleport'",
    );
    expect(() =>
      runJob({ kind: 'measure', measure: 'teleport', input: {} } as unknown as BalanceJob),
    ).toThrow("Unknown measure 'teleport'");
  });
});

describe("C10.3's measures", () => {
  const web = webOf(B1, 'fire', 'full');
  const data = characterGameData();
  const snapshot = auditStart(web, false);
  /** 30 % of it pays for every purchase an investment makes. */
  const earned = { shards: 1e9, cores: 100 };
  const row: EnemyRowInput = {
    content: B1,
    character: 'fire',
    column: 'triangle',
    snapshot,
    account: FRESH_ACCOUNT,
    answer: false,
    seed: 0,
  };
  const onSnapshot = {
    content: B1,
    character: 'fire',
    snapshot,
    earned,
    account: FRESH_ACCOUNT,
    economy: DEFAULT_WEB_ECONOMY,
  } as const;
  const outerRow: OuterRowInput = { ...onSnapshot, outer: 'poison', column: 'triangle', seed: 0 };
  const affix: AffixInput = { ...onSnapshot, outer: 'ice', affixed: true, seed: 0 };
  const board: DeadBoardInput = { ...onSnapshot, outer: 'crit', seed: 0 };
  /** The center route from nothing to outer.poison's entry. */
  const route = [
    'fire.center.alpha.r1',
    'fire.center.alpha.r2',
    'fire.center.alpha.alpha-one',
    'fire.center.alpha.r3',
    'fire.center.main.c1',
    'hub.defense.r1',
  ];
  const invested = (outer: 'poison' | 'crit' | 'ice', first: string | null = null) =>
    boardInvestment(
      web,
      deadBoardBase(web, snapshot, earned),
      FRESH_ACCOUNT,
      DEFAULT_WEB_ECONOMY,
      outer,
      first,
    );

  it('runs each through runJob, its input and reading plain data, the same on two workers', async () => {
    const jobs: MeasureJob[] = [
      { kind: 'measure', measure: 'enemyRow', input: row },
      { kind: 'measure', measure: 'enemyRow', input: { ...row, column: 'dasher', answer: true } },
      { kind: 'measure', measure: 'outerRow', input: outerRow },
      { kind: 'measure', measure: 'affix', input: affix },
      { kind: 'measure', measure: 'deadBoard', input: { ...board, outer: null } },
      { kind: 'measure', measure: 'deadBoard', input: board },
    ];
    for (const job of jobs) {
      const result = runJob(job);
      expect(result).toMatchObject({ kind: 'measure', measure: job.measure });
      expect(result.result).toEqual(runMeasure(job.measure, job.input));
      expect(JSON.parse(JSON.stringify(job))).toStrictEqual(job);
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
    }
    const [inProcess, workers] = [await runJobs(jobs, 1), await runJobs(jobs, 2)];
    expect([inProcess.mode, workers.mode]).toEqual(['in-process', 'workers']);
    expect(workers.results).toEqual(inProcess.results);
  }, 60_000);

  it("plays a column's test wave on the snapshot, or with the nearest center node that answers it", () => {
    const plain = measureEnemyRow(row);
    expect(plain).toMatchObject({ node: null, purchases: [], refused: null });
    expect(plain.run).toEqual(
      testWaveRun(web, snapshot, testWaveData(data, 'triangle'), rowSeed('triangle', 0)),
    );
    const answered = measureEnemyRow({ ...row, column: 'dasher', answer: true, seed: 2 });
    const purchases = [
      'fire.center.alpha.r1',
      'fire.center.alpha.r2',
      'fire.center.alpha.alpha-one',
    ];
    expect(answered).toMatchObject({
      node: 'fire.center.alpha.alpha-one',
      purchases,
      refused: null,
    });
    let progress: CharacterProgress = snapshot;
    for (const id of purchases) {
      const step = auditBuy(web, progress, FRESH_ACCOUNT, id);
      if (!step.ok) throw new Error(step.refusal.reason);
      progress = step.progress;
    }
    expect(answered.run).toEqual(
      testWaveRun(web, progress, testWaveData(data, 'dasher'), rowSeed('dasher', 2)),
    );
    expect(measureEnemyRow({ ...row, answer: true })).toMatchObject({
      node: null,
      purchases: [],
      refused: 'no center node answers triangle',
      run: null,
    });
  });

  it("plays a covered column's test wave with the outer's investment, the ◆ answering it first", () => {
    const answer = measureOuterRow(outerRow);
    expect(answer.bought).toEqual([
      ...route,
      'outer.poison.main.entry',
      'outer.poison.alpha.r1',
      'outer.poison.alpha.r2',
      'outer.poison.alpha.alpha-one',
      'outer.poison.alpha.alpha-two',
      'outer.poison.main.counter',
      'outer.poison.beta.r1',
      'outer.poison.beta.r2',
    ]);
    expect(answer).toMatchObject({ unpaid: [], refused: null });
    expect(answer.run).toEqual(
      testWaveRun(
        web,
        invested('poison', 'outer.poison.main.counter').progress,
        testWaveData(data, 'triangle'),
        rowSeed('triangle', 0),
      ),
    );
    // A center node answers dashers too, earlier in web order: the ◆ is still the outer's own.
    expect(measureOuterRow({ ...outerRow, column: 'dasher' }).bought).toEqual(answer.bought);
    // poison only helps against squares: no ◆, the board breadth-first.
    const helps = measureOuterRow({ ...outerRow, column: 'square' });
    expect(helps.bought).toEqual([...route, ...boardPlan(web, 'poison')]);
  });

  it("reads a board's elite wave, plain or affixed, and the elite's affix bits (none before C7.6)", () => {
    const center = measureAffix({ ...affix, outer: null, affixed: false });
    expect(center).toMatchObject({
      outer: null,
      bits: null,
      bought: [],
      unpaid: [],
      refused: null,
    });
    expect(center.run).toEqual(
      testWaveRun(web, snapshot, eliteWaveData(data, false), rowSeed('hexagon', 0)),
    );
    expect(center.run.count).toBe(1);
    const outer = measureAffix(affix);
    expect(outer.bought).toEqual(invested('ice').bought);
    expect(outer.bits).toBeNull();
    expect(outer.run).toEqual(
      testWaveRun(web, invested('ice').progress, eliteWaveData(data, true), rowSeed('hexagon', 0)),
    );
  });

  it("probes the base, or the base with the outer's investment, on the dead-board seed", () => {
    const calls: { progress: CharacterProgress; seed: number }[] = [];
    const probe: MeasureProbe = (_, progress, seed) => {
      calls.push({ progress, seed });
      return calls.length;
    };
    expect(deadBoardSeed(3)).toBe(deriveSeed(C10_SEED, 'deadBoard:3'));
    expect(measureDeadBoard({ ...board, outer: null, seed: 3 }, probe)).toEqual({
      character: 'fire',
      outer: null,
      seed: 3,
      x: 1,
      bought: [],
      unpaid: [],
      refused: null,
    });
    expect(calls[0]).toEqual({
      progress: deadBoardBase(web, snapshot, earned),
      seed: deadBoardSeed(3),
    });
    const crit = invested('crit');
    expect(measureDeadBoard({ ...board, seed: 3 }, probe)).toMatchObject({
      x: 2,
      bought: crit.bought,
      unpaid: [],
      refused: null,
    });
    expect(calls[1]).toEqual({ progress: crit.progress, seed: deadBoardSeed(3) });
    // The default probe is calibration's: from wave 1, frontierOf.
    expect(measureDeadBoard(board).x).toBe(
      frontierOf(probeRun(web, crit.progress, deadBoardSeed(0), data), data),
    );
  });
});
