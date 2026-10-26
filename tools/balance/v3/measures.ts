/**
 * The balance pool's measure jobs (docs/v3 C10 design §1.1, §1.6): probe runs that read one
 * strength on the main curve, the fractional frontier x = F + φ (src/meta/web/calibrate.ts'
 * frontierOf). A measure's input and its reading are plain data, so a worker can take one and send
 * the other back, and a reading depends only on its input. C10.2's measures are `keystone` and
 * `fusionStrength`; C10.3's read single-type test waves (testWave.ts: `enemyRow`, `outerRow`,
 * `affix`) and an outer's investment (`deadBoard`). C10.4's are `mirror` (the strength measure's
 * with-core run read for its damage by source), `double` and `triple` (a character's fusions two
 * or three at a time), `m1` (checks/m1.ts: the fingerprint and the probe, the M1 diffs) and
 * `fuzz` (checks/fuzz.ts: one build of the web fuzz).
 */

import { deriveSeed } from '../../../src/core/rng';
import { characterGameData, stdHpAt } from '../../../src/data';
import type { CharacterId, GameData, OuterId, SourceClass } from '../../../src/data';
import type { AssembledWeb, FusionKey, RowEnemy } from '../../../src/data/web';
import { boardCounts, refundNode, WEB_RULES, webBuild, webRunConfig } from '../../../src/meta/web';
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
import { createSimulation, NO_INPUT } from '../../../src/sim';
import { boardInvestment, deadBoardBase } from './checks/boards';
import type { BoardInvestment } from './checks/boards';
import { measureFuzz } from './checks/fuzz';
import type { FuzzInput, FuzzReading } from './checks/fuzz';
import { measureM1 } from './checks/m1';
import type { M1Input, M1Reading } from './checks/m1';
import { affixBitsOf, answerNode } from './checks/rows';
import { C10_SEED, webOf } from './content';
import type { ContentRef } from './content';
import { damageByClass } from './session';
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
  /**
   * The owned ★ the base also refunded to make room under the keystone cap (lead ruling U12), the
   * last bought first; empty when the cap had room.
   */
  readonly refunded: readonly string[];
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

/** A strength measure's with-core run read for its damage (design §2.4's mirrors row). */
export interface MirrorReading {
  readonly key: FusionKey;
  readonly seed: number;
  /** damageBySource summed by sourceClass (v3/session.ts' damageByClass). */
  readonly damage: Readonly<Record<SourceClass, number>>;
  /** The run's highest wave cleared and ticks: the strength measure's with-core run's. */
  readonly highestWaveCleared: number;
  readonly ticks: number;
}

/** A character's fusions two or three at a time (design §2.4's doubles and triples rows). */
export interface ComboInput {
  readonly content: ContentRef;
  readonly character: CharacterId;
  /** The fusions' outers in the web's clock order: 2 for a double, 3 for a triple. */
  readonly outers: readonly OuterId[];
  /** Seed index s: comboSeed(measure, s), the same for every combination of the measure. */
  readonly seed: number;
}

export interface ComboReading {
  readonly character: CharacterId;
  readonly outers: readonly OuterId[];
  readonly seed: number;
  /** x of every outer's unlockInvestment, and of it with every core; null when one is refused. */
  readonly base: number | null;
  readonly with: number | null;
  /** stdHpAt(with) ÷ stdHpAt(base); null when a purchase is refused. */
  readonly ratio: number | null;
  /** The refused purchase and canBuy's reason; null when every purchase is made. */
  readonly refused: string | null;
}

export interface MeasureInputs {
  readonly keystone: KeystoneInput;
  readonly fusionStrength: StrengthInput;
  readonly enemyRow: EnemyRowInput;
  readonly outerRow: OuterRowInput;
  readonly affix: AffixInput;
  readonly deadBoard: DeadBoardInput;
  readonly mirror: StrengthInput;
  readonly double: ComboInput;
  readonly triple: ComboInput;
  readonly m1: M1Input;
  readonly fuzz: FuzzInput;
}
export interface MeasureReadings {
  readonly keystone: KeystoneReading;
  readonly fusionStrength: StrengthReading;
  readonly enemyRow: EnemyRowReading;
  readonly outerRow: OuterRowReading;
  readonly affix: AffixReading;
  readonly deadBoard: DeadBoardReading;
  readonly mirror: MirrorReading;
  readonly double: ComboReading;
  readonly triple: ComboReading;
  readonly m1: M1Reading;
  readonly fuzz: FuzzReading;
}
/** Every measure, in MeasureInputs' order: what a shard file may name (lead ruling U14). */
export const MEASURE_IDS = [
  'keystone',
  'fusionStrength',
  'enemyRow',
  'outerRow',
  'affix',
  'deadBoard',
  'mirror',
  'double',
  'triple',
  'm1',
  'fuzz',
] as const satisfies readonly (keyof MeasureInputs)[];
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

/** A double's or a triple's seed s: deriveSeed(C10_SEED, 'double:s' or 'triple:s'), the same for every combination. */
export const comboSeed = (measure: 'double' | 'triple', s: number): number =>
  deriveSeed(C10_SEED, `${measure}:${s}`);

/**
 * A combination's account (design §2.4): a fresh save's, calibration's, whose 2 fusion slots hold a
 * double; 奇點 beaten for a triple's third slot (src/meta/web/counts.ts' fusionSlotsAfterSingularity).
 */
export const COMBO_ACCOUNTS: Readonly<Record<'double' | 'triple', AccountProgress>> = {
  double: CALIBRATION_ACCOUNT,
  triple: { singularityBeaten: true },
};

/** Fusion c.o's calibration builds: c's FULL_SCOPE web, the base, the base with the core, the web at `coef`. */
interface StrengthBuilds {
  readonly web: AssembledWeb;
  readonly base: CharacterProgress;
  readonly withCore: CharacterProgress;
  readonly at: AssembledWeb;
}

/**
 * calibrateFusion's builds at a coef: c's web in FULL_SCOPE with a fresh save's account, the base
 * its unlockInvestment, the core bought through auditBuy, the web reassembled at `coef`. The
 * strength measure and the mirrors' read the same builds (lead ruling U3: one re-measure).
 */
function strengthBuilds(input: StrengthInput, measure: MeasureId): StrengthBuilds {
  const { key } = input;
  const [c, o] = key.split('.') as [CharacterId, OuterId];
  const web = webOf(input.content, c, 'full');
  const core = web.fusions.get(o)?.board.nodes.find((node) => node.kind === 'core');
  if (core === undefined) throw new Error(`${measure} '${key}': no such fusion core in the web`);
  const base = unlockInvestment(web, CALIBRATION_ACCOUNT, o);
  const step = auditBuy(web, base, CALIBRATION_ACCOUNT, core.id);
  if (!step.ok) {
    throw new Error(`${measure} '${key}': the core is refused: ${step.refusal.reason}`);
  }
  const at = webOf(input.content, c, 'full', { [key]: input.coef });
  return { web, base, withCore: step.progress, at };
}

/**
 * Fusion strength on one seed, as calibrateFusion measures it at a coef: the probe of the base, and
 * of the base with the core on the web reassembled at `coef` (strengthBuilds).
 */
export function measureStrength(
  input: StrengthInput,
  probe: MeasureProbe = probeX,
): StrengthReading {
  const { web, base, withCore, at } = strengthBuilds(input, 'fusionStrength');
  const data = characterGameData();
  const seed = strengthSeed(input.seed);
  const without = probe(web, base, seed, data);
  const withX = probe(at, withCore, seed, data);
  return {
    key: input.key,
    seed: input.seed,
    base: without,
    with: withX,
    ratio: stdHpAt(withX) / stdHpAt(without),
  };
}

/**
 * The run probeRun makes of `progress` on `web` (src/meta/web/calibrate.ts: from PROBE_START_WAVE,
 * the scope's wave cap, to the build's death or PROBE_MAX_TICKS), read for its damage by source
 * class instead of its frontier.
 */
export function classRun(
  web: AssembledWeb,
  progress: CharacterProgress,
  seed: number,
  data: GameData,
): Omit<MirrorReading, 'key' | 'seed'> {
  const config = {
    ...webRunConfig(
      webBuild(web, progress),
      seed,
      PROBE_START_WAVE,
      web.scope.waveCap ?? undefined,
    ),
    maxTicks: PROBE_MAX_TICKS,
  };
  const sim = createSimulation(config, data);
  while (!sim.state.finished) sim.step(NO_INPUT);
  const result = sim.result();
  return {
    damage: damageByClass(result),
    highestWaveCleared: result.highestWaveCleared,
    ticks: result.ticks,
  };
}

/**
 * A mirror's reading on one seed (design §2.4's mirrors row): the strength measure's with-core run
 * (the base with the core on the web at the entry's coef, on calibrateFusion's seed s), read for
 * its damage by source class.
 */
export function measureMirror(input: StrengthInput): MirrorReading {
  const { withCore, at } = strengthBuilds(input, 'mirror');
  const run = classRun(at, withCore, strengthSeed(input.seed), characterGameData());
  return { key: input.key, seed: input.seed, ...run };
}

/**
 * The fusions of `outers` together on `character`'s web (design §2.4's doubles and triples rows):
 * base = every outer's unlockInvestment, the first's then each next one's purchases it lacks in
 * the order that investment bought them; with = the base and each fusion's core, in `outers`'
 * order. Every purchase is an audit purchase (auditBuy), so only the rules refuse: the fusion slots
 * of `account` above all, and a refusal is reported, not measured. The web is the content's (its
 * calibrated coefs); both builds are probed on calibration's probe.
 */
export function measureCombo(
  measure: 'double' | 'triple',
  input: ComboInput,
  probe: MeasureProbe = probeX,
): ComboReading {
  const { character, outers, seed } = input;
  const account = COMBO_ACCOUNTS[measure];
  const web = webOf(input.content, character, 'full');
  const reading = (fields: Pick<ComboReading, 'base' | 'with' | 'ratio' | 'refused'>) => ({
    character,
    outers,
    seed,
    ...fields,
  });
  const refused = (id: string, reason: string) =>
    reading({ base: null, with: null, ratio: null, refused: `${id}: ${reason}` });
  const [first, ...others] = outers;
  if (first === undefined) throw new Error(`${measure}: no fusion to measure on ${character}`);
  let base = unlockInvestment(web, account, first);
  for (const outer of others) {
    const next = unlockInvestment(web, account, outer);
    for (const id of Object.keys(next.ranks)) {
      while (storedRank(base, id) < storedRank(next, id)) {
        const step = auditBuy(web, base, account, id);
        if (!step.ok) return refused(id, step.refusal.reason);
        base = step.progress;
      }
    }
  }
  let withCores = base;
  for (const outer of outers) {
    const core = web.fusions.get(outer)?.board.nodes.find((node) => node.kind === 'core');
    if (core === undefined) {
      throw new Error(`${measure} '${character}.${outer}': no such fusion core in the web`);
    }
    const step = auditBuy(web, withCores, account, core.id);
    if (!step.ok) return refused(core.id, step.refusal.reason);
    withCores = step.progress;
  }
  const data = characterGameData();
  const at = comboSeed(measure, seed);
  const baseX = probe(web, base, at, data);
  const withX = probe(web, withCores, at, data);
  return reading({
    base: baseX,
    with: withX,
    ratio: stdHpAt(withX) / stdHpAt(baseX),
    refused: null,
  });
}

/** The gate refusals of canBuy's rows 7–9: the purchases that make them go are on the node's board. */
const GATE_REASONS: ReadonlySet<string> = new Set(['centerGate', 'outerGate', 'fusionGate']);

/** The ids `after` owns that `before` does not, in web order. */
const added = (web: AssembledWeb, before: CharacterProgress, after: CharacterProgress): string[] =>
  web.nodes
    .filter((node) => storedRank(after, node.id) > 0 && storedRank(before, node.id) === 0)
    .map((node) => node.id);

/**
 * The owned ★ of `progress` in purchase order: its ranks' key order, which buy appends to and
 * refundNode keeps (src/meta/web/rules.ts).
 */
const ownedStars = (web: AssembledWeb, progress: CharacterProgress): string[] =>
  Object.keys(progress.ranks).filter(
    (id) => web.byId.get(id)?.kind === 'keystone' && storedRank(progress, id) > 0,
  );

/**
 * A ★ on a prestige-point snapshot (design §2.2): base = the snapshot with the ★ refunded
 * (refundNode), and, while the ★ the snapshot owns leave no room under the keystone cap, the owned
 * ★ bought last refunded too, then the one before (lead ruling U12); without = base + the route
 * to the ★ (shortestRoute through no gated kind) + the ★'s gate (fillBoard on its board while
 * canBuy refuses the ★ on a gate; a ★ has none as built); with = without + the ★. Each purchase is
 * an audit purchase (auditBuy), so the wallet never refuses; a refusal is reported, not measured.
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
  let base = refundNode(web, input.snapshot, account, star, input.economy);
  const refunded: string[] = [];
  while (boardCounts(web, base).keystones >= WEB_RULES.keystonesHeld) {
    const last = ownedStars(web, base).at(-1);
    if (last === undefined) break;
    base = refundNode(web, base, account, last, input.economy);
    refunded.push(last);
  }
  const reading = (
    fields: Pick<KeystoneReading, 'with' | 'without' | 'route' | 'refused'>,
  ): KeystoneReading => ({ character, star, seed: input.seed, ...fields, refunded });
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

/** Runs one measure here, in this thread; throws, naming it, for a measure it does not know (U14). */
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
    case 'mirror':
      return measureMirror(input as StrengthInput);
    case 'double':
    case 'triple':
      return measureCombo(measure, input as ComboInput);
    case 'm1':
      return measureM1(input as M1Input);
    case 'fuzz':
      return measureFuzz(input as FuzzInput);
    default:
      throw new Error(`Unknown measure '${String(measure satisfies never)}'`);
  }
}
