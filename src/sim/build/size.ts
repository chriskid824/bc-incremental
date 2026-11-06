/**
 * Size and count factors (docs/v3 C4 design D29; Hoshi's Q2 (A)): every area radius the attacks,
 * effects and zones create is sized by the build's area factor: compiled effects once, by
 * compileBuild's sizedEffect pass (the same r × areaFactor), and burst events and the other sites
 * through sizeOf at use. Each of 巨大化's four counts is read through countOf, once, where the run
 * reads it. sizeOf multiplies by the build's area factor (BuildFlags.areaFactor: areaSize ×
 * 巨大化's sizeFactor, a number compileBuild computes once), so a build without either keeps every
 * radius as written, bit for bit. countOf halves only under 巨大化 (BuildFlags.halveCounts) and is
 * the identity otherwise.
 *
 * Spread distances (E3, 擴散距離) take the build's spread factor (BuildFlags.spreadFactor:
 * spreadRadius, also computed once by compileBuild): a spread is an area too, so the effects that
 * spread (every spreadAilment, and an applyAilment whose radius node data marks `spread`) are
 * sized r × areaFactor × spreadFactor in the same sizedEffect pass, one product; a selector's
 * range that node data marks is a reach, × spreadFactor alone (src/sim/effects/select.ts
 * spreadSelector); and a rule module reads its own spread distances through spreadOf.
 *
 * Thorns radii (E16, 荊棘範圍; lead ruling 21 of B4) take the build's thorns factor
 * (BuildFlags.thornsFactor: the thornsArea stat when above 0, else 0, also computed once by
 * compileBuild): the effects whose tags hold thorns are sized r × areaFactor × thornsFactor in
 * the same sizedEffect pass, one product (× spreadFactor too were one to spread); a thorns-tagged
 * strike's selector range is a reach, × thornsFactor and never × areaFactor (strikeSelector),
 * and its area radius sizeOf(r) × thornsFactor (src/sim/emitters/strike.ts). The radii read at
 * use, a nova's and an explode's burst event and a groundZone's zone, take the same product when
 * the effect's tags hold thorns (sizedRadius, src/sim/effects/execute.ts).
 */

import type { CompiledBuild } from './compile';

/** The radius `r` of an area `build` creates, as the build sizes it: r × its area factor. */
export function sizeOf(build: Pick<CompiledBuild, 'flags'>, r: number): number {
  return r * build.flags.areaFactor;
}

/**
 * The reach of `build`'s auras from the player: the auraRadius stat as the build sizes it
 * (sizeOf). The pull effect's 'auraEdge' (src/sim/effects/execute.ts) reads it, and so do an
 * aura's pulse and the inAura condition through auraReachSq; a pull lands its enemy where that
 * squared test holds (landing), so the aura's edge is where its pulse reaches.
 */
export function auraReach(build: Pick<CompiledBuild, 'flags' | 'values'>): number {
  return sizeOf(build, build.values.auraRadius);
}

/**
 * The squared reach of `build`'s auras (auraReach). An enemy is within it when the squared
 * distance of its centre from the player is at most this, inclusive, as the grid's within()
 * test: what an aura's pulse hits (src/sim/emitters/aura.ts) and what the inAura condition asks
 * (src/sim/build/eval.ts; lead rulings 19, W2) both read it, so they cannot drift apart.
 */
export function auraReachSq(build: Pick<CompiledBuild, 'flags' | 'values'>): number {
  const r = auraReach(build);
  return r * r;
}

/**
 * A rule module's own spread distance `r` (燎原's 「60 內」), as the build reaches it: r × its
 * spread factor, read at use (in a hook: the factor is set once every module has compiled).
 * Like a marked selector's range, it is a reach and takes no area factor; a module whose spread
 * is an area sizes it as well (sizeOf).
 */
export function spreadOf(build: Pick<CompiledBuild, 'flags'>, r: number): number {
  return r * build.flags.spreadFactor;
}

/**
 * The count `n` of something `build` creates (projectiles, the fan's cones, chain jumps, drones),
 * as the build counts it: under 巨大化 halved and rounded down, at least 1 (gd:268's
 * 「減半，一律無條件捨去，最少 1」), so no fraction is left to roll; a count below 1, at most a
 * chance of one, halves to none rather than rising to 1. `n` itself otherwise.
 */
export function countOf(build: Pick<CompiledBuild, 'flags'>, n: number): number {
  if (!build.flags.halveCounts) return n;
  return n >= 1 ? Math.max(1, Math.floor(n / 2)) : 0;
}
