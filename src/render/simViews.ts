/**
 * Pure reads of the sim's views for the renderer (V1, for content batch B1's zone and lob
 * drawing): a zone's slow by its slot, and a lobbed shot's flight progress. They read SimState
 * and never write it; nothing draws with them yet.
 */

import type { ShotPoolState, ZonePoolState } from '../sim';

/**
 * The slow the zone in slot `s` (s < SimState.zoneCount) holds on the enemies in it, 0 for none:
 * the pool keeps it by the zone's record, so slot s reads slow[record[s]] (ZonePoolState).
 */
export function zoneSlowAt(zones: Readonly<ZonePoolState>, s: number): number {
  return zones.slow[zones.record[s] as number] as number;
}

/**
 * How far the lobbed shot in slot `s` (s < SimState.shotCount) has flown at tick `now`, from 0 on
 * its launch tick to 1 on its landing tick: (now − launched) / (until − launched), clamped to
 * [0, 1]. `now` may fall between ticks: a frame drawn at `alpha` between the last two ticks reads
 * SimState.tick − 1 + alpha, as positions interpolate. A shot that lands on its launch tick reads 1.
 */
export function lobProgress(shots: Readonly<ShotPoolState>, s: number, now: number): number {
  const launched = shots.launched[s] as number;
  const span = (shots.until[s] as number) - launched;
  if (!(span > 0)) return 1;
  const t = (now - launched) / span;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}
