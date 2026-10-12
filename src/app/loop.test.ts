import { describe, expect, it } from 'vitest';
import {
  FixedStepClock,
  GameLoop,
  HIT_STOP_BUDGET_MS,
  HIT_STOP_BUDGET_RATE,
  HIT_STOP_MAX_MS,
  HIT_STOP_MIN_MS,
  HIT_STOP_TIME_SCALE,
  HitStop,
  MAX_STEPS_PER_FRAME,
  TICK_MS,
} from './loop';
import type { LoopHost, Speed } from './loop';

describe('FixedStepClock', () => {
  it('runs one tick per tick of elapsed time and keeps the remainder as alpha', () => {
    const clock = new FixedStepClock();
    expect(clock.advance(10, 1)).toBe(0);
    expect(clock.alpha).toBeCloseTo(10 / TICK_MS);
    expect(clock.advance(10, 1)).toBe(1);
    expect(clock.alpha).toBeCloseTo((20 - TICK_MS) / TICK_MS);
    expect(clock.advance(TICK_MS * 2, 1)).toBe(2);
  });

  it('multiplies elapsed time by the speed', () => {
    const clock = new FixedStepClock();
    expect(clock.advance(TICK_MS + 0.01, 4)).toBe(4);
    expect(clock.advance(TICK_MS + 0.01, 2)).toBe(2);
  });

  it('caps catch-up per frame and drops the excess', () => {
    const clock = new FixedStepClock();
    expect(clock.advance(5000, 1)).toBe(MAX_STEPS_PER_FRAME);
    expect(clock.alpha).toBe(0);
    expect(clock.advance(0, 1)).toBe(0);
    expect(clock.advance(5000, 4)).toBe(MAX_STEPS_PER_FRAME * 4);
  });

  it('ignores negative frame times and resets', () => {
    const clock = new FixedStepClock();
    expect(clock.advance(-50, 1)).toBe(0);
    clock.advance(10, 1);
    clock.reset();
    expect(clock.alpha).toBe(0);
  });
});

describe('HitStop', () => {
  const FRAME = 1000 / 60;

  it('passes time through when no stop is running', () => {
    const stop = new HitStop(true);
    expect(stop.scale(FRAME)).toBeCloseTo(FRAME);
    expect(stop.scale(-5)).toBe(0);
  });

  it('slows simulation time for the length of the stop, then resumes', () => {
    const stop = new HitStop(true);
    expect(stop.request(40)).toBe(40);
    expect(stop.scale(30)).toBeCloseTo(30 * HIT_STOP_TIME_SCALE);
    // 10 ms of stop left, then normal time.
    expect(stop.scale(30)).toBeCloseTo(10 * HIT_STOP_TIME_SCALE + 20);
    expect(stop.remaining).toBe(0);
    expect(stop.scale(30)).toBeCloseTo(30);
  });

  it('caps a single stop and merges overlapping requests instead of stacking them', () => {
    const stop = new HitStop(true);
    expect(stop.request(500)).toBe(HIT_STOP_MAX_MS);
    expect(stop.request(HIT_STOP_MAX_MS)).toBe(0);
    expect(stop.remaining).toBe(HIT_STOP_MAX_MS);
    stop.scale(30);
    // A new big request tops the stop back up to the cap, never past it.
    expect(stop.request(HIT_STOP_MAX_MS)).toBe(30);
    expect(stop.remaining).toBe(HIT_STOP_MAX_MS);
  });

  it('ignores requests too short to notice', () => {
    const stop = new HitStop(true);
    expect(stop.request(HIT_STOP_MIN_MS / 2)).toBe(0);
    expect(stop.request(0)).toBe(0);
    expect(stop.request(Number.NaN)).toBe(0);
  });

  it('cannot turn into a slideshow however often it is requested', () => {
    const stop = new HitStop(true);
    let wall = 0;
    let sim = 0;
    let longest = 0;
    let run = 0;
    for (let frame = 0; frame < 60 * 60; frame++) {
      stop.request(HIT_STOP_MAX_MS);
      run = stop.remaining > 0 ? run + FRAME : 0;
      longest = Math.max(longest, run);
      sim += stop.scale(FRAME);
      wall += FRAME;
    }
    // Over a minute of constant requests, stops eat at most the budget rate (plus the bank).
    const stoppedShare = (wall - sim) / (1 - HIT_STOP_TIME_SCALE) / wall;
    expect(stoppedShare).toBeLessThanOrEqual(HIT_STOP_BUDGET_RATE + HIT_STOP_BUDGET_MS / wall);
    expect(sim / wall).toBeGreaterThan(0.9);
    // The opening bank allows about two full stops back to back (plus what refills meanwhile).
    expect(longest).toBeLessThanOrEqual(HIT_STOP_BUDGET_MS * 1.25);
  });

  it('refills its budget over time', () => {
    const stop = new HitStop(true);
    stop.request(HIT_STOP_MAX_MS);
    stop.scale(HIT_STOP_MAX_MS);
    stop.request(HIT_STOP_MAX_MS);
    stop.scale(HIT_STOP_MAX_MS);
    // The bank is spent: a request right away gets only what refilled meanwhile.
    expect(stop.request(HIT_STOP_MAX_MS)).toBeLessThan(HIT_STOP_MIN_MS);
    stop.scale(HIT_STOP_MAX_MS / HIT_STOP_BUDGET_RATE);
    expect(stop.request(HIT_STOP_MAX_MS)).toBe(HIT_STOP_MAX_MS);
  });

  it('does nothing under reduced motion', () => {
    const stop = new HitStop(false);
    expect(stop.request(HIT_STOP_MAX_MS)).toBe(0);
    expect(stop.scale(FRAME)).toBeCloseTo(FRAME);
  });

  it('resets to no stop and a full budget', () => {
    const stop = new HitStop(true);
    stop.request(HIT_STOP_MAX_MS);
    stop.scale(HIT_STOP_MAX_MS);
    stop.request(HIT_STOP_MAX_MS);
    stop.reset();
    expect(stop.remaining).toBe(0);
    expect(stop.request(HIT_STOP_MAX_MS)).toBe(HIT_STOP_MAX_MS);
  });
});

class FakeHost implements LoopHost {
  steps = 0;
  frames: { alpha: number; elapsedMs: number; speed: Speed }[] = [];
  constructor(private readonly stopAfter: number) {}
  isRunning(): boolean {
    return this.steps < this.stopAfter;
  }
  step(): void {
    this.steps++;
  }
  frame(alpha: number, elapsedMs: number, speed: Speed): void {
    this.frames.push({ alpha, elapsedMs, speed });
  }
}

describe('GameLoop', () => {
  it('steps the host by elapsed time × speed and renders once per frame', () => {
    const host = new FakeHost(Infinity);
    const loop = new GameLoop(host);
    loop.tick(TICK_MS + 0.01);
    expect(host.steps).toBe(1);
    loop.speed = 4;
    loop.tick(TICK_MS + 0.01);
    expect(host.steps).toBe(5);
    expect(host.frames).toHaveLength(2);
    expect(host.frames[1]?.speed).toBe(4);
    expect(host.frames[1]?.alpha).toBeGreaterThanOrEqual(0);
    expect(host.frames[1]?.alpha).toBeLessThan(1);
  });

  it('stops stepping when the run ends mid-frame and shows the end state', () => {
    const host = new FakeHost(2);
    const loop = new GameLoop(host);
    loop.tick(TICK_MS * 4 + 0.01);
    expect(host.steps).toBe(2);
    expect(host.frames[0]?.alpha).toBe(1);
    loop.tick(TICK_MS * 4);
    expect(host.steps).toBe(2);
    expect(host.frames).toHaveLength(2);
  });

  it('runs fewer ticks during a hit-stop and catches up to normal speed after it', () => {
    const host = new FakeHost(Infinity);
    const loop = new GameLoop(host);
    expect(loop.hitStop(HIT_STOP_MAX_MS)).toBe(HIT_STOP_MAX_MS);
    // 80 ms of wall-clock time at 10% speed is under one tick.
    loop.tick(HIT_STOP_MAX_MS);
    expect(host.steps).toBe(0);
    loop.tick(TICK_MS * 3);
    expect(host.steps).toBe(3);
  });

  it('ignores hit-stop under reduced motion and drops it with the clock', () => {
    const calm = new FakeHost(Infinity);
    const calmLoop = new GameLoop(calm, { reducedMotion: true });
    expect(calmLoop.hitStop(HIT_STOP_MAX_MS)).toBe(0);
    calmLoop.tick(TICK_MS * 2 + 0.01);
    expect(calm.steps).toBe(2);

    const host = new FakeHost(Infinity);
    const loop = new GameLoop(host);
    loop.hitStop(HIT_STOP_MAX_MS);
    loop.resetClock();
    loop.tick(TICK_MS * 2 + 0.01);
    expect(host.steps).toBe(2);
  });
});
