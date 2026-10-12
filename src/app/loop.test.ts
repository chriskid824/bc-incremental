import { describe, expect, it } from 'vitest';
import { FixedStepClock, GameLoop, MAX_STEPS_PER_FRAME, TICK_MS } from './loop';
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
});
