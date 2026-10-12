/**
 * Simulates one player session: run → settle → spend talents → next run, until the play-time
 * budget is used up (docs/ARCHITECTURE.md §12, docs/GDD.md §2.2). Deterministic for a given
 * SessionConfig; uses only src/meta and src/sim, never the renderer.
 */

import { assertFinite, num, toNumber } from '../../src/core/num';
import { deriveSeed } from '../../src/core/rng';
import { DAMAGE_TAG_BIT, loadGameData, stdHp } from '../../src/data';
import type { GameData, RuleSpec, StatBlock } from '../../src/data';
import {
  allowedStartWave,
  collectRules,
  createMetaState,
  settleRun,
  statBlockFor,
} from '../../src/meta';
import type { EconomyConfig, MetaState } from '../../src/meta';
import { compileRules, createSimulation, NO_INPUT, TICK_RATE } from '../../src/sim';
import type { EndReason, RunConfig } from '../../src/sim';
import { spend } from './strategies';
import type { StrategyId } from './strategies';

/** How the bot picks the start wave of each run. */
export type StartWavePolicy =
  /** The highest allowed wave: allowedStartWave(meta, economy). */
  | { readonly kind: 'max' }
  /** max(1, floor(maxWave × ratio)), capped at the allowed wave. */
  | { readonly kind: 'ratio'; readonly ratio: number }
  /** Always wave 1. */
  | { readonly kind: 'first' };

/** Parses `max`, `1` or `ratio:<x>` with 0 < x ≤ 1. */
export function parseStartWavePolicy(text: string): StartWavePolicy {
  if (text === 'max') return { kind: 'max' };
  if (text === '1') return { kind: 'first' };
  const match = /^ratio:(.+)$/.exec(text);
  if (match) {
    const ratio = Number(match[1]);
    if (Number.isFinite(ratio) && ratio > 0 && ratio <= 1) return { kind: 'ratio', ratio };
  }
  throw new Error(`Invalid start-wave policy '${text}': use max, 1 or ratio:<x> with 0 < x <= 1`);
}

export function formatStartWavePolicy(policy: StartWavePolicy): string {
  if (policy.kind === 'max') return 'max';
  if (policy.kind === 'first') return '1';
  return `ratio:${policy.ratio}`;
}

export function chooseStartWave(
  policy: StartWavePolicy,
  meta: Readonly<MetaState>,
  economy: EconomyConfig,
): number {
  const allowed = allowedStartWave(meta, economy);
  if (policy.kind === 'max') return allowed;
  if (policy.kind === 'first') return 1;
  return Math.min(allowed, Math.max(1, Math.floor(meta.maxWave * policy.ratio)));
}

export interface SessionConfig {
  readonly strategy: StrategyId;
  /** Session index; together with `seed` it selects the run seeds. */
  readonly session: number;
  readonly seed: number;
  /** Play-time budget. The last run may end past it. */
  readonly minutes: number;
  readonly startWave: StartWavePolicy;
  readonly economy: EconomyConfig;
  /** Assumed time between runs (settlement and talent screen). */
  readonly menuSeconds: number;
  /** Optional wave cap passed to every run (demo / prototype limit). */
  readonly waveCap: number | null;
}

/** Seed of one run: the same for every strategy, so strategies face the same spawns. */
export function runSeed(seed: number, session: number, run: number): number {
  return deriveSeed(deriveSeed(seed, `session:${session}`), `run:${run}`);
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const HIT = DAMAGE_TAG_BIT.hit;
const CRIT = DAMAGE_TAG_BIT.crit;
const BURN = DAMAGE_TAG_BIT.burn;

/**
 * Effective damage per attack `D` against one target (docs/GDD.md §7.2): the expected primary
 * hit including crits, plus the total burn that hit is expected to cause. Mirrors the
 * simulation: crits use damageMult[hit|crit], a crit's burn is computed from the crit hit
 * with damageMult[burn|crit], and rules apply as compiled by src/sim/rules.ts. Ignores burn
 * stack caps, pandemic spread and hits that kill before burning.
 */
export function effectiveHit(stats: StatBlock, rules: readonly RuleSpec[] = []): number {
  const { values, damageMult } = stats;
  const fx = compileRules(rules);
  const mult = (mask: number): number => damageMult[mask] as number;
  const critChance = fx.steadyAimEvery > 0 ? 1 / fx.steadyAimEvery : clamp01(values.critChance);
  const critMultiplier = values.critMultiplier * fx.critMultiplierMult;
  const critFactor = critChance * critMultiplier;
  const hit =
    fx.hitMult * ((1 - critChance) * mult(HIT) * fx.nonCritHitMult + critFactor * mult(HIT | CRIT));
  const ignite = clamp01(values.igniteChance);
  const critIgnite = fx.critsAlwaysIgnite ? 1 : clamp01(ignite + fx.critIgniteChance);
  const burnPerDamage =
    (1 - critChance) * ignite * mult(BURN) + critFactor * critIgnite * mult(BURN | CRIT);
  const burn =
    values.burnDamage * Math.max(0, values.burnDuration * fx.burnDurationMult) * burnPerDamage;
  return values.damage * fx.allDamageMult * (hit + burn);
}

/** One row of runs.csv. Damage and currency columns are plain numbers taken from Num. */
export interface RunRow {
  readonly strategy: StrategyId;
  readonly session: number;
  /** 1-based run index within the session. */
  readonly run: number;
  /** Cumulative play time when this run ended (earlier runs and menus included). */
  readonly minutes: number;
  readonly startWave: number;
  readonly highestWaveReached: number;
  readonly highestWaveCleared: number;
  readonly clearedStartWave: boolean;
  readonly endReason: EndReason;
  readonly runSeconds: number;
  /** meta.maxWave after settling this run: the frontier. */
  readonly maxWave: number;
  readonly kills: number;
  /** stdHp(highestWaveReached). */
  readonly stdHpAtFrontier: number;
  /** D of the build that played this run (see effectiveHit). */
  readonly effectiveHit: number;
  /** stdHpAtFrontier ÷ effectiveHit. */
  readonly hitsToKillFrontier: number;
  /** overkillSeconds ÷ runSeconds (docs/GDD.md §2.2, target ≤ 0.3). */
  readonly overkillShare: number;
  readonly dmgHit: number;
  readonly dmgCrit: number;
  readonly dmgBurn: number;
  readonly dmgChain: number;
  readonly shardsFromRun: number;
  readonly skipShards: number;
  readonly coresFromRun: number;
  readonly skipCores: number;
  /** Allocated non-repeatable nodes after this visit's purchases. */
  readonly nodesAllocated: number;
  /** Total ranks on repeatable nodes after this visit's purchases. */
  readonly repeatableRanks: number;
  /** Currencies left after this visit's purchases. */
  readonly shardsBank: number;
  readonly coresBank: number;
  /** Nodes bought after this run, in order, as `id` or `id×n` for consecutive repeats. */
  readonly bought: string;
}

export interface SessionResult {
  readonly strategy: StrategyId;
  readonly session: number;
  readonly rows: readonly RunRow[];
  /** Play time when the session stopped, after the last menu visit. */
  readonly endMinutes: number;
  /** Play time at the end of the run after which the first notable / keystone was bought. */
  readonly firstNotableMinutes: number | null;
  readonly firstKeystoneMinutes: number | null;
}

/** Safety net against a zero-length loop; a 60 minute session has a few hundred runs at most. */
const MAX_RUNS = 100_000;

export function runSession(config: SessionConfig, data: GameData = loadGameData()): SessionResult {
  const { strategy, economy } = config;
  const kindById = new Map(data.talents.map((node) => [node.id, node.kind]));
  const meta = createMetaState();
  const rows: RunRow[] = [];
  const budgetSeconds = config.minutes * 60;
  let clockSeconds = 0;
  let firstNotableMinutes: number | null = null;
  let firstKeystoneMinutes: number | null = null;

  for (let run = 1; clockSeconds < budgetSeconds; run++) {
    if (run > MAX_RUNS) throw new Error(`Session exceeded ${MAX_RUNS} runs`);
    let startWave = chooseStartWave(config.startWave, meta, economy);
    if (config.waveCap !== null) startWave = Math.min(startWave, config.waveCap);
    const stats = statBlockFor(meta, data);
    const runConfig: RunConfig = {
      seed: runSeed(config.seed, config.session, run),
      stats,
      rules: collectRules(meta, data),
      startWave,
      mode: 'auto',
      ...(config.waveCap === null ? {} : { waveCap: config.waveCap }),
    };

    let row: RunRow;
    try {
      const sim = createSimulation(runConfig, data);
      while (!sim.state.finished) sim.step(NO_INPUT);
      const result = sim.result();
      const settlement = settleRun(meta, result, data, stats, economy);
      const runSeconds = result.ticks / TICK_RATE;
      clockSeconds += runSeconds;
      const minutes = clockSeconds / 60;
      const bought = spend(strategy, meta, data, economy);
      clockSeconds += config.menuSeconds;

      for (const id of bought) {
        const kind = kindById.get(id);
        if (kind === 'notable') firstNotableMinutes ??= minutes;
        if (kind === 'keystone') firstKeystoneMinutes ??= minutes;
      }

      const d = toNumber(assertFinite(num(effectiveHit(stats, runConfig.rules)), 'effective hit'));
      const frontierHp = stdHp(result.highestWaveReached);
      let repeatableRanks = 0;
      for (const rank of meta.ranks.values()) repeatableRanks += rank;
      row = {
        strategy,
        session: config.session,
        run,
        minutes,
        startWave,
        highestWaveReached: result.highestWaveReached,
        highestWaveCleared: result.highestWaveCleared,
        clearedStartWave: result.clearedStartWave,
        endReason: result.endReason,
        runSeconds,
        maxWave: meta.maxWave,
        kills: result.kills,
        stdHpAtFrontier: frontierHp,
        effectiveHit: d,
        hitsToKillFrontier: frontierHp / d,
        overkillShare: runSeconds > 0 ? result.overkillSeconds / runSeconds : 0,
        dmgHit: toNumber(result.damage.hit),
        dmgCrit: toNumber(result.damage.crit),
        dmgBurn: toNumber(result.damage.burn),
        dmgChain: toNumber(result.damage.chain),
        shardsFromRun: toNumber(settlement.shardsFromRun),
        skipShards: toNumber(settlement.skipShards),
        coresFromRun: settlement.coresFromRun,
        skipCores: settlement.skipCores,
        nodesAllocated: meta.allocated.size - meta.ranks.size,
        repeatableRanks,
        shardsBank: toNumber(meta.shards),
        coresBank: meta.cores,
        bought: compressIds(bought),
      };
    } catch (error) {
      throw new Error(
        `${strategy} session ${config.session} run ${run} (start wave ${startWave}) failed; ` +
          `build: ${describeBuild(meta)}`,
        { cause: error },
      );
    }
    rows.push(row);
  }

  return {
    strategy,
    session: config.session,
    rows,
    endMinutes: clockSeconds / 60,
    firstNotableMinutes,
    firstKeystoneMinutes,
  };
}

/** "a b b b c" → "a b×3 c". */
export function compressIds(ids: readonly string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < ids.length;) {
    let j = i + 1;
    while (j < ids.length && ids[j] === ids[i]) j++;
    parts.push(j - i > 1 ? `${ids[i]}×${j - i}` : (ids[i] as string));
    i = j;
  }
  return parts.join(' ');
}

/** Allocated talents and ranks, for error messages. */
function describeBuild(meta: Readonly<MetaState>): string {
  const ids = [...meta.allocated].map((id) => {
    const rank = meta.ranks.get(id);
    return rank === undefined ? id : `${id}×${rank}`;
  });
  return ids.length > 0 ? ids.join(' ') : '(no talents)';
}
