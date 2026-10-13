/**
 * Decides which crits earn a hit-stop (docs/ARCHITECTURE.md §10). Crit hit-stop is a rare
 * accent, not a beat: the crit must be huge next to a plain hit, must stand out from the crits
 * this run has been landing (so steadyAim, whose every third volley is a wall of identical big
 * crits, does not hitch on that rhythm), and stops are spaced by a long cooldown. Elite and boss
 * kills ask for their own hit-stops in the renderer and do not go through this gate.
 */

/** A crit must deal at least this many times the typical hit. */
export const CRIT_STOP_MIN_RATIO = 20;
/** ...and at least this many times the run's usual crit so far. */
export const CRIT_STOP_STANDOUT = 2;
/** Wall-clock ms after a crit hit-stop before another crit may ask for one. */
export const CRIT_STOP_COOLDOWN_MS = 2500;
/** Stop length at the threshold, growing per order of magnitude above it, up to the max. */
export const CRIT_STOP_MS = 30;
export const CRIT_STOP_MAX_MS = 60;
/** Weight of each crit in the running "usual crit" level (an average in log space). */
const LEVEL_WEIGHT = 0.25;

const MIN_DECADES = Math.log10(CRIT_STOP_MIN_RATIO);
const STANDOUT_DECADES = Math.log10(CRIT_STOP_STANDOUT);

export class CritStopGate {
  /** log10 of the usual crit over the typical hit; a run starts at the typical hit. */
  private level = 0;
  private cooldownMs = 0;

  /**
   * Reports a crit `decades` orders of magnitude above the typical hit. Returns the hit-stop to
   * ask for in ms, or 0. Call it for every crit so the usual crit level keeps up.
   */
  crit(decades: number): number {
    if (!Number.isFinite(decades)) return 0;
    const standsOut = decades - this.level >= STANDOUT_DECADES;
    this.level += (decades - this.level) * LEVEL_WEIGHT;
    if (!standsOut || decades < MIN_DECADES || this.cooldownMs > 0) return 0;
    this.cooldownMs = CRIT_STOP_COOLDOWN_MS;
    return Math.min(CRIT_STOP_MAX_MS, CRIT_STOP_MS * (1 + (decades - MIN_DECADES)));
  }

  update(dtMs: number): void {
    this.cooldownMs = Math.max(0, this.cooldownMs - Math.max(0, dtMs));
  }

  reset(): void {
    this.level = 0;
    this.cooldownMs = 0;
  }
}
