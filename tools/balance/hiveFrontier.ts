/**
 * The hive frontier report (docs/v3 C5 design PG5, §8.1 C5.4; Q5): how far the `?hive`
 * prototype's swarm gets beside M1 from the same profile. Each side plays FRONTIER_SESSIONS
 * balance sessions of the `balanced` strategy, FRONTIER_MINUTES simulated minutes each, from the
 * `?hive` preset (src/app/hivePreset.json, loaded through loadSave as main.ts loads it), with the
 * preset session's settings otherwise (tools/balance/hivePreset.ts): the swarm's runs with its
 * signature (SessionConfig.signature), M1's without one. Every session starts from a profile of
 * its own. It prints each side's frontier and minutes to waves 20 and 30, per session and their
 * mean, then the gap in waves. Under Q5 (A), a swarm frontier more than GAP_LIMIT waves below
 * M1's calls for the tuning commit C5.R. Writes nothing.
 *
 *   npx tsx tools/balance/hiveFrontier.ts
 *
 * A session's frontier is the highest wave its runs reached (RunRow.highestWaveReached), and its
 * minutes to wave N the play time at the end of its first run that reached N. The profile's
 * maxWave, which report.ts' minutesToWave reads, starts at the preset's own frontier, so it says
 * nothing of these sessions.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadGameData } from '../../src/data';
import type { GameData, SignatureSpec } from '../../src/data';
import { allowedStartWave } from '../../src/meta';
import type { MetaState } from '../../src/meta';
import { loadSave } from '../../src/save';
import { PRESET_PATH, PRESET_SESSION } from './hivePreset';
import { runSession } from './session';
import type { SessionConfig, SessionResult } from './session';

export const FRONTIER_SESSIONS = 2;
export const FRONTIER_MINUTES = 10;
/** The waves whose minutes the report prints. */
export const FRONTIER_WAVES = [20, 30] as const;
/** Q5 (A): a swarm frontier more than this many waves below M1's calls for C5.R. */
export const GAP_LIMIT = 5;

/** One side of the report: its name and its runs' signature (none for M1's). */
export interface FrontierSide {
  readonly name: string;
  readonly signature?: SignatureSpec;
}

/** The swarm (HIVE_SIGNATURE, src/app/devFlags.ts), then M1. */
export const FRONTIER_SIDES: readonly FrontierSide[] = [
  { name: 'swarm', signature: { id: 'swarm' } },
  { name: 'M1' },
];

/** One session's numbers. */
export interface SessionFrontier {
  readonly session: number;
  /** The highest wave its runs reached. */
  readonly frontier: number;
  /** Play time at the end of its first run that reached each of FRONTIER_WAVES; null for none. */
  readonly minutesTo: readonly (number | null)[];
  readonly runs: number;
  /** Its first run's start wave. */
  readonly startWave: number;
}

export interface SideFrontier {
  readonly name: string;
  readonly sessions: readonly SessionFrontier[];
}

/**
 * The sessions of `side`: sessions 0 .. FRONTIER_SESSIONS − 1 of the preset session's config,
 * FRONTIER_MINUTES long, with the side's signature, each from a profile `preset` loads for it
 * alone.
 */
export function frontierConfigs(side: FrontierSide, preset: () => MetaState): SessionConfig[] {
  return Array.from({ length: FRONTIER_SESSIONS }, (_, session) => ({
    ...PRESET_SESSION,
    session,
    minutes: FRONTIER_MINUTES,
    ...(side.signature === undefined ? {} : { signature: side.signature }),
    initialMeta: preset(),
  }));
}

/** Play time at the end of the first run of `result` that reached `wave`; null for none. */
export function minutesToReach(result: SessionResult, wave: number): number | null {
  for (const row of result.rows) if (row.highestWaveReached >= wave) return row.minutes;
  return null;
}

export function sessionFrontier(result: SessionResult): SessionFrontier {
  let frontier = 0;
  for (const row of result.rows) frontier = Math.max(frontier, row.highestWaveReached);
  return {
    session: result.session,
    frontier,
    minutesTo: FRONTIER_WAVES.map((wave) => minutesToReach(result, wave)),
    runs: result.rows.length,
    startWave: result.rows[0]?.startWave ?? 0,
  };
}

/** The mean of `values`, or null when one of them is null. */
export function meanOf(values: readonly (number | null)[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return values.length === 0 ? null : sum / values.length;
}

/** M1's mean frontier less the swarm's (FRONTIER_SIDES' names), in waves. */
export function frontierGap(sides: readonly SideFrontier[]): number {
  const mean = (name: string): number => {
    const side = sides.find((entry) => entry.name === name);
    if (side === undefined) throw new Error(`no ${name} side`);
    return meanOf(side.sessions.map((session) => session.frontier)) ?? Number.NaN;
  };
  return mean('M1') - mean('swarm');
}

const minutes = (value: number | null): string => (value === null ? '—' : value.toFixed(2));

/** The report's lines. */
export function formatReport(sides: readonly SideFrontier[]): string[] {
  const head = ['side', 'session', 'start', 'frontier', ...FRONTIER_WAVES.map((w) => `min→${w}`)];
  const lines = [
    [...head, 'runs']
      .map((cell) => cell.padEnd(9))
      .join('')
      .trimEnd(),
  ];
  for (const side of sides) {
    for (const s of side.sessions) {
      const cells = [side.name, String(s.session), String(s.startWave), String(s.frontier)];
      cells.push(...s.minutesTo.map(minutes), String(s.runs));
      lines.push(
        cells
          .map((cell) => cell.padEnd(9))
          .join('')
          .trimEnd(),
      );
    }
    const frontier = meanOf(side.sessions.map((s) => s.frontier));
    const cells = [side.name, 'mean', '', frontier === null ? '—' : frontier.toFixed(1)];
    cells.push(
      ...FRONTIER_WAVES.map((_, k) =>
        minutes(meanOf(side.sessions.map((s) => s.minutesTo[k] ?? null))),
      ),
    );
    lines.push(
      cells
        .map((cell) => cell.padEnd(9))
        .join('')
        .trimEnd(),
    );
  }
  const gap = frontierGap(sides);
  const verdict =
    gap > GAP_LIMIT
      ? `more than ${GAP_LIMIT}: Q5 (A) calls for C5.R`
      : `within ${GAP_LIMIT}: no C5.R under Q5 (A)`;
  lines.push(`gap (M1 − swarm, mean frontier): ${gap.toFixed(1)} waves, ${verdict}`);
  return lines;
}

/** Plays every side's sessions in turn, from `preset`'s profiles. */
export function runFrontier(data: GameData, preset: () => MetaState): SideFrontier[] {
  return FRONTIER_SIDES.map((side) => ({
    name: side.name,
    sessions: frontierConfigs(side, preset).map((config) =>
      sessionFrontier(runSession(config, data)),
    ),
  }));
}

function main(): void {
  const data = loadGameData();
  const text = readFileSync(PRESET_PATH, 'utf8');
  const preset = (): MetaState => {
    const loaded = loadSave(text, data);
    if (!loaded.ok) throw new Error(`${PRESET_PATH}: ${loaded.error}`);
    return loaded.profile.meta;
  };
  const meta = preset();
  console.log(
    `hive frontier: ${PRESET_SESSION.strategy} × ${FRONTIER_SESSIONS} sessions × ` +
      `${FRONTIER_MINUTES} min, seed ${PRESET_SESSION.seed}, from the ?hive preset ` +
      `(maxWave ${meta.maxWave}, allowed start wave ` +
      `${allowedStartWave(meta, PRESET_SESSION.economy)})`,
  );
  for (const line of formatReport(runFrontier(data, preset))) console.log(line);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
