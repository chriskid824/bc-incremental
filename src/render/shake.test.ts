import { describe, expect, it } from 'vitest';
import { SHAKE_MAX_OFFSET, ScreenShake } from './shake';

describe('ScreenShake', () => {
  it('adds trauma up to the ceiling of each kick', () => {
    const shake = new ScreenShake(false);
    shake.add(0.3, 0.5);
    expect(shake.level).toBeCloseTo(0.3);
    shake.add(0.3, 0.5);
    expect(shake.level).toBeCloseTo(0.5);
    // Small kicks cannot pump it higher; a big one can.
    shake.add(0.3, 0.5);
    expect(shake.level).toBeCloseTo(0.5);
    shake.add(0.4);
    expect(shake.level).toBeCloseTo(0.9);
    // A low-ceiling kick never lowers trauma that is already above it.
    shake.add(0.1, 0.5);
    expect(shake.level).toBeCloseTo(0.9);
  });

  it('decays quickly, so a stream of capped kicks stays a light shake', () => {
    const shake = new ScreenShake(false);
    let peak = 0;
    let sum = 0;
    const frames = 600;
    for (let frame = 0; frame < frames; frame++) {
      if (frame % 11 === 0) shake.add(0.4, 0.55);
      shake.update(1000 / 60);
      peak = Math.max(peak, Math.abs(shake.offsetX), Math.abs(shake.offsetY));
      sum += shake.level;
    }
    // Offsets grow with trauma², so a 0.55 ceiling keeps them under a third of the maximum.
    expect(peak).toBeLessThan(SHAKE_MAX_OFFSET * 0.55 * 0.55 + 1e-9);
    expect(sum / frames).toBeLessThan(0.4);
  });

  it('settles to rest and resets', () => {
    const shake = new ScreenShake(false);
    shake.add(1);
    shake.update(1000);
    expect(shake.level).toBe(0);
    expect(shake.offsetX).toBe(0);
    shake.add(0.5);
    shake.reset();
    expect(shake.level).toBe(0);
  });

  it('never moves under reduced motion', () => {
    const shake = new ScreenShake(true);
    shake.add(1);
    shake.update(16);
    expect(shake.level).toBe(0);
    expect(shake.offsetX).toBe(0);
    expect(shake.offsetY).toBe(0);
  });
});
