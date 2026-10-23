/**
 * The balance pool's measure jobs (docs/v3 C10 design §1.1, §1.6): probe runs that read one
 * strength on the main curve, the fractional frontier x = F + φ (src/meta/web/calibrate.ts'
 * frontierOf). A measure's input and its reading are plain data, so a worker can take one and send
 * the other back, and a reading depends only on its input. C10.2's measures are `keystone` and
 * `fusionStrength`; C10.3 adds `enemyRow`, `outerRow`, `affix` and `deadBoard`, C10.4 `mirror`,
 * `double` and `triple`.
 */

import { deriveSeed } from '../../../src/core/rng';
import { characterGameData, stdHpAt } from '../../../src/data';
import type { CharacterId, GameData, OuterId } from '../../../src/data';
import type { AssembledWeb, FusionKey } from '../../../src/data/web';
import { refundNode } from '../../../src/meta/web';
import type { AccountProgress, CharacterProgress, WebEconomy } from '../../../src/meta/web';
import {
  CALIBRATION_ACCOUNT,
  CALIBRATION_SEED,
  frontierOf,
  probeRun,
} from '../../../src/meta/web/calibrate';
import { GATED_KINDS, storedRank } from '../../../src/meta/web/counts';
import { auditBuy, fillBoard, unlockInvestment } from '../../../src/meta/web/invest';
import { shortestRoute } from '../../../src/meta/web/path';
import { C10_SEED, webOf } from './content';
import type { ContentRef } from './content';

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

export interface MeasureInputs {
  readonly keystone: KeystoneInput;
  readonly fusionStrength: StrengthInput;
}
export interface MeasureReadings {
  readonly keystone: KeystoneReading;
  readonly fusionStrength: StrengthReading;
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

/** A ★ measure's seed s (design §2.2: 16 seeds, the same for every session and ★). */
export const keystoneSeed = (s: number): number => deriveSeed(C10_SEED, `keystone:${s}`);

/** calibrateFusion's seed s. */
export const strengthSeed = (s: number): number => deriveSeed(CALIBRATION_SEED, `calibrate:${s}`);

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

/** Runs one measure here, in this thread. */
export function runMeasure(measure: MeasureId, input: MeasureInput): MeasureReading {
  switch (measure) {
    case 'keystone':
      return measureKeystone(input as KeystoneInput);
    case 'fusionStrength':
      return measureStrength(input as StrengthInput);
  }
}
