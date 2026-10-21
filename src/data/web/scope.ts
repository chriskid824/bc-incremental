/**
 * The web scopes and the batch counts (docs/v3 C6 design D16, §3.6). A scope selects the
 * characters and outers a web shows: FULL_SCOPE everything registered, the Demo 熔核 and 蜂巢 to
 * wave 40, or 熔核 and 霜晶 under the 10/28 fallback (D29); B2 picks the Demo's by VITE_FLAVOR.
 * An outer outside a scope is locked (「完整版」, gd:853).
 */

import type { CharacterId, OuterId } from '../sources';
import type { WebScope } from './types';

export const FULL_SCOPE: WebScope = {
  name: 'full',
  characters: 'all',
  outers: 'all',
  deferredFusions: [],
  waveCap: null,
};

export const DEMO_SCOPE_A: WebScope = {
  name: 'demoA',
  characters: ['fire', 'summon'],
  outers: ['fire', 'ice', 'poison', 'crit', 'summon'],
  deferredFusions: [],
  waveCap: 40,
};

export const DEMO_SCOPE_B: WebScope = {
  name: 'demoB',
  characters: ['fire', 'ice'],
  outers: ['fire', 'ice', 'poison', 'crit', 'lightning'],
  deferredFusions: [],
  waveCap: 40,
};

/** Every scope a web is assembled in; loadContent validates each that lists a built character. */
export const SCOPES: readonly WebScope[] = [FULL_SCOPE, DEMO_SCOPE_A, DEMO_SCOPE_B];

export type Batch = 'B1' | 'B2' | 'B3' | 'B4' | 'B5';
const BATCHES: readonly Batch[] = ['B1', 'B2', 'B3', 'B4', 'B5'];

/**
 * The assembled node total once each batch has landed, generated fusion nodes included (impl:281,
 * impl:600-604): B1 156 = 40 + 24 + 4 × 18 + 4 × 5, then +90, +159, +227 and +12. V14 checks it
 * whenever the registered blocks are a batch's (C6.5).
 */
export const BATCH_COUNTS: Readonly<Record<Batch, number>> = {
  B1: 156,
  B2: 246,
  B3: 405,
  B4: 632,
  B5: 644,
};

/** The blocks a batch registers: centers, the hub, outers, and the characters whose ascendancies it writes. */
export interface BatchBlocks {
  readonly centers: readonly CharacterId[];
  readonly hub: boolean;
  readonly outers: readonly OuterId[];
  readonly ascendancies: readonly CharacterId[];
}

/**
 * What each batch adds under the plan (impl:585-589) and under the 10/28 fallback (impl:270-279),
 * which counts the same (impl:281); src/data/web/testing.ts' variants follow the plan.
 */
export const BATCH_PLANS: readonly Readonly<Record<Batch, BatchBlocks>>[] = [
  {
    B1: {
      centers: ['fire'],
      hub: true,
      outers: ['ice', 'poison', 'crit', 'summon'],
      ascendancies: [],
    },
    B2: { centers: ['summon'], hub: false, outers: ['fire'], ascendancies: ['fire', 'summon'] },
    B3: {
      centers: ['ice'],
      hub: false,
      outers: ['lightning', 'bleed', 'barrage'],
      ascendancies: [],
    },
    B4: {
      centers: ['lightning'],
      hub: false,
      outers: ['combo', 'aura', 'greed', 'thorns'],
      ascendancies: [],
    },
    B5: { centers: [], hub: false, outers: [], ascendancies: ['ice', 'lightning'] },
  },
  {
    B1: {
      centers: ['fire'],
      hub: true,
      outers: ['ice', 'poison', 'crit', 'lightning'],
      ascendancies: [],
    },
    B2: { centers: ['ice'], hub: false, outers: ['fire'], ascendancies: ['fire', 'ice'] },
    B3: {
      centers: ['summon'],
      hub: false,
      outers: ['summon', 'bleed', 'barrage'],
      ascendancies: [],
    },
    B4: {
      centers: ['lightning'],
      hub: false,
      outers: ['combo', 'aura', 'greed', 'thorns'],
      ascendancies: [],
    },
    B5: { centers: [], hub: false, outers: [], ascendancies: ['summon', 'lightning'] },
  },
];

/**
 * The batch whose landing leaves exactly `registered` registered, under either plan; null for
 * any other set, which V14 then checks by gd §2.1's formula alone.
 */
export function batchOf(registered: BatchBlocks): Batch | null {
  const key = (blocks: BatchBlocks): string =>
    [blocks.centers, blocks.outers, blocks.ascendancies]
      .map((ids) => [...ids].sort().join(','))
      .concat(String(blocks.hub))
      .join('|');
  const wanted = key(registered);
  for (const plan of BATCH_PLANS) {
    const sum: {
      centers: CharacterId[];
      hub: boolean;
      outers: OuterId[];
      ascendancies: CharacterId[];
    } = { centers: [], hub: false, outers: [], ascendancies: [] };
    for (const batch of BATCHES) {
      const blocks = plan[batch];
      sum.centers.push(...blocks.centers);
      sum.hub ||= blocks.hub;
      sum.outers.push(...blocks.outers);
      sum.ascendancies.push(...blocks.ascendancies);
      if (key(sum) === wanted) return batch;
    }
  }
  return null;
}
