/**
 * The replay's specs (docs/v3 C10 design §1.7): the wall's fusion clips, B1's select-card
 * preview, the PR GIF and renderStress, and the `?replay=` grammar: parseReplayParam for the spec,
 * parseReplayRoute for the route's own parameters. Pure, so the tests reach it.
 */

import { CHARACTER_IDS, OUTER_IDS } from '../../data/sources';
import type { CharacterId, OuterId } from '../../data/sources';
import type { FusionKey } from '../../data/web';
import { TICK_RATE } from '../../sim';
import { STRESS_START_WAVE } from '../../sim/testing';
import type { ReplaySpec } from './types';

/** The PR GIF's wave, 「約第 30 波的 15 秒 GIF」 (F14; impl:546) (初始值). */
export const GIF_WAVE = 30;
/** The PR GIF's length in seconds (F14; impl:546) (初始值). */
export const GIF_SECONDS = 15;
/** The PR GIF's frames a second (F14) (初始值). */
export const GIF_FPS = 30;
/** The PR GIF's width in px (F14) (初始值). */
export const GIF_WIDTH = 640;
/** A wall clip's length: impl:571's 「3 秒片段」 (初始值). */
export const CLIP_TICKS = 180;
/** The select card's loop in seconds: impl:530's 「10 秒固定 seed 預覽」 (初始值). */
export const PREVIEW_SECONDS = 10;
/**
 * A wall clip's start wave and warm-up (初始值): the first core comes at about 0:20 (gd:831), near
 * wave 22 (GDD:212); four waves lower, its unlock investment holds the screen.
 */
export const CLIP_WAVE = 18;
export const CLIP_WARMUP_TICKS = 300;
/** The select card's wave and purchases (初始值): gd:318's typical build at the first prestige. */
export const PREVIEW_WAVE = 30;
export const PREVIEW_PURCHASES = 68;
/** Every replay's seed unless `&seed=` names one (初始值): impl:530's 「固定 seed」, the stress readings' 1. */
export const REPLAY_SEED = 1;
/**
 * renderStress's warm-up and clip (初始值): the stress scenarios' 30 s run (impl:518) from the
 * tick their alive band starts at (bench.ts' ALIVE_FROM_TICK), so the clip is the ticks the band
 * is read over, 301–1800.
 */
export const RENDER_STRESS_WARMUP_TICKS = 300;
export const RENDER_STRESS_TICKS = 1500;

/** The wall's 3 s clip of fusion `key`: its unlock investment and core, from CLIP_WAVE. */
export function fusionClipSpec(key: FusionKey, o: Partial<ReplaySpec> = {}): ReplaySpec {
  return {
    build: { kind: 'fusion', key },
    content: 'registered',
    seed: REPLAY_SEED,
    startWave: CLIP_WAVE,
    warmupTicks: CLIP_WARMUP_TICKS,
    durationTicks: CLIP_TICKS,
    loop: true,
    ...o,
  };
}

/** B1's select card: c's typical build at the first prestige, a 10 s loop at PREVIEW_WAVE. */
export function previewSpec(c: CharacterId, o: Partial<ReplaySpec> = {}): ReplaySpec {
  return {
    build: { kind: 'default', character: c, count: PREVIEW_PURCHASES },
    content: 'registered',
    seed: REPLAY_SEED,
    startWave: PREVIEW_WAVE,
    warmupTicks: CLIP_WARMUP_TICKS,
    durationTicks: PREVIEW_SECONDS * TICK_RATE,
    loop: true,
    ...o,
  };
}

/** The PR GIF: the preview's build, GIF_SECONDS from GIF_WAVE, once. */
export function gifSpec(c: CharacterId, o: Partial<ReplaySpec> = {}): ReplaySpec {
  return {
    build: { kind: 'default', character: c, count: PREVIEW_PURCHASES },
    content: 'registered',
    seed: REPLAY_SEED,
    startWave: GIF_WAVE,
    warmupTicks: CLIP_WARMUP_TICKS,
    durationTicks: GIF_SECONDS * TICK_RATE,
    loop: false,
    ...o,
  };
}

/** The frame-time readout's scene (presets.ts): its seed-1 window of the stress run, looped. */
export function renderStressSpec(o: Partial<ReplaySpec> = {}): ReplaySpec {
  return {
    build: { kind: 'preset', id: 'renderStress' },
    content: 'registered',
    seed: REPLAY_SEED,
    startWave: STRESS_START_WAVE,
    warmupTicks: RENDER_STRESS_WARMUP_TICKS,
    durationTicks: RENDER_STRESS_TICKS,
    loop: true,
    ...o,
  };
}

/** A whole number in decimal digits. */
const WHOLE = /^\d+$/;
/** The largest seed: createRng reads a seed as an unsigned 32-bit integer (src/core/rng.ts). */
const SEED_MAX = 0xffffffff;
/** `&seconds=`'s longest clip: a capture of up to a minute (the lead's ruling H8). */
const SECONDS_MAX = 60;
/** `&fps=`'s rates: the divisors of TICK_RATE, so that every frame steps whole ticks. */
const FPS_RATES = Array.from({ length: TICK_RATE }, (_, i) => i + 1).filter(
  (fps) => TICK_RATE % fps === 0,
);

type Parsed<T> = T | { readonly error: string };

/** `name`'s value as a whole number in [min, max]; undefined when absent. */
function wholeParam(
  params: URLSearchParams,
  name: string,
  min: number,
  max: number,
): Parsed<number | undefined> {
  const text = params.get(name);
  if (text === null) return undefined;
  const value = WHOLE.test(text) ? Number(text) : NaN;
  if (!(value >= min && value <= max)) {
    return { error: `&${name}=${text}: a whole number from ${min} to ${max}` };
  }
  return value;
}

const isError = (value: unknown): value is { readonly error: string } =>
  typeof value === 'object' && value !== null && 'error' in value;
const isCharacter = (text: string): text is CharacterId =>
  (CHARACTER_IDS as readonly string[]).includes(text);
const isOuter = (text: string): text is OuterId => (OUTER_IDS as readonly string[]).includes(text);

/** The replay forms, as `?replay=` names them. */
const GRAMMAR = 'renderStress, preview:<c>, gif:<c> or clip:<c>.<o>';

/** The spec form of `value` with these overrides; an error for any other value. */
function specOf(value: string, o: Partial<ReplaySpec>): Parsed<ReplaySpec> {
  if (value === 'renderStress') return renderStressSpec(o);
  const colon = value.indexOf(':');
  const form = colon < 0 ? value : value.slice(0, colon);
  const rest = colon < 0 ? null : value.slice(colon + 1);
  if (rest !== null && (form === 'preview' || form === 'gif')) {
    if (!isCharacter(rest)) return { error: `?replay=${value}: no character '${rest}'` };
    return form === 'preview' ? previewSpec(rest, o) : gifSpec(rest, o);
  }
  if (rest !== null && form === 'clip') {
    const dot = rest.indexOf('.');
    const c = dot < 0 ? rest : rest.slice(0, dot);
    const outer = dot < 0 ? null : rest.slice(dot + 1);
    if (outer === null || !isCharacter(c) || !isOuter(outer)) {
      return { error: `?replay=${value}: a fusion is clip:<character>.<outer>` };
    }
    return fusionClipSpec(`${c}.${outer}`, o);
  }
  return { error: `?replay=${value}: unknown; the forms are ${GRAMMAR}` };
}

/**
 * The spec `?replay=` names in `search` (a page's location.search), with `&seed=`, `&wave=`,
 * `&seconds=` (the clip's length: n × TICK_RATE ticks; without it, the form's own) and
 * `&fixture`. An error for a missing or empty `?replay=` (the game's page, readDevFlags), an
 * unknown form or a parameter out of range.
 */
export function parseReplayParam(search: string): ReplaySpec | { readonly error: string } {
  const params = new URLSearchParams(search);
  const value = params.get('replay');
  if (value === null || value === '') return { error: `no ?replay=; the forms are ${GRAMMAR}` };
  const seed = wholeParam(params, 'seed', 0, SEED_MAX);
  if (isError(seed)) return seed;
  const wave = wholeParam(params, 'wave', 1, Number.MAX_SAFE_INTEGER);
  if (isError(wave)) return wave;
  const seconds = wholeParam(params, 'seconds', 1, SECONDS_MAX);
  if (isError(seconds)) return seconds;
  return specOf(value, {
    ...(seed === undefined ? {} : { seed }),
    ...(wave === undefined ? {} : { startWave: wave }),
    ...(seconds === undefined ? {} : { durationTicks: seconds * TICK_RATE }),
    ...(params.has('fixture') ? { content: 'fixture' as const } : {}),
  });
}

/** The route's page (route.ts): the spec and how to show it. */
export interface ReplayRoute {
  readonly spec: ReplaySpec;
  /** `&width=`: the canvas's CSS width, at 16:9; a GIF's GIF_WIDTH; else null, the window. */
  readonly width: number | null;
  /** `&step=1`: step mode, which exposes `window.__replay`. */
  readonly step: boolean;
  /** `&readout=0|1`: the frame-time readout; 1 for renderStress, else 0, by default. */
  readonly readout: boolean;
  /**
   * Ticks a step-mode frame runs: TICK_RATE ÷ `&fps=`; without it TICK_RATE ÷ GIF_FPS for a GIF
   * (a 30 fps capture), else 1.
   */
  readonly frameTicks: number;
}

/** A 0|1 flag; undefined when absent. */
function flagParam(params: URLSearchParams, name: string): Parsed<boolean | undefined> {
  const text = params.get(name);
  if (text === null) return undefined;
  if (text !== '0' && text !== '1') return { error: `&${name}=${text}: 0 or 1` };
  return text === '1';
}

/** `&fps=`: one of FPS_RATES; undefined when absent. */
function fpsParam(params: URLSearchParams): Parsed<number | undefined> {
  const text = params.get('fps');
  if (text === null) return undefined;
  const value = WHOLE.test(text) ? Number(text) : NaN;
  if (!FPS_RATES.includes(value)) {
    const rates = `${FPS_RATES.slice(0, -1).join(', ')} or ${FPS_RATES.at(-1)}`;
    return { error: `&fps=${text}: a divisor of ${TICK_RATE}: ${rates}` };
  }
  return value;
}

/** parseReplayParam's spec with the route's `&width=`, `&step=`, `&readout=` and `&fps=`. */
export function parseReplayRoute(search: string): ReplayRoute | { readonly error: string } {
  const spec = parseReplayParam(search);
  if (isError(spec)) return spec;
  const params = new URLSearchParams(search);
  const width = wholeParam(params, 'width', 1, Number.MAX_SAFE_INTEGER);
  if (isError(width)) return width;
  const step = flagParam(params, 'step');
  if (isError(step)) return step;
  const readout = flagParam(params, 'readout');
  if (isError(readout)) return readout;
  const fps = fpsParam(params);
  if (isError(fps)) return fps;
  const gif = (params.get('replay') ?? '').startsWith('gif:');
  return {
    spec,
    width: width ?? (gif ? GIF_WIDTH : null),
    step: step ?? false,
    readout: readout ?? spec.build.kind === 'preset',
    frameTicks: fps !== undefined ? TICK_RATE / fps : gif ? TICK_RATE / GIF_FPS : 1,
  };
}
