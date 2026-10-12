/**
 * Browser game loop (docs/ARCHITECTURE.md §4.1): a fixed-timestep accumulator drives the
 * simulation at TICK_RATE from the frame's wall-clock time, and the renderer interpolates
 * between the last two ticks. Game speed runs more ticks per frame; it never changes DT.
 * Hit-stop (docs/ARCHITECTURE.md §10) briefly slows the time fed to the simulation; effects
 * keep running on wall-clock time, so a big kill freezes the crowd while the blast plays.
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

/** Longest single hit-stop, in wall-clock ms. */
export const HIT_STOP_MAX_MS = 80;
/** A request that would add less than this is ignored. */
export const HIT_STOP_MIN_MS = 15;
/** Simulation time runs at this fraction of wall-clock time during a hit-stop. */
export const HIT_STOP_TIME_SCALE = 0.1;
/**
 * Hit-stop ms earned back per wall-clock ms, up to HIT_STOP_BUDGET_MS. Stopped time can never
 * exceed this share of play however often stops are requested, so they cannot chain into a
 * slideshow.
 */
export const HIT_STOP_BUDGET_RATE = 0.08;
/** Banked hit-stop: enough for two full stops back to back (a crit, then a boss kill). */
export const HIT_STOP_BUDGET_MS = HIT_STOP_MAX_MS * 2;

/**
 * Brief time dilation on big moments. Requests that overlap a running stop merge (the longer
 * wins) instead of stacking, each stop is capped at HIT_STOP_MAX_MS, and all stops draw on a
 * budget that refills with wall-clock time. Disabled under reduced motion.
 */
export class HitStop {
  private remainingMs = 0;
  private budgetMs = HIT_STOP_BUDGET_MS;

  constructor(private readonly enabled: boolean) {}

  /** Wall-clock ms left in the current stop. */
  get remaining(): number {
    return this.remainingMs;
  }

  /** Asks for a stop of `ms`; returns the ms added (0 when refused or merged away). */
  request(ms: number): number {
    if (!this.enabled || !(ms > 0)) return 0;
    const wanted = Math.min(ms, HIT_STOP_MAX_MS);
    const extra = Math.min(wanted - this.remainingMs, this.budgetMs);
    if (extra <= 0 || this.remainingMs + extra < HIT_STOP_MIN_MS) return 0;
    this.remainingMs += extra;
    this.budgetMs -= extra;
    return extra;
  }

  /** Turns a frame's wall-clock time into simulation time, using up the stop. */
  scale(elapsedMs: number): number {
    const elapsed = Math.max(0, elapsedMs);
    this.budgetMs = Math.min(HIT_STOP_BUDGET_MS, this.budgetMs + elapsed * HIT_STOP_BUDGET_RATE);
    if (this.remainingMs <= 0) return elapsed;
    const stopped = Math.min(elapsed, this.remainingMs);
    this.remainingMs -= stopped;
    return elapsed - stopped + stopped * HIT_STOP_TIME_SCALE;
  }

  reset(): void {
    this.remainingMs = 0;
    this.budgetMs = HIT_STOP_BUDGET_MS;
  }
}

export interface GameLoopOptions {
  /** Turns hit-stop off (settings toggle later, docs/ARCHITECTURE.md §10). */
  readonly reducedMotion: boolean;
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
  private readonly hitStopper: HitStop;
  private speedValue: Speed = 1;

  constructor(
    private readonly host: LoopHost,
    options: GameLoopOptions = { reducedMotion: false },
  ) {
    this.hitStopper = new HitStop(!options.reducedMotion);
  }

  get speed(): Speed {
    return this.speedValue;
  }

  set speed(value: Speed) {
    this.speedValue = value;
  }

  /** Drop accumulated time and any hit-stop, e.g. when a new run starts. */
  resetClock(): void {
    this.clock.reset();
    this.hitStopper.reset();
  }

  /** Requests a hit-stop of `ms` wall-clock ms (see HitStop); returns the ms granted. */
  hitStop(ms: number): number {
    return this.hitStopper.request(ms);
  }

  /** One rendered frame; `elapsedMs` is raw wall-clock time since the previous frame. */
  tick(elapsedMs: number): void {
    let alpha = 1;
    if (this.host.isRunning()) {
      const simMs = this.hitStopper.scale(elapsedMs);
      const steps = this.clock.advance(simMs, this.speedValue);
      for (let i = 0; i < steps && this.host.isRunning(); i++) this.host.step();
      // After the final tick the end state is shown as is.
      alpha = this.host.isRunning() ? this.clock.alpha : 1;
    }
    this.host.frame(alpha, elapsedMs, this.speedValue);
  }
}
