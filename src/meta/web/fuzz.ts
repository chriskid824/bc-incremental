/**
 * The web fuzz (docs/v3 C6 design D25, §4.9; V23, P9, N-7): random legal builds of the assembled
 * webs, each run for a while with every tick checked. The webs are every character of the content
 * with a center in every scope that holds it, character by character, and build i goes to web
 * i mod n. Build i draws from createRng(deriveSeed(seed, 'webFuzz:' + i)) (L2): 10–140 purchases,
 * the third fusion slot for a quarter, best wave 1, 15 or 30, a prestige for 30 %, for a third of
 * the builds every fusion's coef at one end of its coefRange (1 for an insensitive one), then the
 * start wave 1, 15 or 30 within the scope's cap; sampleProgress makes the purchases (D25).
 *
 * After tick 0 and every tick: checkSummonTick against SUMMON_CAP, which only a test module
 * raises (finite hp and positions, summons, shots and chain hits within their caps), and the alive
 * count, which warns above 400 until C7 exports ENEMY_CAP_ENFORCED (D31; the lead's ruling R7).
 * At the end, effectsDropped 0 and effectBudgetStreakMax below 30 (F8). Every tenth build runs
 * twice and the two runs' hashes of every tick's events and of the result must match. A throw is
 * a failure at its tick. A run stops at its first failing tick (F56) and the next build runs; the
 * report counts the runs stopped early. runWebFuzz reads no clock (N-7): with the caller's clock
 * it records each build's run time. src/meta/web/fuzz.test.ts runs it in CHECK (V23) and
 * tools/content/fuzzWeb.ts in CI.
 */

import { createRng, deriveSeed } from '../../core/rng';
import type { Rng } from '../../core/rng';
import { coefRange } from '../../data/fusion/sensitivity';
import { CHARACTER_IDS } from '../../data/sources';
import type { CharacterId } from '../../data/sources';
import type { GameData } from '../../data/types';
import { assembleWeb, scopeHolds } from '../../data/web/assemble';
import { FULL_SCOPE, SCOPES } from '../../data/web/scope';
import type { AssembledWeb, Content, FusionKey, WebScope } from '../../data/web/types';
import { SUMMON_CAP } from '../../sim/caps';
import type { TestModule } from '../../sim/rules';
import { createSimulation } from '../../sim/simulation';
import type { RunContext } from '../../sim/systems/context';
import { checkSummonTick, createRunHash } from '../../sim/testing';
import type { SummonFuzzFailure } from '../../sim/testing';
import { NO_INPUT } from '../../sim/types';
import type { CounterId } from '../../sim/types';
import { webBuild, webRunConfig } from './build';
import { storedRank } from './counts';
import { progressFromOrder } from './invest';
import { sampleProgress } from './sample';
import type { AccountProgress, CharacterProgress } from './types';

/** SUMMON_FUZZ_SEED is 1028 (src/sim/testing.ts). */
export const WEB_FUZZ_SEED = 1029;
/** CI's counts (D25): 1,000 builds of the registered webs, 100 of the fixture's, 60 s each. */
export const WEB_FUZZ_BUILDS = 1000;
export const WEB_FUZZ_FIXTURE_BUILDS = 100;
export const WEB_FUZZ_TICKS = 3600;
/** The best waves (the reveal) and the start waves a build draws from. */
export const WEB_FUZZ_WAVES = [1, 15, 30] as const;
/** Alive enemies above this warn (D31, F47): C7's cap, not enforced before it. */
export const ALIVE_WARNING = 400;
/** effectBudgetStreakMax must stay below this: half a second of carried-over effects (F8). */
export const BUDGET_STREAK_LIMIT = 30;
/** Every this-many-th build, build 0 first, runs twice and compares the runs' hashes. */
export const HASH_EVERY = 10;
const PURCHASES = { min: 10, max: 140 } as const;
const THIRD_SLOT_SHARE = 0.25;
const PRESTIGE_SHARE = 0.3;
const COEF_ENDS_SHARE = 1 / 3;

export interface WebFuzzOptions {
  readonly content: Content;
  readonly data: GameData;
  /** 1,000 in CI, 20 in CHECK. */
  readonly builds: number;
  /** 3,600 (60 s) in CI, 600 in CHECK. */
  readonly ticks: number;
  readonly seed?: number;
  /** One build, `<character>.<scope>.<index>`, or a fixed case by name, from a repro line. */
  readonly only?: string;
  /** The caller's clock, for per-build times (the tool passes performance.now); runWebFuzz reads none itself (N-7). */
  readonly clock?: () => number;
  /** `content` is fixtureContent(): the repro lines carry --fixture (the lead's ruling R2). */
  readonly fixture?: boolean;
  /** The fixed cases to run after the builds: FIXED_WEB_CASES on the registered content. */
  readonly cases?: readonly WebFuzzCase[];
  /** Test modules for a build's run r (1 or 2), new for each run: the tests' planted faults. */
  readonly modules?: (build: WebFuzzDraw, run: number) => readonly TestModule[];
}

export interface WebFuzzFailure {
  readonly kind: SummonFuzzFailure['kind'] | 'budget' | 'dropped' | 'enemies';
  readonly text: string;
  /** npm run fuzz:web -- --only fire.full.417 */
  readonly repro: string;
  /** The build's owned nodes. */
  readonly ids: readonly string[];
}

/** More than ALIVE_WARNING enemies alive at once in a build: a warning until C7 (D31). */
export interface WebFuzzWarning {
  readonly text: string;
  readonly repro: string;
}

/**
 * A fixed case (S373): `order` bought from empty, ranks by repetition, on the character's web in
 * FULL_SCOPE with a fresh save's account, run from `startWave` under the builds' checks; the
 * report says whether that wave was cleared, which is C10's balance check, not a failure.
 */
export interface WebFuzzCase {
  readonly name: string;
  readonly character: CharacterId;
  readonly order: readonly string[];
  readonly startWave: number;
}

/** Fixed cases, from B1: 「熔核：瘟疫＋無盡烈焰＋悶燒，第 30 波清怪」 (S373). */
export const FIXED_WEB_CASES: readonly WebFuzzCase[] = [];

/** What a build is: its web and progress and how it runs. */
export interface WebFuzzDraw {
  /** `<character>.<scope>.<index>` for a build, the case's name for a fixed case. */
  readonly name: string;
  /** The build's index; −1 for a fixed case. */
  readonly index: number;
  readonly character: CharacterId;
  readonly scope: string;
  /** The purchases asked for; ranks holds those made. */
  readonly purchases: number;
  readonly account: AccountProgress;
  readonly bestWave: number;
  readonly prestiged: boolean;
  /**
   * Each fusion's coef as the web was assembled, when it was assembled at its range's ends; null
   * at the calibrated ones.
   */
  readonly coefs: Readonly<Partial<Record<FusionKey, number>>> | null;
  readonly startWave: number;
  /** The run's seed. */
  readonly seed: number;
  /** The owned nodes in web order, and the ranks bought in all. */
  readonly ids: readonly string[];
  readonly ranks: number;
}

/** The most of each thing a run held after a tick (the counters' gauges at the run's end). */
export interface WebFuzzPeaks {
  readonly alive: number;
  readonly summons: number;
  /** Volley projectiles and shot pool shots together. */
  readonly inFlight: number;
  readonly chainHits: number;
  readonly effectQueue: number;
  readonly budgetStreak: number;
}

/** A build's line of the report: the draw and what its runs did. */
export interface WebFuzzBuild extends WebFuzzDraw {
  /** 2 for a build that ran twice. */
  readonly runs: number;
  /** Ticks stepped over its runs. */
  readonly ticks: number;
  /** A run stopped at a failure. */
  readonly stopped: boolean;
  /** The first run's hash of every tick's events and the result; null when it ran once. */
  readonly hash: string | null;
  /** The first run's highestWaveCleared, at its end or where it stopped. */
  readonly highestWaveCleared: number;
  readonly peaks: WebFuzzPeaks;
  /** enemyKilled, hit and impact events over its runs. */
  readonly kills: number;
  readonly hits: number;
  readonly impacts: number;
  /** The clock's reading over its runs; null without a clock. */
  readonly time: number | null;
}

export interface WebFuzzReport {
  readonly seed: number;
  readonly ticksPerRun: number;
  /** The webs, `<character>.<scope>`, in dealing order. */
  readonly webs: readonly string[];
  readonly builds: readonly WebFuzzBuild[];
  /** The fixed cases run, each with whether its start wave was cleared. */
  readonly cases: readonly (WebFuzzBuild & { readonly cleared: boolean })[];
  readonly runs: number;
  readonly ticks: number;
  /** Runs that stopped at a failing tick or a throw. */
  readonly stoppedEarly: number;
  readonly failures: readonly WebFuzzFailure[];
  readonly warnings: readonly WebFuzzWarning[];
  readonly peaks: WebFuzzPeaks;
  readonly kills: number;
  readonly hits: number;
  readonly impacts: number;
}

/** Every character with a center in every scope that holds it, character by character (§4.9). */
export function fuzzWebs(content: Content): AssembledWeb[] {
  const webs: AssembledWeb[] = [];
  for (const c of CHARACTER_IDS) {
    if (content.characters[c].center === null) continue;
    for (const scope of SCOPES) {
      if (scopeHolds(scope.characters, c)) webs.push(assembleWeb(content, c, scope));
    }
  }
  return webs;
}

const webName = (web: AssembledWeb): string => `${web.character}.${web.scope.name}`;

const ownedIds = (web: AssembledWeb, progress: CharacterProgress): string[] =>
  web.nodes.filter((node) => storedRank(progress, node.id) > 0).map((node) => node.id);

/** A build ready to run. */
interface Planned {
  readonly draw: WebFuzzDraw;
  readonly web: AssembledWeb;
  readonly progress: CharacterProgress;
  readonly hashed: boolean;
}

/** Each fusion's coef as `web` was assembled. */
const coefsOf = (web: AssembledWeb): Partial<Record<FusionKey, number>> =>
  Object.fromEntries([...web.fusions.values()].map((fusion) => [fusion.key, fusion.coef]));

/** The waves a scope's cap allows from `waves`. */
const within = (scope: WebScope, waves: readonly number[]): number[] =>
  waves.filter((wave) => wave <= (scope.waveCap ?? Infinity));

/** Build `index` on `web` (D25): every draw from the build's own rng, in a fixed order. */
function drawBuild(content: Content, web: AssembledWeb, seed: number, index: number): Planned {
  const buildSeed = deriveSeed(seed, `webFuzz:${index}`);
  const rng: Rng = createRng(buildSeed);
  const purchases = PURCHASES.min + rng.int(PURCHASES.max - PURCHASES.min + 1);
  const account: AccountProgress = { singularityBeaten: rng.chance(THIRD_SLOT_SHARE) };
  const bestWave = rng.pick(WEB_FUZZ_WAVES);
  const prestiged = rng.chance(PRESTIGE_SHARE);
  let coefs: Partial<Record<FusionKey, number>> | null = null;
  if (rng.chance(COEF_ENDS_SHARE)) {
    coefs = {};
    for (const fusion of web.fusions.values()) {
      const range = coefRange(fusion);
      coefs[fusion.key] = range === null ? 1 : rng.chance(0.5) ? range[0] : range[1];
    }
  }
  const startWave = rng.pick(within(web.scope, WEB_FUZZ_WAVES));
  const built = coefs === null ? web : assembleWeb(content, web.character, web.scope, { coefs });
  const progress = sampleProgress(built, rng, { purchases, account, bestWave, prestiged });
  const ids = ownedIds(built, progress);
  return {
    draw: {
      name: `${webName(web)}.${index}`,
      index,
      character: web.character,
      scope: web.scope.name,
      purchases,
      account,
      bestWave,
      prestiged,
      coefs: coefs === null ? null : coefsOf(built),
      startWave,
      seed: buildSeed,
      ids,
      ranks: ids.reduce((sum, id) => sum + storedRank(progress, id), 0),
    },
    web: built,
    progress,
    hashed: index % HASH_EVERY === 0,
  };
}

/** A fixed case on its character's web in FULL_SCOPE, with a fresh save's account. */
function planCase(content: Content, at: WebFuzzCase, seed: number): Planned {
  const web = assembleWeb(content, at.character, FULL_SCOPE);
  const account: AccountProgress = { singularityBeaten: false };
  const progress = progressFromOrder(web, account, at.order);
  const ids = ownedIds(web, progress);
  return {
    draw: {
      name: at.name,
      index: -1,
      character: at.character,
      scope: FULL_SCOPE.name,
      purchases: at.order.length,
      account,
      bestWave: progress.bestWave,
      prestiged: progress.prestiges > 0,
      coefs: null,
      startWave: at.startWave,
      seed: deriveSeed(seed, `webFuzzCase:${at.name}`),
      ids,
      ranks: at.order.length,
    },
    web,
    progress,
    hashed: false,
  };
}

/** What one run did. */
interface RunOutcome {
  readonly failures: readonly { readonly kind: WebFuzzFailure['kind']; readonly text: string }[];
  /** Stopped at a failing tick or a throw, not at its end (F56). */
  readonly stopped: boolean;
  /** The first tick above ALIVE_WARNING enemies alive, and how many; null for none. */
  readonly crowded: { readonly tick: number; readonly alive: number } | null;
  readonly hash: string;
  readonly ticks: number;
  readonly highestWaveCleared: number;
  readonly peaks: WebFuzzPeaks;
  readonly kills: number;
  readonly hits: number;
  readonly impacts: number;
}

const NO_PEAKS: WebFuzzPeaks = {
  alive: 0,
  summons: 0,
  inFlight: 0,
  chainHits: 0,
  effectQueue: 0,
  budgetStreak: 0,
};

function maxPeaks(a: WebFuzzPeaks, b: WebFuzzPeaks): WebFuzzPeaks {
  return {
    alive: Math.max(a.alive, b.alive),
    summons: Math.max(a.summons, b.summons),
    inFlight: Math.max(a.inFlight, b.inFlight),
    chainHits: Math.max(a.chainHits, b.chainHits),
    effectQueue: Math.max(a.effectQueue, b.effectQueue),
    budgetStreak: Math.max(a.budgetStreak, b.budgetStreak),
  };
}

/**
 * One run of `planned` for up to `ticks` ticks under the fuzz's checks, stopping at its first
 * failing tick or throw (F56). The hash covers every tick's events and the result, and is
 * computed only for a build that runs twice.
 */
function runOnce(
  planned: Planned,
  data: GameData,
  ticks: number,
  modules: readonly TestModule[],
): RunOutcome {
  const failures: SummonFuzzFailure[] = [];
  const ended: { kind: WebFuzzFailure['kind']; text: string }[] = [];
  const hash = createRunHash();
  const seen: { ctx: RunContext | null } = { ctx: null };
  const watch: TestModule = (b) =>
    void b.hook('tick', (ctx) => {
      seen.ctx = ctx;
    });
  const run = { stepped: 0, created: false, cleared: 0, alive: 0, summons: 0, inFlight: 0 };
  const work = { kills: 0, hits: 0, impacts: 0 };
  let crowded: RunOutcome['crowded'] = null;
  let counters: Readonly<Record<CounterId, number>> | null = null;
  try {
    const { web, progress, draw } = planned;
    const waveCap = web.scope.waveCap ?? undefined;
    const config = {
      ...webRunConfig(webBuild(web, progress), draw.seed, draw.startWave, waveCap),
      maxTicks: ticks,
    };
    const sim = createSimulation(config, data, [...modules, watch]);
    run.created = true;
    const { state } = sim;
    const observe = (): void => {
      run.alive = Math.max(run.alive, state.enemies.length);
      run.summons = Math.max(run.summons, state.droneCount);
      run.inFlight = Math.max(run.inFlight, state.projectiles.length + state.shotCount);
      run.cleared = state.highestWaveCleared;
    };
    observe();
    checkSummonTick(state, SUMMON_CAP, null, failures);
    while (failures.length === 0 && !state.finished) {
      const events = sim.step(NO_INPUT);
      run.stepped = state.tick;
      if (planned.hashed) hash.update(JSON.stringify(events));
      for (const event of events) {
        if (event.type === 'enemyKilled') work.kills++;
        else if (event.type === 'hit') work.hits++;
        else if (event.type === 'impact') work.impacts++;
      }
      observe();
      const alive = state.enemies.length;
      if (alive > ALIVE_WARNING && crowded === null) crowded = { tick: state.tick, alive };
      checkSummonTick(state, SUMMON_CAP, seen.ctx?.counters ?? null, failures);
    }
    if (failures.length === 0) {
      const result = sim.result();
      if (planned.hashed) hash.update(JSON.stringify(result));
      counters = result.counters;
      if (counters.effectsDropped !== 0) {
        ended.push({ kind: 'dropped', text: `effectsDropped ${counters.effectsDropped}, not 0` });
      }
      if (counters.effectBudgetStreakMax >= BUDGET_STREAK_LIMIT) {
        ended.push({
          kind: 'budget',
          text:
            `effectBudgetStreakMax ${counters.effectBudgetStreakMax}, not below ` +
            `${BUDGET_STREAK_LIMIT}: effects carried over half a second in a row (F8)`,
        });
      }
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const tick = run.created ? run.stepped + 1 : 0;
    failures.push({ kind: 'threw', text: `tick ${tick}: threw ${text}` });
  }
  counters ??= seen.ctx?.counters ?? null;
  return {
    failures: [...failures, ...ended],
    stopped: failures.length > 0,
    crowded,
    hash: hash.digest(),
    ticks: run.stepped,
    highestWaveCleared: run.cleared,
    peaks: {
      alive: run.alive,
      summons: run.summons,
      inFlight: run.inFlight,
      chainHits: counters?.chainHitsPeak ?? 0,
      effectQueue: counters?.effectQueuePeak ?? 0,
      budgetStreak: counters?.effectBudgetStreakMax ?? 0,
    },
    ...work,
  };
}

/** A line of the report and how many of its runs stopped early. */
interface Ran {
  readonly line: WebFuzzBuild;
  readonly stopped: number;
}

/** The fuzz's checks over `planned`'s runs, as a line of the report, its failures and warning. */
function runPlanned(
  planned: Planned,
  options: WebFuzzOptions,
  repro: string,
  failures: WebFuzzFailure[],
  warnings: WebFuzzWarning[],
): Ran {
  const { draw } = planned;
  const { clock } = options;
  const subject =
    draw.index < 0
      ? `fuzz case '${draw.name}' (character '${draw.character}')`
      : `fuzz build ${draw.index} (character '${draw.character}', scope '${draw.scope}')`;
  const started = clock?.();
  const runs: RunOutcome[] = [];
  for (let r = 1; r <= (planned.hashed ? 2 : 1); r++) {
    const modules = options.modules?.(draw, r) ?? [];
    const run = runOnce(planned, options.data, options.ticks, modules);
    runs.push(run);
    // A failing run ends the build: a second run would only repeat its failure.
    if (run.failures.length > 0) break;
  }
  const time = clock === undefined || started === undefined ? null : clock() - started;
  for (const [r, run] of runs.entries()) {
    const at = r === 0 ? '' : `run ${r + 1}: `;
    for (const failure of run.failures) {
      failures.push({
        kind: failure.kind,
        text: `${subject}: ${at}${failure.text}`,
        repro,
        ids: draw.ids,
      });
    }
  }
  const [first, second] = runs as [RunOutcome, RunOutcome | undefined];
  if (second !== undefined && second.hash !== first.hash) {
    failures.push({
      kind: 'hash',
      text: `${subject}: runs differ (${first.hash}, ${second.hash})`,
      repro,
      ids: draw.ids,
    });
  }
  const crowded = runs.find((run) => run.crowded !== null)?.crowded ?? null;
  if (crowded !== null) {
    warnings.push({
      text:
        `${subject}: tick ${crowded.tick}: ${crowded.alive} enemies alive, above ` +
        `${ALIVE_WARNING} (a failure once C7 exports ENEMY_CAP_ENFORCED; D31)`,
      repro,
    });
  }
  const sum = (pick: (run: RunOutcome) => number): number =>
    runs.reduce((total, run) => total + pick(run), 0);
  const stopped = runs.filter((run) => run.stopped).length;
  return {
    line: {
      ...draw,
      runs: runs.length,
      ticks: sum((run) => run.ticks),
      stopped: stopped > 0,
      hash: planned.hashed ? first.hash : null,
      highestWaveCleared: first.highestWaveCleared,
      peaks: runs.reduce((peaks, run) => maxPeaks(peaks, run.peaks), NO_PEAKS),
      kills: sum((run) => run.kills),
      hits: sum((run) => run.hits),
      impacts: sum((run) => run.impacts),
      time,
    },
    stopped,
  };
}

/** The repro line's flags for a run of these options, before --only. */
function reproOf(options: WebFuzzOptions, seed: number, name: string): string {
  const { ticks } = options;
  const flags = [
    ...(options.fixture === true ? ['--fixture'] : []),
    ...(seed === WEB_FUZZ_SEED ? [] : ['--seed', String(seed)]),
    ...(ticks === WEB_FUZZ_TICKS ? [] : ['--ticks', String(ticks)]),
    '--only',
    name,
  ];
  return `npm run fuzz:web -- ${flags.join(' ')}`;
}

/**
 * The build `only` names, `<character>.<scope>.<index>`, which must be the web build `index` is
 * dealt to; throws otherwise, naming the web it is dealt to.
 */
function onlyIndex(only: string, webs: readonly AssembledWeb[]): number {
  const match = /^([a-z]+)\.([A-Za-z0-9]+)\.(\d+)$/.exec(only);
  if (match === null || webs.length === 0) {
    throw new Error(
      `runWebFuzz: --only '${only}' names no build: write <character>.<scope>.<index>` +
        (webs.length === 0 ? ', and the content has no web' : ''),
    );
  }
  const index = Number(match[3]);
  const dealt = webName(webs[index % webs.length] as AssembledWeb);
  if (dealt !== `${match[1]}.${match[2]}`) {
    throw new Error(`runWebFuzz: --only '${only}': build ${index} is dealt to '${dealt}'`);
  }
  return index;
}

/**
 * The web fuzz (§4.9): builds 0 to `builds` − 1 dealt over fuzzWebs(content), then the fixed
 * cases; with `only`, just that build or case, exactly as the full run draws it.
 */
export function runWebFuzz(options: WebFuzzOptions): WebFuzzReport {
  const seed = options.seed ?? WEB_FUZZ_SEED;
  const { ticks, content } = options;
  const webs = fuzzWebs(content);
  const failures: WebFuzzFailure[] = [];
  const warnings: WebFuzzWarning[] = [];
  const cases = options.cases ?? [];
  const onlyCase = cases.find((at) => at.name === options.only);
  const plans: Planned[] = [];
  const casePlans: Planned[] = [];
  if (options.only === undefined) {
    for (let i = 0; i < options.builds && webs.length > 0; i++) {
      plans.push(drawBuild(content, webs[i % webs.length] as AssembledWeb, seed, i));
    }
    for (const at of cases) casePlans.push(planCase(content, at, seed));
  } else if (onlyCase !== undefined) {
    casePlans.push(planCase(content, onlyCase, seed));
  } else {
    const index = onlyIndex(options.only, webs);
    plans.push(drawBuild(content, webs[index % webs.length] as AssembledWeb, seed, index));
  }
  const run = (planned: Planned): Ran =>
    runPlanned(planned, options, reproOf(options, seed, planned.draw.name), failures, warnings);
  const ran = plans.map(run);
  const casesRan = casePlans.map(run);
  const all = [...ran, ...casesRan];
  const sum = (pick: (line: WebFuzzBuild) => number): number =>
    all.reduce((total, { line }) => total + pick(line), 0);
  return {
    seed,
    ticksPerRun: ticks,
    webs: webs.map(webName),
    builds: ran.map(({ line }) => line),
    cases: casesRan.map(({ line }) => ({
      ...line,
      cleared: line.highestWaveCleared >= line.startWave,
    })),
    runs: sum((line) => line.runs),
    ticks: sum((line) => line.ticks),
    stoppedEarly: all.reduce((total, { stopped }) => total + stopped, 0),
    failures,
    warnings,
    peaks: all.reduce((peaks, { line }) => maxPeaks(peaks, line.peaks), NO_PEAKS),
    kills: sum((line) => line.kills),
    hits: sum((line) => line.hits),
    impacts: sum((line) => line.impacts),
  };
}
