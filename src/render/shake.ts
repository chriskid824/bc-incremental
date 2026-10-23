/**
 * Trauma-based screen shake: quick to decay, disabled under reduced motion. Each kick names a
 * ceiling it may raise trauma to, so frequent small kicks (crits) top out at a light punch
 * while rare big ones (boss kills) can shake hard; trauma never sits high for long.
 */

import { defaultRandom } from './random';
import type { RenderRandom } from './random';

/** Largest offset in arena units, at trauma 1. */
export const SHAKE_MAX_OFFSET = 14;
/** Trauma lost per second. */
const DECAY = 3.2;

export class ScreenShake {
  private trauma = 0;
  offsetX = 0;
  offsetY = 0;

  constructor(
    private readonly reducedMotion: boolean,
    private readonly random: RenderRandom = defaultRandom,
  ) {}

  /** Current trauma in [0, 1]; the offset grows with its square. */
  get level(): number {
    return this.trauma;
  }

  /** Adds trauma, but never past `ceiling` (in [0, 1]); trauma already above it is kept. */
  add(amount: number, ceiling = 1): void {
    if (this.reducedMotion || this.trauma >= ceiling) return;
    this.trauma = Math.min(ceiling, this.trauma + amount);
  }

  reset(): void {
    this.trauma = 0;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  update(dtMs: number): void {
    this.trauma = Math.max(0, this.trauma - (DECAY * dtMs) / 1000);
    const magnitude = SHAKE_MAX_OFFSET * this.trauma * this.trauma;
    this.offsetX = magnitude === 0 ? 0 : (this.random() * 2 - 1) * magnitude;
    this.offsetY = magnitude === 0 ? 0 : (this.random() * 2 - 1) * magnitude;
  }
}
