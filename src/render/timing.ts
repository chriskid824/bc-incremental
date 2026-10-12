/** Frame timing shared by the effect layers. */

/**
 * Effects are created between frames (while ticks run) and aged by the next frame's time.
 * On that first update they age at most one 60 Hz frame, so a slow frame cannot age a short
 * effect (a lightning bolt, a crit pop) out before it is ever drawn.
 */
export const FIRST_FRAME_MS = 1000 / 60;

/** Time to age an effect by this frame: capped on the frame after it was created. */
export function ageStep(dtMs: number, fresh: boolean): number {
  return fresh ? Math.min(dtMs, FIRST_FRAME_MS) : dtMs;
}
