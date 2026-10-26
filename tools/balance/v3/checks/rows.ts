/**
 * 敵人對照表, 外盤能補的敵人 and 菁英詞綴 (docs/v3 C10 design §2.3's enemyRow, outerRow and affixes
 * rows; gd:766-769, impl:478-479): single-type test waves (testWave.ts) on each character's
 * DEAD_BOARD_MINUTES snapshot (boards.ts). enemyRow judges each ROW_ENEMIES column against the
 * median over the built characters; outerRow each column an open outer covers, with the outer's
 * investment against without it; affixes lead ruling L6's proxy on elite test waves. A column
 * whose behaviour is a C7 part not live (c7.ts' probe) is c7Pending, and its units are not
 * planned. The measures read a session's snapshot, so their units come in a plan's second phase
 * (run.ts' derivedUnits).
 */

import type { CharacterId, OuterId } from '../../../../src/data';
import { ROW_ENEMIES } from '../../../../src/data/web';
import type { AssembledWeb, Cover, Mark, RowEnemy, WebNode } from '../../../../src/data/web';
import type { CharacterProgress } from '../../../../src/meta/web';
import { median } from '../../../../src/meta/web/calibrate';
import { GATED_KINDS, storedRank } from '../../../../src/meta/web/counts';
import { shortestRoute } from '../../../../src/meta/web/path';
import { toCsv } from '../../csv';
import type { CsvValue } from '../../csv';
import { webOf } from '../content';
import type { AffixReading, EnemyRowReading, OuterRowReading } from '../measures';
import { openOuters } from '../strategies';
import { ENEMY_ROW_MAX_SECONDS, ENEMY_ROW_SEEDS } from '../testWave';
import type { TestWaveReading } from '../testWave';
import { boardSnapshot, DEAD_BOARD_MINUTES, snapshotInput } from './boards';
import { C7_PARTS } from './c7';
import type { C7Part, C7Parts } from './c7';
import { checkRow, measureResultOf, NA_UNLOCKS, naRow } from './types';
import type { CheckPlan, CheckResult, PlanUnit, UnitResults } from './types';

/** ✓: the clear time at least this share of the characters' median (impl:478; gd:766; 初始值). */
export const ROW_STRONG_MIN = 0.4;
/** ✗ with its answer node: time and damage at most this many medians (impl:478; gd:766; 初始值). */
export const ROW_WEAK_MAX = 2.5;
/** ✗ when the damage median is 0: leaks at most 1 per 10 (impl:478; gd:766; 初始值). */
export const ZERO_MEDIAN_LEAKS = { leaks: 1, per: 10 } as const;
/** An outer helps a column it covers: time or damage better by this share (impl:479; gd:768; 初始門檻). */
export const OUTER_ROW_GAIN = 0.2;
/** Boards that must counter each affix (gd:769 「至少有 3 塊盤」; 初始值). */
export const AFFIX_BOARDS_MIN = 3;
/** Board b counters affix a when r_b(a) ≤ this (lead ruling L6; 初始值): at most half again the plain kill time. */
export const AFFIX_RATIO_MAX = 1.5;
/**
 * The affixes in gd:707-714's order, C7.6's AFFIX_IDS (C7D:428): an elite's `affixes` bit i is
 * AFFIX_ORDER[i]. C10.4 at the latest imports AFFIX_IDS and the typed field (design §2.3).
 */
export const AFFIX_ORDER = [
  'swift',
  'armoured',
  'regen',
  'guardian',
  'multiply',
  'berserk',
  'ward',
  'frost',
] as const;
export type AffixName = (typeof AFFIX_ORDER)[number];

/**
 * The C7 part each column's behaviour arrives with (C7D §2.4–§2.8): shields C7.3; regeneration,
 * the dash and the treasure's flight C7.4a; shots and summons C7.4b; the onion C7.7. M1's three
 * types need none.
 */
export const ROW_PARTS: Readonly<Record<RowEnemy, C7Part | null>> = {
  triangle: null,
  square: null,
  pentagon: null,
  shielder: 'C7.3',
  regenerator: 'C7.4a',
  dasher: 'C7.4a',
  shooter: 'C7.4b',
  summoner: 'C7.4b',
  treasure: 'C7.4a',
  boss: 'C7.7',
};

/** A C7 part as its c7Pending detail names it: its fields, then the part ('affixes (C7.6)'). */
export function partDetail(part: C7Part): string {
  const fields = C7_PARTS.find((entry) => entry.part === part)?.fields ?? [];
  return `${fields.join(', ')} (${part})`;
}

/** The detail of a column whose C7 part is not live, or null when it is (or needs none). */
export function pendingPart(parts: C7Parts, column: RowEnemy): string | null {
  const part = ROW_PARTS[column];
  return part === null || parts[part] ? null : partDetail(part);
}

/**
 * An enemy view's affix bits, read structurally so the tools compile before C7.6 (K7): the
 * `affixes` number when the view holds one, else null.
 */
export function affixBitsOf(view: unknown): number | null {
  if (typeof view !== 'object' || view === null || !('affixes' in view)) return null;
  const bits = (view as { readonly affixes: unknown }).affixes;
  return typeof bits === 'number' ? bits : null;
}

/** The affixes `bits` hold, in AFFIX_ORDER. */
export const affixNames = (bits: number): AffixName[] =>
  AFFIX_ORDER.filter((_, index) => (bits & (1 << index)) !== 0);

const notGated = (node: WebNode): boolean => !GATED_KINDS.has(node.kind);

/**
 * The center node that answers `column` nearest to `progress` (gd:767; design §2.3): fewest
 * purchases by shortestRoute through no gated kind, an owned one none, ties in web order; with
 * the purchases it needs. Null when no center node answers it.
 */
export function answerNode(
  web: AssembledWeb,
  progress: CharacterProgress,
  column: RowEnemy,
): { readonly node: string; readonly route: readonly string[] } | null {
  const center = `${web.character}.center`;
  let best: { readonly node: string; readonly route: readonly string[] } | null = null;
  for (const node of web.nodes) {
    if (node.board !== center || !node.answers.includes(column)) continue;
    const route =
      storedRank(progress, node.id) > 0 ? [] : shortestRoute(web, progress, node.id, notGated);
    if (route !== null && (best === null || route.length < best.route.length)) {
      best = { node: node.id, route };
    }
  }
  return best;
}

/** A build's medians over its seeds: clear time, damage taken (contact + bullets), leaks per 10. */
export interface RowStats {
  readonly time: number;
  readonly damage: number;
  readonly leaks: number;
  /** Seeds whose wave never cleared, read at ENEMY_ROW_MAX_SECONDS. */
  readonly uncleared: number;
}

/** The medians over the characters' base stats, which ✓ and ✗ are judged against. */
export interface RowMedians {
  readonly time: number;
  readonly damage: number;
}

export function rowStats(runs: readonly TestWaveReading[]): RowStats {
  return {
    time: median(runs.map((run) => run.clearSeconds)),
    damage: median(runs.map((run) => run.contact + (run.bullet ?? 0))),
    leaks: median(runs.map((run) => (run.leaks * ZERO_MEDIAN_LEAKS.per) / run.count)),
    uncleared: runs.filter((run) => !run.cleared).length,
  };
}

/** ✓ (gd:766): the clear time at least ROW_STRONG_MIN × the median. */
export const strongHolds = (stats: RowStats, medians: RowMedians): boolean =>
  stats.time >= ROW_STRONG_MIN * medians.time;

/**
 * ✗ with its answer node (gd:766): time and damage at most ROW_WEAK_MAX × the medians; a damage
 * median of 0 judges leaks, at most ZERO_MEDIAN_LEAKS per 10, in place of damage.
 */
export function weakHolds(answer: RowStats, medians: RowMedians): boolean {
  if (!(answer.time <= ROW_WEAK_MAX * medians.time)) return false;
  return medians.damage > 0
    ? answer.damage <= ROW_WEAK_MAX * medians.damage
    : answer.leaks <= ZERO_MEDIAN_LEAKS.leaks;
}

/**
 * An outer helps a column it covers (gd:768): time or damage at most 1 − OUTER_ROW_GAIN of the
 * base's; a base damage of 0 judges time alone.
 */
export function outerHolds(base: RowStats, withOuter: RowStats): boolean {
  const kept = 1 - OUTER_ROW_GAIN;
  return (
    withOuter.time <= kept * base.time ||
    (base.damage > 0 && withOuter.damage <= kept * base.damage)
  );
}

/** One board's r(a): a character, a board id, and the ratio (null when no affixed elite drew a). */
export interface AffixRatio {
  readonly character: CharacterId;
  readonly board: string;
  readonly ratio: number | null;
}

/**
 * An affix's verdict (gd:769; L6): pass with AFFIX_BOARDS_MIN boards countering it (r ≤
 * AFFIX_RATIO_MAX, for some character) and one countering it for every built character. A rule that
 * fails while a ratio is unread, or a character has none, is n/a: the reading might pass it.
 */
export function affixVerdict(
  ratios: readonly AffixRatio[],
  characters: readonly CharacterId[],
): {
  readonly status: 'pass' | 'FAIL' | 'n/a';
  readonly boards: readonly string[];
  readonly without: readonly CharacterId[];
} {
  const countering = ratios.filter(({ ratio }) => ratio !== null && ratio <= AFFIX_RATIO_MAX);
  const boards = [...new Set(countering.map(({ board }) => board))];
  const without = characters.filter((c) => !countering.some(({ character }) => character === c));
  if (boards.length >= AFFIX_BOARDS_MIN && without.length === 0) {
    return { status: 'pass', boards, without };
  }
  const unread =
    ratios.some(({ ratio }) => ratio === null) ||
    characters.some((c) => !ratios.some(({ character }) => character === c));
  return { status: unread ? 'n/a' : 'FAIL', boards, without };
}

// ---- Units ----

/** A row measure unit's id: the character, the column, the build (snapshot or answer), the seed. */
export const enemyRowUnitId = (
  character: CharacterId,
  column: RowEnemy,
  answer: boolean,
  seed: number,
): string => `measure:enemyRow:${character}:${column}:${answer ? 'answer' : 'snapshot'}:${seed}`;

export const outerRowUnitId = (
  character: CharacterId,
  outer: OuterId,
  column: RowEnemy,
  seed: number,
): string => `measure:outerRow:${character}:${outer}:${column}:${seed}`;

/** An affix unit's id: the board is `center` or the outer whose investment is added. */
export const affixUnitId = (
  character: CharacterId,
  outer: OuterId | null,
  affixed: boolean,
  seed: number,
): string =>
  `measure:affix:${character}:${outer ?? 'center'}:${affixed ? 'affixed' : 'plain'}:${seed}`;

/** The columns an outer covers (OuterDef.covers), in ROW_ENEMIES order. */
function covered(web: AssembledWeb, outer: OuterId): [RowEnemy, Cover][] {
  const covers = web.outers.get(outer)?.covers ?? {};
  return ROW_ENEMIES.flatMap((column): [RowEnemy, Cover][] => {
    const cover = covers[column];
    return cover === undefined ? [] : [[column, cover]];
  });
}

/** Whether a character's column is a ✗ the rule judges: every ✗ but the treasure's. */
const judgedWeak = (mark: Mark, column: RowEnemy): boolean =>
  mark === 'weak' && column !== 'treasure';

/**
 * The second phase's row units (design §2.3): for each character with a board snapshot and each
 * live column, ENEMY_ROW_SEEDS test waves on the snapshot, and on the snapshot with its answer
 * node where the column is a judged ✗; with outerRow, each open outer's covered live columns with
 * its investment; with affixes once C7.6 is live, the elite waves plain and affixed on the center
 * and each open outer. None of a check the set lacks.
 */
export function rowUnits(plan: CheckPlan, results: UnitResults): PlanUnit[] {
  const enemyRows = plan.checks.includes('enemyRow');
  const outerRows = plan.checks.includes('outerRow');
  const affixes = plan.checks.includes('affixes') && plan.c7['C7.6'];
  const units: PlanUnit[] = [];
  if (!enemyRows && !outerRows && !affixes) return units;
  const seeds = Array.from({ length: ENEMY_ROW_SEEDS }, (_, seed) => seed);
  for (const character of plan.characters) {
    const found = boardSnapshot(plan, results, character);
    if (found === null) continue;
    const web = webOf(plan.content, character, 'full');
    const live = (column: RowEnemy): boolean => pendingPart(plan.c7, column) === null;
    const snapshot = { content: plan.content, character, ...snapshotInput(found) };
    for (const column of ROW_ENEMIES.filter(live)) {
      const builds = [
        ...(enemyRows || outerRows ? [false] : []),
        ...(enemyRows && judgedWeak(web.def.enemyRow[column], column) ? [true] : []),
      ];
      for (const answer of builds) {
        for (const seed of seeds) {
          units.push({
            id: enemyRowUnitId(character, column, answer, seed),
            job: {
              kind: 'measure',
              measure: 'enemyRow',
              input: {
                content: plan.content,
                character,
                column,
                snapshot: found.snapshot.progress,
                account: found.account,
                answer,
                seed,
              },
            },
          });
        }
      }
    }
    const outers = openOuters(web);
    if (outerRows) {
      for (const outer of outers) {
        for (const [column] of covered(web, outer).filter(([column]) => live(column))) {
          for (const seed of seeds) {
            units.push({
              id: outerRowUnitId(character, outer, column, seed),
              job: {
                kind: 'measure',
                measure: 'outerRow',
                input: { ...snapshot, outer, column, seed },
              },
            });
          }
        }
      }
    }
    if (affixes) {
      for (const outer of [null, ...outers]) {
        for (const affixed of [false, true]) {
          for (const seed of seeds) {
            units.push({
              id: affixUnitId(character, outer, affixed, seed),
              job: {
                kind: 'measure',
                measure: 'affix',
                input: { ...snapshot, outer, affixed, seed },
              },
            });
          }
        }
      }
    }
  }
  return units;
}

// ---- Readings ----

/** The readings of ENEMY_ROW_SEEDS units that have one, by seed. */
function bySeed<T>(read: (seed: number) => T | null): T[] {
  return Array.from({ length: ENEMY_ROW_SEEDS }, (_, seed) => read(seed)).filter(
    (reading): reading is T => reading !== null,
  );
}

const enemyRowReadings = (
  results: UnitResults,
  character: CharacterId,
  column: RowEnemy,
  answer: boolean,
): EnemyRowReading[] =>
  bySeed((seed) =>
    measureResultOf(results, enemyRowUnitId(character, column, answer, seed), 'enemyRow'),
  );

const outerRowReadings = (
  results: UnitResults,
  character: CharacterId,
  outer: OuterId,
  column: RowEnemy,
): OuterRowReading[] =>
  bySeed((seed) =>
    measureResultOf(results, outerRowUnitId(character, outer, column, seed), 'outerRow'),
  );

const affixReadings = (
  results: UnitResults,
  character: CharacterId,
  outer: OuterId | null,
  affixed: boolean,
): AffixReading[] =>
  bySeed((seed) => measureResultOf(results, affixUnitId(character, outer, affixed, seed), 'affix'));

/** A build's stats from its readings, or why it has none: a seed unread, or a refused purchase. */
function statsOf(
  readings: readonly { readonly run: TestWaveReading | null; readonly refused: string | null }[],
): RowStats | string {
  if (readings.length < ENEMY_ROW_SEEDS) {
    return `${readings.length} of ${ENEMY_ROW_SEEDS} seeds measured`;
  }
  const runs = readings.flatMap(({ run }) => (run === null ? [] : [run]));
  if (runs.length < readings.length) {
    return `no test wave: ${readings.find(({ run }) => run === null)?.refused ?? 'no run'}`;
  }
  return rowStats(runs);
}

const seconds = (value: number): string => `${Number(value.toFixed(1))} s`;
const amount = (value: number): string => String(Number(value.toFixed(1)));

/** A build's stats as the measured column prints them. */
const statsText = (stats: RowStats): string =>
  `time ${seconds(stats.time)}, damage ${amount(stats.damage)}, ` +
  `${amount(stats.leaks)} leaks per ${ZERO_MEDIAN_LEAKS.per}` +
  (stats.uncleared > 0 ? ` (${stats.uncleared} of ${ENEMY_ROW_SEEDS} uncleared)` : '');

/** A test wave's CSV columns, and a reading's cells (empty with no run). */
const RUN_COLUMNS = ['clearSeconds', 'cleared', 'died', 'count', 'leaks', 'contact', 'bullet'];

const runCells = (run: TestWaveReading | null): CsvValue[] =>
  run === null
    ? RUN_COLUMNS.map(() => null)
    : [run.clearSeconds, run.cleared, run.died, run.count, run.leaks, run.contact, run.bullet];

// ---- 敵人對照表 ----

export const ENEMY_ROW_STANDARD =
  `single-type test waves on the ${DEAD_BOARD_MINUTES}-min snapshot, against the median over ` +
  `the characters: ✓ time ≥ ${ROW_STRONG_MIN} × it; ✗ with its answer node time and damage ≤ ` +
  `${ROW_WEAK_MAX} × (leaks ≤ ${ZERO_MEDIAN_LEAKS.leaks} per ${ZERO_MEDIAN_LEAKS.per} when the ` +
  'damage median is 0); △ and the treasure’s ✗ info (初始值)';

const MARK_TARGETS: Readonly<Record<Mark, string>> = {
  strong: `✓: time ≥ ${ROW_STRONG_MIN} × the median (初始值)`,
  weak:
    `✗: with the answer node, time and damage ≤ ${ROW_WEAK_MAX} × the medians; leaks ≤ ` +
    `${ZERO_MEDIAN_LEAKS.leaks} per ${ZERO_MEDIAN_LEAKS.per} when the damage median is 0 (初始值)`,
  even: '△: info',
};
const TREASURE_TARGET = '✗ (寶藏怪 exempt, gd:766): info';

/**
 * The enemyRow rows: per live ROW_ENEMIES column, one per built character (one c7Pending row for
 * a pending column). One built character: info (oneCharacter, the median of one is itself).
 */
export function enemyRowCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const rows: CheckResult[] = [];
  for (const column of ROW_ENEMIES) {
    const pending = pendingPart(plan.c7, column);
    if (pending !== null) {
      rows.push(
        naRow('enemyRow', plan.set, `all × ${column}`, ENEMY_ROW_STANDARD, 'c7Pending', pending),
      );
      continue;
    }
    const bases = plan.characters.map((character) =>
      boardSnapshot(plan, results, character) === null
        ? `no default session of ${character} has a ${DEAD_BOARD_MINUTES}-min snapshot`
        : statsOf(enemyRowReadings(results, character, column, false)),
    );
    const read = bases.filter((base): base is RowStats => typeof base !== 'string');
    const medians: RowMedians | null =
      read.length === bases.length && read.length > 0
        ? { time: median(read.map(({ time }) => time)), damage: median(read.map((s) => s.damage)) }
        : null;
    plan.characters.forEach((character, index) => {
      rows.push(
        enemyRowOf(plan, results, character, column, bases[index] as RowStats | string, medians),
      );
    });
  }
  return rows;
}

function enemyRowOf(
  plan: CheckPlan,
  results: UnitResults,
  character: CharacterId,
  column: RowEnemy,
  base: RowStats | string,
  medians: RowMedians | null,
): CheckResult {
  const mark = webOf(plan.content, character, 'full').def.enemyRow[column];
  const exempt = mark === 'weak' && column === 'treasure';
  const subject = `${character} × ${column}`;
  const target = exempt ? TREASURE_TARGET : MARK_TARGETS[mark];
  const evidence = [`enemy_row.csv: ${character} ${column}`];
  const against =
    medians === null ? '' : ` (medians ${seconds(medians.time)}, ${amount(medians.damage)})`;
  const shown = typeof base === 'string' ? `no reading: ${base}` : `${statsText(base)}${against}`;
  if (plan.characters.length === 1) {
    const why = `oneCharacter: the median of one is itself, until ${NA_UNLOCKS.oneCharacter}`;
    return checkRow('enemyRow', plan.set, {
      subject,
      target,
      measured: `${shown}; ${why}`,
      status: 'info',
      evidence,
    });
  }
  if (typeof base === 'string') {
    return naRow('enemyRow', plan.set, subject, target, 'noData', base);
  }
  if (medians === null) {
    const detail = 'the median needs every built character’s reading';
    return naRow('enemyRow', plan.set, subject, target, 'noData', detail, shown);
  }
  if (mark === 'even' || exempt) {
    return checkRow('enemyRow', plan.set, {
      subject,
      target,
      measured: shown,
      status: 'info',
      evidence,
    });
  }
  if (mark === 'strong') {
    return checkRow('enemyRow', plan.set, {
      subject,
      target,
      measured: shown,
      status: strongHolds(base, medians) ? 'pass' : 'FAIL',
      evidence,
    });
  }
  const readings = enemyRowReadings(results, character, column, true);
  const answer = statsOf(readings);
  if (typeof answer === 'string') {
    return naRow('enemyRow', plan.set, subject, target, 'noData', answer, shown);
  }
  const node = readings[0]?.node ?? '—';
  return checkRow('enemyRow', plan.set, {
    subject,
    target,
    measured: `with ${node}: ${statsText(answer)}${against}; without: ${statsText(base)}`,
    status: weakHolds(answer, medians) ? 'pass' : 'FAIL',
    evidence,
  });
}

/** enemy_row.csv: one line per character, column, build (snapshot or answer) and seed. */
export function enemyRowCsv(plan: CheckPlan, results: UnitResults): string {
  const header = [
    'character',
    'column',
    'mark',
    'build',
    'seed',
    'node',
    'purchases',
    'refused',
    ...RUN_COLUMNS,
    'session',
  ];
  const rows: CsvValue[][] = [];
  for (const character of plan.characters) {
    const mark = webOf(plan.content, character, 'full').def.enemyRow;
    const session = boardSnapshot(plan, results, character)?.session ?? null;
    for (const column of ROW_ENEMIES) {
      for (const answer of [false, true]) {
        for (const reading of enemyRowReadings(results, character, column, answer)) {
          rows.push([
            character,
            column,
            mark[column],
            answer ? 'answer' : 'snapshot',
            reading.seed,
            reading.node,
            reading.purchases.join(' '),
            reading.refused,
            ...runCells(reading.run),
            session,
          ]);
        }
      }
    }
  }
  return toCsv(header, rows);
}

// ---- 外盤能補的敵人 ----

export const OUTER_ROW_STANDARD =
  `each open outer's covered columns (◆, ＋): time or damage better by ≥ ` +
  `${OUTER_ROW_GAIN * 100}% with its investment (deadBoards', the answering ◆ first) on the ` +
  `${DEAD_BOARD_MINUTES}-min snapshot; time alone when the base damage is 0 (初始門檻, 初始值)`;

const COVER_MARKS: Readonly<Record<Cover, string>> = { answer: '◆', helps: '＋' };

const change = (from: number, to: number): string =>
  from === 0
    ? ''
    : ` (${to < from ? '−' : to > from ? '+' : '±'}${Number((Math.abs(to / from - 1) * 100).toFixed(1))}%)`;

/**
 * The outerRow rows: one per character, open outer (clock order) and live column it covers; one
 * c7Pending row per pending column some outer covers. Real with one character: an outer is judged
 * against the same snapshot without it.
 */
export function outerRowCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const rows: CheckResult[] = [];
  const pending = new Set<RowEnemy>();
  for (const character of plan.characters) {
    const web = webOf(plan.content, character, 'full');
    const found = boardSnapshot(plan, results, character);
    for (const outer of openOuters(web)) {
      for (const [column, cover] of covered(web, outer)) {
        if (pendingPart(plan.c7, column) !== null) {
          pending.add(column);
          continue;
        }
        const subject = `${character} × outer.${outer} × ${column}`;
        const target = `${COVER_MARKS[cover]} ${column}: time or damage −${OUTER_ROW_GAIN * 100}% or more (初始門檻)`;
        if (found === null) {
          const detail = `no default session of ${character} has a ${DEAD_BOARD_MINUTES}-min snapshot`;
          rows.push(naRow('outerRow', plan.set, subject, target, 'noData', detail));
          continue;
        }
        const base = statsOf(enemyRowReadings(results, character, column, false));
        const readings = outerRowReadings(results, character, outer, column);
        const withOuter = statsOf(readings);
        if (typeof base === 'string' || typeof withOuter === 'string') {
          const detail =
            typeof base === 'string' ? `without: ${base}` : `with: ${withOuter as string}`;
          rows.push(naRow('outerRow', plan.set, subject, target, 'noData', detail));
          continue;
        }
        const first = readings[0];
        rows.push(
          checkRow('outerRow', plan.set, {
            subject,
            target,
            measured:
              `time ${seconds(base.time)} → ${seconds(withOuter.time)}` +
              `${change(base.time, withOuter.time)}, damage ${amount(base.damage)} → ` +
              `${amount(withOuter.damage)}${change(base.damage, withOuter.damage)}; ` +
              `${first?.bought.length ?? 0} bought, ${first?.unpaid.length ?? 0} unpaid`,
            status: outerHolds(base, withOuter) ? 'pass' : 'FAIL',
            evidence: [`outer_row.csv: ${character} ${outer} ${column}`],
          }),
        );
      }
    }
  }
  for (const column of ROW_ENEMIES.filter((column) => pending.has(column))) {
    const detail = pendingPart(plan.c7, column) as string;
    rows.push(
      naRow('outerRow', plan.set, `all × ${column}`, OUTER_ROW_STANDARD, 'c7Pending', detail),
    );
  }
  if (rows.length === 0) {
    rows.push(
      naRow(
        'outerRow',
        plan.set,
        'all',
        OUTER_ROW_STANDARD,
        'noData',
        'no open outer covers a column',
      ),
    );
  }
  return rows;
}

/** outer_row.csv: one line per character, open outer, covered column and seed. */
export function outerRowCsv(plan: CheckPlan, results: UnitResults): string {
  const header = [
    'character',
    'outer',
    'column',
    'cover',
    'seed',
    'bought',
    'unpaid',
    'refused',
    ...RUN_COLUMNS,
    'session',
  ];
  const rows: CsvValue[][] = [];
  for (const character of plan.characters) {
    const web = webOf(plan.content, character, 'full');
    const session = boardSnapshot(plan, results, character)?.session ?? null;
    for (const outer of openOuters(web)) {
      for (const [column, cover] of covered(web, outer)) {
        for (const reading of outerRowReadings(results, character, outer, column)) {
          rows.push([
            character,
            outer,
            column,
            cover,
            reading.seed,
            reading.bought.join(' '),
            reading.unpaid.join(' '),
            reading.refused,
            ...runCells(reading.run),
            session,
          ]);
        }
      }
    }
  }
  return toCsv(header, rows);
}

// ---- 菁英詞綴 ----

export const AFFIXES_STANDARD =
  `L6's proxy on elite test waves: board b counters affix a when the median kill time of ` +
  `a-elites ÷ plain ≤ ${AFFIX_RATIO_MAX}; each affix needs ≥ ${AFFIX_BOARDS_MIN} countering ` +
  'boards and one for every character (初始值)';

/** A kill time: the clear when the elite never reached the player, else ENEMY_ROW_MAX_SECONDS. */
const killSeconds = (run: TestWaveReading): number =>
  run.cleared && run.leaks === 0 ? run.clearSeconds : ENEMY_ROW_MAX_SECONDS;

/** One character's board on the elite waves: its plain median kill time and its affixed readings. */
interface AffixBoard {
  readonly character: CharacterId;
  readonly board: string;
  readonly outer: OuterId | null;
  /** null while a plain seed is unread. */
  readonly plain: number | null;
  readonly affixed: readonly AffixReading[];
}

function affixBoards(plan: CheckPlan, results: UnitResults): AffixBoard[] {
  return plan.characters.flatMap((character) => {
    const web = webOf(plan.content, character, 'full');
    return [null, ...openOuters(web)].map((outer): AffixBoard => {
      const plain = affixReadings(results, character, outer, false);
      return {
        character,
        board: outer === null ? `${character}.center` : `outer.${outer}`,
        outer,
        plain:
          plain.length < ENEMY_ROW_SEEDS ? null : median(plain.map(({ run }) => killSeconds(run))),
        affixed: affixReadings(results, character, outer, true),
      };
    });
  });
}

/** r_b(a): the median kill time of the affixed seeds whose elite drew a over the plain median. */
function ratioOf(board: AffixBoard, bit: number): number | null {
  const drew = board.affixed.filter(({ bits }) => bits !== null && (bits & (1 << bit)) !== 0);
  if (board.plain === null || drew.length === 0) return null;
  return median(drew.map(({ run }) => killSeconds(run))) / board.plain;
}

/**
 * The affixes rows: c7Pending (affixes, C7.6) before C7.6; then one per affix in AFFIX_ORDER,
 * judged by affixVerdict over each character's center and open outers.
 */
export function affixesCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  if (!plan.c7['C7.6']) {
    return [naRow('affixes', plan.set, 'all', AFFIXES_STANDARD, 'c7Pending', partDetail('C7.6'))];
  }
  const boards = affixBoards(plan, results);
  return AFFIX_ORDER.map((affix, bit) => {
    const ratios = boards.map((board) => ({
      character: board.character,
      board: board.board,
      ratio: ratioOf(board, bit),
    }));
    const verdict = affixVerdict(ratios, plan.characters);
    const measured =
      `${verdict.boards.length} countering boards` +
      (verdict.boards.length > 0 ? ` (${verdict.boards.join(', ')})` : '') +
      (verdict.without.length > 0
        ? `; none for ${verdict.without.join(', ')}`
        : '; one for every character');
    const target = `${affix}: ≥ ${AFFIX_BOARDS_MIN} boards at r ≤ ${AFFIX_RATIO_MAX}, one for every character (初始值)`;
    if (verdict.status === 'n/a') {
      const unread = ratios.filter(({ ratio }) => ratio === null).length;
      const detail = `${unread} of ${ratios.length} boards have no ${affix} elite or no plain reading`;
      return naRow('affixes', plan.set, affix, target, 'noData', detail, measured);
    }
    return checkRow('affixes', plan.set, {
      subject: affix,
      target,
      measured,
      status: verdict.status,
      evidence: [`affixes.csv: ${affix}`],
    });
  });
}

/** affixes.csv: one line per character, board (center or outer), variant and seed. */
export function affixesCsv(plan: CheckPlan, results: UnitResults): string {
  const header = [
    'character',
    'board',
    'variant',
    'seed',
    'affixes',
    'bought',
    'unpaid',
    'refused',
    'clearSeconds',
    'cleared',
    'leaks',
    'killSeconds',
    'session',
  ];
  const rows: CsvValue[][] = [];
  for (const board of affixBoards(plan, results)) {
    const session = boardSnapshot(plan, results, board.character)?.session ?? null;
    for (const affixed of [false, true]) {
      for (const reading of affixReadings(results, board.character, board.outer, affixed)) {
        rows.push([
          board.character,
          board.board,
          affixed ? 'affixed' : 'plain',
          reading.seed,
          reading.bits === null ? null : affixNames(reading.bits).join(' '),
          reading.bought.join(' '),
          reading.unpaid.join(' '),
          reading.refused,
          reading.run.clearSeconds,
          reading.run.cleared,
          reading.run.leaks,
          killSeconds(reading.run),
          session,
        ]);
      }
    }
  }
  return toCsv(header, rows);
}
