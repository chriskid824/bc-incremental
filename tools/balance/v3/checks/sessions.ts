/**
 * The checks that read character sessions (docs/v3 C10 design §2.2): 前線節奏, 前兩小時, 新手公平,
 * 角色公平, 中心主體性, 一輪轉生的點數, 傳承, 遊玩時間 and 轉生後回到最遠波次. Each reads the
 * default sessions of the plan's characters (傳承 also the legacy sessions), takes medians over
 * sessions, and counts a milestone a session never reaches as never (∞). Before B2 a session stops
 * at its first prestige point, so what lies past it is noPrestige.
 */

import { PACING_TOLERANCE } from '../../../../src/data';
import type { CharacterId } from '../../../../src/data';
import { median } from '../../../../src/meta/web/calibrate';
import { toCsv } from '../../csv';
import type { CsvValue } from '../../csv';
import type { LegacyHook } from '../legacy';
import { characterCurvePoints, characterRowAt } from '../report';
import { centerShareOf, CLEAR_WAVE, PRESTIGE_WAVE } from '../session';
import type { CharacterRunRow, CharacterSessionResult } from '../session';
import {
  CENTER_SHARE_MIN,
  CENTER_SHARE_WAVE,
  FAIRNESS_MAX,
  FAIRNESS_WAVES,
  FIRST_HOURS,
  FIRST_HOURS_TOLERANCE,
  LEGACY_MAX,
  LEGACY_WAVE,
  NEWBIE_BAND,
  NEWBIE_MINUTES,
  PLAY_TIME_MINUTES,
  POINT_BUDGET,
  PRESTIGE_RETURN_MAX,
  V3_PACING_TARGETS,
} from './targets';
import type { FirstHoursMilestone } from './targets';
import {
  checkRow,
  defaultSessions,
  FRESH_ACCOUNT,
  legacyUnitId,
  naRow,
  sessionConfigOf,
  sessionResultOf,
  sessionUnitId,
} from './types';
import type { CheckPlan, CheckResult, PlanUnit, UnitResults } from './types';

/** A number as the report prints it: at most `digits` decimals, ∞ for never, — for none. */
export const num = (value: number, digits = 1): string =>
  Number.isNaN(value) ? '—' : Number.isFinite(value) ? String(Number(value.toFixed(digits))) : '∞';

/** A share as a percentage with one decimal. */
const pct = (value: number): string => `${num(value * 100)} %`;

/** Minutes as h:mm, gd §9's form. */
const clock = (minutes: number): string =>
  `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

const PRESTIGE_STOP = `a session stops at its first prestige point (wave ${PRESTIGE_WAVE}) until B2`;

/** The median over sessions of a session's minutes to `wave`, a session never there counting ∞. */
export function medianMinutesToWave(
  sessions: readonly CharacterSessionResult[],
  wave: number,
): number {
  return median(sessions.map((result) => result.milestones.minutesToWave[wave] ?? Infinity));
}

// ---- 前線節奏 ----

/**
 * Per character and V3_PACING_TARGETS minute m: the default sessions' median bestWave at m (the
 * last row ending by m, a session stopped at its prestige point carried; v3/report.ts'
 * characterCurvePoints) within ±PACING_TOLERANCE of the target. Past wave 30, noPrestige until B2.
 */
export function pacingCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const band = `±${num(PACING_TOLERANCE * 100)}%`;
  return plan.characters.flatMap((character) => {
    const points = characterCurvePoints(defaultSessions(plan, results, character));
    return V3_PACING_TARGETS.map((goal, index) => {
      const subject = `${character} @ ${goal.minutes} min`;
      const target = `bestWave ${goal.frontierWave} ${band} (初始值)`;
      if (!plan.prestige && goal.frontierWave > PRESTIGE_WAVE) {
        return naRow('pacing', plan.set, subject, target, 'noPrestige', PRESTIGE_STOP);
      }
      const point = points[index];
      if (point === undefined || point.sessions === 0) {
        const detail = `no default session is read at ${goal.minutes} min`;
        return naRow('pacing', plan.set, subject, target, 'noData', detail);
      }
      return checkRow('pacing', plan.set, {
        subject,
        target,
        measured:
          `median ${num(point.waveMedian)} over ${point.sessions} sessions` +
          (point.carried > 0 ? ` (${point.carried} carried past their end)` : ''),
        status: point.withinTolerance === true ? 'pass' : 'FAIL',
        evidence: [`curve_check.csv: ${character} default ${goal.minutes}`],
      });
    });
  });
}

// ---- 前兩小時 ----

/** A session's minutes to a FIRST_HOURS milestone; ∞ when it never gets there. */
export function minutesTo(result: CharacterSessionResult, milestone: FirstHoursMilestone): number {
  const { milestones } = result;
  const minutes =
    milestone === 'prestigePoint'
      ? milestones.prestigePoint?.minutes
      : milestone === 'wall'
        ? milestones.wall?.minutes
        : milestones[milestone];
  return minutes ?? Infinity;
}

/** milestones.csv's column of each milestone. */
const MILESTONE_COLUMNS: Readonly<Record<FirstHoursMilestone, string>> = {
  firstOuterNode: 'firstOuterNode',
  firstFusionCore: 'firstFusionCore',
  firstKeystoneAffordable: 'firstKeystoneAffordable',
  prestigePoint: 'prestigeMinutes',
  centerThreshold: 'centerThreshold',
  wall: 'wallMinutes',
};

/**
 * Per character and FIRST_HOURS milestone: the default sessions' median minutes to it within
 * FIRST_HOURS_TOLERANCE of gd §9's time (a range widened at both ends); the wall's median wave,
 * over the sessions that hit one, within its waves. Milestones after the first prestige are
 * noPrestige until B2.
 */
export function firstHoursCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const tolerance = FIRST_HOURS_TOLERANCE;
  return plan.characters.flatMap((character) => {
    const sessions = defaultSessions(plan, results, character);
    return FIRST_HOURS.map((item) => {
      const [from, to] = item.minutes;
      const lo = from * (1 - tolerance);
      const hi = to * (1 + tolerance);
      const subject = `${character} × ${item.label}`;
      const target =
        `${clock(from)}${from === to ? '' : `–${clock(to)}`} ±${num(tolerance * 100)}% ` +
        `(${num(lo)}–${num(hi)} min)` +
        (item.waves === undefined ? '' : ` at waves ${item.waves[0]}–${item.waves[1]}`) +
        ' (初始值)';
      if (item.afterPrestige && !plan.prestige) {
        const detail = `gd §9 puts it after the first prestige; ${PRESTIGE_STOP}`;
        return naRow('firstHours', plan.set, subject, target, 'noPrestige', detail);
      }
      if (sessions.length === 0) {
        return naRow('firstHours', plan.set, subject, target, 'noData', 'no default session');
      }
      const times = sessions.map((result) => minutesTo(result, item.milestone));
      const mid = median(times);
      const reached = times.filter(Number.isFinite).length;
      let inRange = mid >= lo && mid <= hi;
      let wave = '';
      if (item.waves !== undefined) {
        const walls = sessions.flatMap((result) =>
          result.milestones.wall === null ? [] : [result.milestones.wall.wave],
        );
        const midWave = walls.length === 0 ? NaN : median(walls);
        inRange = inRange && midWave >= item.waves[0] && midWave <= item.waves[1];
        wave = `, wave ${num(midWave)}`;
      }
      return checkRow('firstHours', plan.set, {
        subject,
        target,
        measured: `median ${num(mid)} min${wave} (${reached} of ${sessions.length} sessions get there)`,
        status: inRange ? 'pass' : 'FAIL',
        evidence: [`milestones.csv: ${character} default ${MILESTONE_COLUMNS[item.milestone]}`],
      });
    });
  });
}

// ---- 新手公平 ----

/** A character's front at `minutes`: its default sessions' median bestWave there; NaN with none read. */
export function frontAt(sessions: readonly CharacterSessionResult[], minutes: number): number {
  const waves = sessions.flatMap((result) => {
    const found = characterRowAt(result, minutes);
    return found === null ? [] : [found.row.bestWave];
  });
  return waves.length === 0 ? NaN : median(waves);
}

/**
 * At each NEWBIE_MINUTES minute: every character's front from 0 talents (its default sessions),
 * and the largest |front − median| ÷ median over the characters ≤ NEWBIE_BAND. One character:
 * oneCharacter, its front shown.
 */
export function newbieCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const sessions = plan.characters.map(
    (character) => [character, defaultSessions(plan, results, character)] as const,
  );
  return NEWBIE_MINUTES.map((minutes) => {
    const subject = `all @ ${minutes} min`;
    const target = `max |front − median| ÷ median ≤ ${NEWBIE_BAND} over the characters (初始值)`;
    const fronts = sessions.map(([character, list]) => ({
      character,
      front: frontAt(list, minutes),
    }));
    const shown = fronts.map(({ character, front }) => `${character} ${num(front)}`).join(', ');
    if (fronts.length < 2) {
      const detail = 'one character has a center: there is no second front to compare';
      return naRow('newbie', plan.set, subject, target, 'oneCharacter', detail, `fronts ${shown}`);
    }
    if (fronts.some(({ front }) => Number.isNaN(front))) {
      const detail = `a character has no default session read at ${minutes} min`;
      return naRow('newbie', plan.set, subject, target, 'noData', detail, `fronts ${shown}`);
    }
    const mid = median(fronts.map(({ front }) => front));
    const worst = Math.max(...fronts.map(({ front }) => Math.abs(front - mid) / mid));
    return checkRow('newbie', plan.set, {
      subject,
      target,
      measured: `${num(worst, 3)} (fronts ${shown}; median ${num(mid)})`,
      status: worst <= NEWBIE_BAND ? 'pass' : 'FAIL',
      evidence: [`curve_check.csv: default ${minutes}`],
    });
  });
}

// ---- 角色公平 ----

/**
 * At each FAIRNESS_WAVES wave: each character's median minutes to it over its default sessions,
 * and the slowest ÷ the fastest ≤ FAIRNESS_MAX. One character: oneCharacter; wave 60 is
 * noPrestige until B2.
 */
export function characterFairnessCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const sessions = plan.characters.map(
    (character) => [character, defaultSessions(plan, results, character)] as const,
  );
  return FAIRNESS_WAVES.map((wave) => {
    const subject = `all × wave ${wave}`;
    const target = `slowest ÷ fastest median minutes to wave ${wave} ≤ ${FAIRNESS_MAX} (初始值)`;
    const times = sessions.map(([character, list]) => ({
      character,
      minutes: list.length === 0 ? NaN : medianMinutesToWave(list, wave),
    }));
    const shown = times.map(({ character, minutes }) => `${character} ${num(minutes)}`).join(', ');
    if (times.length < 2) {
      const detail = 'one character has a center: there is no second to compare';
      return naRow('characterFairness', plan.set, subject, target, 'oneCharacter', detail, shown);
    }
    if (!plan.prestige && wave > PRESTIGE_WAVE) {
      return naRow('characterFairness', plan.set, subject, target, 'noPrestige', PRESTIGE_STOP);
    }
    if (times.some(({ minutes }) => Number.isNaN(minutes))) {
      const detail = 'a character has no default session';
      return naRow('characterFairness', plan.set, subject, target, 'noData', detail, shown);
    }
    const all = times.map(({ minutes }) => minutes);
    const ratio = Math.max(...all) / Math.min(...all);
    return checkRow('characterFairness', plan.set, {
      subject,
      target,
      measured: `${num(ratio, 3)} (minutes ${shown})`,
      status: ratio <= FAIRNESS_MAX ? 'pass' : 'FAIL',
      evidence: [`milestones.csv: default minToWave${wave}`],
    });
  });
}

// ---- 中心主體性 ----

/** The first run of a session that reaches CENTER_SHARE_WAVE, or null when none does. */
export function centerShareRun(result: CharacterSessionResult): CharacterRunRow | null {
  return result.rows.find((row) => row.highestWaveReached >= CENTER_SHARE_WAVE) ?? null;
}

/** A run's (center + asc) ÷ all damage (session.ts' centerShareOf) and asc ÷ all; 0 without damage. */
export function runShares(row: CharacterRunRow): { readonly share: number; readonly asc: number } {
  const damage = {
    center: row.dmgCenter,
    hub: row.dmgHub,
    outer: row.dmgOuter,
    fusion: row.dmgFusion,
    asc: row.dmgAsc,
  };
  const total = damage.center + damage.hub + damage.outer + damage.fusion + damage.asc;
  return { share: centerShareOf(damage) ?? 0, asc: total > 0 ? damage.asc / total : 0 };
}

/**
 * Per character: in each default session, the first run reaching wave CENTER_SHARE_WAVE, its
 * center share with the ascendancy counted for the center (C3D:1773-1776), shown apart; the
 * median over sessions ≥ CENTER_SHARE_MIN. A session without such a run FAILs the character.
 */
export function centerShareCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const target =
    `median (center + asc) ÷ all damage ≥ ${CENTER_SHARE_MIN} in the first run reaching ` +
    `wave ${CENTER_SHARE_WAVE} (初始值)`;
  return plan.characters.map((character) => {
    const sessions = defaultSessions(plan, results, character);
    if (sessions.length === 0) {
      return naRow('centerShare', plan.set, character, target, 'noData', 'no default session');
    }
    const runs = sessions.map(centerShareRun);
    const shares = runs.flatMap((row) => (row === null ? [] : [runShares(row)]));
    const missing = runs.length - shares.length;
    const evidence = [`center_share.csv: ${character}`];
    if (missing > 0) {
      return checkRow('centerShare', plan.set, {
        subject: character,
        target,
        measured: `${missing} of ${sessions.length} sessions never reach wave ${CENTER_SHARE_WAVE}`,
        status: 'FAIL',
        evidence,
      });
    }
    const mid = median(shares.map(({ share }) => share));
    const asc = median(shares.map((reading) => reading.asc));
    return checkRow('centerShare', plan.set, {
      subject: character,
      target,
      measured: `median ${pct(mid)} (asc ${pct(asc)} of all) over ${sessions.length} sessions`,
      status: mid >= CENTER_SHARE_MIN ? 'pass' : 'FAIL',
      evidence,
    });
  });
}

/** center_share.csv: per default session, its first run reaching wave 30 (blank for none). */
export function centerShareCsv(plan: CheckPlan, results: UnitResults): string {
  const header = [
    'character',
    'session',
    'run',
    'minutes',
    'highestWaveReached',
    'dmgCenter',
    'dmgHub',
    'dmgOuter',
    'dmgFusion',
    'dmgAsc',
    'share',
    'ascShare',
  ];
  const rows: CsvValue[][] = [];
  for (const character of plan.characters) {
    for (const result of defaultSessions(plan, results, character)) {
      const row = centerShareRun(result);
      const shares = row === null ? null : runShares(row);
      rows.push([
        character,
        result.session,
        row?.run ?? null,
        row?.minutes ?? null,
        row?.highestWaveReached ?? null,
        row?.dmgCenter ?? null,
        row?.dmgHub ?? null,
        row?.dmgOuter ?? null,
        row?.dmgFusion ?? null,
        row?.dmgAsc ?? null,
        shares?.share ?? null,
        shares?.asc ?? null,
      ]);
    }
  }
  return toCsv(header, rows);
}

// ---- 一輪轉生的點數 ----

const inside = (value: number, [lo, hi]: readonly [number, number]): boolean =>
  value >= lo && value <= hi;

/**
 * Per character: the median purchases at the prestige point, over the default sessions that
 * reach it, in POINT_BUDGET.prestige; at the clear, over the sessions that clear, in
 * POINT_BUDGET.clear, noSingularity until B5 builds 奇點.
 */
export function pointBudgetCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  return plan.characters.flatMap((character) => {
    const sessions = defaultSessions(plan, results, character);
    const [plo, phi] = POINT_BUDGET.prestige;
    const [clo, chi] = POINT_BUDGET.clear;
    const prestigeSubject = `${character} × prestige point`;
    const prestigeTarget = `median purchases ${plo}–${phi} at the prestige point (gd:318; 初始值)`;
    const clearSubject = `${character} × clear`;
    const clearTarget = `median purchases ${clo}–${chi} at the clear (gd:319; 初始值)`;
    const points = sessions.flatMap((result) =>
      result.milestones.prestigePoint === null ? [] : [result.milestones.prestigePoint.purchases],
    );
    const atPrestige =
      points.length === 0
        ? naRow(
            'pointBudget',
            plan.set,
            prestigeSubject,
            prestigeTarget,
            'noData',
            'no default session reached the prestige point',
          )
        : checkRow('pointBudget', plan.set, {
            subject: prestigeSubject,
            target: prestigeTarget,
            measured: `median ${num(median(points))} over ${points.length} of ${sessions.length} sessions`,
            status: inside(median(points), POINT_BUDGET.prestige) ? 'pass' : 'FAIL',
            evidence: [`milestones.csv: ${character} default prestigePurchases`],
          });
    if (!plan.singularity) {
      const detail = "the clear is wave 100's 奇點, which B5 builds";
      return [
        atPrestige,
        naRow('pointBudget', plan.set, clearSubject, clearTarget, 'noSingularity', detail),
      ];
    }
    const cleared = sessions.flatMap((result) =>
      result.stop === 'cleared' ? [result.rows.at(-1)?.purchases ?? 0] : [],
    );
    const atClear =
      cleared.length === 0
        ? naRow(
            'pointBudget',
            plan.set,
            clearSubject,
            clearTarget,
            'noData',
            'no default session cleared',
          )
        : checkRow('pointBudget', plan.set, {
            subject: clearSubject,
            target: clearTarget,
            measured: `median ${num(median(cleared))} over ${cleared.length} of ${sessions.length} sessions`,
            status: inside(median(cleared), POINT_BUDGET.clear) ? 'pass' : 'FAIL',
            evidence: [`runs.csv: ${character} default purchases`],
          });
    return [atPrestige, atClear];
  });
}

// ---- 傳承 ----

/**
 * The legacy sessions (run.ts' derivedUnits): once B5 sets LEGACY, every other character's
 * default session s played from the account the first character's session s leaves through
 * `hook`. None without the check, the hook or a second character.
 */
export function legacyUnits(
  plan: CheckPlan,
  results: UnitResults,
  hook: LegacyHook | null,
): PlanUnit[] {
  const [first, ...others] = plan.characters;
  if (!plan.checks.includes('legacy') || !plan.legacy || hook === null || first === undefined) {
    return [];
  }
  const units: PlanUnit[] = [];
  for (const character of others) {
    for (let session = 0; session < plan.sessions; session++) {
      const before = sessionResultOf(results, sessionUnitId(first, session));
      if (before === null) continue;
      const account = sessionConfigOf(plan, sessionUnitId(first, session)).account ?? FRESH_ACCOUNT;
      const config = sessionConfigOf(plan, sessionUnitId(character, session));
      units.push({
        id: legacyUnitId(character, session),
        job: {
          kind: 'character',
          config: { ...config, account: hook.accountAfter(before, account) },
        },
      });
    }
  }
  return units;
}

/** A character's legacy sessions with results, by session index. */
function legacySessions(
  plan: CheckPlan,
  results: UnitResults,
  character: CharacterId,
): CharacterSessionResult[] {
  const found: CharacterSessionResult[] = [];
  for (let session = 0; session < plan.sessions; session++) {
    const result = sessionResultOf(results, legacyUnitId(character, session));
    if (result !== null) found.push(result);
  }
  return found;
}

/**
 * Per second character, after the first's 傳承: its median minutes to LEGACY_WAVE ≤ LEGACY_MAX ×
 * the first's (default sessions). noLegacy until B5 sets LEGACY; oneCharacter with one.
 */
export function legacyCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const target =
    `the second character's median minutes to wave ${LEGACY_WAVE} ≤ ${LEGACY_MAX} × the ` +
    "first's (初始值)";
  if (!plan.legacy) {
    const detail = '傳承 is not written: LEGACY is null until B5';
    return [naRow('legacy', plan.set, 'all', target, 'noLegacy', detail)];
  }
  const [first, ...others] = plan.characters;
  if (first === undefined || others.length === 0) {
    const detail = 'one character has a center: there is no second character';
    return [naRow('legacy', plan.set, 'all', target, 'oneCharacter', detail)];
  }
  const firstSessions = defaultSessions(plan, results, first);
  const theirs = firstSessions.length === 0 ? NaN : medianMinutesToWave(firstSessions, LEGACY_WAVE);
  return others.map((character) => {
    const subject = `${character} after ${first}`;
    const sessions = legacySessions(plan, results, character);
    if (sessions.length === 0 || !Number.isFinite(theirs)) {
      const detail =
        sessions.length === 0
          ? `no legacy session of ${character}`
          : `${first} never reaches wave ${LEGACY_WAVE}`;
      return naRow('legacy', plan.set, subject, target, 'noData', detail);
    }
    const mine = medianMinutesToWave(sessions, LEGACY_WAVE);
    return checkRow('legacy', plan.set, {
      subject,
      target,
      measured: `${num(mine)} min against ${num(theirs)} (${num(mine / theirs, 3)}×)`,
      status: mine <= LEGACY_MAX * theirs ? 'pass' : 'FAIL',
      evidence: [`milestones.csv: ${first} default minToWave${LEGACY_WAVE}`],
    });
  });
}

// ---- 遊玩時間 ----

/**
 * Per character, from a fresh account: the default sessions' median minutes to the clear (wave
 * CLEAR_WAVE, menus included; ∞ for a session that does not clear) in PLAY_TIME_MINUTES. noPrestige
 * until B2; info until B5 builds 奇點.
 */
export function playTimeCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const [lo, hi] = PLAY_TIME_MINUTES;
  const target = `a fresh account clears wave ${CLEAR_WAVE} in ${lo}–${hi} min with menus (初始值)`;
  return plan.characters.map((character) => {
    if (!plan.prestige) {
      return naRow('playTime', plan.set, character, target, 'noPrestige', PRESTIGE_STOP);
    }
    const sessions = defaultSessions(plan, results, character);
    if (sessions.length === 0) {
      return naRow('playTime', plan.set, character, target, 'noData', 'no default session');
    }
    const minutes = sessions.map((result) =>
      result.stop === 'cleared' ? result.endMinutes : Infinity,
    );
    const mid = median(minutes);
    const cleared = minutes.filter(Number.isFinite).length;
    return checkRow('playTime', plan.set, {
      subject: character,
      target: plan.singularity ? target : `${target}; info until B5 builds 奇點`,
      measured: `median ${num(mid)} min (${cleared} of ${sessions.length} sessions clear)`,
      status: !plan.singularity ? 'info' : inside(mid, PLAY_TIME_MINUTES) ? 'pass' : 'FAIL',
      evidence: [`milestones.csv: ${character} default endMinutes`],
    });
  });
}

// ---- 轉生後回到最遠波次 ----

/**
 * Each prestige of a session: the minutes from it (the next run's start) to the end of the first
 * run of the new cycle whose cycleBest reaches the last cycle's, ∞ if none does, ÷ the minutes of
 * the last cycle (from the session's start or the prestige before).
 */
export function prestigeReturns(result: CharacterSessionResult): number[] {
  const ratios: number[] = [];
  const { rows } = result;
  let cycleStart = 0;
  for (let i = 1; i < rows.length; i++) {
    const last = rows[i - 1] as CharacterRunRow;
    const next = rows[i] as CharacterRunRow;
    if (next.prestiges <= last.prestiges) continue;
    const prestigedAt = next.minutes - next.runSeconds / 60;
    let back = Infinity;
    for (let j = i; j < rows.length; j++) {
      const row = rows[j] as CharacterRunRow;
      if (row.prestiges !== next.prestiges) break;
      if (row.cycleBest >= last.cycleBest) {
        back = row.minutes - prestigedAt;
        break;
      }
    }
    ratios.push(back / (prestigedAt - cycleStart));
    cycleStart = prestigedAt;
  }
  return ratios;
}

/**
 * Per character: over every prestige of its default sessions, the median of prestigeReturns ≤
 * PRESTIGE_RETURN_MAX. noPrestige until B2.
 */
export function prestigeReturnCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const target =
    `median minutes back to the last cycle's best ≤ ${PRESTIGE_RETURN_MAX} × that cycle's ` +
    '(初始值)';
  return plan.characters.map((character) => {
    if (!plan.prestige) {
      return naRow('prestigeReturn', plan.set, character, target, 'noPrestige', PRESTIGE_STOP);
    }
    const ratios = defaultSessions(plan, results, character).flatMap(prestigeReturns);
    if (ratios.length === 0) {
      const detail = 'no default session prestiged';
      return naRow('prestigeReturn', plan.set, character, target, 'noData', detail);
    }
    const mid = median(ratios);
    return checkRow('prestigeReturn', plan.set, {
      subject: character,
      target,
      measured: `median ${num(mid, 3)} over ${ratios.length} prestiges`,
      status: mid <= PRESTIGE_RETURN_MAX ? 'pass' : 'FAIL',
      evidence: [`runs.csv: ${character} default prestiges`],
    });
  });
}
