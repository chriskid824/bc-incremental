/**
 * Fixed talent builds for the probes that measure a build rather than a whole session
 * (tools/balance/keystones.ts, tools/balance/startWaves.ts), and a single-run measurement.
 */

import type { GameData, TalentNode } from '../../src/data';
import { collectRules, createMetaState, statBlockFor } from '../../src/meta';
import type { MetaState } from '../../src/meta';
import { createSimulation, NO_INPUT } from '../../src/sim';
import type { EndReason } from '../../src/sim';

export const SECTORS = ['crit', 'dot', 'chain'] as const;
export type Sector = (typeof SECTORS)[number];

export const isSector = (value: string): value is Sector =>
  (SECTORS as readonly string[]).includes(value);

export interface SectorBuildOptions {
  /** Also allocate the sector's own keystone. */
  readonly keystone: boolean;
  /** Ranks on the repeatable node (Might). */
  readonly might: number;
  /** Extra node ids to allocate, e.g. a generic keystone. */
  readonly extra?: readonly string[];
}

const isRepeatable = (node: TalentNode): boolean => node.kind === 'repeatable';

/**
 * A full sector plus the generic nodes next to the start, as a player who finished their own
 * sector has it: every node of `sector` (its keystone only with `keystone`), every generic
 * small node (attack speed, life) and `might` ranks on the repeatable node. Generic keystones
 * (glassCannon) and bridge nodes only come in through `extra`. Adjacency is not checked.
 */
export function sectorBuild(
  data: GameData,
  sector: Sector,
  options: SectorBuildOptions,
): MetaState {
  const meta = createMetaState();
  for (const node of data.talents) {
    if (node.kind === 'start' || isRepeatable(node)) continue;
    const ownSector = node.archetype === sector && (node.kind !== 'keystone' || options.keystone);
    const generic = node.archetype === 'none' && node.kind === 'small';
    if (ownSector || generic || (options.extra?.includes(node.id) ?? false)) {
      meta.allocated.add(node.id);
    }
  }
  const repeatable = data.talents.find(isRepeatable);
  if (repeatable !== undefined && options.might > 0) {
    meta.allocated.add(repeatable.id);
    meta.ranks.set(repeatable.id, options.might);
  }
  return meta;
}

/** The keystone of a sector. Throws when the sector has none. */
export function sectorKeystone(data: GameData, sector: Sector): TalentNode {
  const node = data.talents.find((n) => n.archetype === sector && n.kind === 'keystone');
  if (node === undefined) throw new Error(`Sector ${sector} has no keystone`);
  return node;
}

export interface RunReach {
  /** Highest wave the run reached. */
  readonly wave: number;
  /** 'timeout' means the 3-minute limit stopped a build that was still alive. */
  readonly endReason: EndReason;
}

/** One full, uncapped run of the build from `startWave`. */
export function runFrom(
  meta: Readonly<MetaState>,
  data: GameData,
  startWave: number,
  seed: number,
): RunReach {
  const sim = createSimulation(
    {
      seed,
      stats: statBlockFor(meta, data),
      rules: collectRules(meta, data),
      startWave,
      mode: 'auto',
    },
    data,
  );
  while (!sim.state.finished) sim.step(NO_INPUT);
  const result = sim.result();
  return { wave: result.highestWaveReached, endReason: result.endReason };
}
