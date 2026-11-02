/**
 * Size and count factors (docs/v3 C4 design D29; Hoshi's Q2 (A)): every area radius the attacks,
 * effects and zones create is sized by the build's area factor: compiled effects once, by
 * compileBuild's sizedEffect pass (the same r × areaFactor), and burst events and the other sites
 * through sizeOf at use. Each of 巨大化's four counts is read through countOf, once, where the run
 * reads it. sizeOf multiplies by the build's area factor (BuildFlags.areaFactor: areaSize ×
 * 巨大化's sizeFactor, a number compileBuild computes once), so a build without either keeps every
 * radius as written, bit for bit. countOf halves only under 巨大化 (BuildFlags.halveCounts) and is
 * the identity otherwise.
 */

import type { CompiledBuild } from './compile';

/** The radius `r` of an area `build` creates, as the build sizes it: r × its area factor. */
export function sizeOf(build: Pick<CompiledBuild, 'flags'>, r: number): number {
  return r * build.flags.areaFactor;
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
