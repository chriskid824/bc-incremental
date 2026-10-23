import { describe, expect, it } from 'vitest';
import { fixtureContent } from '../../../../src/data/web/testing';
import { BUDGET_COUNTERS } from '../session';
import type { BudgetCounter, CharacterRunRow } from '../session';
import { BOMBS_STRESS_RATE, BUDGET_INFO, budgetCheck } from './budget';
import { checkSet } from './run';
import { NO_C7, runRow, sessionResult, sessionResults } from './testing';
import type { CheckResult } from './types';

const plan = checkSet('nightly', fixtureContent('B2'), { fixture: 'B2' }, { c7: NO_C7 });

/** Budget counters all 0 but `counters`. */
const counters = (
  values: Partial<Record<BudgetCounter, number | null>>,
): Record<BudgetCounter, number | null> => {
  const budget = {} as Record<BudgetCounter, number | null>;
  for (const name of BUDGET_COUNTERS) budget[name] = values[name] ?? 0;
  for (const [name, value] of Object.entries(values)) budget[name as BudgetCounter] = value;
  return budget;
};

/** 熔核's and 蜂巢's default sessions: two each, two runs each, of `rows(character)`. */
const check = (row: (character: 'fire' | 'summon') => Partial<CharacterRunRow>): CheckResult[] =>
  budgetCheck(
    plan,
    sessionResults(
      (['fire', 'summon'] as const).flatMap((character) =>
        [0, 1].map((session) =>
          sessionResult(character, session, {
            rows: [
              runRow({ character, session, ...row(character) }),
              runRow({ character, session, run: 2 }),
            ],
          }),
        ),
      ),
    ),
  );

const rowOf = (rows: readonly CheckResult[], subject: string): CheckResult | undefined =>
  rows.find((row) => row.subject === subject);

describe('budget (預算報告)', () => {
  it('FAILs a character with one effect dropped and passes it with none, whatever the other counters', () => {
    const dropped = check((c) => ({
      budget: counters(c === 'fire' ? { effectsDropped: 1 } : {}),
    }));
    expect(rowOf(dropped, 'fire × effectsDropped')).toMatchObject({
      status: 'FAIL',
      measured: 'Σ 2; 2 of 4 runs (50 %)',
      target: 'Σ effectsDropped = 0 (C3D:1777)',
    });
    expect(rowOf(dropped, 'summon × effectsDropped')?.status).toBe('pass');
    const busy = check(() => ({
      budget: counters({
        effectBudgetTicks: 9,
        summonCapped: 9,
        chainHitCapped: 9,
        projectilesCapped: 9,
        enemyCapDelayed: 9,
        enemySpawnsSkipped: 9,
      }),
    }));
    expect(rowOf(busy, 'fire × effectsDropped')).toMatchObject({
      status: 'pass',
      measured: 'Σ 0; 0 of 4 runs (0 %)',
    });
  });

  it("reports each other counter's sum and runs as info, — where the runs lack it", () => {
    const rows = check(() => ({
      budget: counters({ summonCapped: 3, enemyCapDelayed: null, enemySpawnsSkipped: null }),
    }));
    expect(
      rows.filter((row) => row.subject.startsWith('summon ×')).map((row) => row.subject),
    ).toEqual([
      'summon × effectsDropped',
      ...BUDGET_INFO.map(({ counter }) => `summon × ${counter}`),
    ]);
    expect(rowOf(rows, 'fire × summonCapped')).toMatchObject({
      status: 'info',
      measured: 'Σ 6; 2 of 4 runs (50 %)',
      target: 'info: drones refused at SUMMON_CAP 24 (C5D:1483)',
    });
    expect(rowOf(rows, 'fire × enemyCapDelayed')).toMatchObject({ status: 'info', measured: '—' });
    expect(rowOf(rows, 'fire × effectBudgetTicks')?.target).toBe(
      'info: ticks past EFFECTS_PER_TICK (2000 effects a tick)',
    );
    expect(rowOf(rows, 'fire × chainHitCapped')?.target).toContain('CHAIN_HIT_CAP 32');
    expect(rowOf(rows, 'fire × projectilesCapped')?.target).toContain('PROJECTILE_CAP 512');
  });

  it('prints a counter the runs keep at 0 as Σ 0, apart from one they lack', () => {
    const rows = check(() => ({ budget: counters({ enemySpawnsSkipped: null }) }));
    expect(rowOf(rows, 'fire × enemyCapDelayed')).toMatchObject({
      status: 'info',
      measured: 'Σ 0; 0 of 4 runs (0 %)',
    });
    expect(rowOf(rows, 'fire × enemySpawnsSkipped')?.measured).toBe('—');
  });

  it("prints 熔核's most bombs in one second as info against the stress rate", () => {
    const rows = check((c) => ({ bombs: 40, bombsPeak: c === 'fire' ? 13 : 99 }));
    expect(rowOf(rows, 'fire × bombs')).toMatchObject({
      status: 'info',
      measured: `13/s at most over 4 runs; past ${BOMBS_STRESS_RATE}/s: re-record stress`,
      target:
        'info: the most bombs in one second of a run, against the stress rate 12/s (C4D:3127)',
    });
    expect(rowOf(rows, 'summon × bombs')).toBeUndefined();
    expect(
      rowOf(
        check(() => ({ bombsPeak: 12 })),
        'fire × bombs',
      )?.measured,
    ).toBe('12/s at most over 4 runs');
  });

  it('is noData for a character without default runs', () => {
    expect(budgetCheck(plan, {})).toMatchObject([
      { subject: 'fire × effectsDropped', status: 'n/a', reason: { id: 'noData' } },
      { subject: 'summon × effectsDropped', status: 'n/a', reason: { id: 'noData' } },
    ]);
  });
});
