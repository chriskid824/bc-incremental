/**
 * Fusion strength, 融合強度 (docs/v3 C10 design §2.4's fusionStrength row): a calibrated fusion
 * re-measured at its entry's coef as calibrateFusion measures it (tools/balance/v3/measures.ts),
 * each calibration seed's ratio within [1.1, 1.3] and the digest current, unless
 * content.acceptedFails has the key; a median drifted past STRENGTH_DRIFT from the entry's is
 * info. C10.2's pr set reads the first hand fusion and the first template fusion with entries;
 * C10.4 extends the nightly to every calibrated fusion, mirrors, doubles and triples.
 */

import type { CharacterId } from '../../../../src/data';
import { assembleWeb, FULL_SCOPE } from '../../../../src/data/web';
import type { CalibrationEntry, Content, FusionDef, FusionKey } from '../../../../src/data/web';
import { median, SEED_BAND } from '../../../../src/meta/web/calibrate';
import type { ContentRef } from '../content';
import { checkRow, measureResultOf, naRow } from './types';
import type { CheckPlan, CheckResult, PlanUnit, UnitResults } from './types';

/** calibrate.ts' SEED_BAND as ratios (初始值): every seed's strength in [1.1, 1.3], both ends in. */
export const STRENGTH_BAND = { min: 1 + SEED_BAND.min, max: 1 + SEED_BAND.max } as const;
/** A tenth of the +20 % target (初始值): a median moved this far is stale (C6F:104, F28). */
export const STRENGTH_DRIFT = 0.02;

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

/**
 * Per group, the first fusion with a calibration entry, the characters in order and each web's
 * fusions in clock order (FULL_SCOPE, as calibration assembles them); without one, the group's
 * first fusion, uncalibrated.
 */
export function strengthTargets(
  content: Content,
  characters: readonly CharacterId[],
): StrengthTarget[] {
  const fusions = characters.flatMap((c) => [
    ...assembleWeb(content, c, FULL_SCOPE).fusions.values(),
  ]);
  return STRENGTH_GROUPS.map((group) => {
    const ofGroup = fusions.filter((fusion) => groupOf(fusion.kind) === group);
    const calibrated = ofGroup.find((fusion) => content.calibrated[fusion.key] !== undefined);
    const fusion = calibrated ?? ofGroup[0];
    const reason = fusion === undefined ? '' : (content.acceptedFails[fusion.key] ?? '').trim();
    return {
      group,
      key: fusion?.key ?? null,
      digest: fusion?.digest ?? null,
      entry: calibrated === undefined ? null : (content.calibrated[calibrated.key] ?? null),
      accepted: reason === '' ? null : reason,
    };
  });
}

/** A strength unit's id: the fusion and the seed index. */
export const strengthUnitId = (key: FusionKey, seed: number): string =>
  `measure:fusionStrength:${key}:${seed}`;

/** One measure unit per seed s < entry.seeds of each calibrated target, at the entry's coef. */
export function strengthUnits(content: ContentRef, targets: readonly StrengthTarget[]): PlanUnit[] {
  return targets.flatMap(({ key, entry }) =>
    key === null || entry === null
      ? []
      : Array.from({ length: entry.seeds }, (_, seed) => ({
          id: strengthUnitId(key, seed),
          job: {
            kind: 'measure',
            measure: 'fusionStrength',
            input: { content, key, coef: entry.coef, seed },
          },
        })),
  );
}

/** 4 decimals, as an entry keeps a ratio. */
const ratio4 = (value: number): string => String(Math.round(value * 1e4) / 1e4);

/** The strength rows: one per target. */
export function fusionStrengthCheck(plan: CheckPlan, results: UnitResults): CheckResult[] {
  const band = `[${STRENGTH_BAND.min}, ${STRENGTH_BAND.max}]`;
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
        `no ${target.group} fusion has a calibration entry; ${target.key} is the first`,
      );
    }
    const key = target.key;
    const standard = `every seed in ${band} at coef ${entry.coef}, ${entry.seeds} seeds; digest current (初始值)`;
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
