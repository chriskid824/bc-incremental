import type { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { COLORS } from '../palette';
import {
  CELL_RADIUS,
  DOCK_SLOTS,
  DRONE_RADIUS,
  EMPTY_MS,
  HiveView,
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

/** The drawn alpha of the six outer comb cells, by dock slot. */
function cellAlphas(hive: HiveView): number[] {
  const comb = hive.view.getChildByLabel('comb', true) as Container;
  return comb.children.slice(1, 1 + DOCK_SLOTS).map((cell) => cell.alpha);
}

function expectCells(hive: HiveView, empty: readonly number[]): void {
  const alphas = cellAlphas(hive);
  expect(alphas).toHaveLength(DOCK_SLOTS);
  alphas.forEach((alpha, slot) =>
    expect(alpha, `cell ${slot}`).toBeCloseTo(empty.includes(slot) ? 0.12 : 1, 9),
  );
}

function reach(view: Container): number {
  const b = view.getLocalBounds();
  return Math.max(-b.minX, b.maxX, -b.minY, b.maxY);
}

describe('hive with the run’s drones (simDrones)', () => {
  it('draws the comb only: no docking ring and no drones of its own', () => {
    const sheet = new HiveView();
    expect(reach(sheet.view)).toBeGreaterThan(DRONE_RADIUS);
    const hive = new HiveView({ simDrones: true });
    expect(reach(hive.view)).toBeLessThan(DRONE_RADIUS);
    // attack() launches nothing: the drone layer draws the sorties.
    hive.attack(0);
    for (let t = 0; t < 1000; t += 16) hive.update(16);
    expect(reach(hive.view)).toBeLessThan(DRONE_RADIUS);
    expectCells(hive, []);
  });

  it('empties a pair of cells for each third of the drones out (setDocked)', () => {
    const hive = new HiveView({ simDrones: true });
    expectCells(hive, []);
    hive.setDocked(2 / 3);
    hive.update(EMPTY_MS);
    expectCells(hive, [0, 3]);
    hive.setDocked(1 / 3);
    hive.update(EMPTY_MS);
    expectCells(hive, [0, 3, 1, 4]);
    hive.setDocked(0);
    hive.update(EMPTY_MS);
    expectCells(hive, [0, 1, 2, 3, 4, 5]);
    hive.setDocked(1);
    hive.update(EMPTY_MS);
    expectCells(hive, []);
  });

  it('eases the cells toward setDocked over EMPTY_MS, and reset fills them at once', () => {
    const hive = new HiveView({ simDrones: true });
    hive.setDocked(0);
    hive.update(EMPTY_MS / 2);
    expectCells(hive, [0, 3, 1]);
    hive.update(EMPTY_MS / 2);
    expectCells(hive, [0, 1, 2, 3, 4, 5]);
    hive.reset();
    expectCells(hive, []);
    // Out of range shares are clamped.
    hive.setDocked(-1);
    hive.update(EMPTY_MS * 3);
    expectCells(hive, [0, 1, 2, 3, 4, 5]);
  });

  it('keeps the red hit flash', () => {
    const hive = new HiveView({ simDrones: true });
    const body = hive.view.children[0] as Container;
    hive.hit();
    hive.update(0);
    expect(body.tint).toBe(COLORS.playerHit);
  });
});
