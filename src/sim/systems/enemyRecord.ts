/**
 * The per-enemy v3 record (docs/v3 C7 design §1.3, C7/F6): Enemy.v3. addEnemy creates one for
 * every enemy of a v3 run (ctx.sys.enemyAi.enabled), M1 types included; every enemy of an M1
 * run has null. createEnemyV3 holds the record's one literal: each later C7 commit adds its
 * fields there, with neutral starting values. Anything it needs from systems/context.ts it
 * imports as a type only.
 */

import type { EnemyDef } from '../../data/types';

/** Enemy AI kinds (EnemyV3.ai): what a v3 type does each tick beyond walking in. */
export const AI_NONE = 0;
export const AI_DASH = 1;
export const AI_SHOOT = 2;
export const AI_SUMMON = 3;
export const AI_TREASURE = 4;

/** A v3 run's enemy record (Enemy.v3). */
export interface EnemyV3 {
  /** Its AI kind (AI_*), from its def's behaviour; AI_NONE for a plain walker. */
  readonly ai: number;
  /**
   * Outside composeWave's count: summons, onion bursts, 增殖 children and the treasure, which
   * calibration's φ leaves out (C7/F12).
   */
  readonly extra: boolean;
}

/**
 * How a spawn differs from its def (addEnemy's `origin`, docs/v3 C7 design §1.3): scales on its
 * hp, radius and drops, whether it is extra (EnemyV3.extra), and its affixes, −1 to draw them
 * (an elite), else these bits. M1 callers pass none.
 */
export interface SpawnOrigin {
  readonly hpScale: number;
  readonly radiusScale: number;
  readonly dropScale: number;
  readonly extra: boolean;
  readonly affixes: number;
}

/** The AI kind of each behaviour; shield, regeneration and layers walk in as M1's types do. */
function aiOf(def: EnemyDef): number {
  switch (def.behaviour?.kind) {
    case 'dash':
      return AI_DASH;
    case 'shoot':
      return AI_SHOOT;
    case 'summon':
      return AI_SUMMON;
    case 'treasure':
      return AI_TREASURE;
    default:
      return AI_NONE;
  }
}

/** The record of a v3 run's enemy of `def`, spawned with `origin` if its caller passed one. */
export function createEnemyV3(def: EnemyDef, origin: SpawnOrigin | undefined): EnemyV3 {
  return {
    ai: aiOf(def),
    // The treasure comes from its schedule, never from composeWave, whatever spawns it.
    extra: (origin?.extra ?? false) || def.behaviour?.kind === 'treasure',
  };
}
