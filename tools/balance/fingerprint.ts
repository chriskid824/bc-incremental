/**
 * Behaviour fingerprint of the run simulation: runs a fixed matrix of builds to the end and
 * hashes every tick's events (each projected to its M1 keys, see projectEvent in
 * src/sim/testing.ts) together with the result. A refactor must reproduce the recorded baseline
 * line for line; a behaviour change shows which cases moved, and --compare-results by how much.
 *
 * Cases: 2 data sets (real, test) × 6 stat profiles × 9 rule sets × 3 seeds × 3 start waves of
 * synthetic builds, plus 10 real talent builds (tools/balance/builds.ts sectorBuild) × 3 seeds ×
 * start waves 1 and 12. Each line is `<case> <hash> wave … kills … leaks … damage … burn …`.
 *
 *   npm run fingerprint -- [--check | --write | --compare-results] [--baseline <file>]
 *
 * Without a flag the lines are printed. --check compares them with the baseline and fails on
 * any difference; --write records a new baseline; --compare-results prints how the result of
 * every changed case moved.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { toNumber } from '../../src/core/num';
import { loadGameData } from '../../src/data';
import type { GameData, Modifier, RuleSpec, StatBlock, StatId } from '../../src/data';
import { collectRules, statBlockFor } from '../../src/meta';
import { createSimulation, NO_INPUT } from '../../src/sim';
import type { RunConfig, RunResult } from '../../src/sim';
import {
  makeConfig,
  makeStats,
  makeTestData,
  maskProbeMods,
  projectEvent,
  projectResult,
} from '../../src/sim/testing';
import { SECTORS, sectorBuild } from './builds';
import { formatTable } from './report';

export const BASELINE_FILE = fileURLToPath(new URL('./fingerprint.baseline.txt', import.meta.url));

/** Stat values of the synthetic builds, over BASE_STATS; damage tables come from maskProbeMods. */
export const STAT_PROFILES: Readonly<Record<string, Partial<Record<StatId, number>>>> = {
  base: {},
  crit: { critChance: 0.4, critMultiplier: 3, damage: 40 },
  burn: { igniteChance: 0.6, burnDamage: 2, burnMaxStacks: 8, damage: 30 },
  chain: { chainCount: 3.4, chainRetention: 0.8, chainRange: 300, damage: 30 },
  volley: { projectileCount: 3.5, attackSpeed: 6, damage: 25 },
  tank: { maxLife: 5000, damage: 60, igniteChance: 0.3, chainCount: 2 },
};

/**
 * One rule set of the synthetic builds. A set may change form (a RuleSpec becoming modifiers or
 * data triggers) but keeps its name, so its lines stay comparable.
 */
export interface RuleSet {
  readonly rules: readonly RuleSpec[];
  /** Scoped modifiers appended to the profile's maskProbeMods(). */
  readonly modifiers: readonly Modifier[];
  /** Data-form triggers; the rule vocabulary has none yet. */
  readonly triggers: readonly never[];
}

const rulesOnly = (...rules: RuleSpec[]): RuleSet => ({ rules, modifiers: [], triggers: [] });
const PANDEMIC: RuleSpec = { id: 'pandemic', spreadRadius: 250, spreadEffect: 0.4, hitMore: -0.3 };
const ETERNAL: RuleSpec = { id: 'eternalFlame', durationMore: -0.5 };

export const RULE_SETS: Readonly<Record<string, RuleSet>> = {
  none: rulesOnly(),
  steady: rulesOnly({ id: 'steadyAim', everyNth: 3, critMultiplierMore: 0.5 }),
  pandemic: rulesOnly(PANDEMIC),
  eternal: rulesOnly(ETERNAL),
  eternalPandemic: rulesOnly(ETERNAL, PANDEMIC),
  overload: rulesOnly({ id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2 }),
  glass: rulesOnly({ id: 'glassCannon', damageMore: 1 }),
  searing: rulesOnly({ id: 'critsAlwaysIgnite', nonCritHitMore: -0.5 }),
  bridges: rulesOnly(
    { id: 'critIgniteChance', chance: 0.3 },
    { id: 'chainIgniteChance', chance: 0.25 },
    { id: 'chainCritChance', perJump: 0.1 },
  ),
};

const SYNTHETIC_SEEDS = [1, 2, 3] as const;
const SYNTHETIC_START_WAVES = [1, 12, 25] as const;
const TALENT_SEEDS = [1, 2, 3] as const;
const TALENT_START_WAVES = [1, 12] as const;
/** Might ranks of every talent build. */
const TALENT_MIGHT = 5;

export interface FingerprintCase {
  readonly id: string;
  readonly data: GameData;
  readonly config: RunConfig;
}

/** The profile's values with the damage table of maskProbeMods() plus the set's modifiers. */
function syntheticStats(profile: Partial<Record<StatId, number>>, set: RuleSet): StatBlock {
  return makeStats(profile, [...maskProbeMods(), ...set.modifiers]);
}

/**
 * Real talent builds: each sector without and with its keystone and with Glass Cannon (as
 * tools/balance/keystones.ts measures them), and the crit sector with every bridge node,
 * Searing Crits included.
 */
function talentBuilds(data: GameData) {
  const might = TALENT_MIGHT;
  const builds = SECTORS.flatMap((sector) => [
    { name: `${sector}/plain`, meta: sectorBuild(data, sector, { keystone: false, might }) },
    { name: `${sector}/keystone`, meta: sectorBuild(data, sector, { keystone: true, might }) },
    {
      name: `${sector}/glassCannon`,
      meta: sectorBuild(data, sector, { keystone: false, might, extra: ['glassCannon'] }),
    },
  ]);
  const bridges = data.talents.filter((node) => node.archetype === 'hybrid').map((n) => n.id);
  builds.push({
    name: 'crit/bridges',
    meta: sectorBuild(data, 'crit', { keystone: false, might, extra: bridges }),
  });
  return builds;
}

/** Every case, in output order. */
export function fingerprintCases(): FingerprintCase[] {
  const real = loadGameData();
  const cases: FingerprintCase[] = [];
  for (const [dataName, data] of [
    ['real', real],
    ['test', makeTestData()],
  ] as const) {
    for (const [profileName, profile] of Object.entries(STAT_PROFILES)) {
      for (const [setName, set] of Object.entries(RULE_SETS)) {
        const stats = syntheticStats(profile, set);
        for (const seed of SYNTHETIC_SEEDS) {
          for (const startWave of SYNTHETIC_START_WAVES) {
            cases.push({
              id: `${dataName}/${profileName}/${setName}/s${seed}/w${startWave}`,
              data,
              config: makeConfig({ seed, startWave, stats, rules: set.rules }),
            });
          }
        }
      }
    }
  }
  for (const { name, meta } of talentBuilds(real)) {
    const stats = statBlockFor(meta, real);
    const rules = collectRules(meta, real);
    for (const seed of TALENT_SEEDS) {
      for (const startWave of TALENT_START_WAVES) {
        cases.push({
          id: `talent/${name}/s${seed}/w${startWave}`,
          data: real,
          config: { seed, stats, rules, startWave, mode: 'auto' },
        });
      }
    }
  }
  return cases;
}

export interface CaseRun {
  /** First 16 hex digits of the SHA-256 of every tick's projected events and the result. */
  readonly digest: string;
  readonly result: RunResult;
}

export function runCase({ config, data }: FingerprintCase): CaseRun {
  const sim = createSimulation(config, data);
  const hash = createHash('sha256');
  while (!sim.state.finished) hash.update(JSON.stringify(sim.step(NO_INPUT).map(projectEvent)));
  const result = sim.result();
  hash.update(JSON.stringify(projectResult(result)));
  return { digest: hash.digest('hex').slice(0, 16), result };
}

/** The case line: id, digest and the result numbers --compare-results reads back. */
export function caseLine(id: string, { digest, result }: CaseRun): string {
  const { hit, crit, burn, chain } = result.damage;
  const damage = toNumber(hit) + toNumber(crit) + toNumber(burn) + toNumber(chain);
  return (
    `${id} ${digest} wave ${result.highestWaveReached} kills ${result.kills} ` +
    `leaks ${result.leaks} damage ${damage} burn ${toNumber(burn)}`
  );
}

/** Every case line, then `cases N, ticks T, fingerprint <SHA-256 of all digests>`. */
export function fingerprint(cases: readonly FingerprintCase[] = fingerprintCases()): string[] {
  const top = createHash('sha256');
  const lines: string[] = [];
  let ticks = 0;
  for (const c of cases) {
    const run = runCase(c);
    lines.push(caseLine(c.id, run));
    top.update(run.digest);
    ticks += run.result.ticks;
  }
  lines.push(`cases ${cases.length}, ticks ${ticks}, fingerprint ${top.digest('hex')}`);
  return lines;
}

/** A case line read back. */
export interface CaseSummary {
  readonly id: string;
  readonly digest: string;
  readonly wave: number;
  readonly kills: number;
  readonly leaks: number;
  readonly damage: number;
  readonly burn: number;
}

const CASE_LINE =
  /^(\S+) ([0-9a-f]{16}) wave (\S+) kills (\S+) leaks (\S+) damage (\S+) burn (\S+)$/;

/** Case lines by id; the summary line and anything else that is not a case line are skipped. */
export function parseCaseLines(lines: readonly string[]): Map<string, CaseSummary> {
  const cases = new Map<string, CaseSummary>();
  for (const line of lines) {
    const match = CASE_LINE.exec(line);
    if (match === null) continue;
    const [, id = '', digest = '', ...numbers] = match;
    const [wave, kills, leaks, damage, burn] = numbers.map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    cases.set(id, { id, digest, wave, kills, leaks, damage, burn });
  }
  return cases;
}

/** Lines that differ, as [baseline line or null, current line or null], in baseline order. */
export function differingLines(
  baseline: readonly string[],
  current: readonly string[],
): [string | null, string | null][] {
  const key = (line: string): string => (CASE_LINE.test(line) ? (line.split(' ')[0] ?? '') : '');
  const now = new Map(current.map((line) => [key(line), line]));
  const differ: [string | null, string | null][] = [];
  for (const line of baseline) {
    const other = now.get(key(line)) ?? null;
    if (other !== line) differ.push([line, other]);
    now.delete(key(line));
  }
  for (const line of now.values()) differ.push([null, line]);
  return differ;
}

/** Relative change in percent; 0 when both are 0. */
const percentChange = (before: number, after: number): number =>
  before === after ? 0 : (100 * (after - before)) / Math.abs(before);

/**
 * How the result of each changed case moved: wave, kill and leak deltas, total and burn damage
 * in percent, and a summary over the changed cases (the C3 behaviour-commit gate reads it).
 */
export function compareResults(baseline: readonly string[], current: readonly string[]): string {
  const before = parseCaseLines(baseline);
  const after = parseCaseLines(current);
  const rows: string[][] = [['case', 'Δwave', 'Δkills', 'Δleaks', 'Δdamage %', 'Δburn %']];
  let changed = 0;
  let sameOutcome = 0;
  let maxWave = 0;
  let maxDamage = 0;
  let maxBurn = 0;
  for (const [id, old] of before) {
    const now = after.get(id);
    if (now === undefined || now.digest === old.digest) continue;
    changed++;
    const dWave = now.wave - old.wave;
    const dDamage = percentChange(old.damage, now.damage);
    const dBurn = percentChange(old.burn, now.burn);
    if (dWave === 0 && now.kills === old.kills && now.leaks === old.leaks) sameOutcome++;
    maxWave = Math.max(maxWave, Math.abs(dWave));
    maxDamage = Math.max(maxDamage, Math.abs(dDamage));
    maxBurn = Math.max(maxBurn, Math.abs(dBurn));
    rows.push([
      id,
      String(dWave),
      String(now.kills - old.kills),
      String(now.leaks - old.leaks),
      dDamage.toFixed(3),
      dBurn.toFixed(3),
    ]);
  }
  const missing = [...before.keys()].filter((id) => !after.has(id));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const out: string[] = [];
  if (changed > 0) out.push(formatTable(rows), '');
  out.push(`changed ${changed} of ${before.size} cases`);
  if (changed > 0) {
    out.push(
      `same wave, kills and leaks: ${sameOutcome} of ${changed} ` +
        `(${((100 * sameOutcome) / changed).toFixed(1)}%)`,
      `max |Δwave| ${maxWave}, max |Δdamage| ${maxDamage.toFixed(3)}%, ` +
        `max |Δburn| ${maxBurn.toFixed(3)}%`,
    );
  }
  if (missing.length > 0) out.push(`missing now: ${missing.join(', ')}`);
  if (added.length > 0) out.push(`new cases: ${added.join(', ')}`);
  return out.join('\n');
}

const SHOWN_DIFFERENCES = 20;

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      check: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      'compare-results': { type: 'boolean', default: false },
      baseline: { type: 'string', default: BASELINE_FILE },
    },
  });
  const file = relative(process.cwd(), values.baseline);
  const lines = fingerprint();
  if (values.write) {
    writeFileSync(values.baseline, `${lines.join('\n')}\n`);
    console.log(`wrote ${file}: ${lines.at(-1) ?? ''}`);
    return;
  }
  if (!values.check && !values['compare-results']) {
    console.log(lines.join('\n'));
    return;
  }
  const baseline = readFileSync(values.baseline, 'utf8').trimEnd().split('\n');
  if (values['compare-results']) {
    console.log(compareResults(baseline, lines));
    return;
  }
  const differ = differingLines(baseline, lines);
  if (differ.length === 0) {
    console.log(`fingerprint matches ${file}: ${lines.at(-1) ?? ''}`);
    return;
  }
  console.log(`fingerprint differs from ${file} on ${differ.length} lines:`);
  for (const [old, now] of differ.slice(0, SHOWN_DIFFERENCES)) {
    console.log(`- ${old ?? '(none)'}\n+ ${now ?? '(none)'}`);
  }
  if (differ.length > SHOWN_DIFFERENCES) {
    console.log(`… and ${differ.length - SHOWN_DIFFERENCES} more`);
  }
  process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
