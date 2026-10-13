import { describe, expect, it } from 'vitest';
import type { Num } from '../core/num';
import { num } from '../core/num';
import { SpatialGrid } from './grid';
import { isCovered, pickTarget, pickTargetInGrid } from './targeting';
import type { Targetable } from './targeting';
import { ARENA_HEIGHT, ARENA_WIDTH } from './types';

interface Dummy extends Targetable {
  readonly id: number;
}

const ESTIMATE = num(10);

function dummy(id: number, x: number, y: number, hp = 10, inbound = 0, alive = true): Dummy {
  return { id, x, y, hp: num(hp), inbound, alive };
}

const idOf = (target: Dummy | null): number | null => target?.id ?? null;

describe('isCovered', () => {
  it('is true once the inbound estimates reach the hp', () => {
    expect(isCovered(dummy(1, 0, 0, 10, 0), ESTIMATE)).toBe(false);
    expect(isCovered(dummy(1, 0, 0, 10, 1), ESTIMATE)).toBe(true);
    expect(isCovered(dummy(1, 0, 0, 25, 2), ESTIMATE)).toBe(false);
    expect(isCovered(dummy(1, 0, 0, 25, 3), ESTIMATE)).toBe(true);
  });

  it('never covers anything with a zero estimate', () => {
    expect(isCovered(dummy(1, 0, 0, 1e-9, 5), num(0))).toBe(false);
  });
});

describe('pickTarget', () => {
  it('picks the closest alive target that is not covered', () => {
    const targets = [
      dummy(1, 50, 0, 10, 0, false), // closest, dead
      dummy(2, 100, 0, 10, 1), // covered
      dummy(3, 0, 300, 25, 2), // partly covered: 20 inbound < 25 hp
      dummy(4, 200, 0), // uncovered but farther
    ];
    expect(idOf(pickTarget(targets, 0, 0, ESTIMATE))).toBe(4);
    expect(idOf(pickTarget(targets, 0, 250, ESTIMATE))).toBe(3);
  });

  it('falls back to the closest alive target when every one is covered', () => {
    const targets = [
      dummy(1, 300, 0, 10, 1),
      dummy(2, 100, 0, 10, 2),
      dummy(3, 50, 0, 10, 0, false),
    ];
    expect(idOf(pickTarget(targets, 0, 0, ESTIMATE))).toBe(2);
    expect(idOf(pickTarget(targets, 290, 0, ESTIMATE))).toBe(1);
  });

  it('measures distance from the given point', () => {
    const targets = [dummy(1, -100, 0), dummy(2, 100, 0), dummy(3, 0, 120)];
    expect(idOf(pickTarget(targets, -90, 0, ESTIMATE))).toBe(1);
    expect(idOf(pickTarget(targets, 90, 0, ESTIMATE))).toBe(2);
    expect(idOf(pickTarget(targets, 0, 100, ESTIMATE))).toBe(3);
  });

  it('prefers the earlier entry on equal distance', () => {
    const uncovered = [dummy(1, 100, 0), dummy(2, 0, 100), dummy(3, -100, 0)];
    expect(idOf(pickTarget(uncovered, 0, 0, ESTIMATE))).toBe(1);
    const covered = [dummy(1, 100, 0, 10, 1), dummy(2, 0, 100, 10, 1)];
    expect(idOf(pickTarget(covered, 0, 0, ESTIMATE))).toBe(1);
    const mixed = [dummy(1, 100, 0, 10, 1), dummy(2, 0, 100), dummy(3, 0, -100)];
    expect(idOf(pickTarget(mixed, 0, 0, ESTIMATE))).toBe(2);
  });

  it('returns null when nothing is alive', () => {
    expect(pickTarget([], 0, 0, ESTIMATE)).toBeNull();
    expect(pickTarget([dummy(1, 10, 0, 10, 0, false)], 0, 0, ESTIMATE)).toBeNull();
  });

  describe('with focus targets', () => {
    /** Ids from 10 up stand for elites and bosses near the player. */
    const isFocus = (target: Dummy): boolean => target.id >= 10;
    const pick = (targets: readonly Dummy[], avoid?: (target: Dummy) => boolean): number | null =>
      idOf(pickTarget(targets, 0, 0, ESTIMATE, avoid, isFocus));

    it('prefers the closest uncovered focus target over closer ordinary ones', () => {
      const targets = [dummy(1, 50, 0), dummy(10, 400, 0), dummy(11, 300, 0), dummy(2, 100, 0)];
      expect(pick(targets)).toBe(11);
      // Without the predicate nothing is a focus target.
      expect(idOf(pickTarget(targets, 0, 0, ESTIMATE))).toBe(1);
    });

    it('skips focus targets that are covered, avoided or dead', () => {
      const targets = [
        dummy(1, 50, 0),
        dummy(10, 100, 0, 10, 1), // covered
        dummy(11, 200, 0),
        dummy(12, 150, 0, 10, 0, false), // dead
        dummy(2, 80, 0),
      ];
      expect(pick(targets)).toBe(11);
      expect(pick(targets, (target) => target.id === 11)).toBe(1);
    });

    it('falls back to the closest alive target when everything is covered', () => {
      const targets = [dummy(10, 100, 0, 10, 1), dummy(1, 50, 0, 10, 1)];
      expect(pick(targets)).toBe(1);
    });

    it('prefers the earlier focus entry on equal distance', () => {
      const targets = [dummy(1, 10, 0), dummy(10, 100, 0), dummy(11, 0, 100)];
      expect(pick(targets)).toBe(10);
    });
  });
});

describe('pickTargetInGrid', () => {
  /** Ids from 10 up stand for elites and bosses near the player; the grid marks them. */
  const isFocus = (target: Dummy): boolean => target.id >= 10;

  /**
   * The grid variant's pick, checked against pickTarget on the same targets, with the targets
   * sorted into the cells and with a grid that scans them (fewer than its linearBelow).
   */
  function pick(
    targets: readonly Dummy[],
    x: number,
    y: number,
    estimate: Num = ESTIMATE,
    avoid?: (target: Dummy) => boolean,
    focus?: (target: Dummy) => boolean,
  ): number | null {
    const expected = pickTarget(targets, x, y, estimate, avoid, focus);
    const shootable = (target: Dummy): boolean =>
      !isCovered(target, estimate) && (avoid === undefined || !avoid(target));
    for (const linearBelow of [0, Infinity]) {
      const grid = new SpatialGrid<Dummy>(ARENA_WIDTH, ARENA_HEIGHT, 128, linearBelow);
      grid.rebuild(targets, isFocus);
      expect(grid.linearSource() === null).toBe(linearBelow === 0 && targets.length > 0);
      expect(pickTargetInGrid(grid, x, y, shootable, focus)).toBe(expected);
    }
    return idOf(expected);
  }

  it('picks like pickTarget: uncovered first, then the closest alive target', () => {
    const targets = [
      dummy(1, 550, 500, 10, 0, false),
      dummy(2, 600, 500, 10, 1),
      dummy(3, 500, 800, 25, 2),
      dummy(4, 700, 500),
    ];
    expect(pick(targets, 500, 500)).toBe(4);
    expect(pick(targets, 500, 750)).toBe(3);
    const covered = [dummy(1, 800, 500, 10, 1), dummy(2, 600, 500, 10, 2)];
    expect(pick(covered, 500, 500)).toBe(2);
    expect(pick([], 0, 0)).toBeNull();
  });

  it('prefers the earlier entry on equal distance, across cells', () => {
    const targets = [dummy(1, 960, 940), dummy(2, 1360, 540), dummy(3, 560, 540)];
    expect(pick(targets, 960, 540)).toBe(1);
    expect(pick(targets, 960, 540, ESTIMATE, (target) => target.id === 1)).toBe(2);
  });

  it('prefers focus targets, including ones added after the grid was sorted', () => {
    const targets = [dummy(1, 550, 500), dummy(10, 900, 500), dummy(2, 600, 500)];
    const grid = new SpatialGrid<Dummy>(ARENA_WIDTH, ARENA_HEIGHT, 128);
    grid.rebuild(targets, isFocus);
    const shootable = (target: Dummy): boolean => !isCovered(target, ESTIMATE);
    expect(idOf(pickTargetInGrid(grid, 500, 500, shootable, isFocus))).toBe(10);
    targets.push(dummy(11, 800, 500));
    expect(idOf(pickTargetInGrid(grid, 500, 500, shootable, isFocus))).toBe(11);
    expect(pick(targets, 500, 500, ESTIMATE, undefined, isFocus)).toBe(11);
  });

  it('ignores targets whose squared distance overflows, like pickTarget', () => {
    expect(pick([dummy(1, 1e200, 0)], 0, 0)).toBeNull();
    expect(pick([dummy(1, 1e200, 0), dummy(2, 5000, 0, 10, 3)], 0, 0)).toBe(2);
  });
});
