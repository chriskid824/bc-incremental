/**
 * The kill explosion's tier (Bursts.kill), read from the def's flags (docs/v3 C7 design §1.2): a
 * boss explodes as a boss, any other tough type as an elite, the rest as normal enemies. So 洋蔥
 * explodes as M1's octagon does and the v3 types as M1's small ones. DOM-free, so the tests pin it
 * on every type (C7.1's hand-off to C7.8).
 */

import type { EnemyDef } from '../data/types';

/** Enemy tier for kill explosions. */
export const TIER_NORMAL = 0;
export const TIER_ELITE = 1;
export const TIER_BOSS = 2;

/** TIER_BOSS for a boss def, TIER_ELITE for any other tough def, else TIER_NORMAL. */
export function killTier(def: Pick<EnemyDef, 'tough' | 'boss'>): number {
  return def.boss ? TIER_BOSS : def.tough ? TIER_ELITE : TIER_NORMAL;
}
