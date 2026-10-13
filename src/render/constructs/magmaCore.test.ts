import { describe, expect, it } from 'vitest';
import {
  ATTACK_MS,
  PLATE_ANGLES,
  PLATE_COUNT,
  attackOpening,
  ember,
  plateOpening,
  platePose,
} from './magmaCore';
import { MAX_PART_OFFSET, angleDistance, degrees } from './shared';

describe('magma core plates', () => {
  it('rings the core with six plates 60° apart, a gap facing straight right', () => {
    expect(PLATE_ANGLES).toHaveLength(PLATE_COUNT);
    for (let i = 0; i < PLATE_COUNT; i++) {
      const next = PLATE_ANGLES[(i + 1) % PLATE_COUNT] ?? 0;
      expect(angleDistance(PLATE_ANGLES[i] ?? 0, next)).toBeCloseTo(degrees(60));
    }
    const nearestToRight = Math.min(...PLATE_ANGLES.map((a) => angleDistance(a, 0)));
    expect(nearestToRight).toBeCloseTo(degrees(30));
  });

  it('opens the plates facing the target and keeps the far side shut', () => {
    const open = PLATE_ANGLES.map((a) => plateOpening(a, 0));
    expect(open.filter((o) => o === 1)).toHaveLength(2);
    for (let i = 0; i < PLATE_COUNT; i++) {
      const facing = angleDistance(PLATE_ANGLES[i] ?? 0, 0);
      if (facing > degrees(60)) expect(open[i]).toBe(0);
    }
    // Aimed straight at a plate, that plate opens fully and its neighbors partly.
    const aimed = PLATE_ANGLES.map((a) => plateOpening(a, PLATE_ANGLES[1] ?? 0));
    expect(aimed[1]).toBe(1);
    expect(aimed[0]).toBeGreaterThan(0);
    expect(aimed[0]).toBeLessThan(1);
  });

  it('slides opening plates out and apart, never past MAX_PART_OFFSET', () => {
    for (let t = 0; t < 360; t += 7) {
      const target = degrees(t);
      for (const angle of PLATE_ANGLES) {
        for (const open of [0, 0.5, 1]) {
          const pose = platePose(angle, target, open * plateOpening(angle, target), 1.6);
          expect(Math.hypot(pose.x, pose.y)).toBeLessThanOrEqual(MAX_PART_OFFSET);
        }
      }
    }
    // The plate just below the firing line opens outward and further down, away from it.
    const below = platePose(degrees(30), 0, 1, 0);
    expect(below.x * Math.cos(degrees(30)) + below.y * Math.sin(degrees(30))).toBeGreaterThan(0);
    expect(below.y).toBeGreaterThan(0);
    expect(below.rotation).toBeGreaterThan(0);
    const above = platePose(degrees(-30), 0, 1, 0);
    expect(above.y).toBeCloseTo(-below.y);
    expect(above.rotation).toBeCloseTo(-below.rotation);
  });

  it('snaps open, holds, and closes within the attack', () => {
    expect(attackOpening(-1)).toBe(0);
    expect(attackOpening(0)).toBe(0);
    expect(attackOpening(120)).toBe(1);
    expect(attackOpening(ATTACK_MS * 0.8)).toBeGreaterThan(0);
    expect(attackOpening(ATTACK_MS * 0.8)).toBeLessThan(1);
    expect(attackOpening(ATTACK_MS)).toBe(0);
  });
});

describe('magma core embers', () => {
  it('rise from the core and fade, staying close to the construct', () => {
    for (let k = 0; k < 9; k++) {
      for (let t = 0; t < 5000; t += 37) {
        const e = ember(k, t);
        expect(e.alpha).toBeGreaterThanOrEqual(0);
        expect(e.alpha).toBeLessThanOrEqual(1);
        expect(e.y).toBeLessThan(0);
        expect(Math.hypot(e.x, e.y)).toBeLessThan(60);
      }
    }
    // Ember 0 starts a life at t = 0 and climbs through it.
    expect(ember(0, 1000).y).toBeLessThan(ember(0, 200).y);
    expect(ember(3, 1234)).toEqual(ember(3, 1234));
  });
});
