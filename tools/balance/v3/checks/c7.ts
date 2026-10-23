/**
 * Which C7 parts are live (docs/v3 C10 design §2.3, "C7 parts live"): probed on one spawned
 * enemy's v3 view and one RunResult, each field read structurally with `in`, never by a name a C7
 * commit adds, so the tools compile in either landing order. The report header lists them; C10.3's
 * checks name a part still pending in their c7Pending columns.
 */

import { characterGameData } from '../../../../src/data';
import { emptyProgress, webBuild } from '../../../../src/meta/web';
import { createSimulation, NO_INPUT } from '../../../../src/sim';
import { C10_SEED, webOf } from '../content';
import { GREEDY_PROBE_TICKS } from '../strategies';
import { cappedRunConfig } from '../visit';

/** The C7 parts the probe reads, each where it shows: an enemy's v3 view, the result or its counters. */
export const C7_PARTS = [
  { part: 'C7.3', on: 'enemy', fields: ['defence'] },
  { part: 'C7.4a', on: 'enemy', fields: ['state'] },
  { part: 'C7.4b', on: 'result', fields: ['bulletTakenBy'] },
  { part: 'C7.5', on: 'counters', fields: ['enemyCapDelayed', 'enemySpawnsSkipped'] },
  { part: 'C7.6', on: 'enemy', fields: ['affixes'] },
  { part: 'C7.7', on: 'enemy', fields: ['layersLeft'] },
] as const;
export type C7Part = (typeof C7_PARTS)[number]['part'];
export type C7Parts = Readonly<Record<C7Part, boolean>>;

/** Whether `value` is an object holding `key`, whatever its value. */
const holds = (value: unknown, key: string): boolean =>
  typeof value === 'object' && value !== null && key in value;

/** The C7 parts an enemy's v3 view and a run's result show: a part is live when it has every field. */
export function c7PartsOf(view: unknown, result: unknown): C7Parts {
  const counters = holds(result, 'counters')
    ? (result as { readonly counters: unknown }).counters
    : null;
  const where = { enemy: view, result, counters };
  const parts = {} as Record<C7Part, boolean>;
  for (const { part, on, fields } of C7_PARTS) {
    parts[part] = fields.every((field) => holds(where[on], field));
  }
  return parts;
}

let probed: C7Parts | null = null;

/**
 * The live probe: one v3 run of the B1 fixture's 熔核 web from empty progress, from wave 1, to
 * its end or GREEDY_PROBE_TICKS; the first enemy that spawns gives the v3 view. The parts are the
 * engine's, so the fixture serves whatever content the checks run on. Made once per process.
 */
export function probeC7Parts(): C7Parts {
  if (probed !== null) return probed;
  const web = webOf({ fixture: 'B1' }, 'fire', 'full');
  const config = {
    ...cappedRunConfig(web, webBuild(web, emptyProgress('fire')), C10_SEED, 1),
    maxTicks: GREEDY_PROBE_TICKS,
  };
  const sim = createSimulation(config, characterGameData());
  let view: unknown = null;
  while (!sim.state.finished) {
    sim.step(NO_INPUT);
    view ??= sim.state.enemies[0]?.v3 ?? null;
  }
  probed = c7PartsOf(view, sim.result());
  return probed;
}

/** The header's line: the live parts, then the pending ones, each with its fields. */
export function formatC7Parts(parts: C7Parts): string {
  const list = (live: boolean): string =>
    C7_PARTS.filter(({ part }) => parts[part] === live)
      .map(({ part, fields }) => `${part} (${fields.join(', ')})`)
      .join(', ') || 'none';
  return `live: ${list(true)}; pending: ${list(false)}`;
}
