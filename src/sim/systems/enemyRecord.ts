/**
 * The per-enemy v3 record (docs/v3 C7 design §1.3, C7/F6): Enemy.v3. addEnemy creates one for
 * every enemy of a v3 run (ctx.sys.enemyAi.enabled), M1 types included; every enemy of an M1
 * run has null. createEnemyV3 holds the record's one literal: each later C7 commit adds its
 * fields there, with neutral starting values. Anything it needs from systems/context.ts it
 * imports as a type only.
 */

import type { EnemyDef } from '../../data/types';
import { DT } from '../types';

/** Enemy AI kinds (EnemyV3.ai): what a v3 type does each tick beyond walking in. */
export const AI_NONE = 0;
export const AI_DASH = 1;
export const AI_SHOOT = 2;
export const AI_SUMMON = 3;
export const AI_TREASURE = 4;

/**
 * Bits of EnemyV3.defence (docs/v3 C7 design §2.4): the defences defend
 * (src/sim/combat/defend.ts, which exports them too) applies to the enemy's hits. SHIELDED blocks
 * a hit part below blockPct of its max life (盾兵's shield), ARMOURED halves what passes (C7.6's
 * 堅甲). They are defined here, outside the hit path's import cycle, so that createEnemyV3 and
 * spawn.ts stay out of it.
 */
export const SHIELDED = 1;
export const ARMOURED = 2;

/**
 * Bits of EnemyV3.state (docs/v3 C7 design §2.5): the phase of a behaviour
 * (src/sim/systems/enemyAi.ts, which exports them too), 0 while the enemy walks in. A dasher
 * charges as CHARGING | STOPPED, then dashes as DASHING; a treasure circles as ORBITING, then
 * flees as FLEEING. The targetState condition reads DASHING and STOPPED
 * (src/sim/build/eval.ts), so they are defined here, outside every import cycle, as SHIELDED is.
 */
export const STOPPED = 1;
export const CHARGING = 2;
export const DASHING = 4;
export const ORBITING = 8;
export const FLEEING = 16;

/** A v3 run's enemy record (Enemy.v3). */
export interface EnemyV3 {
  /** Its AI kind (AI_*), from its def's behaviour; AI_NONE for a plain walker. */
  readonly ai: number;
  /**
   * Outside composeWave's count: summons, onion bursts, 增殖 children and the treasure, which
   * calibration's φ leaves out (C7/F12).
   */
  readonly extra: boolean;
  /** Its defences (SHIELDED, ARMOURED): SHIELDED from its def's shield behaviour, else none. */
  defence: number;
  /** The share of its max life a hit part must reach to pass SHIELDED; 0 without a shield. */
  blockPct: number;
  /** × on its contact damage (src/sim/systems/contact.ts); 1 until C7.6: 狂暴's ×2. */
  contactMult: number;
  /** Its behaviour's state bits (STOPPED … FLEEING); 0 while it walks in, and for a walker. */
  state: number;
  /** The tick its current phase ends (a charge, an orbit); each frozen tick pushes it back one. */
  stateUntil: number;
  /** Its walk step per tick: its def's speed × DT. */
  baseStep: number;
  /** The treasure's escape distance, set when it flees; 0 before, and for every other type. */
  escapeDist: number;
  /** The share of its max life it regains a second (its def's regeneration); 0 for none. */
  regen: number;
  /**
   * × on its kill's shards and expected cores (src/sim/systems/death.ts): the run's toughDropMult
   * for a tough def, × its origin's dropScale.
   */
  dropScale: number;
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

/**
 * The record of a v3 run's enemy of `def`, spawned with `origin` if its caller passed one, in a
 * run whose drops of tough kills are × `toughDropMult` (EnemyAiState.toughDropMult).
 */
export function createEnemyV3(
  def: EnemyDef,
  origin: SpawnOrigin | undefined,
  toughDropMult: number,
): EnemyV3 {
  const shield = def.behaviour?.kind === 'shield' ? def.behaviour : null;
  return {
    ai: aiOf(def),
    // The treasure comes from its schedule, never from composeWave, whatever spawns it.
    extra: (origin?.extra ?? false) || def.behaviour?.kind === 'treasure',
    defence: shield === null ? 0 : SHIELDED,
    blockPct: shield === null ? 0 : shield.blockBelowPct,
    contactMult: 1,
    state: 0,
    stateUntil: 0,
    baseStep: def.speed * DT,
    escapeDist: 0,
    regen: def.behaviour?.kind === 'regen' ? def.behaviour.lifePctPerSec : 0,
    dropScale: (def.tough ? toughDropMult : 1) * (origin?.dropScale ?? 1),
  };
}
