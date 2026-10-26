/**
 * The balance pool's measure jobs (docs/v3 C10 design §1.1, §1.6): probe runs that read one
 * strength on the main curve, the fractional frontier x = F + φ (src/meta/web/calibrate.ts'
 * frontierOf). A measure's input and its reading are plain data, so a worker can take one and send
 * the other back, and a reading depends only on its input. C10.2's measures are `keystone` and
 * `fusionStrength`; C10.3's read single-type test waves (testWave.ts: `enemyRow`, `outerRow`,
 * `affix`) and an outer's investment (`deadBoard`). C10.4 adds `mirror`, `double` and `triple`.
 */

import { deriveSeed } from '../../../src/core/rng';
import { characterGameData, stdHpAt } from '../../../src/data';
import type { CharacterId, GameData, OuterId } from '../../../src/data';
import type { AssembledWeb, FusionKey, RowEnemy } from '../../../src/data/web';
import { refundNode } from '../../../src/meta/web';
import type { AccountProgress, CharacterProgress, WebEconomy } from '../../../src/meta/web';
import {
  CALIBRATION_ACCOUNT,
  CALIBRATION_SEED,
  frontierOf,
  PROBE_MAX_TICKS,
  PROBE_START_WAVE,
  probeRun,
} from '../../../src/meta/web/calibrate';
import { GATED_KINDS, storedRank } from '../../../src/meta/web/counts';
import { auditBuy, fillBoard, unlockInvestment } from '../../../src/meta/web/invest';
import { shortestRoute } from '../../../src/meta/web/path';
import { boardInvestment, deadBoardBase } from './checks/boards';
import type { BoardInvestment } from './checks/boards';
import { affixBitsOf, answerNode } from './checks/rows';
import { C10_SEED, webOf } from './content';
import type { ContentRef } from './content';
import type { SessionSnapshot } from './session';
import { eliteWaveData, rowSeed, testWaveData, testWaveRun } from './testWave';
import type { TestWaveReading } from './testWave';
import { probeFrom } from './visit';

/** Fusion c.o re-measured at its entry's coef, on one calibration seed (design §2.4's rule). */
export interface StrengthInput {
  readonly content: ContentRef;
  readonly key: FusionKey;
  /** content.calibrated[key].coef. */
  readonly coef: number;
  /** Seed index s: deriveSeed(CALIBRATION_SEED, 'calibrate:' + s), calibrateFusion's. */
  readonly seed: number;
}

export interface StrengthReading {
  readonly key: FusionKey;
  readonly seed: number;
  /** x of the unlock investment, and of it with the core at the coef. */
  readonly base: number;
  readonly with: number;
  /** stdHpAt(with) ÷ stdHpAt(base). */
  readonly ratio: number;
}

/** One ★ on a session's prestige-point snapshot, on one probe seed (design §2.2's keystones row). */
export interface KeystoneInput {
  readonly content: ContentRef;
  readonly character: CharacterId;
  /** The ★'s node id. */
  readonly star: string;
  /** The snapshot's progress. */
  readonly snapshot: CharacterProgress;
  /** The session's account and economy, for the refund and the purchases. */
  readonly account: AccountProgress;
  readonly economy: WebEconomy;
  /** Seed index s: deriveSeed(C10_SEED, 'keystone:' + s), the same for every session and ★. */
  readonly seed: number;
}

export interface KeystoneReading {
  readonly character: CharacterId;
  readonly star: string;
  readonly seed: number;
  /** x with the route, the gate and the ★, and without the ★; null when a purchase is refused. */
  readonly with: number | null;
  readonly without: number | null;
  /** The route's and the gate's purchases after the refund, in order. */
  readonly route: readonly string[];
  /** The refused purchase and canBuy's reason; null when every purchase is made. */
  readonly refused: string | null;
}

/** A session's DEAD_BOARD_MINUTES snapshot as a measure reads it (checks/boards.ts' boardSnapshot). */
export interface SnapshotInput {
  readonly content: ContentRef;
  readonly character: CharacterId;
  /** The snapshot's progress and what the session had earned by then. */
  readonly snapshot: CharacterProgress;
  readonly earned: SessionSnapshot['earned'];
  /** The session's account and economy, for the purchases. */
  readonly account: AccountProgress;
  readonly economy: WebEconomy;
}

/** A ROW_ENEMIES column's test wave on a snapshot, or with its answer node (design §2.3's enemyRow). */
export interface EnemyRowInput {
  readonly content: ContentRef;
  readonly character: CharacterId;
  readonly column: RowEnemy;
  readonly snapshot: CharacterProgress;
  readonly account: AccountProgress;
  /** Buy the nearest center node that answers the column first (checks/rows.ts' answerNode). */
  readonly answer: boolean;
  /** Seed index s: rowSeed(column, s), the same for every character and build. */
  readonly seed: number;
}

export interface EnemyRowReading {
  readonly character: CharacterId;
  readonly column: RowEnemy;
  readonly answer: boolean;
  readonly seed: number;
  /** The answer node; null on the snapshot alone, or when no center node answers the column. */
  readonly node: string | null;
  /** The route's and the node's purchases, in order. */
  readonly purchases: readonly string[];
  /** Why no wave was played: a refused purchase, or no answer node. */
  readonly refused: string | null;
  readonly run: TestWaveReading | null;
}

/** A covered column's test wave with an outer's investment (design §2.3's outerRow). */
export interface OuterRowInput extends SnapshotInput {
  readonly outer: OuterId;
  readonly column: RowEnemy;
  /** Seed index s: rowSeed(column, s), the enemy row's seeds. */
  readonly seed: number;
}

export interface OuterRowReading {
  readonly character: CharacterId;
  readonly outer: OuterId;
  readonly column: RowEnemy;
  readonly seed: number;
  /** The investment (checks/boards.ts' boardInvestment): bought, unpaid, the first refusal. */
  readonly bought: readonly string[];
  readonly unpaid: readonly string[];
  readonly refused: string | null;
  readonly run: TestWaveReading;
}

/** An elite test wave on a board, plain or with one affix (design §2.3's affixes; lead ruling L6). */
export interface AffixInput extends SnapshotInput {
  /** The board: null for the center (the snapshot), else the outer whose investment is added. */
  readonly outer: OuterId | null;
  readonly affixed: boolean;
  /** Seed index s: rowSeed('hexagon', s), the same plain and affixed. */
  readonly seed: number;
}

export interface AffixReading {
  readonly character: CharacterId;
  readonly outer: OuterId | null;
  readonly affixed: boolean;
  readonly seed: number;
  /** The elite's affix bits at spawn (checks/rows.ts' affixBitsOf); null when its view has none. */
  readonly bits: number | null;
  readonly bought: readonly string[];
  readonly unpaid: readonly string[];
  readonly refused: string | null;
  readonly run: TestWaveReading;
}

/** An outer's investment, or none (the base), probed on the main curve (design §2.3's deadBoards). */
export interface DeadBoardInput extends SnapshotInput {
  readonly outer: OuterId | null;
  /** Seed index s: deriveSeed(C10_SEED, 'deadBoard:' + s), the same for every board. */
  readonly seed: number;
}

export interface DeadBoardReading {
  readonly character: CharacterId;
  readonly outer: OuterId | null;
  readonly seed: number;
  /** The frontier x of the base, or of the base with the investment. */
  readonly x: number;
  readonly bought: readonly string[];
  readonly unpaid: readonly string[];
  readonly refused: string | null;
}

export interface MeasureInputs {
  readonly keystone: KeystoneInput;
  readonly fusionStrength: StrengthInput;
  readonly enemyRow: EnemyRowInput;
  readonly outerRow: OuterRowInput;
  readonly affix: AffixInput;
  readonly deadBoard: DeadBoardInput;
}
export interface MeasureReadings {
  readonly keystone: KeystoneReading;
  readonly fusionStrength: StrengthReading;
  readonly enemyRow: EnemyRowReading;
  readonly outerRow: OuterRowReading;
  readonly affix: AffixReading;
  readonly deadBoard: DeadBoardReading;
}
export type MeasureId = keyof MeasureInputs;
export type MeasureInput = MeasureInputs[MeasureId];
export type MeasureReading = MeasureReadings[MeasureId];

/** A probe run's x: `progress` on `web` from wave 1, on `seed` (calibration's probe). */
export type MeasureProbe = (
  web: AssembledWeb,
  progress: CharacterProgress,
  seed: number,
  data: GameData,
) => number;

const probeX: MeasureProbe = (web, progress, seed, data) =>
  frontierOf(probeRun(web, progress, seed, data), data);

/** The dead boards' x: visit.ts' probeFrom from PROBE_START_WAVE for PROBE_MAX_TICKS, calibration's probe. */
const boardX: MeasureProbe = (web, progress, seed, data) =>
  frontierOf(probeFrom(web, progress, seed, data, PROBE_START_WAVE, PROBE_MAX_TICKS), data);

/** A ★ measure's seed s (design §2.2: 16 seeds, the same for every session and ★). */
export const keystoneSeed = (s: number): number => deriveSeed(C10_SEED, `keystone:${s}`);

/** calibrateFusion's seed s. */
export const strengthSeed = (s: number): number => deriveSeed(CALIBRATION_SEED, `calibrate:${s}`);

/** A dead-board measure's seed s (design §2.3: 8 seeds, the same for every board). */
export const deadBoardSeed = (s: number): number => deriveSeed(C10_SEED, `deadBoard:${s}`);

/**
 * Fusion strength on one seed, as calibrateFusion measures it at a coef: c's web in FULL_SCOPE
 * with a fresh save's account, the base its unlockInvestment, the core bought through auditBuy,
 * and the probe of the base with the core on the web reassembled at `coef`.
 */
export function measureStrength(
  input: StrengthInput,
  probe: MeasureProbe = probeX,
): StrengthReading {
  const { key } = input;
  const [c, o] = key.split('.') as [CharacterId, OuterId];
  const web = webOf(input.content, c, 'full');
  const core = web.fusions.get(o)?.board.nodes.find((node) => node.kind === 'core');
  if (core === undefined)
    throw new Error(`fusionStrength '${key}': no such fusion core in the web`);
  const base = unlockInvestment(web, CALIBRATION_ACCOUNT, o);
  const step = auditBuy(web, base, CALIBRATION_ACCOUNT, core.id);
  if (!step.ok) {
    throw new Error(`fusionStrength '${key}': the core is refused: ${step.refusal.reason}`);
  }
  const data = characterGameData();
  const seed = strengthSeed(input.seed);
  const without = probe(web, base, seed, data);
  const at = webOf(input.content, c, 'full', { [key]: input.coef });
  const withCore = probe(at, step.progress, seed, data);
  return {
    key,
    seed: input.seed,
    base: without,
    with: withCore,
    ratio: stdHpAt(withCore) / stdHpAt(without),
  };
}

/** The gate refusals of canBuy's rows 7–9: the purchases that make them go are on the node's board. */
const GATE_REASONS: ReadonlySet<string> = new Set(['centerGate', 'outerGate', 'fusionGate']);

/** The ids `after` owns that `before` does not, in web order. */
const added = (web: AssembledWeb, before: CharacterProgress, after: CharacterProgress): string[] =>
  web.nodes
    .filter((node) => storedRank(after, node.id) > 0 && storedRank(before, node.id) === 0)
    .map((node) => node.id);

/**
 * A ★ on a prestige-point snapshot (design §2.2): base = the snapshot with the ★ refunded
 * (refundNode); without = base + the route to the ★ (shortestRoute through no gated kind) + the
 * ★'s gate (fillBoard on its board while canBuy refuses the ★ on a gate; a ★ has none as built);
 * with = without + the ★. Each purchase is an audit purchase (auditBuy), so the wallet never
 * refuses; a refusal (the ★ cap, say) is reported, not measured.
 */
export function measureKeystone(
  input: KeystoneInput,
  probe: MeasureProbe = probeX,
): KeystoneReading {
  const { character, star, account } = input;
  const web = webOf(input.content, character, 'full');
  const node = web.byId.get(star);
  if (node === undefined || node.kind !== 'keystone') {
    throw new Error(`keystone '${star}': no such ★ in ${character}'s web`);
  }
  const reading = (
    fields: Pick<KeystoneReading, 'with' | 'without' | 'route' | 'refused'>,
  ): KeystoneReading => ({ character, star, seed: input.seed, ...fields });
  const base = refundNode(web, input.snapshot, account, star, input.economy);
  const route = shortestRoute(web, base, star, (other) => !GATED_KINDS.has(other.kind));
  if (route === null) {
    return reading({ with: null, without: null, route: [], refused: `${star}: no route` });
  }
  let progress = base;
  for (const id of route.slice(0, -1)) {
    const step = auditBuy(web, progress, account, id);
    if (!step.ok) {
      const bought = added(web, base, progress);
      return reading({
        with: null,
        without: null,
        route: bought,
        refused: `${id}: ${step.refusal.reason}`,
      });
    }
    progress = step.progress;
  }
  const onGate = (p: CharacterProgress): boolean => {
    const step = auditBuy(web, p, account, star);
    return !step.ok && GATE_REASONS.has(step.refusal.reason);
  };
  progress = fillBoard(web, progress, account, node.board, (p) => !onGate(p));
  const bought = added(web, base, progress);
  const step = auditBuy(web, progress, account, star);
  if (!step.ok) {
    return reading({
      with: null,
      without: null,
      route: bought,
      refused: `${star}: ${step.refusal.reason}`,
    });
  }
  const data = characterGameData();
  const seed = keystoneSeed(input.seed);
  return reading({
    with: probe(web, step.progress, seed, data),
    without: probe(web, progress, seed, data),
    route: bought,
    refused: null,
  });
}

/**
 * A column's test wave on the snapshot, or with its answer node (design §2.3's enemyRow): the
 * nearest center node whose `answers` has the column (gd:767), its route and itself bought as audit
 * purchases (auditBuy), so only the rules refuse; a refusal, or no answering node, is reported and
 * no wave is played.
 */
export function measureEnemyRow(input: EnemyRowInput): EnemyRowReading {
  const { character, column, answer, seed } = input;
  const web = webOf(input.content, character, 'full');
  const reading = (
    fields: Pick<EnemyRowReading, 'node' | 'purchases' | 'refused' | 'run'>,
  ): EnemyRowReading => ({ character, column, answer, seed, ...fields });
  let progress = input.snapshot;
  let node: string | null = null;
  const purchases: string[] = [];
  if (answer) {
    const found = answerNode(web, progress, column);
    if (found === null) {
      return reading({ node, purchases, refused: `no center node answers ${column}`, run: null });
    }
    node = found.node;
    for (const id of found.route) {
      const step = auditBuy(web, progress, input.account, id);
      if (!step.ok) {
        return reading({ node, purchases, refused: `${id}: ${step.refusal.reason}`, run: null });
      }
      progress = step.progress;
      purchases.push(id);
    }
  }
  const data = testWaveData(characterGameData(), column);
  const run = testWaveRun(web, progress, data, rowSeed(column, seed));
  return reading({ node, purchases, refused: null, run });
}

/** The investment of `outer` on a snapshot (checks/boards.ts), `first` bought first. */
function invested(
  input: SnapshotInput,
  web: AssembledWeb,
  outer: OuterId,
  first: string | null,
): BoardInvestment {
  const base = deadBoardBase(web, input.snapshot, input.earned);
  return boardInvestment(web, base, input.account, input.economy, outer, first);
}

/**
 * A covered column's test wave with the outer's investment (design §2.3's outerRow): deadBoards'
 * investment, the outer's node that answers the column (its ◆) bought first.
 */
export function measureOuterRow(input: OuterRowInput): OuterRowReading {
  const { character, outer, column, seed } = input;
  const web = webOf(input.content, character, 'full');
  const board = `outer.${outer}`;
  const first =
    web.nodes.find((node) => node.board === board && node.answers.includes(column))?.id ?? null;
  const { progress, bought, unpaid, refused } = invested(input, web, outer, first);
  const data = testWaveData(characterGameData(), column);
  const run = testWaveRun(web, progress, data, rowSeed(column, seed));
  return { character, outer, column, seed, bought, unpaid, refused, run };
}

/**
 * An elite test wave on a board (design §2.3's affixes; lead ruling L6): the snapshot for the
 * center, with the outer's investment for an outer; the elite's affix bits read as it spawns.
 */
export function measureAffix(input: AffixInput): AffixReading {
  const { character, outer, affixed, seed } = input;
  const web = webOf(input.content, character, 'full');
  const { progress, bought, unpaid, refused } =
    outer === null
      ? { progress: input.snapshot, bought: [], unpaid: [], refused: null }
      : invested(input, web, outer, null);
  let bits: number | null = null;
  let seen = false;
  const run = testWaveRun(
    web,
    progress,
    eliteWaveData(characterGameData(), affixed),
    rowSeed('hexagon', seed),
    (enemy) => {
      if (seen) return;
      seen = true;
      bits = affixBitsOf(enemy.v3);
    },
  );
  return { character, outer, affixed, seed, bits, bought, unpaid, refused, run };
}

/**
 * The frontier x of an outer's investment on a snapshot, or of the base alone (design §2.3's
 * deadBoards): the base at best wave 30 with WALLET_SHARE of `earned`, the route to the outer's
 * entry and DEAD_BOARD_NODES of its board at real prices, probed as calibration probes.
 */
export function measureDeadBoard(
  input: DeadBoardInput,
  probe: MeasureProbe = boardX,
): DeadBoardReading {
  const { character, outer, seed } = input;
  const web = webOf(input.content, character, 'full');
  const { progress, bought, unpaid, refused } =
    outer === null
      ? {
          progress: deadBoardBase(web, input.snapshot, input.earned),
          bought: [],
          unpaid: [],
          refused: null,
        }
      : invested(input, web, outer, null);
  const x = probe(web, progress, deadBoardSeed(seed), characterGameData());
  return { character, outer, seed, x, bought, unpaid, refused };
}

/** Runs one measure here, in this thread. */
export function runMeasure(measure: MeasureId, input: MeasureInput): MeasureReading {
  switch (measure) {
    case 'keystone':
      return measureKeystone(input as KeystoneInput);
    case 'fusionStrength':
      return measureStrength(input as StrengthInput);
    case 'enemyRow':
      return measureEnemyRow(input as EnemyRowInput);
    case 'outerRow':
      return measureOuterRow(input as OuterRowInput);
    case 'affix':
      return measureAffix(input as AffixInput);
    case 'deadBoard':
      return measureDeadBoard(input as DeadBoardInput);
  }
}
