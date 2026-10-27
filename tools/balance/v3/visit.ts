/**
 * A menu visit of a character session (docs/v3 C10 design §1.3): what a strategy reads, and the
 * only way it buys, each purchase checked by canBuy first (src/meta/web/rules.ts); and greedy's
 * short probe runs from the next start wave, read at their fractional frontier with calibration's
 * bookkeeping (src/meta/web/calibrate.ts).
 */

import { deriveSeed } from '../../../src/core/rng';
import type { Rng } from '../../../src/core/rng';
import type { GameData } from '../../../src/data';
import type { AssembledWeb } from '../../../src/data/web';
import { buy, canBuy, webBuild, webRunConfig } from '../../../src/meta/web';
import type {
  AccountProgress,
  BuyCheck,
  CharacterProgress,
  WebEconomy,
  WebRun,
} from '../../../src/meta/web';
import { fateOf, frontierOf, isExtra } from '../../../src/meta/web/calibrate';
import type { EnemyFate, ProbeRun } from '../../../src/meta/web/calibrate';
import { createSimulation, NO_INPUT } from '../../../src/sim';
import type { EnemyState, RunConfig } from '../../../src/sim';
import type { TestModule } from '../../../src/sim/rules';
import { C10_SEED } from './content';
import { GREEDY_PROBE_TICKS, GREEDY_SEEDS } from './strategies';

export interface Visit {
  readonly web: AssembledWeb;
  readonly account: AccountProgress;
  readonly economy: WebEconomy;
  readonly data: GameData;
  /** The session's strategy stream, the same object every visit. */
  readonly rng: Rng;
  /** Play time at the end of the run before this visit. */
  readonly minutes: number;
  /** The progress with this visit's purchases so far. */
  progress(): CharacterProgress;
  /** canBuy on the progress now. */
  check(id: string): BuyCheck;
  /** canBuy, then buy; throws when canBuy refuses. */
  buy(id: string): void;
  /** Greedy's reading: the frontier x of `progress` on each GREEDY_SEEDS seed. */
  probe(progress: CharacterProgress): readonly number[];
}

/** A visit as the session holds it: also what it bought, in order, ranks by repetition. */
export interface OpenVisit extends Visit {
  readonly bought: readonly string[];
}

export interface VisitInput {
  readonly web: AssembledWeb;
  readonly account: AccountProgress;
  readonly economy: WebEconomy;
  readonly data: GameData;
  readonly rng: Rng;
  readonly minutes: number;
  readonly progress: CharacterProgress;
  readonly probe: (progress: CharacterProgress) => readonly number[];
}

/** Upper bound on purchases in one visit; prices grow, so reaching it means a bug (M1's bound). */
const MAX_PURCHASES_PER_VISIT = 10_000;

export function openVisit(input: VisitInput): OpenVisit {
  const { web, account, economy } = input;
  let current = input.progress;
  const bought: string[] = [];
  return {
    web,
    account,
    economy,
    data: input.data,
    rng: input.rng,
    minutes: input.minutes,
    progress: () => current,
    check: (id) => canBuy(web, current, account, id, economy),
    buy(id) {
      const check = canBuy(web, current, account, id, economy);
      if (!check.ok) throw new Error(`visit: '${id}' refused: ${check.reason}`);
      if (bought.length >= MAX_PURCHASES_PER_VISIT) {
        throw new Error(`visit: ${MAX_PURCHASES_PER_VISIT} purchases in one visit`);
      }
      current = buy(web, current, account, id, economy);
      bought.push(id);
    },
    probe: input.probe,
    bought,
  };
}

/** webRunConfig of a session's run or probe, capped at the scope's wave cap (a demo scope's 40). */
export const cappedRunConfig = (
  web: AssembledWeb,
  run: WebRun,
  seed: number,
  startWave: number,
): RunConfig => webRunConfig(run, seed, startWave, web.scope.waveCap ?? undefined);

/** The probe seeds of the visit after run `run` of session `session`: one per GREEDY_SEEDS. */
export function greedySeeds(session: number, run: number): number[] {
  return Array.from({ length: GREEDY_SEEDS }, (_, s) =>
    deriveSeed(C10_SEED, `greedy:${session}:${run}:${s}`),
  );
}

/**
 * probeRun's bookkeeping (src/meta/web/calibrate.ts) from `startWave` rather than wave 1: a watch
 * module records each kill as it happens, the enemies new at each tick's end are kept and the
 * playerHit events say which leaked (a bullet's bulletHit is no leak); an extra enemy (isExtra:
 * summons, onion bursts, the treasure) has no fate, and each fate is calibration's (fateOf: an
 * onion's shells counted). The waves below the start wave count as cleared, so a run
 * that clears nothing reads F = startWave − 1 where the run's highestWaveCleared says 0.
 */
export function probeFrom(
  web: AssembledWeb,
  progress: CharacterProgress,
  seed: number,
  data: GameData,
  startWave: number,
  maxTicks: number = GREEDY_PROBE_TICKS,
): ProbeRun {
  const killed = new Map<number, EnemyFate>();
  const watch: TestModule = (b) =>
    void b.hook('onKill', (_ctx, victim) => {
      if (!isExtra(victim)) killed.set(victim.id, fateOf(victim, 'killed', data));
    });
  const config = { ...cappedRunConfig(web, webBuild(web, progress), seed, startWave), maxTicks };
  const sim = createSimulation(config, data, [watch]);
  const { state } = sim;
  const seen = new Map<number, EnemyState>();
  const leaked = new Set<number>();
  let newest = 0;
  while (!state.finished) {
    for (const event of sim.step(NO_INPUT)) {
      if (event.type === 'playerHit') leaked.add(event.enemyId);
    }
    // state.enemies is in id order, so the enemies new since the last tick are its tail.
    const { enemies } = state;
    for (let k = enemies.length - 1; k >= 0; k--) {
      const enemy = enemies[k] as EnemyState;
      if (enemy.id <= newest) break;
      if (!isExtra(enemy)) seen.set(enemy.id, enemy);
    }
    newest = Math.max(newest, enemies[enemies.length - 1]?.id ?? 0);
  }
  const fates: EnemyFate[] = [];
  for (const [id, enemy] of seen) {
    if (!killed.has(id)) fates.push(fateOf(enemy, leaked.has(id) ? 'leaked' : 'alive', data));
  }
  fates.push(...killed.values());
  const result = sim.result();
  return {
    highestWaveCleared: Math.max(result.highestWaveCleared, startWave - 1),
    enemies: fates,
    ticks: result.ticks,
    timeout: result.endReason === 'timeout',
  };
}

/** The frontier x = F + φ (frontierOf) of a probe run of `progress` on each seed. */
export function probeFrontiers(
  web: AssembledWeb,
  progress: CharacterProgress,
  data: GameData,
  startWave: number,
  seeds: readonly number[],
): number[] {
  return seeds.map((seed) => frontierOf(probeFrom(web, progress, seed, data, startWave), data));
}
