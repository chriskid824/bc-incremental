/**
 * 關鍵天賦, keystones (docs/v3 C10 design §2.2's keystones row): every visible ★, the center's two
 * and each open outer's (impl:545, :555), measured on a default session's prestige-point snapshot
 * (tools/balance/v3/measures.ts' measureKeystone): the median frontier x with the ★ less the median
 * without it, over KEYSTONE_SEEDS seeds, in M1's +4 to +6 waves. The measures read a session's
 * snapshot, so their units come in a plan's second phase (run.ts' derivedUnits).
 */

import type { CharacterId } from '../../../../src/data';
import { isCenterBoard } from '../../../../src/meta/web/counts';
import { median } from '../../../../src/meta/web/calibrate';
import { toCsv } from '../../csv';
import type { CsvValue } from '../../csv';
import { TARGET_GAIN } from '../../keystones';
import { webOf } from '../content';
import type { ContentRef } from '../content';
import type { KeystoneReading } from '../measures';
import type { SessionSnapshot } from '../session';
import {
  checkRow,
  FRESH_ACCOUNT,
  measureResultOf,
  naRow,
  sessionConfigOf,
  sessionResultOf,
  sessionUnitId,
} from './types';
import type { CheckPlan, CheckResult, PlanUnit, UnitResults } from './types';

/** Probe seeds per ★ (design §2.2; 初始值): the same 16 for every session and ★. */
export const KEYSTONE_SEEDS = 16;
/** M1's archetype band (tools/balance/keystones.ts' TARGET_GAIN; GDD §9.1): +4 to +6 waves (初始值). */
export const KEYSTONE_GAIN = { low: TARGET_GAIN.low, high: TARGET_GAIN.high } as const;
/**
 * ★ slugs measured as info, never judged (初始值): impl:485 「玻璃大砲維持賭博」. None is written
 * yet; a gamble's batch adds its slug.
 */
export const KEYSTONE_GAMBLES: readonly string[] = [];

/** A visible ★ of a character's web. */
export interface KeystoneTarget {
  readonly character: CharacterId;
  /** The ★'s node id. */
  readonly star: string;
  /** Its slug, the id's last part (src/data/web/ids.ts), which KEYSTONE_GAMBLES names. */
  readonly slug: string;
  readonly board: string;
}

/**
 * The visible ★ of each character's full web (the sessions' scope), in web order: the center's and
 * each open outer's. The hub's are left out, as the design's row lists them.
 */
export function keystoneTargets(
  content: ContentRef,
  characters: readonly CharacterId[],
): KeystoneTarget[] {
  return characters.flatMap((character) =>
    webOf(content, character, 'full')
      .nodes.filter(
        (node) =>
          node.kind === 'keystone' &&
          (isCenterBoard(node.board) || node.board.startsWith('outer.')),
      )
      .map((node) => ({
        character,
        star: node.id,
        slug: node.id.slice(node.id.lastIndexOf('.') + 1),
        board: node.board,
      })),
  );
}

/** A ★ measure unit's id: the character, the ★ and the seed index. */
export const keystoneUnitId = (character: CharacterId, star: string, seed: number): string =>
  `measure:keystone:${character}:${star}:${seed}`;

/** The snapshot the ★ of `character` are measured on: its lowest-index default session's prestige point. */
export function keystoneSnapshot(
  plan: CheckPlan,
  results: UnitResults,
  character: CharacterId,
): { readonly session: number; readonly snapshot: SessionSnapshot } | null {
  for (let session = 0; session < plan.sessions; session++) {
    const result = sessionResultOf(results, sessionUnitId(character, session));
    const snapshot = result?.snapshots.find((snap) => snap.minutes === 'prestige');
    if (snapshot !== undefined) return { session, snapshot };
  }
  return null;
}

/**
 * The second phase's ★ units (design §2.2; run.ts' derivedUnits): for each target whose character
 * has a prestige-point snapshot, KEYSTONE_SEEDS measures on it, with that session's account and
 * economy. None when the plan has no keystones check.
 */
export function keystoneUnits(plan: CheckPlan, results: UnitResults): PlanUnit[] {
  if (!plan.checks.includes('keystones')) return [];
  return plan.keystones.flatMap(({ character, star }) => {
    const found = keystoneSnapshot(plan, results, character);
    if (found === null) return [];
    const config = sessionConfigOf(plan, sessionUnitId(character, found.session));
    return Array.from({ length: KEYSTONE_SEEDS }, (_, seed): PlanUnit => ({
      id: keystoneUnitId(character, star, seed),
      job: {
        kind: 'measure',
        measure: 'keystone',
        input: {
          content: plan.content,
          character,
          star,
          snapshot: found.snapshot.progress,
          account: config.account ?? FRESH_ACCOUNT,
          economy: config.economy,
          seed,
        },
      },
    }));
  });
}

/** The readings of a target's KEYSTONE_SEEDS units that have one, by seed. */
function readingsOf(results: UnitResults, target: KeystoneTarget): KeystoneReading[] {
  return Array.from({ length: KEYSTONE_SEEDS }, (_, seed) =>
    measureResultOf(results, keystoneUnitId(target.character, target.star, seed), 'keystone'),
  ).filter((reading) => reading !== null);
}

const waves = (value: number): string => String(Number(value.toFixed(2)));
const signed = (value: number): string => (value >= 0 ? '+' : '−') + waves(Math.abs(value));

/** The keystones rows: one per visible ★, a gamble's (`gambles`, by slug) as info. */
export function keystonesCheck(
  plan: CheckPlan,
  results: UnitResults,
  gambles: readonly string[] = KEYSTONE_GAMBLES,
): CheckResult[] {
  const band = `[+${KEYSTONE_GAIN.low}, +${KEYSTONE_GAIN.high}]`;
  const target =
    `median x(with) − median x(without) over ${KEYSTONE_SEEDS} seeds in ${band} waves ` +
    '(初始值)';
  if (plan.keystones.length === 0) {
    return [naRow('keystones', plan.set, 'all', target, 'noData', 'no visible ★ on the webs')];
  }
  return plan.keystones.map((keystone) => {
    const subject = `${keystone.character} × ${keystone.star}`;
    const gamble = gambles.includes(keystone.slug);
    const standard = gamble ? `${target}; a gamble (KEYSTONE_GAMBLES): info` : target;
    const found = keystoneSnapshot(plan, results, keystone.character);
    if (found === null) {
      return naRow(
        'keystones',
        plan.set,
        subject,
        standard,
        'noData',
        `no default session of ${keystone.character} reached the prestige point`,
      );
    }
    const readings = readingsOf(results, keystone);
    if (readings.length < KEYSTONE_SEEDS) {
      return naRow(
        'keystones',
        plan.set,
        subject,
        standard,
        'noData',
        `${readings.length} of ${KEYSTONE_SEEDS} seeds measured`,
      );
    }
    const refused = readings.find((reading) => reading.refused !== null);
    if (refused !== undefined) {
      return naRow(
        'keystones',
        plan.set,
        subject,
        standard,
        'noData',
        `a purchase is refused on session ${found.session}'s prestige point: ${refused.refused}`,
      );
    }
    const withX = median(readings.map((reading) => reading.with as number));
    const withoutX = median(readings.map((reading) => reading.without as number));
    const gain = withX - withoutX;
    const inBand = gain >= KEYSTONE_GAIN.low && gain <= KEYSTONE_GAIN.high;
    const route = readings[0]?.route.length ?? 0;
    return checkRow('keystones', plan.set, {
      subject,
      target: standard,
      measured:
        `${signed(gain)} (x ${waves(withX)} with, ${waves(withoutX)} without; session ` +
        `${found.session}'s prestige point, ${route} route and gate purchases)`,
      status: gamble ? 'info' : inBand ? 'pass' : 'FAIL',
      evidence: [`keystones.csv: ${keystone.character} ${keystone.star}`],
    });
  });
}

/** keystones.csv: one line per ★ and seed, with the snapshot's session and the purchases made. */
export function keystonesCsv(plan: CheckPlan, results: UnitResults): string {
  const header = [
    'character',
    'star',
    'slug',
    'session',
    'seed',
    'with',
    'without',
    'gain',
    'route',
    'refused',
  ];
  const rows: CsvValue[][] = [];
  for (const keystone of plan.keystones) {
    const session = keystoneSnapshot(plan, results, keystone.character)?.session ?? null;
    for (const reading of readingsOf(results, keystone)) {
      rows.push([
        keystone.character,
        keystone.star,
        keystone.slug,
        session,
        reading.seed,
        reading.with,
        reading.without,
        reading.with === null || reading.without === null ? null : reading.with - reading.without,
        reading.route.join(' '),
        reading.refused,
      ]);
    }
  }
  return toCsv(header, rows);
}
