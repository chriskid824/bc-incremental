/**
 * 滑過節點顯示 DPS 變化 (docs/v3/game-design-v3.md §8 item 7: 「對一般怪 1.2K → 1.9K、對 Boss 8K →
 * 9K」): a build's damage a second in two short probe runs of the simulator, so a node's preview
 * is the same sim the run is, whatever the node does. Each probe is DPS_PROBE_SECONDS of a run
 * from wave 1 on a fixed seed against enemies that cannot die and deal no contact damage: 一般怪
 * a crowd of DPS_PROBE_CROWD squares walking in, Boss the onion alone. The damage is every
 * source's (RunResult.damageBySource), over the seconds from the first hit (or pulse) on. A preview is a comparison, not
 * a promise: the probes start from wave 1 and nothing dies, so kill triggers stay quiet.
 */

import { add, div, num, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { EnemyDef, EnemyId, GameData } from '../../data/types';
import type { AssembledWeb } from '../../data/web/types';
import { createSimulation } from '../../sim/simulation';
import { NO_INPUT, TICK_RATE } from '../../sim/types';
import { webBuild, webRunConfig } from './build';
import type { CharacterProgress } from './types';

export const DPS_PROBE_SECONDS = 10;
export const DPS_PROBE_CROWD = 10;
export const DPS_PROBE_SEED = 7;
/** An HP multiplier no probe gets through. */
const IMMORTAL = 1e15;

export type DpsTarget = 'crowd' | 'boss';

export interface DpsReading {
  readonly crowd: Num;
  readonly boss: Num;
}

const immortal = (def: EnemyDef): EnemyDef => ({
  ...def,
  hpMult: def.hpMult * IMMORTAL,
  contactDamage: 0,
});

const cache = new WeakMap<GameData, Readonly<Record<DpsTarget, GameData>>>();

/** The two probes' game data from the run's: the same enemies, one wave of each target. */
export function probeData(data: GameData): Readonly<Record<DpsTarget, GameData>> {
  const hit = cache.get(data);
  if (hit !== undefined) return hit;
  const enemies = { ...data.enemies } as Record<EnemyId, EnemyDef>;
  enemies.square = immortal(enemies.square);
  enemies.onion = immortal(enemies.onion);
  const once = { eliteEvery: 1e6, spawnDurationSec: 0, waveTimerSec: 1e6 };
  const v3 =
    data.waves.v3 === undefined
      ? {}
      : { v3: { ...data.waves.v3, bossRotation: ['onion'] as EnemyId[] } };
  const probes = {
    crowd: {
      ...data,
      enemies,
      waves: {
        ...once,
        bossEvery: 1e6,
        rules: [
          {
            enemy: 'square',
            fromWave: 1,
            base: DPS_PROBE_CROWD,
            perWave: 0,
            maxCount: DPS_PROBE_CROWD,
          },
        ],
        ...v3,
      },
    },
    boss: { ...data, enemies, waves: { ...once, bossEvery: 1, rules: [], ...v3 } },
  } satisfies Record<DpsTarget, GameData>;
  cache.set(data, probes);
  return probes;
}

/** The build's damage a second against one probe's target. */
export function probeDps(
  web: AssembledWeb,
  progress: CharacterProgress,
  data: GameData,
  target: DpsTarget,
): Num {
  const ticks = DPS_PROBE_SECONDS * TICK_RATE;
  const config = {
    ...webRunConfig(webBuild(web, progress), DPS_PROBE_SEED, 1),
    maxTicks: ticks,
  };
  const sim = createSimulation(config, probeData(data)[target]);
  // The clock starts at the first hit, so the walk in does not water the reading down.
  let first: number | null = null;
  while (!sim.state.finished) {
    const events = sim.step(NO_INPUT);
    if (first === null && events.some((e) => e.type === 'hit' || e.type === 'pulse')) {
      first = sim.state.tick - 1;
    }
  }
  if (first === null) return ZERO;
  let total = ZERO;
  for (const value of Object.values(sim.result().damageBySource)) total = add(total, value);
  return div(total, num((sim.state.tick - first) / TICK_RATE));
}

export function readDps(
  web: AssembledWeb,
  progress: CharacterProgress,
  data: GameData,
): DpsReading {
  return {
    crowd: probeDps(web, progress, data, 'crowd'),
    boss: probeDps(web, progress, data, 'boss'),
  };
}

/** `progress` with one more rank of each of `ids`, unchecked: what the preview reads after. */
export function withRanks(progress: CharacterProgress, ids: readonly string[]): CharacterProgress {
  const ranks = { ...progress.ranks };
  for (const id of ids) ranks[id] = (ranks[id] ?? 0) + 1;
  return { ...progress, ranks };
}
