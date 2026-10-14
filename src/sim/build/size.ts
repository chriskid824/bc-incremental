/**
 * Size and count factors: every radius and count the attacks, shots and zones create is read
 * through sizeOf and countOf, the one place where a build-wide size or count factor (the
 * 巨大化 keystone, docs/v3/game-design-v3.md §2.1) applies once it is decided. Both return their
 * input until then.
 */

import type { CompiledBuild } from './compile';

/** The radius `r` of something `build` creates, as the build sizes it. */
export function sizeOf(_build: CompiledBuild, r: number): number {
  return r;
}

/** The count `n` of something `build` creates (shots, cones, jumps), as the build counts it. */
export function countOf(_build: CompiledBuild, n: number): number {
  return n;
}
