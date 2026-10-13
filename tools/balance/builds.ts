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

/**
 * Breadth-first search over talent links from `from` (in link order, so ties go to the
 * first-listed link). Returns each reached node's predecessor; the `from` nodes map to null.
 */
function searchFrom(data: GameData, from: readonly string[]): Map<string, string | null> {
  const byId = new Map(data.talents.map((node) => [node.id, node]));
  const previous = new Map<string, string | null>(from.map((id) => [id, null]));
  const queue = [...from];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    for (const next of byId.get(id)?.links ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, id);
      queue.push(next);
    }
  }
  return previous;
}

/**
 * The sector's spine up to and including its first notable, i.e. what a player of that
 * archetype buys first (keenEye, sharpen, quickDraw, precision for crit): every sector node no
 * farther from the start than the sector's nearest notable.
 */
export function sectorSpine(data: GameData, sector: Sector): string[] {
  const start = data.talents.find((node) => node.kind === 'start');
  if (start === undefined) throw new Error('The talent web has no start node');
  const previous = searchFrom(data, [start.id]);
  const depth = (id: string): number => {
    let steps = 0;
    for (let at = previous.get(id); at !== null && at !== undefined; at = previous.get(at)) {
      steps++;
    }
    return previous.has(id) ? steps : Infinity;
  };
  const own = data.talents.filter((node) => node.archetype === sector);
  const notable = Math.min(...own.filter((n) => n.kind === 'notable').map((n) => depth(n.id)));
  return own.filter((n) => n.kind !== 'keystone' && depth(n.id) <= notable).map((n) => n.id);
}

/** Node ids on a shortest link path from any of `from` to `to`, `to` included, `from` not. */
export function shortestPath(data: GameData, from: readonly string[], to: string): string[] {
  const previous = searchFrom(data, from);
  if (!previous.has(to)) throw new Error(`No path to ${to}`);
  const path: string[] = [];
  let at: string | null | undefined = to;
  while (at !== null && at !== undefined && !from.includes(at)) {
    path.unshift(at);
    at = previous.get(at);
  }
  return path;
}

/**
 * A player of `sector` who buys the sector's spine (sectorSpine) and then the shortest path
 * into `keystone`, usually another sector's keystone, with the generic small nodes and `might`
 * ranks as in sectorBuild. About as many nodes as the full sector plus its own keystone.
 */
export function beelineBuild(
  data: GameData,
  sector: Sector,
  keystone: string,
  might: number,
): MetaState {
  const meta = sectorBuild(data, sector, { keystone: false, might });
  for (const node of data.talents) {
    if (node.archetype === sector) meta.allocated.delete(node.id);
  }
  const spine = sectorSpine(data, sector);
  for (const id of [...spine, ...shortestPath(data, spine, keystone)]) {
    // The start node is always owned; a path may run through it.
    if (data.talents.find((node) => node.id === id)?.kind !== 'start') meta.allocated.add(id);
  }
  return meta;
}

/** Talent nodes a build allocated, repeatable ranks not counted. */
export function allocatedNodes(meta: Readonly<MetaState>, data: GameData): number {
  return data.talents.filter((node) => !isRepeatable(node) && meta.allocated.has(node.id)).length;
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
