/**
 * The frame-time readout (docs/v3 C10 design §2.5): a replay's rAF intervals, after a warm-up of
 * FPS_WARMUP_MS, over a window of FPS_WINDOW_MS; meanwhile its panel reads `measuring <s> / 30 s`,
 * and a resize, a full-screen change or the page hidden or shown starts it over. Then the block
 * stays, for Hoshi to copy into the thread (the C9 runbook's §8). Its text is dev text, in English
 * and outside i18n, as viewer.html's (src/app/viewer.ts). The statistics, the text and the restart
 * wiring are here, DOM-free, so the tests reach them; the panel is in replay.ts.
 */

import type { ReplayCounts } from './build';
import type { FrameStats } from './types';

/** Warm-up before the window (初始值): shaders and texture uploads settle in seconds. */
export const FPS_WARMUP_MS = 5_000;
/** The window (初始值): 30 s, as the stress scenarios (impl:518). */
export const FPS_WINDOW_MS = 30_000;
/**
 * The verdict's limits (初始值): 60 fps is 16.7 ms a frame (impl:519, :530); a p95 of at most
 * 20 ms allows vsync jitter, and a frame over 25 ms misses a 60 Hz refresh. A pass holds the p95
 * at most FPS_P95_MAX_MS and at most FPS_LONG_SHARE_MAX of the frames over FPS_LONG_MS.
 */
export const FPS_P95_MAX_MS = 20;
export const FPS_LONG_MS = 25;
export const FPS_LONG_SHARE_MAX = 0.01;

/** The `q` quantile of ascending `sorted` by nearest rank; 0 for none. */
function nearestRank(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1] as number;
}

/** The median of ascending `sorted`: the middle one, or the mean of the middle two; 0 for none. */
function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The readout's numbers: rAF intervals, warm-up first, then the window's, with the replay's
 * counts at each of the window's frames. Once the window is full it is done and keeps them.
 */
export class FrameTimer {
  private phaseValue: FrameStats['phase'] = 'warmup';
  /** Ms of the current phase. */
  private elapsed = 0;
  private readonly deltas: number[] = [];
  private aliveSum = 0;
  private summons = 0;
  private orbs = 0;

  constructor(
    private readonly warmupMs = FPS_WARMUP_MS,
    private readonly windowMs = FPS_WINDOW_MS,
  ) {}

  get phase(): FrameStats['phase'] {
    return this.phaseValue;
  }

  /** Ms of the current phase so far. */
  get elapsedMs(): number {
    return this.elapsed;
  }

  /** Back to the warm-up, the window emptied; a done readout keeps its numbers (the block stays). */
  restart(): void {
    if (this.phaseValue === 'done') return;
    this.phaseValue = 'warmup';
    this.elapsed = 0;
    this.deltas.length = 0;
    this.aliveSum = 0;
    this.summons = 0;
    this.orbs = 0;
  }

  /** One rAF interval of `deltaMs`, ending a frame that showed `counts`. */
  frame(deltaMs: number, counts: ReplayCounts): void {
    if (this.phaseValue === 'done') return;
    this.elapsed += deltaMs;
    if (this.phaseValue === 'warmup') {
      if (this.elapsed >= this.warmupMs) {
        this.phaseValue = 'window';
        this.elapsed = 0;
      }
      return;
    }
    this.deltas.push(deltaMs);
    this.aliveSum += counts.alive;
    this.summons = Math.max(this.summons, counts.summons);
    this.orbs = Math.max(this.orbs, counts.orbs);
    if (this.elapsed >= this.windowMs) this.phaseValue = 'done';
  }

  stats(): FrameStats {
    const sorted = [...this.deltas].sort((a, b) => a - b);
    const frames = sorted.length;
    let longFrames = 0;
    for (const delta of sorted) if (delta > FPS_LONG_MS) longFrames++;
    const longShare = frames === 0 ? 0 : longFrames / frames;
    const p95Ms = nearestRank(sorted, 0.95);
    return {
      phase: this.phaseValue,
      elapsedMs: this.elapsed,
      frames,
      medianMs: median(sorted),
      p50Ms: nearestRank(sorted, 0.5),
      p95Ms,
      p99Ms: nearestRank(sorted, 0.99),
      maxMs: frames === 0 ? 0 : (sorted[frames - 1] as number),
      longFrames,
      longShare,
      aliveAvg: frames === 0 ? 0 : this.aliveSum / frames,
      summons: this.summons,
      orbs: this.orbs,
      pass: frames > 0 && p95Ms <= FPS_P95_MAX_MS && longShare <= FPS_LONG_SHARE_MAX,
    };
  }
}

/** The panel's text while the readout measures, `measuring <s> / 30 s`: the window's seconds. */
export function measuringText(phase: FrameStats['phase'], elapsedMs: number): string {
  const seconds = FPS_WINDOW_MS / 1000;
  if (phase === 'warmup') return `measuring 0 / ${seconds} s (warm-up)`;
  return `measuring ${Math.floor(elapsedMs / 1000)} / ${seconds} s`;
}

/** The page a readout ran on: the Steam build's under file: (C9's loadFile), else the web's. */
export const pageOf = (protocol: string): 'web' | 'steam' =>
  protocol === 'file:' ? 'steam' : 'web';

/** Where the block was read: the page, the build and the screen. */
export interface ReadoutEnv {
  readonly page: 'web' | 'steam';
  /** __BUILD_ID__. */
  readonly build: string;
  readonly userAgent: string;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly devicePixelRatio: number;
  /** The canvas's drawing buffer, in device pixels. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

const ms = (value: number): string => value.toFixed(1);

/** The block Hoshi copies (the C9 runbook's §8.2, §8.3), from `bc-incremental fps v1` to `end fps`. */
export function fpsBlock(stats: FrameStats, env: ReadoutEnv): string {
  const percent = (stats.longShare * 100).toFixed(2);
  return [
    'bc-incremental fps v1',
    `page: ${env.page}  build: ${env.build}`,
    `ua: ${env.userAgent}`,
    `screen: ${env.screenWidth}x${env.screenHeight} @${env.devicePixelRatio}  ` +
      `canvas: ${env.canvasWidth}x${env.canvasHeight}`,
    `warm-up ${FPS_WARMUP_MS / 1000} s, window ${FPS_WINDOW_MS / 1000} s, frames ${stats.frames}, ` +
      `median interval ${ms(stats.medianMs)} ms`,
    `frame ms: p50 ${ms(stats.p50Ms)}  p95 ${ms(stats.p95Ms)}  p99 ${ms(stats.p99Ms)}  ` +
      `max ${ms(stats.maxMs)}`,
    `long frames > ${FPS_LONG_MS} ms: ${stats.longFrames} (${percent} %)`,
    `alive avg ${stats.aliveAvg.toFixed(1)}  summons ${stats.summons}  orbs ${stats.orbs}`,
    `verdict: ${stats.pass ? 'pass' : 'FAIL'} (p95 <= ${FPS_P95_MAX_MS} ms, ` +
      `long <= ${FPS_LONG_SHARE_MAX * 100} %)`,
    'end fps',
  ].join('\n');
}

/** What watchRestarts listens on: the page's window and document, or stubs in the tests. */
export interface RestartSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Calls `restart` on a resize (window), a full-screen change and the page hidden or shown again
 * (document): each makes the frames before it and after it two different readings. Returns the
 * function that stops listening.
 */
export function watchRestarts(
  win: RestartSource,
  doc: RestartSource,
  restart: () => void,
): () => void {
  win.addEventListener('resize', restart);
  doc.addEventListener('fullscreenchange', restart);
  doc.addEventListener('visibilitychange', restart);
  return () => {
    win.removeEventListener('resize', restart);
    doc.removeEventListener('fullscreenchange', restart);
    doc.removeEventListener('visibilitychange', restart);
  };
}
