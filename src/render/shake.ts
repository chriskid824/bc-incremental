/** Trauma-based screen shake: small, quick to decay, disabled under reduced motion. */

const MAX_OFFSET = 9;
/** Trauma lost per second. */
const DECAY = 4;

export class ScreenShake {
  private trauma = 0;
  offsetX = 0;
  offsetY = 0;

  constructor(private readonly reducedMotion: boolean) {}

  /** Adds trauma in [0, 1]; the offset grows with trauma squared. */
  add(amount: number): void {
    if (this.reducedMotion) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  reset(): void {
    this.trauma = 0;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  update(dtMs: number): void {
    this.trauma = Math.max(0, this.trauma - (DECAY * dtMs) / 1000);
    const magnitude = MAX_OFFSET * this.trauma * this.trauma;
    this.offsetX = magnitude === 0 ? 0 : (Math.random() * 2 - 1) * magnitude;
    this.offsetY = magnitude === 0 ? 0 : (Math.random() * 2 - 1) * magnitude;
  }
}
