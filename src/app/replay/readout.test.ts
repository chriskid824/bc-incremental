import { describe, expect, it, vi } from 'vitest';
import type { ReplayCounts } from './build';
import {
  FPS_LONG_MS,
  FPS_LONG_SHARE_MAX,
  FPS_P95_MAX_MS,
  FPS_WARMUP_MS,
  FPS_WINDOW_MS,
  FrameTimer,
  fpsBlock,
  measuringText,
  pageOf,
  watchRestarts,
} from './readout';
import type { ReadoutEnv, RestartSource } from './readout';

const COUNTS: ReplayCounts = { alive: 300, summons: 32, orbs: 8 };
/** The warm-up's frames: slow (shaders compiling) and crowded, none of them the window's. */
const WARMUP_DELTA_MS = 50;
const WARMUP_COUNTS: ReplayCounts = { alive: 1000, summons: 40, orbs: 12 };

/** Feeds `timer` its warm-up: FPS_WARMUP_MS of WARMUP_DELTA_MS frames. */
function warmUp(timer: FrameTimer): void {
  for (let t = 0; t < FPS_WARMUP_MS; t += WARMUP_DELTA_MS) {
    expect(timer.phase).toBe('warmup');
    timer.frame(WARMUP_DELTA_MS, WARMUP_COUNTS);
  }
}

/** A timer past its warm-up, then fed these window deltas, each frame showing `counts`. */
function timed(deltas: readonly number[], counts: (i: number) => ReplayCounts = () => COUNTS) {
  const timer = new FrameTimer();
  warmUp(timer);
  deltas.forEach((delta, i) => timer.frame(delta, counts(i)));
  return timer;
}

const repeat = (count: number, ms: number): number[] => Array<number>(count).fill(ms);

/**
 * 1000 window frames at the verdict's edges: the 950th fastest at `p95` ms (the p95 by nearest
 * rank, 20 by default), then `slow` ms frames (24) and `long` frames of 26 ms (10: 1 %).
 */
const edge = ({ p95 = 20, slow = 24, long = 10 } = {}): number[] => [
  ...repeat(940, 16),
  ...repeat(10, p95),
  ...repeat(50 - long, slow),
  ...repeat(long, 26),
];

describe('the frame-time readout (docs/v3 C10 design §2.5, OWN test 7)', () => {
  it('holds §2.5’s numbers: 5 s of warm-up, a 30 s window, p95 ≤ 20 ms, ≤ 1 % over 25 ms', () => {
    expect([FPS_WARMUP_MS, FPS_WINDOW_MS]).toEqual([5_000, 30_000]);
    expect([FPS_P95_MAX_MS, FPS_LONG_MS, FPS_LONG_SHARE_MAX]).toEqual([20, 25, 0.01]);
  });

  it('reads p50, p95, p99, max, the median and the long share of the window’s deltas', () => {
    // 1..100 ms, shuffled: the statistics sort them.
    const deltas = Array.from({ length: 100 }, (_, i) => ((i * 37) % 100) + 1);
    expect(new Set(deltas).size).toBe(100);
    const stats = timed(deltas, (i) => ({
      alive: (deltas[i] as number) * 2,
      summons: i % 33,
      orbs: i % 9,
    })).stats();
    expect(stats).toEqual({
      phase: 'window',
      elapsedMs: 5050,
      frames: 100,
      medianMs: 50.5,
      p50Ms: 50,
      p95Ms: 95,
      p99Ms: 99,
      maxMs: 100,
      longFrames: 75,
      longShare: 0.75,
      aliveAvg: 101,
      summons: 32,
      orbs: 8,
      pass: false,
    });
  });

  it('counts none of the warm-up’s frames: not their deltas, not their counts', () => {
    const timer = new FrameTimer();
    warmUp(timer);
    expect(timer.stats()).toMatchObject({ phase: 'window', elapsedMs: 0, frames: 0, pass: false });
    timer.frame(16, COUNTS);
    expect(timer.stats()).toMatchObject({
      frames: 1,
      maxMs: 16,
      longFrames: 0,
      aliveAvg: 300,
      summons: 32,
      orbs: 8,
      pass: true,
    });
  });

  it('passes at a p95 of exactly 20 ms and exactly 1 % of frames over 25 ms, warm-up and all', () => {
    // The warm-up's 100 frames of 50 ms would fail both, counted.
    expect(timed(edge()).stats()).toMatchObject({
      frames: 1000,
      p95Ms: 20,
      longFrames: 10,
      longShare: 0.01,
      pass: true,
    });
    expect(timed(edge({ p95: 20.5 })).stats()).toMatchObject({
      p95Ms: 20.5,
      longFrames: 10,
      pass: false,
    });
    expect(timed(edge({ long: 11 })).stats()).toMatchObject({
      p95Ms: 20,
      longFrames: 11,
      pass: false,
    });
  });

  it('counts a frame of exactly 25 ms as on time, and one over it as long', () => {
    expect(timed(edge({ slow: 25 })).stats()).toMatchObject({ longFrames: 10, pass: true });
    expect(timed(edge({ slow: 25.01 })).stats()).toMatchObject({ longFrames: 50, pass: false });
  });

  it('ends at 30 s of window and keeps its numbers: later frames and restarts change nothing', () => {
    const timer = timed(repeat(1875, 16));
    const done = timer.stats();
    expect(done).toMatchObject({ phase: 'done', elapsedMs: 30_000, frames: 1875, pass: true });
    // 30 s of rAF time, however many frames fill it: 1,200 of 25 ms.
    expect(timed(repeat(1199, 25)).stats().phase).toBe('window');
    expect(timed(repeat(1200, 25)).stats()).toMatchObject({
      phase: 'done',
      elapsedMs: 30_000,
      frames: 1200,
    });
    timer.frame(500, WARMUP_COUNTS);
    timer.restart();
    expect(timer.stats()).toEqual(done);
  });

  it('starts over on a resize, a full-screen change and the page hidden or shown', () => {
    const listeners = (): RestartSource & { fire(type: string): void; count(): number } => {
      const map = new Map<string, Set<() => void>>();
      return {
        addEventListener: (type, listener) => {
          const set = map.get(type) ?? new Set();
          set.add(listener);
          map.set(type, set);
        },
        removeEventListener: (type, listener) => void map.get(type)?.delete(listener),
        fire: (type) => map.get(type)?.forEach((listener) => listener()),
        count: () => [...map.values()].reduce((sum, set) => sum + set.size, 0),
      };
    };
    const win = listeners();
    const doc = listeners();
    const timer = new FrameTimer();
    const restart = vi.fn(() => timer.restart());
    const stop = watchRestarts(win, doc, restart);
    for (const [source, type] of [
      [win, 'resize'],
      [doc, 'fullscreenchange'],
      [doc, 'visibilitychange'],
    ] as const) {
      warmUp(timer);
      timer.frame(16, COUNTS);
      expect(timer.stats().frames, type).toBe(1);
      restart.mockClear();
      source.fire(type);
      expect(restart, type).toHaveBeenCalledTimes(1);
      expect(timer.stats(), type).toMatchObject({ phase: 'warmup', elapsedMs: 0, frames: 0 });
    }
    // The window's own events only: a resize of the document is no resize.
    restart.mockClear();
    doc.fire('resize');
    win.fire('visibilitychange');
    expect(restart).not.toHaveBeenCalled();
    stop();
    expect([win.count(), doc.count()]).toEqual([0, 0]);
  });

  it('shows `measuring <s> / 30 s` meanwhile', () => {
    expect(measuringText('warmup', 4_000)).toBe('measuring 0 / 30 s (warm-up)');
    expect(measuringText('window', 0)).toBe('measuring 0 / 30 s');
    expect(measuringText('window', 12_999)).toBe('measuring 12 / 30 s');
    const timer = new FrameTimer();
    timer.frame(16, COUNTS);
    expect(measuringText(timer.phase, timer.elapsedMs)).toBe('measuring 0 / 30 s (warm-up)');
  });

  it('reads the page as steam under file: (the Steam shell’s loadFile) and as web elsewhere', () => {
    expect(pageOf('file:')).toBe('steam');
    for (const protocol of ['http:', 'https:', 'app:', 'chrome-extension:', 'about:']) {
      expect(pageOf(protocol), protocol).toBe('web');
    }
  });

  it('prints the block from `bc-incremental fps v1` to `end fps`', () => {
    const env: ReadoutEnv = {
      page: 'web',
      build: '0.1.0+abc1234',
      userAgent: 'Mozilla/5.0 (test)',
      screenWidth: 1920,
      screenHeight: 1080,
      devicePixelRatio: 1.25,
      canvasWidth: 2400,
      canvasHeight: 1350,
    };
    expect(fpsBlock(timed(edge()).stats(), env).split('\n')).toEqual([
      'bc-incremental fps v1',
      'page: web  build: 0.1.0+abc1234',
      'ua: Mozilla/5.0 (test)',
      'screen: 1920x1080 @1.25  canvas: 2400x1350',
      'warm-up 5 s, window 30 s, frames 1000, median interval 16.0 ms',
      'frame ms: p50 16.0  p95 20.0  p99 24.0  max 26.0',
      'long frames > 25 ms: 10 (1.00 %)',
      'alive avg 300.0  summons 32  orbs 8',
      'verdict: pass (p95 <= 20 ms, long <= 1 %)',
      'end fps',
    ]);
    const failed = fpsBlock(timed([30, 30]).stats(), { ...env, page: 'steam' }).split('\n');
    expect([failed[1], failed[6], failed[8]]).toEqual([
      'page: steam  build: 0.1.0+abc1234',
      'long frames > 25 ms: 2 (100.00 %)',
      'verdict: FAIL (p95 <= 20 ms, long <= 1 %)',
    ]);
  });
});
