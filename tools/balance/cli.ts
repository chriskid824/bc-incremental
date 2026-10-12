/**
 * Headless balance simulator (docs/ARCHITECTURE.md §12).
 *
 *   npm run balance -- --strategy all --sessions 8 --minutes 60
 *
 * Writes runs.csv, milestones.csv and curve_check.csv to --out and prints a summary.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_ECONOMY } from '../../src/meta';
import type { EconomyConfig } from '../../src/meta';
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
  --help                    show this help`;

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

/** Parses CLI arguments; returns null when --help was given. Throws on invalid input. */
export function parseOptions(argv: readonly string[]): CliOptions | null {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      strategy: { type: 'string', default: 'crit-greedy' },
      sessions: { type: 'string', default: '20' },
      minutes: { type: 'string', default: '60' },
      seed: { type: 'string', default: '1' },
      'start-wave': { type: 'string', default: 'max' },
      'start-wave-ratio': { type: 'string' },
      'skip-reward-rate': { type: 'string' },
      'menu-seconds': { type: 'string', default: '20' },
      'wave-cap': { type: 'string' },
      out: { type: 'string', default: join('out', 'balance') },
      workers: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return null;

  const economy: EconomyConfig = {
    ...DEFAULT_ECONOMY,
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

  return {
    strategies: parseStrategies(values.strategy),
    sessions: parseNumber('sessions', values.sessions, { integer: true, min: 1 }),
    minutes: parseNumber('minutes', values.minutes, { min: 0, exclusiveMin: true }),
    seed: parseNumber('seed', values.seed, { integer: true }),
    startWave: parseStartWavePolicy(values['start-wave']),
    economy,
    menuSeconds: parseNumber('menu-seconds', values['menu-seconds'], { min: 0 }),
    waveCap:
      values['wave-cap'] === undefined
        ? null
        : parseNumber('wave-cap', values['wave-cap'], { integer: true, min: 1 }),
    out: values.out,
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

async function main(): Promise<void> {
  let options: CliOptions | null;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options === null) {
    console.log(HELP);
    return;
  }

  const started = performance.now();
  const output = await runBalance(options, (message) => console.warn(message));
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
  console.log(report);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
