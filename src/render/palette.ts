/**
 * Render colors. Effect colors follow the archetype palette reserved in src/data/enemies.ts:
 * crit yellow/white, burn orange-red, chain cyan, poison green, frost icy blue.
 */

export const COLORS = {
  background: 0x0b0d12,
  arena: 0x0d1018,
  grid: 0x1b2232,
  arenaEdge: 0x252e44,
  /** Faint light pool around the player on the arena floor. */
  floorGlow: 0x2a6f9a,
  player: 0x9fe8ff,
  playerCore: 0xe9fbff,
  playerHit: 0xff4d5e,
  projectile: 0xf4fbff,
  projectileTrail: 0x9fdcff,
  hitFlash: 0xffffff,
  spark: 0xd8f1ff,
  crit: 0xffd84a,
  critHot: 0xfff6c8,
  burn: 0xff7a2e,
  /** Flame core, shading to burnDeep as it rises and cools. */
  burnHot: 0xffc44a,
  burnDeep: 0xe0301a,
  chain: 0x5ff4ff,
  /**
   * Poisoned enemies' cast (src/render/enemies.ts): 熔核's 瘟爆 green (DEFAULT_MAGMA_LOOKS.poison),
   * bluer than 蜂巢's lime so a poisoned enemy does not read as the hive's colour.
   */
  poison: 0x3fd08a,
  /** Chilled enemies lean toward `chill` with the meter; frozen ones toward the paler `frozen`. */
  chill: 0x7fd4ff,
  frozen: 0xaee9ff,
  hpBack: 0x05060a,
  hpFill: 0xff6b81,
  damageHit: 0xeef2ff,
  damageCrit: 0xffe066,
  damageBurn: 0xff8a3d,
  damageChain: 0x7ff6ff,
  /** Cold-tagged hits (碎冰, 霜蜂): a deeper frost blue than the chain's cyan. */
  damageCold: 0x5aa9ff,
  /** Poison ticks: a mint green, apart from 蜂巢's lime hit numbers (hitNumberColor). */
  damagePoison: 0x5ef2a6,
  damageBleed: 0xff5068,
  /** A hit the enemy's defences took in full (hitBlocked): steel, apart from a landed hit's white. */
  blocked: 0x9aa6bd,
  /** 衝刺者 while it charges its dash (gd A.5 「衝刺前變紅 0.6 秒」). */
  enemyCharge: 0xff3b3b,
  /** Enemy bullets: hostile red, apart from the player's cool projectiles; their core near white. */
  bullet: 0xff5a4e,
  bulletCore: 0xffe4dc,
  /** The player's shield arc (PlayerState.shield): the player's cyan, lighter. */
  playerShield: 0xcff6ff,
  /**
   * A segment's links between drones or summons (src/render/segmentLines.ts): a cooler blue than
   * the chain cyan of shocked links, so a laser fence reads apart from 雷網.
   */
  droneLink: 0x86a8ff,
} as const;

/**
 * 熔核's attack language and fusions (docs/v3/game-design-v3.md §11.4, §11.6, §5.2): the bomb and
 * its explosion share the character orange (CONSTRUCT_COLORS.magmaCore.main); these are the rest.
 */
export const MAGMA_COLORS = {
  /** The bomb's white-hot heart and its explosion's flash. */
  bombHot: 0xfff1c9,
  /** Its shadow on the floor and the scorch marks: near black, drawn with normal blending. */
  shadow: 0x050201,
  /** 火地: deep ember red under the orange, so a patch glows instead of flattening to a disc. */
  zoneDeep: 0xc2340f,
  /** 霜焰 (火冰): the white-blue frost ring outside the explosion and on a fire zone's edge. */
  frostRim: 0xe4f7ff,
  frost: 0x8fe3ff,
  /** 斬擊線: 暴擊's low-chroma white light (gd §4.6, #FFF4D6), the crit skin's accent. */
  slash: 0xfff4d6,
} as const;

/**
 * The arenas (docs/v3/game-design-v3.md §11.5), by CharacterDef.arena. 熔核's and 蜂巢's are drawn
 * so far; the others fall back to M1's backdrop until their batches.
 */
export const ARENA_COLORS = {
  fire: {
    /** Charcoal with a warm cast. */
    floor: 0x110c0a,
    /** The forge grate: concentric rings and spokes from the center. */
    grate: 0x3b2417,
    /** Every third ring, a little hotter. */
    grateHot: 0x5c3018,
    edge: 0x4a2a19,
    /** A faint heat under the grate's center, far dimmer than M1's light pool. */
    heat: 0x7a2e10,
  },
  summon: {
    /** Deep teal. */
    floor: 0x061518,
    /** The hex lattice, and the cells of every third ring around the center a little brighter. */
    comb: 0x0f3236,
    combHot: 0x184a46,
    edge: 0x1c4a4c,
    /** The turret seats' track at the turret radius. */
    seat: 0x2c6a4e,
    /** A faint glow over the nest, far dimmer than M1's light pool. */
    glow: 0x1b5e52,
  },
} as const;

/**
 * 蜂巢's attack language (gd §1.5, §11.4, §11.5): the drones' colour is the character green
 * (CONSTRUCT_COLORS.hive.main); these are the rest.
 */
export const HIVE_COLORS = {
  /** An impact's flash and a turret's muzzle flash: green-white. */
  flash: 0xf4ffe6,
  /** The dock ring's cradles while their drone is out. */
  cradleEmpty: 0x2f5f3a,
  /** A turret's seat plate on the floor. */
  seat: 0x3f8a52,
} as const;

/** Linear blend of two 0xRRGGBB colors; t = 0 gives a, t = 1 gives b. */
export function mixColor(a: number, b: number, t: number): number {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const r = ((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k;
  const g = ((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k;
  const bl = (a & 0xff) + ((b & 0xff) - (a & 0xff)) * k;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

/**
 * Character constructs (docs/v3/game-design-v3.md §11.3, §11.6). `main` is the character color;
 * the four main hues are at least 70° apart in OKLCH. The other shades follow the reference
 * drawing docs/v3/characters-v3.svg.
 */
export const CONSTRUCT_COLORS = {
  magmaCore: {
    main: 0xff7a2f,
    /** Diamond core, from the white-hot center out to `main` at the rim. */
    coreHot: 0xfffbea,
    coreMid: 0xffd27a,
    coreEdge: 0xfff1d0,
    plate: 0x3d2a20,
    plateEdge: 0xff8a45,
    vent: 0xffa255,
    ember: 0xffb26b,
  },
  frostCrystal: {
    main: 0x8fe3ff,
    /** Lit and shaded facets of a spike. */
    facetLight: 0xf0fcff,
    facetDark: 0x6cc6ee,
    edge: 0xffffff,
    core: 0xffffff,
  },
  teslaTower: {
    main: 0xb48cff,
    /** The white core of every arc and the discharge tips. */
    core: 0xffffff,
    post: 0x24163c,
    postEdge: 0x5b4396,
    base: 0x2a1b45,
    baseEdge: 0x6a4fa8,
  },
  hive: {
    main: 0x9bf25c,
    /** Center cell of the comb, the outer cells, and their dark hollows. */
    cellCenter: 0xe2ffc4,
    cell: 0x6fbf3a,
    cellHollow: 0x2e6a18,
    cellEdge: 0xe6ffd0,
    dock: 0x4fa048,
    droneEdge: 0xf2ffe4,
    droneMark: 0x2a5a14,
  },
} as const;
