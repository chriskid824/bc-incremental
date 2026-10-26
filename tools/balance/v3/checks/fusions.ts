/**
 * The fusion checks (docs/v3 C10 design §2.4): 融合強度, 鏡像融合, 雙融合組合 and 三融合組合.
 * Fusion strength re-measures a calibrated fusion at its entry's coef as calibrateFusion measures
 * it (tools/balance/v3/measures.ts), each calibration seed's ratio within [1.1, 1.3] and the digest
 * current, unless content.acceptedFails has the key; a median drifted past STRENGTH_DRIFT from the
 * entry's is info. The pr set reads the first hand fusion and the first template fusion with
 * entries (C10.2); the nightly every fusion, an uncalibrated one n/a. Mirrors compare a mirror
 * pair's damage makeups by source class on the strength measure's with-core runs. Doubles and
 * triples probe a character's fusions two and three at a time, with the investments that unlock
 * them, and FAIL a combination above COMBO_FAIL_RATIO × the character's median gain.
 */

import type { CharacterId, OuterId } from '../../../../src/data';
import { assembleWeb, FULL_SCOPE } from '../../../../src/data/web';
import type { CalibrationEntry, Content, FusionDef, FusionKey } from '../../../../src/data/web';
import { CALIBRATION_SEEDS, median, SEED_BAND } from '../../../../src/meta/web/calibrate';
import { toCsv } from '../../csv';
import type { CsvValue } from '../../csv';
import type { ContentRef } from '../content';
import type { ComboInput, ComboReading, MirrorReading } from '../measures';
import { checkRow, measureResultOf, naRow } from './types';
import type { CheckId, CheckPlan, CheckResult, PlanUnit, UnitResults } from './types';

/** calibrate.ts' SEED_BAND as ratios (初始值): every seed's strength in [1.1, 1.3], both ends in. */
export const STRENGTH_BAND = { min: 1 + SEED_BAND.min, max: 1 + SEED_BAND.max } as const;
/** A tenth of the +20 % target (初始值): a median moved this far is stale (C6F:104, F28). */
export const STRENGTH_DRIFT = 0.02;
/** impl:481's six mirror pairs (初始值): 火冰／冰火, 火雷／雷火, 火靈／火召喚, 冰雷／雷冰, 冰靈／冰召喚, 雷靈／雷召喚. */
export const MIRROR_PAIRS: readonly (readonly [FusionKey, FusionKey])[] = [
  ['fire.ice', 'ice.fire'],
  ['fire.lightning', 'lightning.fire'],
  ['fire.summon', 'summon.fire'],
  ['ice.lightning', 'lightning.ice'],
  ['ice.summon', 'summon.ice'],
  ['lightning.summon', 'summon.lightning'],
];
/** Damage makeups by class differ by at least a fifth (初始值): the L1 distance of the shares. */
export const MIRROR_MIN_L1 = 0.2;
/** Seeds per combination (初始值): CALIBRATION_SEEDS, so a pair reads like a calibration (C10/F6). */
export const DOUBLE_SEEDS = CALIBRATION_SEEDS;
export const TRIPLE_SEEDS = CALIBRATION_SEEDS;
/** A combination stronger than this many times its character's median gain FAILs (impl:486-487; 初始值). */
export const COMBO_FAIL_RATIO = 2;
/** The strongest and the weakest combinations listed (impl:486 「最強與最弱各 10 組」). */
export const COMBO_LISTED = 10;

/** Whether a seed's ratio is in STRENGTH_BAND, both ends included (calibrate.ts' form, C6AB R10). */
export const inStrengthBand = (ratio: number): boolean =>
  ratio >= STRENGTH_BAND.min && ratio <= STRENGTH_BAND.max;

/** impl:493's two PR fusions: a hand one, and a template one (a template override among them). */
export type StrengthGroup = 'hand' | 'template';
export const STRENGTH_GROUPS: readonly StrengthGroup[] = ['hand', 'template'];

const groupOf = (kind: FusionDef['kind']): StrengthGroup => (kind === 'hand' ? 'hand' : 'template');

export interface StrengthTarget {
  readonly group: StrengthGroup;
  /** The fusion measured; for a group without an entry, its first fusion; null for no fusion. */
  readonly key: FusionKey | null;
  /** The fusion's digest now. */
  readonly digest: string | null;
  /** Its calibration entry; null when no fusion of the group has one. */
  readonly entry: CalibrationEntry | null;
  /** content.acceptedFails' reason for the key, null for none. */
  readonly accepted: string | null;
}

/** The characters' fusions in order, each web's in clock order (FULL_SCOPE, as calibration assembles them). */
const fusionsOf = (content: Content, characters: readonly CharacterId[]): FusionDef[] =>
  characters.flatMap((c) => [...assembleWeb(content, c, FULL_SCOPE).fusions.values()]);

const acceptedOf = (content: Content, key: FusionKey): string | null => {
  const reason = (content.acceptedFails[key] ?? '').trim();
  return reason === '' ? null : reason;
};

/**
 * Per group, the first fusion with a calibration entry, the characters in order and each web's
 * fusions in clock order (FULL_SCOPE, as calibration assembles them); without one, the group's
 * first fusion, uncalibrated.
 */
export function strengthTargets(
  content: Content,
  characters: readonly CharacterId[],
): StrengthTarget[] {
  const fusions = fusionsOf(content, characters);
  return STRENGTH_GROUPS.map((group) => {
    const ofGroup = fusions.filter((fusion) => groupOf(fusion.kind) === group);
    const calibrated = ofGroup.find((fusion) => content.calibrated[fusion.key] !== undefined);
    const fusion = calibrated ?? ofGroup[0];
    return {
      group,
      key: fusion?.key ?? null,
      digest: fusion?.digest ?? null,
      entry: calibrated === undefined ? null : (content.calibrated[calibrated.key] ?? null),
      accepted: fusion === undefined ? null : acceptedOf(content, fusion.key),
    };
  });
}

/**
 * The nightly's targets (design §1.4 「fusionStrength over every fusion」): every fusion of the
 * characters in the same order, each with its own entry, or none (uncalibrated).
 */
export function everyStrengthTarget(
  content: Content,
  characters: readonly CharacterId[],
): StrengthTarget[] {
  return fusionsOf(content, characters).map((fusion) => ({
    group: groupOf(fusion.kind),
    key: fusion.key,
    digest: fusion.digest,
    entry: content.calibrated[fusion.key] ?? null,
    accepted: acceptedOf(content, fusion.key),
  }));
}

/** A strength unit's id: the fusion and the seed index. */
export const strengthUnitId = (key: FusionKey, seed: number): string =>
  `measure:fusionStrength:${key}:${seed}`;

/** One unit of `measure` per seed s < entry.seeds of each calibrated target, at the entry's coef. */
function entryUnits(
  measure: 'fusionStrength' | 'mirror',
  content: ContentRef,
  targets: readonly StrengthTarget[],
  idOf: (key: FusionKey, seed: number) => string,
): PlanUnit[] {
  return targets.flatMap(({ key, entry }) =>
    key === null || entry === null
      ? []
      : Array.from({ length: entry.seeds }, (_, seed) => ({
          id: idOf(key, seed),
          job: { kind: 'measure', measure, input: { content, key, coef: entry.coef, seed } },
        })),
  );
}

/** One measure unit per seed s < entry.seeds of each calibrated target, at the entry's coef. */
export const strengthUnits = (
  content: ContentRef,
  targets: readonly StrengthTarget[],
): PlanUnit[] => entryUnits('fusionStrength', content, targets, strengthUnitId);

/** 4 decimals, as an entry keeps a ratio. */
const ratio4 = (value: number): string => String(Math.round(value * 1e4) / 1e4);

/** An entry with no seed: nothing to re-measure (lead ruling U16; npm run calibrate writes 1 or more). */
const NO_SEED = 'the entry has seeds: 0, so there is nothing to re-measure';

/** The strength rows: one per target; one noData row when the nightly's webs have no fusion. */
export function fusionStrengthCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const band = `[${STRENGTH_BAND.min}, ${STRENGTH_BAND.max}]`;
  if (plan.strength.length === 0) {
    const detail = 'no fusion in the webs';
    return [naRow('fusionStrength', plan.set, 'all', `every seed in ${band}`, 'noData', detail)];
  }
  return plan.strength.map((target) => {
    const subject = target.key ?? `${target.group} fusion`;
    const { entry } = target;
    if (target.key === null) {
      return naRow(
        'fusionStrength',
        plan.set,
        subject,
        `every seed in ${band}`,
        'noData',
        `no ${target.group} fusion in the webs`,
      );
    }
    if (entry === null) {
      return naRow(
        'fusionStrength',
        plan.set,
        subject,
        `every seed in ${band} (初始值)`,
        'uncalibrated',
        plan.set === 'pr'
          ? `no ${target.group} fusion has a calibration entry; ${target.key} is the first`
          : `${target.key} has no calibration entry`,
      );
    }
    const key = target.key;
    const standard = `every seed in ${band} at coef ${entry.coef}, ${entry.seeds} seeds; digest current (初始值)`;
    if (entry.seeds < 1) {
      return naRow('fusionStrength', plan.set, subject, standard, 'noData', NO_SEED);
    }
    const readings = Array.from({ length: entry.seeds }, (_, s) =>
      measureResultOf(results, strengthUnitId(key, s), 'fusionStrength'),
    );
    const ratios = readings.flatMap((reading) => (reading === null ? [] : [reading.ratio]));
    if (ratios.length < entry.seeds) {
      return naRow(
        'fusionStrength',
        plan.set,
        subject,
        standard,
        'noData',
        `${ratios.length} of ${entry.seeds} seeds measured`,
      );
    }
    const mid = median(ratios);
    const outside = ratios.filter((ratio) => !inStrengthBand(ratio)).length;
    const stale = entry.digest !== target.digest;
    const drifted = Math.abs(mid - entry.median) > STRENGTH_DRIFT;
    const notes = [
      ...(outside > 0 ? [`${outside} seed${outside === 1 ? '' : 's'} outside`] : []),
      ...(stale ? [`digest stale (${entry.digest} → ${target.digest ?? '—'})`] : []),
      ...(drifted ? [`drifted from ${entry.median}`] : []),
    ];
    const failed = outside > 0 || stale;
    return checkRow('fusionStrength', plan.set, {
      subject,
      target: standard,
      measured:
        `median ${ratio4(mid)} (min ${ratio4(Math.min(...ratios))}, max ${ratio4(Math.max(...ratios))}; ` +
        `entry ${entry.median})` +
        (notes.length > 0 ? `; ${notes.join('; ')}` : ''),
      status: failed ? 'FAIL' : drifted ? 'info' : 'pass',
      ...(failed && target.accepted !== null ? { accepted: target.accepted } : {}),
      evidence: [`checks.json: seeds ${ratios.map(ratio4).join(' ')}`],
    });
  });
}

// ---- 鏡像融合 ----

/** The classes a makeup compares, the center's with its ascendancy's (design §1.4's center share). */
export const MIRROR_CLASSES = ['center', 'hub', 'outer', 'fusion'] as const;
export type MirrorClass = (typeof MIRROR_CLASSES)[number];
export type MirrorShares = Readonly<Record<MirrorClass, number>>;

/** A mirror pair whose fusions both exist, with their strength targets (entries and digests). */
export interface MirrorTarget {
  readonly a: StrengthTarget;
  readonly b: StrengthTarget;
}

/** MIRROR_PAIRS whose fusions are both among the strength targets (the nightly's: every fusion). */
export function mirrorTargets(strength: readonly StrengthTarget[]): MirrorTarget[] {
  const byKey = new Map(strength.map((target) => [target.key, target]));
  return MIRROR_PAIRS.flatMap(([a, b]) => {
    const [ta, tb] = [byKey.get(a), byKey.get(b)];
    return ta === undefined || tb === undefined ? [] : [{ a: ta, b: tb }];
  });
}

/** A mirror unit's id: the fusion and the seed index (its strength unit's seed). */
export const mirrorUnitId = (key: FusionKey, seed: number): string =>
  `measure:mirror:${key}:${seed}`;

/** Each pair's fusions on their strength seeds and coefs, when both are calibrated. */
export const mirrorUnits = (content: ContentRef, strength: readonly StrengthTarget[]): PlanUnit[] =>
  entryUnits(
    'mirror',
    content,
    mirrorTargets(strength).flatMap(({ a, b }) =>
      a.entry === null || b.entry === null ? [] : [a, b],
    ),
    mirrorUnitId,
  );

/**
 * A fusion's makeup: damageBySource summed by class over its with-core runs (center + asc as one
 * class), each class over the total; why not, when a seed is unread or the runs dealt no damage.
 */
export function mirrorShares(
  readings: readonly Pick<MirrorReading, 'damage'>[],
  seeds: number,
): MirrorShares | string {
  if (seeds < 1) return NO_SEED;
  if (readings.length < seeds) return `${readings.length} of ${seeds} seeds measured`;
  const sums: Record<MirrorClass, number> = { center: 0, hub: 0, outer: 0, fusion: 0 };
  for (const { damage } of readings) {
    sums.center += damage.center + damage.asc;
    sums.hub += damage.hub;
    sums.outer += damage.outer;
    sums.fusion += damage.fusion;
  }
  const total = MIRROR_CLASSES.reduce((sum, cls) => sum + sums[cls], 0);
  if (!(total > 0)) return 'the with-core runs dealt no damage';
  return {
    center: sums.center / total,
    hub: sums.hub / total,
    outer: sums.outer / total,
    fusion: sums.fusion / total,
  };
}

/** Σ |a − b| over the classes, in MIRROR_CLASSES' order. */
export const mirrorL1 = (a: MirrorShares, b: MirrorShares): number =>
  MIRROR_CLASSES.reduce((sum, cls) => sum + Math.abs(a[cls] - b[cls]), 0);

/** Whether center + asc is the largest share, ties included. */
export const centerLargest = (shares: MirrorShares): boolean =>
  MIRROR_CLASSES.every((cls) => shares.center >= shares[cls]);

const share2 = (value: number): string => String(Number(value.toFixed(2)));
const sharesText = (shares: MirrorShares): string =>
  MIRROR_CLASSES.map(
    (cls) => `${cls === 'center' ? 'center + asc' : cls} ${share2(shares[cls])}`,
  ).join(', ');

export const MIRRORS_STANDARD =
  'class shares (center + asc, hub, outer, fusion) of damageBySource on the with-core runs: ' +
  `L1 ≥ ${MIRROR_MIN_L1}, center + asc each one's largest (初始值)`;

const mirrorReadings = (results: UnitResults, target: StrengthTarget): MirrorReading[] =>
  target.key === null || target.entry === null
    ? []
    : Array.from({ length: target.entry.seeds }, (_, s) =>
        measureResultOf(results, mirrorUnitId(target.key as FusionKey, s), 'mirror'),
      ).filter((reading) => reading !== null);

/** The mirrors rows: one per pair whose fusions both exist; one n/a row without any. */
export function mirrorsCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const targets = mirrorTargets(plan.strength);
  if (targets.length === 0) {
    return [
      plan.characters.length < 2
        ? naRow(
            'mirrors',
            plan.set,
            'all',
            MIRRORS_STANDARD,
            'oneCharacter',
            'a mirror pair needs two characters',
          )
        : naRow(
            'mirrors',
            plan.set,
            'all',
            MIRRORS_STANDARD,
            'noData',
            'no mirror pair has both fusions in the webs',
          ),
    ];
  }
  return targets.map(({ a, b }) => {
    const subject = `${a.key} ↔ ${b.key}`;
    const uncalibrated = [a, b].filter((t) => t.entry === null).map((t) => t.key);
    if (uncalibrated.length > 0) {
      const detail = `${uncalibrated.join(' and ')} ${uncalibrated.length === 1 ? 'has' : 'have'} no calibration entry`;
      return naRow('mirrors', plan.set, subject, MIRRORS_STANDARD, 'uncalibrated', detail);
    }
    const [sa, sb] = [a, b].map((t) =>
      mirrorShares(mirrorReadings(results, t), (t.entry as CalibrationEntry).seeds),
    ) as [MirrorShares | string, MirrorShares | string];
    if (typeof sa === 'string' || typeof sb === 'string') {
      const detail = typeof sa === 'string' ? `${a.key}: ${sa}` : `${b.key}: ${sb as string}`;
      return naRow('mirrors', plan.set, subject, MIRRORS_STANDARD, 'noData', detail);
    }
    const l1 = mirrorL1(sa, sb);
    const largest = centerLargest(sa) && centerLargest(sb);
    return checkRow('mirrors', plan.set, {
      subject,
      target: MIRRORS_STANDARD,
      measured:
        `L1 ${String(Number(l1.toFixed(3)))}; ${a.key}: ${sharesText(sa)}; ` +
        `${b.key}: ${sharesText(sb)}`,
      status: l1 >= MIRROR_MIN_L1 && largest ? 'pass' : 'FAIL',
      evidence: [`fusions.csv: ${a.key} ${b.key}`],
    });
  });
}

/** fusions.csv: one line per calibrated fusion and seed, its strength and its mirror run's damage. */
export function fusionsCsv(plan: CheckPlan, results: UnitResults): string {
  const header = [
    'key',
    'seed',
    'coef',
    'base',
    'with',
    'ratio',
    'center',
    'asc',
    'hub',
    'outer',
    'fusion',
  ];
  const rows: CsvValue[][] = [];
  for (const { key, entry } of plan.strength) {
    if (key === null || entry === null) continue;
    for (let s = 0; s < entry.seeds; s++) {
      const strength = measureResultOf(results, strengthUnitId(key, s), 'fusionStrength');
      const mirror = measureResultOf(results, mirrorUnitId(key, s), 'mirror');
      if (strength === null && mirror === null) continue;
      rows.push([
        key,
        s,
        entry.coef,
        strength?.base ?? null,
        strength?.with ?? null,
        strength?.ratio ?? null,
        mirror?.damage.center ?? null,
        mirror?.damage.asc ?? null,
        mirror?.damage.hub ?? null,
        mirror?.damage.outer ?? null,
        mirror?.damage.fusion ?? null,
      ]);
    }
  }
  return toCsv(header, rows);
}

// ---- 雙融合組合, 三融合組合 ----

export type ComboMeasure = 'double' | 'triple';

/** Every k-element combination of `items`, each in the items' order, in lexicographic order. */
export function combinations<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of combinations(items.slice(i + 1), k - 1)) out.push([item, ...rest]);
  });
  return out;
}

const COMBO_SIZE: Readonly<Record<ComboMeasure, number>> = { double: 2, triple: 3 };
const COMBO_SEEDS: Readonly<Record<ComboMeasure, number>> = {
  double: DOUBLE_SEEDS,
  triple: TRIPLE_SEEDS,
};
const COMBO_CHECK: Readonly<Record<ComboMeasure, CheckId>> = {
  double: 'doubles',
  triple: 'triples',
};

/** A combination's name: its outers joined with '+'. */
export const comboName = (outers: readonly OuterId[]): string => outers.join('+');

/** A double or triple unit's id: the character, the combination and the seed index. */
export const comboUnitId = (
  measure: ComboMeasure,
  character: CharacterId,
  outers: readonly OuterId[],
  seed: number,
): string => `measure:${measure}:${character}:${comboName(outers)}:${seed}`;

/**
 * Each character's combinations of its fusions (FULL_SCOPE, clock order), two or three at a time,
 * on DOUBLE_SEEDS or TRIPLE_SEEDS seeds: C(k, 2) and C(k, 3) for k fusions.
 */
export function comboUnits(
  measure: ComboMeasure,
  content: Content,
  ref: ContentRef,
  characters: readonly CharacterId[],
): PlanUnit[] {
  return characters.flatMap((character) => {
    const outers = [...assembleWeb(content, character, FULL_SCOPE).fusions.keys()];
    return combinations(outers, COMBO_SIZE[measure]).flatMap((combo) =>
      Array.from({ length: COMBO_SEEDS[measure] }, (_, seed): PlanUnit => ({
        id: comboUnitId(measure, character, combo, seed),
        job: {
          kind: 'measure',
          measure,
          input: { content: ref, character, outers: combo, seed },
        },
      })),
    );
  });
}

/** A combination's reading over its seeds. */
export interface ComboStat {
  readonly character: CharacterId;
  readonly outers: readonly OuterId[];
  /** Its seeds' readings, by seed. */
  readonly readings: readonly ComboReading[];
  /** Median ratio − 1 over the seeds; null while a seed is unread or refused. */
  readonly gain: number | null;
  /** The first refusal, or null. */
  readonly refused: string | null;
}

/** The plan's combinations of `measure` by character, in unit order, with their readings. */
export function comboStats(
  measure: ComboMeasure,
  plan: CheckPlan,
  results: UnitResults,
): Map<CharacterId, ComboStat[]> {
  const byCharacter = new Map<CharacterId, ComboStat[]>();
  const seen = new Set<string>();
  for (const unit of plan.units) {
    if (unit.job.kind !== 'measure' || unit.job.measure !== measure) continue;
    const { character, outers } = unit.job.input as ComboInput;
    const name = `${character}:${comboName(outers)}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const readings = Array.from({ length: COMBO_SEEDS[measure] }, (_, s) =>
      measureResultOf(results, comboUnitId(measure, character, outers, s), measure),
    ).filter((reading) => reading !== null);
    const refused = readings.find((reading) => reading.refused !== null)?.refused ?? null;
    const complete = readings.length === COMBO_SEEDS[measure] && refused === null;
    const stat: ComboStat = {
      character,
      outers,
      readings,
      gain: complete ? median(readings.map((reading) => reading.ratio as number)) - 1 : null,
      refused,
    };
    byCharacter.set(character, [...(byCharacter.get(character) ?? []), stat]);
  }
  return byCharacter;
}

/** The combinations by gain, the strongest first; ties keep the plan's order. */
export const strongestFirst = (stats: readonly ComboStat[]): ComboStat[] =>
  [...stats].sort((a, b) => (b.gain as number) - (a.gain as number));

/** The combinations by gain, the weakest first; ties keep the plan's order. */
export const weakestFirst = (stats: readonly ComboStat[]): ComboStat[] =>
  [...stats].sort((a, b) => (a.gain as number) - (b.gain as number));

/** The gains' median, and whether a combination is above COMBO_FAIL_RATIO × it. */
export const medianGain = (stats: readonly ComboStat[]): number =>
  median(stats.map((stat) => stat.gain as number));
export const aboveRatio = (gain: number, mid: number): boolean => gain > COMBO_FAIL_RATIO * mid;

const pct = (gain: number): string =>
  `${gain >= 0 ? '+' : '−'}${Number((Math.abs(gain) * 100).toFixed(1))}%`;
const listed = (stats: readonly ComboStat[]): string =>
  stats
    .slice(0, COMBO_LISTED)
    .map((stat) => `${comboName(stat.outers)} ${pct(stat.gain as number)}`)
    .join(', ');

export const comboStandard = (measure: ComboMeasure): string =>
  `${COMBO_SIZE[measure]} fusions with both investments and every core ` +
  `(${measure === 'triple' ? '奇點 beaten for the third slot' : '2 slots'}): gain = median ratio − 1 ` +
  `over ${COMBO_SEEDS[measure]} seeds; FAIL above ${COMBO_FAIL_RATIO} × the character's median ` +
  `gain; the top and bottom ${COMBO_LISTED} listed (初始值)`;

/**
 * The doubles or triples rows: per character with combinations, one row listing the strongest
 * and weakest COMBO_LISTED (pass, or info when some combination FAILs), then one FAIL row per
 * combination above COMBO_FAIL_RATIO × the median gain.
 */
export function comboCheck(
  measure: ComboMeasure,
  plan: CheckPlan,
  results: UnitResults,
): CheckResult[] {
  const id = COMBO_CHECK[measure];
  const csv = measure === 'double' ? 'doubles.csv' : 'triples.csv';
  const standard = comboStandard(measure);
  const stats = comboStats(measure, plan, results);
  const rows: CheckResult[] = [];
  for (const character of plan.characters) {
    const ofCharacter = stats.get(character) ?? [];
    if (ofCharacter.length === 0) {
      const detail = `${character} has fewer than ${COMBO_SIZE[measure]} fusions`;
      rows.push(naRow(id, plan.set, character, standard, 'noData', detail));
      continue;
    }
    const refused = ofCharacter.find((stat) => stat.refused !== null);
    if (refused !== undefined) {
      const detail = `${comboName(refused.outers)}: a purchase is refused: ${refused.refused}`;
      rows.push(naRow(id, plan.set, character, standard, 'noData', detail));
      continue;
    }
    const read = ofCharacter.filter((stat) => stat.gain !== null).length;
    if (read < ofCharacter.length) {
      const detail = `${read} of ${ofCharacter.length} combinations read on every seed`;
      rows.push(naRow(id, plan.set, character, standard, 'noData', detail));
      continue;
    }
    const mid = medianGain(ofCharacter);
    const above = ofCharacter.filter((stat) => aboveRatio(stat.gain as number, mid));
    rows.push(
      checkRow(id, plan.set, {
        subject: character,
        target: standard,
        measured:
          `${ofCharacter.length} combinations, median gain ${pct(mid)}; strongest ` +
          `${listed(strongestFirst(ofCharacter))}; weakest ${listed(weakestFirst(ofCharacter))}` +
          (above.length > 0 ? `; ${above.length} above ${COMBO_FAIL_RATIO} × the median` : ''),
        status: above.length === 0 ? 'pass' : 'info',
        evidence: [`${csv}: ${character}`],
      }),
    );
    for (const stat of above) {
      rows.push(
        checkRow(id, plan.set, {
          subject: `${character} × ${comboName(stat.outers)}`,
          target: `gain ≤ ${COMBO_FAIL_RATIO} × ${character}'s median gain (初始值)`,
          measured: `gain ${pct(stat.gain as number)} > ${COMBO_FAIL_RATIO} × ${pct(mid)}`,
          status: 'FAIL',
          evidence: [`${csv}: ${character} ${comboName(stat.outers)}`],
        }),
      );
    }
  }
  return rows;
}

export const doublesCheck = (plan: CheckPlan, results: UnitResults): CheckResult[] =>
  comboCheck('double', plan, results);
export const triplesCheck = (plan: CheckPlan, results: UnitResults): CheckResult[] =>
  comboCheck('triple', plan, results);

/**
 * doubles.csv or triples.csv: one line per combination and seed, with the combination's gain, its
 * rank by gain (1 the strongest) and whether it is above COMBO_FAIL_RATIO × the median, once every
 * combination of its character is read.
 */
export function comboCsv(measure: ComboMeasure, plan: CheckPlan, results: UnitResults): string {
  const header = [
    'character',
    'outers',
    'seed',
    'base',
    'with',
    'ratio',
    'refused',
    'gain',
    'rank',
    'above',
  ];
  const rows: CsvValue[][] = [];
  for (const [character, stats] of comboStats(measure, plan, results)) {
    const complete = stats.every((stat) => stat.gain !== null);
    const mid = complete ? medianGain(stats) : null;
    const ranks = complete ? strongestFirst(stats) : [];
    for (const stat of stats) {
      for (const reading of stat.readings) {
        rows.push([
          character,
          comboName(stat.outers),
          reading.seed,
          reading.base,
          reading.with,
          reading.ratio,
          reading.refused,
          stat.gain,
          complete ? ranks.indexOf(stat) + 1 : null,
          mid === null ? null : aboveRatio(stat.gain as number, mid),
        ]);
      }
    }
  }
  return toCsv(header, rows);
}

export const doublesCsv = (plan: CheckPlan, results: UnitResults): string =>
  comboCsv('double', plan, results);
export const triplesCsv = (plan: CheckPlan, results: UnitResults): string =>
  comboCsv('triple', plan, results);
