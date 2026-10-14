/**
 * Simulates one player session: run → settle → spend talents → next run, until the play-time
 * budget is used up (docs/ARCHITECTURE.md §12, docs/GDD.md §2.2). Deterministic for a given
 * SessionConfig; uses only src/meta and src/sim, never the renderer.
 */

import { assertFinite, num, toNumber } from '../../src/core/num';
import { deriveSeed } from '../../src/core/rng';
import { loadGameData, stdHp, TAG } from '../../src/data';
import type { GameData, RuleSpec, StatBlock } from '../../src/data';
import {
  allowedStartWave,
  collectRules,
  createMetaState,
  settleRun,
  statBlockFor,
} from '../../src/meta';
import type { EconomyConfig, MetaState } from '../../src/meta';
import {
  centerStat,
  compileBuild,
  createSimulation,
  NO_INPUT,
  SCOPED_INDEX,
  TICK_RATE,
} from '../../src/sim';
import type { CompiledBuild, EndReason, RunConfig, SimEvent, SimState } from '../../src/sim';
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
  /** Record every elite and boss in SessionResult.toughTargets (tools/balance/probe.ts). */
  readonly trackToughTargets?: boolean;
}

/** Seed of one run: the same for every strategy, so strategies face the same spawns. */
export function runSeed(seed: number, session: number, run: number): number {
  return deriveSeed(deriveSeed(seed, `session:${session}`), `run:${run}`);
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const HIT = TAG.hit;
const CRIT = TAG.crit;
const BURN = TAG.burn;
const CHAIN = TAG.chain;

const DAMAGE = SCOPED_INDEX.damage;
const CRIT_CHANCE = SCOPED_INDEX.critChance;
const CRIT_MULTIPLIER = SCOPED_INDEX.critMultiplier;
const IGNITE_CHANCE = SCOPED_INDEX.igniteChance;
const CRIT_ALWAYS = SCOPED_INDEX.critAlways;
const IGNITE_ALWAYS = SCOPED_INDEX.igniteAlways;

/**
 * Expected damage, per point of base damage before retention, of one hit `jump` chain jumps
 * after the primary target (0 = the primary): the hit with its crit expectation plus the
 * burn it is expected to cause. Mirrors the simulation (src/sim/combat/hit.ts): the crit
 * chance comes from the hit's row, everything else from the row of its outcome (hit|crit for
 * crits), jumps add the chain tag to the hit (not to its burn), a crit's burn is computed from
 * the crit hit with the burn|crit row, a steady shot crits on every jump, *Always stats make
 * their chance 1, and rules apply as compileBuild compiles them (src/sim/build/compile.ts).
 */
function hitValue(build: CompiledBuild, jump: number): number {
  const { values } = build;
  const chain = jump > 0 ? CHAIN : 0;
  // Burns are no chain instances: their rows read at jump 0, as in the simulation.
  const at = (mask: number, stat: number): number =>
    centerStat(build, mask, stat, (mask & BURN) === 0 ? jump : 0);
  const mult = (mask: number): number => at(mask, DAMAGE);
  /** A roll's chance, or 1 when its *Always stat forces it. */
  const chance = (mask: number, stat: number, always: number): number =>
    at(mask, always) > 0 ? 1 : clamp01(at(mask, stat));
  const every = build.signature.forceCritEvery;
  const critChance =
    at(HIT | chain, CRIT_ALWAYS) > 0
      ? 1
      : every > 0
        ? 1 / every
        : clamp01(at(HIT | chain, CRIT_CHANCE));
  const critFactor = critChance * at(HIT | CRIT | chain, CRIT_MULTIPLIER);
  const hit = (1 - critChance) * mult(HIT | chain) + critFactor * mult(HIT | CRIT | chain);
  const ignite = chance(HIT | chain, IGNITE_CHANCE, IGNITE_ALWAYS);
  const critIgnite = chance(HIT | CRIT | chain, IGNITE_CHANCE, IGNITE_ALWAYS);
  const burnPerDamage =
    (1 - critChance) * ignite * mult(BURN) + critFactor * critIgnite * mult(BURN | CRIT);
  const burn = values.burnDamage * Math.max(0, values.burnDuration) * burnPerDamage;
  return hit + burn;
}

/**
 * Effective damage per attack `D` against one target (docs/GDD.md §7.2): the expected primary
 * hit including crits, plus the total burn that hit is expected to cause. Ignores chain jumps,
 * burn stack caps, pandemic spread and hits that kill before burning.
 */
export function effectiveHit(stats: StatBlock, rules: readonly RuleSpec[] = []): number {
  const build = compileBuild(stats, rules);
  return build.values.damage * hitValue(build, 0);
}

/**
 * Expected damage of one projectile over its primary target and all its chain jumps: `D`
 * plus the jumps, each scaled by the retention, assuming every jump finds a target.
 */
export function attackDamage(stats: StatBlock, rules: readonly RuleSpec[] = []): number {
  const build = compileBuild(stats, rules);
  const { values } = build;
  const jumps = Math.max(0, values.chainCount);
  const retention = clamp01(values.chainRetention);
  const whole = Math.floor(jumps);
  let total = hitValue(build, 0);
  for (let k = 1; k <= whole; k++) total += retention ** k * hitValue(build, k);
  total += (jumps - whole) * retention ** (whole + 1) * hitValue(build, whole + 1);
  return values.damage * total;
}

/**
 * Damage per second against a crowd: attackDamage × attacks per second × projectiles, as if
 * every projectile and jump found a target. Ignores overkill and pandemic spread.
 */
export function crowdDps(stats: StatBlock, rules: readonly RuleSpec[] = []): number {
  const { values } = stats;
  return attackDamage(stats, rules) * values.attackSpeed * Math.max(1, values.projectileCount);
}

/** Talent ids whose node belongs to a crit, DoT or chain sector (not bridges or generic). */
function isSectorNode(data: GameData, id: string): boolean {
  const archetype = data.talents.find((node) => node.id === id)?.archetype;
  return archetype === 'crit' || archetype === 'dot' || archetype === 'chain';
}

/** A copy of the build without the talents matching `drop` (ranks included). */
function buildWithout(meta: Readonly<MetaState>, drop: (id: string) => boolean): MetaState {
  const copy = createMetaState();
  for (const id of meta.allocated) if (!drop(id)) copy.allocated.add(id);
  for (const [id, rank] of meta.ranks) if (!drop(id)) copy.ranks.set(id, rank);
  return copy;
}

/**
 * How much of a build's damage comes from repeatable ranks (Might) and how much from sector
 * nodes (docs/GDD.md §9.1): each ratio is the build's value over the same build without
 * those talents. `D` ratios use effectiveHit; attack ratios use attackDamage, which adds the
 * chain jumps of one projectile; crowd ratios use crowdDps, which also counts attack speed
 * and projectiles.
 */
export interface BuildMultipliers {
  readonly repeatableMultD: number;
  readonly sectorMultD: number;
  readonly sectorMultAttack: number;
  readonly sectorMultCrowd: number;
}

export function buildMultipliers(meta: Readonly<MetaState>, data: GameData): BuildMultipliers {
  const measure = (build: Readonly<MetaState>): { d: number; attack: number; crowd: number } => {
    const stats = statBlockFor(build, data);
    const rules = collectRules(build, data);
    return {
      d: effectiveHit(stats, rules),
      attack: attackDamage(stats, rules),
      crowd: crowdDps(stats, rules),
    };
  };
  const full = measure(meta);
  const noRanks = measure(buildWithout(meta, (id) => meta.ranks.has(id)));
  const noSector = measure(buildWithout(meta, (id) => isSectorNode(data, id)));
  return {
    repeatableMultD: full.d / noRanks.d,
    sectorMultD: full.d / noSector.d,
    sectorMultAttack: full.attack / noSector.attack,
    sectorMultCrowd: full.crowd / noSector.crowd,
  };
}

/** What happened to one elite or boss of a run (SessionConfig.trackToughTargets). */
export interface ToughTarget {
  readonly run: number;
  readonly enemy: 'hexagon' | 'boss';
  /** Wave the enemy belongs to. */
  readonly wave: number;
  /** meta.maxWave when the run started: the frontier the run pushes against. */
  readonly frontier: number;
  /** Killed, reached the player, or still alive when the run ended. */
  readonly outcome: 'killed' | 'reached' | 'alive';
  /** Seconds from spawn to kill; null unless killed. */
  readonly killSeconds: number | null;
}

/** Follows the elites and bosses of one run through its events. */
function toughTargetTracker(run: number, frontier: number) {
  const open = new Map<number, { enemy: 'hexagon' | 'boss'; wave: number; tick: number }>();
  const done: ToughTarget[] = [];
  const close = (id: number, outcome: ToughTarget['outcome'], tick: number): void => {
    const entry = open.get(id);
    if (entry === undefined) return;
    open.delete(id);
    const killSeconds = outcome === 'killed' ? (tick - entry.tick) / TICK_RATE : null;
    done.push({ run, enemy: entry.enemy, wave: entry.wave, frontier, outcome, killSeconds });
  };
  return {
    observe(events: readonly SimEvent[], state: Readonly<SimState>): void {
      for (const event of events) {
        if (
          event.type === 'enemySpawned' &&
          (event.enemy === 'hexagon' || event.enemy === 'boss')
        ) {
          const spawned = state.enemies.find((enemy) => enemy.id === event.enemyId);
          const wave = spawned?.wave ?? state.wave;
          open.set(event.enemyId, { enemy: event.enemy, wave, tick: state.tick });
        } else if (event.type === 'enemyKilled') {
          close(event.enemyId, 'killed', state.tick);
        } else if (event.type === 'playerHit') {
          close(event.enemyId, 'reached', state.tick);
        }
      }
    },
    finish(tick: number): ToughTarget[] {
      for (const id of [...open.keys()]) close(id, 'alive', tick);
      return done;
    },
  };
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
  /** buildMultipliers of the build after this visit's purchases. */
  readonly repeatableMultD: number;
  readonly sectorMultD: number;
  readonly sectorMultAttack: number;
  readonly sectorMultCrowd: number;
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
  /** Every elite and boss, in run order; only with SessionConfig.trackToughTargets. */
  readonly toughTargets?: readonly ToughTarget[];
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
  const toughTargets: ToughTarget[] = [];

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
      if (config.trackToughTargets === true) {
        const tracker = toughTargetTracker(run, meta.maxWave);
        while (!sim.state.finished) tracker.observe(sim.step(NO_INPUT), sim.state);
        toughTargets.push(...tracker.finish(sim.state.tick));
      } else {
        while (!sim.state.finished) sim.step(NO_INPUT);
      }
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
        ...buildMultipliers(meta, data),
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
    ...(config.trackToughTargets === true ? { toughTargets } : {}),
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
