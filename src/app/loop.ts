/**
 * Browser game loop (docs/ARCHITECTURE.md §4.1): a fixed-timestep accumulator drives the
 * simulation at TICK_RATE from the frame's wall-clock time, and the renderer interpolates
 * between the last two ticks. Game speed runs more ticks per frame; it never changes DT.
 */

import { TICK_RATE } from '../sim';

export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

export const TICK_MS = 1000 / TICK_RATE;

/**
 * Catch-up limit per frame at 1x, scaled by speed. Time beyond it is dropped, so a long frame
 * (tab switch, breakpoint) slows the game down instead of spiralling into ever longer frames.
 */
export const MAX_STEPS_PER_FRAME = 5;

/** Turns wall-clock frame time into a whole number of ticks plus an interpolation alpha. */
export class FixedStepClock {
  private accumulatorMs = 0;

  /** Adds a frame of `elapsedMs` at the given speed and returns how many ticks to run. */
  advance(elapsedMs: number, speed: number): number {
    this.accumulatorMs += Math.max(0, elapsedMs) * speed;
    const steps = Math.floor(this.accumulatorMs / TICK_MS);
    const maxSteps = MAX_STEPS_PER_FRAME * speed;
    if (steps > maxSteps) {
      this.accumulatorMs = 0;
      return maxSteps;
    }
    this.accumulatorMs -= steps * TICK_MS;
    return steps;
  }

  /** Fraction of a tick accumulated past the last tick, in [0, 1). */
  get alpha(): number {
    return Math.min(1, this.accumulatorMs / TICK_MS);
  }

  reset(): void {
    this.accumulatorMs = 0;
  }
}

/** What the loop drives each frame. Implemented by main.ts on top of session, render and UI. */
export interface LoopHost {
  /** True while a run is in progress and ticks should be simulated. */
  isRunning(): boolean;
  /** Runs one tick. */
  step(): void;
  /** Called once per frame after the ticks, with the interpolation alpha and frame time. */
  frame(alpha: number, elapsedMs: number, speed: Speed): void;
}

export class GameLoop {
  private readonly clock = new FixedStepClock();
  private speedValue: Speed = 1;

  constructor(private readonly host: LoopHost) {}

  get speed(): Speed {
    return this.speedValue;
  }

  set speed(value: Speed) {
    this.speedValue = value;
  }

  /** Drop accumulated time, e.g. when a new run starts. */
  resetClock(): void {
    this.clock.reset();
  }

  /** One rendered frame; `elapsedMs` is raw wall-clock time since the previous frame. */
  tick(elapsedMs: number): void {
    let alpha = 1;
    if (this.host.isRunning()) {
      const steps = this.clock.advance(elapsedMs, this.speedValue);
      for (let i = 0; i < steps && this.host.isRunning(); i++) this.host.step();
      // After the final tick the end state is shown as is.
      alpha = this.host.isRunning() ? this.clock.alpha : 1;
    }
    this.host.frame(alpha, elapsedMs, this.speedValue);
  }
}
