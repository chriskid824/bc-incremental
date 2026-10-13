import { describe, expect, it } from 'vitest';
import {
  CELL_RADIUS,
  DOCK_SLOTS,
  RETURN_AT_MS,
  SORTIE_MS,
  cellCenters,
  dockEmptiness,
  nearestDockedSlot,
  slotAngle,
  sortieOffset,
} from './hive';
import { MAX_PART_OFFSET, angleDistance, degrees } from './shared';

describe('hive comb', () => {
  it('packs seven hexagonal cells edge to edge around the middle one', () => {
    const centers = cellCenters();
    expect(centers).toHaveLength(7);
    const pitch = CELL_RADIUS * Math.sqrt(3);
    for (let k = 1; k < 7; k++) {
      const c = centers[k] ?? { x: 0, y: 0 };
      const next = centers[(k % 6) + 1] ?? { x: 0, y: 0 };
      expect(Math.hypot(c.x, c.y)).toBeCloseTo(pitch);
      expect(Math.hypot(c.x - next.x, c.y - next.y)).toBeCloseTo(pitch);
    }
  });
});

describe('hive drones', () => {
  it('docks six drones 60° apart on the ring', () => {
    expect(DOCK_SLOTS).toBe(6);
    for (let i = 0; i < DOCK_SLOTS; i++) {
      expect(angleDistance(slotAngle(i, 0.3), slotAngle(i + 1, 0.3))).toBeCloseTo(degrees(60));
    }
  });

  it('launches the docked drone nearest the target, skipping drones already out', () => {
    const docked = Array.from({ length: DOCK_SLOTS }, () => true);
    expect(nearestDockedSlot(docked, 0, degrees(5))).toBe(0);
    expect(nearestDockedSlot(docked, degrees(60), degrees(5))).toBe(5);
    docked[0] = false;
    expect([1, 5]).toContain(nearestDockedSlot(docked, 0, 0));
    docked.fill(false);
    expect(nearestDockedSlot(docked, 0, 0)).toBe(-1);
  });

  it('leaves nose-out, curves toward the target and stays within MAX_PART_OFFSET', () => {
    const start = sortieOffset(degrees(60), 0, 0);
    expect(start.x).toBeCloseTo(0);
    expect(start.y).toBeCloseTo(0);
    expect(start.heading).toBeCloseTo(degrees(60));
    for (let slot = 0; slot < 360; slot += 30) {
      for (let t = 0; t < 360; t += 20) {
        const a = degrees(slot);
        for (let s = 0; s <= 1; s += 0.05) {
          const pose = sortieOffset(a, degrees(t), s);
          expect(Math.hypot(pose.x, pose.y)).toBeLessThanOrEqual(MAX_PART_OFFSET + 1e-9);
          // Never back across the comb.
          expect(pose.x * Math.cos(a) + pose.y * Math.sin(a)).toBeGreaterThanOrEqual(-1e-9);
        }
      }
    }
    const end = sortieOffset(degrees(60), 0, 1);
    expect(end.x).toBeGreaterThan(20);
  });

  it('empties the dock while a drone is out and fills it again when it returns', () => {
    expect(dockEmptiness(-1)).toBe(0);
    expect(dockEmptiness(0)).toBe(0);
    expect(dockEmptiness(RETURN_AT_MS - 1)).toBe(1);
    expect(dockEmptiness(RETURN_AT_MS + 100)).toBeGreaterThan(0);
    expect(dockEmptiness(SORTIE_MS)).toBe(0);
  });
});
