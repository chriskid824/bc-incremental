/**
 * Fusion calibration (docs/v3 C6 design D26, §4.10; F4, F28, AMB15; S-2): the coef that makes a
 * fusion core worth +20 % on the main curve. The probe of fusion c.o runs its unlock investment
 * (unlockInvestment: 「中心＋那塊外盤、不點融合」, impl:480) without and with the core, on 8 seeds,
 * each run from wave 1 to death or maxTicks 72,000, credited at its fractional frontier
 * x = F + φ: F its highest wave cleared, φ the share of wave F + 1's HP destroyed. A seed's
 * strength is stdHpAt(x with the core) / stdHpAt(x without), paired by seed; a coef's strength is
 * the median of the seeds'. The search bisects log coef inside the fusion's coefRange for a
 * median of 1.20, and the status says how it went: ok when every seed is within +10–30 %, spread
 * when one is not, weak or strong when the range cannot reach 1.20, insensitive when the coef
 * moves nothing. Everything runs in-process from the content given; tools/content/calibrate.ts
 * writes the entries to src/data/fusion/calibrated.ts.
 */

import { toNumber } from '../../core/num';
import { deriveSeed } from '../../core/rng';
import { composeWave } from '../../data/compose';
import { stdHp, stdHpAt } from '../../data/curve';
import { coefRange } from '../../data/fusion/sensitivity';
import type { CoefRange } from '../../data/fusion/sensitivity';
import { CHARACTER_IDS } from '../../data/sources';
import type { CharacterId, OuterId } from '../../data/sources';
import type { EnemyId, GameData } from '../../data/types';
import { assembleWeb } from '../../data/web/assemble';
import { FULL_SCOPE } from '../../data/web/scope';
import type {
  AssembledWeb,
  CalibrationEntry,
  CalibrationStatus,
  Content,
  FusionDef,
  FusionKey,
} from '../../data/web/types';
import type { TestModule } from '../../sim/rules';
import { createSimulation } from '../../sim/simulation';
import { NO_INPUT } from '../../sim/types';
import type { EnemyState } from '../../sim/types';
import { webBuild, webRunConfig } from './build';
import { auditBuy, unlockInvestment } from './invest';
import type { AccountProgress, CharacterProgress } from './types';

/** The runs' seeds: deriveSeed(CALIBRATION_SEED, 'calibrate:' + s) for seed s (L2). */
export const CALIBRATION_SEED = 1030;
export const CALIBRATION_SEEDS = 8;
/** A probe run's end when the build does not die first: 20 minutes (F4). */
export const PROBE_MAX_TICKS = 72_000;
export const PROBE_START_WAVE = 1;
/** The strength a fusion core is calibrated to: +20 % standard HP at the frontier (D26). */
export const TARGET_STRENGTH = 1.2;
/** Below this between the range's ends, the coef moves nothing (§4.10). */
export const INSENSITIVE_MARGIN = 0.05;
/** ok needs every seed's strength − 1 within this band (§4.10). */
export const SEED_BAND = { min: 0.1, max: 0.3 } as const;
export const BISECTION_STEPS = 12;
/** A fresh save's account (the lead's ruling R3): no prestige, 奇點 not beaten. */
export const CALIBRATION_ACCOUNT: AccountProgress = { singularityBeaten: false };

/** How a probe run's enemy ended. */
export type EnemyEnd = 'killed' | 'alive' | 'leaked';

/** One enemy of a probe run: its wave, its HP, its shells and how it ended. */
export interface EnemyFate {
  readonly wave: number;
  /** Its max life: a layered enemy's (the onion's, docs/v3 C7 design §2.8) is one shell's. */
  readonly maxHp: number;
  /** Its hp when it was killed, when it reached the player, or at the run's end. */
  readonly hp: number;
  readonly end: EnemyEnd;
  /** Its def's layer count for a layered enemy of a v3 run; 1 for every other. */
  readonly layers: number;
  /** Its record's layersLeft for a layered enemy of a v3 run as it ended; 1 for every other. */
  readonly layersLeft: number;
}

/**
 * What frontierOf reads of a run: every enemy that spawned, split children included, but the
 * extra ones (EnemyV3.extra: summons, the treasure), which waveHp does not count (C7/F12).
 */
export interface ProbeRun {
  readonly highestWaveCleared: number;
  readonly enemies: readonly EnemyFate[];
  readonly ticks: number;
  /** It reached maxTicks alive: measured all the same, and flagged (§4.10). */
  readonly timeout: boolean;
}

/** An enemy's HP in standard units with everything it splits into (dropUnits' recursion). */
function hpUnits(enemy: EnemyId, data: GameData, visiting: Set<EnemyId>): number {
  if (visiting.has(enemy)) throw new Error(`Cyclic splitInto through enemy ${enemy}`);
  const def = data.enemies[enemy];
  let units = def.hpMult;
  if (def.splitInto) {
    visiting.add(enemy);
    units += def.splitInto.count * hpUnits(def.splitInto.enemy, data, visiting);
    visiting.delete(enemy);
  }
  return units;
}

/**
 * The HP of all of `wave` (AMB15): composeWave's enemies, each its hpMult and its split
 * children's, recursively (src/meta/settle.ts' dropUnits), times the wave's standard HP.
 */
export function waveHp(wave: number, data: GameData): number {
  let units = 0;
  for (const entry of composeWave(wave, data.waves)) {
    units += entry.count * hpUnits(entry.enemy, data, new Set());
  }
  return units * stdHp(wave);
}

/**
 * The HP an enemy lost: a killed one all its shells, layers × maxHp; any other its broken shells,
 * (layers − layersLeft) × maxHp, and maxHp − hp of the one it holds, within [0, maxHp]. An enemy
 * with no shells has layers and layersLeft 1, so it loses maxHp or maxHp − hp as before C7.7.
 */
const lostHp = (fate: EnemyFate): number =>
  fate.end === 'killed'
    ? fate.layers * fate.maxHp
    : (fate.layers - fate.layersLeft) * fate.maxHp +
      Math.min(fate.maxHp, Math.max(0, fate.maxHp - fate.hp));

/**
 * A run's fractional frontier x = F + φ (AMB15): F its highest wave cleared, φ the HP that wave
 * F + 1's spawned enemies lost (killed ones whole, living ones and leaked ones what they lost
 * before the end or the player, an onion's broken shells included: lostHp) over waveHp(F + 1),
 * which counts an onion's whole hpMult.
 */
export function frontierOf(run: ProbeRun, data: GameData): number {
  const next = run.highestWaveCleared + 1;
  let lost = 0;
  for (const fate of run.enemies) if (fate.wave === next) lost += lostHp(fate);
  return run.highestWaveCleared + lost / waveHp(next, data);
}

/**
 * An enemy outside composeWave's count, which φ leaves out as waveHp does (C7/F12); greedy's
 * probes (tools/balance/v3/visit.ts probeFrom) leave it out too.
 */
export const isExtra = (enemy: EnemyState): boolean => enemy.v3 !== null && enemy.v3.extra;

/**
 * The fate of an enemy of a run of `data` ending `end`, read off its state: a layered enemy (a
 * v3 run's enemy whose def has a `layers` behaviour, the onion) has its def's layer count and its
 * record's layersLeft, every other 1 and 1. greedy's probes (tools/balance/v3/visit.ts probeFrom)
 * read their fates with it too.
 */
export function fateOf(enemy: EnemyState, end: EnemyEnd, data: GameData): EnemyFate {
  const behaviour = data.enemies[enemy.type].behaviour;
  const v3 = enemy.v3;
  const layered = v3 !== null && behaviour?.kind === 'layers';
  return {
    wave: enemy.wave,
    maxHp: toNumber(enemy.maxHp),
    hp: toNumber(enemy.hp),
    end,
    layers: layered ? behaviour.layers : 1,
    layersLeft: layered ? v3.layersLeft : 1,
  };
}

/**
 * One probe run (D26, F4): `progress` on `web` from PROBE_START_WAVE until the build dies or
 * `maxTicks`, with every enemy's fate: a watch module's onKill hook records each kill as it
 * happens, split children killed on the tick they appear included; the enemies new at each tick's
 * end are kept, and the playerHit events say which of them leaked (a bullet's bulletHit is no
 * leak). An extra enemy has no fate, killed, leaked or alive (isExtra).
 */
export function probeRun(
  web: AssembledWeb,
  progress: CharacterProgress,
  seed: number,
  data: GameData,
  maxTicks: number = PROBE_MAX_TICKS,
): ProbeRun {
  const killed = new Map<number, EnemyFate>();
  const watch: TestModule = (b) =>
    void b.hook('onKill', (_ctx, victim) => {
      if (!isExtra(victim)) killed.set(victim.id, fateOf(victim, 'killed', data));
    });
  const config = {
    ...webRunConfig(
      webBuild(web, progress),
      seed,
      PROBE_START_WAVE,
      web.scope.waveCap ?? undefined,
    ),
    maxTicks,
  };
  const sim = createSimulation(config, data, [watch]);
  const { state } = sim;
  const seen = new Map<number, EnemyState>();
  const leaked = new Set<number>();
  let newest = 0;
  while (!state.finished) {
    for (const event of sim.step(NO_INPUT)) {
      if (event.type === 'playerHit') leaked.add(event.enemyId);
    }
    // state.enemies is in id order, so the enemies new since the last tick are its tail.
    const { enemies } = state;
    for (let k = enemies.length - 1; k >= 0; k--) {
      const enemy = enemies[k] as EnemyState;
      if (enemy.id <= newest) break;
      if (!isExtra(enemy)) seen.set(enemy.id, enemy);
    }
    newest = Math.max(newest, enemies[enemies.length - 1]?.id ?? 0);
  }
  const fates: EnemyFate[] = [];
  for (const [id, enemy] of seen) {
    if (!killed.has(id)) fates.push(fateOf(enemy, leaked.has(id) ? 'leaked' : 'alive', data));
  }
  fates.push(...killed.values());
  const result = sim.result();
  return {
    highestWaveCleared: result.highestWaveCleared,
    enemies: fates,
    ticks: result.ticks,
    timeout: result.endReason === 'timeout',
  };
}

/** The median: the middle value, or the mean of the middle two of an even count. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of no values');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** A coef's strength: each seed's ratio and their median. */
export interface StrengthReading {
  readonly coef: number;
  readonly ratios: readonly number[];
  readonly median: number;
}

export interface SearchResult {
  readonly coef: number;
  readonly status: CalibrationStatus;
  /** The reading at `coef`, which the entry records. */
  readonly reading: StrengthReading;
  /** Every coef measured, in the order measured. */
  readonly readings: readonly StrengthReading[];
}

/** 3 significant digits (§4.10). */
export const roundCoef = (coef: number): number => Number(coef.toPrecision(3));

/**
 * §4.10's search over `range` (coefRange's; null for none), `measure` giving each seed's strength
 * at a coef. No range, or less than INSENSITIVE_MARGIN between the ends' medians: insensitive at
 * coef 1. A median below TARGET_STRENGTH at the top: weak at it; above it at the bottom: strong at
 * it. Otherwise BISECTION_STEPS halvings of log coef, the coef √(lo × hi) at 3 significant digits,
 * measured once more: ok when every seed's strength is within 1 + SEED_BAND, both ends included
 * (a seed at 1.10 or 1.30 is in), else spread. Each coef is measured once, so an end or coef 1
 * measured twice costs nothing.
 */
export function searchCoef(
  range: CoefRange | null,
  measure: (coef: number) => readonly number[],
): SearchResult {
  const readings: StrengthReading[] = [];
  const read = (coef: number): StrengthReading => {
    const known = readings.find((reading) => reading.coef === coef);
    if (known !== undefined) return known;
    const ratios = measure(coef);
    const reading = { coef, ratios, median: median(ratios) };
    readings.push(reading);
    return reading;
  };
  const settle = (coef: number, status: CalibrationStatus): SearchResult => ({
    coef,
    status,
    reading: read(coef),
    readings,
  });
  if (range === null) return settle(1, 'insensitive');
  let [lo, hi] = range;
  const bottom = read(lo);
  const top = read(hi);
  if (top.median - bottom.median < INSENSITIVE_MARGIN) return settle(1, 'insensitive');
  if (top.median < TARGET_STRENGTH) return settle(hi, 'weak');
  if (bottom.median > TARGET_STRENGTH) return settle(lo, 'strong');
  for (let step = 0; step < BISECTION_STEPS; step++) {
    const mid = Math.sqrt(lo * hi);
    if (read(mid).median < TARGET_STRENGTH) lo = mid;
    else hi = mid;
  }
  const coef = roundCoef(Math.sqrt(lo * hi));
  const reading = read(coef);
  const banded = reading.ratios.every(
    (ratio) => ratio >= 1 + SEED_BAND.min && ratio <= 1 + SEED_BAND.max,
  );
  return { coef, status: banded ? 'ok' : 'spread', reading, readings };
}

/** What calibrating one fusion measured, beside its entry. */
export interface CalibrationResult {
  readonly key: FusionKey;
  readonly kind: FusionDef['kind'];
  /** coefRange of the fusion; null for an insensitive one. */
  readonly range: CoefRange | null;
  readonly entry: CalibrationEntry;
  readonly readings: readonly StrengthReading[];
  /** Each seed's frontier without the core, and the runs, game ticks and timeouts in all. */
  readonly baseFrontiers: readonly number[];
  readonly runs: number;
  readonly ticks: number;
  readonly timeouts: number;
}

export interface CalibrateOptions {
  /** CALIBRATION_SEEDS by default (`npm run calibrate -- --seeds 8`). */
  readonly seeds?: number;
}

/** A ratio as the entry keeps it: 4 decimals. */
const kept = (value: number): number => Math.round(value * 1e4) / 1e4;

/**
 * Calibrates fusion `key`, c.o, of `content` (D26, §4.10; the lead's ruling R3): c's web in
 * FULL_SCOPE, the account of a fresh save, the base its unlock investment and the probe the base
 * with the core at rank 1, the web reassembled at each coef the search measures. Throws when c has
 * no center or its web no such fusion.
 */
export function calibrateFusion(
  content: Content,
  key: FusionKey,
  data: GameData,
  options: CalibrateOptions = {},
): CalibrationResult {
  const seeds = options.seeds ?? CALIBRATION_SEEDS;
  const [c, o] = key.split('.') as [CharacterId, OuterId];
  if (!CHARACTER_IDS.includes(c) || content.characters[c].center === null) {
    throw new Error(`calibrateFusion '${key}': character '${c}' has no center`);
  }
  const web = assembleWeb(content, c, FULL_SCOPE);
  const fusion = web.fusions.get(o);
  if (fusion === undefined) throw new Error(`calibrateFusion '${key}': no such fusion in the web`);
  const core = fusion.board.nodes.find((node) => node.kind === 'core');
  if (core === undefined) throw new Error(`calibrateFusion '${key}': the fusion has no core`);
  const base = unlockInvestment(web, CALIBRATION_ACCOUNT, o);
  const step = auditBuy(web, base, CALIBRATION_ACCOUNT, core.id);
  if (!step.ok) {
    throw new Error(`calibrateFusion '${key}': the core is refused: ${step.refusal.reason}`);
  }
  const withCore = step.progress;
  const seedOf = (s: number): number => deriveSeed(CALIBRATION_SEED, `calibrate:${s}`);
  const totals = { runs: 0, ticks: 0, timeouts: 0 };
  const probe = (at: AssembledWeb, progress: CharacterProgress, s: number): number => {
    const run = probeRun(at, progress, seedOf(s), data);
    totals.runs += 1;
    totals.ticks += run.ticks;
    if (run.timeout) totals.timeouts += 1;
    return frontierOf(run, data);
  };
  const seedIds = Array.from({ length: seeds }, (_, s) => s);
  const baseFrontiers = seedIds.map((s) => probe(web, base, s));
  const range = coefRange(fusion);
  const search = searchCoef(range, (coef) => {
    const at = assembleWeb(content, c, FULL_SCOPE, { coefs: { [key]: coef } });
    return seedIds.map(
      (s) => stdHpAt(probe(at, withCore, s)) / stdHpAt(baseFrontiers[s] as number),
    );
  });
  const { ratios } = search.reading;
  return {
    key,
    kind: fusion.kind,
    range,
    entry: {
      coef: search.coef,
      status: search.status,
      median: kept(search.reading.median),
      min: kept(Math.min(...ratios)),
      max: kept(Math.max(...ratios)),
      seeds,
      startWave: PROBE_START_WAVE,
      digest: fusion.digest,
    },
    readings: search.readings,
    baseFrontiers,
    ...totals,
  };
}
