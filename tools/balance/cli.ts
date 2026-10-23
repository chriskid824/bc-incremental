/**
 * Headless balance simulator (docs/ARCHITECTURE.md §12).
 *
 *   npm run balance -- --strategy all --sessions 8 --minutes 60
 *   npm run balance -- --character all --content fixture --strategy all --sessions 2
 *
 * Writes runs.csv, milestones.csv and curve_check.csv to --out and prints a summary. With
 * --character it plays character sessions on the v3 webs instead (tools/balance/v3/) and also
 * writes budget.csv.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CHARACTER_IDS } from '../../src/data';
import type { CharacterId } from '../../src/data';
import { DEFAULT_ECONOMY } from '../../src/meta';
import type { EconomyConfig } from '../../src/meta';
import { DEFAULT_WEB_ECONOMY } from '../../src/meta/web';
import type { WebEconomy } from '../../src/meta/web';
import { jobOf, runJobs } from './jobs';
import type { JobResult } from './jobs';
import { runSessions } from './pool';
import {
  curveCheckCsv,
  milestonesCsv,
  multiplierTable,
  runsCsv,
  sortResults,
  summaryTable,
} from './report';
import { formatStartWavePolicy, parseStartWavePolicy } from './session';
import type { SessionConfig, StartWavePolicy } from './session';
import { isStrategyId, STRATEGY_IDS } from './strategies';
import type { StrategyId } from './strategies';
import {
  builtCharacters,
  formatContentRef,
  isScopeName,
  parseContentRef,
  resolveContent,
  SCOPE_NAMES,
  scopeLists,
  sessionCharacters,
  webOf,
} from './v3/content';
import type { ContentRef, ScopeName } from './v3/content';
import {
  budgetCsv,
  characterCurveCheckCsv,
  characterMilestonesCsv,
  characterRunsCsv,
  characterSummaryTable,
} from './v3/report';
import {
  defaultSessionMinutes,
  FULL_SESSION_MINUTES,
  OTHER_SESSION_MINUTES,
  PRE_PRESTIGE_MINUTES,
} from './v3/session';
import type { CharacterSessionConfig, CharacterSessionResult } from './v3/session';
import {
  BASE_WEB_STRATEGIES,
  focusOuter,
  isWebStrategyId,
  openOuters,
  webStrategiesFor,
} from './v3/strategies';
import type { WebStrategyId } from './v3/strategies';

const HELP = `Usage: npm run balance -- [options]

  --strategy <id|all|a,b>   ${STRATEGY_IDS.join(', ')} or all (default crit-greedy)
  --sessions <n>            sessions per strategy, each with its own seeds (default 20)
  --minutes <m>             play-time budget per session (default 60)
  --seed <s>                base seed (default 1)
  --start-wave <policy>     max | ratio:<x> | 1 (default max); ratio is capped at the allowed wave
  --start-wave-ratio <x>    override startWaveRatio (default ${DEFAULT_ECONOMY.startWaveRatio})
  --skip-reward-rate <x>    override skipRewardRate (default ${DEFAULT_ECONOMY.skipRewardRate})
  --menu-seconds <s>        time between runs (default 20)
  --wave-cap <w>            end runs once this wave is cleared (default none)
  --out <dir>               output directory (default out/balance)
  --workers <k>             worker threads (default min(4, CPUs))
  --help                    show this help

Character sessions on the v3 webs (tools/balance/v3/):
  --character <c|all>       ${CHARACTER_IDS.join(', ')} or all: play character sessions
  --content <c>             registered | fixture | fixture:<B1..B5> (default registered)
  --scope <s>               ${SCOPE_NAMES.join(' | ')} (default full); a demo scope caps waves at 40
  --strategy <id|all|a,b>   ${BASE_WEB_STRATEGIES.join(', ')}, focus:<outer>
                            or all, which adds focus:<outer> per open outer (default default)
  --minutes <m>             default ${PRE_PRESTIGE_MINUTES}, and a session stops at its first prestige point;
                            once B2 writes the prestige, ${FULL_SESSION_MINUTES} for default, ${OTHER_SESSION_MINUTES} for the others
  --start-wave-ratio, --skip-reward-rate override the web economy (defaults ${DEFAULT_WEB_ECONOMY.startWaveRatio}, ${DEFAULT_WEB_ECONOMY.skipRewardRate})
  --out <dir>               output directory (default out/balance/v3); --wave-cap is M1's only`;

export interface CliOptions {
  readonly strategies: readonly StrategyId[];
  readonly sessions: number;
  readonly minutes: number;
  readonly seed: number;
  readonly startWave: StartWavePolicy;
  readonly economy: EconomyConfig;
  readonly menuSeconds: number;
  readonly waveCap: number | null;
  readonly out: string;
  readonly workers: number;
}

/** --character's options: character sessions (tools/balance/v3/session.ts). */
export interface CharacterCliOptions {
  readonly character: CharacterId | 'all';
  readonly content: ContentRef;
  readonly scope: ScopeName;
  /** null for `all`: each web's base strategies and a focus:<o> per open outer. */
  readonly strategies: readonly WebStrategyId[] | null;
  readonly sessions: number;
  /** null for each strategy's default (defaultSessionMinutes). */
  readonly minutes: number | null;
  readonly seed: number;
  readonly startWave: StartWavePolicy;
  readonly economy: WebEconomy;
  readonly menuSeconds: number;
  readonly out: string;
  readonly workers: number;
}

function parseNumber(
  name: string,
  text: string,
  { integer = false, min = -Infinity, exclusiveMin = false } = {},
): number {
  const value = Number(text);
  const valid =
    text.trim() !== '' &&
    Number.isFinite(value) &&
    (!integer || Number.isInteger(value)) &&
    (exclusiveMin ? value > min : value >= min);
  if (!valid) {
    const kind = integer ? 'an integer' : 'a number';
    const bound = Number.isFinite(min) ? ` ${exclusiveMin ? '>' : '>='} ${min}` : '';
    throw new Error(`--${name} must be ${kind}${bound}, got '${text}'`);
  }
  return value;
}

function parseStrategies(text: string): StrategyId[] {
  if (text === 'all') return [...STRATEGY_IDS];
  const ids = text.split(',').map((part) => part.trim());
  for (const id of ids) {
    if (!isStrategyId(id)) {
      throw new Error(`Unknown strategy '${id}'; use ${STRATEGY_IDS.join(', ')} or all`);
    }
  }
  return [...new Set(ids as StrategyId[])];
}

/** `all` (null: per web, see CharacterCliOptions) or a list of web strategy ids. */
function parseWebStrategies(text: string): WebStrategyId[] | null {
  if (text === 'all') return null;
  const ids = text.split(',').map((part) => part.trim());
  for (const id of ids) {
    if (!isWebStrategyId(id)) {
      throw new Error(
        `Unknown strategy '${id}'; use ${BASE_WEB_STRATEGIES.join(', ')}, focus:<outer> or all`,
      );
    }
  }
  return [...new Set(ids as WebStrategyId[])];
}

const isCharacterChoice = (text: string): text is CharacterId | 'all' =>
  text === 'all' || (CHARACTER_IDS as readonly string[]).includes(text);

/**
 * Parses CLI arguments; returns null when --help was given. Throws on invalid input. Without
 * --character the options are M1's, as before character sessions; with it, CharacterCliOptions.
 */
export function parseOptions(argv: readonly string[]): CliOptions | CharacterCliOptions | null {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      character: { type: 'string' },
      content: { type: 'string' },
      scope: { type: 'string' },
      // No defaults where M1 and character sessions differ: each path applies its own.
      strategy: { type: 'string' },
      sessions: { type: 'string', default: '20' },
      minutes: { type: 'string' },
      seed: { type: 'string', default: '1' },
      'start-wave': { type: 'string', default: 'max' },
      'start-wave-ratio': { type: 'string' },
      'skip-reward-rate': { type: 'string' },
      'menu-seconds': { type: 'string', default: '20' },
      'wave-cap': { type: 'string' },
      out: { type: 'string' },
      workers: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return null;

  const overrides = {
    ...(values['start-wave-ratio'] === undefined
      ? {}
      : {
          startWaveRatio: parseNumber('start-wave-ratio', values['start-wave-ratio'], {
            min: 0,
            exclusiveMin: true,
          }),
        }),
    ...(values['skip-reward-rate'] === undefined
      ? {}
      : {
          skipRewardRate: parseNumber('skip-reward-rate', values['skip-reward-rate'], { min: 0 }),
        }),
  };
  const defaultWorkers = Math.max(1, Math.min(4, availableParallelism()));

  if (values.character !== undefined) {
    const { character } = values;
    if (!isCharacterChoice(character)) {
      throw new Error(`Unknown character '${character}'; use ${CHARACTER_IDS.join(', ')} or all`);
    }
    if (values['wave-cap'] !== undefined) {
      throw new Error("--wave-cap is M1's; character sessions end at their scope's wave cap");
    }
    const scope = values.scope ?? 'full';
    if (!isScopeName(scope)) {
      throw new Error(`Invalid scope '${scope}': use ${SCOPE_NAMES.join(', ')}`);
    }
    const economy: WebEconomy = { ...DEFAULT_WEB_ECONOMY, ...overrides };
    return {
      character,
      content: parseContentRef(values.content ?? 'registered'),
      scope,
      strategies: parseWebStrategies(values.strategy ?? 'default'),
      sessions: parseNumber('sessions', values.sessions, { integer: true, min: 1 }),
      minutes:
        values.minutes === undefined
          ? null
          : parseNumber('minutes', values.minutes, { min: 0, exclusiveMin: true }),
      seed: parseNumber('seed', values.seed, { integer: true }),
      startWave: parseStartWavePolicy(values['start-wave']),
      economy,
      menuSeconds: parseNumber('menu-seconds', values['menu-seconds'], { min: 0 }),
      out: values.out ?? join('out', 'balance', 'v3'),
      workers:
        values.workers === undefined
          ? defaultWorkers
          : parseNumber('workers', values.workers, { integer: true, min: 1 }),
    };
  }
  if (values.content !== undefined || values.scope !== undefined) {
    throw new Error('--content and --scope need --character');
  }

  const economy: EconomyConfig = { ...DEFAULT_ECONOMY, ...overrides };
  return {
    strategies: parseStrategies(values.strategy ?? 'crit-greedy'),
    sessions: parseNumber('sessions', values.sessions, { integer: true, min: 1 }),
    minutes: parseNumber('minutes', values.minutes ?? '60', { min: 0, exclusiveMin: true }),
    seed: parseNumber('seed', values.seed, { integer: true }),
    startWave: parseStartWavePolicy(values['start-wave']),
    economy,
    menuSeconds: parseNumber('menu-seconds', values['menu-seconds'], { min: 0 }),
    waveCap:
      values['wave-cap'] === undefined
        ? null
        : parseNumber('wave-cap', values['wave-cap'], { integer: true, min: 1 }),
    out: values.out ?? join('out', 'balance'),
    workers:
      values.workers === undefined
        ? defaultWorkers
        : parseNumber('workers', values.workers, { integer: true, min: 1 }),
  };
}

/** One session config per strategy × session, in output order. */
export function sessionConfigs(options: CliOptions): SessionConfig[] {
  const configs: SessionConfig[] = [];
  for (const strategy of options.strategies) {
    for (let session = 0; session < options.sessions; session++) {
      configs.push({
        strategy,
        session,
        seed: options.seed,
        minutes: options.minutes,
        startWave: options.startWave,
        economy: options.economy,
        menuSeconds: options.menuSeconds,
        waveCap: options.waveCap,
      });
    }
  }
  return configs;
}

/** A usage error found once the content is known; main prints it and exits 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** Why a character has no web: the registered content has no center before B1. */
function noCenter(character: CharacterId, ref: ContentRef, built: readonly CharacterId[]): string {
  const content = `the ${formatContentRef(ref)} content`;
  return built.length === 0
    ? `${character} has no center: no character has one in ${content} before B1 ` +
        `registers 熔核. Use --content fixture to run the fixture webs.`
    : `${character} has no center in ${content} (built: ${built.join(', ')}). ` +
        'Use --content fixture to run the fixture webs.';
}

/**
 * One character session config per character × strategy × session, in output order: the
 * characters in CHARACTER_IDS order, each character's strategies as given (a focus:<o> only where
 * o's board is open) or, for `all`, webStrategiesFor its web. Empty for `all` when no character
 * of the scope has a center. Throws a UsageError for a named character without a center or
 * outside the scope, and for a focus:<o> no character can play.
 */
export function characterSessionConfigs(options: CharacterCliOptions): CharacterSessionConfig[] {
  const content = resolveContent(options.content);
  const built = builtCharacters(content);
  let characters: CharacterId[];
  if (options.character === 'all') {
    characters = sessionCharacters(content, options.scope);
  } else {
    const { character } = options;
    if (!built.includes(character)) {
      throw new UsageError(noCenter(character, options.content, built));
    }
    if (!scopeLists(options.scope, character)) {
      throw new UsageError(`${character} is not in scope ${options.scope}`);
    }
    characters = [character];
  }

  const configs: CharacterSessionConfig[] = [];
  const played = new Set<WebStrategyId>();
  for (const character of characters) {
    const web = webOf(options.content, character, options.scope);
    const open = openOuters(web);
    const strategies =
      options.strategies === null
        ? webStrategiesFor(web)
        : options.strategies.filter((id) => {
            const outer = focusOuter(id);
            return outer === null || open.includes(outer);
          });
    for (const strategy of strategies) {
      played.add(strategy);
      for (let session = 0; session < options.sessions; session++) {
        configs.push({
          character,
          strategy,
          session,
          seed: options.seed,
          minutes: options.minutes ?? defaultSessionMinutes(strategy),
          startWave: options.startWave,
          economy: options.economy,
          menuSeconds: options.menuSeconds,
          content: options.content,
          scope: options.scope,
        });
      }
    }
  }
  const unplayed =
    characters.length === 0 ? [] : (options.strategies ?? []).filter((id) => !played.has(id));
  if (unplayed.length > 0) {
    throw new UsageError(
      `${unplayed.join(', ')}: the outer's board is open on no web of ` +
        `${characters.join(', ')} in scope ${options.scope}`,
    );
  }
  return configs;
}

export interface BalanceOutput {
  readonly runsCsv: string;
  readonly milestonesCsv: string;
  readonly curveCheckCsv: string;
  readonly summary: string;
  readonly mode: string;
}

/** Runs every session and renders all outputs; does not touch the file system. */
export async function runBalance(
  options: CliOptions,
  log: (message: string) => void = () => {},
): Promise<BalanceOutput> {
  const pool = await runSessions(sessionConfigs(options), options.workers, log);
  const sorted = sortResults(pool.results, options.strategies);
  return {
    runsCsv: runsCsv(sorted),
    milestonesCsv: milestonesCsv(sorted),
    curveCheckCsv: curveCheckCsv(sorted, options.strategies),
    summary: `${summaryTable(sorted, options.strategies)}\n\n${multiplierTable(sorted, options.strategies)}`,
    mode: pool.mode === 'workers' ? `${pool.workers} workers` : 'in-process',
  };
}

export interface CharacterBalanceOutput {
  readonly results: readonly CharacterSessionResult[];
  readonly runsCsv: string;
  readonly milestonesCsv: string;
  readonly curveCheckCsv: string;
  readonly budgetCsv: string;
  readonly summary: string;
  readonly mode: string;
}

const characterResult = (result: JobResult): CharacterSessionResult => {
  if (result.kind !== 'character') {
    throw new Error(`Expected a character session, got '${result.kind}'`);
  }
  return result.result;
};

/** Runs every character session and renders all outputs; does not touch the file system. */
export async function runCharacterBalance(
  configs: readonly CharacterSessionConfig[],
  workers: number,
  log: (message: string) => void = () => {},
): Promise<CharacterBalanceOutput> {
  const pool = await runJobs(configs.map(jobOf), workers, log);
  const results = pool.results.map(characterResult);
  return {
    results,
    runsCsv: characterRunsCsv(results),
    milestonesCsv: characterMilestonesCsv(results),
    curveCheckCsv: characterCurveCheckCsv(results),
    budgetCsv: budgetCsv(results),
    summary: characterSummaryTable(results),
    mode: pool.mode === 'workers' ? `${pool.workers} workers` : 'in-process',
  };
}

function describeOptions(options: CliOptions): string {
  const { economy } = options;
  return (
    `${options.strategies.length} strateg${options.strategies.length === 1 ? 'y' : 'ies'} × ` +
    `${options.sessions} sessions × ${options.minutes} min, seed ${options.seed}, ` +
    `start wave ${formatStartWavePolicy(options.startWave)} ` +
    `(ratio ${economy.startWaveRatio}, skip reward ${economy.skipRewardRate}), ` +
    `menu ${options.menuSeconds} s` +
    (options.waveCap === null ? '' : `, wave cap ${options.waveCap}`)
  );
}

function describeCharacterOptions(
  options: CharacterCliOptions,
  configs: readonly CharacterSessionConfig[],
): string {
  const { economy } = options;
  const characters = [...new Set(configs.map((config) => config.character))];
  const pairs = configs.length / options.sessions;
  return (
    `${characters.join(', ')}: ${pairs} character × strategy pair${pairs === 1 ? '' : 's'} × ` +
    `${options.sessions} sessions × ` +
    (options.minutes === null ? 'the default minutes' : `${options.minutes} min`) +
    `, content ${formatContentRef(options.content)}, scope ${options.scope}, seed ${options.seed}, ` +
    `start wave ${formatStartWavePolicy(options.startWave)} ` +
    `(ratio ${economy.startWaveRatio}, skip reward ${economy.skipRewardRate}), ` +
    `menu ${options.menuSeconds} s`
  );
}

/** Where main writes: the console unless a test passes its own. */
export interface CliIo {
  readonly log: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
}

const CONSOLE: CliIo = {
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

async function mainCharacters(options: CharacterCliOptions, io: CliIo): Promise<number> {
  let configs: CharacterSessionConfig[];
  try {
    configs = characterSessionConfigs(options);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.error(error.message);
    return 2;
  }
  if (configs.length === 0) {
    const built = builtCharacters(resolveContent(options.content));
    const content = `the ${formatContentRef(options.content)} content`;
    io.log(
      built.length === 0
        ? `No character has a center in ${content} (none before B1 registers 熔核): no ` +
            'sessions to run. Use --content fixture to run the fixture webs.'
        : `No character of scope ${options.scope} has a center in ${content} ` +
            `(built: ${built.join(', ')}): no sessions to run.`,
    );
    return 0;
  }

  const started = performance.now();
  const output = await runCharacterBalance(configs, options.workers, (message) => io.warn(message));
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'runs.csv'), output.runsCsv);
  writeFileSync(join(options.out, 'milestones.csv'), output.milestonesCsv);
  writeFileSync(join(options.out, 'curve_check.csv'), output.curveCheckCsv);
  writeFileSync(join(options.out, 'budget.csv'), output.budgetCsv);
  const seconds = (performance.now() - started) / 1000;

  // summary.txt leaves the wall time out, so the outputs never depend on the machine.
  const report = [
    `Character sessions: ${describeCharacterOptions(options, configs)}`,
    '',
    output.summary,
    '',
    `Wrote runs.csv, milestones.csv, curve_check.csv, budget.csv to ${options.out}`,
  ].join('\n');
  writeFileSync(join(options.out, 'summary.txt'), report + '\n');
  io.log(report);
  io.log(`Wall time ${seconds.toFixed(1)} s (${output.mode})`);
  return 0;
}

/** The CLI: parses `argv`, runs the sessions and writes the outputs; resolves to the exit code. */
export async function main(argv: readonly string[], io: CliIo = CONSOLE): Promise<number> {
  let options: CliOptions | CharacterCliOptions | null;
  try {
    options = parseOptions(argv);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error(`\n${HELP}`);
    return 2;
  }
  if (options === null) {
    io.log(HELP);
    return 0;
  }
  if ('character' in options) return mainCharacters(options, io);

  const started = performance.now();
  const output = await runBalance(options, (message) => io.warn(message));
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'runs.csv'), output.runsCsv);
  writeFileSync(join(options.out, 'milestones.csv'), output.milestonesCsv);
  writeFileSync(join(options.out, 'curve_check.csv'), output.curveCheckCsv);
  const seconds = (performance.now() - started) / 1000;

  const report = [
    `Balance: ${describeOptions(options)}`,
    '',
    output.summary,
    '',
    `Wrote runs.csv, milestones.csv, curve_check.csv to ${options.out}`,
    `Wall time ${seconds.toFixed(1)} s (${output.mode})`,
  ].join('\n');
  writeFileSync(join(options.out, 'summary.txt'), report + '\n');
  io.log(report);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
