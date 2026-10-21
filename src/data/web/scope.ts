/**
 * The web scopes and the batch counts (docs/v3 C6 design D16, §3.6). A scope selects the
 * characters and outers a web shows: FULL_SCOPE everything registered, the Demo 熔核 and 蜂巢 to
 * wave 40, or 熔核 and 霜晶 under the 10/28 fallback (D29); B2 picks the Demo's by VITE_FLAVOR.
 * An outer outside a scope is locked (「完整版」, gd:853).
 */

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

export type Batch = 'B1' | 'B2' | 'B3' | 'B4' | 'B5';

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
