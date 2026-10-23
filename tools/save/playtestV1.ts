/**
 * Writes tests/fixtures/save-v1-playtest.json (docs/v3 C8 design §2.2, D6; the lead's ruling K2):
 * the v1 save of about an hour on the M1 page, the progress a playtester brings to the v3 game. It
 * replays PLAYTEST_LOG through M1's own rules: an income step credits a run's shards and cores as
 * settleRun does, and a buy step is checked by canAllocate and made by allocate, so M1's prices
 * set every cost and `spent`. The save then takes the frontier, one run per income, the play time
 * and the speed, and loadSave must read it back with nothing refunded before serializeSave's text
 * is formatted as the repository formats JSON. Only M1 names are imported, so the script runs at
 * the `playtest-v1` tag as it does here. Its stale twin (an allocation the M1 web lacks) is no
 * file: the tests build it with staleTwinV1 (src/save/testing.ts).
 *
 * Scripted at 304c668 because no `playtest-v1` tag exists (2026-10-22): the M1 web and prices are
 * those of 304c668. Run with --check in a checkout of the tag once it exists; a diff means the
 * playtest build's M1 web or prices differ, and its output replaces this file.
 *
 *   npx tsx tools/save/playtestV1.ts --write | --check
 *
 * --check writes nothing and fails when the committed file differs from a fresh one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { num } from '../../src/core/num';
import { loadGameData } from '../../src/data';
import { allocate, canAllocate, createMetaState, DEFAULT_ECONOMY } from '../../src/meta';
import { loadSave, serializeSave } from '../../src/save';

export const PLAYTEST_PATH = resolve(
  import.meta.dirname,
  '../../tests/fixtures/save-v1-playtest.json',
);

/** One step: a run's income as settleRun credits it, or one purchase (a node, or a rank of one). */
export type PlaytestStep =
  | { readonly kind: 'income'; readonly shards: number; readonly cores: number }
  | { readonly kind: 'buy'; readonly id: string };

const income = (shards: number, cores: number): PlaytestStep => ({ kind: 'income', shards, cores });
const buy = (id: string): PlaytestStep => ({ kind: 'buy', id });

/**
 * Runs 1–35 of one balance session at 304c668 (strategy balanced, seed 1, start wave max, 20 s
 * menus, M1's signature): each run's shards, its own and the skipped waves', and its cores, then
 * the bot's purchases after it, plus eight ranks of might the bot left for later (after runs 9,
 * 14, 19, 25 and 31), which leave the bank short of pandemic until run 31.
 */
export const PLAYTEST_LOG: readonly PlaytestStep[] = [
  income(211.3059052365675, 1),
  buy('keenEye'),
  income(342.8012395162218, 1),
  buy('kindling'),
  income(466.1626670662592, 1),
  buy('spark'),
  income(696.4595564352782, 4),
  buy('sharpen'),
  buy('fuel'),
  income(925.8704521324261, 4),
  buy('conductor'),
  income(980.0743816719912, 4),
  buy('quickDraw'),
  income(1597.484757687721, 4),
  buy('slowBurn'),
  income(1936.9405174743374, 4),
  buy('charge'),
  income(2052.2833324798075, 5),
  buy('might'),
  income(2129.4771889733806, 5),
  buy('precision'),
  income(2888.084532752623, 5),
  buy('deadlyAim'),
  income(3549.993358242623, 5),
  buy('splitShot'),
  income(5928.2737121014425, 5),
  buy('assassin'),
  income(6058.000567256524, 5),
  buy('might'),
  income(6052.057761376164, 5),
  buy('inferno'),
  income(7883.360940313091, 5),
  buy('stoke'),
  income(12128.331222410772, 8),
  buy('scorch'),
  income(13310.718318360407, 8),
  buy('heat'),
  income(12956.417277613704, 8),
  buy('might'),
  buy('might'),
  income(13708.489091712003, 8),
  income(15764.717758846662, 8),
  buy('arcStorm'),
  income(28347.485403061655, 9),
  buy('reach'),
  income(27644.771476257338, 8),
  buy('fork'),
  income(29561.470741010296, 9),
  buy('voltage'),
  income(42695.906495111405, 9),
  buy('might'),
  buy('might'),
  income(36601.701057998354, 9),
  income(37441.52669792774, 9),
  income(43820.308033379115, 9),
  buy('volley'),
  income(79419.5728727751, 9),
  income(86566.9605068685, 9),
  income(88623.71544346052, 9),
  buy('pandemic'),
  buy('might'),
  buy('might'),
  income(87147.58908012863, 9),
  income(104142.81513114726, 12),
  buy('tempest'),
  income(101284.55087230244, 12),
  income(98455.72701281376, 9),
];

/** The frontier the save ends on: the farthest wave of the session's first 35 runs. */
export const PLAYTEST_MAX_WAVE = 31;
/**
 * About an hour of runs and menus, as the M1 page sums its frames' times (src/app/main.ts):
 * 215,623 frames at 60 Hz, so not a whole number.
 */
export const PLAYTEST_PLAY_SECONDS = 3593.7166666666667;
export const PLAYTEST_SPEED = 2;
/** The save's timestamp: fixed, so a regenerated file is byte-identical. */
export const PLAYTEST_SAVED_AT = '2026-10-22T21:14:05.512Z';

/** PLAYTEST_LOG's save as serializeSave writes it; throws when M1's rules or loader refuse it. */
export function playtestSave(): string {
  const data = loadGameData();
  const meta = createMetaState();
  let runs = 0;
  for (const [i, step] of PLAYTEST_LOG.entries()) {
    if (step.kind === 'income') {
      // settleRun's credit, one IEEE addition: num, the one core/num name on the design's list.
      meta.shards = num(meta.shards + step.shards);
      meta.cores += step.cores;
      runs += 1;
      continue;
    }
    const check = canAllocate(meta, step.id, data, DEFAULT_ECONOMY);
    if (!check.ok) {
      throw new Error(`PLAYTEST_LOG[${i}]: '${step.id}' cannot be bought: ${check.reason}`);
    }
    allocate(meta, step.id, data, DEFAULT_ECONOMY);
  }
  meta.maxWave = PLAYTEST_MAX_WAVE;
  meta.runs = runs;
  const text = serializeSave(
    { meta, playSeconds: PLAYTEST_PLAY_SECONDS, speed: PLAYTEST_SPEED },
    PLAYTEST_SAVED_AT,
  );
  const loaded = loadSave(text, data);
  if (!loaded.ok) throw new Error(`the M1 loader refuses the save: ${loaded.error}`);
  if (loaded.refunded) throw new Error('the M1 loader refunds the save: it does not fit the web');
  return text;
}

/** The file's text: playtestSave() formatted as the repository formats JSON. */
export async function playtestFile(): Promise<string> {
  const options = (await resolveConfig(PLAYTEST_PATH)) ?? {};
  return format(playtestSave(), { ...options, filepath: PLAYTEST_PATH });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      write: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
    },
  });
  if (values.write === values.check) throw new Error('pass --write or --check');
  const text = await playtestFile();
  const loaded = loadSave(text, loadGameData());
  if (!loaded.ok) throw new Error(loaded.error);
  const { meta } = loaded.profile;
  let ranks = 0;
  for (const rank of meta.ranks.values()) ranks += rank;
  console.log(`playtest v1 save: ${PLAYTEST_LOG.length} steps, ${meta.runs} runs`);
  console.log(`  shards ${meta.shards} in the bank, ${meta.spentShards} spent`);
  console.log(`  cores  ${meta.cores} in the bank, ${meta.spentCores} spent`);
  console.log(`  nodes  ${meta.allocated.size - meta.ranks.size} + ${ranks} ranks`);
  console.log(`  maxWave ${meta.maxWave}, playSeconds ${loaded.profile.playSeconds}`);
  if (values.check) {
    if (readFileSync(PLAYTEST_PATH, 'utf8') !== text) {
      throw new Error(`${PLAYTEST_PATH} differs from a fresh save: rerun with --write`);
    }
    console.log(`${PLAYTEST_PATH} is up to date`);
    return;
  }
  writeFileSync(PLAYTEST_PATH, text);
  console.log(`wrote ${PLAYTEST_PATH}`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
