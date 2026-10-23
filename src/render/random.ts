/**
 * The effects' randomness (docs/ARCHITECTURE.md §10): jitter, spread and flicker draw from a
 * `RenderRandom` handed down by the Renderer (RendererOptions.random) instead of calling
 * Math.random themselves. The M1 page passes none and draws Math.random through the default; a
 * replay (src/app/replay) passes a seeded one, so its frames depend only on its run and seed.
 */

/** A uniform number in [0, 1), as Math.random gives. */
export type RenderRandom = () => number;

/** The one default: Math.random, looked up at each call. */
export const defaultRandom: RenderRandom = () => Math.random();
