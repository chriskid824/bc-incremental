/**
 * The replay's shapes (docs/v3 C10 design §1.7): one seeded run of a build from a wave, drawn by
 * the game's renderer, for the clip wall and the PR GIF (C10.5b), B1's select card, B5's dev start
 * options and the frame-time readout (§2.5). DOM-free, so the tests reach them; the component's
 * handle, which holds its canvas, is in replay.ts.
 */

import type { CharacterId } from '../../data/sources';
import type { GameData } from '../../data/types';
import type { AssembledWeb, FusionKey } from '../../data/web';
import type { CharacterProgress } from '../../meta/web';
import type { RunConfig } from '../../sim';
import type { TestModule } from '../../sim/rules';

/** What a replay plays. */
export type ReplayBuild =
  /** These purchases from empty, in order, ranks by repetition (progressFromOrder). */
  | { readonly kind: 'web'; readonly character: CharacterId; readonly purchases: readonly string[] }
  /** The first `count` purchases of the character's defaultOrder, all without it. */
  | { readonly kind: 'default'; readonly character: CharacterId; readonly count?: number }
  /** Fusion c.o's unlock investment (unlockInvestment) and its core. */
  | { readonly kind: 'fusion'; readonly key: FusionKey }
  /** A workload of src/app/replay/presets.ts. */
  | { readonly kind: 'preset'; readonly id: 'renderStress' };

export interface ReplaySpec {
  readonly build: ReplayBuild;
  /** fixture: fixtureContent('B5'), for dev pages before B1 registers content. */
  readonly content: 'registered' | 'fixture';
  /** The web's scope; 'full' when omitted. */
  readonly scope?: 'full' | 'demoA' | 'demoB';
  readonly seed: number;
  readonly startWave: number;
  /** Ticks simulated before the first frame, not drawn. */
  readonly warmupTicks: number;
  /** Ticks the clip shows after the warm-up. */
  readonly durationTicks: number;
  /** Restart at the end: identical frames each loop. */
  readonly loop: boolean;
  /** The renderer's seed; deriveSeed(seed, 'render') when omitted. */
  readonly renderSeed?: number;
}

export interface ReplayOptions {
  /** The canvas's size in CSS px. */
  readonly width: number;
  readonly height: number;
  /** play: rAF through FixedStepClock (src/app/loop.ts); step: frames only on step(). */
  readonly mode: 'play' | 'step';
  /** Step mode's ticks per frame (2 = a 30 fps capture); 1 when omitted. */
  readonly frameTicks?: number;
  /** The frame-time readout's panel (readout.ts). */
  readonly readout?: boolean;
  /** min(2, devicePixelRatio) when omitted; 1 in captures. */
  readonly resolution?: number;
  /** Called at each restart of a looping clip. */
  readonly onLoop?: () => void;
}

/** A run a replay can play: its game data, test modules and config (B5's dev start options). */
export interface RunSetup {
  readonly data: GameData;
  readonly testModules: readonly TestModule[];
  /** The run's config with this seed from this wave. */
  config(seed: number, startWave: number): RunConfig;
}

/** A resolved ReplayBuild: the character's web and progress (null for a preset), and its run. */
export interface ResolvedBuild {
  readonly web: AssembledWeb | null;
  readonly progress: CharacterProgress | null;
  readonly run: RunSetup;
}

/** The frame-time readout's numbers so far (readout.ts), over its window of rAF deltas. */
export interface FrameStats {
  /** The warm-up, the window, or done: the numbers then stay. */
  readonly phase: 'warmup' | 'window' | 'done';
  /** Ms of the current phase so far (the window's whole length once done). */
  readonly elapsedMs: number;
  /** Frames in the window. */
  readonly frames: number;
  /** The median frame interval, ms. */
  readonly medianMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** Frames longer than FPS_LONG_MS, and their share of the window's frames. */
  readonly longFrames: number;
  readonly longShare: number;
  /** Alive enemies, averaged over the window's frames; the most summons and orbs in it. */
  readonly aliveAvg: number;
  readonly summons: number;
  readonly orbs: number;
  /** p95 ≤ FPS_P95_MAX_MS and longShare ≤ FPS_LONG_SHARE_MAX. */
  readonly pass: boolean;
}
