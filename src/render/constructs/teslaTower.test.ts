import { describe, expect, it } from 'vitest';
import { MAX_PART_OFFSET, angleDistance, degrees } from './shared';
import {
  ATTACK_MS,
  COIL_COUNT,
  FORMATION_RADIUS,
  SPARK_LENGTH,
  arcBrightness,
  coilAngle,
  coilTips,
  nearestCoil,
  turnProgress,
} from './teslaTower';

const STEP = (2 * Math.PI) / 3;

describe('tesla tower formation', () => {
  it('puts three coils on a radius-40 triangle, the first at the top (game-design-v3 §11.3)', () => {
    expect(COIL_COUNT).toBe(3);
    expect(FORMATION_RADIUS).toBe(40);
    const tips = coilTips(0);
    expect(tips[0]?.x).toBeCloseTo(0);
    expect(tips[0]?.y).toBeCloseTo(-40);
    for (let i = 0; i < COIL_COUNT; i++) {
      const a = tips[i] ?? { x: 0, y: 0 };
      const b = tips[(i + 1) % COIL_COUNT] ?? { x: 0, y: 0 };
      expect(Math.hypot(a.x, a.y)).toBeCloseTo(40);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(40 * Math.sqrt(3));
    }
  });

  it('discharges from the coil facing the target, and the 120° turn brings the next one round', () => {
    for (let i = 0; i < COIL_COUNT; i++) expect(nearestCoil(0, coilAngle(i, 0))).toBe(i);
    for (let t = 0; t < 360; t += 10) {
      const target = degrees(t);
      const now = nearestCoil(0, target);
      expect(angleDistance(coilAngle(now, 0), target)).toBeLessThanOrEqual(degrees(60) + 1e-9);
      expect(nearestCoil(STEP, target)).not.toBe(now);
    }
    // After a full turn the formation looks the same: the coils have swapped places.
    const before = coilTips(0);
    const after = coilTips(STEP);
    expect(after[0]?.x).toBeCloseTo(before[1]?.x ?? NaN);
    expect(after[0]?.y).toBeCloseTo(before[1]?.y ?? NaN);
  });

  it('turns smoothly within the attack', () => {
    expect(turnProgress(0)).toBe(0);
    expect(turnProgress(ATTACK_MS)).toBe(1);
    let last = 0;
    for (let t = 0; t <= ATTACK_MS; t += 10) {
      expect(turnProgress(t)).toBeGreaterThanOrEqual(last);
      last = turnProgress(t);
    }
  });

  it('keeps the discharge spark within MAX_PART_OFFSET of its coil', () => {
    expect(SPARK_LENGTH).toBeLessThanOrEqual(MAX_PART_OFFSET);
  });
});

describe('tesla tower idle arcs', () => {
  it('stay faintly lit and flash at irregular times', () => {
    for (let pair = 0; pair < COIL_COUNT; pair++) {
      const starts: number[] = [];
      let lit = 0;
      let wasFlashing = false;
      for (let t = 0; t < 20_000; t += 10) {
        const b = arcBrightness(pair, t);
        expect(b).toBeGreaterThan(0.2);
        expect(b).toBeLessThanOrEqual(1);
        const flashing = b > 0.3;
        if (flashing) lit++;
        if (flashing && !wasFlashing) starts.push(t);
        wasFlashing = flashing;
      }
      expect(lit / 2000).toBeGreaterThan(0.05);
      expect(lit / 2000).toBeLessThan(0.4);
      const gaps = starts.slice(1).map((s, i) => s - (starts[i] ?? 0));
      expect(new Set(gaps).size).toBeGreaterThan(5);
    }
    expect(arcBrightness(1, 4321)).toBe(arcBrightness(1, 4321));
  });
});
