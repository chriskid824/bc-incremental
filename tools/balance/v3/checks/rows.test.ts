import { describe, expect, it } from 'vitest';
import { num } from '../../../../src/core/num';
import type { CharacterId } from '../../../../src/data';
import { AFFIX_IDS } from '../../../../src/data/affixes';
import { ROW_ENEMIES } from '../../../../src/data/web';
import type { AssembledWeb, RowEnemy } from '../../../../src/data/web';
import { fixtureContent } from '../../../../src/data/web/testing';
import { emptyProgress } from '../../../../src/meta/web';
import { auditStart } from '../../../../src/meta/web/invest';
import { createEnemyV3 } from '../../../../src/sim/systems/enemyRecord';
import { TEST_ENEMIES } from '../../../../src/sim/testing';
import type { EnemyV3View } from '../../../../src/sim/types';
import type { BalanceJob, JobResult } from '../../jobs';
import { webOf } from '../content';
import type {
  AffixInput,
  AffixReading,
  DeadBoardInput,
  EnemyRowInput,
  EnemyRowReading,
  MeasureReading,
  OuterRowInput,
  OuterRowReading,
} from '../measures';
import { ENEMY_ROW_MAX_SECONDS } from '../testWave';
import type { TestWaveReading } from '../testWave';
import { boardSnapshot, DEAD_BOARD_MINUTES } from './boards';
import {
  AFFIX_BOARDS_MIN,
  AFFIX_ORDER,
  AFFIX_RATIO_MAX,
  affixBitsOf,
  affixesCheck,
  affixesCsv,
  affixNames,
  affixUnitId,
  affixVerdict,
  answerNode,
  enemyRowCheck,
  enemyRowCsv,
  enemyRowUnitId,
  escapesOf,
  judgedRun,
  OUTER_ROW_GAIN,
  outerHolds,
  outerRowCheck,
  outerRowCsv,
  outerRowUnitId,
  pendingPart,
  ROW_STRONG_MIN,
  ROW_WEAK_MAX,
  rowStats,
  rowUnits,
  strongHolds,
  weakHolds,
  ZERO_MEDIAN_LEAKS,
} from './rows';
import { checkSet, derivedUnits, evaluate, runPlan } from './run';
import type { RunJobs } from './run';
import {
  ALL_C7,
  BASE_C7,
  measureResults,
  merged,
  NO_C7,
  rowWith,
  sessionResult,
  snapshotSessions,
  testWave,
} from './testing';
import { FRESH_ACCOUNT } from './types';
import type { CheckPlan, CheckResult, UnitResults } from './types';

type Batch = 'B1' | 'B2' | 'B3';

/** The nightly plan of a fixture batch, one 35-min session a character. */
const planOf = (batch: Batch, c7 = ALL_C7): CheckPlan =>
  checkSet('nightly', fixtureContent(batch), { fixture: batch }, { sessions: 1, minutes: 35, c7 });

/** Each character's session 0 with its 30-min snapshot, the audit start. */
const snapped = (plan: CheckPlan): UnitResults => snapshotSessions(plan, DEAD_BOARD_MINUTES);

/** A unit's synthetic test wave: its fields, null for a refused purchase, undefined for no reading. */
type Wave = Partial<TestWaveReading> | null | undefined;

interface Reads {
  readonly enemyRow?: (input: EnemyRowInput) => Wave;
  readonly outerRow?: (input: OuterRowInput) => Wave;
  readonly affix?: (
    input: AffixInput,
  ) => { readonly bits: number | null; readonly run: Partial<TestWaveReading> } | undefined;
}

/** The snapshot sessions, plus `reads`' readings of the plan's row units. */
function rowResults(plan: CheckPlan, reads: Reads, base: UnitResults = snapped(plan)): UnitResults {
  const readings = measureResults(rowUnits(plan, base), (measure, input): MeasureReading | null => {
    if (measure === 'enemyRow') {
      const i = input as EnemyRowInput;
      const run = reads.enemyRow?.(i);
      if (run === undefined) return null;
      const reading: EnemyRowReading = {
        character: i.character,
        column: i.column,
        answer: i.answer,
        seed: i.seed,
        node: i.answer ? `${i.character}.center.answer` : null,
        purchases: i.answer ? [`${i.character}.center.answer`] : [],
        refused: run === null ? `${i.character}.center.answer: hidden` : null,
        run: run === null ? null : testWave(run),
      };
      return reading;
    }
    if (measure === 'outerRow') {
      const i = input as OuterRowInput;
      const run = reads.outerRow?.(i);
      if (run === undefined || run === null) return null;
      const reading: OuterRowReading = {
        character: i.character,
        outer: i.outer,
        column: i.column,
        seed: i.seed,
        bought: [`outer.${i.outer}.main.entry`],
        unpaid: [`outer.${i.outer}.alpha.r1`],
        refused: `outer.${i.outer}.alpha.r1: notEnoughShards`,
        run: testWave(run),
      };
      return reading;
    }
    if (measure === 'affix') {
      const i = input as AffixInput;
      const read = reads.affix?.(i);
      if (read === undefined) return null;
      const reading: AffixReading = {
        character: i.character,
        outer: i.outer,
        affixed: i.affixed,
        seed: i.seed,
        bits: read.bits,
        bought: [],
        unpaid: [],
        refused: null,
        run: testWave(read.run),
      };
      return reading;
    }
    return null;
  });
  return merged(base, readings);
}

const ofCheck = (rows: readonly CheckResult[], subject: string): CheckResult =>
  rowWith(rows, subject);

describe('the row rules', () => {
  it('holds ✓ at ROW_STRONG_MIN × the median exactly (OWN 3)', () => {
    expect(ROW_STRONG_MIN).toBe(0.4);
    const at = (time: number) =>
      strongHolds({ time, damage: 0, leaks: 0, uncleared: 0 }, { time: 10, damage: 5 });
    expect([at(4), at(3.999), at(10), at(ENEMY_ROW_MAX_SECONDS)]).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it('holds ✗ with its answer at ROW_WEAK_MAX × the medians exactly, time and damage both (OWN 3)', () => {
    expect(ROW_WEAK_MAX).toBe(2.5);
    const medians = { time: 10, damage: 4 };
    const at = (time: number, damage: number) =>
      weakHolds({ time, damage, leaks: 10, uncleared: 0 }, medians);
    expect([at(25, 10), at(25.001, 10), at(25, 10.001), at(1, 0)]).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it('judges leaks, at most 1 per 10, in place of damage when the damage median is 0 (OWN 2)', () => {
    expect(ZERO_MEDIAN_LEAKS).toEqual({ leaks: 1, per: 10 });
    const medians = { time: 10, damage: 0 };
    const at = (leaks: number, damage: number) =>
      weakHolds({ time: 10, damage, leaks, uncleared: 0 }, medians);
    expect([at(1, 500), at(0, 0), at(1.25, 0), at(2, 0)]).toEqual([true, true, false, false]);
    expect(weakHolds({ time: 25.5, damage: 0, leaks: 0, uncleared: 0 }, medians)).toBe(false);
  });

  it('reads a treasure wave any treasure escaped at ENEMY_ROW_MAX_SECONDS, uncleared; any other as it ran (lead ruling U18)', () => {
    // Two treasures, one fled: escapes = count − kills − leaks.
    const fled = testWave({ clearSeconds: 3, count: 2, kills: 1 });
    expect(escapesOf(fled)).toBe(1);
    expect(judgedRun(fled, 'treasure')).toEqual({
      ...fled,
      clearSeconds: ENEMY_ROW_MAX_SECONDS,
      cleared: false,
    });
    expect(judgedRun(fled, 'triangle')).toBe(fled);
    // Every treasure caught: its clear time. A leak is not an escape.
    const caught = testWave({ clearSeconds: 3, count: 2, kills: 2 });
    expect(judgedRun(caught, 'treasure')).toBe(caught);
    const leaked = testWave({ clearSeconds: 3, count: 2, kills: 1, leaks: 1 });
    expect(escapesOf(leaked)).toBe(0);
    expect(judgedRun(leaked, 'treasure')).toBe(leaked);
  });

  it('reads the medians over seeds: clear time, contact plus bullets, leaks per 10', () => {
    const stats = rowStats([
      testWave({ clearSeconds: 5, contact: 1, bullet: 4, leaks: 1 }),
      testWave({ clearSeconds: ENEMY_ROW_MAX_SECONDS, cleared: false, contact: 2, leaks: 3 }),
      testWave({ clearSeconds: 7, contact: 10, bullet: 0, leaks: 2 }),
    ]);
    expect(stats).toEqual({ time: 7, damage: 5, leaks: 2, uncleared: 1 });
    // The Boss row's one enemy: its leak is 10 per 10.
    expect(rowStats([testWave({ count: 1, leaks: 1 })]).leaks).toBe(10);
  });

  it('holds an outer at OUTER_ROW_GAIN better time or damage, either one (OWN 4)', () => {
    expect(OUTER_ROW_GAIN).toBe(0.2);
    const base = { time: 10, damage: 10, leaks: 0, uncleared: 0 };
    const at = (time: number, damage: number) =>
      outerHolds(base, { time, damage, leaks: 0, uncleared: 0 });
    // 19.9 %, 20 % and 20.1 % better: on time alone, then on damage alone.
    expect([at(8.01, 10), at(8, 10), at(7.99, 10)]).toEqual([false, true, true]);
    expect([at(10, 8.01), at(10, 8), at(10, 7.99)]).toEqual([false, true, true]);
    expect(at(10.5, 2)).toBe(true);
    // A base damage of 0 judges time alone.
    const clean = { time: 10, damage: 0, leaks: 0, uncleared: 0 };
    expect(outerHolds(clean, clean)).toBe(false);
    expect(outerHolds(clean, { ...clean, time: 8 })).toBe(true);
  });

  it('passes an affix with AFFIX_BOARDS_MIN countering boards and one for every character (OWN 7)', () => {
    expect([AFFIX_BOARDS_MIN, AFFIX_RATIO_MAX]).toEqual([3, 1.5]);
    const r = (character: CharacterId, board: string, ratio: number | null) => ({
      character,
      board,
      ratio,
    });
    const both: CharacterId[] = ['fire', 'summon'];
    expect(
      affixVerdict(
        [
          r('fire', 'fire.center', 1.5),
          r('fire', 'outer.ice', 1.2),
          r('summon', 'summon.center', 0.9),
          r('summon', 'outer.crit', 3),
        ],
        both,
      ),
    ).toEqual({
      status: 'pass',
      boards: ['fire.center', 'outer.ice', 'summon.center'],
      without: [],
    });
    // A character with no countering board fails, whatever the other counters.
    const fireOnly = [
      r('fire', 'fire.center', 1),
      r('fire', 'outer.ice', 1),
      r('fire', 'outer.crit', 1),
      r('summon', 'summon.center', 1.51),
    ];
    expect(affixVerdict(fireOnly, both)).toMatchObject({ status: 'FAIL', without: ['summon'] });
    // Two boards are too few; a board two characters counter with counts once.
    expect(
      affixVerdict(
        [r('fire', 'outer.ice', 1), r('summon', 'outer.ice', 1), r('summon', 'summon.center', 1)],
        both,
      ),
    ).toMatchObject({ status: 'FAIL', boards: ['outer.ice', 'summon.center'] });
    // A failing rule with a ratio unread, or a character unread, is n/a.
    const unread = [...fireOnly.slice(0, 3), r('summon', 'summon.center', null)];
    expect(affixVerdict(unread, both).status).toBe('n/a');
    expect(affixVerdict(fireOnly.slice(0, 3), both).status).toBe('n/a');
  });

  it("reads an enemy record's affix bits and names them in AFFIX_ORDER", () => {
    const record = (affixes: number): EnemyV3View =>
      createEnemyV3(TEST_ENEMIES.hexagon, undefined, 1, affixes, num(100));
    expect(affixBitsOf(record(5))).toBe(5);
    expect(affixBitsOf(record(0))).toBe(0);
    expect(affixBitsOf(createEnemyV3(TEST_ENEMIES.triangle, undefined, 1))).toBe(0);
    // An M1 run's enemies have no record.
    expect(affixBitsOf(null)).toBeNull();
    // C7.6's AFFIX_IDS is the order itself, so the tools and the sim cannot drift apart.
    expect(AFFIX_ORDER).toBe(AFFIX_IDS);
    expect(AFFIX_ORDER).toEqual([
      'swift',
      'armoured',
      'regen',
      'guardian',
      'multiply',
      'berserk',
      'ward',
      'frost',
    ]);
    expect(affixNames(0b101)).toEqual(['swift', 'regen']);
    expect(affixNames(1 << 7)).toEqual(['frost']);
  });

  it("names the C7 part a column's behaviour waits for, none for M1's types", () => {
    expect(ROW_ENEMIES.map((column) => pendingPart(NO_C7, column))).toEqual([
      null,
      null,
      null,
      'defence (C7.3)',
      'state (C7.4a)',
      'state (C7.4a)',
      'bulletTakenBy (C7.4b)',
      'bulletTakenBy (C7.4b)',
      'state (C7.4a)',
      'layersLeft (C7.7)',
    ]);
    expect(ROW_ENEMIES.map((column) => pendingPart(ALL_C7, column))).toEqual(
      ROW_ENEMIES.map(() => null),
    );
    expect(pendingPart(BASE_C7, 'shielder')).toBeNull();
    expect(pendingPart(BASE_C7, 'regenerator')).toBe('state (C7.4a)');
  });
});

describe('the answer node', () => {
  const web = webOf({ fixture: 'B1' }, 'fire', 'full');
  const start = emptyProgress('fire');

  it('is the center node that answers the column, with the purchases that reach it', () => {
    expect(answerNode(web, start, 'dasher')).toEqual({
      node: 'fire.center.alpha.alpha-one',
      route: ['fire.center.alpha.r1', 'fire.center.alpha.r2', 'fire.center.alpha.alpha-one'],
    });
    expect(answerNode(web, start, 'summoner')?.node).toBe('fire.center.beta.beta-one');
    expect(answerNode(web, start, 'triangle')).toBeNull();
    const owning = {
      ...start,
      ranks: {
        'fire.center.alpha.r1': 1,
        'fire.center.alpha.r2': 1,
        'fire.center.alpha.alpha-one': 1,
      },
    };
    expect(answerNode(web, owning, 'dasher')).toEqual({
      node: 'fire.center.alpha.alpha-one',
      route: [],
    });
  });

  it('takes the nearest node that answers, not the first in web order; ties in web order', () => {
    // gamma-one answers dashers too: one purchase away once gamma's r1 and r2 are owned.
    const twice: AssembledWeb = {
      ...web,
      nodes: web.nodes.map((node) =>
        node.id === 'fire.center.gamma.gamma-one'
          ? { ...node, answers: [...node.answers, 'dasher'] }
          : node,
      ),
    };
    const near = { ...start, ranks: { 'fire.center.gamma.r1': 1, 'fire.center.gamma.r2': 1 } };
    expect(answerNode(twice, near, 'dasher')).toEqual({
      node: 'fire.center.gamma.gamma-one',
      route: ['fire.center.gamma.gamma-one'],
    });
    expect(answerNode(twice, start, 'dasher')?.node).toBe('fire.center.alpha.alpha-one');
  });
});

describe('the row units', () => {
  it("plans each live column on the 30-min snapshot, and the answer build of each judged ✗ but the treasure's", () => {
    const plan = planOf('B2');
    const units = rowUnits(plan, snapped(plan)).filter((unit) =>
      unit.id.startsWith('measure:enemyRow:'),
    );
    expect(units).toHaveLength((2 * ROW_ENEMIES.length + 4) * 8);
    const answers = new Set(
      units.filter((unit) => unit.id.includes(':answer:')).map((unit) => unit.id.slice(0, -2)),
    );
    expect([...answers]).toEqual([
      'measure:enemyRow:fire:dasher:answer',
      'measure:enemyRow:fire:summoner:answer',
      'measure:enemyRow:summon:shielder:answer',
      'measure:enemyRow:summon:dasher:answer',
    ]);
    expect(units[0]).toEqual({
      id: 'measure:enemyRow:fire:triangle:snapshot:0',
      job: {
        kind: 'measure',
        measure: 'enemyRow',
        input: {
          content: { fixture: 'B2' },
          character: 'fire',
          column: 'triangle',
          snapshot: auditStart(webOf({ fixture: 'B2' }, 'fire', 'full'), false),
          account: FRESH_ACCOUNT,
          answer: false,
          seed: 0,
        },
      },
    });
  });

  it('plans no unit of a column whose C7 part is pending, and no affix wave before C7.6', () => {
    const plan = planOf('B2', NO_C7);
    const units = rowUnits(plan, snapped(plan));
    const columns = new Set(
      units.flatMap((unit) =>
        unit.job.kind === 'measure' && 'column' in unit.job.input ? [unit.job.input.column] : [],
      ),
    );
    expect([...columns]).toEqual(['triangle', 'square', 'pentagon']);
    expect(units.some((unit) => unit.id.includes(':answer:'))).toBe(false);
    expect(units.some((unit) => unit.id.startsWith('measure:affix:'))).toBe(false);
  });

  it("plans each open outer's covered live columns, and once C7.6 is live the elite waves of each board", () => {
    const plan = planOf('B1', BASE_C7);
    const units = rowUnits(plan, snapped(plan));
    expect(
      units
        .filter((unit) => unit.id.startsWith('measure:outerRow:') && unit.id.endsWith(':0'))
        .map((unit) => unit.id.slice('measure:outerRow:fire:'.length, -2)),
    ).toEqual([
      'poison:triangle',
      'poison:square',
      'poison:pentagon',
      'poison:shielder',
      'crit:triangle',
      'crit:square',
      'crit:shielder',
      'ice:triangle',
      'ice:pentagon',
      'summon:triangle',
      'summon:pentagon',
      'summon:shielder',
    ]);
    expect(units.filter((unit) => unit.id.startsWith('measure:outerRow:'))).toHaveLength(12 * 8);
    expect(units.some((unit) => unit.id.startsWith('measure:affix:'))).toBe(false);
    const live = planOf('B1', ALL_C7);
    const affixes = rowUnits(live, snapped(live)).filter((unit) =>
      unit.id.startsWith('measure:affix:'),
    );
    expect(affixes).toHaveLength(5 * 2 * 8);
    expect([...new Set(affixes.map((unit) => unit.id.replace(/:\d+$/, '')))]).toEqual([
      'measure:affix:fire:center:plain',
      'measure:affix:fire:center:affixed',
      'measure:affix:fire:poison:plain',
      'measure:affix:fire:poison:affixed',
      'measure:affix:fire:crit:plain',
      'measure:affix:fire:crit:affixed',
      'measure:affix:fire:ice:plain',
      'measure:affix:fire:ice:affixed',
      'measure:affix:fire:summon:plain',
      'measure:affix:fire:summon:affixed',
    ]);
  });

  it('plans none without a DEAD_BOARD_MINUTES snapshot, nor in a set without the row checks', () => {
    const plan = planOf('B1');
    expect(rowUnits(plan, snapshotSessions(plan, 'prestige'))).toEqual([]);
    expect(rowUnits(plan, snapshotSessions(plan, 20))).toEqual([]);
    const pr = checkSet('pr', fixtureContent('B1'), { fixture: 'B1' }, { sessions: 1, c7: ALL_C7 });
    expect(rowUnits(pr, snapped(pr))).toEqual([]);
  });

  it('names each unit by what it reads alone: the same in any results order, plain data', () => {
    const plan = planOf('B2');
    const base = snapped(plan);
    const units = rowUnits(plan, base);
    expect(rowUnits(plan, Object.fromEntries(Object.entries(base).reverse()))).toEqual(units);
    expect(new Set(units.map((unit) => unit.id)).size).toBe(units.length);
    for (const unit of units) {
      if (unit.job.kind !== 'measure') throw new Error(unit.id);
      const { job } = unit;
      const input = job.input as Partial<EnemyRowInput & OuterRowInput & AffixInput>;
      const c = input.character as CharacterId;
      const s = input.seed as number;
      const id =
        job.measure === 'enemyRow'
          ? enemyRowUnitId(c, input.column as RowEnemy, input.answer === true, s)
          : job.measure === 'outerRow'
            ? outerRowUnitId(
                c,
                input.outer as NonNullable<typeof input.outer>,
                input.column as RowEnemy,
                s,
              )
            : affixUnitId(c, input.outer ?? null, input.affixed === true, s);
      expect(unit.id).toBe(id);
      expect(JSON.parse(JSON.stringify(unit))).toStrictEqual(unit);
    }
    expect(enemyRowUnitId('fire', 'boss', true, 7)).toBe('measure:enemyRow:fire:boss:answer:7');
    expect(outerRowUnitId('summon', 'fire', 'square', 0)).toBe(
      'measure:outerRow:summon:fire:square:0',
    );
    expect(affixUnitId('fire', null, true, 3)).toBe('measure:affix:fire:center:affixed:3');
  });

  it("gives each character's units that character's own snapshot, account and economy", () => {
    const plan = planOf('B2');
    const base = snapped(plan);
    const units = rowUnits(plan, base);
    for (const character of plan.characters) {
      const found = boardSnapshot(plan, base, character);
      if (found === null) throw new Error(character);
      const own = units.filter((unit) => unit.id.split(':')[2] === character);
      expect(own.length).toBeGreaterThan(0);
      for (const unit of own) {
        if (unit.job.kind !== 'measure') throw new Error(unit.id);
        const input = unit.job.input as Partial<EnemyRowInput & OuterRowInput>;
        expect(input.character).toBe(character);
        expect(input.snapshot).toEqual(found.snapshot.progress);
        expect(input.account).toEqual(found.account);
        if (unit.job.measure !== 'enemyRow') {
          expect(input.earned).toEqual(found.snapshot.earned);
          expect(input.economy).toEqual(found.economy);
        }
      }
    }
  });
});

describe('enemyRow (敵人對照表)', () => {
  it('is info (oneCharacter) with one built character, each pending column c7Pending', () => {
    const plan = planOf('B1', BASE_C7);
    const rows = enemyRowCheck(plan, rowResults(plan, { enemyRow: () => ({ clearSeconds: 8 }) }));
    expect(rows.map((row) => [row.subject, row.status, row.reason?.id ?? null])).toEqual([
      ['fire × triangle', 'info', null],
      ['fire × square', 'info', null],
      ['fire × pentagon', 'info', null],
      ['fire × shielder', 'info', null],
      ['all × regenerator', 'n/a', 'c7Pending'],
      ['all × dasher', 'n/a', 'c7Pending'],
      ['all × shooter', 'n/a', 'c7Pending'],
      ['all × summoner', 'n/a', 'c7Pending'],
      ['all × treasure', 'n/a', 'c7Pending'],
      ['all × boss', 'n/a', 'c7Pending'],
    ]);
    expect(ofCheck(rows, 'fire × square').measured).toBe(
      'time 8 s, damage 0, 0 leaks per 10 (medians 8 s, 0); oneCharacter: the median of one ' +
        'is itself, until B2 registers 蜂巢, the second character',
    );
    expect(ofCheck(rows, 'all × boss').reason).toEqual({
      id: 'c7Pending',
      detail: 'layersLeft (C7.7)',
    });
  });

  it('judges ✓ against the median over the characters, at ROW_STRONG_MIN exactly (OWN 3)', () => {
    // B3: 熔核, 霜晶 and 蜂巢; 霜晶 is ✓ against triangles, the other two △.
    const plan = planOf('B3');
    const timed = (ice: number) =>
      enemyRowCheck(
        plan,
        rowResults(plan, {
          enemyRow: ({ character, column }) =>
            column === 'triangle'
              ? { clearSeconds: { fire: 2, ice, summon: 30 }[character as 'fire'] }
              : {},
        }),
      );
    // The median is 2 (the mean 10.9): 0.8 is ROW_STRONG_MIN of it.
    expect(ofCheck(timed(0.8), 'ice × triangle').status).toBe('pass');
    expect(ofCheck(timed(0.79), 'ice × triangle').status).toBe('FAIL');
    expect(ofCheck(timed(0.8), 'fire × triangle').status).toBe('info');
    expect(ofCheck(timed(0.8), 'ice × triangle').measured).toBe(
      'time 0.8 s, damage 0, 0 leaks per 10 (medians 2 s, 0)',
    );
  });

  it('judges ✗ on the answer build, its time and damage within ROW_WEAK_MAX × the medians (OWN 3)', () => {
    // B2: 熔核 and 蜂巢 are both ✗ against dashers.
    const plan = planOf('B2');
    const results = (answerTime: number, answerDamage: number) =>
      rowResults(plan, {
        enemyRow: ({ character, column, answer }) => {
          if (column !== 'dasher') return {};
          if (answer) return { clearSeconds: answerTime, contact: answerDamage };
          return character === 'fire'
            ? { clearSeconds: 10, contact: 40 }
            : { clearSeconds: 20, contact: 20 };
        },
      });
    // Medians 15 s and 30: the bound is 37.5 s and 75.
    const status = (time: number, damage: number) =>
      ofCheck(enemyRowCheck(plan, results(time, damage)), 'fire × dasher').status;
    expect([status(37.5, 75), status(37.6, 75), status(37.5, 75.1)]).toEqual([
      'pass',
      'FAIL',
      'FAIL',
    ]);
    expect(ofCheck(enemyRowCheck(plan, results(37.5, 75)), 'fire × dasher').measured).toBe(
      'with fire.center.answer: time 37.5 s, damage 75, 0 leaks per 10 (medians 15 s, 30); ' +
        'without: time 10 s, damage 40, 0 leaks per 10',
    );
  });

  it('judges ✗ by leaks per 10 when the damage median is 0, on the answer build only (OWN 2)', () => {
    const plan = planOf('B2');
    const rows = enemyRowCheck(
      plan,
      rowResults(plan, {
        enemyRow: ({ character, column, answer }) => {
          if (column !== 'dasher') return {};
          if (!answer) return { leaks: character === 'fire' ? 10 : 0 };
          return { leaks: character === 'fire' ? 1 : 2, contact: 0 };
        },
      }),
    );
    // 熔核 leaks every dasher without its answer node and 1 in 10 with it.
    expect(ofCheck(rows, 'fire × dasher').status).toBe('pass');
    expect(ofCheck(rows, 'summon × dasher').status).toBe('FAIL');
  });

  it("is info for △ and the treasure's ✗, which is exempt; the treasure's ✓ is judged (OWN 3)", () => {
    const plan = planOf('B2');
    const rows = enemyRowCheck(
      plan,
      rowResults(plan, {
        enemyRow: ({ character, column }) =>
          column === 'treasure' ? { clearSeconds: character === 'fire' ? 60 : 1 } : {},
      }),
    );
    // 熔核 is ✗ against the treasure (exempt, gd:766) and has no answer build; 蜂巢 is ✓.
    expect(ofCheck(rows, 'fire × treasure')).toMatchObject({
      status: 'info',
      target: '✗ (寶藏怪 exempt, gd:766): info',
    });
    expect(ofCheck(rows, 'summon × treasure').status).toBe('FAIL');
    expect(ofCheck(rows, 'fire × triangle')).toMatchObject({ status: 'info', target: '△: info' });
  });

  it("judges the treasure's ✓ on catches: a wave the treasure fled reads 60 s, uncleared (lead ruling U18)", () => {
    // 蜂巢 is ✓ against the treasure: its waves end in 3 s, the treasure fleeing or caught;
    // 熔核 (✗, exempt) catches it in 40 s.
    const plan = planOf('B2');
    const summon = (kills: number): CheckResult =>
      ofCheck(
        enemyRowCheck(
          plan,
          rowResults(plan, {
            enemyRow: ({ character, column }) =>
              column !== 'treasure'
                ? {}
                : character === 'fire'
                  ? { clearSeconds: 40 }
                  : { clearSeconds: 3, count: 1, kills },
          }),
        ),
        'summon × treasure',
      );
    // Fled on every seed: 60 s against the median of 40 and 60, as an uncleared wave.
    expect(summon(0)).toMatchObject({
      status: 'pass',
      measured: 'time 60 s, damage 0, 0 leaks per 10 (8 of 8 uncleared) (medians 50 s, 0)',
    });
    // Caught on every seed: its 3 s against the median of 40 and 3, as C10.3 judges a clear time.
    expect(summon(1)).toMatchObject({
      status: 'FAIL',
      measured: 'time 3 s, damage 0, 0 leaks per 10 (medians 21.5 s, 0)',
    });
  });

  it('is noData while a seed or an answer reading is missing, or the answer was refused', () => {
    const plan = planOf('B2');
    const rows = enemyRowCheck(
      plan,
      rowResults(plan, {
        enemyRow: ({ character, column, answer, seed }) => {
          if (column === 'square' && character === 'fire' && seed === 7) return undefined;
          if (column === 'dasher' && answer) return character === 'fire' ? null : undefined;
          return {};
        },
      }),
    );
    expect(ofCheck(rows, 'fire × square').reason).toEqual({
      id: 'noData',
      detail: '7 of 8 seeds measured',
    });
    // The median needs every character: 蜂巢's square is unjudged too.
    expect(ofCheck(rows, 'summon × square').reason?.detail).toBe(
      'the median needs every built character’s reading',
    );
    expect(ofCheck(rows, 'fire × dasher').reason?.detail).toBe(
      'no test wave: fire.center.answer: hidden',
    );
    expect(ofCheck(rows, 'summon × dasher').reason?.detail).toBe('0 of 8 seeds measured');
    // A plan with no 30-min snapshot reads nothing.
    const none = enemyRowCheck(plan, snapshotSessions(plan, 'prestige'));
    expect(ofCheck(none, 'fire × square').reason?.detail).toBe(
      'no default session of fire has a 30-min snapshot',
    );
  });

  it('writes enemy_row.csv: one line per character, column, build and seed', () => {
    const plan = planOf('B1', BASE_C7);
    const csv = enemyRowCsv(plan, rowResults(plan, { enemyRow: () => ({ bullet: 2 }) }));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(
      'character,column,mark,build,seed,node,purchases,refused,clearSeconds,cleared,died,count,' +
        'leaks,kills,contact,bullet,session',
    );
    expect(lines).toHaveLength(1 + 4 * 8);
    expect(lines[1]).toBe('fire,triangle,even,snapshot,0,,,,10,true,false,10,0,10,0,2,0');
  });
});

describe('outerRow (外盤能補的敵人)', () => {
  const plan = planOf('B1', BASE_C7);
  const withOuter = (time: number, damage: number): UnitResults =>
    rowResults(plan, {
      enemyRow: () => ({ clearSeconds: 10, contact: 10 }),
      outerRow: ({ outer, column }) =>
        outer === 'poison' && column === 'triangle'
          ? { clearSeconds: time, contact: damage }
          : { clearSeconds: 10, contact: 10 },
    });

  it("judges each open outer's covered live columns with its investment, real with one character (OWN 4)", () => {
    const rows = outerRowCheck(plan, withOuter(8, 10));
    expect(rows.map((row) => row.subject)).toEqual([
      'fire × outer.poison × triangle',
      'fire × outer.poison × square',
      'fire × outer.poison × pentagon',
      'fire × outer.poison × shielder',
      'fire × outer.crit × triangle',
      'fire × outer.crit × square',
      'fire × outer.crit × shielder',
      'fire × outer.ice × triangle',
      'fire × outer.ice × pentagon',
      'fire × outer.summon × triangle',
      'fire × outer.summon × pentagon',
      'fire × outer.summon × shielder',
      'all × regenerator',
      'all × dasher',
      'all × shooter',
      'all × summoner',
      'all × treasure',
      'all × boss',
    ]);
    expect(ofCheck(rows, 'fire × outer.poison × triangle')).toMatchObject({
      status: 'pass',
      target: '◆ triangle: time or damage −20% or more (初始門檻)',
      measured: 'time 10 s → 8 s (−20%), damage 10 → 10 (±0%); 1 bought, 1 unpaid',
    });
    expect(ofCheck(rows, 'fire × outer.poison × square')).toMatchObject({
      status: 'FAIL',
      target: '＋ square: time or damage −20% or more (初始門檻)',
    });
    expect(ofCheck(rows, 'all × dasher').reason).toEqual({
      id: 'c7Pending',
      detail: 'state (C7.4a)',
    });
    const status = (time: number, damage: number) =>
      ofCheck(outerRowCheck(plan, withOuter(time, damage)), 'fire × outer.poison × triangle')
        .status;
    expect([status(8.01, 10), status(7.99, 10), status(10, 8), status(10, 8.01)]).toEqual([
      'FAIL',
      'pass',
      'pass',
      'FAIL',
    ]);
  });

  it('is noData while a reading is missing', () => {
    const rows = outerRowCheck(
      plan,
      rowResults(plan, {
        enemyRow: ({ column, seed }) => (column === 'square' && seed === 3 ? undefined : {}),
        outerRow: ({ outer }) => (outer === 'ice' ? undefined : {}),
      }),
    );
    expect(ofCheck(rows, 'fire × outer.poison × square').reason?.detail).toBe(
      'without: 7 of 8 seeds measured',
    );
    expect(ofCheck(rows, 'fire × outer.ice × triangle').reason?.detail).toBe(
      'with: 0 of 8 seeds measured',
    );
  });

  it('writes outer_row.csv: one line per character, outer, covered column and seed', () => {
    const csv = outerRowCsv(plan, withOuter(8, 10));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(
      'character,outer,column,cover,seed,bought,unpaid,refused,clearSeconds,cleared,died,count,' +
        'leaks,kills,contact,bullet,session',
    );
    expect(lines).toHaveLength(1 + 12 * 8);
    expect(lines[1]).toBe(
      'fire,poison,triangle,answer,0,outer.poison.main.entry,outer.poison.alpha.r1,' +
        'outer.poison.alpha.r1: notEnoughShards,8,true,false,10,0,10,10,,0',
    );
  });
});

describe('affixes (菁英詞綴)', () => {
  it('is c7Pending: affixes (C7.6) before C7.6', () => {
    const plan = planOf('B1', BASE_C7);
    expect(affixesCheck(plan, snapped(plan))).toEqual([
      {
        id: 'affixes',
        set: 'nightly',
        name: '菁英詞綴',
        source: 'gd:769',
        subject: 'all',
        target: expect.stringContaining("L6's proxy") as string,
        measured: '—',
        status: 'n/a',
        reason: { id: 'c7Pending', detail: 'affixes (C7.6)' },
        evidence: [],
      },
    ]);
  });

  // B1 with every part live: 熔核's center and its four outers, 8 seeds each. Seed s's affixed
  // elite draws affix s (bit s), so each affix is read on one seed a board.
  const plan = planOf('B1', ALL_C7);
  const results = (kill: (board: string, affix: number) => Partial<TestWaveReading>) =>
    rowResults(plan, {
      affix: ({ outer, affixed, seed }) => ({
        bits: affixed ? 1 << seed : 0,
        run: affixed ? kill(outer ?? 'center', seed) : { clearSeconds: 10 },
      }),
    });

  it('counters an affix on a board at r = affixed ÷ plain kill time ≤ AFFIX_RATIO_MAX (OWN 7)', () => {
    // swift: three boards at 1.5 pass; armoured: 2 everywhere fails; regen: a leaked elite is
    // killed at ENEMY_ROW_MAX_SECONDS, whatever its clear time.
    const rows = affixesCheck(
      plan,
      results((board, affix) => {
        if (affix === 0)
          return { clearSeconds: ['center', 'ice', 'crit'].includes(board) ? 15 : 16 };
        if (affix === 1) return { clearSeconds: 20 };
        if (affix === 2) return { clearSeconds: 12, leaks: board === 'center' ? 0 : 1 };
        return { clearSeconds: 10 };
      }),
    );
    expect(rows.map((row) => [row.subject, row.status])).toEqual([
      ['swift', 'pass'],
      ['armoured', 'FAIL'],
      ['regen', 'FAIL'],
      ['guardian', 'pass'],
      ['multiply', 'pass'],
      ['berserk', 'pass'],
      ['ward', 'pass'],
      ['frost', 'pass'],
    ]);
    expect(ofCheck(rows, 'swift').measured).toBe(
      '3 countering boards (fire.center, outer.crit, outer.ice); one for every character',
    );
    expect(ofCheck(rows, 'regen').measured).toBe(
      '1 countering boards (fire.center); one for every character',
    );
  });

  it("reads r_b(a) from the median kill time of a board's seeds that drew a, not their mean", () => {
    // Seeds 0-2 of every board draw swift, killed at 10, 10 and 40 s against a plain 10 s: the
    // median gives r = 1 (countering) where the mean, 20 s, would give r = 2 (L6).
    const rows = affixesCheck(
      plan,
      rowResults(plan, {
        affix: ({ affixed, seed }) => ({
          bits: affixed ? (seed < 3 ? 1 : 1 << seed) : 0,
          run: { clearSeconds: affixed && seed === 2 ? 40 : 10 },
        }),
      }),
    );
    expect(ofCheck(rows, 'swift')).toMatchObject({
      status: 'pass',
      measured:
        '5 countering boards (fire.center, outer.poison, outer.crit, outer.ice, outer.summon); ' +
        'one for every character',
    });
  });

  it('counters no affix on a board whose plain median kill time is censored (lead ruling U19)', () => {
    // No board kills its plain elite (60 s, uncleared): an affixed elite killed in 10 s, or never,
    // reads no ratio below AFFIX_RATIO_MAX, so no board counters an affix.
    for (const affixed of [
      { clearSeconds: 10 },
      { clearSeconds: ENEMY_ROW_MAX_SECONDS, cleared: false },
    ]) {
      const rows = affixesCheck(
        plan,
        rowResults(plan, {
          affix: ({ affixed: drew, seed }) => ({
            bits: drew ? 1 << seed : 0,
            run: drew ? affixed : { clearSeconds: ENEMY_ROW_MAX_SECONDS, cleared: false },
          }),
        }),
      );
      expect(ofCheck(rows, 'swift')).toMatchObject({
        status: 'FAIL',
        measured: '0 countering boards; none for fire',
      });
    }
    // The center alone kills its plain elite in 10 s: it alone counters.
    const center = affixesCheck(
      plan,
      rowResults(plan, {
        affix: ({ outer, affixed: drew, seed }) => ({
          bits: drew ? 1 << seed : 0,
          run:
            drew || outer === null
              ? { clearSeconds: 10 }
              : { clearSeconds: ENEMY_ROW_MAX_SECONDS, cleared: false },
        }),
      }),
    );
    expect(ofCheck(center, 'swift').measured).toBe(
      '1 countering boards (fire.center); one for every character',
    );
  });

  it('is noData for an affix no elite drew, or a board missing a plain seed', () => {
    const rows = affixesCheck(
      plan,
      rowResults(plan, {
        affix: ({ affixed, seed }) => ({
          bits: affixed ? 1 << (seed % 4) : 0,
          run: { clearSeconds: 10 },
        }),
      }),
    );
    expect(ofCheck(rows, 'swift').status).toBe('pass');
    expect(ofCheck(rows, 'frost')).toMatchObject({
      status: 'n/a',
      reason: { id: 'noData', detail: '5 of 5 boards have no frost elite or no plain reading' },
    });
    // The center's plain seed 0 unread: only the center would counter, so the rule waits for it.
    const unread = affixesCheck(
      plan,
      rowResults(plan, {
        affix: ({ outer, affixed, seed }) =>
          outer === null && !affixed && seed === 0
            ? undefined
            : {
                bits: affixed ? 1 << seed : 0,
                run: { clearSeconds: affixed && outer !== null ? 20 : 10 },
              },
      }),
    );
    expect(ofCheck(unread, 'swift')).toMatchObject({
      status: 'n/a',
      measured: '0 countering boards; none for fire',
      reason: { id: 'noData', detail: '1 of 5 boards have no swift elite or no plain reading' },
    });
  });

  it('writes affixes.csv: one line per character, board, variant and seed', () => {
    const csv = affixesCsv(
      plan,
      results(() => ({ clearSeconds: 12, leaks: 1 })),
    );
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(
      'character,board,variant,seed,affixes,bought,unpaid,refused,clearSeconds,cleared,leaks,' +
        'killSeconds,session',
    );
    expect(lines).toHaveLength(1 + 5 * 2 * 8);
    expect(lines[1]).toBe('fire,fire.center,plain,0,,,,,10,true,0,10,0');
    expect(lines[9]).toBe('fire,fire.center,affixed,0,swift,,,,12,true,1,60,0');
  });
});

describe("the nightly plan with C10.3's units", () => {
  /** A stub pool: sessions with a 30-min snapshot, every row measure a 10 s wave, every board x 30. */
  const stub: RunJobs = (jobs, workers) =>
    Promise.resolve({
      results: jobs.map((job: BalanceJob): JobResult => {
        if (job.kind === 'character') {
          const { character, session } = job.config;
          const progress = auditStart(webOf(job.config.content, character, 'full'), false);
          return {
            kind: 'character',
            result: sessionResult(character, session, {
              snapshots: [
                { minutes: DEAD_BOARD_MINUTES, progress, earned: { shards: 0, cores: 0 } },
              ],
            }),
          };
        }
        if (job.kind !== 'measure') throw new Error(job.kind);
        const run = testWave();
        const parts = { bought: [], unpaid: [], refused: null };
        if (job.measure === 'enemyRow') {
          const { character, column, answer, seed } = job.input as EnemyRowInput;
          const result = { character, column, answer, seed, node: null, purchases: [], run };
          return { kind: 'measure', measure: 'enemyRow', result: { ...result, refused: null } };
        }
        if (job.measure === 'outerRow') {
          const { character, outer, column, seed } = job.input as OuterRowInput;
          const result = { character, outer, column, seed, ...parts, run };
          return { kind: 'measure', measure: 'outerRow', result };
        }
        if (job.measure === 'deadBoard') {
          const { character, outer, seed } = job.input as DeadBoardInput;
          const result = { character, outer, seed, x: 30, ...parts };
          return { kind: 'measure', measure: 'deadBoard', result };
        }
        throw new Error(`unexpected measure ${job.measure}`);
      }),
      mode: workers > 1 ? 'workers' : 'in-process',
      workers,
      fallbackReason: null,
    });

  it('runs the row and board measures in the second phase, the same results on 1 and 4 workers', async () => {
    const nightly = checkSet(
      'nightly',
      fixtureContent('B2'),
      { fixture: 'B2' },
      {
        sessions: 2,
        minutes: 35,
        c7: BASE_C7,
      },
    );
    // The sessions alone: the stub plays no first-phase measure (C10.4's doubles, M1 diffs, fuzz).
    const plan = {
      ...nightly,
      units: nightly.units.filter((unit) => unit.job.kind === 'character'),
    };
    const [one, four] = [
      await runPlan(plan, 1, () => {}, stub),
      await runPlan(plan, 4, () => {}, stub),
    ];
    expect(Object.keys(four.results)).toEqual(Object.keys(one.results));
    expect(four.results).toEqual(one.results);
    const derived = derivedUnits(plan, one.results);
    const kinds = derived.map((unit) =>
      unit.job.kind === 'measure' ? unit.job.measure : 'session',
    );
    // Per character: the 4 live columns on the snapshot (and 蜂巢's ✗ shielder with its answer);
    // its four outers' 12 covered live columns; and the base and the four outers, 8 seeds each.
    expect(kinds.filter((kind) => kind === 'enemyRow')).toHaveLength((2 * 4 + 1) * 8);
    expect(kinds.filter((kind) => kind === 'outerRow')).toHaveLength((12 + 12) * 8);
    expect(kinds.filter((kind) => kind === 'deadBoard')).toHaveLength(2 * 5 * 8);
    expect(evaluate(plan, one.results)).toEqual(evaluate(plan, four.results));
  });
});
