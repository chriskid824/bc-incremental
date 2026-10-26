import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../../src/core/num';
import { createRng, deriveSeed } from '../../../src/core/rng';
import { characterGameData } from '../../../src/data';
import type { EnemyId } from '../../../src/data';
import type { AssembledWeb } from '../../../src/data/web';
import {
  boardCounts,
  buy,
  DEFAULT_WEB_ECONOMY,
  emptyProgress,
  webBuild,
  webStartWave,
} from '../../../src/meta/web';
import type { CharacterProgress } from '../../../src/meta/web';
import { frontierOf, probeRun } from '../../../src/meta/web/calibrate';
import { GATED_KINDS } from '../../../src/meta/web/counts';
import { fillBoard, unlockInvestment } from '../../../src/meta/web/invest';
import { shortestRoute } from '../../../src/meta/web/path';
import { createSimulation, NO_INPUT } from '../../../src/sim';
import type { ContactTally, RunResult, Simulation } from '../../../src/sim';
import { TEST_V3_WAVES, v3TestData } from '../../../src/sim/testing';
import { jobOf, runJobs } from '../jobs';
import { compressIds } from '../session';
import { builtCharacters, C10_SEED, resolveContent, webOf } from './content';
import { PRESTIGE } from './prestige';
import type { PrestigeHook } from './prestige';
import {
  BOMB_WINDOW_TICKS,
  budgetOf,
  centerShareOf,
  characterStartWave,
  damageByClass,
  damageColumns,
  defaultSessionMinutes,
  FULL_SESSION_MINUTES,
  OTHER_SESSION_MINUTES,
  playRun,
  PRE_PRESTIGE_MINUTES,
  PRESTIGE_WAVE,
  purchasesOf,
  runCharacterSession,
  settlementEarned,
  SNAPSHOT_MINUTES,
  TYPE_COLUMNS,
  typeTallies,
  V3_MILESTONE_WAVES,
  WALL_STALL_RUNS,
} from './session';
import type { CharacterRunRow, CharacterSessionConfig } from './session';
import { createStrategy, openNodes } from './strategies';
import type { WebStrategy, WebStrategyId } from './strategies';
import { cappedRunConfig, greedySeeds, openVisit, probeFrom, probeFrontiers } from './visit';
import type { Visit } from './visit';

const FIXTURE = { fixture: 'B5' } as const;
const ACCOUNT = { singularityBeaten: false };
const web = webOf(FIXTURE, 'fire', 'full');

const config = (overrides: Partial<CharacterSessionConfig> = {}): CharacterSessionConfig => ({
  character: 'fire',
  strategy: 'default',
  session: 0,
  seed: 1,
  minutes: 3,
  startWave: { kind: 'max' },
  economy: DEFAULT_WEB_ECONOMY,
  menuSeconds: 20,
  content: FIXTURE,
  scope: 'full',
  ...overrides,
});

/** A fresh fire progress holding `shards` and `cores`. */
const funded = (shards: number, cores = 0, extra: Partial<CharacterProgress> = {}) => ({
  ...emptyProgress('fire'),
  wallet: { shards: num(shards), cores, resonance: 0 },
  ...extra,
});

/**
 * `progress` with the route to each target and the target bought, then one more rank of each of
 * `more`, then an empty wallet.
 */
function owning(targets: readonly string[], more: readonly string[] = []): CharacterProgress {
  let progress: CharacterProgress = funded(1e30, 1000);
  for (const target of targets) {
    const route = shortestRoute(web, progress, target, (node) => !GATED_KINDS.has(node.kind));
    for (const id of route ?? []) progress = buy(web, progress, ACCOUNT, id, DEFAULT_WEB_ECONOMY);
  }
  for (const id of more) progress = buy(web, progress, ACCOUNT, id, DEFAULT_WEB_ECONOMY);
  return { ...progress, wallet: { shards: num(0), cores: 0, resonance: 0 } };
}

/** A strategy that never buys. */
const idle = (id: WebStrategyId): WebStrategy => ({ id, evaluations: [], visit() {} });

/** A hook that prestiges once, when `due` says so, keeping the ranks. */
function prestigeOnce(
  due: (minutes: number, cycleBest: number) => boolean,
  applied: number[] = [],
) {
  const hook: PrestigeHook = {
    shouldPrestige: (state) =>
      state.prestiges === 0 && due(state.minutes, state.progress.cycleBest),
    apply: (_web, progress, account) => {
      applied.push(progress.runs);
      return {
        progress: { ...progress, cycleBest: 0, prestiges: progress.prestiges + 1 },
        account,
      };
    },
  };
  return hook;
}

/** A strategy that buys exactly one node a visit, the first open one canBuy accepts. */
const oneEachVisit = (id: WebStrategyId): WebStrategy => ({
  id,
  evaluations: [],
  visit(v) {
    const node = openNodes(v.web, v.progress()).find((open) => v.check(open.id).ok);
    if (node !== undefined) v.buy(node.id);
  },
});

describe('runCharacterSession', () => {
  it('is a pure function of its config, in-process or on two workers', async () => {
    // Stateful strategies too: balanced's turn and greedy's readings start afresh each session.
    const probe = (p: CharacterProgress) => [3 + purchasesOf(web, p) / 100, 3];
    for (const strategy of ['random', 'balanced', 'greedy'] as const) {
      const once = config({ strategy, initialProgress: funded(1e6, 6) });
      expect(runCharacterSession(once, { probe }), strategy).toEqual(
        runCharacterSession(once, { probe }),
      );
    }
    const configs = [
      config({ strategy: 'random', initialProgress: funded(1e6, 6) }),
      config({ strategy: 'random', session: 1, initialProgress: funded(1e6, 6) }),
      config({ strategy: 'cheapest', initialProgress: funded(1e6, 6) }),
      config({ strategy: 'balanced', initialProgress: funded(1e6, 6) }),
      config({ strategy: 'balanced', session: 1, initialProgress: funded(1e6, 6) }),
    ];
    const inProcess = await runJobs(configs.map(jobOf), 1);
    const workers = await runJobs(configs.map(jobOf), 2);
    expect([inProcess.mode, workers.mode]).toEqual(['in-process', 'workers']);
    expect(workers.results).toEqual(inProcess.results);
  }, 30_000);

  it("gives each session its strategy's own stream, and every strategy the same run seeds", () => {
    const [a, b] = [0, 1].map((session) =>
      runCharacterSession(config({ strategy: 'random', session, initialProgress: funded(1e6, 6) })),
    );
    expect(a?.rows[0]?.bought).not.toBe(b?.rows[0]?.bought);
    const runOf = (strategy: WebStrategyId): readonly (number | undefined)[] => {
      const row = runCharacterSession(config({ strategy, initialProgress: funded(1e6, 6) }))
        .rows[0];
      return [row?.kills, row?.runSeconds, row?.leaks];
    };
    expect(runOf('random')).toEqual(runOf('default'));
    expect(runOf('might-only')).toEqual(runOf('default'));
  });

  it('buys only through its visit, each purchase accepted by canBuy when made', () => {
    const strategies: WebStrategyId[] = [
      'default',
      'greedy',
      'random',
      'cheapest',
      'balanced',
      'might-only',
      'focus:ice',
    ];
    for (const strategy of strategies) {
      const visits: { readonly id: string; readonly ok: boolean }[][] = [];
      const made: WebStrategy[] = [];
      const spy = (id: WebStrategyId, w: AssembledWeb): WebStrategy => {
        const inner = createStrategy(id, w);
        made.push(inner);
        return {
          id,
          evaluations: inner.evaluations,
          visit(v) {
            const before = v.progress();
            const buys: { id: string; ok: boolean }[] = [];
            const watched: Visit = {
              ...v,
              buy: (node) => {
                buys.push({ id: node, ok: v.check(node).ok });
                v.buy(node);
              },
            };
            inner.visit(watched);
            visits.push(buys);
            expect(purchasesOf(w, v.progress()) - purchasesOf(w, before), strategy).toBe(
              buys.length,
            );
          },
        };
      };
      const result = runCharacterSession(
        config({ strategy, minutes: 2, initialProgress: funded(1e6, 8) }),
        { strategy: spy, probe: (p) => [3 + purchasesOf(web, p) / 100, 3] },
      );
      expect(visits.length, strategy).toBe(result.rows.length);
      expect(visits.flat().length, strategy).toBeGreaterThan(0);
      expect(
        visits.flat().every((purchase) => purchase.ok),
        strategy,
      ).toBe(true);
      expect(
        result.rows.map((row) => row.bought),
        strategy,
      ).toEqual(visits.map((buys) => compressIds(buys.map((purchase) => purchase.id))));
      // The session's bought list: every node once, in first-bought order; greedy's readings kept.
      expect(result.bought, strategy).toEqual([
        ...new Set(visits.flat().map((purchase) => purchase.id)),
      ]);
      const readings = made[0]?.evaluations ?? [];
      expect(made, strategy).toHaveLength(1);
      expect(result.evaluations, strategy).toEqual(readings.length > 0 ? readings : undefined);
      if (strategy === 'greedy') expect(readings.length).toBeGreaterThan(0);
      if (strategy === 'random') expect(result.evaluations).toBeUndefined();
    }
  });

  it('stops before B2 after the first run that ends with cycleBest ≥ PRESTIGE_WAVE', () => {
    expect(PRESTIGE).toBeNull();
    expect(defaultSessionMinutes('default')).toBe(PRE_PRESTIGE_MINUTES);
    expect(defaultSessionMinutes('greedy')).toBe(PRE_PRESTIGE_MINUTES);

    const at = (wave: number) => ({ ...emptyProgress('fire'), cycleBest: wave, bestWave: wave });
    const stopped = runCharacterSession(
      config({ minutes: 10, initialProgress: at(PRESTIGE_WAVE) }),
    );
    const row = stopped.rows[0] as CharacterRunRow;
    expect(stopped.stop).toBe('prestigePoint');
    expect(stopped.rows).toHaveLength(1);
    expect(stopped.milestones.prestigePoint).toEqual({ minutes: row.minutes, purchases: 0 });
    expect(stopped.snapshots.map((snapshot) => snapshot.minutes)).toEqual(['prestige']);
    expect(stopped.endMinutes).toBeCloseTo(row.minutes + 20 / 60, 9);

    const below = runCharacterSession(
      config({ minutes: 6, initialProgress: at(PRESTIGE_WAVE - 1) }),
    );
    expect(below.stop).toBe('budget');
    expect(below.milestones.prestigePoint).toBeNull();
    expect(below.endMinutes).toBeGreaterThanOrEqual(6);
    expect(below.endMinutes).toBeCloseTo((below.rows.at(-1)?.minutes ?? NaN) + 20 / 60, 9);
    // No run raises cycleBest from 29, but without a prestige there is no wall.
    expect(below.rows.length).toBeGreaterThan(WALL_STALL_RUNS);
    expect(below.rows.every((r) => r.cycleBest === PRESTIGE_WAVE - 1)).toBe(true);
    expect(below.milestones.wall).toBeNull();
  });

  it("counts the prestige point's purchases after its visit", () => {
    const start = { ...funded(1e30, 1000), cycleBest: PRESTIGE_WAVE, bestWave: PRESTIGE_WAVE };
    const result = runCharacterSession(config({ minutes: 10, initialProgress: start }), {
      strategy: oneEachVisit,
    });
    const row = result.rows[0] as CharacterRunRow;
    expect(result.stop).toBe('prestigePoint');
    expect(row.purchases).toBe(1);
    expect(result.milestones.prestigePoint).toEqual({ minutes: row.minutes, purchases: 1 });
  });

  it('gives default sessions the clear and the others two hours once a prestige hook exists', () => {
    const hook = prestigeOnce(() => false);
    expect([FULL_SESSION_MINUTES, OTHER_SESSION_MINUTES]).toEqual([360, 120]);
    expect(defaultSessionMinutes('default', hook)).toBe(FULL_SESSION_MINUTES);
    expect(defaultSessionMinutes('greedy', hook)).toBe(OTHER_SESSION_MINUTES);
    expect(defaultSessionMinutes('focus:ice', hook)).toBe(OTHER_SESSION_MINUTES);
  });

  it('prestiges through a hook and goes on, applying it once, and stops at the clear', () => {
    const applied: number[] = [];
    const hook = prestigeOnce((_minutes, cycleBest) => cycleBest >= PRESTIGE_WAVE, applied);
    const start = { ...emptyProgress('fire'), cycleBest: PRESTIGE_WAVE, bestWave: PRESTIGE_WAVE };
    const result = runCharacterSession(config({ minutes: 8, initialProgress: start }), {
      prestige: hook,
    });
    const rows = result.rows;
    expect(applied).toEqual([1]);
    expect(result.stop).toBe('budget');
    expect(rows.length).toBeGreaterThan(WALL_STALL_RUNS + 2);
    expect(rows.map((row) => row.prestiges)).toEqual(rows.map((_, i) => (i === 0 ? 0 : 1)));
    expect(result.milestones.prestigePoint).toEqual({
      minutes: rows[0]?.minutes,
      purchases: rows[0]?.purchases,
    });
    expect(result.snapshots.filter((snapshot) => snapshot.minutes === 'prestige')).toHaveLength(1);

    // The wall: the first WALL_STALL_RUNS runs in a row after the prestige without a new best.
    let best = 0;
    let stall = 0;
    let wall: { minutes: number; wave: number } | null = null;
    for (const row of rows.slice(1)) {
      stall = row.cycleBest > best ? 0 : stall + 1;
      best = Math.max(best, row.cycleBest);
      if (stall >= WALL_STALL_RUNS) {
        wall = { minutes: row.minutes, wave: row.cycleBest };
        break;
      }
    }
    expect(wall).not.toBeNull();
    expect(result.milestones.wall).toEqual(wall);

    // A second prestige: the prestige point stays the first, and each prestige restarts the
    // count of runs without a new cycleBest (this hook keeps cycleBest, so no run raises it).
    const twice: number[] = [];
    const keeping: PrestigeHook = {
      shouldPrestige: (state) => state.progress.runs === 1 || state.progress.runs === 3,
      apply: (_web, progress, account) => {
        twice.push(progress.runs);
        return { progress: { ...progress, prestiges: progress.prestiges + 1 }, account };
      },
    };
    const kept = runCharacterSession(config({ minutes: 8, initialProgress: start }), {
      prestige: keeping,
    });
    expect(twice).toEqual([1, 3]);
    expect(kept.milestones.prestigePoint).toEqual({
      minutes: kept.rows[0]?.minutes,
      purchases: kept.rows[0]?.purchases,
    });
    expect(kept.snapshots.filter((snapshot) => snapshot.minutes === 'prestige')).toEqual([
      expect.objectContaining({ progress: expect.objectContaining({ runs: 1, prestiges: 0 }) }),
    ]);
    expect(kept.rows.every((r) => r.cycleBest === PRESTIGE_WAVE)).toBe(true);
    const after = kept.rows[3 + WALL_STALL_RUNS - 1] as CharacterRunRow;
    expect(kept.milestones.wall).toEqual({ minutes: after.minutes, wave: PRESTIGE_WAVE });

    const cleared = runCharacterSession(config({ minutes: 30 }), {
      prestige: prestigeOnce(() => false),
      clearWave: 3,
    });
    const last = cleared.rows.at(-1) as CharacterRunRow;
    expect(cleared.stop).toBe('cleared');
    expect(last.highestWaveCleared).toBeGreaterThanOrEqual(3);
    expect(cleared.rows.slice(0, -1).every((row) => row.highestWaveCleared < 3)).toBe(true);
  });

  it('takes its snapshots after the visit, at 10, 20, 30 and 45 min and at the prestige point', () => {
    const result = runCharacterSession(
      config({ minutes: 48, initialProgress: funded(1e30, 1000) }),
      { prestige: prestigeOnce((minutes) => minutes >= 46), strategy: oneEachVisit },
    );
    expect(SNAPSHOT_MINUTES).toEqual([10, 20, 30, 45]);
    expect(result.snapshots.map((snapshot) => snapshot.minutes)).toEqual([
      ...SNAPSHOT_MINUTES,
      'prestige',
    ]);
    let shards = 0;
    let cores = 0;
    const earned = result.rows.map((row) => {
      shards += row.shardsFromRun + row.skipShards;
      cores += row.coresFromRun + row.skipCores;
      return { shards, cores };
    });
    for (const snapshot of result.snapshots) {
      const due = snapshot.minutes === 'prestige' ? 46 : snapshot.minutes;
      const index = result.rows.findIndex((row) => row.minutes >= due);
      const row = result.rows[index] as CharacterRunRow;
      expect(purchasesOf(web, snapshot.progress), `${snapshot.minutes}`).toBe(row.purchases);
      expect(toNumber(snapshot.progress.wallet.shards)).toBe(row.shardsBank);
      expect(snapshot.earned.shards).toBeCloseTo(earned[index]?.shards ?? NaN, 6);
      expect(snapshot.earned.cores).toBe(earned[index]?.cores);
    }
    expect(
      settlementEarned({
        shardsFromRun: num(10),
        coresFromRun: 1,
        skipShards: num(5),
        skipCores: 2,
      }),
    ).toEqual({ shards: 15, cores: 3 });
  });

  it('takes a snapshot due at the very minute a run ends after that run', () => {
    const base = config({ minutes: 4, initialProgress: funded(1e30, 1000) });
    const hooks = { strategy: oneEachVisit };
    const row = runCharacterSession(base, hooks).rows[2] as CharacterRunRow;
    const exact = runCharacterSession({ ...base, snapshotMinutes: [row.minutes] }, hooks);
    expect(exact.snapshots.map((snapshot) => snapshot.minutes)).toEqual([row.minutes]);
    expect(purchasesOf(web, exact.snapshots[0]?.progress as CharacterProgress)).toBe(row.purchases);
  });

  it("caps start waves and runs at a demo scope's wave cap", () => {
    const high = { ...emptyProgress('fire'), cycleBest: 100, bestWave: 100 };
    const economy = DEFAULT_WEB_ECONOMY;
    expect(characterStartWave({ kind: 'max' }, high, economy, null)).toBe(50);
    expect(characterStartWave({ kind: 'max' }, high, economy, 40)).toBe(40);
    expect(characterStartWave({ kind: 'ratio', ratio: 0.3 }, high, economy, 40)).toBe(30);
    expect(characterStartWave({ kind: 'first' }, high, economy, 40)).toBe(1);
    const demo = runCharacterSession(
      config({ scope: 'demoA', minutes: 0.5, initialProgress: high }),
    );
    expect(demo.rows[0]).toMatchObject({ scope: 'demoA', startWave: 40 });
    expect(demo.rows.every((row) => row.highestWaveReached <= 40)).toBe(true);
    const demoWeb = webOf(FIXTURE, 'fire', 'demoA');
    expect(cappedRunConfig(demoWeb, webBuild(demoWeb, high), 1, 40).waveCap).toBe(40);
    expect('waveCap' in cappedRunConfig(web, webBuild(web, high), 1, 40)).toBe(false);
  });

  it("floors ratio:x's start wave, at least wave 1 and at most the allowed wave", () => {
    const at = (cycleBest: number) => ({
      ...emptyProgress('fire'),
      cycleBest,
      bestWave: cycleBest,
    });
    const economy = DEFAULT_WEB_ECONOMY;
    const ratio = (x: number) => ({ kind: 'ratio', ratio: x }) as const;
    expect(webStartWave(at(25), economy)).toBe(12);
    // ⌊25 × 0.3⌋ = ⌊7.5⌋ = 7.
    expect(characterStartWave(ratio(0.3), at(25), economy, null)).toBe(7);
    expect(characterStartWave(ratio(0.3), at(3), economy, null)).toBe(1);
    expect(characterStartWave(ratio(0.9), at(25), economy, null)).toBe(12);
  });

  it('counts the boards, ★ and cores it owns after each visit', () => {
    const MIGHT = 'hub.might.might';
    const targets = ['outer.ice.main.entry', 'outer.summon.main.entry', MIGHT];
    const stars = ['hub.rules.rule-one', `fire.center.main.star-one`];
    const progress = owning([...targets, ...stars], [MIGHT, MIGHT]);
    expect(progress.ranks[MIGHT]).toBe(3);
    const result = runCharacterSession(config({ minutes: 0.1, initialProgress: progress }), {
      strategy: idle,
    });
    const row = result.rows[0] as CharacterRunRow;
    const counts = boardCounts(web, progress);
    let hub = 0;
    for (const node of web.nodes)
      if (node.board === 'hub' && (progress.ranks[node.id] ?? 0) > 0) hub++;
    expect(row).toMatchObject({
      purchases: purchasesOf(web, progress),
      nodesCenter: counts.center,
      nodesHub: hub,
      nodesOuter: 2,
      outersUsed: 2,
      keystones: 2,
      fusionCores: 0,
    });
    expect(counts.keystones).toBe(2);
    expect(row.nodesCenter).toBeGreaterThan(0);
    expect(row.nodesHub).toBeGreaterThan(0);
  });

  it('records its milestones', () => {
    const fromBest = runCharacterSession(
      config({ minutes: 0.5, initialProgress: { ...emptyProgress('fire'), bestWave: 30 } }),
    );
    const first = fromBest.rows[0] as CharacterRunRow;
    for (const wave of V3_MILESTONE_WAVES) {
      expect(fromBest.milestones.minutesToWave[wave], `wave ${wave}`).toBe(
        wave <= 30 ? first.minutes : null,
      );
    }
    // The first visit starts able to pay a center ★ (3 cores), then spends the cores on notables.
    const rich = runCharacterSession(config({ minutes: 0.5, initialProgress: funded(1e6, 3) }));
    expect(rich.milestones.firstKeystoneAffordable).toBe(rich.rows[0]?.minutes);
    expect(rich.rows[0]?.coresBank).toBeLessThan(3);
    const poor = runCharacterSession(config({ minutes: 0.5, initialProgress: funded(1e6, 0) }));
    expect(poor.milestones.firstKeystoneAffordable).toBeNull();
  });

  it('records the first outer node, fusion core and ★ and the center threshold where each was bought', () => {
    // Fire–crit's gate met, the center at 12 and crit at 8 (the thresholds' gates), and main.c1
    // owned, next to the center ★ star-one.
    let start = unlockInvestment(web, ACCOUNT, 'crit');
    start = fillBoard(web, start, ACCOUNT, 'fire.center', (p) => boardCounts(web, p).center >= 12);
    start = fillBoard(
      web,
      start,
      ACCOUNT,
      'outer.crit',
      (p) => (boardCounts(web, p).outers.crit ?? 0) >= 8,
    );
    start = { ...start, wallet: { shards: num(1e30), cores: 1000, resonance: 0 } };
    const route = shortestRoute(web, start, 'fire.center.main.c1', (n) => !GATED_KINDS.has(n.kind));
    for (const id of route ?? []) start = buy(web, start, ACCOUNT, id, DEFAULT_WEB_ECONOMY);
    // Visit by visit: a hub node, an outer node, the ★, the core, crit's threshold, the center's.
    const plan = [
      ['hub.economy.r2'],
      ['outer.crit.alpha.r4'],
      ['fire.center.main.star-one'],
      ['fusion.fire.crit.core'],
      ['outer.crit.main.counter', 'outer.crit.main.threshold'],
      ['fire.center.main.threshold'],
    ];
    const scripted = (id: WebStrategyId): WebStrategy => {
      let visit = 0;
      return {
        id,
        evaluations: [],
        visit(v) {
          for (const node of plan[visit] ?? []) v.buy(node);
          visit += 1;
        },
      };
    };
    const result = runCharacterSession(config({ minutes: 5, initialProgress: start }), {
      strategy: scripted,
    });
    expect(result.rows.slice(0, plan.length).map((row) => row.bought)).toEqual(
      plan.map(compressIds),
    );
    const after = (visit: number) => result.rows[visit]?.minutes;
    expect(result.milestones).toMatchObject({
      firstOuterNode: after(1),
      firstKeystone: after(2),
      firstFusionCore: after(3),
      centerThreshold: after(5),
    });
    expect(new Set([1, 2, 3, 4, 5].map(after)).size).toBe(5);
  });
});

describe('content', () => {
  it('makes each fixture batch once, its own', () => {
    const full = resolveContent({ fixture: 'B5' });
    const first = resolveContent({ fixture: 'B1' });
    expect(builtCharacters(full)).toEqual(['fire', 'ice', 'lightning', 'summon']);
    expect(builtCharacters(first)).toEqual(['fire']);
    expect(resolveContent({ fixture: 'B1' })).toBe(first);
    expect(resolveContent({ fixture: 'B5' })).toBe(full);
  });
});

describe('openVisit', () => {
  const visit = (progress: CharacterProgress) =>
    openVisit({
      web,
      account: ACCOUNT,
      economy: DEFAULT_WEB_ECONOMY,
      data: characterGameData(),
      rng: createRng(1),
      minutes: 0,
      progress,
      probe: () => [0, 0],
    });

  it('buys what canBuy accepts and throws on a refusal, leaving the progress as it was', () => {
    const near = 'fire.center.alpha.r1';
    const far = 'outer.ice.main.entry';
    const broke = visit(emptyProgress('fire'));
    expect(() => broke.buy(near)).toThrow(
      /visit: 'fire\.center\.alpha\.r1' refused: notEnoughShards/,
    );
    expect(() => broke.buy(far)).toThrow(/visit: 'outer\.ice\.main\.entry' refused/);
    expect(broke.bought).toEqual([]);
    expect(broke.progress()).toEqual(emptyProgress('fire'));

    const paid = visit(funded(1e6));
    expect(paid.check(near).ok).toBe(true);
    paid.buy(near);
    paid.buy(near);
    expect(paid.bought).toEqual([near, near]);
    expect(paid.progress().ranks[near]).toBe(2);
    expect(() => paid.buy(far)).toThrow(/refused/);
  });
});

describe('greedy probes', () => {
  it("probes from the next run's start wave, on the session's and the run's seeds", () => {
    let visit = 0;
    const calls = new Map<number, { readonly start: number; readonly seeds: readonly number[] }>();
    const counting = (id: WebStrategyId, w: AssembledWeb): WebStrategy => {
      const inner = createStrategy(id, w);
      return {
        id,
        evaluations: inner.evaluations,
        visit(v) {
          visit += 1;
          inner.visit(v);
        },
      };
    };
    const result = runCharacterSession(
      config({
        strategy: 'greedy',
        session: 3,
        // Start waves at cycleBest itself, so run 2 starts above run 1.
        economy: { ...DEFAULT_WEB_ECONOMY, startWaveRatio: 1 },
        initialProgress: funded(1e6, 6),
      }),
      {
        strategy: counting,
        probe: (p, start, seeds) => {
          const seen = calls.get(visit);
          if (seen !== undefined) expect({ start, seeds }).toEqual(seen);
          calls.set(visit, { start, seeds });
          return [3 + purchasesOf(web, p) / 100, 3];
        },
      },
    );
    // Run 1 starts at wave 1, run 2 higher: visit 1 probes from run 2's start, not run 1's.
    expect(result.rows[1]?.startWave).toBeGreaterThan(result.rows[0]?.startWave ?? NaN);
    expect(calls.has(1)).toBe(true);
    for (const [run, { start, seeds }] of calls) {
      expect(seeds, `visit ${run}`).toEqual(greedySeeds(3, run));
      const next = result.rows[run];
      if (next !== undefined) expect(start, `visit ${run}`).toBe(next.startWave);
    }
    expect(greedySeeds(3, 7)).toEqual([
      deriveSeed(C10_SEED, 'greedy:3:7:0'),
      deriveSeed(C10_SEED, 'greedy:3:7:1'),
    ]);
  });

  it('reads a probe as calibration does, from its start wave on, for at most its ticks', () => {
    const data = characterGameData();
    const progress = owning(['hub.might.might']);
    expect(probeFrom(web, progress, 5, data, 1, 3_000)).toEqual(
      probeRun(web, progress, 5, data, 3_000),
    );
    // The waves below the start wave count as cleared.
    const late = probeFrom(web, progress, 5, data, 10, 3_000);
    expect(late.highestWaveCleared).toBe(9);
    expect(late.enemies.length).toBeGreaterThan(0);
    expect(late.enemies.every((fate) => fate.wave >= 10)).toBe(true);
    expect(probeFrom(web, progress, 5, data, 1, 60)).toMatchObject({ ticks: 60, timeout: true });
    expect(probeFrontiers(web, progress, data, 10, [5, 6])).toEqual(
      [5, 6].map((seed) => frontierOf(probeFrom(web, progress, seed, data, 10), data)),
    );
  });

  it("stops a probe at the scope's wave cap", () => {
    const data = characterGameData();
    // Enemies that neither hurt the player nor hold their wave: no contact damage, and shooters and
    // summoners walk in as M1's types do (at their posts, C7.4b's, the empty build could never
    // clear them, and bullets hurt). A probe runs on to the wave cap, or to its ticks without one.
    const harmless = {
      ...data,
      enemies: Object.fromEntries(
        Object.entries(data.enemies).map(([id, { behaviour, ...enemy }]) => [
          id,
          {
            ...enemy,
            contactDamage: 0,
            ...(behaviour === undefined || behaviour.kind === 'shoot' || behaviour.kind === 'summon'
              ? {}
              : { behaviour }),
          },
        ]),
      ) as typeof data.enemies,
    };
    const high = { ...emptyProgress('fire'), cycleBest: 80, bestWave: 80 };
    const capped = probeFrom(webOf(FIXTURE, 'fire', 'demoA'), high, 5, harmless, 40, 7_200);
    expect(capped).toMatchObject({ highestWaveCleared: 40, timeout: false });
    expect(capped.ticks).toBeLessThan(7_200);
    expect(capped.enemies.every((fate) => fate.wave <= 40)).toBe(true);
    const full = probeFrom(web, high, 5, harmless, 40, 7_200);
    expect(full).toMatchObject({ ticks: 7_200, timeout: true });
    expect(full.enemies.some((fate) => fate.wave > 40)).toBe(true);
  });

  it('leaves out the extra enemies as probeRun does: summoned children have no fate (C7/F12)', () => {
    // Planted bug: probeFrom keeping the fates of the extra enemies that probeRun leaves out.
    // Two summoners a wave that the build cannot kill, and six triangles.
    const v3 = v3TestData({
      enemies: { summoner: { hpMult: 1e9 } },
      waves: {
        rules: [
          { enemy: 'summoner', fromWave: 1, base: 2, perWave: 0, maxCount: 2 },
          { enemy: 'triangle', fromWave: 1, base: 6, perWave: 0, maxCount: 6 },
        ],
        eliteEvery: 1000,
        bossEvery: 1000,
        v3: {
          ...TEST_V3_WAVES.v3,
          affixes: [],
          treasure: { ...TEST_V3_WAVES.v3.treasure, fromWave: 999 },
        },
      },
    });
    const progress = owning(['hub.might.might']);
    const sim = createSimulation(
      { ...cappedRunConfig(web, webBuild(web, progress), 5, 1), maxTicks: 6_000 },
      v3,
    );
    let summoned = 0;
    while (!sim.state.finished) {
      for (const e of sim.step(NO_INPUT)) if (e.type === 'summoned') summoned += e.count;
    }
    expect(summoned).toBeGreaterThan(10);
    const probe = probeFrom(web, progress, 5, v3, 1, 6_000);
    expect(probe).toEqual(probeRun(web, progress, 5, v3, 6_000));
    // Eight fates a wave at most: its summoners and triangles, never their children.
    const perWave = new Map<number, number>();
    for (const fate of probe.enemies) perWave.set(fate.wave, (perWave.get(fate.wave) ?? 0) + 1);
    expect(Math.max(...perWave.values())).toBe(8);
  });
});

describe('row readings', () => {
  const tally = (hits: number, damage: number): ContactTally => ({ hits, damage });
  const takenBy = (entries: Partial<Record<EnemyId, ContactTally>>) => {
    const zero = Object.fromEntries(
      Object.keys(characterGameData().enemies).map((id) => [id, tally(0, 0)]),
    );
    return { ...zero, ...entries } as Record<EnemyId, ContactTally>;
  };

  it('puts each type in its gd §6.4 column: the shard as a pentagon, the hexagon as the elite', () => {
    const damageTakenBy = takenBy({
      triangle: tally(1, 2),
      pentagon: tally(3, 4),
      shard: tally(5, 6),
      hexagon: tally(7, 8),
      boss: tally(9, 10),
      onion: tally(11, 12),
      treasure: tally(13, 14),
      shielder: tally(15, 16),
    });
    const plain = typeTallies({ damageTakenBy } as unknown as RunResult);
    expect(plain.triangle).toEqual({ leaks: 1, contact: 2, bullet: null });
    expect(plain.pentagon).toEqual({ leaks: 8, contact: 10, bullet: null });
    expect(plain.elite).toEqual({ leaks: 7, contact: 8, bullet: null });
    expect(plain.boss).toEqual({ leaks: 20, contact: 22, bullet: null });
    expect(plain.treasure).toEqual({ leaks: 13, contact: 14, bullet: null });
    expect(plain.shielder).toEqual({ leaks: 15, contact: 16, bullet: null });
    expect(plain.square).toEqual({ leaks: 0, contact: 0, bullet: null });

    const bulletTakenBy = takenBy({
      shard: tally(1, 5),
      hexagon: tally(1, 7),
      shooter: tally(2, 3),
    });
    const shot = typeTallies({ damageTakenBy, bulletTakenBy } as unknown as RunResult);
    expect(shot.pentagon.bullet).toBe(5);
    expect(shot.elite.bullet).toBe(7);
    expect(shot.shooter.bullet).toBe(3);
    expect(shot.triangle.bullet).toBe(0);
  });

  it("sums the per-type columns to each run's leaks and contact damage", () => {
    const result = runCharacterSession(config({ minutes: 2 }));
    expect(result.rows.length).toBeGreaterThan(1);
    for (const row of result.rows) {
      const columns = TYPE_COLUMNS.map((column) => row.byType[column]);
      expect(columns.reduce((sum, t) => sum + t.leaks, 0)).toBe(row.leaks);
      expect(columns.reduce((sum, t) => sum + t.contact, 0)).toBe(row.damageTaken);
      // Bullets are tallied apart: every column null before C7.4b, every one a number after.
      expect(new Set(columns.map((t) => t.bullet === null)).size).toBe(1);
      expect(row.leaks).toBeGreaterThan(0);
    }
  });

  it('reads the budget counters by name, null for one the run lacks', () => {
    const counters = { effectBudgetTicks: 4, effectsDropped: 0, summonCapped: 2 };
    expect(budgetOf({ counters } as unknown as RunResult)).toEqual({
      effectBudgetTicks: 4,
      effectsDropped: 0,
      summonCapped: 2,
      chainHitCapped: null,
      projectilesCapped: null,
      enemyCapDelayed: null,
      enemySpawnsSkipped: null,
    });
    const later = { ...counters, enemyCapDelayed: 3, enemySpawnsSkipped: 1 };
    expect(budgetOf({ counters: later } as unknown as RunResult)).toMatchObject({
      enemyCapDelayed: 3,
      enemySpawnsSkipped: 1,
    });
  });

  it('sums damage by source class and counts the ascendancy as the center', () => {
    const damageBySource = {
      center: num(5),
      hub: num(1),
      'outer.ice': num(2),
      'outer.crit': num(1),
      'fusion.fire.ice': num(3),
      asc: num(4),
    };
    const classes = damageByClass({ damageBySource } as unknown as RunResult);
    expect(classes).toEqual({ center: 5, hub: 1, outer: 3, fusion: 3, asc: 4 });
    expect(centerShareOf(classes)).toBe(9 / 16);
    expect(damageColumns({ damageBySource } as unknown as RunResult)).toEqual({
      dmgCenter: 5,
      dmgHub: 1,
      dmgOuter: 3,
      dmgFusion: 3,
      dmgAsc: 4,
      centerShare: 9 / 16,
    });
    expect(centerShareOf({ center: 0, hub: 0, outer: 0, fusion: 0, asc: 0 })).toBeNull();
  });
});

/** A simulation whose tick t emits lobs[t] lob events beside another event, finished after the last. */
function scripted(lobs: readonly number[]): Simulation {
  let tick = 0;
  const state = { finished: lobs.length === 0 };
  const step = (): { type: string }[] => {
    const events = Array.from({ length: lobs[tick] ?? 0 }, () => ({ type: 'lob' }));
    events.push({ type: 'kill' });
    tick += 1;
    state.finished = tick >= lobs.length;
    return events;
  };
  return { state, step } as unknown as Simulation;
}

/** `ticks` ticks with `at`'s lob counts and none elsewhere. */
const lobsAt = (at: Readonly<Record<number, number>>, ticks: number): number[] =>
  Array.from({ length: ticks }, (_, tick) => at[tick] ?? 0);

describe('the bombs peak', () => {
  it('is the most lob events in any 60 consecutive ticks, a window sliding tick by tick', () => {
    expect(BOMB_WINDOW_TICKS).toBe(60);
    // Ticks 55 and 65 share a second that no window from tick 0, 60, 120, … holds.
    expect(playRun(scripted(lobsAt({ 55: 10, 65: 10 }, 200)))).toEqual({
      bombs: 20,
      bombsPeak: 20,
    });
    // 59 ticks apart: one window; 60 apart: never one.
    expect(playRun(scripted(lobsAt({ 0: 5, 59: 5 }, 200)))).toEqual({ bombs: 10, bombsPeak: 10 });
    expect(playRun(scripted(lobsAt({ 0: 5, 60: 5 }, 200)))).toEqual({ bombs: 10, bombsPeak: 5 });
    // Ticks 69 and 129 are 60 apart: 3 + 4 + 5 is never one second's; 2 + 3 + 4 and 4 + 5 are.
    expect(playRun(scripted(lobsAt({ 10: 1, 30: 2, 69: 3, 75: 4, 129: 5 }, 200)))).toEqual({
      bombs: 15,
      bombsPeak: 9,
    });
    // A run shorter than the window counts all its ticks.
    expect(playRun(scripted([1, 2, 3]))).toEqual({ bombs: 6, bombsPeak: 6 });
    expect(playRun(scripted([]))).toEqual({ bombs: 0, bombsPeak: 0 });
  });

  it('starts each run afresh: a window never spans two runs', () => {
    expect(playRun(scripted(lobsAt({ 99: 7 }, 100)))).toEqual({ bombs: 7, bombsPeak: 7 });
    expect(playRun(scripted(lobsAt({ 0: 7 }, 100)))).toEqual({ bombs: 7, bombsPeak: 7 });
    const result = runCharacterSession(config({ content: { fixture: 'B1' }, minutes: 2 }));
    expect(result.rows.length).toBeGreaterThan(1);
    expect(result.rows.some((row) => row.bombs > 0)).toBe(true);
    for (const row of result.rows) {
      expect(row.bombsPeak).toBeLessThanOrEqual(row.bombs);
      expect(row.bombsPeak > 0).toBe(row.bombs > 0);
    }
  });
});
