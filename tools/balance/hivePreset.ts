/**
 * Writes src/app/hivePreset.json, the save the `?hive` prototype opens on (docs/v3 C5 design
 * D21): one balance session of M1's signature (m1Volley: no `signature` is passed, so FP keeps it
 * valid whatever the swarm's numbers become) under the `balanced` strategy for 40 simulated
 * minutes, with the balance cli's defaults otherwise, its final profile serialized through
 * runSession's onEnd by serializeSave. main.ts loads it with loadSave like any save. The run is
 * deterministic and the timestamp fixed, so the file comes out byte-identical every time.
 * Prints the numbers the handoff note quotes.
 *
 *   npx tsx tools/balance/hivePreset.ts [--check]
 *
 * --check writes nothing and fails when the committed file differs from a fresh one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { toNumber } from '../../src/core/num';
import { loadGameData } from '../../src/data';
import { DEFAULT_ECONOMY, allowedStartWave } from '../../src/meta';
import type { MetaState } from '../../src/meta';
import { serializeSave } from '../../src/save';
import { runSession } from './session';
import type { SessionConfig } from './session';

export const PRESET_PATH = resolve(import.meta.dirname, '../../src/app/hivePreset.json');

/** The save's timestamp: fixed, so a regenerated preset is byte-identical. */
export const PRESET_SAVED_AT = '2026-10-20T00:00:00.000Z';

export const PRESET_SESSION: SessionConfig = {
  strategy: 'balanced',
  session: 0,
  seed: 1,
  minutes: 40,
  startWave: { kind: 'max' },
  economy: DEFAULT_ECONOMY,
  menuSeconds: 20,
  waveCap: null,
};

export interface Preset {
  /** The save text, formatted as the repository formats JSON. */
  readonly text: string;
  readonly meta: Readonly<MetaState>;
  /** Simulated play time of the session, menus included. */
  readonly minutes: number;
}

export async function buildPreset(): Promise<Preset> {
  const ends: Readonly<MetaState>[] = [];
  const result = runSession(PRESET_SESSION, loadGameData(), (meta) => ends.push(meta));
  const meta = ends[0];
  if (meta === undefined) throw new Error('runSession did not hand over its final profile');
  const save = serializeSave(
    { meta, playSeconds: Math.round(result.endMinutes * 60), speed: 1 },
    PRESET_SAVED_AT,
  );
  const options = (await resolveConfig(PRESET_PATH)) ?? {};
  const text = await format(save, { ...options, filepath: PRESET_PATH });
  return { text, meta, minutes: result.endMinutes };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { check: { type: 'boolean', default: false } },
  });
  const { text, meta, minutes } = await buildPreset();
  let ranks = 0;
  for (const rank of meta.ranks.values()) ranks += rank;
  console.log(
    `hive preset: balanced, M1's signature, ${PRESET_SESSION.minutes} simulated minutes ` +
      `(${minutes.toFixed(2)} with the last run and menu), seed ${PRESET_SESSION.seed}`,
  );
  console.log(`  frontier (maxWave)   ${meta.maxWave}`);
  console.log(`  allowed start wave   ${allowedStartWave(meta, DEFAULT_ECONOMY)}`);
  console.log(`  shards in the bank   ${toNumber(meta.shards).toPrecision(6)}`);
  console.log(`  cores in the bank    ${meta.cores}`);
  console.log(`  nodes bought         ${meta.allocated.size - meta.ranks.size} + ${ranks} ranks`);
  console.log(`  runs                 ${meta.runs}`);
  if (values.check) {
    if (readFileSync(PRESET_PATH, 'utf8') !== text) {
      throw new Error(`${PRESET_PATH} differs from a fresh preset: rerun without --check`);
    }
    console.log(`${PRESET_PATH} is up to date`);
    return;
  }
  writeFileSync(PRESET_PATH, text);
  console.log(`wrote ${PRESET_PATH}`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
