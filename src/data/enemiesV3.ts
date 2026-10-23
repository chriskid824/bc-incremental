/**
 * The v3 types (docs/v3/game-design-v3.md §6, docs/v3 C7 design §1.2), merged into ENEMIES.
 * Every number is an initial value (初始值): the game design's where it gives one, the rest
 * chosen so that non-tough radii stay ≤ 22 (shotPad stays 22), speeds stay in M1's 90–160 walk
 * band and dropMult follows hpMult as on M1's non-boss types. Only v3 waves
 * (src/data/wavesV3.ts) spawn them, and until each behaviour's commit reads it they walk in like
 * M1's types.
 */

import type { EnemyDef, EnemyId } from './types';

/** 「中性的白灰輪廓」 (game-design-v3 §6): every v3 type but the treasure. */
const NEUTRAL = 0xe8ecf2;

export const V3_ENEMIES = {
  /** 盾兵: its test is the shield, not its hp; 1.5 × a square, a little slower. */
  shielder: {
    id: 'shielder',
    shape: 'circle',
    hpMult: 1.5,
    speed: 100,
    radius: 22,
    contactDamage: 5,
    dropMult: 1.5,
    cores: 0,
    color: NEUTRAL,
    tough: false,
    boss: false,
    behaviour: { kind: 'shield', blockBelowPct: 0.15 },
  },
  /** 再生者: a square's speed and size, 1.5 × its hp so that 8 %/s is felt. */
  regenerator: {
    id: 'regenerator',
    shape: 'cross',
    hpMult: 1.5,
    speed: 110,
    radius: 20,
    contactDamage: 4,
    dropMult: 1.5,
    cores: 0,
    color: NEUTRAL,
    tough: false,
    boss: false,
    behaviour: { kind: 'regen', lifePctPerSec: 0.08 },
  },
  /** 衝刺者: charges inside the shortest spawn distance (540), so always on screen. */
  dasher: {
    id: 'dasher',
    shape: 'rhombus',
    hpMult: 1,
    speed: 110,
    radius: 18,
    contactDamage: 6,
    dropMult: 1,
    cores: 0,
    color: NEUTRAL,
    tough: false,
    boss: false,
    behaviour: { kind: 'dash', chargeDist: 420, chargeSec: 0.6, dashMult: 4 },
  },
  /** 射手: stops halfway along the shortest walk-in; a bullet deals its contact damage. */
  shooter: {
    id: 'shooter',
    shape: 'trapezoid',
    hpMult: 1,
    speed: 120,
    radius: 20,
    contactDamage: 3,
    dropMult: 1,
    cores: 0,
    color: NEUTRAL,
    tough: false,
    boss: false,
    behaviour: { kind: 'shoot', stopDist: 300, periodSec: 2, bulletSpeed: 200, bulletDamage: 3 },
  },
  /** 召喚者: hides on the outer ring, so 3 × hp; drawn larger than its collision radius. */
  summoner: {
    id: 'summoner',
    shape: 'ring',
    hpMult: 3,
    speed: 90,
    radius: 22,
    contactDamage: 8,
    dropMult: 3,
    cores: 0,
    color: NEUTRAL,
    tough: false,
    boss: false,
    behaviour: { kind: 'summon', stopDist: 480, periodSec: 3, enemy: 'triangle', count: 2 },
  },
  /**
   * 寶藏怪: small, fast and a reward, never a threat; 20 × drops and a core (game-design-v3
   * §6.1). Not a spawn rule: the v3 block's treasure schedule brings it.
   */
  treasure: {
    id: 'treasure',
    shape: 'diamond',
    hpMult: 2,
    speed: 150,
    radius: 14,
    contactDamage: 0,
    dropMult: 20,
    cores: 1,
    color: 0xffd23f,
    tough: false,
    boss: false,
    behaviour: { kind: 'treasure', orbitDist: 480, orbitSec: 8, fleeMult: 2 },
  },
  /**
   * 洋蔥, the v3 boss (the v3 block's bossRotation): M1's boss values, hpMult the total over its
   * layers; each break sprays a quarter of M1's triangle minimum per wave.
   */
  onion: {
    id: 'onion',
    shape: 'onion',
    hpMult: 28,
    speed: 45,
    radius: 70,
    contactDamage: 100,
    dropMult: 16,
    cores: 3,
    color: NEUTRAL,
    tough: true,
    boss: true,
    behaviour: { kind: 'layers', layers: 3, burst: { enemy: 'triangle', count: 12 } },
  },
} satisfies Readonly<Partial<Record<EnemyId, EnemyDef>>>;
