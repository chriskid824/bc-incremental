/**
 * Balance probe (docs/GDD.md §7.5, §9.1): runs whole sessions for several seeds and prints
 * what the cli.ts summary leaves out, pooled over the seeds: frontier medians, archetype
 * parity, first notable and keystone times, the first repeatable (Might) rank, elite and
 * boss kill rates near the frontier, Might vs sector multipliers at 30 minutes and overkill,
 * then pass/FAIL for each round-2 target (probeChecks).
 *
 *   npx tsx tools/balance/probe.ts [--seeds 1,2,3] [--sessions 12] [--minutes 60]
 *     [--strategy crit-greedy,dot-greedy,chain-greedy | all] [--workers 4]
 */

import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_ECONOMY } from '../../src/meta';
import { runSessions } from './pool';
import { formatTable, minutesToWave, MULTIPLIER_MINUTES, rowAt } from './report';
import type { RunRow, SessionConfig, SessionResult, ToughTarget } from './session';
import { isStrategyId, STRATEGY_IDS } from './strategies';
import type { StrategyId } from './strategies';

/** The pure archetype strategies whose time-to-wave should match (docs/GDD.md §7.5). */
export const PURE_STRATEGIES: readonly StrategyId[] = ['crit-greedy', 'dot-greedy', 'chain-greedy'];
const FRONTIER_MINUTES = [10, 20, 40, 60] as const;
const PARITY_WAVES = [20, 30] as const;
/** Elites and bosses of waves within this many waves of the run's frontier count as near. */
export const NEAR_FRONTIER_WAVES = 3;
const OVERKILL_LIMIT = 0.3;

/** Median that keeps ∞ (quantile would turn ∞ × 0 into NaN); NaN for no values. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}

const show = (value: number, digits = 1): string =>
  Number.isFinite(value) ? String(Number(value.toFixed(digits))) : '-';
const ratio = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : '-');
const pct = (part: number, whole: number): string =>
  whole > 0 ? `${Math.round((100 * part) / whole)}% (${part}/${whole})` : '-';

/**
 * Elites and bosses near the run's frontier, by outcome. Two rates come from it: killed ÷
 * (killed + reached the player), which T7 checks because a tough enemy that reaches the player
 * is what the target is about, and killed ÷ all of them, which also counts the ones still alive
 * when the swarm ended the run.
 */
export interface NearFrontierRate {
  readonly killed: number;
  readonly reached: number;
  /** Still alive when the run ended (usually the swarm killed the player first). */
  readonly alive: number;
  readonly killSeconds: readonly number[];
}

export function nearFrontierRate(
  targets: readonly ToughTarget[],
  enemy: ToughTarget['enemy'],
): NearFrontierRate {
  let killed = 0;
  let reached = 0;
  let alive = 0;
  const killSeconds: number[] = [];
  for (const target of targets) {
    if (target.enemy !== enemy) continue;
    if (Math.abs(target.wave - Math.max(1, target.frontier)) > NEAR_FRONTIER_WAVES) continue;
    if (target.outcome === 'killed') {
      killed++;
      if (target.killSeconds !== null) killSeconds.push(target.killSeconds);
    } else if (target.outcome === 'reached') {
      reached++;
    } else {
      alive++;
    }
  }
  return { killed, reached, alive, killSeconds };
}

/** 1-based run after which the first repeatable rank was bought, or null. */
export function firstRepeatableRun(result: SessionResult, repeatableIds: ReadonlySet<string>) {
  for (const row of result.rows) {
    const ids = row.bought.split(' ').map((part) => part.split('×')[0] ?? '');
    if (ids.some((id) => repeatableIds.has(id))) return row.run;
  }
  return null;
}

/** Median over sessions of minutes to reach `wave`; sessions that never do count as ∞. */
export function medianMinutesToWave(sessions: readonly SessionResult[], wave: number): number {
  return median(sessions.map((result) => minutesToWave(result, wave) ?? Infinity));
}

/** max ÷ min of the given medians; NaN when any is not finite. */
export function spread(values: readonly number[]): number {
  if (values.length === 0 || !values.every(Number.isFinite)) return NaN;
  return Math.max(...values) / Math.min(...values);
}

function frontierAt(sessions: readonly SessionResult[], minutes: number): number {
  const waves: number[] = [];
  for (const result of sessions) {
    const row = rowAt(result, minutes);
    if (row) waves.push(row.maxWave);
  }
  return median(waves);
}

/** All probe tables for results grouped by seed. */
export function probeReport(
  bySeed: ReadonlyMap<number, readonly SessionResult[]>,
  strategies: readonly StrategyId[],
  repeatableIds: ReadonlySet<string>,
): string {
  const seeds = [...bySeed.keys()];
  const all = [...bySeed.values()].flat();
  const of = (results: readonly SessionResult[], strategy: StrategyId): SessionResult[] =>
    results.filter((result) => result.strategy === strategy);
  const out: string[] = [];

  // Frontier medians, pooled over every seed's sessions; per-seed medians in brackets.
  const frontier: string[][] = [['strategy', ...FRONTIER_MINUTES.map((m) => `F@${m}`)]];
  for (const strategy of strategies) {
    frontier.push([
      strategy,
      ...FRONTIER_MINUTES.map((minutes) => {
        const perSeed = seeds.map((seed) =>
          show(frontierAt(of(bySeed.get(seed) ?? [], strategy), minutes)),
        );
        const pooled = show(frontierAt(of(all, strategy), minutes));
        return seeds.length > 1 ? `${pooled} (${perSeed.join('/')})` : pooled;
      }),
    ]);
  }
  out.push('Frontier (median maxWave, pooled over seeds; per seed in brackets)');
  out.push(formatTable(frontier));

  // Time to wave N and the parity of the pure archetypes.
  const pure = strategies.filter((strategy) => PURE_STRATEGIES.includes(strategy));
  const parity: string[][] = [['minutes to wave', ...strategies, 'pure max÷min']];
  for (const wave of PARITY_WAVES) {
    const pooled = strategies.map((strategy) => medianMinutesToWave(of(all, strategy), wave));
    const pureSpread = spread(pure.map((s) => medianMinutesToWave(of(all, s), wave)));
    parity.push([`${wave} pooled`, ...pooled.map((value) => show(value)), ratio(pureSpread)]);
    if (seeds.length > 1) {
      for (const seed of seeds) {
        const results = bySeed.get(seed) ?? [];
        const values = strategies.map((strategy) =>
          medianMinutesToWave(of(results, strategy), wave),
        );
        const seedSpread = spread(pure.map((s) => medianMinutesToWave(of(results, s), wave)));
        parity.push([`${wave} seed ${seed}`, ...values.map((v) => show(v)), ratio(seedSpread)]);
      }
    }
  }
  out.push('', 'Time to wave (median minutes; sessions that never get there count as ∞)');
  out.push(formatTable(parity));

  // Purchases: first notable, first keystone, first repeatable rank.
  const buys: string[][] = [
    ['strategy', 'first notable (min)', 'first keystone (min)', 'first repeatable (run)'],
  ];
  for (const strategy of strategies) {
    const sessions = of(all, strategy);
    const minutes = (pick: (result: SessionResult) => number | null): string =>
      show(median(sessions.map((result) => pick(result) ?? Infinity)));
    buys.push([
      strategy,
      minutes((result) => result.firstNotableMinutes),
      minutes((result) => result.firstKeystoneMinutes),
      show(median(sessions.map((r) => firstRepeatableRun(r, repeatableIds) ?? Infinity)), 0),
    ]);
  }
  out.push('', 'First purchases (median over sessions; never = ∞)');
  out.push(formatTable(buys));

  // Elites and bosses near the frontier.
  const tough: string[][] = [
    [
      'strategy',
      'elites killed',
      'bosses killed',
      'elites of all',
      'bosses of all',
      'boss kill s',
      'alive at end e/b',
    ],
  ];
  for (const strategy of strategies) {
    const targets = of(all, strategy).flatMap((result) => result.toughTargets ?? []);
    const elites = nearFrontierRate(targets, 'hexagon');
    const bosses = nearFrontierRate(targets, 'boss');
    tough.push([
      strategy,
      pct(elites.killed, elites.killed + elites.reached),
      pct(bosses.killed, bosses.killed + bosses.reached),
      pct(elites.killed, elites.killed + elites.reached + elites.alive),
      pct(bosses.killed, bosses.killed + bosses.reached + bosses.alive),
      show(median(bosses.killSeconds)),
      `${elites.alive}/${bosses.alive}`,
    ]);
  }
  out.push(
    '',
    `Elites and bosses within ±${NEAR_FRONTIER_WAVES} waves of the run's frontier ` +
      '(maxWave when the run started). "killed": killed ÷ (killed + reached the player); ' +
      '"of all" also counts the ones still alive at run end',
  );
  out.push(formatTable(tough));

  // Might vs sector nodes at 30 minutes, medians over the builds playing then.
  const mults: string[][] = [
    [
      `@${MULTIPLIER_MINUTES}m`,
      'ranks',
      'Might× D',
      'sector× D',
      'sector× attack',
      'sector× crowd',
    ],
  ];
  for (const strategy of strategies) {
    const rows: RunRow[] = [];
    for (const result of of(all, strategy)) {
      const row = rowAt(result, MULTIPLIER_MINUTES);
      if (row) rows.push(row);
    }
    const med = (pick: (row: RunRow) => number): string => ratio(median(rows.map(pick)));
    mults.push([
      strategy,
      show(median(rows.map((row) => row.repeatableRanks))),
      med((row) => row.repeatableMultD),
      med((row) => row.sectorMultD),
      med((row) => row.sectorMultAttack),
      med((row) => row.sectorMultCrowd),
    ]);
  }
  out.push('', 'Might vs sector nodes (attack = one projectile with its chain jumps)');
  out.push(formatTable(mults));

  // Overkill (docs/GDD.md §2.2).
  const overkill: string[][] = [['strategy', 'max run share', 'runs >30%']];
  for (const strategy of strategies) {
    const rows = of(all, strategy).flatMap((result) => result.rows);
    const shares = rows.map((row) => row.overkillShare);
    overkill.push([
      strategy,
      `${show(100 * Math.max(0, ...shares))}%`,
      pct(shares.filter((share) => share > OVERKILL_LIMIT).length, rows.length),
    ]);
  }
  out.push('', 'Overkill time share per run');
  out.push(formatTable(overkill));
  return out.join('\n');
}

/** One acceptance check of docs/GDD.md §7.5 as the probe measures it. */
export interface ProbeCheck {
  /** T1–T8 as in the round-2 notes (docs/GDD.md §9.1); 'info' checks never fail the run. */
  readonly id: string;
  readonly label: string;
  /** Measured values, formatted. */
  readonly value: string;
  readonly pass: boolean;
}

const within = (value: number, low: number, high: number): boolean =>
  Number.isFinite(value) && value >= low && value <= high;

/**
 * The round-2 targets (docs/GDD.md §7.5, §9.1) checked on probe results. Only checks whose
 * strategies were run are returned: frontier, parity and purchases need the three pure
 * strategies, T3 needs balanced and cheapest, T5 needs might-only. Bench time (T8) is
 * measured by `npm run bench`, not here.
 */
export function probeChecks(
  bySeed: ReadonlyMap<number, readonly SessionResult[]>,
  strategies: readonly StrategyId[],
  repeatableIds: ReadonlySet<string>,
): ProbeCheck[] {
  const seeds = [...bySeed.keys()];
  const all = [...bySeed.values()].flat();
  const of = (results: readonly SessionResult[], strategy: StrategyId): SessionResult[] =>
    results.filter((result) => result.strategy === strategy);
  const pure = PURE_STRATEGIES.filter((strategy) => strategies.includes(strategy));
  const checks: ProbeCheck[] = [];
  const add = (id: string, label: string, values: readonly number[], pass: boolean): void => {
    checks.push({ id, label, value: values.map((value) => show(value)).join(' / '), pass });
  };
  if (pure.length === PURE_STRATEGIES.length) {
    const frontier = (minutes: number): number[] =>
      pure.map((strategy) => frontierAt(of(all, strategy), minutes));
    const f60 = frontier(60);
    add(
      'T1',
      'pure F@60 in 34–46',
      f60,
      f60.every((v) => within(v, 34, 46)),
    );

    for (const wave of PARITY_WAVES) {
      const pooled = spread(pure.map((s) => medianMinutesToWave(of(all, s), wave)));
      const perSeed = seeds.map((seed) =>
        spread(pure.map((s) => medianMinutesToWave(of(bySeed.get(seed) ?? [], s), wave))),
      );
      checks.push({
        id: 'T2',
        label: `parity to wave ${wave}: pooled ≤ 1.20, each seed ≤ 1.25`,
        value: `${ratio(pooled)} (${perSeed.map(ratio).join('/')})`,
        pass: pooled <= 1.2 && perSeed.every((value) => value <= 1.25),
      });
    }

    for (const [minutes, low, high] of [
      [10, 13, 17.5],
      [20, 19, 25.5],
      [40, 25.5, 34.5],
    ] as const) {
      const values = frontier(minutes);
      const perSeed = seeds.flatMap((seed) =>
        pure.map((strategy) => frontierAt(of(bySeed.get(seed) ?? [], strategy), minutes)),
      );
      checks.push({
        id: 'T4',
        label: `pure F@${minutes} in ${low}–${high} (pooled)`,
        value:
          `${values.map((v) => show(v)).join(' / ')} ` +
          `(${perSeed.every((v) => within(v, low, high)) ? 'all seeds in' : 'a seed out'})`,
        pass: values.every((v) => within(v, low, high)),
      });
    }
    const purchase = (pick: (result: SessionResult) => number | null): number[] =>
      pure.map((strategy) => median(of(all, strategy).map((r) => pick(r) ?? Infinity)));
    const notable = purchase((r) => r.firstNotableMinutes);
    add(
      'T4',
      'pure first notable ≥ 3 min',
      notable,
      notable.every((v) => v >= 3),
    );
    const keystone = purchase((r) => r.firstKeystoneMinutes);
    add(
      'T4',
      'pure first keystone 10–25 min',
      keystone,
      keystone.every((v) => within(v, 10, 25)),
    );

    if (strategies.includes('balanced') && strategies.includes('cheapest')) {
      const balanced = frontierAt(of(all, 'balanced'), 60);
      const cheapest = frontierAt(of(all, 'cheapest'), 60);
      const slowest = Math.min(...f60);
      add(
        'T3',
        `balanced F@60 ≥ 34 and ≥ 0.9 × slowest pure (${show(0.9 * slowest)}); cheapest ≥ 26`,
        [balanced, cheapest],
        balanced >= 34 && balanced >= 0.9 * slowest && cheapest >= 26,
      );
    }
    if (strategies.includes('might-only')) {
      const might = frontierAt(of(all, 'might-only'), 60);
      const firstRank = median(
        of(all, 'might-only').map((r) => firstRepeatableRun(r, repeatableIds) ?? Infinity),
      );
      add(
        'T5',
        `might-only F@60 ≤ 0.8 × slowest pure (${show(0.8 * Math.min(...f60))}); first rank ≤ run 3`,
        [might, firstRank],
        might <= 0.8 * Math.min(...f60) && firstRank <= 3,
      );
    }

    const sectorOverMight = pure.map((strategy) => {
      const rows = of(all, strategy)
        .map((result) => rowAt(result, MULTIPLIER_MINUTES))
        .filter((row): row is RunRow => row !== null);
      // Chain sector power is in the jumps, which D leaves out (docs/GDD.md §3.4).
      const sector = median(
        rows.map((row) => (strategy === 'chain-greedy' ? row.sectorMultAttack : row.sectorMultD)),
      );
      return sector / median(rows.map((row) => row.repeatableMultD));
    });
    checks.push({
      id: 'T6',
      label: `sector× ÷ Might× at ${MULTIPLIER_MINUTES} min > 1 (chain: with jumps)`,
      value: sectorOverMight.map(ratio).join(' / '),
      pass: sectorOverMight.every((value) => value > 1),
    });

    const rates = pure.map((strategy) => {
      const targets = of(all, strategy).flatMap((result) => result.toughTargets ?? []);
      const share = (rate: NearFrontierRate): number =>
        rate.killed + rate.reached > 0 ? rate.killed / (rate.killed + rate.reached) : NaN;
      const bosses = nearFrontierRate(targets, 'boss');
      return {
        elites: share(nearFrontierRate(targets, 'hexagon')),
        bosses: share(bosses),
        bossSeconds: median(bosses.killSeconds),
      };
    });
    checks.push({
      id: 'T7',
      label: `elites / bosses near the frontier killed ≥ 50% of those killed or reaching you`,
      value: rates.map((r) => `${pctOf(r.elites)}/${pctOf(r.bosses)}`).join(' · '),
      pass: rates.every((r) => r.elites >= 0.5 && r.bosses >= 0.5),
    });
    add(
      'info',
      'boss kill time near the frontier 8–15 s (GDD §7.5)',
      rates.map((r) => r.bossSeconds),
      rates.every((r) => within(r.bossSeconds, 8, 15)),
    );
  }

  const shares = strategies.flatMap((strategy) =>
    of(all, strategy).flatMap((result) => result.rows.map((row) => row.overkillShare)),
  );
  const worst = Math.max(0, ...shares);
  checks.push({
    id: 'T8',
    label: `overkill time share per run ≤ ${100 * OVERKILL_LIMIT}% (bench: npm run bench)`,
    value: `max ${show(100 * worst)}%`,
    pass: worst <= OVERKILL_LIMIT,
  });
  return checks;
}

const pctOf = (share: number): string =>
  Number.isFinite(share) ? `${Math.round(100 * share)}%` : '-';

export function formatChecks(checks: readonly ProbeCheck[]): string {
  return formatTable([
    ['check', 'target', 'measured', 'result'],
    ...checks.map((check) => [
      check.id,
      check.label,
      check.value,
      check.id === 'info' ? (check.pass ? 'in' : 'out') : check.pass ? 'pass' : 'FAIL',
    ]),
  ]);
}

function parseList(name: string, text: string): number[] {
  const values = text.split(',').map((part) => Number(part.trim()));
  if (values.length === 0 || !values.every(Number.isInteger)) {
    throw new Error(`--${name} must be a comma-separated list of integers, got '${text}'`);
  }
  return values;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      seeds: { type: 'string', default: '1,2,3' },
      sessions: { type: 'string', default: '12' },
      minutes: { type: 'string', default: '60' },
      strategy: { type: 'string', default: PURE_STRATEGIES.join(',') },
      workers: { type: 'string' },
    },
  });
  const seeds = parseList('seeds', values.seeds);
  const [sessions = 12] = parseList('sessions', values.sessions);
  const minutes = Number(values.minutes);
  const strategies: StrategyId[] =
    values.strategy === 'all'
      ? [...STRATEGY_IDS]
      : values.strategy.split(',').map((id) => {
          if (!isStrategyId(id)) throw new Error(`Unknown strategy '${id}'`);
          return id;
        });
  const workers =
    values.workers === undefined
      ? Math.max(1, Math.min(4, availableParallelism()))
      : (parseList('workers', values.workers)[0] ?? 1);

  const configs: SessionConfig[] = [];
  for (const seed of seeds) {
    for (const strategy of strategies) {
      for (let session = 0; session < sessions; session++) {
        configs.push({
          strategy,
          session,
          seed,
          minutes,
          startWave: { kind: 'max' },
          economy: DEFAULT_ECONOMY,
          menuSeconds: 20,
          waveCap: null,
          trackToughTargets: true,
        });
      }
    }
  }
  const started = performance.now();
  const pool = await runSessions(configs, workers, (message) => console.warn(message));
  const bySeed = new Map<number, SessionResult[]>();
  pool.results.forEach((result, i) => {
    const seed = configs[i]?.seed ?? 0;
    bySeed.set(seed, [...(bySeed.get(seed) ?? []), result]);
  });
  const { loadGameData } = await import('../../src/data');
  const repeatableIds = new Set(
    loadGameData()
      .talents.filter((node) => node.kind === 'repeatable')
      .map((node) => node.id),
  );
  console.log(
    `Probe: seeds ${seeds.join(',')} × ${sessions} sessions × ${minutes} min, ` +
      `${strategies.join(', ')}\n`,
  );
  console.log(probeReport(bySeed, strategies, repeatableIds));
  console.log('\nTargets (round 2, docs/GDD.md §7.5, §9.1)');
  console.log(formatChecks(probeChecks(bySeed, strategies, repeatableIds)));
  console.log(`\nWall time ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
