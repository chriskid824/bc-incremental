/**
 * Elite affixes (docs/v3 C7 design §1.8, docs/v3/game-design-v3.md:703-714): the eight rules an
 * elite draws from, in gd:707-714's order. An elite's record holds them as bits
 * (EnemyV3.affixes, src/sim/systems/enemyRecord.ts), bit i for AFFIX_IDS[i], so a run's picks
 * are one number and the renderer, the balance checks and the sim all read the same order.
 * This module imports nothing: the picks (pickAffixes) live beside the record, and the rules
 * (src/sim/systems/affixes.ts) hold their own constants.
 */

/** Bit i of EnemyV3.affixes is AFFIX_IDS[i]: 迅捷, 堅甲, 再生, 守護, 增殖, 狂暴, 元素護盾, 冰霜. */
export const AFFIX_IDS = [
  'swift',
  'armoured',
  'regen',
  'guardian',
  'multiply',
  'berserk',
  'ward',
  'frost',
] as const;
export type AffixId = (typeof AFFIX_IDS)[number];

/** How many affixes exist: the wave table's `count` reaches at most this (src/data/validate.ts). */
export const AFFIX_COUNT = AFFIX_IDS.length;

/** 迅捷 (gd:707): walks at SWIFT_MULT × its def's speed. */
export const AFFIX_SWIFT = 1;
/** 堅甲 (gd:708): ARMOURED, so a hit part that passes its shield is halved. */
export const AFFIX_ARMOURED = 2;
/** 再生 (gd:709): regains life a second as the regenerator does. */
export const AFFIX_REGEN = 4;
/** 守護 (gd:710): gives every v3 enemy around it the shielder's block. */
export const AFFIX_GUARDIAN = 8;
/** 增殖 (gd:711): its death leaves MULTIPLY_COUNT smaller elites. */
export const AFFIX_MULTIPLY = 16;
/** 狂暴 (gd:712): below half life it moves and hits BERSERK_MULT × harder. */
export const AFFIX_BERSERK = 32;
/** 元素護盾 (gd:713): ailments on it are × WARD_AILMENT_MULT until hits break the ward. */
export const AFFIX_WARD = 64;
/** 冰霜 (gd:714): near the player, every attack's cadence is × FROST_CADENCE. */
export const AFFIX_FROST = 128;
