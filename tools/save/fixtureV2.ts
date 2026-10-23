/**
 * Writes tests/fixtures/save-v2.json (docs/v3 C8 design §2.2, D6): a save v2 profile on the
 * fixture content (src/data/web/testing.ts) with every part of the format in use, for the v3
 * loader's tests and for every later version's migration from 2. fire holds 火毒's 固定投入
 * (unlockInvestment) and its core, bought with buy (one fusion slot, one codex entry), a
 * fractional wallet and a loadout of its build; summon a prestige and one ascendancy node bought
 * with 迴響, which records its chain; ice and lightning are empty; the account has speed 2, its
 * stats, the last character, the enemy types met (the lead's ruling K3) and no pending. Every
 * purchase passes canBuy, and the save must load on the fixture webs with no notice and nothing
 * changed, and read back to its own text, before serializeProfile's text is formatted as the
 * repository formats JSON. Its ids sit under src/data/web/snapshots/fixture and V21, as stable as
 * real ids.
 *
 * Regenerated only while SAVE_VERSION is 2, then frozen: under another version the script refuses
 * to run, since serializeProfile would write that version.
 *
 *   npx tsx tools/save/fixtureV2.ts --write | --check
 *
 * --check writes nothing and fails when the committed file differs from a fresh one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { add, num } from '../../src/core/num';
import { FULL_SCOPE } from '../../src/data/web';
import type { AssembledWeb } from '../../src/data/web';
import { fixtureContent } from '../../src/data/web/testing';
import { buy, nextPrice, progressFromOrder, unlockInvestment } from '../../src/meta/web';
import type { AccountProgress, CharacterProgress } from '../../src/meta/web';
import { SAVE_VERSION } from '../../src/save/format';
import {
  freshProfile,
  parseProfile,
  profileContext,
  serializeProfile,
} from '../../src/save/profile';
import type { LoadContext, SaveProfile } from '../../src/save/profile';

export const FIXTURE_V2_PATH = resolve(import.meta.dirname, '../../tests/fixtures/save-v2.json');

/** The save's timestamp: fixed, so a regenerated file is byte-identical. */
export const FIXTURE_V2_SAVED_AT = '2026-10-22T00:00:00.000Z';

/** fire's fusion core: 火毒. */
export const FIRE_CORE = 'fusion.fire.poison.core';

/** summon's route from its root to path-one's first ascendancy node, planPath's on the fixture. */
export const SUMMON_ORDER: readonly string[] = [
  'summon.center.gamma.r1',
  'summon.center.gamma.r2',
  'summon.center.gamma.gamma-one',
  'summon.center.gamma.r3',
  'summon.center.main.c5',
  'hub.echo.r2',
  'summon.asc.path-one.n1',
];

/** M1's six enemy types, met by wave 41. */
const SEEN_ENEMIES = ['boss', 'hexagon', 'pentagon', 'shard', 'square', 'triangle'];

/** profileContext on fixtureContent() in FULL_SCOPE: the four fixture webs. */
export function fixtureV2Context(): LoadContext {
  return profileContext(fixtureContent(), FULL_SCOPE);
}

function webOf(context: LoadContext, character: 'fire' | 'summon'): AssembledWeb {
  const web = context.webOf(character);
  if (web === null) throw new Error(`the fixture content has no ${character} web`);
  return web;
}

/**
 * fire: 火毒's 固定投入, then its core bought with buy on a wallet credited with the core's price,
 * then the run counters and the wallet earned since.
 */
function fireProgress(web: AssembledWeb, account: AccountProgress): CharacterProgress {
  const invested = unlockInvestment(web, account, 'poison');
  const price = nextPrice(web, invested, FIRE_CORE);
  const { wallet } = invested;
  const credited: CharacterProgress = {
    ...invested,
    wallet: {
      shards: add(wallet.shards, price.shards),
      cores: wallet.cores + price.cores,
      resonance: wallet.resonance + price.resonance,
    },
  };
  return {
    ...buy(web, credited, account, FIRE_CORE),
    wallet: { shards: num(4567.891), cores: 2, resonance: 0 },
    bestWave: 34,
    cycleBest: 34,
    runs: 21,
  };
}

/**
 * summon: SUMMON_ORDER's purchases (progressFromOrder's audit, with the prestige the ascendancy
 * node needs), then the second cycle's wallet: 15 迴響 earned, the node's spent.
 */
function summonProgress(web: AssembledWeb, account: AccountProgress): CharacterProgress {
  const bought = progressFromOrder(web, account, SUMMON_ORDER);
  const resonanceEarned = 15;
  return {
    ...bought,
    wallet: { shards: num(87.3), cores: 1, resonance: resonanceEarned - bought.spent.resonance },
    bestWave: 41,
    cycleBest: 3,
    prestiges: 1,
    resonanceEarned,
    runs: 34,
  };
}

/** The profile save-v2.json holds, on `context`'s webs (the fixture's). */
export function fixtureV2Profile(context: LoadContext): SaveProfile {
  const account: AccountProgress = { singularityBeaten: false };
  const fire = fireProgress(webOf(context, 'fire'), account);
  const summon = summonProgress(webOf(context, 'summon'), account);
  const fresh = freshProfile();
  return {
    account: {
      ...fresh.account,
      codex: { 'fire.poison': { bestWave: 34 } },
      settings: { speed: 2 },
      stats: { playSeconds: 5432.1, runs: 55 },
      lastCharacter: 'fire',
      seenEnemies: SEEN_ENEMIES,
    },
    characters: {
      ...fresh.characters,
      fire: { progress: fire, loadouts: [{ ...fire.ranks }, null, null], startWave: 15 },
      summon: { ...fresh.characters.summon, progress: summon },
    },
  };
}

/**
 * save-v2.json's text as serializeProfile writes it; throws unless SAVE_VERSION is 2 and the save
 * loads on the fixture webs with no notice, nothing changed and its own text back.
 */
export function fixtureV2Save(): string {
  if (SAVE_VERSION !== 2) {
    throw new Error(`save-v2.json is frozen: SAVE_VERSION is ${SAVE_VERSION}, not 2`);
  }
  const context = fixtureV2Context();
  const text = serializeProfile(fixtureV2Profile(context), FIXTURE_V2_SAVED_AT);
  const loaded = parseProfile(text, context);
  if (!loaded.ok) throw new Error(`the v3 loader refuses the save: ${JSON.stringify(loaded)}`);
  if (loaded.notices.length > 0 || loaded.changed) {
    throw new Error(`the save does not load clean: ${JSON.stringify(loaded.notices)}`);
  }
  if (serializeProfile(loaded.profile, FIXTURE_V2_SAVED_AT) !== text) {
    throw new Error('the save does not read back to its own text');
  }
  return text;
}

/** The file's text: fixtureV2Save() formatted as the repository formats JSON. */
export async function fixtureV2File(): Promise<string> {
  const options = (await resolveConfig(FIXTURE_V2_PATH)) ?? {};
  return format(fixtureV2Save(), { ...options, filepath: FIXTURE_V2_PATH });
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
  const text = await fixtureV2File();
  const { characters } = fixtureV2Profile(fixtureV2Context());
  for (const c of ['fire', 'summon'] as const) {
    const { ranks, wallet, spent } = characters[c].progress;
    console.log(
      `  ${c}: ${Object.keys(ranks).length} nodes; wallet ${wallet.shards} shards, ` +
        `${wallet.cores} cores, ${wallet.resonance} 迴響; spent ${spent.shards}, ` +
        `${spent.cores}, ${spent.resonance}`,
    );
  }
  if (values.check) {
    if (readFileSync(FIXTURE_V2_PATH, 'utf8') !== text) {
      throw new Error(`${FIXTURE_V2_PATH} differs from a fresh save: rerun with --write`);
    }
    console.log(`${FIXTURE_V2_PATH} is up to date`);
    return;
  }
  writeFileSync(FIXTURE_V2_PATH, text);
  console.log(`wrote ${FIXTURE_V2_PATH}`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
