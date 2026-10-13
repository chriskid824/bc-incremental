/**
 * Start-wave probe (docs/GDD.md §2.2): the start wave the browser's picker
 * (highestClearedStartWave, src/meta/startWave.ts) offers each archetype's full sector at
 * several Might levels, next to how far one run of the same build gets, so an archetype the
 * picker holds back much more than the others stands out.
 *
 *   npx tsx tools/balance/startWaves.ts [--might 0,10,20,40] [--max-start-wave 40]
 *     [--seeds 8] [--start-wave 8] [--no-keystone]
 *
 * "reach" is the median highest wave one uncapped run reaches from --start-wave over --seeds
 * seeds, with the number of those runs the 3-minute limit stopped (a strong build that clears
 * slowly, such as burn at high Might, times out instead of dying); "picked" is the picker's
 * answer with maxStartWave and the game's wave cap (40). The share column is
 * picked ÷ min(reach, maxStartWave).
 */

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGameData } from '../../src/data';
import type { GameData } from '../../src/data';
import { highestClearedStartWave } from '../../src/meta';
import { runFrom, SECTORS, sectorBuild } from './builds';
import type { Sector } from './builds';
import { parseLevels } from './keystones';
import { median } from './probe';
import { formatTable } from './report';

/** The browser build's last wave (src/app/main.ts WAVE_CAP). */
export const GAME_WAVE_CAP = 40;

export interface StartWaveRow {
  readonly sector: Sector;
  readonly might: number;
  readonly picked: number;
  readonly reach: number;
  /** Runs of the reach measurement that ended on the time limit, not by death. */
  readonly timeouts: number;
  readonly runs: number;
}

export interface StartWaveProbeOptions {
  readonly might: readonly number[];
  readonly maxStartWave: number;
  readonly seeds: readonly number[];
  readonly startWave: number;
  readonly keystone: boolean;
}

export function measureStartWaves(data: GameData, options: StartWaveProbeOptions): StartWaveRow[] {
  const rows: StartWaveRow[] = [];
  for (const sector of SECTORS) {
    for (const might of options.might) {
      const meta = sectorBuild(data, sector, { keystone: options.keystone, might });
      const picked = highestClearedStartWave(meta, data, options.maxStartWave, {
        waveCap: GAME_WAVE_CAP,
      });
      const runs = options.seeds.map((seed) => runFrom(meta, data, options.startWave, seed));
      rows.push({
        sector,
        might,
        picked,
        reach: median(runs.map((run) => run.wave)),
        timeouts: runs.filter((run) => run.endReason === 'timeout').length,
        runs: runs.length,
      });
    }
  }
  return rows;
}

export function startWaveReport(rows: readonly StartWaveRow[], maxStartWave: number): string {
  const table: string[][] = [['sector', 'might', 'reach', 'timed out', 'picked', 'picked ÷ reach']];
  for (const row of rows) {
    const reach = Math.min(row.reach, maxStartWave);
    table.push([
      row.sector,
      String(row.might),
      String(row.reach),
      `${row.timeouts}/${row.runs}`,
      String(row.picked),
      reach > 0 ? (row.picked / reach).toFixed(2) : '-',
    ]);
  }
  return formatTable(table);
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      might: { type: 'string', default: '0,10,20,40' },
      'max-start-wave': { type: 'string', default: String(GAME_WAVE_CAP) },
      seeds: { type: 'string', default: '8' },
      'start-wave': { type: 'string', default: '8' },
      'no-keystone': { type: 'boolean', default: false },
    },
  });
  const maxStartWave = Number(values['max-start-wave']);
  const seedCount = Number(values.seeds);
  const startWave = Number(values['start-wave']);
  for (const [name, value] of [
    ['max-start-wave', maxStartWave],
    ['seeds', seedCount],
    ['start-wave', startWave],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be >= 1`);
  }
  const started = performance.now();
  const rows = measureStartWaves(loadGameData(), {
    might: parseLevels(values.might),
    maxStartWave,
    seeds: Array.from({ length: seedCount }, (_, i) => i + 1),
    startWave,
    keystone: !values['no-keystone'],
  });
  console.log(
    `Start-wave picker vs reach: full sector${values['no-keystone'] ? '' : ' + keystone'} + ` +
      `generic small nodes, maxStartWave ${maxStartWave}, reach = median of ${seedCount} ` +
      `uncapped runs from wave ${startWave}\n`,
  );
  console.log(startWaveReport(rows, maxStartWave));
  console.log(`\nWall time ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
