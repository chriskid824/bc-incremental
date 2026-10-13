import { describe, expect, it } from 'vitest';
import {
  FIRE_ARC,
  REGROW_MS,
  SPIKES,
  firingSpikes,
  idleStretch,
  regrowth,
  shardFlight,
} from './frostCrystal';
import { MAX_PART_OFFSET, angleDistance, degrees } from './shared';

describe('frost crystal spikes', () => {
  it('has 5–7 spikes of different lengths, unevenly spaced (game-design-v3 §11.3)', () => {
    expect(SPIKES.length).toBeGreaterThanOrEqual(5);
    expect(SPIKES.length).toBeLessThanOrEqual(7);
    expect(new Set(SPIKES.map((s) => s.length)).size).toBe(SPIKES.length);
    const angles = SPIKES.map((s) => s.angle).sort((a, b) => a - b);
    const gaps = angles.map((a, i) =>
      i === 0 ? a + 2 * Math.PI - (angles.at(-1) ?? 0) : a - (angles[i - 1] ?? 0),
    );
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(degrees(20));
  });

  it('fires the spikes facing the target, and always at least one', () => {
    for (let t = 0; t < 360; t += 5) {
      for (const spin of [0, 1, 4]) {
        const target = degrees(t);
        const fired = firingSpikes(spin, target);
        expect(fired.length).toBeGreaterThan(0);
        if (fired.length > 1) {
          for (const i of fired) {
            const angle = (SPIKES[i]?.angle ?? 0) + spin;
            expect(angleDistance(angle, target)).toBeLessThanOrEqual(FIRE_ARC);
          }
        }
      }
    }
    // Aimed straight down a spike, that spike fires.
    const spike = SPIKES[2]?.angle ?? 0;
    expect(firingSpikes(0.5, spike + 0.5)).toContain(2);
  });

  it('grows a fired spike back within 0.3 s', () => {
    expect(REGROW_MS).toBe(300);
    expect(regrowth(0)).toBe(0);
    expect(regrowth(REGROW_MS)).toBe(1);
    let last = 0;
    for (let t = 0; t <= REGROW_MS; t += 10) {
      expect(regrowth(t)).toBeGreaterThanOrEqual(last);
      last = regrowth(t);
    }
  });

  it('flies a fired spike toward the target, at most MAX_PART_OFFSET out, then hands it off', () => {
    for (let t = 0; t < 360; t += 15) {
      const target = degrees(t);
      for (let age = 0; age <= 400; age += 20) {
        const pose = shardFlight(age, target - 0.6, target);
        expect(Math.hypot(pose.x, pose.y)).toBeLessThanOrEqual(MAX_PART_OFFSET + 1e-9);
      }
      const end = shardFlight(400, target - 0.6, target);
      expect(end.alpha).toBe(0);
      expect(end.rotation).toBeCloseTo(target);
      expect(Math.cos(target) * end.x + Math.sin(target) * end.y).toBeCloseTo(MAX_PART_OFFSET);
    }
    expect(shardFlight(0, 1, 2).alpha).toBe(1);
  });

  it('stretches the spikes in turn while idle', () => {
    for (let t = 0; t < 6000; t += 40) {
      const stretched = SPIKES.filter((_, i) => idleStretch(i, t) > 1.001).length;
      expect(stretched).toBeLessThanOrEqual(3);
      for (let i = 0; i < SPIKES.length; i++) {
        expect(idleStretch(i, t)).toBeGreaterThanOrEqual(1);
        expect(idleStretch(i, t)).toBeLessThanOrEqual(1.15 + 1e-9);
      }
    }
    // Every spike gets its turn.
    for (let i = 0; i < SPIKES.length; i++) {
      let peak = 1;
      for (let t = 0; t < 3000; t += 20) peak = Math.max(peak, idleStretch(i, t));
      expect(peak).toBeGreaterThan(1.1);
    }
  });
});
