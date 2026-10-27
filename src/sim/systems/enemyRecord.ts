/**
 * The per-enemy v3 record (docs/v3 C7 design §1.3, C7/F6): Enemy.v3. addEnemy creates one for
 * every enemy of a v3 run (ctx.sys.enemyAi.enabled), M1 types included; every enemy of an M1
 * run has null. createEnemyV3 holds the record's one literal: each later C7 commit adds its
 * fields there, with neutral starting values. Anything it needs from systems/context.ts it
 * imports as a type only. C7.6's affix picks (affixCount, pickAffixes) and the constants its
 * spawn, hit and ailment paths share live here too, for the same reason: src/sim/systems/affixes.ts
 * re-exports them (deviation D1).
 */

import type { Num } from '../../core/num';
import { mul, ZERO } from '../../core/num';
import type { Rng } from '../../core/rng';
import {
  AFFIX_ARMOURED,
  AFFIX_COUNT,
  AFFIX_REGEN,
  AFFIX_SWIFT,
  AFFIX_WARD,
} from '../../data/affixes';
import type { EnemyBehaviour, EnemyDef, V3WaveRules } from '../../data/types';
import { DT } from '../types';
import type { Enemy } from './context';

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
 * 堅甲), and WARDED shrinks every ailment applied to it (C7.6's 元素護盾) until hits have taken
 * wardLeft off it. They are defined here, outside the hit path's import cycle, so that
 * createEnemyV3 and spawn.ts stay out of it.
 */
export const SHIELDED = 1;
export const ARMOURED = 2;
export const WARDED = 4;

/**
 * C7.6's affix constants that the record, the spawn path and the ailment entries need
 * (docs/v3 C7 design §1.8). Their home is src/sim/systems/affixes.ts, which re-exports them;
 * they are declared here because that module calls spawnOrSkip for 增殖, and spawn.ts,
 * enemyRecord.ts and the ailment entries would close a cycle with it (deviation D1, as C7.3's
 * defence bits and C7.4a's state bits).
 */
/** 迅捷 (gd:707): × on an elite's walk step. */
export const SWIFT_MULT = 2;
/** 元素護盾 (gd:713): the share of its max life in hit damage that breaks the ward. */
export const WARD_BREAK_PCT = 0.3;
/** 元素護盾 (gd:713): × on every ailment applied to it while WARDED (「效果 −75%」). */
export const WARD_AILMENT_MULT = 0.25;

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
  /** × on its contact damage (src/sim/systems/contact.ts); 1, or BERSERK_MULT while 狂暴 rages. */
  contactMult: number;
  /** Its behaviour's state bits (STOPPED … FLEEING); 0 while it walks in, and for a walker. */
  state: number;
  /** The tick its current phase ends (a charge, an orbit); each frozen tick pushes it back one. */
  stateUntil: number;
  /** Its walk step per tick: its def's speed × DT, × SWIFT_MULT with 迅捷. */
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
  /**
   * The tick of a shooter's next shot or a summoner's next summons (src/sim/systems/enemyAi.ts),
   * armed when it first reaches its post; Infinity until then, and for every other type. Each
   * frozen tick pushes it back one, which leaves Infinity as it is.
   */
  nextAct: number;
  /**
   * Its affixes as AFFIX_* bits (src/data/affixes.ts), drawn at spawn for an elite and inherited
   * by a 增殖 child; 0 for every other enemy, and never −1 (SpawnOrigin.affixes alone uses that).
   */
  readonly affixes: number;
  /**
   * 元素護盾's counter: the hit damage left before the ward breaks, WARD_BREAK_PCT × its max life
   * at spawn and ZERO without the affix. defend subtracts what each hit lands and clears WARDED
   * at 0 or below (src/sim/combat/defend.ts).
   */
  wardLeft: Num;
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

/**
 * The origin of an enemy-made spawn at its def's own hp, radius and drops, outside composeWave's
 * count and with no affix: a summoner's children (summon, src/sim/systems/enemyAi.ts) and, from
 * C7.7, an onion's bursts. One frozen constant, passed as is.
 */
export const EXTRA_ORIGIN: SpawnOrigin = Object.freeze({
  hpScale: 1,
  radiusScale: 1,
  dropScale: 1,
  extra: true,
  affixes: 0,
});

type TreasureBehaviour = Extract<EnemyBehaviour, { readonly kind: 'treasure' }>;

/**
 * The angle an orbiting treasure (ORBITING, standing at its post) turns its bearing by in a tick
 * at slow `slow`: its slowed walk step over its orbitDist; 0 for one of speed 0, or fully slowed.
 * The orbit turns by it (src/sim/systems/enemyAi.ts), and bleedRemaining
 * (src/sim/ailments/remaining.ts) and the lob's lead (src/sim/emitters/lob.ts) read it.
 */
export function orbitTurn(enemy: Enemy, slow: number): number {
  const v = enemy.v3 as EnemyV3;
  return (v.baseStep * (1 - slow)) / (enemy.def.behaviour as TreasureBehaviour).orbitDist;
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
 * How many affixes an elite released in `wave` draws (gd:703, through the v3 wave block's table):
 * the largest `count` of an entry with `fromWave ≤ wave`, 0 before the first one. The table is in
 * ascending `fromWave` (src/data/validate.ts), so the walk stops at the first later entry. With
 * V3_WAVES' table (5/1, 25/2, 60/3) an elite draws 1 from wave 5, 2 from wave 25 and 3 from
 * wave 60; elite waves are 5, 15, 25, … (boss waves are not elite waves), so the first 2-affix
 * elite is wave 25 and the first 3-affix one wave 65.
 */
export function affixCount(wave: number, table: V3WaveRules['affixes']): number {
  let count = 0;
  for (const rule of table) {
    if (rule.fromWave > wave) break;
    if (rule.count > count) count = rule.count;
  }
  return count;
}

/**
 * `count` distinct affixes drawn uniformly from the eight (C7/F21), as AFFIX_* bits: a partial
 * Fisher–Yates over a fresh [0 … 7] on the run's `affixes` stream, `int(8 − i)` for i in
 * 0..count−1, so a draw of `count` costs exactly `count` numbers and never repeats an affix.
 * A count of 0 draws nothing and returns 0.
 */
export function pickAffixes(rng: Rng, count: number): number {
  let bits = 0;
  if (count <= 0) return bits;
  // A fresh array per call: a kept one would make a draw depend on the draws before it.
  const ids = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = 0; i < count; i++) {
    const j = i + rng.int(AFFIX_COUNT - i);
    const pick = ids[j] as number;
    ids[j] = ids[i] as number;
    ids[i] = pick;
    bits |= 1 << pick;
  }
  return bits;
}

/**
 * The record of a v3 run's enemy of `def`, spawned with `origin` if its caller passed one, in a
 * run whose drops of tough kills are × `toughDropMult` (EnemyAiState.toughDropMult). `affixes`
 * are the AFFIX_* bits it carries (C7.6), drawn or inherited by its caller (addEnemy,
 * src/sim/systems/spawn.ts); `maxHp` its max life, which 元素護盾's counter starts from, and
 * `affixRegen` the life fraction a second 再生 gives, from the run's regenerator def. The three
 * default to no affix, so a caller that spawns without them gets today's record.
 */
export function createEnemyV3(
  def: EnemyDef,
  origin: SpawnOrigin | undefined,
  toughDropMult: number,
  affixes = 0,
  maxHp: Num = ZERO,
  affixRegen = 0,
): EnemyV3 {
  const shield = def.behaviour?.kind === 'shield' ? def.behaviour : null;
  const warded = (affixes & AFFIX_WARD) !== 0;
  return {
    ai: aiOf(def),
    // The treasure comes from its schedule, never from composeWave, whatever spawns it.
    extra: (origin?.extra ?? false) || def.behaviour?.kind === 'treasure',
    defence:
      (shield === null ? 0 : SHIELDED) |
      ((affixes & AFFIX_ARMOURED) !== 0 ? ARMOURED : 0) |
      (warded ? WARDED : 0),
    blockPct: shield === null ? 0 : shield.blockBelowPct,
    contactMult: 1,
    state: 0,
    stateUntil: 0,
    baseStep: (affixes & AFFIX_SWIFT) !== 0 ? def.speed * DT * SWIFT_MULT : def.speed * DT,
    escapeDist: 0,
    regen:
      (affixes & AFFIX_REGEN) !== 0
        ? affixRegen
        : def.behaviour?.kind === 'regen'
          ? def.behaviour.lifePctPerSec
          : 0,
    dropScale: (def.tough ? toughDropMult : 1) * (origin?.dropScale ?? 1),
    nextAct: Infinity,
    affixes,
    wardLeft: warded ? mul(maxHp, WARD_BREAK_PCT) : ZERO,
  };
}
