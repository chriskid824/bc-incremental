/**
 * 預算報告, the budget report (docs/v3 C10 design §2.2's budget row; impl:490): over each
 * character's default runs, each budget and cap counter's sum and the share of runs with any, as
 * info; effectsDropped above 0 FAILs (C3D:1777). The counters are read by name from each run's
 * result.counters (tools/balance/v3/session.ts' budgetOf), so one a run lacks prints "—". For 熔核,
 * the most bombs in one second of a run (the run rows' bombsPeak) as info against the stress rate.
 */

import { CHAIN_HIT_CAP, PROJECTILE_CAP, SUMMON_CAP } from '../../../../src/sim/caps';
import { EFFECTS_PER_TICK } from '../../../../src/sim/effects/types';
import type { BudgetCounter, CharacterRunRow } from '../session';
import { checkRow, defaultSessions, naRow } from './types';
import type { CheckPlan, CheckResult, UnitResults } from './types';

/**
 * C4D:3127 (the C4 design's C10 hand-off; 初始值): the stress scenario's 12 bombs a second, which
 * 三連擊, 無盡連擊 and projectileCount content may pass; `stress` is re-recorded if a run does.
 */
export const BOMBS_STRESS_RATE = 12;

/** The info counters in the report's order, each with what it counts. */
export const BUDGET_INFO: readonly { readonly counter: BudgetCounter; readonly what: string }[] = [
  {
    counter: 'effectBudgetTicks',
    what: `ticks past EFFECTS_PER_TICK (${EFFECTS_PER_TICK} effects a tick)`,
  },
  { counter: 'summonCapped', what: `drones refused at SUMMON_CAP ${SUMMON_CAP} (C5D:1483)` },
  { counter: 'chainHitCapped', what: `chain jumps refused at CHAIN_HIT_CAP ${CHAIN_HIT_CAP}` },
  { counter: 'projectilesCapped', what: `projectiles refused at PROJECTILE_CAP ${PROJECTILE_CAP}` },
  { counter: 'enemyCapDelayed', what: 'enemies the enemy cap delayed (C7.5)' },
  { counter: 'enemySpawnsSkipped', what: 'enemy-made spawns the enemy cap refused (C7.5)' },
];

/** Σ of a counter over runs and the runs with any; null when a run lacks the counter. */
function tally(
  runs: readonly CharacterRunRow[],
  counter: BudgetCounter,
): { readonly sum: number; readonly runs: number } | null {
  let sum = 0;
  let any = 0;
  for (const run of runs) {
    const value = run.budget[counter];
    if (value === null) return null;
    sum += value;
    if (value > 0) any += 1;
  }
  return { sum, runs: any };
}

const share = (part: number, whole: number): string =>
  `${part} of ${whole} runs (${whole === 0 ? 0 : Number(((part / whole) * 100).toFixed(1))} %)`;

/** The budget rows: per character, effectsDropped, the info counters, and for 熔核 the bombs. */
export function budgetCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  return plan.characters.flatMap((character) => {
    const runs = defaultSessions(plan, results, character).flatMap((result) => result.rows);
    const evidence = [`budget.csv: ${character} default`];
    const dropsTarget = 'Σ effectsDropped = 0 (C3D:1777)';
    if (runs.length === 0) {
      return [
        naRow(
          'budget',
          plan.set,
          `${character} × effectsDropped`,
          dropsTarget,
          'noData',
          'no default run',
        ),
      ];
    }
    const rows: CheckResult[] = [];
    const drops = tally(runs, 'effectsDropped');
    rows.push(
      drops === null
        ? naRow(
            'budget',
            plan.set,
            `${character} × effectsDropped`,
            dropsTarget,
            'noData',
            'the runs have no effectsDropped counter',
          )
        : checkRow('budget', plan.set, {
            subject: `${character} × effectsDropped`,
            target: dropsTarget,
            measured: `Σ ${drops.sum}; ${share(drops.runs, runs.length)}`,
            status: drops.sum > 0 ? 'FAIL' : 'pass',
            evidence,
          }),
    );
    for (const { counter, what } of BUDGET_INFO) {
      const counted = tally(runs, counter);
      rows.push(
        checkRow('budget', plan.set, {
          subject: `${character} × ${counter}`,
          target: `info: ${what}`,
          measured:
            counted === null ? '—' : `Σ ${counted.sum}; ${share(counted.runs, runs.length)}`,
          status: 'info',
          evidence,
        }),
      );
    }
    if (character === 'fire') {
      const peak = Math.max(...runs.map((run) => run.bombsPeak));
      rows.push(
        checkRow('budget', plan.set, {
          subject: `${character} × bombs`,
          target:
            `info: the most bombs in one second of a run, against the stress rate ` +
            `${BOMBS_STRESS_RATE}/s (C4D:3127)`,
          measured:
            `${peak}/s at most over ${runs.length} runs` +
            (peak > BOMBS_STRESS_RATE ? `; past ${BOMBS_STRESS_RATE}/s: re-record stress` : ''),
          status: 'info',
          evidence: ['budget.csv: fire default bombsPeak'],
        }),
      );
    }
    return rows;
  });
}
