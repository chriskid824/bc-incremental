/**
 * 死盤 and 死節點 (docs/v3 C10 design §2.3's deadBoards and deadNodes rows; gd:770, impl:483-484):
 * each open outer's investment on each character's DEAD_BOARD_MINUTES snapshot, ranked by the
 * frontier it adds over calibration's probe; and the nodes the nightly sessions never bought or
 * bought for little, from greedy's readings. The investment and the snapshot are also the outer
 * rows' and the affix proxy's (checks/rows.ts); the deadBoard measures (measures.ts) read a
 * session's snapshot, so their units come in a plan's second phase (run.ts' derivedUnits).
 */

import { num } from '../../../../src/core/num';
import type { CharacterId } from '../../../../src/data';
import { OUTER_IDS } from '../../../../src/data/sources';
import type { OuterId } from '../../../../src/data/sources';
import type { AssembledWeb, BoardId, WebNode, WebNodeKind } from '../../../../src/data/web';
import { buy, canBuy, emptyProgress, PRICE_CURVE_OF } from '../../../../src/meta/web';
import type { AccountProgress, CharacterProgress, WebEconomy } from '../../../../src/meta/web';
import { CALIBRATION_SEEDS, median } from '../../../../src/meta/web/calibrate';
import { GATED_KINDS, storedRank } from '../../../../src/meta/web/counts';
import { auditWave } from '../../../../src/meta/web/invest';
import { shortestRoute } from '../../../../src/meta/web/path';
import { toCsv } from '../../csv';
import type { CsvValue } from '../../csv';
import { webOf } from '../content';
import type { DeadBoardReading } from '../measures';
import type { CharacterSessionResult, SessionSnapshot } from '../session';
import { breadthFirst, openOuters } from '../strategies';
import {
  checkRow,
  FRESH_ACCOUNT,
  legacyUnitId,
  measureResultOf,
  NA_UNLOCKS,
  naRow,
  sessionConfigOf,
  sessionResultOf,
  sessionUnitId,
} from './types';
import type { CheckPlan, CheckResult, PlanUnit, UnitResults } from './types';

/**
 * The investment's wallet (gd:770 「錢包固定為同一時間點累計碎片收入的 30%」; 初始值): this share
 * of what the session earned by the snapshot, so the part greedy spends leaves something to buy.
 * deadBoardBase takes the same share of cores, but boardPlan plans no core-priced kind, so only
 * shards are ever spent.
 */
export const WALLET_SHARE = 0.3;
/** Nodes of an outer an investment owns (gd:770 「各點 8 個節點（入口到門檻前）」; 初始值). */
export const DEAD_BOARD_NODES = 8;
/** An outer passes in some character's top this many (gd:770 「排前 5」; 初始值). */
export const DEAD_BOARD_TOP = 5;
/** Low value: best gain ÷ shards under this share of the evaluated median (impl:484; 初始值). */
export const DEAD_NODE_SHARE = 0.2;
/** The boards' and the rows' snapshot (初始值): the enemy row's, before the prestige reveals every outer. */
export const DEAD_BOARD_MINUTES = 30;

/** The snapshot a character's boards and rows are measured on, with its session's account and economy. */
export interface BoardSnapshot {
  readonly session: number;
  readonly snapshot: SessionSnapshot;
  readonly account: AccountProgress;
  readonly economy: WebEconomy;
}

/** `character`'s lowest-index default session's DEAD_BOARD_MINUTES snapshot; null when none has one. */
export function boardSnapshot(
  plan: CheckPlan,
  results: UnitResults,
  character: CharacterId,
): BoardSnapshot | null {
  for (let session = 0; session < plan.sessions; session++) {
    const id = sessionUnitId(character, session);
    const snapshot = sessionResultOf(results, id)?.snapshots.find(
      (snap) => snap.minutes === DEAD_BOARD_MINUTES,
    );
    if (snapshot === undefined) continue;
    const config = sessionConfigOf(plan, id);
    return {
      session,
      snapshot,
      account: config.account ?? FRESH_ACCOUNT,
      economy: config.economy,
    };
  }
  return null;
}

/** A measure's view of a board snapshot: plain data for its input. */
export function snapshotInput(found: BoardSnapshot): {
  readonly snapshot: CharacterProgress;
  readonly earned: SessionSnapshot['earned'];
  readonly account: AccountProgress;
  readonly economy: WebEconomy;
} {
  return {
    snapshot: found.snapshot.progress,
    earned: found.snapshot.earned,
    account: found.account,
    economy: found.economy,
  };
}

/**
 * The investment's base (design §2.3): the snapshot at best wave 30 at least, so every outer is
 * revealed as invest.ts' audits reveal them (auditWave), its wallet WALLET_SHARE of what was earned
 * by then in place of the bank.
 */
export function deadBoardBase(
  web: AssembledWeb,
  progress: CharacterProgress,
  earned: SessionSnapshot['earned'],
): CharacterProgress {
  return {
    ...progress,
    bestWave: Math.max(progress.bestWave, auditWave(web)),
    wallet: {
      shards: num(WALLET_SHARE * earned.shards),
      cores: WALLET_SHARE * earned.cores,
      resonance: progress.wallet.resonance,
    },
  };
}

const notGated = (node: WebNode): boolean => !GATED_KINDS.has(node.kind);

/**
 * The nodes of o's board an investment owns, in order: the entry; `first` and the board's route
 * to it from the entry; then the board breadth-first from the entry (strategies.ts' breadthFirst),
 * never a gated kind, so no threshold or ★, and no fusion node. Up to `nodes`.
 */
export function boardPlan(
  web: AssembledWeb,
  outer: OuterId,
  first: string | null = null,
  nodes: number = DEAD_BOARD_NODES,
): string[] {
  const board: BoardId = `outer.${outer}`;
  const entry = web.nodes.find((node) => node.board === board && node.slot.at === 'outerEntry');
  if (entry === undefined)
    throw new Error(`deadBoard: outer '${outer}' is not open on '${web.character}'`);
  const onBoard = (node: WebNode): boolean => node.board === board && notGated(node);
  const fromEntry: CharacterProgress = {
    ...emptyProgress(web.character),
    ranks: { [entry.id]: 1 },
  };
  const toFirst = first === null ? [] : (shortestRoute(web, fromEntry, first, onBoard) ?? []);
  const order = new Set([entry.id, ...toFirst, ...breadthFirst(web, [entry.id], onBoard)]);
  return [...order].slice(0, nodes);
}

/** An investment: the progress after it, what it bought, what it could not, and the first refusal. */
export interface BoardInvestment {
  readonly progress: CharacterProgress;
  readonly bought: readonly string[];
  readonly unpaid: readonly string[];
  readonly refused: string | null;
}

/**
 * o's investment on `base` (design §2.3, K10): the route to o's entry (planPath's: shortestRoute
 * through no gated kind), then boardPlan's nodes, each bought at its real price from the base's
 * wallet (canBuy, then buy, on the session's economy). A node already owned is kept; one canBuy
 * refuses is unpaid, and the first refusal says why.
 */
export function boardInvestment(
  web: AssembledWeb,
  base: CharacterProgress,
  account: AccountProgress,
  economy: WebEconomy,
  outer: OuterId,
  first: string | null = null,
  nodes: number = DEAD_BOARD_NODES,
): BoardInvestment {
  const planned = boardPlan(web, outer, first, nodes);
  const entry = planned[0] as string;
  const route = (shortestRoute(web, base, entry, notGated) ?? [entry]).slice(0, -1);
  let progress = base;
  const bought: string[] = [];
  const unpaid: string[] = [];
  let refused: string | null = null;
  for (const id of [...route, ...planned]) {
    if (storedRank(progress, id) > 0) continue;
    const check = canBuy(web, progress, account, id, economy);
    if (check.ok) {
      progress = buy(web, progress, account, id, economy);
      bought.push(id);
    } else {
      unpaid.push(id);
      refused ??= `${id}: ${check.reason}`;
    }
  }
  return { progress, bought, unpaid, refused };
}

// ---- 死盤 ----

/** A deadBoard measure unit's id: the character, the outer (`base` for none) and the seed index. */
export const deadBoardUnitId = (
  character: CharacterId,
  outer: OuterId | null,
  seed: number,
): string => `measure:deadBoard:${character}:${outer ?? 'base'}:${seed}`;

/**
 * The second phase's deadBoard units (design §2.3): for each character with a board snapshot, its
 * base and each open outer (clock order) on CALIBRATION_SEEDS seeds. None without the check.
 */
export function boardUnits(plan: CheckPlan, results: UnitResults): PlanUnit[] {
  if (!plan.checks.includes('deadBoards')) return [];
  return plan.characters.flatMap((character) => {
    const found = boardSnapshot(plan, results, character);
    if (found === null) return [];
    const outers = openOuters(webOf(plan.content, character, 'full'));
    return [null, ...outers].flatMap((outer) =>
      Array.from({ length: CALIBRATION_SEEDS }, (_, seed): PlanUnit => ({
        id: deadBoardUnitId(character, outer, seed),
        job: {
          kind: 'measure',
          measure: 'deadBoard',
          input: { content: plan.content, character, outer, ...snapshotInput(found), seed },
        },
      })),
    );
  });
}

/**
 * Whether every character's open outers, `counts`, fit in its top DEAD_BOARD_TOP: deadBoards is
 * info (fewOuters) until some character sees more (B3).
 */
export const fewOuters = (counts: readonly number[]): boolean =>
  counts.every((count) => count <= DEAD_BOARD_TOP);

/** Outers by Δx, the largest first; ties keep the order given, the clock order (OWN test 5). */
export function rankOuters(
  deltas: readonly { readonly outer: OuterId; readonly delta: number }[],
): OuterId[] {
  return [...deltas].sort((a, b) => b.delta - a.delta).map(({ outer }) => outer);
}

/** A character's dead-board readings: its open outers, and their Δx and ranking when all are read. */
interface Standing {
  readonly character: CharacterId;
  readonly outers: readonly OuterId[];
  readonly session: number | null;
  readonly deltas: ReadonlyMap<OuterId, number> | null;
  readonly ranking: readonly OuterId[] | null;
  /** Why the ranking is missing. */
  readonly missing: string | null;
}

/** The readings of a board's CALIBRATION_SEEDS units that have one, by seed. */
function boardReadings(
  results: UnitResults,
  character: CharacterId,
  outer: OuterId | null,
): DeadBoardReading[] {
  return Array.from({ length: CALIBRATION_SEEDS }, (_, seed) =>
    measureResultOf(results, deadBoardUnitId(character, outer, seed), 'deadBoard'),
  ).filter((reading) => reading !== null);
}

function standingOf(plan: CheckPlan, results: UnitResults, character: CharacterId): Standing {
  const outers = openOuters(webOf(plan.content, character, 'full'));
  const found = boardSnapshot(plan, results, character);
  const none = { character, outers, deltas: null, ranking: null };
  if (found === null) {
    const missing = `no default session of ${character} has a ${DEAD_BOARD_MINUTES}-min snapshot`;
    return { ...none, session: null, missing };
  }
  const xOf = (outer: OuterId | null): number | null => {
    const readings = boardReadings(results, character, outer);
    return readings.length < CALIBRATION_SEEDS ? null : median(readings.map(({ x }) => x));
  };
  const base = xOf(null);
  const deltas = new Map<OuterId, number>();
  for (const outer of outers) {
    const x = xOf(outer);
    if (x !== null && base !== null) deltas.set(outer, x - base);
  }
  if (base === null || deltas.size < outers.length) {
    const read = deltas.size + (base === null ? 0 : 1);
    const missing = `${character}: ${read} of ${outers.length + 1} boards measured on all seeds`;
    return { ...none, session: found.session, missing };
  }
  const ranking = rankOuters(
    outers.map((outer) => ({ outer, delta: deltas.get(outer) as number })),
  );
  return { character, outers, session: found.session, deltas, ranking, missing: null };
}

const waves = (value: number): string => String(Number(value.toFixed(2)));
const signed = (value: number): string => (value >= 0 ? '+' : '−') + waves(Math.abs(value));

export const DEAD_BOARDS_STANDARD =
  `in some character's top ${DEAD_BOARD_TOP} by median x(with) − median x(base) over ` +
  `${CALIBRATION_SEEDS} seeds: route, then ${DEAD_BOARD_NODES} nodes at real prices from ` +
  `${WALLET_SHARE} × earned on the ${DEAD_BOARD_MINUTES}-min snapshot (初始值)`;

/**
 * The deadBoards rows: one per outer some character sees open, in clock order; pass in some
 * character's top DEAD_BOARD_TOP, ties by clock order. Info (fewOuters) while every character sees
 * DEAD_BOARD_TOP outers or fewer, which all fit; noData when a character that sees it has no
 * complete ranking and none ranks it in its top.
 */
export function deadBoardsCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const standings = plan.characters.map((character) => standingOf(plan, results, character));
  const outers = OUTER_IDS.filter((outer) => standings.some((s) => s.outers.includes(outer)));
  if (outers.length === 0) {
    return [naRow('deadBoards', plan.set, 'all', DEAD_BOARDS_STANDARD, 'noData', 'no open outer')];
  }
  const few = fewOuters(standings.map((s) => s.outers.length));
  return outers.map((outer) => {
    const seers = standings.filter((s) => s.outers.includes(outer));
    const ranks = seers
      .map((s) =>
        s.ranking === null || s.deltas === null
          ? `${s.character} —`
          : `${s.character} #${s.ranking.indexOf(outer) + 1} ` +
            `(${signed(s.deltas.get(outer) as number)})`,
      )
      .join(', ');
    const fields = {
      subject: `outer.${outer}`,
      target: DEAD_BOARDS_STANDARD,
      evidence: [`dead_boards.csv: ${outer}`],
    };
    if (few) {
      const why =
        `fewOuters: every character sees ${DEAD_BOARD_TOP} outers or fewer, all in its top ` +
        `${DEAD_BOARD_TOP}, until ${NA_UNLOCKS.fewOuters}`;
      return checkRow('deadBoards', plan.set, {
        ...fields,
        measured: `${ranks}; ${why}`,
        status: 'info',
      });
    }
    const top = seers.some((s) => s.ranking !== null && s.ranking.indexOf(outer) < DEAD_BOARD_TOP);
    const missing = seers.filter((s) => s.ranking === null);
    if (!top && missing.length > 0) {
      const detail = missing.map((s) => s.missing).join('; ');
      return naRow('deadBoards', plan.set, fields.subject, fields.target, 'noData', detail, ranks);
    }
    return checkRow('deadBoards', plan.set, {
      ...fields,
      measured: ranks,
      status: top ? 'pass' : 'FAIL',
    });
  });
}

/** dead_boards.csv: one line per character, board and seed, with the board's Δx and rank. */
export function deadBoardsCsv(plan: CheckPlan, results: UnitResults): string {
  const header = [
    'character',
    'outer',
    'seed',
    'x',
    'delta',
    'rank',
    'bought',
    'unpaid',
    'refused',
    'session',
  ];
  const rows: CsvValue[][] = [];
  for (const character of plan.characters) {
    const standing = standingOf(plan, results, character);
    for (const outer of [null, ...standing.outers]) {
      const delta = outer === null ? null : (standing.deltas?.get(outer) ?? null);
      const rank =
        outer === null || standing.ranking === null ? null : standing.ranking.indexOf(outer) + 1;
      for (const reading of boardReadings(results, character, outer)) {
        rows.push([
          character,
          outer ?? 'base',
          reading.seed,
          reading.x,
          delta,
          rank,
          reading.bought.join(' '),
          reading.unpaid.join(' '),
          reading.refused,
          standing.session,
        ]);
      }
    }
  }
  return toCsv(header, rows);
}

// ---- 死節點 ----

/** A node the dead-node report lists: never bought, low value, or a ★ greedy read. */
export interface DeadNode {
  readonly node: string;
  readonly kind: WebNodeKind;
  readonly board: BoardId;
  /** Sessions that bought it (its `bought` lists). */
  readonly sessions: number;
  /** Greedy's readings of it, its best gain, and its best gain ÷ shards when it costs shards. */
  readonly evaluations: number;
  readonly bestGain: number | null;
  readonly bestPerShard: number | null;
  readonly never: boolean;
  readonly low: boolean;
}

export interface DeadNodes {
  /** The median best gain ÷ shards over the evaluated shard-priced nodes; null with none. */
  readonly median: number | null;
  /** Nodes but the signature, and the evaluated shard-priced ones. */
  readonly total: number;
  readonly evaluated: number;
  /** The listed nodes in web order. */
  readonly nodes: readonly DeadNode[];
}

/**
 * The dead nodes of a web over `sessions` (impl:484; K11): the nodes no session bought (the union
 * of `bought`); the shard-priced nodes greedy read whose best gain ÷ shards is under
 * DEAD_NODE_SHARE × the median over the evaluated shard-priced nodes (a ★ costs no shards, so it
 * stays out of the ratio); and each ★ greedy read, with its best gain.
 */
export function deadNodes(
  web: AssembledWeb,
  sessions: readonly CharacterSessionResult[],
): DeadNodes {
  const boughtBy = new Map<string, number>();
  for (const session of sessions) {
    for (const id of new Set(session.bought)) boughtBy.set(id, (boughtBy.get(id) ?? 0) + 1);
  }
  const reads = new Map<string, { gain: number; perShard: number | null }[]>();
  for (const session of sessions) {
    for (const reading of session.evaluations ?? []) {
      const node = web.byId.get(reading.node);
      if (node === undefined) continue;
      const priced = PRICE_CURVE_OF[node.kind] !== null;
      const list = reads.get(node.id) ?? [];
      list.push({ gain: reading.gain, perShard: priced ? reading.gain / reading.shards : null });
      reads.set(node.id, list);
    }
  }
  const nodes = web.nodes.filter((node) => node.kind !== 'signature');
  const best = (values: readonly number[]): number | null =>
    values.length === 0 ? null : Math.max(...values);
  const rows = nodes.map((node) => {
    const list = reads.get(node.id) ?? [];
    return {
      node,
      bestGain: best(list.map(({ gain }) => gain)),
      bestPerShard: best(list.flatMap(({ perShard }) => (perShard === null ? [] : [perShard]))),
      evaluations: list.length,
    };
  });
  const evaluated = rows.flatMap(({ bestPerShard }) =>
    bestPerShard === null ? [] : [bestPerShard],
  );
  const mid = evaluated.length === 0 ? null : median(evaluated);
  const listed: DeadNode[] = [];
  for (const { node, bestGain, bestPerShard, evaluations } of rows) {
    const sessionsBought = boughtBy.get(node.id) ?? 0;
    const never = sessionsBought === 0;
    const low = mid !== null && bestPerShard !== null && bestPerShard < DEAD_NODE_SHARE * mid;
    const star = node.kind === 'keystone' && evaluations > 0;
    if (!never && !low && !star) continue;
    listed.push({
      node: node.id,
      kind: node.kind,
      board: node.board,
      sessions: sessionsBought,
      evaluations,
      bestGain,
      bestPerShard,
      never,
      low,
    });
  }
  return { median: mid, total: nodes.length, evaluated: evaluated.length, nodes: listed };
}

/** Every session of `character` the plan holds a result for: its units', then its legacy sessions'. */
function characterSessions(
  plan: CheckPlan,
  results: UnitResults,
  character: CharacterId,
): CharacterSessionResult[] {
  const ids = [
    ...plan.units
      .filter((unit) => unit.job.kind === 'character' && unit.job.config.character === character)
      .map((unit) => unit.id),
    ...Array.from({ length: plan.sessions }, (_, session) => legacyUnitId(character, session)),
  ];
  return ids.map((id) => sessionResultOf(results, id)).filter((result) => result !== null);
}

export const DEAD_NODES_STANDARD =
  'info: nodes no nightly session bought; shard-priced nodes whose best greedy gain ÷ shards is ' +
  `under ${DEAD_NODE_SHARE} × the evaluated median; ★ with their gain (初始值)`;

const gainText = (value: number | null): string =>
  value === null ? '—' : String(Number(value.toPrecision(3)));

/** The deadNodes rows: one info row per character, n/a without a session. */
export function deadNodesCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  return plan.characters.map((character) => {
    const sessions = characterSessions(plan, results, character);
    if (sessions.length === 0) {
      const detail = `no session of ${character} has a result`;
      return naRow('deadNodes', plan.set, character, DEAD_NODES_STANDARD, 'noData', detail);
    }
    const report = deadNodes(webOf(plan.content, character, 'full'), sessions);
    const never = report.nodes.filter((node) => node.never).length;
    const low = report.nodes.filter((node) => node.low).map((node) => node.node);
    const stars = report.nodes
      .filter((node) => node.kind === 'keystone' && node.evaluations > 0)
      .map((node) => `${node.node} ${gainText(node.bestGain)}`);
    const lows =
      report.median === null
        ? 'no greedy reading'
        : `${low.length} of ${report.evaluated} evaluated under ${DEAD_NODE_SHARE} × the median ` +
          `${gainText(report.median)}${low.length > 0 ? `: ${low.join(', ')}` : ''}`;
    return checkRow('deadNodes', plan.set, {
      subject: character,
      target: DEAD_NODES_STANDARD,
      measured:
        `never bought ${never} of ${report.total} over ${sessions.length} sessions; ${lows}; ` +
        `★ ${stars.length > 0 ? stars.join(', ') : 'none read'}`,
      status: 'info',
      evidence: [`dead_nodes.csv: ${character}`],
    });
  });
}

/** dead_nodes.csv: one line per listed node of each character, in web order. */
export function deadNodesCsv(plan: CheckPlan, results: UnitResults): string {
  const header = [
    'character',
    'node',
    'kind',
    'board',
    'never',
    'low',
    'sessions',
    'evaluations',
    'bestGain',
    'bestGainPerShard',
    'median',
  ];
  const rows: CsvValue[][] = [];
  for (const character of plan.characters) {
    const sessions = characterSessions(plan, results, character);
    if (sessions.length === 0) continue;
    const report = deadNodes(webOf(plan.content, character, 'full'), sessions);
    for (const node of report.nodes) {
      rows.push([
        character,
        node.node,
        node.kind,
        node.board,
        node.never,
        node.low,
        node.sessions,
        node.evaluations,
        node.bestGain,
        node.bestPerShard,
        report.median,
      ]);
    }
  }
  return toCsv(header, rows);
}
