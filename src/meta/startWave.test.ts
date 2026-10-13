import { describe, expect, it } from 'vitest';
import { createSimulation, NO_INPUT, TICK_RATE } from '../sim';
import {
  PROBE_SECONDS,
  PROBE_SEEDS,
  clearsStartWave,
  highestClearedStartWave,
  probeConfig,
} from './startWave';
import { createMetaState } from './state';
import { collectRules, statBlockFor } from './stats';
import { fixtureData } from './testing';
import type { MetaState } from './types';

const data = fixtureData();

/** A fixture build: `ranks` ranks of the +10% more damage node, plus extra nodes. */
function build(ranks: number, nodes: readonly string[] = []): MetaState {
  const meta = createMetaState();
  for (const id of nodes) meta.allocated.add(id);
  if (ranks > 0) {
    meta.allocated.add('r');
    meta.ranks.set('r', ranks);
  }
  return meta;
}

function config(meta: MetaState, wave: number, seed: number, waveCap?: number) {
  const options = waveCap === undefined ? {} : { waveCap };
  return probeConfig(statBlockFor(meta, data), collectRules(meta, data), wave, seed, options);
}

/** The probe run played to its end, as the session would play it. */
function playedOut(meta: MetaState, wave: number, seed: number): boolean {
  const sim = createSimulation(config(meta, wave, seed), data);
  while (!sim.state.finished) sim.step(NO_INPUT);
  return sim.result().clearedStartWave;
}

/** Whether the build clears `wave` on every probe seed, by playing every run out. */
const clearsOnAllSeeds = (meta: MetaState, wave: number): boolean =>
  PROBE_SEEDS.every((seed) => playedOut(meta, wave, seed));

describe('probeConfig', () => {
  it('builds a short auto run of the current talents with the next wave as the cap', () => {
    const meta = build(3, ['a', 'b']);
    const probe = config(meta, 9, 42);
    expect(probe).toEqual({
      seed: 42,
      stats: statBlockFor(meta, data),
      rules: collectRules(meta, data),
      startWave: 9,
      mode: 'auto',
      waveCap: 10,
      maxTicks: PROBE_SECONDS * TICK_RATE,
    });
    // The game's own last wave caps the probe too.
    expect(config(meta, 9, 42, 9).waveCap).toBe(9);
    expect(config(meta, 8, 42, 9).waveCap).toBe(9);
  });
});

describe('clearsStartWave', () => {
  it('agrees with the run played to its end, on clears and on failures', () => {
    const outcomes = new Set<boolean>();
    for (const ranks of [0, 12, 30]) {
      const meta = build(ranks);
      for (let wave = 1; wave <= 25; wave += 3) {
        for (const seed of PROBE_SEEDS) {
          const expected = playedOut(meta, wave, seed);
          expect(clearsStartWave(config(meta, wave, seed), data), `${ranks} ${wave} ${seed}`).toBe(
            expected,
          );
          outcomes.add(expected);
        }
      }
    }
    expect([...outcomes].sort()).toEqual([false, true]);
  });
});

describe('highestClearedStartWave', () => {
  it('is a wave the build clears on every seed, with the wave above it not cleared', () => {
    for (const ranks of [0, 8, 20]) {
      const meta = build(ranks);
      const max = 30;
      const wave = highestClearedStartWave(meta, data, max);
      expect(wave).toBeGreaterThanOrEqual(1);
      expect(wave).toBeLessThanOrEqual(max);
      if (wave > 1) expect(clearsOnAllSeeds(meta, wave), `${ranks}`).toBe(true);
      if (wave < max) expect(clearsOnAllSeeds(meta, wave + 1), `${ranks}`).toBe(false);
    }
  });

  it('takes the highest allowed wave when the build clears it, and 1 with nothing to pick', () => {
    const meta = build(30);
    const cleared = highestClearedStartWave(meta, data, 30);
    expect(cleared).toBeGreaterThan(2);
    expect(highestClearedStartWave(meta, data, cleared)).toBe(cleared);
    expect(highestClearedStartWave(meta, data, cleared - 1)).toBe(cleared - 1);
    expect(highestClearedStartWave(meta, data, 1)).toBe(1);
    expect(highestClearedStartWave(meta, data, 0)).toBe(1);
  });

  it('goes up with damage and is the same every time', () => {
    const weak = highestClearedStartWave(build(0), data, 40);
    const strong = highestClearedStartWave(build(40), data, 40);
    expect(strong).toBeGreaterThan(weak);
    expect(highestClearedStartWave(build(40), data, 40)).toBe(strong);
  });
});
