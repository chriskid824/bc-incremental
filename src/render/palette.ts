/**
 * Render colors. Effect colors follow the archetype palette reserved in src/data/enemies.ts:
 * crit yellow/white, burn orange-red, chain cyan.
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
  hpBack: 0x05060a,
  hpFill: 0xff6b81,
  damageHit: 0xeef2ff,
  damageCrit: 0xffe066,
  damageBurn: 0xff8a3d,
  damageChain: 0x7ff6ff,
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
