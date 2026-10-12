/**
 * Enemy definitions (docs/GDD.md §2.4). Colors avoid the effect palette reserved for the
 * archetypes (crit yellow/white, burn orange-red, chain cyan), so hits stay readable.
 */

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
  },
  /** Every bossEvery waves. */
  boss: {
    id: 'boss',
    shape: 'octagon',
    hpMult: 16,
    speed: 60,
    radius: 70,
    contactDamage: 100,
    dropMult: 16,
    cores: 3,
    color: 0xff3d8b,
  },
} satisfies Readonly<Record<EnemyId, EnemyDef>>;
