/**
 * Keystone value probe (docs/GDD.md §4.2, §9.1): adds each archetype keystone to its full
 * sector (plus the generic small nodes and some Might ranks) and measures how many more waves
 * one run reaches from a fixed start wave, over many seeds and Might levels. Glass Cannon is
 * measured on every sector too; it is meant to stay a gamble (life 1).
 *
 *   npx tsx tools/balance/keystones.ts [--seeds 16] [--start-wave 8] [--might 0-30:5]
 *     [--sectors crit,dot,chain] [--no-glass] [--beelines]
 *
 * Gain is median(with keystone) − median(without) over the seeds, as the round-2 judge
 * measured it; "paired" is the mean of the per-seed differences and "worst" the lowest one.
 * The summary checks the round-3 target for the archetype keystones: +4 to +6 waves at
 * Might 0 and 15, and never negative at any measured Might level.
 *
 * --beelines adds the keystone identity table: for each archetype, its full sector plus its
 * own keystone next to a build that buys only the sector's spine and then the shortest path
 * into each other archetype keystone (tools/balance/builds.ts beelineBuild), about as many
 * nodes. A foreign keystone far ahead of the own one means that keystone is the better pick
 * for this archetype too, which is not what a keystone of another archetype should be.
 */

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGameData } from '../../src/data';
import type { GameData } from '../../src/data';
import {
  allocatedNodes,
  beelineBuild,
  isSector,
  runFrom,
  SECTORS,
  sectorBuild,
  sectorKeystone,
} from './builds';
import type { Sector } from './builds';
import { median } from './probe';
import { formatTable } from './report';

/** Generic keystone measured on every sector. */
export const GAMBLE_KEYSTONE = 'glassCannon';

export interface KeystoneValue {
  readonly sector: Sector;
  readonly keystone: string;
  readonly might: number;
  /** Highest wave reached per seed, without and with the keystone. */
  readonly without: readonly number[];
  readonly with: readonly number[];
}

/** median(with) − median(without). */
export const medianGain = (value: KeystoneValue): number =>
  median(value.with) - median(value.without);

/** Mean of the per-seed differences. */
export function pairedGain(value: KeystoneValue): number {
  let sum = 0;
  value.with.forEach((wave, i) => (sum += wave - (value.without[i] ?? 0)));
  return value.with.length > 0 ? sum / value.with.length : NaN;
}

/** Lowest per-seed difference. */
export const worstGain = (value: KeystoneValue): number =>
  Math.min(...value.with.map((wave, i) => wave - (value.without[i] ?? 0)));

export interface KeystoneProbeOptions {
  readonly seeds: readonly number[];
  readonly startWave: number;
  readonly might: readonly number[];
  readonly sectors: readonly Sector[];
  /** Also measure GAMBLE_KEYSTONE on each sector. */
  readonly gamble: boolean;
}

/** Runs every sector × Might level × seed without and with each keystone. */
export function measureKeystones(data: GameData, options: KeystoneProbeOptions): KeystoneValue[] {
  const values: KeystoneValue[] = [];
  const reach = (sector: Sector, might: number, keystone: boolean, extra: string[]): number[] =>
    options.seeds.map(
      (seed) =>
        runFrom(
          sectorBuild(data, sector, { keystone, might, extra }),
          data,
          options.startWave,
          seed,
        ).wave,
    );
  for (const sector of options.sectors) {
    const own = sectorKeystone(data, sector).id;
    for (const might of options.might) {
      const without = reach(sector, might, false, []);
      values.push({ sector, keystone: own, might, without, with: reach(sector, might, true, []) });
      if (options.gamble) {
        values.push({
          sector,
          keystone: GAMBLE_KEYSTONE,
          might,
          without,
          with: reach(sector, might, false, [GAMBLE_KEYSTONE]),
        });
      }
    }
  }
  return values;
}

const show = (value: number): string => (Number.isFinite(value) ? String(+value.toFixed(1)) : '-');
const signed = (value: number): string => (value > 0 ? `+${show(value)}` : show(value));

export function keystoneReport(values: readonly KeystoneValue[]): string {
  const rows: string[][] = [
    ['sector', 'keystone', 'might', 'without', 'with', 'gain', 'paired', 'worst seed'],
  ];
  for (const value of values) {
    rows.push([
      value.sector,
      value.keystone,
      String(value.might),
      show(median(value.without)),
      show(median(value.with)),
      signed(medianGain(value)),
      signed(pairedGain(value)),
      signed(worstGain(value)),
    ]);
  }
  return formatTable(rows);
}

/** Round-3 target for an archetype keystone's median gain (docs/GDD.md §9.1). */
export const TARGET_GAIN = { low: 4, high: 6, atMight: [0, 15] } as const;

export interface KeystoneCheck {
  readonly keystone: string;
  /** Median gains at TARGET_GAIN.atMight, where measured. */
  readonly targetGains: readonly number[];
  /** Lowest median gain over every measured Might level, and where. */
  readonly lowest: number;
  readonly lowestAt: number;
  readonly pass: boolean;
}

/** TARGET_GAIN checked for each archetype keystone (Glass Cannon is a gamble, not checked). */
export function keystoneChecks(values: readonly KeystoneValue[]): KeystoneCheck[] {
  const checks: KeystoneCheck[] = [];
  const keystones = [...new Set(values.map((value) => value.keystone))];
  for (const keystone of keystones.filter((id) => id !== GAMBLE_KEYSTONE)) {
    const own = values.filter((value) => value.keystone === keystone);
    const targetGains = own
      .filter((value) => (TARGET_GAIN.atMight as readonly number[]).includes(value.might))
      .map(medianGain);
    let lowest = Infinity;
    let lowestAt = NaN;
    for (const value of own) {
      if (medianGain(value) < lowest) {
        lowest = medianGain(value);
        lowestAt = value.might;
      }
    }
    checks.push({
      keystone,
      targetGains,
      lowest,
      lowestAt,
      pass:
        lowest >= 0 &&
        targetGains.every((gain) => gain >= TARGET_GAIN.low && gain <= TARGET_GAIN.high),
    });
  }
  return checks;
}

export function formatKeystoneChecks(checks: readonly KeystoneCheck[]): string {
  return formatTable([
    ['keystone', `gain at might ${TARGET_GAIN.atMight.join('/')}`, 'lowest gain (might)', 'result'],
    ...checks.map((check) => [
      check.keystone,
      check.targetGains.length > 0 ? check.targetGains.map(signed).join(' / ') : '-',
      `${signed(check.lowest)} (${check.lowestAt})`,
      check.pass ? 'pass' : 'FAIL',
    ]),
  ]);
}

/** One archetype at one Might level: own sector + keystone vs beelines into the others. */
export interface BeelineValue {
  readonly sector: Sector;
  readonly might: number;
  /** Highest wave per seed of the full sector plus its own keystone. */
  readonly own: readonly number[];
  readonly ownNodes: number;
  readonly beelines: readonly {
    readonly keystone: string;
    readonly nodes: number;
    readonly waves: readonly number[];
  }[];
}

/** Runs each sector's own build and its beeline into every other sector's keystone. */
export function measureBeelines(
  data: GameData,
  options: Omit<KeystoneProbeOptions, 'gamble'>,
): BeelineValue[] {
  const values: BeelineValue[] = [];
  const waves = (meta: ReturnType<typeof sectorBuild>): number[] =>
    options.seeds.map((seed) => runFrom(meta, data, options.startWave, seed).wave);
  for (const sector of options.sectors) {
    for (const might of options.might) {
      const own = sectorBuild(data, sector, { keystone: true, might });
      const beelines = SECTORS.filter((other) => other !== sector).map((other) => {
        const keystone = sectorKeystone(data, other).id;
        const meta = beelineBuild(data, sector, keystone, might);
        return { keystone, nodes: allocatedNodes(meta, data), waves: waves(meta) };
      });
      values.push({
        sector,
        might,
        own: waves(own),
        ownNodes: allocatedNodes(own, data),
        beelines,
      });
    }
  }
  return values;
}

/** median(own) − the best median of the beelines. */
export const ownMargin = (value: BeelineValue): number =>
  median(value.own) - Math.max(...value.beelines.map((beeline) => median(beeline.waves)));

export function beelineReport(values: readonly BeelineValue[]): string {
  const rows: string[][] = [['sector', 'might', 'own (nodes)', 'beelines (nodes)', 'own − best']];
  for (const value of values) {
    rows.push([
      value.sector,
      String(value.might),
      `${show(median(value.own))} (${value.ownNodes})`,
      value.beelines.map((b) => `${b.keystone} ${show(median(b.waves))} (${b.nodes})`).join(', '),
      signed(ownMargin(value)),
    ]);
  }
  return formatTable(rows);
}

/** "0,15", "0-30" or "0-30:5" (inclusive range with a step). */
export function parseLevels(text: string): number[] {
  const levels: number[] = [];
  for (const part of text.split(',')) {
    const range = /^(\d+)-(\d+)(?::(\d+))?$/.exec(part.trim());
    if (range) {
      const [from, to, step] = [Number(range[1]), Number(range[2]), Number(range[3] ?? 1)];
      if (step < 1 || to < from) throw new Error(`Invalid range '${part}'`);
      for (let level = from; level <= to; level += step) levels.push(level);
    } else {
      const level = Number(part.trim());
      if (!Number.isInteger(level) || level < 0) throw new Error(`Invalid level '${part}'`);
      levels.push(level);
    }
  }
  return levels;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      seeds: { type: 'string', default: '16' },
      'start-wave': { type: 'string', default: '8' },
      might: { type: 'string', default: '0-30:5' },
      sectors: { type: 'string', default: SECTORS.join(',') },
      'no-glass': { type: 'boolean', default: false },
      beelines: { type: 'boolean', default: false },
    },
  });
  const seedCount = Number(values.seeds);
  const startWave = Number(values['start-wave']);
  if (!Number.isInteger(seedCount) || seedCount < 1) throw new Error('--seeds must be >= 1');
  if (!Number.isInteger(startWave) || startWave < 1) throw new Error('--start-wave must be >= 1');
  const sectors = values.sectors.split(',').map((id) => {
    const sector = id.trim();
    if (!isSector(sector)) throw new Error(`Unknown sector '${id}'`);
    return sector;
  });
  const options: KeystoneProbeOptions = {
    seeds: Array.from({ length: seedCount }, (_, i) => i + 1),
    startWave,
    might: parseLevels(values.might),
    sectors,
    gamble: !values['no-glass'],
  };
  const started = performance.now();
  const results = measureKeystones(loadGameData(), options);
  console.log(
    `Keystone value: full sector + generic small nodes, ${seedCount} seeds, ` +
      `one run from wave ${startWave}, highest wave reached (median)\n`,
  );
  console.log(keystoneReport(results));
  console.log(
    `\nArchetype keystones: +${TARGET_GAIN.low} to +${TARGET_GAIN.high} waves at Might ` +
      `${TARGET_GAIN.atMight.join(' and ')}, never negative`,
  );
  console.log(formatKeystoneChecks(keystoneChecks(results)));
  if (values.beelines) {
    console.log(
      '\nKeystone identity: full sector + own keystone vs the sector spine + the shortest ' +
        'path into another archetype keystone (highest wave, median)\n',
    );
    console.log(beelineReport(measureBeelines(loadGameData(), options)));
  }
  console.log(`\nWall time ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
