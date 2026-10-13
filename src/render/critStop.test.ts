import { describe, expect, it } from 'vitest';
import {
  CRIT_STOP_COOLDOWN_MS,
  CRIT_STOP_MAX_MS,
  CRIT_STOP_MIN_RATIO,
  CRIT_STOP_STANDOUT,
  CritStopGate,
} from './critStop';

const FRAME = 1000 / 60;
const decadesOf = (ratio: number): number => Math.log10(ratio);

/** Feeds `volleys` volleys of `perVolley` crits every `gapMs`; returns the stops granted. */
function stream(gate: CritStopGate, ratio: number, volleys: number, perVolley = 7, gapMs = 600) {
  const stops: number[] = [];
  for (let v = 0; v < volleys; v++) {
    for (let c = 0; c < perVolley; c++) {
      const ms = gate.crit(decadesOf(ratio));
      if (ms > 0) stops.push(ms);
    }
    for (let t = 0; t < gapMs; t += FRAME) gate.update(FRAME);
  }
  return stops;
}

describe('CritStopGate', () => {
  it('never stops for crits below the ratio, however much they stand out', () => {
    const gate = new CritStopGate();
    expect(stream(gate, CRIT_STOP_MIN_RATIO * 0.9, 50)).toEqual([]);
  });

  it('does not hitch on a steady rhythm of equally big crits (steadyAim volleys)', () => {
    const gate = new CritStopGate();
    // 30 s of volleys every 600 ms, each crit well past the ratio.
    const stops = stream(gate, CRIT_STOP_MIN_RATIO * 1.3, 50);
    // Only the first big crit of the run stands out from the crits before it.
    expect(stops).toHaveLength(1);
  });

  it('stops for a crit that towers over the usual crits, then waits out the cooldown', () => {
    const gate = new CritStopGate();
    stream(gate, CRIT_STOP_MIN_RATIO * 1.2, 20);
    const towering = decadesOf(CRIT_STOP_MIN_RATIO * 1.2 * CRIT_STOP_STANDOUT * 1.5);
    expect(gate.crit(towering)).toBeGreaterThan(0);
    // An even bigger one right after is refused until the cooldown has run out.
    gate.update(CRIT_STOP_COOLDOWN_MS - 1);
    expect(gate.crit(towering + 1)).toBe(0);
    gate.update(1);
    expect(gate.crit(towering + 2)).toBeGreaterThan(0);
  });

  it('keeps stops short and ignores non-finite amounts', () => {
    const gate = new CritStopGate();
    expect(gate.crit(12)).toBe(CRIT_STOP_MAX_MS);
    gate.reset();
    expect(gate.crit(Number.NaN)).toBe(0);
    expect(gate.crit(decadesOf(CRIT_STOP_MIN_RATIO))).toBeGreaterThan(0);
    expect(gate.crit(decadesOf(CRIT_STOP_MIN_RATIO))).toBe(0);
  });

  it('starts every run fresh', () => {
    const gate = new CritStopGate();
    expect(gate.crit(decadesOf(CRIT_STOP_MIN_RATIO * 2))).toBeGreaterThan(0);
    gate.reset();
    expect(gate.crit(decadesOf(CRIT_STOP_MIN_RATIO * 2))).toBeGreaterThan(0);
  });
});
