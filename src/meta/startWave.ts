/**
 * Highest start wave a talent build clears, found by simulating short runs (docs/GDD.md §2.2).
 * The browser session uses it so a respec, a weaker build or a reload does not keep a start
 * wave the build cannot clear, and a strong build is not sent back to trivial early waves.
 * Pure and deterministic: fixed seeds, no clock.
 */

import type { RuleSpec } from '../data/rules';
import type { StatBlock } from '../data/stats';
import type { GameData } from '../data/types';
import { createSimulation } from '../sim/simulation';
import { NO_INPUT, TICK_RATE } from '../sim/types';
import type { RunConfig } from '../sim/types';
import { collectRules, statBlockFor } from './stats';
import type { MetaState } from './types';

/** A start wave counts as cleared only if the probe clears it on every one of these seeds. */
export const PROBE_SEEDS: readonly number[] = [7001, 7002];

/** Probe runs stop after this much simulated time; a start wave still open by then fails. */
export const PROBE_SECONDS = 30;

export interface StartWaveProbeOptions {
  /** The game's last wave (the session's waveCap); probes never run past it. */
  readonly waveCap?: number;
}

/**
 * Probe run config for start wave `wave`: built like the browser session's runs (stats and
 * rules of the current talents, auto mode), plus the next wave as the cap, so a start wave
 * that takes longer than the wave timer meets the pressure it would meet in a real run.
 */
export function probeConfig(
  stats: StatBlock,
  rules: readonly RuleSpec[],
  wave: number,
  seed: number,
  options: StartWaveProbeOptions = {},
): RunConfig {
  return {
    seed,
    stats,
    rules,
    startWave: wave,
    mode: 'auto',
    waveCap: Math.max(wave, Math.min(wave + 1, options.waveCap ?? Infinity)),
    maxTicks: PROBE_SECONDS * TICK_RATE,
  };
}

/**
 * RunResult.clearedStartWave of the run `config` describes, stopping as soon as it is known:
 * a contact before the next wave starts can only come from the start wave (no skip), and the
 * start wave clearing before anything reached the player means it was cleared. Otherwise the
 * run plays out and its result decides.
 */
export function clearsStartWave(config: RunConfig, data: GameData): boolean {
  const sim = createSimulation(config, data);
  const start = config.startWave;
  let nextStarted = false;
  let contact = false;
  while (!sim.state.finished) {
    const events = sim.step(NO_INPUT);
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event === undefined) continue;
      if (event.type === 'waveStarted') {
        if (event.wave > start) nextStarted = true;
      } else if (event.type === 'playerHit') {
        if (!nextStarted) return false;
        contact = true;
      } else if (event.type === 'waveCleared' && event.wave === start && !contact) {
        return true;
      }
    }
  }
  return sim.result().clearedStartWave;
}

/**
 * Highest start wave in 1..maxStartWave that the current talents clear on every probe seed;
 * wave 1 when none does. Tries maxStartWave first, so a build that clears it costs one probe
 * per seed. Otherwise it binary-searches below it, assuming that a build which clears a wave
 * clears the waves before it. That only roughly holds: a single leak fails a seed, and elite
 * and boss waves are harder than the waves after them. So the search asks for a clear on any
 * seed, which moves less from one wave to the next, and the answer is then verified on every
 * seed, stepping down until a wave clears on all of them. Each wave and seed runs once.
 */
export function highestClearedStartWave(
  meta: Readonly<MetaState>,
  data: GameData,
  maxStartWave: number,
  options: StartWaveProbeOptions = {},
): number {
  const max = Math.max(1, Math.floor(maxStartWave));
  if (max <= 1) return 1;
  const stats = statBlockFor(meta, data);
  const rules = collectRules(meta, data);
  const probed = new Map<number, boolean>();
  const clears = (wave: number, seedIndex: number): boolean => {
    const key = wave * PROBE_SEEDS.length + seedIndex;
    let cleared = probed.get(key);
    if (cleared === undefined) {
      const seed = PROBE_SEEDS[seedIndex] as number;
      cleared = clearsStartWave(probeConfig(stats, rules, wave, seed, options), data);
      probed.set(key, cleared);
    }
    return cleared;
  };
  const seeds = PROBE_SEEDS.map((_, index) => index);
  const clearsAll = (wave: number): boolean => seeds.every((index) => clears(wave, index));
  const clearsAny = (wave: number): boolean => seeds.some((index) => clears(wave, index));

  if (clearsAll(max)) return max;
  let low = 1;
  let high = max - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (clearsAny(mid)) low = mid;
    else high = mid - 1;
  }
  while (low > 1 && !clearsAll(low)) low--;
  return low;
}
