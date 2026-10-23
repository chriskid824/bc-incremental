/**
 * One character session (docs/v3 C10 design §1.2): run → settleWebRun → a strategy's visit → next
 * run, on a character's v3 web and characterGameData(), until the first prestige point, the clear
 * or the play-time budget. Deterministic for a given CharacterSessionConfig, which is plain data
 * for the workers. M1 sessions stay in tools/balance/session.ts.
 */

import { lt, toNumber } from '../../../src/core/num';
import { createRng, deriveSeed } from '../../../src/core/rng';
import { characterGameData, sourceClass } from '../../../src/data';
import type { CharacterId, EnemyId, SourceClass } from '../../../src/data';
import type { Settlement } from '../../../src/meta';
import { ROW_ENEMIES, rowEnemyOf } from '../../../src/data/web';
import type { AssembledWeb, RowEnemy } from '../../../src/data/web';
import {
  boardCounts,
  emptyProgress,
  nextPrice,
  settleWebRun,
  webBuild,
  webStartWave,
} from '../../../src/meta/web';
import type { AccountProgress, CharacterProgress, Price, WebEconomy } from '../../../src/meta/web';
import { createSimulation, NO_INPUT, TICK_RATE } from '../../../src/sim';
import type { ContactTally, EndReason, RunResult } from '../../../src/sim';
import { compressIds, runSeed } from '../session';
import type { StartWavePolicy } from '../session';
import { webOf } from './content';
import type { ContentRef, ScopeName } from './content';
import { PRESTIGE } from './prestige';
import type { PrestigeHook } from './prestige';
import { createStrategy } from './strategies';
import type { GreedyEvaluation, WebStrategy, WebStrategyId } from './strategies';
import { cappedRunConfig, greedySeeds, openVisit, probeFrontiers } from './visit';

/** gd:833 「第 30 波：第一次轉生」: the first prestige point (初始值). */
export const PRESTIGE_WAVE = 30;
/** CLAUDE.md:7: wave 100's 奇點 is the clear (初始值). */
export const CLEAR_WAVE = 100;
/**
 * Minutes of a session before B2 (初始值): a build that never reaches wave 30 stops at the demo's
 * hour (GDD:214); pacing has failed by 40 min.
 */
export const PRE_PRESTIGE_MINUTES = 60;
/** A default session after B2 (初始值): the 4–6 h clear (impl:489); wave 100 at 5 h +15 % (F5). */
export const FULL_SESSION_MINUTES = 360;
/** Another strategy's session after B2 (初始值): dead-node and greedy readings differ most in gd §9's first two hours. */
export const OTHER_SESSION_MINUTES = 120;
/** Snapshot times (初始值): gd §9's checkpoints before the first prestige (gd:829-833). */
export const SNAPSHOT_MINUTES: readonly number[] = [10, 20, 30, 45];
/** Milestone waves (初始值): M1's list (tools/balance/report.ts) on to wave 100 (impl:474). */
export const V3_MILESTONE_WAVES: readonly number[] = [
  5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100,
];
/** Runs without a new cycleBest that make the wall (初始值): 5–10 min at gd §9's 1–2 min runs of the second hour. */
export const WALL_STALL_RUNS = 5;
/** Safety net against a zero-length loop, as tools/balance/session.ts' MAX_RUNS. */
const MAX_RUNS = 100_000;

/** A fresh save's account (default): 奇點 not beaten. */
const FRESH_ACCOUNT: AccountProgress = { singularityBeaten: false };

export interface CharacterSessionConfig {
  readonly character: CharacterId;
  readonly strategy: WebStrategyId;
  /** Session index; with `seed` it selects the run seeds, the same for every strategy. */
  readonly session: number;
  readonly seed: number;
  /** Play-time budget. The last run may end past it. */
  readonly minutes: number;
  readonly startWave: StartWavePolicy;
  readonly economy: WebEconomy;
  /** Assumed time between runs (settlement and the web screen). */
  readonly menuSeconds: number;
  readonly content: ContentRef;
  readonly scope: ScopeName;
  /** A fresh account when omitted. */
  readonly account?: AccountProgress;
  /** The progress the session starts from in place of emptyProgress(character). */
  readonly initialProgress?: CharacterProgress;
  /** SNAPSHOT_MINUTES when omitted. */
  readonly snapshotMinutes?: readonly number[];
}

/** The gd §6.4 columns a run's contact and bullet tallies go to; `elite` holds the hexagon (rowEnemyOf null). */
export const TYPE_COLUMNS = [...ROW_ENEMIES, 'elite'] as const;
export type TypeColumn = RowEnemy | 'elite';

export interface TypeTally {
  /** Enemies of the column's types that reached the player (damageTakenBy hits). */
  readonly leaks: number;
  readonly contact: number;
  /** Bullet damage (RunResult.bulletTakenBy, C7.4b); null before it exists. */
  readonly bullet: number | null;
}

/** The counters budget.csv reads, by name; the last two arrive with C7.5. */
export const BUDGET_COUNTERS = [
  'effectBudgetTicks',
  'effectsDropped',
  'summonCapped',
  'chainHitCapped',
  'projectilesCapped',
  'enemyCapDelayed',
  'enemySpawnsSkipped',
] as const;
export type BudgetCounter = (typeof BUDGET_COUNTERS)[number];

/** One row of the v3 runs.csv; currencies and damage are plain numbers taken from Num. */
export interface CharacterRunRow {
  readonly character: CharacterId;
  readonly scope: ScopeName;
  readonly strategy: WebStrategyId;
  readonly session: number;
  /** 1-based run index within the session. */
  readonly run: number;
  /** Cumulative play time when this run ended (earlier runs and menus included). */
  readonly minutes: number;
  readonly startWave: number;
  readonly highestWaveReached: number;
  readonly highestWaveCleared: number;
  readonly endReason: EndReason;
  readonly runSeconds: number;
  /** After settling this run. */
  readonly cycleBest: number;
  readonly bestWave: number;
  readonly prestiges: number;
  readonly kills: number;
  readonly leaks: number;
  readonly damageTaken: number;
  readonly killedBy: EnemyId | null;
  readonly shardsFromRun: number;
  readonly skipShards: number;
  readonly coresFromRun: number;
  readonly skipCores: number;
  /** The wallet after this visit's purchases. */
  readonly shardsBank: number;
  readonly coresBank: number;
  /** Σ ranks owned after this visit, the signature never counted. */
  readonly purchases: number;
  /** Owned nodes after this visit (boardCounts): the center's, the hub's and the outers'. */
  readonly nodesCenter: number;
  readonly nodesHub: number;
  readonly nodesOuter: number;
  /** Outer boards holding an owned node. */
  readonly outersUsed: number;
  readonly keystones: number;
  readonly fusionCores: number;
  /** damageBySource of the run by sourceClass. */
  readonly dmgCenter: number;
  readonly dmgHub: number;
  readonly dmgOuter: number;
  readonly dmgFusion: number;
  readonly dmgAsc: number;
  /** (center + asc) ÷ all damage; null for a run without damage. */
  readonly centerShare: number | null;
  readonly byType: Readonly<Record<TypeColumn, TypeTally>>;
  /** The signature's bombs lobbed (lob events). */
  readonly bombs: number;
  /** The counters of BUDGET_COUNTERS, null for one the run does not have. */
  readonly budget: Readonly<Record<BudgetCounter, number | null>>;
  /** Nodes bought after this run, in order, as `id` or `id×n` for consecutive repeats. */
  readonly bought: string;
}

export interface SessionMilestones {
  /** Run-end minutes of the first run after which bestWave ≥ wave, per V3_MILESTONE_WAVES. */
  readonly minutesToWave: Readonly<Record<number, number | null>>;
  /** Run-end minutes of the run after which the first outer node, core and ★ were bought. */
  readonly firstOuterNode: number | null;
  readonly firstFusionCore: number | null;
  /** The first visit that starts with a wallet covering the cheapest unowned center ★ (W3). */
  readonly firstKeystoneAffordable: number | null;
  readonly firstKeystone: number | null;
  /** The first prestige point: its run-end minutes and Σ ranks after its visit. */
  readonly prestigePoint: { readonly minutes: number; readonly purchases: number } | null;
  /** The center threshold bought. */
  readonly centerThreshold: number | null;
  /** The first WALL_STALL_RUNS runs in a row after the first prestige without a new cycleBest. */
  readonly wall: { readonly minutes: number; readonly wave: number } | null;
}

export interface SessionSnapshot {
  /** The snapshot time it is due at, or the prestige point. */
  readonly minutes: number | 'prestige';
  /** The progress after that run's visit. */
  readonly progress: CharacterProgress;
  /** Shards and cores earned so far, skip compensation included. */
  readonly earned: { readonly shards: number; readonly cores: number };
}

export type SessionStop = 'prestigePoint' | 'budget' | 'cleared';

export interface CharacterSessionResult {
  readonly character: CharacterId;
  readonly scope: ScopeName;
  readonly strategy: WebStrategyId;
  readonly session: number;
  readonly rows: readonly CharacterRunRow[];
  /** Play time when the session stopped, after the last menu visit. */
  readonly endMinutes: number;
  readonly stop: SessionStop;
  readonly milestones: SessionMilestones;
  readonly snapshots: readonly SessionSnapshot[];
  /** Every node bought, once, in first-bought order. */
  readonly bought: readonly string[];
  /** Greedy's readings, when the strategy made any. */
  readonly evaluations?: readonly GreedyEvaluation[];
}

/** Test seams; a config stays plain data for the workers. */
export interface SessionHooks {
  /** In place of PRESTIGE; null for none. */
  readonly prestige?: PrestigeHook | null;
  /** In place of CLEAR_WAVE. */
  readonly clearWave?: number;
  /** In place of createStrategy (a spy around it, say). */
  readonly strategy?: (id: WebStrategyId, web: AssembledWeb) => WebStrategy;
  /** In place of greedy's probe runs: the progress, the next run's start wave and the visit's seeds. */
  readonly probe?: (
    progress: CharacterProgress,
    startWave: number,
    seeds: readonly number[],
  ) => readonly number[];
}

/**
 * The start wave of a run (§1.2 step 1): max is webStartWave; ratio:x is
 * min(allowed, max(1, ⌊cycleBest × x⌋)); 1 is 1; then capped at the scope's wave cap.
 */
export function characterStartWave(
  policy: StartWavePolicy,
  progress: CharacterProgress,
  economy: WebEconomy,
  waveCap: number | null,
): number {
  const allowed = webStartWave(progress, economy);
  const wave =
    policy.kind === 'max'
      ? allowed
      : policy.kind === 'first'
        ? 1
        : Math.min(allowed, Math.max(1, Math.floor(progress.cycleBest * policy.ratio)));
  return waveCap === null ? wave : Math.min(wave, waveCap);
}

/** --minutes' default: PRE_PRESTIGE_MINUTES before B2; then the default build's clear, or the first two hours. */
export function defaultSessionMinutes(
  strategy: WebStrategyId,
  prestige: PrestigeHook | null = PRESTIGE,
): number {
  if (prestige === null) return PRE_PRESTIGE_MINUTES;
  return strategy === 'default' ? FULL_SESSION_MINUTES : OTHER_SESSION_MINUTES;
}

/** Σ ranks owned, the signature never counted. */
export function purchasesOf(web: AssembledWeb, progress: CharacterProgress): number {
  let total = 0;
  for (const node of web.nodes) {
    if (node.kind === 'signature') continue;
    const rank = progress.ranks[node.id];
    if (rank !== undefined && rank >= 1) total += Math.floor(rank);
  }
  return total;
}

/** RunResult.bulletTakenBy (C7.4b), read structurally so the tools compile before it exists. */
function bulletsOf(result: RunResult): Readonly<Record<string, ContactTally>> | null {
  if (!('bulletTakenBy' in result)) return null;
  return (result as { readonly bulletTakenBy: Readonly<Record<string, ContactTally>> })
    .bulletTakenBy;
}

/** A TypeTally while it is summed. */
interface TallySum {
  leaks: number;
  contact: number;
  bullet: number | null;
}

/** The run's contact and bullet tallies by column: rowEnemyOf, the elite in `elite`. */
export function typeTallies(result: RunResult): Readonly<Record<TypeColumn, TypeTally>> {
  const bullets = bulletsOf(result);
  const tallies = {} as Record<TypeColumn, TallySum>;
  for (const column of TYPE_COLUMNS) {
    tallies[column] = { leaks: 0, contact: 0, bullet: bullets === null ? null : 0 };
  }
  const columnOf = (id: string): TypeColumn => rowEnemyOf(id as EnemyId) ?? 'elite';
  for (const [id, tally] of Object.entries(result.damageTakenBy) as [string, ContactTally][]) {
    const entry = tallies[columnOf(id)];
    entry.leaks += tally.hits;
    entry.contact += tally.damage;
  }
  if (bullets !== null) {
    for (const [id, tally] of Object.entries(bullets)) {
      const entry = tallies[columnOf(id)];
      entry.bullet = (entry.bullet ?? 0) + tally.damage;
    }
  }
  return tallies;
}

/** BUDGET_COUNTERS read by name from result.counters, null when the run has no such counter. */
export function budgetOf(result: RunResult): Readonly<Record<BudgetCounter, number | null>> {
  const counters = result.counters as Readonly<Record<string, number | undefined>>;
  const budget = {} as Record<BudgetCounter, number | null>;
  for (const name of BUDGET_COUNTERS) budget[name] = counters[name] ?? null;
  return budget;
}

/** damageBySource summed by sourceClass. */
export function damageByClass(result: RunResult): Readonly<Record<SourceClass, number>> {
  const sums: Record<SourceClass, number> = { center: 0, outer: 0, fusion: 0, hub: 0, asc: 0 };
  for (const [id, amount] of Object.entries(result.damageBySource)) {
    const cls = sourceClass(id);
    if (cls !== null) sums[cls] += toNumber(amount);
  }
  return sums;
}

/** The run's center share: (center + asc) ÷ all damage (design §1.4); null for a run without damage. */
export function centerShareOf(damage: Readonly<Record<SourceClass, number>>): number | null {
  const total = damage.center + damage.hub + damage.outer + damage.fusion + damage.asc;
  return total > 0 ? (damage.center + damage.asc) / total : null;
}

/** A run's damage columns: damageBySource by sourceClass, and the center share. */
export function damageColumns(
  result: RunResult,
): Pick<
  CharacterRunRow,
  'dmgCenter' | 'dmgHub' | 'dmgOuter' | 'dmgFusion' | 'dmgAsc' | 'centerShare'
> {
  const dmg = damageByClass(result);
  return {
    dmgCenter: dmg.center,
    dmgHub: dmg.hub,
    dmgOuter: dmg.outer,
    dmgFusion: dmg.fusion,
    dmgAsc: dmg.asc,
    centerShare: centerShareOf(dmg),
  };
}

/** What a settled run adds to a session's `earned`: its drops and the skip compensation. */
export function settlementEarned(settlement: Settlement): {
  readonly shards: number;
  readonly cores: number;
} {
  return {
    shards: toNumber(settlement.shardsFromRun) + toNumber(settlement.skipShards),
    cores: settlement.coresFromRun + settlement.skipCores,
  };
}

/** The cheapest unowned center ★'s price, or null when every center ★ is owned. */
function centerKeystonePrice(
  web: AssembledWeb,
  progress: CharacterProgress,
  economy: WebEconomy,
): Price | null {
  let cheapest: Price | null = null;
  for (const node of web.nodes) {
    if (node.kind !== 'keystone' || node.board !== `${web.character}.center`) continue;
    if ((progress.ranks[node.id] ?? 0) >= 1) continue;
    const price = nextPrice(web, progress, node.id, economy);
    if (
      cheapest === null ||
      lt(price.shards, cheapest.shards) ||
      (!lt(cheapest.shards, price.shards) && price.cores < cheapest.cores)
    ) {
      cheapest = price;
    }
  }
  return cheapest;
}

const covers = (progress: CharacterProgress, price: Price): boolean =>
  !lt(progress.wallet.shards, price.shards) &&
  progress.wallet.cores >= price.cores &&
  progress.wallet.resonance >= price.resonance;

/** Owned ids and ranks, for error messages. */
function describeProgress(progress: CharacterProgress): string {
  const ids = Object.entries(progress.ranks).map(([id, rank]) => (rank > 1 ? `${id}×${rank}` : id));
  return ids.length > 0 ? ids.join(' ') : '(no talents)';
}

/**
 * Plays the session (§1.2). Each run: the start wave, webBuild and webRunConfig with runSeed's seed,
 * the run stepped with NO_INPUT, settleWebRun, the strategy's visit, the snapshots due, the menu
 * time and one row. It stops (a) before B2, after the first run that ends with cycleBest ≥
 * PRESTIGE_WAVE, recording the prestige point; with a prestige hook, (b) prestiges when it says so
 * and goes on, and (d) stops once a run clears CLEAR_WAVE; (c) at `minutes` of play.
 */
export function runCharacterSession(
  config: CharacterSessionConfig,
  hooks: SessionHooks = {},
): CharacterSessionResult {
  const { character, economy } = config;
  const prestige = hooks.prestige === undefined ? PRESTIGE : hooks.prestige;
  const clearWave = hooks.clearWave ?? CLEAR_WAVE;
  const web = webOf(config.content, character, config.scope);
  const data = characterGameData();
  const waveCap = web.scope.waveCap;
  const strategy = (hooks.strategy ?? createStrategy)(config.strategy, web);
  const rng = createRng(deriveSeed(config.seed, `strategy:${config.strategy}:${config.session}`));
  const snapshotMinutes = config.snapshotMinutes ?? SNAPSHOT_MINUTES;
  const probe =
    hooks.probe ??
    ((p: CharacterProgress, start: number, seeds: readonly number[]) =>
      probeFrontiers(web, p, data, start, seeds));
  let progress = config.initialProgress ?? emptyProgress(character);
  let account = config.account ?? FRESH_ACCOUNT;

  const rows: CharacterRunRow[] = [];
  const snapshots: SessionSnapshot[] = [];
  const taken = new Set<number>();
  const bought = new Set<string>();
  const earned = { shards: 0, cores: 0 };
  const minutesToWave: Record<number, number | null> = {};
  for (const wave of V3_MILESTONE_WAVES) minutesToWave[wave] = null;
  let firstOuterNode: number | null = null;
  let firstFusionCore: number | null = null;
  let firstKeystoneAffordable: number | null = null;
  let firstKeystone: number | null = null;
  let prestigePoint: SessionMilestones['prestigePoint'] = null;
  let centerThreshold: number | null = null;
  let wall: SessionMilestones['wall'] = null;
  let prestiged = false;
  let runsSinceNewBest = 0;
  let stop: SessionStop = 'budget';
  const budgetSeconds = config.minutes * 60;
  let clockSeconds = 0;

  for (let run = 1; clockSeconds < budgetSeconds; run++) {
    if (run > MAX_RUNS) throw new Error(`Session exceeded ${MAX_RUNS} runs`);
    const startWave = characterStartWave(config.startWave, progress, economy, waveCap);
    let row: CharacterRunRow;
    let result: RunResult;
    let minutes: number;
    try {
      const wr = webBuild(web, progress);
      const runConfig = cappedRunConfig(
        web,
        wr,
        runSeed(config.seed, config.session, run),
        startWave,
      );
      const sim = createSimulation(runConfig, data);
      let bombs = 0;
      while (!sim.state.finished) {
        for (const event of sim.step(NO_INPUT)) if (event.type === 'lob') bombs += 1;
      }
      result = sim.result();
      const cycleBefore = progress.cycleBest;
      const settled = settleWebRun(progress, result, data, wr.stats, economy);
      progress = settled.progress;
      const { settlement } = settled;
      const gained = settlementEarned(settlement);
      earned.shards += gained.shards;
      earned.cores += gained.cores;
      const runSeconds = result.ticks / TICK_RATE;
      clockSeconds += runSeconds;
      minutes = clockSeconds / 60;
      for (const wave of V3_MILESTONE_WAVES) {
        if (minutesToWave[wave] === null && progress.bestWave >= wave) {
          minutesToWave[wave] = minutes;
        }
      }
      runsSinceNewBest = progress.cycleBest > cycleBefore ? 0 : runsSinceNewBest + 1;
      if (prestiged && wall === null && runsSinceNewBest >= WALL_STALL_RUNS) {
        wall = { minutes, wave: progress.cycleBest };
      }

      const star = centerKeystonePrice(web, progress, economy);
      if (firstKeystoneAffordable === null && star !== null && covers(progress, star)) {
        firstKeystoneAffordable = minutes;
      }
      const nextStart = characterStartWave(config.startWave, progress, economy, waveCap);
      const seeds = greedySeeds(config.session, run);
      const visit = openVisit({
        web,
        account,
        economy,
        data,
        rng,
        minutes,
        progress,
        probe: (p) => probe(p, nextStart, seeds),
      });
      strategy.visit(visit);
      progress = visit.progress();
      for (const id of visit.bought) {
        bought.add(id);
        const node = web.byId.get(id);
        if (node === undefined) continue;
        if (node.board.startsWith('outer.')) firstOuterNode ??= minutes;
        if (node.kind === 'core') firstFusionCore ??= minutes;
        if (node.kind === 'keystone') firstKeystone ??= minutes;
        if (node.kind === 'threshold' && node.board === `${character}.center`) {
          centerThreshold ??= minutes;
        }
      }
      for (const due of snapshotMinutes) {
        if (taken.has(due) || minutes < due) continue;
        taken.add(due);
        snapshots.push({ minutes: due, progress, earned: { ...earned } });
      }
      clockSeconds += config.menuSeconds;

      const counts = boardCounts(web, progress);
      const outerCounts = Object.values(counts.outers).map((count) => count ?? 0);
      let hub = 0;
      for (const node of web.nodes) {
        if (node.board === 'hub' && (progress.ranks[node.id] ?? 0) >= 1) hub += 1;
      }
      row = {
        character,
        scope: config.scope,
        strategy: config.strategy,
        session: config.session,
        run,
        minutes,
        startWave,
        highestWaveReached: result.highestWaveReached,
        highestWaveCleared: result.highestWaveCleared,
        endReason: result.endReason,
        runSeconds,
        cycleBest: progress.cycleBest,
        bestWave: progress.bestWave,
        prestiges: progress.prestiges,
        kills: result.kills,
        leaks: result.leaks,
        damageTaken: result.damageTaken,
        killedBy: result.killedBy,
        shardsFromRun: toNumber(settlement.shardsFromRun),
        skipShards: toNumber(settlement.skipShards),
        coresFromRun: settlement.coresFromRun,
        skipCores: settlement.skipCores,
        shardsBank: toNumber(progress.wallet.shards),
        coresBank: progress.wallet.cores,
        purchases: purchasesOf(web, progress),
        nodesCenter: counts.center,
        nodesHub: hub,
        nodesOuter: outerCounts.reduce((sum, count) => sum + count, 0),
        outersUsed: outerCounts.filter((count) => count > 0).length,
        keystones: counts.keystones,
        fusionCores: counts.cores,
        ...damageColumns(result),
        byType: typeTallies(result),
        bombs,
        budget: budgetOf(result),
        bought: compressIds(visit.bought),
      };
    } catch (error) {
      throw new Error(
        `${character} ${config.strategy} session ${config.session} run ${run} ` +
          `(start wave ${startWave}) failed; build: ${describeProgress(progress)}`,
        { cause: error },
      );
    }
    rows.push(row);

    if (prestige === null) {
      if (progress.cycleBest >= PRESTIGE_WAVE) {
        prestigePoint = { minutes, purchases: row.purchases };
        snapshots.push({ minutes: 'prestige', progress, earned: { ...earned } });
        stop = 'prestigePoint';
        break;
      }
    } else {
      if (result.highestWaveCleared >= clearWave) {
        stop = 'cleared';
        break;
      }
      const state = { progress, runsSinceNewBest, minutes, prestiges: progress.prestiges };
      if (prestige.shouldPrestige(state)) {
        if (prestigePoint === null) {
          prestigePoint = { minutes, purchases: row.purchases };
          snapshots.push({ minutes: 'prestige', progress, earned: { ...earned } });
        }
        ({ progress, account } = prestige.apply(web, progress, account, economy));
        prestiged = true;
        runsSinceNewBest = 0;
      }
    }
  }

  return {
    character,
    scope: config.scope,
    strategy: config.strategy,
    session: config.session,
    rows,
    endMinutes: clockSeconds / 60,
    stop,
    milestones: {
      minutesToWave,
      firstOuterNode,
      firstFusionCore,
      firstKeystoneAffordable,
      firstKeystone,
      prestigePoint,
      centerThreshold,
      wall,
    },
    snapshots,
    bought: [...bought],
    ...(strategy.evaluations.length > 0 ? { evaluations: [...strategy.evaluations] } : {}),
  };
}
