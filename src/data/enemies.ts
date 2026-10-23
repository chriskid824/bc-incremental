/**
 * Enemy definitions (docs/GDD.md §2.4). Colors avoid the effect palette reserved for the
 * archetypes (crit yellow/white, burn orange-red, chain cyan), so hits stay readable. M1's six
 * types come first; the v3 types (src/data/enemiesV3.ts) follow, since the data's record covers
 * every EnemyId, but only v3 waves (src/data/wavesV3.ts) spawn them.
 */

import { V3_ENEMIES } from './enemiesV3';
import type { EnemyDef, EnemyId } from './types';

export const ENEMIES = {
  triangle: {
    id: 'triangle',
    shape: 'triangle',
    hpMult: 0.5,
    speed: 160,
    radius: 16,
    contactDamage: 2,
    dropMult: 0.5,
    cores: 0,
    color: 0xff4fd8,
    tough: false,
    boss: false,
  },
  square: {
    id: 'square',
    shape: 'square',
    hpMult: 1,
    speed: 110,
    radius: 20,
    contactDamage: 4,
    dropMult: 1,
    cores: 0,
    color: 0x5b6cff,
    tough: false,
    boss: false,
  },
  pentagon: {
    id: 'pentagon',
    shape: 'pentagon',
    hpMult: 1,
    speed: 150,
    radius: 22,
    contactDamage: 3,
    dropMult: 1,
    cores: 0,
    splitInto: { enemy: 'shard', count: 3 },
    color: 0x3fe07a,
    tough: false,
    boss: false,
  },
  /** Small triangle a pentagon splits into. */
  shard: {
    id: 'shard',
    shape: 'triangle',
    hpMult: 0.25,
    speed: 200,
    radius: 10,
    contactDamage: 1,
    dropMult: 0.25,
    cores: 0,
    color: 0xa6f7bf,
    tough: false,
    boss: false,
  },
  /** Elite, every eliteEvery waves. */
  hexagon: {
    id: 'hexagon',
    shape: 'hexagon',
    hpMult: 14,
    speed: 90,
    radius: 34,
    contactDamage: 30,
    dropMult: 14,
    cores: 1,
    color: 0xa45cff,
    tough: true,
    boss: false,
  },
  /** Every bossEvery waves of an M1 run; a v3 run's boss waves take its bossRotation. */
  boss: {
    id: 'boss',
    shape: 'octagon',
    hpMult: 28,
    speed: 45,
    radius: 70,
    contactDamage: 100,
    dropMult: 16,
    cores: 3,
    color: 0xff3d8b,
    tough: true,
    boss: true,
  },
  ...V3_ENEMIES,
} satisfies Readonly<Record<EnemyId, EnemyDef>>;
